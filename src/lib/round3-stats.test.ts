// Tests for the third review round (October 23, 2026), statistics: the scale of scores in plain-text answers (grown
// from the range of the model's answers), the nominal level on a numeric scale, "NA" cells as blank cells, label
// columns, and the Agreement panel's field for a run and a label column.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { chosenField, leftOutReason, outsideAnswersNote } from '../components/RunsView';
import { combineFields, comparableFields } from './compare';
import { agreementForRun, knownFieldNames, labelPairs, labelValue } from './export/tables';
import { agreement, grownScale, seeded } from './metrics';
import { buildDocViews } from './view';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type Run, type Study, type Variable } from './types';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const text: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'text', variables: [] };
const variable = (name: string, type: Variable['type'], values: string[] = []): Variable => ({ name, type, values, description: '' });
const structured = (...variables: Variable[]): PromptSpec => ({ ...DEFAULT_PROMPT, outputMode: 'structured', variables });
const mkRun = (prompt: PromptSpec, docIds: string[], id = 'r', number = 1, replicates = 1): Run => ({
  id, studyId: 's', number, label: '', createdAt: '', finishedAt: null, mode: 'sync', scope: '', docIds, status: 'completed', batch: null, error: null,
  snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: { ...DEFAULT_RUN_OPTIONS, replicates }, prompt, promptVersion: 1, promptHash: 'h', outputSchema: null, requestBase: {} },
});
const mkResult = (run: string, doc: string, rep: number, values: Record<string, string>): Result => ({
  id: `${run}:${doc}:${rep}`, runId: run, studyId: 's', docId: doc, replicate: rep, status: 'ok', values, rationale: '', reasoningSummary: '', rawText: values.response ?? '',
  parseError: null, error: null, usage, latencyMs: 1, requestedAt: '', completedAt: '', responseId: `id-${doc}-${rep}`, modelReported: 'm', stopReason: 'end_turn',
});
const mkDoc = (id: string, order: number, meta: Record<string, string> = {}): Doc => ({ id, studyId: 's', docId: id, text: 't', meta, source: `${id}.txt`, order, addedAt: '' });
const study: Study = { id: 's', name: 'S', description: '', createdAt: '', updatedAt: '', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt: text };
const SCALE = ['-3', '-2', '-1', '0', '1', '2', '3'];
const answer = (o: Record<string, unknown>) => ({ response: JSON.stringify(o) });
const nums = (a: string[], b: string[]) => a.map((x, i) => [Number(x), Number(b[i])] as [number, number]);

// Gwet's AC1/AC2 written out from the method (as in round2-stats.test.ts): q = the scale's points, a value between two
// points split between them by distance.
function refScale(pairs: [number, number][], scale: number[], weighted: boolean): number {
  const s = [...scale].sort((a, b) => a - b);
  const q = s.length;
  const n = pairs.length;
  const w = (a: number, b: number) => (weighted ? 1 - Math.abs(a - b) / (s[q - 1] - s[0]) : a === b ? 1 : 0);
  const pi = new Array(q).fill(0);
  const add = (v: number) => {
    const k = s.indexOf(v);
    if (k >= 0) return void (pi[k] += 1);
    const i = s.findIndex((p, j) => p < v && v < s[j + 1]);
    if (i < 0) throw new Error(`${v} is off the scale`);
    pi[i] += (s[i + 1] - v) / (s[i + 1] - s[i]);
    pi[i + 1] += (v - s[i]) / (s[i + 1] - s[i]);
  };
  for (const [a, b] of pairs) (add(a), add(b));
  const shares = pi.map((x) => x / (2 * n));
  const pa = pairs.reduce((t, [a, b]) => t + w(a, b), 0) / n;
  let tw = 0;
  for (const a of s) for (const b of s) tw += w(a, b);
  const pe = (tw / (q * (q - 1))) * shares.reduce((t, p) => t + p * (1 - p), 0);
  return (pa - pe) / (1 - pe);
}

