// Tests for the fifth review round (October 24, 2026), statistics, panel, Workbench and samples: the midpoint of a
// codebook against plain-text scores (H0), the panel's identifier test (H3), two label columns whose field only a
// prompt names (H6), the field "Disagree with" compares (H7, H14, H26, H27), the batch notice (H25), run names in
// the Remaining notice (H12, H22) and samples marked in one column (H2).
import 'fake-indexeddb/auto';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { columnsFieldRun, looksLikeIdColumn, promptField } from '../components/RunsView';
import { codebookFields, compareFieldFor, comparableLabel, remainingNotes, unknownUploadNote } from '../components/Workbench';
import { combineFields, comparableFields, fieldValue, type ComparableField } from './compare';
import { buildComparisonReport } from './export/packages';
import { labelValue } from './export/tables';
import { agreement } from './metrics';
import { normalizeLabel } from './prompt';
import { drawStratifiedSample, takenNote } from './sample';
import { buildDocViews, runName } from './view';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type Run, type Study, type Variable } from './types';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const text: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'text', variables: [] };
const variable = (name: string, type: Variable['type'], values: string[] = []): Variable => ({ name, type, values, description: '' });
const structured = (...variables: Variable[]): PromptSpec => ({ ...DEFAULT_PROMPT, outputMode: 'structured', includeRationale: false, variables });
const mkRun = (prompt: PromptSpec, docIds: string[], id = 'r', number = 1): Run => ({
  id, studyId: 's', number, label: '', createdAt: '', finishedAt: '2026-10-24', mode: 'sync', scope: '', docIds, status: 'completed', batch: null, error: null,
  snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: { ...DEFAULT_RUN_OPTIONS, replicates: 1 }, prompt, promptVersion: 1, promptHash: `h${id}`, outputSchema: null, requestBase: {} },
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

describe('a codebook against plain-text scores keeps the codebook’s midpoint (H0)', () => {
  // 40 texts: (codebook, plain text) = 10× (0, 1), 6× (0, 2), 6× (1, −1), 17 agreeing, and one (3, 4): a single answer
  // of 4 beyond the codebook's −3…3. Only the six (1, −1) pairs are in opposite directions.
  const pairs: [number, number][] = [];
  for (let i = 0; i < 10; i++) pairs.push([0, 1]);
  for (let i = 0; i < 6; i++) pairs.push([0, 2]);
  for (let i = 0; i < 6; i++) pairs.push([1, -1]);
  for (let i = 0; i < 8; i++) pairs.push([2, 2]);
  for (let i = 0; i < 9; i++) pairs.push([-2, -2]);
  pairs.push([3, 4]);
  const docs = pairs.map((_, i) => mkDoc(`d${i}`, i));
  const coded = mkRun(structured(variable('tone', 'ordinal', SCALE)), docs.map((d) => d.id), 'ca', 1);
  const plain = mkRun(text, docs.map((d) => d.id), 'pb', 2);
  const results = pairs.flatMap(([x, y], i) => [mkResult('ca', docs[i].id, { tone: String(x) }), mkResult('pb', docs[i].id, answer({ tone: y, tone_explanation: 'e' }))]);
  const runs = [coded, plain];

  for (const [first, second] of [[coded, plain], [plain, coded]] as const) {
    it(`midpoint 0 and the codebook-only opposite share, with run #${first.number} first`, () => {
      const fa = comparableFields(first, buildDocViews(docs, runs, results, first.id).values())[0];
      const fb = comparableFields(second, buildDocViews(docs, runs, results, second.id).values())[0];
      const f = combineFields(fa, fb);
      // Still widened, so the model's 4 is not left out, but the midpoint is the codebook's.
      expect(f.allowed).toEqual([...SCALE, '4']);
      expect(f.range).toEqual([-3, 3]);
      const vals = (run: Run) => pairs.map(([x, y]) => String(run === coded ? x : y));
      const r = agreement(vals(first), vals(second), f.level, f.allowed, 1, { withIntervals: false, scaleSeen: f.scaleSeen, range: f.range });
      expect(r.leftOut.n).toBe(0);
      expect(r.midpoint).toBe(0);
      expect(r.oppositeDirection).toBeCloseTo(6 / 40, 10);
    });
  }

  it('the comparison report’s Summary and Review sheet use the codebook’s midpoint', async () => {
    const blob = await buildComparisonReport(coded, plain, docs, runs, results, 1);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await blob.arrayBuffer()) as unknown as ArrayBuffer);
    const sheet = (name: string) => {
      const ws = wb.getWorksheet(name)!;
      const head = (ws.getRow(1).values as unknown[]).slice(1) as string[];
      return Array.from({ length: ws.rowCount - 1 }, (_, i) => Object.fromEntries(head.map((h, j) => [h, ws.getRow(i + 2).getCell(j + 1).value])));
    };
    expect(sheet('Summary')[0].opposite_direction).toBe(0.15);
    expect(sheet('Review').filter((r) => r.category === 'opposite direction')).toHaveLength(6);
  });

  it('a 1…5 codebook against a plain-text 6 keeps the midpoint 3', () => {
    const f = combineFields({ key: 'x', label: 'x', level: 'ordinal', allowed: ['1', '2', '3', '4', '5'], yesNo: false }, { key: 'x', label: 'x', level: 'ordinal', allowed: ['1', '2', '3', '4', '5', '6'], scaleSeen: true, range: [1, 6], yesNo: false });
    const r = agreement(['3', '2', '4', '5'], ['4', '4', '2', '6'], f.level, f.allowed, 1, { withIntervals: false, scaleSeen: f.scaleSeen, range: f.range });
    expect(r.midpoint).toBe(3);
    // (2, 4) and (4, 2) are opposite on 1…5; (3, 4) is not.
    expect(r.oppositeDirection).toBe(0.5);
  });

  it('a plain-text 0 below a 1…5 codebook, in both orders: midpoint 3, and the interval drawn around the same share', () => {
    const coded: ComparableField = { key: 'x', label: 'x', level: 'ordinal', allowed: ['1', '2', '3', '4', '5'], yesNo: false };
    const plainX: ComparableField = { key: 'x', label: 'x', level: 'ordinal', allowed: ['0', '1', '2', '3', '4', '5'], scaleSeen: true, range: [0, 5], yesNo: false };
    const xs = ['2', '4', '3', '1', '5', '2', '4', '3', '2', '4', '3', '1'];
    const ys = ['4', '2', '3', '0', '5', '2', '4', '2', '4', '2', '3', '1'];
    for (const f of [combineFields(coded, plainX), combineFields(plainX, coded)]) {
      expect([f.allowed, f.range]).toEqual([['0', '1', '2', '3', '4', '5'], [1, 5]]);
      const r = agreement(xs, ys, f.level, f.allowed, 1, { scaleSeen: f.scaleSeen, range: f.range });
      // (With the widened scale's midpoint, 2.5, the (3, 2) pair would count too.)
      expect([r.midpoint, r.oppositeDirection]).toEqual([3, 4 / 12]);
      const [lo, hi] = r.ci!.oppositeDirection!;
      expect(lo <= 4 / 12 && 4 / 12 <= hi).toBe(true);
    }
  });
});

