import 'fake-indexeddb/auto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import * as dbApi from '../db';
import { agreement } from '../metrics';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type ResultLog, type Run, type Study } from '../types';
import { buildComparisonReport, buildSupplementary, comparisonSentence } from './packages';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const textPrompt: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'text', variables: [] };
const mkRun = (id: string, number: number, docIds: string[], prompt: PromptSpec = textPrompt): Run => ({
  id, studyId: 's', number, label: '', createdAt: '', finishedAt: null, mode: 'sync', scope: '', docIds, status: 'completed', batch: null, error: null,
  snapshot: { appVersion: 'test', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt, promptVersion: 1, promptHash: 'h', outputSchema: null, requestBase: { model: 'm' } },
});
const mkDocs = (n: number, meta: (i: number) => Record<string, string> = () => ({})): Doc[] =>
  Array.from({ length: n }, (_, i) => ({ id: `d${i}`, studyId: 's', docId: `art_${i}`, text: 't', meta: { file: `art_${i}.md`, ...meta(i) }, source: 'x', order: i, addedAt: '' }));
/** A plain-text answer per text (JSON, or an error where the answer is null). */
const answers = (run: Run, docs: Doc[], json: (i: number) => Record<string, unknown> | null): Result[] =>
  docs.map((d, i) => {
    const a = json(i);
    const values: Record<string, string> = a ? { response: JSON.stringify(a) } : {};
    return {
      id: `${run.id}:${d.id}:1`, runId: run.id, studyId: 's', docId: d.id, replicate: 1, status: a ? 'ok' : 'error', values, rationale: '',
      reasoningSummary: '', rawText: '', parseError: null, error: a ? null : 'failed', usage, latencyMs: 1, requestedAt: '', completedAt: '', responseId: '', modelReported: 'm', stopReason: 'end_turn',
    };
  });

async function workbook(blob: Blob) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await blob.arrayBuffer());
  const rows = (name: string) => {
    const ws = wb.getWorksheet(name)!;
    const head = (ws.getRow(1).values as unknown[]).slice(1) as string[];
    return Array.from({ length: ws.rowCount - 1 }, (_, i) => Object.fromEntries(head.map((h, j) => [h, ws.getRow(i + 2).getCell(j + 1).value])));
  };
  const header = (name: string) => (wb.getWorksheet(name)!.getRow(1).values as unknown[]).slice(1);
  return { wb, rows, header };
}

