// Tests for fixes from the October 2026 audit.
import { describe, expect, it } from 'vitest';
import { comparableFields } from './compare';
import { goldColumnsFor, resultsWide } from './export/tables';
import { agreement } from './metrics';
import { buildOutputSchema, normalizeLabel, toNumber } from './prompt';
import { incompleteAnswer } from './store';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type Run } from './types';
import { buildDocViews } from './view';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const mkRun = (prompt: PromptSpec, replicates = 1): Run => ({
  id: 'r', studyId: 's', number: 1, label: '', createdAt: '', finishedAt: null, mode: 'sync', scope: '', docIds: ['d1'], status: 'completed', batch: null, error: null,
  snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: { ...DEFAULT_RUN_OPTIONS, replicates }, prompt, promptVersion: 1, promptHash: 'h', outputSchema: null, requestBase: {} },
});
const mkResult = (rep: number, values: Record<string, string>): Result => ({
  id: `r:d1:${rep}`, runId: 'r', studyId: 's', docId: 'd1', replicate: rep, status: 'ok', values, rationale: '', reasoningSummary: '', rawText: values.response ?? '',
  parseError: null, error: null, usage, latencyMs: 1, requestedAt: '', completedAt: '', responseId: '', modelReported: 'm', stopReason: 'end_turn',
});
const doc = (meta: Record<string, string> = {}): Doc => ({ id: 'd1', studyId: 's', docId: 'a1', text: 't', meta, source: 'a1.txt', order: 1, addedAt: '' });

describe('incomplete answers', () => {
  it('counts only complete stop reasons as complete', () => {
    for (const s of ['end_turn', 'stop_sequence', 'completed', '']) expect(incompleteAnswer(s)).toBe(false);
    for (const s of ['max_tokens', 'refusal', 'refusal (cyber)', 'refusal: no', 'incomplete (max_output_tokens)', 'model_context_window_exceeded']) expect(incompleteAnswer(s)).toBe(true);
  });
});

describe('plain-text JSON answers annotated more than once', () => {
  const text = { ...DEFAULT_PROMPT, outputMode: 'text' as const };
  const run = mkRun(text, 3);
  const results = [
    mkResult(1, { response: '{"race": 2, "race_explanation": "a"}' }),
    mkResult(2, { response: '{"race": 3, "race_explanation": "b"}' }),
    mkResult(3, { response: '{"race": 2, "race_explanation": "c"}' }),
  ];
  it('combines the scores (median), so columns and agreement still work', () => {
    const v = buildDocViews([doc()], [run], results, 'r').get('d1')!;
    expect(JSON.parse(v.values.response)).toEqual({ race: 2, race_explanation: 'a | b | c' });
    expect(comparableFields(run, [v]).map((f) => f.key)).toEqual(['race']);
    const row = resultsWide(run, [doc()], [run], results, { text: false, rationale: false })[0];
    expect(row.race).toBe(2);
    expect(Object.keys(row)).not.toContain('response_agreement_across_runs');
  });
  it('puts each flat-named explanation right after its score', () => {
    const one = [mkResult(1, { response: '{"race_explanation": "x", "race": 1, "gender_explanation": "y", "gender": 0}' })];
    const row = resultsWide(mkRun(text), [doc()], [mkRun(text)], one, { text: false, rationale: false })[0];
    const cols = Object.keys(row).filter((k) => /race|gender/.test(k));
    expect(cols).toEqual(['race', 'race_explanation', 'gender', 'gender_explanation']);
  });
  it('weighs plain-text scores on the whole scale between the lowest and highest value', () => {
    const views = ['-3', '-1', '0', '3'].map((x) => ({ run: run, results: [], values: { response: `{"s": ${x}}` }, consistency: {}, status: 'ok' as const }));
    expect(comparableFields(run, views)[0].allowed).toEqual(['-3', '-2', '-1', '0', '1', '2', '3']);
  });
});

describe('typed minus signs', () => {
  it('reads −3 and –3 as -3 in the scale and in labels', () => {
    expect(toNumber('−3')).toBe(-3);
    expect(toNumber('–2')).toBe(-2);
    expect(normalizeLabel('−2')).toBe('-2');
    const p = { ...DEFAULT_PROMPT, variables: [{ name: 's', type: 'ordinal' as const, values: ['−3', '−2', '−1', '0', '1', '2', '3'], description: '' }] };
    expect((buildOutputSchema(p)!.properties as Record<string, { enum: number[] }>).s.enum).toEqual([-3, -2, -1, 0, 1, 2, 3]);
  });
});

describe('scale fields with a stray non-number label', () => {
  it('leaves "NA" out instead of switching to nominal statistics', () => {
    const a = ['-3', '-1', '0', '0', '2', '3', '1', '0', '-2', '0', '1', '0'];
    const b = ['-2', '1', '0', '0', '2', '1', '1', '0', '-3', '1', '0', '0'];
    const clean = agreement(a.slice(1), b.slice(1), 'ordinal');
    const withNa = agreement(a, ['NA', ...b.slice(1)], 'ordinal');
    expect(withNa.n).toBe(11);
    expect(withNa.level).toBe('ordinal');
    expect(withNa.krippendorffAlpha).toBeCloseTo(clean.krippendorffAlpha!, 10);
    expect(withNa.weightedKappa).not.toBeNull();
    // Labels that are no numbers at all are compared as categories, as before.
    expect(agreement(['low', 'high'], ['low', 'low'], 'ordinal').level).toBe('nominal');
  });
});

describe('finding human label columns', () => {
  it('skips coders’ notes', () => {
    const docs = [doc({ race_gold: '1', race_explanation: 'note', human_race: '2', file: 'a1.txt' })];
    expect(goldColumnsFor('race', docs)).toEqual(['race_gold', 'human_race']);
  });
});
