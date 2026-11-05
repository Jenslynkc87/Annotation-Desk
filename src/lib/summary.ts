import { fieldValue, zeroOneScores, type ComparableField } from './compare';
import { isMissingLabel, wilsonCI } from './metrics';
import { normalizeLabel, toNumber } from './prompt';
import type { Doc, Run } from './types';
import type { DocView } from './view';

/** A text of the run with its view (status, combined values). */
export interface RunItem {
  doc: Doc;
  view: DocView;
}

/**
 * Run summary (Runs & agreement → Results): how one run's answers are distributed, field by field. Each text counts
 * once, with its combined value (the median of its annotations on a scale, the mean for numbers, the majority for
 * categories: as in the Results table and the exports). Descriptive only: no tests.
 */

/** How a field is drawn: bars on a numeric scale (−3…3, 1–5, 0/1 flags), a histogram (numbers), or categories. */
export type SummaryKind = 'scale' | 'number' | 'categories';

export interface Bin {
  /** The value as stored (normalized), e.g. "-3", "0.5", "positive", "true"; for histogram bins "lo|hi". */
  key: string;
  /** As shown, e.g. "−3", "Yes", "Positive", "10–20". */
  label: string;
  n: number;
  /** Scale and number bars: where the bar sits on the axis (a histogram bin: its middle). */
  value?: number;
  /** Not a point of the scale or a value of the codebook: a combined half point (0.5), a tie, an off-scale number. */
  extra?: boolean;
}

export interface FieldSummary {
  key: string;
  label: string;
  kind: SummaryKind;
  /** A scale with values below and above 0 (e.g. −3…3): drawn around 0, below in one color, above in another. */
  diverging: boolean;
  /** The scale's ends (codebook, the study's declared scale, or the range of the answers); null for categories. */
  range: [number, number] | null;
  bins: Bin[];
  /** Texts whose value is counted in the figures. */
  n: number;
  /** Annotated texts with no value for this field (e.g. a plain-text answer without the key, or written as prose). */
  missing: number;
  /** Numeric fields: values that aren't numbers (e.g. "NA"), left out of the figures, with up to 5 of them. */
  leftOut: { n: number; values: string[] };
  mean: number | null;
  sd: number | null;
  median: number | null;
  /** 95% interval of the mean (t), from 10 texts. */
  ci: [number, number] | null;
  min: number | null;
  max: number | null;
  /** Diverging scales: texts below 0, at 0, above 0. */
  sides: { below: number; middle: number; above: number } | null;
  /** Yes/no fields: share of yes among the texts with yes or no (a tie is neither), with its 95% Wilson interval. */
  yes: { share: number; n: number; ci: [number, number] | null } | null;
}

export interface RunCounts {
  /** Texts the run was for. */
  total: number;
  /** With an answer (every annotation, or some: `partial`). */
  annotated: number;
  /** Annotated, but some of their annotations failed: their values combine the others. */
  partial: number;
  /** Every annotation failed. */
  failed: number;
  /** No answer yet (a batch still at the provider, or a run that was stopped). */
  waiting: number;
}

/**
 * The run's texts (also those removed from the study but kept for it) with their views, in the run's order. Texts an
 * older version deleted outright have no record and are not counted.
 */
export function runItems(run: Run, docs: Doc[], views: Map<string, DocView>): RunItem[] {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const out: RunItem[] = [];
  for (const id of new Set(run.docIds)) {
    const doc = byId.get(id);
    const view = views.get(id);
    if (doc && view) out.push({ doc, view });
  }
  return out;
}

export function runCounts(items: RunItem[]): RunCounts {
  const c: RunCounts = { total: items.length, annotated: 0, partial: 0, failed: 0, waiting: 0 };
  for (const { view: v } of items) {
    if (v.status === 'ok' || v.status === 'partial') c.annotated++;
    if (v.status === 'partial') c.partial++;
    if (v.status === 'error') c.failed++;
    if (v.status === 'none') c.waiting++;
  }
  return c;
}

/** A number as shown on a scale: a real minus sign, at most 2 decimals ("−3", "0.5", "1.33"). */
export function scaleLabel(x: number): string {
  const s = String(Math.round(x * 100) / 100);
  return s.startsWith('-') ? `−${s.slice(1)}` : s;
}

/**
 * The two-sided 95% critical value of Student's t with `df` degrees of freedom (Cornish–Fisher expansion around the
 * normal quantile; within 0.001 of the exact value from df = 5, and intervals are only given from 10 texts, df = 9).
 */
export function tCritical95(df: number): number {
  const z = 1.959963984540054;
  if (!Number.isFinite(df) || df <= 0) return NaN;
  const z3 = z ** 3;
  const z5 = z ** 5;
  const z7 = z ** 7;
  const z9 = z ** 9;
  return (
    z +
    (z3 + z) / (4 * df) +
    (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2) +
    (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3) +
    (79 * z9 + 776 * z7 + 1482 * z5 - 1920 * z3 - 945 * z) / (92160 * df ** 4)
  );
}

