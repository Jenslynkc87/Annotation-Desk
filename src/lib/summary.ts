// A single run at a glance: the distribution of one field's labels, with n, mean, SD and median, overall and split
// by a metadata column (e.g. era, journal, year). Descriptive only: no tests, nothing exported.
import { labelScale, zeroOneScores, type ComparableField } from './compare';
import { isMissingLabel } from './metrics';
import { normalizeLabel } from './prompt';
import type { DocView } from './view';

/**
 * How a field is shown: `scale`, numbers on a fixed list of points (an ordinal codebook, plain-text scores on the
 * study's scale or the range seen); `categories` (nominal); `yesno`; `numbers` with no fixed points (Number fields).
 */
export type SummaryKind = 'scale' | 'categories' | 'yesno' | 'numbers';

/** One text of the run: its status in the run and the field's combined value (as `fieldValue` reads it). */
export interface SummaryItem {
  status: DocView['status'];
  value: string;
}

export interface Summary {
  kind: SummaryKind;
  /** The bars, in order: scale points, codebook categories (then others seen, for a field with no list), false/true. */
  points: string[];
  counts: number[];
  /** Texts of the run. */
  nTexts: number;
  /** Texts whose every attempt failed. */
  nFailed: number;
  /** Texts not answered (yet): still running, or never sent (a cancelled run). */
  nNotYet: number;
  /** Answered, but the field is empty (or a missing marker such as NA). */
  nBlank: number;
  /** Texts whose value is counted: in the bars, or (scales) between two points. */
  nValue: number;
  /** Scales: combined labels between two points (a median of 0.5 with two replicates): in the mean, not in the bars. */
  between: number;
  /** Replicates tied ("a | b"): no single label. */
  ties: number;
  /** Values off the scale or not one of the field's values (the first five shown). */
  leftOut: { n: number; values: string[] };
  /** Scales and numbers: over the values counted (bars and between). Null otherwise or with no value. */
  mean: number | null;
  sd: number | null;
  median: number | null;
  min: number | null;
  q1: number | null;
  q3: number | null;
  max: number | null;
}

const isNumber = (s: string) => s.trim() !== '' && Number.isFinite(Number(s));

/** The scale a field is summarized on: plain-text 0/1 scores on 0…1, so a code far off them (a 9) is left out and reported. */
export const summaryField = (f: ComparableField): ComparableField => (zeroOneScores(f) ? labelScale(f) : f);

export function summaryKind(f: ComparableField): SummaryKind {
  if (f.yesNo) return 'yesno';
  const numeric = f.allowed.length > 0 && f.allowed.every(isNumber);
  if (f.level !== 'nominal' && numeric) return 'scale';
  if (f.level !== 'nominal') return 'numbers';
  return 'categories';
}

/** Quantile by linear interpolation between order statistics (R's type 7, numpy's default). `xs` sorted. */
function quantile(xs: number[], p: number): number {
  const h = (xs.length - 1) * p;
  const lo = Math.floor(h);
  return lo + 1 < xs.length ? xs[lo] + (h - lo) * (xs[lo + 1] - xs[lo]) : xs[lo];
}

