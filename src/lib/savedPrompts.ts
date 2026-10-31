import type { PromptSpec, SavedPrompt, Study } from './types';

/** True when two prompts (text, output mode and fields) are identical. */
export function samePrompt(a: PromptSpec, b: PromptSpec): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The same, whatever kind of study (texts or entries) each belongs to: loading a prompt keeps the study's own kind. */
export function samePromptAnyKind(a: PromptSpec, b: PromptSpec): boolean {
  return samePrompt({ ...a, subject: undefined }, { ...b, subject: undefined });
}

export function findSavedByName(list: SavedPrompt[], name: string): SavedPrompt | undefined {
  const n = name.trim().toLowerCase();
  return list.find((x) => x.name.trim().toLowerCase() === n);
}

/** Add a named prompt, or replace the one with the same name (ignoring case), keeping its id and spelling. */
export function upsertSavedPrompt(list: SavedPrompt[], name: string, prompt: PromptSpec, id: string, savedAt: string): SavedPrompt[] {
  const existing = findSavedByName(list, name);
  const entry: SavedPrompt = { id: existing?.id ?? id, name: existing?.name ?? name.trim(), savedAt, prompt: structuredClone(prompt) };
  return existing ? list.map((x) => (x.id === existing.id ? entry : x)) : [...list, entry];
}

/** One line of the Saved prompts menu: a prompt and every study that keeps an identical copy of it under that name. */
export interface SharedPrompt {
  entry: SavedPrompt;
  /** True when the open study keeps it; otherwise `studyName` is the study it was saved in. */
  here: boolean;
  studyName: string;
  /** Each copy (study and saved prompt id), e.g. in a duplicated study, so deleting it removes it everywhere. */
  copies: { studyId: string; id: string }[];
}

/**
 * The saved prompts of every study, for the menu: the open study's first, in its order, then the other studies' (in
 * the order given) that it doesn't already have. A prompt kept under the same name and with identical text and fields
 * in several studies (a duplicated study, a backup copy) is listed once; one with the same name but a different text
 * is listed with its study's name.
 */
export function sharedPrompts(studies: Study[], currentId: string): SharedPrompt[] {
  const list: SharedPrompt[] = [];
  const ordered = [...studies.filter((s) => s.id === currentId), ...studies.filter((s) => s.id !== currentId)];
  for (const s of ordered)
    for (const sp of s.savedPrompts ?? []) {
      const same = list.find(
        (x) => x.entry.name.trim().toLowerCase() === sp.name.trim().toLowerCase() && samePromptAnyKind(x.entry.prompt, sp.prompt),
      );
      if (same) same.copies.push({ studyId: s.id, id: sp.id });
      else list.push({ entry: sp, here: s.id === currentId, studyName: s.name, copies: [{ studyId: s.id, id: sp.id }] });
    }
  return list;
}
