import { describe, expect, it } from 'vitest';
import type { Doc } from '../types';
import { guessKeyColumn, matchLabels } from './labels';

const doc = (id: string, file: string, meta: Record<string, string> = {}): Doc => ({
  id, studyId: 's', docId: file.replace(/\.md$/, ''), text: 'T', meta: { file, ...meta }, source: file, order: 0, addedAt: '',
});
const docs = [doc('a', 'article_001.md'), doc('b', 'article_017.md', { stance_gold: 'for' }), doc('c', 'Ærø_note.md')];
const table = {
  name: 'labels.xlsx',
  columns: ['coder', 'file', 'stance_gold'],
  rows: [
    { coder: 'A', file: 'article_001.md', stance_gold: 'against' },
    { coder: 'A', file: 'article_017', stance_gold: 'against' },
    { coder: 'A', file: 'ærø_NOTE.MD', stance_gold: '' },
    { coder: 'A', file: 'missing.md', stance_gold: 'for' },
  ],
};

describe('adding labels from a spreadsheet', () => {
  it('finds the file-name column by itself', () => {
    expect(guessKeyColumn(docs, table)).toBe('file');
  });
  it('matches with or without extension, skips empty cells, reports what it could not match', () => {
    const m = matchLabels(docs, table, 'file');
    expect(m.updates.get('a')).toEqual({ coder: 'A', stance_gold: 'against' });
    expect(m.updates.get('b')).toEqual({ coder: 'A', stance_gold: 'against' });
    expect(m.updates.get('c')).toEqual({ coder: 'A' });
    expect(m.unmatched).toEqual(['missing.md']);
    expect(m.replaced).toEqual(['stance_gold']);
  });
});
