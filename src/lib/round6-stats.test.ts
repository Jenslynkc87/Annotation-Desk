// Tests for the sixth review round (October 24, 2026), statistics, panel and Workbench: a Yes/no field against
// plain-text 0/1 scores (K3), two label columns whose field only a prompt names when the current prompt is plain text
// with its fields hidden (K7, K14), and "Disagree with" in "Latest result per text" judging each text on its own run's
// scale (K15). Review: yes/no labels against plain-text 0/1 scores, in the panel, the exports and the Workbench.
import 'fake-indexeddb/auto';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { columnsFieldRun } from '../components/RunsView';
import { compareRows } from '../components/Workbench';
import { combineFields, comparableFields, fieldValue, type ComparableField } from './compare';
import { buildComparisonReport } from './export/packages';
import { agreementForRun, labelColumnsFor, labelValue } from './export/tables';
import { agreement } from './metrics';
import { normalizeLabel } from './prompt';
import { buildDocViews, type DocView } from './view';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type Run, type Study, type Variable } from './types';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const text: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'text', variables: [] };
const variable = (name: string, type: Variable['type'], values: string[] = []): Variable => ({ name, type, values, description: '' });
const structured = (...variables: Variable[]): PromptSpec => ({ ...DEFAULT_PROMPT, outputMode: 'structured', includeRationale: false, variables });
const mkRun = (prompt: PromptSpec, docIds: string[], id = 'r', number = 1, replicates = 1): Run => ({
  id, studyId: 's', number, label: '', createdAt: '', finishedAt: '2026-10-24', mode: 'sync', scope: '', docIds, status: 'completed', batch: null, error: null,
  snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: { ...DEFAULT_RUN_OPTIONS, replicates }, prompt, promptVersion: 1, promptHash: `h${id}`, outputSchema: null, requestBase: {} },
});
const mkResult = (run: string, doc: string, values: Record<string, string>, rep = 1): Result => ({
  id: `${run}:${doc}:${rep}`, runId: run, studyId: 's', docId: doc, replicate: rep, status: 'ok', values, rationale: '', reasoningSummary: '', rawText: values.response ?? '',
  parseError: null, error: null, usage, latencyMs: 1, requestedAt: '', completedAt: '', responseId: `id-${doc}-${rep}`, modelReported: 'm', stopReason: 'end_turn',
});
const mkDoc = (id: string, order: number, meta: Record<string, string> = {}): Doc => ({ id, studyId: 's', docId: id, text: 't', meta: { file: `${id}.md`, ...meta }, source: `${id}.md`, order, addedAt: '' });
const mkStudy = (prompt: PromptSpec, saved: PromptSpec[] = []): Study => ({
  id: 's', name: 'S', description: '', createdAt: '', updatedAt: '', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt,
  savedPrompts: saved.map((p, i) => ({ id: `p${i}`, name: `P${i}`, savedAt: '', prompt: p })),
});
const SCALE = ['-3', '-2', '-1', '0', '1', '2', '3'];
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

