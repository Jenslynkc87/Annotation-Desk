import { describe, expect, it } from 'vitest';
import { comparableFields, fieldValue } from './compare';
import { comparisonSentence } from './export/packages';
import { agreement } from './metrics';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Run } from './types';
import type { DocView } from './view';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const textRun: Run = {
  id: 'r', studyId: 's', number: 1, label: '', createdAt: '', finishedAt: null, mode: 'sync', scope: '', docIds: [], status: 'completed', batch: null, error: null,
  snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt: { ...DEFAULT_PROMPT, outputMode: 'text' }, promptVersion: 1, promptHash: 'h', outputSchema: null, requestBase: {} },
};
const view = (response: string): DocView => ({ run: textRun, results: [], values: { response }, consistency: {}, status: 'ok' });

describe('comparing plain-text runs that answer in JSON', () => {
  const views = [view('{"race": {"reasoning": "x", "negative": 2, "positive": 0}, "note": "hi"}'), view('{"race": {"reasoning": "y", "negative": 1, "positive": 0.5}}')];
  it('uses the numeric scores, not reasoning or other text', () => {
    const f = comparableFields(textRun, views);
    expect(f.map((x) => [x.key, x.level])).toEqual([
      ['race_negative', 'ordinal'],
      ['race_positive', 'interval'],
    ]);
    expect(fieldValue(textRun, views[0].values, 'race_negative')).toBe('2');
  });
});

describe('draft text', () => {
  it('reports exact, within-one and a systematic difference', () => {
    const a = Array.from({ length: 40 }, (_, i) => String((i % 4) + 1));
    const b = a.map((x, i) => String(Math.min(4, Number(x) + (i % 3 === 0 ? 1 : 0))));
    const text = comparisonSentence('Score', 'Opus', 'Sol', agreement(a, b, 'ordinal', ['1', '2', '3', '4'], 1), 40);
    expect(text).toMatch(/^For Score, Opus and Sol gave identical scores for \d+\.\d% of texts \(95% CI/);
    expect(text).toContain('within 1 point for 100.0%');
    expect(text).toMatch(/Sol scored on average 0\.\d\d points higher than Opus/);
  });
});
