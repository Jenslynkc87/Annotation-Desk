// Cost and length estimates shown before a run. Nothing here calls a provider: the estimate is
// worked out in the browser from text lengths, the codebook and earlier results in the study.
// Prices are list prices in US dollars per million tokens, typed in here (no provider API returns
// them), so they can go out of date: the owner can overwrite them per model in Setup → Model →
// Sampling & limits.

import { useSyncExternalStore } from 'react';
import { supportsAdaptiveThinking } from './providers/anthropic';
import { buildOutputSchema, outputFields, renderMessage, renderMessageParts } from './prompt';
import type { Doc, ModelSettings, PromptSpec, ProviderId, Result, Run, Study } from './types';

export interface Price {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens (reasoning/thinking tokens are billed as output). */
  output: number;
  /** USD per million tokens read from the prompt cache; defaults to 0.1 × input. */
  cacheRead?: number;
  /** Higher prices for requests whose prompt is over `over` tokens (Claude Haiku 5.5). */
  long?: { over: number; input: number; output: number; cacheRead?: number };
}

/** Where the built-in prices come from, per provider. */
export const PRICE_SOURCES: Record<ProviderId, { url: string; checked: string; note?: string }> = {
  anthropic: { url: 'https://platform.claude.com/docs/en/about-claude/pricing', checked: 'October 18, 2026' },
  openai: {
    url: 'https://openai.com/api/pricing/',
    checked: 'October 2026',
    note: "taken from third-party price trackers; OpenAI's own page could not be read automatically",
  },
};
export const PRICES_AS_OF = 'October 2026';

/** Built-in prices; a model id matches the longest key it starts with (so dated ids work). */
const BUILT_IN: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, long: { over: 100_000, input: 0.5, output: 2.5 } },
  'claude-haiku-4-5': { input: 1, output: 5 },
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

/**
 * Characters per token when the study has no earlier results to measure it. About 4 for English
 * prose on older tokenizers; Claude Opus 4.7 and later models use a tokenizer that produces about
 * 30% more tokens for the same text (Anthropic's pricing page), so about 3.1 there.
 */
export function charsPerToken(model: string): number {
  if (/^claude-(fable|mythos)|^claude-(opus|sonnet|haiku)-([5-9]|4-[7-9])(\b|-|$)/.test(model)) return 3.1;
  return 4;
}

/** Shortest fixed prompt part Anthropic will cache (shorter prefixes silently aren't cached). */
function minCacheable(model: string): number {
  if (/^claude-(fable|mythos)|^claude-opus-5/.test(model)) return 512;
  if (/^claude-haiku-4-5/.test(model)) return 4096;
  return 1024;
}

/**
 * Reasoning tokens per request assumed for each effort when the study has no earlier results with
 * the same model and effort. Deliberately wide: how much a model reasons depends on the task.
 */
export const ASSUMED_REASONING: Record<string, [number, number]> = {
  none: [0, 0],
  minimal: [0, 300],
  low: [0, 1500],
  medium: [200, 4000],
  high: [500, 8000],
  xhigh: [1000, 16000],
  max: [2000, 32000],
};

/** Effort the request actually runs at ('' = not sent: the provider's default, or no reasoning). */
function effectiveEffort(m: ModelSettings): string {
  if (m.provider === 'anthropic') {
    if (!supportsAdaptiveThinking(m.model)) return 'none';
    return m.effort || 'medium';
  }
  return m.effort || 'none';
}

/** Characters sent with every text besides the text itself: prompt, system prompt and output schema. */
export function fixedCharsOf(p: PromptSpec): number {
  const schema = buildOutputSchema(p);
  return renderMessage(p.userTemplate, { docId: '', text: '', meta: {} }, p.subject).length + p.system.length + (schema ? JSON.stringify(schema).length : 0);
}

export function fixedChars(study: Study): number {
  return fixedCharsOf(study.prompt);
}

/** Characters that can be cached: the system prompt and the prompt before the text. */
function cacheableChars(p: PromptSpec): number {
  return renderMessageParts(p.userTemplate, { docId: '', text: '', meta: {} }, p.subject).prefix.length + p.system.length;
}

/** Answer length (visible output) assumed from the codebook when there are no earlier results. */
export function assumedAnswerTokens(p: PromptSpec): [number, number] {
  if (p.outputMode !== 'structured') return [50, 600];
  // A label or score is a few tokens with its JSON key; a free-text field (an explanation) is a sentence or a paragraph.
  const text = p.variables.filter((v) => v.type === 'text').length + (p.includeRationale ? 1 : 0);
  const short = p.variables.filter((v) => v.type !== 'text').length;
  return [5 + 8 * short + 40 * text, 20 + 25 * short + 300 * text];
}

/** What earlier results in the study say about this model and prompt. */
export interface Calibration {
  /** Characters per input token measured on earlier requests to this model. */
  charsPerToken: number | null;
  inputN: number;
  /** Mean visible answer tokens on earlier results with this model and these fields. */
  answer: number | null;
  answerN: number;
  /** Mean reasoning tokens on earlier results with this model and effort. */
  reasoning: number | null;
  reasoningN: number;
}

