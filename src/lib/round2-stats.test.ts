// Tests for the second review round (October 23, 2026): Gwet's AC1 and AC2 on the scale, labels outside the range of
// plain-text scores, label columns, and the long results tables.
import { describe, expect, it } from 'vitest';
import { comparableFields } from './compare';
import { agreementForRun, goldColumnsFor, knownFieldNames, labelPairs, resultsLong } from './export/tables';
import { agreement, seeded } from './metrics';
import { normalizeLabel } from './prompt';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type Run, type Study } from './types';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const text: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'text', variables: [] };
const mkRun = (prompt: PromptSpec, docIds: string[], id = 'r', number = 1, replicates = 1): Run => ({
  id, studyId: 's', number, label: '', createdAt: '', finishedAt: null, mode: 'sync', scope: '', docIds, status: 'completed', batch: null, error: null,
  snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: { ...DEFAULT_RUN_OPTIONS, replicates }, prompt, promptVersion: 1, promptHash: 'h', outputSchema: null, requestBase: {} },
});
const mkResult = (run: string, doc: string, rep: number, values: Record<string, string>, status: 'ok' | 'error' = 'ok'): Result => ({
  id: `${run}:${doc}:${rep}`, runId: run, studyId: 's', docId: doc, replicate: rep, status, values, rationale: '', reasoningSummary: '', rawText: values.response ?? '',
  parseError: null, error: status === 'error' ? 'HTTP 529' : null, usage, latencyMs: 1, requestedAt: '', completedAt: '', responseId: `id-${doc}-${rep}`, modelReported: 'm', stopReason: status === 'ok' ? 'end_turn' : '',
});
const mkDoc = (id: string, order: number, meta: Record<string, string> = {}): Doc => ({ id, studyId: 's', docId: id, text: 't', meta, source: `${id}.txt`, order, addedAt: '' });
const study: Study = { id: 's', name: 'S', description: '', createdAt: '', updatedAt: '', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt: text };

// Gwet's AC1 and AC2 for two raters written out from the method decided on (Oct 2026), independent of the app's code:
// q = the number of scale points; each label counts for its point, a label between two adjacent points is split
// between them by distance; pa is exact equality (AC1) or 1 − |a − b| / (max − min) (AC2, linear weights);
// pe = Tw / (q(q − 1)) · Σπ(1 − π), with Tw the sum of the weights over the scale's points (q for identity weights).
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

// AC1 on codebook categories: a tie "a | b" counts half for each of its categories and agrees only with the same tie.
function refNominal(pairs: [string, string][], cats: string[]): number {
  const n = pairs.length;
  const q = cats.length;
  const pi = new Map(cats.map((c) => [c, 0]));
  for (const v of pairs.flat()) {
    const parts = pi.has(v) ? [v] : v.split(' | ');
    for (const p of parts) pi.set(p, pi.get(p)! + 1 / parts.length / (2 * n));
  }
  const pa = pairs.filter(([a, b]) => a === b).length / n;
  const pe = [...pi.values()].reduce((t, p) => t + p * (1 - p), 0) / (q - 1);
  return (pa - pe) / (1 - pe);
}

/** Scores on −3…3, mostly near 0, with the model off by one point now and then (seeded, so always the same). */
function scores(n: number, seed: number): { gold: string[]; model: string[] } {
  const rnd = seeded(seed);
  const pick = (ws: number[]) => {
    let r = rnd() * ws.reduce((s, w) => s + w, 0);
    for (let i = 0; i < ws.length; i++) if ((r -= ws[i]) < 0) return i;
    return ws.length - 1;
  };
  const gold: string[] = [];
  const model: string[] = [];
  for (let i = 0; i < n; i++) {
    const g = pick([1, 2, 4, 10, 5, 3, 1]) - 3;
    gold.push(String(g));
    model.push(String(Math.max(-3, Math.min(3, g + pick([1, 6, 1]) - 1))));
  }
  return { gold, model };
}

const SCALE = ['-3', '-2', '-1', '0', '1', '2', '3'];
const nums = (a: string[], b: string[]) => a.map((x, i) => [Number(x), Number(b[i])] as [number, number]);

