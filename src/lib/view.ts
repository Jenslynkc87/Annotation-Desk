// Derived views over results: which result(s) to show per text, and aggregated values.
import { aggregate, type Aggregation } from './metrics';
import { flattenJsonResponse, isExplanationKey, outputFields, RATIONALE_KEY, TEXT_RESPONSE_KEY, toNumber } from './prompt';
import type { Doc, PromptSpec, Result, Run } from './types';
import { slug } from './util';

export type RunFilter = 'latest' | string; // 'latest' or a run id

export interface DocView {
  run: Run | null;
  results: Result[]; // replicates of the chosen run, sorted
  values: Record<string, string>; // aggregated across replicates
  /** Share of replicates agreeing with the aggregate, per field (only when >1 replicate). */
  consistency: Record<string, number>;
  /** The rationale (structured runs) of the replicate whose labels are closest to the combined ones. */
  rationale: string;
  status: 'none' | 'ok' | 'error' | 'partial';
}

/** How replicates of a field are combined: median for ordinal scales, mean for numbers, majority otherwise. */
export function aggregationFor(prompt: PromptSpec, field: string): Aggregation {
  const t = prompt.variables.find((x) => x.name === field)?.type;
  return t === 'ordinal' ? 'median' : t === 'number' ? 'mean' : 'majority';
}

export function buildDocViews(docs: Doc[], runs: Run[], results: Result[], filter: RunFilter): Map<string, DocView> {
  const runById = new Map(runs.map((r) => [r.id, r]));
  const byDoc = new Map<string, Result[]>();
  for (const r of results) {
    if (filter !== 'latest' && r.runId !== filter) continue;
    const list = byDoc.get(r.docId);
    if (list) list.push(r);
    else byDoc.set(r.docId, [r]);
  }
  const out = new Map<string, DocView>();
  for (const d of docs) {
    const list = byDoc.get(d.id) ?? [];
    let chosenRun: Run | null = null;
    for (const r of list) {
      const run = runById.get(r.runId);
      // (Of runs that share a number, the one started last, as in the exports.)
      if (run && (!chosenRun || runOrder(run, chosenRun) > 0)) chosenRun = run;
    }
    const reps = chosenRun ? list.filter((r) => r.runId === chosenRun!.id).sort((a, b) => a.replicate - b.replicate) : [];
    const values: Record<string, string> = {};
    const consistency: Record<string, number> = {};
    let rationale = '';
    if (chosenRun) {
      const ok = reps.filter((r) => r.status === 'ok');
      const prompt = chosenRun.snapshot.prompt;
      const combined = ok.length > 1 && prompt.outputMode === 'text' ? combineJsonAnswers(ok) : null;
      const fields = outputFields(prompt);
      const typeOf = (f: string) => prompt.variables.find((v) => v.name === f)?.type;
      const isExplanation = (f: string) => isExplanationKey(f) && typeOf(f) === 'text';
      // The labels an explanation (or the rationale) can belong to: every field but free text.
      const labels = fields.filter((f) => typeOf(f) && typeOf(f) !== 'text');
      const numeric = new Set(labels.filter((f) => typeOf(f) === 'ordinal' || typeOf(f) === 'number'));
      for (const f of fields) {
        if (isExplanation(f)) continue;
        const vals = ok.map((r) => r.values[f] ?? '');
        values[f] = combined ?? aggregate(vals, aggregationFor(prompt, f));
        if (vals.length > 1 && !combined) consistency[f] = vals.filter((v) => v === values[f]).length / vals.length;
      }
      const okValues = ok.map((r) => r.values);
      for (const f of fields.filter(isExplanation)) values[f] = ok[explanationSource(f, values, okValues, labels, numeric)]?.values[f] ?? '';
      rationale = ok[explanationSource(RATIONALE_KEY, values, okValues, labels, numeric)]?.rationale ?? '';
    }
    const nErr = reps.filter((r) => r.status === 'error').length;
    out.set(d.id, {
      run: chosenRun,
      results: reps,
      values,
      consistency,
      rationale,
      status: !reps.length ? 'none' : nErr === reps.length ? 'error' : nErr ? 'partial' : 'ok',
    });
  }
  return out;
}

/**
 * Plain-text runs whose answers are JSON, annotated more than once: combine value by value (the median of
 * numbers, the majority otherwise) into one JSON answer, so the score columns and agreement work as with
 * a single answer. (The answers as a whole always differ, e.g. in their explanations.) Only the answers that
 * are JSON are combined: one written as prose has no scores to add, like a failed one. Null if none is JSON.
 * A value that is a number in most answers is a score: the median of its numbers ("NA" in one answer is left
 * out, as agreement leaves it out).
 */
