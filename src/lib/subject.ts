import type { PromptSpec } from './types';

/** How the things being annotated are called: texts, or entries in a model-knowledge study. */
export function words(p: Pick<PromptSpec, 'subject'>) {
  return p.subject === 'entries'
    ? { one: 'entry', many: 'entries', One: 'Entry', Many: 'Entries' }
    : { one: 'text', many: 'texts', One: 'Text', Many: 'Texts' };
}

export const isEntries = (p: Pick<PromptSpec, 'subject'>) => p.subject === 'entries';
