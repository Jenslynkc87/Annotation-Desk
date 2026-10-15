#!/usr/bin/env python3
"""
Check extracted .md files for lost "fi" / "fl" / "ff" ligature letters.

Some PDFs set fi, fl and ff as single ligature glyphs. Some extractors then drop
the second letter, so "conflict" becomes "confict", "first" becomes "frst",
"different" becomes "diferent", and the missing letter is sometimes left as a loose
single letter elsewhere in the text, often between stray <mark> tags
("conf</mark> i <mark>icting").

check_md.py does not catch this: the characters that remain are all decodable, and
length and digit counts look normal. This script counts two signals per file:

  broken   - occurrences of common words with the ligature letter missing
             (confict, frst, signifcant, diferent, ofers, ...)
  loose    - loose single letters f/i/l next to <mark> tags, left behind by the same fault

It also counts <mark> tags per file (column mark_tags). pymupdf4llm writes highlights that are
present in the PDF as <mark>...</mark>, so these are not noise: they are someone's highlighting,
and a model reading the text sees it. If the highlights are your own, they leak your judgement
into the model's input; if only some files have them, the corpus is inconsistent.

and reports them per 10,000 characters. Severity bands (calibrated on five articles;
treat them as guidance, not a verdict):
    clean     under 1    nothing to worry about
    trace     1-5        a few words; readable
    damaged   5-20       many words; consider re-extracting this journal
    severe    over 20    re-extract

HOW TO RUN
    python check_ligatures.py <folder with .md files>
Writes ligature_report.csv in that folder, worst first.
"""
import argparse
import csv
import re
import sys
from pathlib import Path

# Common words containing fi / fl / ff. Broken form = each ligature pair reduced to "f".
WORDS = """
first final finally find finding findings fine finish finished fire firm fit five fix fixed
figure figures fight field fields file film finance financial fiction fifth fifty fill filled
flag flow flows flowed flower flight floor flourish fluid flexible fluent flaw flood
conflict conflicts conflicting reflect reflects reflected reflecting reflection influence
influences influenced influential inflict inflation fulfill fulfil overflow
effect effects effective effectively effort efforts different difference differences differently
offer offers offered offering office officer official officially affect affects affected affair
affairs afford suffer suffering sufficient insufficient staff stuff coffee traffic
significant significantly significance specific specifically specify scientific scientist
definition definitions define defined defines benefit benefits beneficial artificial difficult
difficulty efficient efficiency sacrifice justification classification identification
verification modification qualification certificate confirm confirmed confident confidence
ofﬁce affirm affirmative disaffected refine refined refinement identify identified identifies
signify signifies simplify unify justify classify clarify specify notify modify qualify
magnificent beautiful powerful meaningful wonderful successful careful carefully useful
""".split()
COLLISIONS = {"fat", "fee", "four", "of", "fore", "fro", "fix", "ft", "fe", "fre", "fne", "fight", "food"}


def broken_form(w: str) -> str:
    return re.sub(r"ffi|ffl|ff|fi|fl", "f", w)


BROKEN = {broken_form(w) for w in WORDS if "f" in w and broken_form(w) != w}
BROKEN = {b for b in BROKEN if b not in COLLISIONS and len(b) >= 4}
# whole-word match, case-insensitive
BROKEN_RE = re.compile(r"\b(" + "|".join(sorted(BROKEN, key=len, reverse=True)) + r")\b", re.I)
LOOSE_RE = re.compile(r"(</mark>\s+[fil]\s+<mark>|</mark>\s+[fil]\s*$|\s[fil]\s+<mark>)", re.M)


def band(per10k: float) -> str:
    if per10k < 1:
        return "clean"
    if per10k < 5:
        return "trace"
    if per10k < 20:
        return "damaged"
    return "severe"


def main() -> int:
    ap = argparse.ArgumentParser(description="Check .md files for lost fi/fl/ff ligature letters.")
    ap.add_argument("folder", nargs="?", default=".")
    args = ap.parse_args()
    src = Path(args.folder).expanduser().resolve()
    files = sorted(src.glob("*.md"))
    if not files:
        print(f"No .md files in {src}")
        return 1
    rows = []
    for p in files:
        t = p.read_text(encoding="utf-8", errors="replace")
        broken = len(BROKEN_RE.findall(t))
        loose = len(LOOSE_RE.findall(t))
        marks = t.count("<mark>")
        per10k = round(10000 * (broken + loose) / max(len(t), 1), 1)
        rows.append({"file_stem": p.stem, "chars": len(t), "broken_words": broken, "loose_letters": loose, "mark_tags": marks,
                     "per_10k_chars": per10k, "severity": band(per10k)})
    rows.sort(key=lambda r: -r["per_10k_chars"])
    counts = {}
    for r in rows:
        counts[r["severity"]] = counts.get(r["severity"], 0) + 1
    print(f"folder: {src}\nfiles:  {len(rows)}\n")
    for name in ("clean", "trace", "damaged", "severe"):
        if counts.get(name):
            print(f"  {name:8s} {counts[name]}")
    with_marks = [r for r in rows if r["mark_tags"]]
    print(f"\nFiles containing <mark> tags (highlights from the PDF): {len(with_marks)} of {len(rows)}")
    for r in sorted(with_marks, key=lambda r: -r["mark_tags"])[:15]:
        print(f"   {r['mark_tags']:5d}  {r['file_stem']}")
    if len(with_marks) > 15:
        print(f"   ... and {len(with_marks) - 15} more (see the CSV)")
    flagged = [r for r in rows if r["severity"] in ("damaged", "severe")]
    if flagged:
        print(f"\nFILES WITH MANY LOST LIGATURE LETTERS ({len(flagged)}):")
        for r in flagged[:40]:
            print(f"   {r['per_10k_chars']:6.1f}  {r['file_stem']}  ({r['broken_words']} words, {r['loose_letters']} loose letters)")
        print("\nThe PDFs are fine; try another extractor (e.g. pypdf) for these files.")
    out = src / "ligature_report.csv"
    with out.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"\nReport written to: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
