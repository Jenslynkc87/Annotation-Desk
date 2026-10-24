// Tests for the fourth round of fixes (lookups of lost uploads, deletes, retries, the tab lock), after the fourth
// verification of October 23, 2026. Providers are stubbed: nothing is sent anywhere (any request that does reach
// `fetch` fails the test, except the adapters' own listing tests, which answer from a stub).
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dbApi from './db';
import { buildBackup, importBackup } from './export/backup';
import { anthropicAdapter } from './providers/anthropic';
import { openaiAdapter } from './providers/openai';
import type { BatchItem, CallOutcome, ListedBatch, ProviderAdapter } from './providers/types';
import * as store from './store';
import { tabLock } from './tabLock';
import type { PromptSpec, Result, Run } from './types';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const outcome = (rawText: string, stopReason = 'end_turn'): CallOutcome => ({ rawText, reasoningSummary: '', usage, responseId: `id_${Math.random()}`, modelReported: 'm', stopReason, response: {} });
const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });
const connectionError = () => new Error('Connection error.');
const quotaError = () => Object.assign(new Error(''), { name: 'QuotaExceededError' });

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
let answer: boolean | ((m: string) => boolean) = true;
beforeEach(() => {
  confirms.length = 0;
  answer = true;
  (globalThis as Record<string, unknown>).confirm = (m: string) => (confirms.push(m), typeof answer === 'function' ? answer(m) : answer);
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('fetch', async (u: unknown) => {
    throw new Error(`unexpected request: ${String(u)}`);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Nothing of an earlier test stays in the database (the stubs number their batches b1, b2, … in every test). */
async function emptyDatabase() {
  for (const s of await dbApi.listStudies()) await dbApi.deleteStudy(s.id);
}

let studies = 0;
async function freshStudy(n: number, setup: (p: PromptSpec) => void = () => {}) {
  await emptyDatabase();
  await store.createStudy(`Study ${++studies}`);
  store.setKey('anthropic', 'sk-ant-test');
  store.setKey('openai', 'sk-test');
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
const runById = (id: string) => store.getState().runs.find((r) => r.id === id)!;
const toasts = () => store.getState().toasts.map((t) => t.text);
const partIds = (r: Run) => store.batchParts(r).map((p) => p.batchId);
const batchStudy = () => store.updateStudy((s) => void (s.options.batch = true));
/** A later upload's time: never the same millisecond as the run's first upload (which would make it that one). */
const laterUpload = () => new Date(Date.now() + 1000).toISOString();
const openaiBatchStudy = () =>
  store.updateStudy((s) => {
    s.options.batch = true;
    s.model.provider = 'openai';
    s.model.model = 'gpt-6.1-sol';
  });

/**
 * A provider's batches, as a stub of the adapter: uploads (which can be refused, or arrive without an answer coming
 * back), listing (cancelled batches marked as the providers list them), checking, results, cancelling.
 */
function fakeBatches(adapter: ProviderAdapter) {
  type Made = { id: string; items: BatchItem[]; at: string; done: boolean; cancelled: boolean; file?: string; metadata?: Record<string, string> };
  const made: Made[] = [];
  let upload: (n: number) => 'ok' | 'lost' | Error = () => 'ok';
  const submit = vi.spyOn(adapter, 'submitBatch').mockImplementation(async (_k, _b, items, opts) => {
    const how = upload(made.length + 1);
    if (how instanceof Error) throw how;
    const id = `b${made.length + 1}`;
    const file = adapter.id === 'openai' ? `file-${made.length + 1}` : undefined;
    if (file) await opts?.onFile?.(file);
    // (Only OpenAI keeps the metadata a batch is created with.)
    made.push({ id, items, at: new Date().toISOString(), done: false, cancelled: false, file, metadata: adapter.id === 'openai' ? opts?.metadata : undefined });
    // (The provider created it, but its answer never arrived.)
    if (how === 'lost') throw Object.assign(connectionError(), file ? { inputFileId: file } : {});
    return { batchId: id, inputFileId: file };
  });
  const list = vi.spyOn(adapter, 'listRecentBatches').mockImplementation(async () =>
    made
      .map((b): ListedBatch => ({ batchId: b.id, createdAt: b.at, requests: b.items.length, inputFileId: b.file, metadata: b.metadata, ...(b.cancelled ? { stopped: true } : {}) }))
      .reverse(),
  );
  const check = vi.spyOn(adapter, 'checkBatch').mockImplementation(async (_k, id) => {
    const b = made.find((x) => x.id === id);
    return { status: b?.done ? 'ended' : 'in_progress', done: !!b?.done, total: b?.items.length ?? 0, completed: 0, failed: 0, endedAt: b?.done ? new Date().toISOString() : undefined };
  });
  const fetch = vi.spyOn(adapter, 'fetchBatchResults').mockImplementation(async (_k, id) => {
    const b = made.find((x) => x.id === id)!;
    return b.items.map((it) => (b.cancelled ? { customId: it.customId, ok: false as const, error: 'Request canceled' } : { customId: it.customId, ok: true as const, outcome: { ...outcome(`answer ${it.customId} of ${id}`), responseId: `${id}_${it.customId}` } }));
  });
  const cancel = vi.spyOn(adapter, 'cancelBatch').mockImplementation(async (_k, id) => {
    const b = made.find((x) => x.id === id);
    if (b) [b.cancelled, b.done] = [true, true];
  });
  return { made, submit, list, check, fetch, cancel, uploads: (f: (n: number) => 'ok' | 'lost' | Error) => (upload = f), finishAll: () => made.forEach((b) => (b.done = true)) };
}

/** A copy of the open study, imported from its backup into this browser (as Studies → Import study backup does). */
async function backupCopy() {
  const s = store.getState();
  const copy = await importBackup(await buildBackup(store.currentStudy()!, s.docs, s.runs, false));
  await store.refreshStudies();
  return copy;
}

// ---------- 1. looking up a lost upload ----------

describe('a lost upload is never matched to a batch this browser knows (G3, G7)', () => {
  it('not the cancelled batch of a run deleted moments before, run again with a corrected prompt', async () => {
    const ids = await freshStudy(3);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    await store.startRun({ docIds: ids, scope: 'all' });
    const a = lastRun();
    // Deleted (its batch is cancelled), as the Runs view does it.
    await store.removeRun(a.id);
    expect(p.cancel).toHaveBeenCalledWith('sk-ant-test', 'b1');
    // The provider doesn't list it as cancelled yet: only this browser's record of deleted runs keeps it out.
    p.made[0].cancelled = false;
    store.updateStudy((s) => void (s.prompt.userTemplate = 'Rate it (corrected).'));
    p.uploads(() => connectionError());
    await store.startRun({ docIds: ids, scope: 'all' });
    const b = lastRun();
    expect(partIds(b)).toEqual([]);
    expect(b.batch?.uploadUnknown).toBeTruthy();
    answer = false;
    await store.retryFailed(b.id);
    expect(partIds(runById(b.id))).toEqual([]);
    expect(confirms.at(-1)).toMatch(/^No batch from the upload of/);
    // Nor does deleting it cancel that batch again.
    p.cancel.mockClear();
    answer = true;
    await store.removeRun(b.id);
    expect(p.cancel).not.toHaveBeenCalled();
  });

  it('not a batch the provider lists as cancelled, also when this browser keeps no record (storage unavailable)', async () => {
    vi.stubGlobal('localStorage', undefined);
    const ids = await freshStudy(3);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    await store.startRun({ docIds: ids, scope: 'all' });
    await store.removeRun(lastRun().id);
    p.uploads(() => connectionError());
    await store.startRun({ docIds: ids, scope: 'all' });
    expect(partIds(lastRun())).toEqual([]);
    expect(lastRun().batch?.uploadUnknown).toBeTruthy();
  });

  it('not the collected batch of a deleted run', async () => {
    const ids = await freshStudy(3);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    await store.startRun({ docIds: ids, scope: 'all' });
    p.finishAll();
    await store.checkBatch(lastRun().id);
    expect(lastRun().status).toBe('completed');
    await store.removeRun(lastRun().id);
    p.uploads(() => connectionError());
    await store.startRun({ docIds: ids, scope: 'all' });
    expect(partIds(lastRun())).toEqual([]);
  });

  it('not a batch this page uploaded for another run whose record could not be saved after it', async () => {
    const ids = await freshStudy(3);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    // Run Y: its upload never arrived, and the provider couldn't be asked.
    p.uploads(() => connectionError());
    p.list.mockRejectedValueOnce(connectionError());
    await store.startRun({ docIds: ids, scope: 'all' });
    const y = lastRun();
    expect(y.batch?.uploadUnknown).toBeTruthy();
    // Run X, another prompt on the same texts: its batch goes up, but the save right after it fails.
    p.uploads(() => 'ok');
    store.updateStudy((s) => void (s.prompt.userTemplate = 'Is it about sport?'));
    const real = dbApi.putRun;
    let saves = 0;
    const put = vi.spyOn(dbApi, 'putRun').mockImplementation(async (r) => {
      if (++saves === 2) throw quotaError();
      return real(r);
    });
    await store.startRun({ docIds: ids, scope: 'all' });
    put.mockRestore();
    const x = lastRun();
    expect([partIds(x), (await dbApi.getRun(x.id))!.batch?.parts]).toEqual([['b1'], []]);
    // Retry failed on Y: X's batch is not Y's.
    answer = false;
    await store.retryFailed(y.id);
    expect(partIds(runById(y.id))).toEqual([]);
    expect(confirms.at(-1)).toMatch(/^No batch from the upload of/);
    // Nor is it cancelled when Y is deleted.
    answer = true;
    await store.removeRun(y.id);
    expect(p.cancel).not.toHaveBeenCalled();
    expect(partIds(runById(x.id))).toEqual(['b1']);
  });
});

describe('clock differences between this computer and the provider (gap)', () => {
  async function lost(skewMinutes: number) {
    const ids = await freshStudy(3);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    p.uploads(() => 'lost');
    p.list.mockRejectedValueOnce(connectionError());
    await store.startRun({ docIds: ids, scope: 'all' });
    // The provider's clock is ahead (or behind) by this much.
    p.made[0].at = new Date(Date.parse(p.made[0].at) + skewMinutes * 60_000).toISOString();
    await store.retryFailed(lastRun().id);
    return { p, run: lastRun() };
  }
  it('finds the batch with the provider’s clock up to 10 minutes ahead', async () => {
    for (const skew of [6, 9]) {
      const { p, run } = await lost(skew);
      expect(partIds(run)).toEqual(['b1']);
      expect(p.submit).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    }
  });
  it('the adapters list batches created up to 10 minutes before the upload began', async () => {
    const since = '2026-10-23T12:00:00.000Z';
    const at = (min: number) => new Date(Date.parse(since) + min * 60_000);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.hostname !== '127.0.0.1') throw new Error(`unexpected request: ${url.href}`);
      if (url.pathname === '/v1/messages/batches') {
        const b = (id: string, min: number, cancelled = false) => ({
          id, type: 'message_batch', processing_status: cancelled ? 'canceling' : 'in_progress', created_at: at(min).toISOString(), cancel_initiated_at: cancelled ? at(min + 1).toISOString() : null,
          ended_at: null, expires_at: at(min + 1440).toISOString(), archived_at: null, results_url: null, request_counts: { processing: 3, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
        });
        return json({ data: [b('msgbatch_a', 1), b('msgbatch_b', -9, true), b('msgbatch_c', -11)], has_more: false, first_id: 'msgbatch_a', last_id: 'msgbatch_c' });
      }
      if (url.pathname === '/v1/batches') {
        const b = (id: string, min: number, status: string) => ({ id, object: 'batch', endpoint: '/v1/responses', status, input_file_id: 'file-x', completion_window: '24h', created_at: Math.floor(at(min).getTime() / 1000), request_counts: { total: 3, completed: 0, failed: 0 }, metadata: null });
        return json({ object: 'list', data: [b('batch_a', 1, 'in_progress'), b('batch_b', -9, 'cancelled'), b('batch_c', -11, 'in_progress')], has_more: false });
      }
      throw new Error(`unexpected request: ${url.href}`);
    });
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:9');
    vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:9/v1');
    const a = await anthropicAdapter.listRecentBatches('sk-ant-test', since);
    expect(a.map((b) => [b.batchId, !!b.stopped])).toEqual([['msgbatch_a', false], ['msgbatch_b', true]]);
    const o = await openaiAdapter.listRecentBatches('sk-test', since);
    expect(o.map((b) => [b.batchId, !!b.stopped])).toEqual([['batch_a', false], ['batch_b', true]]);
  });
});

// ---------- 2. backup copies in this browser that share an upload of unknown outcome ----------

describe('a study and its backup copy that share an upload of unknown outcome (G11, G14, G20, G21, G40)', () => {
  async function sharedLostUpload(p: 'anthropic' | 'openai' = 'anthropic') {
    const ids = await freshStudy(3);
    if (p === 'openai') openaiBatchStudy();
    else batchStudy();
    const fake = fakeBatches(p === 'openai' ? openaiAdapter : anthropicAdapter);
    // The upload reaches the provider (b1), but its answer is lost and the provider can't be asked at that moment.
    fake.uploads(() => 'lost');
    fake.list.mockRejectedValueOnce(connectionError());
    await store.startRun({ docIds: ids, scope: 'all' });
    const original = { study: store.currentStudy()!, run: lastRun() };
    expect(original.run.batch?.uploadUnknown).toBeTruthy();
    fake.uploads(() => 'ok');
    const study = await backupCopy();
    await store.selectStudy(study.id);
    return { fake, original, copy: { study, run: lastRun() } };
  }

  for (const p of ['anthropic', 'openai'] as const) {
    it(`Retry failed in both collects the one batch in both, never a second paid batch (${p})`, async () => {
      const { fake, original, copy } = await sharedLostUpload(p);
      await store.retryFailed(copy.run.id);
      expect(partIds(lastRun())).toEqual(['b1']);
      await store.selectStudy(original.study.id);
      await store.retryFailed(original.run.id);
      expect(confirms).toEqual([]);
      expect(fake.submit).toHaveBeenCalledTimes(1);
      expect(partIds(lastRun())).toEqual(['b1']);
      expect(toasts().at(-1)).toContain(`“${copy.study.name}”`);
      // Both collect it.
      fake.finishAll();
      await store.checkBatch(original.run.id);
      expect([lastRun().status, store.getState().results.filter((r) => r.status === 'ok').length]).toEqual(['completed', 3]);
    });
  }

  it('deleting the copy’s run leaves the batch running for the original, which then finds it', async () => {
    const { fake, original, copy } = await sharedLostUpload();
    await store.removeRun(copy.run.id);
    expect(fake.cancel).not.toHaveBeenCalled();
    expect(toasts().at(-1)).toMatch(new RegExp(`left running for “${original.study.name}”`));
    await store.selectStudy(original.study.id);
    await store.retryFailed(original.run.id);
    expect(partIds(lastRun())).toEqual(['b1']);
    expect(fake.made[0].cancelled).toBe(false);
  });

  it('deleting the copy (the whole study) leaves it too; so does deleting the original', async () => {
    const { fake, original, copy } = await sharedLostUpload();
    await store.removeStudy(copy.study.id);
    expect(fake.cancel).not.toHaveBeenCalled();
    expect(store.getState().studies.some((s) => s.id === copy.study.id)).toBe(false);
    // The other way round: a second copy, then the original deleted.
    await store.selectStudy(original.study.id);
    const again = await backupCopy();
    await store.selectStudy(original.study.id);
    await store.removeStudy(original.study.id);
    expect(fake.cancel).not.toHaveBeenCalled();
    await store.selectStudy(again.id);
    await store.retryFailed(lastRun().id);
    expect(partIds(lastRun())).toEqual(['b1']);
  });

  it('a copy that has found the batch: deleting it leaves the batch to the original, still waiting for it', async () => {
    const { fake, original, copy } = await sharedLostUpload();
    await store.retryFailed(copy.run.id);
    expect(store.getState().runs.find((r) => r.id === copy.run.id)?.status).toBe('submitted');
    expect((await store.sharedBatches(lastRun())).get('b1')).toBe(original.study.name);
    await store.removeStudy(copy.study.id);
    expect(fake.cancel).not.toHaveBeenCalled();
    await store.selectStudy(original.study.id);
    await store.retryFailed(original.run.id);
    expect(partIds(lastRun())).toEqual(['b1']);
    expect(fake.submit).toHaveBeenCalledTimes(1);
  });

  it('the original that has found the batch: deleting the copy, still waiting, leaves it', async () => {
    const { fake, original, copy } = await sharedLostUpload();
    await store.selectStudy(original.study.id);
    await store.retryFailed(original.run.id);
    await store.selectStudy(copy.study.id);
    expect(await store.sharedUnknownUpload(lastRun())).toEqual([original.study.name]);
    await store.removeRun(copy.run.id);
    expect(fake.cancel).not.toHaveBeenCalled();
  });
});

// ---------- 3. deleting: every question before anything is cancelled ----------

describe('deleting asks every question before cancelling anything (G33)', () => {
  /** A batch run still processing (b1) that also has a later upload of unknown outcome (a split upload cut off). */
  async function processingWithUnknown() {
    const ids = await freshStudy(3);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    await store.startRun({ docIds: ids, scope: 'all' });
    const run = (await dbApi.getRun(lastRun().id))!;
    await dbApi.putRun({ ...run, error: 'cut off', batch: { ...run.batch!, uploadUnknown: { since: laterUpload(), requests: 2 } } });
    await store.selectStudy(store.currentStudy()!.id);
    return p;
  }
  it('a run kept at the question about its upload of unknown outcome keeps its processing batch', async () => {
    const p = await processingWithUnknown();
    p.list.mockRejectedValue(connectionError());
    answer = false;
    await store.removeRun(lastRun().id);
    expect(confirms.at(-1)).toMatch(/could not be looked up at Anthropic .*Delete run #\d+ anyway\?$/s);
    expect(p.cancel).not.toHaveBeenCalled();
    expect(lastRun().status).toBe('submitted');
  });
  it('a study kept at that question keeps every batch', async () => {
    const p = await processingWithUnknown();
    p.list.mockRejectedValue(connectionError());
    answer = false;
    const study = store.currentStudy()!.id;
    await store.removeStudy(study);
    expect(confirms.at(-1)).toMatch(/Delete the study anyway\?$/);
    expect(p.cancel).not.toHaveBeenCalled();
    expect(store.getState().studies.some((s) => s.id === study)).toBe(true);
  });
  it('a found batch is cancelled only once the run is surely deleted', async () => {
    const p = await processingWithUnknown();
    p.list.mockResolvedValue([{ batchId: 'b_lost', createdAt: new Date().toISOString(), requests: 2 }]);
    await store.removeRun(lastRun().id);
    expect(confirms).toEqual([]);
    expect(p.cancel.mock.calls.map((c) => c[1]).sort()).toEqual(['b1', 'b_lost']);
    expect(store.getState().runs).toEqual([]);
    expect(toasts().at(-1)).toContain('(b_lost) had reached the provider and was cancelled');
  });
  it('a cancel that fails is asked about, saying what was already cancelled', async () => {
    const ids = await freshStudy(3);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    await store.startRun({ docIds: ids.slice(0, 1), scope: 'one' });
    await store.startRun({ docIds: ids, scope: 'all' });
    p.cancel.mockImplementation(async (_k, id) => {
      if (id === 'b2') throw connectionError();
    });
    answer = false;
    const study = store.currentStudy()!.id;
    await store.removeStudy(study);
    expect(confirms.at(-1)).toMatch(/^Could not cancel a batch: .*b1 was cancelled already and stays cancelled if you keep the study\. Delete the study anyway\?/s);
    expect(store.getState().studies.some((s) => s.id === study)).toBe(true);
  });
});

// ---------- 4. a retry upload that fails keeps the earlier unknown upload ----------

describe('Retry failed after an upload of unknown outcome (G10)', () => {
  it('keeps that upload on record when the retry’s own upload is refused, so it is still looked for', async () => {
    const ids = await freshStudy(3);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    p.uploads(() => connectionError());
    await store.startRun({ docIds: ids, scope: 'all' });
    const runId = lastRun().id;
    const unknown = lastRun().batch!.uploadUnknown!;
    // Not found; the owner sends again, and that upload is refused.
    p.uploads(() => apiError(429, 'Too many requests'));
    await store.retryFailed(runId);
    expect(confirms.at(-1)).toMatch(/^No batch from the upload/);
    const stored = (await dbApi.getRun(runId))!;
    expect(stored.batch?.uploadUnknown).toEqual(unknown);
    expect(store.unknownUpload(runById(runId))).toEqual(unknown);
    const s = store.getState();
    expect(store.remainingDocs(store.currentStudy()!, s.docs, s.runs, s.results).unknown).toBe(3);
    // Later the first upload's batch turns up at the provider: found, nothing sent again.
    p.list.mockResolvedValue([{ batchId: 'b_late', createdAt: unknown.since, requests: 3 }]);
    p.submit.mockClear();
    await store.retryFailed(runId);
    expect(p.submit).not.toHaveBeenCalled();
    expect(partIds(runById(runId))).toEqual(['b_late']);
  });
});

// ---------- 5. an immediate retry that is stopped ----------

describe('an immediate Retry failed that is stopped (G13, G28)', () => {
  it('stopped with Cancel: counts every request it began to send, answered or not', async () => {
    const ids = await freshStudy(8);
    const send = vi.spyOn(anthropicAdapter, 'send').mockResolvedValue(outcome('', 'refusal'));
    await store.startRun({ docIds: ids, scope: 'all' });
    const runId = lastRun().id;
    // Two answers come back; four requests are still under way when Cancel is clicked.
    let n = 0;
    send.mockImplementation(async (_k, _b, _p, signal) => {
      if (++n <= 2) return outcome('fine');
      return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('Request was aborted.'))));
    });
    const retry = store.retryFailed(runId);
    await vi.waitFor(() => expect([n, store.getState().job?.done]).toEqual([6, 2]));
    store.cancelJob();
    await retry;
    expect(runById(runId).retries).toEqual([{ at: expect.any(String), requests: 6, counted: 'sent', unanswered: 4 }]);
    expect((await dbApi.getRun(runId))!.retries?.[0].requests).toBe(6);
  });

  it('stopped because a result could not be saved: the same', async () => {
    const ids = await freshStudy(8);
    const send = vi.spyOn(anthropicAdapter, 'send').mockResolvedValue(outcome('', 'refusal'));
    await store.startRun({ docIds: ids, scope: 'all' });
    const runId = lastRun().id;
    let n = 0;
    send.mockImplementation(async (_k, _b, _p, signal) => {
      if (++n <= 2) return outcome('fine');
      return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('Request was aborted.'))));
    });
    const real = dbApi.putResult;
    let puts = 0;
    vi.spyOn(dbApi, 'putResult').mockImplementation(async (...a) => {
      if (++puts === 2) throw quotaError();
      return real(...a);
    });
    await store.retryFailed(runId);
    // (Four had begun: the first answer was stored, the second could not be, two were still under way.)
    expect(runById(runId).retries).toEqual([{ at: expect.any(String), requests: 4, counted: 'sent', unanswered: 3 }]);
  });

  it('interrupted by a closed page before any answer: still on record, as at least none', async () => {
    const ids = await freshStudy(2);
    vi.spyOn(anthropicAdapter, 'send').mockResolvedValue(outcome('', 'refusal'));
    await store.startRun({ docIds: ids, scope: 'all' });
    const run = (await dbApi.getRun(lastRun().id))!;
    const at = new Date(Date.now() + 1000).toISOString();
    await dbApi.putRun({ ...run, status: 'running', resumeStatus: 'completed', resumeError: null, retries: [{ at, requests: 0, counted: 'sent' }] });
    await store.selectStudy(store.currentStudy()!.id);
    expect(lastRun().retries).toEqual([{ at, requests: 0, counted: 'sent', interrupted: true }]);
  });
});

