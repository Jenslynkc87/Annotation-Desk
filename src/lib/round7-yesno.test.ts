// Tests for the seventh review round (October 24, 2026), yes/no pairings: a yes/no field in any of its forms (a Yes/no
// field, categories yes and no, a codebook of 0 and 1, plain-text scores mostly 0 and 1) is compared as yes/no against
// one in words, in both orders (M3); a stray answer or a code such as 9 doesn't switch that off but is left out and
// reported (M4, M10); a coder's yes/no, y/n, 1/0 or true/false reads the same against any of them; and the comparison
// report's Review sheet calls a pair the Summary left out "left out", not a disagreement (gap note). Expected figures:
// recomputed independently with sklearn and krippendorff (scratchpad r7-yesno/py/expected.py), in both orders.
import 'fake-indexeddb/auto';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { compareRows } from '../components/Workbench';
import { combineFields, comparableFields, dichotomy, fieldValue } from './compare';
import { buildComparisonReport } from './export/packages';
import { agreementForRun, labelPairs, labelValue } from './export/tables';
import { agreement } from './metrics';
import { normalizeLabel } from './prompt';
import { buildDocViews } from './view';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type Run, type Variable } from './types';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const text: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'text', variables: [] };
const variable = (name: string, type: Variable['type'], values: string[] = []): Variable => ({ name, type, values, description: '' });
const structured = (...variables: Variable[]): PromptSpec => ({ ...DEFAULT_PROMPT, outputMode: 'structured', includeRationale: false, variables });
const mkRun = (prompt: PromptSpec, docIds: string[], id: string, number: number, replicates = 1): Run => ({
  id, studyId: 's', number, label: '', createdAt: `2026-10-0${number}T00:00:00.000Z`, finishedAt: '2026-10-24', mode: 'sync', scope: '', docIds, status: 'completed', batch: null, error: null,
  snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: { ...DEFAULT_RUN_OPTIONS, replicates }, prompt, promptVersion: number, promptHash: `h${id}`, outputSchema: null, requestBase: {} },
});
const mkResult = (run: string, doc: string, values: Record<string, string>, rep = 1): Result => ({
  id: `${run}:${doc}:${rep}`, runId: run, studyId: 's', docId: doc, replicate: rep, status: 'ok', values, rationale: '', reasoningSummary: '', rawText: values.response ?? '',
  parseError: null, error: null, usage, latencyMs: 1, requestedAt: '', completedAt: '', responseId: `id-${run}-${doc}-${rep}`, modelReported: 'm', stopReason: 'end_turn',
});
const mkDoc = (id: string, order: number, meta: Record<string, string> = {}): Doc => ({ id, studyId: 's', docId: id, text: 't', meta: { file: `${id}.md`, ...meta }, source: `${id}.md`, order, addedAt: '' });
const answer = (o: Record<string, unknown>) => ({ response: JSON.stringify(o) });
async function sheets(blob: Blob) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await blob.arrayBuffer()) as unknown as ArrayBuffer);
  return (name: string) => {
    const ws = wb.getWorksheet(name)!;
    const head = (ws.getRow(1).values as unknown[]).slice(1) as string[];
    return Array.from({ length: ws.rowCount - 1 }, (_, i) => Object.fromEntries(head.map((h, j) => [h, ws.getRow(i + 2).getCell(j + 1).value])));
  };
}

// The fixtures' values (as in expected.py): a for the runs in words, b for the runs in numbers (a with every 5th text
// flipped), c for the coders' labels (b with every 7th text flipped), written as 1/0, y/n, yes/no or TRUE/FALSE.
const a = (i: number) => i % 3 !== 0;
const b = (i: number) => (i % 5 === 0 ? !a(i) : a(i));
const c = (i: number) => (i % 7 === 0 ? !b(i) : b(i));
const FORMS = [['1', '0'], ['y', 'n'], ['yes', 'no'], ['TRUE', 'FALSE']];
const word = (i: number, v: boolean) => FORMS[i % 4][v ? 0 : 1];