export function summarize(field: ComparableField, items: SummaryItem[]): Summary {
  const f = summaryField(field);
  const kind = summaryKind(f);
  const points =
    kind === 'yesno' ? ['false', 'true'] : kind === 'scale' ? [...f.allowed].sort((a, b) => Number(a) - Number(b)) : kind === 'categories' ? [...f.allowed] : [];
  const index = new Map(points.map((p, i) => [p, i]));
  const counts = points.map(() => 0);
  const lo = kind === 'scale' ? Number(points[0]) : -Infinity;
  const hi = kind === 'scale' ? Number(points[points.length - 1]) : Infinity;
  const nums: number[] = [];
  const left: string[] = [];
  let [nFailed, nNotYet, nBlank, between, ties, nLeft] = [0, 0, 0, 0, 0, 0];
  for (const it of items) {
    if (it.status === 'none') {
      nNotYet++;
      continue;
    }
    if (it.status === 'error') {
      nFailed++;
      continue;
    }
    const v = normalizeLabel(it.value, kind === 'yesno');
    if (v === '' || (isMissingLabel(v) && !index.has(v))) {
      nBlank++;
      continue;
    }
    const i = index.get(v);
    if (i !== undefined) {
      counts[i]++;
      if (kind === 'scale') nums.push(Number(v));
      continue;
    }
    if (kind !== 'numbers' && v.includes(' | ')) {
      ties++;
      continue;
    }
    if (kind === 'scale' && isNumber(v) && Number(v) > lo && Number(v) < hi) {
      between++;
      nums.push(Number(v));
      continue;
    }
    if (kind === 'numbers' && isNumber(v)) {
      nums.push(Number(v));
      continue;
    }
    // A category field with no list of values (none in practice): every value seen is a category.
    if (kind === 'categories' && !f.allowed.length) {
      index.set(v, points.length);
      points.push(v);
      counts.push(1);
      continue;
    }
    nLeft++;
    if (left.length < 5 && !left.includes(v)) left.push(v);
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = n ? sorted.reduce((s, x) => s + x, 0) / n : null;
  const sd = n > 1 && mean !== null ? Math.sqrt(sorted.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : null;
  const inBars = counts.reduce((s, c) => s + c, 0);
  return {
    kind,
    points,
    counts,
    nTexts: items.length,
    nFailed,
    nNotYet,
    nBlank,
    nValue: kind === 'numbers' ? n : inBars + between,
    between,
    ties,
    leftOut: { n: nLeft, values: left },
    mean,
    sd,
    median: n ? quantile(sorted, 0.5) : null,
    min: n ? sorted[0] : null,
    q1: n ? quantile(sorted, 0.25) : null,
    q3: n ? quantile(sorted, 0.75) : null,
    max: n ? sorted[n - 1] : null,
  };
}

/** Name of the group of texts with no value in the split column. */
export const NO_GROUP = '(no value)';

/**
 * The summary per value of a metadata column, in the column's order: by number when every value is a number (years),
 * else alphabetically (numbers within names in numeric order); texts with no value last.
 */
export function summarizeGroups(field: ComparableField, items: (SummaryItem & { group: string })[]): { group: string; summary: Summary }[] {
  const by = new Map<string, SummaryItem[]>();
  for (const it of items) {
    const g = it.group.trim() || NO_GROUP;
    const list = by.get(g);
    if (list) list.push(it);
    else by.set(g, [it]);
  }
  const named = [...by.keys()].filter((g) => g !== NO_GROUP);
  const numeric = named.every(isNumber);
  named.sort(numeric ? (a, b) => Number(a) - Number(b) : (a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (by.has(NO_GROUP)) named.push(NO_GROUP);
  return named.map((group) => ({ group, summary: summarize(field, by.get(group)!) }));
}

/**
 * A column whose values are numbers along a line (years, publication dates as numbers), shown as a trend: at least 95%
 * of its filled cells numbers, at least 5 different values, and at most one value per two texts (not an identifier).
 */
export function isNumericColumn(cells: (string | undefined)[]): boolean {
  const filled = cells.map((c) => (c ?? '').trim()).filter(Boolean);
  if (!filled.length) return false;
  const nums = filled.filter(isNumber);
  const distinct = new Set(nums.map(Number)).size;
  return nums.length >= filled.length * 0.95 && distinct >= 5 && distinct <= filled.length / 2;
}

/** A column that groups texts (era, journal): 2 to 30 different values, as the comparison report's breakdown. */
export function isGroupColumn(cells: (string | undefined)[]): boolean {
  const n = new Set(cells.map((c) => (c ?? '').trim()).filter(Boolean)).size;
  return n >= 2 && n <= 30;
}
