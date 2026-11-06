import type { Row } from './export/tables';
import { binCategoryKey, CATEGORY_SLOTS, scaleLabel, scaleStops, TIE_KEY, wholePercent, yesPercent, type Bin, type FieldSummary } from './summary';

/**
 * Downloadable figures of the Results panel, drawn for print rather than copied from the screen: SVG (vector, any
 * size; opens in Word, PowerPoint, Inkscape and Illustrator, which can also save it as EPS or PDF), PNG at 600 dpi,
 * and the numbers behind each figure as CSV. White background, Arial or Helvetica at 7–8 pt at the chosen width, no
 * title inside (that goes in the caption), colors that keep their order in grayscale. Not tied to one journal: the
 * two widths are the common one-column and full-page widths.
 */

export const FIGURE_WIDTHS = [
  { mm: 85, label: 'one column (85 mm)' },
  { mm: 175, label: 'full width (175 mm)' },
] as const;
export const PNG_DPI = 600;

const PT_PER_MM = 72 / 25.4;
const FONT = 'Arial, Helvetica, sans-serif';
const SIZE = 8; // pt
const SMALL = 7; // pt
const INK = '#1a1a1a';
const MUTED = '#5c5c5c';
const AXIS = '#9a9a9a';
const GRID = '#e2e2e2';
const GAP = 0.6; // pt of white between touching parts of a bar

/** The panel's light-mode colors (src/styles.css, --sum-*), as hex: the figures don't depend on the screen's theme. */
const PALETTE: Record<string, string> = {
  mid: '#d5d4d1',
  'neg-1': '#86b6ef',
  'neg-2': '#3987e5',
  'neg-3': '#1c5cab',
  'pos-1': '#eca071',
  'pos-2': '#dc702f',
  'pos-3': '#a64a18',
  'seq-1': '#86b6ef',
  'seq-2': '#3987e5',
  'seq-3': '#1c5cab',
  'cat-1': '#2a78d6',
  'cat-2': '#eda100',
  'cat-3': '#008300',
  'cat-4': '#e87ba4',
  'cat-5': '#6250d6',
  'cat-6': '#eb6834',
  'cat-7': '#1baf7a',
  'cat-8': '#e34948',
  other: '#cfcdc6',
  tie: '#8a8882',
};

/* ------------------------------------------------------------------ colors */

function hexToLin(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}
function linToOklab([r, g, b]: [number, number, number]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function oklabToHex([L, a, b]: [number, number, number]): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return `#${lin
    .map((c) => {
      const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(0, c) ** (1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, '0');
    })
    .join('')}`;
}
/** Two hex colors mixed in OKLab, `f` of the way from `a` to `b` (as CSS color-mix does on the screen). */
export function mixHex(a: string, b: string, f: number): string {
  const x = linToOklab(hexToLin(a));
  const y = linToOklab(hexToLin(b));
  return oklabToHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * f) as [number, number, number]);
}
function scaleHex(s: FieldSummary, v: number): string {
  const { stops, p } = scaleStops(s, v);
  const i = Math.max(0, Math.min(stops.length - 1, Math.floor(p)));
  const f = p - i;
  return f < 0.001 || i === stops.length - 1 ? PALETTE[stops[i]] : mixHex(PALETTE[stops[i]], PALETTE[stops[i + 1]], f);
}
const categoryHex = (s: FieldSummary, b: Bin) => PALETTE[binCategoryKey(s, b)];
const binHex = (s: FieldSummary, b: Bin) => (s.kind === 'categories' ? categoryHex(s, b) : s.kind === 'scale' ? scaleHex(s, b.value ?? 0) : PALETTE['seq-2']);

/* ------------------------------------------------------------------ axes */

/**
 * Round ticks (1, 2, 2.5 or 5 times a power of ten) between `lo` and `hi`: the finest such step that gives at most
 * `max` of them (−1, 0, 1 on −1.6…1.3, not 0 alone). Always at least two: where the step that fits gives one, every
 * other tick of the finer step (0.25 and 0.75 on 0.1…0.9 with two at most).
 */
export function niceTicks(lo: number, hi: number, max = 5): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const mag0 = 10 ** Math.floor(Math.log10(span / max));
  let finer: number[] | null = null;
  for (const mag of [mag0, mag0 * 10, mag0 * 100])
    for (const m of [1, 2, 2.5, 5]) {
      const step = m * mag;
      const first = Math.ceil(lo / step - 1e-9);
      const last = Math.floor(hi / step + 1e-9);
      const n = last - first + 1;
      const ticks = Array.from({ length: Math.max(0, n) }, (_, i) => Math.round((first + i) * step * 1e6) / 1e6);
      if (n > max) {
        finer = ticks;
        continue;
      }
      if (n >= 2 || !finer) return ticks;
      const k = Math.ceil(finer.length / Math.max(2, max));
      const zero = finer.findIndex((t) => Math.abs(t) < 1e-9);
      const thin = finer.filter((_, i) => i % k === (zero >= 0 ? zero % k : 0));
      return thin.length >= 2 ? thin : [finer[0], finer[finer.length - 1]];
    }
  return [lo, hi];
}

/** A tick's label, with as many decimals as the tick has (17.5%, not 18%; 0.475, not 0.48); shares as percentages. */
export function tickLabel(t: number, share: boolean): string {
  const x = Math.round((share ? t * 100 : t) * 1e6) / 1e6;
  const s = String(x === 0 ? 0 : x);
  return `${s.startsWith('-') ? `−${s.slice(1)}` : s}${share ? '%' : ''}`;
}

/* ------------------------------------------------------------------ text */

/** Text width in pt: measured with the browser's Arial where there is a browser, else estimated (tests). */
let ctx: CanvasRenderingContext2D | null | undefined;
export function textWidth(text: string, size = SIZE): number {
  if (ctx === undefined) {
    try {
      ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    } catch {
      ctx = null;
    }
  }
  if (ctx) {
    ctx.font = `${size}px ${FONT}`;
    return ctx.measureText(text).width;
  }
  return text.length * size * 0.56;
}
/** The text, shortened with "…" to fit `max` pt. */
function fit(text: string, max: number, size = SIZE): string {
  if (textWidth(text, size) <= max) return text;
  let t = text;
  while (t.length > 1 && textWidth(`${t}…`, size) > max) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (n: number, total: number) => (!total ? '' : wholePercent(n, total));
/** An interval's bound as a percentage to one decimal. */
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;
const fmtN = (n: number) => n.toLocaleString('en-US');
/** A mean or bound as on the screen: 2 decimals, 1 from 100 up (a mean year 1886.5), halves away from 0, a real minus. */
function numText(x: number): string {
  const d = Math.abs(x) >= 100 ? 1 : 2;
  return (Math.sign(x) * (Math.round(Math.abs(x) * 10 ** d) / 10 ** d)).toFixed(d).replace(/^-(?=.*[1-9])/, '−').replace(/^-/, '');
}

/**
 * Words wrapped into at most `maxLines` lines of `maxW` pt; a word is never split. `shorten`: the last line ends with
 * "…" if the text goes on (names); otherwise the lines run on (numbers are never cut).
 */
function wrap(text: string, maxW: number, size: number, maxLines: number, shorten: boolean): string[] {
  if (textWidth(text, size) <= maxW) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (!cur || textWidth(next, size) <= maxW) {
      cur = next;
      continue;
    }
    lines.push(cur);
    if (lines.length === maxLines - 1) {
      cur = words.slice(i).join(' ');
      break;
    }
    cur = words[i];
  }
  lines.push(cur);
  return shorten ? lines.map((l) => fit(l, maxW, size)) : lines;
}

