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
  /** Of those that differ: by a part of a point (e.g. 0.5 or 1.5, from the median of an even number of annotations). */
  fractional: number;
}

export interface Agreement {
  n: number;
  /** The level the statistics were computed at: the one asked for, or nominal when the values aren't numbers. */
  level: Level;
  /**
   * Texts left out, and some of those labels. On a scale: a label that wasn't a number (e.g. "NA") or was outside
   * the scale (e.g. 99): the codebook's, or for plain-text scores the range of the model's answers grown through the
   * labels next to it (see `agreement`); `range` is the scale's lowest and highest value. With codebook categories
   * that aren't numbers: a label that isn't one of them (nor a tie of them).
   */
  leftOut: { n: number; values: string[]; range?: [number, number] };
  /**
   * Plain-text scores: texts kept although a label lies outside the range of the model's answers (`range`), because it
   * is next to that range or to another label on the scale (e.g. a −3 when the model answered −2…3); the values, in order.
   */
  outsideAnswers?: { n: number; values: string[]; range: [number, number] };
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

/** Cell values that mean "no label" (e.g. R writes NA for a missing value), in any case. */
const MISSING_LABEL = /^(na|n\/a|#n\/a|n\.a\.?|nan|none|missing|unknown|-|–|—|\.|\?)$/i;
export const isMissingLabel = (v: string) => MISSING_LABEL.test(v.trim());

/** The distinct values: `first` (e.g. the codebook scale), then those of the pairs, in order of appearance. */
function distinct(pairs: [string, string][], first: string[] = []): string[] {
  const set = new Set(first);
  for (const [a, b] of pairs) set.add(a).add(b);
  return [...set];
}

/** How often each value occurs, counting both sides of every pair. */
function valueCounts(pairs: [string, string][]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [a, b] of pairs) {
    counts.set(a, (counts.get(a) ?? 0) + 1);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  return counts;
}

function sortCats(cats: string[]): string[] {
  return cats.every(isNum) ? cats.sort((a, b) => Number(a) - Number(b)) : cats.sort();
}

export function percentAgreement(pairs: [string, string][]): number | null {
  if (!pairs.length) return null;
  return pairs.filter(([a, b]) => a === b).length / pairs.length;
}

/**
 * Cohen's kappa. `scale` (e.g. the codebook's allowed values) adds categories nobody used, so that
 * weights reflect distances on the full scale (as sklearn's `labels=`); plain kappa is unaffected.
 * Weights for numbers are the distance between the values over the scale's range, |x − y| / (max − min)
 * (squared for quadratic): on a whole-number scale such as −3…3 that is the same as counting steps, and a
 * combined label between two scale points (e.g. 0.5, the median of an even number of annotations) gets
 * partial credit by its distance instead of becoming an extra step that stretches every other distance.
 */
export function cohenKappa(pairs: [string, string][], weights: 'none' | 'linear' | 'quadratic' = 'none', scale: string[] = []): number | null {
  const n = pairs.length;
  if (!n) return null;
  const cats = sortCats(distinct(pairs, scale));
  if (cats.length < 2) return null;
  const k = cats.length;
  const idx = new Map(cats.map((c, i) => [c, i]));
  // Position on the scale: the value itself for numbers, else the category's rank.
  const at = cats.every(isNum) ? cats.map(Number) : cats.map((_, i) => i);
  const range = Math.max(...at) - Math.min(...at);
  const dist = (i: number, j: number) => Math.abs(at[i] - at[j]) / range;
  const w = (i: number, j: number) => (weights === 'none' ? (i === j ? 0 : 1) : weights === 'linear' ? dist(i, j) : dist(i, j) ** 2);
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
  const values = sortCats(distinct(pairs));
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

/** The fixed categories for Gwet's coefficients: the codebook's (numbers: the scale's points, in order); null if fewer than 2. */
function fixedCategories(allowed: string[], numeric: boolean): string[] | null {
  if (!numeric) {
    const cats = [...new Set(allowed)];
    return cats.length >= 2 ? cats : null;
  }
  const byValue = new Map<number, string>();
  for (const s of allowed) if (isNum(s) && !byValue.has(Number(s))) byValue.set(Number(s), s);
  return byValue.size >= 2 ? [...byValue.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s) : null;
}

/**
 * Each category's share of all labels (both sides of every pair), on fixed categories: a label on a category counts
 * for it; a tie of categories ("a | b", majority vote) is split equally among them; on a numeric scale, a value between
 * two adjacent points (e.g. a 1.5 median) is split between them by distance. Null if a label fits none of these.
 */
function marginalsOn(cats: string[], pairs: [string, string][], numeric: boolean): number[] | null {
  const idx = new Map(cats.map((c, i) => [c, i]));
  const points = numeric ? cats.map(Number) : [];
  const at = (v: string) => idx.get(v) ?? (numeric && isNum(v) ? points.findIndex((p) => Math.abs(p - Number(v)) < 1e-9) : -1);
  const pi = new Array<number>(cats.length).fill(0);
  for (const [v, count] of valueCounts(pairs)) {
    const share = count / (2 * pairs.length);
    const i = at(v);
    if (i >= 0) {
      pi[i] += share;
    } else if (numeric && isNum(v)) {
      const x = Number(v);
      const above = points.findIndex((p) => p > x);
      if (above <= 0) return null; // below the lowest point or above the highest
      const [lo, hi] = [points[above - 1], points[above]];
      pi[above - 1] += (share * (hi - x)) / (hi - lo);
      pi[above] += (share * (x - lo)) / (hi - lo);
    } else {
      const parts = v.split(' | ').map(at);
      if (parts.length < 2 || parts.some((p) => p < 0)) return null;
      for (const p of parts) pi[p] += share / parts.length;
    }
  }
  return pi;
}

const spread = (pi: number[]) => pi.reduce((s, p) => s + p * (1 - p), 0);

/**
 * Gwet's AC1 for two raters. With the codebook's categories (`allowed`; `numericScale`: the points of a numeric scale)
 * q is their number and labels count towards them as in `marginalsOn`, so a tie or a half-point median is a
 * disagreement but no extra category. Without a codebook (or when a label fits none of its categories): the
 * categories are those seen.
 */
export function gwetAC1(pairs: [string, string][], allowed: string[] = [], numericScale = false): number | null {
  const n = pairs.length;
  if (!n) return null;
  const pa = pairs.filter(([a, b]) => a === b).length / n;
  const fixed = fixedCategories(allowed, numericScale);
  const pi = fixed && marginalsOn(fixed, pairs, numericScale);
  let q: number;
  let sum: number;
  if (fixed && pi) {
    q = fixed.length;
    sum = spread(pi);
  } else {
    const cats = distinct(pairs, allowed);
    q = cats.length;
    if (q < 2) return null;
    const counts = valueCounts(pairs);
    sum = spread(cats.map((c) => (counts.get(c) ?? 0) / (2 * n)));
  }
  const pe = sum / (q - 1);
  if (pe === 1) return null;
  return (pa - pe) / (1 - pe);
}

/**
 * Gwet's AC2 for two raters with linear weights, 1 − |a − b| / (max − min) over the scale's values. With a scale
 * (`scale`, at least 2 numbers) the categories are its points: q, the weights' total and the chance term are taken
 * over them, and a value between two points (e.g. a 1.5 median) is split between them as in `marginalsOn`. Without
 * one (or with a value off it), the categories are the values seen. With identity weights this is AC1.
 */
export function gwetAC2Linear(pairs: [string, string][], scale: string[] = []): number | null {
  const n = pairs.length;
  if (!n) return null;
  const fixed = fixedCategories(scale, true);
  const pi = fixed && marginalsOn(fixed, pairs, true);
  const cats = fixed && pi ? fixed : sortCats(distinct(pairs, scale));
  const q = cats.length;
  if (q < 2 || !cats.every(isNum)) return null;
  const vals = cats.map(Number);
  const range = Math.max(...vals) - Math.min(...vals);
  const w = (a: number, b: number) => 1 - Math.abs(a - b) / range;
  const pa = pairs.reduce((s, [a, b]) => s + w(Number(a), Number(b)), 0) / n;
  let tw = 0;
  for (const a of vals) for (const b of vals) tw += w(a, b);
  const counts = valueCounts(pairs);
  const sum = spread(pi ?? cats.map((c) => (counts.get(c) ?? 0) / (2 * n)));
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
  const g: Gaps = { same: 0, secondHigherSmall: 0, secondLowerSmall: 0, secondHigherLarge: 0, secondLowerLarge: 0, fractional: 0 };
  for (const [x, y] of numPairs(p)) {
    const d = y - x;
    if (Math.abs(d) < 1e-9) g.same++;
    else if (Math.abs(d) >= 2 - 1e-9) d > 0 ? g.secondHigherLarge++ : g.secondLowerLarge++;
    else d > 0 ? g.secondHigherSmall++ : g.secondLowerSmall++;
    if (Math.abs(d) >= 1e-9 && Math.abs(d - Math.round(d)) > 1e-9) g.fractional++;
  }
  return g;
}

/** Scale midpoint: from the codebook scale, else 0 when the values run from negative to positive. */
function scaleMidpoint(scale: number[], observed: number[]): number | null {
  if (scale.length >= 2) return (Math.min(...scale) + Math.max(...scale)) / 2;
  return observed.some((x) => x < 0) && observed.some((x) => x > 0) ? 0 : null;
}

/**
 * Plain-text scores: the scale labels may be on, grown from the range of the model's answers. A value whose distance to
 * the scale is at most `step` (half the range's width, at least 1 point) joins it and extends it, so labels next to the
 * range (or next to another label on the scale) are kept, e.g. a −3 when the model answered −2…3, while a code far
 * off (9, 33 or 99) is not.
 */
export function grownScale([lo, hi]: [number, number], values: number[]): [number, number] {
  const step = Math.max(1, (hi - lo) / 2);
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  for (const x of sorted) {
    if (x <= hi) continue;
    if (x - hi > step + 1e-9) break;
    hi = x;
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const x = sorted[i];
    if (x >= lo) continue;
    if (lo - x > step + 1e-9) break;
    lo = x;
  }
  return [lo, hi];
}

/**
 * `tolerance`: for numbers, how many scale points apart still count as agreeing in `withinTolerance`.
 * `withIntervals` false: leave out the bootstrap intervals (the slow part), e.g. to show the figures first.
 * `scaleSeen`: plain-text scores, with no codebook. `range`: the lowest and highest of the model's answers (else the
 * lowest and highest number in `allowed`, which is then every whole number of that range). The scale is that range
 * grown through the labels next to it (`grownScale`); it sets the weights and which labels are left out, but not the
 * scale's midpoint (which decides "opposite direction").
 */
export function agreement(
  a: string[],
  b: string[],
  level: Level,
  allowed: string[] = [],
  tolerance = 1,
  { withIntervals = true, scaleSeen = false, range }: { withIntervals?: boolean; scaleSeen?: boolean; range?: [number, number] } = {},
): Agreement {
  let pairs: [string, string][] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== '' && b[i] !== '' && a[i] !== undefined && b[i] !== undefined) pairs.push([a[i], b[i]]);
  }
  // On a scale, a value that isn't a number (e.g. "NA" in a coder's column) is missing, not a category of its
  // own (one such cell would otherwise turn every statistic nominal), as long as most values are numbers.
  // So is a number outside the scale (e.g. a missing-value code such as 9 or 99, or a typo such as 30 for 3),
  // which would otherwise stretch the scale every weight is measured on: the codebook's scale, or for plain-text
  // scores (`scaleSeen`) the range of the model's answers grown through the labels next to it. Codebook values
  // that are all numbers are a scale at every level, so at the nominal level too a combined label between two of
  // them (a 1.5 median) is compared, as a disagreement. With codebook categories that aren't numbers, a label that
  // is neither a category nor a tie of categories ("a | b") is left out. Those left out are reported. Mostly words
  // (e.g. "2 (moderate)"): compared as categories instead. A missing-value marker such as "NA" or "N/A" that isn't
  // itself a category is always left out (and reported), even where most labels are such markers.
  const leftOut: Agreement['leftOut'] = { n: 0, values: [] };
  let outsideAnswers: Agreement['outsideAnswers'];
  const numericCodebook = !scaleSeen && allowed.length > 0 && allowed.every(isNum);
  const allowedNums = allowed.filter(isNum).map(Number);
  // Plain-text scores: the range of the model's answers, and the scale grown from it.
  const seed: [number, number] | null = !scaleSeen
    ? null
    : range ?? (allowedNums.length ? [Math.min(...allowedNums), Math.max(...allowedNums)] : null);
  let block: [number, number] | null = null;
  let fits: ((v: string) => boolean) | null = null;
  // Numbers judged on a scale (plain-text scores, a codebook scale, or numeric codes): a number off it is always left out.
  let onNumbers = false;
  if (scaleSeen) {
    if (seed) {
      const values: number[] = [];
      for (const [x, y] of pairs) for (const v of [x, y]) if (isNum(v)) values.push(Number(v));
      block = grownScale(seed, values);
      leftOut.range = block;
    }
    const [lo, hi] = block ?? [-Infinity, Infinity];
    fits = (v: string) => isNum(v) && Number(v) >= lo - 1e-9 && Number(v) <= hi + 1e-9;
    onNumbers = true;
  } else if (level !== 'nominal' || numericCodebook) {
    onNumbers = true;
    const lo = allowedNums.length >= 2 ? Math.min(...allowedNums) : -Infinity;
    const hi = allowedNums.length >= 2 ? Math.max(...allowedNums) : Infinity;
    if (allowedNums.length >= 2) leftOut.range = [lo, hi];
    const onScale = (v: string) => isNum(v) && Number(v) >= lo - 1e-9 && Number(v) <= hi + 1e-9;
    // (A tie of scale points, from a majority vote of numeric categories, is a category of its own at the nominal level.)
    fits = level === 'nominal' ? (v: string) => onScale(v) || (v.includes(' | ') && v.split(' | ').every(onScale)) : onScale;
  } else if (new Set(allowed).size >= 2) {
    const cats = new Set(allowed);
    fits = (v: string) => cats.has(v) || (v.includes(' | ') && v.split(' | ').every((x) => cats.has(x)));
  }
  let compareAsWords = false;
  if (fits) {
    const onScale = fits;
    const missing = (v: string) => !onScale(v) && isMissingLabel(v);
    const labelled = pairs.filter(([x, y]) => !missing(x) && !missing(y));
    const kept = labelled.filter(([x, y]) => onScale(x) && onScale(y));
    // On a scale, a number off it is always left out (also where most labels are, e.g. a column of 99 codes); only
    // mostly words are compared as they are. Categories: mostly labels that aren't categories.
    compareAsWords = onNumbers
      ? labelled.filter(([x, y]) => !isNum(x) || !isNum(y)).length * 2 > labelled.length
      : !(kept.length && kept.length >= labelled.length / 2);
    const use = compareAsWords ? labelled : kept;
    if (use.length < pairs.length) {
      leftOut.n = pairs.length - use.length;
      leftOut.values = [...new Set(pairs.flat().filter((v) => !onScale(v) && (!compareAsWords || missing(v))))].slice(0, 5);
      pairs = use;
    }
    if (seed && !compareAsWords) {
      const outside = (v: string) => isNum(v) && (Number(v) < seed[0] - 1e-9 || Number(v) > seed[1] + 1e-9);
      const beyond = pairs.filter(([x, y]) => outside(x) || outside(y));
      if (beyond.length) {
        const values = [...new Set(beyond.flat().filter(outside))].sort((x, y) => Number(x) - Number(y));
        outsideAnswers = { n: beyond.length, values, range: seed };
      }
    }
  }
  const allNumbers = pairs.length > 0 && pairs.every(([x, y]) => isNum(x) && isNum(y));
  const numeric = level !== 'nominal' && allNumbers;
  const xs = numeric ? pairs.map(([x]) => Number(x)) : [];
  const ys = numeric ? pairs.map(([, y]) => Number(y)) : [];
  const categories = sortCats([...new Set([...allowed, ...pairs.flat()])]);
  const confusion: Record<string, Record<string, number>> = {};
  for (const c of categories) confusion[c] = Object.fromEntries(categories.map((d) => [d, 0]));
  for (const [x, y] of pairs) confusion[x][y]++;
  // Plain-text runs (`scaleSeen`): the scale is every whole number of the grown scale above, so a value never used
  // still counts in the weights and in Gwet's q, and a value between whole numbers (a 1.5 median, or a 2.5 answer
  // that made the field interval) is split between them, as on a codebook scale. Without a range, the range of the
  // values here (whole numbers only).
  const seenScale = (): string[] => {
    const vals = block ? [...block, ...allowedNums] : [...allowedNums, ...pairs.flat().map(Number)];
    const whole = !!block || level === 'ordinal' || allowedNums.length > 0 || vals.every(Number.isInteger);
    if (!vals.length || !whole) return allowedNums.map(String);
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of vals) (lo = Math.min(lo, x)), (hi = Math.max(hi, x));
    [lo, hi] = [Math.floor(lo), Math.ceil(hi)];
    return hi - lo <= 100 ? Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i)) : allowedNums.map(String);
  };
  // The scale's points: for the weights (numbers), and for Gwet's AC1 also at the nominal level when the codebook's
  // values are numbers (or for plain-text scores): q is their number, a half point is split between its neighbours.
  const points = allNumbers || (level === 'nominal' && !compareAsWords && (scaleSeen || numericCodebook)) ? (scaleSeen ? seenScale() : allowed.filter(isNum)) : [];
  const scale = numeric ? points : [];
  const ac1Scale = numeric || (level === 'nominal' && points.length >= 2) ? points : allowed;
  const ac1Numeric = ac1Scale === points && points.length > 0;
  // Nothing left to compare (e.g. every label "NA"): the level asked for, not nominal.
  const alphaLevel = numeric || !pairs.length ? level : 'nominal';
  const midpoint = numeric ? scaleMidpoint(scaleSeen ? [] : scale.map(Number), [...xs, ...ys]) : null;
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
    gwetAC1: (p: [string, string][]) => gwetAC1(p, ac1Scale, ac1Numeric),
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
    level: alphaLevel,
    leftOut,
    ...(outsideAnswers ? { outsideAnswers } : {}),
    percentAgreement: percentAgreement(pairs),
    cohenKappa: cohenKappa(pairs),
    weightedKappa: numeric ? cohenKappa(pairs, 'quadratic', scale) : null,
    weightedKappaLinear: numeric ? cohenKappa(pairs, 'linear', scale) : null,
    krippendorffAlpha: krippendorffAlpha(pairs, alphaLevel),
    gwetAC1: gwetAC1(pairs, ac1Scale, ac1Numeric),
    gwetAC2Linear: numeric ? gwetAC2Linear(pairs, scale) : null,
    ci: withIntervals ? bootstrapCI(pairs, stats) : {},
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

/** A number to `digits` decimals, without a minus sign on zero (a tiny negative such as −1e-17 is "0.000", not "-0.000"). */
export function fixed(x: number, digits: number): string {
  return x.toFixed(digits).replace(/^-(0(\.0+)?)$/, '$1');
}

export function fmtStat(x: number | null, digits = 3): string {
  return x === null || Number.isNaN(x) ? '—' : fixed(x, digits);
}

export function fmtPct(x: number | null): string {
  return x === null ? '—' : `${(x * 100).toFixed(1)}%`;
}