describe('the panel’s identifier test (H3)', () => {
  const years = Array.from({ length: 80 }, (_, i) => String(1900 + i));
  const scores: ComparableField = { key: 'birth_year', label: 'birth_year', level: 'ordinal', allowed: [], scaleSeen: true, range: [1900, 1979], yesNo: false };
  it('does not take mostly distinct years for an identifier on a numeric field, at any level, with "NA" or "unknown" cells', () => {
    expect(looksLikeIdColumn(years, scores, 'ordinal', false)).toBe(false);
    const withNa = [...years.slice(0, 78), 'NA', 'unknown'];
    expect(looksLikeIdColumn(withNa, scores, 'interval', false)).toBe(false);
    expect(looksLikeIdColumn(withNa, { key: 'n', label: 'n', level: 'interval', allowed: [], yesNo: false }, 'interval', false)).toBe(false);
    // Two label columns with no field, Interval picked by hand.
    expect(looksLikeIdColumn(withNa, undefined, 'interval', false)).toBe(false);
  });
  it('still flags a file-name column, and never a column the exports pair with the field', () => {
    const files = years.map((y) => `article_${y}.md`);
    expect(looksLikeIdColumn(files, scores, 'ordinal', false)).toBe(true);
    expect(looksLikeIdColumn(files, undefined, 'nominal', false)).toBe(true);
    expect(looksLikeIdColumn(files, scores, 'ordinal', true)).toBe(false);
    // Few texts, or few distinct values: no identifier.
    expect(looksLikeIdColumn(files.slice(0, 20), undefined, 'nominal', false)).toBe(false);
    expect(looksLikeIdColumn(years.map((y) => y.slice(0, 3)), undefined, 'nominal', false)).toBe(false);
  });
});

