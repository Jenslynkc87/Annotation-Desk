// Tests for the lead's fixes after the recheck of the final round (October 24, 2026): a delete holds everything else
// back until it is done (no run, Retry failed or download meanwhile), and plain-text 0/1 scores against label columns
// are measured on a scale grown from 0…1, so a far code the model used (9 = can't tell) is left out and reported, while
// a −3…3 score that is mostly 0 or 1 keeps its other values.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareRows } from '../components/Workbench';
import { comparableFields, labelScale } from './compare';
import { agreementForRun } from './export/tables';
import * as store from './store';
import { buildDocViews } from './view';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type Run } from './types';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const text: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'text', variables: [] };
const mkRun = (docIds: string[], id = 'p'): Run => ({
  id, studyId: 's', number: 1, label: '', createdAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-24', mode: 'sync', scope: '', docIds, status: 'completed', batch: null, error: null,
  snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt: text, promptVersion: 1, promptHash: 'h', outputSchema: null, requestBase: {} },
});
const mkResult = (run: string, doc: string, o: Record<string, unknown>): Result => ({
  id: `${run}:${doc}:1`, runId: run, studyId: 's', docId: doc, replicate: 1, status: 'ok', values: { response: JSON.stringify(o) }, rationale: '', reasoningSummary: '', rawText: JSON.stringify(o),
  parseError: null, error: null, usage, latencyMs: 1, requestedAt: '', completedAt: '', responseId: `id-${run}-${doc}`, modelReported: 'm', stopReason: 'end_turn',
});
const mkDoc = (i: number, meta: Record<string, string>): Doc => ({ id: `d${i}`, studyId: 's', docId: `d${i}`, text: 't', meta: { file: `d${i}.md`, ...meta }, source: `d${i}.md`, order: i, addedAt: '' });

describe('plain-text 0/1 scores against label columns (labelScale)', () => {
  it('a 9 for can’t tell is left out and reported, in the exports and the Workbench, as against a Yes/no run', () => {
    // 100 texts: the model says 1 or 0 as the coder does, and 9 on 4 of them.
    const flag = (i: number) => (i % 3 === 0 ? 1 : 0);
    const docs = Array.from({ length: 100 }, (_, i) => mkDoc(i, { flag_gold: flag(i) ? 'yes' : 'no' }));
    const run = mkRun(docs.map((d) => d.id));
    const results = docs.map((d, i) => mkResult('p', d.id, { flag: i < 4 ? 9 : flag(i) }));
    const [row] = agreementForRun(run, docs, [run], results);
    expect([row.stats.n, row.stats.leftOut.n, row.stats.leftOut.values]).toEqual([96, 4, ['9']]);
    expect(row.stats.percentAgreement).toBe(1);
    // The Workbench's Disagree with: the 9s don't count as disagreements.
    const views = buildDocViews(docs, [run], results, run.id);
    const rows = compareRows('flag', 'flag_gold', docs, views);
    expect([...rows.values()].filter((r) => r.counts && r.value !== r.label).length).toBe(0);
    expect([...rows.values()].filter((r) => !r.counts).length).toBe(4);
  });

  it('a −3…3 score that is mostly 0 or 1 keeps its other values (labels and answers within 3 points)', () => {
    // 300 texts, nearly all 0 or 1; three answers of 2, −1 and 3, and the coder agrees on them.
    const score = (i: number) => (i === 10 ? 2 : i === 20 ? -1 : i === 30 ? 3 : i % 2);
    const docs = Array.from({ length: 300 }, (_, i) => mkDoc(i, { tone_gold: String(score(i)) }));
    const run = mkRun(docs.map((d) => d.id));
    const results = docs.map((d, i) => mkResult('p', d.id, { tone: score(i) }));
    const f = comparableFields(run, buildDocViews(docs, [run], results, run.id).values()).find((x) => x.key === 'tone')!;
    expect(f.zeroOne).toBe(true);
    expect(labelScale(f).range).toEqual([0, 1]);
    const [row] = agreementForRun(run, docs, [run], results);
    expect([row.stats.n, row.stats.leftOut.n, row.stats.percentAgreement]).toEqual([300, 0, 1]);
    expect(row.stats.leftOut.range).toEqual([-1, 3]);
  });

  it('other plain-text scores are unchanged', () => {
    const f = { key: 'x', label: 'x', level: 'ordinal' as const, allowed: ['-3', '3'], scaleSeen: true, range: [-3, 3] as [number, number], yesNo: false, zeroOne: false };
    expect(labelScale(f)).toBe(f);
  });
});