// Run A against run B as the Agreement panel reads them (RunsView: `combineFields`, then each value with its yes/no rule).
function panel(first: Run, second: Run, docs: Doc[], runs: Run[], results: Result[], key = 'flag') {
  const views = (run: Run) => buildDocViews(docs, runs, results, run.id);
  const field = (run: Run) => comparableFields(run, views(run).values()).find((f) => f.key === key)!;
  const f = combineFields(field(first), field(second));
  const values = (run: Run) => {
    const v = views(run);
    return docs.map((d) => (v.get(d.id)?.status === 'none' ? '' : normalizeLabel(fieldValue(run, v.get(d.id)!.values, key), f.yesNo)));
  };
  return { f, r: agreement(values(first), values(second), f.level, f.allowed, 1, { withIntervals: false, scaleSeen: f.scaleSeen, range: f.range }) };
}

describe('a yes/no field in any form against one in words, in both orders (M3)', () => {
  const docs = Array.from({ length: 60 }, (_, i) => mkDoc(`d${i}`, i, { flag_gold: i === 59 ? 'NA' : word(i, c(i)) }));
  const ids = docs.map((d) => d.id);
  const yn = mkRun(structured(variable('flag', 'boolean')), ids, 'yn', 1);
  const catyn = mkRun(structured(variable('flag', 'category', ['yes', 'no'])), ids, 'catyn', 2);
  const cat01 = mkRun(structured(variable('flag', 'category', ['0', '1'])), ids, 'cat01', 3);
  const ord01 = mkRun(structured(variable('flag', 'ordinal', ['0', '1'])), ids, 'ord01', 4);
  const plain = mkRun(text, ids, 'plain', 5, 3);
  const results = docs.flatMap((d, i) => [
    mkResult('yn', d.id, { flag: String(a(i)) }),
    mkResult('catyn', d.id, { flag: a(i) ? 'yes' : 'no' }),
    mkResult('cat01', d.id, { flag: b(i) ? '1' : '0' }),
    mkResult('ord01', d.id, { flag: b(i) ? '1' : '0' }),
    ...[1, 2, 3].map((r) => mkResult('plain', d.id, answer({ flag: b(i) ? 1 : 0, flag_explanation: 'e' }), r)),
  ]);
  const runs = [yn, catyn, cat01, ord01, plain];
  // sklearn: 48 of 60 agree, κ 0.571429; krippendorff (nominal): α 0.572967; Gwet's AC1 (q = 2): 0.626556.
  const pairs: [Run, Run][] = [[yn, cat01], [yn, ord01], [catyn, plain], [catyn, cat01], [catyn, ord01], [yn, plain]];

  for (const [x, y] of pairs)
    for (const [first, second] of [[x, y], [y, x]]) {
      it(`${first.id} vs ${second.id}: the panel compares them as yes/no`, () => {
        const { f, r } = panel(first, second, docs, runs, results);
        expect([f.level, f.allowed, f.yesNo]).toEqual(['nominal', ['false', 'true'], true]);
        expect([r.n, r.leftOut.n, r.percentAgreement]).toEqual([60, 0, 0.8]);
        expect(r.cohenKappa).toBeCloseTo(0.571429, 5);
        expect(r.krippendorffAlpha).toBeCloseTo(0.572967, 5);
        expect(r.gwetAC1).toBeCloseTo(0.626556, 5);
      });

      it(`${first.id} vs ${second.id}: the comparison report gives the same figures`, async () => {
        const sheet = await sheets(await buildComparisonReport(first, second, docs, runs, results, 1));
        const row = sheet('Summary').find((s) => s.field === 'flag')!;
        expect([row.level, row.n_compared, row.exact_agreement, row.cohen_kappa]).toEqual(['nominal', 60, 0.8, 0.5714]);
        expect(String(sheet('Draft text')[0].draft_text)).toContain('80.0%');
      });
    }

  it('two runs in words, or two in numbers, are compared as before', () => {
    expect(panel(catyn, yn, docs, runs, results).r.percentAgreement).toBe(1);
    // 0 and 1 on both sides: numbers, as before (they agree on every text).
    for (const [x, y] of [[cat01, ord01], [ord01, plain], [plain, cat01]]) {
      const { f, r } = panel(x, y, docs, runs, results);
      expect([f.yesNo, r.percentAgreement]).toEqual([false, 1]);
    }
  });

  it('a coder’s 1/0, y/n, yes/no or TRUE/FALSE reads the same against every form', () => {
    const forms = ['1', 'y', 'Yes', 'TRUE', '0', 'n', 'No', 'false'];
    for (const run of runs) {
      const f = comparableFields(run, buildDocViews(docs, runs, results, run.id).values())[0];
      expect(dichotomy(f)).toBe(true);
      const read = forms.map((v) => labelValue(v, f));
      expect(read).toEqual(f.yesNo ? ['true', 'true', 'true', 'true', 'false', 'false', 'false', 'false'] : ['1', '1', '1', '1', '0', '0', '0', '0']);
    }
  });

  // sklearn: words (a) against the labels 42 of 59, κ 0.407561; numbers (b) 50 of 59, κ 0.690018.
  for (const [run, pa, kappa] of [[yn, 42 / 59, 0.407561], [catyn, 42 / 59, 0.407561], [cat01, 50 / 59, 0.690018], [ord01, 50 / 59, 0.690018], [plain, 50 / 59, 0.690018]] as const) {
    it(`run ${run.id}: the exports pair flag_gold and leave none of its labels out`, () => {
      expect(labelPairs(run, docs, runs, results).pairs).toEqual([{ field: 'flag', column: 'flag_gold' }]);
      const row = agreementForRun(run, docs, runs, results).find((x) => x.compared_with === 'flag_gold')!;
      expect([row.stats.n, row.stats.leftOut.n, row.nLabelled]).toEqual([59, 0, 59]);
      expect(row.stats.percentAgreement).toBeCloseTo(pa, 10);
      expect(row.stats.cohenKappa).toBeCloseTo(kappa, 5);
    });
  }

  it('“Disagree with flag_gold” lists the same texts as the panel, in words and in numbers', () => {
    const disagree = (run: Run) => [...compareRows('flag', 'flag_gold', docs, buildDocViews(docs, runs, results, run.id))].filter(([, r]) => r.counts && r.value !== r.label).map(([id]) => id);
    const words = ['d5', 'd7', 'd10', 'd14', 'd15', 'd20', 'd21', 'd25', 'd28', 'd30', 'd40', 'd42', 'd45', 'd49', 'd50', 'd55', 'd56'];
    const numbers = ['d0', 'd7', 'd14', 'd21', 'd28', 'd35', 'd42', 'd49', 'd56'];
    expect(disagree(yn)).toEqual(words);
    expect(disagree(catyn)).toEqual(words);
    expect(disagree(cat01)).toEqual(numbers);
    expect(disagree(ord01)).toEqual(numbers);
    expect(disagree(plain)).toEqual(numbers);
  });
});