function combineJsonAnswers(ok: Result[]): string | null {
  const answers = ok.map((r) => flattenJsonResponse(r.values[TEXT_RESPONSE_KEY])).filter((x): x is Record<string, string> => !!x);
  if (!answers.length) return null;
  const keys = [...new Set(answers.flatMap((x) => Object.keys(x)))];
  const isScore = (k: string) => {
    const vs = answers.map((x) => x[k] ?? '').filter((v) => v.trim() !== '');
    const nums = vs.filter((v) => Number.isFinite(toNumber(v)));
    return nums.length > 0 && nums.length >= vs.length / 2;
  };
  const scores = keys.filter((k) => !isExplanationKey(k) && isScore(k));
  const combined: Record<string, string> = {};
  const labels = keys.filter((k) => !isExplanationKey(k));
  for (const k of labels) {
    combined[k] = scores.includes(k)
      ? aggregate(answers.map((x) => toNumber(x[k] ?? '')).filter(Number.isFinite).map(String), 'median')
      : aggregate(answers.map((x) => x[k] ?? ''), 'majority');
  }
  for (const k of keys.filter(isExplanationKey)) combined[k] = answers[explanationSource(k, combined, answers, labels, new Set(scores))][k] ?? '';
  // Keys in the order of the first answer; numbers as numbers.
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, scores.includes(k) && combined[k] !== '' ? Number(combined[k]) : combined[k]])));
}

/**
 * Which replicate's explanation (or rationale) to show for combined answers: the one written with the combined
 * labels (closest to them; the first if tied). Merging all of them would mix in the reasoning for other labels.
 * The labels an explanation belongs to: "race" for race_explanation, else those in its group (race_negative,
 * race_positive for race_explanation), else all of them. Numbers count by distance, other labels by equality.
 */
function explanationSource(key: string, combined: Record<string, string>, answers: Record<string, string>[], labels: string[], numeric: Set<string>): number {
  const base = key.replace(/_(explanation|reasoning)$/, '');
  const own = base === key ? [] : labels.includes(base) ? [base] : labels.filter((s) => s.startsWith(`${base}_`));
  const relevant = own.length ? own : labels;
  let best = 0;
  let bestDistance = Infinity;
  answers.forEach((x, i) => {
    let d = 0;
    for (const s of relevant) {
      const [a, c] = [x[s] ?? '', combined[s] ?? ''];
      d += numeric.has(s) && isNum(a) && isNum(c) ? Math.abs(Number(a) - Number(c)) : a === c ? 0 : 1;
    }
    if (d < bestDistance) [best, bestDistance] = [i, d];
  });
  return best;
}

const isNum = (s: string) => s.trim() !== '' && !Number.isNaN(Number(s));

/**
 * Failed attempts that retries replaced, and their token use: from the results (each keeps its earlier attempts'),
 * so also those of a retry still under way; else the run's own record (runs of October 22, 2026).
 */
export function replacedAttempts(run: Run, results: Result[]): Run['replaced'] {
  let requests = 0;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  for (const r of results) {
    if (r.runId !== run.id) continue;
    requests += Math.max(0, (r.attempt ?? 1) - 1);
    for (const k of Object.keys(usage) as (keyof typeof usage)[]) usage[k] += r.replacedUsage?.[k] ?? 0;
  }
  return requests ? { requests, usage } : run.replaced?.requests ? run.replaced : undefined;
}

/** A run still being sent, or waiting for its batch: an export of it shows the results so far. */
export const runInProgress = (run: Run) => run.status === 'running' || run.status === 'submitted';

/** An immediate "Retry failed" of the run is being sent (the run is "running" until it ends). */
export const retryInProgress = (run: Run) => run.status === 'running' && run.resumeStatus !== undefined;

/** A "Retry failed" of the run not finished yet: being sent, or its batch not back yet (a batch run waits for one
 *  only after its first batches ended). */
export const retryUnderWay = (run: Run) => retryInProgress(run) || (run.status === 'submitted' && !!run.retries?.length);

/**
 * Build ids of versions before October 22, 2026 (the published one among them) are a bare version such as "0.1.0";
 * later ones add the commit ("0.1.0+3f2a9c1 (2026-10-22)").
 */
const BARE_VERSION = /^\d+\.\d+\.\d+$/;

