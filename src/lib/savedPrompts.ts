import type { PromptSpec, SavedPrompt } from './types';

/** True when two prompts (text, output mode and fields) are identical. */
export function samePrompt(a: PromptSpec, b: PromptSpec): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
