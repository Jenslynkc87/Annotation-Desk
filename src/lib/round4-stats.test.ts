// Tests for the fourth review round (October 23, 2026), statistics and label columns: the scale of plain-text scores
// (step 3, only within −10…10), a codebook against plain-text scores, the field of two label columns, label column
// names, the Agreement panel's field for a skipped column, "Disagree with" for plain-text scores, and the work done
// per update during a run.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { columnFieldOf, columnsFieldRun, resultsByRun, studyFieldNames } from '../components/RunsView';
import { comparableLabel } from '../components/Workbench';
import { combineFields, comparableFields, fieldValue, type ComparableField } from './compare';
import { agreementForRun, knownFieldNames, labelPairs, labelValue } from './export/tables';
import { agreement, grownScale, seeded } from './metrics';
import { retryableCount } from './store';
import { buildDocViews, replacedAttempts, runTokens } from './view';
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

// Gwet's AC1/AC2 written out from the method (as in round3-stats.test.ts).
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

/** A plain-text run (JSON answers with `race`) and the same answers as a structured −3…3 run, with their model and human–human rows. */
function bothRuns(docs: Doc[], scores: number[]) {
  const ids = docs.map((d) => d.id);
  const run = mkRun(text, ids, 't');
  const results = docs.map((d, i) => mkResult('t', d.id, 1, answer({ race: scores[i], race_explanation: 'x' })));
  const sRun = mkRun(structured(variable('race', 'ordinal', SCALE)), ids, 's1');
  const sResults = docs.map((d, i) => mkResult('s1', d.id, 1, { race: String(scores[i]) }));
  return { plain: agreementForRun(run, docs, [run], results), coded: agreementForRun(sRun, docs, [sRun], sResults) };
}
const row = (rows: ReturnType<typeof agreementForRun>, source: string, column: string) => rows.find((r) => r.source === source && r.compared_with === column)!;