describe('a Yes/no field against plain-text 0/1 scores of the same name (K3)', () => {
  // 40 texts: (codebook, plain text) = 15× (yes, 1), 15× (no, 0), 5× (yes, 0), 5× (no, 1): 75% agree, κ 0.5. The
  // plain-text run has 3 replicates (the owner's layout), two of them giving the combined score.
  const pairs: [boolean, number][] = [];
  for (let i = 0; i < 15; i++) pairs.push([true, 1]);
  for (let i = 0; i < 15; i++) pairs.push([false, 0]);
  for (let i = 0; i < 5; i++) pairs.push([true, 0]);
  for (let i = 0; i < 5; i++) pairs.push([false, 1]);
  const docs = pairs.map((_, i) => mkDoc(`d${i}`, i));
  const coded = mkRun(structured(variable('flag', 'boolean')), docs.map((d) => d.id), 'ca', 1);
  const plain = mkRun(text, docs.map((d) => d.id), 'pb', 2, 3);
  const results = pairs.flatMap(([x, y], i) => [
    mkResult('ca', docs[i].id, { flag: String(x) }),
    ...[y, y, i % 2 ? 1 - y : y].map((z, r) => mkResult('pb', docs[i].id, answer({ flag: z, flag_explanation: 'e' }), r + 1)),
  ]);
  const runs = [coded, plain];
  const fieldOf = (run: Run) => comparableFields(run, buildDocViews(docs, runs, results, run.id).values()).find((f) => f.key === 'flag')!;

  for (const [first, second] of [[coded, plain], [plain, coded]] as const) {
    it(`compared as yes/no with run #${first.number} first, as the panel reads the values`, () => {
      const f = combineFields(fieldOf(first), fieldOf(second));
      expect([f.level, f.allowed, f.yesNo, f.scaleSeen, f.range]).toEqual(['nominal', ['false', 'true'], true, undefined, undefined]);
      const values = (run: Run) => {
        const views = buildDocViews(docs, runs, results, run.id);
        return docs.map((d) => normalizeLabel(fieldValue(run, views.get(d.id)!.values, 'flag'), f.yesNo));
      };
      const r = agreement(values(first), values(second), f.level, f.allowed, 1, { withIntervals: false, scaleSeen: f.scaleSeen, range: f.range });
      expect([r.n, r.leftOut.n, r.percentAgreement, r.cohenKappa, r.gwetAC1]).toEqual([40, 0, 0.75, 0.5, 0.5]);
    });

    it(`the comparison report with run #${first.number} first: 75% agreement, κ 0.5`, async () => {
      const sheet = await sheets(await buildComparisonReport(first, second, docs, runs, results, 1));
      const row = sheet('Summary')[0];
      expect([row.field, row.n_compared, row.exact_agreement, row.cohen_kappa, row.gwet_ac1]).toEqual(['flag', 40, 0.75, 0.5, 0.5]);
      expect(String(sheet('Draft text')[0].draft_text)).toContain('75.0%');
    });
  }

  it('a yes/no answer written as a word among the 0/1 scores is read as yes/no too', () => {
    const f = combineFields(fieldOf(coded), { key: 'flag', label: 'flag', level: 'ordinal', allowed: ['0', '1'], scaleSeen: true, range: [0, 1], yesNo: false });
    expect(f.yesNo).toBe(true);
    expect(['1', 'yes', 'TRUE', '0', 'no'].map((v) => normalizeLabel(v, f.yesNo))).toEqual(['true', 'true', 'true', 'false', 'false']);
  });

  it('plain-text scores beyond 0/1 are no yes/no field: compared as before', () => {
    const yn = fieldOf(coded);
    const scores = (range: [number, number], level: 'ordinal' | 'interval' = 'ordinal'): ComparableField => ({
      key: 'flag', label: 'flag', level, allowed: level === 'ordinal' ? Array.from({ length: range[1] - range[0] + 1 }, (_, i) => String(range[0] + i)) : [], scaleSeen: true, range, yesNo: false,
    });
    for (const other of [scores([0, 3]), scores([-1, 1])]) {
      expect(combineFields(yn, other).yesNo).toBe(false);
      expect(combineFields(other, yn).yesNo).toBe(false);
    }
    // Two sets of plain-text 0/1 scores: no codebook says they are yes/no.
    expect(combineFields(scores([0, 1]), scores([0, 1])).yesNo).toBe(false);
  });

  // (Review.) One stray 0.5 among the answers makes the scores interval: still yes/no, with that text left out and
  // reported, not every 1 and 0 a disagreement.
  it('a stray 0.5 answer: still yes/no, the 0.5 left out and reported', () => {
    const half: ComparableField = { key: 'flag', label: 'flag', level: 'interval', allowed: [], scaleSeen: true, range: [0, 1], yesNo: false };
    for (const f of [combineFields(fieldOf(coded), half), combineFields(half, fieldOf(coded))]) {
      expect([f.level, f.allowed, f.yesNo]).toEqual(['nominal', ['false', 'true'], true]);
      const xs = ['true', 'false', 'true', 'false'];
      const ys = ['1', '0', '0.5', '1'].map((v) => normalizeLabel(v, f.yesNo));
      const r = agreement(xs, ys, f.level, f.allowed, 1, { withIntervals: false, scaleSeen: f.scaleSeen, range: f.range });
      expect([r.n, r.percentAgreement, r.leftOut]).toEqual([3, 2 / 3, { n: 1, values: ['0.5'] }]);
    }
  });
});

