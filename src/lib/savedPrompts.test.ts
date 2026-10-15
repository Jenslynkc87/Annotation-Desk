import { describe, expect, it } from 'vitest';
import { findSavedByName, samePrompt, upsertSavedPrompt } from './savedPrompts';
import { DEFAULT_PROMPT } from './types';

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
});