describe('plain-text scores: the scale grown by 3 points, within −10…10 only (G1, G5, F56, F62)', () => {
  it('grows by 3 points, or half the range if more', () => {
    expect(grownScale([0, 0], [2, -2, 3])).toEqual([-2, 3]);
    expect(grownScale([0, 1], [-2, -3, 2])).toEqual([-3, 2]);
    expect(grownScale([-1, 1], [-3, 3])).toEqual([-3, 3]);
    expect(grownScale([-3, 3], [9, 99, -9])).toEqual([-3, 3]);
    expect(grownScale([0, 0], [33])).toEqual([0, 0]);
  });

  it('model always 0, gold ±2 and 3: nothing left out, the same n and figures as the codebook run', () => {
    const gold = Array.from({ length: 206 }, (_, i) => (i === 10 ? '2' : i === 50 ? '-2' : i === 90 ? '3' : i === 130 ? '-2' : i === 170 ? '2' : '0'));
    const coder2 = gold.map((g, i) => (i === 130 ? '-3' : i === 7 ? '1' : g));
    const docs = gold.map((g, i) => mkDoc(`d${i}`, i, { race_gold: g, race_coder2: coder2[i] }));
    const { plain, coded } = bothRuns(docs, gold.map(() => 0));
    for (const [source, column] of [['model', 'race_gold'], ['model', 'race_coder2'], ['race_gold', 'race_coder2']]) {
      const p = row(plain, source, column);
      const c = row(coded, source, column);
      expect([p.stats.n, p.stats.leftOut.n]).toEqual([206, 0]);
      for (const k of ['percentAgreement', 'cohenKappa', 'krippendorffAlpha', 'mae', 'meanDifference'] as const) expect(p.stats[k]).toBeCloseTo(c.stats[k] as number, 12);
    }
    // (Was: 201 of 206 compared, 100% agreement and a mean difference of 0.)
    expect(row(plain, 'model', 'race_gold').stats.percentAgreement).toBeLessThan(1);
  });

  it('model −1…1 with gold ±3 and no ±2: kept', () => {
    const rnd = seeded(4);
    const scores = Array.from({ length: 60 }, () => Math.floor(rnd() * 3) - 1);
    const gold = scores.map((s, i) => (i % 10 === 0 ? '3' : i % 10 === 5 ? '-3' : String(s)));
    const docs = gold.map((g, i) => mkDoc(`d${i}`, i, { race_gold: g }));
    const { plain, coded } = bothRuns(docs, scores);
    const p = row(plain, 'model', 'race_gold');
    expect([p.stats.n, p.stats.leftOut.n, p.stats.leftOut.range]).toEqual([60, 0, [-3, 3]]);
    // On −3…3 (both ±3 used), every figure is the codebook run's.
    const c = row(coded, 'model', 'race_gold');
    for (const k of ['percentAgreement', 'weightedKappa', 'weightedKappaLinear', 'krippendorffAlpha', 'gwetAC1', 'gwetAC2Linear', 'mae'] as const)
      expect(p.stats[k]).toBeCloseTo(c.stats[k] as number, 12);
  });

  it('a 99 and a 9 next to −3…3: left out', () => {
    const scores = Array.from({ length: 40 }, (_, i) => (i % 7) - 3);
    const gold = scores.map((s, i) => (i === 4 ? '99' : i === 9 ? '9' : String(s)));
    const docs = gold.map((g, i) => mkDoc(`d${i}`, i, { race_gold: g }));
    const p = row(bothRuns(docs, scores).plain, 'model', 'race_gold');
    expect([p.stats.n, p.stats.leftOut.n, p.stats.leftOut.values, p.stats.leftOut.range]).toEqual([38, 2, ['99', '9'], [-3, 3]]);
    // Also when the model only ever said 0: 9 and 99 are more than 3 points off the labels near the answers.
    const zero = row(bothRuns(docs, scores.map(() => 0)).plain, 'model', 'race_gold');
    expect([zero.stats.leftOut.n, zero.stats.leftOut.values]).toEqual([2, ['99', '9']]);
  });

  it('a percentage score in a narrow band above 10: gold labels farther off are kept (lead: rating scales only)', () => {
    // The model always answered 40…44 %, the coders 5 and 95 for two texts: real labels, not codes. (Answers within
    // −10…10 can't be told apart from a rating scale, where such a value is left out and reported.)
    const scores = Array.from({ length: 20 }, (_, i) => 40 + (i % 5));
    const gold = scores.map((s, i) => String(i === 4 ? 5 : i === 9 ? 95 : s));
    const st = agreement(scores.map(String), gold, 'interval', [], 1, { withIntervals: false, scaleSeen: true, range: [40, 44] });
    expect([st.n, st.leftOut.n]).toEqual([20, 0]);
    expect(st.percentAgreement).toBeCloseTo(18 / 20, 12);
    // On a rating scale within −10…10 the rule still applies: 0…10 answers, a 99 left out.
    const r = agreement(['3', '5', '8', '2'], ['3', '99', '8', '2'], 'ordinal', [], 1, { withIntervals: false, scaleSeen: true, range: [0, 10] });
    expect([r.n, r.leftOut.values]).toEqual([3, ['99']]);
  });

  it('years 1830…1946 with a gold 1702: kept (answers beyond −10…10 leave no number out)', () => {
    const years = Array.from({ length: 30 }, (_, i) => 1830 + Math.round((i * 116) / 29));
    const gold = years.map((y, i) => String(i === 3 ? 1702 : y));
    const docs = gold.map((g, i) => mkDoc(`d${i}`, i, { born_gold: g }));
    const run = mkRun(text, docs.map((d) => d.id));
    const results = docs.map((d, i) => mkResult('r', d.id, 1, answer({ born: years[i] })));
    const [r] = agreementForRun(run, docs, [run], results);
    expect([r.stats.n, r.stats.leftOut.n, r.stats.leftOut.range]).toEqual([30, 0, undefined]);
    expect(r.stats.mae).toBeCloseTo(Math.abs(years[3] - 1702) / 30, 12);
    // Still not a number (or a missing-value marker): left out.
    const na = agreement(['1850', '1900', '1930'], ['1850', 'unknown', 'x'], 'ordinal', [], 1, { withIntervals: false, scaleSeen: true, range: [1830, 1946] });
    expect([na.n, na.leftOut.values]).toEqual([1, ['unknown', 'x']]);
  });

  it('the human–human baseline no longer depends on a narrow model range (F56)', () => {
    // Coders use −2 and 3 but not −1 or 2; the model answers 0…1.
    const rnd = seeded(11);
    const scores = Array.from({ length: 40 }, () => (rnd() < 0.5 ? 0 : 1));
    const gold = scores.map((s, i) => (i % 9 === 0 ? '-2' : i % 11 === 0 ? '3' : String(s)));
    const coder2 = gold.map((g, i) => (i % 13 === 0 ? (g === '0' ? '1' : '0') : g));
    const docs = gold.map((g, i) => mkDoc(`d${i}`, i, { race_gold: g, race_coder2: coder2[i] }));
    const { plain, coded } = bothRuns(docs, scores);
    const p = row(plain, 'race_gold', 'race_coder2');
    const c = row(coded, 'race_gold', 'race_coder2');
    expect([p.stats.n, p.stats.leftOut.n]).toEqual([40, 0]);
    for (const k of ['percentAgreement', 'cohenKappa', 'krippendorffAlpha'] as const) expect(p.stats[k]).toBeCloseTo(c.stats[k] as number, 12);
  });
});