/** A small SVG writer in points. */
class Svg {
  parts: string[] = [];
  rect(x: number, y: number, w: number, h: number, fill: string, extra = '') {
    if (w <= 0 || h <= 0) return;
    // (A part thinner than the white gap between parts keeps a hairline, so one text in 300 doesn't vanish.)
    w = Math.max(w, 0.35);
    h = Math.max(h, 0.35);
    this.parts.push(`<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" fill="${fill}"${extra}/>`);
  }
  line(x1: number, y1: number, x2: number, y2: number, stroke: string, width = 0.5) {
    this.parts.push(`<line x1="${r2(x1)}" y1="${r2(y1)}" x2="${r2(x2)}" y2="${r2(y2)}" stroke="${stroke}" stroke-width="${width}"/>`);
  }
  /** A dot with a white ring (so it stands off a line behind it), or with `stroke`, a ring of that color (a hollow dot). */
  circle(cx: number, cy: number, r: number, fill: string, stroke = '#ffffff') {
    this.parts.push(`<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r)}" fill="${fill}" stroke="${stroke}" stroke-width="0.8"/>`);
  }
  text(x: number, y: number, t: string, opts: { size?: number; anchor?: 'start' | 'middle' | 'end'; fill?: string; weight?: number } = {}) {
    const a = opts.anchor && opts.anchor !== 'start' ? ` text-anchor="${opts.anchor}"` : '';
    const w = opts.weight ? ` font-weight="${opts.weight}"` : '';
    this.parts.push(`<text x="${r2(x)}" y="${r2(y)}" font-size="${opts.size ?? SIZE}"${a}${w} fill="${opts.fill ?? INK}">${esc(t)}</text>`);
  }
  done(width: number, height: number, widthMm: number, description: string): string {
    const h = Math.ceil(height);
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${r2(h / PT_PER_MM)}mm" viewBox="0 0 ${r2(width)} ${h}" font-family="${FONT}">`,
      `<desc>${esc(description)}</desc>`,
      `<rect x="0" y="0" width="${r2(width)}" height="${h}" fill="#ffffff"/>`,
      ...this.parts,
      '</svg>',
    ].join('\n');
  }
}

/* ------------------------------------------------------------------ legends */

type KeyItem = { color: string; label: string };

/** A row of swatches with names, wrapped at `maxW`, after an optional title (“−3 to 3:”); returns the height used. */
function legend(svg: Svg, x: number, y: number, maxW: number, items: KeyItem[], title?: string): number {
  let cx = x;
  let cy = y;
  if (title) {
    svg.text(cx, cy, title, { size: SMALL, fill: MUTED });
    cx += textWidth(title, SMALL) + 5;
  }
  for (const it of items) {
    const w = 7 + 3 + textWidth(it.label, SMALL) + 9;
    if (cx > x && cx + w > x + maxW) {
      cx = x;
      cy += 10;
    }
    svg.rect(cx, cy - 6, 6, 6, it.color);
    svg.text(cx + 9, cy, it.label, { size: SMALL, fill: MUTED });
    cx += w;
  }
  return cy - y + 10;
}
/** The width of a key on one line. */
const legendWidth = (items: KeyItem[], title?: string) => (title ? textWidth(title, SMALL) + 5 : 0) + items.reduce((t, it) => t + 7 + 3 + textWidth(it.label, SMALL) + 9, 0) - 9;

/**
 * The key to a categories field (as on the screen): its own categories (the first seven past eight), then one light
 * gray for other values (outside the codebook, or past eight) and the darker gray of “No majority (tie)”, each only if
 * some text has it, here or in any of `also` (the other groups of a split, so the key covers every bar).
 */
function categoryItems(s: FieldSummary, also: FieldSummary[] = []): KeyItem[] {
  const own = s.bins.filter((b) => !b.extra);
  const colored = own.length > CATEGORY_SLOTS ? own.slice(0, CATEGORY_SLOTS - 1) : own;
  const all = [s, ...also];
  const others = new Set([...own.slice(colored.length).map((b) => b.label), ...all.flatMap((x) => x.bins.filter((b) => b.extra && b.key !== TIE_KEY && b.n).map((b) => b.label))]);
  const ties = all.some((x) => x.bins.some((b) => b.key === TIE_KEY && b.n));
  return [
    ...colored.map((b) => ({ color: categoryHex(s, b), label: b.label })),
    ...(others.size ? [{ color: PALETTE.other, label: others.size === 1 ? [...others][0] : 'Other values' }] : []),
    ...(ties ? [{ color: PALETTE.tie, label: 'No majority (tie)' }] : []),
  ];
}
/** The key to a scale's colors: its whole points. */
function scaleItems(s: FieldSummary): KeyItem[] {
  return s.bins.filter((b) => !b.extra || Number.isInteger(b.value)).map((b) => ({ color: binHex(s, b), label: b.label }));
}
/** The share of yes (of 1s) in words: “share of yes 62.0%”. */
const shareWords = (y: NonNullable<FieldSummary['yes']>) => `share of ${y.word === '1' ? '1s' : 'yes'} ${yesPercent(y)}`;
/** A note under a figure when a share of yes (or of 1s) leaves out texts whose annotations had no majority. */
function tieNote(summaries: FieldSummary[], many: string): string {
  const tied = summaries.filter((s) => s.yes && s.yes.n < s.n);
  if (!tied.length) return '';
  const words = new Set(tied.map((s) => s.yes!.word));
  return `Shares of ${words.size > 1 ? 'yes and of 1s' : words.has('1') ? '1s' : 'yes'} leave out the ${many} whose annotations had no majority (ties).`;
}

/* ------------------------------------------------------------------ rows figure */

export interface FigureRow {
  name: string;
  s: FieldSummary;
  /** A period of a column of numbers (1950–1954: from 1950 to 1955), for the CSV. */
  from?: number;
  to?: number;
}

/**
 * The rows whose means go on the shared axis (the screen's and the figure's): groups of one field all; otherwise the
 * largest set of fields on the same scale (e.g. the −3…3 domains), so a Number field or a field on another scale
 * beside them doesn't take the axis away from all (their own figures are written out instead). Without means: the rows
 * with a share of yes (or of 1s).
 */
