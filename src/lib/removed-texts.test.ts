// Texts deleted from a study that runs used (November 2026): kept for those runs, restored when added again, and
// results of texts an earlier version deleted outright reconnected by their logged requests.
// Providers are stubbed: nothing is sent anywhere.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dbApi from './db';
import { buildBackup, importBackup } from './export/backup';
import { resultsLong, resultsWide } from './export/tables';
import { anthropicAdapter } from './providers/anthropic';
import type { CallOutcome } from './providers/types';
import { loggedKey, matchLostTexts, requestKey } from './reconnect';
import * as store from './store';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const answer = (score: number): CallOutcome => ({ rawText: JSON.stringify({ score }), reasoningSummary: '', usage, responseId: `id_${Math.random()}`, modelReported: 'm', stopReason: 'end_turn', response: {} });

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
  // Each text gets a score from its number, so two runs agree.
  vi.spyOn(anthropicAdapter, 'send').mockImplementation(async (_k, _b, part) => answer(Number(/text (\d+)/.exec(JSON.stringify(part))?.[1] ?? 0) % 3));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const file = (i: number, text = `text ${i}`) => ({ docId: `a${i}`, text, meta: { file: `a${i}.txt` }, source: `a${i}.txt` });
const S = () => store.getState();

async function studyWithRun(n = 4) {
  for (const s of await dbApi.listStudies()) await dbApi.deleteStudy(s.id);
  await store.createStudy('Removed texts');
  store.setKey('anthropic', 'sk-ant-test');
  store.updateStudy((s) => {
    s.prompt.userTemplate = 'Rate it.';
    s.prompt.outputMode = 'text';
    s.prompt.variables = [];
  });
  await store.addDocs(Array.from({ length: n }, (_, i) => file(i)));
  await store.startRun({ docIds: S().docs.map((d) => d.id), scope: 'all' });
  return S().runs.at(-1)!;
}
const all = () => store.withRemoved(S().docs, S().removedDocs);
const shownIn = (runId: string) => resultsWide(S().runs.find((r) => r.id === runId)!, all(), S().runs, S().results, { text: false, rationale: false }).map((r) => r.doc_id);

describe('deleting texts that a run used', () => {
  it('keeps them for the run: hidden from the study, still in its results, and still so after reopening the study', async () => {
    const run = await studyWithRun();
    const ids = S().docs.map((d) => d.id);
    await store.removeDocs(ids);
    expect(S().docs).toEqual([]);
    expect(S().removedDocs.map((d) => d.docId)).toEqual(['a0', 'a1', 'a2', 'a3']);
    expect(shownIn(run.id)).toEqual(['a0', 'a1', 'a2', 'a3']);
    await store.selectStudy(S().currentId!);
    expect(S().docs).toEqual([]);
    expect(S().removedDocs).toHaveLength(4);
    // Nothing is called deleted in the per-request table: the texts have their names.
    expect(resultsLong(store.currentStudy()!, S().runs, all(), S().results, { rationale: false, reasoning: false }).map((r) => r.doc_id)).toEqual(['a0', 'a1', 'a2', 'a3']);
  });

  it('deletes outright a text no run used', async () => {
    await studyWithRun(2);
    await store.addDocs([file(9)]);
    const unused = S().docs.find((d) => d.docId === 'a9')!.id;
    await store.removeDocs([unused]);
    expect(S().removedDocs).toEqual([]);
    expect((await dbApi.getDocsForStudy(S().currentId!)).map((d) => d.docId)).toEqual(['a0', 'a1']);
  });

  it('gives a text added again (same name, identical text) its record back, so two runs compare on it', async () => {
    const first = await studyWithRun();
    const before = S().docs.map((d) => d.id);
    await store.removeDocs(before);
    await store.addDocs([file(0), file(1), file(2), file(3)]);
    expect(S().docs.map((d) => d.id)).toEqual(before);
    expect(S().removedDocs).toEqual([]);
    await store.startRun({ docIds: S().docs.map((d) => d.id), scope: 'all' });
    const second = S().runs.at(-1)!;
    expect(second.docIds).toEqual(first.docIds);
    expect(S().toasts.map((t) => t.text).some((t) => t.includes('had been deleted before'))).toBe(true);
  });

  it('adds a changed text as a new one, keeping the removed one for its run', async () => {
    const run = await studyWithRun(1);
    await store.removeDocs(S().docs.map((d) => d.id));
    await store.addDocs([file(0, 'text 0, revised')]);
    expect(S().docs.map((d) => [d.docId, d.text])).toEqual([['a0', 'text 0, revised']]);
    expect(S().removedDocs.map((d) => d.text)).toEqual(['text 0']);
    expect(shownIn(run.id)).toEqual(['a0']);
  });

  it('keeps removed texts removed in a study backup and its copy', async () => {
    const run = await studyWithRun(2);
    await store.removeDocs([S().docs[0].id]);
    const copy = await importBackup(await buildBackup(store.currentStudy()!, all(), S().runs, false));
    await store.refreshStudies();
    await store.selectStudy(copy.id);
    expect(S().docs.map((d) => d.docId)).toEqual(['a1']);
    expect(S().removedDocs.map((d) => d.docId)).toEqual(['a0']);
    expect(shownIn(S().runs.find((r) => r.number === run.number)!.id)).toEqual(['a0', 'a1']);
  });

  it('drops removed texts once no run uses them (the run was deleted)', async () => {
    const run = await studyWithRun(2);
    await store.removeDocs(S().docs.map((d) => d.id));
    await store.removeRun(run.id);
    expect(S().removedDocs).toEqual([]);
    expect(await dbApi.getDocsForStudy(S().currentId!)).toEqual([]);
  });
});

