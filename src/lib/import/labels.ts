// Attach human labels (an "answer key") from a spreadsheet to texts already in the study.
// Rows are matched to texts by ID or file name; the texts themselves are never changed.
import { flattenJsonResponse, outputFields, RATIONALE_KEY, TEXT_RESPONSE_KEY } from '../prompt';
import type { Doc, Result, Run } from '../types';
import { baseName, type ParsedTable } from './parse';

export interface LabelMatch {
  /** Internal doc id -> label values to set (the non-empty cells of its row). */
  updates: Map<string, Record<string, string>>;
  /** Internal doc id -> columns its row leaves blank (an earlier value there is removed, see `clearPlan`). */
  blanks: Map<string, string[]>;
  /** Row keys that match no text. */
  unmatched: string[];
  /** Row keys that match more than one text. */
  ambiguous: string[];
  /** Texts the sheet names but that are skipped (a key matching several texts, or rows that conflict): their
   *  earlier values are kept as they are. */
  untouched: Set<string>;
  /** Texts with several rows that give different values for a column (e.g. one row per coder): the sheet can't be
   *  used as it is (each coder's labels belong in a column of their own). */
  conflicts: string[];
  /** Texts with several rows that agree (merged without loss). */
  repeated: string[];
  /** Of the texts with several rows (conflicting or merged): those whose name the study also has with _2, _3 …
   *  added (names repeated when they were added, e.g. two entries called John Smith). Rows meant for those must
   *  use their ID as stored (John Smith_2). `ids`: the IDs of the texts with that name. */
  sameName: { key: string; ids: string[] }[];
  /** Label columns that already exist (their values are replaced by this sheet's). */
  replaced: string[];
  /** Columns that will be added or replaced. */
  columns: string[];
  /** Columns of the sheet that are not added: `file` (each text keeps the name of its own file). */
  skipped: string[];
  /** How many rows matched a text. */
  matchedRows: number;
  /** How many texts those rows matched (including texts left out for conflicting rows). */
  matchedTexts: number;
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
  const untouched = new Set<string>();
  const conflicts = new Set<string>();
  let matchedRows = 0;
  for (const row of table.rows) {
    const key = String(row[keyColumn] ?? '').trim();
    if (!key) continue;
    const hits = lookup(index, key);
    if (!hits) unmatched.push(key);
    else if (hits.size > 1) {
      ambiguous.push(key);
      for (const id of hits) untouched.add(id);
    } else {
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
  for (const [id] of conflicting) {
    updates.delete(id);
    untouched.add(id);
  }
  for (const id of updates.keys()) untouched.delete(id);
  const repeated = [...rowsOf.entries()].filter(([id, keys]) => keys.length > 1 && updates.has(id)).map(([, keys]) => keys[0]);
  // Several rows for one text whose name the study also has with _2, _3 … added (as adding does with a name that
  // is taken; not a file really named so, e.g. smith_2.md).
  const byId = new Map(docs.map((d) => [d.id, d]));
  const suffixed = (d: Doc, name: string) =>
    d.docId.startsWith(`${name}_`) && /^([2-9]|[1-9]\d+)$/.test(d.docId.slice(name.length + 1)) && !(d.meta.file && baseName(d.meta.file) === d.docId);
  const sameName = [...rowsOf.entries()]
    .filter(([, keys]) => keys.length > 1)
    .map(([id, keys]) => {
      const name = byId.get(id)!.docId;
      const others = docs.filter((d) => suffixed(d, name)).map((d) => d.docId);
      return { key: keys[0], ids: others.length ? [name, ...others] : [] };
    })
    .filter((x) => x.ids.length);
  const blanks = new Map([...updates.entries()].map(([id, v]) => [id, columns.filter((c) => !(c in v))]));
  const replaced = columns.filter((c) => docs.some((d) => (d.meta[c] ?? '') !== ''));
  return {
    updates, blanks, unmatched, ambiguous, untouched, conflicts: conflicting.map(([, keys]) => keys[0]), repeated, sameName, replaced, columns, skipped,
    matchedRows, matchedTexts: rowsOf.size,
  };
}

/**
 * The earlier values a sheet removes, per text: in its columns that already exist, values its rows leave blank,
 * and (unless `keepUnlisted`, as the labels dialog does unless asked) values of texts it doesn't list. Texts it
 * names but skips (`untouched`) keep their values.
 */
export function clearPlan(docs: Doc[], m: LabelMatch, keepUnlisted: boolean): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of docs) {
    const listed = m.updates.has(d.id);
    if (!listed && (keepUnlisted || m.untouched.has(d.id))) continue;
    const cols = m.replaced.filter((c) => (d.meta[c] ?? '') !== '' && (listed ? m.blanks.get(d.id)!.includes(c) : true));
    if (cols.length) out.set(d.id, cols);
  }
  return out;
}

/**
 * The columns of a results table exported by this app (Excel Results sheet, results.csv) that hold the model's
 * answers, when `table` is one: it has n_ok and n_error, and columns named like a run's fields. Added as labels,
 * the model's answers would count as human labels. [] for any other sheet.
 */
export function modelAnswerColumns(table: ParsedTable, runs: Run[], results: Result[]): string[] {
  if (!table.columns.includes('n_ok') || !table.columns.includes('n_error')) return [];
  const names = new Set<string>();
  // As the exports name them (a field called like one of the table's own columns gets "answer_").
  const add = (k: string) => (names.add(k), names.add(`answer_${k}`));
  const textRuns = new Set<string>();
  for (const run of runs) {
    const p = run.snapshot.prompt;
    if (p.outputMode !== 'structured') {
      names.add(TEXT_RESPONSE_KEY);
      textRuns.add(run.id);
      continue;
    }
    for (const f of outputFields(p)) (add(f), names.add(`${f}_replicate_agreement`));
    if (p.includeRationale) names.add(RATIONALE_KEY);
  }
  // Plain-text runs: the keys of the JSON answers (each its own column in the exports).
  const open = new Set(table.columns.filter((c) => !names.has(c)));
  for (const r of results) {
    if (!open.size) break;
    if (!textRuns.has(r.runId) || !r.values[TEXT_RESPONSE_KEY]) continue;
    for (const k of Object.keys(flattenJsonResponse(r.values[TEXT_RESPONSE_KEY]) ?? {})) {
      add(k);
      open.delete(k);
      open.delete(`answer_${k}`);
    }
  }
  const answers = table.columns.filter((c) => names.has(c));
  return answers.length ? [...answers, 'n_ok', 'n_error'] : [];
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