export function axisRows<T extends { s: FieldSummary }>(rows: T[], oneField: boolean): T[] {
  const means = rows.filter((r) => r.s.mean !== null);
  if (!means.length) return rows.filter((r) => r.s.yes);
  if (oneField) return means;
  const byScale = new Map<string, T[]>();
  for (const r of means) {
    if (!r.s.range) continue;
    const k = JSON.stringify(r.s.range);
    byScale.set(k, [...(byScale.get(k) ?? []), r]);
  }
  return [...byScale.values()].sort((a, b) => b.length - a.length)[0] ?? [];
}

/** A row's mean or share of yes written out, for a row whose figure isn't on the axis: the figure, and its interval. */
function valueText(s: FieldSummary): string[] | null {
  if (s.yes) return [shareWords(s.yes), ...(s.yes.ci ? [`(95% CI ${pct1(s.yes.ci[0])} to ${pct1(s.yes.ci[1])})`] : [])];
  if (s.mean !== null) return [`mean ${numText(s.mean)}`, ...(s.ci ? [`(95% CI ${numText(s.ci[0])} to ${numText(s.ci[1])})`] : [])];
  return null;
}

/**
 * Rows of distributions (every field of a run, or one field by group), as on the screen: the name, the distribution
 * as one bar (around 0 for scales with values on both sides, with the shares below and above 0; a Number field's
 * range in words), the mean with its 95% interval on a shared axis (or the share of yes / of 1s; written out for rows
 * on another scale), and n. Keys below. `oneField`: the rows are groups of one field (one key for all).
 */
export function rowsFigure(rows: FigureRow[], opts: { widthMm: number; oneField: boolean; description: string; manyWord?: string }): string {
  const many = opts.manyWord ?? 'texts';
  const W = opts.widthMm * PT_PER_MM;
  const svg = new Svg();
  const narrow = opts.widthMm < 120;
  const barH = 8;
  const gap = narrow ? 5 : 8;
  // Columns: name | below % | bar | above % | interval | n
  const nW = Math.max(textWidth('n', SMALL), ...rows.map((r) => textWidth(fmtN(r.s.n), SMALL))) + 2;
  const div = rows.filter((r) => r.s.diverging && r.s.sides && r.s.n);
  const sideW = div.length ? textWidth('100%', SMALL) + 2 : 0;
  const use = axisRows(rows, opts.oneField);
  const onAxis = new Set(use);
  // (Rows not on the axis, e.g. a share of yes beside means or a Number field beside −3…3 domains: written out.)
  const texts = rows.map((r) => (onAxis.has(r) ? null : valueText(r.s)));
  const stripW = use.length || texts.some(Boolean) ? Math.max(narrow ? 48 : 58, W * (narrow ? 0.2 : 0.22)) : 0;
  const axis = figureAxis(use, stripW);
  const nameW = Math.min(Math.max(...rows.map((r) => textWidth(r.name))) + 2, W * (narrow ? 0.3 : 0.26));
  const barX = nameW + gap + sideW + (sideW ? 3 : 0);
  const barW = W - barX - (sideW ? sideW + 3 : 0) - gap - (stripW ? stripW + gap : 0) - nW;
  const stripX = barX + barW + (sideW ? sideW + 3 : 0) + gap;
  const nX = W;
  // (A Number field's range is written across the bar and its side columns.)
  const wideX = nameW + gap;
  const wideW = barX + barW + (sideW ? sideW + 3 : 0) - wideX;
  const leftMax = Math.max(0, ...div.map((r) => (r.s.sides!.below + r.s.sides!.middle / 2) / r.s.n));
  const rightMax = Math.max(0, ...div.map((r) => (r.s.sides!.above + r.s.sides!.middle / 2) / r.s.n));
  const span = leftMax + rightMax || 1;
  const center = barX + (leftMax / span) * barW;
  // Each row's lines: a long name on two (shortened if need be), values written out on up to four (never cut); the row grows.
  const NAME_LH = 9.5;
  const SMALL_LH = 8.2;
  const layout = rows.map((r, i) => {
    const name = wrap(r.name, nameW, SIZE, 2, true);
    // (On one line where it fits, else the figure and its interval each wrapped.)
    const t = texts[i];
    const value = !t ? [] : textWidth(t.join(' '), SMALL) <= stripW ? [t.join(' ')] : t.flatMap((part) => wrap(part, stripW, SMALL, 2, false));
    const range = r.s.n && r.s.kind === 'number' && r.s.min !== null && r.s.max !== null ? wrap(`numbers from ${scaleLabel(r.s.min)} to ${scaleLabel(r.s.max)}`, wideW, SMALL, 2, false) : [];
    const h = Math.max(14, name.length * NAME_LH + 4.5, Math.max(value.length, range.length) * SMALL_LH + 5.8);
    return { name, value, range, h };
  });
  /** Lines centered on `mid`. */
  const lines = (x: number, mid: number, ls: string[], lh: number, opts2: { size: number; fill: string; anchor?: 'start' | 'end' }) =>
    ls.forEach((l, k) => svg.text(x, mid + (opts2.size === SIZE ? 2.8 : 2.5) + (k - (ls.length - 1) / 2) * lh, l, opts2));

  // Header: what the bar shows, and n.
  let y = 9;
  // (The longer heading where it fits over the bars.)
  const heading = div.length && textWidth(`Share of ${many} below 0, at 0 and above 0`, SMALL) <= barW + sideW ? `Share of ${many} below 0, at 0 and above 0` : `Share of ${many}`;
  svg.text(barX, y, heading, { size: SMALL, fill: MUTED });
  svg.text(nX, y, 'n', { size: SMALL, fill: MUTED, anchor: 'end' });
  y += 5;
  const top = y;
  const ys: number[] = [];
  rows.forEach((r, i) => {
    const { h } = layout[i];
    const mid = y + h / 2;
    ys.push(mid);
    lines(0, mid, layout[i].name, NAME_LH, { size: SIZE, fill: INK });
    const s = r.s;
    // A part of the bar with a white gap on each side, or, if thinner than the gap, a hairline without one.
    const part = (x0: number, w: number, fill: string) => svg.rect(w > GAP * 2 ? x0 + GAP / 2 : x0, mid - barH / 2, w > GAP * 2 ? w - GAP : w, barH, fill);
    if (s.n && s.diverging && s.sides) {
      svg.text(barX - 3, mid + 2.5, pct(s.sides.below, s.n), { size: SMALL, fill: MUTED, anchor: 'end' });
      svg.text(barX + barW + 3, mid + 2.5, pct(s.sides.above, s.n), { size: SMALL, fill: MUTED });
      const midBin = s.bins.find((b) => b.value === 0);
      const half = midBin ? midBin.n / s.n / 2 : 0;
      const at = (share: number) => (share / span) * barW;
      // The shared center (0) of the bars, through this row.
      svg.line(center, mid - barH / 2 - 2.5, center, mid + barH / 2 + 2.5, AXIS, 0.6);
      if (midBin && midBin.n) part(center - at(half), at(half * 2), PALETTE.mid);
      let left = center - at(half);
      for (const b of s.bins.filter((x) => (x.value ?? 0) < 0).reverse()) {
        const w = at(b.n / s.n);
        if (b.n) part(left - w, w, binHex(s, b));
        left -= w;
      }
      let right = center + at(half);
      for (const b of s.bins.filter((x) => (x.value ?? 0) > 0)) {
        const w = at(b.n / s.n);
        if (b.n) part(right, w, binHex(s, b));
        right += w;
      }
    } else if (s.n && s.kind !== 'number') {
      let x = barX;
      for (const b of s.bins.filter((x) => x.n)) {
        const w = (b.n / s.n) * barW;
        part(x, w, binHex(s, b));
        x += w;
      }
    } else if (s.n) lines(wideX, mid, layout[i].range, SMALL_LH, { size: SMALL, fill: MUTED });
    else svg.text(barX, mid + 2.5, 'no values', { size: SMALL, fill: MUTED });
    svg.text(nX, mid + 2.5, fmtN(s.n), { size: SMALL, fill: INK, anchor: 'end' });
    y += h;
    // A categories field's key under its bar (all fields), or once below (groups of one field). (At one column's
    // width, from the left edge, as wide as the bars and names together, so it doesn't run down in a narrow column.)
    if (!opts.oneField && s.kind === 'categories' && s.n) y += legend(svg, narrow ? 0 : barX, y + 5, narrow ? stripX - gap : barW + (sideW ? sideW + 3 : 0), categoryItems(s)) + 1;
  });
  const bottom = y;
  // The intervals: gridlines at the ticks, 0 darker, each row's mean (or share) with its interval, ticks below.
  if (axis) {
    const at = (x: number) => stripX + axis.at(x) * stripW;
    for (const t of axis.ticks) svg.line(at(t), top, at(t), bottom, t === 0 && !axis.share ? AXIS : GRID, t === 0 && !axis.share ? 0.6 : 0.4);
    rows.forEach((r, i) => {
      if (!onAxis.has(r)) return;
      const m = axis.share ? r.s.yes?.share : r.s.mean;
      if (m === undefined || m === null) return;
      const ci = axis.share ? r.s.yes?.ci : r.s.ci;
      if (ci) svg.line(at(ci[0]), ys[i], at(ci[1]), ys[i], INK, 0.9);
      svg.circle(at(m), ys[i], 2.4, INK);
    });
    svg.line(stripX, bottom, stripX + stripW, bottom, AXIS, 0.5);
    for (const t of axis.ticks) svg.text(at(t), bottom + 8, axis.label(t), { size: SMALL, fill: MUTED, anchor: 'middle' });
    // (The title centered under the axis, kept within the figure when it is wider than the axis.)
    const tw = textWidth(axis.title, SMALL);
    svg.text(Math.min(W - tw / 2, Math.max(barX + tw / 2, stripX + stripW / 2)), bottom + 17, axis.title, { size: SMALL, fill: MUTED, anchor: 'middle' });
  }
  // Figures written out (rows not on the axis), over the gridlines on a white ground.
  rows.forEach((_, i) => {
    const ls = layout[i].value;
    if (!ls.length) return;
    const w = Math.max(...ls.map((l) => textWidth(l, SMALL)));
    svg.rect(stripX - 1.5, ys[i] - (ls.length * SMALL_LH) / 2 - 1, w + 3, ls.length * SMALL_LH + 2, '#ffffff');
    lines(stripX, ys[i], ls, SMALL_LH, { size: SMALL, fill: INK });
  });
  y = bottom + (axis ? 22 : 6);
  // (A key at the bars where it fits on one line, else from the left edge.)
  const keyAt = (items: KeyItem[], title?: string) => (legendWidth(items, title) <= W - barX ? { x: barX, w: W - barX } : { x: 0, w: W });
  // Keys: the scale's colors, one per scale (named when the rows have more than one), and the categories of a split field.
  const byRange = new Map<string, FieldSummary[]>();
  for (const r of rows) if (r.s.kind === 'scale' && r.s.n) byRange.set(JSON.stringify(r.s.range), [...(byRange.get(JSON.stringify(r.s.range)) ?? []), r.s]);
  for (const list of byRange.values()) {
    // (Every row's points: the key from the row with the most of them.)
    const widest = list.reduce((a, b) => (scaleItems(b).length > scaleItems(a).length ? b : a));
    const title = byRange.size > 1 && widest.range ? `${scaleLabel(widest.range[0])} to ${scaleLabel(widest.range[1])}:` : undefined;
    const at = keyAt(scaleItems(widest), title);
    y += legend(svg, at.x, y + 6, at.w, scaleItems(widest), title);
  }
  if (opts.oneField) {
    const cat = rows.find((r) => r.s.kind === 'categories' && r.s.n);
    if (cat) {
      const items = categoryItems(cat.s, rows.map((r) => r.s));
      const at = keyAt(items);
      y += legend(svg, at.x, y + 6, at.w, items);
    }
  }
  const note = tieNote(rows.map((r) => r.s), many);
  if (note) {
    for (const l of wrap(note, W, SMALL, 3, false)) {
      svg.text(0, y + 8, l, { size: SMALL, fill: MUTED });
      y += SMALL_LH;
    }
    y += 2;
  }
  return svg.done(W, y + 2, opts.widthMm, opts.description);
}

