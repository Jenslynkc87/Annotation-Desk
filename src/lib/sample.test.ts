import { describe, expect, it } from 'vitest';
import { allocationNote, drawStratifiedSample, orderStrata, SAMPLING_METHOD } from './sample';
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
  it('draws the same whatever order the strata boxes were ticked (method 3), and can still redraw method 2', () => {
    expect(SAMPLING_METHOD).toBe('Annotation Desk sampling method 3');
    expect(orderStrata(['journal', 'era'])).toEqual(['era', 'journal']);
    const ticked = drawStratifiedSample(docs, { ...opts, strata: ['journal', 'era'] });
    expect(ticked.ids).toEqual(r.ids);
    expect(ticked.strata).toEqual(r.strata);
    expect(r.strata[0].key).toBe('1960s · J1');
    // Method 2 took the columns in the order ticked, so the other order drew other texts from the same seed.
    const old = (strata: string[]) => drawStratifiedSample(docs, { ...opts, strata, method: 2 }).ids;
    expect(old(['era', 'journal'])).toEqual(r.ids);
    expect(old(['journal', 'era'])).not.toEqual(r.ids);
  });
  it('draws the same whatever order the metadata columns were added in (method 3)', () => {
    // The same values, but journal added before era (e.g. from two spreadsheets, or a sheet with its columns moved).
    const swapped = docs.map((d) => ({ ...d, meta: { file: d.meta.file, journal: d.meta.journal, pilot: d.meta.pilot, era: d.meta.era } }));
    expect(drawStratifiedSample(swapped, opts).ids).toEqual(r.ids);
    expect(drawStratifiedSample(swapped, { ...opts, strata: ['journal', 'era'] }).ids).toEqual(r.ids);
  });
  it('says “at least one per stratum” only when every stratum got a text', () => {
    expect(allocationNote(r)).toBe('proportional allocation, at least one per stratum');
    // 60 strata of one text each, sample of 20.
    const ds = Array.from({ length: 60 }, (_, i) => ({ ...docs[0], id: `g${i}`, meta: { file: `g${i}.md`, era: `e${i % 3}`, journal: `j${i}` } }));
    const s = drawStratifiedSample(ds, { size: 20, strata: ['era', 'journal'], exclude: null, seed: 3 });
    expect(s.strata.filter((x) => x.drawn === 0)).toHaveLength(40);
    expect(allocationNote(s)).toBe('proportional allocation; 40 of 60 strata received no text because the sample is smaller than the number of strata');
    expect(allocationNote(s, 'entry')).toContain('40 of 60 strata received no entry');
    expect(allocationNote(drawStratifiedSample(ds, { size: 60, strata: ['era', 'journal'], exclude: null, seed: 3 }))).toContain('at least one per stratum');
  });
});