/** Gold scores on −3…3 and a model that never answers −3 (it says −2 instead), off by a point now and then. */
function compressed(n: number, seed: number): { gold: string[]; model: string[] } {
  const rnd = seeded(seed);
  const gold: string[] = [];
  const model: string[] = [];
  for (let i = 0; i < n; i++) {
    const g = Math.min(3, Math.max(-3, Math.round((rnd() - 0.5) * 7.5)));
    gold.push(String(g));
    const m = rnd() < 0.75 ? g : g + (rnd() < 0.5 ? -1 : 1);
    model.push(String(Math.min(3, Math.max(-2, m))));
  }
  return { gold, model };
}

describe('the scale grown from the range of the model’s answers', () => {
  it('takes in values next to the range (step: half its width, at least 1), and chains', () => {
    expect(grownScale([-2, 3], [-3, 9, 33, 99])).toEqual([-3, 3]);
    expect(grownScale([0, 2], [-1, -2, -3, 3])).toEqual([-3, 3]); // a pilot's 0…2: −1, −2, −3 chain
    expect(grownScale([0, 2], [-3, 3])).toEqual([0, 3]); // −3 alone is too far
    expect(grownScale([0, 0], [1, 99, -1])).toEqual([-1, 1]); // one value: step 1
    expect(grownScale([0.2, 3.7], [5, 9])).toEqual([0.2, 5]); // not whole: step 1.75
  });
});

