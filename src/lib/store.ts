import { useSyncExternalStore } from 'react';
import * as dbApi from './db';
import { buildOutputSchema, effectiveTemplate, parseModelOutput, renderMessageParts } from './prompt';
import { describeApiError, provider } from './providers';
import { rejectsTemperature } from './providers/anthropic';
import type { BatchLine, CallOutcome, ModelInfo } from './providers/types';
import { ZERO_USAGE } from './providers/types';
import {
  DEFAULT_MODEL_SETTINGS,
  DEFAULT_PROMPT,
  DEFAULT_RUN_OPTIONS,
  type Doc,
  type ProviderId,
  type Result,
  type ResultLog,
  type Run,
  type RunOptions,
  type RunSnapshot,
  type Study,
} from './types';
import { errorMessage, nowIso, shortHash, uid } from './util';

export interface Job {
  runId: string;
  total: number;
  done: number;
  failed: number;
  abort: AbortController;
}

export interface Toast {
  id: string;
  kind: 'info' | 'error' | 'success';
  text: string;
}

export interface State {
  ready: boolean;
  studies: Study[];
  currentId: string | null;
  docs: Doc[];
  runs: Run[];
  results: Result[];
  keys: Record<ProviderId, string>;
  rememberKeys: boolean;
  models: Record<ProviderId, ModelInfo[] | null>;
  modelsStatus: Record<ProviderId, 'idle' | 'loading' | 'ok' | 'error'>;
  modelsError: Record<ProviderId, string>;
  job: Job | null;
  toasts: Toast[];
  saving: boolean;
}

const KEY_STORAGE = 'annotation-desk-keys';
const LAST_STUDY = 'annotation-desk-last-study';

function loadSavedKeys(): { keys: Record<ProviderId, string>; remember: boolean } {
  try {
    const raw = localStorage.getItem(KEY_STORAGE);
    if (raw) return { keys: { anthropic: '', openai: '', ...JSON.parse(raw) }, remember: true };
  } catch {
    /* storage unavailable */
  }
  return { keys: { anthropic: '', openai: '' }, remember: false };
}

const saved = loadSavedKeys();

let state: State = {
  ready: false,
  studies: [],
  currentId: null,
  docs: [],
  runs: [],
  results: [],
  keys: saved.keys,
  rememberKeys: saved.remember,
  models: { anthropic: null, openai: null },
  modelsStatus: { anthropic: 'idle', openai: 'idle' },
  modelsError: { anthropic: '', openai: '' },
  job: null,
  toasts: [],
  saving: false,
};

const listeners = new Set<() => void>();
function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  listeners.forEach((l) => l());
}
export function getState(): State {
  return state;
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export function currentStudy(s: State = state): Study | null {
  return s.studies.find((x) => x.id === s.currentId) ?? null;
}

// ---------- toasts ----------

export function toast(text: string, kind: Toast['kind'] = 'info') {
  const t = { id: uid(), kind, text };
  set((s) => ({ toasts: [...s.toasts, t] }));
  setTimeout(() => dismissToast(t.id), kind === 'error' ? 9000 : 4500);
}
export function dismissToast(id: string) {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

// ---------- studies ----------

export function newStudy(name = 'Untitled study'): Study {
  const t = nowIso();
  return {
    id: uid(),
    name,
    description: '',
    createdAt: t,
    updatedAt: t,
    model: { ...DEFAULT_MODEL_SETTINGS },
    options: { ...DEFAULT_RUN_OPTIONS },
    prompt: structuredClone(DEFAULT_PROMPT),
  };
}

export async function init() {
  let studies = await dbApi.listStudies();
  if (!studies.length) {
    const s = newStudy('My first study');
    await dbApi.putStudy(s);
    studies = [s];
  }
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_STUDY);
  } catch {
    /* ignore */
  }
  const currentId = studies.find((s) => s.id === last)?.id ?? studies[0].id;
  set({ studies, ready: true });
  await selectStudy(currentId);
  startBatchPolling();
}

export async function refreshStudies() {
  set({ studies: await dbApi.listStudies() });
}

