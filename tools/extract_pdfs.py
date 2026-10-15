#!/usr/bin/env python3
"""
Extract PDFs to Markdown, restoring digits that some publishers' PDFs store as
private-use characters (e.g. Cambridge University Press / Journal of American Studies).

In such PDFs the digits 0-9 are encoded as U+F643..U+F64C. Ordinary extraction tools
silently drop those characters, so years, page numbers, footnote numbers and DOIs vanish
("deported in 1948" becomes "deported in ."). This script keeps the structure from
pymupdf4llm (headings, paragraphs, footnotes) and maps the private-use characters back
to digits.

Usage:
    pip install pymupdf4llm
    python extract_pdfs.py  <folder with PDFs>  <output folder>

For each PDF it writes <name>.md and prints a check: the DOI printed in the page header
must equal the DOI printed as a URL (if both are present); if they differ, the digit
mapping does not apply to that PDF and you should not use its output.
"""
import re
import sys
from pathlib import Path

import pymupdf4llm

# U+F643..U+F64C -> 0..9 (verified against DOIs and page ranges on 5 JAS 2021 articles)
DIGITS = {chr(0xF643 + i): str(i) for i in range(10)}
PUA = re.compile("[-]")


def extract(pdf: Path) -> tuple[str, str]:
    md = pymupdf4llm.to_markdown(str(pdf))
    md = "".join(DIGITS.get(c, c) for c in md)
    status = []
    left = PUA.findall(md)
    if left:
        status.append(f"WARNING: {len(left)} unknown private-use characters remain ({sorted(set(left))[:5]})")
    hdr = re.search(r"doi:\s*(10\.\d{4,}/\S+)", md)
    url = re.search(r"https://doi\.org/(10\.\d{4,}/\S+)", md)
    if hdr and url:
        status.append("DOI check OK" if hdr.group(1).strip() == url.group(1).strip() else "DOI check FAILED: do not use this output")
    else:
        status.append("no DOI pair to check")
    return md, "; ".join(status)


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    dst.mkdir(parents=True, exist_ok=True)
    pdfs = sorted(src.glob("*.pdf"))
    if not pdfs:
        sys.exit(f"No PDFs found in {src}")
    for pdf in pdfs:
        md, status = extract(pdf)
        (dst / f"{pdf.stem}.md").write_text(md, encoding="utf-8")
        print(f"{pdf.name}: {len(md):,} characters; {status}")


if __name__ == "__main__":
    main()