/** Mean, SD (n − 1), median, min, max and the 95% t interval of the mean (none below 10 values). */
export function describe(xs: number[]): Pick<FieldSummary, 'mean' | 'sd' | 'median' | 'ci' | 'min' | 'max'> {
  const n = xs.length;
  if (!n) return { mean: null, sd: null, median: null, ci: null, min: null, max: null };
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : null;
  const mid = Math.floor(n / 2);
  const median = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const half = n >= 10 && sd !== null ? (tCritical95(n - 1) * sd) / Math.sqrt(n) : null;
  return { mean, sd, median, ci: half === null ? null : [mean - half, mean + half], min: sorted[0], max: sorted[n - 1] };
}

const isNumberText = (s: string) => s.trim() !== '' && Number.isFinite(toNumber(s));
const sortNumeric = (a: number, b: number) => a - b;

/** How a field is drawn, and the points of its scale (numbers) where it has one. */
function shapeOf(field: ComparableField): { kind: SummaryKind; points: number[]; range: [number, number] | null } {
  if (field.yesNo) return { kind: 'categories', points: [], range: null };
  // Plain-text scores of 0 and 1 (a flag): bars at 0 and 1, the mean is the share of 1s.
  if (zeroOneScores(field)) return { kind: 'scale', points: [0, 1], range: [0, 1] };
  if (field.level === 'nominal') return { kind: 'categories', points: [], range: null };
  const points = field.allowed.filter(isNumberText).map((x) => toNumber(x));
  // An ordinal scale with its points (a codebook, the study's declared scale, or the whole numbers of the answers seen).
  if (field.level === 'ordinal' && points.length >= 2 && points.length === field.allowed.length) {
    points.sort(sortNumeric);
    const range: [number, number] = field.range ?? [points[0], points[points.length - 1]];
    return { kind: 'scale', points, range };
  }
  return { kind: 'number', points: [], range: field.range ?? null };
}

/** Display names of a structured field's categories, from the run's codebook ("Very positive" for "very positive"). */
function categoryNames(run: Run, key: string): Map<string, string> {
  const v = run.snapshot.prompt.variables.find((x) => x.name === key);
  const names = new Map<string, string>();
  for (const x of v?.values ?? []) {
    const k = normalizeLabel(x);
    if (k && !names.has(k)) names.set(k, x.trim());
  }
  return names;
}

const YES_NO: Record<string, string> = { true: 'Yes', false: 'No' };
/** The bar of a categories field for texts whose annotations had no majority. */
export const TIE_KEY = '\u0000tie';

/**
 * One field of one run, over `items` (the run's texts, or a group of them): its bars and figures. Texts without an
 * answer (failed, waiting) are not counted at all; annotated texts without a value for the field are `missing`.
 */
