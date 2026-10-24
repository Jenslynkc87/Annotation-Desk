// Tests for the fifth round of fixes (lost uploads and deletes, retries after a lost upload, batches whose run record
// could not be saved, adding texts twice, run names in messages), after the fifth verification of October 24, 2026.
// Providers are stubbed: nothing is sent anywhere (any request that does reach `fetch` fails the test).
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dbApi from './db';
import { buildBackup, importBackup } from './export/backup';
import { anthropicAdapter } from './providers/anthropic';
import type { BatchItem, CallOutcome, ListedBatch, ProviderAdapter } from './providers/types';
import * as store from './store';
import type { PromptSpec, Run } from './types';
import { retriedRequests, runName } from './view';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const outcome = (rawText: string, stopReason = 'end_turn'): CallOutcome => ({ rawText, reasoningSummary: '', usage, responseId: `id_${Math.random()}`, modelReported: 'm', stopReason, response: {} });
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
let answer = true;
beforeEach(() => {
  confirms.length = 0;
  answer = true;
  (globalThis as Record<string, unknown>).confirm = (m: string) => (confirms.push(m), answer);
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('fetch', async (u: unknown) => {
    throw new Error(`unexpected request: ${String(u)}`);
  });
});
afterEach(() => {
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
const runById = (id: string) => store.getState().runs.find((r) => r.id === id)!;
const toasts = () => store.getState().toasts.map((t) => t.text);
const partIds = (r: Run) => store.batchParts(r).map((p) => p.batchId);
const batchStudy = () => store.updateStudy((s) => void (s.options.batch = true));
const forgotten = () => JSON.parse(localStorage.getItem('annotation-desk-deleted-batches') ?? '[]') as unknown[];

/** A provider's batches, as a stub of the adapter (as in round4-runs.test.ts): uploads that can arrive without an
 *  answer, listing (cancelled batches marked as stopped), checking, results named by their request, cancelling. */
function fakeBatches(adapter: ProviderAdapter) {
  type Made = { id: string; items: BatchItem[]; at: string; done: boolean; cancelled: boolean };
  const made: Made[] = [];
  let upload: (n: number) => 'ok' | 'lost' | Error = () => 'ok';
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
  let failFirst = '';
  const fetch = vi.spyOn(adapter, 'fetchBatchResults').mockImplementation(async (_k, id) => {
    const b = made.find((x) => x.id === id)!;
    return b.items.map((it, i) =>
      b.cancelled || (id === failFirst && i === 0)
        ? { customId: it.customId, ok: false as const, error: b.cancelled ? 'Request canceled' : 'Overloaded' }
        : { customId: it.customId, ok: true as const, outcome: { ...outcome(`answer ${it.customId} of ${id}`), responseId: `${id}_${it.customId}` } },
    );
  });
  const cancel = vi.spyOn(adapter, 'cancelBatch').mockImplementation(async (_k, id) => {
    const b = made.find((x) => x.id === id);
    if (b) [b.cancelled, b.done] = [true, true];
  });
  return {
    made,
    submit,
    list,
    check,
    fetch,
    cancel,
    uploads: (f: (n: number) => 'ok' | 'lost' | Error) => (upload = f),
    finishAll: () => made.forEach((b) => (b.done = true)),
    /** The first answer of this batch comes back failed. */
    failFirstOf: (id: string) => (failFirst = id),
  };
}

/** A run whose upload reached Anthropic (b1) without an answer, while the provider could not be asked. */
async function lostUpload(n = 3) {
  const ids = await freshStudy(n);
  batchStudy();
  const p = fakeBatches(anthropicAdapter);
  p.uploads(() => 'lost');
  p.list.mockRejectedValueOnce(connectionError());
  await store.startRun({ docIds: ids, scope: 'all' });
  expect(lastRun().batch?.uploadUnknown).toBeTruthy();
  p.uploads(() => 'ok');
  return { p, ids, runId: lastRun().id };
}

/** The open study's backup, imported into this browser (Studies → Import study backup), and opened. */
async function restore(backup: Awaited<ReturnType<typeof buildBackup>>) {
  const copy = await importBackup(backup);
  await store.refreshStudies();
  await store.selectStudy(copy.id);
  return copy;
}
const backupNow = () => {
  const s = store.getState();
  return buildBackup(store.currentStudy()!, s.docs, s.runs, false);
};

// ---------- H4, H8: a run or study deleted after its lost upload's batch was found, restored from a backup ----------

describe('restoring a deleted run from its backup finds its own lost upload’s batch (H4, H8)', () => {
  for (const how of ['study', 'run'] as const) {
    for (const batch of ['ended', 'running'] as const) {
      it(`delete the ${how} (its batch ${batch}), import the backup: Retry failed adopts that batch, uploading nothing`, async () => {
        const { p, runId } = await lostUpload();
        const backup = await backupNow();
        if (batch === 'ended') p.made[0].done = true;
        if (how === 'study') await store.removeStudy(store.currentStudy()!.id);
        else await store.removeRun(runId);
        // The delete found it: “did arrive (b1) and has already ended”, or it cancelled it.
        if (batch === 'ended') expect(confirms.at(-1)).toMatch(/did arrive \(b1\) and has already ended/);
        else expect(p.cancel).toHaveBeenCalledWith('sk-ant-test', 'b1');
        expect(forgotten()).toEqual([{ id: 'b1', since: expect.any(String), requests: 3 }]);
        confirms.length = 0;
        await restore(backup);
        p.submit.mockClear();
        await store.retryFailed(lastRun().id);
        expect([confirms, p.submit.mock.calls.length, partIds(lastRun())]).toEqual([[], 0, ['b1']]);
        // Its results (those finished before a cancel) are collected into the restored run.
        await store.checkBatch(lastRun().id);
        expect(lastRun().status).toBe('completed');
      });
    }
  }

  it('an older backup, restored after the run had adopted the found batch and was then deleted: the same', async () => {
    const { p, runId } = await lostUpload();
    const backup = await backupNow();
    await store.retryFailed(runId);
    expect(partIds(runById(runId))).toEqual(['b1']);
    p.finishAll();
    await store.checkBatch(runId);
    await store.removeRun(runId);
    await restore(backup);
    p.submit.mockClear();
    await store.retryFailed(lastRun().id);
    expect([confirms, p.submit.mock.calls.length, partIds(lastRun())]).toEqual([[], 0, ['b1']]);
  });

  it('another run’s lost upload with the same number of requests never takes the deleted run’s batch (G3 kept)', async () => {
    const { p, ids, runId } = await lostUpload();
    p.made[0].done = true;
    await store.removeRun(runId);
    // A new run (corrected prompt, same texts) whose upload never arrives.
    store.updateStudy((s) => void (s.prompt.userTemplate = 'Rate it (corrected).'));
    p.uploads(() => connectionError());
    await store.startRun({ docIds: ids, scope: 'all' });
    expect(partIds(lastRun())).toEqual([]);
    expect(lastRun().batch?.uploadUnknown).toBeTruthy();
  });

  it('a deleted run’s batch that was cancelled makes another upload’s lookup unsure, never “No batch … was found”', async () => {
    const ids = await freshStudy(3);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    await store.startRun({ docIds: ids, scope: 'all' });
    await store.removeRun(lastRun().id);
    expect(p.made[0].cancelled).toBe(true);
    store.updateStudy((s) => void (s.prompt.userTemplate = 'Rate it (corrected).'));
    p.uploads(() => connectionError());
    await store.startRun({ docIds: ids, scope: 'all' });
    answer = false;
    await store.retryFailed(lastRun().id);
    expect(confirms.at(-1)).toMatch(/could not be looked up at Anthropic \(Claude\) \(a batch there with the same number of requests \(b1\) was cancelled or expired/);
    expect(partIds(lastRun())).toEqual([]);
  });

  it('reads the bare ids remembered by the version of October 23, 2026', async () => {
    const { p, ids, runId } = await lostUpload();
    await store.removeRun(runId);
    localStorage.setItem('annotation-desk-deleted-batches', JSON.stringify(['b1']));
    p.made[0].cancelled = false;
    p.uploads(() => connectionError());
    await store.startRun({ docIds: ids, scope: 'all' });
    expect(partIds(lastRun())).toEqual([]);
    expect(lastRun().batch?.uploadUnknown).toBeTruthy();
  });
});

// ---------- H5: a retry whose own upload never went up ----------

describe('a retry’s lost upload is not credited with the earlier lost upload’s batch (H5)', () => {
  it('the lookup right after it works: the batch is collected, but no retry is counted as sent', async () => {
    const { p, runId } = await lostUpload();
    const first = runById(runId).batch!.uploadUnknown!;
    // Retry failed: the lookup can't reach the provider; the owner sends again, and that upload never arrives.
    p.list.mockRejectedValueOnce(connectionError());
    p.uploads(() => connectionError());
    await store.retryFailed(runId);
    expect(confirms).toHaveLength(1);
    expect(partIds(runById(runId))).toEqual(['b1']);
    expect(toasts().at(-1)).toMatch(/^The upload got no answer, but Anthropic \(Claude\) has a batch with these requests \(b1\): it is this upload’s, or that of the earlier upload/);
    expect(runById(runId).retries).toBeUndefined();
    p.finishAll();
    await store.checkBatch(runId);
    const s = store.getState();
    const run = runById(runId);
    expect(run.status).toBe('completed');
    expect([run.retries, retriedRequests(run, s.results).requests]).toEqual([undefined, 0]);
    // Its answers were requested when the first upload went up.
    expect(new Set(s.results.map((r) => r.requestedAt))).toEqual(new Set([first.since]));
  });

  it('the network still down after it: a later Retry failed finds the batch, and counts no retry', async () => {
    const { p, runId } = await lostUpload();
    const first = runById(runId).batch!.uploadUnknown!;
    p.list.mockRejectedValueOnce(connectionError()).mockRejectedValueOnce(connectionError());
    p.uploads(() => connectionError());
    await store.retryFailed(runId);
    // The retry's upload is now the one of unknown outcome; the first is kept with it.
    const second = runById(runId).batch!.uploadUnknown!;
    expect(second.earlier).toEqual({ since: first.since, requests: 3, endedAt: first.endedAt });
    confirms.length = 0;
    await store.retryFailed(runId);
    expect([confirms, p.submit.mock.calls.length, partIds(runById(runId))]).toEqual([[], 2, ['b1']]);
    expect(toasts().at(-1)).toMatch(/Nothing was sent again\./);
    p.finishAll();
    await store.checkBatch(runId);
    const run = runById(runId);
    expect([run.status, run.retries, retriedRequests(run, store.getState().results).requests]).toEqual(['completed', undefined, 0]);
  });

  it('a batch that the retry’s upload did create is counted as the retry once its answers show it', async () => {
    const ids = await freshStudy(3);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    // The first upload never arrives (the provider says so: none there).
    p.uploads(() => connectionError());
    await store.startRun({ docIds: ids, scope: 'all' });
    const runId = lastRun().id;
    expect(lastRun().batch?.uploadUnknown).toBeTruthy();
    // Retry failed: none found, the owner sends again; that batch arrives, but its answer is lost.
    p.uploads(() => 'lost');
    await store.retryFailed(runId);
    expect(confirms.at(-1)).toMatch(/^No batch from the upload of/);
    expect(partIds(runById(runId))).toEqual(['b1']);
    expect(runById(runId).retries).toBeUndefined();
    p.finishAll();
    await store.checkBatch(runId);
    const run = runById(runId);
    const retryAt = run.retries?.[0]?.at;
    expect(run.retries).toEqual([{ at: expect.any(String), requests: 3, asBatch: true, counted: 'sent' }]);
    expect(retriedRequests(run, store.getState().results).requests).toBe(3);
    // Recorded as sent by the retry's upload (its own time), not the first one's.
    const part = store.batchParts(run)[0];
    expect(part.eitherRetry).toBeUndefined();
    expect(part.submittedAt! >= retryAt!).toBe(true);
    expect(store.getState().results.every((r) => r.requestedAt === part.submittedAt)).toBe(true);
  });
});

// ---------- H15: a retry's batch went up, but the save right after it failed ----------

describe('a retry’s batch that went up while the run could not be saved after it (H15)', () => {
  it('the next check drops the earlier unknown upload, and a later Retry failed re-sends only what failed', async () => {
    const { p, runId } = await lostUpload();
    // Retry failed: the lookup fails, the owner sends again; that batch (b2) goes up, the save after it fails.
    p.list.mockRejectedValueOnce(connectionError());
    const real = dbApi.putRun;
    let saves = 0;
    const put = vi.spyOn(dbApi, 'putRun').mockImplementation(async (r) => {
      if (++saves === 2) throw quotaError();
      return real(r);
    });
    await store.retryFailed(runId);
    put.mockRestore();
    expect((await dbApi.getRun(runId))!.batch?.uploadUnknown).toBeTruthy();
    await store.checkBatch(runId, true);
    expect([runById(runId).batch?.uploadUnknown, (await dbApi.getRun(runId))!.batch?.uploadUnknown]).toEqual([undefined, undefined]);
    // b2 ends with one failed answer.
    p.failFirstOf('b2');
    p.made[1].done = true;
    await store.checkBatch(runId);
    expect(runById(runId).status).toBe('completed');
    expect(toasts().at(-1)).toBe('Batch run #1 finished: 2 ok, 1 failed.');
    // Retry failed: only that request goes out (a new batch), and b2's answers stay as they are.
    p.made[0].done = true;
    p.submit.mockClear();
    await store.retryFailed(runId);
    expect(p.submit).toHaveBeenCalledTimes(1);
    expect(p.submit.mock.calls[0][2]).toHaveLength(1);
    expect(partIds(runById(runId))).toEqual(['b2', 'b3']);
    expect(store.getState().results.filter((r) => r.status === 'ok').map((r) => r.attempt ?? 1)).toEqual([1, 1]);
  });
});

// ---------- H16: results saved, but not the run's record of them ----------

describe('a batch whose run record could not be saved, after opening another study and coming back (H16)', () => {
  it('still shows that, and is completed by the next check that can save it, without fetching again', async () => {
    const ids = await freshStudy(2);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    await store.startRun({ docIds: ids, scope: 'all' });
    const runId = lastRun().id;
    const studyId = store.currentStudy()!.id;
    p.finishAll();
    const put = vi.spyOn(dbApi, 'putRun').mockRejectedValue(quotaError());
    await store.checkBatch(runId, true);
    put.mockRestore();
    const marks = (r: Run) => store.batchParts(r).map((x) => [x.status, !!x.saveFailed, !!x.resultsSaved]);
    expect(marks(runById(runId))).toEqual([['submitted', true, true]]);
    await store.createStudy('Other');
    await store.selectStudy(studyId);
    expect(marks(runById(runId))).toEqual([['submitted', true, true]]);
    p.fetch.mockClear();
    await store.checkBatch(runId, true);
    expect([runById(runId).status, p.fetch.mock.calls.length, (await dbApi.getRun(runId))!.status]).toEqual(['completed', 0, 'completed']);
    expect(store.getState().results.filter((r) => r.status === 'ok')).toHaveLength(2);
  });

  it('results that could not be saved: still shown so after coming back, and not fetched by the quiet checks', async () => {
    const ids = await freshStudy(2);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    await store.startRun({ docIds: ids, scope: 'all' });
    const runId = lastRun().id;
    const studyId = store.currentStudy()!.id;
    p.finishAll();
    const results = vi.spyOn(dbApi, 'putResult').mockRejectedValue(quotaError());
    const put = vi.spyOn(dbApi, 'putRun').mockRejectedValue(quotaError());
    await store.checkBatch(runId, true);
    put.mockRestore();
    results.mockRestore();
    await store.createStudy('Other');
    await store.selectStudy(studyId);
    const part = store.batchParts(runById(runId))[0];
    expect([part.status, !!part.saveFailed, !!part.resultsSaved]).toEqual(['submitted', true, false]);
    p.fetch.mockClear();
    await store.checkBatch(runId, true);
    expect(p.fetch).not.toHaveBeenCalled();
    expect(store.batchParts(runById(runId))[0].saveFailed).toBeTruthy();
    // Check now collects it.
    await store.checkBatch(runId);
    expect(runById(runId).status).toBe('completed');
  });
});

// ---------- H9, H23: adding texts or entries ----------

describe('adding texts or entries already here, or twice at once (H9, H23)', () => {
  const entry = (name: string, country: string, fame: string) => ({ docId: name, text: `name: ${name}\ncountry: ${country}`, meta: { name, country, my_fame: fame }, source: 'pasted' });

  it('the same table pasted again adds neither John Smith (the second was stored as John Smith_2)', async () => {
    await emptyDatabase();
    await store.createStudy('Entries', 'entries');
    const rows = [entry('Niels Bohr', 'Denmark', '3'), entry('John Smith', 'UK', '1'), entry('John Smith', 'US', '3')];
    await store.addDocs(rows);
    await store.addDocs([...rows, entry('Lise Meitner', 'Austria', '2')]);
    expect(store.getState().docs.map((d) => d.docId)).toEqual(['Niels Bohr', 'John Smith', 'John Smith_2', 'Lise Meitner']);
    expect(toasts()).toContain('Skipped 3 entries already in this study (same name and identical details).');
  });

  it('a text-study table with a repeated ID, pasted twice: no third copy', async () => {
    await emptyDatabase();
    await store.createStudy('Texts');
    const rows = [
      { docId: 'a1', text: 'First article.', meta: { era: '1990' }, source: 'pasted' },
      { docId: 'a1', text: 'Another article with the same ID.', meta: { era: '2000' }, source: 'pasted' },
    ];
    await store.addDocs(rows);
    await store.addDocs(rows);
    expect(store.getState().docs.map((d) => d.docId)).toEqual(['a1', 'a1_2']);
  });

  it('a file really named smith_2.md is compared under its own name only', async () => {
    await emptyDatabase();
    await store.createStudy('Files');
    await store.addDocs([{ docId: 'smith_2', text: 'Same words.', meta: { file: 'smith_2.md' }, source: 'smith_2.md' }]);
    await store.addDocs([{ docId: 'smith', text: 'Same words.', meta: { file: 'smith.md' }, source: 'smith.md' }]);
    expect(store.getState().docs.map((d) => d.docId)).toEqual(['smith_2', 'smith']);
  });

  it('one file selected twice in one drop is added once; a same-named file with another text gets a suffix', async () => {
    await emptyDatabase();
    await store.createStudy('Drop');
    const file = (name: string, text: string) => ({ docId: name.replace(/\.[^.]+$/, ''), text, meta: { file: name }, source: name });
    const before = toasts().length;
    await store.addDocs([file('Hansen_2001_framing.txt', 'Framing.'), file('Larsen_1999_policy.txt', 'Policy.'), file('Hansen_2001_framing.txt', 'Framing.')]);
    expect(store.getState().docs.map((d) => d.docId)).toEqual(['Hansen_2001_framing', 'Larsen_1999_policy']);
    expect(toasts().slice(before)).toContain('Skipped 1 text included twice in this addition (same name, identical text and columns): Hansen_2001_framing.txt.');
    expect(toasts().slice(before).some((t) => t.includes('already in this study') || t.includes('got a suffix'))).toBe(false);
    await store.addDocs([file('x.txt', 'One.'), file('x.txt', 'Two.')]);
    expect(store.getState().docs.map((d) => d.docId).slice(2)).toEqual(['x', 'x_2']);
  });
});

// ---------- H24: deleting a run whose lost upload another study has already found ----------

describe('deleting a run whose lost upload a backup copy has already found (H24)', () => {
  it('says the copy has the batch and collects it, not that its Retry failed finds it', async () => {
    const { p, runId } = await lostUpload();
    const originalStudy = store.currentStudy()!;
    const copy = await restore(await backupNow());
    await store.retryFailed(lastRun().id);
    expect(partIds(lastRun())).toEqual(['b1']);
    await store.selectStudy(originalStudy.id);
    expect(await store.unknownUploadSharers(runById(runId))).toEqual({ waiting: [], holding: [{ study: copy.name, batchId: 'b1', collected: false }] });
    await store.removeRun(runId);
    expect(p.cancel).not.toHaveBeenCalled();
    expect(toasts().at(-1)).toBe(
      `The batch of run #1’s upload of unknown outcome (b1) had reached the provider and is left running for “${copy.name}” (another study here that shares that upload: a copy from a backup, or the study this one was copied from), which collects it.`,
    );
  });
});

// ---------- H12, H21, H22: runs that share a number, in messages ----------

describe('messages name runs that share a number as the screens do (H12, H21, H22)', () => {
  it('Retry failed, Remaining and a delete whose lookup fails', async () => {
    const ids = await freshStudy(2);
    const send = vi.spyOn(anthropicAdapter, 'send').mockResolvedValueOnce(outcome('fine')).mockRejectedValueOnce(Object.assign(new Error('Overloaded'), { status: 529 }));
    await store.startRun({ docIds: ids, scope: 'all' });
    // A second run given the same number (two tabs of the published version).
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    p.uploads(() => connectionError());
    p.list.mockRejectedValueOnce(connectionError());
    await store.startRun({ docIds: ids, scope: 'all' });
    const [a, b] = store.getState().runs;
    await dbApi.putRun({ ...(await dbApi.getRun(b.id))!, number: 1 });
    await store.selectStudy(store.currentStudy()!.id);
    const runs = store.getState().runs;
    const [nameA, nameB] = [runName(runById(a.id), runs), runName(runById(b.id), runs)];
    expect(nameA).toMatch(/^1-/);
    // Remaining leaves out the text that failed in the first run: the second run's upload may have it.
    const s = store.getState();
    expect(store.remainingDocs(store.currentStudy()!, s.docs, s.runs, s.results)).toMatchObject({ unknown: 1, unknownRuns: [1], unknownRunNames: [nameB] });
    send.mockResolvedValue(outcome('fine again'));
    await store.retryFailed(a.id);
    expect(toasts().at(-1)).toBe(`Retry in run #${nameA} finished: 1 ok.`);
    p.list.mockRejectedValue(connectionError());
    answer = false;
    await store.removeRun(b.id);
    expect(confirms.at(-1)).toMatch(new RegExp(`of run #${nameB} could not be looked up .*Delete run #${nameB} anyway\\?$`, 's'));
  });
});

// ---------- Review of the fixes above ----------

describe('review: lost uploads, retries and save marks, in combination', () => {
  it('a backup copy sharing a batch whose run record could not be saved in the original collects it itself (H16)', async () => {
    const ids = await freshStudy(2);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    await store.startRun({ docIds: ids, scope: 'all' });
    const runId = lastRun().id;
    const studyId = store.currentStudy()!.id;
    const backup = await backupNow();
    p.finishAll();
    const put = vi.spyOn(dbApi, 'putRun').mockRejectedValue(quotaError());
    await store.checkBatch(runId, true);
    put.mockRestore();
    // The copy's run waits for the same batch (b1), and has none of its results.
    await restore(backup);
    const copyRun = lastRun();
    expect(copyRun.id).not.toBe(runId);
    const part = store.batchParts(copyRun)[0];
    expect([part.batchId, part.status, !!part.saveFailed, !!part.resultsSaved]).toEqual(['b1', 'submitted', false, false]);
    p.fetch.mockClear();
    await store.checkBatch(copyRun.id, true);
    expect(p.fetch).toHaveBeenCalledTimes(1);
    expect(store.getState().results.filter((r) => r.runId === copyRun.id && r.status === 'ok')).toHaveLength(2);
    // The original is still completed from its marks, without fetching again.
    await store.selectStudy(studyId);
    p.fetch.mockClear();
    await store.checkBatch(runId, true);
    expect([runById(runId).status, p.fetch.mock.calls.length]).toEqual(['completed', 0]);
  });

  /** A first upload (b1) and a retry's upload (never arrived), both of unknown outcome: the retry's is on record,
   *  with the first as `earlier`. */
  async function twoLostUploads() {
    const { p, ids, runId } = await lostUpload();
    p.list.mockRejectedValueOnce(connectionError()).mockRejectedValueOnce(connectionError());
    p.uploads(() => connectionError());
    await store.retryFailed(runId);
    expect(runById(runId).batch!.uploadUnknown!.earlier).toBeTruthy();
    p.uploads(() => 'ok');
    confirms.length = 0;
    return { p, ids, runId };
  }

  it('a copy of a deleted run, whose retry’s upload is the unknown one, takes the batch the run had for the first upload as either’s', async () => {
    const { p, runId } = await twoLostUploads();
    const backup = await backupNow();
    // The run finds b1 (either upload's), collects it, and is deleted.
    await store.retryFailed(runId);
    p.finishAll();
    await store.checkBatch(runId);
    expect(runById(runId).status).toBe('completed');
    await store.removeRun(runId);
    await restore(backup);
    confirms.length = 0;
    p.submit.mockClear();
    await store.retryFailed(lastRun().id);
    expect([confirms, p.submit.mock.calls.length, partIds(lastRun())]).toEqual([[], 0, ['b1']]);
    expect(store.batchParts(lastRun())[0].eitherRetry).toBeTruthy();
    await store.checkBatch(lastRun().id);
    const run = lastRun();
    expect([run.status, run.retries]).toEqual(['completed', undefined]);
  });

  it('a run deleted while its retry’s upload was unknown, the batch found then (the first upload’s): its copy counts no retry', async () => {
    const { p, runId } = await twoLostUploads();
    const backup = await backupNow();
    p.finishAll();
    await store.removeRun(runId);
    expect(confirms.at(-1)).toMatch(/did arrive \(b1\) and has already ended/);
    await restore(backup);
    confirms.length = 0;
    p.submit.mockClear();
    await store.retryFailed(lastRun().id);
    expect([confirms, p.submit.mock.calls.length, partIds(lastRun())]).toEqual([[], 0, ['b1']]);
    expect(lastRun().retries).toBeUndefined();
    await store.checkBatch(lastRun().id);
    const run = lastRun();
    expect([run.status, run.retries, retriedRequests(run, store.getState().results).requests]).toEqual(['completed', undefined, 0]);
  });

  it('a copy that has already found the first upload’s batch: the run whose retry’s upload is unknown shares it', async () => {
    const { p, runId } = await lostUpload();
    const originalStudy = store.currentStudy()!;
    const backup = await backupNow();
    // In the original, a retry whose lookup fails and whose upload never arrives.
    p.list.mockRejectedValueOnce(connectionError()).mockRejectedValueOnce(connectionError());
    p.uploads(() => connectionError());
    await store.retryFailed(runId);
    expect(runById(runId).batch!.uploadUnknown!.earlier).toBeTruthy();
    p.uploads(() => 'ok');
    // A copy taken while the first upload was unknown finds b1.
    await restore(backup);
    await store.retryFailed(lastRun().id);
    expect(partIds(lastRun())).toEqual(['b1']);
    await store.selectStudy(originalStudy.id);
    confirms.length = 0;
    p.submit.mockClear();
    await store.retryFailed(runId);
    expect([confirms, p.submit.mock.calls.length, partIds(runById(runId))]).toEqual([[], 0, ['b1']]);
    p.finishAll();
    await store.checkBatch(runId);
    expect([runById(runId).status, runById(runId).retries]).toEqual(['completed', undefined]);
  });

  it('a retry’s batch found as either’s, the save after it failed, collected in the same check: no upload left unknown (H15)', async () => {
    const { p, runId } = await lostUpload();
    // Retry failed: the lookup fails, the owner sends again; that upload never arrives, the lookup after it finds b1,
    // and the save right after fails.
    p.list.mockRejectedValueOnce(connectionError());
    p.uploads(() => connectionError());
    const real = dbApi.putRun;
    let saves = 0;
    const put = vi.spyOn(dbApi, 'putRun').mockImplementation(async (r) => {
      if (++saves === 2) throw quotaError();
      return real(r);
    });
    await store.retryFailed(runId);
    put.mockRestore();
    expect((await dbApi.getRun(runId))!.batch?.uploading).toBeTruthy();
    expect(store.batchParts(runById(runId))[0].eitherRetry).toBeTruthy();
    p.finishAll();
    await store.checkBatch(runId, true);
    const run = runById(runId);
    expect([run.status, run.batch?.uploadUnknown, run.error]).toEqual(['completed', undefined, null]);
    expect(toasts().at(-1)).toBe('Batch run #1 finished: 3 ok, 0 failed.');
  });
});