describe('two label columns whose field only a prompt names (H6)', () => {
  // 100 texts: coders' labels on 60, "NA" on the other 40; the only run is of a tone prompt.
  const sc = (k: number) => String((((k % 7) + 7) % 7) - 3);
  const docs = Array.from({ length: 100 }, (_, i) =>
    mkDoc(`d${i}`, i, { race_gold: i < 60 ? sc(i) : 'NA', race_coder2: i < 60 ? (i % 4 ? sc(i) : sc(i + 1)) : 'NA' }),
  );
  const toneRun = mkRun(structured(variable('tone', 'ordinal', SCALE)), docs.map((d) => d.id), 'r', 1);
  const results = docs.map((d, i) => mkResult('r', d.id, { tone: sc(i) }));
  const raceP = structured(variable('race', 'ordinal', SCALE));
  const panel = (f: ComparableField) => {
    const xs: string[] = [];
    const ys: string[] = [];
    for (const d of docs) {
      const [x, y] = [labelValue(d.meta.race_gold, f), labelValue(d.meta.race_coder2, f)];
      if (x && y) (xs.push(x), ys.push(y));
    }
    return agreement(xs, ys, f.level, f.allowed, 1, { withIntervals: false, scaleSeen: f.scaleSeen, range: f.range });
  };

  for (const [name, st] of [['the current prompt', mkStudy(raceP)], ['a saved prompt', mkStudy(text, [raceP])]] as const) {
    it(`finds race in ${name}, with its scale, listed with the latest run’s fields; "NA" is a blank cell`, () => {
      const m = columnsFieldRun('race_gold', 'race_coder2', st, [toneRun], docs, results);
      expect(m?.field.key).toBe('race');
      expect(m?.field.allowed).toEqual(SCALE);
      expect(m?.run.id).toBe('r');
      expect(m?.fields.map((x) => x.key)).toEqual(['tone', 'race']);
      const r = panel(m!.field);
      expect(r.n).toBe(60);
      expect(r.percentAgreement).toBeCloseTo(0.75, 10);
      expect(r.weightedKappa).not.toBeNull();
    });
  }

  it('a plain-text prompt: numbers compared as numbers, no range, "NA" blank', () => {
    const st = mkStudy({ ...text, variables: [variable('race', 'ordinal', SCALE)] });
    const f = promptField('race_gold', 'race_coder2', st, docs, ['race', 'tone'])!;
    expect([f.key, f.level, f.scaleSeen, f.range, f.allowed]).toEqual(['race', 'ordinal', true, undefined, []]);
    const r = panel(f);
    expect(r.n).toBe(60);
    expect(r.leftOut.n).toBe(0);
    // A label far off counts (no distance rule without the model's range).
    expect(agreement(['3', '1'], ['30', '1'], f.level, f.allowed, 1, { withIntervals: false, scaleSeen: true }).n).toBe(2);
  });

  it('takes the longest field both columns are named after, and none whose values the columns don’t hold', () => {
    const negDocs = docs.map((d) => ({ ...d, meta: { race_negative_gold: d.meta.race_gold, race_negative_coder2: d.meta.race_coder2 } }));
    const st = mkStudy(structured(variable('race', 'ordinal', SCALE), variable('race_negative', 'ordinal', SCALE)));
    expect(columnsFieldRun('race_negative_gold', 'race_negative_coder2', st, [toneRun], negDocs, results)?.field.key).toBe('race_negative');
    const wordsP = mkStudy(structured(variable('race', 'category', ['low', 'high'])));
    expect(columnsFieldRun('race_gold', 'race_coder2', wordsP, [toneRun], docs, results)).toBeUndefined();
    expect(columnsFieldRun('race_gold', 'race_coder2', mkStudy(text), [toneRun], docs, results)).toBeUndefined();
  });
});

