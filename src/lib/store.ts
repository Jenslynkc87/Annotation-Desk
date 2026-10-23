import { useSyncExternalStore } from 'react';
import * as dbApi from './db';
import { buildOutputSchema, effectiveTemplate, parseModelOutput, renderMessageParts } from './prompt';
import { describeApiError, isConnectionError, isPermanentError, provider } from './providers';
import { rejectsTemperature } from './providers/anthropic';
import type { BatchLine, BatchStatus, CallOutcome, ListedBatch, ModelInfo } from './providers/types';
import { CLOCK_MARGIN_MS, ZERO_USAGE } from './providers/types';
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
import { errorMessage, fmtDateTime, nowIso, shortHash, uid } from './util';

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
  showToast(text, kind, sticky);
}

/** The same, returning the message's id (to dismiss it later). */
function showToast(text: string, kind: Toast['kind'], sticky: boolean): string {
  const t = { id: uid(), kind, text };
  set((s) => ({ toasts: [...s.toasts, t] }));
  if (!sticky) setTimeout(() => dismissToast(t.id), kind === 'error' ? 9000 : 4500);
  return t.id;
}

/** For storage failures: browsers report a full disk or quota as QuotaExceededError, often without a message. */
export function storageError(e: unknown): string {
  return isQuotaError(e)
    ? "this browser's storage is full; free disk space, or export a backup and delete old runs or studies"
    : errorMessage(e) || 'the browser refused to save it';
}

export function isQuotaError(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? '';
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || /quota/i.test(errorMessage(e));
}

/** A backup is being imported (closing the tab meanwhile would leave a partial study, removed at the next start). */
export function setImporting(importing: boolean) {
  set({ importing });
}

/** The app is open in another tab: this one shows a notice and asks again when the user comes back to it or clicks
 *  Open here (see lib/tabLock.ts). */
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
  // (A study still marked as being imported is a partial import: never listed, removed at the next start. A study
  // with a change not yet saved keeps the version in memory, which is saved next.)
  const stored = (await dbApi.listStudies()).filter((s) => !s.importIncomplete);
  set((st) => ({ studies: stored.map((s) => (dirty.has(s.id) ? (st.studies.find((x) => x.id === s.id) ?? s) : s)) }));
}

/**
 * Today's rules for results stored by older versions as "ok" that count as failed now (in memory; the stored record
 * is not changed): answers of the refusal fallback (another model), unreadable, cut-off, refused or empty answers,
 * unreadable JSON in plain-text runs. A refused or cut-off answer is reported once, as such, not also as a JSON error.
 */