export async function selectStudy(id: string) {
  if (state.job) {
    toast('Finish or cancel the running job before switching studies.', 'error');
    return;
  }
  const data = await dbApi.loadStudyData(id);
  // Older versions stored unreadable answers as "ok"; count them as failed like new ones.
  for (const r of data.results) if (r.status === 'ok' && r.parseError) r.status = 'error';
  // Runs left "running" by a closed tab can't continue: mark them interrupted.
  for (const r of data.runs) {
    if (r.status === 'running') {
      r.status = 'cancelled';
      r.error = 'Interrupted (the page was closed or reloaded while running). Completed results were kept.';
      r.finishedAt ??= nowIso();
      await dbApi.putRun(r);
    }
  }
  try {
    localStorage.setItem(LAST_STUDY, id);
  } catch {
    /* ignore */
  }
  set({ currentId: id, ...data });
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
const dirty = new Set<string>();
export function updateStudy(mutate: (s: Study) => void) {
  const cur = currentStudy();
  if (!cur) return;
  const next = structuredClone(cur);
  mutate(next);
  next.updatedAt = nowIso();
  dirty.add(next.id);
  set((s) => ({ studies: s.studies.map((x) => (x.id === next.id ? next : x)), saving: true }));
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushStudies, 400);
}

async function flushStudies() {
  saveTimer = null;
  const ids = [...dirty];
  dirty.clear();
  for (const id of ids) {
    const st = state.studies.find((x) => x.id === id);
    if (st) await dbApi.putStudy(st);
  }
  set({ saving: false });
}

// Don't lose a pending edit when the tab is closed.
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => void flushStudies());

export async function createStudy(name: string) {
  const s = newStudy(name);
  await dbApi.putStudy(s);
  set((st) => ({ studies: [s, ...st.studies] }));
  await selectStudy(s.id);
}

export async function duplicateStudy(withCorpus: boolean) {
  const cur = currentStudy();
  if (!cur) return;
  const copy: Study = { ...structuredClone(cur), id: uid(), name: `${cur.name} (copy)`, createdAt: nowIso(), updatedAt: nowIso() };
  await dbApi.putStudy(copy);
  if (withCorpus) {
    await dbApi.putDocs(state.docs.map((d) => ({ ...d, id: uid(), studyId: copy.id })));
  }
  set((st) => ({ studies: [copy, ...st.studies] }));
  await selectStudy(copy.id);
}

export async function removeStudy(id: string) {
  await dbApi.deleteStudy(id);
  const studies = state.studies.filter((s) => s.id !== id);
  set({ studies });
  if (!studies.length) {
    await createStudy('My first study');
  } else if (state.currentId === id) {
    await selectStudy(studies[0].id);
  }
}

// ---------- corpus ----------

export async function addDocs(items: { docId: string; text: string; meta: Record<string, string>; source: string }[]) {
  const cur = currentStudy();
  if (!cur || !items.length) return;
  const taken = new Set(state.docs.map((d) => d.docId));
  let order = state.docs.reduce((m, d) => Math.max(m, d.order), 0);
  const t = nowIso();
  const renamed: string[] = [];
  const docs: Doc[] = items.map((it) => {
    let docId = it.docId.trim() || `text_${order + 1}`;
    if (taken.has(docId)) {
      let k = 2;
      while (taken.has(`${docId}_${k}`)) k++;
      renamed.push(`${docId} → ${docId}_${k}`);
      docId = `${docId}_${k}`;
    }
    taken.add(docId);
    order++;
    return { id: uid(), studyId: cur.id, docId, text: it.text, meta: it.meta, source: it.source, order, addedAt: t };
  });
  await dbApi.putDocs(docs);
  set((s) => ({ docs: [...s.docs, ...docs] }));
  toast(`Added ${docs.length} text${docs.length === 1 ? '' : 's'}.`, 'success');
  if (renamed.length) {
    toast(`${renamed.length} ID${renamed.length === 1 ? ' was' : 's were'} already in use and got a suffix: ${renamed.slice(0, 3).join(', ')}${renamed.length > 3 ? ', …' : ''}`, 'error');
  }
}

export async function removeDocs(ids: string[]) {
  await dbApi.deleteDocs(ids);
  const drop = new Set(ids);
  set((s) => ({ docs: s.docs.filter((d) => !drop.has(d.id)) }));
}

// ---------- keys & models ----------

export function setKey(p: ProviderId, key: string) {
  set((s) => ({ keys: { ...s.keys, [p]: key.trim() }, models: { ...s.models, [p]: null }, modelsStatus: { ...s.modelsStatus, [p]: 'idle' } }));
  persistKeys();
}

export function setRememberKeys(remember: boolean) {
  set({ rememberKeys: remember });
  persistKeys();
}

function persistKeys() {
  try {
    if (state.rememberKeys) localStorage.setItem(KEY_STORAGE, JSON.stringify(state.keys));
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* ignore */
  }
}

