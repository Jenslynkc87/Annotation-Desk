// Attach human labels (an "answer key") from a spreadsheet to texts already in the study.
// Rows are matched to texts by ID or file name; the texts themselves are never changed.
import { isMissingLabel } from '../metrics';
import { flattenJsonResponse, isExplanationKey, outputFields, RATIONALE_KEY, TEXT_RESPONSE_KEY } from '../prompt';
import type { Doc, PromptSpec, Result, Run } from '../types';
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
  /** Texts with several rows that give different values for a column (e.g. one row per coder), or with several rows
   *  under a name the study has more than once (`sameName`): the sheet can't be used as it is (each coder's labels
   *  belong in a column of their own). */
  conflicts: string[];
  /** Texts with several rows that don't differ in any value (merged without loss). */
  repeated: string[];
  /** Of the texts with several rows: those whose name the study also has with _2, _3 … added (names repeated when
   *  they were added, e.g. two entries called John Smith). Their rows are not used, even when they agree (also in
   *  `conflicts`): rows meant for the others must use their ID as stored (John Smith_2). `ids`: the IDs of the texts
   *  with that name. */
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
  // Several rows for one text whose name the study also has with _2, _3 … added (as adding does with a name that
  // is taken; not a file really named so, e.g. smith_2.md): rows probably meant for different texts, so none of
  // them is used, even when they agree or fill different columns (they would all go to the first).
  const byId = new Map(docs.map((d) => [d.id, d]));
  const suffixed = new Map<string, string[]>();
  for (const d of docs) {
    const m = /^(.*)_([2-9]|[1-9]\d+)$/.exec(d.docId);
    if (m && !(d.meta.file && baseName(d.meta.file) === d.docId)) (suffixed.get(m[1]) ?? suffixed.set(m[1], []).get(m[1])!).push(d.docId);
  }
  const twins = new Map<string, string[]>();
  for (const [id, keys] of rowsOf) {
    const d = byId.get(id)!;
    // Not when every row names it by its own file (smith.md, beside smith.txt stored as smith_2): that name is its alone.
    const byFile = (k: string) => [d.source, d.meta.file ?? ''].some((f) => f !== '' && norm(f) === norm(k));
    if (keys.length > 1 && suffixed.has(d.docId) && !keys.every(byFile)) twins.set(id, [d.docId, ...suffixed.get(d.docId)!]);
  }
  // A text whose rows conflict is listed by the key of its first row, and not updated.
  const conflicting = [...rowsOf.entries()].filter(([id, keys]) => twins.has(id) || keys.some((k) => conflicts.has(k)));
  for (const [id] of conflicting) {
    updates.delete(id);
    untouched.add(id);
  }
  for (const id of updates.keys()) untouched.delete(id);
  const repeated = [...rowsOf.entries()].filter(([id, keys]) => keys.length > 1 && updates.has(id)).map(([, keys]) => keys[0]);
  const sameName = [...twins].map(([id, ids]) => ({ key: rowsOf.get(id)![0], ids }));
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

/** Columns of the results tables this app exports that no other sheet has (the run's and requests' details). */
const EXPORT_COLUMNS = new Set([
  'run_label', 'prompt_version', 'prompt_hash', 'model_requested', 'model_reported', 'parse_error', 'stop_reason', 'input_tokens', 'output_tokens',
  'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens', 'response_id', 'reasoning_summary', 'n_ok', 'n_error',
]);
/** Columns of those tables that another sheet may have too (a coder's status, a date): never enough on their own. */
const SHARED_COLUMNS = new Set(['study', 'run', 'provider', 'replicate', 'status', 'error', 'requested_at', 'completed_at', 'latency_ms']);
/** Of those, the timing columns: latency_ms with one of the others is the exports' own. */
const TIMING = new Set(['latency_ms', 'requested_at', 'completed_at']);

/** Whether a column is one of the results tables' own (not an answer): status, tokens, n_ok, … */
export function isResultsTableColumn(c: string): boolean {
  return EXPORT_COLUMNS.has(c) || SHARED_COLUMNS.has(c);
}

