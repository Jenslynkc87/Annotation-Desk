// Tests for fixes from the October 2026 audit.
import { describe, expect, it } from 'vitest';
import { comparableFields } from './compare';
import { pyStr } from './export/python';
import { agreementForRun, goldColumnsFor, resultsLong, resultsWide } from './export/tables';
import { agreement } from './metrics';
import { buildOutputSchema, normalizeLabel, toNumber } from './prompt';
import { groupForBatches, incompleteAnswer } from './store';
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
    mkResult(1, { response: '{"race": 3, "race_explanation": "a"}' }),
    mkResult(2, { response: '{"race": 2, "race_explanation": "b"}' }),
    mkResult(3, { response: '{"race": 2, "race_explanation": "c"}' }),
  ];
  it('combines the scores (median), so columns and agreement still work', () => {
    const v = buildDocViews([doc()], [run], results, 'r').get('d1')!;
    // The explanation is the one written with the combined score (the first such), not a merge of all three.
    expect(JSON.parse(v.values.response)).toEqual({ race: 2, race_explanation: 'b' });
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
    // (Read from each answer, as a view holds them.)
    const views = ['-3', '-1', '0', '3'].map((x) => ({ run: run, results: [mkResult(1, { response: `{"s": ${x}}` })], values: { response: `{"s": ${x}}` }, consistency: {}, rationale: '', status: 'ok' as const }));
    expect(comparableFields(run, views)[0].allowed).toEqual(['-3', '-2', '-1', '0', '1', '2', '3']);
  });
});

describe('explanations of combined answers in structured runs', () => {
  it('takes the explanation written with the combined score', () => {
    const p = {
      ...DEFAULT_PROMPT,
      variables: [
        { name: 'race_explanation', type: 'text' as const, values: [], description: '' },
        { name: 'race', type: 'ordinal' as const, values: ['0', '1', '2', '3'], description: '' },
        { name: 'note', type: 'text' as const, values: [], description: '' },
      ],
    };
    const rs = [mkResult(1, { race: '3', race_explanation: 'three', note: 'x' }), mkResult(2, { race: '1', race_explanation: 'one', note: 'x' }), mkResult(3, { race: '1', race_explanation: 'also one', note: 'y' })];
    const v = buildDocViews([doc()], [mkRun(p, 3)], rs, 'r').get('d1')!;
    expect(v.values).toMatchObject({ race: '1', race_explanation: 'one', note: 'x' });
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
    expect(withNa.leftOut).toEqual({ n: 1, values: ['NA'] });
    // Mostly words (e.g. "2 (moderate)"): compared as categories, as before, with nothing left out.
    const words = agreement(['1', '2 (moderate)', '3 (high)'], ['1', '2 (moderate)', '1 (low)'], 'ordinal');
    expect([words.level, words.n, words.leftOut.n]).toEqual(['nominal', 3, 0]);
  });
});

describe('finding human label columns', () => {
  it('skips coders’ notes', () => {
    const docs = [doc({ race_gold: '1', race_explanation: 'note', human_race: '2', file: 'a1.txt' })];
    expect(goldColumnsFor('race', docs)).toEqual(['race_gold', 'human_race']);
  });
});

describe('batches over the provider’s limit', () => {
  it('are split in order, keeping a margin below the limit', () => {
    expect(groupForBatches('anthropic', [100e6, 100e6, 100e6])).toEqual([[0, 1], [2]]);
    expect(groupForBatches('anthropic', [1e6, 2e6])).toEqual([[0, 1]]);
    // OpenAI: 200 MB per batch, so 2 × 100 MB no longer fit together with the margin.
    expect(groupForBatches('openai', [100e6, 100e6])).toEqual([[0], [1]]);
  });
});

describe('second audit (Oct 2026)', () => {
  const text = { ...DEFAULT_PROMPT, outputMode: 'text' as const };
  it('exports agreement for the scores in plain-text JSON answers, as the app shows it', () => {
    const run = mkRun(text);
    const results = [mkResult(1, { response: '{"race": 2, "explanation": "x"}' })];
    const rows = agreementForRun(run, [doc({ race_gold: '2' })], [run], results);
    expect(rows.map((r) => [r.field, r.compared_with, r.stats.n])).toEqual([['race', 'race_gold', 1]]);
  });
  it('treats a JSON field of scores with a stray "NA" as scores', () => {
    const views = ['1', '2', '"NA"', '3'].map((x) => ({ run: mkRun(text), results: [mkResult(1, { response: `{"s": ${x}}` })], values: { response: `{"s": ${x}}` }, consistency: {}, rationale: '', status: 'ok' as const }));
    const f = comparableFields(mkRun(text), views);
    expect(f.map((x) => [x.key, x.level, x.scaleSeen])).toEqual([['s', 'ordinal', true]]);
  });
  it('does not take the midpoint of the values seen as the scale’s midpoint', () => {
    // Scores 0–3 seen, no codebook: 1 vs 3 is not "opposite direction" (the scale may well be −3…3).
    const a = ['1', '3', '0', '2'];
    const b = ['3', '1', '0', '2'];
    const allowed = ['0', '1', '2', '3'];
    expect(agreement(a, b, 'ordinal', allowed).oppositeDirection).toBe(0.5);
    expect(agreement(a, b, 'ordinal', allowed, 1, { scaleSeen: true }).oppositeDirection ?? null).toBeNull();
  });
  it('takes the explanation and rationale written with the combined category', () => {
    const p = {
      ...DEFAULT_PROMPT,
      includeRationale: true,
      variables: [
        { name: 'stance', type: 'category' as const, values: ['for', 'against'], description: '' },
        { name: 'stance_explanation', type: 'text' as const, values: [], description: '' },
      ],
    };
    const rs = [mkResult(1, { stance: 'for', stance_explanation: 'pro' }), mkResult(2, { stance: 'against', stance_explanation: 'contra' }), mkResult(3, { stance: 'against', stance_explanation: 'also contra' })];
    rs.forEach((r, i) => (r.rationale = `rationale ${i + 1}`));
    const v = buildDocViews([doc()], [mkRun(p, 3)], rs, 'r').get('d1')!;
    expect([v.values.stance, v.values.stance_explanation, v.rationale]).toEqual(['against', 'contra', 'rationale 2']);
  });
  it('gives a field named like one of the table’s own columns its own column', () => {
    const p = { ...DEFAULT_PROMPT, variables: [{ name: 'status', type: 'category' as const, values: ['active', 'retired'], description: '' }] };
    const run = mkRun(p);
    const r = { ...mkResult(1, { status: 'retired' }), error: null };
    const long = resultsLong({ name: 'S' } as never, [run], [doc()], [r], { rationale: false, reasoning: false })[0];
    expect([long.status, long.answer_status]).toEqual(['ok', 'retired']);
    const json = resultsLong({ name: 'S' } as never, [mkRun(text)], [doc()], [mkResult(1, { response: '{"error": 1, "rationale": "why"}' })], { rationale: true, reasoning: false })[0];
    expect([json.error, json.answer_error, json.answer_rationale]).toEqual(['', 1, 'why']);
  });
  it('writes any text as a Python literal that reads back the same', () => {
    expect(pyStr('a\r\nb')).toBe('"""a\\r\nb"""');
    expect(pyStr('"""\n"""')).toBe('"""\\"""\n\\"\\"\\""""');
  });
});