describe('two label columns, the current prompt plain text with the codebook’s fields hidden (K7, K14)', () => {
  // 100 texts: coders agree on 3 of 4; coder 2 has a "9" (don't know) on every 10th; NA on texts 80 and up.
  const sc = (k: number) => String((((k % 7) + 7) % 7) - 3);
  const docs = Array.from({ length: 100 }, (_, i) =>
    mkDoc(`d${i}`, i, {
      race_gold: i < 80 ? sc(i) : 'NA',
      race_coder2: i < 80 ? (i % 10 === 0 ? '9' : i % 4 ? sc(i) : sc(i + 1)) : 'NA',
      yn_gold: i < 80 ? (i % 3 ? 'yes' : 'no') : 'NA',
      yn_coder2: i < 80 ? (i % 5 ? (i % 3 ? 'yes' : 'no') : 'yes') : 'NA',
    }),
  );
  const toneRun = mkRun(structured(variable('tone', 'ordinal', SCALE)), docs.map((d) => d.id), 'r', 1);
  const results = docs.map((d, i) => mkResult('r', d.id, { tone: sc(i) }));
  const codebook = structured(variable('race', 'ordinal', SCALE), variable('yn', 'boolean'));
  // The codebook switched to Plain text: its fields stay in the prompt, hidden and not used.
  const plainFromCodebook: PromptSpec = { ...codebook, outputMode: 'text' };
  const panel = (f: ComparableField, a: string, b: string) => {
    const xs: string[] = [];
    const ys: string[] = [];
    for (const d of docs) {
      const [x, y] = [labelValue(d.meta[a], f), labelValue(d.meta[b], f)];
      if (x && y) (xs.push(x), ys.push(y));
    }
    return agreement(xs, ys, f.level, f.allowed, 1, { withIntervals: false, scaleSeen: f.scaleSeen, range: f.range });
  };

  it('a saved codebook wins over the hidden fields: its scale, the 9s left out, and the yes/no field', () => {
    const st = mkStudy(plainFromCodebook, [codebook]);
    const race = columnsFieldRun('race_gold', 'race_coder2', st, [toneRun], docs, results)!.field;
    expect([race.key, race.allowed, race.scaleSeen]).toEqual(['race', SCALE, undefined]);
    const r = panel(race, 'race_gold', 'race_coder2');
    expect([r.n, r.leftOut.n, r.leftOut.values]).toEqual([72, 8, ['9']]);
    const yn = columnsFieldRun('yn_gold', 'yn_coder2', st, [toneRun], docs, results)!.field;
    expect([yn.key, yn.yesNo, yn.allowed]).toEqual(['yn', true, ['false', 'true']]);
    expect(panel(yn, 'yn_gold', 'yn_coder2').n).toBe(80);
  });

  it('gives the same figures as a structured current prompt', () => {
    for (const [a, b] of [['race_gold', 'race_coder2'], ['yn_gold', 'yn_coder2']]) {
      const hidden = columnsFieldRun(a, b, mkStudy(plainFromCodebook, [codebook]), [toneRun], docs, results)!.field;
      const shown = columnsFieldRun(a, b, mkStudy(codebook), [toneRun], docs, results)!.field;
      expect(hidden).toEqual(shown);
    }
  });

  it('a plain-text prompt’s hidden fields alone give no field: the columns are compared as they are', () => {
    expect(columnsFieldRun('race_gold', 'race_coder2', mkStudy(plainFromCodebook), [toneRun], docs, results)).toBeUndefined();
    expect(columnsFieldRun('yn_gold', 'yn_coder2', mkStudy(plainFromCodebook, [plainFromCodebook]), [toneRun], docs, results)).toBeUndefined();
  });

  it('a field of the same name in a later prompt is tried when an earlier one doesn’t fit the columns', () => {
    const words = structured(variable('race', 'category', ['low', 'high']));
    expect(columnsFieldRun('race_gold', 'race_coder2', mkStudy(words, [codebook]), [toneRun], docs, results)?.field.allowed).toEqual(SCALE);
  });
});