export async function loadModels(p: ProviderId) {
  const key = state.keys[p];
  if (!key) return;
  set((s) => ({ modelsStatus: { ...s.modelsStatus, [p]: 'loading' }, modelsError: { ...s.modelsError, [p]: '' } }));
  try {
    const models = await provider(p).listModels(key);
    set((s) => ({ models: { ...s.models, [p]: models }, modelsStatus: { ...s.modelsStatus, [p]: 'ok' } }));
  } catch (e) {
    set((s) => ({ modelsStatus: { ...s.modelsStatus, [p]: 'error' }, modelsError: { ...s.modelsError, [p]: describeApiError(e) } }));
  }
}

// ---------- runs ----------

export async function promptFingerprint(st: Study): Promise<string> {
  const p = st.prompt;
  return shortHash(
    JSON.stringify({
      system: p.system,
      userTemplate: effectiveTemplate(p.userTemplate),
      outputMode: p.outputMode,
      variables: p.outputMode === 'structured' ? p.variables : [],
      includeRationale: p.outputMode === 'structured' && p.includeRationale,
    }),
  );
}

/** Prompt version numbers: identical prompts share a number; each new prompt gets the next one. */
export function versionFor(hash: string, runs: Run[]): number {
  const existing = runs.find((r) => r.snapshot.promptHash === hash);
  if (existing) return existing.snapshot.promptVersion;
  return runs.reduce((m, r) => Math.max(m, r.snapshot.promptVersion), 0) + 1;
}

export async function buildSnapshot(st: Study, batch = false): Promise<RunSnapshot> {
  const promptHash = await promptFingerprint(st);
  const outputSchema = buildOutputSchema(st.prompt);
  const adapter = provider(st.model.provider);
  const model = structuredClone(st.model);
  // Record only what is sent: these models take no temperature.
  if (model.provider === 'anthropic' && rejectsTemperature(model.model)) model.temperature = null;
  // Anthropic cache lifetime: 5 minutes between immediate requests; 1 hour for batches, which are
  // processed over a longer period (as Anthropic recommends).
  const options: RunOptions = { ...structuredClone(st.options), cacheTtl: batch ? '1h' : '5m' };
  return {
    appVersion: __APP_VERSION__,
    model,
    options,
    prompt: structuredClone(st.prompt),
    promptVersion: versionFor(promptHash, state.runs),
    promptHash,
    outputSchema,
    requestBase: adapter.buildRequestBase({
      model,
      options,
      system: st.prompt.system,
      outputSchema,
      promptHash,
    }),
  };
}

function makeResult(run: Run, doc: Doc, replicate: number, requestedAt: string, outcome: CallOutcome | null, error: string | null, latencyMs: number | null): Result {
  const parsed = outcome ? parseModelOutput(outcome.rawText, run.snapshot.prompt) : { values: {}, rationale: '', parseError: null };
  const empty = outcome?.rawText === '' && !!outcome.stopReason && outcome.stopReason !== 'end_turn' && outcome.stopReason !== 'completed';
  // An answer that can't be read (e.g. cut off at the token limit) has no usable labels: it counts as failed.
  const failed = !!error || empty || !!parsed.parseError;
  return {
    id: `${run.id}:${doc.id}:${replicate}`,
    runId: run.id,
    studyId: run.studyId,
    docId: doc.id,
    replicate,
    status: failed ? 'error' : 'ok',
    values: parsed.values,
    rationale: parsed.rationale,
    reasoningSummary: outcome?.reasoningSummary ?? '',
    rawText: outcome?.rawText ?? '',
    parseError: parsed.parseError,
    error: error ?? (empty ? `Empty response (stop reason: ${outcome?.stopReason})` : null),
    usage: outcome?.usage ?? { ...ZERO_USAGE },
    latencyMs,
    requestedAt,
    completedAt: nowIso(),
    responseId: outcome?.responseId ?? '',
    modelReported: outcome?.modelReported ?? '',
    stopReason: outcome?.stopReason ?? '',
  };
}

async function saveRun(run: Run) {
  await dbApi.putRun(run);
  set((s) => ({ runs: s.runs.some((r) => r.id === run.id) ? s.runs.map((r) => (r.id === run.id ? run : r)) : [...s.runs, run] }));
}

