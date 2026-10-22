import { useSyncExternalStore } from 'react';
import * as dbApi from './db';
import { buildOutputSchema, effectiveTemplate, parseModelOutput, renderMessageParts } from './prompt';
import { describeApiError, isPermanentError, provider } from './providers';
import { rejectsTemperature } from './providers/anthropic';
import type { BatchLine, BatchStatus, CallOutcome, ModelInfo } from './providers/types';
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
  type UploadAttempt,
  type Usage,
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
  /** Set while a study backup is being imported (closing the tab would leave it half done). */
  importing: boolean;
  toasts: Toast[];
  saving: boolean;
  /** Why the last change to a study could not be saved ('' = saved); it is tried again. */
  saveError: string;
  /** The app is open in another tab of this browser, which works on the same data: this one waits. */
  otherTab: boolean;
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
  importing: false,
  toasts: [],
  saving: false,
  saveError: '',
  otherTab: false,
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

/** A message at the bottom of the page. `sticky`: stays until dismissed (for something that must not be missed). */
export function toast(text: string, kind: Toast['kind'] = 'info', sticky = false) {
  const t = { id: uid(), kind, text };
  set((s) => ({ toasts: [...s.toasts, t] }));
  if (!sticky) setTimeout(() => dismissToast(t.id), kind === 'error' ? 9000 : 4500);
}

/** For storage failures: browsers report a full disk or quota as QuotaExceededError, often without a message. */
export function storageError(e: unknown): string {
  return isQuotaError(e)
    ? "this browser's storage is full (free disk space, or export a backup and delete old runs or studies)"
    : errorMessage(e) || 'the browser refused to save it';
}

function isQuotaError(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? '';
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || /quota/i.test(errorMessage(e));
}

/** A backup is being imported (closing the tab meanwhile would leave a partial study, removed at the next start). */
export function setImporting(importing: boolean) {
  set({ importing });
}