describe('results of texts an earlier version deleted outright', () => {
  it('are reconnected to the identical texts added again, results, logs and the run alike', async () => {
    const run = await studyWithRun();
    const oldIds = S().docs.map((d) => d.id);
    // As the version before November 2026 did: the records deleted.
    await dbApi.deleteDocs(oldIds);
    await store.selectStudy(S().currentId!);
    expect(shownIn(run.id)).toEqual([]);
    await store.addDocs([file(0), file(1), file(2), file(3)]);
    await vi.waitFor(() => expect(S().runs[0].docIds).toEqual(S().docs.map((d) => d.id)));
    const newIds = S().docs.map((d) => d.id);
    expect(newIds.some((id) => oldIds.includes(id))).toBe(false);
    expect(shownIn(run.id)).toEqual(['a0', 'a1', 'a2', 'a3']);
    expect(S().results.map((r) => r.docId).sort()).toEqual([...newIds].sort());
    for (const r of S().results) expect((await dbApi.getLog(r.id))?.requestPart).toBeTruthy();
    expect(S().toasts.map((t) => t.text).some((t) => t.startsWith('Reconnected 4 earlier results to 4 texts'))).toBe(true);
    // A run made now on those texts compares with the old one.
    await store.startRun({ docIds: newIds, scope: 'all' });
    expect(S().runs.at(-1)!.docIds).toEqual(S().runs[0].docIds);
  });

  it('are reconnected when the study is opened, if the texts are already there; a text added only partly matches nothing', async () => {
    const run = await studyWithRun(3);
    const oldIds = S().docs.map((d) => d.id);
    await dbApi.deleteDocs(oldIds);
    // Two of the three added again (stored directly, as before this version).
    await dbApi.putDocs([0, 1].map((i) => ({ id: `new${i}`, studyId: S().currentId!, docId: `a${i}`, text: `text ${i}`, meta: { file: `a${i}.txt` }, source: `a${i}.txt`, order: 10 + i, addedAt: '' })));
    await store.selectStudy(S().currentId!);
    await vi.waitFor(() => expect(shownIn(run.id)).toEqual(['a0', 'a1']));
    expect(S().results.filter((r) => !r.docId.startsWith('new'))).toHaveLength(1);
  });
});

describe('matching a lost text by its logged request', () => {
  it('matches the identical request only, ignores a batch request’s name, and never guesses between two identical texts', async () => {
    const run = await studyWithRun(1);
    const doc = (id: string, docId: string, text: string) => ({ id, studyId: '', docId, text, meta: {}, source: '', order: 0, addedAt: '' });
    const part = JSON.parse(requestKey(run, doc('x', 'a', 'text 7'))) as Record<string, unknown>;
    expect(loggedKey({ custom_id: 'r3', ...part })).toBe(JSON.stringify(part));
    const lost = [{ id: 'old', run, requestPart: { custom_id: 'r0', ...part } }];
    expect([...matchLostTexts(lost, [doc('n1', 'a', 'text 7'), doc('n2', 'b', 'text 8')])]).toEqual([['old', 'n1']]);
    expect([...matchLostTexts(lost, [doc('n1', 'a', 'text 7 '), doc('n2', 'b', 'text 8')])]).toEqual([]);
    // The same text under two names, with a prompt that doesn't use the name: either could be it.
    expect([...matchLostTexts(lost, [doc('n1', 'a', 'text 7'), doc('n2', 'b', 'text 7')])]).toEqual([]);
  });
});