function applyTodaysRules(results: Result[], runs: Run[]) {
  const runById = new Map(runs.map((r) => [r.id, r]));
  for (const r of results) {
    const incomplete = incompleteAnswer(r.stopReason) || (!!r.stopReason && !r.rawText.trim());
    if (incomplete && r.parseError) {
      // (Reported as cut off, refused or empty, not as a JSON error; a failed row keeps a reason.)
      r.parseError = null;
      if (r.status !== 'ok') r.error ??= incompleteMessage(r.rawText, r.stopReason);
    }
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
}

/** Failed attempts that retries replaced, from the results (each keeps its earlier attempts' token use). */
function replacedFrom(results: Result[]): Run['replaced'] {
  let requests = 0;
  const usage = { ...ZERO_USAGE };
  for (const r of results) {
    requests += Math.max(0, (r.attempt ?? 1) - 1);
    for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += r.replacedUsage?.[k] ?? 0;
  }
  return requests ? { requests, usage } : undefined;
}

export async function selectStudy(id: string) {
  if (isBusy()) {
    toast('Finish or cancel the running job before switching studies.', 'error');
    return;
  }
  const data = await dbApi.loadStudyData(id);
  // Older versions stored some answers as "ok" that count as failed now: apply today's rules (in memory).
  applyTodaysRules(data.results, data.runs);
  // Replaced attempts (and their tokens) are kept with the results, so the run's record of them is always complete.
  const byRun = new Map<string, Result[]>();
  for (const r of data.results) {
    const list = byRun.get(r.runId);
    if (list) list.push(r);
    else byRun.set(r.runId, [r]);
  }
  for (const r of data.runs) {
    const replaced = replacedFrom(byRun.get(r.id) ?? []) ?? (r.replaced?.requests ? r.replaced : undefined);
    if (replaced) r.replaced = replaced;
  }
  // Runs left "running" by a closed tab can't continue: mark them interrupted. (Another open tab would hold
  // the app, so a run marked "running" here is not being sent anywhere.) A batch run whose upload was cut off
  // may or may not have reached the provider.
  for (const r of data.runs) {
    let changed = false;
    if (r.status === 'running') {
      const mine = byRun.get(r.id) ?? [];
      // A tab of the version before October 23, 2026 (published as 0.1.0) takes no lock, so it may still be sending
      // this run (or its retry, which that version started without `resumeStatus` or `counted`) if it was busy with it
      // a moment ago. Marked interrupted all the same, with a warning: Remaining would send its texts again. (Said with
      // "if": a page of that version reloaded mid-run, in this same tab, looks the same from here.)
      const older = !r.resumeStatus && (/^\d+\.\d+\.\d+$/.test(r.snapshot.appVersion) || (!!r.retries?.length && !r.retries.at(-1)!.counted));
      const lastSeen = [r.createdAt, r.retries?.at(-1)?.at ?? '', ...mine.map((x) => x.completedAt || x.requestedAt)].reduce((m, t) => (t > m ? t : m), '');
      if (older && Date.now() - Date.parse(lastSeen) < 120_000) {
        toast(
          `Run #${r.number} was still marked as running, and it was being sent less than 2 minutes ago. If a tab with an earlier version of Annotation Desk is still open, it may still be sending it: close that tab before going on (Remaining or Retry failed here would send its ${words(r.snapshot.prompt).many} again).`,
          'error',
          true,
        );
      }
      // An interrupted retry: count the requests it did send (their results are stored), not those planned. Kept
      // with none answered too: requests may have gone out before the page closed.
      const retry = r.resumeStatus ? r.retries?.at(-1) : undefined;
      if (retry) {
        retry.requests = mine.filter((x) => x.requestedAt >= retry.at).length;
        retry.counted = 'sent';
        retry.interrupted = true;
      }
      r.status = r.resumeStatus ?? 'cancelled';
      r.error = r.resumeStatus
        ? r.resumeError ?? null
        : 'Interrupted: the run stopped without being saved as finished (the page was closed or reloaded, or the browser’s storage was full). Completed results were kept.';
      if (r.resumeStatus) toast(`The retry in run #${r.number} was interrupted (the page was closed or reloaded, or storage was full). Completed results were kept.`);
      delete r.resumeStatus;
      delete r.resumeError;
      // It ended with its last answer (or, with none, when it began), not when the study was opened again.
      const last = mine.map((x) => x.completedAt || x.requestedAt).reduce((m, t) => (t > m ? t : m), r.finishedAt ?? '');
      r.finishedAt = last || r.createdAt;
      changed = true;
    } else if (r.status === 'cancelled' && r.error?.startsWith('Interrupted (the page was closed or reloaded while running)') && !r.retries?.some((x) => x.counted)) {
      // Marked so by the published version (0.1.0), which gave it the time the study was next opened (or, for a
      // retry, the time before it): it ended with its last answer. (In this page only; the record is left as it is.)
      const last = (byRun.get(r.id) ?? []).map((x) => x.completedAt || x.requestedAt).reduce((m, t) => (t > m ? t : m), '');
      r.finishedAt = last || r.createdAt;
    }
    if (r.batch?.uploading) {
      markUploadUnknown(r);
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

// The sticky "not saved" message, dismissed once the change is saved.
let notSavedToast = '';

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
  if (failed && !state.saveError) notSavedToast = showToast(`Your latest changes to the study could not be saved: ${failed}. They are tried again every few seconds; until then they are lost if this tab is closed.`, 'error', true);
  if (!failed && notSavedToast) {
    dismissToast(notSavedToast);
    notSavedToast = '';
    toast('Your changes to the study are saved now.', 'success');
  }
  set({ saving: false, saveError: failed });
  if (failed) saveTimer = setTimeout(flushStudies, 5000);
}

// Don't lose a pending edit when the tab is closed.
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => void flushStudies());

export async function createStudy(name: string, subject?: PromptSpec['subject']) {
  const s = newStudy(name, subject);
  try {
    await dbApi.putStudy(s);
  } catch (e) {
    toast(`The study was not created: ${storageError(e)}.`, 'error', true);
    return;
  }
  set((st) => ({ studies: [s, ...st.studies] }));
  await selectStudy(s.id);
}

export async function duplicateStudy(withCorpus: boolean) {
  const cur = currentStudy();
  if (!cur) return;
  const copy: Study = { ...structuredClone(cur), id: uid(), name: `${cur.name} (copy)`, createdAt: nowIso(), updatedAt: nowIso() };
  try {
    // The copy and its texts in one transaction: both, or (e.g. storage full) neither.
    await dbApi.putDocsAndStudy(withCorpus ? state.docs.map((d) => ({ ...d, id: uid(), studyId: copy.id })) : [], copy);
  } catch (e) {
    toast(`The study was not duplicated: ${storageError(e)}.`, 'error', true);
    return;
  }
  set((st) => ({ studies: [copy, ...st.studies] }));
  await selectStudy(copy.id);
}

export async function removeStudy(id: string) {
  if (isBusy()) return toast('Finish or cancel the running job first.', 'error');
  const runs = id === state.currentId ? state.runs : [];
  // Every question first, before anything is cancelled (a study kept at a question keeps its batches): a batch upload
  // of unknown outcome is looked up at the provider (not one another study here shares: left to it).
  const looks: [Run, UnknownLook][] = [];
  for (const r of runs) if (unknownUpload(r)) looks.push([r, await lookUpUnknownUpload(r)]);
  const problems = looks.map(([, l]) => l.problem).filter(Boolean);
  if (problems.length && !confirm(`${problems.join('\n\n')}\n\nDelete the study anyway?`)) return;
  // Batches still processing would keep running (and be charged) with nowhere to deliver their results. (Not one
  // that a copy of this study, imported from a backup, also waits for: that copy collects it.) Then the batches
  // found for uploads of unknown outcome.
  const cancelled: string[] = [];
  const failed: string[] = [];
  for (const r of runs) {
    if (r.status !== 'submitted') continue;
    const c = await cancelRunBatches(r, true);
    cancelled.push(...c.cancelled);
    if (c.failed) failed.push(c.failed);
  }
  const found: [Run, string][] = [];
  for (const [r, l] of looks) {
    if (!l.cancelId) continue;
    const why = await cancelFoundUpload(r, l.cancelId);
    if (why) failed.push(why);
    else {
      cancelled.push(l.cancelId);
      found.push([r, l.cancelId]);
    }
  }
  if (failed.length && !confirm(`${failed.join('\n\n')}\n\n${alreadyCancelled(cancelled, 'study')}Delete the study anyway? A batch still running at the provider may be charged, and its results can't be collected here.`)) return;
  const all = id === state.currentId ? runs : await dbApi.listAllRuns().then((rs) => rs.filter((r) => r.studyId === id), () => []);
  await dbApi.deleteStudy(id);
  // (Once deleted: a study kept, e.g. because deleting failed, still looks for its own uploads' batches.)
  await forgetBatchesOf(all, looks.map(([, l]) => l.foundId));
  for (const [r, batchId] of found) toast(`The batch of run #${r.number}’s upload of unknown outcome (${batchId}) had reached the provider and was cancelled.`);
  for (const [r, l] of looks) if (l.keptFor.length) toast(keptMessage(r, l.keptFor));
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
  // One addition at a time (e.g. a folder dropped while a paste is being added): each sees the texts the one before
  // added, so nothing is added twice or gets an ID already in use.
  const turn = addQueue.then(() => addDocsNow(items, studyId));
  addQueue = turn.catch(() => undefined);
  return turn;
}
let addQueue: Promise<unknown> = Promise.resolve();

/** False when they could not be saved (or another study was opened meanwhile): the dialog then stays open. */
async function addDocsNow(items: { docId: string; text: string; meta: Record<string, string>; source: string }[], studyId?: string): Promise<boolean> {
  const cur = currentStudy();
  if (!cur || !items.length) return !!cur;
  if (studyId && cur.id !== studyId) {
    toast('Another study was opened while the files were being read, so nothing was added. Open the study again and add the files there.', 'error', true);
    return false;
  }
  // A text that is already here (same name, identical text), e.g. after dropping the whole folder again to add
  // a few new files, is skipped rather than added again as a copy. Same name with a different text is added.
  // (Versions before October 15, 2026 stored texts without surrounding blank lines and spaces: such a text also
  // counts as already here. Only the comparison ignores them; nothing stored or added is changed.) Only texts stored
  // before: two rows of one table with the same name and details (two people called John Smith from the UK, with
  // different answers of the owner's) are both added, the second with a suffix, as the import dialog says.
  const present = new Map<string, string[]>();
  for (const d of state.docs) present.set(nameOf(d), [...(present.get(nameOf(d)) ?? []), d.text]);
  const w = words(cur.prompt);
  const before = items.length;
  items = items.filter((it) => {
    const texts = present.get(nameOf(it)) ?? [];
    return !(texts.includes(it.text) || texts.includes(it.text.trim()));
  });
  const skipped = before - items.length;
  if (skipped) toast(`Skipped ${skipped.toLocaleString()} ${skipped === 1 ? w.one : w.many} already in this study (same name and identical ${w.one === 'entry' ? 'details' : 'text'}).`);
  if (!items.length) return true;
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
    return false;
  }
  // (Another study may have been opened while they were being saved: they belong to this one, not the one in view.)
  if (state.currentId !== cur.id) {
    toast(`Added ${docs.length} ${docs.length === 1 ? w.one : w.many} to “${cur.name}” (not to the study now open).`, 'success', true);
    return true;
  }
  set((s) => ({ docs: [...s.docs, ...docs] }));
  // (Named: another study may be opening while they were saved, and would be in view by the time this shows.)
  toast(`Added ${docs.length.toLocaleString()} ${docs.length === 1 ? w.one : w.many} to “${cur.name}”.`, 'success');
  // Ask the browser not to clear this site's data when disk space runs low (some browsers ask the user once).
  void navigator.storage?.persist?.().catch(() => undefined);
  if (renamed.length) {
    toast(`${renamed.length} ID${renamed.length === 1 ? ' was' : 's were'} already in use and got a suffix: ${renamed.slice(0, 3).join(', ')}${renamed.length > 3 ? ', …' : ''}`, 'error');
  }
  return true;
}

/**
 * Said when a change to texts' columns (labels, a sample, a removed column) could not be saved: it rewrites each text
 * it touches in full, text included, so a full storage needs about that much free space.
 */
function rewriteFailed(what: string, docs: Doc[], e: unknown): string {
  if (!isQuotaError(e)) return `${what}: ${storageError(e)}. Nothing was changed.`;
  const chars = docs.reduce((n, d) => n + d.text.length + JSON.stringify(d.meta).length, 0);
  const size = chars >= 1e6 ? `${Math.ceil(chars / 1e6).toLocaleString()} MB` : `${Math.max(1, Math.ceil(chars / 1e3)).toLocaleString()} KB`;
  const w = words(currentStudy()?.prompt ?? {});
  return `${what}: ${storageError(e)}. The change rewrites each of the ${docs.length.toLocaleString()} ${docs.length === 1 ? w.one : w.many} it touches in full, ${w.one === 'entry' ? 'details' : 'text'} included, so it needs about ${size} of free space. Nothing was changed.`;
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
    toast(rewriteFailed('The labels were not added', changed, e), 'error', true);
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
    toast(rewriteFailed('The column was not removed', changed, e), 'error', true);
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
  const kept = cur.description
    .split('\n')
    .filter((line) => !isSampleNote(line, column, value))
    .join('\n')
    .trim();
  const next: Study = { ...structuredClone(cur), description: `${kept ? kept + '\n' : ''}${note}`, updatedAt: nowIso() };
  try {
    await dbApi.putDocsAndStudy(changed, next);
  } catch (e) {
    toast(rewriteFailed('The sample was not marked', changed, e), 'error', true);
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

/** A note of a drawn sample of exactly this column = value ("Sample sample = validation (2026-10-22): …"), not of
 *  another value that starts the same way (e.g. "validation (2)"). */
function isSampleNote(line: string, column: string, value: string): boolean {
  const prefix = sampleNotePrefix(column, value);
  return line.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}\): /.test(line.slice(prefix.length));
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

/**
 * The earlier run whose prompt this one is: first one with exactly the same fingerprint (`hash`, display names
 * included; studies from the published app may hold one sent prompt under two versions, after a renamed field),
 * else one that sends the same.
 */
function samePromptRun(prompt: PromptSpec, runs: Run[], hash?: string): Run | undefined {
  const key = promptKey(prompt);
  return (hash ? runs.find((r) => r.snapshot.promptHash === hash) : undefined) ?? runs.find((r) => promptKey(r.snapshot.prompt) === key);
}

/** Prompt version numbers: prompts that send the same thing share a number; each new prompt gets the next one. */
export function versionFor(prompt: PromptSpec, runs: Run[], hash?: string): number {
  const existing = samePromptRun(prompt, runs, hash);
  if (existing) return existing.snapshot.promptVersion;
  return runs.reduce((m, r) => Math.max(m, r.snapshot.promptVersion), 0) + 1;
}

/**
 * What "Remaining" sends: the texts without a usable result from a run with the current prompt, model and effort,
 * leaving out those still waiting in a batch with them, and those of a batch upload whose outcome is unknown
 * (sending them again could pay twice: Retry failed on that run looks for its batch first).
 */
export function remainingDocs(st: Study, docs: Doc[], runs: Run[], results: Result[]): { todo: Doc[]; waiting: number; unknown: number; unknownRuns: number[] } {
  const key = promptKey(st.prompt);
  const same = new Set(
    runs
      .filter((r) => r.snapshot.model.provider === st.model.provider && r.snapshot.model.model === st.model.model && (r.snapshot.model.effort || '') === (st.model.effort || ''))
      .filter((r) => promptKey(r.snapshot.prompt) === key)
      .map((r) => r.id),
  );
  const done = new Set(results.filter((r) => r.status === 'ok' && same.has(r.runId)).map((r) => r.docId));
  const pending = new Set(runs.filter((r) => same.has(r.id) && (r.status === 'submitted' || r.status === 'running')).flatMap((r) => r.docIds));
  const unsure = runs.filter((r) => same.has(r.id) && (r.batch?.uploadUnknown || r.batch?.uploading));
  const unknownIds = new Set(unsure.flatMap((r) => r.docIds));
  const left = docs.filter((d) => !done.has(d.id));
  const heldBack = left.filter((d) => !pending.has(d.id) && unknownIds.has(d.id));
  const held = new Set(heldBack.map((d) => d.id));
  return {
    todo: left.filter((d) => !pending.has(d.id) && !unknownIds.has(d.id)),
    waiting: left.filter((d) => pending.has(d.id)).length,
    unknown: heldBack.length,
    // (Only the runs that hold back one of these texts.)
    unknownRuns: unsure.filter((r) => r.docIds.some((id) => held.has(id))).map((r) => r.number),
  };
}

export async function buildSnapshot(st: Study, batch = false): Promise<RunSnapshot> {
  // A prompt that sends the same as an earlier run's keeps that run's version and hash (only a display name differs),
  // both taken from the same run.
  const fingerprint = await promptFingerprint(st);
  const promptHash = samePromptRun(st.prompt, state.runs, fingerprint)?.snapshot.promptHash ?? fingerprint;
  const outputSchema = buildOutputSchema(st.prompt);
  const adapter = provider(st.model.provider);
  const model = structuredClone(st.model);
  delete (model as { refusalFallback?: unknown }).refusalFallback; // a setting removed in October 2026
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
    promptVersion: versionFor(st.prompt, state.runs, fingerprint),
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

/**
 * A batch upload cut off before the provider confirmed it (the page closed, or the run couldn't be saved after it):
 * recorded as an upload of unknown outcome, and the run (with nothing else waiting) back to how it was before.
 */
function markUploadUnknown(r: Run) {
  if (!r.batch?.uploading) return;
  const attempt = r.batch.uploading;
  delete r.batch.uploading;
  // (Its batch is already among the run's: nothing is unknown.)
  if (batchParts(r).some((p) => p.submittedAt === attempt.since)) return;
  r.batch.uploadUnknown = attempt;
  if (r.status === 'submitted' && !batchParts(r).some((p) => p.status === 'submitted')) {
    r.status = batchParts(r).some((p) => p.status === 'collected') ? 'completed' : 'failed';
    r.finishedAt = attempt.finishedBefore ?? r.finishedAt ?? nowIso();
  }
  r.error = UPLOAD_UNKNOWN;
}

/** Said before deleting a run whose batch upload could not be looked up (or a found batch not cancelled). */
const STILL_RUNNING = "may still run and be charged, and its results can't be collected here: check the provider's batch list (its console) first.";

/** Shown on a run whose batch upload may or may not have reached the provider. */
const UPLOAD_UNKNOWN =
  'A batch upload of this run was cut off (connection lost, or the page closed) before the provider confirmed it, so it may or may not have arrived. Retry failed (offered once no batch of the run is still processing) looks for it at the provider first, so nothing is paid for twice.';

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

/** The metadata an OpenAI batch is created with, naming its run and upload (never keys or texts). */
const uploadMetadata = (runId: string, attempt: UploadAttempt) => ({ annotation_desk_run: runId, annotation_desk_upload: attempt.since });

/** `heldBy`: the study whose run already has the batch (a copy of this study imported from a backup, which shares
 *  the upload, or the study it was copied from): the batch is then shared, as such copies share their batches.
 *  `stopped`: not sure only because a batch that may be the upload's was cancelled or has expired (nothing to stop). */
type Lookup = { found: { batchId: string; inputFileId?: string } | null; sure: boolean; why: string; heldBy?: string; stopped?: boolean };

/**
 * Every run in this browser: the stored ones and the open study's as this page has them (with a batch that went up
 * when its run could not be saved after it). A run of the open study may be listed twice.
 */
async function runsHere(): Promise<Run[]> {
  return [...(await dbApi.listAllRuns()), ...state.runs];
}

const studyName = (studyId: string) => state.studies.find((s) => s.id === studyId)?.name ?? 'another study';

/** The same upload in two runs: a run and its copy in a study imported from a backup, which keeps it as it was. */
const sameUpload = (a: UploadAttempt, b: UploadAttempt) =>
  a.since === b.since && a.requests === b.requests && (a.retryAt ?? '') === (b.retryAt ?? '') && (!a.inputFileId || !b.inputFileId || a.inputFileId === b.inputFileId);

// Batches of runs deleted in this browser, and batches a delete found and cancelled: never taken for a lost upload
// by their number of requests (the provider may not list a cancel at once, and a collected batch is not cancelled).
// Ids only, the latest few hundred (a lookup only sees batches created around its upload), in localStorage: if that
// is unavailable, batches the provider lists as cancelled are still left out.
const FORGOTTEN = 'annotation-desk-deleted-batches';

function forgottenBatches(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FORGOTTEN) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** Remember the batches of runs being deleted (and `found`: batches of their uploads of unknown outcome), except one
 *  another run here still collects or waits for. */
async function forgetBatchesOf(runs: Run[], found: string[]) {
  const gone = new Set(runs.map((r) => r.id));
  const others = (await runsHere().catch(() => [] as Run[])).filter((r) => !gone.has(r.id));
  const held = new Set(others.flatMap((r) => batchParts(r).map((p) => p.batchId)));
  const waiting = new Set(others.map((r) => unknownUpload(r)?.since).filter(Boolean));
  const ids = [...runs.flatMap((r) => batchParts(r).filter((p) => !held.has(p.batchId) && !waiting.has(p.submittedAt)).map((p) => p.batchId)), ...found].filter(Boolean);
  if (!ids.length) return;
  try {
    localStorage.setItem(FORGOTTEN, JSON.stringify([...new Set([...forgottenBatches(), ...ids])].slice(-500)));
  } catch {
    /* storage unavailable */
  }
}

/**
 * After an upload without an answer, look for the batch it may have created. First this very upload's batch, if a
 * run of another study here already has it (a copy of this run imported from a backup keeps the upload's time, which
 * a found batch is recorded with). Else among the batches created around the upload: the one with this upload's input
 * file or metadata (OpenAI; a copy has another run id, so its upload time is what counts), else, for an upload without
 * either (Anthropic, and OpenAI uploads before October 23, 2026), the one with the same number of requests that no
 * run here has (also no deleted run's, and none the provider lists as cancelled), or for OpenAI one still being
 * validated (listed with 0 requests) that was created after the upload began.
 * `sure`: the outcome is clear (exactly one such batch, or the provider answered and has none).
 */
async function lookUpUpload(p: ProviderId, key: string, runId: string, attempt: UploadAttempt): Promise<Lookup> {
  let listed: ListedBatch[];
  let runs: Run[];
  try {
    runs = await runsHere();
    for (const r of runs) {
      const part = r.id !== runId && r.batch?.provider === p ? batchParts(r).find((x) => x.submittedAt === attempt.since) : undefined;
      if (part) return { found: { batchId: part.batchId, inputFileId: part.inputFileId }, sure: true, why: '', heldBy: studyName(r.studyId) };
    }
    listed = await provider(p).listRecentBatches(key, attempt.since);
  } catch (e) {
    // (Said in brackets: without the message's own closing period.)
    return { found: null, sure: false, why: describeApiError(e).replace(/\.$/, '') };
  }
  const own = new Set(runs.filter((r) => r.id === runId).flatMap((r) => batchParts(r).map((x) => x.batchId)));
  let found = listed.filter((b) => !own.has(b.batchId) && ((!!attempt.inputFileId && b.inputFileId === attempt.inputFileId) || b.metadata?.annotation_desk_upload === uploadMetadata(runId, attempt).annotation_desk_upload));
  if (!found.length && !attempt.labelled && !attempt.inputFileId) {
    const known = new Set([...runs.flatMap((r) => batchParts(r).map((x) => x.batchId)), ...forgottenBatches()]);
    // (An upload that got no answer while the page was open created its batch, if any, before then: some minutes'
    // margin for the provider's clock.)
    const before = attempt.endedAt ? Date.parse(attempt.endedAt) + CLOCK_MARGIN_MS : Infinity;
    const alike = listed.filter(
      (b) =>
        !known.has(b.batchId) &&
        Date.parse(b.createdAt) <= before &&
        (b.requests === attempt.requests || (p === 'openai' && b.requests === 0 && b.status === 'validating' && b.createdAt >= attempt.since)),
    );
    found = alike.filter((b) => !b.stopped);
    // A cancelled or expired batch is never taken by its number of requests alone. But it may be the upload's (e.g.
    // cancelled in the provider's console, or by a delete the owner then said no to): then none is not said to be there.
    const stopped = alike.filter((b) => b.stopped).map((b) => b.batchId);
    if (!found.length && stopped.length) {
      const which = stopped.length === 1 ? `a batch there with the same number of requests (${stopped[0]}) was` : `${stopped.length} batches there with the same number of requests (${stopped.join(', ')}) were`;
      return { found: null, sure: false, stopped: true, why: `${which} cancelled or expired, so it can't be told whether that upload arrived` };
    }
  }
  if (found.length > 1) return { found: null, sure: false, why: `${found.length} batches there could be the one of that upload` };
  const b = found[0];
  if (!b) return { found: null, sure: true, why: '' };
  const holder = runs.find((r) => r.id !== runId && batchParts(r).some((x) => x.batchId === b.batchId));
  return { found: { batchId: b.batchId, inputFileId: b.inputFileId }, sure: true, why: '', ...(holder ? { heldBy: studyName(holder.studyId) } : {}) };
}

/** The batch an upload without an answer created, if it can be found for certain (null otherwise). */
async function findUploadedBatch(p: ProviderId, key: string, runId: string, attempt: UploadAttempt): Promise<{ batchId: string; inputFileId?: string } | null> {
  return (await lookUpUpload(p, key, runId, attempt)).found;
}

/**
 * Record requests that a retry of the run (begun at `at`) sent as a batch: added to that retry's record (made when
 * an earlier batch of it went up, e.g. the first of several), or a new record.
 */
function addRetryBatch(run: Run, at: string, requests: number) {
  const entry = run.retries?.find((x) => x.at === at);
  if (entry) Object.assign(entry, { requests: entry.requests + requests, asBatch: true, counted: 'sent' as const });
  else run.retries = [...(run.retries ?? []), { at, requests, asBatch: true, counted: 'sent' as const }].sort((a, b) => a.at.localeCompare(b.at));
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
  retry?: Retry,
): Promise<boolean> {
  const { snapshot } = run;
  const p = snapshot.model.provider;
  const adapter = provider(p);
  const groups = groupForBatches(p, requestBytes(snapshot.requestBase, items)).map((g) => g.map((i) => items[i]));
  const parts = [...earlier];
  // (An earlier upload of unknown outcome stays on record until a batch of this retry has gone up: if none does, it
  // is still looked for, and its requests are still held back from Remaining.)
  const record = (extra: Partial<NonNullable<Run['batch']>>) => {
    const { uploading: _u, uploadUnknown: _k, ...rest } = run.batch ?? ({} as NonNullable<Run['batch']>);
    const still = parts.length === earlier.length && retry?.before.uploadUnknown ? { uploadUnknown: retry.before.uploadUnknown } : {};
    run.batch = { ...rest, provider: p, batchId: parts[0]?.batchId ?? '', inputFileId: parts[0]?.inputFileId, map, lastStatus: 'submitted', lastCheckedAt: nowIso(), parts, ...still, ...extra };
  };
  let sent = 0;
  let problem = '';
  let unknown: UploadAttempt | null = null;
  let cancelFailed = '';
  cancelRequested.delete(run.id);
  uploadingRun = run.id;
  try {
    for (const [g, group] of groups.entries()) {
      if (cancelRequested.has(run.id)) break;
      const which = groups.length > 1 ? `batch ${g + 1} of ${groups.length}` : 'a batch';
      set({ submitting: `Uploading ${which} (${group.length.toLocaleString()} request${group.length === 1 ? '' : 's'}) to ${adapter.label}…` });
      const attempt: UploadAttempt = {
        since: nowIso(),
        requests: group.length,
        finishedBefore: retry ? retry.before.finishedAt : null,
        ...(retry ? { retryAt: retry.at } : {}),
        ...(p === 'openai' ? { labelled: true } : {}),
      };
      try {
        record({ uploading: attempt });
        run.status = 'submitted';
        run.finishedAt = null;
        await saveRun(run);
      } catch (e) {
        // (Not sent, so no upload is under way: not left marked as one in this page.)
        delete run.batch?.uploading;
        problem = `${sent ? 'The remaining batches were not sent' : 'Nothing was sent'}: the run could not be saved, because ${storageError(e)}.`;
        break;
      }
      let handle: { batchId: string; inputFileId?: string } | null;
      try {
        handle = await adapter.submitBatch(key, snapshot.requestBase, group, {
          metadata: uploadMetadata(run.id, attempt),
          // (OpenAI: the input file is on record before the batch is started, so a batch started without an answer
          // is found by it, also after a reload. If this save fails, the batch's metadata still names the upload.)
          onFile: async (fileId) => {
            attempt.inputFileId = fileId;
            record({ uploading: attempt });
            await saveRun(run).catch(() => undefined);
          },
        });
      } catch (e) {
        if (refusedByProvider(e)) {
          const rest = sent ? ` The ${sent} already submitted continue; send the rest with Retry failed when ${sent === 1 ? 'it has' : 'they have'} finished.` : '';
          problem = `Submitting ${which} failed: ${describeApiError(e).replace(/\.$/, '')}.${rest}`;
          break;
        }
        // No answer: the provider may have created the batch anyway. Look for it rather than risk a second one.
        const fileId = (e as { inputFileId?: string } | null)?.inputFileId;
        if (fileId) attempt.inputFileId = fileId;
        handle = await findUploadedBatch(p, key, run.id, attempt);
        if (!handle) {
          unknown = { ...attempt, endedAt: nowIso() };
          problem = `Submitting ${which} got no answer (${describeApiError(e)}), so it is not known whether ${adapter.label} received it. Don't send these requests again until you have checked the provider's batch list; Retry failed looks for the batch there first.`;
          break;
        }
      }
      parts.push({ batchId: handle.batchId, inputFileId: handle.inputFileId, status: 'submitted', lastStatus: 'submitted', submittedAt: attempt.since });
      sent++;
      if (retry) addRetryBatch(run, retry.at, group.length);
      // Cancelled while this batch was going up: stop it right away (what finished before is still collected).
      if (cancelRequested.has(run.id)) {
        try {
          await adapter.cancelBatch(key, handle.batchId);
        } catch (e) {
          const ended = await adapter.checkBatch(key, handle.batchId).then((st) => st.done, () => false);
          if (!ended) cancelFailed = describeApiError(e).replace(/\.$/, '');
        }
      }
      try {
        record({});
        await saveRun(run);
      } catch (e) {
        // (The record before the upload stays, marked as an upload under way: after a reload, Retry failed finds the
        // batch at the provider. Until then this page keeps it and collects it.)
        problem = `${parts
          .slice(earlier.length)
          .map((x) => x.batchId)
          .join(', ')} went up to ${adapter.label}, but the run could not be saved, because ${storageError(e)}. This page still collects its results while it stays open; after a reload, Retry failed finds the batch at the provider. Nothing else was sent.`;
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
      run.finishedAt = run.status === 'submitted' ? null : (retry?.before.finishedAt ?? nowIso());
      await saveRun(run);
    } else if (!problem.includes('could not be saved')) {
      if (!sent && !retry) {
        await dbApi.deleteRun(run.id);
        set((s) => ({ runs: s.runs.filter((r) => r.id !== run.id) }));
      } else if (!sent && retry) {
        record({});
        const { uploadUnknown: _kept, ...before } = retry.before;
        Object.assign(run, before);
        await saveRun(run);
      } else {
        record({});
        await saveRun(run);
      }
    }
  } catch (e) {
    problem ||= `The run could not be saved, because ${storageError(e)}.`;
  }
  if (problem) toast(problem, 'error', true);
  else if (cancelled && cancelFailed) {
    toast(`Upload stopped: ${sent} of ${groups.length} batches had gone up. The last one could not be cancelled (${cancelFailed}): it runs on at ${adapter.label} and its results are collected into run #${run.number}.`, 'error', true);
  } else if (cancelled) toast(`Upload stopped: ${sent} of ${groups.length} batches had gone up and ${sent === 1 ? 'was' : 'were'} cancelled at ${adapter.label}. Results finished before cancelling are still collected.`, 'error', true);
  else if (sent === groups.length) {
    toast(`${sent > 1 ? `${sent} batches` : 'Batch'} submitted (run #${run.number}). Results usually arrive within an hour; this page checks every minute while open.`, 'success');
  }
  return sent > 0;
}

type Task = { doc: Doc; replicate: number; part: Record<string, unknown> };

/** What the frozen settings hold but the adapter leaves out when sending (the retired `fallbacks` of day-one runs). */
function omittedFrom(run: Run): Pick<ResultLog, 'omitted'> {
  return run.snapshot.model.provider === 'anthropic' && 'fallbacks' in run.snapshot.requestBase ? { omitted: ['fallbacks'] } : {};
}

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

/** HTTP 400 messages about one text rather than the settings: too long for the model, or flagged by the provider. */
const PER_TEXT_400 = /too long|context length|context window|context limit|maximum context|too many tokens|invalid_prompt|flagged|usage polic|safety|content (policy|filter)/i;

/**
 * An error that says nothing about one text, so it would hit every request the same way (null: it may be about
 * its text): no connection to the provider at all (offline, an extension or firewall blocking it), an exhausted
 * account (OpenAI's 429 with code or type insufficient_quota or billing_not_active, not a rate limit whose message
 * links the billing page; Anthropic's 400 "credit balance is too low"), or the settings shared by every request (HTTP 401, 403, 404, and
 * 400 except the messages about one text). Such a 400 is only taken to be about the settings when it repeats with
 * the same message (`same`), since an unknown wording may still be about one text. The same in first runs and retries.
 */
function sharedFailure(e: unknown): { connection?: boolean; same?: string } | null {
  if (isConnectionError(e)) return { connection: true };
  const err = e as { status?: unknown; code?: unknown; type?: unknown } | null;
  const status = err?.status;
  if (typeof status !== 'number') return null;
  const text = describeApiError(e);
  if (status === 429) return [err?.code, err?.type].some((x) => x === 'insufficient_quota' || x === 'billing_not_active') ? {} : null;
  if ([401, 403, 404].includes(status)) return {};
  if (status !== 400) return null;
  if (/credit balance/i.test(text)) return {};
  if (PER_TEXT_400.test(`${String(err?.code ?? '')} ${text}`)) return null;
  // (Without the ids each answer carries, e.g. a request id.)
  const same = text
    .replace(/\b(req|msg|msgbatch|batch|file|resp)_[A-Za-z0-9]+/g, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/request[ _-]?id\W*\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { same };
}

/** A retry: when it began, and the run as it was before (restored if nothing of it goes out). */
type Retry = { at: string; before: Pick<Run, 'status' | 'error' | 'finishedAt'> & { uploadUnknown?: UploadAttempt } };

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
  // Stopped because every request fails the same way: no further requests are sent; those under way finish and are kept.
  let stopping = false;
  // Requests answered (stored) so far, how many of them failed in a way that would hit every request, for which
  // texts (one text's replicates never stop a run), and the messages of those that were HTTP 400s.
  let answered = 0;
  let sharedFailures = 0;
  const sharedDocs = new Set<string>();
  const messages400 = new Set<string>();
  let connection = false;
  let next = 0;
  // Requests whose sending began: a Cancel or a failed save stops those under way, which may have reached the
  // provider (and be charged) without an answer being stored.
  let began = 0;
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
      let shared: ReturnType<typeof sharedFailure> = null;
      try {
        began++;
        outcome = await adapter.send(key, snapshot.requestBase, t.part, signal);
      } catch (e) {
        if (signal.aborted) return;
        error = describeApiError(e);
        shared = sharedFailure(e);
      }
      const result = makeResult(run, t.doc, t.replicate, requestedAt, outcome, error, Math.round(performance.now() - started));
      const log: ResultLog = { id: result.id, runId: run.id, studyId: run.studyId, requestPart: t.part, response: outcome?.response ?? { error }, ...omittedFrom(run) };
      try {
        // (An earlier attempt it replaces is logged as today's rules read it, e.g. an old answer stored as "ok".)
        await dbApi.putResult(result, log, (prev) => applyTodaysRules([prev], [run]));
      } catch (e) {
        // Without a saved result, sending more would only pay for answers that are lost.
        const others = Math.min(snapshot.options.concurrency, tasks.length) - 1;
        if (!signal.aborted) {
          run.error = `Stopped: a result could not be saved in this browser, because ${storageError(e)}.${others > 0 ? ` Answers to up to ${others} other requests that were under way could not be kept either.` : ''}`;
        }
        job.abort.abort();
        return;
      }
      queueResult(result);
      const failed = result.status === 'error';
      set((s) => (s.job ? { job: { ...s.job, done: s.job.done + 1, failed: s.job.failed + (failed ? 1 : 0) } } : {}));
      // Stop when the first 3 or more requests answered, for at least 2 texts, all failed in a way that would hit
      // every request (the settings, the connection, the account), the 400s among them with the same message.
      // Answers that came back refused, cut off or unreadable say something about one text.
      answered++;
      if (shared) {
        sharedFailures++;
        sharedDocs.add(t.doc.id);
        if (shared.same !== undefined) messages400.add(shared.same);
        if (shared.connection) connection = true;
      }
      if (!stopping && answered >= 3 && sharedFailures === answered && sharedDocs.size >= 2 && messages400.size <= 1) {
        stopping = true;
        run.error = `${retry ? 'Retry stopped' : 'Stopped'}: the first ${answered} requests all failed the same way, which points to ${connection ? 'the connection' : 'the settings or the account'} rather than the ${words(snapshot.prompt).many}: ${result.error}`;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(snapshot.options.concurrency, tasks.length)) }, worker));
  } finally {
    await finishTasks(run, job, doneMessage, { retry, stopping, began });
  }
}