describe('plain-text 0/1 scores with a code or a stray answer stay yes/no (M4, M10)', () => {
  const docs = Array.from({ length: 100 }, (_, i) => mkDoc(`d${i}`, i, { flag_gold: i === 99 ? 'NA' : word(i, c(i)) }));
  const ids = docs.map((d) => d.id);
  const yn = mkRun(structured(variable('flag', 'boolean')), ids, 'yn', 1);
  // A 9 ("can't tell") from all three replicates on 5 texts, a stray 2 and a stray 9 from one replicate on two others.
  const reps9 = (i: number) => (i % 20 === 3 ? [9, 9, 9] : i === 7 ? [+b(i), +b(i), 2] : i === 11 ? [+b(i), 9, +b(i)] : [+b(i), +b(i), +b(i)]);
  const reps2 = (i: number) => (i === 7 ? [+b(i), +b(i), 2] : [+b(i), +b(i), +b(i)]);
  const plainRun = (id: string, reps: (i: number) => number[]) => ({
    run: mkRun(text, ids, id, 2, 3),
    results: docs.flatMap((d, i) => reps(i).map((z, r) => mkResult(id, d.id, answer({ flag: z, flag_explanation: 'e' }), r + 1))),
  });
  const ynResults = docs.map((d, i) => mkResult('yn', d.id, { flag: String(a(i)) }));
  const p9 = plainRun('p9', reps9);
  const p2 = plainRun('p2', reps2);

  for (const order of ['yes/no first', 'plain text first'])
    it(`codes and strays: the 9s left out and reported, the rest compared as yes/no (${order})`, async () => {
      const runs = [yn, p9.run];
      const results = [...ynResults, ...p9.results];
      const [first, second] = order === 'yes/no first' ? [yn, p9.run] : [p9.run, yn];
      const { f, r } = panel(first, second, docs, runs, results);
      expect([f.yesNo, r.n, r.leftOut.n, r.leftOut.values]).toEqual([true, 95, 5, ['9']]);
      // sklearn: 75 of 95 agree, κ 0.549550; krippendorff α 0.55.
      expect(r.percentAgreement).toBeCloseTo(75 / 95, 10);
      expect(r.cohenKappa).toBeCloseTo(0.54955, 5);
      expect(r.krippendorffAlpha).toBeCloseTo(0.55, 5);
      const row = (await sheets(await buildComparisonReport(first, second, docs, runs, results, 1)))('Summary')[0];
      expect([row.n_compared, row.n_left_out_not_on_scale, row.cohen_kappa]).toEqual([95, 5, 0.5495]);
    });

  it('one stray 2 among 300 answers: the coders’ words still read as 1/0, with the figures of the answers without it', () => {
    const runs = [yn, p2.run];
    const results = [...ynResults, ...p2.results];
    const f = comparableFields(p2.run, buildDocViews(docs, runs, results, p2.run.id).values())[0];
    expect([f.range, f.zeroOne]).toEqual([[0, 2], true]);
    expect(labelPairs(p2.run, docs, runs, results).pairs).toEqual([{ field: 'flag', column: 'flag_gold' }]);
    const row = agreementForRun(p2.run, docs, runs, results).find((x) => x.compared_with === 'flag_gold')!;
    // sklearn: 84 of 99, κ 0.686907.
    expect([row.stats.n, row.stats.leftOut.n]).toEqual([99, 0]);
    expect(row.stats.percentAgreement).toBeCloseTo(84 / 99, 10);
    expect(row.stats.cohenKappa).toBeCloseTo(0.686907, 5);
    const disagree = [...compareRows('flag', 'flag_gold', docs, buildDocViews(docs, runs, results, p2.run.id))].filter(([, r]) => r.counts && r.value !== r.label).map(([id]) => id);
    expect(disagree).toEqual(['d0', 'd7', 'd14', 'd21', 'd28', 'd35', 'd42', 'd49', 'd56', 'd63', 'd70', 'd77', 'd84', 'd91', 'd98']);
    // Against the Yes/no run, both orders (sklearn: 80 of 100, κ 0.572650).
    for (const [x, y] of [[yn, p2.run], [p2.run, yn]]) {
      const { f: pf, r } = panel(x, y, docs, runs, results);
      expect([pf.yesNo, r.n, r.percentAgreement]).toEqual([true, 100, 0.8]);
      expect(r.cohenKappa).toBeCloseTo(0.57265, 5);
    }
  });

  it('a −3…3 field whose answers are nearly all 0 or 1 keeps its other values against numbers (only a field in words pairs as yes/no)', () => {
    // As in a corpus where most texts score 0: 300 texts × 3 answers, a 2 on 2 texts and a −1 on 1 (under 1%).
    const many = Array.from({ length: 300 }, (_, i) => mkDoc(`m${i}`, i, { race_gold: String(i === 5 ? 2 : i % 10 === 0 ? 1 : 0) }));
    const mids = many.map((d) => d.id);
    const score = (i: number) => (i === 5 || i === 150 ? 2 : i === 77 ? -1 : i % 10 === 0 ? 1 : 0);
    const p1 = mkRun(text, mids, 'r1', 1, 3);
    const p2 = mkRun(text, mids, 'r2', 2, 3);
    const cb = mkRun(structured(variable('race', 'ordinal', ['-3', '-2', '-1', '0', '1', '2', '3'])), mids, 'rc', 3);
    const results = many.flatMap((d, i) => [
      ...[1, 2, 3].map((r) => mkResult('r1', d.id, answer({ race: score(i) }), r)),
      ...[1, 2, 3].map((r) => mkResult('r2', d.id, answer({ race: i === 150 ? 1 : score(i) }), r)),
      mkResult('rc', d.id, { race: String(score(i)) }),
    ]);
    const runs = [p1, p2, cb];
    const f1 = comparableFields(p1, buildDocViews(many, runs, results, 'r1').values())[0];
    // (Taken for 0/1 scores with strays: a coder's yes/no would read as 1/0, numbers are read as they are.)
    expect([f1.zeroOne, labelValue('2', f1), labelValue('-1', f1)]).toEqual([true, '2', '-1']);
    for (const [x, y] of [[p1, p2], [p2, p1], [p1, cb], [cb, p1]]) {
      const { f, r } = panel(x, y, many, runs, results, 'race');
      expect([f.yesNo, r.n, r.leftOut.n]).toEqual([false, 300, 0]);
      expect(r.percentAgreement).toBeCloseTo(x === cb || y === cb ? 1 : 299 / 300, 12);
    }
    const row = agreementForRun(p1, many, runs, results).find((x) => x.compared_with === 'race_gold')!;
    expect([row.stats.n, row.stats.leftOut.n]).toEqual([300, 0]);
  });

  it('a scale whose answers are mostly 0 and 1 but use −1 and 2 too is no yes/no', () => {
    // −3…3 scores: 0 or 1 on most texts, −1 or 2 on every 10th (10%).
    const scale = mkRun(text, ids, 'sc', 3);
    const results = docs.map((d, i) => mkResult('sc', d.id, answer({ flag: i % 10 === 0 ? (i % 20 ? -1 : 2) : +b(i) })));
    const f = comparableFields(scale, buildDocViews(docs, [yn, scale], results, 'sc').values())[0];
    expect([f.zeroOne, dichotomy(f)]).toEqual([false, false]);
    expect(labelValue('yes', f)).toBe('true');
    expect(combineFields(f, comparableFields(yn, []).find((x) => x.key === 'flag')!).yesNo).toBe(false);
  });
});

