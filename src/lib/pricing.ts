// Rough cost and length estimates shown before a run. Prices are list prices in US dollars per
// million tokens, typed in here (no provider API returns them), so they can go out of date: the
// owner can overwrite them per model in Setup → Model → Sampling & limits.

import { useSyncExternalStore } from 'react';
import { buildOutputSchema, renderMessage } from './prompt';
import type { Doc, Result, Run, Study } from './types';

export interface Price {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens (thinking tokens are billed as output). */
  output: number;
  /** Higher prices for requests whose prompt is over `over` tokens (Claude Haiku 5.5). */
  long?: { over: number; input: number; output: number };
}

/** Built-in prices; a model id matches the longest key it starts with (so dated ids work). */
export const PRICES_AS_OF = 'October 2026';
const BUILT_IN: Record<string, Price> = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, long: { over: 100_000, input: 0.5, output: 2.5 } },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // OpenAI figures come from third-party price trackers, not from OpenAI's own page.
  'gpt-6-astra': { input: 10, output: 50 },
  'gpt-6.1-sol': { input: 2, output: 10 },
  'gpt-6-sol': { input: 2, output: 10 },
  'gpt-6-luna': { input: 0.1, output: 0.5 },
};

const STORAGE = 'annotation-desk-prices';
type Overrides = Record<string, { input: number; output: number }>;

function loadOverrides(): Overrides {
  try {
    return JSON.parse(localStorage.getItem(STORAGE) ?? '{}') as Overrides;
  } catch {
    return {};
  }
}

let overrides: Overrides = loadOverrides();
const listeners = new Set<() => void>();

/** Own prices for a model replace the built-in ones; `null` goes back to the built-in. */
export function setPriceOverride(model: string, price: { input: number; output: number } | null) {
  overrides = { ...overrides };
  if (price) overrides[model] = price;
  else delete overrides[model];
  try {
    localStorage.setItem(STORAGE, JSON.stringify(overrides));
  } catch {
    /* storage unavailable: the change lasts until the page is closed */
  }
  listeners.forEach((l) => l());
}

export function usePriceOverrides(): Overrides {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => overrides,
  );
}

export function builtInPrice(model: string): Price | undefined {
  const keys = Object.keys(BUILT_IN)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length);
  return keys.length ? BUILT_IN[keys[0]] : undefined;
}

export function priceFor(model: string, own: Overrides = overrides): Price | undefined {
  const o = own[model];
  return o ? { input: o.input, output: o.output } : builtInPrice(model);
}

/** Context window in tokens, or undefined when unknown (then no length warning is shown). */
export function contextWindow(model: string): number | undefined {
  if (/^claude-(fable|mythos)-5|^claude-(opus|sonnet|haiku)-5|^claude-(opus|sonnet)-4-[6-9]/.test(model)) return 1_000_000;
  if (/^claude-/.test(model)) return 200_000;
  return undefined;
}

/** Roughly 4 characters per token for English prose; the true count differs a little by model. */
export const CHARS_PER_TOKEN = 4;
/** Output tokens per request assumed when the study has no earlier results for the model. */
export const ASSUMED_OUTPUT_TOKENS = 500;

/** Average output tokens per request from earlier successful results with this model. */
export function observedOutputTokens(model: string, runs: Run[], results: Result[]): number | null {
  const ids = new Set(runs.filter((r) => r.snapshot.model.model === model).map((r) => r.id));
  let sum = 0;
  let n = 0;
  for (const r of results) {
    if (r.status === 'ok' && ids.has(r.runId) && r.usage.outputTokens > 0) {
      sum += r.usage.outputTokens;
      n++;
    }
  }
  return n ? sum / n : null;
}

/** Characters sent with every text besides the text itself: prompt, system prompt and output schema. */
export function fixedChars(study: Study): number {
  const p = study.prompt;
  const schema = buildOutputSchema(p);
  return renderMessage(p.userTemplate, { docId: '', text: '', meta: {} }).length + p.system.length + (schema ? JSON.stringify(schema).length : 0);
}

export interface Estimate {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** USD, or null when the model has no known price. */
  cost: number | null;
  outputAssumed: boolean;
  /** Texts whose request would not fit in the model's context window (with room for the answer). */
  tooLong: Doc[];
  window: number | undefined;
}

export interface EstimateInput {
  docs: Pick<Doc, 'id' | 'docId' | 'text'>[];
  fixedChars: number; // see fixedChars()
  model: string;
  maxOutputTokens: number;
  replicates: number;
  batch: boolean;
  observedOutput: number | null;
}

export function estimateRun(inp: EstimateInput): Estimate {
  const price = priceFor(inp.model);
  const window = contextWindow(inp.model);
  const outPer = inp.observedOutput ?? ASSUMED_OUTPUT_TOKENS;
  const discount = inp.batch ? 0.5 : 1;
  let inputTokens = 0;
  let cost = 0;
  const tooLong: Doc[] = [];
  for (const d of inp.docs) {
    const tokens = Math.ceil((inp.fixedChars + d.text.length) / CHARS_PER_TOKEN);
    inputTokens += tokens;
    if (window && tokens + inp.maxOutputTokens > window) tooLong.push(d as Doc);
    if (price) {
      const tier = price.long && tokens > price.long.over ? price.long : price;
      cost += (tokens * tier.input + outPer * tier.output) / 1e6;
    }
  }
  inputTokens *= inp.replicates;
  return {
    requests: inp.docs.length * inp.replicates,
    inputTokens,
    outputTokens: Math.round(outPer * inp.docs.length * inp.replicates),
    cost: price ? cost * inp.replicates * discount : null,
    outputAssumed: inp.observedOutput === null,
    tooLong,
    window,
  };
}

export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

export function fmtUsd(x: number): string {
  if (x < 0.01) return '<$0.01';
  if (x < 10) return `$${x.toFixed(2)}`;
  return `$${Math.round(x).toLocaleString('en-US')}`;
}

/** One line for the hint under the run buttons and the confirmation dialog. */
export function describeEstimate(e: Estimate, batch = false): string {
  const cost = e.cost === null ? 'no price known for this model' : `about ${fmtUsd(e.cost)}${batch ? ' at batch price (½)' : ''}`;
  return `${cost} (≈${fmtTokens(e.inputTokens)} input and ≈${fmtTokens(e.outputTokens)} output tokens${e.outputAssumed ? ', output assumed' : ''}; before caching)`;
}
