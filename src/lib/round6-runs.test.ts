// Tests for the sixth round of fixes (batches found for either of two lost uploads, adding texts again under other
// IDs, samples drawn around earlier samples), after the sixth verification of October 24, 2026.
// Providers are stubbed: nothing is sent anywhere (any request that does reach `fetch` fails the test).
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dbApi from './db';
import { buildBackup, importBackup } from './export/backup';
import { anthropicAdapter } from './providers/anthropic';
import type { BatchItem, CallOutcome, ListedBatch, ProviderAdapter } from './providers/types';
import { dependentSamples, drawStratifiedSample, replaceSampleNotes, sampleNote, takenNote, type SampleOptions } from './sample';
import * as store from './store';
import type { Doc, PromptSpec, Run } from './types';
import { retriedRequests } from './view';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const outcome = (rawText: string): CallOutcome => ({ rawText, reasoningSummary: '', usage, responseId: `id_${Math.random()}`, modelReported: 'm', stopReason: 'end_turn', response: {} });
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
beforeEach(() => {
  confirms.length = 0;
  (globalThis as Record<string, unknown>).confirm = (m: string) => (confirms.push(m), true);
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
const docIds = () => store.getState().docs.map((d) => d.docId);

/** A provider's batches, as a stub of the adapter (as in round5-runs.test.ts): uploads that can arrive without an
 *  answer, listing (cancelled batches marked as stopped), checking, results named by their request, cancelling. */
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
  vi.spyOn(adapter, 'checkBatch').mockImplementation(async (_k, id) => {
    const b = made.find((x) => x.id === id);
    return { status: b?.done ? 'ended' : 'in_progress', done: !!b?.done, total: b?.items.length ?? 0, completed: 0, failed: 0, endedAt: b?.done ? new Date().toISOString() : undefined };
  });
  vi.spyOn(adapter, 'fetchBatchResults').mockImplementation(async (_k, id) => {
    const b = made.find((x) => x.id === id)!;
    return b.items.map((it) =>
      b.cancelled || id === failing
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
    cancel,
    uploads: (f: (n: number) => 'ok' | 'lost' | Error) => (upload = f),
    finishAll: () => made.forEach((b) => (b.done = true)),
    /** Every answer of this batch comes back failed. */
    failAll: (id: string) => (failing = id),
  };
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

// ---------- K1, K5: a batch found as either's is credited to the retry whose names its answers carry ----------

describe('a lost retry upload found as either’s, after an earlier lost retry upload (K1, K5)', () => {
  /** A batch run whose 3 answers all failed (b1); Retry failed R1's upload reaches Anthropic (b2) without an answer and
   *  the lookup fails; Retry failed R2: its lookup fails, the owner sends again, and that upload never arrives. */
  async function twoLostRetries(lookupAfterR2: 'finds' | 'fails') {
    const ids = await freshStudy(3);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    p.failAll('b1');
    await store.startRun({ docIds: ids, scope: 'all' });
    const runId = lastRun().id;
    p.finishAll();
    await store.checkBatch(runId);
    p.uploads(() => 'lost');
    p.list.mockRejectedValueOnce(connectionError());
    await store.retryFailed(runId);
    const r1 = runById(runId).batch!.uploadUnknown!.retryAt!;
    p.list.mockRejectedValueOnce(connectionError());
    if (lookupAfterR2 === 'fails') p.list.mockRejectedValueOnce(connectionError());
    p.uploads(() => connectionError());
    await new Promise((r) => setTimeout(r, 5));
    await store.retryFailed(runId);
    return { p, runId, r1 };
  }

  it('found by the lookup right after the second upload: counted as the first retry, whose names the answers carry', async () => {
    const { p, runId, r1 } = await twoLostRetries('finds');
    expect(store.batchParts(runById(runId))[1].eitherRetry?.earlierAt).toBe(r1);
    p.finishAll();
    await store.checkBatch(runId);
    const run = runById(runId);
    expect(run.retries).toEqual([{ at: r1, requests: 3, asBatch: true, counted: 'sent' }]);
    expect(retriedRequests(run, store.getState().results).requests).toBe(3);
    expect(store.batchParts(run).every((x) => !x.eitherRetry)).toBe(true);
  });

  it('found by a third Retry failed: the same, and its message gives both uploads’ times to the second (K23)', async () => {
    const { p, runId, r1 } = await twoLostRetries('fails');
    const slot = runById(runId).batch!.uploadUnknown!;
    expect(slot.earlier?.retryAt).toBe(r1);
    await store.retryFailed(runId);
    expect(p.submit).toHaveBeenCalledTimes(3);
    const found = toasts().find((t) => t.startsWith('Found a batch'))!;
    expect(found.match(/\d{2}:\d{2}:\d{2}/g)).toHaveLength(2);
    p.finishAll();
    await store.checkBatch(runId);
    expect(runById(runId).retries).toEqual([{ at: r1, requests: 3, asBatch: true, counted: 'sent' }]);
  });
});

// ---------- K4, K9: a batch a delete found as either's is remembered under both uploads' times ----------

describe('a backup restored after a delete found the batch of a retry’s lost upload as either’s (K4, K9)', () => {
  /** U1 got no answer (b1 created), the lookup failed; a backup is taken; Retry failed sends again and that upload
   *  never arrives (lookups failing), so the run's upload of unknown outcome is the retry's (A2, with U1 as earlier). */
  async function lostTwice() {
    const ids = await freshStudy(3);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    p.uploads(() => 'lost');
    p.list.mockRejectedValueOnce(connectionError());
    await store.startRun({ docIds: ids, scope: 'all' });
    const older = await backupNow();
    p.list.mockRejectedValueOnce(connectionError()).mockRejectedValueOnce(connectionError());
    p.uploads(() => connectionError());
    await store.retryFailed(lastRun().id);
    p.uploads(() => 'ok');
    expect(lastRun().batch!.uploadUnknown!.earlier).toBeTruthy();
    return { p, older, runId: lastRun().id };
  }

  for (const how of ['run', 'study'] as const) {
    for (const batch of ['ended', 'running'] as const) {
      it(`deleting the ${how} (b1 ${batch}), then the backup taken before the retry: Retry failed adopts b1`, async () => {
        const { p, older, runId } = await lostTwice();
        if (batch === 'ended') p.made[0].done = true;
        if (how === 'run') await store.removeRun(runId);
        else await store.removeStudy(store.currentStudy()!.id);
        if (batch === 'ended') expect(confirms.at(-1)).toMatch(/, or its earlier upload of .*\d{2}:\d{2}:\d{2}, did arrive \(b1\)/);
        await restore(older);
        confirms.length = 0;
        p.submit.mockClear();
        await store.retryFailed(lastRun().id);
        expect([confirms, p.submit.mock.calls.length, partIds(lastRun())]).toEqual([[], 0, ['b1']]);
      });
    }
  }

  it('the backup taken after the retry (its upload on record) adopts b1 as either’s, and its answers count no retry (review)', async () => {
    const { p, runId } = await lostTwice();
    const newer = await backupNow();
    p.made[0].done = true;
    await store.removeRun(runId);
    await restore(newer);
    confirms.length = 0;
    p.submit.mockClear();
    await store.retryFailed(lastRun().id);
    expect([confirms, p.submit.mock.calls.length, partIds(lastRun())]).toEqual([[], 0, ['b1']]);
    expect(store.batchParts(lastRun())[0].eitherRetry).toBeTruthy();
    await store.checkBatch(lastRun().id);
    const run = lastRun();
    expect([run.status, run.retries, retriedRequests(run, store.getState().results).requests]).toEqual(['completed', undefined, 0]);
  });

  it('adopted as either’s, then deleted while running (cancelled): a backup with the retry’s upload adopts it', async () => {
    const { p, runId } = await lostTwice();
    const newer = await backupNow();
    await store.retryFailed(runId);
    expect(store.batchParts(runById(runId))[0].eitherRetry).toBeTruthy();
    await store.removeRun(runId);
    expect(p.made[0].cancelled).toBe(true);
    await restore(newer);
    confirms.length = 0;
    p.submit.mockClear();
    await store.retryFailed(lastRun().id);
    expect([confirms, p.submit.mock.calls.length, partIds(lastRun())]).toEqual([[], 0, ['b1']]);
  });
});

// ---------- K16: a batch found as either's, collected while the run's record can't be saved ----------

describe('a batch found as either’s whose run record failed to save twice (K16)', () => {
  it('the retry’s upload is not brought back as of unknown outcome at the next check', async () => {
    const ids = await freshStudy(3);
    batchStudy();
    const p = fakeBatches(anthropicAdapter);
    p.uploads(() => 'lost');
    p.list.mockRejectedValueOnce(connectionError());
    await store.startRun({ docIds: ids, scope: 'all' });
    const runId = lastRun().id;
    // Retry failed: the lookup fails, the retry's upload never arrives, the lookup after it finds b1 (either's); the
    // save right after that fails.
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
    // The check that collects b1 can't save the run's record either; the next one can.
    p.finishAll();
    const put2 = vi.spyOn(dbApi, 'putRun').mockRejectedValue(quotaError());
    await store.checkBatch(runId, true);
    put2.mockRestore();
    await store.checkBatch(runId, true);
    const run = runById(runId);
    const db = (await dbApi.getRun(runId))!;
    expect([run.status, run.batch?.uploadUnknown, run.error]).toEqual(['completed', undefined, null]);
    expect([db.batch?.uploadUnknown, db.batch?.uploading]).toEqual([undefined, undefined]);
    expect(toasts().some((t) => t.includes('may or may not have reached'))).toBe(false);
  });
});

// ---------- K10, K17, K18, K26: adding texts or entries ----------

describe('adding rows: own IDs within one import, made-up IDs across imports (K10, K17, K18, K26)', () => {
  it('rows with IDs of their own and a repeated file column are all added', async () => {
    await emptyDatabase();
    await store.createStudy('Utterances');
    const row = (id: string, speaker: string, text: string) => ({ docId: id, text, meta: { file: 'interview03.docx', speaker }, source: 'utterances.csv' });
    const before = toasts().length;
    await store.addDocs([row('u1', 'A', 'Yes.'), row('u2', 'B', 'Why?'), row('u3', 'A', 'Yes.'), row('u4', 'B', 'No.')]);
    expect(docIds()).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(toasts().slice(before).some((t) => t.includes('included twice'))).toBe(false);
  });

  it('an entries table pasted again whose automatic ID moved to another column adds only the new row', async () => {
    await emptyDatabase();
    await store.createStudy('Books', 'entries');
    // (As the import dialog makes them: the automatic ID is the first ticked column whose values all differ.)
    const books = (rows: string[][], id: 'author' | 'title') =>
      rows.map(([author, title, rating]) => ({ docId: id === 'author' ? author : title, text: `author: ${author}\ntitle: ${title}`, meta: { author, title, my_rating: rating }, source: 'pasted' }));
    const first = [
      ['Karen Blixen', 'Out of Africa', '3'],
      ['Tove Ditlevsen', 'Childhood', '2'],
      ['Peter Høeg', 'Smilla’s Sense of Snow', '2'],
      ['Inger Christensen', 'Alphabet', '3'],
    ];
    await store.addDocs(books(first, 'author'));
    // A sample marked since (a column the pasted rows don't have) doesn't make them new.
    await store.markSample('sample', 'pilot', [store.getState().docs[0].id], 'Sample sample = pilot (2026-10-24): 1 of 4 entries drawn at random; seed 1 (x).', 1);
    const before = toasts().length;
    await store.addDocs(books([...first, ['Karen Blixen', 'Babette’s Feast', '1']], 'title'));
    expect(docIds()).toEqual(['Karen Blixen', 'Tove Ditlevsen', 'Peter Høeg', 'Inger Christensen', 'Babette’s Feast']);
    expect(toasts().slice(before)).toContain(
      'Skipped 4 entries already in this study under another ID (identical details and columns): Out of Africa (stored as Karen Blixen), Childhood (stored as Tove Ditlevsen), Smilla’s Sense of Snow (stored as Peter Høeg), ….',
    );
  });

  it('a repeated name makes the automatic ID the country: the entry already here is not added again', async () => {
    await emptyDatabase();
    await store.createStudy('People', 'entries');
    const person = (id: string, name: string, country: string) => ({ docId: id, text: `name: ${name}\ncountry: ${country}`, meta: { name, country, my_fame: '1' }, source: 'pasted' });
    await store.addDocs([person('John Smith', 'John Smith', 'UK'), person('John Smith', 'John Smith', 'US')]);
    expect(docIds()).toEqual(['John Smith', 'John Smith_2']);
    await store.addDocs([person('UK', 'John Smith', 'UK'), person('USA', 'John Smith', 'USA')]);
    expect(docIds()).toEqual(['John Smith', 'John Smith_2', 'USA']);
  });

  it('a numbered table imported again with a row inserted adds only that row', async () => {
    await emptyDatabase();
    await store.createStudy('Numbered');
    const numbered = (texts: string[]) => texts.map((text, i) => ({ docId: `corpus_${i + 1}`, text, meta: { era: '1990s' }, source: 'corpus.csv' }));
    await store.addDocs(numbered(['Alpha article text.', 'Beta article text.', 'Gamma article text.']));
    const again = numbered(['New first article.', 'Alpha article text.', 'Beta article text.', 'Gamma article text.']);
    // (What an import dialog can count before adding.)
    const plan = store.sortAddition(again, store.getState().docs);
    expect([plan.kept.map((x) => x.text), plan.already, plan.elsewhere.length, plan.twice]).toEqual([['New first article.'], 0, 3, []]);
    await store.addDocs(again);
    expect(store.getState().docs.map((d) => [d.docId, d.text])).toEqual([
      ['corpus_1', 'Alpha article text.'],
      ['corpus_2', 'Beta article text.'],
      ['corpus_3', 'Gamma article text.'],
      ['corpus_1_2', 'New first article.'],
    ]);
  });

  it('a row with an ID of its own is added even when its text and other columns equal a stored one', async () => {
    await emptyDatabase();
    await store.createStudy('Own IDs');
    await store.addDocs([{ docId: 'u1', text: 'Yes.', meta: { speaker: 'A' }, source: 'part1.csv' }]);
    await store.addDocs([{ docId: 'u9', text: 'Yes.', meta: { speaker: 'A' }, source: 'part2.csv' }]);
    expect(docIds()).toEqual(['u1', 'u9']);
  });
});

// ---------- K0, K8, K21, K24: a sample drawn around an earlier one stays reproducible ----------

describe('a sample drawn around an earlier sample in its column (K0, K8, K21, K24)', () => {
  const w = { one: 'text', many: 'texts' };
  const today = new Date().toISOString().slice(0, 10);
  /** Draw and mark a sample as the dialog does (its note included). */
  async function draw(value: string, size: number, seed: number) {
    const o = { size, strata: ['era'], exclude: null, seed, markedAs: { column: 'sample', value } } satisfies SampleOptions;
    const r = drawStratifiedSample(store.getState().docs, o);
    const note = sampleNote({ column: 'sample', value, date: today, strata: o.strata, exclude: null, seed }, r, w, store.currentStudy()!.description);
    await store.markSample('sample', value, r.ids, note, seed);
    return r.ids;
  }
  const marked = (value: string) => store.getState().docs.filter((d) => d.meta.sample === value).map((d) => d.id).sort();

  it('names the earlier draw it left out, keeps that draw’s note when it is redrawn, and can be drawn again from the notes', async () => {
    await emptyDatabase();
    await store.createStudy('Samples');
    await store.addDocs(Array.from({ length: 300 }, (_, i) => ({ docId: `a${i}`, text: `text ${i}`, meta: { file: `a${String(i).padStart(3, '0')}.txt`, era: ['1960s', '1980s', '2000s'][i % 3] }, source: 'x' })));
    await draw('validation', 20, 11);
    const holdout = await draw('holdout', 100, 22);
    const notes = () => store.currentStudy()!.description.split('\n');
    expect(notes()[1]).toContain(`not from the 20 texts already marked sample = validation (drawn ${today}, 20 of 300 texts, seed 11); seed 22`);
    expect(dependentSamples(store.currentStudy()!.description, 'sample', 'validation', w)).toEqual(['sample = holdout']);
    // Validation redrawn larger with another seed: its first note is kept, marked as replaced.
    await draw('validation', 40, 44);
    expect(notes()).toHaveLength(3);
    expect(notes()[0]).toMatch(new RegExp(`^\\(replaced ${today}\\) Sample sample = validation \\(${today}\\): 20 of 300 texts .*; seed 11 `));
    expect(notes()[2]).toContain('40 of 200 texts');
    // Nothing depends on the second validation draw: a third replaces its note.
    expect(dependentSamples(store.currentStudy()!.description, 'sample', 'validation', w)).toEqual([]);
    await draw('validation', 30, 55);
    expect(notes()).toHaveLength(3);
    expect([notes()[0].includes('seed 11'), notes()[1].startsWith('Sample sample = holdout'), notes()[2].startsWith(`Sample sample = validation (${today}): 30 of 200`)]).toEqual([true, true, true]);
    expect(notes().some((l) => l.includes('seed 44'))).toBe(false);
    // From the notes alone: the first validation draw on the texts without marks, then the holdout draw around it.
    const bare: Doc[] = store.getState().docs.map((d) => ({ ...d, meta: { file: d.meta.file, era: d.meta.era } }));
    const v1 = drawStratifiedSample(bare, { size: 20, strata: ['era'], exclude: null, seed: 11, markedAs: { column: 'sample', value: 'validation' } }).ids;
    const withV1 = bare.map((d) => (v1.includes(d.id) ? { ...d, meta: { ...d.meta, sample: 'validation' } } : d));
    const again = drawStratifiedSample(withV1, { size: 100, strata: ['era'], exclude: null, seed: 22, markedAs: { column: 'sample', value: 'holdout' } }).ids;
    expect(again.sort()).toEqual([...holdout].sort());
    expect(marked('holdout')).toEqual([...holdout].sort());
  });

  it('a note depends only on the value and draw it names', () => {
    const v = 'Sample sample = validation (2026-10-24): 20 of 300 texts drawn at random; seed 11 (Annotation Desk sampling method 3).';
    const other = (named: string) => `Sample sample = holdout (2026-10-24): 100 of 280 texts drawn at random, not from the 20 texts already marked ${named}; seed 22 (x).`;
    expect(replaceSampleNotes(`${v}\n${other('sample = validation 2 (drawn 2026-10-24, 20 of 300 texts, seed 11)')}`, 'sample', 'validation', today)).not.toContain('replaced');
    expect(replaceSampleNotes(`${v}\n${other('sample = validation (drawn 2026-10-24, 20 of 300 texts, seed 12)')}`, 'sample', 'validation', today)).not.toContain('replaced');
    expect(replaceSampleNotes(`${v}\n${other('sample = validation (drawn 2026-10-24, 20 of 300 texts, seed 11)')}`, 'sample', 'validation', today)).toMatch(/^\(replaced /);
    // (Notes of October 24, 2026 name no draw: kept to be safe.)
    expect(replaceSampleNotes(`${v}\n${other('sample = validation')}`, 'sample', 'validation', today)).toMatch(/^\(replaced /);
  });

  it('marks added otherwise are named as such; without the notes the wording is as before', () => {
    const r = { ids: [], strata: [], eligible: 0, taken: [{ value: 'validation', n: 20 }] };
    expect(takenNote(r, 'sample', w, '')).toBe('not from the 20 texts already marked sample = validation (no draw recorded)');
    expect(takenNote(r, 'sample')).toBe('not from the 20 texts already marked sample = validation');
  });

  it('a redraw with the recorded seed and size on the same day is told apart from the draw it replaced (review)', async () => {
    await emptyDatabase();
    await store.createStudy('Same seed');
    await store.addDocs(Array.from({ length: 300 }, (_, i) => ({ docId: `a${i}`, text: `text ${i}`, meta: { file: `a${String(i).padStart(3, '0')}.txt`, era: ['1960s', '1980s', '2000s'][i % 3] }, source: 'x' })));
    await draw('validation', 20, 99);
    await draw('holdout', 100, 5);
    // Redrawn with its recorded seed and size (e.g. to restore it): the holdout texts are left out now, so it is
    // another draw (20 of 200), which the holdout's note doesn't name.
    await draw('validation', 20, 99);
    const lines = () => store.currentStudy()!.description.split('\n');
    expect(lines()[1]).toContain(`sample = validation (drawn ${today}, 20 of 300 texts, seed 99); seed 5`);
    expect(dependentSamples(store.currentStudy()!.description, 'sample', 'validation', w)).toEqual([]);
    await draw('validation', 30, 7);
    expect(lines().filter((l) => l.startsWith('(replaced '))).toHaveLength(1);
    expect(lines()[0]).toMatch(/^\(replaced [-\d]+\) Sample sample = validation \([-\d]+\): 20 of 300 texts .*; seed 99 /);
  });
});

describe('review of the sixth round: adding rows again', () => {
  it('an entry whose blank answer a label sheet has removed since is still recognized under another ID', async () => {
    await emptyDatabase();
    await store.createStudy('People again', 'entries');
    const person = (id: string, name: string, country: string) => ({ docId: id, text: `name: ${name}\ncountry: ${country}`, meta: { name, country, my_fame: '' }, source: 'pasted' });
    await store.addDocs([person('Niels Bohr', 'Niels Bohr', 'Denmark'), person('Karen Blixen', 'Karen Blixen', 'Kenya')]);
    // A label sheet that leaves Niels Bohr's answer blank removes the column from that entry.
    await store.addLabels(new Map(), new Map([[store.getState().docs[0].id, ['my_fame']]]));
    expect('my_fame' in store.getState().docs[0].meta).toBe(false);
    // Pasted again with a second Niels Bohr: the automatic ID moves to the country.
    await store.addDocs([person('Denmark', 'Niels Bohr', 'Denmark'), person('Sweden', 'Niels Bohr', 'Sweden'), person('Kenya', 'Karen Blixen', 'Kenya')]);
    expect(docIds()).toEqual(['Niels Bohr', 'Karen Blixen', 'Sweden']);
  });
});