describe('comparison report', () => {
  it('Review sheet: a score that is not a number gets its own category, last, with the value as written', async () => {
    const docs = mkDocs(30);
    const a = mkRun('a', 1, docs.map((d) => d.id));
    const b = mkRun('b', 2, docs.map((d) => d.id));
    // art_3: NA in the first run; art_5: NA in the second; art_7: NA in both (not "agree").
    const va = (i: number) => (i === 3 || i === 7 ? 'NA' : (i % 7) - 3);
    const vb = (i: number) => (i === 5 || i === 7 ? 'NA' : ((i + (i % 3 === 0 ? 1 : 0)) % 7) - 3);
    const results = [...answers(a, docs, (i) => ({ race: va(i) })), ...answers(b, docs, (i) => ({ race: vb(i) }))];
    const { rows } = await workbook(await buildComparisonReport(a, b, docs, [a, b], results, 1));
    const review = rows('Review');
    const na = review.filter((r) => r.category === 'not a number');
    expect(na.map((r) => r.file).sort()).toEqual(['art_3.md', 'art_5.md', 'art_7.md']);
    expect(review.slice(-3).every((r) => r.category === 'not a number')).toBe(true);
    expect(na.find((r) => r.file === 'art_3.md')).toMatchObject({ first: 'NA', second: 1, difference: null });
    expect(na.find((r) => r.file === 'art_5.md')).toMatchObject({ first: 2, second: 'NA', difference: null });
    expect(na.find((r) => r.file === 'art_7.md')).toMatchObject({ first: 'NA', second: 'NA' });
    // As many as the Summary leaves out; every other row has both numbers.
    const summary = rows('Summary')[0];
    expect(summary.n_left_out_not_on_scale).toBe(3);
    expect(summary.n_compared).toBe(27);
    expect(review.filter((r) => r.category !== 'not a number').every((r) => typeof r.first === 'number' && typeof r.second === 'number')).toBe(true);
  });

  it('two runs with different codebook scales are compared on both scales, whichever run comes first', async () => {
    const docs = mkDocs(30);
    const scale = (values: string[]): PromptSpec => ({ ...DEFAULT_PROMPT, variables: [{ name: 'tone', type: 'ordinal', values, description: '' }] });
    // The second run's codebook is wider: its -2 is on its own scale, so nothing is left out, in either order.
    const a = mkRun('a', 1, docs.map((d) => d.id), scale(['0', '1', '2', '3']));
    const b = mkRun('b', 2, docs.map((d) => d.id), scale(['-3', '-2', '-1', '0', '1', '2', '3']));
    const result = (run: Run, d: Doc, tone: string): Result => ({
      ...answers(run, [d], () => ({}))[0], values: { tone },
    });
    const results = [...docs.map((d, i) => result(a, d, String(i % 4))), ...docs.map((d, i) => result(b, d, i % 10 === 0 ? '-2' : String((i + 1) % 4)))];
    const ab = (await workbook(await buildComparisonReport(a, b, docs, [a, b], results, 1))).rows('Summary')[0];
    const ba = (await workbook(await buildComparisonReport(b, a, docs, [a, b], results, 1))).rows('Summary')[0];
    expect([ab.n_compared, ab.n_left_out_not_on_scale, ba.n_compared, ba.n_left_out_not_on_scale]).toEqual([30, undefined, 30, undefined]);
    expect(ab.weighted_kappa_linear).toBeCloseTo(ba.weighted_kappa_linear as number, 10);
    expect(ab.gwet_ac2_linear).toBeCloseTo(ba.gwet_ac2_linear as number, 10);
  });

  it('a breakdown column named like a report column is renamed group_<name>, not overwritten', async () => {
    const docs = mkDocs(24, (i) => ({ field: ['history', 'politics', 'sociology'][i % 3], level: i < 12 ? 'early' : 'late', category: i % 2 ? 'x' : 'y' }));
    const a = mkRun('a', 1, docs.map((d) => d.id));
    const b = mkRun('b', 2, docs.map((d) => d.id));
    const results = [
      ...answers(a, docs, (i) => ({ Race: (i % 5) - 2, Gender: (i % 3) - 1 })),
      ...answers(b, docs, (i) => ({ Race: ((i + 1) % 5) - 2, Gender: (i % 3) - 1 })),
    ];
    for (const groupBy of ['field', 'level', 'category']) {
      const { rows, header, wb } = await workbook(await buildComparisonReport(a, b, docs, [a, b], results, 1, groupBy));
      const col = `group_${groupBy}`;
      const review = rows('Review');
      expect(header('Review').slice(0, 3)).toEqual(['file', 'field', col]);
      expect(new Set(review.map((r) => r.field))).toEqual(new Set(['Race', 'Gender']));
      expect(review.every((r) => r[col] === docs[Number(String(r.file).slice(4, -3))].meta[groupBy])).toBe(true);
      // The sheet keeps the column's own name; its rows keep the field and the statistics' level.
      expect(wb.getWorksheet(`By ${groupBy}`)).toBeDefined();
      const by = rows(`By ${groupBy}`);
      expect(header(`By ${groupBy}`).slice(0, 3)).toEqual(['field', col, 'level']);
      expect(by.map((r) => `${r.field}/${r[col]}`)).toContain(`Race/${docs[0].meta[groupBy]}`);
      expect(by.every((r) => r.level === 'ordinal')).toBe(true);
      if (groupBy === 'category') expect(review.every((r) => ['x', 'y'].includes(String(r[col])) && !['x', 'y'].includes(String(r.category)))).toBe(true);
    }
  });

  it('table sheet names: no apostrophe at either end, and no two names differing only in capitals', async () => {
    const docs = mkDocs(12);
    const a = mkRun('a', 1, docs.map((d) => d.id));
    const b = mkRun('b', 2, docs.map((d) => d.id));
    // "Table Portrayal of the authors'" is 31 characters and ends in an apostrophe; "Race" and "race" differ only in case.
    const json = (shift: number) => (i: number) => ({ "Portrayal of the authors' views": ((i + shift) % 3) - 1, Race: (i % 3) - 1, race: ((i + shift) % 3) - 1, "'quoted'": (i % 3) - 1 });
    const results = [...answers(a, docs, json(0)), ...answers(b, docs, json(1))];
    const { wb } = await workbook(await buildComparisonReport(a, b, docs, [a, b], results, 1, ''));
    const tables = wb.worksheets.map((ws) => ws.name).filter((n) => n.startsWith('Table'));
    expect(tables).toEqual(['Table Portrayal of the authors', 'Table Race', 'Table race_2', "Table 'quoted"]);
  });

  it('plain-text scores: swapping the runs gives the same weighted kappa and AC2', async () => {
    const docs = mkDocs(21);
    const a = mkRun('a', 1, docs.map((d) => d.id));
    const b = mkRun('b', 2, docs.map((d) => d.id));
    // The first run also used -3 and 3, on a text the second run has no answer for: its range is wider.
    const x = [0, 1, -1, 0, 1, 0, -1, 1, 0, 0, 1, -1, 0, 1, 0, 0, -1, 1, 0, 0, -3];
    const y = [0, 1, -1, 1, 1, 0, -1, 0, 0, 0, 1, -1, 0, 1, -1, 0, -1, 1, 0, 1, null];
    const results = [...answers(a, docs, (i) => ({ race: x[i], race_explanation: 'a', other: i === 0 ? 3 : 0 })), ...answers(b, docs, (i) => (y[i] === null ? null : { race: y[i], race_explanation: 'b', other: 0 }))];
    const ab = (await workbook(await buildComparisonReport(a, b, docs, [a, b], results, 1))).rows('Summary');
    const ba = (await workbook(await buildComparisonReport(b, a, docs, [a, b], results, 1))).rows('Summary');
    const race = (rows: Record<string, unknown>[]) => rows.find((r) => r.field === 'race' && r.texts === 'all')!;
    expect(race(ab).n_compared).toBe(20);
    for (const k of ['weighted_kappa_linear', 'weighted_kappa_quadratic', 'gwet_ac2_linear', 'gwet_ac2_linear_ci_low', 'gwet_ac2_linear_ci_high', 'krippendorff_alpha', 'cohen_kappa']) {
      expect(race(ba)[k], k).toBe(race(ab)[k]);
    }
    expect((race(ba).mean_difference_second_minus_first as number) + (race(ab).mean_difference_second_minus_first as number)).toBeCloseTo(0, 10);
  });
});

