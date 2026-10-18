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
  it('gives the extra texts to the groups furthest below their share (not to one raised to one text)', () => {
    const sizes = { A: 35, B: 35, C: 21, D: 9 };
    const ds = Object.entries(sizes).flatMap(([g, n]) => Array.from({ length: n }, (_, i) => ({ ...docs[0], id: `${g}${i}`, meta: { file: `${g}${i}.md`, g } })));
    const s = drawStratifiedSample(ds, { size: 10, strata: ['g'], exclude: null, seed: 1 });
    expect(s.strata.map((x) => [x.key, x.drawn])).toEqual([['A', 4], ['B', 3], ['C', 2], ['D', 1]]);
  });
  it('draws the same with capitals, Aa and Ø in file names, whatever the import order', () => {
    // Names are ordered character by character (a Danish-language browser would sort "Aagaard" after "Zahle").
    const ds = ['Zahle.md', 'aagaard.md', 'Aagaard.md', 'Ørsted.md', 'abel.md'].map((file, i) => ({ ...docs[0], id: `x${i}`, meta: { file } }));
    const draw = drawStratifiedSample(ds, { size: 5, strata: [], exclude: null, seed: 7 }).ids;
    const reordered = drawStratifiedSample([...ds].reverse(), { size: 5, strata: [], exclude: null, seed: 7 }).ids;
    expect(reordered).toEqual(draw);
  });
  it('gives every stratum at least one text when the sample is large enough', () => {
    const small = [...docs.slice(0, 300), { ...docs[0], id: 'rare', meta: { file: 'rare.md', era: '1950s', journal: 'J9' } }];
    const s = drawStratifiedSample(small, { ...opts, size: 20, exclude: null });
    expect(s.ids).toContain('rare');
    expect(s.ids).toHaveLength(20);
  });
});
