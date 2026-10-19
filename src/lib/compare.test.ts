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
const view = (response: string): DocView => ({ run: textRun, results: [], values: { response }, consistency: {}, rationale: '', status: 'ok' });

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

import ExcelJS from 'exceljs';
import { buildComparisonReport } from './export/packages';
import type { Doc, Result } from './types';

describe('comparison report', () => {
  it('has summary rows for all texts and non-zero texts, and a review sheet ordered for reading', async () => {
    const prompt = { ...DEFAULT_PROMPT, variables: [{ name: 'score', type: 'ordinal' as const, values: ['-3', '-2', '-1', '0', '1', '2', '3'], description: '' }] };
    const mk = (id: string, n: number): Run => ({ ...textRun, id, number: n, docIds: [], snapshot: { ...textRun.snapshot, prompt } });
    const a = mk('a', 1);
    const b = mk('b', 2);
    const x = [-3, -1, 0, 0, 2, 3, 1, 0, -2, 0, 1, 0];
    const y = [-2, 1, 0, 0, 2, 1, 1, 0, -3, 1, 0, 0];
    const docs: Doc[] = x.map((_, i) => ({ id: `d${i}`, studyId: 's', docId: `art_${i}`, text: 't', meta: { file: `art_${i}.md` }, source: 'x', order: i, addedAt: '' }));
    a.docIds = b.docIds = docs.map((d) => d.id);
    const res = (run: Run, v: number[]): Result[] =>
      docs.map((d, i) => ({
        id: `${run.id}:${d.id}:1`, runId: run.id, studyId: 's', docId: d.id, replicate: 1, status: 'ok', values: { score: String(v[i]) }, rationale: `${run.id} because ${i}`,
        reasoningSummary: '', rawText: '', parseError: null, error: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        latencyMs: 1, requestedAt: '', completedAt: '', responseId: '', modelReported: 'm', stopReason: 'end_turn',
      }));
    const blob = await buildComparisonReport(a, b, docs, [a, b], [...res(a, x), ...res(b, y)], 1);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await blob.arrayBuffer());
    const rows = (name: string) => {
      const ws = wb.getWorksheet(name)!;
      const head = (ws.getRow(1).values as unknown[]).slice(1) as string[];
      return Array.from({ length: ws.rowCount - 1 }, (_, i) => Object.fromEntries(head.map((h, j) => [h, ws.getRow(i + 2).getCell(j + 1).value])));
    };
    const summary = rows('Summary');
    expect(summary.map((r) => r.texts)).toEqual(['all', 'at least one non-zero']);
    expect(summary[1].n_compared).toBe(8);
    expect(summary[1].exact_agreement).toBeCloseTo(0.25, 4);
    expect(summary[1].weighted_kappa_linear).toBeCloseTo(0.4921, 4);
    const review = rows('Review');
    expect(review[0]).toMatchObject({ file: 'art_1.md', first: -1, second: 1, category: 'opposite direction', first_explanation: 'a because 1', second_explanation: 'b because 1' });
    expect(review.at(-1)!.category).toBe('agree (zero)');
    expect(review.map((r) => r.category)).toContain('agree (non-zero)');
    const rnd = review.map((r) => r.random as number);
    expect(rnd.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(new Set(rnd).size).toBe(rnd.length);
    expect(String(rows('Draft text')[0].draft_text)).toContain('in direction for 8.3%');
    // Confusion table: row labels first, then the scale in order (not "0", "1", … before "-3").
    const head = (wb.getWorksheet('Table score')!.getRow(1).values as unknown[]).slice(1);
    expect(head).toEqual(['first \\ second', '-3', '-2', '-1', '0', '1', '2', '3']);
  });
});

import { resultsLong } from './export/tables';

describe('explanation columns in the exports', () => {
  it('puts each explanation after its scores, like the older reasoning columns', () => {
    const doc: Doc = { id: 'd', studyId: 's', docId: 'art', text: 't', meta: {}, source: 'x', order: 0, addedAt: '' };
    const r: Result = {
      id: 'r:d:1', runId: 'r', studyId: 's', docId: 'd', replicate: 1, status: 'ok', rationale: '', reasoningSummary: '', rawText: '', parseError: null, error: null,
      values: { response: '{"race": {"explanation": "Because.", "negative": 2, "positive": 0}, "gender": {"explanation": "So.", "negative": 1}}' },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, latencyMs: 1, requestedAt: '', completedAt: '', responseId: '', modelReported: '', stopReason: '',
    };
    const study = { id: 's', name: 'S', description: '', createdAt: '', updatedAt: '', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt: textRun.snapshot.prompt };
    const cols = Object.keys(resultsLong(study, [textRun], [doc], [r], { rationale: false, reasoning: false })[0]);
    expect(cols.filter((c) => c.startsWith('race_') || c.startsWith('gender_'))).toEqual(['race_negative', 'race_positive', 'race_explanation', 'gender_negative', 'gender_explanation']);
  });
});