export function summarizeField(run: Run, field: ComparableField, items: RunItem[]): FieldSummary {
  const { kind, points, range } = shapeOf(field);
  const values: string[] = [];
  let missing = 0;
  for (const { view: v } of items) {
    if (v.status !== 'ok' && v.status !== 'partial') continue;
    const raw = normalizeLabel(fieldValue(run, v.values, field.key), field.yesNo);
    // (A missing-value marker such as "NA" on a categories field is a value if the codebook has it, else a blank.)
    if (raw === '' || (kind === 'categories' && isMissingLabel(raw) && !field.allowed.includes(raw))) missing++;
    else values.push(raw);
  }

  const base = { key: field.key, label: field.label, kind, range, missing };
  if (kind === 'categories') {
    const counts = new Map<string, number>();
    for (const x of values) counts.set(x, (counts.get(x) ?? 0) + 1);
    const names = categoryNames(run, field.key);
    const label = (k: string) => (field.yesNo ? (YES_NO[k] ?? k) : (names.get(k) ?? k));
    // The codebook's values in its order (also those no text got), then any others (values from older codebooks),
    // most frequent first, then the texts whose annotations had no majority (ties such as "critical | neutral"), as
    // one bar: with several annotations per text there can be many different ties.
    const allowed = field.yesNo ? ['true', 'false'] : field.allowed;
    const bins: Bin[] = allowed.map((k) => ({ key: k, label: label(k), n: counts.get(k) ?? 0 }));
    const isTie = (k: string) => k.includes(' | ') && !allowed.includes(k);
    const others = [...counts.entries()].filter(([k]) => !allowed.includes(k) && !isTie(k)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [k, n] of others) bins.push({ key: k, label: label(k), n, extra: true });
    const ties = [...counts.entries()].filter(([k]) => isTie(k)).reduce((t, [, n]) => t + n, 0);
    if (ties) bins.push({ key: TIE_KEY, label: 'No majority (tie)', n: ties, extra: true });
    const yesN = counts.get('true') ?? 0;
    const noN = counts.get('false') ?? 0;
    const yes = field.yesNo && yesN + noN > 0 ? { share: yesN / (yesN + noN), n: yesN + noN, ci: wilsonCI(yesN / (yesN + noN), yesN + noN) } : null;
    return { ...base, diverging: false, bins, n: values.length, leftOut: { n: 0, values: [] }, ...describe([]), sides: null, yes };
  }

  // Numbers: values that aren't (e.g. "NA" in a plain-text answer) are left out and reported.
  const xs: number[] = [];
  const left: string[] = [];
  let leftN = 0;
  for (const x of values) {
    const num = toNumber(x);
    if (Number.isFinite(num)) xs.push(num);
    else {
      leftN++;
      if (left.length < 5 && !left.includes(x)) left.push(x);
    }
  }
  const stats = describe(xs);
  const diverging = kind === 'scale' && !!range && range[0] < 0 && range[1] > 0;
  const sides = diverging ? { below: xs.filter((x) => x < 0).length, middle: xs.filter((x) => x === 0).length, above: xs.filter((x) => x > 0).length } : null;
  let bins: Bin[];
  if (kind === 'scale') {
    const counts = new Map<number, number>();
    for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
    // Every point of the scale (also those no text got), and values between or beyond them (combined half points,
    // off-scale answers in plain text) in their place.
    const all = [...new Set([...points, ...counts.keys()])].sort(sortNumeric);
    bins = all.map((x) => ({ key: String(x), label: scaleLabel(x), n: counts.get(x) ?? 0, value: x, ...(points.includes(x) ? {} : { extra: true }) }));
  } else bins = histogram(xs);
  return { ...base, diverging, bins, n: xs.length, leftOut: { n: leftN, values: left }, ...stats, sides, yes: null };
}

/** Numbers: a bar per value when there are at most 15 distinct ones, else 10 bins of equal width. */
export function histogram(xs: number[]): Bin[] {
  if (!xs.length) return [];
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  if (counts.size <= 15)
    return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([x, n]) => ({ key: String(x), label: scaleLabel(x), n, value: x }));
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of xs) (lo = Math.min(lo, x)), (hi = Math.max(hi, x));
  const k = 10;
  const width = (hi - lo) / k;
  const n = Array.from({ length: k }, () => 0);
  // (The highest value goes into the last bin.)
  for (const x of xs) n[Math.min(k - 1, Math.floor((x - lo) / width))]++;
  const edge = (x: number) => scaleLabel(Number(x.toPrecision(3)));
  return n.map((c, i) => {
    const a = lo + i * width;
    const b = i === k - 1 ? hi : lo + (i + 1) * width;
    return { key: `${a}|${b}`, label: `${edge(a)}–${edge(b)}`, n: c, value: (a + b) / 2 };
  });
}

/**
 * The run's texts by a metadata column (e.g. era, journal), each group summarized: groups in natural order (1960s
 * before 1970s, 2 before 10), texts with no value last as "(no value)".
 */
export function summarizeByGroup(run: Run, field: ComparableField, items: RunItem[], column: string): { group: string; none: boolean; summary: FieldSummary }[] {
  const groups = new Map<string, RunItem[]>();
  for (const item of items) {
    const g = (item.doc.meta[column] ?? '').trim();
    const list = groups.get(g);
    if (list) list.push(item);
    else groups.set(g, [item]);
  }
  const collator = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' });
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : collator.compare(a, b)))
    .map(([g, list]) => ({ group: g || '(no value)', none: g === '', summary: summarizeField(run, field, list) }));
}

/**
 * Columns a run's texts can be split by, in the order the columns first appear: a few distinct values (2 to 30) among
 * the texts that have one, as the comparison report's breakdown, and not nearly one per text (a file name or an ID
 * in a small pilot: more than 70% of them different). A column with a value for only some texts still counts (the
 * rest form "(no value)").
 */
export function groupColumns(items: RunItem[]): string[] {
  const seen = new Map<string, { values: Set<string>; filled: number }>();
  for (const { doc } of items)
    for (const [k, x] of Object.entries(doc.meta)) {
      const t = (x ?? '').trim();
      if (!t) continue;
      let s = seen.get(k);
      if (!s) seen.set(k, (s = { values: new Set(), filled: 0 }));
      s.filled++;
      if (s.values.size <= 30) s.values.add(t);
    }
  return [...seen.entries()].filter(([, s]) => s.values.size >= 2 && s.values.size <= 30 && s.values.size <= s.filled * 0.7).map(([k]) => k);
}
