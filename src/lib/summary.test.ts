import { describe, expect, it } from 'vitest';
import type { ComparableField } from './compare';
import { isGroupColumn, isNumericColumn, NO_GROUP, summarize, summarizeGroups, summaryKind } from './summary';

const scale: ComparableField = { key: 'race', label: 'race', level: 'ordinal', allowed: ['-3', '-2', '-1', '0', '1', '2', '3'], yesNo: false };
const ok = (value: string) => ({ status: 'ok' as const, value });

describe('run summary', () => {
  it('counts a −3…3 field on every point and gives mean, SD, median (checked against Python statistics/numpy)', () => {
    const s = summarize(scale, [ok('-3'), ok('-1'), ok('0'), ok('0'), ok('1'), ok('2'), ok('0.5'), { status: 'error', value: '' }, { status: 'none', value: '' }]);
    expect(s.kind).toBe('scale');
    expect(s.points).toEqual(['-3', '-2', '-1', '0', '1', '2', '3']);
    expect(s.counts).toEqual([1, 0, 1, 2, 1, 1, 0]);
    expect([s.nTexts, s.nValue, s.between, s.nFailed, s.nNotYet]).toEqual([9, 7, 1, 1, 1]);
    expect(s.mean).toBeCloseTo(-0.07142857142857142, 12);
    expect(s.sd).toBeCloseTo(1.5923926292577109, 12);
    expect([s.median, s.q1, s.q3]).toEqual([0, -0.5, 0.75]);
  });

  it('leaves out values off the scale and missing markers, and reports them', () => {
    const s = summarize(scale, [ok('5'), ok('NA'), ok(''), ok('high'), ok('3')]);
    expect(s.counts[6]).toBe(1);
    expect(s.leftOut).toEqual({ n: 2, values: ['5', 'high'] });
    expect(s.nBlank).toBe(2);
    expect(s.mean).toBe(3);
  });

  it('reads yes/no fields in any encoding and counts ties apart', () => {
    const yn: ComparableField = { key: 'q', label: 'q', level: 'nominal', allowed: ['false', 'true'], yesNo: true };
    const s = summarize(yn, [ok('true'), ok('Yes'), ok('1'), ok('no'), ok('false | true')]);
    expect(s.kind).toBe('yesno');
    expect(s.counts).toEqual([1, 3]);
    expect(s.ties).toBe(1);
    expect(s.mean).toBeNull();
  });

  it('keeps categories in codebook order', () => {
    const cat: ComparableField = { key: 'c', label: 'c', level: 'nominal', allowed: ['praise', 'neutral', 'critique'], yesNo: false };
    const s = summarize(cat, [ok('Critique'), ok('praise'), ok('critique'), ok('other')]);
    expect(s.counts).toEqual([1, 0, 2]);
    expect(s.leftOut.n).toBe(1);
  });

  it('gives quartiles for Number fields', () => {
    const num: ComparableField = { key: 'n', label: 'n', level: 'interval', allowed: [], yesNo: false };
    expect(summaryKind(num)).toBe('numbers');
    const s = summarize(num, ['12.5', '40', '7', '100', '63.2'].map(ok));
    expect(s.mean).toBeCloseTo(44.54, 10);
    expect(s.sd).toBeCloseTo(38.34198742892705, 10);
    expect([s.min, s.q1, s.median, s.q3, s.max]).toEqual([7, 12.5, 40, 63.2, 100]);
  });

  it('puts plain-text 0/1 scores on 0…1, so a code such as 9 is left out', () => {
    const zo: ComparableField = { key: 'f', label: 'f', level: 'ordinal', allowed: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'], scaleSeen: true, range: [0, 9], yesNo: false, zeroOne: true };
    const s = summarize(zo, ['0', '1', '1', '9'].map(ok));
    expect(s.points).toEqual(['0', '1']);
    expect(s.leftOut.n).toBe(1);
    expect(s.mean).toBeCloseTo(2 / 3, 12);
  });

  it('splits by a column: years in numeric order, texts without a value last', () => {
    const g = summarizeGroups(scale, [
      { ...ok('1'), group: '2010' },
      { ...ok('-1'), group: '' },
      { ...ok('3'), group: '999' },
      { ...ok('2'), group: '2010' },
    ]);
    expect(g.map((x) => [x.group, x.summary.nValue, x.summary.mean])).toEqual([
      ['999', 1, 3],
      ['2010', 2, 1.5],
      [NO_GROUP, 1, -1],
    ]);
  });

  it('tells a year column from an identifier or a grouping column', () => {
    const years = Array.from({ length: 100 }, (_, i) => String(1990 + (i % 30)));
    expect(isNumericColumn(years)).toBe(true);
    expect(isNumericColumn(Array.from({ length: 100 }, (_, i) => String(i)))).toBe(false);
    expect(isNumericColumn(['1', '2', '1', '2'])).toBe(false);
    expect(isGroupColumn(['early', 'late', 'early', ''])).toBe(true);
    expect(isGroupColumn(years)).toBe(true);
  });
});
