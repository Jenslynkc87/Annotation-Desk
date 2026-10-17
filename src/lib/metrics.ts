// Agreement statistics between two sets of labels for the same items.
// Pairs with a missing value on either side are dropped before computing.

export type Level = 'nominal' | 'ordinal' | 'interval';

export interface Gaps {
  same: number;
  /** Differ by less than 2 points ("off by 1" on whole-number scales); "second" = the compared-with source. */
  secondHigherSmall: number;
  secondLowerSmall: number;
  /** Differ by 2 points or more. */
  secondHigherLarge: number;
  secondLowerLarge: number;
}

export interface Agreement {
  n: number;
  percentAgreement: number | null;
  cohenKappa: number | null;
  weightedKappa: number | null; // quadratic weights, ordinal/interval only
  weightedKappaLinear: number | null; // linear weights, ordinal/interval only
  krippendorffAlpha: number | null;
  gwetAC1: number | null;
  /** Numbers only: Gwet's AC2 with linear weights over the scale (partial credit for near misses). */
  gwetAC2Linear: number | null;
  spearman: number | null;
  pearson: number | null;
  mae: number | null;
  /** Numbers only: the tolerance used for `withinTolerance` (in scale points). */
  tolerance: number;
  /** Numbers only: share of texts whose two values differ by at most `tolerance` (exact and adjacent agreement). */
  withinTolerance: number | null;
  /** Numbers only: average of (second − first); positive = the second source scores higher. */
  meanDifference: number | null;
  /** Numbers only: share of texts whose values differ by 2 or more points. */
  largeDifference: number | null;
  /** Numbers only: share of texts where one value is below the scale midpoint and the other above it (null without a midpoint). */
  oppositeDirection: number | null;
  /** Numbers only: how many texts have the same value, differ by less than 2 points, or by 2 or more, split by which source is higher. */
  gaps: Gaps | null;
  /** The midpoint used for `oppositeDirection` (e.g. 0 on a −3…+3 scale, 4 on 1…7). */
  midpoint: number | null;
  /** 95% bootstrap intervals (percentile method, texts resampled); null when too few texts. */
  ci: Partial<Record<CiStat, [number, number] | null>>;
  categories: string[];
  /** confusion[a][b] = count, a = first source, b = second source */
  confusion: Record<string, Record<string, number>>;
}

export type CiStat =
  | 'percentAgreement'
  | 'withinTolerance'
  | 'largeDifference'
  | 'oppositeDirection'
  | 'cohenKappa'
  | 'weightedKappa'
  | 'weightedKappaLinear'
  | 'krippendorffAlpha'
  | 'gwetAC1'
  | 'gwetAC2Linear'
  | 'meanDifference'
  | 'mae';

const isNum = (s: string) => s.trim() !== '' && !Number.isNaN(Number(s));

function sortCats(cats: string[]): string[] {
  return cats.every(isNum) ? cats.sort((a, b) => Number(a) - Number(b)) : cats.sort();
}

export function percentAgreement(pairs: [string, string][]): number | null {
  if (!pairs.length) return null;
  return pairs.filter(([a, b]) => a === b).length / pairs.length;
}

/**
 * Cohen's kappa. `scale` (e.g. the codebook's allowed values) adds categories nobody used, so that
 * quadratic weights reflect distances on the full scale (as sklearn's `labels=`); plain kappa is unaffected.
 */