interface FigureAxis {
  ticks: number[];
  at: (x: number) => number; // 0…1 across the strip
  label: (x: number) => string;
  share: boolean;
  title: string;
}
/**
 * As on the screen (`meanAxis` in RunSummary.tsx): the means (else the shares) of the rows on the axis (`axisRows`),
 * 0 included on scales around 0, with as many round ticks as fit the strip.
 */
function figureAxis(use: FigureRow[], stripW: number): FigureAxis | null {
  if (!use.length) return null;
  const share = use[0].s.mean === null;
  const xs = use.flatMap((r) => (share ? [r.s.yes!.share, ...(r.s.yes!.ci ?? [])] : [r.s.mean!, ...(r.s.ci ?? [])]));
  if (use.some((r) => r.s.diverging)) xs.push(0);
  let lo = Math.min(...xs);
  let hi = Math.max(...xs);
  if (hi - lo < 1e-9) (lo -= share ? 0.05 : 0.5), (hi += share ? 0.05 : 0.5);
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  if (share) (lo = Math.max(0, lo)), (hi = Math.min(1, hi));
  // (As many round ticks as fit with their labels apart: −0.5, 0, 0.5 in one column's width.)
  let ticks: number[] = [];
  for (let max = 6; max >= 2; max--) {
    ticks = niceTicks(lo, hi, max);
    const widest = Math.max(...ticks.map((t) => textWidth(tickLabel(t, share), SMALL)));
    const apart = ticks.length > 1 ? ((ticks[1] - ticks[0]) / (hi - lo)) * stripW : Infinity;
    if (apart >= widest + 5) break;
  }
  const words = new Set(use.map((r) => r.s.yes?.word).filter(Boolean));
  const title = share ? `Share of ${words.size > 1 ? 'yes or 1s' : words.has('1') ? '1s' : 'yes'} (95% CI)` : 'Mean (95% CI)';
  return { ticks, at: (x) => (x - lo) / (hi - lo), label: (x) => tickLabel(x, share), share, title };
}