describe('plain-text JSON scores: labels the model never used (F0, F7, F14, F24)', () => {
  const { gold, model } = compressed(206, 5);
  const docs = gold.map((g, i) => mkDoc(`d${i}`, i + 1, { race_gold: g, race_coder2: i % 9 === 0 ? String(Math.max(-3, Number(g) - 1)) : g }));
  const ids = docs.map((d) => d.id);

  it('keeps a gold −3 when the model answered −2…3, and reports it as outside the answers', () => {
    expect(gold.filter((g) => g === '-3').length).toBeGreaterThan(5);
    expect(model.includes('-3')).toBe(false);
    const run = mkRun(text, ids);
    const results = docs.map((d, i) => mkResult('r', d.id, 1, answer({ race: Number(model[i]), race_explanation: 'x' })));
    const [f] = comparableFields(run, buildDocViews(docs, [run], results, 'r').values());
    expect([f.allowed[0], f.range]).toEqual(['-2', [-2, 3]]);
    const rows = agreementForRun(run, docs, [run], results);
    const m = rows.find((r) => r.source === 'model' && r.compared_with === 'race_gold')!;
    expect([m.stats.n, m.nLabelled, m.stats.leftOut.n, m.stats.leftOut.range]).toEqual([206, 206, 0, [-3, 3]]);
    const threes = gold.filter((g) => g === '-3').length;
    expect(m.stats.outsideAnswers).toEqual({ n: threes, values: ['-3'], range: [-2, 3] });
    // The same answers in a structured run with the codebook −3…3 give the same figures.
    const sRun = mkRun(structured(variable('race', 'ordinal', SCALE)), ids, 's1');
    const sResults = docs.map((d, i) => mkResult('s1', d.id, 1, { race: model[i] }));
    const s = agreementForRun(sRun, docs, [sRun], sResults).find((r) => r.source === 'model' && r.compared_with === 'race_gold')!;
    for (const k of ['n', 'percentAgreement', 'cohenKappa', 'weightedKappa', 'weightedKappaLinear', 'krippendorffAlpha', 'gwetAC1', 'gwetAC2Linear', 'meanDifference'] as const)
      expect(m.stats[k]).toBeCloseTo(s.stats[k] as number, 12);
    // The human–human baseline is not trimmed by the model's range: the same as in the structured run's export.
    const hh = rows.find((r) => r.source === 'race_gold')!;
    const sHh = agreementForRun(sRun, docs, [sRun], sResults).find((r) => r.source === 'race_gold')!;
    expect([hh.stats.n, hh.stats.leftOut.n]).toEqual([206, 0]);
    for (const k of ['percentAgreement', 'weightedKappaLinear', 'krippendorffAlpha', 'gwetAC1', 'gwetAC2Linear'] as const) expect(hh.stats[k]).toBeCloseTo(sHh.stats[k] as number, 12);
  }, 60000);

  it('a pilot whose answers span 0…2 keeps −1, −2 and −3 in the labels (they chain), not 99', () => {
    const x = ['0', '1', '2', '1', '0', '2', '1', '0', '0', '1', '2', '0'];
    const y = ['0', '1', '3', '-1', '-2', '-3', '1', '0', '99', '1', '2', '-1'];
    const r = agreement(x, y, 'ordinal', ['0', '1', '2'], 1, { withIntervals: false, scaleSeen: true, range: [0, 2] });
    expect(r.leftOut).toEqual({ n: 1, values: ['99'], range: [-3, 3] });
    expect(r.outsideAnswers).toEqual({ n: 5, values: ['-3', '-2', '-1', '3'], range: [0, 2] });
    // The scale (weights, Gwet's q) is every whole number of the grown range, −3…3 (F62).
    const kept = x.map((v, i) => [v, y[i]] as const).filter(([, v]) => v !== '99');
    const [a, b] = [kept.map((p) => p[0]), kept.map((p) => p[1])];
    expect(r.gwetAC1).toBeCloseTo(refScale(nums(a, b), [-3, -2, -1, 0, 1, 2, 3], false), 12);
    expect(r.gwetAC2Linear).toBeCloseTo(refScale(nums(a, b), [-3, -2, -1, 0, 1, 2, 3], true), 12);
  });

  it('most labels outside the answers: AC1 and AC2 still on the whole numbers between, a half point split (F62)', () => {
    const x = ['0', '1', '2', '1', '0', '2', '1', '0', '1.5', '1', '2', '0'];
    const y = ['3', '-1', '-2', '-3', '3', '-3', '2', '3', '3', '-1', '2', '-2'];
    const r = agreement(x, y, 'ordinal', ['0', '1', '2'], 1, { withIntervals: false, scaleSeen: true, range: [0, 2] });
    expect([r.n, r.leftOut.n]).toEqual([12, 0]);
    expect(r.gwetAC1).toBeCloseTo(refScale(nums(x, y), [-3, -2, -1, 0, 1, 2, 3], false), 12);
    expect(r.gwetAC2Linear).toBeCloseTo(refScale(nums(x, y), [-3, -2, -1, 0, 1, 2, 3], true), 12);
  });
});