// Results arrive quickly during a run; flush them to the UI in small batches.
let pendingResults: Result[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
function queueResult(r: Result) {
  pendingResults.push(r);
  flushTimer ??= setTimeout(flushResults, 250);
}
function flushResults() {
  flushTimer = null;
  if (!pendingResults.length) return;
  const incoming = new Map(pendingResults.map((r) => [r.id, r]));
  pendingResults = [];
  set((s) => ({ results: [...s.results.filter((r) => !incoming.has(r.id)), ...incoming.values()] }));
}

export interface RunRequest {
  docIds: string[];
  scope: string;
  /** Force a synchronous run even when batch mode is on (used for quick tests). */
  forceSync?: boolean;
}

export async function startRun(req: RunRequest): Promise<void> {
  const st = currentStudy();
  if (!st) return;
  if (state.job) return toast('A run is already in progress.', 'error');
  const key = state.keys[st.model.provider];
  if (!key) return toast(`Add your ${provider(st.model.provider).label} API key first (API keys, top right).`, 'error');
  if (!st.model.model) return toast('Choose a model first.', 'error');
  if (!req.docIds.length) return toast('No texts in this selection.', 'error');
  if (st.prompt.outputMode === 'structured' && !st.prompt.variables.length) {
    return toast('Add at least one output field, or switch the output to plain text.', 'error');
  }

  const batch = st.options.batch && !req.forceSync;
  const snapshot = await buildSnapshot(st, batch);
  const run: Run = {
    id: uid(),
    studyId: st.id,
    number: state.runs.reduce((m, r) => Math.max(m, r.number), 0) + 1,
    label: '',
    createdAt: nowIso(),
    finishedAt: null,
    mode: batch ? 'batch' : 'sync',
    scope: req.scope,
    docIds: req.docIds,
    status: batch ? 'submitted' : 'running',
    snapshot,
    batch: null,
    error: null,
  };
  const docsById = new Map(state.docs.map((d) => [d.id, d]));
  const adapter = provider(snapshot.model.provider);
  const tasks: { doc: Doc; replicate: number; part: Record<string, unknown> }[] = [];
  for (const id of req.docIds) {
    const doc = docsById.get(id);
    if (!doc) continue;
    const part = adapter.buildRequestPart(renderMessageParts(snapshot.prompt.userTemplate, doc), snapshot.options, snapshot.model.model);
    for (let r = 1; r <= snapshot.options.replicates; r++) tasks.push({ doc, replicate: r, part });
  }

  if (batch) {
    const map: Record<string, [string, number]> = {};
    const items = tasks.map((t, i) => {
      const customId = `r${i}`;
      map[customId] = [t.doc.id, t.replicate];
      return { customId, part: t.part };
    });
    try {
      toast(`Submitting batch of ${items.length} request${items.length === 1 ? '' : 's'}…`);
      const handle = await adapter.submitBatch(key, snapshot.requestBase, items);
      run.batch = { provider: snapshot.model.provider, batchId: handle.batchId, inputFileId: handle.inputFileId, map, lastStatus: 'submitted', lastCheckedAt: nowIso() };
      await saveRun(run);
      toast(`Batch submitted (run #${run.number}). Results usually arrive within an hour; this page checks every minute while open.`, 'success');
    } catch (e) {
      toast(`Batch submission failed: ${describeApiError(e)}`, 'error');
    }
    return;
  }

  await saveRun(run);
  const job: Job = { runId: run.id, total: tasks.length, done: 0, failed: 0, abort: new AbortController() };
  set({ job });
  const signal = job.abort.signal;
  let next = 0;
  const worker = async () => {
    while (next < tasks.length && !signal.aborted) {
      const t = tasks[next++];
      const requestedAt = nowIso();
      const started = performance.now();
      let outcome: CallOutcome | null = null;
      let error: string | null = null;
      try {
        outcome = await adapter.send(key, snapshot.requestBase, t.part, signal);
      } catch (e) {
        if (signal.aborted) return;
        error = describeApiError(e);
      }
      const result = makeResult(run, t.doc, t.replicate, requestedAt, outcome, error, Math.round(performance.now() - started));
      const log: ResultLog = { id: result.id, runId: run.id, studyId: run.studyId, requestPart: t.part, response: outcome?.response ?? { error } };
      await dbApi.putResult(result, log);
      queueResult(result);
      const failed = result.status === 'error';
      set((s) => (s.job ? { job: { ...s.job, done: s.job.done + 1, failed: s.job.failed + (failed ? 1 : 0) } } : {}));
      // Stop early when every request so far failed: almost certainly a configuration problem.
      const j = getState().job;
      if (j && j.done >= 3 && j.failed === j.done) {
        job.abort.abort();
        run.error = `Stopped after ${j.done} consecutive errors: ${result.error}`;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(snapshot.options.concurrency, tasks.length)) }, worker));
  flushResults();
  const final = getState().job;
  run.status = signal.aborted ? (run.error ? 'failed' : 'cancelled') : 'completed';
  run.finishedAt = nowIso();
  await saveRun(run);
  set({ job: null });
  if (run.status === 'completed') {
    const f = final?.failed ?? 0;
    toast(`Run #${run.number} finished: ${(final?.done ?? 0) - f} ok${f ? `, ${f} failed` : ''}.`, f ? 'error' : 'success');
  } else if (run.status === 'failed') {
    toast(run.error ?? 'Run failed', 'error');
  } else {
    toast(`Run #${run.number} cancelled. Completed results were kept.`);
  }
}