describe("Gwet's AC1 and AC2: the categories are the scale's points (R2, R12, R24, N37, N57, N91)", () => {
  it('give the same figures as before when every value is on the scale', () => {
    const { gold, model } = scores(60, 1);
    const r = agreement(model, gold, 'ordinal', SCALE, 1, { withIntervals: false });
    // The figures of the app before this change (validated against Gwet's formulas), and the reference.
    expect(r.gwetAC1).toBeCloseTo(0.6173672742732635, 12);
    expect(r.gwetAC2Linear).toBeCloseTo(0.874218231368576, 12);
    expect(r.gwetAC1).toBeCloseTo(refScale(nums(model, gold), SCALE.map(Number), false), 12);
    expect(r.gwetAC2Linear).toBeCloseTo(refScale(nums(model, gold), SCALE.map(Number), true), 12);
  });

  it('split a half-point median between its two scale points instead of adding a category', () => {
    const { gold, model } = scores(400, 2);
    const halves = model.map((x, i) => (i % 37 === 0 ? String(Number(x) + 0.5 * (Number(x) < 3 ? 1 : -1)) : x));
    expect(halves.filter((x) => x.includes('.')).length).toBeGreaterThan(5);
    const r = agreement(halves, gold, 'ordinal', SCALE, 1, { withIntervals: false });
    expect(r.gwetAC1).toBeCloseTo(refScale(nums(halves, gold), SCALE.map(Number), false), 12);
    expect(r.gwetAC2Linear).toBeCloseTo(refScale(nums(halves, gold), SCALE.map(Number), true), 12);
    // The bootstrap intervals use the same categories.
    const ci = agreement(halves, gold, 'ordinal', SCALE).ci;
    expect(ci.gwetAC1![0]).toBeLessThan(r.gwetAC1!);
    expect(ci.gwetAC1![1]).toBeGreaterThan(r.gwetAC1!);
  });

  it('score a half-point miss between an exact match and a one-point miss', () => {
    for (const [n, seed] of [[60, 1], [400, 2], [3080, 3]] as const) {
      const { gold, model } = scores(n, seed);
      const i = gold.findIndex((g, k) => g === '2' && model[k] === '2');
      const at = (x: string) => agreement(model.map((v, k) => (k === i ? x : v)), gold, 'ordinal', SCALE, 1, { withIntervals: false });
      for (const [half, miss] of [['1.5', '1'], ['2.5', '3']]) {
        const [e, h, m] = [at('2'), at(half), at(miss)];
        // AC2 gives partial credit by distance: strictly between.
        expect(h.gwetAC2Linear!).toBeLessThan(e.gwetAC2Linear!);
        expect(h.gwetAC2Linear!).toBeGreaterThan(m.gwetAC2Linear!);
        // AC1 compares exactly, so a half-point miss is a miss: below the exact match, and the same as a whole miss
        // apart from the chance term (which only moves the share of the two neighbouring points).
        expect(h.gwetAC1!).toBeLessThan(e.gwetAC1!);
        expect(Math.abs(h.gwetAC1! - m.gwetAC1!)).toBeLessThan(1 / (n * 6));
      }
    }
  });

  it('keep the unused scale values in q', () => {
    // Only 0…2 used, on a −3…3 codebook scale: q stays 7.
    const a = ['0', '1', '2', '1', '0', '2', '1', '1', '0', '2', '1.5'];
    const b = ['0', '1', '1', '1', '0', '2', '2', '1', '0', '2', '2'];
    const r = agreement(a, b, 'ordinal', SCALE, 1, { withIntervals: false });
    expect(r.gwetAC1).toBeCloseTo(refScale(nums(a, b), SCALE.map(Number), false), 12);
    expect(r.gwetAC2Linear).toBeCloseTo(refScale(nums(a, b), SCALE.map(Number), true), 12);
  });

  it('plain-text scores: a half point keeps the whole numbers of the answers’ range as the scale (N35)', () => {
    const allowed = ['0', '1', '2', '3'];
    const a = ['0', '1', '2', '3', '1', '0', '2', '1', '3', '2', '1.5', '0'];
    const b = ['0', '1', '2', '2', '1', '0', '3', '1', '3', '2', '2', '1'];
    const r = agreement(a, b, 'ordinal', allowed, 1, { withIntervals: false, scaleSeen: true });
    expect(r.gwetAC1).toBeCloseTo(refScale(nums(a, b), [0, 1, 2, 3], false), 12);
    expect(r.gwetAC2Linear).toBeCloseTo(refScale(nums(a, b), [0, 1, 2, 3], true), 12);
  });
});