describe('plain-text JSON scores: a missing-value code far off the answers (F2, F4, F8)', () => {
  const N = 30;
  const model = Array.from({ length: N }, (_, i) => ((i * 3) % 7) - 3);
  const gold = model.map((m, i) => String(i % 5 === 0 ? Math.max(-3, m - 1) : m));
  const docsWith = (code: string) => gold.map((g, i) => mkDoc(`d${i}`, i + 1, { race_gold: i === 10 ? code : g }));
  const row = (docs: Doc[], score: (i: number, rep: number) => number, reps = 1) => {
    const run = mkRun(text, docs.map((d) => d.id), 'r', 1, reps);
    const results: Result[] = [];
    for (let i = 0; i < N; i++) for (let rep = 1; rep <= reps; rep++) results.push(mkResult('r', `d${i}`, rep, answer({ race: score(i, rep), race_explanation: 'x' })));
    return agreementForRun(run, docs, [run], results)[0];
  };

  it('is left out when one model answer is not a whole number (interval field)', () => {
    const r = row(docsWith('99'), (i) => (i === 7 ? model[7] + 0.5 : model[i]));
    expect(r.level).toBe('interval');
    expect([r.stats.n, r.stats.leftOut.n, r.stats.leftOut.values]).toEqual([29, 1, ['99']]);
    // The same figures as with that text's label left blank.
    const blank = row(docsWith(''), (i) => (i === 7 ? model[7] + 0.5 : model[i]));
    expect(blank.stats.n).toBe(29);
    for (const k of ['weightedKappaLinear', 'krippendorffAlpha', 'gwetAC2Linear', 'mae', 'meanDifference'] as const) expect(r.stats[k]).toBeCloseTo(blank.stats[k]!, 12);
    // (Also in one replicate only: a 2.5 among three answers makes the field interval.)
    const rep = row(docsWith('99'), (i, k) => (i === 7 && k === 2 ? model[7] + 0.5 : model[i]), 3);
    expect([rep.stats.n, rep.stats.leftOut.values]).toEqual([29, ['99']]);
  });

  it('is left out when the model gave one value only', () => {
    for (const code of ['99', '9']) {
      const docs = gold.map((_, i) => mkDoc(`d${i}`, i + 1, { race_gold: i === 2 ? code : i % 6 === 0 ? '1' : '0' }));
      const r = row(docs, () => 0);
      expect([r.stats.n, r.stats.leftOut.n, r.stats.leftOut.values, r.stats.leftOut.range]).toEqual([29, 1, [code], [0, 1]]);
      expect(r.stats.mae).toBeCloseTo(5 / 29, 12);
    }
  });

  it('two runs: the range is the union of both runs’ answers (whole or not), either way round', () => {
    const run = (id: string, scores: number[]) => {
      const r = mkRun(text, scores.map((_, i) => `d${i}`), id);
      return comparableFields(r, buildDocViews(scores.map((_, i) => mkDoc(`d${i}`, i)), [r], scores.map((s, i) => mkResult(id, `d${i}`, 1, answer({ race: s }))), id).values())[0];
    };
    const a = run('a', [0, 1, 2]);
    const b = run('b', [-1, 0.5, 3]);
    expect([a.range, b.range, b.allowed]).toEqual([[0, 2], [-1, 3], []]);
    expect(combineFields(a, b).range).toEqual([-1, 3]);
    expect(combineFields(b, a).range).toEqual([-1, 3]);
    // A codebook field and a plain-text one: the codebook's scale, no range.
    const coded = { key: 'race', label: 'race', level: 'ordinal' as const, allowed: SCALE, yesNo: false };
    expect(combineFields(coded, a).range).toBeUndefined();
  });

  it('says where the scale comes from, and which labels outside the answers were kept', () => {
    expect(leftOutReason('ordinal', [-3, 3], true)).toBe('a label isn’t a number or lies far outside the model’s answers (the scale, −3 to 3, takes in the labels next to them)');
    expect(leftOutReason('ordinal', [-3, 3])).toBe('a label isn’t a number or is outside the scale (−3 to 3)');
    expect(outsideAnswersNote({ n: 12, values: ['-3'], range: [-2, 3] }, { one: 'text', many: 'texts' })).toBe(
      'Labels outside the range of the model’s answers (−2 to 3) were kept: −3 (12 texts).',
    );
  });
});

