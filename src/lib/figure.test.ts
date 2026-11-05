import { describe, expect, it } from 'vitest';
import { binCsvRows, fieldFigure, mixHex, rowsFigure, summaryCsvRows, withDpi } from './figure';
import { describe as describeNumbers, histogram, type FieldSummary } from './summary';

const scale = (counts: number[], extra: Partial<FieldSummary> = {}): FieldSummary => {
  const values = [-3, -2, -1, 0, 1, 2, 3];
  const xs = values.flatMap((v, i) => Array(counts[i]).fill(v));
  return {
    key: 'nation',
    label: 'Nation & state',
    kind: 'scale',
    diverging: true,
    range: [-3, 3],
    bins: values.map((v, i) => ({ key: String(v), label: v < 0 ? `−${-v}` : String(v), n: counts[i], value: v })),
    n: xs.length,
    missing: 0,
    leftOut: { n: 0, values: [], offScale: 0, scale: [-3, 3] },
    ...describeNumbers(xs),
    sides: { below: xs.filter((x) => x < 0).length, middle: xs.filter((x) => x === 0).length, above: xs.filter((x) => x > 0).length },
    yes: null,
    ...extra,
  };
};

describe('figures', () => {
  const a = scale([2, 5, 9, 12, 8, 4, 1]);
  const b = scale([0, 1, 3, 10, 12, 9, 6], { key: 'culture', label: 'Culture' });

  it('draws every field as a row, at the asked width, with text escaped and no NaN', () => {
    const svg = rowsFigure(
      [
        { name: a.label, s: a },
        { name: b.label, s: b },
      ],
      { widthMm: 175, oneField: false, description: 'Study “x” <test>' },
    );
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="175mm" height="[\d.]+mm" viewBox="0 0 496.06 \d+"/);
    expect(svg).toContain('Nation &amp; state');
    expect(svg).toContain('&lt;test&gt;');
    expect(svg).not.toMatch(/NaN|undefined|Infinity/);
    expect(svg).toContain('Mean (95% CI)');
    expect(svg.trim().endsWith('</svg>')).toBe(true);
  });

  it('draws one field as columns with the mean marked, at one column’s width', () => {
    const svg = fieldFigure(a, { widthMm: 85, description: 'd' });
    expect(svg).toContain('width="85mm"');
    expect(svg).toMatch(/mean −?0\.\d+|mean 0/);
    expect(svg).not.toMatch(/NaN|undefined|Infinity/);
    // One column per point.
    expect((svg.match(/<rect /g) ?? []).length).toBe(1 + 7);
  });

  it('draws numbers as a histogram with round edges', () => {
    const years = Array.from({ length: 50 }, (_, i) => 1965 + i);
    const s: FieldSummary = { ...scale([0, 0, 0, 0, 0, 0, 0]), kind: 'number', diverging: false, range: null, bins: histogram(years), n: 50, ...describeNumbers(years), sides: null };
    const svg = fieldFigure(s, { widthMm: 175, description: 'd' });
    expect(svg).toContain('>1965<');
    expect(svg).toContain('>2015<');
    expect(svg).not.toMatch(/NaN|undefined/);
  });

  it('mixes colors in OKLab, ending at both ends', () => {
    expect(mixHex('#d5d4d1', '#eca071', 0)).toBe('#d5d4d1');
    expect(mixHex('#d5d4d1', '#eca071', 1)).toBe('#eca071');
  });
});

describe('PNG resolution', () => {
  // A minimal PNG: signature, IHDR (1×1), IDAT, IEND (contents don't matter here).
  const chunk = (type: string, data: number[]) => {
    const len = [0, 0, 0, data.length];
    return [...len, ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
  };
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]), ...chunk('pHYs', [0, 0, 0, 1, 0, 0, 0, 1, 0]), ...chunk('IDAT', [1, 2, 3]), ...chunk('IEND', [])]);

  it('writes 600 dpi right after the header and drops the old one', () => {
    const out = withDpi(png, 600);
    const types: string[] = [];
    const v = new DataView(out.buffer);
    let at = 8;
    while (at < out.length) {
      const len = v.getUint32(at);
      types.push(String.fromCharCode(...out.subarray(at + 4, at + 8)));
      if (types[types.length - 1] === 'pHYs') {
        expect(v.getUint32(at + 8)).toBe(23622); // 600 / 0.0254
        expect(v.getUint32(at + 12)).toBe(23622);
        expect(out[at + 16]).toBe(1);
        // CRC of "pHYs" + data, checked against a known value computed independently (zlib.crc32).
        expect(v.getUint32(at + 17).toString(16)).toBe('14944341');
      }
      at += 12 + len;
    }
    expect(types).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND']);
  });
});

