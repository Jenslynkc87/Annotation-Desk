// Tests for the third round of fixes (runs, batches, retries, storage), after the verification of October 23, 2026.
// Providers are stubbed: nothing is sent anywhere (any request that does reach `fetch` fails the test).
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dbApi from './db';
import { anthropicAdapter } from './providers/anthropic';
import { openaiAdapter } from './providers/openai';
import type { BatchItem, CallOutcome, ListedBatch } from './providers/types';
import * as store from './store';
import type { PromptSpec, Result, Run } from './types';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const outcome = (rawText: string, stopReason = 'end_turn'): CallOutcome => ({ rawText, reasoningSummary: '', usage, responseId: `id_${Math.random()}`, modelReported: 'm', stopReason, response: {} });
const apiError = (status: number, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { status, ...extra });
const connectionError = () => new Error('Connection error.');
const quotaError = () => Object.assign(new Error(''), { name: 'QuotaExceededError' });

const confirms: string[] = [];
let answer = true;
beforeEach(() => {
  confirms.length = 0;
  answer = true;
  (globalThis as Record<string, unknown>).confirm = (m: string) => (confirms.push(m), answer);
  // Nothing may leave the test.
  vi.stubGlobal('fetch', async (u: unknown) => {
    throw new Error(`unexpected request: ${String(u)}`);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function freshStudy(n: number, setup: (p: PromptSpec) => void = () => {}, name = 'Test') {
  await store.createStudy(name);
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

/** A provider's batches, as a stub of the adapter: uploads, listing, checking, results (all failed unless `ok`). */
function fakeBatches(adapter: typeof anthropicAdapter) {
  const made: { id: string; items: BatchItem[]; at: string; done: boolean }[] = [];
  let fail: (n: number) => Error | null = () => null;
  const submit = vi.spyOn(adapter, 'submitBatch').mockImplementation(async (_k, _b, items) => {
    const e = fail(made.length + 1);
    if (e) throw e;
    const id = `b${made.length + 1}`;
    made.push({ id, items, at: new Date().toISOString(), done: false });
    return { batchId: id };
  });
  const list = vi.spyOn(adapter, 'listRecentBatches').mockImplementation(async () => made.map((b): ListedBatch => ({ batchId: b.id, createdAt: b.at, requests: b.items.length })).reverse());
  vi.spyOn(adapter, 'checkBatch').mockImplementation(async (_k, id) => {
    const b = made.find((x) => x.id === id);
    return { status: b?.done ? 'ended' : 'in_progress', done: !!b?.done, total: b?.items.length ?? 0, completed: 0, failed: 0, endedAt: b?.done ? new Date().toISOString() : undefined };
  });
  // (The same answers, with the same ids, each time a batch's results are fetched.)
  const fetch = vi.spyOn(adapter, 'fetchBatchResults').mockImplementation(async (_k, id) =>
    made.find((b) => b.id === id)!.items.map((it) => ({ customId: it.customId, ok: true as const, outcome: { ...outcome('fine'), responseId: `${id}_${it.customId}` } })),
  );
  const cancel = vi.spyOn(adapter, 'cancelBatch').mockResolvedValue(undefined);
  return { made, submit, list, fetch, cancel, failUpload: (f: (n: number) => Error | null) => (fail = f), finishAll: () => made.forEach((b) => (b.done = true)) };
}

// ---------- 1. split retries ----------

describe('a batch retry sent as several batches', () => {
  it('adds a lost later upload, found by Retry failed, to the requests its first batch sent', async () => {
    // 2 texts × 50,001 annotations: 100,002 requests, over Anthropic's 100,000 per batch.
    const ids = await freshStudy(2);
    store.updateStudy((s) => {
      s.options.batch = true;
      s.options.replicates = 50_001;
    });
    const p = fakeBatches(anthropicAdapter);
    p.fetch.mockResolvedValue([]); // the first run's batches come back empty: every request is retried
    await store.startRun({ docIds: ids, scope: 'all' });
    const runId = lastRun().id;
    p.finishAll();
    await store.checkBatch(runId);
    expect(runById(runId).status).toBe('failed');
    // Retry failed: the first batch goes up, the second gets no answer and can't be found yet.
    p.failUpload((n) => (n === 4 ? connectionError() : null));
    p.list.mockResolvedValue([]);
    await store.retryFailed(runId);
    let run = runById(runId);
    expect(run.retries?.map((x) => x.requests)).toEqual([100_000]);
    expect(run.batch?.uploadUnknown).toMatchObject({ requests: 2, retryAt: run.retries![0].at });
    // Later Retry failed finds it at the provider: the retry is recorded with all it sent.
    p.list.mockResolvedValue([{ batchId: 'b_late', createdAt: new Date().toISOString(), requests: 2 }]);
    p.submit.mockClear();
    await store.retryFailed(runId);
    run = runById(runId);
    expect(p.submit).not.toHaveBeenCalled();
    expect(run.retries).toEqual([{ at: run.retries![0].at, requests: 100_002, asBatch: true, counted: 'sent' }]);
    expect((await dbApi.getRun(runId))!.retries?.[0].requests).toBe(100_002);
  }, 120_000);

  it('adds an upload cut off by a closed page, found after a reload, to the retry’s record', async () => {
    const ids = await freshStudy(3);
    store.updateStudy((s) => void (s.options.batch = true));
    const p = fakeBatches(anthropicAdapter);
    await store.startRun({ docIds: ids, scope: 'all' });
    const stored = (await dbApi.getRun(lastRun().id))!;
    // As a page closed during the second batch of a retry leaves it: its first batch (5 requests) recorded, the
    // second (3) marked as going up.
    const at = '2026-10-23T09:00:00.000Z';
    const since = '2026-10-23T09:00:05.000Z';
    await dbApi.putRun({ ...stored, retries: [{ at, requests: 5, asBatch: true, counted: 'sent' }], batch: { ...stored.batch!, uploading: { since, requests: 3, retryAt: at } } });
    await store.selectStudy(store.currentStudy()!.id);
    expect(lastRun().batch?.uploadUnknown?.retryAt).toBe(at);
    p.list.mockResolvedValue([{ batchId: 'b_after_reload', createdAt: since, requests: 3 }]);
    await store.retryFailed(lastRun().id);
    expect(lastRun().retries).toEqual([{ at, requests: 8, asBatch: true, counted: 'sent' }]);
  });
});

// ---------- failed saves around batch uploads ----------

describe('a batch that went up while the run could not be saved', () => {
  it('is recorded as a retry when it was one, and is not also an upload of unknown outcome', async () => {
    const ids = await freshStudy(4);
    store.updateStudy((s) => void (s.options.batch = true));
    const p = fakeBatches(anthropicAdapter);
    p.fetch.mockImplementation(async (_k, id) => p.made.find((b) => b.id === id)!.items.map((it, i) => ({ customId: it.customId, ok: true as const, outcome: i < 2 && id === 'b1' ? outcome('', 'refusal') : outcome('fine') })));
    await store.startRun({ docIds: ids, scope: 'all' });
    const runId = lastRun().id;
    p.finishAll();
    await store.checkBatch(runId);
    // The retry's batch goes up, but the save right after it fails (storage full).
    const real = dbApi.putRun;
    let saves = 0;
    const put = vi.spyOn(dbApi, 'putRun').mockImplementation(async (r) => {
      if (++saves === 2) throw quotaError();
      return real(r);
    });
    await store.retryFailed(runId);
    put.mockRestore();
    expect((await dbApi.getRun(runId))!.batch?.uploading).toBeTruthy();
    // The page stays open, space is freed: the next checks collect it.
    await store.checkBatch(runId, true);
    p.finishAll();
    await store.checkBatch(runId, true);
    const run = (await dbApi.getRun(runId))!;
    expect([run.status, run.error, run.batch?.uploadUnknown, run.batch?.uploading]).toEqual(['completed', null, undefined, undefined]);
    expect(run.retries?.map((x) => [x.requests, x.asBatch, x.counted])).toEqual([[2, true, 'sent']]);
    expect(toasts().some((t) => t.includes('may or may not'))).toBe(false);
  });

  it('whose results were stored but whose run could not be saved: not re-fetched by quiet checks, said once, and collected on Check', async () => {
    const ids = await freshStudy(2);
    store.updateStudy((s) => void (s.options.batch = true));
    const p = fakeBatches(anthropicAdapter);
    await store.startRun({ docIds: ids, scope: 'all' });
    const runId = lastRun().id;
    p.finishAll();
    const real = dbApi.putRun;
    let full = true;
    vi.spyOn(dbApi, 'putRun').mockImplementation(async (r) => {
      if (full) throw quotaError();
      return real(r);
    });
    const before = toasts().length;
    await store.checkBatch(runId, true);
    const shown = runById(runId);
    expect(shown.status).toBe('submitted');
    expect(store.batchParts(shown).map((x) => [x.status, !!x.saveFailed, x.lastStatus])).toEqual([['submitted', true, 'ended; results not saved']]);
    const said = toasts().slice(before);
    expect(said.some((t) => t.includes('finished'))).toBe(false);
    expect(said.filter((t) => t.includes('could not be saved'))).toHaveLength(1);
    // Quiet checks leave it alone (no new download, no new message).
    p.fetch.mockClear();
    await store.checkBatch(runId, true);
    expect(p.fetch).not.toHaveBeenCalled();
    expect(toasts().slice(before).filter((t) => t.includes('could not be saved'))).toHaveLength(1);
    // Space freed, Check: collected, and the answers are not stored twice.
    full = false;
    await store.checkBatch(runId);
    expect([runById(runId).status, (await dbApi.getRun(runId))!.status]).toEqual(['completed', 'completed']);
    expect((await dbApi.getResultsForRun(runId)).map((r) => r.attempt ?? 1)).toEqual([1, 1]);
  });
});

// ---------- 2. opening a study ----------

describe('opening a study', () => {
  it('groups a large run’s results in linear time', async () => {
    await store.createStudy('Large');
    const sid = store.currentStudy()!.id;
    const run = { ...(await (async () => {
      const ids = await freshStudy(1, () => {}, 'Large source');
      vi.spyOn(anthropicAdapter, 'send').mockResolvedValue(outcome('fine'));
      await store.startRun({ docIds: ids, scope: 'all' });
      return lastRun();
    })()), id: 'big', studyId: sid };
    await dbApi.putRun(run);
    const n = 30_000;
    const results: Result[] = Array.from({ length: n }, (_, i) => ({
      id: `big:d${i}:1`, runId: 'big', studyId: sid, docId: `d${i}`, replicate: 1, status: 'ok', values: { response: 'x' }, rationale: '', reasoningSummary: '', rawText: 'x',
      parseError: null, error: null, usage, latencyMs: 1, requestedAt: '2026-10-23T00:00:00.000Z', completedAt: '2026-10-23T00:00:01.000Z', responseId: `r${i}`, modelReported: 'm', stopReason: 'end_turn',
    }));
    await dbApi.putMany('results', results);
    const t0 = performance.now();
    await dbApi.loadStudyData(sid);
    const load = performance.now() - t0;
    const t1 = performance.now();
    await store.selectStudy(sid);
    const open = performance.now() - t1;
    // (Copying the run's list for every result took seconds here; now opening costs about as much as reading.)
    expect(open).toBeLessThan(load * 3 + 1000);
  }, 60_000);
});

// ---------- 3. deleting a run or study with an upload of unknown outcome ----------

describe('deleting a run whose batch upload has an unknown outcome', () => {
  async function unknownRun() {
    const ids = await freshStudy(3);
    store.updateStudy((s) => void (s.options.batch = true));
    const p = fakeBatches(anthropicAdapter);
    p.failUpload(() => connectionError());
    p.list.mockResolvedValue([]);
    await store.startRun({ docIds: ids, scope: 'all' });
    expect(lastRun().batch?.uploadUnknown).toBeTruthy();
    return p;
  }
  it('looks the batch up and cancels it when it did arrive', async () => {
    const p = await unknownRun();
    p.list.mockResolvedValue([{ batchId: 'b_arrived', createdAt: new Date().toISOString(), requests: 3 }]);
    expect(await store.cancelUnknownUpload(lastRun())).toEqual({ problem: '', cancelled: 'b_arrived' });
    expect(p.cancel).toHaveBeenCalledWith('sk-ant-test', 'b_arrived');
  });
  it('has nothing to ask when the provider surely has no such batch', async () => {
    const p = await unknownRun();
    expect(await store.cancelUnknownUpload(lastRun())).toEqual({ problem: '', cancelled: '' });
    expect(p.cancel).not.toHaveBeenCalled();
  });
  it('says so when the provider can’t be asked (no connection, no key), and the study is then kept unless the owner insists', async () => {
    const p = await unknownRun();
    p.list.mockRejectedValue(connectionError());
    const look = await store.cancelUnknownUpload(lastRun());
    expect(look.problem).toMatch(/could not be looked up at Anthropic/);
    store.setKey('anthropic', '');
    expect((await store.cancelUnknownUpload(lastRun())).problem).toMatch(/no Anthropic \(Claude\) API key is set/);
    const study = store.currentStudy()!.id;
    answer = false;
    await store.removeStudy(study);
    expect(confirms.at(-1)).toContain('check the provider');
    expect(store.getState().studies.some((s) => s.id === study)).toBe(true);
  });
  it('by request count, leaves out a batch created well after the upload got no answer (lead, round three)', async () => {
    const p = await unknownRun();
    expect(lastRun().batch?.uploadUnknown?.endedAt).toBeTruthy();
    // e.g. the exported annotate.py, run on the same texts an hour later: same number of requests, not this upload's.
    p.list.mockResolvedValue([{ batchId: 'b_later', createdAt: new Date(Date.now() + 3_600_000).toISOString(), requests: 3 }]);
    expect(await store.cancelUnknownUpload(lastRun())).toEqual({ problem: '', cancelled: '' });
    expect(p.cancel).not.toHaveBeenCalled();
  });
  it('is looked up when the study is deleted, and a found batch is cancelled', async () => {
    const p = await unknownRun();
    p.list.mockResolvedValue([{ batchId: 'b_arrived', createdAt: new Date().toISOString(), requests: 3 }]);
    const study = store.currentStudy()!.id;
    await store.removeStudy(study);
    expect(p.cancel).toHaveBeenCalledWith('sk-ant-test', 'b_arrived');
    expect(store.getState().studies.some((s) => s.id === study)).toBe(false);
    expect(toasts().some((t) => t.includes('(b_arrived) had reached the provider and was cancelled'))).toBe(true);
  });
});

// ---------- 4. Retry failed on such a run ----------

describe('Retry failed on a run with an upload of unknown outcome', () => {
  it('looks first, then asks before sending anything as a new batch', async () => {
    const ids = await freshStudy(3);
    store.updateStudy((s) => void (s.options.batch = true));
    const p = fakeBatches(anthropicAdapter);
    p.failUpload(() => connectionError());
    p.list.mockResolvedValue([]);
    await store.startRun({ docIds: ids, scope: 'all' });
    p.submit.mockClear();
    answer = false;
    await store.retryFailed(lastRun().id);
    expect(p.list).toHaveBeenCalled();
    expect(p.submit).not.toHaveBeenCalled();
    expect(confirms.at(-1)).toMatch(/^No batch from the upload of .* was found at Anthropic \(Claude\)\..*Send the 3 failed \(or never sent\) requests of run #\d+ again as a new batch/s);
  });
});

// ---------- 5. the early stop ----------

describe('the early stop', () => {
  const concurrency = 4;
  async function send(n: number, reps: number, fail: (text: string) => Error | null, retry = false) {
    const ids = await freshStudy(n);
    store.updateStudy((s) => void (s.options.replicates = reps));
    const s = vi.spyOn(anthropicAdapter, 'send');
    if (retry) {
      // A first run whose texts were all refused (nothing about the settings), then retried.
      s.mockImplementation(async () => outcome('', 'refusal'));
      await store.startRun({ docIds: ids, scope: 'all' });
    }
    s.mockClear();
    s.mockImplementation(async (_k, _b, part) => {
      const e = fail(JSON.stringify(part));
      if (e) throw e;
      return outcome('fine');
    });
    if (retry) await store.retryFailed(lastRun().id);
    else await store.startRun({ docIds: ids, scope: 'all' });
    return s.mock.calls.length;
  }
  const settings400 = () => apiError(400, 'max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens for claude-opus-5-5');
  it('never stops for one text whose replicates all fail with an unknown 400', async () => {
    expect(await send(5, 3, (part) => (part.includes('text 0') ? apiError(400, 'Something odd about this input') : null))).toBe(15);
    expect(lastRun().status).toBe('completed');
  });
  it('stops when three texts fail with the same 400, and quotes it', async () => {
    expect(await send(10, 3, () => settings400())).toBeLessThan(4 + 2 * concurrency);
    const run = lastRun();
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/^Stopped: the first \d+ requests all failed the same way, which points to the settings or the account rather than the texts: HTTP 400: max_tokens/);
  });
  it('ignores request ids when comparing messages, but goes on when the messages differ', async () => {
    let i = 0;
    expect(await send(10, 1, () => apiError(400, `Bad input (request_id: req_${(i++).toString(36)}abcdef)`))).toBeLessThan(10);
    let j = 0;
    expect(await send(10, 1, () => apiError(400, `Field ${j++} is wrong`))).toBe(10);
  });
  it('counts an exhausted account (OpenAI insufficient_quota, Anthropic credit balance), not a rate limit linking billing', async () => {
    expect(await send(10, 1, () => apiError(429, 'You exceeded your current quota.', { code: 'insufficient_quota', type: 'insufficient_quota' }))).toBeLessThan(10);
    expect(await send(10, 1, () => apiError(429, 'Your account is not active, please check your billing details on our website.', { code: 'billing_not_active', type: 'billing_not_active' }))).toBeLessThan(10);
    expect(await send(10, 1, () => apiError(400, 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'))).toBeLessThan(10);
    const limited = () => apiError(429, 'Rate limit reached for gpt-6.1-sol on requests per min (RPM): Limit 3. You can increase your rate limit by adding a payment method to your account at https://platform.openai.com/account/billing.', { code: 'rate_limit_exceeded', type: 'requests' });
    expect(await send(10, 1, limited)).toBe(10);
  });
  it('stops a retry the same way, and the run keeps a “stopped” explanation', async () => {
    expect(await send(10, 1, () => apiError(400, 'Your credit balance is too low to access the Anthropic API.'), true)).toBeLessThan(10);
    const run = lastRun();
    expect([run.status, run.error?.startsWith('Retry stopped: the first')]).toEqual(['completed', true]);
  });
  it('stops a retry after a settings stop whose settings are still wrong', async () => {
    const ids = await freshStudy(10);
    const s = vi.spyOn(anthropicAdapter, 'send').mockImplementation(async () => {
      throw settings400();
    });
    await store.startRun({ docIds: ids, scope: 'all' });
    expect(lastRun().status).toBe('failed');
    s.mockClear();
    await store.retryFailed(lastRun().id);
    expect(s.mock.calls.length).toBeLessThan(10);
    expect([lastRun().status, lastRun().error?.startsWith('Retry stopped:')]).toEqual(['failed', true]);
  });
});

// ---------- 6. OpenAI: finding a lost upload ----------

describe('OpenAI batch uploads', () => {
  /** A fake OpenAI API behind `fetch`: files, batches (the create can be made to get no answer), listing. */
  function fakeOpenAI(opts: { createFails?: boolean; listed?: () => Record<string, unknown>[] } = {}) {
    const calls: { method: string; path: string; body: unknown }[] = [];
    let storedAtCreate: Run | undefined;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = url.pathname.replace(/^\/v1/, '');
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ method, path, body });
      if (method === 'POST' && path === '/files') return json({ id: 'file-abc', object: 'file', bytes: 1, created_at: 0, filename: 'annotation-batch.jsonl', purpose: 'batch' });
      if (method === 'POST' && path === '/batches') {
        storedAtCreate = await dbApi.getRun(lastRun().id);
        if (opts.createFails) throw new TypeError('Failed to fetch');
        return json({ id: 'batch_new', object: 'batch', status: 'validating', input_file_id: 'file-abc', created_at: Math.floor(Date.now() / 1000), metadata: body?.metadata ?? null });
      }
      if (method === 'GET' && path === '/batches') return json({ object: 'list', data: opts.listed?.() ?? [], has_more: false });
      throw new Error(`unexpected request: ${method} ${url.href}`);
    });
    return { calls, storedAtCreate: () => storedAtCreate };
  }
  const openaiStudy = async (n = 2) => {
    const ids = await freshStudy(n);
    store.updateStudy((s) => {
      s.options.batch = true;
      s.model.provider = 'openai';
      s.model.model = 'gpt-6.1-sol';
    });
    return ids;
  };

  it('record the input file before the batch is started, and name the run and upload in its metadata', async () => {
    const ids = await openaiStudy();
    const api = fakeOpenAI();
    await store.startRun({ docIds: ids, scope: 'all' });
    const run = lastRun();
    expect(api.storedAtCreate()?.batch?.uploading).toMatchObject({ inputFileId: 'file-abc', labelled: true });
    const create = api.calls.find((c) => c.method === 'POST' && c.path === '/batches')!;
    expect(create.body).toMatchObject({ input_file_id: 'file-abc', metadata: { annotation_desk_run: run.id, annotation_desk_upload: api.storedAtCreate()!.batch!.uploading!.since } });
    expect(JSON.stringify(create.body)).not.toContain('sk-test');
    expect(store.batchParts(run).map((p) => p.batchId)).toEqual(['batch_new']);
  });

  it('never take another 0-request batch for a lost upload; find it by its metadata or input file', async () => {
    const ids = await openaiStudy();
    let listed: Record<string, unknown>[] = [];
    fakeOpenAI({ createFails: true, listed: () => listed });
    await store.startRun({ docIds: ids, scope: 'all' });
    const run = lastRun();
    const unknown = run.batch!.uploadUnknown!;
    expect(unknown).toMatchObject({ inputFileId: 'file-abc', labelled: true });
    const now = Math.floor(Date.now() / 1000) + 1;
    const batch = (id: string, extra: Record<string, unknown>) => ({ id, object: 'batch', status: 'validating', created_at: now, request_counts: { total: 0, completed: 0, failed: 0 }, input_file_id: 'file-other', metadata: null, ...extra });
    // Another device's batch, still validating: not this upload.
    listed = [batch('batch_someone_else', {})];
    answer = false;
    await store.retryFailed(run.id);
    expect(runById(run.id).batch?.uploadUnknown).toBeTruthy();
    expect(confirms.at(-1)).toMatch(/^No batch from the upload/);
    // The batch with this run's metadata (or input file): adopted.
    listed = [batch('batch_someone_else', {}), batch('batch_mine', { metadata: { annotation_desk_run: run.id, annotation_desk_upload: unknown.since } })];
    await store.retryFailed(run.id);
    expect(store.batchParts(runById(run.id)).map((p) => p.batchId)).toEqual(['batch_mine']);
  });

  it('for an upload made before batches had metadata, take a 0-request batch only while it is validating', async () => {
    const ids = await openaiStudy();
    vi.spyOn(openaiAdapter, 'submitBatch').mockRejectedValue(connectionError());
    const list = vi.spyOn(openaiAdapter, 'listRecentBatches').mockResolvedValue([]);
    await store.startRun({ docIds: ids, scope: 'all' });
    const run = (await dbApi.getRun(lastRun().id))!;
    // As an older version recorded it: no input file, no metadata.
    const since = run.batch!.uploadUnknown!.since;
    await dbApi.putRun({ ...run, batch: { ...run.batch!, uploadUnknown: { since, requests: 2 } } });
    await store.selectStudy(store.currentStudy()!.id);
    const later = new Date(Date.parse(since) + 1000).toISOString();
    list.mockResolvedValue([{ batchId: 'batch_cancelled', createdAt: later, requests: 0, status: 'cancelled' }]);
    answer = false;
    await store.retryFailed(run.id);
    expect(runById(run.id).batch?.uploadUnknown).toBeTruthy();
    list.mockResolvedValue([{ batchId: 'batch_validating', createdAt: later, requests: 0, status: 'validating' }]);
    await store.retryFailed(run.id);
    expect(store.batchParts(runById(run.id)).map((p) => p.batchId)).toEqual(['batch_validating']);
  });
});

// ---------- 7. records of older versions ----------

describe('records of older versions', () => {
  it('give an old cut-off stored as failed with only a JSON error a reason', async () => {
    const ids = await freshStudy(1);
    vi.spyOn(anthropicAdapter, 'send').mockResolvedValue(outcome('fine'));
    await store.startRun({ docIds: ids, scope: 'all' });
    const r = store.getState().results.at(-1)!;
    await dbApi.putResult({ ...r, status: 'error', rawText: '{"race": ', stopReason: 'max_tokens', parseError: 'Response was not valid JSON', error: null, requestedAt: 'x', responseId: 'old' }, null);
    await store.selectStudy(store.currentStudy()!.id);
    const now = store.getState().results.find((x) => x.id === r.id)!;
    expect([now.status, now.parseError, now.error]).toEqual(['error', null, 'Incomplete answer (stop reason: max_tokens)']);
  });
  it('log a replaced answer of the refusal fallback as failed, with today’s reason', async () => {
    const ids = await freshStudy(1);
    vi.spyOn(anthropicAdapter, 'send').mockResolvedValue(outcome('fine'));
    await store.startRun({ docIds: ids, scope: 'all' });
    const r = store.getState().results.at(-1)!;
    await dbApi.putResult({ ...r, fallback: 'claude-sonnet-5-5', requestedAt: 'old', responseId: 'old' } as Result, null);
    await store.selectStudy(store.currentStudy()!.id);
    await store.retryFailed(lastRun().id);
    const log = await dbApi.getLog(`${r.id}#2`);
    expect([log?.replaced?.status, log?.replaced?.error?.startsWith('Refused by the requested model')]).toEqual(['error', true]);
  });
  it('keep the record of a setting not sent when a later retry replaces that attempt', async () => {
    const ids = await freshStudy(2);
    const send = vi.spyOn(anthropicAdapter, 'send').mockResolvedValue(outcome('fine'));
    await store.startRun({ docIds: ids.slice(0, 1), scope: 'one' });
    // A day-one run (refusal fallback frozen in its settings), whose second text was never sent.
    const run = (await dbApi.getRun(lastRun().id))!;
    await dbApi.putRun({ ...run, docIds: ids, status: 'cancelled', snapshot: { ...run.snapshot, requestBase: { ...run.snapshot.requestBase, fallbacks: 'default' } } });
    await store.selectStudy(store.currentStudy()!.id);
    send.mockResolvedValue(outcome('', 'refusal'));
    await store.retryFailed(run.id);
    send.mockResolvedValue(outcome('fine'));
    await store.retryFailed(run.id);
    const log = await dbApi.getLog(`${run.id}:${ids[1]}:1#1`);
    expect([log?.attempt, log?.omitted]).toEqual([1, ['fallbacks']]);
  });
  it('give a prompt the version of the run with exactly the same prompt, display names included', async () => {
    await freshStudy(1, (p) => {
      p.outputMode = 'structured';
      p.variables = [{ name: 'race', label: 'Race', type: 'ordinal', values: ['0', '1'], description: '' }];
    });
    const st = store.currentStudy()!;
    const exact = await store.promptFingerprint(st);
    const base = { studyId: st.id, label: '', createdAt: '', finishedAt: null, mode: 'sync' as const, scope: '', docIds: [], status: 'completed' as const, batch: null, error: null };
    const snap = (version: number, hash: string, label: string): Run['snapshot'] => ({
      appVersion: '0.1.0', model: st.model, options: st.options, prompt: { ...st.prompt, variables: [{ ...st.prompt.variables[0], label }] }, promptVersion: version, promptHash: hash, outputSchema: null, requestBase: {},
    });
    // The published app gave a renamed field a new version: v1 'race', then v2 'Race' (the current prompt).
    const runs: Run[] = [
      { ...base, id: 'a', number: 1, snapshot: snap(1, 'h_race', 'race') },
      { ...base, id: 'b', number: 2, snapshot: snap(2, exact, 'Race') },
    ];
    expect(store.versionFor(st.prompt, runs, exact)).toBe(2);
    expect(store.versionFor(st.prompt, runs)).toBe(1);
  });
});

// ---------- 9. interrupted runs ----------

describe('an interrupted run or retry', () => {
  it('finishes at its last answer, not when the study is opened again', async () => {
    const ids = await freshStudy(2);
    vi.spyOn(anthropicAdapter, 'send').mockResolvedValue(outcome('fine'));
    await store.startRun({ docIds: ids, scope: 'all' });
    const run = (await dbApi.getRun(lastRun().id))!;
    const results = await dbApi.getResultsForRun(run.id);
    const last = '2026-10-20T12:00:00.000Z';
    await dbApi.putResult({ ...results[0], requestedAt: '2026-10-20T11:59:00.000Z', completedAt: last }, null);
    await dbApi.putResult({ ...results[1], requestedAt: '2026-10-20T10:59:00.000Z', completedAt: '2026-10-20T11:00:00.000Z' }, null);
    // Left "running" by a closed page.
    await dbApi.putRun({ ...run, status: 'running', finishedAt: null });
    await store.selectStudy(store.currentStudy()!.id);
    expect(lastRun().finishedAt).toBe(last);
    // An interrupted retry: its finish time is not left before its answers.
    const retryAt = '2026-10-21T08:00:00.000Z';
    await dbApi.putResult({ ...results[1], requestedAt: retryAt, completedAt: '2026-10-21T08:05:00.000Z', responseId: 'again' }, null);
    await dbApi.putRun({ ...(await dbApi.getRun(run.id))!, status: 'running', resumeStatus: 'completed', resumeError: null, finishedAt: last, retries: [{ at: retryAt, requests: 0, counted: 'sent' }] });
    await store.selectStudy(store.currentStudy()!.id);
    expect([lastRun().status, lastRun().finishedAt, lastRun().retries]).toEqual(['completed', '2026-10-21T08:05:00.000Z', [{ at: retryAt, requests: 1, counted: 'sent', interrupted: true }]]);
  });
});

// ---------- 8. retries are marked as counted when sent ----------

describe('the record of a retry', () => {
  it('is marked as counting the requests sent, for immediate and batch retries', async () => {
    const ids = await freshStudy(2);
    const send = vi.spyOn(anthropicAdapter, 'send').mockResolvedValue(outcome('', 'refusal'));
    await store.startRun({ docIds: ids, scope: 'all' });
    send.mockResolvedValue(outcome('fine'));
    await store.retryFailed(lastRun().id);
    expect(lastRun().retries).toEqual([{ at: expect.any(String), requests: 2, counted: 'sent' }]);
  });
});

// ---------- 10. messages ----------

describe('messages', () => {
  it('a refused batch upload does not double the provider’s period', async () => {
    const ids = await freshStudy(2);
    store.updateStudy((s) => void (s.options.batch = true));
    vi.spyOn(anthropicAdapter, 'submitBatch').mockRejectedValue(apiError(400, 'Your credit balance is too low to access the Anthropic API.'));
    await store.startRun({ docIds: ids, scope: 'all' });
    const t = toasts().find((x) => x.startsWith('Submitting a batch failed'))!;
    expect(t).toBe('Submitting a batch failed: HTTP 400: Your credit balance is too low to access the Anthropic API.');
  });
  it('adding texts names the study they went to', async () => {
    await freshStudy(2, () => {}, 'Corpus A');
    expect(toasts()).toContain('Added 2 texts to “Corpus A”.');
  });
  it('a label sheet that doesn’t fit says what free space it needs, and that nothing changed', async () => {
    const ids = await freshStudy(2);
    vi.spyOn(dbApi, 'putDocs').mockRejectedValue(quotaError());
    expect(await store.addLabels(new Map(ids.map((id) => [id, { race_gold: '1' }])))).toBe(false);
    expect(toasts().at(-1)).toMatch(/^The labels were not added: this browser's storage is full.*rewrites each of the 2 texts it touches in full, text included, so it needs about 1 KB of free space\. Nothing was changed\.$/);
  });
});

// ---------- review of the third round ----------

describe('deleting with an upload of unknown outcome: what the question says', () => {
  async function unknownRun() {
    const ids = await freshStudy(3);
    store.updateStudy((s) => void (s.options.batch = true));
    const p = fakeBatches(anthropicAdapter);
    p.failUpload(() => connectionError());
    p.list.mockResolvedValue([]);
    await store.startRun({ docIds: ids, scope: 'all' });
    return p;
  }
  it('a found batch that has already ended: its results are paid for, not “may still run”', async () => {
    const p = await unknownRun();
    p.list.mockResolvedValue([{ batchId: 'b_done', createdAt: new Date().toISOString(), requests: 3 }]);
    p.cancel.mockRejectedValue(apiError(409, 'Batch has already ended.'));
    vi.spyOn(anthropicAdapter, 'checkBatch').mockResolvedValue({ status: 'ended', done: true, total: 3, completed: 3, failed: 0 });
    const { problem, cancelled } = await store.cancelUnknownUpload(lastRun());
    expect(cancelled).toBe('');
    expect(problem).toMatch(/did arrive \(b_done\) and has already ended: its results are paid for, and Retry failed on the run collects them\.$/);
    expect(problem).not.toMatch(/may still run/);
  });
  it('a found batch that could not be cancelled may still run; a lookup that failed is said without a doubled period', async () => {
    const p = await unknownRun();
    p.list.mockResolvedValue([{ batchId: 'b_on', createdAt: new Date().toISOString(), requests: 3 }]);
    p.cancel.mockRejectedValue(connectionError());
    let { problem } = await store.cancelUnknownUpload(lastRun());
    expect(problem).toMatch(/did arrive \(b_on\) but could not be cancelled \(Network error: Connection error\. Check your connection or browser extensions blocking the API\)\. It may still run and be charged/);
    p.list.mockRejectedValue(connectionError());
    ({ problem } = await store.cancelUnknownUpload(lastRun()));
    expect(problem).toMatch(/could not be looked up at Anthropic \(Claude\) \(Network error: [^)]*API\)\. If that batch did arrive, it may still run and be charged/);
    expect(problem).not.toContain('.).');
  });
});

describe('a batch upload whose save before it fails', () => {
  it('leaves no upload marked as under way in the page (the later batches of a split upload)', async () => {
    // 1 text × 50,001 annotations: two OpenAI batches (50,000 + 1).
    const ids = await freshStudy(1);
    store.updateStudy((s) => {
      s.options.batch = true;
      s.options.replicates = 50_001;
      s.model.provider = 'openai';
      s.model.model = 'gpt-6.1-sol';
    });
    let n = 0;
    vi.spyOn(openaiAdapter, 'submitBatch').mockImplementation(async () => ({ batchId: `ob${++n}` }));
    const real = dbApi.putRun;
    let saves = 0;
    vi.spyOn(dbApi, 'putRun').mockImplementation(async (r) => {
      // The save before the second batch's upload: storage full.
      if (++saves === 3) throw quotaError();
      return real(r);
    });
    await store.startRun({ docIds: ids, scope: 'all' });
    expect(n).toBe(1);
    expect(toasts().at(-1)).toMatch(/^The remaining batches were not sent: the run could not be saved/);
    const run = lastRun();
    expect(store.batchParts(run).map((p) => p.batchId)).toEqual(['ob1']);
    expect(store.unknownUpload(run)).toBeUndefined();
  }, 120_000);
});

describe('batch results that could not be saved because storage is full', () => {
  it('say how to free space once, then to click Check now', async () => {
    const ids = await freshStudy(2);
    store.updateStudy((s) => void (s.options.batch = true));
    const p = fakeBatches(anthropicAdapter);
    await store.startRun({ docIds: ids, scope: 'all' });
    p.finishAll();
    vi.spyOn(dbApi, 'putRun').mockRejectedValue(quotaError());
    await store.checkBatch(lastRun().id, true);
    const said = toasts().filter((t) => t.startsWith(`Batch run #${lastRun().number}:`) && t.includes('could not be saved'));
    expect(said).toEqual([
      `Batch run #${lastRun().number}: the results arrived but could not be saved, because this browser's storage is full; free disk space, or export a backup and delete old runs or studies. Then click Check now on the Workbench (Check under Runs & agreement).`,
    ]);
  });
});