describe('a delete holds everything else back until it is done (lead)', () => {
  const confirms: string[] = [];
  beforeEach(() => {
    confirms.length = 0;
    vi.stubGlobal('fetch', async (u: unknown) => {
      throw new Error(`unexpected request: ${String(u)}`);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('while a study is being deleted the page is busy: no run, Retry failed or download starts, and it ends free', async () => {
    await store.createStudy('Keep');
    await store.createStudy('Delete me');
    const id = store.currentStudy()!.id;
    await store.addDocs([{ docId: 't1', text: 'x', meta: {}, source: 't1.txt' }]);
    let busyDuring: boolean | null = null;
    // The batch-check wait inside the delete: observe the state while the delete is under way.
    const del = vi.spyOn((await import('./db')), 'deleteStudy').mockImplementation(async () => {
      busyDuring = store.isBusy();
      const before = store.getState().toasts.length;
      await store.startRun({ docIds: store.getState().docs.map((d) => d.id), scope: 'all' });
      // Refused: the page is busy, nothing was sent (fetch would throw).
      expect(store.getState().toasts.length).toBeGreaterThan(before);
    });
    (globalThis as Record<string, unknown>).confirm = (m: string) => (confirms.push(m), true);
    await store.removeStudy(id);
    expect(del).toHaveBeenCalled();
    expect(busyDuring).toBe(true);
    expect(store.getState().deletingWhat).toBe('');
    expect(store.isBusy()).toBe(false);
    expect(store.currentStudy()!.name).toBe('Keep');
  });
});

describe('re-importing a paragraph table whose IDs are built from the file name (M11 residual)', () => {
  it('a new paragraph art1_5 reading like art1_2 is added, not taken for it', async () => {
    const { sortAddition } = await import('./dedupe');
    const row = (n: number, words: string) => ({ docId: `art1_${n}`, text: words, meta: { file: 'art1' }, source: 'paras.csv' });
    const stored: Doc[] = [row(1, 'Intro'), row(2, 'Notes'), row(3, 'Body')].map((r, i) => ({ id: `x${i}`, studyId: 's', ...r, order: i, addedAt: '' }));
    const again = sortAddition([row(1, 'Intro'), row(2, 'Notes'), row(3, 'Body'), row(5, 'Notes')], stored);
    expect(again.kept.map((r) => r.docId)).toEqual(['art1_5']);
    expect(again.already).toBe(3);
  });
});

describe('the short check after the final round (lead)', () => {
  it('a percentage or 0–10 score that is mostly 0 is not a 0/1 item: its values are kept against labels', () => {
    // 200 texts, 85% scored 0, the rest a spread of percentages; the coder agrees on all but two.
    const pct = (i: number) => (i % 7 === 0 ? [10, 25, 40, 60, 75, 90][i % 6] : 0);
    const docs = Array.from({ length: 200 }, (_, i) => mkDoc(i, { share_gold: String(i === 7 || i === 14 ? 5 : pct(i)) }));
    const run = mkRun(docs.map((d) => d.id));
    const results = docs.map((d, i) => mkResult('p', d.id, { share: pct(i) }));
    const f = comparableFields(run, buildDocViews(docs, [run], results, run.id).values()).find((x) => x.key === 'share')!;
    expect(f.zeroOne).toBe(false);
    const [row] = agreementForRun(run, docs, [run], results);
    expect([row.stats.n, row.stats.leftOut.n]).toEqual([200, 0]);
    expect(row.stats.percentAgreement).toBeCloseTo(198 / 200, 12);
  });

  it('a 0/1 item with a 9 for can’t tell is still one (the 9s look like a code)', () => {
    const docs = Array.from({ length: 100 }, (_, i) => mkDoc(i, {}));
    const run = mkRun(docs.map((d) => d.id));
    const results = docs.map((d, i) => mkResult('p', d.id, { flag: i < 4 ? 9 : i % 2 }));
    const f = comparableFields(run, buildDocViews(docs, [run], results, run.id).values()).find((x) => x.key === 'flag')!;
    expect(f.zeroOne).toBe(true);
  });

  it('a run or study is deleted in one transaction: if storage refuses, nothing of it is removed', async () => {
    const dbApi = await import('./db');
    await store.createStudy('Atomic');
    const ids = (await store.addDocs([1, 2, 3].map((i) => ({ docId: `t${i}`, text: `x${i}`, meta: {}, source: `t${i}.txt` })))) && store.getState().docs.map((d) => d.id);
    const studyId = store.currentStudy()!.id;
    const run: Run = { ...mkRun(ids || []), id: 'atomic-run', studyId };
    await dbApi.putRun(run);
    for (const d of ids || []) await dbApi.putResult({ ...mkResult('atomic-run', d, { flag: 1 }), studyId, runId: 'atomic-run', id: `atomic-run:${d}:1` }, { id: `atomic-run:${d}:1`, runId: 'atomic-run', studyId, requestPart: {}, response: {} } as never);
    // The logs store refuses its deletes, as a full disk may: the whole delete is undone.
    const orig = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      if (this.name === 'logs') throw new DOMException('full', 'QuotaExceededError');
      return orig.call(this, key);
    };
    try {
      await expect(dbApi.deleteRun('atomic-run')).rejects.toBeTruthy();
      await expect(dbApi.deleteStudy(studyId)).rejects.toBeTruthy();
    } finally {
      IDBObjectStore.prototype.delete = orig;
    }
    expect((await dbApi.getResultsForRun('atomic-run')).length).toBe(3);
    expect(await dbApi.getRun('atomic-run')).toBeTruthy();
    expect((await dbApi.getDocsForStudy(studyId)).length).toBe(3);
  });
});

describe('Retry failed never sends more than the page shows as failed (lead)', () => {
  it('refuses when fewer results are stored than the page shows', async () => {
    const dbApi = await import('./db');
    vi.stubGlobal('fetch', async (u: unknown) => {
      throw new Error(`unexpected request: ${String(u)}`);
    });
    await store.createStudy('Bound');
    store.setKey('anthropic', 'sk-ant-test');
    store.setKey('openai', 'sk-test');
    await store.addDocs([1, 2, 3, 4].map((i) => ({ docId: `b${i}`, text: `y${i}`, meta: {}, source: `b${i}.txt` })));
    const studyId = store.currentStudy()!.id;
    const ids = store.getState().docs.map((d) => d.id);
    const run: Run = { ...mkRun(ids), id: 'bound-run', studyId };
    await dbApi.putRun(run);
    for (const [i, d] of ids.entries()) {
      const r = { ...mkResult('bound-run', d, { flag: 1 }), studyId, id: `bound-run:${d}:1`, ...(i === 3 ? { status: 'error' as const, error: 'overloaded' } : {}) };
      await dbApi.putResult(r, { id: r.id, runId: 'bound-run', studyId, requestPart: {}, response: {} } as never);
    }
    await store.selectStudy(studyId);
    expect(store.getState().results.filter((r) => r.runId === 'bound-run').length).toBe(4);
    // Two stored results gone (e.g. a delete that stopped part-way in an earlier version).
    const d = await dbApi.db();
    await d.delete('results', `bound-run:${ids[0]}:1`);
    await d.delete('results', `bound-run:${ids[1]}:1`);
    await store.retryFailed('bound-run');
    expect(store.getState().toasts.some((t) => t.text.includes('fewer results are stored than this page shows'))).toBe(true);
    vi.unstubAllGlobals();
  });
});