export function cohenKappa(pairs: [string, string][], weights: 'none' | 'linear' | 'quadratic' = 'none', scale: string[] = []): number | null {
  const n = pairs.length;
  if (!n) return null;
  const cats = sortCats([...new Set([...scale, ...pairs.flat()])]);
  if (cats.length < 2) return null;
  const k = cats.length;
  const idx = new Map(cats.map((c, i) => [c, i]));
  const w = (i: number, j: number) => (weights === 'none' ? (i === j ? 0 : 1) : weights === 'linear' ? Math.abs(i - j) / (k - 1) : ((i - j) / (k - 1)) ** 2);
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

/**
 * Gwet's AC2 for two raters with linear weights, 1 − |a − b| / (max − min) over the scale's values
 * (the categories are the codebook scale plus any observed value). With identity weights this is AC1.
 */
export function gwetAC2Linear(pairs: [string, string][], scale: string[] = []): number | null {
  const n = pairs.length;
  if (!n) return null;
  const cats = sortCats([...new Set([...scale, ...pairs.flat()])]);
  const q = cats.length;
  if (q < 2 || !cats.every(isNum)) return null;
  const vals = cats.map(Number);
  const range = Math.max(...vals) - Math.min(...vals);
  const w = (a: number, b: number) => 1 - Math.abs(a - b) / range;
  const pa = pairs.reduce((s, [a, b]) => s + w(Number(a), Number(b)), 0) / n;
  let tw = 0;
  for (const a of vals) for (const b of vals) tw += w(a, b);
  let sum = 0;
  for (const c of cats) {
    const pi = pairs.reduce((s, [a, b]) => s + (a === c ? 1 : 0) + (b === c ? 1 : 0), 0) / (2 * n);
    sum += pi * (1 - pi);
  }
  const pe = (tw / (q * (q - 1))) * sum;
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

// Small seeded random generator (mulberry32), so bootstrap intervals are the same every time.
export function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BOOTSTRAP_RESAMPLES = 2000;

/** 95% percentile bootstrap intervals: texts are drawn with replacement and each statistic recomputed. */
function bootstrapCI(pairs: [string, string][], stats: Partial<Record<CiStat, (p: [string, string][]) => number | null>>): Agreement['ci'] {
  const keys = Object.keys(stats) as CiStat[];
  if (pairs.length < 10) return Object.fromEntries(keys.map((k) => [k, null]));
  const rnd = seeded(20260101);
  const draws: Record<string, number[]> = Object.fromEntries(keys.map((k) => [k, []]));
  const sample: [string, string][] = new Array(pairs.length);
  for (let b = 0; b < BOOTSTRAP_RESAMPLES; b++) {
    for (let i = 0; i < pairs.length; i++) sample[i] = pairs[Math.floor(rnd() * pairs.length)];
    for (const k of keys) {
      const v = stats[k]!(sample);
      if (v !== null && Number.isFinite(v)) draws[k].push(v);
    }
  }
  const pct = (xs: number[], q: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.round(q * (xs.length - 1))))];
  return Object.fromEntries(
    keys.map((k) => {
      const xs = draws[k].sort((x, y) => x - y);
      // Undefined in many resamples (e.g. only one category drawn): no trustworthy interval.
      return [k, xs.length >= 0.9 * BOOTSTRAP_RESAMPLES ? [pct(xs, 0.025), pct(xs, 0.975)] : null];
    }),
  );
}

const numPairs = (p: [string, string][]) => p.map(([x, y]) => [Number(x), Number(y)] as const);
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
export const withinTolerance = (p: [string, string][], tol: number) => mean(numPairs(p).map(([x, y]) => (Math.abs(x - y) <= tol + 1e-9 ? 1 : 0)));
export const meanDifference = (p: [string, string][]) => mean(numPairs(p).map(([x, y]) => y - x));
export const meanAbsoluteError = (p: [string, string][]) => mean(numPairs(p).map(([x, y]) => Math.abs(x - y)));
export const largeDifference = (p: [string, string][]) => mean(numPairs(p).map(([x, y]) => (Math.abs(x - y) >= 2 - 1e-9 ? 1 : 0)));
export const oppositeDirection = (p: [string, string][], mid: number) =>
  mean(numPairs(p).map(([x, y]) => ((x < mid && y > mid) || (x > mid && y < mid) ? 1 : 0)));

export function gapCounts(p: [string, string][]): Gaps {
  const g: Gaps = { same: 0, secondHigherSmall: 0, secondLowerSmall: 0, secondHigherLarge: 0, secondLowerLarge: 0 };
  for (const [x, y] of numPairs(p)) {
    const d = y - x;
    if (Math.abs(d) < 1e-9) g.same++;
    else if (Math.abs(d) >= 2 - 1e-9) d > 0 ? g.secondHigherLarge++ : g.secondLowerLarge++;
    else d > 0 ? g.secondHigherSmall++ : g.secondLowerSmall++;
  }
  return g;
}