// ---------- 6. messages ----------

describe('a batch whose results were saved but whose run record could not be (G19)', () => {
  it('says the results were saved and only the run’s record was not', async () => {
    const ids = await freshStudy(2);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    await store.startRun({ docIds: ids, scope: 'all' });
    p.finishAll();
    vi.spyOn(dbApi, 'putRun').mockRejectedValue(quotaError());
    await store.checkBatch(lastRun().id);
    expect((await dbApi.getResultsForRun(lastRun().id)).length).toBe(2);
    const said = toasts().filter((t) => t.startsWith(`Batch run #${lastRun().number}:`));
    expect(said).toEqual([
      `Batch run #${lastRun().number}: its results were saved, but the run’s own record could not be saved, because this browser's storage is full; free disk space, or export a backup and delete old runs or studies. Then click Check now on the Workbench (Check under Runs & agreement).`,
    ]);
    expect(store.batchParts(lastRun()).map((x) => [x.lastStatus, !!x.saveFailed, x.resultsSaved])).toEqual([['ended; run record not saved', true, true]]);
  });
});

// ---------- 7. runs of the published version ----------

describe('runs the published version marked “Interrupted” (G31)', () => {
  const OLD = 'Interrupted (the page was closed or reloaded while running). Completed results were kept.';
  it('finish at their last answer (in this page; the stored record is left as it is)', async () => {
    const ids = await freshStudy(2);
    vi.spyOn(anthropicAdapter, 'send').mockResolvedValue(outcome('fine'));
    await store.startRun({ docIds: ids, scope: 'all' });
    const run = (await dbApi.getRun(lastRun().id))!;
    const results = await dbApi.getResultsForRun(run.id);
    const last = '2026-10-20T12:00:00.000Z';
    await dbApi.putResult({ ...results[0], requestedAt: '2026-10-20T11:59:00.000Z', completedAt: last }, null);
    await dbApi.putResult({ ...results[1], requestedAt: '2026-10-20T10:59:00.000Z', completedAt: '2026-10-20T11:00:00.000Z' }, null);
    // Opened again in the published version a day later.
    const reopened = '2026-10-21T09:00:00.000Z';
    await dbApi.putRun({ ...run, status: 'cancelled', error: OLD, finishedAt: reopened, snapshot: { ...run.snapshot, appVersion: '0.1.0' } });
    await store.selectStudy(store.currentStudy()!.id);
    expect(lastRun().finishedAt).toBe(last);
    expect((await dbApi.getRun(run.id))!.finishedAt).toBe(reopened);
    // A retry interrupted there kept the time before it, earlier than its answers.
    await dbApi.putResult({ ...results[1], requestedAt: '2026-10-22T08:00:00.000Z', completedAt: '2026-10-22T08:01:00.000Z', responseId: 'again' }, null);
    await dbApi.putRun({ ...run, status: 'cancelled', error: OLD, finishedAt: last, retries: [{ at: '2026-10-22T08:00:00.000Z', requests: 1 }], snapshot: { ...run.snapshot, appVersion: '0.1.0' } });
    await store.selectStudy(store.currentStudy()!.id);
    expect(lastRun().finishedAt).toBe('2026-10-22T08:01:00.000Z');
  });
});

