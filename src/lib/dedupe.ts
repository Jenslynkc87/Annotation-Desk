// Which rows of an addition are already in the study (a folder dropped again, a table or entries pasted again), so
// that adding them again adds only the new ones.
import type { Doc } from './types';

export type NewItem = { docId: string; text: string; meta: Record<string, string>; source: string };

/** What a text is called where it came from: its file name, else its ID. */
const nameOf = (x: { docId: string; meta: Record<string, string> }) => x.meta.file || x.docId.trim();

/** An ID without the suffix adding gives an ID already in use (John Smith_2 → John Smith). */
const unsuffixed = (id: string) => /^(.*)_([2-9]|[1-9]\d+)$/.exec(id)?.[1] ?? id;

/**
 * Whether a row's ID was made up when it was added rather than read from an ID column of its own: one of its columns'
 * values (entries with an automatic ID keep every column) or the table's name with the row's number (no ID column, or
 * an empty ID cell). Such an ID can differ the next time the same rows are added.
 */
function madeUpId(x: { docId: string; meta: Record<string, string>; source: string }): boolean {
  const id = x.docId.trim();
  if (Object.values(x.meta).some((v) => v.trim() === id)) return true;
  const dot = x.source.lastIndexOf('.');
  const base = dot > 0 ? x.source.slice(0, dot) : x.source;
  return id.startsWith(`${base}_`) && /^\d+$/.test(id.slice(base.length + 1));
}

/** Whether a row's ID came from an ID column of its own (a paragraph table's para_id): not a dropped file's (named
 *  after its file), and not made up, also before a suffix adding gave it (John Smith_2). Only a stored text can carry
 *  such a suffix, and only when its unsuffixed ID is stored too (`storedIds`): a row's ID is as the table gives it, so
 *  art1_5 (paragraph 5 of file art1) is its own ID, not art1 with a suffix. */
const ownId = (x: NewItem, storedIds?: Set<string>) => {
  const id = x.docId.trim();
  const u = unsuffixed(id);
  const forms = storedIds && u !== id && storedIds.has(u) ? [id, u] : [id];
  return x.source !== x.meta.file && !forms.some((f) => madeUpId({ ...x, docId: f }));
};

/**
 * Which rows of an addition are added (`kept`) and which are skipped: already here under their name (`already`) or
 * under another ID (`elsewhere`), or included twice in this addition (`twice`: their names). Compared only with the
 * texts stored before it (`stored`), so an import dialog can count with it too. `entries`: an entries study, whose
 * details are compared whatever the order of their lines.
 */
export function sortAddition<T extends NewItem>(
  items: T[],
  stored: Doc[],
  entries = false,
): { kept: T[]; already: number; elsewhere: string[]; twice: string[] } {
  // A text that is already here (same name, identical text), e.g. after dropping the whole folder again to add
  // a few new files, is skipped rather than added again as a copy. Same name with a different text is added.
  // (Versions before October 15, 2026 stored texts without surrounding blank lines and spaces: such a text also
  // counts as already here. Only the comparison ignores them; nothing stored or added is changed.) A text stored with
  // a suffix because its name was taken (John Smith_2, the second John Smith of a table) also counts under that name,
  // so the same table pasted again adds neither. (Not a file's own name, e.g. smith_2.md: files go by their name.)
  // An entry's details count as the same in any order of their lines: the columns the model sees are written in the
  // table's order, which may differ the next time the same rows are pasted. (Not a text's: lines swapped are an edit.)
  const detailsKey = (t: string) => t.trim().split('\n').sort().join('\n');
  const keysOf = (t: string) => (entries ? [detailsKey(t)] : [t, t.trim()]);
  const storedKey = (d: Doc) => (entries ? detailsKey(d.text) : d.text);
  const present = new Map<string, Doc[]>();
  const note = (name: string, d: Doc) => present.set(name, [...(present.get(name) ?? []), d]);
  for (const d of stored) {
    note(nameOf(d), d);
    const m = d.meta.file ? null : /^(.*)_([2-9]|[1-9]\d+)$/.exec(d.docId.trim());
    if (m) note(m[1], d);
  }
  // A row with an ID of its own is another row than a stored one with another ID of its own, also under the same file
  // name (two paragraphs of one file reading “Notes”, the second added with the extended table): judged by its ID.
  const storedIds = new Set(stored.map((d) => d.docId.trim()));
  const otherRow = (it: T, d: Doc) => ownId(it) && ownId(d, storedIds) && d.docId.trim() !== it.docId.trim() && unsuffixed(d.docId.trim()) !== it.docId.trim();
  // A row whose ID was made up (`madeUpId`) is already here also when a stored text without a file has its text and
  // the same value in each of its columns (columns added since, e.g. labels or a sample, aside), whatever ID it gets
  // this time: the automatic ID may move to another column, or numbered rows shift when a row is inserted. (A cell a
  // label sheet has emptied since is no longer stored: the same as an empty cell.)
  const byText = new Map<string, Doc[]>();
  for (const d of stored) if (!d.meta.file) byText.set(storedKey(d), [...(byText.get(storedKey(d)) ?? []), d]);
  const storedAs = (it: T) =>
    it.meta.file || !madeUpId(it)
      ? undefined
      : keysOf(it.text)
          .flatMap((k) => byText.get(k) ?? [])
          .find((d) => Object.entries(it.meta).every(([k, v]) => (d.meta[k] ?? '') === v));
  let already = 0;
  const elsewhere: string[] = [];
  // Within one addition, only an exact copy (same ID and name, identical text and columns) is skipped, e.g. one file
  // selected from two folders: two rows of one table with the same name and details (two people called John Smith
  // from the UK, with different answers of the owner's) are both added, the second with a suffix, as the import dialog
  // says, and so are rows with IDs of their own that differ (two paragraphs of one file reading “Notes”).
  const seen = new Set<string>();
  const twice: string[] = [];
  const kept = items.filter((it) => {
    const keys = keysOf(it.text);
    if ((present.get(nameOf(it)) ?? []).some((d) => keys.includes(storedKey(d)) && !otherRow(it, d))) return (already++, false);
    const same = storedAs(it);
    if (same) return (elsewhere.push(`${it.docId.trim()} (stored as ${same.docId})`), false);
    const copy = JSON.stringify([it.docId.trim(), nameOf(it), it.text, Object.entries(it.meta).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]);
    if (seen.has(copy)) return (twice.push(nameOf(it)), false);
    seen.add(copy);
    return true;
  });
  return { kept, already, elsewhere, twice };
}