describe('“Disagree with” in “Latest result per text” judges each text on its own run’s scale (K15)', () => {
  // 20 texts. A plain-text run on all of them (trust 1…5 in its answers), then a newer structured run with a 1…5
  // codebook on the even ones. Labels: don't-know codes 0 and 8 on two structured texts, a 9 on a plain-text one, and
  // one real disagreement in each run.
  const docs = Array.from({ length: 20 }, (_, i) => mkDoc(`d${i}`, i));
  const score = (i: number) => (i % 5) + 1;
  const gold: Record<number, string> = { 0: '0', 2: '8', 4: '1', 1: '9', 3: '1' };
  for (const [i, d] of docs.entries()) d.meta.trust_gold = gold[i] ?? String(score(i));
  const trust = variable('trust', 'ordinal', ['1', '2', '3', '4', '5']);
  const plain = mkRun(text, docs.map((d) => d.id), 'pt', 1);
  const coded = mkRun(structured(trust), docs.filter((_, i) => i % 2 === 0).map((d) => d.id), 'cb', 2);
  const results = [
    ...docs.map((d, i) => mkResult('pt', d.id, answer({ trust: score(i), trust_explanation: 'e' }))),
    ...docs.filter((_, i) => i % 2 === 0).map((d) => mkResult('cb', d.id, { trust: String(score(Number(d.id.slice(1)))) })),
  ];
  const runs = [plain, coded];
  const disagree = (views: Map<string, DocView>) =>
    [...compareRows('trust', 'trust_gold', docs, views)].filter(([, r]) => r.counts && r.value !== r.label).map(([id]) => id).sort();

  it('structured texts on the codebook (0 and 8 left out), plain-text ones on the range of the answers (9 left out)', () => {
    expect(disagree(buildDocViews(docs, runs, results, 'latest'))).toEqual(['d3', 'd4']);
  });

  it('the structured texts as in the structured run’s own view; the plain-text scale grows only through its own texts', () => {
    const latest = disagree(buildDocViews(docs, runs, results, 'latest'));
    const even = docs.filter((_, i) => i % 2 === 0).map((d) => d.id);
    expect(latest.filter((id) => even.includes(id))).toEqual(disagree(buildDocViews(docs, runs, results, 'cb')));
    // The 8 on d2 (a structured text in "Latest") doesn't carry the plain-text scale up to the 9 on d1.
    const rows = compareRows('trust', 'trust_gold', docs, buildDocViews(docs, runs, results, 'latest'));
    expect(rows.get('d1')).toEqual({ value: '2', label: '9', counts: false });
  });

  it('a structured run on its own codebook, not the current prompt’s or another run’s scale', () => {
    // A newer structured run on the odd texts with trust on −3…3: its texts are judged on −3…3, the even texts on 1…5.
    const wide = mkRun(structured(variable('trust', 'ordinal', SCALE)), docs.filter((_, i) => i % 2 === 1).map((d) => d.id), 'cw', 3);
    const wideResults = docs.filter((_, i) => i % 2 === 1).map((d, k) => mkResult('cw', d.id, { trust: k === 0 ? '-2' : '2' }));
    const views = buildDocViews(docs, [...runs, wide], [...results, ...wideResults], 'latest');
    const rows = compareRows('trust', 'trust_gold', docs, views);
    // d1: label 9 is off −3…3; d3: label 1 against 2 is compared; d0 and d2 (0 and 8) are still off 1…5.
    expect([rows.get('d1')?.counts, rows.get('d3')?.counts, rows.get('d0')?.counts, rows.get('d2')?.counts]).toEqual([false, true, false, false]);
    // Labels 4 and 5 on the −3…3 run's texts are off its scale too: not compared.
    expect(rows.get('d9')).toMatchObject({ value: '2', label: '5', counts: false });
  });

  it('a single run’s view is unchanged: its own scale', () => {
    expect(disagree(buildDocViews(docs, runs, results, 'cb'))).toEqual(['d4']);
    // The plain-text run alone: its answers' range 1…5 grows to 8 through the label 8, which brings in the 9.
    expect(disagree(buildDocViews(docs, runs, results, 'pt'))).toEqual(['d0', 'd1', 'd2', 'd3', 'd4']);
  });
});