describe('comparisonSentence', () => {
  it('never writes "-0.00" for a tiny negative mean difference or interval end', () => {
    const base = agreement(['1', '0', '-1', '1'], ['1', '0', '-1', '0'], 'ordinal', ['-1', '0', '1'], 1, { withIntervals: false });
    const s = { ...base, meanDifference: -0.0025, ci: { meanDifference: [-0.004, 0.002] as [number, number] } };
    const text = comparisonSentence('race', 'A', 'B', s, 4);
    expect(text).toContain('mean difference 0.00, 95% CI 0.00 to 0.00');
    expect(text).not.toMatch(/-0\.00/);
    const clear = comparisonSentence('race', 'A', 'B', { ...s, meanDifference: -0.012, ci: { meanDifference: [-0.02, -0.001] as [number, number] } }, 4);
    expect(clear).toContain('B scored on average 0.01 points lower than A (95% CI -0.02 to 0.00)');
  });
});

describe('request and response logs in the supplementary package', () => {
  it('are read a page at a time, in the study order of texts, replicate and attempt, with replaced attempts', async () => {
    // More logs than one page (300), and a study order unlike the order of the ids.
    const n = 160;
    const docs: Doc[] = Array.from({ length: n }, (_, i) => ({
      id: `k${String((i * 7919) % 1009).padStart(4, '0')}`, studyId: 's', docId: `art_${i}`, text: `text ${i}`, meta: {}, source: 'x', order: i, addedAt: '',
    }));
    const study: Study = { id: 's', name: 'Logs', description: '', createdAt: '', updatedAt: '', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt: textPrompt };
    const run: Run = {
      ...mkRun('run1', 1, docs.map((d) => d.id)),
      snapshot: { ...mkRun('run1', 1, []).snapshot, appVersion: 'old', options: { ...DEFAULT_RUN_OPTIONS, replicates: 2 } },
      replaced: { requests: 1, usage },
    };
    const result = (d: Doc, rep: number, status: 'ok' | 'error', requestedAt: string): Result => ({
      id: `${run.id}:${d.id}:${rep}`, runId: run.id, studyId: 's', docId: d.id, replicate: rep, status, values: status === 'ok' ? { response: 'fine' } : {}, rationale: '',
      reasoningSummary: '', rawText: '', parseError: null, error: status === 'ok' ? null : 'overloaded', usage, latencyMs: 1, requestedAt, completedAt: requestedAt, responseId: requestedAt, modelReported: 'm', stopReason: 'end_turn',
    });
    const log = (r: Result, answer: string): ResultLog => ({ id: r.id, runId: run.id, studyId: 's', requestPart: { messages: [{ role: 'user', content: r.docId }] }, response: { answer } });
    await dbApi.putStudy(study);
    await dbApi.putDocs(docs);
    await dbApi.putRun(run);
    const results: Result[] = [];
    for (const d of docs)
      for (const rep of [1, 2]) {
        // The second text's replicate 2 failed first, then "Retry failed" replaced it.
        const r = result(d, rep, d === docs[1] && rep === 2 ? 'error' : 'ok', 't1');
        await dbApi.putResult(r, log(r, r.status === 'ok' ? 'first' : 'error'));
        results.push(r);
      }
    const retried = result(docs[1], 2, 'ok', 't2');
    await dbApi.putResult(retried, log(retried, 'second'));
    expect(retried.attempt).toBe(2);
    results[3] = retried;

    const { blob } = await buildSupplementary({ study, docs, runs: [run], results }, run, { includeTexts: false, includeRationales: false, includeLogs: true });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const read = async (suffix: string) => zip.file(Object.keys(zip.files).find((k) => k.endsWith(suffix))!)!.async('string');
    const lines = async (suffix: string) => (await read(suffix)).trim().split('\n').map((l) => JSON.parse(l));
    const requests = await lines('logs/requests.jsonl');
    const responses = await lines('logs/responses.jsonl');
    expect(requests).toHaveLength(2 * n + 1);
    expect(responses).toHaveLength(2 * n + 1);
    const expected = docs.flatMap((d, i) => (i === 1 ? [[d.docId, 1, 1], [d.docId, 2, 1], [d.docId, 2, 2]] : [[d.docId, 1, 1], [d.docId, 2, 1]]));
    expect(responses.map((l) => [l.doc_id, l.replicate, l.attempt])).toEqual(expected);
    expect(requests.map((l) => [l.doc_id, l.replicate, l.attempt])).toEqual(expected);
    expect(requests[0].request).toEqual({ model: 'm', messages: [{ role: 'user', content: docs[0].id }] });
    // Replaced attempts carry their outcome (with the parse error, round four G23); the current one doesn't need to.
    expect(responses.slice(2, 5)).toEqual([
      { doc_id: 'art_1', replicate: 1, attempt: 1, response: { answer: 'first' } },
      { doc_id: 'art_1', replicate: 2, attempt: 1, status: 'error', error: 'overloaded', parse_error: null, response: { answer: 'error' } },
      { doc_id: 'art_1', replicate: 2, attempt: 2, response: { answer: 'second' } },
    ]);

    const readme = await read('README.md');
    expect(readme).toContain('exported from Annotation Desk test (the run was made with old)');
    expect(readme).toContain('| Failed attempts replaced by Retry failed | 1 (their tokens are included in the token totals; their logs are kept) |');
  });
});
