// Agreement statistics between two sets of labels for the same items.
// Pairs with a missing value on either side are dropped before computing.

export type Level = 'nominal' | 'ordinal' | 'interval';

export interface Agreement {
  n: number;
  percentAgreement: number | null;
  cohenKappa: number | null;
  weightedKappa: number | null; // quadratic weights, ordinal/interval only
  krippendorffAlpha: number | null;
  gwetAC1: number | null;
  spearman: number | null;
  pearson: number | null;
  mae: number | null;
  categories: string[];
  /** confusion[a][b] = count, a = first source, b = second source */
  confusion: Record<string, Record<string, number>>;
}

const isNum = (s: string) => s.trim() !== '' && !Number.isNaN(Number(s));

function sortCats(cats: string[]): string[] {
  return cats.every(isNum) ? cats.sort((a, b) => Number(a) - Number(b)) : cats.sort();
}

export function percentAgreement(pairs: [string, string][]): number | null {
  if (!pairs.length) return null;
  return pairs.filter(([a, b]) => a === b).length / pairs.length;
}

export function cohenKappa(pairs: [string, string][], weights: 'none' | 'quadratic' = 'none'): number | null {
  const n = pairs.length;
  if (!n) return null;
  const cats = sortCats([...new Set(pairs.flat())]);
  if (cats.length < 2) return null;
  const k = cats.length;
  const idx = new Map(cats.map((c, i) => [c, i]));
  const w = (i: number, j: number) => (weights === 'none' ? (i === j ? 0 : 1) : ((i - j) / (k - 1)) ** 2);
  const obs = Array.from({ length: k }, () => new Array(k).fill(0));
  const ra = new Array(k).fill(0);
  const rb = new Array(k).fill(0);
  for (const [a, b] of pairs) {
    const i = idx.get(a)!;
    const j = idx.get(b)!;
    obs[i][j]++;
    ra[i]++;
    rb[j]++;
  }
  let po = 0;
  let pe = 0;
  for (let i = 0; i < k; i++)
    for (let j = 0; j < k; j++) {
      po += w(i, j) * obs[i][j];
      pe += (w(i, j) * ra[i] * rb[j]) / n;
    }
  if (pe === 0) return null;
  return 1 - po / pe;
}

/** Krippendorff's alpha for two coders (complete pairs). */
export function krippendorffAlpha(pairs: [string, string][], level: Level): number | null {
  if (pairs.length < 2) return null;
  if (level !== 'nominal' && !pairs.every(([a, b]) => isNum(a) && isNum(b))) level = 'nominal';
  const values = sortCats([...new Set(pairs.flat())]);
  if (values.length < 2) return null;
  const idx = new Map(values.map((v, i) => [v, i]));
  const k = values.length;
  // Coincidence matrix: each unit with two values contributes once in each direction.
  const o = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const [a, b] of pairs) {
    o[idx.get(a)!][idx.get(b)!]++;
    o[idx.get(b)!][idx.get(a)!]++;
  }
  const nc = o.map((row) => row.reduce((s, x) => s + x, 0));
  const n = nc.reduce((s, x) => s + x, 0);
  const delta2 = (c: number, d: number): number => {
    if (c === d) return 0;
    if (level === 'nominal') return 1;
    if (level === 'interval') return (Number(values[c]) - Number(values[d])) ** 2;
    const lo = Math.min(c, d);
    const hi = Math.max(c, d);
    let s = 0;
    for (let g = lo; g <= hi; g++) s += nc[g];
    return (s - (nc[c] + nc[d]) / 2) ** 2;
  };
  let num = 0;
  let den = 0;
  for (let c = 0; c < k; c++)
    for (let d = 0; d < k; d++) {
      const dd = delta2(c, d);
      num += o[c][d] * dd;
      den += nc[c] * nc[d] * dd;
    }
  if (den === 0) return null;
  return 1 - ((n - 1) * num) / den;
}

/** Gwet's AC1 for two raters, nominal categories. */
export function gwetAC1(pairs: [string, string][], allowed: string[] = []): number | null {
  const n = pairs.length;
  if (!n) return null;
  const cats = [...new Set([...allowed, ...pairs.flat()])];
  const q = cats.length;
  if (q < 2) return null;
  const pa = pairs.filter(([a, b]) => a === b).length / n;
  let pe = 0;
  for (const c of cats) {
    const pi = (pairs.filter(([a]) => a === c).length + pairs.filter(([, b]) => b === c).length) / (2 * n);
    pe += pi * (1 - pi);
  }
  pe /= q - 1;
  if (pe === 1) return null;
  return (pa - pe) / (1 - pe);
}

function ranks(xs: number[]): number[] {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let t = i; t <= j; t++) r[order[t][1]] = avg;
    i = j + 1;
  }
  return r;
}

export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

export function spearman(xs: number[], ys: number[]): number | null {
  return pearson(ranks(xs), ranks(ys));
}

export function agreement(a: string[], b: string[], level: Level, allowed: string[] = []): Agreement {
  const pairs: [string, string][] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== '' && b[i] !== '' && a[i] !== undefined && b[i] !== undefined) pairs.push([a[i], b[i]]);
  }
  const numeric = level !== 'nominal' && pairs.length > 0 && pairs.every(([x, y]) => isNum(x) && isNum(y));
  const xs = numeric ? pairs.map(([x]) => Number(x)) : [];
  const ys = numeric ? pairs.map(([, y]) => Number(y)) : [];
  const categories = sortCats([...new Set([...allowed, ...pairs.flat()])]);
  const confusion: Record<string, Record<string, number>> = {};
  for (const c of categories) confusion[c] = Object.fromEntries(categories.map((d) => [d, 0]));
  for (const [x, y] of pairs) confusion[x][y]++;
  return {
    n: pairs.length,
    percentAgreement: percentAgreement(pairs),
    cohenKappa: cohenKappa(pairs),
    weightedKappa: numeric ? cohenKappa(pairs, 'quadratic') : null,
    krippendorffAlpha: krippendorffAlpha(pairs, numeric ? level : 'nominal'),
    gwetAC1: gwetAC1(pairs, allowed),
    spearman: numeric ? spearman(xs, ys) : null,
    pearson: numeric ? pearson(xs, ys) : null,
    mae: numeric ? xs.reduce((s, x, i) => s + Math.abs(x - ys[i]), 0) / xs.length : null,
    categories,
    confusion,
  };
}

/** Majority vote (categorical) or mean (numeric) across replicates. Ties are reported as "a | b". */
export function aggregate(values: string[], numeric: boolean): string {
  const v = values.filter((x) => x !== '');
  if (!v.length) return '';
  if (numeric && v.every(isNum)) {
    const mean = v.reduce((s, x) => s + Number(x), 0) / v.length;
    return String(Math.round(mean * 1000) / 1000);
  }
  const counts = new Map<string, number>();
  for (const x of v) counts.set(x, (counts.get(x) ?? 0) + 1);
  const max = Math.max(...counts.values());
  const top = [...counts.entries()].filter(([, c]) => c === max).map(([x]) => x);
  return top.length === 1 ? top[0] : top.sort().join(' | ');
}

export function fmtStat(x: number | null, digits = 3): string {
  return x === null || Number.isNaN(x) ? '—' : x.toFixed(digits);
}

export function fmtPct(x: number | null): string {
  return x === null ? '—' : `${(x * 100).toFixed(1)}%`;
}
