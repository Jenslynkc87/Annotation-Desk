import { describe, expect, it } from 'vitest';
import { drawStratifiedSample } from './sample';
import type { Doc } from './types';

// 3,080 texts: three eras of different size, two journals, 50 pilot articles.
const docs: Doc[] = Array.from({ length: 3080 }, (_, i) => ({
  id: `id${i}`, studyId: 's', docId: `a${i}`, text: 't', order: i, addedAt: '', source: 'x',
  meta: { file: `a${String(i).padStart(4, '0')}.${i % 3 ? 'txt' : 'md'}`, era: i < 400 ? '1960s' : i < 1500 ? '1980s' : '2000s', journal: i % 4 ? 'J1' : 'J2', pilot: i < 50 ? 'yes' : '' },
}));
const opts = { size: 100, strata: ['era', 'journal'], exclude: { column: 'pilot', value: 'Yes' }, seed: 12345 };

describe('stratified sample', () => {
  const r = drawStratifiedSample(docs, opts);
  it('draws exactly the requested number, proportionally, never from excluded texts', () => {
    expect(r.ids).toHaveLength(100);
    expect(r.eligible).toBe(3030);
    expect(r.ids.some((id) => Number(id.slice(2)) < 50)).toBe(false);
    for (const s of r.strata) expect(Math.abs(s.drawn - (100 * s.available) / 3030)).toBeLessThan(1);
    expect(new Set(r.ids).size).toBe(100);
  });
  it('is reproducible from the seed, regardless of import order, and changes with another seed', () => {
    const shuffled = [...docs].reverse();
    expect(new Set(drawStratifiedSample(shuffled, opts).ids)).toEqual(new Set(r.ids));
    expect(drawStratifiedSample(docs, { ...opts, seed: 1 }).ids).not.toEqual(r.ids);
  });
  it('gives every stratum at least one text when the sample is large enough', () => {
    const small = [...docs.slice(0, 300), { ...docs[0], id: 'rare', meta: { file: 'rare.md', era: '1950s', journal: 'J9' } }];
    const s = drawStratifiedSample(small, { ...opts, size: 20, exclude: null });
    expect(s.ids).toContain('rare');
    expect(s.ids).toHaveLength(20);
  });
});