/** The app is open in another tab: this one shows a notice and waits until that tab is closed. */
export function setOtherTab(other: boolean) {
  set({ otherTab: other });
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
  // A backup import that was interrupted (tab closed) leaves a partial study: remove it (the file is still there).
  const partial = studies.filter((s) => s.importIncomplete);
  for (const s of partial) await dbApi.deleteStudy(s.id).catch(() => undefined);
  if (partial.length) {
    studies = studies.filter((s) => !s.importIncomplete);
    toast(`An interrupted backup import (${partial.map((s) => `"${s.name}"`).join(', ')}) was incomplete and has been removed. Import the backup file again.`, 'error', true);
  }
  for (const s of studies) delete (s.model as { refusalFallback?: unknown }).refusalFallback; // a setting removed in October 2026
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
  try {
    await selectStudy(currentId);
  } catch (e) {
    toast(`Could not open the study: ${storageError(e)}`, 'error', true);
  }
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
  // Older versions stored some answers as "ok" that count as failed now: apply today's rules (in memory).
  const runById = new Map(data.runs.map((r) => [r.id, r]));
  for (const r of data.results) {
    if (r.status !== 'ok') continue;
    const legacy = r as Result & { fallback?: string };
    const prompt = runById.get(r.runId)?.snapshot.prompt;
    if (legacy.fallback) {
      // Answered by another model after a refusal (the refusal fallback of the first version, Oct 15, 2026):
      // a label from another model is not this run's label.
      r.status = 'error';
      r.error ??= `Refused by the requested model; answered by a fallback model (${legacy.fallback}), which is not counted.`;
    } else if (r.parseError) r.status = 'error';
    else if (incompleteAnswer(r.stopReason) || !r.rawText.trim()) {
      r.status = 'error';
      r.error ??= incompleteMessage(r.rawText, r.stopReason);
    } else if (prompt?.outputMode === 'text') {
      const parseError = parseModelOutput(r.rawText, prompt).parseError;
      if (parseError) [r.status, r.parseError] = ['error', parseError];
    }
  }
  // Runs left "running" by a closed tab can't continue: mark them interrupted. (Another open tab would hold
  // the app, so a run marked "running" here is not being sent anywhere.) A batch run whose upload was cut off
  // may or may not have reached the provider.
  for (const r of data.runs) {
    let changed = false;
    if (r.status === 'running') {
      // An interrupted retry: count the requests it did send (their results are stored), not those planned.
      const retry = r.resumeStatus ? r.retries?.at(-1) : undefined;
      if (retry) {
        retry.requests = data.results.filter((x) => x.runId === r.id && x.requestedAt >= retry.at).length;
        if (!retry.requests) r.retries = r.retries!.slice(0, -1);
      }
      r.status = r.resumeStatus ?? 'cancelled';
      r.error = r.resumeStatus ? r.resumeError ?? null : 'Interrupted (the page was closed or reloaded while running). Completed results were kept.';
      if (r.resumeStatus) toast(`The retry in run #${r.number} was interrupted (the page was closed or reloaded). Completed results were kept.`);
      delete r.resumeStatus;
      delete r.resumeError;
      r.finishedAt ??= nowIso();
      changed = true;
    }
    if (r.batch?.uploading) {
      r.batch.uploadUnknown = r.batch.uploading;
      delete r.batch.uploading;
      if (r.status === 'submitted' && !batchParts(r).some((p) => p.status === 'submitted')) r.status = batchParts(r).some((p) => p.status === 'collected') ? 'completed' : 'failed';
      r.error = UPLOAD_UNKNOWN;
      changed = true;
    }
    if (changed) {
      try {
        await dbApi.putRun(r);
      } catch (e) {
        toast(`Run #${r.number} could not be updated: ${storageError(e)}.`, 'error');
      }
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
  let failed = '';
  for (const id of ids) {
    const st = state.studies.find((x) => x.id === id);
    if (!st) continue;
    try {
      await dbApi.putStudy(st);
    } catch (e) {
      // Kept as unsaved and tried again, so the change isn't lost when space is freed.
      dirty.add(id);
      failed = storageError(e);
    }
  }
  if (failed && !state.saveError) toast(`Your latest changes to the study could not be saved: ${failed}. They are tried again every few seconds; until then they are lost if this tab is closed.`, 'error', true);
  set({ saving: false, saveError: failed });
  if (failed) saveTimer = setTimeout(flushStudies, 5000);
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
  // Batches still processing would keep running (and be charged) with nowhere to deliver their results. (Not one
  // that a copy of this study, imported from a backup, also waits for: that copy collects it.)
  for (const r of id === state.currentId ? state.runs : []) {
    const why = r.status === 'submitted' ? await cancelBatch(r.id, { keepShared: true }) : '';
    if (why && !confirm(`${why}\n\nDelete the study anyway? A batch still running at the provider may be charged, and its results can't be collected here.`)) return;
  }
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

/**
 * Add texts to the open study. `studyId`: the study they were read for; if another study has been opened since
 * (e.g. while a folder was still being read), nothing is added.
 */
export async function addDocs(items: { docId: string; text: string; meta: Record<string, string>; source: string }[], studyId?: string) {
  const cur = currentStudy();
  if (!cur || !items.length) return;
  if (studyId && cur.id !== studyId) {
    toast('Another study was opened while the files were being read, so nothing was added. Open the study again and add the files there.', 'error', true);
    return;
  }
  // A text that is already here (same name, identical text), e.g. after dropping the whole folder again to add
  // a few new files, is skipped rather than added again as a copy. Same name with a different text is added.
  // (Versions before October 15, 2026 stored texts without surrounding blank lines and spaces: such a text also
  // counts as already here. Only the comparison ignores them; nothing stored or added is changed.)
  const present = new Map<string, string[]>();
  for (const d of state.docs) present.set(nameOf(d), [...(present.get(nameOf(d)) ?? []), d.text]);
  const w = words(cur.prompt);
  const before = items.length;
  items = items.filter((it) => {
    const texts = present.get(nameOf(it)) ?? [];
    if (texts.includes(it.text) || texts.includes(it.text.trim())) return false;
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
  try {
    await dbApi.putDocs(docs);
  } catch (e) {
    toast(`Nothing was added: ${storageError(e)}.`, 'error', true);
    return;
  }
  set((s) => ({ docs: [...s.docs, ...docs] }));
  toast(`Added ${docs.length} ${docs.length === 1 ? w.one : w.many}.`, 'success');
  // Ask the browser not to clear this site's data when disk space runs low (some browsers ask the user once).
  void navigator.storage?.persist?.().catch(() => undefined);
  if (renamed.length) {
    toast(`${renamed.length} ID${renamed.length === 1 ? ' was' : 's were'} already in use and got a suffix: ${renamed.slice(0, 3).join(', ')}${renamed.length > 3 ? ', …' : ''}`, 'error');
  }
}

/**
 * Add label columns (e.g. human codes) to existing texts. Only metadata changes; texts are untouched.
 * `clear`: per text, columns whose earlier value is removed (left blank in a corrected sheet, or the text is not
 * in it). Returns false if nothing could be saved.
 */
export async function addLabels(updates: Map<string, Record<string, string>>, clear: Map<string, string[]> = new Map()): Promise<boolean> {
  const changed = state.docs
    .filter((d) => updates.has(d.id) || clear.has(d.id))
    .map((d) => {
      const meta = { ...d.meta, ...updates.get(d.id) };
      for (const c of clear.get(d.id) ?? []) delete meta[c];
      return { ...d, meta };
    });
  if (!changed.length) return true;
  try {
    await dbApi.putDocs(changed);
  } catch (e) {
    toast(`The labels were not added: ${storageError(e)}.`, 'error', true);
    return false;
  }
  const byId = new Map(changed.map((d) => [d.id, d]));
  set((s) => ({ docs: s.docs.map((d) => byId.get(d.id) ?? d) }));
  const w = words(currentStudy()!.prompt);
  toast(`Updated the columns of ${changed.length} ${changed.length === 1 ? w.one : w.many}.`, 'success');
  return true;
}

/** Remove a metadata column (e.g. labels added by mistake) from every text of the open study. Texts are untouched. */
export async function removeMetaColumn(column: string): Promise<boolean> {
  const changed = state.docs
    .filter((d) => column in d.meta)
    .map((d) => {
      const { [column]: _gone, ...meta } = d.meta;
      return { ...d, meta };
    });
  if (!changed.length) return true;
  try {
    await dbApi.putDocs(changed);
  } catch (e) {
    toast(`The column was not removed: ${storageError(e)}.`, 'error', true);
    return false;
  }
  const byId = new Map(changed.map((d) => [d.id, d]));
  set((s) => ({ docs: s.docs.map((d) => byId.get(d.id) ?? d) }));
  toast(`Removed the column "${column}" from ${changed.length} ${changed.length === 1 ? words(currentStudy()!.prompt).one : words(currentStudy()!.prompt).many}.`, 'success');
  return true;
}

/**
 * Mark a drawn sample: `column` = `value` on these texts, removed from texts marked by an earlier draw.
 * `note` (the rule and seed) is added to the study description, which is exported with the study; it replaces
 * the note of an earlier draw for the same `column` = `value` (whose marks this draw replaces). The marks and
 * the note are saved together, or not at all.
 */
export async function markSample(column: string, value: string, ids: string[], note: string, seed: number): Promise<boolean> {
  const cur = currentStudy();
  if (!cur) return false;
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
  const earlier = sampleNotePrefix(column, value);
  const kept = cur.description
    .split('\n')
    .filter((line) => !line.startsWith(earlier))
    .join('\n')
    .trim();
  const next: Study = { ...structuredClone(cur), description: `${kept ? kept + '\n' : ''}${note}`, updatedAt: nowIso() };
  try {
    await dbApi.putDocsAndStudy(changed, next);
  } catch (e) {
    toast(`The sample was not marked: ${storageError(e)}.`, 'error', true);
    return false;
  }
  const byId = new Map(changed.map((d) => [d.id, d]));
  set((s) => ({ docs: s.docs.map((d) => byId.get(d.id) ?? d), studies: s.studies.map((x) => (x.id === next.id ? next : x)) }));
  const w = words(next.prompt);
  toast(`Marked ${ids.length} ${ids.length === 1 ? w.one : w.many} as ${column} = ${value} (seed ${seed}). The rule and seed are in the Excel Settings sheet and the supplementary metadata.`, 'success');
  return true;
}

/** The start of the study note a drawn sample adds (see SampleDialog), so a redraw can replace it. */
export function sampleNotePrefix(column: string, value: string): string {
  return `Sample ${column} = ${value} (`;
}

export async function removeDocs(ids: string[]) {
  // Not while a run is going: the run would go on sending (and paying for) the deleted texts.
  if (isBusy()) return toast('Finish or cancel the running job first.', 'error');
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

/**
 * What a prompt sends, for telling prompts apart: the prompt and system prompt as sent, and the output schema
 * (built with today's code, so runs from before a change to the schema's wording still match). A field's display
 * name is not sent, so renaming a field gives no new prompt version.
 */
export function promptKey(p: PromptSpec): string {
  return JSON.stringify({ system: p.system, userTemplate: effectiveTemplate(p.userTemplate, p.subject), outputMode: p.outputMode, schema: buildOutputSchema(p) });
}

/** Prompt version numbers: prompts that send the same thing share a number; each new prompt gets the next one. */
export function versionFor(prompt: PromptSpec, runs: Run[]): number {
  const key = promptKey(prompt);
  const existing = runs.find((r) => promptKey(r.snapshot.prompt) === key);
  if (existing) return existing.snapshot.promptVersion;
  return runs.reduce((m, r) => Math.max(m, r.snapshot.promptVersion), 0) + 1;
}

/**
 * What "Remaining" sends: the texts without a usable result from a run with the current prompt, model and effort,
 * leaving out those still waiting in a batch with them (sending them again would pay twice).
 */
export function remainingDocs(st: Study, docs: Doc[], runs: Run[], results: Result[]): { todo: Doc[]; waiting: number } {
  const key = promptKey(st.prompt);
  const same = new Set(
    runs
      .filter((r) => r.snapshot.model.provider === st.model.provider && r.snapshot.model.model === st.model.model && (r.snapshot.model.effort || '') === (st.model.effort || ''))
      .filter((r) => promptKey(r.snapshot.prompt) === key)
      .map((r) => r.id),
  );
  const done = new Set(results.filter((r) => r.status === 'ok' && same.has(r.runId)).map((r) => r.docId));
  const pending = new Set(runs.filter((r) => same.has(r.id) && (r.status === 'submitted' || r.status === 'running')).flatMap((r) => r.docIds));
  const left = docs.filter((d) => !done.has(d.id));
  return { todo: left.filter((d) => !pending.has(d.id)), waiting: left.filter((d) => pending.has(d.id)).length };
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
    promptVersion: versionFor(st.prompt, state.runs),
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

function makeResult(
  run: Run,
  doc: Doc,
  replicate: number,
  requestedAt: string,
  outcome: CallOutcome | null,
  error: string | null,
  latencyMs: number | null,
  completedAt = nowIso(),
): Result {
  const parsed = outcome ? parseModelOutput(outcome.rawText, run.snapshot.prompt) : { values: {}, rationale: '', parseError: null };
  // An answer that was cut off or refused, or is empty, or can't be read, has no usable labels: it counts as
  // failed. (Plain prose cut off at the token limit would otherwise pass as a complete answer, and an empty
  // plain-text answer as a usable one.) A refused or cut-off answer is not also a JSON error: it is reported once.
  const incomplete = !!outcome && incompleteAnswer(outcome.stopReason);
  const empty = !!outcome && !outcome.rawText.trim();
  const parseError = incomplete || empty ? null : parsed.parseError;
  const failed = !!error || incomplete || empty || !!parseError;
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
    parseError,
    error: error ?? (incomplete || empty ? incompleteMessage(outcome!.rawText, outcome!.stopReason) : null),
    usage: outcome?.usage ?? { ...ZERO_USAGE },
    latencyMs,
    requestedAt,
    completedAt,
    responseId: outcome?.responseId ?? '',
    modelReported: outcome?.modelReported ?? '',
    stopReason: outcome?.stopReason ?? '',
  };
}

function incompleteMessage(rawText: string, stopReason: string): string {
  return `${rawText.trim() ? 'Incomplete answer' : 'Empty response'} (stop reason: ${stopReason || 'none'})`;
}

/** Add a replaced attempt's token use to the run's record of replaced attempts. */
function addReplaced(run: Run, prev: Result) {
  const r = run.replaced ?? { requests: 0, usage: { ...ZERO_USAGE } };
  r.requests++;
  for (const k of Object.keys(r.usage) as (keyof Usage)[]) r.usage[k] += prev.usage[k] ?? 0;
  run.replaced = r;
}

/** Store a run. Its name is kept as stored (it may have been renamed while the run was going), unless renaming. */
async function saveRun(run: Run, rename = false) {
  if (!rename) {
    const stored = await dbApi.getRun(run.id);
    if (stored) run.label = stored.label;
  }
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
  if (!req.docIds.length) return toast(`No ${words(st.prompt).many} in this selection.`, 'error');
  if (st.prompt.outputMode === 'structured' && !st.prompt.variables.length) {
    return toast('Add at least one output field, or switch the output to plain text.', 'error');
  }

  // Marked busy right away (before any waiting), so a second click can't start the same run twice.
  set({ submitting: 'Preparing…' });
  let started: { run: Run; tasks: Task[] } | null = null;
  try {
    started = await prepareRun(st, req, key);
  } catch (e) {
    // E.g. the run could not be saved: nothing has been sent (a run is saved before anything goes out).
    toast(`The run was not started: ${storageError(e)}.`, 'error', true);
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

/** For the confirmation before a batch run: its size, how many batches it is sent as, and which limit splits it. */
export function batchPlan(st: Study, docs: Doc[]): { mb: number; batches: number; limitMb: number; limitRequests: number; requests: number; bySize: boolean; provider: string } {
  const adapter = provider(st.model.provider);
  const options = { ...st.options, cacheTtl: '1h' as const };
  const base = adapter.buildRequestBase({ model: st.model, options, system: st.prompt.system, outputSchema: buildOutputSchema(st.prompt), promptHash: '' });
  const items: BatchItem[] = [];
  for (const d of docs) {
    const part = adapter.buildRequestPart(renderMessageParts(st.prompt.userTemplate, d, st.prompt.subject), options, st.model.model);
    for (let r = 1; r <= st.options.replicates; r++) items.push({ customId: `r${items.length}`, part });
  }
  const sizes = requestBytes(base, items);
  const limit = BATCH_LIMITS[st.model.provider];
  const groups = groupForBatches(st.model.provider, sizes);
  // Split by size when a batch was closed before reaching the request limit.
  const bySize = groups.slice(0, -1).some((g) => g.length < limit.requests);
  return { mb: sizes.reduce((s, x) => s + x, 0) / 1e6, batches: groups.length, limitMb: limit.mb, limitRequests: limit.requests, requests: items.length, bySize, provider: adapter.label };
}

/** The batches of a batch run (older runs have one, recorded only as `batchId`). */
export function batchParts(run: Run): BatchPart[] {
  if (!run.batch) return [];
  const status = run.status === 'submitted' ? 'submitted' : run.status === 'failed' ? 'failed' : 'collected';
  return run.batch.parts ?? [{ batchId: run.batch.batchId, inputFileId: run.batch.inputFileId, status, lastStatus: run.batch.lastStatus }];
}

/** Shown on a run whose batch upload may or may not have reached the provider. */
const UPLOAD_UNKNOWN =
  'A batch upload of this run was cut off (connection lost, or the page closed) before the provider confirmed it, so it may or may not have arrived. Retry failed looks for it at the provider first.';

// Cancelling a run while its batches are still being uploaded: the upload stops after the batch under way, and
// that batch is cancelled as soon as it is created.
const cancelRequested = new Set<string>();
let uploadingRun: string | null = null;

/** Did the provider answer (and refuse)? Then nothing was created. A 5xx or no answer at all leaves it open. */
function refusedByProvider(e: unknown): boolean {
  if ((e as { notCreated?: boolean } | null)?.notCreated) return true;
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

/**
 * After an upload without an answer, find the batch it may have created: one created since the upload began with
 * the same number of requests (or, for OpenAI, the same input file) that no run here knows. Null if there is not
 * exactly one, or the provider can't be asked.
 */
async function findUploadedBatch(p: ProviderId, key: string, attempt: UploadAttempt): Promise<{ batchId: string; inputFileId?: string } | null> {
  try {
    const known = new Set((await dbApi.listAllRuns()).flatMap((r) => batchParts(r).map((x) => x.batchId)));
    const found = (await provider(p).listRecentBatches(key, attempt.since)).filter(
      (b) => !known.has(b.batchId) && (attempt.inputFileId ? b.inputFileId === attempt.inputFileId : b.requests === attempt.requests),
    );
    return found.length === 1 ? { batchId: found[0].batchId, inputFileId: found[0].inputFileId } : null;
  } catch {
    return null;
  }
}

/**
 * Upload requests as one batch, or several when they are over the provider's limit, adding them to the run's
 * earlier batches (for a retry: `retry` holds its time and the run's state before it). The run is saved before
 * each upload (so a page closed during it leaves a record) and after it, so a batch that went up is never lost.
 * Returns whether anything was sent.
 */
async function submitBatches(
  run: Run,
  key: string,
  items: BatchItem[],
  map: Record<string, [string, number]>,
  earlier: BatchPart[],
  retry?: { at: string; before: Pick<Run, 'status' | 'error' | 'finishedAt'> },
): Promise<boolean> {
  const { snapshot } = run;
  const p = snapshot.model.provider;
  const adapter = provider(p);
  const groups = groupForBatches(p, requestBytes(snapshot.requestBase, items)).map((g) => g.map((i) => items[i]));
  const parts = [...earlier];
  const record = (extra: Partial<NonNullable<Run['batch']>>) => {
    const { uploading: _u, uploadUnknown: _k, ...rest } = run.batch ?? ({} as NonNullable<Run['batch']>);
    run.batch = { ...rest, provider: p, batchId: parts[0]?.batchId ?? '', inputFileId: parts[0]?.inputFileId, map, lastStatus: 'submitted', lastCheckedAt: nowIso(), parts, ...extra };
  };
  let sent = 0;
  let requestsSent = 0;
  let problem = '';
  let unknown: UploadAttempt | null = null;
  cancelRequested.delete(run.id);
  uploadingRun = run.id;
  try {
    for (const [g, group] of groups.entries()) {
      if (cancelRequested.has(run.id)) break;
      const which = groups.length > 1 ? `batch ${g + 1} of ${groups.length}` : 'a batch';
      set({ submitting: `Uploading ${which} (${group.length.toLocaleString()} request${group.length === 1 ? '' : 's'}) to ${adapter.label}…` });
      const attempt: UploadAttempt = { since: nowIso(), requests: group.length };
      try {
        record({ uploading: attempt });
        run.status = 'submitted';
        run.finishedAt = null;
        await saveRun(run);
      } catch (e) {
        problem = `${sent ? 'The remaining batches were not sent' : 'Nothing was sent'}: the run could not be saved (${storageError(e)}).`;
        break;
      }
      let handle: { batchId: string; inputFileId?: string } | null;
      try {
        handle = await adapter.submitBatch(key, snapshot.requestBase, group);
      } catch (e) {
        if (refusedByProvider(e)) {
          const rest = sent ? ` The ${sent} already submitted continue; send the rest with Retry failed when ${sent === 1 ? 'it has' : 'they have'} finished.` : '';
          problem = `Submitting ${which} failed: ${describeApiError(e)}.${rest}`;
          break;
        }
        // No answer: the provider may have created the batch anyway. Look for it rather than risk a second one.
        const fileId = (e as { inputFileId?: string } | null)?.inputFileId;
        if (fileId) attempt.inputFileId = fileId;
        handle = await findUploadedBatch(p, key, attempt);
        if (!handle) {
          unknown = attempt;
          problem = `Submitting ${which} got no answer (${describeApiError(e)}), so it is not known whether ${adapter.label} received it. Don't send these requests again until you have checked the provider's batch list; Retry failed looks for the batch there first.`;
          break;
        }
      }
      parts.push({ batchId: handle.batchId, inputFileId: handle.inputFileId, status: 'submitted', lastStatus: 'submitted', submittedAt: attempt.since });
      sent++;
      requestsSent += group.length;
      if (retry) {
        const entry = run.retries?.find((x) => x.at === retry.at);
        if (entry) entry.requests = requestsSent;
        else run.retries = [...(run.retries ?? []), { at: retry.at, requests: requestsSent, asBatch: true }];
      }
      // Cancelled while this batch was going up: stop it right away (what finished before is still collected).
      if (cancelRequested.has(run.id)) await adapter.cancelBatch(key, handle.batchId).catch(() => undefined);
      try {
        record({});
        await saveRun(run);
      } catch (e) {
        problem = `${parts
          .slice(earlier.length)
          .map((x) => x.batchId)
          .join(', ')} went up to ${adapter.label}, but the run could not be saved (${storageError(e)}), so its results can't be collected yet. Free some space and reload the page: the app then finds the batch at the provider (Retry failed). Nothing else was sent.`;
        break;
      }
    }
  } finally {
    uploadingRun = null;
  }
  const cancelled = cancelRequested.delete(run.id);
  // How the run is left: waiting for the batches that went up; else as it was before a retry; else (a new run of
  // which nothing went up) removed, unless an upload's outcome is unknown.
  try {
    if (unknown) {
      record({ uploadUnknown: unknown });
      run.status = sent || parts.some((x) => x.status === 'submitted') ? 'submitted' : retry ? retry.before.status : 'failed';
      run.error = UPLOAD_UNKNOWN;
      run.finishedAt = run.status === 'submitted' ? null : nowIso();
      await saveRun(run);
    } else if (!problem.includes('could not be saved')) {
      if (!sent && !retry) {
        await dbApi.deleteRun(run.id);
        set((s) => ({ runs: s.runs.filter((r) => r.id !== run.id) }));
      } else if (!sent && retry) {
        record({});
        Object.assign(run, retry.before);
        await saveRun(run);
      } else {
        record({});
        await saveRun(run);
      }
    }
  } catch (e) {
    problem ||= `The run could not be saved: ${storageError(e)}.`;
  }
  if (problem) toast(problem, 'error', true);
  else if (cancelled) toast(`Upload stopped: ${sent} of ${groups.length} batches had gone up and ${sent === 1 ? 'was' : 'were'} cancelled at ${adapter.label}. Results finished before cancelling are still collected.`, 'error', true);
  else if (sent === groups.length) {
    toast(`${sent > 1 ? `${sent} batches` : 'Batch'} submitted (run #${run.number}). Results usually arrive within an hour; this page checks every minute while open.`, 'success');
  }
  return sent > 0;
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
 * An error that points to the settings shared by every request (a wrong key, model or parameter, no credit), not
 * to one text: an HTTP 400, 401, 403 or 404, except a text too long for the model.
 */
function settingsError(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status !== 'number' || ![400, 401, 403, 404].includes(status)) return false;
  return !/too long|context length|context window|maximum context|too many tokens/i.test(describeApiError(e));
}

type Retry = { at: string; before: Pick<Run, 'status' | 'error' | 'finishedAt'> };

/**
 * Send requests one by one (several in parallel), storing each result in the run as it arrives.
 * `retry`: a retry of failed requests within the run; one stopped early leaves the run as it was.
 */
async function sendTasks(run: Run, tasks: Task[], key: string, doneMessage: string, retry?: Retry) {
  const { snapshot } = run;
  const adapter = provider(snapshot.model.provider);
  const job: Job = { runId: run.id, total: tasks.length, done: 0, failed: 0, abort: new AbortController() };
  set({ job });
  const signal = job.abort.signal;
  // Stopped because of the settings: no further requests are sent; those already under way finish and are kept.
  let stopping = false;
  // Requests answered (stored) so far, and how many of them failed because of the settings.
  let answered = 0;
  let settingsFailures = 0;
  let sent = 0;
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
    while (next < tasks.length && !signal.aborted && !stopping) {
      const t = tasks[next++];
      const requestedAt = nowIso();
      const started = performance.now();
      let outcome: CallOutcome | null = null;
      let error: string | null = null;
      let fromSettings = false;
      sent++;
      try {
        outcome = await adapter.send(key, snapshot.requestBase, t.part, signal);
      } catch (e) {
        if (signal.aborted) return;
        error = describeApiError(e);
        fromSettings = settingsError(e);
      }
      const result = makeResult(run, t.doc, t.replicate, requestedAt, outcome, error, Math.round(performance.now() - started));
      const log: ResultLog = { id: result.id, runId: run.id, studyId: run.studyId, requestPart: t.part, response: outcome?.response ?? { error } };
      let replaced: Result | null;
      try {
        replaced = await dbApi.putResult(result, log);
      } catch (e) {
        // Without a saved result, sending more would only pay for answers that are lost.
        const others = Math.min(snapshot.options.concurrency, tasks.length) - 1;
        if (!signal.aborted) {
          run.error = `Stopped: a result could not be saved in this browser (${storageError(e)}).${others > 0 ? ` Answers to up to ${others} other requests that were under way could not be kept either.` : ''}`;
        }
        job.abort.abort();
        return;
      }
      if (replaced) addReplaced(run, replaced);
      queueResult(result);
      const failed = result.status === 'error';
      set((s) => (s.job ? { job: { ...s.job, done: s.job.done + 1, failed: s.job.failed + (failed ? 1 : 0) } } : {}));
      // Stop when every request so far failed because of the settings (almost certainly a configuration problem).
      // Answers that came back refused, cut off or unreadable say something about one text, not the settings.
      answered++;
      if (fromSettings) settingsFailures++;
      if (!stopping && answered >= 3 && settingsFailures === answered) {
        stopping = true;
        run.error = `${retry ? 'Retry stopped' : 'Stopped'}: the first ${answered} requests all failed with an error that points to the settings rather than the ${words(snapshot.prompt).many}: ${result.error}`;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(snapshot.options.concurrency, tasks.length)) }, worker));
  } finally {
    await finishTasks(run, job, doneMessage, { retry, stopping, sent });
  }
}

async function finishTasks(run: Run, job: Job, doneMessage: string, how: { retry?: Retry; stopping: boolean; sent: number }) {
  const { retry, stopping, sent } = how;
  const signal = job.abort.signal;
  flushResults();
  const final = getState().job;
  const stopped = signal.aborted || stopping;
  const stoppedByErrors = stopping || (signal.aborted && !!run.error);
  run.status = !stopped ? 'completed' : retry ? retry.before.status : stoppedByErrors ? 'failed' : 'cancelled';
  if (retry && stopped && !stoppedByErrors) run.error = retry.before.error;
  if (retry) {
    // Record the requests actually sent (a retry stopped early sent fewer than it planned; none: no retry).
    const others = (run.retries ?? []).filter((x) => x.at !== retry.at);
    run.retries = sent ? [...others, { at: retry.at, requests: sent }] : others;
  }
  delete run.resumeStatus;
  delete run.resumeError;
  run.finishedAt = nowIso();
  try {
    await saveRun(run);
  } catch (e) {
    toast(`Could not save run #${run.number}: ${storageError(e)}`, 'error', true);
  } finally {
    set({ job: null });
  }
  if (!stopped) {
    const f = final?.failed ?? 0;
    toast(`${doneMessage}: ${(final?.done ?? 0) - f} ok${f ? `, ${f} failed. Retry them in the same run under Runs & agreement` : ''}.`, f ? 'error' : 'success');
  } else if (stoppedByErrors) {
    toast(run.error ?? 'Run failed', 'error', true);
  } else {
    toast(`${retry ? `Retry in run #${run.number}` : `Run #${run.number}`} cancelled. Completed results were kept.`);
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
 * run stays one complete dataset. New answers replace the failed ones (whose logs and token use are kept);
 * each retry is recorded on the run with the number of requests it sent.
 */
export async function retryFailed(runId: string) {
  const original = state.runs.find((r) => r.id === runId);
  if (!original) return;
  if (isBusy()) return toast('A run is already in progress.', 'error');
  const key = state.keys[original.snapshot.model.provider];
  if (!key) return toast(`Add your ${provider(original.snapshot.model.provider).label} API key first (API keys, top right).`, 'error');
  set({ submitting: 'Preparing…' });
  let ok: Set<string>;
  try {
    // A batch upload whose outcome is unknown: find that batch at the provider first, rather than pay twice.
    const unknown = original.batch?.uploadUnknown;
    if (unknown && original.batch) {
      set({ submitting: `Looking for the batch at ${provider(original.batch.provider).label}…` });
      const found = await findUploadedBatch(original.batch.provider, key, unknown);
      if (found) {
        const run: Run = structuredClone(original);
        const parts = [...batchParts(run), { batchId: found.batchId, inputFileId: found.inputFileId, status: 'submitted' as const, lastStatus: 'submitted', submittedAt: unknown.since }];
        const { uploadUnknown: _gone, ...batch } = run.batch!;
        run.batch = { ...batch, batchId: parts[0].batchId, inputFileId: parts[0].inputFileId, parts, lastStatus: 'submitted' };
        run.status = 'submitted';
        run.error = null;
        run.finishedAt = null;
        await saveRun(run);
        toast(`Found the batch that was uploaded (${found.batchId}): its results are collected into run #${run.number}. Nothing was sent again.`, 'success', true);
        return;
      }
      const at = new Date(unknown.since).toLocaleString();
      if (
        !confirm(
          `No batch from the upload of ${at} (${unknown.requests.toLocaleString()} requests) was found at ${provider(original.batch.provider).label}, or the provider could not be asked. If it did arrive, sending again pays twice. Check the provider's batch list if in doubt.\n\nSend the failed requests again?`,
        )
      )
        return;
    }
    // What is stored now (not what this page loaded): answers may have arrived since.
    ok = new Set((await dbApi.getResultsForRun(runId)).filter((r) => r.status === 'ok').map((r) => r.id));
  } catch (e) {
    toast(`Could not prepare the retry: ${storageError(e)}`, 'error', true);
    return;
  } finally {
    set({ submitting: '' });
  }
  const run: Run = structuredClone(getState().runs.find((r) => r.id === runId) ?? original);
  const tasks = buildTasks(run, (docId, rep) => !ok.has(`${run.id}:${docId}:${rep}`));
  if (!tasks.length) return toast(`Run #${run.number} has no failed requests.`);
  const retry: Retry = { at: nowIso(), before: { status: run.status, error: run.error, finishedAt: run.finishedAt } };
  if (run.batch?.uploadUnknown) delete run.batch.uploadUnknown;
  run.error = null;
  if (run.mode === 'batch' && run.batch) {
    // A batch run's failed requests go out as a new batch (half price), collected into the same run.
    const map = { ...run.batch.map };
    const n = (run.retries?.length ?? 0) + 1;
    const items = tasks.map((t, i) => {
      const customId = `t${n}_${i}`;
      map[customId] = [t.doc.id, t.replicate];
      return { customId, part: t.part };
    });
    set({ submitting: 'Preparing…' });
    try {
      await submitBatches(run, key, items, map, batchParts(run), retry);
    } finally {
      set({ submitting: '' });
    }
    return;
  }
  run.status = 'running';
  // Restored if the page is closed during the retry (with the number of requests that were actually sent).
  run.resumeStatus = retry.before.status;
  run.resumeError = retry.before.error;
  run.retries = [...(run.retries ?? []), { at: retry.at, requests: 0 }];
  set({ submitting: 'Preparing…' });
  try {
    await saveRun(run);
  } catch (e) {
    toast(`The retry was not started: ${storageError(e)}.`, 'error', true);
    return;
  } finally {
    set({ submitting: '' });
  }
  await sendTasks(run, tasks, key, `Retry in run #${run.number} finished`, retry);
}

export function cancelJob() {
  state.job?.abort.abort();
}

export async function deleteRunById(runId: string) {
  if (uploadingRun === runId) return toast('A batch of this run is being uploaded: wait until that is done.', 'error');
  await dbApi.deleteRun(runId);
  set((s) => ({ runs: s.runs.filter((r) => r.id !== runId), results: s.results.filter((r) => r.runId !== runId) }));
}

export async function renameRun(runId: string, label: string) {
  const run = state.runs.find((r) => r.id === runId);
  if (!run) return;
  await saveRun({ ...run, label }, true);
}

// ---------- batches ----------

const checking = new Set<string>();
// Runs whose batch results could not be stored: said once per session, not at every quiet check.
const saveFailureShown = new Set<string>();

export async function checkBatch(runId: string, quiet = false) {
  const run = state.runs.find((r) => r.id === runId);
  if (!run?.batch || run.status !== 'submitted' || checking.has(runId)) return;
  // Batches being uploaded (e.g. a retry of this run) are added to the run as they go up: check after that.
  if (state.submitting) {
    if (!quiet) toast('A batch is being uploaded; check again when that is done.');
    return;
  }
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
    let lookupError = '';
    let saveError = '';
    const replaced: Result[] = [];
    for (const p of parts) {
      if (p.status !== 'submitted') continue;
      // Results that didn't fit: fetched again only when the owner asks (after freeing space).
      if (p.saveFailed && quiet) continue;
      let st: BatchStatus;
      try {
        st = await adapter.checkBatch(key, p.batchId);
      } catch (e) {
        // One batch that can't be read now doesn't hold up the others; it is checked again next time.
        lookupError = describeApiError(e);
        p.lastStatus = `could not be checked (${lookupError})`;
        continue;
      }
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
      if (!(await dbApi.getRun(runId))) break; // deleted meanwhile
      // The time the provider finished the batch (not when this page collected it).
      const endedAt = st.endedAt ?? nowIso();
      let c: { ok: number; failed: number; replaced: Result[] };
      try {
        c = await storeBatchResults(run, lines, p.submittedAt ?? run.createdAt, endedAt);
      } catch (e) {
        saveError = storageError(e);
        p.saveFailed = nowIso();
        p.lastStatus = `${st.status} · results could not be saved: ${saveError}. Free space, then click Check`;
        continue;
      }
      delete p.saveFailed;
      counts.ok += c.ok;
      counts.failed += c.failed;
      replaced.push(...c.replaced);
      p.status = lines.length ? 'collected' : 'failed';
      p.endedAt = endedAt;
      if (!lines.length) p.error ??= `A batch ended with status "${st.status}" and returned no results.`;
      if (p.error) errors.push(p.error);
    }
    // Saved onto the run as it is now: it may have been renamed meanwhile, or deleted (its results then go too).
    const latest = await dbApi.getRun(runId);
    if (!latest?.batch) {
      await dbApi.deleteRun(runId);
      set((s) => ({ results: s.results.filter((r) => r.runId !== runId) }));
      return;
    }
    const merged = batchParts(latest).map((p) => parts.find((q) => q.batchId === p.batchId) ?? p);
    const waiting = merged.filter((p) => p.status === 'submitted');
    const lastStatus = waiting.map((p) => p.lastStatus).join('; ') || 'ended';
    const updated: Run = { ...latest, batch: { ...latest.batch, parts: merged, lastStatus, lastCheckedAt: nowIso() } };
    for (const r of replaced) addReplaced(updated, r);
    if (!waiting.length) {
      // Every batch is in. The run failed only if no batch returned anything.
      updated.status = merged.some((p) => p.status === 'collected') ? 'completed' : 'failed';
      updated.finishedAt = merged.map((p) => p.endedAt ?? '').sort().at(-1) || nowIso();
      // Errors of the batches sent since the last retry (a retry replaces what failed before it).
      const since = latest.retries?.at(-1)?.at ?? '';
      const current = merged.filter((p) => (p.submittedAt ?? '') >= since);
      const allErrors = current.map((p) => p.error).filter((x): x is string => !!x);
      updated.error = allErrors.length ? allErrors.join(' ') : null;
      const mine = state.currentId === run.studyId ? state.results.filter((r) => r.runId === run.id) : null;
      const ok = mine ? mine.filter((r) => r.status === 'ok').length : counts.ok;
      const failed = mine ? mine.length - ok : counts.failed;
      toast(updated.status === 'failed' ? `Batch run #${run.number}: ${updated.error}` : `Batch run #${run.number} finished: ${ok} ok, ${failed} failed.`, failed || errors.length ? 'error' : 'success');
    } else if (saveError) {
      if (!quiet || !saveFailureShown.has(runId)) toast(`Batch run #${run.number}: the results arrived but could not be saved (${saveError}). Free some space, then click Check on the run.`, 'error', true);
      saveFailureShown.add(runId);
    } else if (!quiet) {
      toast(`Batch run #${run.number}: ${lastStatus}.`, lookupError ? 'error' : undefined);
    }
    await saveRun(updated);
  } catch (e) {
    if (!quiet) toast(`Could not check batch: ${isQuotaError(e) ? storageError(e) : describeApiError(e)}`, 'error');
  } finally {
    checking.delete(runId);
  }
}

async function storeBatchResults(run: Run, lines: BatchLine[], requestedAt: string, completedAt: string): Promise<{ ok: number; failed: number; replaced: Result[] }> {
  // Read the run's own texts (not the open study's): the user may switch studies while results are collected.
  const docsById = new Map((await dbApi.getDocsForStudy(run.studyId)).map((d) => [d.id, d]));
  const adapter = provider(run.snapshot.model.provider);
  const counts = { ok: 0, failed: 0, replaced: [] as Result[] };
  const stored: Result[] = [];
  try {
    for (const line of lines) {
      const ref = run.batch!.map[line.customId];
      if (!ref) continue;
      const doc = docsById.get(ref[0]);
      if (!doc) continue; // text deleted since submission
      const result = makeResult(run, doc, ref[1], requestedAt, line.ok ? line.outcome : null, line.ok ? null : line.error, null, completedAt);
      const part = adapter.buildRequestPart(renderMessageParts(run.snapshot.prompt.userTemplate, doc, run.snapshot.prompt.subject), run.snapshot.options, run.snapshot.model.model);
      const log: ResultLog = {
        id: result.id,
        runId: run.id,
        studyId: run.studyId,
        requestPart: { custom_id: line.customId, ...part },
        response: line.ok ? line.outcome.response : line.response ?? { error: line.error },
      };
      const prev = await dbApi.putResult(result, log);
      if (prev) counts.replaced.push(prev);
      stored.push(result);
      counts[result.status === 'ok' ? 'ok' : 'failed']++;
    }
  } finally {
    if (state.currentId === run.studyId) {
      for (const r of stored) queueResult(r);
      flushResults();
    }
  }
  return counts;
}

/**
 * The batches of a run that a run of another study (a copy imported from a backup, or the study it was copied
 * from) also waits for: batch id → that study's name. Cancelling such a batch would stop it there too.
 */
export async function sharedBatches(run: Run): Promise<Map<string, string>> {
  const mine = new Set(batchParts(run).filter((p) => p.status === 'submitted').map((p) => p.batchId));
  const out = new Map<string, string>();
  if (!mine.size) return out;
  const names = new Map((await dbApi.listStudies()).map((s) => [s.id, s.name]));
  for (const r of await dbApi.listAllRuns()) {
    if (r.id === run.id) continue;
    for (const p of batchParts(r)) if (p.status === 'submitted' && mine.has(p.batchId)) out.set(p.batchId, names.get(r.studyId) ?? 'another study');
  }
  return out;
}

/**
 * Ask the provider to stop a run's unfinished batches (and stop an upload of further batches under way).
 * `keepShared`: leave alone a batch another study also waits for (when deleting: that study still collects it).
 * Returns why a batch could not be stopped ('' if all were stopped, had already ended or were left to another study).
 */
export async function cancelBatch(runId: string, opts: { keepShared?: boolean } = {}): Promise<string> {
  const run = state.runs.find((r) => r.id === runId);
  if (!run?.batch) return '';
  if (uploadingRun === runId) cancelRequested.add(runId);
  const adapter = provider(run.batch.provider);
  const key = state.keys[run.batch.provider];
  if (!key) return `The batch could not be cancelled: no ${adapter.label} API key is set (API keys, top right).`;
  const shared = opts.keepShared ? await sharedBatches(run).catch(() => new Map<string, string>()) : new Map<string, string>();
  const failures: string[] = [];
  for (const p of batchParts(run)) {
    if (p.status !== 'submitted' || shared.has(p.batchId)) continue;
    try {
      await adapter.cancelBatch(key, p.batchId);
    } catch (e) {
      // A batch that has already ended has nothing left to stop.
      const ended = await adapter.checkBatch(key, p.batchId).then((st) => st.done, () => false);
      if (!ended) failures.push(describeApiError(e));
    }
  }
  return failures.length ? `Could not cancel ${failures.length === 1 ? 'a batch' : `${failures.length} batches`}: ${failures[0]}` : '';
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