/** A text as written in a cell, whatever its line ends. */
const sameText = (s: string) => s.replace(/\r\n?/g, '\n').trim();

/** A results table exported by this app, as `resultsTable` recognizes it. */
export interface ResultsTable {
  /** Every column to delete before the sheet can be added: the model's answers, then the table's own columns. [] for
   *  any other sheet. */
  columns: string[];
  /** Columns named like a field of this study's prompts or runs (or a key of its plain-text answers). */
  answers: string[];
  /** Columns only these tables have (n_ok, prompt_hash, …, latency_ms with requested_at, a field's replicate
   *  agreement). */
  strong: string[];
  /** Answer columns whose values are the model's answers stored in this study, for nearly every text the sheet lists. */
  copied: string[];
  /** The tables' other columns (status, run, …), which other sheets may have too. */
  shared: string[];
}

/**
 * Whether `table` is a results table exported by this app (Excel Results or By replicate sheet, results.csv,
 * results_long.csv, results_by_replicate.csv, …): it has a column only those tables have, or a column with the
 * model's explanations word for word, or two of their other columns and a column with the model's answers
 * (`matched`: the sheet's values per text, as matchLabels gives them). Added as labels, the model's answers would
 * count as human labels. The answer columns are those named like a field of `runs` or `prompts` (the study's current
 * and saved prompts, so also before any run, or after one is deleted).
 */
export function resultsTable(table: ParsedTable, runs: Run[], results: Result[], matched?: Map<string, Record<string, string>>, prompts: PromptSpec[] = []): ResultsTable {
  const names = new Set<string>();
  // As the exports name them (a field called like one of the table's own columns gets "answer_").
  const add = (k: string) => (names.add(k), names.add(`answer_${k}`));
  const agreement = new Set<string>();
  const textRuns = new Set<string>();
  const addPrompt = (p: PromptSpec) => {
    if (p.outputMode !== 'structured') return void names.add(TEXT_RESPONSE_KEY);
    for (const f of outputFields(p)) (add(f), agreement.add(`${f}_replicate_agreement`));
    if (p.includeRationale) names.add(RATIONALE_KEY);
  };
  for (const run of runs) {
    addPrompt(run.snapshot.prompt);
    if (run.snapshot.prompt.outputMode !== 'structured') textRuns.add(run.id);
  }
  for (const p of prompts) addPrompt(p);
  const timing = table.columns.includes('latency_ms') && table.columns.some((c) => c !== 'latency_ms' && TIMING.has(c));
  const strong = table.columns.filter((c) => EXPORT_COLUMNS.has(c) || agreement.has(c) || (timing && TIMING.has(c)));
  const shared = table.columns.filter((c) => SHARED_COLUMNS.has(c) && !strong.includes(c));
  const likely = strong.length > 0 || shared.length >= 2;
  // Plain-text runs: the keys of the JSON answers (each its own column in the exports). Every sheet is checked and a
  // big study has tens of thousands of answers, so only the keys that matter are looked for (any key in a sheet that
  // looks like an export; otherwise explanations, which may be copied word for word), and only in answers that could
  // hold one: the key's name ends like the column's (nested keys are joined with _).
  const open = new Set(table.columns.filter((c) => !names.has(c) && (likely || isExplanationKey(c.replace(/^answer_/, '')))));
  const tail = (c: string) => `${c.slice(c.lastIndexOf('_') + 1)}"`;
  for (const r of results) {
    if (!open.size) break;
    const raw = r.values[TEXT_RESPONSE_KEY];
    if (!textRuns.has(r.runId) || !raw || ![...open].some((c) => raw.includes(tail(c)))) continue;
    for (const k of Object.keys(flattenJsonResponse(raw) ?? {})) {
      add(k);
      open.delete(k);
      open.delete(`answer_${k}`);
    }
  }
  const answers = table.columns.filter((c) => names.has(c) && !agreement.has(c) && !isResultsTableColumn(c));
  // Explanations are compared on any sheet; other answers (short labels a coder may share) only on one that looks
  // like an export.
  const copied = copiedColumns(answers, textRuns, results, matched, likely);
  const exported = strong.length > 0 || copied.some(isWordy) || (shared.length >= 2 && copied.length > 0);
  if (!exported) return { columns: [], answers: [], strong: [], copied: [], shared: [] };
  return { columns: [...answers, ...table.columns.filter((c) => strong.includes(c) || shared.includes(c))], answers, strong, copied, shared };
}

