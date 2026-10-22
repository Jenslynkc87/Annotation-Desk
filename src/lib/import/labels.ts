// Attach human labels (an "answer key") from a spreadsheet to texts already in the study.
// Rows are matched to texts by ID or file name; the texts themselves are never changed.
import type { Doc } from '../types';
import type { ParsedTable } from './parse';

export interface LabelMatch {
  /** Internal doc id -> label values to set (the non-empty cells of its row). */
  updates: Map<string, Record<string, string>>;
  /** Internal doc id -> columns its row leaves blank (an earlier value there is removed, see `clearPlan`). */
  blanks: Map<string, string[]>;
  /** Row keys that match no text. */
  unmatched: string[];
  /** Row keys that match more than one text. */
  ambiguous: string[];
  /** Texts with several rows that give different values for a column (e.g. one row per coder): the sheet can't be
   *  used as it is (each coder's labels belong in a column of their own). */
  conflicts: string[];
  /** Texts with several rows that agree (merged without loss). */
  repeated: string[];
  /** Label columns that already exist (their values are replaced by this sheet's). */
  replaced: string[];
  /** Columns that will be added or replaced. */
  columns: string[];
  /** Columns of the sheet that are not added: `file` (each text keeps the name of its own file). */
  skipped: string[];
  /** How many rows matched a text. */
  matchedRows: number;
}

/** Names compared alike whatever their case, surrounding spaces or Unicode form (macOS stores "ü" as u + ¨). */
const norm = (s: string) => s.normalize('NFC').trim().toLowerCase();

/** A name without its file extension (art_1.md → art_1). Only real extensions: in "H.C. Andersen" or
 *  "Smith et al. 2001" the part after the period belongs to the name, and must not be cut off. */
const stem = (s: string) => s.trim().replace(/\.(txt|md|markdown|pdf|docx?|html?|rtf|odt|csv|tsv|xlsx?|ods|jsonl?)$/i, '');

/** Lookup from every name a text is known by (ID, file name, either without extension) to the texts. */
function docIndex(docs: Doc[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const d of docs) {
    const names = [d.docId, d.source, d.meta.file ?? ''].filter(Boolean);
    for (const n of names)
      for (const k of new Set([norm(n), norm(stem(n))])) {
        if (!index.has(k)) index.set(k, new Set());
        index.get(k)!.add(d.id);
      }
  }
  return index;
}

function lookup(index: Map<string, Set<string>>, key: string): Set<string> | undefined {
  return index.get(norm(key)) ?? index.get(norm(stem(key)));
}

/** Columns a label sheet must not overwrite: the file name a text came from (used to match and name it). */
const PROTECTED = new Set(['file']);

export function matchLabels(docs: Doc[], table: ParsedTable, keyColumn: string): LabelMatch {
  const index = docIndex(docs);
  const columns = table.columns.filter((c) => c !== keyColumn && !PROTECTED.has(c));
  const skipped = table.columns.filter((c) => c !== keyColumn && PROTECTED.has(c));
  const updates = new Map<string, Record<string, string>>();
  const rowsOf = new Map<string, string[]>();
  const unmatched: string[] = [];
  const ambiguous: string[] = [];
  const conflicts = new Set<string>();
  let matchedRows = 0;
  for (const row of table.rows) {
    const key = String(row[keyColumn] ?? '').trim();
    if (!key) continue;
    const hits = lookup(index, key);
    if (!hits) unmatched.push(key);
    else if (hits.size > 1) ambiguous.push(key);
    else {
      matchedRows++;
      const id = [...hits][0];
      const values: Record<string, string> = Object.fromEntries(columns.map((c) => [c, String(row[c] ?? '')]).filter(([, v]) => v.trim() !== ''));
      const before = updates.get(id) ?? {};
      if (rowsOf.has(id) && Object.entries(values).some(([c, v]) => c in before && before[c].trim() !== v.trim())) conflicts.add(key);
      rowsOf.set(id, [...(rowsOf.get(id) ?? []), key]);
      updates.set(id, { ...before, ...values });
    }
  }
  // A text whose rows conflict is listed by the key of its first row, and not updated.
  const conflicting = [...rowsOf.entries()].filter(([, keys]) => keys.some((k) => conflicts.has(k)));
  for (const [id] of conflicting) updates.delete(id);
  const repeated = [...rowsOf.entries()].filter(([id, keys]) => keys.length > 1 && updates.has(id)).map(([, keys]) => keys[0]);
  const blanks = new Map([...updates.entries()].map(([id, v]) => [id, columns.filter((c) => !(c in v))]));
  const replaced = columns.filter((c) => docs.some((d) => (d.meta[c] ?? '') !== ''));
  return { updates, blanks, unmatched, ambiguous, conflicts: conflicting.map(([, keys]) => keys[0]), repeated, replaced, columns, skipped, matchedRows };
}

/**
 * The earlier values a sheet removes, per text: in its columns that already exist, values its rows leave blank,
 * and (unless `keepUnlisted`, e.g. when labels are added in parts) values of texts it doesn't list. So a corrected
 * sheet replaces its columns: a label taken out of it is gone, not silently kept.
 */
export function clearPlan(docs: Doc[], m: LabelMatch, keepUnlisted: boolean): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of docs) {
    const listed = m.updates.has(d.id);
    if (!listed && keepUnlisted) continue;
    const cols = m.replaced.filter((c) => (d.meta[c] ?? '') !== '' && (listed ? m.blanks.get(d.id)!.includes(c) : true));
    if (cols.length) out.set(d.id, cols);
  }
  return out;
}

/** The column whose values match the most texts (usually the file name or ID column). */
export function guessKeyColumn(docs: Doc[], table: ParsedTable): string {
  const index = docIndex(docs);
  let best = table.columns[0] ?? '';
  let bestHits = -1;
  for (const c of table.columns) {
    const hits = table.rows.filter((r) => lookup(index, String(r[c] ?? '').trim())?.size === 1).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = c;
    }
  }
  return best;
}