export interface RetryCount {
  at: string;
  asBatch: boolean;
  /** Requests sent (see `retryCounts`). */
  requests: number;
  /** A retry by a version that recorded only the number planned: that number (`requests` is then a lower bound). */
  planned?: number;
  /** Such a retry, whose replaced attempts that version did not keep (their token use is missing). */
  unrecorded?: boolean;
  /** The page closed while it was being sent: `requests` are those answered (a few more may have gone out). */
  interrupted?: boolean;
  /** Of `requests`, those stopped (Cancel, a failed save) before an answer was stored. */
  unanswered?: number;
  /** A batch retry by a version that dated its answers at the run's start: `requests` is the number it recorded. */
  undated?: boolean;
}

/**
 * What each "Retry failed" of a run sent. Versions before October 22, 2026 (bare build id) recorded the number
 * planned before sending, also when the retry was stopped early (60 for 5 sent) or, as a batch, only some of its
 * batches went up (a later upload failed, or the page closed during it): the requests sent from the retry's start
 * until the next retry are counted, from the stored answers and the earlier attempts a later retry replaced
 * (`replacedAt`). That is a lower bound, since those versions overwrote an attempt a retry replaced (and attempts
 * replaced before October 23, 2026 are only in the logs); such a batch retry whose batches are not back yet counts
 * the answers so far (none at first). An immediate retry still being sent: its answers so far.
 *
 * The batch builds of October 18–20, 2026 (live before the published one) dated every batch answer at the run's start
 * and kept no upload time on their batches, so no answer of their batch retries falls in its window: such a retry
 * counts the number it recorded, which it saved only once its batch had gone up (`undated`).
 */