describe('figure numbers', () => {
  it('gives one row per field with the summary and the texts at each value', () => {
    const s = scale([2, 5, 9, 12, 8, 4, 1]);
    const [row] = summaryCsvRows([{ name: s.label, s }], { run: '#2', model: 'm', appVersion: 'v' });
    expect(row).toMatchObject({ run: '#2', field: 'Nation & state', n: 41, 'n_-3': 2, n_0: 12, n_3: 1, share_below_0: Math.round((16 / 41) * 1e4) / 1e4, app_version: 'v' });
    expect(row.mean).toBeCloseTo(s.mean!, 4);
  });
  it('names the group column after the metadata column in a split', () => {
    const s = scale([1, 1, 1, 1, 1, 1, 1]);
    const [row] = summaryCsvRows([{ name: '1960s', s }], { run: '#2', model: 'm', appVersion: 'v', field: 'Nation', groupColumn: 'era' });
    expect(row).toMatchObject({ field: 'Nation', era: '1960s' });
  });
  it('gives one row per bar for one field', () => {
    const s = scale([2, 0, 0, 0, 0, 0, 2]);
    const rows = binCsvRows(s, { run: '#2', model: 'm', appVersion: 'v' });
    expect(rows.map((r) => [r.value, r.n, r.share])).toEqual([
      [-3, 2, 0.5],
      [-2, 0, 0],
      [-1, 0, 0],
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 2, 0.5],
    ]);
  });
});

describe('figure numbers in a split', () => {
  it('writes 0 for a value a group didn’t get, and orders the value columns', async () => {
    const { csvColumns } = await import('./figure');
    const s1 = scale([1, 0, 0, 0, 0, 0, 1]);
    const s2: FieldSummary = { ...scale([0, 0, 0, 1, 0, 0, 0]), bins: [...scale([0, 0, 0, 1, 0, 0, 0]).bins, { key: '0.5', label: '0.5', n: 2, value: 0.5, extra: true }] };
    const rows = summaryCsvRows(
      [
        { name: 'a', s: s1 },
        { name: 'b', s: s2 },
      ],
      { run: '#1', model: 'm', appVersion: 'v', field: 'F', groupColumn: 'era' },
    );
    expect(rows[0]['n_0.5']).toBe(0);
    const [, cols] = csvColumns(rows);
    expect(cols.filter((c) => c.startsWith('n_') && c !== 'n_without_value' && c !== 'n_left_out')).toEqual(['n_-3', 'n_-2', 'n_-1', 'n_0', 'n_0.5', 'n_1', 'n_2', 'n_3']);
    expect(cols[cols.length - 1]).toBe('app_version');
    expect(cols).not.toContain('share_yes');
  });
});

describe('axis ticks', () => {
  it('always gives at least two round ticks', async () => {
    const { niceTicks } = await import('./figure');
    expect(niceTicks(-1.6, 1.3, 6)).toEqual([-1.5, -1, -0.5, 0, 0.5, 1]);
    expect(niceTicks(-1.6, 1.3, 4)).toEqual([-1, 0, 1]);
    expect(niceTicks(-1.8, 1.6, 4)).toEqual([-1, 0, 1]);
    expect(niceTicks(0.1, 0.62, 4)).toEqual([0.2, 0.4, 0.6]);
    expect(niceTicks(1949, 2026, 5)).toEqual([1960, 1980, 2000, 2020]);
  });
});

describe('over time', () => {
  it('stacks each period to its whole share, 0 straddling the baseline', async () => {
    const { timeStacks, timeFigure } = await import('./figure');
    const a = scale([2, 5, 9, 12, 8, 4, 1]);
    const b = scale([0, 1, 3, 10, 12, 9, 6]);
    const groups = [
      { tick: '1950', name: '1950–1954', s: a },
      { tick: '1955', name: '1955–1959', s: b },
    ];
    const st = timeStacks(groups);
    expect(st.diverging).toBe(true);
    for (const [i, parts] of st.parts.entries()) {
      const total = parts.reduce((t, p) => t + (p.to - p.from), 0);
      expect(total).toBeCloseTo(1, 10);
      const zero = parts.find((p) => p.b.value === 0)!;
      expect(zero.from).toBeCloseTo(-zero.to, 10);
      const below = parts.filter((p) => (p.b.value ?? 0) < 0).reduce((t, p) => t + (p.to - p.from), 0);
      expect(below).toBeCloseTo(groups[i].s.sides!.below / groups[i].s.n, 10);
      expect(Math.min(...parts.map((p) => p.from))).toBeGreaterThanOrEqual(st.lo - 1e-9);
      expect(Math.max(...parts.map((p) => p.to))).toBeLessThanOrEqual(st.hi + 1e-9);
    }
    const svg = timeFigure(groups, { widthMm: 85, description: 'd', column: 'year (steps of 5)' });
    expect(svg).not.toMatch(/NaN|undefined|Infinity/);
    expect(svg).toContain('Mean (95% CI)');
    expect(svg).toContain('year (steps of 5)');
  });

  it('gives the CSV the period bounds and the subset', () => {
    const s = scale([1, 1, 1, 1, 1, 1, 1]);
    const [row] = summaryCsvRows([{ name: '1950–1954', s, from: 1950, to: 1955 }], { run: '#1', model: 'm', appVersion: 'v', field: 'F', groupColumn: 'year', subset: 'journal = AQ' });
    expect(row).toMatchObject({ subset: 'journal = AQ', year: '1950–1954', period_from: 1950, period_to_before: 1955 });
  });
});
