import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Doc, Result, ResultLog, Run, Study } from './types';
import { runOrder } from './view';

interface DeskDB extends DBSchema {
  studies: { key: string; value: Study };
  docs: { key: string; value: Doc; indexes: { byStudy: string } };
  runs: { key: string; value: Run; indexes: { byStudy: string } };
  results: { key: string; value: Result; indexes: { byStudy: string; byRun: string } };
  logs: { key: string; value: ResultLog; indexes: { byStudy: string; byRun: string } };
}

let dbPromise: Promise<IDBPDatabase<DeskDB>> | null = null;

export function db(): Promise<IDBPDatabase<DeskDB>> {
  dbPromise ??= openDB<DeskDB>('annotation-desk', 1, {
    upgrade(d) {
      d.createObjectStore('studies', { keyPath: 'id' });
      d.createObjectStore('docs', { keyPath: 'id' }).createIndex('byStudy', 'studyId');
      d.createObjectStore('runs', { keyPath: 'id' }).createIndex('byStudy', 'studyId');
      const results = d.createObjectStore('results', { keyPath: 'id' });
      results.createIndex('byStudy', 'studyId');
      results.createIndex('byRun', 'runId');
      const logs = d.createObjectStore('logs', { keyPath: 'id' });
      logs.createIndex('byStudy', 'studyId');
      logs.createIndex('byRun', 'runId');
    },
  });
  return dbPromise;
}

