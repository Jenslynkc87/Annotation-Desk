import { useSyncExternalStore } from 'react';
import * as dbApi from './db';
import { buildOutputSchema, effectiveTemplate, parseModelOutput, renderMessageParts } from './prompt';
import { describeApiError, isPermanentError, provider } from './providers';
import { rejectsTemperature } from './providers/anthropic';
import type { BatchLine, CallOutcome, ModelInfo } from './providers/types';
import { ZERO_USAGE } from './providers/types';
import {
  DEFAULT_MODEL_SETTINGS,
  DEFAULT_PROMPT,
  DEFAULT_RUN_OPTIONS,
  type BatchPart,
  type Doc,
  type PromptSpec,
  type ProviderId,
  type Result,
  type ResultLog,
  type Run,
  type RunOptions,
  type RunSnapshot,
  type Study,
} from './types';
import { words } from './subject';
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
  /** Set while a run is being prepared or a batch uploaded (before `job` exists): nothing else may start. */
  submitting: string;
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
  submitting: '',
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

/** A run is being sent, or being prepared or uploaded. */
export function isBusy(s: State = state): boolean {
  return !!s.job || !!s.submitting;
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

export function newStudy(name = 'Untitled study', subject?: PromptSpec['subject']): Study {
  const t = nowIso();
  return {
    id: uid(),
    name,
    description: '',
    createdAt: t,
    updatedAt: t,
    model: { ...DEFAULT_MODEL_SETTINGS },
    options: { ...DEFAULT_RUN_OPTIONS },
    prompt: { ...structuredClone(DEFAULT_PROMPT), ...(subject ? { subject } : {}) },
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
  if (isBusy()) {
    toast('Finish or cancel the running job before switching studies.', 'error');
    return;
  }
  const data = await dbApi.loadStudyData(id);
  // Older versions stored unreadable, cut-off or refused answers as "ok"; count them as failed like new ones.
  for (const r of data.results) {
    if (r.status !== 'ok') continue;
    if (r.parseError) r.status = 'error';
    else if (incompleteAnswer(r.stopReason)) {
      r.status = 'error';
      r.error ??= incompleteMessage(r.rawText, r.stopReason);
    }
  }
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

export async function createStudy(name: string, subject?: PromptSpec['subject']) {
  const s = newStudy(name, subject);
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
  if (isBusy()) return toast('Finish or cancel the running job first.', 'error');
  // Batches still processing would keep running (and be charged) with nowhere to deliver their results.
  for (const r of id === state.currentId ? state.runs : []) if (r.status === 'submitted') await cancelBatch(r.id);
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

/** What a text is called where it came from: its file name, else its ID. */
const nameOf = (x: { docId: string; meta: Record<string, string> }) => x.meta.file || x.docId.trim();

export async function addDocs(items: { docId: string; text: string; meta: Record<string, string>; source: string }[]) {
  const cur = currentStudy();
  if (!cur || !items.length) return;
  // A text that is already here (same name, identical text), e.g. after dropping the whole folder again to add
  // a few new files, is skipped rather than added again as a copy. Same name with a different text is added.
  const present = new Map<string, string[]>();
  for (const d of state.docs) present.set(nameOf(d), [...(present.get(nameOf(d)) ?? []), d.text]);
  const w = words(cur.prompt);
  const before = items.length;
  items = items.filter((it) => {
    const texts = present.get(nameOf(it)) ?? [];
    if (texts.includes(it.text)) return false;
    present.set(nameOf(it), [...texts, it.text]);
    return true;
  });
  const skipped = before - items.length;
  if (skipped) toast(`Skipped ${skipped.toLocaleString()} ${skipped === 1 ? w.one : w.many} already in this study (same name and identical ${w.one === 'entry' ? 'details' : 'text'}).`);
  if (!items.length) return;
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
  toast(`Added ${docs.length} ${docs.length === 1 ? w.one : w.many}.`, 'success');
  // Ask the browser not to clear this site's data when disk space runs low (some browsers ask the user once).
  void navigator.storage?.persist?.().catch(() => undefined);
  if (renamed.length) {
    toast(`${renamed.length} ID${renamed.length === 1 ? ' was' : 's were'} already in use and got a suffix: ${renamed.slice(0, 3).join(', ')}${renamed.length > 3 ? ', …' : ''}`, 'error');
  }
}

/** Add label columns (e.g. human codes) to existing texts. Only metadata changes; texts are untouched. */
export async function addLabels(updates: Map<string, Record<string, string>>) {
  const changed = state.docs.filter((d) => updates.has(d.id)).map((d) => ({ ...d, meta: { ...d.meta, ...updates.get(d.id) } }));
  if (!changed.length) return;
  await dbApi.putDocs(changed);
  const byId = new Map(changed.map((d) => [d.id, d]));
  set((s) => ({ docs: s.docs.map((d) => byId.get(d.id) ?? d) }));
  toast(`Added labels to ${changed.length} text${changed.length === 1 ? '' : 's'}.`, 'success');
}

/**
 * Mark a drawn sample: `column` = `value` on these texts, removed from texts marked by an earlier draw.
 * `note` (the rule and seed) is added to the study description, which is exported with the study.
 */
export async function markSample(column: string, value: string, ids: string[], note: string, seed: number) {
  const chosen = new Set(ids);
  const changed: Doc[] = [];
  for (const d of state.docs) {
    const marked = d.meta[column] === value;
    if (chosen.has(d.id) && !marked) changed.push({ ...d, meta: { ...d.meta, [column]: value } });
    else if (!chosen.has(d.id) && marked) {
      const { [column]: _old, ...rest } = d.meta;
      changed.push({ ...d, meta: rest });
    }
  }
  await dbApi.putDocs(changed);
  const byId = new Map(changed.map((d) => [d.id, d]));
  set((s) => ({ docs: s.docs.map((d) => byId.get(d.id) ?? d) }));
  updateStudy((s) => void (s.description = `${s.description.trim() ? s.description.trim() + '\n' : ''}${note}`));
  toast(`Marked ${ids.length} text${ids.length === 1 ? '' : 's'} as ${column} = ${value} (seed ${seed}). The rule and seed are in the Excel Settings sheet and the supplementary metadata.`, 'success');
}

export async function removeDocs(ids: string[]) {
  // Only texts of the open study (a selection must never reach into another study).
  const own = new Set(state.docs.map((d) => d.id));
  ids = ids.filter((id) => own.has(id));
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
      userTemplate: effectiveTemplate(p.userTemplate, p.subject),
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

/** Stop reasons of a complete answer. Anything else (cut off at the token limit, refused, …) is not one. */
const COMPLETE_STOPS = new Set(['', 'end_turn', 'stop_sequence', 'completed']);
export function incompleteAnswer(stopReason: string): boolean {
  return !COMPLETE_STOPS.has(stopReason);
}

function makeResult(run: Run, doc: Doc, replicate: number, requestedAt: string, outcome: CallOutcome | null, error: string | null, latencyMs: number | null): Result {
  const parsed = outcome ? parseModelOutput(outcome.rawText, run.snapshot.prompt) : { values: {}, rationale: '', parseError: null };
  // An answer that was cut off or refused, or can't be read, has no usable labels: it counts as failed.
  // (Plain prose cut off at the token limit would otherwise pass as a complete answer.)
  const incomplete = !!outcome && incompleteAnswer(outcome.stopReason);
  const failed = !!error || incomplete || !!parsed.parseError;
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
    error: error ?? (incomplete ? incompleteMessage(outcome!.rawText, outcome!.stopReason) : null),
    usage: outcome?.usage ?? { ...ZERO_USAGE },
    latencyMs,
    requestedAt,
    completedAt: nowIso(),
    responseId: outcome?.responseId ?? '',
    modelReported: outcome?.modelReported ?? '',
    stopReason: outcome?.stopReason ?? '',
  };
}

function incompleteMessage(rawText: string, stopReason: string): string {
  return `${rawText ? 'Incomplete answer' : 'Empty response'} (stop reason: ${stopReason})`;
}

async function saveRun(run: Run) {
  await dbApi.putRun(run);
  // The study may have been switched while a batch was being collected: only the open study's runs are in view.
  if (state.currentId !== run.studyId) return;
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
  if (isBusy()) return toast('A run is already in progress.', 'error');
  const key = state.keys[st.model.provider];
  if (!key) return toast(`Add your ${provider(st.model.provider).label} API key first (API keys, top right).`, 'error');
  if (!st.model.model) return toast('Choose a model first.', 'error');
  if (!req.docIds.length) return toast('No texts in this selection.', 'error');
  if (st.prompt.outputMode === 'structured' && !st.prompt.variables.length) {
    return toast('Add at least one output field, or switch the output to plain text.', 'error');
  }

  // Marked busy right away (before any waiting), so a second click can't start the same run twice.
  set({ submitting: 'Preparing…' });
  let started: { run: Run; tasks: Task[] } | null = null;
  try {
    started = await prepareRun(st, req, key);
  } finally {
    set({ submitting: '' });
  }
  // Nothing is awaited between clearing `submitting` and sendTasks setting `job`.
  if (started) await sendTasks(started.run, started.tasks, key, `Run #${started.run.number} finished`);
}

/** Creates the run. A batch is submitted here (returns null); an immediate run returns the requests to send. */
async function prepareRun(st: Study, req: RunRequest, key: string): Promise<{ run: Run; tasks: Task[] } | null> {
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
  const tasks = buildTasks(run, () => true);

  if (batch) {
    const map: Record<string, [string, number]> = {};
    const items = tasks.map((t, i) => {
      const customId = `r${i}`;
      map[customId] = [t.doc.id, t.replicate];
      return { customId, part: t.part };
    });
    await submitBatches(run, key, items, map, []);
    return null;
  }

  await saveRun(run);
  return { run, tasks };
}

/** Size limits of the providers' batch APIs (checked October 2026). */
const BATCH_LIMITS: Record<ProviderId, { mb: number; requests: number }> = {
  anthropic: { mb: 256, requests: 100_000 },
  openai: { mb: 200, requests: 50_000 },
};

type BatchItem = { customId: string; part: Record<string, unknown> };

/** The size of each request as uploaded, in bytes. */
function requestBytes(base: Record<string, unknown>, items: BatchItem[]): number[] {
  const enc = new TextEncoder();
  return items.map((it) => enc.encode(JSON.stringify({ custom_id: it.customId, params: { ...base, ...it.part } })).length);
}

/** Requests (by position) grouped into batches within the provider's limits, keeping their order. A small margin
 *  is kept, as the upload adds some wrapping and a refusal comes only after a long upload. */
export function groupForBatches(p: ProviderId, sizes: number[]): number[][] {
  const limit = BATCH_LIMITS[p];
  const maxBytes = 0.95 * limit.mb * 1e6;
  const groups: number[][] = [[]];
  let bytes = 0;
  sizes.forEach((size, i) => {
    const g = groups[groups.length - 1];
    if (g.length && (bytes + size > maxBytes || g.length >= limit.requests)) {
      groups.push([i]);
      bytes = size;
    } else {
      g.push(i);
      bytes += size;
    }
  });
  return groups;
}

/** For the confirmation before a batch run: its size, and how many batches it is sent as. */
export function batchPlan(st: Study, docs: Doc[]): { mb: number; batches: number; limitMb: number; provider: string } {
  const adapter = provider(st.model.provider);
  const options = { ...st.options, cacheTtl: '1h' as const };
  const base = adapter.buildRequestBase({ model: st.model, options, system: st.prompt.system, outputSchema: buildOutputSchema(st.prompt), promptHash: '' });
  const items: BatchItem[] = [];
  for (const d of docs) {
    const part = adapter.buildRequestPart(renderMessageParts(st.prompt.userTemplate, d, st.prompt.subject), options, st.model.model);
    for (let r = 1; r <= st.options.replicates; r++) items.push({ customId: `r${items.length}`, part });
  }
  const sizes = requestBytes(base, items);
  return { mb: sizes.reduce((s, x) => s + x, 0) / 1e6, batches: groupForBatches(st.model.provider, sizes).length, limitMb: BATCH_LIMITS[st.model.provider].mb, provider: adapter.label };
}

/** The batches of a batch run (older runs have one, recorded only as `batchId`). */
export function batchParts(run: Run): BatchPart[] {
  if (!run.batch) return [];
  return run.batch.parts ?? [{ batchId: run.batch.batchId, inputFileId: run.batch.inputFileId, status: run.status === 'submitted' ? 'submitted' : 'collected', lastStatus: run.batch.lastStatus }];
}

/**
 * Upload requests as one batch, or several when they are over the provider's limit, adding them to the run's
 * earlier batches (for a retry). The run is saved after each upload, so a batch that went up is never lost.
 */
async function submitBatches(run: Run, key: string, items: BatchItem[], map: Record<string, [string, number]>, earlier: BatchPart[]) {
  const { snapshot } = run;
  const adapter = provider(snapshot.model.provider);
  const groups = groupForBatches(snapshot.model.provider, requestBytes(snapshot.requestBase, items)).map((g) => g.map((i) => items[i]));
  const parts = [...earlier];
  let sent = 0;
  for (const [g, group] of groups.entries()) {
    const which = groups.length > 1 ? `batch ${g + 1} of ${groups.length}` : 'a batch';
    set({ submitting: `Uploading ${which} (${group.length.toLocaleString()} request${group.length === 1 ? '' : 's'}) to ${adapter.label}…` });
    try {
      const h = await adapter.submitBatch(key, snapshot.requestBase, group);
      parts.push({ batchId: h.batchId, inputFileId: h.inputFileId, status: 'submitted', lastStatus: 'submitted' });
    } catch (e) {
      const rest = sent ? ` The ${sent} already submitted continue; send the rest with Retry failed when ${sent === 1 ? 'it has' : 'they have'} finished.` : '';
      toast(`Submitting ${which} failed: ${describeApiError(e)}.${rest}`, 'error');
      break;
    }
    sent++;
    run.batch = { provider: snapshot.model.provider, batchId: parts[0].batchId, inputFileId: parts[0].inputFileId, map, lastStatus: 'submitted', lastCheckedAt: nowIso(), parts };
    run.status = 'submitted';
    run.finishedAt = null;
    await saveRun(run);
  }
  if (sent && sent === groups.length) {
    toast(`${sent > 1 ? `${sent} batches` : 'Batch'} submitted (run #${run.number}). Results usually arrive within an hour; this page checks every minute while open.`, 'success');
  }
}

type Task = { doc: Doc; replicate: number; part: Record<string, unknown> };

/** Requests for a run's texts × replicates (those `include` accepts), built from the run's frozen settings. */
function buildTasks(run: Run, include: (docId: string, replicate: number) => boolean): Task[] {
  const docsById = new Map(state.docs.map((d) => [d.id, d]));
  const { snapshot } = run;
  const adapter = provider(snapshot.model.provider);
  const tasks: Task[] = [];
  for (const id of run.docIds) {
    const doc = docsById.get(id);
    if (!doc) continue;
    const part = adapter.buildRequestPart(renderMessageParts(snapshot.prompt.userTemplate, doc, snapshot.prompt.subject), snapshot.options, snapshot.model.model);
    for (let r = 1; r <= snapshot.options.replicates; r++) if (include(doc.id, r)) tasks.push({ doc, replicate: r, part });
  }
  return tasks;
}

/**
 * Send requests one by one (several in parallel), storing each result in the run as it arrives.
 * `retryOf`: the run's status and error before a retry; a retry that is stopped early leaves the run as it was.
 */
async function sendTasks(run: Run, tasks: Task[], key: string, doneMessage: string, retryOf?: Pick<Run, 'status' | 'error'>) {
  const { snapshot } = run;
  const adapter = provider(snapshot.model.provider);
  const job: Job = { runId: run.id, total: tasks.length, done: 0, failed: 0, abort: new AbortController() };
  set({ job });
  const signal = job.abort.signal;
  let next = 0;
  const worker = async () => {
    try {
      await sendSome();
    } catch (e) {
      // Anything unexpected: stop every worker, so the run doesn't count as finished while requests go on.
      if (!run.error) run.error = `Stopped by an unexpected error: ${errorMessage(e)}`;
      job.abort.abort();
    }
  };
  const sendSome = async () => {
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
      try {
        await dbApi.putResult(result, log);
      } catch (e) {
        // Without a saved result, sending more would only pay for answers that are lost.
        if (!signal.aborted) run.error = `Stopped: a result could not be saved in this browser (${errorMessage(e)}). Is the disk or the browser's storage full?`;
        job.abort.abort();
        return;
      }
      queueResult(result);
      const failed = result.status === 'error';
      set((s) => (s.job ? { job: { ...s.job, done: s.job.done + 1, failed: s.job.failed + (failed ? 1 : 0) } } : {}));
      // Stop early when every request so far failed: almost certainly a configuration problem.
      const j = getState().job;
      if (j && j.done >= 3 && j.failed === j.done) {
        job.abort.abort();
        run.error = `${retryOf ? 'Retry stopped' : 'Stopped'} after ${j.done} consecutive errors: ${result.error}`;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(snapshot.options.concurrency, tasks.length)) }, worker));
  } finally {
    await finishTasks(run, job, doneMessage, retryOf);
  }
}

async function finishTasks(run: Run, job: Job, doneMessage: string, retryOf?: Pick<Run, 'status' | 'error'>) {
  const signal = job.abort.signal;
  flushResults();
  const final = getState().job;
  const stoppedByErrors = signal.aborted && !!run.error;
  run.status = !signal.aborted ? 'completed' : retryOf && retryOf.status !== 'running' ? retryOf.status : stoppedByErrors ? 'failed' : 'cancelled';
  if (retryOf && signal.aborted && !stoppedByErrors) run.error = retryOf.error;
  run.finishedAt = nowIso();
  try {
    await saveRun(run);
  } catch (e) {
    toast(`Could not save run #${run.number}: ${errorMessage(e)}`, 'error');
  } finally {
    set({ job: null });
  }
  if (!signal.aborted) {
    const f = final?.failed ?? 0;
    toast(`${doneMessage}: ${(final?.done ?? 0) - f} ok${f ? `, ${f} failed. Retry them in the same run under Runs & agreement` : ''}.`, f ? 'error' : 'success');
  } else if (stoppedByErrors) {
    toast(run.error ?? 'Run failed', 'error');
  } else {
    toast(`${retryOf ? `Retry in run #${run.number}` : `Run #${run.number}`} cancelled. Completed results were kept.`);
  }
}

/** Requests in a finished run without a usable result: failed, or never sent (e.g. after cancelling). */
export function retryableCount(run: Run, results: Result[], docs: Doc[]): number {
  if (run.status === 'running' || run.status === 'submitted') return 0;
  const ok = new Set(results.filter((r) => r.runId === run.id && r.status === 'ok').map((r) => r.id));
  const present = new Set(docs.map((d) => d.id));
  let n = 0;
  for (const id of run.docIds) {
    if (!present.has(id)) continue;
    for (let rep = 1; rep <= run.snapshot.options.replicates; rep++) if (!ok.has(`${run.id}:${id}:${rep}`)) n++;
  }
  return n;
}

/**
 * Re-send a run's failed (or never sent) requests within the same run, with its frozen settings, so the
 * run stays one complete dataset. New answers replace the failed ones; each retry is recorded on the run.
 */
export async function retryFailed(runId: string) {
  const original = state.runs.find((r) => r.id === runId);
  if (!original) return;
  if (isBusy()) return toast('A run is already in progress.', 'error');
  const key = state.keys[original.snapshot.model.provider];
  if (!key) return toast(`Add your ${provider(original.snapshot.model.provider).label} API key first (API keys, top right).`, 'error');
  const ok = new Set(state.results.filter((r) => r.runId === runId && r.status === 'ok').map((r) => r.id));
  const run: Run = structuredClone(original);
  const tasks = buildTasks(run, (docId, rep) => !ok.has(`${run.id}:${docId}:${rep}`));
  if (!tasks.length) return toast(`Run #${run.number} has no failed requests.`);
  const asBatch = original.mode === 'batch' && !!original.batch;
  run.retries = [...(run.retries ?? []), { at: nowIso(), requests: tasks.length, ...(asBatch ? { asBatch } : {}) }];
  run.error = null;
  if (asBatch && original.batch) {
    // A batch run's failed requests go out as a new batch (half price), collected into the same run.
    const map = { ...original.batch.map };
    const items = tasks.map((t, i) => {
      const customId = `t${run.retries!.length}_${i}`;
      map[customId] = [t.doc.id, t.replicate];
      return { customId, part: t.part };
    });
    set({ submitting: 'Preparing…' });
    try {
      await submitBatches(run, key, items, map, batchParts(original));
    } finally {
      set({ submitting: '' });
    }
    return;
  }
  run.status = 'running';
  set({ submitting: 'Preparing…' });
  try {
    await saveRun(run);
  } finally {
    set({ submitting: '' });
  }
  await sendTasks(run, tasks, key, `Retry in run #${run.number} finished`, original);
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
    const parts = batchParts(run).map((p) => ({ ...p }));
    const counts = { ok: 0, failed: 0 };
    const errors: string[] = [];
    for (const p of parts) {
      if (p.status !== 'submitted') continue;
      const st = await adapter.checkBatch(key, p.batchId);
      p.lastStatus = `${st.status} · ${st.completed + st.failed}/${st.total}`;
      if (!st.done) continue;
      let lines: BatchLine[];
      try {
        lines = await adapter.fetchBatchResults(key, p.batchId);
      } catch (e) {
        // A network hiccup is tried again at the next check; a batch the provider failed (or whose results
        // are gone) would otherwise stay "processing" forever.
        if (!isPermanentError(e)) throw e;
        lines = [];
        p.error = `A batch ended with status "${st.status}" and its results could not be collected: ${describeApiError(e)}`;
      }
      const c = await storeBatchResults(run, lines);
      counts.ok += c.ok;
      counts.failed += c.failed;
      p.status = lines.length ? 'collected' : 'failed';
      if (!lines.length) p.error ??= `A batch ended with status "${st.status}" and returned no results.`;
      if (p.error) errors.push(p.error);
    }
    const waiting = parts.filter((p) => p.status === 'submitted');
    const lastStatus = waiting.map((p) => p.lastStatus).join('; ') || 'ended';
    const updated: Run = { ...run, batch: { ...run.batch, parts, lastStatus, lastCheckedAt: nowIso() } };
    if (!waiting.length) {
      // Every batch is in. The run failed only if no batch returned anything.
      updated.status = parts.some((p) => p.status === 'collected') ? 'completed' : 'failed';
      updated.finishedAt = nowIso();
      updated.error = errors.length ? errors.join(' ') : null;
      const mine = state.currentId === run.studyId ? state.results.filter((r) => r.runId === run.id) : null;
      const ok = mine ? mine.filter((r) => r.status === 'ok').length : counts.ok;
      const failed = mine ? mine.length - ok : counts.failed;
      toast(updated.status === 'failed' ? `Batch run #${run.number}: ${updated.error}` : `Batch run #${run.number} finished: ${ok} ok, ${failed} failed.`, failed || errors.length ? 'error' : 'success');
    } else if (!quiet) {
      toast(`Batch run #${run.number}: ${lastStatus}.`);
    }
    await saveRun(updated);
  } catch (e) {
    if (!quiet) toast(`Could not check batch: ${describeApiError(e)}`, 'error');
  } finally {
    checking.delete(runId);
  }
}

async function storeBatchResults(run: Run, lines: BatchLine[]): Promise<{ ok: number; failed: number }> {
  // Read the run's own texts (not the open study's): the user may switch studies while results are collected.
  const docsById = new Map((await dbApi.getDocsForStudy(run.studyId)).map((d) => [d.id, d]));
  const adapter = provider(run.snapshot.model.provider);
  const counts = { ok: 0, failed: 0 };
  const stored: Result[] = [];
  for (const line of lines) {
    const ref = run.batch!.map[line.customId];
    if (!ref) continue;
    const doc = docsById.get(ref[0]);
    if (!doc) continue; // text deleted since submission
    const result = makeResult(run, doc, ref[1], run.createdAt, line.ok ? line.outcome : null, line.ok ? null : line.error, null);
    const part = adapter.buildRequestPart(renderMessageParts(run.snapshot.prompt.userTemplate, doc, run.snapshot.prompt.subject), run.snapshot.options, run.snapshot.model.model);
    const log: ResultLog = {
      id: result.id,
      runId: run.id,
      studyId: run.studyId,
      requestPart: { custom_id: line.customId, ...part },
      response: line.ok ? line.outcome.response : line.response ?? { error: line.error },
    };
    await dbApi.putResult(result, log);
    stored.push(result);
    counts[result.status === 'ok' ? 'ok' : 'failed']++;
  }
  if (state.currentId === run.studyId) {
    for (const r of stored) queueResult(r);
    flushResults();
  }
  return counts;
}

export async function cancelBatch(runId: string) {
  const run = state.runs.find((r) => r.id === runId);
  if (!run?.batch) return;
  try {
    for (const p of batchParts(run)) if (p.status === 'submitted') await provider(run.batch.provider).cancelBatch(state.keys[run.batch.provider], p.batchId);
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