/* ------------------------------------------------------------------ over time */

/** One period (or value) of a split by a column of numbers, in order. */
export interface TimeGroup {
  /** The axis label (a period's first value, e.g. 1950) and the full name (1950–1954). */
  tick: string;
  name: string;
  s: FieldSummary;
}

/** Periods with fewer texts than this are marked (*, hollow dots): one text moves their shares by 10 points or more. */
export const FEW = 10;

/**
 * The shares in each period as stacked columns: on a scale around 0, values below 0 stack down from the baseline and
 * values above 0 up, with 0 straddling it; otherwise columns of 100% (the scale's low values or the first category at
 * the bottom). Their geometry, in shares: shared by the screen and the downloaded figure.
 */
export function timeStacks(groups: TimeGroup[]): { diverging: boolean; lo: number; hi: number; ticks: number[]; parts: { b: Bin; from: number; to: number }[][] } {
  const diverging = groups.some((g) => g.s.diverging && g.s.n);
  const parts = groups.map(({ s }) => {
    const out: { b: Bin; from: number; to: number }[] = [];
    if (!s.n || s.kind === 'number') return out;
    if (diverging && s.diverging) {
      const mid = s.bins.find((b) => b.value === 0);
      const half = mid ? mid.n / s.n / 2 : 0;
      if (mid && mid.n) out.push({ b: mid, from: -half, to: half });
      let down = -half;
      for (const b of s.bins.filter((x) => (x.value ?? 0) < 0).reverse()) {
        const h = b.n / s.n;
        if (b.n) out.push({ b, from: down - h, to: down });
        down -= h;
      }
      let up = half;
      for (const b of s.bins.filter((x) => (x.value ?? 0) > 0)) {
        const h = b.n / s.n;
        if (b.n) out.push({ b, from: up, to: up + h });
        up += h;
      }
    } else {
      let at = 0;
      for (const b of s.bins.filter((x) => x.n)) {
        const h = b.n / s.n;
        out.push({ b, from: at, to: at + h });
        at += h;
      }
    }
    return out;
  });
  if (!diverging) return { diverging, lo: 0, hi: 1, ticks: [0, 0.25, 0.5, 0.75, 1], parts };
  const down = Math.max(0.05, ...parts.flat().map((p) => -p.from));
  const up = Math.max(0.05, ...parts.flat().map((p) => p.to));
  const step = Math.max(down, up) > 0.5 ? 0.2 : 0.1;
  const lo = -Math.ceil(down / step - 1e-9) * step;
  const hi = Math.ceil(up / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + 1e-9; t += step) ticks.push(Math.round(t * 100) / 100);
  return { diverging, lo, hi, ticks, parts };
}

/**
 * The means (or shares of yes, of 1s) of the periods with their 95% intervals: the axis from the lowest to the highest
 * bound, a little wider, taking in 0 on a scale around 0, with round ticks. Null when no period has one.
 */
export function timeMeans(groups: TimeGroup[]): { share: boolean; lo: number; hi: number; ticks: number[]; points: ({ m: number; ci: [number, number] | null } | null)[] } | null {
  const share = !groups.some((g) => g.s.mean !== null) && groups.some((g) => g.s.yes);
  const points = groups.map(({ s }) => {
    const m = share ? s.yes?.share : s.mean;
    return m === undefined || m === null ? null : { m, ci: (share ? s.yes?.ci : s.ci) ?? null };
  });
  const xs = points.flatMap((p) => (p ? [p.m, ...(p.ci ?? [])] : []));
  if (!xs.length) return null;
  if (!share && groups.some((g) => g.s.diverging)) xs.push(0);
  let lo = Math.min(...xs);
  let hi = Math.max(...xs);
  if (hi - lo < 1e-9) (lo -= share ? 0.05 : 0.5), (hi += share ? 0.05 : 0.5);
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  if (share) (lo = Math.max(0, lo)), (hi = Math.min(1, hi));
  return { share, lo, hi, ticks: niceTicks(lo, hi, 5), points };
}

/**
 * A split by a column of numbers (years) as a figure: stacked columns of the shares per period (`timeStacks`) above,
 * the means with their intervals below on their own axis (`timeMeans`; two panels, never two scales on one axis),
 * the periods along the bottom, a key, and a note on small periods (* over the column, hollow dots).
 */
