// Regression tests for the November 2026 audit: a batch found for a lost upload by its number of requests alone may
// be another browser's (same key); its answers must never be stored on this run's texts. Providers are stubbed:
// nothing is sent anywhere (any request that does reach `fetch` fails the test).
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dbApi from './db';
import { anthropicAdapter } from './providers/anthropic';
import type { BatchItem, CallOutcome, ListedBatch } from './providers/types';
import * as store from './store';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const outcome = (rawText: string): CallOutcome => ({ rawText, reasoningSummary: '', usage, responseId: `id_${Math.random()}`, modelReported: 'm', stopReason: 'end_turn', response: {} });

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

beforeEach(() => {
  (globalThis as Record<string, unknown>).confirm = () => true;
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('fetch', async (u: unknown) => {
    throw new Error(`unexpected request: ${String(u)}`);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function freshBatchStudy(n: number) {
  for (const s of await dbApi.listStudies()) await dbApi.deleteStudy(s.id);
  await store.createStudy('Audit');
  store.setKey('anthropic', 'sk-ant-test');
  store.updateStudy((s) => {
    s.prompt.userTemplate = 'Rate it.';
    s.prompt.outputMode = 'text';
    s.prompt.variables = [];
    s.options.batch = true;
  });
  await store.addDocs(Array.from({ length: n }, (_, i) => ({ docId: `t${i}`, text: `text ${i}`, meta: {}, source: `t${i}.txt` })));
  return store.getState().docs.map((d) => d.id);
}

/** Anthropic's batches as a stub: `made` holds every batch that exists there (also other browsers'). */
function fakeAnthropic(upload: () => 'ok' | Error) {
  const made: { id: string; items: BatchItem[]; at: string; done: boolean }[] = [];
  const submit = vi.spyOn(anthropicAdapter, 'submitBatch').mockImplementation(async (_k, _b, items) => {
    const how = upload();
    if (how instanceof Error) throw how;
    const id = `b${made.length + 1}`;
    made.push({ id, items, at: new Date().toISOString(), done: false });
    return { batchId: id };
  });
  vi.spyOn(anthropicAdapter, 'listRecentBatches').mockImplementation(async () =>
    made.map((b): ListedBatch => ({ batchId: b.id, createdAt: b.at, requests: b.items.length })).reverse(),
  );
  vi.spyOn(anthropicAdapter, 'checkBatch').mockImplementation(async (_k, id) => {
    const b = made.find((x) => x.id === id);
    return { status: b?.done ? 'ended' : 'in_progress', done: !!b?.done, total: b?.items.length ?? 0, completed: 0, failed: 0, endedAt: b?.done ? new Date().toISOString() : undefined };
  });
  vi.spyOn(anthropicAdapter, 'fetchBatchResults').mockImplementation(async (_k, id) =>
    made.find((x) => x.id === id)!.items.map((it) => ({ customId: it.customId, ok: true as const, outcome: outcome(`answer to ${it.customId} in ${id}`) })),
  );
  return { made, submit };
}

describe('batch request names (Nov 2026 audit)', () => {
  it('carry a tag of their own run', async () => {
    const ids = await freshBatchStudy(3);
    const fake = fakeAnthropic(() => 'ok');
    await store.startRun({ docIds: ids, scope: 'all' });
    const run = store.getState().runs.at(-1)!;
    const tag = run.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
    expect(fake.submit.mock.calls[0][2].map((it) => it.customId)).toEqual([`${tag}_r0`, `${tag}_r1`, `${tag}_r2`]);
    expect(Object.keys(run.batch!.map)).toEqual([`${tag}_r0`, `${tag}_r1`, `${tag}_r2`]);
  });

  it('keep another browser’s batch, found for a lost upload by its count, off this run’s texts', async () => {
    const ids = await freshBatchStudy(3);
    // Another browser (same key) has just sent a batch of 3 requests; this browser's upload never arrives.
    const fake = fakeAnthropic(() => new Error('Connection error.'));
    fake.made.push({ id: 'other', at: new Date().toISOString(), done: false, items: [0, 1, 2].map((i) => ({ customId: `deadbeef_r${i}`, part: {} })) });
    await store.startRun({ docIds: ids, scope: 'all' });
    const runId = store.getState().runs.at(-1)!.id;
    // The lookup takes the other browser's batch by its count (it can't tell before the batch has ended) ...
    expect(store.batchParts(store.getState().runs.at(-1)!).map((p) => p.batchId)).toEqual(['other']);
    fake.made[0].done = true;
    await store.checkBatch(runId);
    // ... but none of its answers are stored here, and the run says why.
    expect(store.getState().results.filter((r) => r.runId === runId)).toEqual([]);
    const run = store.getState().runs.find((r) => r.id === runId)!;
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/not this run’s: its requests have other names/);
    expect(store.retryableCount(run, store.getState().results, store.getState().docs)).toBe(3);
  });
});

describe('the scale of plain-text scores reaches every plain-text run of the study (Nov 2026 audit)', () => {
  it('is set on earlier runs and new ones, kept when a run is saved, and cleared again', async () => {
    const ids = await freshBatchStudy(2);
    store.updateStudy((s) => void (s.options.batch = false));
    vi.spyOn(anthropicAdapter, 'send').mockResolvedValue(outcome('{"race": 1}'));
    await store.startRun({ docIds: ids, scope: 'all' });
    const first = store.getState().runs.at(-1)!.id;
    expect(store.getState().runs.at(-1)!.scoreScale).toBeUndefined();
    await store.setScoreScale({ min: -3, max: 3 });
    expect(store.currentStudy()!.scoreScale).toEqual({ min: -3, max: 3 });
    expect((await dbApi.getRun(first))!.scoreScale).toEqual({ min: -3, max: 3 });
    expect(store.getState().runs.find((r) => r.id === first)!.scoreScale).toEqual({ min: -3, max: 3 });
    // A new run starts with it; renaming (a save) keeps it.
    await store.startRun({ docIds: ids, scope: 'all' });
    const second = store.getState().runs.at(-1)!.id;
    expect((await dbApi.getRun(second))!.scoreScale).toEqual({ min: -3, max: 3 });
    await store.renameRun(second, 'pilot');
    expect((await dbApi.getRun(second))!.scoreScale).toEqual({ min: -3, max: 3 });
    await store.setScoreScale(null);
    expect((await dbApi.getRun(first))!.scoreScale).toBeUndefined();
    expect(store.getState().runs.every((r) => r.scoreScale === undefined)).toBe(true);
  });
});