export function calibrate(model: ModelSettings, prompt: PromptSpec, runs: Run[], results: Result[], docs: Doc[]): Calibration {
  const sameModel = new Map(runs.filter((r) => r.snapshot.model.model === model.model).map((r) => [r.id, r]));
  const fieldsKey = JSON.stringify([prompt.outputMode, outputFields(prompt), prompt.includeRationale]);
  const effort = effectiveEffort(model);
  const docLen = new Map(docs.map((d) => [d.id, d.text.length]));
  const fixed = new Map<string, number>();
  let chars = 0, inTok = 0, inputN = 0, ans = 0, answerN = 0, reas = 0, reasoningN = 0;
  for (const r of results) {
    const run = sameModel.get(r.runId);
    if (!run || r.status !== 'ok' || r.usage.outputTokens <= 0) continue;
    const snap = run.snapshot;
    const len = docLen.get(r.docId);
    if (len !== undefined) {
      if (!fixed.has(run.id)) fixed.set(run.id, fixedCharsOf(snap.prompt));
      const u = r.usage;
      // Anthropic reports cached tokens separately; OpenAI's input count already includes them.
      const tokens = snap.model.provider === 'anthropic' ? u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens : u.inputTokens;
      if (tokens > 0) {
        chars += fixed.get(run.id)! + len;
        inTok += tokens;
        inputN++;
      }
    }
    if (JSON.stringify([snap.prompt.outputMode, outputFields(snap.prompt), snap.prompt.includeRationale]) === fieldsKey) {
      ans += Math.max(0, r.usage.outputTokens - r.usage.reasoningTokens);
      answerN++;
    }
    if (effectiveEffort(snap.model) === effort) {
      reas += r.usage.reasoningTokens;
      reasoningN++;
    }
  }
  return {
    charsPerToken: inputN ? chars / inTok : null,
    inputN,
    answer: answerN ? ans / answerN : null,
    answerN,
    reasoning: reasoningN ? reas / reasoningN : null,
    reasoningN,
  };
}

export const NO_CALIBRATION: Calibration = { charsPerToken: null, inputN: 0, answer: null, answerN: 0, reasoning: null, reasoningN: 0 };

export interface Range {
  low: number;
  high: number;
}

export interface Part {
  tokens: Range;
  /** USD, or null when the model has no known price. */
  cost: Range | null;
  /** How the token count was arrived at. */
  basis: 'measured' | 'assumed' | 'none';
}

export interface Estimate {
  texts: number;
  requests: number;
  input: Part;
  answer: Part;
  reasoning: Part;
  total: Range | null;
  price: Price | undefined;
  ownPrice: boolean;
  batch: boolean;
  /** Cache savings counted in the low end, or why none are counted. */
  cache: { assumed: true; tokensPerRequest: number; saving: number | null; ttl: '5m' | '1h' } | { assumed: false; reason: string };
  charsPerToken: number;
  effort: string;
  /** Texts whose request would not fit in the model's context window (with room for the answer). */
  tooLong: Doc[];
  window: number | undefined;
}

export interface EstimateInput {
  docs: Pick<Doc, 'id' | 'docId' | 'text'>[];
  prompt: PromptSpec;
  model: ModelSettings;
  caching: boolean;
  replicates: number;
  batch: boolean;
  calibration: Calibration;
}

// Spread around a measured mean: per-text lengths vary, but over a run they mostly even out.
const MEASURED_LOW = 0.8;
const MEASURED_HIGH = 1.3;
// Spread around a characters-per-token figure: measured on this study, or a rule of thumb.
const CPT_MEASURED: Range = { low: 0.95, high: 1.05 };
const CPT_ASSUMED: Range = { low: 0.85, high: 1.2 };

