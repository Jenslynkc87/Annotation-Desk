import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import * as dbApi from '../db';
import { init, storageError } from '../store';
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
  // Complete: no longer marked as a partial import, in the database too.
  expect('importIncomplete' in imported).toBe(false);
  expect((await dbApi.listStudies()).find((s) => s.id === imported.id)?.importIncomplete).toBeUndefined();
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
    // (A mark of a partial import in the backup's own study is not carried over.)
    const old = { format: 'annotation-desk-study', version: 1, exportedAt: '', appVersion: 'old', study: { ...study, importIncomplete: true }, docs, runs: [run], results, logs };
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

  it('keeps the logs of earlier attempts replaced by a retry, under the new run and text ids', async () => {
    const s2: Study = { ...study, id: 's2' };
    const run2: Run = { ...run, id: 'r2', studyId: 's2' };
    const base = { ...results[0], id: 'r2:d0:1', runId: 'r2', studyId: 's2' };
    const logOf = (content: string): ResultLog => ({ id: 'r2:d0:1', runId: 'r2', studyId: 's2', requestPart: { content }, response: { content } });
    await dbApi.putResult({ ...base, status: 'error', error: 'overloaded', requestedAt: 't1', responseId: '' }, logOf('first'));
    const retried: Result = { ...base, requestedAt: 't2', responseId: 'id2' };
    await dbApi.putResult(retried, logOf('second')); // the failed attempt's log is kept as r2:d0:1#1
    expect(retried.attempt).toBe(2);

    const blob = await buildBackup(s2, docs, [run2], [retried], true);
    expect(JSON.parse(await blob.text()).logs.map((l: ResultLog) => l.id)).toEqual(['r2:d0:1', 'r2:d0:1#1']);
    const imported = await importBackup(blob);
    const data = await dbApi.loadStudyData(imported.id);
    const r = data.runs[0];
    const d0 = data.docs.find((d) => d.docId === 'doc_0')!.id;
    expect(data.results.map((x) => [x.id, x.attempt])).toEqual([[`${r.id}:${d0}:1`, 2]]);
    const ls = new Map((await dbApi.getLogsForRun(r.id)).map((l) => [l.id, l]));
    expect([...ls.keys()].sort()).toEqual([`${r.id}:${d0}:1`, `${r.id}:${d0}:1#1`]);
    expect(ls.get(`${r.id}:${d0}:1`)?.requestPart).toEqual({ content: 'second' });
    expect(ls.get(`${r.id}:${d0}:1#1`)).toMatchObject({ runId: r.id, studyId: imported.id, attempt: 1, requestPart: { content: 'first' }, replaced: { status: 'error', error: 'overloaded' } });
  });

  it('reads a run’s logs a page at a time, never all at once', async () => {
    const many: ResultLog[] = Array.from({ length: 650 }, (_, i) => ({ id: `r3:d${i}:1`, runId: 'r3', studyId: 's3', requestPart: { content: `text ${i}` }, response: null }));
    await dbApi.putMany('logs', many);
    const real = dbApi.logPagesForRun;
    const pages: number[] = [];
    const paged = vi.spyOn(dbApi, 'logPagesForRun').mockImplementation(async function* (runId, size) {
      for await (const page of real(runId, size)) {
        pages.push(page.length);
        yield page;
      }
    });
    const whole = vi.spyOn(dbApi, 'getLogsForRun');
    try {
      const blob = await buildBackup({ ...study, id: 's3' }, [], [{ ...run, id: 'r3', studyId: 's3' }], [], true);
      expect(pages).toEqual([300, 300, 50]);
      expect(whole).not.toHaveBeenCalled();
      expect(JSON.parse(await blob.text()).logs.map((l: ResultLog) => l.id)).toEqual(many.map((l) => l.id).sort());
    } finally {
      paged.mockRestore();
      whole.mockRestore();
    }
  });

  it('marks the study until the whole file is in, so an import cut off by closing the page is removed at the next start', async () => {
    await seed();
    const text = await (await buildBackup(study, docs, [run], results, true)).text();
    // A file that stops arriving after the texts and runs, as when the page is closed during the import (the
    // import never finishes, and never gets to remove what it wrote).
    const head = new TextEncoder().encode(text.slice(0, text.indexOf('"results":[')));
    const stalled = { stream: () => new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(head) }) } as unknown as Blob;
    const before = (await dbApi.listStudies()).map((s) => s.id);
    void importBackup(stalled);
    const partial = await vi.waitFor(async () => {
      const s = (await dbApi.listStudies()).find((x) => !before.includes(x.id));
      expect(s).toBeDefined();
      expect((await dbApi.loadStudyData(s!.id)).runs).toHaveLength(1);
      return s!;
    });
    expect(partial).toMatchObject({ name: 'Study "one" (imported)', importIncomplete: true });
    await init();
    // Gone, with everything written so far; the complete studies stay.
    expect((await dbApi.listStudies()).map((s) => s.id).sort()).toEqual(before.sort());
    expect(await dbApi.loadStudyData(partial.id)).toEqual({ docs: [], runs: [], results: [] });
  });

  it('reports a full storage as such, and leaves the study marked when even removing it fails', async () => {
    await seed();
    const blob = await buildBackup(study, docs, [run], results, true);
    const before = (await dbApi.listStudies()).map((s) => s.id);
    // Chrome's QuotaExceededError comes without a message.
    const put = vi.spyOn(dbApi, 'putMany').mockRejectedValue(new DOMException('', 'QuotaExceededError'));
    const del = vi.spyOn(dbApi, 'deleteStudy').mockRejectedValue(new Error('the database connection was closed'));
    let err: unknown;
    try {
      err = await importBackup(blob).then(() => null, (e: unknown) => e);
    } finally {
      put.mockRestore();
      del.mockRestore();
    }
    // The cause, not the failed clean-up, is what the owner sees ("Import failed: …").
    expect((err as DOMException).name).toBe('QuotaExceededError');
    expect(storageError(err)).toMatch(/storage is full/);
    const left = (await dbApi.listStudies()).filter((s) => !before.includes(s.id));
    expect(left).toMatchObject([{ name: 'Study "one" (imported)', importIncomplete: true }]);
    await init();
    expect((await dbApi.listStudies()).map((s) => s.id).sort()).toEqual(before.sort());
  });
});
