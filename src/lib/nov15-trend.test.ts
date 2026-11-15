import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildComparisonReport } from './export/packages';
import { linearTrend } from './summary';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type Result, type Run } from './types';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

// Reference figures from scipy 1.18.1: linregress(year, second − first) and t.ppf(0.975, n − 2) * stderr.
const years = [1949, 1950, 1952, 1954, 1956, 1958, 1960, 1962, 1964, 1966, 1968, 1970, 1972, 1974, 1976, 1978, 1980, 1982, 1984, 1986, 1988, 1990, 1992, 1994, 1996, 1998, 2000, 2002, 2004, 2006, 2008, 2010, 2012, 2014, 2016, 2018, 2020, 2022, 2024, 2026];
const x = [-1, -2, 0, 2, -3, -3, 3, 1, -3, -1, 1, -3, 1, -2, -3, -3, 0, 0, -3, -2, -3, 1, 0, -3, 3, 1, -3, -2, 2, 2, 1, -3, 1, 1, 0, -3, -2, -3, 1, 3];
const y = [-1, -2, 0, 2, -3, -3, 3, 1, -3, -1, 1, -2, 1, -2, -2, -2, 0, -1, -3, -2, -3, 0, 1, -3, 3, 1, -3, -2, 2, 2, 2, -3, 1, 2, 0, -2, -2, -3, 1, 3];
const REF = { n: 39, slope: 0.002215713067045137, low: -0.004490093414283484, high: 0.008921519548373759 };

describe('trend of the difference between two runs', () => {
  it('matches scipy.stats.linregress', () => {
    const pts = years.map((t, i) => [t, y[i] - x[i]] as [number, number]).filter((_, i) => i !== 5);
    const fit = linearTrend(pts)!;
    expect(fit.n).toBe(REF.n);
    expect(fit.slope).toBeCloseTo(REF.slope, 10);
    expect(fit.ci[0]).toBeCloseTo(REF.low, 5);
    expect(fit.ci[1]).toBeCloseTo(REF.high, 5);
    expect(linearTrend(pts.slice(0, 9))).toBeNull();
    expect(linearTrend(pts.map(([, d]) => [2000, d]))).toBeNull();
  });

  it('adds a "Trend by" sheet to the comparison report, leaving the other sheets as they were', async () => {
    const prompt = { ...DEFAULT_PROMPT, variables: [{ name: 'score', type: 'ordinal' as const, values: ['-3', '-2', '-1', '0', '1', '2', '3'], description: '' }] };
    const mk = (id: string, n: number): Run => ({
      id, studyId: 's', number: n, label: '', createdAt: '', finishedAt: null, mode: 'sync', scope: '', docIds: [], status: 'completed', batch: null, error: null,
      snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt, promptVersion: 1, promptHash: 'h', outputSchema: null, requestBase: {} },
    });
    const a = mk('a', 1);
    const b = mk('b', 2);
    // Text 5 has no year: compared in the Summary, left out of the trend and counted.
    const docs: Doc[] = x.map((_, i) => ({ id: `d${i}`, studyId: 's', docId: `art_${i}`, text: 't', meta: { file: `art_${i}.md`, year: i === 5 ? 'n.d.' : String(years[i]) }, source: 'x', order: i, addedAt: '' }));
    a.docIds = b.docIds = docs.map((d) => d.id);
    const res = (run: Run, v: number[]): Result[] =>
      docs.map((d, i) => ({
        id: `${run.id}:${d.id}:1`, runId: run.id, studyId: 's', docId: d.id, replicate: 1, status: 'ok', values: { score: String(v[i]) }, rationale: '',
        reasoningSummary: '', rawText: '', parseError: null, error: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        latencyMs: 1, requestedAt: '', completedAt: '', responseId: '', modelReported: 'm', stopReason: 'end_turn',
      }));
    const load = async (blob: Blob) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await blob.arrayBuffer());
      return wb;
    };
    const rows = (wb: ExcelJS.Workbook, name: string) => {
      const ws = wb.getWorksheet(name)!;
      const head = (ws.getRow(1).values as unknown[]).slice(1) as string[];
      return Array.from({ length: ws.rowCount - 1 }, (_, i) => Object.fromEntries(head.map((h, j) => [h, ws.getRow(i + 2).getCell(j + 1).value])));
    };
    const results = [...res(a, x), ...res(b, y)];
    const without = await load(await buildComparisonReport(a, b, docs, [a, b], results, 1));
    const withTrend = await load(await buildComparisonReport(a, b, docs, [a, b], results, 1, '', undefined, 'year'));
    expect(without.getWorksheet('Trend by year')).toBeUndefined();
    expect(rows(withTrend, 'Summary')).toEqual(rows(without, 'Summary'));
    expect(rows(withTrend, 'Review')).toEqual(rows(without, 'Review'));
    const [t] = rows(withTrend, 'Trend by year');
    expect(t).toMatchObject({ field: 'score', n_compared: 39, n_without_a_number_in_year: 1, year_from: 1949, year_to: 2026 });
    expect(t.slope_per_unit).toBeCloseTo(REF.slope, 6);
    expect(t.slope_per_unit_ci_low).toBeCloseTo(REF.low, 5);
    expect(t.slope_per_unit_ci_high).toBeCloseTo(REF.high, 5);
    expect(t.slope_per_10_units).toBeCloseTo(REF.slope * 10, 4);
    expect(rows(withTrend, 'Notes').some((r) => String(r.note).startsWith('"Trend by year" sheet'))).toBe(true);
  });
});