describe('Level = Nominal on a numeric scale (F20, F55, F74) and rows with nothing to compare (F75)', () => {
  const x = ['1', '2', '1.5', '0', '-1', '3', '2', '1', '0', '2.5', '1', '0', '-2', '1'];
  const y = ['1', '2', '2', '0', '-1', '2', '2', '1', '1', '3', '1', '0', '-3', '99'];

  it('a half-point median is a disagreement, not left out; AC1 keeps q = the codebook’s size', () => {
    const nominal = agreement(x, y, 'nominal', SCALE, 1, { withIntervals: false });
    const ordinal = agreement(x, y, 'ordinal', SCALE, 1, { withIntervals: false });
    expect([nominal.n, nominal.leftOut.n, nominal.leftOut.values]).toEqual([13, 1, ['99']]);
    expect(nominal.percentAgreement).toBe(ordinal.percentAgreement);
    expect(nominal.cohenKappa).toBe(ordinal.cohenKappa);
    expect(nominal.gwetAC1).toBeCloseTo(ordinal.gwetAC1!, 12);
    expect(nominal.gwetAC1).toBeCloseTo(refScale(nums(x.slice(0, 13), y.slice(0, 13)), SCALE.map(Number), false), 12);
    // The left-out notice names the scale (the panel passes a numeric level when there is a range).
    expect(nominal.leftOut.range).toEqual([-3, 3]);
  });

  it('plain-text scores at the nominal level: the same rule', () => {
    const r = agreement(x, y, 'nominal', SCALE, 1, { withIntervals: false, scaleSeen: true, range: [-3, 3] });
    expect([r.n, r.leftOut.values]).toEqual([13, ['99']]);
    expect(r.gwetAC1).toBeCloseTo(refScale(nums(x.slice(0, 13), y.slice(0, 13)), SCALE.map(Number), false), 12);
  });

  it('categories that are numbers keep their ties as disagreements, split equally in AC1', () => {
    const a = ['1', '2', '3', '1 | 2', '2', '3', '1', '2'];
    const b = ['1', '2', '2', '1', '2', '3', '1 | 2', '1'];
    const r = agreement(a, b, 'nominal', ['1', '2', '3'], 1, { withIntervals: false });
    expect([r.n, r.leftOut.n]).toEqual([8, 0]);
    // As before round 3 (categories compared as strings, ties split equally among their categories).
    const pairs = a.map((v, i) => [v, b[i]] as [string, string]);
    const pi = new Map([['1', 0], ['2', 0], ['3', 0]]);
    for (const v of pairs.flat()) for (const p of v.split(' | ')) pi.set(p, pi.get(p)! + 1 / v.split(' | ').length / 16);
    const pa = pairs.filter(([p, q]) => p === q).length / 8;
    const pe = [...pi.values()].reduce((t, p) => t + p * (1 - p), 0) / 2;
    expect(r.gwetAC1).toBeCloseTo((pa - pe) / (1 - pe), 12);
  });

  it('every label a missing-value marker: the level asked for, nothing compared', () => {
    const r = agreement(['1', '2', '0'], ['NA', 'NA', 'n/a'], 'ordinal', SCALE, 1, { withIntervals: false });
    expect([r.level, r.n, r.leftOut.n]).toEqual(['ordinal', 0, 3]);
    // In the exports: the run's answered texts are all "NA" in race_gold; its one label is on a text without a result.
    const docs = ['NA', 'NA', 'n/a', '2'].map((v, i) => mkDoc(`d${i}`, i, { race_gold: v }));
    const run = mkRun(structured(variable('race', 'ordinal', SCALE)), docs.map((d) => d.id));
    const rows = agreementForRun(run, docs, [run], docs.slice(0, 3).map((d) => mkResult('r', d.id, 1, { race: '1' })));
    expect(rows.map((x) => [x.compared_with, x.level, x.stats.level, x.stats.n, x.nLabelled, x.stats.leftOut.n])).toEqual([['race_gold', 'ordinal', 'ordinal', 0, 1, 0]]);
    // A column with no label on the run's texts at all is not used for this run (the Export hint says why).
    const pilot = mkRun(run.snapshot.prompt, ['d0', 'd1'], 'p');
    expect(labelPairs(pilot, docs, [pilot], []).skipped).toEqual([{ field: 'race', column: 'race_gold', reason: 'no labels for race' }]);
  });
});

