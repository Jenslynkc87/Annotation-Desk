// Tests for the seventh round of fixes: downloads versus changes to the same study (a download reads the study's
// stored results and logs as it goes, so nothing may change or delete them meanwhile), a download shown as another
// study's, and a batch check racing a delete (October 24, 2026).
// Providers are stubbed: nothing is sent anywhere (any request that does reach `fetch` fails the test).
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildingFor, endBackground, startBackground } from './background';
import * as dbApi from './db';
import { anthropicAdapter } from './providers/anthropic';
import type { BatchItem, CallOutcome, ListedBatch, ProviderAdapter } from './providers/types';
import * as store from './store';
import type { PromptSpec } from './types';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const outcome = (rawText: string): CallOutcome => ({ rawText, reasoningSummary: '', usage, responseId: `id_${Math.random()}`, modelReported: 'm', stopReason: 'end_turn', response: {} });
const connectionError = () => new Error('Connection error.');

/** A browser's localStorage, in memory (Node has none). */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

const confirms: string[] = [];
beforeEach(() => {
  confirms.length = 0;
  (globalThis as Record<string, unknown>).confirm = (m: string) => (confirms.push(m), true);
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('fetch', async (u: unknown) => {
    throw new Error(`unexpected request: ${String(u)}`);
  });
});
afterEach(() => {
  endBackground();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function emptyDatabase() {
  for (const s of await dbApi.listStudies()) await dbApi.deleteStudy(s.id);
}

let studies = 0;
async function freshStudy(n: number, setup: (p: PromptSpec) => void = () => {}) {
  await emptyDatabase();
  await store.createStudy(`Study ${++studies}`);
  store.setKey('anthropic', 'sk-ant-test');
  store.updateStudy((s) => {
    s.prompt.userTemplate = 'Rate it.';
    s.prompt.outputMode = 'text';
    s.prompt.variables = [];
    setup(s.prompt);
  });
  await store.addDocs(Array.from({ length: n }, (_, i) => ({ docId: `t${i}`, text: `text ${i}`, meta: { file: `t${i}.txt` }, source: `t${i}.txt` })));
  return store.getState().docs.map((d) => d.id);
}
const lastRun = () => store.getState().runs.at(-1)!;
const runById = (id: string) => store.getState().runs.find((r) => r.id === id);
const toasts = () => store.getState().toasts.map((t) => t.text);
const batchStudy = () => store.updateStudy((s) => void (s.options.batch = true));
const studyRef = () => ({ id: store.currentStudy()!.id, name: store.currentStudy()!.name });
const tick = () => new Promise((r) => setImmediate(r));

/** A provider's batches, as a stub of the adapter (as in round6-runs.test.ts). */
function fakeBatches(adapter: ProviderAdapter) {
  type Made = { id: string; items: BatchItem[]; at: string; done: boolean; cancelled: boolean };
  const made: Made[] = [];
  let upload: (n: number) => 'ok' | 'lost' | Error = () => 'ok';
  let failing = '';
  const submit = vi.spyOn(adapter, 'submitBatch').mockImplementation(async (_k, _b, items) => {
    const how = upload(made.length + 1);
    if (how instanceof Error) throw how;
    const id = `b${made.length + 1}`;
    made.push({ id, items, at: new Date().toISOString(), done: false, cancelled: false });
    if (how === 'lost') throw connectionError();
    return { batchId: id };
  });
  const list = vi.spyOn(adapter, 'listRecentBatches').mockImplementation(async () =>
    made.map((b): ListedBatch => ({ batchId: b.id, createdAt: b.at, requests: b.items.length, ...(b.cancelled ? { stopped: true } : {}) })).reverse(),
  );
  const check = vi.spyOn(adapter, 'checkBatch').mockImplementation(async (_k, id) => {
    const b = made.find((x) => x.id === id);
    return { status: b?.done ? 'ended' : 'in_progress', done: !!b?.done, total: b?.items.length ?? 0, completed: 0, failed: 0, endedAt: b?.done ? new Date().toISOString() : undefined };
  });
  const fetch = vi.spyOn(adapter, 'fetchBatchResults').mockImplementation(async (_k, id) => {
    const b = made.find((x) => x.id === id)!;
    return b.items.map((it) =>
      b.cancelled || id === failing
        ? { customId: it.customId, ok: false as const, error: b.cancelled ? 'Request canceled' : 'Overloaded' }
        : { customId: it.customId, ok: true as const, outcome: { ...outcome(`answer ${it.customId} of ${id}`), responseId: `${id}_${it.customId}` } },
    );
  });
  vi.spyOn(adapter, 'cancelBatch').mockImplementation(async (_k, id) => {
    const b = made.find((x) => x.id === id);
    if (b) [b.cancelled, b.done] = [true, true];
  });
  return {
    made,
    submit,
    list,
    check,
    fetch,
    uploads: (f: (n: number) => 'ok' | 'lost' | Error) => (upload = f),
    finishAll: () => made.forEach((b) => (b.done = true)),
    failAll: (id: string) => (failing = id),
  };
}

// ---------- the job knows its study ----------

describe('a download being built knows its study (M9, M13, M15)', () => {
  it('buildingFor names the job only for its own study', () => {
    expect(startBackground('backup', 'study backup', { id: 'A', name: 'Study A' })).toBe(true);
    expect(buildingFor('A')).toBe('study backup');
    expect(buildingFor('B')).toBeNull();
    // (Still one at a time, whatever the study.)
    expect(startBackground('report', 'comparison report (run #2 vs run #1)', { id: 'B', name: 'Study B' })).toBe(false);
    endBackground();
    expect(buildingFor('A')).toBeNull();
  });
});

// ---------- M0, M1, M2: nothing changes or deletes the study's stored results while its download is built ----------

describe('while a download of a study is being built, its stored results and logs stay as they are (M0, M1, M2)', () => {
  it('deleting the study or a run is refused, and works once the download is done', async () => {
    await freshStudy(3);
    vi.spyOn(anthropicAdapter, 'send').mockImplementation(async () => outcome('fine'));
    await store.startRun({ docIds: store.getState().docs.map((d) => d.id), scope: 'all' });
    const run = lastRun();
    const study = store.currentStudy()!;
    expect((await dbApi.getResultsForRun(run.id)).length).toBe(3);
    startBackground('backup', 'study backup', studyRef());
    await store.removeStudy(study.id);
    expect((await dbApi.listStudies()).map((s) => s.id)).toContain(study.id);
    expect(toasts().at(-1)).toMatch(/download of this study is still being built \(the study backup\): delete the study once it has been downloaded/);
    await store.removeRun(run.id);
    expect(await dbApi.getRun(run.id)).toBeTruthy();
    expect(toasts().at(-1)).toMatch(/delete the run once it has been downloaded/);
    await store.deleteRunById(run.id);
    expect(await dbApi.getRun(run.id)).toBeTruthy();
    expect((await dbApi.getResultsForRun(run.id)).length).toBe(3);
    expect((await dbApi.getLogsForRun(run.id)).length).toBe(3);
    endBackground();
    await store.removeRun(run.id);
    expect(await dbApi.getRun(run.id)).toBeUndefined();
    expect((await dbApi.getLogsForRun(run.id)).length).toBe(0);
  });

  it('a download of another study does not hold this one back', async () => {
    await freshStudy(2);
    vi.spyOn(anthropicAdapter, 'send').mockImplementation(async () => outcome('fine'));
    await store.startRun({ docIds: store.getState().docs.map((d) => d.id), scope: 'all' });
    const run = lastRun();
    startBackground('research', 'research repository', { id: 'another', name: 'Another' });
    await store.removeRun(run.id);
    expect(await dbApi.getRun(run.id)).toBeUndefined();
  });

  it('Retry failed waits: nothing is sent and the results stay as they are', async () => {
    const ids = await freshStudy(3);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    await store.startRun({ docIds: ids, scope: 'all' });
    const run = lastRun();
    p.failAll('b1');
    p.finishAll();
    await store.checkBatch(run.id);
    expect(runById(run.id)!.status).toBe('completed');
    startBackground('supp', 'supplementary package of run #1', studyRef());
    await store.retryFailed(run.id);
    expect(p.submit).toHaveBeenCalledTimes(1);
    expect(runById(run.id)!.retries).toBeUndefined();
    expect(toasts().at(-1)).toMatch(/\(the supplementary package of run #1\): retry the failed requests once it has been downloaded/);
    endBackground();
    await store.retryFailed(run.id);
    expect(p.submit).toHaveBeenCalledTimes(2);
  });

  it('batch results are not collected meanwhile: quiet checks skip the study, Check says why', async () => {
    const ids = await freshStudy(3);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    await store.startRun({ docIds: ids, scope: 'all' });
    const run = lastRun();
    p.finishAll();
    startBackground('backup', 'study backup', studyRef());
    await store.checkBatch(run.id, true);
    expect(p.check).not.toHaveBeenCalled();
    expect((await dbApi.getResultsForRun(run.id)).length).toBe(0);
    const before = toasts().length;
    await store.checkBatch(run.id);
    expect(p.check).not.toHaveBeenCalled();
    expect(toasts().slice(before)).toEqual([expect.stringMatching(/\(the study backup\): check the batch once it has been downloaded/)]);
    endBackground();
    await store.checkBatch(run.id, true);
    expect((await dbApi.getResultsForRun(run.id)).length).toBe(3);
    expect(runById(run.id)!.status).toBe('completed');
  });

  it('a download waits for a batch check of its study already under way', async () => {
    const ids = await freshStudy(3);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    await store.startRun({ docIds: ids, scope: 'all' });
    const run = lastRun();
    p.finishAll();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const fetchResults = p.fetch.getMockImplementation()!;
    p.fetch.mockImplementation(async (...a) => (await held, fetchResults(...a)));
    const check = store.checkBatch(run.id, true);
    await tick();
    let waited = false;
    const ready = store.batchChecksDone(run.studyId).then(() => (waited = true));
    await tick();
    expect(waited).toBe(false);
    release();
    await check;
    await ready;
    // (What the download then reads is the collected run.)
    expect(runById(run.id)!.status).toBe('completed');
    expect(store.getState().results.filter((r) => r.runId === run.id).length).toBe(3);
  });
});

// ---------- gap: a quiet batch check racing a delete (verify6 gap #2, verify7 gaps) ----------

describe('a batch check and deleting its run exclude each other: nothing is left under a deleted run', () => {
  it('whichever comes first, and however they interleave', async () => {
    const orphans: string[] = [];
    for (const checkFirst of [true, false])
      for (let k = 0; k <= 12; k++) {
        const ids = await freshStudy(3);
        batchStudy();
        const p = fakeBatches(anthropicAdapter);
        await store.startRun({ docIds: ids, scope: 'all' });
        const runId = lastRun().id;
        p.finishAll();
        const first = checkFirst ? store.checkBatch(runId, true) : store.removeRun(runId);
        for (let i = 0; i < k; i++) await tick();
        const second = checkFirst ? store.removeRun(runId) : store.checkBatch(runId, true);
        await Promise.all([first, second]);
        await new Promise((r) => setTimeout(r, 20));
        const stored = await dbApi.getRun(runId);
        const results = (await dbApi.getResultsForRun(runId)).length;
        const logs = (await dbApi.getLogsForRun(runId)).length;
        if (stored || results || logs || runById(runId)) orphans.push(`${checkFirst ? 'check' : 'delete'} first, ${k} ticks: run ${!!stored}, ${results} results, ${logs} logs`);
        vi.restoreAllMocks();
      }
    expect(orphans).toEqual([]);
  }, 60_000);

  it('deleting the study waits for a check of its runs under way, and nothing is left (review)', async () => {
    const ids = await freshStudy(3);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    await store.startRun({ docIds: ids, scope: 'all' });
    const run = lastRun();
    p.finishAll();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const fetchResults = p.fetch.getMockImplementation()!;
    p.fetch.mockImplementation(async (...a) => (await held, fetchResults(...a)));
    const check = store.checkBatch(run.id, true);
    await tick();
    let over = false;
    const removing = store.removeStudy(run.studyId).then(() => (over = true));
    for (let i = 0; i < 20; i++) await tick();
    expect(over).toBe(false);
    expect(toasts()).toContain('Batch results of this study are being collected: the study is deleted once that is done.');
    expect((await dbApi.listStudies()).map((s) => s.id)).toContain(run.studyId);
    release();
    await Promise.all([check, removing]);
    expect((await dbApi.listStudies()).map((s) => s.id)).not.toContain(run.studyId);
    expect(await dbApi.getRun(run.id)).toBeUndefined();
    expect((await dbApi.getResultsForRun(run.id)).length).toBe(0);
    expect((await dbApi.getLogsForRun(run.id)).length).toBe(0);
  });
});

// ---------- M18 ----------

describe('Retry failed’s question about a lost one-request upload (M18)', () => {
  it('says “1 request”', async () => {
    const ids = await freshStudy(1);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    // The upload gets no answer, and the provider has no batch for it.
    p.uploads(() => connectionError());
    await store.startRun({ docIds: ids, scope: 'all' });
    const run = lastRun();
    expect(run.batch?.uploadUnknown?.requests).toBe(1);
    (globalThis as Record<string, unknown>).confirm = (m: string) => (confirms.push(m), false);
    await store.retryFailed(run.id);
    expect(confirms.at(-1)).toMatch(/No batch from the upload of .* \(1 request\) was found at Anthropic/);
  });
});