export async function listStudies(): Promise<Study[]> {
  const all = await (await db()).getAll('studies');
  // A setting removed in October 2026 (the refusal fallback), still stored in studies made before: never used again.
  for (const s of all) delete (s.model as { refusalFallback?: unknown }).refusalFallback;
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function putStudy(s: Study) {
  await (await db()).put('studies', s);
}

export async function loadStudyData(studyId: string) {
  const d = await db();
  const [docs, runs, results] = await Promise.all([
    d.getAllFromIndex('docs', 'byStudy', studyId),
    d.getAllFromIndex('runs', 'byStudy', studyId),
    d.getAllFromIndex('results', 'byStudy', studyId),
  ]);
  docs.sort((a, b) => a.order - b.order);
  // (Runs that share a number, from an earlier version used in two tabs: the one started later last, as in the exports.)
  runs.sort(runOrder);
  // Texts removed from the study but kept for the runs that used them are held apart from the study's own.
  return { docs: docs.filter((d) => !d.removedAt), removedDocs: docs.filter((d) => !!d.removedAt), runs, results };
}

export async function getDocsForStudy(studyId: string): Promise<Doc[]> {
  return (await db()).getAllFromIndex('docs', 'byStudy', studyId);
}

export async function putDocs(docs: Doc[]) {
  const tx = (await db()).transaction('docs', 'readwrite');
  await Promise.all([...docs.map((x) => tx.store.put(x)), tx.done]);
}

export async function deleteDocs(ids: string[]) {
  const tx = (await db()).transaction('docs', 'readwrite');
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
}

/** Delete some texts and store others (e.g. marked removed) in one transaction: both, or (storage full) neither. */
export async function deleteAndPutDocs(ids: string[], docs: Doc[]) {
  const tx = (await db()).transaction('docs', 'readwrite');
  await Promise.all([...ids.map((id) => tx.store.delete(id)), ...docs.map((d) => tx.store.put(d)), tx.done]);
}

/**
 * Attach results stored under texts that no longer exist (`from`, deleted by a version before November 2026) to the
 * text each turned out to be (`to`): the results and logs of every run of the study get the new text's id, and the
 * runs list it. One transaction: all of it, or (e.g. storage full) nothing. A pair whose new ids are already taken
 * in a run (that run has both texts) is left as it is for that run. Returns the number of results moved.
 */
export async function reassignDocs(studyId: string, pairs: [string, string][]): Promise<number> {
  const tx = (await db()).transaction(['runs', 'results', 'logs'], 'readwrite');
  const runs = await tx.objectStore('runs').index('byStudy').getAll(studyId);
  let moved = 0;
  for (const run of runs) {
    let changed = false;
    for (const [from, to] of pairs) {
      if (!run.docIds.includes(from) && !Object.values(run.batch?.map ?? {}).some(([d]) => d === from)) continue;
      const range = (id: string) => IDBKeyRange.bound(`${run.id}:${id}:`, `${run.id}:${id}:\uffff`);
      // (A run that has both texts keeps them apart: nothing of it is moved.)
      if ((await tx.objectStore('results').count(range(to))) > 0 || run.docIds.includes(to)) continue;
      const rename = (id: string) => `${run.id}:${to}:${id.slice(`${run.id}:${from}:`.length)}`;
      for (const r of await tx.objectStore('results').getAll(range(from))) {
        await tx.objectStore('results').delete(r.id);
        await tx.objectStore('results').put({ ...r, id: rename(r.id), docId: to });
        moved++;
      }
      for (const l of await tx.objectStore('logs').getAll(range(from))) {
        await tx.objectStore('logs').delete(l.id);
        await tx.objectStore('logs').put({ ...l, id: rename(l.id) });
      }
      run.docIds = run.docIds.map((d) => (d === from ? to : d));
      if (run.batch) run.batch.map = Object.fromEntries(Object.entries(run.batch.map).map(([k, [d, rep]]) => [k, [d === from ? to : d, rep] as [string, number]]));
      changed = true;
    }
    if (changed) await tx.objectStore('runs').put(run);
  }
  await tx.done;
  return moved;
}

export async function putRun(r: Run) {
  await (await db()).put('runs', r);
}

export async function getRun(id: string): Promise<Run | undefined> {
  return (await db()).get('runs', id);
}

/**
 * Store a result and its log. When a retry replaces an earlier, failed attempt stored under the same id, that
 * attempt's log is kept as `${id}#${attempt}` (with its outcome and token use), so every request sent stays on
 * record, and its token use is added to `r.replacedUsage` (its request time to `r.replacedAt`); the earlier result is
 * returned (null if there was none).
 * `r.attempt` is set accordingly. `asToday`: reads the earlier attempt by today's rules (an answer an older version
 * stored as "ok" may count as failed now), so its log says why it was replaced.
 */
export async function putResult(r: Result, log: ResultLog | null, asToday?: (prev: Result) => void): Promise<Result | null> {
  const tx = (await db()).transaction(['results', 'logs'], 'readwrite');
  const results = tx.objectStore('results');
  const logs = tx.objectStore('logs');
  let replaced: Result | null = null;
  const prev = await results.get(r.id);
  // (The same answer stored again, e.g. batch results collected a second time, is not a new attempt.)
  if (prev && !(prev.requestedAt === r.requestedAt && prev.responseId === r.responseId)) {
    replaced = prev;
    const n = prev.attempt ?? 1;
    r.attempt = n + 1;
    const before = prev.replacedUsage;
    r.replacedUsage = Object.fromEntries(Object.entries(prev.usage).map(([k, v]) => [k, v + (before?.[k as keyof typeof before] ?? 0)])) as Result['usage'];
    // (And when it was sent, so a retry's requests can still be counted once a later retry has replaced them.)
    r.replacedAt = [...(prev.replacedAt ?? []), prev.requestedAt];
    const prevLog = await logs.get(r.id);
    const seen = { ...prev };
    asToday?.(seen);
    await logs.put({
      id: `${r.id}#${n}`,
      runId: prev.runId,
      studyId: prev.studyId,
      requestPart: prevLog?.requestPart ?? {},
      response: prevLog?.response ?? null,
      attempt: n,
      // (Settings of the run not sent with that request, e.g. the retired `fallbacks`, stay on record.)
      ...(prevLog?.omitted ? { omitted: prevLog.omitted } : {}),
      replaced: {
        status: seen.status,
        error: seen.error,
        parseError: seen.parseError,
        stopReason: prev.stopReason,
        usage: prev.usage,
        requestedAt: prev.requestedAt,
        completedAt: prev.completedAt,
      },
    });
  } else if (prev?.attempt) [r.attempt, r.replacedUsage, r.replacedAt] = [prev.attempt, prev.replacedUsage, prev.replacedAt];
  await results.put(r);
  if (log) await logs.put(log);
  await tx.done;
  return replaced;
}

/** Texts and the study in one transaction: both are saved, or neither (e.g. a drawn sample and its note). */
export async function putDocsAndStudy(docs: Doc[], study: Study) {
  const tx = (await db()).transaction(['docs', 'studies'], 'readwrite');
  await Promise.all([...docs.map((x) => tx.objectStore('docs').put(x)), tx.objectStore('studies').put(study), tx.done]);
}

export async function getResultsForRun(runId: string): Promise<Result[]> {
  return (await db()).getAllFromIndex('results', 'byRun', runId);
}

/** Every run of every study (e.g. to find a batch that a copy of a study also waits for). */
export async function listAllRuns(): Promise<Run[]> {
  return (await db()).getAll('runs');
}

/** Many results or logs in one transaction (used when importing a backup). */
export async function putMany(store: 'results' | 'logs', items: Result[] | ResultLog[]) {
  const tx = (await db()).transaction(store, 'readwrite');
  await Promise.all([...items.map((x) => tx.store.put(x as Result & ResultLog)), tx.done]);
}

export async function getLog(id: string): Promise<ResultLog | undefined> {
  return (await db()).get('logs', id);
}

export async function getLogsForRun(runId: string): Promise<ResultLog[]> {
  return (await db()).getAllFromIndex('logs', 'byRun', runId);
}

/**
 * A run's logs a page at a time, in id order, so that a full run (each log holds a whole text) never has to be in
 * memory at once. Log ids start with the run id, so a page is one key range of the store.
 */
export async function* logPagesForRun(runId: string, pageSize = 300): AsyncGenerator<ResultLog[]> {
  const keys = (await (await db()).getAllKeysFromIndex('logs', 'byRun', runId)).sort();
  for (let i = 0; i < keys.length; i += pageSize) {
    const page = keys.slice(i, i + pageSize);
    yield await (await db()).getAll('logs', IDBKeyRange.bound(page[0], page[page.length - 1]));
  }
}

/**
 * Deletes, in ONE transaction, every record of `stores` that `index` gives for `key`, and then `last`'s record: all of
 * it or (e.g. the browser's storage refuses) none of it, so a run or study is never left half deleted, with its
 * results gone while it still shows (and Retry failed would then send every text again).
 */
async function deleteAll(stores: ('docs' | 'runs' | 'results' | 'logs')[], index: 'byStudy' | 'byRun', key: string, last: ['runs' | 'studies', string]) {
  // Untyped view: the typed schema can't express "any store that has this index".
  const d = (await db()) as unknown as IDBPDatabase;
  const tx = d.transaction([...new Set([...stores, last[0]])], 'readwrite');
  const work: Promise<unknown>[] = [];
  try {
    for (const store of stores) {
      const keys = await tx.objectStore(store).index(index).getAllKeys(key);
      for (const k of keys) work.push(tx.objectStore(store).delete(k));
    }
    work.push(tx.objectStore(last[0]).delete(last[1]));
    await Promise.all([...work, tx.done]);
  } catch (e) {
    // (A failure the transaction itself didn't end with, e.g. one thrown while queuing: undo what was queued.)
    try {
      tx.abort();
    } catch {
      /* already ended */
    }
    await Promise.allSettled([...work, tx.done]);
    throw e;
  }
}

export async function deleteRun(runId: string) {
  await deleteAll(['results', 'logs'], 'byRun', runId, ['runs', runId]);
}

export async function deleteStudy(studyId: string) {
  await deleteAll(['docs', 'runs', 'results', 'logs'], 'byStudy', studyId, ['studies', studyId]);
}