describe('a codebook run against a plain-text run with a 2.5 answer (G4)', () => {
  const coded: ComparableField = { key: 'race', label: 'race', level: 'ordinal', allowed: SCALE, yesNo: false };
  const plainField = (scores: number[]) => {
    const docs = scores.map((_, i) => mkDoc(`d${i}`, i));
    const r = mkRun(text, docs.map((d) => d.id), 'p');
    return comparableFields(r, buildDocViews(docs, [r], scores.map((s, i) => mkResult('p', `d${i}`, 1, answer({ race: s }))), 'p').values())[0];
  };

  it('keeps the codebook’s scale at the interval level, either way round', () => {
    const plain = plainField([0, 1, 2, 2.5, 1, 0]);
    expect([plain.level, plain.allowed]).toEqual(['interval', []]);
    for (const f of [combineFields(coded, plain), combineFields(plain, coded)]) {
      expect([f.level, f.allowed, f.scaleSeen, f.range]).toEqual(['interval', SCALE, false, undefined]);
    }
    // Widened to the whole numbers of the plain-text answers where they reach beyond it (no answer left out).
    const wide = plainField([0, 1, 4.5]);
    expect(combineFields({ ...coded, allowed: ['0', '1', '2', '3'] }, wide).allowed).toEqual(['0', '1', '2', '3', '4', '5']);
    // Whole-number answers: as before (the codebook's points, and those of the answers' range).
    expect(combineFields({ ...coded, allowed: ['0', '1', '2', '3'] }, plainField([-1, 0, 2])).allowed).toEqual(['-1', '0', '1', '2', '3']);
  });

  it('AC1 and AC2 on the codebook’s 7 points, the 2.5 split between 2 and 3; the midpoint and opposite direction from it', () => {
    const rnd = seeded(3);
    const xs = Array.from({ length: 40 }, () => String(Math.floor(rnd() * 3)));
    const ys = xs.map((x, i) => (i === 5 ? '2.5' : i % 6 === 0 ? String(Math.min(3, Number(x) + 1)) : x));
    const plain = plainField(ys.map(Number));
    for (const f of [combineFields(coded, plain), combineFields(plain, coded)]) {
      const r = agreement(xs, ys, f.level, f.allowed, 1, { withIntervals: false, scaleSeen: f.scaleSeen, range: f.range });
      expect(r.n).toBe(40);
      expect(r.gwetAC1).toBeCloseTo(refScale(nums(xs, ys), SCALE.map(Number), false), 12);
      expect(r.gwetAC2Linear).toBeCloseTo(refScale(nums(xs, ys), SCALE.map(Number), true), 12);
      expect(r.midpoint).toBe(0);
      expect(r.oppositeDirection).toBe(0);
    }
  });
});

describe('two label columns: the field from a run on other texts (G6)', () => {
  // 100 texts; the coders' sample is 60 of them ("NA" elsewhere); the only run with race (a pilot) has the other 40.
  const docs = Array.from({ length: 100 }, (_, i) =>
    mkDoc(`d${i}`, i, i < 60 ? { race_gold: String((i % 7) - 3), race_coder2: String(Math.min(3, (i % 7) - 3 + (i % 4 === 0 ? 1 : 0))) } : { race_gold: 'NA', race_coder2: 'NA' }),
  );
  const prompt = structured(variable('race', 'ordinal', SCALE));
  const pilot = mkRun(prompt, docs.slice(60).map((d) => d.id), 'pilot');
  const results = docs.slice(60).map((d, i) => mkResult('pilot', d.id, 1, { race: String((i % 7) - 3) }));

  it('finds race, so "NA" is a blank cell and the labels are on the scale', () => {
    const m = columnsFieldRun('race_gold', 'race_coder2', { ...study, prompt }, [pilot], docs, results);
    expect([m?.run.id, m?.field.key]).toEqual(['pilot', 'race']);
    const f = m!.field;
    const xs: string[] = [];
    const ys: string[] = [];
    for (const d of docs) {
      const [x, y] = [labelValue(d.meta.race_gold, f), labelValue(d.meta.race_coder2, f)];
      if (x && y) (xs.push(x), ys.push(y));
    }
    const r = agreement(xs, ys, f.level, f.allowed, 1, { withIntervals: false });
    expect(r.n).toBe(60);
    expect(r.weightedKappa).not.toBeNull();
    // The exports still judge a column on the run's own texts (F54).
    expect(labelPairs(pilot, docs, [pilot], results).pairs).toEqual([]);
  });
});

