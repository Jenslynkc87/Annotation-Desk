import { describe, expect, it } from 'vitest';
import { builtInPrice, calibrate, charsPerToken, contextWindow, estimateRun, NO_CALIBRATION, type EstimateInput } from './pricing';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, type Doc, type PromptSpec, type Result, type Run } from './types';

const doc = (n: number) => ({ id: String(n), docId: `d${n}`, text: 'x'.repeat(n) });
// Plain-text prompt with nothing but the text: no fixed characters at all.
const bare: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'text', userTemplate: '' };
const model = (id: string, effort = 'medium', provider: 'anthropic' | 'openai' = 'anthropic') => ({ ...DEFAULT_MODEL_SETTINGS, provider, model: id, effort });

describe('pricing', () => {
  it('matches dated model ids to the longest known prefix', () => {
    expect(builtInPrice('claude-opus-5-5-20261001')?.input).toBe(4);
    expect(builtInPrice('claude-opus-5-1')?.input).toBe(5);
    expect(builtInPrice('claude-fable-5-1')?.cacheRead).toBe(0.25);
    expect(builtInPrice('claude-fable-5')?.cacheRead).toBeUndefined();
    expect(builtInPrice('some-other-model')).toBeUndefined();
  });

  it('uses about 30% more tokens per character on the newer Claude tokenizer', () => {
    expect(charsPerToken('claude-opus-5-5')).toBe(3.1);
    expect(charsPerToken('claude-opus-4-7')).toBe(3.1);
    expect(charsPerToken('claude-opus-4-6')).toBe(4);
    expect(charsPerToken('gpt-6-luna')).toBe(4);
  });

  it('gives a range from measured lengths, halves it for batches and multiplies by replicates', () => {
    // Haiku 4.5 has no adaptive thinking, so no reasoning tokens; $1 / $5 per million.
    const base: EstimateInput = {
      docs: [doc(4000)],
      prompt: bare,
      model: model('claude-haiku-4-5'),
      caching: false,
      replicates: 1,
      batch: false,
      calibration: { ...NO_CALIBRATION, charsPerToken: 4, inputN: 1, answer: 100, answerN: 1 },
    };
    const e = estimateRun(base);
    // 1,000 input tokens ±5% at $1; 100 answer tokens −20%/+30% at $5
    expect(e.input.tokens).toEqual({ low: 950, high: 1050 });
    expect(e.answer.tokens).toEqual({ low: 80, high: 130 });
    expect(e.reasoning.basis).toBe('none');
    expect(e.total!.low).toBeCloseTo(0.00135, 8);
    expect(e.total!.high).toBeCloseTo(0.0017, 8);
    expect(estimateRun({ ...base, batch: true }).total!.high).toBeCloseTo(0.00085, 8);
    expect(estimateRun({ ...base, replicates: 3 }).total!.high).toBeCloseTo(0.0051, 8);
    expect(estimateRun({ ...base, replicates: 3 }).requests).toBe(3);
  });

  it('assumes reasoning from the effort, capped by the output limit', () => {
    const base: EstimateInput = { docs: [doc(400)], prompt: bare, model: model('claude-opus-5-5'), caching: false, replicates: 1, batch: false, calibration: NO_CALIBRATION };
    const e = estimateRun(base);
    expect(e.reasoning.basis).toBe('assumed');
    expect(e.reasoning.tokens).toEqual({ low: 200, high: 4000 });
    const capped = estimateRun({ ...base, model: { ...model('claude-opus-5-5', 'max'), maxOutputTokens: 1000 } });
    expect(capped.reasoning.tokens.high).toBe(1000 - 600); // answer up to 600 in plain-text mode
    expect(estimateRun({ ...base, model: model('gpt-6-luna', 'none', 'openai') }).reasoning.basis).toBe('none');
  });

  it('counts cache savings in the low end only, and only when they can apply', () => {
    const prompt: PromptSpec = { ...bare, userTemplate: 'Instructions. '.repeat(3000) }; // ~13,500 tokens before the text
    const base: EstimateInput = { docs: Array.from({ length: 10 }, (_, i) => doc(1000 + i)), prompt, model: model('claude-sonnet-5-5'), caching: true, replicates: 1, batch: false, calibration: NO_CALIBRATION };
    const cached = estimateRun(base);
    const uncached = estimateRun({ ...base, caching: false });
    expect(cached.cache.assumed).toBe(true);
    expect(cached.input.cost!.low).toBeLessThan(uncached.input.cost!.low);
    expect(cached.input.cost!.high).toBeCloseTo(uncached.input.cost!.high, 10);
    expect(uncached.cache).toMatchObject({ assumed: false });
    expect(estimateRun({ ...base, model: model('gpt-6.1-sol', 'medium', 'openai') }).cache.assumed).toBe(false);
    expect(estimateRun({ ...base, prompt: bare }).cache.assumed).toBe(false); // nothing fixed to cache
  });

  it('gives no cost for an unknown model and flags texts too long for the window', () => {
    expect(estimateRun({ docs: [doc(10)], prompt: bare, model: model('mystery'), caching: false, replicates: 1, batch: false, calibration: NO_CALIBRATION }).total).toBeNull();
    expect(contextWindow('mystery')).toBeUndefined();
    const e = estimateRun({ docs: [doc(10), doc(900_000)], prompt: bare, model: { ...model('claude-sonnet-4-5'), maxOutputTokens: 16000 }, caching: false, replicates: 1, batch: false, calibration: NO_CALIBRATION });
    expect(e.tooLong.map((d) => d.docId)).toEqual(['d900000']);
  });

  it('measures characters per token, answer and reasoning length from earlier results', () => {
    const m = model('claude-opus-5-5', 'high');
    const run = { id: 'r1', snapshot: { model: m, prompt: bare } } as unknown as Run;
    const other = { id: 'r2', snapshot: { model: { ...m, effort: 'low' }, prompt: bare } } as unknown as Run;
    const docs = [{ ...doc(3100), id: 'a' }, { ...doc(6200), id: 'b' }] as Doc[];
    const res = (runId: string, docId: string, usage: Partial<Result['usage']>) =>
      ({ runId, docId, status: 'ok', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, ...usage } }) as Result;
    const results = [
      res('r1', 'a', { inputTokens: 600, cacheReadTokens: 400, outputTokens: 1100, reasoningTokens: 1000 }),
      res('r1', 'b', { inputTokens: 2000, outputTokens: 3300, reasoningTokens: 3000 }),
      res('r2', 'a', { inputTokens: 1000, outputTokens: 150, reasoningTokens: 50 }),
    ];
    const c = calibrate(m, bare, [run, other], results, docs);
    expect(c.charsPerToken).toBeCloseTo((3100 + 6200 + 3100) / (1000 + 2000 + 1000), 10);
    expect(c.answer).toBeCloseTo((100 + 300 + 100) / 3, 10);
    expect(c.reasoning).toBe(2000); // only the two results at high effort
    expect(c.reasoningN).toBe(2);
  });
});
