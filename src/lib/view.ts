// Derived views over results: which result(s) to show per text, and aggregated values.
import { aggregate, type Aggregation } from './metrics';
import { flattenJsonResponse, outputFields, TEXT_RESPONSE_KEY } from './prompt';
import type { Doc, PromptSpec, Result, Run } from './types';

export type RunFilter = 'latest' | string; // 'latest' or a run id

export interface DocView {
  run: Run | null;
  results: Result[]; // replicates of the chosen run, sorted
  values: Record<string, string>; // aggregated across replicates
  /** Share of replicates agreeing with the aggregate, per field (only when >1 replicate). */
  consistency: Record<string, number>;
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
    if (chosenRun) {
      const ok = reps.filter((r) => r.status === 'ok');
      const combined = ok.length > 1 && chosenRun.snapshot.prompt.outputMode === 'text' ? combineJsonAnswers(ok) : null;
      for (const f of outputFields(chosenRun.snapshot.prompt)) {
        const vals = ok.map((r) => r.values[f] ?? '');
        values[f] = combined ?? aggregate(vals, aggregationFor(chosenRun.snapshot.prompt, f));
        if (vals.length > 1 && !combined) consistency[f] = vals.filter((v) => v === values[f]).length / vals.length;
      }
    }
    const nErr = reps.filter((r) => r.status === 'error').length;
    out.set(d.id, {
      run: chosenRun,
      results: reps,
      values,
      consistency,
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
  const keys = [...new Set(flat.flatMap((x) => Object.keys(x!)))];
  const out: Record<string, string | number> = {};
  for (const k of keys) {
    const vals = flat.map((x) => x![k] ?? '');
    const v = aggregate(vals, 'median');
    out[k] = v !== '' && vals.every((x) => x === '' || isNum(x)) ? Number(v) : v;
  }
  return JSON.stringify(out);
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