describe('label column names (G17)', () => {
  const names = ['race_gold', 'gold_standard_race', 'human_coded_race', 'race_expert_gold', 'race_final_gold', 'race_negative_gold', 'gold_race_negative', 'race_old_gold', 'race_gold_standard'];
  const docs = Array.from({ length: 20 }, (_, i) => mkDoc(`d${i}`, i, Object.fromEntries(names.map((n) => [n, String((i % 7) - 3)]))));
  const prompt = structured(variable('race', 'ordinal', SCALE));
  const run = mkRun(prompt, docs.map((d) => d.id));
  const results = docs.map((d, i) => mkResult('r', d.id, 1, { race: String((i % 7) - 3) }));

  it('a leading marker followed by other words, and expert/final labels, stay with race; a longer field at the end does not', () => {
    const { pairs, skipped } = labelPairs(run, docs, [run], results, { ...study, prompt });
    expect(pairs.map((p) => p.column)).toEqual(['race_gold', 'gold_standard_race', 'human_coded_race', 'race_expert_gold', 'race_final_gold', 'race_gold_standard']);
    // (gold_race_negative isn't named after race at all.)
    expect(skipped.map((x) => `${x.column}: ${x.reason}`)).toEqual(['race_negative_gold: belongs to race_negative', 'race_old_gold: belongs to race_old']);
  });

  it('a field that only ends in race stays with race, unless a prompt or run names it (gold_negative_race)', () => {
    const d2 = docs.map((d) => ({ ...d, meta: { race_gold: d.meta.race_gold, gold_negative_race: d.meta.race_gold } }));
    expect(labelPairs(run, d2, [run], results, null).pairs.map((p) => p.column)).toEqual(['race_gold', 'gold_negative_race']);
    const known = knownFieldNames(null, [run, mkRun(structured(variable('negative_race', 'ordinal', SCALE)), [], 'o', 2)]);
    expect(labelPairs(run, d2, [run], results, null, undefined, undefined, { known }).skipped).toEqual([
      { field: 'race', column: 'gold_negative_race', reason: 'belongs to negative_race' },
    ]);
  });
});

describe('Agreement panel: a run and a label column the exports leave out (G18)', () => {
  const prompt = structured(variable('tone', 'ordinal', SCALE), variable('race', 'ordinal', SCALE));
  // race_gold: labels on 20 of the run's 200 texts, "not coded" on the rest (skipped as mostly not values of race).
  const docs = Array.from({ length: 200 }, (_, i) =>
    mkDoc(`d${i}`, i, { race_gold: i < 20 ? String((i % 7) - 3) : 'not coded', race_note: 'x', author_race: '1', race_negative_gold: i < 20 ? '1' : 'not coded' }),
  );
  const run = mkRun(prompt, docs.map((d) => d.id));
  const results = docs.map((d, i) => mkResult('r', d.id, 1, { tone: '0', race: String((i % 7) - 3) }));
  const lp = labelPairs(run, docs, [run], results, { ...study, prompt });

  it('starts from the field the column is named after, not the first field', () => {
    expect(lp.skipped.find((x) => x.column === 'race_gold')?.reason).toBe('mostly not values of race');
    expect(columnFieldOf('race_gold', lp)).toBe('race');
    // A column of a longer field that isn't one of the run's: still race (the longest of the run's fields it is named after).
    expect(columnFieldOf('race_negative_gold', lp)).toBe('race');
    // Notes, ratings and columns about the author: no field (the panel's old rule: the pick, else the first field).
    expect(columnFieldOf('race_note', lp)).toBeUndefined();
    expect(columnFieldOf('author_race', lp)).toBeUndefined();
  });
});