export function retryCounts(run: Run, results: Result[]): RetryCount[] {
  const entries = [...(run.retries ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  if (!entries.length) return [];
  const legacy = BARE_VERSION.test(run.snapshot.appVersion);
  const parts = run.batch?.parts ?? [];
  // Every request a result records, each with its attempt number: the earlier attempts later retries replaced (those
  // whose request time it kept, from October 23, 2026), then its own.
  const sends = results.flatMap((r) => {
    if (r.runId !== run.id) return [];
    const n = r.attempt ?? 1;
    const before = r.replacedAt ?? [];
    return [...before.map((at, j) => ({ at, attempt: n - before.length + j })), { at: r.requestedAt, attempt: n }];
  });
  const within = (i: number) => sends.filter((s) => s.at >= entries[i].at && (i + 1 >= entries.length || s.at < entries[i + 1].at));
  return entries.map((e, i) => {
    const asBatch = !!e.asBatch;
    if (legacy && !e.counted) {
      // A batch retry with no batch uploaded in its window, among batches without an upload time: undated answers.
      const next = entries[i + 1]?.at;
      const undated =
        asBatch && parts.some((p) => !p.submittedAt) && !parts.some((p) => p.submittedAt && p.submittedAt >= e.at && (!next || p.submittedAt < next));
      // (Its replaced attempts were overwritten too.)
      if (undated) return { at: e.at, asBatch, requests: e.requests, planned: e.requests, unrecorded: true, undated: true };
      // (Requests that record no earlier attempt: whatever they replaced, that version didn't keep.)
      const found = within(i);
      const unrecorded = found.some((s) => s.attempt < 2) || (!asBatch && found.length < e.requests);
      // (Never more than it planned.)
      return { at: e.at, asBatch, requests: Math.min(found.length, e.requests), planned: e.requests, unrecorded };
    }
    if (!asBatch && i === entries.length - 1 && retryInProgress(run)) return { at: e.at, asBatch, requests: within(i).length };
    return { at: e.at, asBatch, requests: e.requests, ...(e.interrupted ? { interrupted: true } : {}), ...(e.unanswered ? { unanswered: e.unanswered } : {}) };
  });
}

export interface RetriedRequests {
  /** Requests "Retry failed" sent in all (at least this many when `lowerBound`). */
  requests: number;
  /** Retries by a version that recorded only the number planned, and fewer answers to them are stored. */
  lowerBound: boolean;
  /** Retries by such a version (not `undated` ones), the number they planned, and the requests counted for them (from the stored answers). */
  legacy: number;
  planned: number;
  legacySent: number;
  /** Retries recorded as sent (by later versions, a batch, or an Oct 18–20 batch retry: `undated`). */
  others: number;
  /** Those retries replaced attempts that version didn't keep: the run's token counts may be too low. */
  tokensIncomplete: boolean;
  asBatch: 'all' | 'none' | 'some';
  /** A retry was interrupted by the page closing: `requests` is then at least this many too. */
  interrupted: boolean;
  /** Requests sent that were stopped (Cancel, a failed save) before an answer was stored: no result, no token count. */
  unanswered: number;
  /** How many retries were interrupted, and how many stopped with requests under way (`unanswered`). */
  retriesInterrupted: number;
  retriesStopped: number;
  /** Batch retries counted as the number recorded (answers dated at the run's start, see `retryCounts`), and that number. */
  undated: number;
  undatedRequests: number;
}

/** The requests a run's retries sent, for the exports (see `retryCounts`). */
export function retriedRequests(run: Run, results: Result[]): RetriedRequests {
  const counts = retryCounts(run, results);
  // (An Oct 18–20 batch retry counts the number it recorded, not a lower bound: among the others.)
  const legacy = counts.filter((c) => c.planned !== undefined && !c.undated);
  return {
    requests: counts.reduce((s, c) => s + c.requests, 0),
    lowerBound: legacy.some((c) => c.requests < c.planned!),
    legacy: legacy.length,
    planned: legacy.reduce((s, c) => s + c.planned!, 0),
    legacySent: legacy.reduce((s, c) => s + c.requests, 0),
    others: counts.length - legacy.length,
    tokensIncomplete: counts.some((c) => c.unrecorded),
    asBatch: counts.every((c) => c.asBatch) ? 'all' : counts.every((c) => !c.asBatch) ? 'none' : 'some',
    interrupted: counts.some((c) => c.interrupted),
    unanswered: counts.reduce((s, c) => s + (c.unanswered ?? 0), 0),
    retriesInterrupted: counts.filter((c) => c.interrupted).length,
    retriesStopped: counts.filter((c) => c.unanswered).length,
    undated: counts.filter((c) => c.undated).length,
    undatedRequests: counts.reduce((s, c) => s + (c.undated ? c.requests : 0), 0),
  };
}

/** A run's token use: its results, plus failed attempts that a retry replaced (`replaced`), which were paid for too. */
export function runTokens(results: Result[], runId: string, replaced?: Run['replaced']) {
  let input = replaced?.usage.inputTokens ?? 0;
  let output = replaced?.usage.outputTokens ?? 0;
  let cacheRead = replaced?.usage.cacheReadTokens ?? 0;
  let cacheWrite = replaced?.usage.cacheWriteTokens ?? 0;
  let ok = 0;
  let failed = 0;
  for (const r of results) {
    if (r.runId !== runId) continue;
    input += r.usage.inputTokens;
    output += r.usage.outputTokens;
    cacheRead += r.usage.cacheReadTokens;
    cacheWrite += r.usage.cacheWriteTokens;
    if (r.status === 'ok') ok++;
    else failed++;
  }
  return { input, output, cacheRead, cacheWrite, ok, failed };
}

/** Runs that share their number with another one (given twice by versions before October 22, 2026, open in two tabs). */
export const sharesNumber = (run: Run, runs: Run[]) => runs.some((r) => r.id !== run.id && r.number === run.number);

/** Runs in the order they were made: by number, then (runs that share one) by start time. */
export const runOrder = (a: Run, b: Run) => a.number - b.number || (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id);

/**
 * When a run started, to the second, or with `ms` to the millisecond: "20261022-221754Z" ("…-221754.123Z"). In UTC,
 * so a name is the same on every computer; the Z says so, since the screens show local times next to it.
 */
function startTag(run: Run, ms = false): string {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{3}))?/.exec(run.createdAt ?? '');
  return m ? `${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}${m[6]}${ms ? `.${m[7] ?? '000'}` : ''}Z` : '';
}

/**
 * Tells apart runs that share a number (also in their folder names): when the run started, which a copy of the study
 * keeps (a backup import gives runs new ids). Two such runs started in the same second: to the millisecond; in the
 * same millisecond: also the start of the id.
 */
export function runTag(run: Run, runs: Run[]): string {
  const twins = runs.filter((r) => r.id !== run.id && r.number === run.number);
  for (const ms of [false, true]) {
    const tag = startTag(run, ms);
    if (tag && !twins.some((r) => startTag(r, ms) === tag)) return tag;
  }
  return [startTag(run, true), slug(run.id.slice(0, 8))].filter(Boolean).join('-');
}

/** A run as the app and its exports name it: its number, or for runs that share one, the number and when it started ("5-20261022-221754Z"). */
export function runName(run: Run, runs: Run[]): number | string {
  return sharesNumber(run, runs) ? `${run.number}-${runTag(run, runs)}` : run.number;
}

/** "#5 · label". `runs`: the study's runs, so runs that share a number are told apart as in the exports (`runName`). */
export function runTitle(run: Run, runs?: Run[]): string {
  return `#${runs ? runName(run, runs) : run.number}${run.label ? ` · ${run.label}` : ''}`;
}