describe('a run an open tab of the published version may still be sending (gap)', () => {
  async function leftRunning(appVersion: string, answeredAgo: number, extra: Partial<Run> = {}) {
    const ids = await freshStudy(2);
    vi.spyOn(anthropicAdapter, 'send').mockResolvedValue(outcome('fine'));
    await store.startRun({ docIds: ids, scope: 'all' });
    const run = (await dbApi.getRun(lastRun().id))!;
    for (const r of await dbApi.getResultsForRun(run.id)) await dbApi.putResult({ ...r, completedAt: new Date(Date.now() - answeredAgo).toISOString() }, null);
    await dbApi.putRun({ ...run, status: 'running', finishedAt: null, createdAt: new Date(Date.now() - answeredAgo - 60_000).toISOString(), snapshot: { ...run.snapshot, appVersion }, ...extra });
    const before = toasts().length;
    await store.selectStudy(store.currentStudy()!.id);
    return { run: lastRun(), said: toasts().slice(before) };
  }
  it('is marked interrupted, with a warning to close that tab first', async () => {
    const { run, said } = await leftRunning('0.1.0', 30_000);
    expect(run.status).toBe('cancelled');
    expect(said).toEqual([
      `Run #${run.number} was still marked as running, and it was being sent less than 2 minutes ago. If a tab with an earlier version of Annotation Desk is still open, it may still be sending it: close that tab before going on (Remaining or Retry failed here would send its texts again).`,
    ]);
    expect(store.getState().toasts.at(-1)?.kind).toBe('error');
  });
  it('also for a retry the published version was sending', async () => {
    const { said } = await leftRunning('0.1.0+abc1234 (2026-10-23)', 30_000, { retries: [{ at: new Date(Date.now() - 60_000).toISOString(), requests: 2 }] });
    expect(said.some((t) => t.includes('earlier version'))).toBe(true);
  });
  it('not for a run of this version (a closed or reloaded tab), nor one whose last answer is older', async () => {
    expect((await leftRunning('0.1.0+abc1234 (2026-10-23)', 30_000)).said.some((t) => t.includes('earlier version'))).toBe(false);
    expect((await leftRunning('0.1.0', 600_000)).said.some((t) => t.includes('earlier version'))).toBe(false);
  });
});