describe('the comparison report’s Review sheet: a pair the Summary leaves out is left out there too (gap note)', () => {
  // 40 texts, a Yes/no run and a plain-text run with 2 replicates: on 10 texts the replicates give 1 and 0 (a 0.5 median,
  // no yes/no), on 10 others they disagree with the Yes/no run.
  const docs = Array.from({ length: 40 }, (_, i) => mkDoc(`d${i}`, i, { era: i % 2 ? 'old' : 'new' }));
  const code = (i: number) => i % 4 !== 3;
  const reps = (i: number) => (i < 10 ? [1, 0] : i < 30 ? [+code(i), +code(i)] : [+!code(i), +!code(i)]);
  const coded = mkRun(structured(variable('flag', 'boolean')), docs.map((d) => d.id), 'ca', 1);
  const plain = mkRun(text, docs.map((d) => d.id), 'pb', 2, 2);
  const results = docs.flatMap((d, i) => [
    mkResult('ca', d.id, { flag: String(code(i)) }),
    ...reps(i).map((z, r) => mkResult('pb', d.id, answer({ flag: z, flag_explanation: 'e' }), r + 1)),
  ]);
  const runs = [coded, plain];

  it('the 0.5 ties are “not a category”, as many as the Summary left out, after the disagreements', async () => {
    const sheet = await sheets(await buildComparisonReport(coded, plain, docs, runs, results, 1, 'era'));
    const summary = sheet('Summary')[0];
    expect([summary.n_compared, summary.n_left_out_not_on_scale]).toEqual([30, 10]);
    const review = sheet('Review');
    const count = (category: string) => review.filter((r) => r.category === category).length;
    expect([count('differ'), count('agree'), count('not a category')]).toEqual([10, 20, 10]);
    expect(review.slice(-10).every((r) => r.category === 'not a category' && r.second === '0.5')).toBe(true);
    expect(sheet('Notes').some((n) => String(n.note).includes('“not a category”'))).toBe(true);
  });

  it('every field: the Review sheet’s left-out rows are exactly the pairs the Summary left out', async () => {
    // Several kinds, in both orders: a Yes/no field against 0/1 scores with 0.5 medians, and against a 0/1 codebook with
    // ties ("0 | 1"); a −3…3 codebook against scores with "NA" and a 9 (the codebook widened to take in the 9), and
    // against itself with half points; categories in words with ties ("con | pro") against a wider codebook.
    const ids = docs.map((d) => d.id);
    const race = variable('race', 'ordinal', ['-3', '-2', '-1', '0', '1', '2', '3']);
    const s1 = mkRun(structured(variable('flag', 'boolean'), race, variable('stance', 'category', ['pro', 'con'])), ids, 's1', 1, 2);
    const t2 = mkRun(text, ids, 't2', 2, 2);
    const s3 = mkRun(structured(variable('flag', 'category', ['0', '1']), race, variable('stance', 'category', ['pro', 'con', 'neutral'])), ids, 's3', 3, 2);
    const res = docs.flatMap((d, i) => [
      ...[1, 2].map((r) => mkResult('s1', d.id, { flag: String(code(i)), race: String((i % 7) - 3), stance: r === 2 && i < 6 ? 'con' : 'pro' }, r)),
      ...[1, 2].map((r) => mkResult('t2', d.id, answer({ flag: i < 7 ? r - 1 : +code(i), race: i === 3 ? 'NA' : i === 4 ? 9 : ((i + (i % 5 === 0 ? 1 : 0)) % 7) - 3 }), r)),
      ...[1, 2].map((r) => mkResult('s3', d.id, { flag: r === 2 && i > 34 ? String(+!code(i)) : String(+code(i)), race: String(((i + r) % 7) - 3), stance: i % 9 === 0 ? 'neutral' : 'pro' }, r)),
    ]);
    const runs = [s1, t2, s3];
    const lefts: Record<string, number> = {};
    for (const [x, y] of [[s1, t2], [t2, s1], [s1, s3], [s3, s1]]) {
      const sheet = await sheets(await buildComparisonReport(x, y, docs, runs, res, 1));
      const review = sheet('Review');
      for (const s of sheet('Summary').filter((z) => z.texts === 'all')) {
        const rows = review.filter((r) => r.field === s.field);
        const left = rows.filter((r) => String(r.category).startsWith('not ')).length;
        expect([x.id, y.id, s.field, left, rows.length - left]).toEqual([x.id, y.id, s.field, s.n_left_out_not_on_scale ?? 0, s.n_compared]);
        lefts[`${x.id} ${y.id} ${s.field}`] = left;
      }
    }
    // The 0.5 medians against the Yes/no field, and the "NA" (the 9 is on the widened codebook). The "0 | 1" ties read as
    // the Yes/no field's own tie "false | true" (normalizeLabel), so they are compared, not left out.
    expect(lefts).toEqual({ 's1 t2 flag': 7, 't2 s1 flag': 7, 's1 t2 race': 1, 't2 s1 race': 1, 's1 s3 flag': 0, 's3 s1 flag': 0, 's1 s3 race': 0, 's3 s1 race': 0, 's1 s3 stance': 0, 's3 s1 stance': 0 });
  });

  it('scores on a scale: a value that isn’t a number is still “not a number”', async () => {
    // Two plain-text runs on −3…3; the second answers "NA" on 3 texts.
    const ids = docs.map((d) => d.id);
    const p1 = mkRun(text, ids, 'p1', 1);
    const p2 = mkRun(text, ids, 'p2', 2);
    const res = docs.flatMap((d, i) => [mkResult('p1', d.id, answer({ race: (i % 7) - 3 })), mkResult('p2', d.id, answer({ race: i < 3 ? 'NA' : (i % 7) - 3 }))]);
    const sheet = await sheets(await buildComparisonReport(p1, p2, docs, [p1, p2], res, 1));
    expect(sheet('Summary')[0].n_left_out_not_on_scale).toBe(3);
    expect(sheet('Review').filter((r) => r.category === 'not a number').map((r) => r.file).sort()).toEqual(['d0.md', 'd1.md', 'd2.md']);
  });
});

describe('a yes/no tie reads the same in every encoding (lead)', () => {
  it('"no | yes" and "0 | 1" become "false | true" for a yes/no field, and stay as they are otherwise', () => {
    expect(normalizeLabel('No | Yes', true)).toBe('false | true');
    expect(normalizeLabel('0 | 1', true)).toBe('false | true');
    expect(normalizeLabel('false | true', true)).toBe('false | true');
    expect(normalizeLabel('0 | 1')).toBe('0 | 1');
    expect(normalizeLabel('con | pro', true)).toBe('con | pro');
  });
});