describe('Workbench “Disagree with”: plain-text scores (G38)', () => {
  it('reads the score inside the JSON answer, on the panel’s scale, and leaves "NA" and far-off codes out', () => {
    const scores = [0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    const gold = ['0', '2', '1', '-3', 'NA', '1', '99', '0', '3', '0', 'n/a', '0'];
    const docs = gold.map((g, i) => mkDoc(`d${i}`, i, { race_gold: g }));
    const run = mkRun(text, docs.map((d) => d.id));
    const results = docs.map((d, i) => mkResult('r', d.id, 1, answer({ race: scores[i], race_explanation: 'x' })));
    const views = buildDocViews(docs, [run], results, 'r');
    const [f] = comparableFields(run, views.values());
    const pairs: [string, string][] = [];
    for (const d of docs) {
      const [x, y] = [fieldValue(run, views.get(d.id)!.values, 'race'), labelValue(d.meta.race_gold, f)];
      if (x && y) pairs.push([x, y]);
    }
    const ok = comparableLabel(f, pairs);
    const disagree = pairs.filter(([x, y]) => x !== y && ok(x) && ok(y)).map(([, y]) => y);
    expect(disagree).toEqual(['2', '-3', '3']);
    // The panel's figures for the same pairs: the same texts compared.
    const panel = agreement(pairs.map((p) => p[0]), pairs.map((p) => p[1]), f.level, f.allowed, 1, { withIntervals: false, scaleSeen: true, range: f.range });
    expect([panel.n, Math.round((1 - panel.percentAgreement!) * panel.n)]).toEqual([pairs.filter(([x, y]) => ok(x) && ok(y)).length, disagree.length]);
  });
});

describe('work per update during a run (G15, G16)', () => {
  // 3,080 texts, 9 plain-text runs of 3 replicates; the last one still being answered.
  const N = 3080;
  const docs = Array.from({ length: N }, (_, i) => mkDoc(`d${i}`, i, { race_a: ['low', 'high', 'mid'][i % 3], race_b: ['low', 'mid', 'high'][i % 3] }));
  const runs = Array.from({ length: 9 }, (_, k) => mkRun(text, docs.map((d) => d.id), `r${k}`, k + 1, 3));
  const all: Result[] = [];
  for (const r of runs)
    for (const d of docs) for (let rep = 1; rep <= 3; rep++) all.push(mkResult(r.id, d.id, rep, answer({ race: (d.order + rep) % 7 - 3, race_explanation: 'Because '.repeat(20) })));

  it('the runs table’s figures from each run’s own results are those from all results', () => {
    const byRun = resultsByRun(all);
    for (const r of runs.slice(0, 2)) {
      const own = byRun.get(r.id) ?? [];
      expect(runTokens(own, r.id, replacedAttempts(r, own))).toEqual(runTokens(all, r.id, replacedAttempts(r, all)));
      expect(retryableCount(r, own, docs)).toBe(retryableCount(r, all, docs));
    }
  });

  it('two label columns no run pairs: one update reads the finished runs’ answers no more', () => {
    expect(studyFieldNames(study, runs, all)).toEqual(knownFieldNames(study, runs, [], all));
    // Warm up (the first reading of every answer), then updates with a new results list each time (one more answer).
    columnsFieldRun('race_a', 'race_b', study, runs, docs, all);
    let results = all;
    const times: number[] = [];
    for (let k = 0; k < 5; k++) {
      results = [...results.filter((r) => r.id !== `r8:d${k}:1`), mkResult('r8', `d${k}`, 1, answer({ race: 1, race_explanation: 'new' }))];
      const t0 = performance.now();
      const m = columnsFieldRun('race_a', 'race_b', study, runs, docs, results, studyFieldNames(study, runs, results));
      times.push(performance.now() - t0);
      expect(m).toBeUndefined();
    }
    // (Was about 0.5 s per update on this corpus.)
    expect(Math.min(...times)).toBeLessThan(250);
  }, 120000);

  it('the scores read once per answer (numbers only, not the explanations) give the same fields, also after an answer changed', () => {
    const docs = Array.from({ length: 6 }, (_, i) => mkDoc(`d${i}`, i));
    const run = mkRun(text, docs.map((d) => d.id));
    const scores = [0, 1, 'NA', 2, '', 1];
    const results = docs.map((d, i) => mkResult('r', d.id, 1, answer({ race_explanation: 'Because '.repeat(50), race: scores[i], note: 'x' })));
    const fields = () => comparableFields(run, buildDocViews(docs, [run], results, 'r').values());
    // "NA" counts as an answer that isn't a number (4 numbers of 5 answers); the explanation and the note are no scores.
    expect(fields().map((f) => [f.key, f.level, f.range])).toEqual([['race', 'ordinal', [0, 2]]]);
    expect(fields()).toEqual(fields());
    results[0].values.response = JSON.stringify({ race: -2.5 });
    expect(fields().map((f) => [f.key, f.level, f.range])).toEqual([['race', 'interval', [-2.5, 2]]]);
  });
});
