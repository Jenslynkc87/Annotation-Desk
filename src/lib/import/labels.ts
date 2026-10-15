// Attach human labels (an "answer key") from a spreadsheet to texts already in the study.
// Rows are matched to texts by ID or file name; the texts themselves are never changed.
import type { Doc } from '../types';
import { baseName, type ParsedTable } from './parse';

export interface LabelMatch {
  /** Internal doc id -> label values to add (empty cells are skipped). */
  updates: Map<string, Record<string, string>>;
  /** Row keys that match no text. */
  unmatched: string[];
  /** Row keys that match more than one text. */
  ambiguous: string[];
  /** Label columns that already exist on some matched text (values will be replaced). */
  replaced: string[];
  /** Columns that will be added. */
  columns: string[];
}

const norm = (s: string) => s.trim().toLowerCase();

/** Lookup from every name a text is known by (ID, file name, either without extension) to the texts. */
function docIndex(docs: Doc[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const d of docs) {
    const names = [d.docId, d.source, d.meta.file ?? ''].filter(Boolean);
    for (const n of names)
      for (const k of new Set([norm(n), norm(baseName(n))])) {
        if (!index.has(k)) index.set(k, new Set());
        index.get(k)!.add(d.id);
      }
  }
  return index;
}

function lookup(index: Map<string, Set<string>>, key: string): Set<string> | undefined {
  return index.get(norm(key)) ?? index.get(norm(baseName(key)));
}

export function matchLabels(docs: Doc[], table: ParsedTable, keyColumn: string): LabelMatch {
  const index = docIndex(docs);
  const columns = table.columns.filter((c) => c !== keyColumn);
  const updates = new Map<string, Record<string, string>>();
  const unmatched: string[] = [];
  const ambiguous: string[] = [];
  for (const row of table.rows) {
    const key = String(row[keyColumn] ?? '').trim();
    if (!key) continue;
    const hits = lookup(index, key);
    if (!hits) unmatched.push(key);
    else if (hits.size > 1) ambiguous.push(key);
    else {
      const id = [...hits][0];
      const values = Object.fromEntries(columns.map((c) => [c, String(row[c] ?? '')]).filter(([, v]) => v.trim() !== ''));
      updates.set(id, { ...(updates.get(id) ?? {}), ...values });
    }
  }
  const byId = new Map(docs.map((d) => [d.id, d]));
  const replaced = columns.filter((c) => [...updates.entries()].some(([id, v]) => c in v && (byId.get(id)?.meta[c] ?? '') !== ''));
  return { updates, unmatched, ambiguous, replaced, columns };
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