export function timeFigure(groups: TimeGroup[], opts: { widthMm: number; description: string; column: string; manyWord?: string }): string {
  const W = opts.widthMm * PT_PER_MM;
  const svg = new Svg();
  const many = opts.manyWord ?? 'texts';
  const stacks = timeStacks(groups);
  const means = timeMeans(groups);
  const hasStacks = stacks.parts.some((p) => p.length);
  const few = (i: number) => groups[i].s.n > 0 && groups[i].s.n < FEW;
  const yAxisW = 26;
  const plotX = yAxisW;
  const plotW = W - plotX - 4;
  const N = groups.length;
  const cx = (i: number) => plotX + ((i + 0.5) / N) * plotW;
  const colW = Math.min(16, (plotW / N) * 0.68);
  let y = 4;
  if (hasStacks) {
    const top = y + 17; // (room for an asterisk over the tallest column)
    const H = Math.max(110, Math.min(190, W * 0.36));
    const yy = (v: number) => top + ((stacks.hi - v) / (stacks.hi - stacks.lo)) * H;
    svg.text(plotX, y + 5, stacks.diverging ? `Share of ${many}: below 0 down, above 0 up` : `Share of ${many}`, { size: SMALL, fill: MUTED });
    for (const t of stacks.ticks) {
      svg.line(plotX, yy(t), plotX + plotW, yy(t), t === 0 && stacks.diverging ? AXIS : GRID, t === 0 && stacks.diverging ? 0.6 : 0.4);
      svg.text(plotX - 3, yy(t) + 2.5, tickLabel(Math.abs(t), true), { size: SMALL, fill: MUTED, anchor: 'end' });
    }
    stacks.parts.forEach((parts, i) => {
      for (const p of parts) {
        const y1 = yy(p.to);
        const y2 = yy(p.from);
        const h = y2 - y1;
        if (h > 0) svg.rect(cx(i) - colW / 2, y1 + (h > GAP * 2 ? GAP / 2 : 0), colW, h > GAP * 2 ? h - GAP : h, binHex(groups[i].s, p.b));
      }
      // (Fewer than 10 texts: an asterisk over the column.)
      if (few(i) && parts.length) svg.text(cx(i), yy(Math.max(...parts.map((p) => p.to))) - 2, '*', { size: SIZE, fill: INK, anchor: 'middle' });
    });
    y = top + H + 4;
  }
  if (means) {
    const top = y + 12;
    const H = Math.max(50, Math.min(80, W * 0.15));
    const yy = (v: number) => top + ((means.hi - v) / (means.hi - means.lo)) * H;
    svg.text(plotX, y + 7, means.share ? (groups.some((g) => g.s.yes?.word === '1') ? 'Share of 1s (95% CI)' : 'Share of yes (95% CI)') : 'Mean (95% CI)', { size: SMALL, fill: MUTED });
    for (const t of means.ticks) {
      const zero = t === 0 && !means.share;
      svg.line(plotX, yy(t), plotX + plotW, yy(t), zero ? AXIS : GRID, zero ? 0.6 : 0.4);
      svg.text(plotX - 3, yy(t) + 2.5, tickLabel(t, means.share), { size: SMALL, fill: MUTED, anchor: 'end' });
    }
    // A thin line through the means, in order (periods without one break it), then the intervals and the dots.
    let d = '';
    let open = false;
    means.points.forEach((p, i) => {
      if (!p) return void (open = false);
      d += `${open ? ' L' : ' M'}${r2(cx(i))} ${r2(yy(p.m))}`;
      open = true;
    });
    if (d) svg.parts.push(`<path d="${d.trim()}" fill="none" stroke="${MUTED}" stroke-width="0.6"/>`);
    means.points.forEach((p, i) => {
      if (!p) return;
      if (p.ci) svg.line(cx(i), yy(p.ci[1]), cx(i), yy(p.ci[0]), INK, 0.9);
      // (Fewer than 10 texts: a hollow dot.)
      if (few(i)) svg.circle(cx(i), yy(p.m), 2, '#ffffff', INK);
      else svg.circle(cx(i), yy(p.m), 2.2, INK);
    });
    y = top + H + 4;
  }
  // The periods: every k-th label so they don't run into each other.
  const widest = Math.max(...groups.map((g) => textWidth(g.tick, SMALL))) + 4;
  const every = Math.max(1, Math.ceil(widest / (plotW / N)));
  svg.line(plotX, y, plotX + plotW, y, AXIS, 0.5);
  groups.forEach((g, i) => {
    if (i % every) return;
    svg.line(cx(i), y, cx(i), y + 2, AXIS, 0.5);
    svg.text(cx(i), y + 9, g.tick, { size: SMALL, fill: MUTED, anchor: 'middle' });
  });
  y += 11;
  for (const l of wrap(opts.column, plotW, SIZE, 2, false)) {
    svg.text(plotX + plotW / 2, y + 8, l, { size: SIZE, fill: INK, anchor: 'middle' });
    y += 9.5;
  }
  y += 3;
  // Key: the scale's points, or the categories.
  const keyFrom = groups.filter((g) => g.s.n && g.s.kind !== 'number').reduce<FieldSummary | null>((a, g) => (!a || g.s.bins.filter((b) => b.n).length > a.bins.filter((b) => b.n).length ? g.s : a), null);
  if (hasStacks && keyFrom) {
    const widestScale = groups.filter((g) => g.s.kind === 'scale' && g.s.n).reduce<FieldSummary | null>((a, g) => (!a || scaleItems(g.s).length > scaleItems(a).length ? g.s : a), null);
    y += legend(svg, plotX, y + 6, plotW, keyFrom.kind === 'categories' ? categoryItems(keyFrom, groups.map((g) => g.s)) : scaleItems(widestScale ?? keyFrom));
  }
  // Notes: small periods, and shares of yes without the ties.
  const notes = [
    groups.some((_, i) => few(i)) ? `${hasStacks && means ? '* and hollow dots' : hasStacks ? '*' : 'Hollow dots'}: fewer than ${FEW} ${many}, so one moves the shares by 10 points or more.` : '',
    tieNote(groups.map((g) => g.s), many),
  ].filter(Boolean);
  for (const note of notes)
    for (const l of wrap(note, W - plotX, SMALL, 3, false)) {
      svg.text(plotX, y + 8, l, { size: SMALL, fill: MUTED });
      y += 8.2;
    }
  return svg.done(W, y + 4, opts.widthMm, opts.description);
}

/* ------------------------------------------------------------------ one field */

/**
 * One field's distribution: columns on its scale (half points between the points, shares on top; past 13 columns a
 * percentage axis instead), the mean marked under the axis, the field's name below; or a histogram for numbers;
 * categories as horizontal bars with counts.
 */