/** The columns of `table` to delete before it can be added as labels (`resultsTable`): [] for any other sheet. */
export function modelAnswerColumns(table: ParsedTable, runs: Run[], results: Result[], matched?: Map<string, Record<string, string>>, prompts: PromptSpec[] = []): string[] {
  return resultsTable(table, runs, results, matched, prompts).columns;
}

const keyOf = (c: string) => c.replace(/^answer_/, '');
/** A column with the model's explanations: a field or JSON key named …_explanation or …_reasoning, the rationale, or a
 *  plain-text answer. */
const isWordy = (c: string) => c === RATIONALE_KEY || c === TEXT_RESPONSE_KEY || isExplanationKey(keyOf(c));

/**
 * The columns that hold the model's answers stored in this study (`all`: any answer column, else only explanations).
 * An explanation must be the same word for word for 90% or more of its texts with a value (not a missing-value marker
 * such as NA), and not just a short phrase anyone might write (e.g. "Not mentioned"): three different ones, or one of
 * 20 characters or more. Other answers (short labels that agree by chance more often): 95% or more of 10 or more
 * texts, with two different values or more.
 */
function copiedColumns(columns: string[], textRuns: Set<string>, results: Result[], matched: Map<string, Record<string, string>> | undefined, all: boolean): string[] {
  const check = columns.filter((c) => all || isWordy(c));
  if (!matched?.size || !check.length) return [];
  const byDoc = new Map<string, Result[]>();
  for (const r of results) if (matched.has(r.docId)) (byDoc.get(r.docId) ?? byDoc.set(r.docId, []).get(r.docId)!).push(r);
  // Each JSON answer read once.
  const flats = new Map<Result, Record<string, string>>();
  const flatOf = (r: Result) => flats.get(r) ?? flats.set(r, textRuns.has(r.runId) ? (flattenJsonResponse(r.values[TEXT_RESPONSE_KEY]) ?? {}) : {}).get(r)!;
  const answersOf = (r: Result, c: string): string[] => {
    if (c === RATIONALE_KEY) return [r.rationale ?? ''];
    if (c === TEXT_RESPONSE_KEY) return [r.values[TEXT_RESPONSE_KEY] ?? ''];
    return [r.values[keyOf(c)] ?? '', r.values[c] ?? '', flatOf(r)[keyOf(c)] ?? ''];
  };
  // (A number as a spreadsheet may write it: 2 and 2.0 are the same answer.)
  const same = (a: string, v: string) => {
    const x = sameText(a);
    return x === v || (x !== '' && v !== '' && Number(x) === Number(v));
  };
  return check.filter((c) => {
    const wordy = isWordy(c);
    const values = [...matched].map(([doc, v]) => [doc, sameText(v[c] ?? '')] as const).filter(([, v]) => v && !isMissingLabel(v));
    let missed = 0;
    const copied = new Set<string>();
    for (const [doc, v] of values) {
      if ((byDoc.get(doc) ?? []).some((r) => answersOf(r, c).some((a) => same(a, v)))) copied.add(v);
      // (No longer 90% or 95%: a coder's own sheet is told apart without reading the rest.)
      else if (++missed > (wordy ? 0.1 : 0.05) * values.length) return false;
    }
    return wordy ? values.length > 0 && (copied.size >= 3 || [...copied].some((v) => v.length >= 20)) : values.length >= 10 && copied.size >= 2;
  });
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
