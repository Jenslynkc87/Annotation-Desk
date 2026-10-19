// Derived views over results: which result(s) to show per text, and aggregated values.
import { aggregate, type Aggregation } from './metrics';
import { flattenJsonResponse, isExplanationKey, outputFields, RATIONALE_KEY, TEXT_RESPONSE_KEY } from './prompt';
import type { Doc, PromptSpec, Result, Run } from './types';

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
      if (run && (!chosenRun || run.number > chosenRun.number)) chosenRun = run;
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
 * a single answer. (The answers as a whole always differ, e.g. in their explanations.) Null if any isn't JSON.
 */
function combineJsonAnswers(ok: Result[]): string | null {
  const flat = ok.map((r) => flattenJsonResponse(r.values[TEXT_RESPONSE_KEY]));
  if (flat.some((x) => !x)) return null;
  const answers = flat as Record<string, string>[];
  const keys = [...new Set(answers.flatMap((x) => Object.keys(x)))];
  const scores = keys.filter((k) => answers.every((x) => (x[k] ?? '') === '' || isNum(x[k])) && answers.some((x) => isNum(x[k] ?? '')));
  const combined: Record<string, string> = {};
  const labels = keys.filter((k) => !isExplanationKey(k));
  for (const k of labels) combined[k] = aggregate(answers.map((x) => x[k] ?? ''), scores.includes(k) ? 'median' : 'majority');
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

export function runTokens(results: Result[], runId: string) {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
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

export function runTitle(run: Run): string {
  return `#${run.number}${run.label ? ` · ${run.label}` : ''}`;
}