async function finishTasks(run: Run, job: Job, doneMessage: string, how: { retry?: Retry; stopping: boolean; began: number }) {
  const { retry, stopping } = how;
  const signal = job.abort.signal;
  flushResults();
  const final = getState().job;
  const stopped = signal.aborted || stopping;
  const stoppedByErrors = stopping || (signal.aborted && !!run.error);
  run.status = !stopped ? 'completed' : retry ? retry.before.status : stoppedByErrors ? 'failed' : 'cancelled';
  if (retry && stopped && !stoppedByErrors) run.error = retry.before.error;
  // Stored with the results, so complete whatever happened during the run.
  const stored = await dbApi.getResultsForRun(run.id).catch(() => null);
  if (stored) {
    const replaced = replacedFrom(stored);
    if (replaced) run.replaced = replaced;
  }
  if (retry) {
    // Record the requests it re-sent: every one whose sending began (a retry stopped early sent fewer than it
    // planned; none: no retry), and how many of them were stopped (Cancel, a failed save) before an answer was stored.
    const answered = stored ? stored.filter((x) => x.requestedAt >= retry.at).length : (getState().job?.done ?? 0);
    const resent = Math.max(how.began, answered);
    const others = (run.retries ?? []).filter((x) => x.at !== retry.at);
    run.retries = resent ? [...others, { at: retry.at, requests: resent, counted: 'sent' as const, ...(resent > answered ? { unanswered: resent - answered } : {}) }] : others;
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
    // A batch upload whose outcome is unknown: find that batch at the provider first, rather than pay twice. (Asked
    // here, not before: the lookup costs nothing.)
    const unknown = original.batch?.uploadUnknown;
    if (unknown && original.batch) {
      const label = provider(original.batch.provider).label;
      set({ submitting: `Looking for the batch at ${label}…` });
      const look = await lookUpUpload(original.batch.provider, key, original.id, unknown);
      const found = look.found;
      if (found) {
        const run: Run = structuredClone(original);
        const parts = [...batchParts(run), { batchId: found.batchId, inputFileId: found.inputFileId, status: 'submitted' as const, lastStatus: 'submitted', submittedAt: unknown.since }];
        const { uploadUnknown: _gone, ...batch } = run.batch!;
        run.batch = { ...batch, batchId: parts[0].batchId, inputFileId: parts[0].inputFileId, parts, lastStatus: 'submitted' };
        run.status = 'submitted';
        run.error = null;
        run.finishedAt = null;
        // An upload made by a retry is recorded as that retry (added to what its other batches sent).
        if (unknown.retryAt) addRetryBatch(run, unknown.retryAt, unknown.requests);
        await saveRun(run);
        // (Found by a copy of this study first: both collect it.)
        const shared = look.heldBy ? ` It is the same batch that “${look.heldBy}” (another study here that shares this upload: a copy from a backup, or the study this one was copied from) collects.` : '';
        toast(`Found the batch that was uploaded (${found.batchId}): its results are collected into run #${run.number}. Nothing was sent again.${shared}`, 'success', true);
        return;
      }
      const at = fmtDateTime(unknown.since);
      const n = retryableCount(original, state.results, state.docs);
      const what = `${n.toLocaleString()} failed (or never sent) request${n === 1 ? '' : 's'} of run #${original.number}`;
      if (
        !confirm(
          `${look.sure ? `No batch from the upload of ${at} (${unknown.requests.toLocaleString()} requests) was found at ${label}.` : `The batch upload of ${at} (${unknown.requests.toLocaleString()} requests) could not be looked up at ${label} (${look.why}).`} If it did arrive, sending again pays twice. Check the provider's batch list if in doubt.\n\nSend the ${what} again as a new batch (half price; results usually within an hour, collected into the same run)?`,
        )
      )
        return;
    }
    // What is stored now (not what this page loaded): answers may have arrived since. Read by today's rules, as the
    // page shows them (an answer older versions stored as usable may count as failed now, and is re-sent).
    const stored = await dbApi.getResultsForRun(runId);
    applyTodaysRules(stored, state.runs);
    ok = new Set(stored.filter((r) => r.status === 'ok').map((r) => r.id));
  } catch (e) {
    toast(`Could not prepare the retry: ${storageError(e)}`, 'error', true);
    return;
  } finally {
    set({ submitting: '' });
  }
  const run: Run = structuredClone(getState().runs.find((r) => r.id === runId) ?? original);
  const tasks = buildTasks(run, (docId, rep) => !ok.has(`${run.id}:${docId}:${rep}`));
  if (!tasks.length) return toast(`Run #${run.number} has no failed requests.`);
  // (An upload of unknown outcome stays on record until a batch of this retry has gone up.)
  const retry: Retry = { at: nowIso(), before: { status: run.status, error: run.error, finishedAt: run.finishedAt, uploadUnknown: run.batch?.uploadUnknown } };
  run.error = null;
  if (run.mode === 'batch' && run.batch) {
    // A batch run's failed requests go out as a new batch (half price), collected into the same run.
    const map = { ...run.batch.map };
    // (Named after the retry's time, so they never repeat an earlier retry's names.)
    const n = Date.parse(retry.at).toString(36);
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
  run.retries = [...(run.retries ?? []), { at: retry.at, requests: 0, counted: 'sent' }];
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

/** A run's batch upload whose outcome is unknown (cut off, or marked as under way while no upload is going on). */
export function unknownUpload(run: Run): UploadAttempt | undefined {
  return run.batch?.uploadUnknown ?? (run.batch?.uploading && uploadingRun !== run.id ? run.batch.uploading : undefined);
}

/**
 * What deleting a run (or its study) does with a batch upload of unknown outcome, found out before anything is
 * cancelled: that batch is looked for at the provider, as Retry failed does, to be cancelled once the owner has
 * answered every question, like a batch still running when its run is deleted (it would otherwise run on and be
 * charged with nowhere to deliver, and Remaining would send the same requests again). Not when another study here
 * shares that upload (a copy imported from a backup, or the study it was copied from): its batch is left to it.
 * `problem`: why deleting may leave a batch at the provider, said in full ('' if there is nothing to ask);
 * `cancelId`: the batch found, still running; `foundId`: the batch found; `keptFor`: the studies it is left to.
 */
export type UnknownLook = { problem: string; cancelId: string; foundId: string; keptFor: string[] };

export async function lookUpUnknownUpload(run: Run): Promise<UnknownLook> {
  const none: UnknownLook = { problem: '', cancelId: '', foundId: '', keptFor: [] };
  const attempt = unknownUpload(run);
  if (!attempt || !run.batch) return none;
  const keptFor = await sharedUnknownUpload(run).catch(() => [] as string[]);
  if (keptFor.length) return { ...none, keptFor };
  const adapter = provider(run.batch.provider);
  const upload = uploadName(run, attempt);
  const key = state.keys[run.batch.provider];
  if (!key) return { ...none, problem: `${upload} could not be looked up at ${adapter.label}: no ${adapter.label} API key is set (API keys, top right). If that batch did arrive, it ${STILL_RUNNING}` };
  const busy = state.submitting;
  if (!busy) set({ submitting: `Looking for the batch at ${adapter.label}…` });
  try {
    const look = await lookUpUpload(run.batch.provider, key, run.id, attempt);
    // (A batch that may be the upload's but was cancelled or has expired: nothing there runs on.)
    if (look.stopped) return none;
    if (!look.sure) return { ...none, problem: `${upload} could not be looked up at ${adapter.label} (${look.why}). If that batch did arrive, it ${STILL_RUNNING}` };
    if (!look.found) return none;
    if (look.heldBy) return { ...none, keptFor: [look.heldBy] };
    const id = look.found.batchId;
    // (One that has already ended has nothing left to stop: its results are paid for.)
    const ended = await adapter.checkBatch(key, id).then((st) => st.done, () => false);
    if (ended) return { ...none, foundId: id, problem: `${upload} did arrive (${id}) and has already ended: its results are paid for, and Retry failed on the run collects them.` };
    return { ...none, cancelId: id, foundId: id };
  } finally {
    if (!busy) set({ submitting: '' });
  }
}

const uploadName = (run: Run, attempt: UploadAttempt) =>
  `The batch upload of ${fmtDateTime(attempt.since)} (${attempt.requests.toLocaleString()} request${attempt.requests === 1 ? '' : 's'}) of run #${run.number}`;

/** Cancel the batch found for a run's upload of unknown outcome. Returns why it could not be ('' if it was, or had
 *  ended meanwhile). */
export async function cancelFoundUpload(run: Run, id: string): Promise<string> {
  const attempt = unknownUpload(run);
  if (!attempt || !run.batch) return '';
  const adapter = provider(run.batch.provider);
  const key = state.keys[run.batch.provider];
  try {
    await adapter.cancelBatch(key, id);
    return '';
  } catch (e) {
    const ended = await adapter.checkBatch(key, id).then((st) => st.done, () => false);
    return ended ? '' : `${uploadName(run, attempt)} did arrive (${id}) but could not be cancelled (${describeApiError(e).replace(/\.$/, '')}). It ${STILL_RUNNING}`;
  }
}

/** The same in one step: look the batch up, and cancel it if it is there and running. */
export async function cancelUnknownUpload(run: Run): Promise<{ problem: string; cancelled: string; keptFor?: string[] }> {
  const look = await lookUpUnknownUpload(run);
  const kept = look.keptFor.length ? { keptFor: look.keptFor } : {};
  if (!look.cancelId) return { problem: look.problem, cancelled: '', ...kept };
  const problem = await cancelFoundUpload(run, look.cancelId);
  return { problem, cancelled: problem ? '' : look.cancelId };
}

/**
 * Studies here with a run that shares this run's upload of unknown outcome (a copy imported from a backup keeps it
 * as it was, or the study it was copied from): the same upload still unknown there, or its batch found there.
 */
export async function sharedUnknownUpload(run: Run): Promise<string[]> {
  const mine = unknownUpload(run);
  if (!mine || !run.batch) return [];
  const out = new Set<string>();
  for (const r of await runsHere()) {
    if (r.id === run.id || r.batch?.provider !== run.batch.provider) continue;
    const theirs = unknownUpload(r);
    if ((theirs && sameUpload(theirs, mine)) || batchParts(r).some((p) => p.submittedAt === mine.since)) out.add(studyName(r.studyId));
  }
  return [...out];
}

/** Said when a batch could not be cancelled after others were: those stay cancelled whatever the answer. */
const alreadyCancelled = (ids: string[], what: 'run' | 'study') =>
  ids.length ? `${ids.join(', ')} ${ids.length === 1 ? 'was' : 'were'} cancelled already and ${ids.length === 1 ? 'stays' : 'stay'} cancelled if you keep the ${what}. ` : '';

const keptMessage = (run: Run, studies: string[]) =>
  `The batch of run #${run.number}’s upload of unknown outcome, if it arrived, is left running for ${studies.map((x) => `“${x}”`).join(', ')} (another study here that shares that upload: a copy from a backup, or the study this one was copied from), where Retry failed finds it.`;

/**
 * Delete a run (its first question already asked by the Runs view). Every further question comes before anything is
 * cancelled, so a run kept at one keeps its batches: an upload of unknown outcome that can't be looked up, or whose
 * batch has ended. Then its batches still processing are cancelled (not one another study here also waits for) and
 * the batch found for its upload, and a cancel that fails is asked about. Its batches are remembered, so that no
 * later lost upload is taken for one of them.
 */
export async function removeRun(runId: string) {
  const run = state.runs.find((r) => r.id === runId);
  if (!run) return;
  if (uploadingRun === runId) return toast('A batch of this run is being uploaded: wait until that is done.', 'error');
  const look = await lookUpUnknownUpload(run);
  if (look.problem && !confirm(`${look.problem} Deleting the run also lets Remaining send these requests again.\n\nDelete run #${run.number} anyway?`)) return;
  const c = run.status === 'submitted' ? await cancelRunBatches(run, true) : { cancelled: [] as string[], failed: '' };
  const notCancelled = look.cancelId ? await cancelFoundUpload(run, look.cancelId) : '';
  const cancelled = [...c.cancelled, ...(look.cancelId && !notCancelled ? [look.cancelId] : [])];
  const failed = [c.failed, notCancelled].filter(Boolean);
  if (failed.length && !confirm(`${failed.join('\n\n')}\n\n${alreadyCancelled(cancelled, 'run')}Delete run #${run.number} anyway? A batch still running at the provider may be charged, and its results can't be collected here.`)) return;
  await deleteRunById(runId);
  // (Once deleted: a run kept, e.g. because deleting failed, still looks for its own upload's batch.)
  if (!state.runs.some((r) => r.id === runId)) await forgetBatchesOf([run], [look.foundId]);
  if (look.cancelId && cancelled.includes(look.cancelId)) toast(`The batch of that upload (${look.cancelId}) had reached the provider and was cancelled.`);
  if (look.keptFor.length) toast(keptMessage(run, look.keptFor));
}

export async function deleteRunById(runId: string) {
  if (uploadingRun === runId) return toast('A batch of this run is being uploaded: wait until that is done.', 'error');
  try {
    await dbApi.deleteRun(runId);
  } catch (e) {
    return toast(`The run was not deleted: ${storageError(e)}.`, 'error', true);
  }
  set((s) => ({ runs: s.runs.filter((r) => r.id !== runId), results: s.results.filter((r) => r.runId !== runId) }));
}

export async function renameRun(runId: string, label: string) {
  const run = state.runs.find((r) => r.id === runId);
  if (!run) return;
  try {
    await saveRun({ ...run, label }, true);
  } catch (e) {
    toast(`The run's label was not saved: ${storageError(e)}.`, 'error', true);
  }
}

// ---------- batches ----------

const checking = new Set<string>();
// Runs whose batch results could not be stored: said once per session, not at every quiet check (run id → that
// message, taken away once the results are saved).
const saveFailureShown = new Map<string, string>();
// Batches whose results could not be stored: not fetched again by the quiet checks (also when the run record
// itself couldn't be saved with that mark), only when the owner checks by hand.
const saveFailedBatches = new Set<string>();

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
    // (Only the run's record could not be saved, its results were.)
    let recordError = '';
    // (Storage full: the reason given already says how to free space.)
    let full = false;
    // Batches collected by this check (id → the provider's status for it).
    const collectedNow = new Map<string, string>();
    for (const p of parts) {
      if (p.status !== 'submitted') continue;
      // Results that didn't fit: fetched again only when the owner asks (after freeing space).
      if ((p.saveFailed || saveFailedBatches.has(p.batchId)) && quiet) continue;
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
      let c: { ok: number; failed: number };
      try {
        c = await storeBatchResults(run, lines, p.submittedAt ?? run.createdAt, endedAt);
      } catch (e) {
        saveError = storageError(e);
        full = isQuotaError(e);
        p.saveFailed = nowIso();
        saveFailedBatches.add(p.batchId);
        p.lastStatus = `${st.status}; results not saved`;
        continue;
      }
      delete p.saveFailed;
      delete p.resultsSaved;
      saveFailedBatches.delete(p.batchId);
      collectedNow.set(p.batchId, st.status);
      counts.ok += c.ok;
      counts.failed += c.failed;
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
    // The stored batches, updated, plus any this page knows of that the stored record lacks (a batch that went up
    // when the run could not be saved after it): never dropped.
    const merged = [
      ...batchParts(latest).map((p) => parts.find((q) => q.batchId === p.batchId) ?? p),
      ...parts.filter((q) => !batchParts(latest).some((p) => p.batchId === q.batchId)),
    ];
    const waiting = merged.filter((p) => p.status === 'submitted');
    const lastStatus = waiting.map((p) => p.lastStatus).join('; ') || 'ended';
    const updated: Run = { ...latest, batch: { ...latest.batch, parts: merged, batchId: merged[0]?.batchId ?? latest.batch.batchId, lastStatus, lastCheckedAt: nowIso() } };
    // Likewise a retry this page recorded when its batch went up, which the stored record lacks: kept (with the
    // larger count, as its batches go up one by one), so the retry is never lost from the run's record.
    for (const x of run.retries ?? []) {
      const have = updated.retries?.find((y) => y.at === x.at);
      if (!have) updated.retries = [...(updated.retries ?? []), { ...x }].sort((a, b) => a.at.localeCompare(b.at));
      else if (x.requests > have.requests) updated.retries = updated.retries!.map((y) => (y === have ? { ...x } : y));
    }
    // An upload still marked as under way, but not going on in this page: its outcome is unknown, unless its batch is
    // one this page knows (it went up, but the run could not be saved after it). A known batch is never also "unknown".
    const knownUpload = (a: UploadAttempt | undefined) => !!a && merged.some((p) => p.submittedAt === a.since);
    if (updated.batch!.uploading && uploadingRun !== runId) {
      const { uploading, ...rest } = updated.batch!;
      updated.batch = knownUpload(uploading) ? rest : { ...rest, uploadUnknown: uploading };
    }
    if (knownUpload(updated.batch!.uploadUnknown)) {
      const { uploadUnknown: _known, ...rest } = updated.batch!;
      updated.batch = rest;
      if (updated.error === UPLOAD_UNKNOWN) updated.error = null;
    }
    const waitingError = updated.error;
    // Replaced attempts (and their tokens) are kept with the results.
    const stored = await dbApi.getResultsForRun(runId).catch(() => null);
    const replacedNow = stored ? replacedFrom(stored) : undefined;
    if (replacedNow) updated.replaced = replacedNow;
    if (!waiting.length) {
      // Every batch is in. The run failed only if no batch returned anything.
      updated.status = merged.some((p) => p.status === 'collected') ? 'completed' : 'failed';
      updated.finishedAt = merged.map((p) => p.endedAt ?? '').sort().at(-1) || nowIso();
      // Errors of the batches sent since the last retry (a retry replaces what failed before it).
      const since = updated.retries?.at(-1)?.at ?? '';
      const current = merged.filter((p) => (p.submittedAt ?? '') >= since);
      const allErrors = [...(updated.batch!.uploadUnknown ? [UPLOAD_UNKNOWN] : []), ...current.map((p) => p.error).filter((x): x is string => !!x)];
      updated.error = allErrors.length ? allErrors.join(' ') : null;
    }
    let saved = true;
    try {
      await saveRun(updated);
    } catch (e) {
      saved = false;
      // The results are stored, but not the run's record of them (e.g. storage full): the run stays waiting here,
      // its collected batches shown as not recorded (in the notice and the Runs view) and not fetched again by the
      // quiet checks, only when the owner checks after freeing space (the answers are then not stored twice).
      const reason = storageError(e);
      if (collectedNow.size && !saveError) [recordError, full] = [reason, isQuotaError(e)];
      else if (!collectedNow.size && !saveError && !quiet) toast(`Run #${run.number} could not be saved: ${reason}.`, 'error');
      const now = nowIso();
      const shownParts = merged.map((p) =>
        collectedNow.has(p.batchId) ? { ...p, status: 'submitted' as const, saveFailed: now, resultsSaved: true, lastStatus: `${collectedNow.get(p.batchId)}; run record not saved` } : p,
      );
      for (const id of collectedNow.keys()) saveFailedBatches.add(id);
      const shown: Run = {
        ...updated,
        status: 'submitted',
        finishedAt: null,
        error: waitingError,
        batch: { ...updated.batch!, parts: shownParts, lastStatus: shownParts.filter((p) => p.status === 'submitted').map((p) => p.lastStatus).join('; ') },
      };
      if (state.currentId === run.studyId) set((s) => ({ runs: s.runs.map((r) => (r.id === runId ? shown : r)) }));
    }
    if (saved && !merged.some((p) => p.saveFailed) && saveFailureShown.has(runId)) {
      dismissToast(saveFailureShown.get(runId)!);
      saveFailureShown.delete(runId);
    }
    if (saved && !waiting.length) {
      const mine = state.currentId === run.studyId ? state.results.filter((r) => r.runId === run.id) : null;
      const ok = mine ? mine.filter((r) => r.status === 'ok').length : counts.ok;
      const failed = mine ? mine.length - ok : counts.failed;
      const unsure = updated.batch!.uploadUnknown ? ' One of its batch uploads may or may not have reached the provider: Retry failed looks for it first.' : '';
      toast(
        updated.status === 'failed' ? `Batch run #${run.number}: ${updated.error}` : `Batch run #${run.number} finished: ${ok} ok, ${failed} failed.${unsure}`,
        failed || errors.length || unsure ? 'error' : 'success',
        !!unsure,
      );
    } else if (saveError || recordError) {
      if (!quiet || !saveFailureShown.has(runId)) {
        if (saveFailureShown.has(runId)) dismissToast(saveFailureShown.get(runId)!);
        const what = saveError ? `the results arrived but could not be saved, because ${saveError}` : `its results were saved, but the run’s own record could not be saved, because ${recordError}`;
        const text = `Batch run #${run.number}: ${what}. ${full ? 'Then click' : 'Free some space, then click'} Check now on the Workbench (Check under Runs & agreement).`;
        saveFailureShown.set(runId, showToast(text, 'error', true));
      }
    } else if (!quiet && saved) {
      toast(`Batch run #${run.number}: ${lastStatus}.`, lookupError ? 'error' : undefined);
    }
  } catch (e) {
    if (!quiet) toast(`Could not check batch: ${isQuotaError(e) ? storageError(e) : describeApiError(e)}`, 'error');
  } finally {
    checking.delete(runId);
  }
}

async function storeBatchResults(run: Run, lines: BatchLine[], requestedAt: string, completedAt: string): Promise<{ ok: number; failed: number }> {
  // Read the run's own texts (not the open study's): the user may switch studies while results are collected.
  const docsById = new Map((await dbApi.getDocsForStudy(run.studyId)).map((d) => [d.id, d]));
  const adapter = provider(run.snapshot.model.provider);
  const counts = { ok: 0, failed: 0 };
  const stored: Result[] = [];
  try {
    for (const line of lines) {
      const ref = run.batch!.map[line.customId];
      if (!ref) continue;
      // A text deleted since the batch went up: its answer is kept all the same (paid for, and in the token
      // totals), like other results of deleted texts, just without the request (its text is gone).
      const doc = docsById.get(ref[0]) ?? ({ id: ref[0] } as Doc);
      const result = makeResult(run, doc, ref[1], requestedAt, line.ok ? line.outcome : null, line.ok ? null : line.error, null, completedAt);
      const part = docsById.has(ref[0])
        ? adapter.buildRequestPart(renderMessageParts(run.snapshot.prompt.userTemplate, doc, run.snapshot.prompt.subject), run.snapshot.options, run.snapshot.model.model)
        : { note: 'text deleted from the study before its answer was collected' };
      const log: ResultLog = {
        id: result.id,
        runId: run.id,
        studyId: run.studyId,
        requestPart: { custom_id: line.customId, ...part },
        response: line.ok ? line.outcome.response : line.response ?? { error: line.error },
        ...omittedFrom(run),
      };
      await dbApi.putResult(result, log, (prev) => applyTodaysRules([prev], [run]));
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
 * from) also waits for: batch id → that study's name. Cancelling such a batch would stop it there too. Also a batch
 * this run found for an upload of unknown outcome that the other run still waits for (the same upload: its Retry
 * failed finds the batch).
 */
export async function sharedBatches(run: Run): Promise<Map<string, string>> {
  const mine = batchParts(run).filter((p) => p.status === 'submitted');
  const out = new Map<string, string>();
  if (!mine.length) return out;
  for (const r of await runsHere()) {
    if (r.id === run.id) continue;
    const held = new Set(batchParts(r).filter((p) => p.status === 'submitted').map((p) => p.batchId));
    const waits = r.batch?.provider === run.batch?.provider ? unknownUpload(r)?.since : undefined;
    for (const p of mine) if (held.has(p.batchId) || (!!waits && p.submittedAt === waits)) out.set(p.batchId, studyName(r.studyId));
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
  return (await cancelRunBatches(run, !!opts.keepShared)).failed;
}

/** The same, also returning the batches it did cancel. */
async function cancelRunBatches(run: Run, keepShared: boolean): Promise<{ failed: string; cancelled: string[] }> {
  if (!run.batch) return { failed: '', cancelled: [] };
  const adapter = provider(run.batch.provider);
  const shared = keepShared ? await sharedBatches(run).catch(() => new Map<string, string>()) : new Map<string, string>();
  const toCancel = batchParts(run).filter((p) => p.status === 'submitted' && !shared.has(p.batchId));
  if (!toCancel.length) return { failed: '', cancelled: [] };
  const key = state.keys[run.batch.provider];
  if (!key) return { failed: `The batch could not be cancelled: no ${adapter.label} API key is set (API keys, top right).`, cancelled: [] };
  const failures: string[] = [];
  const cancelled: string[] = [];
  for (const p of toCancel) {
    try {
      await adapter.cancelBatch(key, p.batchId);
      cancelled.push(p.batchId);
    } catch (e) {
      // A batch that has already ended has nothing left to stop.
      const ended = await adapter.checkBatch(key, p.batchId).then((st) => st.done, () => false);
      if (!ended) failures.push(describeApiError(e));
    }
  }
  return { failed: failures.length ? `Could not cancel ${failures.length === 1 ? 'a batch' : `${failures.length} batches`}: ${failures[0]}` : '', cancelled };
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