describe('yes/no labels against plain-text 0/1 scores (review of K3 and K15)', () => {
  // 40 texts: plain-text "flag" 0/1 in 3 replicates; the label column writes yes/no in words (and NA), as coders do.
  // A newer structured run with a Yes/no flag on the even texts, for "Latest result per text".
  const docs = Array.from({ length: 40 }, (_, i) => mkDoc(`d${i}`, i));
  const score = (i: number) => (i % 3 === 0 ? 0 : 1);
  // Labels agree with the plain-text score except on every 8th text; the words vary in case and form.
  const words = [['no', 'yes'], ['FALSE', 'TRUE'], ['n', 'y'], ['0', '1']];
  for (const [i, d] of docs.entries()) d.meta.flag_gold = i === 39 ? 'NA' : words[i % 4][i % 8 === 5 ? 1 - score(i) : score(i)];
  const plain = mkRun(text, docs.map((d) => d.id), 'pf', 1, 3);
  const coded = mkRun(structured(variable('flag', 'boolean')), docs.filter((_, i) => i % 2 === 0).map((d) => d.id), 'cf', 2);
  const results = [
    ...docs.flatMap((d, i) => [1, 2, 3].map((r) => mkResult('pf', d.id, answer({ flag: score(i), flag_explanation: 'e' }), r))),
    ...docs.filter((_, i) => i % 2 === 0).map((d) => mkResult('cf', d.id, { flag: String(score(Number(d.id.slice(1))) === 1) })),
  ];
  const runs = [plain, coded];
  const field = comparableFields(plain, buildDocViews(docs, runs, results, plain.id).values()).find((f) => f.key === 'flag')!;
  // Texts whose label disagrees with the score: 5, 13, 21, 29, 37.
  const wrong = docs.filter((_, i) => i % 8 === 5).map((d) => d.id);

  it('a yes/no label is read as 1 or 0, other labels as before', () => {
    expect([field.level, field.range, field.yesNo]).toEqual(['ordinal', [0, 1], false]);
    expect(['yes', 'No', 'TRUE', 'false', 'y', 'N', '1', '0', 'NA', ' 1 '].map((v) => labelValue(v, field))).toEqual(['1', '0', '1', '0', '1', '0', '1', '0', '', '1']);
    // Scores beyond 0…1: a word stays a word (no yes/no reading).
    const wide: ComparableField = { ...field, allowed: ['0', '1', '2', '3'], range: [0, 3], zeroOne: false };
    expect(['yes', 'n', '2'].map((v) => labelValue(v, wide))).toEqual(['true', 'n', '2']);
  });

  it('the exports pair the column and compute its agreement as the panel does', () => {
    expect(labelColumnsFor(field, docs).columns).toEqual(['flag_gold']);
    const row = agreementForRun(plain, docs, runs, results).find((r) => r.field === 'flag' && r.compared_with === 'flag_gold')!;
    expect([row.stats.n, row.stats.leftOut.n, row.stats.percentAgreement]).toEqual([39, 0, 34 / 39]);
    // The panel: the run's values and the column through `labelValue`.
    const views = buildDocViews(docs, runs, results, plain.id);
    const xs = docs.map((d) => normalizeLabel(fieldValue(plain, views.get(d.id)!.values, 'flag')));
    const ys = docs.map((d) => labelValue(d.meta.flag_gold, field));
    expect(agreement(xs, ys, field.level, field.allowed, 1, { withIntervals: false, scaleSeen: true, range: field.range }).percentAgreement).toBe(34 / 39);
  });

  it('“Disagree with” in “Latest”: plain-text texts and Yes/no texts each list only real disagreements', () => {
    const rows = compareRows('flag', 'flag_gold', docs, buildDocViews(docs, runs, results, 'latest'));
    expect([...rows].filter(([, r]) => r.counts && r.value !== r.label).map(([id]) => id)).toEqual(wrong);
  });
});