describe('categories with a codebook: ties and labels that are not categories (N91)', () => {
  const cats = ['negative', 'neutral', 'positive'];
  const a = ['negative', 'neutral', 'positive', 'neutral', 'neutral', 'negative', 'positive', 'neutral', 'neutral', 'positive', 'negative | neutral', 'neutral | positive'];
  const b = ['negative', 'neutral', 'positive', 'positive', 'neutral', 'neutral', 'positive', 'neutral', 'negative', 'positive', 'neutral', 'neutral | positive'];
  const zip = (x: string[], y: string[]) => x.map((v, i) => [v, y[i]] as [string, string]);

  it('a tie splits its share among its categories, adds none, and agrees only with the same tie', () => {
    const r = agreement(a, b, 'nominal', cats, 1, { withIntervals: false });
    expect(r.gwetAC1).toBeCloseTo(refNominal(zip(a, b), cats), 12);
    expect(r.percentAgreement).toBeCloseTo(8 / 12, 12); // the two identical ties agree
    expect(r.leftOut.n).toBe(0);
  });

  it('yes/no fields have their two categories, so a tie "false | true" is no third one', () => {
    const p = { ...DEFAULT_PROMPT, variables: [{ name: 'relevant', type: 'boolean' as const, values: [], description: '' }] };
    const [f] = comparableFields(mkRun(p, []), []);
    expect(f.allowed).toEqual(['false', 'true']);
    const x = ['true', 'true', 'false', 'true', 'false', 'false | true', 'true', 'true'];
    const y = ['true', 'false', 'false', 'true', 'false', 'true', 'true', 'true'];
    expect(agreement(x, y, 'nominal', f.allowed, 1, { withIntervals: false }).gwetAC1).toBeCloseTo(refNominal(zip(x, y), f.allowed), 12);
  });

  it('a label that is not a category is left out and reported, if most labels are categories', () => {
    const typo = agreement([...a, 'neutrl'], [...b, 'neutral'], 'nominal', cats, 1, { withIntervals: false });
    const clean = agreement(a, b, 'nominal', cats, 1, { withIntervals: false });
    expect(typo.leftOut).toEqual({ n: 1, values: ['neutrl'] });
    expect(typo.gwetAC1).toBeCloseTo(clean.gwetAC1!, 12);
    expect(typo.cohenKappa).toBeCloseTo(clean.cohenKappa!, 12);
  });

  it('without a codebook nothing changes: the categories are the labels seen', () => {
    const r = agreement(a, b, 'nominal', [], 1, { withIntervals: false });
    const seen = [...new Set([...a, ...b])];
    const pairs = zip(a, b);
    const n = pairs.length;
    const pe = seen.map((c) => pairs.flat().filter((v) => v === c).length / (2 * n)).reduce((t, p) => t + p * (1 - p), 0) / (seen.length - 1);
    const pa = pairs.filter(([x, y]) => x === y).length / n;
    expect(r.gwetAC1).toBeCloseTo((pa - pe) / (1 - pe), 12);
    expect(r.leftOut.n).toBe(0);
  });
});

describe('plain-text JSON scores: labels outside the range of the answers (R23, N33, N90)', () => {
  const allowed = SCALE;
  const { gold, model } = scores(80, 4);
  it('are left out and reported, with the scale’s range, so a 99 stretches nothing', () => {
    const clean = agreement(model, gold, 'ordinal', allowed, 1, { withIntervals: false, scaleSeen: true });
    const coded = agreement([...model, '1', '2'], [...gold, '99', '-9'], 'ordinal', allowed, 1, { withIntervals: false, scaleSeen: true });
    expect(coded.leftOut).toEqual({ n: 2, values: ['99', '-9'], range: [-3, 3] });
    for (const k of ['weightedKappa', 'weightedKappaLinear', 'gwetAC1', 'gwetAC2Linear', 'mae', 'meanDifference', 'krippendorffAlpha'] as const) expect(coded[k]).toBeCloseTo(clean[k]!, 12);
  });

  it('in the exports too', () => {
    const docs = gold.map((g, i) => mkDoc(`d${i}`, i + 1, { race_gold: i === 3 ? '99' : g }));
    const run = mkRun(text, docs.map((d) => d.id));
    const results = docs.map((d, i) => mkResult('r', d.id, 1, { response: JSON.stringify({ race: Number(model[i]), race_explanation: 'x' }) }));
    const [row] = agreementForRun(run, docs, [run], results);
    expect([row.field, row.compared_with, row.stats.n, row.nLabelled, row.stats.leftOut.n, row.stats.leftOut.values]).toEqual(['race', 'race_gold', 79, 80, 1, ['99']]);
  });

  it('a missing-value marker such as "NA" is left out even where most labels are markers', () => {
    const y = gold.map((g, i) => (i % 4 === 0 ? g : i % 2 ? 'NA' : 'n/a'));
    const r = agreement(model, y, 'ordinal', allowed, 1, { withIntervals: false, scaleSeen: true });
    expect([r.level, r.n, r.leftOut.n, r.leftOut.values]).toEqual(['ordinal', 20, 60, ['NA', 'n/a']]);
    expect(r.weightedKappaLinear).not.toBeNull();
  });
});