describe('"NA" cells are blank cells where labels are counted (F10)', () => {
  it('in the model and human–human rows: not labelled, not left out', () => {
    const coded = 20;
    const docs = Array.from({ length: 100 }, (_, i) =>
      mkDoc(`d${i}`, i, { race_gold: i < coded ? String((i % 7) - 3) : 'NA', race_coder2: i < coded ? String(((i + 1) % 7) - 3) : i % 2 ? 'N/A' : '' }),
    );
    const run = mkRun(structured(variable('race', 'ordinal', SCALE)), docs.map((d) => d.id));
    const rows = agreementForRun(run, docs, [run], docs.map((d) => mkResult('r', d.id, 1, { race: '0' })));
    expect(rows.map((r) => [r.source, r.compared_with, r.stats.n, r.nLabelled, r.stats.leftOut.n])).toEqual([
      ['model', 'race_gold', 20, 20, 0],
      ['model', 'race_coder2', 20, 20, 0],
      ['race_gold', 'race_coder2', 20, 20, 0],
    ]);
  });

  it('labelValue: a marker is blank unless it is one of the field’s values', () => {
    const race = { key: 'race', label: 'race', level: 'ordinal' as const, allowed: SCALE, yesNo: false };
    const tone = { key: 'tone', label: 'tone', level: 'nominal' as const, allowed: ['positive', 'none'], yesNo: false };
    expect(['NA', ' n/a ', '-', '2', 'none'].map((v) => labelValue(v, race))).toEqual(['', '', '', '2', '']);
    expect(['NA', 'None', 'Positive'].map((v) => labelValue(v, tone))).toEqual(['', 'none', 'positive']);
  });
});

describe('label columns (F17, F52, F53, F54)', () => {
  it('a longer field no prompt or run knows: its column is not taken for the shorter field (F17)', () => {
    const docs = [0, 1, 2, 3].map((i) => mkDoc(`d${i}`, i, { race_gold: String(i - 1), race_negative_gold: String(1 - i), gold_gender_role: '1', race_coder2: String(i - 2) }));
    const run = mkRun(text, docs.map((d) => d.id));
    const results = docs.map((d, i) => mkResult('r', d.id, 1, answer({ race: i - 1, race_explanation: 'x' })));
    const { pairs, skipped } = labelPairs(run, docs, [run], results, study);
    expect(pairs).toEqual([{ field: 'race', column: 'race_gold' }, { field: 'race', column: 'race_coder2' }]);
    expect(skipped).toEqual([{ field: 'race', column: 'race_negative_gold', reason: 'belongs to race_negative' }]);
    const rows = agreementForRun(run, docs, [run], results, study);
    expect(rows.map((r) => `${r.source} ${r.compared_with}`)).toEqual(['model race_gold', 'model race_coder2', 'race_gold race_coder2']);
  });

  it('the Export hint’s reason for a longer field’s unusable column is that field’s own (F52)', () => {
    const docs = ['f', 'm', 'x', 'f'].map((g, i) => mkDoc(`d${i}`, i, { gender_gold: g, gender_role_gold: 'NA' }));
    const run = mkRun(structured(variable('gender', 'category', ['f', 'm', 'x']), variable('gender_role', 'ordinal', SCALE)), docs.map((d) => d.id));
    const { pairs, skipped } = labelPairs(run, docs, [run], docs.map((d) => mkResult('r', d.id, 1, { gender: 'f', gender_role: '1' })));
    expect(pairs).toEqual([{ field: 'gender', column: 'gender_gold' }]);
    expect(skipped).toEqual([{ field: 'gender_role', column: 'gender_role_gold', reason: 'no labels for gender_role' }]);
  });

  it('score keys of other runs are read from every answer, not the first 200 (F53)', () => {
    const r2 = mkRun(text, [], 'r2', 2);
    const results = Array.from({ length: 600 }, (_, i) => mkResult('r2', `d${i}`, 1, answer(i === 550 ? { race: 1, race_negative: -2 } : { race: 0, race_explanation: 'x' })));
    expect(knownFieldNames(study, [r2], [], results)).toEqual(['race', 'race_negative']);
    // Fast on a full corpus (each answer is read once; later calls look it up).
    const big = Array.from({ length: 3 * 3080 }, (_, i) => mkResult('r2', `d${i}`, 1, answer({ race: i % 7, race_explanation: 'Because '.repeat(40), gender: 1, gender_explanation: 'So.' })));
    const t0 = performance.now();
    knownFieldNames(study, [r2], [], big);
    const first = performance.now() - t0;
    const t1 = performance.now();
    for (let k = 0; k < 10; k++) knownFieldNames(study, [r2], [], big);
    const again = (performance.now() - t1) / 10;
    expect(first).toBeLessThan(1500);
    expect(again).toBeLessThan(50);
  });

  it('the value test reads the run’s texts (F54)', () => {
    // Labels on the 40 texts of the run; a placeholder ("not coded") on the 200 others.
    const docs = Array.from({ length: 240 }, (_, i) => mkDoc(`d${i}`, i, { race_gold: i < 40 ? String((i % 7) - 3) : 'not coded' }));
    const run = mkRun(structured(variable('race', 'ordinal', SCALE)), docs.slice(0, 40).map((d) => d.id));
    const results = docs.slice(0, 40).map((d) => mkResult('r', d.id, 1, { race: '0' }));
    expect(labelPairs(run, docs, [run], results).pairs).toEqual([{ field: 'race', column: 'race_gold' }]);
    expect(agreementForRun(run, docs, [run], results)[0].stats.n).toBe(40);
    // A run over the other texts: mostly not values.
    const other = mkRun(structured(variable('race', 'ordinal', SCALE)), docs.slice(40).map((d) => d.id), 'o');
    expect(labelPairs(other, docs, [other], []).skipped).toEqual([{ field: 'race', column: 'race_gold', reason: 'mostly not values of race' }]);
  });
});

