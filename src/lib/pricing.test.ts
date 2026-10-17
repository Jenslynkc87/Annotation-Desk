import { describe, expect, it } from 'vitest';
import { builtInPrice, contextWindow, estimateRun } from './pricing';

const doc = (n: number) => ({ id: String(n), docId: `d${n}`, text: 'x'.repeat(n) });

describe('pricing', () => {
  it('matches dated model ids to the longest known prefix', () => {
    expect(builtInPrice('claude-opus-5-5-20261001')?.input).toBe(4);
    expect(builtInPrice('claude-opus-5-1')?.input).toBe(5);
    expect(builtInPrice('some-other-model')).toBeUndefined();
  });

  it('estimates cost, halves it for batches and multiplies by replicates', () => {
    const base = { docs: [doc(4000)], fixedChars: 0, model: 'claude-sonnet-5-5', maxOutputTokens: 1000, replicates: 1, batch: false, observedOutput: 1000 };
    const e = estimateRun(base);
    // 1,000 input tokens at $2 + 1,000 output tokens at $10 per million
    expect(e.cost).toBeCloseTo(0.012, 6);
    expect(estimateRun({ ...base, batch: true }).cost).toBeCloseTo(0.006, 6);
    expect(estimateRun({ ...base, replicates: 3 }).cost).toBeCloseTo(0.036, 6);
    expect(e.outputAssumed).toBe(false);
  });

  it('gives no cost for an unknown model and flags texts too long for the window', () => {
    expect(estimateRun({ docs: [doc(10)], fixedChars: 0, model: 'mystery', maxOutputTokens: 100, replicates: 1, batch: false, observedOutput: null }).cost).toBeNull();
    expect(contextWindow('mystery')).toBeUndefined();
    const e = estimateRun({ docs: [doc(10), doc(900_000)], fixedChars: 0, model: 'claude-sonnet-4-5', maxOutputTokens: 16000, replicates: 1, batch: false, observedOutput: null });
    expect(e.tooLong.map((d) => d.docId)).toEqual(['d900000']);
  });
});
