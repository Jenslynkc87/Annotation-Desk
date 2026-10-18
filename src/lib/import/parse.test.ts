import { describe, expect, it } from 'vitest';
import { describeRow, looksLikeEntries, parsePastedTable } from './parse';

describe('pasted tables', () => {
  it('reads rows copied from Excel or Word (tabs), commas inside values included', () => {
    const t = parsePastedTable('name\tborn\tcountry\nBohr, Niels\t1885\tDenmark\nKaren Blixen\t1885\tDenmark\n');
    expect(t.columns).toEqual(['name', 'born', 'country']);
    expect(t.rows[0]).toEqual({ name: 'Bohr, Niels', born: '1885', country: 'Denmark' });
    expect(t.problems).toEqual([]);
    expect(looksLikeEntries(t)).toBe(true);
  });
  it('reads typed rows with commas, and says which rows split wrongly', () => {
    const t = parsePastedTable('name,born\n"Bohr, Niels",1885\nSmith, John,1950\n');
    expect(t.rows[0]).toEqual({ name: 'Bohr, Niels', born: '1885' });
    expect(t.problems?.[0]).toMatch(/^1 row has more or fewer values than there are column names \(line 3\)/);
  });
  it('notices a table with only one column', () => {
    expect(parsePastedTable('Niels Bohr\nKaren Blixen').problems?.at(-1)).toMatch(/Only one column/);
  });
});

describe('entries', () => {
  it('describe a row with the chosen columns, leaving out empty ones', () => {
    expect(describeRow({ name: 'Niels Bohr', born: '1885', country: '', my_rating: '2' }, ['name', 'born', 'country'])).toBe('name: Niels Bohr\nborn: 1885');
  });
  it('are not assumed for tables with a column of texts', () => {
    expect(looksLikeEntries({ name: 't', columns: ['id', 'text'], rows: [{ id: '1', text: 'x'.repeat(500) }] })).toBe(false);
  });
});