// ---------- 8. adding texts and entries ----------

describe('one table listing two entries with the same name and details (G9)', () => {
  it('adds both (the second with a suffix), each with its own other columns', async () => {
    await emptyDatabase();
    await store.createStudy('Entries', 'entries');
    const text = (name: string, country: string) => `name: ${name}\ncountry: ${country}`;
    const rows = [
      { docId: 'Niels Bohr', text: text('Niels Bohr', 'Denmark'), meta: { name: 'Niels Bohr', country: 'Denmark', my_fame: '3' }, source: 'pasted' },
      { docId: 'John Smith', text: text('John Smith', 'UK'), meta: { name: 'John Smith', country: 'UK', my_fame: '1' }, source: 'pasted' },
      { docId: 'John Smith', text: text('John Smith', 'UK'), meta: { name: 'John Smith', country: 'UK', my_fame: '3' }, source: 'pasted' },
    ];
    await store.addDocs(rows);
    expect(store.getState().docs.map((d) => [d.docId, d.meta.my_fame])).toEqual([['Niels Bohr', '3'], ['John Smith', '1'], ['John Smith_2', '3']]);
    expect(toasts().some((t) => t.includes('already in this study'))).toBe(false);
    // The same table again: nothing is added twice.
    await store.addDocs(rows);
    expect(store.getState().docs).toHaveLength(3);
    expect(toasts().at(-1)).toBe('Skipped 3 entries already in this study (same name and identical details).');
  });
});