/** Scale midpoint: from the codebook scale, else 0 when the values run from negative to positive. */
function scaleMidpoint(scale: number[], observed: number[]): number | null {
  if (scale.length >= 2) return (Math.min(...scale) + Math.max(...scale)) / 2;
  return observed.some((x) => x < 0) && observed.some((x) => x > 0) ? 0 : null;
}

/** `tolerance`: for numbers, how many scale points apart still count as agreeing in `withinTolerance`. */
export function agreement(a: string[], b: string[], level: Level, allowed: string[] = [], tolerance = 1): Agreement {
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
  const scale = numeric ? allowed.filter(isNum) : [];
  const alphaLevel = numeric ? level : 'nominal';
  const midpoint = numeric ? scaleMidpoint(scale.map(Number), [...xs, ...ys]) : null;
  const stats = {
    percentAgreement,
    cohenKappa: (p: [string, string][]) => cohenKappa(p),
    ...(numeric
      ? {
          weightedKappa: (p: [string, string][]) => cohenKappa(p, 'quadratic', scale),
          weightedKappaLinear: (p: [string, string][]) => cohenKappa(p, 'linear', scale),
          gwetAC2Linear: (p: [string, string][]) => gwetAC2Linear(p, scale),
          largeDifference,
          ...(midpoint !== null ? { oppositeDirection: (p: [string, string][]) => oppositeDirection(p, midpoint) } : {}),
        }
      : {}),
    krippendorffAlpha: (p: [string, string][]) => krippendorffAlpha(p, alphaLevel),
    gwetAC1: (p: [string, string][]) => gwetAC1(p, allowed),
    ...(numeric
      ? {
          withinTolerance: (p: [string, string][]) => withinTolerance(p, tolerance),
          meanDifference,
          mae: meanAbsoluteError,
        }
      : {}),
  };
  return {
    n: pairs.length,
    percentAgreement: percentAgreement(pairs),
    cohenKappa: cohenKappa(pairs),
    weightedKappa: numeric ? cohenKappa(pairs, 'quadratic', scale) : null,
    weightedKappaLinear: numeric ? cohenKappa(pairs, 'linear', scale) : null,
    krippendorffAlpha: krippendorffAlpha(pairs, alphaLevel),
    gwetAC1: gwetAC1(pairs, allowed),
    gwetAC2Linear: numeric ? gwetAC2Linear(pairs, scale) : null,
    ci: bootstrapCI(pairs, stats),
    spearman: numeric ? spearman(xs, ys) : null,
    pearson: numeric ? pearson(xs, ys) : null,
    mae: numeric ? meanAbsoluteError(pairs) : null,
    tolerance,
    withinTolerance: numeric ? withinTolerance(pairs, tolerance) : null,
    meanDifference: numeric ? meanDifference(pairs) : null,
    largeDifference: numeric ? largeDifference(pairs) : null,
    gaps: numeric ? gapCounts(pairs) : null,
    oppositeDirection: numeric && midpoint !== null ? oppositeDirection(pairs, midpoint) : null,
    midpoint,
    categories,
    confusion,
  };
}

export type Aggregation = 'majority' | 'median' | 'mean';

/**
 * Combine replicates: majority vote (categories; ties reported as "a | b"), median (ordinal scales:
 * a whole number with an odd number of replicates) or mean (numbers).
 */
export function aggregate(values: string[], method: Aggregation): string {
  const v = values.filter((x) => x !== '');
  if (!v.length) return '';
  if (method !== 'majority' && v.every(isNum)) {
    const xs = v.map(Number).sort((a, b) => a - b);
    const mid = Math.floor(xs.length / 2);
    const value = method === 'mean' ? xs.reduce((s, x) => s + x, 0) / xs.length : xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
    return String(Math.round(value * 1000) / 1000);
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