describe('the field “Disagree with” compares (H7, H14, H26, H27)', () => {
  // Ten texts; a structured run with tone and stance (the owner's layout: each score with its explanation), and labels
  // that disagree with tone on d1, d4, d7 and with stance on d2, d5.
  const prompt = structured(variable('summary', 'text'), variable('tone_explanation', 'text'), variable('tone', 'ordinal', SCALE), variable('stance_explanation', 'text'), variable('stance', 'ordinal', SCALE));
  const docs = Array.from({ length: 10 }, (_, i) =>
    mkDoc(`d${i}`, i, { tone_gold: String(i % 3 === 1 ? 2 : 0), stance_gold: i === 9 ? 'NA' : String(i % 3 === 2 ? -1 : 1), era: i < 5 ? '1980s' : '2000s' }),
  );
  const run = mkRun(prompt, docs.map((d) => d.id), 'r2', 2);
  const results = docs.map((d) => mkResult('r2', d.id, { summary: 's', tone_explanation: 'e', tone: '0', stance_explanation: 'e', stance: '1' }));
  const runs = [run];
  // What the Workbench lists under "Disagree with <col>" (TextsAndResults: modelValue, labelOf, comparable).
  const disagree = (col: string, studyPrompt: PromptSpec, runFilter: string) => {
    const views = buildDocViews(docs, runs, results, runFilter);
    const viewed = runFilter === 'latest' ? null : runs.find((r) => r.id === runFilter)!;
    const pick = compareFieldFor(col, [], codebookFields(viewed, studyPrompt, views.values(), runs), 'response');
    const pairs: [string, string][] = [];
    const rows: [string, string, string][] = [];
    for (const d of docs) {
      const v = views.get(d.id)!;
      const x = normalizeLabel(v.run ? fieldValue(v.run, v.values, pick.key) : '', pick.yesNo);
      const y = normalizeLabel(d.meta[col], pick.yesNo);
      if (x && y) (pairs.push([x, y]), rows.push([d.id, x, y]));
    }
    const ok = comparableLabel(pick.variable, pairs);
    return { key: pick.key, ids: rows.filter(([, x, y]) => x !== y && ok(x) && ok(y)).map(([id]) => id) };
  };

  it('a structured run: the codebook field the column is named after, not the first', () => {
    expect(disagree('tone_gold', prompt, 'r2')).toEqual({ key: 'tone', ids: ['d1', 'd4', 'd7'] });
    expect(disagree('stance_gold', prompt, 'r2')).toEqual({ key: 'stance', ids: ['d2', 'd5', 'd8'] });
    // A column named after no field: the first field that isn't free text.
    expect(disagree('era', prompt, 'r2').key).toBe('tone');
  });

  it('“Latest” under a structured prompt, and under a plain-text prompt with only structured results', () => {
    expect(disagree('stance_gold', prompt, 'latest')).toEqual({ key: 'stance', ids: ['d2', 'd5', 'd8'] });
    expect(disagree('tone_gold', text, 'latest')).toEqual({ key: 'tone', ids: ['d1', 'd4', 'd7'] });
    expect(disagree('stance_gold', text, 'latest')).toEqual({ key: 'stance', ids: ['d2', 'd5', 'd8'] });
  });

  it('matches the Agreement panel’s disagreements', () => {
    for (const key of ['tone', 'stance']) {
      const f = comparableFields(run, buildDocViews(docs, runs, results, 'r2').values()).find((x) => x.key === key)!;
      const xs: string[] = [];
      const ys: string[] = [];
      for (const d of docs) {
        const y = labelValue(d.meta[`${key}_gold`], f);
        if (y) (xs.push(normalizeLabel(results.find((r) => r.docId === d.id)!.values[key])), ys.push(y));
      }
      const a = agreement(xs, ys, f.level, f.allowed, 1, { withIntervals: false });
      expect(Math.round((1 - a.percentAgreement!) * a.n)).toBe(disagree(`${key}_gold`, prompt, 'r2').ids.length);
    }
  });

  it('a plain-text run’s scores and a structured run’s fields follow one rule in “Latest”', () => {
    const textRun = mkRun(text, ['d0', 'd1'], 'r3', 3);
    const textResults = [mkResult('r3', 'd0', answer({ stance: 1 })), mkResult('r3', 'd1', answer({ stance: -1 }))];
    const views = buildDocViews(docs, [run, textRun], [...results, ...textResults], 'latest');
    const scores = comparableFields(textRun, views.values());
    const codebook = codebookFields(null, text, views.values(), [run, textRun]);
    expect([...codebook.keys()]).toEqual(['tone', 'stance']);
    expect(compareFieldFor('stance_gold', scores, codebook, 'response').field?.key).toBe('stance');
    const tone = compareFieldFor('tone_gold', scores, codebook, 'response');
    expect([tone.key, tone.field, tone.variable?.type]).toEqual(['tone', undefined, 'ordinal']);
    expect(compareFieldFor('era', scores, codebook, 'response').key).toBe('stance');
  });
});

describe('the batch notice with an upload of unknown outcome (H25)', () => {
  it('says what Retry failed waits for, without contradicting “Its results were saved”', () => {
    expect(unknownUploadNote(0, 1, true)).toContain('is offered once the run’s record of its results is saved;');
    expect(unknownUploadNote(0, 1, true)).not.toContain('once these results are saved');
    expect(unknownUploadNote(0, 1, false)).toContain('is offered once these results are saved;');
    expect(unknownUploadNote(1, 0, false)).toContain('is offered once this batch has ended;');
    expect(unknownUploadNote(2, 1, true)).toContain('is offered once these batches have ended and the run’s record of its results is saved;');
  });
});