// ---------- 9. replaced attempts keep their request times ----------

describe('a result that replaces earlier attempts (G22)', () => {
  it('keeps when each of them was sent', async () => {
    const ids = await freshStudy(1);
    const send = vi.spyOn(anthropicAdapter, 'send').mockResolvedValue(outcome('', 'refusal'));
    await store.startRun({ docIds: ids, scope: 'all' });
    const first = store.getState().results[0].requestedAt;
    await new Promise((r) => setTimeout(r, 5));
    await store.retryFailed(lastRun().id);
    const second = store.getState().results.find((r) => r.runId === lastRun().id)!.requestedAt;
    send.mockResolvedValue(outcome('fine'));
    await new Promise((r) => setTimeout(r, 5));
    await store.retryFailed(lastRun().id);
    const [result] = await dbApi.getResultsForRun(lastRun().id);
    expect([result.attempt, result.replacedAt]).toEqual([3, [first, second]]);
    // The same answer stored again (batch results collected twice) is no new attempt.
    await dbApi.putResult({ ...result }, null);
    expect((await dbApi.getResultsForRun(lastRun().id))[0].replacedAt).toEqual([first, second]);
  });
  it('from a version that did not keep them: only those replaced from now on', async () => {
    const ids = await freshStudy(1);
    vi.spyOn(anthropicAdapter, 'send').mockResolvedValue(outcome('', 'refusal'));
    await store.startRun({ docIds: ids, scope: 'all' });
    const [r] = await dbApi.getResultsForRun(lastRun().id);
    // As a version before October 23, 2026 stored a second attempt.
    await dbApi.putMany('results', [{ ...r, attempt: 2, replacedUsage: usage, requestedAt: '2026-10-20T10:00:00.000Z', responseId: 'old' } as Result]);
    await dbApi.putResult({ ...r, requestedAt: '2026-10-21T10:00:00.000Z', responseId: 'new' }, null);
    const now = (await dbApi.getResultsForRun(lastRun().id))[0];
    expect([now.attempt, now.replacedAt]).toEqual([3, ['2026-10-20T10:00:00.000Z']]);
  });
});

