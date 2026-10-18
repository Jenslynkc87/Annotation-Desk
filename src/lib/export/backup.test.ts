import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as dbApi from '../db';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type Result, type ResultLog, type Run, type Study } from '../types';
import { buildBackup, importBackup } from './backup';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const study: Study = {
  id: 's1', name: 'Study "one"', description: 'line\nbreak', createdAt: '2026-01-01', updatedAt: '2026-01-01',
  model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt: DEFAULT_PROMPT,
};
// Texts with line breaks, quotes, commas at the end of lines and non-ASCII letters must come back unchanged.
const docs: Doc[] = ['First text,\nwith a "quote",\r\nand CRLF', 'Andet: æøå — 你好 🎉\n],\n"docs":[', ''].map((text, i) => ({
  id: `d${i}`, studyId: 's1', docId: `doc_${i}`, text, meta: { era: '1990s' }, source: `doc_${i}.txt`, order: i + 1, addedAt: '2026-01-01',
}));
const run: Run = {
  id: 'r1', studyId: 's1', number: 1, label: '', createdAt: '2026-01-02', finishedAt: '2026-01-02', mode: 'batch', scope: 'All', docIds: docs.map((d) => d.id),
  status: 'completed', error: null,
  batch: { provider: 'anthropic', batchId: 'b1', map: { r0: ['d0', 1], r1: ['d1', 1] }, lastStatus: 'ended', lastCheckedAt: null },
  snapshot: { appVersion: 'test', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt: DEFAULT_PROMPT, promptVersion: 1, promptHash: 'h', outputSchema: null, requestBase: { model: 'm' } },
};
const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const results: Result[] = docs.slice(0, 2).map((d) => ({
  id: `r1:${d.id}:1`, runId: 'r1', studyId: 's1', docId: d.id, replicate: 1, status: 'ok', values: { label: 'x' }, rationale: 'why,', reasoningSummary: '',
  rawText: '{"label":"x"}', parseError: null, error: null, usage, latencyMs: 5, requestedAt: '', completedAt: '', responseId: 'id', modelReported: 'm', stopReason: 'end_turn',
}));
const logs: ResultLog[] = results.map((r) => ({ id: r.id, runId: 'r1', studyId: 's1', requestPart: { messages: [{ role: 'user', content: docs[0].text }] }, response: { ok: true } }));

async function seed() {
  await dbApi.putStudy(study);
  await dbApi.putDocs(docs);
  await dbApi.putRun(run);
  for (let i = 0; i < results.length; i++) await dbApi.putResult(results[i], logs[i]);
}

async function check(imported: Study) {
  expect(imported.id).not.toBe(study.id);
  expect(imported.name).toBe('Study "one" (imported)');
  const data = await dbApi.loadStudyData(imported.id);
  expect(data.docs.map((d) => d.text)).toEqual(docs.map((d) => d.text));
  expect(data.runs).toHaveLength(1);
  const r = data.runs[0];
  const idOf = new Map(data.docs.map((d) => [d.docId, d.id]));
  expect(r.docIds).toEqual(docs.map((d) => idOf.get(d.docId)));
  expect(r.batch?.map.r1).toEqual([idOf.get('doc_1'), 1]);
  expect(data.results.map((x) => x.id).sort()).toEqual([`${r.id}:${idOf.get('doc_0')}:1`, `${r.id}:${idOf.get('doc_1')}:1`].sort());
  const ls = await dbApi.getLogsForRun(r.id);
  expect(ls.map((l) => l.id).sort()).toEqual(data.results.map((x) => x.id).sort());
  expect(ls.every((l) => l.studyId === imported.id)).toBe(true);
}

describe('study backup', () => {
  it('round-trips a study written one record per line', async () => {
    await seed();
    const blob = await buildBackup(study, docs, [run], results, true);
    const text = await blob.text();
    // Still one valid JSON document, with everything in it.
    const parsed = JSON.parse(text);
    expect(parsed.docs).toHaveLength(3);
    expect(parsed.logs).toHaveLength(2);
    expect(text.split('\n').length).toBeGreaterThan(8);
    await check(await importBackup(blob));
  });

  it('reads older backups written as a single line', async () => {
    await seed();
    const old = { format: 'annotation-desk-study', version: 1, exportedAt: '', appVersion: 'old', study, docs, runs: [run], results, logs };
    await check(await importBackup(new Blob([JSON.stringify(old)])));
  });

  it('writes empty sections and no logs when asked', async () => {
    const blob = await buildBackup(study, [], [], [], false);
    const parsed = JSON.parse(await blob.text());
    expect(parsed).toMatchObject({ docs: [], runs: [], results: [], logs: [] });
    const imported = await importBackup(blob);
    expect((await dbApi.loadStudyData(imported.id)).docs).toEqual([]);
  });

  it('rejects other files and leaves nothing behind when a file is cut off', async () => {
    await expect(importBackup(new Blob(['{"hello": 1}']))).rejects.toThrow('Not an Annotation Desk study backup');
    await expect(importBackup(new Blob(['not json']))).rejects.toThrow('not valid JSON');
    const before = (await dbApi.listStudies()).length;
    const text = await (await buildBackup(study, docs, [run], results, true)).text();
    const cut = text.slice(0, text.indexOf('"results":[') + 20);
    await expect(importBackup(new Blob([cut]))).rejects.toThrow();
    // Cut exactly at a line break: every line reads fine, but the end is missing.
    await expect(importBackup(new Blob([text.slice(0, text.indexOf('"results":['))]))).rejects.toThrow('incomplete');
    expect((await dbApi.listStudies()).length).toBe(before);
  });
});