export function fieldFigure(s: FieldSummary, opts: { widthMm: number; description: string; manyWord?: string }): string {
  const W = opts.widthMm * PT_PER_MM;
  const svg = new Svg();
  const many = opts.manyWord ?? 'texts';
  if (s.kind === 'categories') {
    const rowH = 13;
    const nameW = Math.min(Math.max(...s.bins.map((b) => textWidth(b.label))) + 4, W * 0.36);
    const countW = Math.max(...s.bins.map((b) => textWidth(`${fmtN(b.n)} (${pct(b.n, s.n)})`, SMALL))) + 6;
    const barX = nameW + 4;
    const barW = W - barX - countW;
    const max = Math.max(1, ...s.bins.map((b) => b.n));
    let y = 4;
    for (const b of s.bins) {
      const mid = y + rowH / 2;
      svg.text(0, mid + 2.8, fit(b.label, nameW - 2), { fill: b.extra ? MUTED : INK });
      svg.rect(barX, mid - 4, (b.n / max) * barW, 8, categoryHex(s, b));
      svg.text(W, mid + 2.5, `${fmtN(b.n)} (${pct(b.n, s.n)})`, { size: SMALL, fill: MUTED, anchor: 'end' });
      y += rowH;
    }
    svg.line(barX, 4, barX, y, AXIS, 0.5);
    y += 10;
    const notes = [`${s.label}: ${many} (share of the ${fmtN(s.n)} with a value)`, s.yes ? `${shareWords(s.yes)}${s.yes.n < s.n ? ` of the ${fmtN(s.yes.n)} with yes or no` : ''}${s.yes.ci ? ` (95% CI ${pct1(s.yes.ci[0])} to ${pct1(s.yes.ci[1])})` : ''}` : ''];
    for (const note of notes.filter(Boolean))
      for (const l of wrap(note, W - barX, SMALL, 3, false)) {
        svg.text(barX, y, l, { size: SMALL, fill: MUTED });
        y += 8.2;
      }
    return svg.done(W, y + 2, opts.widthMm, opts.description);
  }

  const labels = s.bins.length <= 13;
  // (With a percentage axis, its title above it.)
  const plotTop = labels ? 6 : 16;
  const plotH = Math.max(100, Math.min(190, W * 0.34));
  const plotBottom = plotTop + plotH;
  // (Past 13 columns the shares don't fit on top: a percentage axis on the left instead.)
  const left = labels ? 4 : 28;
  const vals = s.bins.map((b) => b.value ?? 0);
  const ends = s.kind === 'scale' && s.range ? s.range : null;
  const lo0 = Math.min(...vals, ...(ends ? [ends[0]] : []));
  const hi0 = Math.max(...vals, ...(ends ? [ends[1]] : []));
  const sorted = [...new Set(vals)].sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < sorted.length; i++) step = Math.min(step, sorted[i] - sorted[i - 1]);
  if (!Number.isFinite(step) || step <= 0) step = 1;
  const lo = lo0 - step / 2;
  const hi = hi0 + step / 2;
  const x = (v: number) => left + ((v - lo) / (hi - lo)) * (W - left - 4);
  const slot = (step / (hi - lo)) * (W - left - 4);
  const histogram = s.bins[0]?.from !== undefined;
  const barW = histogram ? slot - GAP : Math.min(18, slot * 0.7);
  const max = Math.max(1, ...s.bins.map((b) => b.n));
  // Heights: the tallest column reaches 88% of the plot (room for its share on top).
  const yOf = (share: number) => plotBottom - (share / (max / Math.max(1, s.n))) * plotH * 0.88;
  if (!labels && s.n) {
    svg.text(left - 3, 8, `Share of ${many}`, { size: SMALL, fill: MUTED });
    const topShare = max / s.n / 0.88;
    for (const t of niceTicks(0, topShare, 5)) {
      svg.line(left, yOf(t), W - 4, yOf(t), t === 0 ? AXIS : GRID, 0.4);
      svg.text(left - 3, yOf(t) + 2.5, tickLabel(t, true), { size: SMALL, fill: MUTED, anchor: 'end' });
    }
  }
  for (const b of s.bins) {
    const h = (b.n / max) * plotH * 0.88;
    svg.rect(x(b.value ?? 0) - barW / 2, plotBottom - h, barW, h, binHex(s, b));
    if (labels && b.n) svg.text(x(b.value ?? 0), plotBottom - h - 2.5, pct(b.n, s.n), { size: SMALL, fill: MUTED, anchor: 'middle' });
  }
  svg.line(left, plotBottom, W - 4, plotBottom, AXIS, 0.6);
  // Ticks: a scale's own points (not the half points between them); a histogram's edges (every other past 6 bins,
  // always including the last, so they stay evenly spaced).
  const ticks: { v: number; label: string }[] = histogram
    ? [...s.bins.map((b) => ({ v: b.from!, label: b.fromLabel! })), { v: s.bins[s.bins.length - 1].to!, label: s.bins[s.bins.length - 1].toLabel! }].filter(
        (_, i, all) => all.length <= 7 || i % 2 === (all.length - 1) % 2,
      )
    : s.bins.filter((b) => !(s.kind === 'scale' && b.extra && !Number.isInteger(b.value))).map((b) => ({ v: b.value ?? 0, label: b.label }));
  for (const t of ticks) {
    svg.line(x(t.v), plotBottom, x(t.v), plotBottom + 2.5, AXIS, 0.5);
    // (A label at either end kept inside the figure.)
    const tw = textWidth(t.label, SMALL);
    svg.text(Math.min(W - tw / 2, Math.max(tw / 2, x(t.v))), plotBottom + 10, t.label, { size: SMALL, fill: MUTED, anchor: 'middle' });
  }
  let y = plotBottom + 12;
  // The mean (not for 0/1 scales, whose share of 1s is the figure): a marker under the axis, as on the screen (a line
  // through the plot would cross the shares on top of the columns).
  if (s.mean !== null) {
    const mx = x(s.mean);
    svg.parts.push(`<path d="M${r2(mx)} ${r2(y)} L${r2(mx - 2.6)} ${r2(y + 4)} L${r2(mx + 2.6)} ${r2(y + 4)} Z" fill="${INK}"/>`);
    const label = `mean ${numText(s.mean)}`;
    const right = mx + 4 + textWidth(label, SMALL) <= W;
    svg.text(right ? mx + 4 : mx - 4, y + 5.5, label, { size: SMALL, fill: INK, anchor: right ? 'start' : 'end' });
    y += 9;
  } else if (s.yes) {
    const note = `${shareWords(s.yes)}${s.yes.n < s.n ? ` of the ${fmtN(s.yes.n)} that are 0 or 1` : ''}${s.yes.ci ? ` (95% CI ${pct1(s.yes.ci[0])} to ${pct1(s.yes.ci[1])})` : ''}`;
    for (const l of wrap(note, W - 8, SMALL, 2, false)) {
      svg.text(W / 2, y + 5.5, l, { size: SMALL, fill: INK, anchor: 'middle' });
      y += 8.2;
    }
    y += 1;
  }
  for (const l of wrap(s.label, W - 8, SIZE, 2, true)) {
    svg.text(W / 2, y + 9, l, { size: SIZE, fill: INK, anchor: 'middle' });
    y += 9.5;
  }
  return svg.done(W, y + 4, opts.widthMm, opts.description);
}

/* ------------------------------------------------------------------ PNG */

/**
 * The SVG as a PNG at `dpi` for its width (600 dpi: about 4,100 pixels for 175 mm), with the resolution written into
 * the file (pHYs), so Word and journals' systems read it at the right size. Browser only.
 */