// ---------- 10. the tab lock at page load ----------

describe('the tab lock right after the page loads (G25)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  function setup(focused: boolean) {
    const locks = {
      holder: 'other' as 'me' | 'other' | null,
      requests: 0,
      request(name: string, _opts: LockOptions, cb: (lock: Lock | null) => unknown) {
        locks.requests++;
        return new Promise((resolve) =>
          setTimeout(() => {
            if (locks.holder) return void Promise.resolve(cb(null)).then(resolve);
            locks.holder = 'me';
            void Promise.resolve(cb({ name, mode: 'exclusive' } as Lock)).then(resolve);
          }, 1),
        );
      },
    };
    const state = { started: 0, otherTab: false };
    const ask = tabLock(locks as unknown as Pick<LockManager, 'request'>, () => void state.started++, (o) => void (state.otherTab = o), () => focused);
    return { locks, state, ask };
  }
  it('a page loaded in place of the app’s own page (another address) takes over once the old page lets go, without the focus', async () => {
    const { locks, state, ask } = setup(false);
    void ask();
    await vi.advanceTimersByTimeAsync(20);
    expect(state.otherTab).toBe(true);
    locks.holder = null; // the old page of this tab is gone
    await vi.advanceTimersByTimeAsync(600);
    expect([state.started, state.otherTab]).toEqual([1, false]);
  });
  it('asks a few times at most after loading, then only when the user turns to it', async () => {
    const { locks, state, ask } = setup(false);
    void ask();
    await vi.advanceTimersByTimeAsync(60_000);
    expect([locks.requests, state.started]).toEqual([4, 0]);
    // The working tab reloads later: the lock is free for a moment; this tab doesn't take it.
    locks.holder = null;
    await vi.advanceTimersByTimeAsync(80);
    locks.holder = 'other';
    await vi.advanceTimersByTimeAsync(10_000);
    expect([locks.requests, state.started]).toEqual([4, 0]);
  });
});