describe('the Remaining notice names runs that share a number (H12, H22)', () => {
  const a = { ...mkRun(text, ['d0'], 'e5f6a7b8-0000', 3) };
  const b: Run = { ...mkRun(text, ['d1'], 'a1b2c3d4-0000', 3), status: 'submitted', batch: { provider: 'anthropic', batchId: 'x', map: {}, lastStatus: '', lastCheckedAt: null, uploadUnknown: { since: '', requests: 3 } } };
  const w = { one: 'text', many: 'texts' };
  it('by the name of the run with the lost upload', () => {
    const n = remainingNotes({ waiting: 0, unknown: 3, unknownRuns: [3] }, w, [a, b]);
    expect(n.unknown).toContain(`in run #${runName(b, [a, b])}, whose batch upload`);
    expect(n.unknown).toContain(`Retry failed on run #${runName(b, [a, b])} (under`);
    expect(n.unknown).not.toContain('#3,');
    // A name from the store is kept; runs with their own number stay "#3".
    expect(remainingNotes({ waiting: 0, unknown: 1, unknownRuns: ['3-a1b2c3d4'] }, w, [a, b]).unknown).toContain('run #3-a1b2c3d4,');
    expect(remainingNotes({ waiting: 0, unknown: 1, unknownRuns: [3] }, w, [b]).unknown).toContain('in run #3, whose');
  });
});

describe('a second sample in the same column (H2)', () => {
  // 300 texts in 3 eras; 20 already marked sample = validation.
  const docs = Array.from({ length: 300 }, (_, i) => mkDoc(`a${String(i).padStart(3, '0')}`, i, { era: ['1960s', '1980s', '2000s'][i % 3] }));
  const first = drawStratifiedSample(docs, { size: 20, strata: ['era'], exclude: null, seed: 99, markedAs: { column: 'sample', value: 'validation' } });
  const marked = new Set(first.ids);
  const withValidation = docs.map((d) => (marked.has(d.id) ? { ...d, meta: { ...d.meta, sample: 'validation' } } : d));

  it('leaves texts of the other sample out of the draw, and says how many', () => {
    const r = drawStratifiedSample(withValidation, { size: 100, strata: ['era'], exclude: null, seed: 5, markedAs: { column: 'sample', value: 'holdout' } });
    expect(r.ids.filter((id) => marked.has(id))).toEqual([]);
    expect([r.ids.length, r.eligible, r.taken]).toEqual([100, 280, [{ value: 'validation', n: 20 }]]);
    expect(takenNote(r, 'sample')).toBe('not from the 20 texts already marked sample = validation');
    expect(takenNote({ ...r, taken: [{ value: 'validation', n: 20 }, { value: 'pilot', n: 1 }] }, 'sample', { one: 'entry', many: 'entries' })).toBe(
      'not from the 20 entries already marked sample = validation and the 1 marked sample = pilot',
    );
    // Without the marking column (method 3 as before): the same draw as on texts no sample has marked.
    expect(drawStratifiedSample(withValidation, { size: 100, strata: ['era'], exclude: null, seed: 5 }).ids).toEqual(
      drawStratifiedSample(docs, { size: 100, strata: ['era'], exclude: null, seed: 5 }).ids,
    );
  });

  it('a redraw of the same value may take its own texts again, and gives the same sample from the seed', () => {
    const again = drawStratifiedSample(withValidation, { size: 20, strata: ['era'], exclude: null, seed: 99, markedAs: { column: 'sample', value: 'validation' } });
    expect([again.eligible, again.taken]).toEqual([300, []]);
    expect(again.ids).toEqual(first.ids);
    expect(takenNote(again, 'sample')).toBe('');
  });

  it('marked in a column of other metadata (e.g. journal): the note gives their number, not every value', () => {
    const journals = docs.map((d, i) => ({ ...d, meta: { ...d.meta, journal: i < 240 ? `J${i % 12}` : '' } }));
    const r = drawStratifiedSample(journals, { size: 10, strata: [], exclude: null, seed: 1, markedAs: { column: 'journal', value: 'sample' } });
    expect([r.eligible, r.taken.length]).toEqual([60, 12]);
    expect(takenNote(r, 'journal')).toBe('not from the 240 texts whose journal already holds another value (12 values)');
  });
});