describe('comparableFields reads every answer in linear time (N32, N36)', () => {
  it('3,080 texts × 3 annotations × 10 keys', () => {
    const run = mkRun(text, [], 'r', 1, 3);
    const keys = ['race', 'gender', 'class', 'religion', 'age'];
    const views = Array.from({ length: 3080 }, (_, i) => {
      const results = [1, 2, 3].map((rep) =>
        mkResult('r', `d${i}`, rep, { response: JSON.stringify(Object.fromEntries(keys.flatMap((k, j) => [[k, ((i + rep + j) % 7) - 3], [`${k}_explanation`, `Because ${i}.`]]))) }),
      );
      return { run, results, values: {}, consistency: {}, rationale: '', status: 'ok' as const };
    });
    const t = performance.now();
    const fields = comparableFields(run, views);
    const ms = performance.now() - t;
    expect(fields.map((f) => [f.key, f.allowed.length])).toEqual(keys.map((k) => [k, 7]));
    // About 50–80 ms; copying the list for every value took over a second.
    expect(ms).toBeLessThan(500);
  });
});

describe('label columns (N46, N89, R7, N88, N93)', () => {
  const race = { key: 'race', label: 'race', level: 'ordinal' as const, allowed: SCALE, yesNo: false };
  it('a column with "NA" in the cells of uncoded texts is still a label column', () => {
    const docs = Array.from({ length: 40 }, (_, i) => mkDoc(`d${i}`, i + 1, { race_gold: i < 10 ? String((i % 7) - 3) : ['NA', 'N/A', 'n.a.', '-', '—', '?', 'unknown', 'missing', 'nan', 'none', '.'][i % 11] }));
    expect(goldColumnsFor(race, docs)).toEqual(['race_gold']);
  });

  it('Y/N in a yes/no field’s column are yes and no', () => {
    expect(['Y', 'y', 'N', 'n'].map((v) => normalizeLabel(v, true))).toEqual(['true', 'true', 'false', 'false']);
    expect(normalizeLabel('y')).toBe('y');
    const relevant = { key: 'relevant', label: 'relevant', level: 'nominal' as const, allowed: ['false', 'true'], yesNo: true };
    const docs = ['Y', 'N', 'N', 'Y', 'NA'].map((v, i) => mkDoc(`d${i}`, i + 1, { relevant_gold: v }));
    expect(goldColumnsFor(relevant, docs)).toEqual(['relevant_gold']);
  });

  it('a category named like a missing-value marker (e.g. "none") still counts as a value', () => {
    const tone = { key: 'tone', label: 'tone', level: 'nominal' as const, allowed: ['positive', 'negative', 'none'], yesNo: false };
    const docs = ['none', 'none', 'none', 'positive', 'nope', 'nah'].map((v, i) => mkDoc(`d${i}`, i + 1, { tone_gold: v }));
    expect(goldColumnsFor(tone, docs)).toEqual(['tone_gold']);
  });

  it('columns named after a field but not used are listed, with the reason', () => {
    const p = { ...DEFAULT_PROMPT, variables: [{ name: 'race', type: 'ordinal' as const, values: SCALE, description: '' }] };
    const docs = [
      mkDoc('d1', 1, { race_gold: '2', race_note: 'unclear', author_race: '1', race_explanation_coder2: 'x', race_negative_gold: '1', race_old: 'NA', race_words: 'Black' }),
      mkDoc('d2', 2, { race_gold: '-1', race_note: 'fine', author_race: '0', race_explanation_coder2: 'y', race_negative_gold: '0', race_old: '', race_words: 'white' }),
    ];
    const run = mkRun(p, ['d1', 'd2']);
    const other = mkRun({ ...p, variables: [...p.variables, { name: 'race_negative', type: 'ordinal' as const, values: SCALE, description: '' }] }, [], 'r2', 2);
    const { pairs, skipped } = labelPairs(run, docs, [run, other], [mkResult('r', 'd1', 1, { race: '2' })]);
    expect(pairs).toEqual([{ field: 'race', column: 'race_gold' }]);
    expect(skipped).toEqual([
      { field: 'race', column: 'race_note', reason: 'a note or rating' },
      { field: 'race', column: 'author_race', reason: 'about the author' }, // numbers on the scale, but metadata (R7)
      { field: 'race', column: 'race_explanation_coder2', reason: 'a note or rating' },
      { field: 'race', column: 'race_negative_gold', reason: 'belongs to race_negative' },
      { field: 'race', column: 'race_old', reason: 'no labels for race' },
      { field: 'race', column: 'race_words', reason: 'mostly not values of race' },
    ]);
  });

  it('a longer field known only from another plain-text run’s JSON answers keeps its label column (N88)', () => {
    const docs = [mkDoc('d1', 1, { race_gold: '2', race_negative_gold: '-1' }), mkDoc('d2', 2, { race_gold: '0', race_negative_gold: '1' })];
    const r1 = mkRun(text, ['d1', 'd2'], 'r1', 1);
    const r2 = mkRun(text, ['d1', 'd2'], 'r2', 2);
    const results = [
      ...docs.map((d, i) => mkResult('r1', d.id, 1, { response: JSON.stringify({ race: i * 2, race_explanation: 'x' }) })),
      ...docs.map((d, i) => mkResult('r2', d.id, 1, { response: JSON.stringify({ race: i, race_negative: -i, race_explanation: 'x' }) })),
    ];
    expect(knownFieldNames(study, [r1, r2], [], results)).toEqual(['race', 'race_negative']);
    expect(knownFieldNames(study, [r1, r2])).toEqual([]); // the older call still works
    expect(labelPairs(r1, docs, [r1, r2], results, study).pairs).toEqual([{ field: 'race', column: 'race_gold' }]);
    const rows = agreementForRun(r1, docs, [r1, r2], results, study);
    expect(rows.map((r) => [r.source, r.compared_with])).toEqual([['model', 'race_gold']]);
  });

  it('the panel’s first choice for gender is not gender_role_gold (N93)', () => {
    const run = mkRun(text, ['d1']);
    const results = [mkResult('r', 'd1', 1, { response: '{"gender": 1, "gender_role": 2}' })];
    const docs = [mkDoc('d1', 1, { gender_role_gold: '2', gender_gold: '1' })];
    const [gender] = comparableFields(run, [{ run, results, values: {}, consistency: {}, rationale: '', status: 'ok' }]);
    expect(goldColumnsFor(gender, docs, knownFieldNames(study, [run], [], results))).toEqual(['gender_gold']);
  });
});

