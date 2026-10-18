import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { addDocs, getState, init } from './store';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const file = (name: string, text: string) => ({ docId: name.replace(/\.[^.]+$/, ''), text, meta: { file: name }, source: name });

describe('adding texts', () => {
  it('skips files already in the study when a folder is dropped again, and adds the new ones', async () => {
    await init();
    await addDocs([file('a1.md', 'First'), file('a2.txt', 'Second'), file('a3.txt', 'Third')]);
    // The whole folder again, now with one new article and one changed one.
    await addDocs([file('a1.md', 'First'), file('a2.txt', 'Second'), file('a3.txt', 'Third, revised'), file('a4.txt', 'Fourth')]);
    const docs = getState().docs;
    expect(docs.map((d) => [d.docId, d.text])).toEqual([
      ['a1', 'First'],
      ['a2', 'Second'],
      ['a3', 'Third'],
      ['a3_2', 'Third, revised'], // same name, different text: added, with a suffix and a warning
      ['a4', 'Fourth'],
    ]);
    expect(getState().toasts.map((t) => t.text)).toContain('Skipped 2 texts already in this study (same name and identical text).');
  });
});