export function cancelJob() {
  state.job?.abort.abort();
}

export async function deleteRunById(runId: string) {
  await dbApi.deleteRun(runId);
  set((s) => ({ runs: s.runs.filter((r) => r.id !== runId), results: s.results.filter((r) => r.runId !== runId) }));
}

export async function renameRun(runId: string, label: string) {
  const run = state.runs.find((r) => r.id === runId);
  if (!run) return;
  await saveRun({ ...run, label });
}

// ---------- batches ----------

const checking = new Set<string>();

export async function checkBatch(runId: string, quiet = false) {
  const run = state.runs.find((r) => r.id === runId);
  if (!run?.batch || run.status !== 'submitted' || checking.has(runId)) return;
  const key = state.keys[run.batch.provider];
  if (!key) {
    if (!quiet) toast(`Add your ${provider(run.batch.provider).label} key to check this batch.`, 'error');
    return;
  }
  checking.add(runId);
  try {
    const adapter = provider(run.batch.provider);
    const st = await adapter.checkBatch(key, run.batch.batchId);
    const updated: Run = { ...run, batch: { ...run.batch, lastStatus: `${st.status} · ${st.completed + st.failed}/${st.total}`, lastCheckedAt: nowIso() } };
    if (st.done) {
      const lines = await adapter.fetchBatchResults(key, run.batch.batchId);
      const counts = await storeBatchResults(updated, lines);
      updated.status = 'completed';
      updated.finishedAt = nowIso();
      if (!lines.length) updated.error = `Batch ended with status "${st.status}" and returned no results.`;
      toast(`Batch run #${run.number} finished: ${counts.ok} ok, ${counts.failed} failed.`, counts.failed || !lines.length ? 'error' : 'success');
    } else if (!quiet) {
      toast(`Batch run #${run.number}: ${st.status}, ${st.completed + st.failed} of ${st.total} done.`);
    }
    await saveRun(updated);
  } catch (e) {
    if (!quiet) toast(`Could not check batch: ${describeApiError(e)}`, 'error');
  } finally {
    checking.delete(runId);
  }
}

async function storeBatchResults(run: Run, lines: BatchLine[]): Promise<{ ok: number; failed: number }> {
  const docsById = new Map(state.docs.map((d) => [d.id, d]));
  const adapter = provider(run.snapshot.model.provider);
  const counts = { ok: 0, failed: 0 };
  for (const line of lines) {
    const ref = run.batch!.map[line.customId];
    if (!ref) continue;
    const doc = docsById.get(ref[0]);
    if (!doc) continue; // text deleted since submission
    const result = makeResult(run, doc, ref[1], run.createdAt, line.ok ? line.outcome : null, line.ok ? null : line.error, null);
    const part = adapter.buildRequestPart(renderMessageParts(run.snapshot.prompt.userTemplate, doc), run.snapshot.options, run.snapshot.model.model);
    const log: ResultLog = {
      id: result.id,
      runId: run.id,
      studyId: run.studyId,
      requestPart: { custom_id: line.customId, ...part },
      response: line.ok ? line.outcome.response : line.response ?? { error: line.error },
    };
    await dbApi.putResult(result, log);
    queueResult(result);
    counts[result.status === 'ok' ? 'ok' : 'failed']++;
  }
  flushResults();
  return counts;
}

export async function cancelBatch(runId: string) {
  const run = state.runs.find((r) => r.id === runId);
  if (!run?.batch) return;
  try {
    await provider(run.batch.provider).cancelBatch(state.keys[run.batch.provider], run.batch.batchId);
    toast('Cancellation requested. Results finished before cancelling will still be collected.');
  } catch (e) {
    toast(`Could not cancel: ${errorMessage(e)}`, 'error');
  }
}

let polling = false;
function startBatchPolling() {
  if (polling) return;
  polling = true;
  const tick = () => {
    for (const r of state.runs) if (r.status === 'submitted') void checkBatch(r.id, true);
  };
  setInterval(tick, 60_000);
  setTimeout(tick, 3000);
}