export async function svgToPng(svgText: string, widthMm: number, dpi = PNG_DPI): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('the figure could not be drawn as an image'));
      img.src = url;
    });
    const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svgText);
    const [w, h] = vb ? [Number(vb[1]), Number(vb[2])] : [widthMm * PT_PER_MM, widthMm * PT_PER_MM * 0.5];
    const scale = dpi / 72;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const c = canvas.getContext('2d');
    if (!c) throw new Error('this browser can’t draw images');
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the image could not be saved'))), 'image/png'));
    return new Blob([withDpi(new Uint8Array(await blob.arrayBuffer()), dpi)], { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A PNG with its resolution (pHYs chunk, pixels per meter) set to `dpi`, right after the header chunk; an existing pHYs is replaced. */
export function withDpi(png: Uint8Array, dpi: number): Uint8Array<ArrayBuffer> {
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const v = new DataView(chunk.buffer);
  v.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  v.setUint32(8, ppm);
  v.setUint32(12, ppm);
  chunk[16] = 1; // unit: meter
  v.setUint32(17, crc32(chunk.subarray(4, 17)));
  // Leave out any pHYs already there; put the new one after IHDR (8-byte signature + 25-byte IHDR chunk).
  const parts: Uint8Array[] = [png.subarray(0, 33), chunk];
  let at = 33;
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  while (at + 8 <= png.length) {
    const len = dv.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const end = at + 12 + len;
    if (type !== 'pHYs') parts.push(png.subarray(at, end));
    at = end;
  }
  const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/* ------------------------------------------------------------------ CSV */

/** A figure to `d` decimals, halves away from 0 on both sides (−0.34375 → −0.3438, as 0.34375 → 0.3438). */
const num = (x: number | null | undefined, d = 4) => {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const r = Math.sign(x) * (Math.round(Math.abs(x) * 10 ** d) / 10 ** d);
  return r === 0 ? 0 : r;
};
/** A bin as a CSV column name: n_-3, n_0.5, n_Historical, n_no_majority; histogram bins n_1965-1970. */
function binColumn(s: FieldSummary, b: Bin): string {
  if (b.from !== undefined) return `n_${b.from}-${b.to}`;
  if (s.kind !== 'categories') return `n_${b.value}`;
  if (b.key === TIE_KEY) return 'n_no_majority';
  // (A category named like one of the tables' own columns keeps apart from it.)
  const c = `n_${b.label}`;
  return ['n_without_value', 'n_left_out', 'n_no_majority'].includes(c) ? `n_category_${b.label}` : c;
}

/** The tables' own columns, in order (the group column of a split goes after `field`). */
const FRONT = [
  'study',
  'run',
  'model',
  'prompt_version',
  'subset',
  'field',
  'period_start',
  'period_end_exclusive',
  'value',
  'n',
  'share',
  'not_a_scale_point',
  'n_without_value',
  'n_left_out',
  'scale_min',
  'scale_max',
  'mean',
  'ci95_low',
  'ci95_high',
  'sd',
  'median',
  'min',
  'max',
  'share_below_0',
  'share_at_0',
  'share_above_0',
  'share_yes',
  'share_1',
  'share_n',
  'share_ci95_low',
  'share_ci95_high',
  'field_n',
  'field_mean',
  'field_ci95_low',
  'field_ci95_high',
  'field_share_yes',
  'field_share_1',
  'field_share_n',
  'field_share_ci95_low',
  'field_share_ci95_high',
];

interface CsvMeta {
  study?: string;
  run: string;
  model: string;
  promptVersion?: number | string;
  appVersion: string;
  subset?: string;
}
function csvHead(meta: CsvMeta): Row {
  return {
    ...(meta.study !== undefined ? { study: meta.study } : {}),
    run: meta.run,
    model: meta.model,
    ...(meta.promptVersion !== undefined ? { prompt_version: meta.promptVersion } : {}),
    ...(meta.subset ? { subset: meta.subset } : {}),
  };
}
/** The share of yes (of 1s) as columns: the share, its denominator (texts with yes or no; ties left out) and interval. */
function shareColumns(s: FieldSummary, prefix = ''): Row {
  if (!s.yes) return {};
  return {
    [`${prefix}${s.yes.word === '1' ? 'share_1' : 'share_yes'}`]: num(s.yes.share),
    [`${prefix}share_n`]: s.yes.n,
    [`${prefix}share_ci95_low`]: s.yes.ci ? num(s.yes.ci[0]) : null,
    [`${prefix}share_ci95_high`]: s.yes.ci ? num(s.yes.ci[1]) : null,
  };
}

/**
 * The numbers behind a rows figure (every field, or one field by group): one row per row, with n, the scale's ends,
 * mean, 95% CI, SD, median, range, the shares below/at/above 0, the share of yes (or 1s) with its denominator and
 * interval, and the texts at each value: 0 where the row could have had the value (a point or a value between the
 * ends of its scale; in a split, any value of the field), blank where it couldn't (another field's categories).
 */
export function summaryCsvRows(rows: FigureRow[], meta: CsvMeta & { field?: string; groupColumn?: string }): Row[] {
  // (A group column named like one of the table's own columns is prefixed: group_n, group_field.)
  const group = meta.groupColumn ? (FRONT.includes(meta.groupColumn) || /^(n|share|field|period|scale|ci95)_/.test(meta.groupColumn) || meta.groupColumn === 'app_version' ? `group_${meta.groupColumn}` : meta.groupColumn) : '';
  const columns = rows.flatMap(({ s }) => s.bins.map((b) => ({ col: binColumn(s, b), value: b.from === undefined && s.kind !== 'categories' ? b.value : undefined })));
  return rows.map(({ name, s, from, to }) => {
    const out: Row = csvHead(meta);
    if (group) {
      Object.assign(out, { field: meta.field ?? s.label, [group]: name });
      // (A period: its first value and the first value of the next, e.g. 1950 and 1955 for 1950–1954.)
      if (from !== undefined) Object.assign(out, { period_start: from, period_end_exclusive: to ?? null });
    } else out.field = s.label;
    Object.assign(out, {
      n: s.n,
      n_without_value: s.missing,
      n_left_out: s.leftOut.n,
      scale_min: s.kind === 'scale' && s.range ? s.range[0] : null,
      scale_max: s.kind === 'scale' && s.range ? s.range[1] : null,
      mean: num(s.mean),
      ci95_low: num(s.ci?.[0]),
      ci95_high: num(s.ci?.[1]),
      sd: num(s.sd),
      median: num(s.median),
      min: num(s.min),
      max: num(s.max),
      share_below_0: s.sides ? num(s.sides.below / s.n) : null,
      share_at_0: s.sides ? num(s.sides.middle / s.n) : null,
      share_above_0: s.sides ? num(s.sides.above / s.n) : null,
      ...shareColumns(s),
    });
    for (const c of columns) {
      if (c.col in out) continue;
      const inRange = s.kind === 'scale' && c.value !== undefined && !!s.range && c.value >= s.range[0] - 1e-9 && c.value <= s.range[1] + 1e-9;
      if (group || inRange) out[c.col] = 0;
    }
    for (const b of s.bins) out[binColumn(s, b)] = b.n;
    out.app_version = meta.appVersion;
    return out;
  });
}

/** The numbers behind one field's figure: one row per bar (value, texts, share of the texts with a value), with the field's n, mean and share of yes. */
export function binCsvRows(s: FieldSummary, meta: CsvMeta): Row[] {
  const field: Row = {
    field_n: s.n,
    field_mean: num(s.mean),
    field_ci95_low: num(s.ci?.[0]),
    field_ci95_high: num(s.ci?.[1]),
    ...shareColumns(s, 'field_'),
  };
  return s.bins.map((b) => ({
    ...csvHead(meta),
    field: s.label,
    // (A histogram's bin from its first edge up to the next; the highest value is in the last bin.)
    value: b.from !== undefined ? `${b.from} to ${b.to}` : s.kind === 'categories' ? (b.key === TIE_KEY ? 'no majority (tie)' : b.label) : (b.value ?? null),
    n: b.n,
    share: num(s.n ? b.n / s.n : null),
    // (A combined half point between two points of the scale, or a plain-text value beside the points seen.)
    not_a_scale_point: b.extra && s.kind === 'scale' ? 'yes' : '',
    ...field,
    app_version: meta.appVersion,
  }));
}

/**
 * The rows with their columns in a fixed order: the description and figures first (`FRONT`, a split's group column
 * after the field), then the texts at each value (a scale's values in numeric order, categories in the field's order),
 * the app version last; columns empty in every row (e.g. the shares of yes in a table of scales) are left out.
 */
export function csvColumns(rows: Row[]): [Row[], string[]] {
  const all = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const used = all.filter((c) => rows.some((r) => r[c] !== null && r[c] !== undefined && r[c] !== ''));
  const bins = used.filter((c) => c.startsWith('n_') && !['n_without_value', 'n_left_out'].includes(c));
  const numeric = bins.filter((c) => Number.isFinite(Number(c.slice(2)))).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
  const rest = bins.filter((c) => !numeric.includes(c));
  const known = FRONT.filter((c) => used.includes(c));
  const other = used.filter((c) => !bins.includes(c) && !FRONT.includes(c) && c !== 'app_version');
  const at = known.includes('field') ? known.indexOf('field') + 1 : known.length;
  return [rows, [...known.slice(0, at), ...other, ...known.slice(at), ...numeric, ...rest, ...(used.includes('app_version') ? ['app_version'] : [])]];
}
