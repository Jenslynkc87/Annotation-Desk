import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { describeRow, parseFile, parsePastedTable } from './parse';

describe('pasted tables', () => {
  it('reads rows copied from Excel or Word (tabs), commas inside values included', () => {
    const t = parsePastedTable('name\tborn\tcountry\nBohr, Niels\t1885\tDenmark\nKaren Blixen\t1885\tDenmark\n');
    expect(t.columns).toEqual(['name', 'born', 'country']);
    expect(t.rows[0]).toEqual({ name: 'Bohr, Niels', born: '1885', country: 'Denmark' });
    expect(t.problems).toEqual([]);
  });
  it('reads typed rows with commas, and says which rows split wrongly', () => {
    const t = parsePastedTable('name,born\n"Bohr, Niels",1885\nSmith, John,1950\n');
    expect(t.rows[0]).toEqual({ name: 'Bohr, Niels', born: '1885' });
    expect(t.problems?.[0]).toMatch(/^1 row has more or fewer values than there are column names \(line 3\)/);
  });
  it('takes a single column, e.g. a list of names under a heading', () => {
    const t = parsePastedTable('American presidents\nGeorge Washington\nJohn Adams\n');
    expect([t.columns, t.rows.length, t.problems]).toEqual([['American presidents'], 2, []]);
  });
  it('keeps the columns in place when the first header cell is blank', () => {
    const t = parsePastedTable('\n\tname\tborn\n1\tBohr\t1885\n2\tBlixen\t1885\n\n');
    expect(t.columns).toEqual(['name', 'born']);
    expect(t.rows[1]).toEqual({ name: 'Blixen', born: '1885' });
  });
  it('takes a last row ending in an empty cell without a warning', () => {
    const t = parsePastedTable('name\tmy_rating\nBohr\t2\nBlixen\t\n');
    expect([t.rows[1], t.problems]).toEqual([{ name: 'Blixen', my_rating: '' }, []]);
  });
});

describe('spreadsheets', () => {
  it('read numbers as shown, unless the display is a different number', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['id', 'rounded', 'commas', 'padded', 'one_decimal', 'percent', 'isbn'],
      [1, 2.5, 1234, 123, 2, 0.25, 9783161484100],
    ]);
    const fmt = { B2: '0', C2: '#,##0', D2: '00000', E2: '0.0', F2: '0%' } as const;
    for (const [ref, z] of Object.entries(fmt)) ws[ref].z = z;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const file = new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], 'labels.xlsx');
    const parsed = await parseFile(file);
    if (parsed.kind !== 'table') throw new Error(parsed.kind);
    expect(parsed.table.rows[0]).toEqual({ id: '1', rounded: '2.5', commas: '1234', padded: '00123', one_decimal: '2.0', percent: '25%', isbn: '9783161484100' });
  });
});

describe('entries', () => {
  it('describe a row with the chosen columns, leaving out empty ones', () => {
    expect(describeRow({ name: 'Niels Bohr', born: '1885', country: '', my_rating: '2' }, ['name', 'born', 'country'])).toBe('name: Niels Bohr\nborn: 1885');
  });
});