describe('long results tables (N48, N113, N114)', () => {
  const docs = [mkDoc('d1', 1), mkDoc('d2', 2)];
  const answer = (race: number) => ({ response: JSON.stringify({ race_explanation: 'Because.', race, gender: 1, gender_explanation: 'So.' }) });
  const run = mkRun(text, ['d1', 'd2', 'x1', 'x2'], 'r', 1, 2);
  const results = [
    mkResult('r', 'x2', 1, answer(0)), mkResult('r', 'x2', 2, answer(1)),
    mkResult('r', 'd2', 2, answer(2)), mkResult('r', 'd1', 2, { response: 'I would rather not score this one.' }),
    mkResult('r', 'x1', 2, answer(0)), mkResult('r', 'd1', 1, {}, 'error'), mkResult('r', 'x1', 1, answer(1)), mkResult('r', 'd2', 1, answer(3)),
  ];
  const rows = resultsLong(study, [run], docs, results, { rationale: false, reasoning: false });
  it('put the JSON columns in one place in every row, each explanation after its score', () => {
    const cols = Object.keys(rows[0]);
    expect(cols.slice(cols.indexOf('status'), cols.indexOf('parse_error'))).toEqual(['status', 'response', 'race', 'race_explanation', 'gender', 'gender_explanation']);
    for (const r of rows) expect(Object.keys(r)).toEqual(cols);
  });
  it('put texts removed from the study after the others, each with its annotations together', () => {
    expect(rows.map((r) => `${r.doc_id} ${r.replicate}`)).toEqual(['d1 1', 'd1 2', 'd2 1', 'd2 2', '(deleted x1) 1', '(deleted x1) 2', '(deleted x2) 1', '(deleted x2) 2']);
  });
});

