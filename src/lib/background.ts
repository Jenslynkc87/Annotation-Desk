// Long jobs started from a tab (the zips, the Excel workbook, the study backup, the comparison report). The app shows
// only the open tab, so going to another one unmounts the component that started the job while the job keeps going:
// its state lives here instead, so the tab shows it again on return, a second one can't start meanwhile (it would
// compete for memory and leave a second file), and closing or reloading the page asks first (App.tsx).
import { useSyncExternalStore } from 'react';

export type BackgroundKind = 'excel' | 'research' | 'supp' | 'backup' | 'report';

export interface BackgroundJob {
  kind: BackgroundKind;
  /** What is being built, e.g. "research repository". */
  label: string;
  /** How far it has got (e.g. the file being written), '' at first. */
  progress: string;
}

let current: BackgroundJob | null = null;
const listeners = new Set<() => void>();

function set(job: BackgroundJob | null) {
  current = job;
  for (const l of listeners) l();
}

/** Starts a job: false, and nothing started, if one is already running. */
export function startBackground(kind: BackgroundKind, label: string): boolean {
  if (current) return false;
  set({ kind, label, progress: '' });
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