// ---------- 11. found in review ----------

describe('review of the fourth round', () => {
  it('a run kept after a delete cancelled its lost upload’s batch: Retry failed never says no batch was found', async () => {
    const ids = await freshStudy(3);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    // A batch still processing (b1), and a later upload of unknown outcome whose batch did arrive (b2).
    await store.startRun({ docIds: ids.slice(0, 1), scope: 'one' });
    const runId = lastRun().id;
    const run = (await dbApi.getRun(runId))!;
    await dbApi.putRun({ ...run, error: 'cut off', batch: { ...run.batch!, uploadUnknown: { since: laterUpload(), requests: 2 } } });
    p.made.push({ id: 'b2', items: [{ customId: 'x0', part: {} }, { customId: 'x1', part: {} }], at: new Date().toISOString(), done: false, cancelled: false });
    await store.selectStudy(store.currentStudy()!.id);
    // b2 is found and cancelled; b1 can't be cancelled, and the owner keeps the run.
    p.cancel.mockImplementation(async (_k, id) => {
      if (id === 'b1') throw connectionError();
      p.made.find((b) => b.id === id)!.cancelled = true;
    });
    answer = false;
    await store.removeRun(runId);
    expect(confirms.at(-1)).toMatch(/b2 was cancelled already and stays cancelled if you keep the run/);
    expect(runById(runId)).toBeTruthy();
    // Later, with b1 collected: b2 is not taken by its count (cancelled), but not said to be absent either.
    p.made[0].done = true;
    await store.checkBatch(runId);
    confirms.length = 0;
    await store.retryFailed(runId);
    expect(confirms[0]).toMatch(/could not be looked up at Anthropic \(Claude\) \(a batch there with the same number of requests \(b2\) was cancelled or expired/);
    expect(confirms[0]).not.toMatch(/No batch/);
    expect(p.submit).toHaveBeenCalledTimes(1);
    // Deleting it then asks nothing more about that upload: nothing there runs on.
    confirms.length = 0;
    answer = true;
    p.cancel.mockClear();
    await store.removeRun(runId);
    expect([confirms, p.cancel.mock.calls.length, store.getState().runs.length]).toEqual([[], 0, 0]);
  });

  it('a run whose deletion failed still finds its own upload’s batch afterwards', async () => {
    const ids = await freshStudy(3);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    p.uploads(() => 'lost');
    p.list.mockRejectedValueOnce(connectionError());
    await store.startRun({ docIds: ids, scope: 'all' });
    const runId = lastRun().id;
    // Its batch has ended: deleting asks, the owner says yes, but the run can't be deleted (storage).
    p.finishAll();
    vi.spyOn(dbApi, 'deleteRun').mockRejectedValueOnce(quotaError());
    await store.removeRun(runId);
    expect(confirms.at(-1)).toMatch(/did arrive \(b1\) and has already ended/);
    expect(runById(runId)).toBeTruthy();
    expect(toasts().some((t) => t.startsWith('The run was not deleted'))).toBe(true);
    await store.retryFailed(runId);
    expect(partIds(runById(runId))).toEqual(['b1']);
    expect(p.submit).toHaveBeenCalledTimes(1);
  });

  it('an old tab’s run that has no answer yet: the warning doesn’t speak of an answer', async () => {
    const ids = await freshStudy(2);
    vi.spyOn(anthropicAdapter, 'send').mockResolvedValue(outcome('fine'));
    await store.startRun({ docIds: ids, scope: 'all' });
    const run = (await dbApi.getRun(lastRun().id))!;
    await dbApi.putRun({ ...run, id: 'old-run', number: 9, status: 'running', finishedAt: null, createdAt: new Date(Date.now() - 20_000).toISOString(), snapshot: { ...run.snapshot, appVersion: '0.1.0' } });
    const before = toasts().length;
    await store.selectStudy(store.currentStudy()!.id);
    expect(toasts().slice(before)).toEqual([expect.stringMatching(/^Run #9 was still marked as running, and it was being sent less than 2 minutes ago\. /)]);
  });
});