describe('Agreement panel: a run and a label column (F15)', () => {
  const f = (key: string) => ({ key, label: key, level: 'ordinal' as const, allowed: SCALE, yesNo: false });
  const fields = [f('tone'), f('stance'), f('race')];
  const p1 = 'run:r1\u0001meta:tone_gold';
  const p2 = 'run:r1\u0001meta:stance_gold';

  it('compares the field the chosen column belongs to, unless a field was picked for this pair', () => {
    expect(chosenField(null, p2, false, fields, undefined, 'stance')?.key).toBe('stance');
    // A field picked for another pair doesn't carry over.
    expect(chosenField({ pair: p1, key: 'tone' }, p2, false, fields, undefined, 'stance')?.key).toBe('stance');
    // Picked for this pair: the pick.
    expect(chosenField({ pair: p2, key: 'race' }, p2, false, fields, undefined, 'stance')?.key).toBe('race');
    // A column of no field: as before (the pick, else the first field).
    expect(chosenField({ pair: p1, key: 'race' }, p2, false, fields, undefined, undefined)?.key).toBe('race');
    expect(chosenField(null, p2, false, fields, undefined, undefined)?.key).toBe('tone');
  });

  it('gives the figures of the exported model row for that column', () => {
    const docs = Array.from({ length: 30 }, (_, i) => mkDoc(`d${i}`, i, { tone_gold: String((i % 7) - 3), stance_gold: String(((i * 2) % 7) - 3) }));
    const run = mkRun(structured(variable('tone', 'ordinal', SCALE), variable('stance', 'ordinal', SCALE)), docs.map((d) => d.id), 'r1');
    const results = docs.map((d, i) => mkResult('r1', d.id, 1, { tone: String((i % 7) - 3), stance: String(((i * 3) % 7) - 3) }));
    const { fields: fs, pairs } = labelPairs(run, docs, [run], results);
    const columnField = pairs.find((p) => p.column === 'stance_gold')?.field;
    const cf = chosenField(null, 'run:r1\u0001meta:stance_gold', false, fs, undefined, columnField)!;
    expect(cf.key).toBe('stance');
    const xs = docs.map((_, i) => String(((i * 3) % 7) - 3));
    const ys = docs.map((d) => labelValue(d.meta.stance_gold, cf));
    const panel = agreement(xs, ys, cf.level, cf.allowed, 1, { withIntervals: false, scaleSeen: cf.scaleSeen, range: cf.range });
    const row = agreementForRun(run, docs, [run], results).find((r) => r.compared_with === 'stance_gold')!;
    for (const k of ['n', 'cohenKappa', 'weightedKappaLinear', 'gwetAC1', 'gwetAC2Linear'] as const) expect(panel[k]).toBe(row.stats[k]);
  });
});