describe('second look (reviewer, October 23, 2026)', () => {
  it('AC1 and AC2 equal the reference on random data: whole numbers, points between, ties', () => {
    const rnd = seeded(11);
    const scales = [[-3, -2, -1, 0, 1, 2, 3], [1, 2, 3, 4, 5], [0, 1], [0, 1, 2, 3]];
    for (let t = 0; t < 120; t++) {
      const scale = scales[t % 4];
      // Every third data set has whole numbers only: the figures the app gave before (the scale holds every value).
      const between = t % 3 !== 0;
      const value = () => {
        const i = Math.floor(rnd() * scale.length);
        if (!between || i === scale.length - 1 || rnd() > 0.15) return String(scale[i]);
        return String(Math.round((scale[i] + (rnd() < 0.5 ? 0.5 : 1 / 3)) * 1000) / 1000); // a median or a mean
      };
      const a = Array.from({ length: 10 + Math.floor(rnd() * 90) }, value);
      const b = a.map((x) => (rnd() < 0.6 ? x : value()));
      const r = agreement(a, b, 'ordinal', scale.map(String), 1, { withIntervals: false, scaleSeen: t % 2 === 1 });
      expect(r.n).toBe(a.length);
      expect(r.gwetAC1).toBeCloseTo(refScale(nums(a, b), scale, false), 12);
      expect(r.gwetAC2Linear).toBeCloseTo(refScale(nums(a, b), scale, true), 12);
    }
    for (const cats of [['negative', 'neutral', 'positive'], ['false', 'true']]) {
      const ties = cats.length === 2 ? ['false | true'] : ['negative | neutral', 'neutral | positive', 'negative | positive', 'negative | neutral | positive'];
      for (let t = 0; t < 20; t++) {
        const value = () => (rnd() < 0.1 ? ties[Math.floor(rnd() * ties.length)] : cats[Math.floor(rnd() * cats.length)]);
        const a = Array.from({ length: 10 + Math.floor(rnd() * 60) }, value);
        const b = a.map((x) => (rnd() < 0.6 ? x : value()));
        const r = agreement(a, b, 'nominal', cats, 1, { withIntervals: false });
        expect(r.leftOut.n).toBe(0);
        expect(r.gwetAC1).toBeCloseTo(refNominal(a.map((x, i) => [x, b[i]]), cats), 12);
      }
    }
  });

  it('yes/no and category columns with "NA" for most texts are compared on the labelled ones, NA left out (N46)', () => {
    const tones = ['positive', 'neutral', 'negative'];
    const p: PromptSpec = {
      ...DEFAULT_PROMPT,
      variables: [
        { name: 'relevant', type: 'boolean', values: [], description: '' },
        { name: 'tone', type: 'category', values: ['Positive', 'Neutral', 'Negative'], description: '' },
      ],
    };
    const coded = (i: number) => i < 12;
    const docs = Array.from({ length: 40 }, (_, i) =>
      mkDoc(`d${i}`, i + 1, {
        relevant_gold: coded(i) ? (i % 3 ? 'Y' : 'N') : 'NA',
        tone_gold: coded(i) ? tones[i % 3] : 'NA',
        tone_coder2: coded(i) ? tones[(i + Number(i % 4 === 0)) % 3] : 'n/a',
      }),
    );
    const run = mkRun(p, docs.map((d) => d.id));
    const results = docs.map((d, i) => mkResult('r', d.id, 1, { relevant: i % 3 || i === 4 ? 'true' : 'false', tone: tones[(i + Number(i % 5 === 0)) % 3] }));
    const rows = agreementForRun(run, docs, [run], results);
    expect(rows.map((r) => [r.source, r.compared_with, r.stats.level, r.stats.n, r.stats.leftOut.n])).toEqual([
      ['model', 'relevant_gold', 'nominal', 12, 28],
      ['model', 'tone_gold', 'nominal', 12, 28],
      ['model', 'tone_coder2', 'nominal', 12, 28],
      ['tone_gold', 'tone_coder2', 'nominal', 12, 28],
    ]);
    // The same figures as for the twelve labelled texts alone.
    const twelve = docs.slice(0, 12);
    const clean = agreementForRun(run, twelve, [run], results.slice(0, 12));
    for (const [i, r] of rows.entries()) {
      expect(r.stats.gwetAC1).toBeCloseTo(clean[i].stats.gwetAC1!, 12);
      expect(r.stats.cohenKappa).toBeCloseTo(clean[i].stats.cohenKappa!, 12);
    }
  });
});
