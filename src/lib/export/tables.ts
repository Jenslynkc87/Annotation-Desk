// Tabular views used by every export format.
import Papa from 'papaparse';
import { comparableFields, fieldValue, type ComparableField } from '../compare';
import { agreement, isMissingLabel, type Agreement, type Level } from '../metrics';
import { TEXT_RESPONSE_KEY, flattenJsonResponse, isExplanationKey, normalizeLabel, outputFields, toNumber } from '../prompt';
import { thinkingLabel } from '../providers/anthropic';
import { supportsExplicitCaching } from '../providers/openai';
import type { Doc, Result, Run, Study } from '../types';
import { buildDocViews, replacedAttempts, retriedRequests, runIdTag, runInProgress, runName, sharesNumber, type DocView, type RetriedRequests } from '../view';

export type Row = Record<string, string | number | null>;

export function toCsv(rows: Row[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  // UTF-8 BOM so Excel opens non-ASCII text correctly.
  return '﻿' + Papa.unparse({ fields: cols, data: rows.map((r) => cols.map((c) => r[c] ?? '')) });
}

export function metaColumns(docs: Doc[]): string[] {
  return [...new Set(docs.flatMap((d) => Object.keys(d.meta)))];
}

export function corpusRows(docs: Doc[], includeText: boolean): Row[] {
  const cols = metaColumns(docs);
  // A metadata column with the same name as one of ours (e.g. "source") gets a prefix instead of overwriting it.
  const own = new Set(['doc_id', 'text', 'n_characters', 'source']);
  return docs.map((d) => ({
    doc_id: d.docId,
    ...(includeText ? { text: d.text } : {}),
    n_characters: d.text.length,
    source: d.source,
    ...Object.fromEntries(cols.map((c) => [own.has(c) ? `meta_${c}` : c, d.meta[c] ?? ''])),
  }));
}

/**
 * The results tables' own columns. A codebook field or JSON value with one of these names gets an "answer_"
 * prefix (e.g. answer_status), so it neither overwrites nor is overwritten by the table's own column.
 */
const OWN_COLUMNS = new Set([
  'doc_id', 'file', 'text', 'study', 'run', 'run_label', 'prompt_version', 'prompt_hash', 'provider', 'model_requested', 'model_reported',
  'replicate', 'status', 'rationale', 'reasoning_summary', 'parse_error', 'error', 'stop_reason', 'input_tokens', 'output_tokens',
  'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens', 'latency_ms', 'requested_at', 'completed_at', 'response_id', 'n_ok', 'n_error',
  TEXT_RESPONSE_KEY,
]);
const answerColumn = (k: string) => (OWN_COLUMNS.has(k) ? `answer_${k}` : k);
/** A run's output field as a column name (the raw answer of a plain-text run keeps its own "response" column). */
const fieldColumn = (run: Run, f: string) => (run.snapshot.prompt.outputMode === 'text' && f === TEXT_RESPONSE_KEY ? f : answerColumn(f));

/**
 * The order of the extra columns of plain-text runs that answered with JSON, over all the answers of a table
 * (so every row has the same columns in the same order, whichever text comes first or failed).
 */
function jsonKeyOrder(run: Run, responses: (string | undefined)[]): string[] {
  if (run.snapshot.prompt.outputMode !== 'text') return [];
  const all: string[] = [];
  const seen = new Set<string>();
  for (const r of responses) for (const k of Object.keys(flattenJsonResponse(r) ?? {})) if (!seen.has(k)) (seen.add(k), all.push(k));
  // The model writes its reasoning first (better answers), but readers want the scores first:
  // within each group (e.g. each domain) put the reasoning column last.
  const isReasoning = isExplanationKey;
  const groupOf = (k: string) => (k.includes('_') ? k.slice(0, k.lastIndexOf('_')) : '');
  const order: string[] = [];
  for (const k of all) if (!order.includes(groupOf(k))) order.push(groupOf(k));
  const sorted = [...all].sort((a, b) => order.indexOf(groupOf(a)) - order.indexOf(groupOf(b)) || Number(isReasoning(a)) - Number(isReasoning(b)));
  // Flat names ("race", "race_explanation"): each explanation goes right after its own score.
  const scoreOf = (k: string) => {
    for (const suffix of ['_explanation', '_reasoning']) if (k.endsWith(suffix) && seen.has(k.slice(0, -suffix.length))) return k.slice(0, -suffix.length);
    return null;
  };
  const keys: string[] = [];
  const place = (k: string) => {
    keys.push(k);
    for (const m of sorted) if (scoreOf(m) === k) place(m);
  };
  for (const k of sorted) if (scoreOf(k) === null) place(k);
  return keys;
}

/** Free-text runs that answered with JSON get one extra column per value (all of `keys`, empty where this answer
 *  has none); the raw response column stays. */
function jsonColumns(keys: string[], response: string | undefined): Row {
  if (!keys.length) return {};
  const flat = flattenJsonResponse(response) ?? {};
  return Object.fromEntries(keys.map((k) => [answerColumn(k), numify(flat[k])]));
}

/** Numbers as numbers (so Excel can sort and sum them); anything else unchanged.
 *  Only values that read back identically are converted, so codes like "007" or "3.50" stay as written. */
function numify(v: string | undefined): string | number {
  if (v === undefined) return '';
  const t = v.trim();
  return /^-?\d+(\.\d+)?$/.test(t) && String(Number(t)) === t ? Number(t) : v;
}

function isNumericVar(run: Run, f: string): boolean {
  const t = run.snapshot.prompt.variables.find((x) => x.name === f)?.type;
  return t === 'number' || t === 'ordinal';
}

/** Identifying columns first (id, file name), annotations next, bulky columns (raw JSON answer, full text) last. */
function readingOrder(row: Row, rawLast: boolean): Row {
  const front = ['doc_id', 'file'].filter((k) => k in row);
  const back = [...(rawLast ? [TEXT_RESPONSE_KEY] : []), 'text'].filter((k) => k in row);
  const middle = Object.keys(row).filter((k) => !front.includes(k) && !back.includes(k));
  return Object.fromEntries([...front, ...middle, ...back].map((k) => [k, row[k]]));
}

/** One row per request (text × replicate). `allRuns`: the study's runs, to tell apart runs that share a number. */
export function resultsLong(study: Study, runs: Run[], docs: Doc[], results: Result[], opts: { rationale: boolean; reasoning: boolean }, allRuns: Run[] = runs): Row[] {
  const docById = new Map(docs.map((d) => [d.id, d]));
  const runById = new Map(runs.map((r) => [r.id, r]));
  const names = new Map(runs.map((r) => [r.id, runName(r, allRuns)]));
  const rows: Row[] = [];
  // Texts no longer in the study go after all present ones, each with its replicates together.
  const pos = (id: string) => docById.get(id)?.order ?? Number.MAX_SAFE_INTEGER;
  // (Runs that share a number one after the other, in the order given, not mixed text by text.)
  const runPos = new Map(runs.map((r, i) => [r.id, i]));
  const sorted = [...results].sort((a, b) => {
    const ra = runById.get(a.runId)?.number ?? 0;
    const rb = runById.get(b.runId)?.number ?? 0;
    return (
      ra - rb ||
      (runPos.get(a.runId) ?? 0) - (runPos.get(b.runId) ?? 0) ||
      pos(a.docId) - pos(b.docId) ||
      (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0) ||
      a.replicate - b.replicate
    );
  });
  // Plain-text runs that answered with JSON: one list of columns for the whole table, over all the answers (so every
  // row has them in the same place, whichever request comes first or failed).
  const isText = (r: Result) => runById.get(r.runId)?.snapshot.prompt.outputMode === 'text';
  const textRun = runs.find((run) => run.snapshot.prompt.outputMode === 'text');
  const jsonKeys = textRun ? jsonKeyOrder(textRun, sorted.filter(isText).map((r) => r.values[TEXT_RESPONSE_KEY])) : [];
  for (const r of sorted) {
    const run = runById.get(r.runId);
    if (!run) continue;
    const doc = docById.get(r.docId);
    const row: Row = {
      study: study.name,
      run: names.get(run.id)!,
      run_label: run.label,
      prompt_version: run.snapshot.promptVersion,
      prompt_hash: run.snapshot.promptHash,
      provider: run.snapshot.model.provider,
      model_requested: run.snapshot.model.model,
      model_reported: r.modelReported,
      doc_id: doc?.docId ?? `(deleted ${r.docId})`,
      replicate: r.replicate,
      status: r.status,
    };
    for (const f of outputFields(run.snapshot.prompt)) row[fieldColumn(run, f)] = isNumericVar(run, f) ? numify(r.values[f]) : (r.values[f] ?? '');
    if (isText(r)) Object.assign(row, jsonColumns(jsonKeys, r.values[TEXT_RESPONSE_KEY]));
    if (opts.rationale) row.rationale = r.rationale;
    if (opts.reasoning) row.reasoning_summary = r.reasoningSummary;
    Object.assign(row, {
      parse_error: r.parseError ?? '',
      error: r.error ?? '',
      stop_reason: r.stopReason,
      input_tokens: r.usage.inputTokens,
      output_tokens: r.usage.outputTokens,
      reasoning_tokens: r.usage.reasoningTokens,
      cache_read_tokens: r.usage.cacheReadTokens,
      cache_write_tokens: r.usage.cacheWriteTokens,
      latency_ms: r.latencyMs,
      requested_at: r.requestedAt,
      completed_at: r.completedAt,
      response_id: r.responseId,
    });
    rows.push(row);
  }
  return rows;
}

/** One row per text for a single run: metadata + aggregated annotations. Every row has the same columns. */
export function resultsWide(run: Run, docs: Doc[], allRuns: Run[], results: Result[], opts: { text: boolean; rationale: boolean }): Row[] {
  const views = buildDocViews(docs, allRuns, results, run.id);
  const fields = outputFields(run.snapshot.prompt);
  const p = run.snapshot.prompt;
  const reps = run.snapshot.options.replicates;
  const shown = docs.filter((d) => views.get(d.id)!.status !== 'none');
  const jsonKeys = jsonKeyOrder(run, shown.map((d) => views.get(d.id)!.values[TEXT_RESPONSE_KEY]));
  const withJson = jsonKeys.length > 0;
  // Share of a text's annotations that agree with the combined label, for fields that have one (not free text;
  // plain-text answers are combined value by value, so a share of identical answers says nothing).
  const typeOf = (f: string) => p.variables.find((v) => v.name === f)?.type;
  const consistencyOf = (f: string) => reps > 1 && p.outputMode === 'structured' && typeOf(f) !== undefined && typeOf(f) !== 'text';
  const withRationale = opts.rationale && p.includeRationale && p.outputMode === 'structured';
  // The table's own columns, decided once: a metadata column with one of these names gets a prefix in every row
  // (deciding row by row would put e.g. a human label "race" under the model's "race" where an answer has none).
  const annotationCols = [
    ...fields.flatMap((f) => [fieldColumn(run, f), ...(consistencyOf(f) ? [`${f}_replicate_agreement`] : [])]),
    ...jsonKeys.map(answerColumn),
    ...(withRationale ? ['rationale'] : []),
  ];
  const taken = new Set(['doc_id', 'text', 'n_ok', 'n_error', ...annotationCols]);
  const cols = metaColumns(docs).map((c) => [c, taken.has(c) ? `meta_${c}` : c] as const);
  const rows: Row[] = [];
  for (const d of shown) {
    const v = views.get(d.id)!;
    const row: Row = { doc_id: d.docId };
    if (opts.text) row.text = d.text;
    for (const f of fields) {
      row[fieldColumn(run, f)] = isNumericVar(run, f) ? numify(v.values[f]) : (v.values[f] ?? '');
      if (consistencyOf(f)) row[`${f}_replicate_agreement`] = v.consistency[f] !== undefined ? Math.round(v.consistency[f] * 1000) / 1000 : '';
    }
    Object.assign(row, jsonColumns(jsonKeys, v.values[TEXT_RESPONSE_KEY]));
    if (withRationale) row.rationale = v.rationale; // the one written with the combined labels
    // Metadata (including any human labels) after the annotations.
    for (const [c, name] of cols) row[name] = numify(d.meta[c]);
    row.n_ok = v.results.filter((r) => r.status === 'ok').length;
    row.n_error = v.results.filter((r) => r.status === 'error').length;
    rows.push(readingOrder(row, withJson));
  }
  return rows;
}

export interface AgreementRow {
  field: string;
  /** "model" for the run's annotations, or a metadata column (human–human comparison). */
  source: string;
  compared_with: string;
  level: Level;
  stats: Agreement;
  /** Texts with a value in `compared_with` (for the model: among the run's texts). `stats.n` of them were compared. */
  nLabelled: number;
}

/** Words in a column name that mark coders' notes or ratings about a field, not labels for it (race_note,
 *  race_confidence, race_explanation_coder2). */
const NOT_LABEL_WORDS = new Set(['explanation', 'explanations', 'reasoning', 'rationale', 'note', 'notes', 'comment', 'comments', 'memo', 'confidence', 'certainty', 'flag', 'flags']);
/** Words that mark metadata about a text's author, not a label for the text (author_gender for a gender field). */
const AUTHOR_WORDS = new Set(['author', 'authors']);
/** The reasons `labelColumnsFor` gives for columns named after a field that hold no labels for any field. */
export const NOTE_OR_RATING = 'a note or rating';
export const ABOUT_AUTHOR = 'about the author';
/**
 * Words around a field's name that mark a column of human labels for it (race_gold, human_race, race_coder2), also
 * saying whose or which labels they are (race_expert_gold, race_final_gold, gold_standard_race, human_coded_race).
 */
const LABEL_MARKER = /^(gold|human|coder|rater|annotator|pilot|expert|final|consensus|standard|coded|reference|adjudicated|manual)\d*$/;

/**
 * The fields that label columns' own names point to: race_negative_gold or gold_race_negative → race_negative (the
 * name without its marker words, when two or more words remain). So such a column belongs to that longer field even
 * where no prompt or run names it, and is not taken for race (see `labelColumnsFor`).
 */
function impliedFields(columns: string[]): string[] {
  const out = new Set<string>();
  for (const c of columns) {
    const words = c.toLowerCase().split('_');
    let [i, j] = [0, words.length];
    while (j - i > 1 && LABEL_MARKER.test(words[j - 1])) j--;
    while (j - i > 1 && LABEL_MARKER.test(words[i])) i++;
    if ((i > 0 || j < words.length) && j - i >= 2) out.add(words.slice(i, j).join('_'));
  }
  return [...out];
}

/** The rest of a column's name around a field's name ("gold" in race_gold or gold_race); null if not named after it. */
function nameRest(column: string, field: string): string | null {
  const x = column.toLowerCase();
  const f = field.toLowerCase();
  if (x === f) return '';
  if (x.startsWith(`${f}_`)) return x.slice(f.length + 1);
  if (x.endsWith(`_${f}`)) return x.slice(0, -(f.length + 1));
  return null;
}

/**
 * A label cell as it is compared and counted: trimmed and lower-cased (`normalizeLabel`), and blank when it is a
 * missing-value marker such as "NA" that isn't a value of the field (so it counts neither as labelled nor as left out).
 */
export function labelValue(raw: string | undefined, f: ComparableField): string {
  const v = normalizeLabel(raw, f.yesNo);
  return v && isMissingLabel(v) && !fitsField(v, f) ? '' : v;
}

/** Does a label fit the field: one of its categories, a yes/no, or a number on its scale? */
function fitsField(v: string, f: ComparableField): boolean {
  const n = normalizeLabel(v, f.yesNo);
  if (f.yesNo) return n === 'true' || n === 'false';
  if (f.level === 'nominal') return !f.allowed.length || f.allowed.includes(n);
  const x = toNumber(v);
  if (!Number.isFinite(x)) return false;
  if (f.scaleSeen || !f.allowed.length) return true;
  const scale = f.allowed.map(Number).filter(Number.isFinite);
  return !scale.length || (x >= Math.min(...scale) - 1e-9 && x <= Math.max(...scale) + 1e-9);
}

/**
 * Metadata columns that hold human labels for a field: named after it ("sentiment", "sentiment_gold",
 * "human_sentiment", "sentiment_coder2") and, when the field is known, holding mostly its values (blank cells and
 * missing-value markers such as "NA" aside) in `valueDocs` (e.g. a run's texts; by default every text). Not labels,
 * and listed in `skipped` with the reason: coders' notes and ratings named after it (sentiment_explanation,
 * sentiment_note, sentiment_confidence); metadata about the author (author_gender); a column named after a longer
 * field in `knownFields`, or one its own name points to (gender_role_gold belongs to gender_role, not gender); and a
 * column whose values are mostly not values of the field (e.g. race_old holding words, for a −3…3 scale).
 */
export function labelColumnsFor(
  field: ComparableField | string,
  docs: Doc[],
  knownFields: string[] = [],
  valueDocs: Doc[] = docs,
): { columns: string[]; skipped: { column: string; reason: string }[] } {
  const f = typeof field === 'string' ? null : field;
  const key = typeof field === 'string' ? field : field.key;
  const all = metaColumns(docs);
  // A field only a column's name points to counts when it extends this one at the end (race_negative for race), not
  // when it merely ends in it (standard_race, from gold_standard_race, stays with race).
  const k = key.toLowerCase();
  const longer = [...knownFields.filter((g) => g.length > key.length), ...impliedFields(all).filter((g) => g.startsWith(`${k}_`))].filter((g) => g.toLowerCase() !== k);
  const columns: string[] = [];
  const skipped: { column: string; reason: string }[] = [];
  for (const c of all) {
    const rest = nameRest(c, key);
    if (rest === null) continue;
    const owner = longer.find((g) => nameRest(c, g) !== null);
    let reason: string | null = null;
    if ((isExplanationKey(c.toLowerCase()) && !isExplanationKey(key.toLowerCase())) || rest.split('_').some((w) => NOT_LABEL_WORDS.has(w))) reason = NOTE_OR_RATING;
    else if (rest.split('_').some((w) => AUTHOR_WORDS.has(w))) reason = ABOUT_AUTHOR;
    else if (owner) reason = `belongs to ${owner}`;
    else if (f) {
      // A missing-value marker (e.g. "NA" for an uncoded text) is no label, unless the field has it as a category.
      const values = valueDocs.map((d) => d.meta[c] ?? '').filter((v) => v.trim() !== '' && (!isMissingLabel(v) || fitsField(v, f)));
      if (!values.length) reason = `no labels for ${key}`;
      else if (values.filter((v) => fitsField(v, f)).length < values.length / 2) reason = `mostly not values of ${key}`;
    }
    if (reason) skipped.push({ column: c, reason });
    else columns.push(c);
  }
  return { columns, skipped };
}

/** The label columns of a field (see `labelColumnsFor`). */
export function goldColumnsFor(field: ComparableField | string, docs: Doc[], knownFields: string[] = []): string[] {
  return labelColumnsFor(field, docs, knownFields).columns;
}

/** The label column to show first for a field: one named exactly like it, else a "gold" or "human" one, else the first. */
export function preferredGoldColumn(field: string, columns: string[]): string | undefined {
  const f = field.toLowerCase();
  return (
    columns.find((c) => c.toLowerCase() === f) ??
    columns.find((c) => (nameRest(c, f) ?? '').split('_').some((w) => w === 'gold' || w === 'human')) ??
    columns[0]
  );
}

/** The field a column is named after: the longest of `fields` it extends (race_negative for race_negative_gold). */
export function namedField(column: string, fields: string[]): string | undefined {
  let best: string | undefined;
  for (const f of fields) if (nameRest(column, f) !== null && (!best || f.length > best.length)) best = f;
  return best;
}

/** The keys holding a number in one answer, kept per result (an answer doesn't change), so each is read once. */
const numberKeysOf = new WeakMap<Result, { raw: string | undefined; keys: string[] }>();

/**
 * The score keys in the JSON answers of plain-text runs: every key that holds a number in at least one usable answer
 * (so a score given in few answers, e.g. race_negative only for texts about race, is still found), from every answer.
 */
function jsonScoreKeys(runs: Run[], results: Result[]): string[] {
  const textRuns = new Set(runs.filter((r) => r.snapshot.prompt.outputMode === 'text').map((r) => r.id));
  if (!textRuns.size) return [];
  const keys = new Set<string>();
  for (const r of results) {
    if (r.status !== 'ok' || !textRuns.has(r.runId)) continue;
    const raw = r.values[TEXT_RESPONSE_KEY];
    let known = numberKeysOf.get(r);
    if (!known || known.raw !== raw) {
      const flat = flattenJsonResponse(raw) ?? {};
      known = { raw, keys: Object.keys(flat).filter((k) => Number.isFinite(toNumber(flat[k]))) };
      numberKeysOf.set(r, known);
    }
    for (const k of known.keys) keys.add(k);
  }
  return [...keys];
}

/**
 * Every field name a study or its runs use (current prompt, saved prompts, runs, and with `results`, the score keys
 * of plain-text runs' JSON answers), to tell gender from gender_role.
 */
export function knownFieldNames(study: Study | null, runs: Run[], extra: string[] = [], results: Result[] = []): string[] {
  const prompts = [...(study ? [study.prompt, ...(study.savedPrompts ?? []).map((x) => x.prompt)] : []), ...runs.map((r) => r.snapshot.prompt)];
  return [...new Set([...prompts.flatMap((p) => p.variables.map((v) => v.name)), ...jsonScoreKeys(runs, results), ...extra])];
}

/**
 * The fields of a run agreement can be computed on, each with the label columns that belong to it, and the columns
 * named after a field that are not used, with the reason (e.g. "mostly not values of race"). `valueDocs`: the texts
 * a column's values are judged on (by default the run's); `known`: `knownFieldNames(study, allRuns, [], results)`,
 * if already at hand.
 */
export function labelPairs(
  run: Run,
  docs: Doc[],
  allRuns: Run[],
  results: Result[],
  study: Study | null = null,
  views: Map<string, DocView> = buildDocViews(docs, allRuns, results, run.id),
  fields: ComparableField[] = comparableFields(run, views.values()),
  { valueDocs, known: knownAlready }: { valueDocs?: Doc[]; known?: string[] } = {},
): { fields: ComparableField[]; pairs: { field: string; column: string }[]; skipped: { field: string; column: string; reason: string }[] } {
  const known = knownAlready ? [...new Set([...knownAlready, ...fields.map((f) => f.key)])] : knownFieldNames(study, allRuns, fields.map((f) => f.key), results);
  // Whether a column holds mostly a field's values is judged on the run's texts, which its agreement is computed on.
  const inRun = new Set(run.docIds);
  const runDocs = valueDocs ?? docs.filter((d) => inRun.has(d.id));
  const found = fields.map((f) => ({ field: f.key, ...labelColumnsFor(f, docs, known, runDocs) }));
  // A column of a longer field of this run (gender_role_gold, skipped for gender) is explained by that field's own
  // entry (a pair, or its reason for leaving the column out), not by "belongs to gender_role".
  const ofLonger = (field: string, column: string) =>
    fields.some((g) => g.key.length > field.length && g.key.toLowerCase() !== field.toLowerCase() && nameRest(column, g.key) !== null);
  return {
    fields,
    pairs: found.flatMap(({ field, columns }) => columns.map((column) => ({ field, column }))),
    skipped: found.flatMap(({ field, skipped }) => skipped.filter((x) => !(x.reason.startsWith('belongs to ') && ofLonger(field, x.column))).map((x) => ({ field, ...x }))),
  };
}

export function agreementForRun(run: Run, docs: Doc[], allRuns: Run[], results: Result[], study: Study | null = null): AgreementRow[] {
  const views = buildDocViews(docs, allRuns, results, run.id);
  const out: AgreementRow[] = [];
  // The fields agreement can be computed on: codebook fields (free text excluded: every answer is its own
  // category), or the numeric scores in plain-text JSON answers. Each with the label columns named after it.
  const { fields, pairs } = labelPairs(run, docs, allRuns, results, study, views);
  const inRun = new Set(run.docIds);
  const setup = (field: string) => fields.find((f) => f.key === field)!;
  // (Plain-text scores: the human–human rows too are on the scale grown from the run's answers, `f.range`; it takes in
  // labels within 3 points, so only codes far off it, e.g. 9 or 99 next to −3…3, depend on the model.)
  const stats = (xs: string[], ys: string[], f: ComparableField) => agreement(xs, ys, f.level, f.allowed, 1, { scaleSeen: f.scaleSeen, range: f.range });
  for (const { field, column } of pairs) {
    const f = setup(field);
    const xs: string[] = [];
    const ys: string[] = [];
    let nLabelled = 0;
    for (const d of docs) {
      // A missing-value marker (e.g. "NA") is a blank cell: not labelled.
      const y = labelValue(d.meta[column], f);
      if (!y || !inRun.has(d.id)) continue;
      nLabelled++;
      const v = views.get(d.id)!;
      const x = normalizeLabel(fieldValue(run, v.values, field), f.yesNo);
      if (v.status !== 'none' && x) {
        xs.push(x);
        ys.push(y);
      }
    }
    out.push({ field, source: 'model', compared_with: column, level: f.level, stats: stats(xs, ys, f), nLabelled });
  }
  // Human–human baseline: two label columns for the same field (e.g. stance_gold and stance_coder2), on the
  // run's texts (the same texts as the model rows above, in every export).
  for (const field of new Set(pairs.map((p) => p.field))) {
    const cols = pairs.filter((p) => p.field === field).map((p) => p.column);
    const f = setup(field);
    for (let i = 0; i < cols.length; i++)
      for (let j = i + 1; j < cols.length; j++) {
        const xs: string[] = [];
        const ys: string[] = [];
        let nLabelled = 0;
        for (const d of docs) {
          const y = labelValue(d.meta[cols[j]], f);
          if (!y || !inRun.has(d.id)) continue;
          nLabelled++;
          const x = labelValue(d.meta[cols[i]], f);
          if (x) {
            xs.push(x);
            ys.push(y);
          }
        }
        out.push({ field, source: cols[i], compared_with: cols[j], level: f.level, stats: stats(xs, ys, f), nLabelled });
      }
  }
  return out;
}

/** `run`: the run as the tables name it (`runName`). */
export function agreementRows(rows: AgreementRow[], runNumber: number | string): Row[] {
  const round = (x: number) => Math.round(x * 10000) / 10000;
  const withCi = (name: string, value: number | null, ci: [number, number] | null | undefined): Row => ({
    [name]: value,
    [`${name}_ci_low`]: ci ? round(ci[0]) : null,
    [`${name}_ci_high`]: ci ? round(ci[1]) : null,
  });
  return rows.map((a) => ({
    run: runNumber,
    field: a.field,
    annotations: a.source === 'model' ? `model (run ${runNumber})` : a.source,
    compared_with: a.compared_with,
    level_of_measurement: a.stats.level,
    n: a.stats.n,
    n_with_label: a.nLabelled,
    n_left_out_not_on_scale: a.stats.leftOut.n,
    ...withCi('percent_agreement', a.stats.percentAgreement, a.stats.ci.percentAgreement),
    ...withCi('cohen_kappa', a.stats.cohenKappa, a.stats.ci.cohenKappa),
    ...withCi('weighted_kappa_linear', a.stats.weightedKappaLinear, a.stats.ci.weightedKappaLinear),
    ...withCi('weighted_kappa_quadratic', a.stats.weightedKappa, a.stats.ci.weightedKappa),
    ...withCi('krippendorff_alpha', a.stats.krippendorffAlpha, a.stats.ci.krippendorffAlpha),
    ...withCi('gwet_ac1', a.stats.gwetAC1, a.stats.ci.gwetAC1),
    ...withCi('gwet_ac2_linear', a.stats.gwetAC2Linear, a.stats.ci.gwetAC2Linear),
    spearman_rho: a.stats.spearman,
    pearson_r: a.stats.pearson,
    mean_absolute_error: a.stats.mae,
  }));
}

// (Kept in view.ts, which the screens use too, and passed on from here.)
export { runIdTag, runName, sharesNumber };

/**
 * What a run's retry counts leave out ('' if nothing), about the requests sent and the tokens, and both in one. For
 * retries a version before October 22, 2026 made: it recorded the number of requests a retry planned, and overwrote
 * the failed attempts a retry replaced. For a retry stopped while requests were under way: by the page closing (those
 * are not counted), or by Cancel or a failed save (counted as sent, with no answer).
 */
export function retryNotes(run: Run, retry: RetriedRequests): { requests: string; tokens: string; both: string } {
  const version = `Annotation Desk ${run.snapshot.appVersion}, used for the run,`;
  const n = (k: number) => k.toLocaleString('en-US');
  // (With other retries, which recorded what they sent, also the total: a lower bound too.)
  const requests = retry.lowerBound
    ? `recorded for Retry failed only the number of requests planned (${n(retry.planned)}), not the number sent: counted from the stored answers, ${retry.legacySent ? `at least ${n(retry.legacySent)} ${retry.legacySent === 1 ? 'was' : 'were'} sent` : `the number sent is not known (no stored answer dates from ${retry.legacy === 1 ? 'it' : 'them'})`}${retry.others ? `; with the run’s other ${retry.others === 1 ? 'retry' : 'retries'}, at least ${n(retry.requests)} in all` : ''}`
    : '';
  const tokens = retry.tokensIncomplete
    ? 'did not keep the failed attempts that Retry failed replaced: their token use is missing from the token counts (which may be too low), and they are not counted as replaced by retries'
    : '';
  const both = [requests, tokens].filter(Boolean).join('; it also ');
  // A retry cut short by the page closing counts the requests answered; those under way then are not known.
  const cut = retry.interrupted
    ? `A Retry failed of this run was interrupted (the page was closed while it was sending): it counts the requests answered; up to ${n(run.snapshot.options.concurrency)} more may have been sent without an answer being recorded.`
    : '';
  // Requests sent when Cancel (or a failed save) stopped a retry: counted, but they left no result and no token count.
  const u = retry.unanswered;
  const stopped = u
    ? `${n(u)} ${u === 1 ? 'request' : 'requests'} sent by Retry failed ${u === 1 ? 'was' : 'were'} stopped (Cancel, or a result that could not be saved) before ${u === 1 ? 'its answer was' : 'their answers were'} stored: counted as sent, ${u === 1 ? 'it left no result (its text keeps any earlier one)' : 'they left no result (their texts keep any earlier one)'}, and ${u === 1 ? 'its' : 'their'} token use (if any) is not in the token counts.`
    : '';
  const join = (...parts: string[]) => parts.filter(Boolean).join(' ');
  return {
    requests: join(requests && `${version} ${requests}.`, cut, stopped),
    tokens: join(tokens && `${version} ${tokens}.`, stopped),
    both: join(both && `${version} ${both}.`, cut, stopped),
  };
}

export function runSummaryRows(runs: Run[], results: Result[]): Row[] {
  return runs.map((r) => {
    const rs = results.filter((x) => x.runId === r.id);
    // Tokens: also those of failed attempts that a retry replaced (paid for too), also during a retry.
    const replaced = replacedAttempts(r, rs);
    const sum = (k: keyof Result['usage']) => rs.reduce((s, x) => s + x.usage[k], 0) + (replaced?.usage[k] ?? 0);
    const retry = retriedRequests(r, rs);
    const notes = retryNotes(r, retry);
    return {
      run: runName(r, runs),
      label: r.label,
      started_at: r.createdAt,
      // (A run still being sent, e.g. by Retry failed, has not finished: an earlier finish time would mislead.)
      finished_at: runInProgress(r) ? null : r.finishedAt,
      status: r.status,
      mode: r.mode,
      batch_id: (r.batch?.parts ?? (r.batch ? [r.batch] : [])).map((p) => p.batchId).join('; '),
      scope: r.scope,
      n_texts: r.docIds.length,
      replicates: r.snapshot.options.replicates,
      requests_ok: rs.filter((x) => x.status === 'ok').length,
      requests_failed: rs.filter((x) => x.status === 'error').length,
      // (At least this many, for retries of versions that recorded only the number planned: see notes.)
      requests_retried: retry.requests,
      requests_replaced_by_retries: replaced?.requests ?? 0,
      provider: r.snapshot.model.provider,
      model_requested: r.snapshot.model.model,
      // (Of usable answers only: a failed one may come from another model, e.g. the refusal fallback of the first version.)
      models_reported: [...new Set(rs.filter((x) => x.status === 'ok').map((x) => x.modelReported).filter(Boolean))].join('; '),
      effort: r.snapshot.model.effort || 'default',
      thinking: r.snapshot.model.provider === 'anthropic' ? thinkingLabel(r.snapshot.model.model, r.snapshot.model.reasoningSummary) : '',
      temperature: r.snapshot.model.temperature ?? 'default',
      max_output_tokens: r.snapshot.model.maxOutputTokens,
      caching: cachingLabel(r),
      prompt_version: r.snapshot.promptVersion,
      prompt_hash: r.snapshot.promptHash,
      input_tokens: sum('inputTokens'),
      output_tokens: sum('outputTokens'),
      reasoning_tokens: sum('reasoningTokens'),
      cache_read_tokens: sum('cacheReadTokens'),
      cache_write_tokens: sum('cacheWriteTokens'),
      app_version: r.snapshot.appVersion,
      error: r.error ?? '',
      notes: notes.both,
    };
  });
}

/** How prompt caching was handled in a run, for exports. Older OpenAI models cache whatever the setting says. */
export function cachingLabel(run: Run): string {
  const { provider, model } = run.snapshot.model;
  if (provider === 'openai' && !supportsExplicitCaching(model)) return 'automatic (OpenAI caches long prompts; cannot be turned off)';
  if (!run.snapshot.options.caching) return 'off';
  return provider === 'anthropic' ? `on (${run.snapshot.options.cacheTtl})` : 'on';
}

export function codebookMarkdown(run: Run): string {
  const p = run.snapshot.prompt;
  if (p.outputMode !== 'structured') return '# Codebook\n\nThe model was asked for a free-text response (no structured fields).\n';
  const lines = ['# Codebook', '', 'Fields the model was required to return (enforced with a JSON schema; see `output_schema.json`).', '', '| Field | Column name | Type | Allowed values | Description |', '|---|---|---|---|---|'];
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  if (p.includeRationale) lines.push('| Rationale | rationale | free text | | Brief justification, generated before the labels |');
  // (A field named like one of the tables' own columns, e.g. status, is exported as answer_status.)
  for (const v of p.variables) lines.push(`| ${esc(v.label?.trim() || v.name)} | ${answerColumn(v.name)} | ${v.type} | ${esc(v.values.filter((x) => x.trim()).join(', '))} | ${esc(v.description)} |`);
  return lines.join('\n') + '\n';
}

/** For the Excel sheet only: doc_id is just the file name minus extension for uploaded files, so show only the file name. CSVs keep doc_id as the join key. */
export function dropRedundantId(rows: Row[]): Row[] {
  const stem = (f: unknown) => String(f ?? '').replace(/\.[^./\\]+$/, '');
  if (!rows.length || !rows.every((r) => 'file' in r && r.doc_id === stem(r.file))) return rows;
  return rows.map(({ doc_id: _id, ...rest }) => rest);
}