describe('At a glance: half-point gaps (F73)', () => {
  it('are counted, so the panel doesn’t call them “Off by 1”', () => {
    const r = agreement(['0', '1', '1.5', '2', '0.5'], ['0', '2', '2', '0', '2'], 'ordinal', SCALE, 1, { withIntervals: false });
    expect(r.gaps).toEqual({ same: 1, secondHigherSmall: 3, secondLowerSmall: 0, secondHigherLarge: 0, secondLowerLarge: 1, fractional: 2 });
    expect(agreement(['0', '1'], ['1', '1'], 'ordinal', SCALE, 1, { withIntervals: false }).gaps?.fractional).toBe(0);
  });
});

describe('review: a plain-text field made interval by one non-whole answer (F4, F62)', () => {
  it('AC1 and AC2 are on the whole numbers of the grown scale, the 2.5 split between 2 and 3, not a category of its own', () => {
    const { gold, model } = compressed(120, 9);
    const docs = gold.map((g, i) => mkDoc(`d${i}`, i + 1, { race_gold: g }));
    const run = mkRun(text, docs.map((d) => d.id));
    const half = model.findIndex((m) => Number(m) === 2);
    const scores = model.map((m, i) => Number(m) + (i === half ? 0.5 : 0));
    const results = docs.map((d, i) => mkResult('r', d.id, 1, answer({ race: scores[i], race_explanation: 'x' })));
    const [row] = agreementForRun(run, docs, [run], results);
    expect([row.level, row.stats.n, row.stats.leftOut.n, row.stats.leftOut.range]).toEqual(['interval', 120, 0, [-3, 3]]);
    const xs = scores.map(String);
    expect(row.stats.gwetAC1).toBeCloseTo(refScale(nums(xs, gold), SCALE.map(Number), false), 12);
    expect(row.stats.gwetAC2Linear).toBeCloseTo(refScale(nums(xs, gold), SCALE.map(Number), true), 12);
    // (Weighted κ doesn't depend on the scale's ends: the same as on the values seen.)
    const seen = agreement(xs, gold, 'interval', [], 1, { withIntervals: false });
    expect(row.stats.weightedKappaLinear).toBeCloseTo(seen.weightedKappaLinear!, 12);
  });
});

describe('Codebook scale where most labels are a missing-value code (lead, round three)', () => {
  it('leaves the 99s out instead of stretching the scale', () => {
    const scale = ['-3', '-2', '-1', '0', '1', '2', '3'];
    const model = ['1', '2', '0', '1', '-1', '2', '3', '1', '0', '2'];
    const gold = ['99', '99', '99', '99', '99', '99', '3', '1', '0', '2'];
    const st = agreement(model, gold, 'ordinal', scale, 1, { withIntervals: false });
    expect(st.n).toBe(4);
    expect(st.leftOut).toMatchObject({ n: 6, values: ['99'], range: [-3, 3] });
    // Mostly words: still compared as they are (only NA left out).
    const words = agreement(['low', 'high', 'mid', '2'], ['low', 'mid', 'mid', 'NA'], 'ordinal', scale, 1, { withIntervals: false });
    expect(words.n).toBe(3);
  });
});