export function estimateRun(inp: EstimateInput): Estimate {
  const { model, calibration: cal } = inp;
  const id = model.model;
  const price = priceFor(id);
  const window = contextWindow(id);
  const cpt = cal.charsPerToken ?? charsPerToken(id);
  const spread = cal.charsPerToken ? CPT_MEASURED : CPT_ASSUMED;
  const fixed = fixedCharsOf(inp.prompt);
  const effort = effectiveEffort(model);
  const reps = inp.replicates;
  const discount = inp.batch ? 0.5 : 1;

  const [ansLow, ansHigh] = cal.answer !== null ? [cal.answer * MEASURED_LOW, cal.answer * MEASURED_HIGH] : assumedAnswerTokens(inp.prompt);
  const assumedReasoning = ASSUMED_REASONING[effort] ?? ASSUMED_REASONING.medium;
  const noReasoning = effort === 'none';
  const [reaLow, reaHigh] = noReasoning
    ? [0, 0]
    : cal.reasoning !== null
      ? [cal.reasoning * MEASURED_LOW, cal.reasoning * MEASURED_HIGH]
      : [assumedReasoning[0], Math.min(assumedReasoning[1], Math.max(0, model.maxOutputTokens - ansHigh))];

  // Prompt caching (Anthropic only): the fixed part is written once, then read at the cache price.
  const ttl: '5m' | '1h' = inp.batch ? '1h' : '5m';
  const cacheTokens = Math.round(cacheableChars(inp.prompt) / cpt);
  let cache: Estimate['cache'];
  if (model.provider !== 'anthropic') cache = { assumed: false, reason: "OpenAI's cache prices are not built in, so no savings are counted" };
  else if (!inp.caching) cache = { assumed: false, reason: 'caching is off (Setup → Model)' };
  else if (cacheTokens < minCacheable(id))
    cache = { assumed: false, reason: `the fixed part of the prompt (about ${fmtTokens(cacheTokens)} tokens) is shorter than the ${minCacheable(id).toLocaleString()} tokens this model caches` };
  else if (inp.docs.length * reps < 2) cache = { assumed: false, reason: 'a single request cannot reuse the cache' };
  else cache = { assumed: true, tokensPerRequest: cacheTokens, saving: null, ttl };

  let inLow = 0, inHigh = 0, inCostLow = 0, inCostHigh = 0, ansCostLow = 0, ansCostHigh = 0, reaCostLow = 0, reaCostHigh = 0;
  const tooLong: Doc[] = [];
  for (const d of inp.docs) {
    const tokens = (fixed + d.text.length) / cpt;
    const lo = tokens * spread.low;
    const hi = tokens * spread.high;
    inLow += lo;
    inHigh += hi;
    if (window && tokens + model.maxOutputTokens > window) tooLong.push(d as Doc);
    if (price) {
      const tier = price.long && tokens > price.long.over ? price.long : price;
      inCostLow += lo * tier.input;
      inCostHigh += hi * tier.input;
      ansCostLow += ansLow * tier.output;
      ansCostHigh += ansHigh * tier.output;
      reaCostLow += reaLow * tier.output;
      reaCostHigh += reaHigh * tier.output;
    }
  }
  const n = inp.docs.length;
  const requests = n * reps;
  const usd = (x: number) => (x * reps * discount) / 1e6;

  // Low end: every request but the first reads the fixed part from the cache.
  let inputCost: Range | null = price ? { low: usd(inCostLow), high: usd(inCostHigh) } : null;
  if (price && cache.assumed) {
    const read = price.cacheRead ?? price.input * 0.1;
    const write = price.input * (ttl === '1h' ? 2 : 1.25);
    const t = cache.tokensPerRequest * spread.low;
    const saving = ((requests * t * price.input - (t * write + (requests - 1) * t * read)) * discount) / 1e6;
    cache.saving = saving;
    inputCost = { low: Math.max(0, inputCost!.low - saving), high: inputCost!.high };
  }
  const part = (low: number, high: number, cLow: number, cHigh: number, basis: Part['basis']): Part => ({
    tokens: { low: Math.round(low * reps), high: Math.round(high * reps) },
    cost: price ? { low: usd(cLow), high: usd(cHigh) } : null,
    basis,
  });
  const input: Part = { tokens: { low: Math.round(inLow * reps), high: Math.round(inHigh * reps) }, cost: inputCost, basis: cal.charsPerToken ? 'measured' : 'assumed' };
  const answer = part(ansLow * n, ansHigh * n, ansCostLow, ansCostHigh, cal.answer !== null ? 'measured' : 'assumed');
  const reasoning = part(reaLow * n, reaHigh * n, reaCostLow, reaCostHigh, noReasoning ? 'none' : cal.reasoning !== null ? 'measured' : 'assumed');
  const total =
    price && input.cost && answer.cost && reasoning.cost
      ? { low: input.cost.low + answer.cost.low + reasoning.cost.low, high: input.cost.high + answer.cost.high + reasoning.cost.high }
      : null;

  return {
    texts: n,
    requests,
    input,
    answer,
    reasoning,
    total,
    price,
    ownPrice: !!overrides[id],
    batch: inp.batch,
    cache,
    charsPerToken: cpt,
    effort,
    tooLong,
    window,
  };
}

export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

export function fmtUsd(x: number): string {
  if (x < 0.01) return '<$0.01';
  if (x < 10) return `$${x.toFixed(2)}`;
  return `$${Math.round(x).toLocaleString('en-US')}`;
}

export function fmtRange(r: Range, fmt: (x: number) => string): string {
  const a = fmt(r.low);
  const b = fmt(r.high);
  return a === b ? a : `${a}–${b}`;
}

/** One line for the confirmation dialog before a run. */
export function describeEstimate(e: Estimate): string {
  if (!e.total) return 'no price known for this model';
  return `about ${fmtRange(e.total, fmtUsd)}${e.batch ? ' at batch price (½)' : ''} (a rough guide; see Estimate cost for how it is worked out)`;
}
