// No export names the app or the build it was made with (owner's choice, Nov 16, 2026), except the research zip's
// software_versions.json, a private record. Old backups (format "annotation-desk-study") still import.
import 'fake-indexeddb/auto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import * as dbApi from './db';
import { buildBackup, importBackup } from './export/backup';
import { buildComparisonReport, buildExcel, buildResearchRepo, buildSupplementary } from './export/packages';
import { openaiAdapter } from './providers/openai';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type Run, type Study } from './types';

const BUILD = '0.1.0+c0ffee1 (2026-11-09)';
(globalThis as Record<string, unknown>).__APP_VERSION__ = BUILD;
const TRACE = /annotation[ _-]?desk|c0ffee1|2026-11-09\)/i;

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const prompt: PromptSpec = {
  ...DEFAULT_PROMPT,
  variables: [
    { name: 'tone', type: 'ordinal', values: ['-3', '-2', '-1', '0', '1', '2', '3'], description: '' },
    { name: 'tone_explanation', type: 'text', values: [], description: '' },
  ],
};
const study: Study = {
  id: 'nov16', name: 'Traces', description: 'Sample sample = validation (2026-10-24): 2 of 6 texts drawn at random; seed 11 (Annotation Desk sampling method 3).',
  createdAt: '', updatedAt: '', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt,
};
const docs: Doc[] = Array.from({ length: 6 }, (_, i) => ({
  id: `n16d${i}`, studyId: study.id, docId: `art_${i}`, text: `text ${i}`, meta: { file: `art_${i}.md`, tone_gold: String((i % 7) - 3) }, source: 'x', order: i, addedAt: '',
}));
const mkRun = (id: string, number: number, appVersion: string): Run => ({
  id, studyId: study.id, number, label: '', createdAt: '2026-11-10T00:00:00Z', finishedAt: '2026-11-10T00:01:00Z', mode: 'sync', scope: '',
  docIds: docs.map((d) => d.id), status: 'completed', batch: null, error: null,
  snapshot: { appVersion, model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt, promptVersion: 1, promptHash: 'h', outputSchema: null, requestBase: { model: 'm' } },
});
// One run made by this build, one by an earlier build, one by the first published version (a bare number).
const runs = [mkRun('n16a', 1, BUILD), mkRun('n16b', 2, '0.1.0+1234abc (2026-10-30)'), mkRun('n16c', 3, '0.1.0')];
const results: Result[] = runs.flatMap((run) =>
  docs.map((d, i) => ({
    id: `${run.id}:${d.id}:1`, runId: run.id, studyId: study.id, docId: d.id, replicate: 1, status: 'ok' as const,
    values: { tone: String((i % 7) - 3), tone_explanation: 'because' }, rationale: '', reasoningSummary: '', rawText: '', parseError: null, error: null,
    usage, latencyMs: 1, requestedAt: '2026-11-10T00:00:30Z', completedAt: '2026-11-10T00:00:31Z', responseId: 'r', modelReported: 'm', stopReason: 'end_turn',
  })),
);
const TRACE_ALL = new RegExp(`${TRACE.source}|1234abc|2026-10-30\\)`, 'i');

async function stored() {
  await dbApi.putStudy(study);
  await dbApi.putDocs(docs);
  for (const run of runs) await dbApi.putRun(run);
  for (const r of results) await dbApi.putResult(r, { id: r.id, runId: r.runId, studyId: r.studyId, requestPart: { messages: [] }, response: { ok: true } });
}

async function zipTexts(blob: Blob): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const out = new Map<string, string>();
  for (const [name, f] of Object.entries(zip.files)) if (!f.dir) out.set(name, name.endsWith('.xlsx') ? await xlsxText(await f.async('blob')) : await f.async('string'));
  return out;
}
async function xlsxText(blob: Blob): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await blob.arrayBuffer());
  const cells: string[] = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => cells.push(String(c.value)))));
  return cells.join('\n');
}

describe('exports name neither the app nor its build (Nov 16, 2026)', () => {
  it('the supplementary package, with texts and logs, for every run', async () => {
    await stored();
    for (const run of runs) {
      const { blob } = await buildSupplementary({ study, docs, runs, results }, run, { includeTexts: true, includeRationales: true, includeLogs: true });
      const files = await zipTexts(blob);
      expect(files.size).toBeGreaterThan(5);
      for (const [name, text] of files) expect([name, TRACE_ALL.test(text)]).toEqual([name, false]);
      const meta = JSON.parse([...files].find(([n]) => n.endsWith('metadata.json'))![1]);
      expect(meta.software).toBeUndefined();
      expect(meta.study_notes).toContain('(sampling method 3)');
    }
  });

  it('the research zip: only software_versions.json names them', async () => {
    await stored();
    const { blob } = await buildResearchRepo({ study, docs, runs, results }, { includeLogs: true });
    const files = await zipTexts(blob);
    const versions = [...files].filter(([n]) => n.endsWith('software_versions.json'));
    expect(versions).toHaveLength(1);
    for (const [name, text] of files) if (!name.endsWith('software_versions.json')) expect([name, TRACE_ALL.test(text)]).toEqual([name, false]);
    const record = JSON.parse(versions[0][1]);
    expect(record.exported_with).toBe(BUILD);
    expect(record.runs.map((r: { made_with: string }) => r.made_with)).toEqual([BUILD, '0.1.0+1234abc (2026-10-30)', '0.1.0']);
    // The README lists it, and says to keep it private.
    const readme = [...files].find(([n]) => n.endsWith('README.md'))![1];
    expect(readme).toContain('`software_versions.json`');
    expect(readme).toContain('keep it private');
  });

  it('the Excel workbook and the comparison report', async () => {
    for (const run of runs) expect(TRACE_ALL.test(await xlsxText(await buildExcel({ study, docs, runs, results }, run, { text: true, rationale: true })))).toBe(false);
    expect(TRACE_ALL.test(await xlsxText(await buildComparisonReport(runs[0], runs[1], docs, runs, results, 1)))).toBe(false);
  });

  it('a study backup keeps only a first-version run’s bare number, and imports again; old backups still import', async () => {
    await stored();
    const blob = await buildBackup(study, docs, runs, true);
    const text = await blob.text();
    expect(TRACE_ALL.test(text)).toBe(false);
    const head = JSON.parse(text.split('\n')[0].slice(0, -1) + '}');
    expect(head.format).toBe('annotation-study-backup');
    expect(head.appVersion).toBeUndefined();
    const imported = await importBackup(blob);
    const back = (await dbApi.loadStudyData(imported.id)).runs.sort((a, b) => a.number - b.number);
    expect(back.map((r) => r.snapshot.appVersion)).toEqual(['', '', '0.1.0']);
    // A backup written before: the old format name, with the app's version.
    const old = text.replace('"format":"annotation-study-backup"', '"format":"annotation-desk-study","appVersion":"0.1.0+1234abc (2026-10-30)"');
    const again = await importBackup(new Blob([old]));
    expect((await dbApi.loadStudyData(again.id)).runs).toHaveLength(3);
  });

  it('new OpenAI requests use a cache key that names no app', () => {
    const base = openaiAdapter.buildRequestBase({
      model: { ...DEFAULT_MODEL_SETTINGS, provider: 'openai', model: 'gpt-4.1' }, options: { ...DEFAULT_RUN_OPTIONS, caching: true }, system: '', outputSchema: null, promptHash: 'abc',
    });
    expect(base.prompt_cache_key).toBe('prompt-abc');
  });
});
