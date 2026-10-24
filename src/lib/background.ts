// Long jobs started from a tab (the zips, the Excel workbook, the study backup, the comparison report). The app shows
// only the open tab, so going to another one unmounts the component that started the job while the job keeps going:
// its state lives here instead, so the tab shows it again on return, a second one can't start meanwhile (it would
// compete for memory and leave a second file), and closing or reloading the page asks first (App.tsx).
// Each job knows its study: another study may be opened meanwhile, and the job's own study must not change under it
// (a download reads the study's stored results and logs as it goes), so deleting it or its runs, Retry failed and
// collecting batch results wait until it is done (store.ts).
import { useSyncExternalStore } from 'react';

export type BackgroundKind = 'excel' | 'research' | 'supp' | 'backup' | 'report';

/** What the Export tab's build was started with, shown again when the tab is opened during it. */
export interface BuildChoices {
  runId?: string;
  supp?: { includeTexts: boolean; includeRationales: boolean; includeLogs: boolean };
  researchLogs?: boolean;
}

export interface BackgroundJob {
  kind: BackgroundKind;
  /** What is being built, e.g. "research repository". */
  label: string;
  /** How far it has got (e.g. the file being written), '' at first. */
  progress: string;
  /** The study it is for (its name as it was when the job started). */
  study: { id: string; name: string };
  choices?: BuildChoices;
}

let current: BackgroundJob | null = null;
const listeners = new Set<() => void>();

function set(job: BackgroundJob | null) {
  current = job;
  for (const l of listeners) l();
}

/** Starts a job: false, and nothing started, if one is already running. */
export function startBackground(kind: BackgroundKind, label: string, study: { id: string; name: string }, choices?: BuildChoices): boolean {
  if (current) return false;
  set({ kind, label, progress: '', study, ...(choices ? { choices } : {}) });
  return true;
}

export function setBackgroundProgress(text: string): void {
  if (current && current.progress !== text) set({ ...current, progress: text });
}

export function endBackground(): void {
  if (current) set(null);
}

export function backgroundRunning(): boolean {
  return current !== null;
}

/** What is being built for this study (its label), or null if nothing is. */
export function buildingFor(studyId: string): string | null {
  return current && current.study.id === studyId ? current.label : null;
}

/** Said when something that would change a study's stored results waits for its download (`action`: e.g. "delete
 *  the run"). */
export const waitForDownload = (label: string, action: string) =>
  `A download of this study is still being built (the ${label}): ${action} once it has been downloaded, so the file holds the study as it was.`;

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The job running, if any (re-renders when it starts, moves on or ends). */
export function useBackground(): BackgroundJob | null {
  return useSyncExternalStore(subscribe, () => current);
}

/** Whether a job is running (re-renders only when one starts or ends, not at each step). */
export function useBackgroundRunning(): boolean {
  return useSyncExternalStore(subscribe, backgroundRunning);
}

/** `buildingFor` (re-renders only when a job starts or ends). */
export function useBuildingFor(studyId: string | null | undefined): string | null {
  return useSyncExternalStore(subscribe, () => (studyId ? buildingFor(studyId) : null));
}
