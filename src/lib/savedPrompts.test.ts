import { describe, expect, it } from 'vitest';
import { findSavedByName, samePrompt, samePromptAnyKind, sharedPrompts, upsertSavedPrompt } from './savedPrompts';
import { DEFAULT_PROMPT, type SavedPrompt, type Study } from './types';

const prompt = (text: string) => ({ ...structuredClone(DEFAULT_PROMPT), userTemplate: text });

describe('saved prompts', () => {
  it('adds a named prompt together with its fields', () => {
    const p = { ...prompt('A'), variables: [{ name: 'x', type: 'ordinal' as const, values: ['-1', '0', '1'], description: '' }] };
    const list = upsertSavedPrompt([], ' Prompt 3 ', p, 'id1', 't1');
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Prompt 3');
    expect(list[0].prompt.variables[0].values).toEqual(['-1', '0', '1']);
  });
  it('replaces a prompt with the same name (any case), keeping its id', () => {
    const first = upsertSavedPrompt([], 'Prompt 1', prompt('A'), 'id1', 't1');
    const second = upsertSavedPrompt(first, 'prompt 1', prompt('B'), 'id2', 't2');
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe('id1');
    expect(second[0].name).toBe('Prompt 1');
    expect(second[0].prompt.userTemplate).toBe('B');
  });
  it('keeps a stored copy that later edits to the live prompt do not change', () => {
    const live = prompt('A');
    const list = upsertSavedPrompt([], 'P', live, 'id1', 't1');
    live.userTemplate = 'changed';
    expect(list[0].prompt.userTemplate).toBe('A');
  });
  it('recognizes a prompt that is already saved', () => {
    const list = upsertSavedPrompt([], 'P', prompt('A'), 'id1', 't1');
    expect(samePrompt(list[0].prompt, prompt('A'))).toBe(true);
    expect(samePrompt(list[0].prompt, prompt('B'))).toBe(false);
    expect(findSavedByName(list, 'p')?.id).toBe('id1');
  });

  describe('shared across studies', () => {
    const sp = (id: string, name: string, text: string, subject?: 'entries'): SavedPrompt => ({ id, name, savedAt: '', prompt: { ...prompt(text), subject } });
    const study = (id: string, name: string, saved: SavedPrompt[]) => ({ id, name, savedPrompts: saved }) as unknown as Study;

    it('lists the open study’s prompts first, then those of other studies with their study’s name', () => {
      const list = sharedPrompts([study('a', 'Pilot', [sp('1', 'Prompt 1', 'A')]), study('b', 'Main', [sp('2', 'Prompt 2', 'B')])], 'b');
      expect(list.map((x) => [x.entry.name, x.here, x.studyName])).toEqual([
        ['Prompt 2', true, 'Main'],
        ['Prompt 1', false, 'Pilot'],
      ]);
    });
    it('lists an identical copy (same name, text and fields) once, with every study that keeps it', () => {
      const list = sharedPrompts([study('a', 'Main', [sp('1', 'Prompt 1', 'A')]), study('b', 'Main (copy)', [sp('1', 'prompt 1', 'A')])], 'a');
      expect(list).toHaveLength(1);
      expect(list[0].copies).toEqual([
        { studyId: 'a', id: '1' },
        { studyId: 'b', id: '1' },
      ]);
    });
    it('keeps prompts apart that share a name but differ in text', () => {
      const list = sharedPrompts([study('a', 'A', [sp('1', 'Prompt 1', 'A')]), study('b', 'B', [sp('2', 'Prompt 1', 'other')])], 'a');
      expect(list.map((x) => x.here)).toEqual([true, false]);
    });
    it('treats a prompt from an entries study as the same prompt in a texts study', () => {
      expect(samePromptAnyKind(prompt('A'), { ...prompt('A'), subject: 'entries' })).toBe(true);
      expect(samePrompt(prompt('A'), { ...prompt('A'), subject: 'entries' })).toBe(false);
      const list = sharedPrompts([study('a', 'Texts', [sp('1', 'P', 'A')]), study('b', 'Entries', [sp('2', 'P', 'A', 'entries')])], 'a');
      expect(list).toHaveLength(1);
    });
    it('handles studies without saved prompts', () => {
      expect(sharedPrompts([study('a', 'A', undefined as unknown as SavedPrompt[])], 'a')).toEqual([]);
    });
  });
});
