import type { Row } from './export/tables';
import { categoryKey, CATEGORY_SLOTS, scaleLabel, scaleStops, type Bin, type FieldSummary } from './summary';

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
  'neg-1': '#eca071',
  'neg-2': '#dc702f',
  'neg-3': '#a64a18',
  'pos-1': '#86b6ef',
  'pos-2': '#3987e5',
  'pos-3': '#1c5cab',
  'seq-1': '#86b6ef',
  'seq-2': '#3987e5',
  'seq-3': '#1c5cab',
  'cat-1': '#2a78d6',
  'cat-2': '#eb6834',
  'cat-3': '#1baf7a',
  'cat-4': '#eda100',
  'cat-5': '#e87ba4',
  'cat-6': '#008300',
  'cat-7': '#6250d6',
  'cat-8': '#e34948',
  other: '#b9b7b0',
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
const categoryHex = (s: FieldSummary, b: Bin) => PALETTE[categoryKey(s.bins.indexOf(b), !!b.extra, s.bins.filter((x) => !x.extra).length)];
const binHex = (s: FieldSummary, b: Bin) => (s.kind === 'categories' ? categoryHex(s, b) : s.kind === 'scale' ? scaleHex(s, b.value ?? 0) : PALETTE['seq-2']);

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
const pct = (n: number, total: number) => (!total ? '' : n > 0 && (n / total) * 100 < 0.5 ? '<1%' : `${Math.round((n / total) * 100)}%`);
const fmtN = (n: number) => n.toLocaleString('en-US');

/** A small SVG writer in points. */
class Svg {
  parts: string[] = [];
  rect(x: number, y: number, w: number, h: number, fill: string, extra = '') {
    if (w <= 0 || h <= 0) return;
    this.parts.push(`<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" fill="${fill}"${extra}/>`);
  }
  line(x1: number, y1: number, x2: number, y2: number, stroke: string, width = 0.5) {
    this.parts.push(`<line x1="${r2(x1)}" y1="${r2(y1)}" x2="${r2(x2)}" y2="${r2(y2)}" stroke="${stroke}" stroke-width="${width}"/>`);
  }
  circle(cx: number, cy: number, r: number, fill: string) {
    this.parts.push(`<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r)}" fill="${fill}" stroke="#ffffff" stroke-width="0.8"/>`);
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

/** A row of swatches with names, wrapped at `maxW`; returns the height used. */
function legend(svg: Svg, x: number, y: number, maxW: number, items: { color: string; label: string }[]): number {
  let cx = x;
  let cy = y;
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
/** The key to a categories field: its own categories (the first seven past eight), then one gray for the rest. */
function categoryItems(s: FieldSummary): { color: string; label: string }[] {
  const own = s.bins.filter((b) => !b.extra);
  const colored = own.length > CATEGORY_SLOTS ? own.slice(0, CATEGORY_SLOTS - 1) : own;
  const gray = [...own.slice(colored.length), ...s.bins.filter((b) => b.extra && b.n)];
  return [...colored.map((b) => ({ color: categoryHex(s, b), label: b.label })), ...(gray.length ? [{ color: PALETTE.other, label: gray.length === 1 ? gray[0].label : 'Others' }] : [])];
}
/** The key to a scale's colors: its whole points. */
function scaleItems(s: FieldSummary): { color: string; label: string }[] {
  return s.bins.filter((b) => !b.extra || Number.isInteger(b.value)).map((b) => ({ color: binHex(s, b), label: b.label }));
}

/* ------------------------------------------------------------------ rows figure */

export interface FigureRow {
  name: string;
  s: FieldSummary;
}

/**
 * Rows of distributions (every field of a run, or one field by group), as on the screen: the name, the distribution
 * as one bar (around 0 for scales with values on both sides, with the shares below and above 0), the mean with its 95%
 * interval on a shared axis (or the share of yes / of 1s), and n. Keys below. `oneField`: the rows are groups of one
 * field (one key for all).
 */
export function rowsFigure(rows: FigureRow[], opts: { widthMm: number; oneField: boolean; description: string; manyWord?: string }): string {
  const many = opts.manyWord ?? 'texts';
  const W = opts.widthMm * PT_PER_MM;
  const svg = new Svg();
  const narrow = opts.widthMm < 120;
  const rowH = 14;
  const barH = 8;
  const gap = narrow ? 5 : 8;
  // Columns: name | below % | bar | above % | interval | n
  const nW = Math.max(textWidth('n', SMALL), ...rows.map((r) => textWidth(fmtN(r.s.n), SMALL))) + 2;
  const div = rows.filter((r) => r.s.diverging && r.s.sides && r.s.n);
  const sideW = div.length ? textWidth('100%', SMALL) + 2 : 0;
  const axis = figureAxis(rows, opts.oneField);
  const stripW = axis ? Math.max(narrow ? 48 : 58, W * (narrow ? 0.2 : 0.22)) : 0;
  const nameW = Math.min(Math.max(...rows.map((r) => textWidth(r.name))) + 2, W * (narrow ? 0.3 : 0.26));
  const barX = nameW + gap + sideW + (sideW ? 3 : 0);
  const barW = W - barX - (sideW ? sideW + 3 : 0) - gap - (axis ? stripW + gap : 0) - nW;
  const stripX = barX + barW + (sideW ? sideW + 3 : 0) + gap;
  const nX = W;
  const leftMax = Math.max(0, ...div.map((r) => (r.s.sides!.below + r.s.sides!.middle / 2) / r.s.n));
  const rightMax = Math.max(0, ...div.map((r) => (r.s.sides!.above + r.s.sides!.middle / 2) / r.s.n));
  const span = leftMax + rightMax || 1;
  const center = barX + (leftMax / span) * barW;

  // Header: what the bar shows, and n.
  let y = 9;
  // (The longer heading where it fits over the bars.)
  const heading = div.length && textWidth(`Share of ${many} below 0, at 0 and above 0`, SMALL) <= barW + sideW ? `Share of ${many} below 0, at 0 and above 0` : `Share of ${many}`;
  svg.text(barX, y, heading, { size: SMALL, fill: MUTED });
  svg.text(nX, y, 'n', { size: SMALL, fill: MUTED, anchor: 'end' });
  y += 5;
  const top = y;
  const ys: number[] = [];
  for (const r of rows) {
    const mid = y + rowH / 2;
    ys.push(mid);
    svg.text(0, mid + 2.8, fit(r.name, nameW), { fill: INK });
    const s = r.s;
    if (s.n && s.diverging && s.sides) {
      svg.text(barX - 3, mid + 2.5, pct(s.sides.below, s.n), { size: SMALL, fill: MUTED, anchor: 'end' });
      svg.text(barX + barW + 3, mid + 2.5, pct(s.sides.above, s.n), { size: SMALL, fill: MUTED });
      const midBin = s.bins.find((b) => b.value === 0);
      const half = midBin ? midBin.n / s.n / 2 : 0;
      const at = (share: number) => (share / span) * barW;
      // The shared center (0) of the bars, through this row.
      svg.line(center, mid - barH / 2 - 2.5, center, mid + barH / 2 + 2.5, AXIS, 0.6);
      if (midBin && midBin.n) svg.rect(center - at(half) + GAP / 2, mid - barH / 2, at(half * 2) - GAP, barH, PALETTE.mid);
      let left = center - at(half);
      for (const b of s.bins.filter((x) => (x.value ?? 0) < 0).reverse()) {
        const w = at(b.n / s.n);
        if (b.n) svg.rect(left - w + GAP / 2, mid - barH / 2, w - GAP, barH, binHex(s, b));
        left -= w;
      }
      let right = center + at(half);
      for (const b of s.bins.filter((x) => (x.value ?? 0) > 0)) {
        const w = at(b.n / s.n);
        if (b.n) svg.rect(right + GAP / 2, mid - barH / 2, w - GAP, barH, binHex(s, b));
        right += w;
      }
    } else if (s.n && s.kind !== 'number') {
      let x = barX;
      for (const b of s.bins.filter((x) => x.n)) {
        const w = (b.n / s.n) * barW;
        svg.rect(x + GAP / 2, mid - barH / 2, w - GAP, barH, binHex(s, b));
        x += w;
      }
    } else if (!s.n) svg.text(barX, mid + 2.5, 'no values', { size: SMALL, fill: MUTED });
    svg.text(nX, mid + 2.5, fmtN(s.n), { size: SMALL, fill: INK, anchor: 'end' });
    y += rowH;
    // A categories field's key under its bar (all fields), or once below (groups of one field).
    if (!opts.oneField && s.kind === 'categories' && s.n) y += legend(svg, barX, y + 5, barW + (sideW ? sideW + 3 : 0), categoryItems(s)) + 1;
  }
  const bottom = y;
  // The intervals: gridlines at the ticks, 0 darker, each row's mean (or share) with its interval, ticks below.
  if (axis) {
    const at = (x: number) => stripX + axis.at(x) * stripW;
    for (const t of axis.ticks) svg.line(at(t), top, at(t), bottom, t === 0 && !axis.share ? AXIS : GRID, t === 0 && !axis.share ? 0.6 : 0.4);
    rows.forEach((r, i) => {
      const m = axis.share ? r.s.yes?.share : r.s.mean;
      if (m === undefined || m === null) return;
      const ci = axis.share ? r.s.yes?.ci : r.s.ci;
      if (ci) svg.line(at(ci[0]), ys[i], at(ci[1]), ys[i], INK, 0.9);
      svg.circle(at(m), ys[i], 2.4, INK);
    });
    svg.line(stripX, bottom, stripX + stripW, bottom, AXIS, 0.5);
    for (const t of axis.ticks) svg.text(at(t), bottom + 8, axis.label(t), { size: SMALL, fill: MUTED, anchor: 'middle' });
    svg.text(stripX + stripW / 2, bottom + 17, axis.share ? (rows.some((r) => r.s.yes?.word === '1') ? 'Share of 1s (95% CI)' : 'Share of yes (95% CI)') : 'Mean (95% CI)', {
      size: SMALL,
      fill: MUTED,
      anchor: 'middle',
    });
  }
  y = bottom + (axis ? 22 : 6);
  // Keys: the scale's colors (one key when the rows share a scale), or the categories of a split field.
  const scaled = rows.filter((r) => r.s.kind === 'scale' && r.s.n);
  const sameScale = new Set(scaled.map((r) => JSON.stringify(r.s.range))).size === 1;
  if (scaled.length && sameScale) {
    // (Every group's points: the key from the row with the most of them.)
    const widest = scaled.reduce((a, b) => (scaleItems(b.s).length > scaleItems(a.s).length ? b : a));
    y += legend(svg, barX, y + 6, W - barX, scaleItems(widest.s));
  }
  if (opts.oneField) {
    const cat = rows.find((r) => r.s.kind === 'categories' && r.s.n);
    if (cat) y += legend(svg, barX, y + 6, W - barX, categoryItems(cat.s));
  }
  return svg.done(W, y + 2, opts.widthMm, opts.description);
}

interface FigureAxis {
  ticks: number[];
  at: (x: number) => number; // 0…1 across the strip
  label: (x: number) => string;
  share: boolean;
}
/** As on the screen (`meanAxis` in RunSummary.tsx): the means (else the shares) of the rows on one axis, 0 included on scales around 0. */
function figureAxis(rows: FigureRow[], oneField: boolean): FigureAxis | null {
  const means = rows.filter((r) => r.s.mean !== null);
  const share = !means.length;
  const use = share ? rows.filter((r) => r.s.yes) : means;
  if (!use.length) return null;
  const ranges = new Set(use.map((r) => JSON.stringify(r.s.range)));
  if (!share && !oneField && (ranges.size > 1 || use.some((r) => !r.s.range))) return null;
  const xs = use.flatMap((r) => (share ? [r.s.yes!.share, ...(r.s.yes!.ci ?? [])] : [r.s.mean!, ...(r.s.ci ?? [])]));
  if (use.some((r) => r.s.diverging)) xs.push(0);
  let lo = Math.min(...xs);
  let hi = Math.max(...xs);
  if (hi - lo < 1e-9) (lo -= share ? 0.05 : 0.5), (hi += share ? 0.05 : 0.5);
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  if (share) (lo = Math.max(0, lo)), (hi = Math.min(1, hi));
  const raw = (hi - lo) / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) ?? raw;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(Math.round(t / step) * step);
  return { ticks, at: (x) => (x - lo) / (hi - lo), label: share ? (x) => `${Math.round(x * 100)}%` : (x) => scaleLabel(x), share };
}

/* ------------------------------------------------------------------ one field */

/**
 * One field's distribution: columns on its scale (half points between the points, the mean marked, shares on top)
 * or a histogram for numbers, with the field's name below the axis; categories as horizontal bars with counts.
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
    svg.text(barX, y + 10, `${s.label}: ${many} (share of the ${fmtN(s.n)} with a value)`, { size: SMALL, fill: MUTED });
    return svg.done(W, y + 14, opts.widthMm, opts.description);
  }

  const H = Math.max(130, Math.min(230, W * 0.42));
  const topPad = 14; // room for the mean's label
  const plotTop = topPad;
  const plotBottom = H - 26;
  const plotH = plotBottom - plotTop;
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
  const x = (v: number) => 4 + ((v - lo) / (hi - lo)) * (W - 8);
  const slot = (step / (hi - lo)) * (W - 8);
  const histogram = s.bins[0]?.from !== undefined;
  const barW = histogram ? slot - GAP : Math.min(18, slot * 0.7);
  const max = Math.max(1, ...s.bins.map((b) => b.n));
  const labels = s.bins.length <= 13;
  for (const b of s.bins) {
    const h = (b.n / max) * plotH * 0.88;
    svg.rect(x(b.value ?? 0) - barW / 2, plotBottom - h, barW, h, binHex(s, b));
    if (labels && b.n) svg.text(x(b.value ?? 0), plotBottom - h - 2.5, pct(b.n, s.n), { size: SMALL, fill: MUTED, anchor: 'middle' });
  }
  svg.line(4, plotBottom, W - 4, plotBottom, AXIS, 0.6);
  // Ticks: a scale's own points (not the half points between them); a histogram's edges (every other past 6 bins).
  const ticks: { v: number; label: string }[] = histogram
    ? [...s.bins.map((b) => ({ v: b.from!, label: b.fromLabel! })), { v: s.bins[s.bins.length - 1].to!, label: s.bins[s.bins.length - 1].toLabel! }].filter(
        (_, i, all) => all.length <= 7 || i % 2 === 0 || i === all.length - 1,
      )
    : s.bins.filter((b) => !(s.kind === 'scale' && b.extra && !Number.isInteger(b.value))).map((b) => ({ v: b.value ?? 0, label: b.label }));
  for (const t of ticks) {
    svg.line(x(t.v), plotBottom, x(t.v), plotBottom + 2.5, AXIS, 0.5);
    svg.text(x(t.v), plotBottom + 10, t.label, { size: SMALL, fill: MUTED, anchor: 'middle' });
  }
  svg.text(W / 2, plotBottom + 21, s.label, { size: SIZE, fill: INK, anchor: 'middle' });
  // The mean (not for 0/1 scales, whose share of 1s is the figure): a line with its value at the top.
  if (s.mean !== null) {
    const mx = x(s.mean);
    svg.line(mx, plotTop - 2, mx, plotBottom, INK, 0.7);
    const label = `mean ${scaleLabel(s.mean)}`;
    const right = mx + 3 + textWidth(label, SMALL) < W;
    svg.text(right ? mx + 3 : mx - 3, plotTop + 4, label, { size: SMALL, fill: INK, anchor: right ? 'start' : 'end' });
  } else if (s.yes) {
    svg.text(W - 4, plotTop + 4, `share of 1s ${Math.round(s.yes.share * 1000) / 10}%`, { size: SMALL, fill: INK, anchor: 'end' });
  }
  return svg.done(W, H, opts.widthMm, opts.description);
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

const num = (x: number | null | undefined, d = 4) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
/** A bin as a CSV column name: n_-3, n_0.5, n_Historical, n_no_majority; histogram bins n_1965-1970. */
function binColumn(s: FieldSummary, b: Bin): string {
  if (b.from !== undefined) return `n_${b.from}-${b.to}`;
  if (s.kind !== 'categories') return `n_${b.value}`;
  if (b.key.startsWith('\u0000')) return 'n_no_majority';
  return `n_${b.label}`;
}

/**
 * The numbers behind a rows figure (every field, or one field by group): one row per row, with n, mean, 95% CI, SD,
 * median, range, the shares below/at/above 0, the share of yes (or 1s) with its interval, and the texts at each value.
 */
export function summaryCsvRows(rows: FigureRow[], meta: { run: string; model: string; appVersion: string; field?: string; groupColumn?: string }): Row[] {
  // Groups of one field: a value no text of a group got is 0 there (with every field, another field's values are blank).
  const zeros: Row = meta.groupColumn ? Object.fromEntries(rows.flatMap(({ s }) => s.bins.map((b) => [binColumn(s, b), 0]))) : {};
  return rows.map(({ name, s }) => {
    const out: Row = { run: meta.run, model: meta.model };
    if (meta.groupColumn) Object.assign(out, { field: meta.field ?? s.label, [meta.groupColumn]: name });
    else out.field = s.label;
    Object.assign(out, {
      n: s.n,
      n_without_value: s.missing,
      n_left_out: s.leftOut.n,
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
      [s.yes?.word === '1' ? 'share_1' : 'share_yes']: s.yes ? num(s.yes.share) : null,
      share_ci95_low: s.yes?.ci ? num(s.yes.ci[0]) : null,
      share_ci95_high: s.yes?.ci ? num(s.yes.ci[1]) : null,
    });
    Object.assign(out, zeros);
    for (const b of s.bins) out[binColumn(s, b)] = b.n;
    out.app_version = meta.appVersion;
    return out;
  });
}

/** The numbers behind one field's figure: one row per bar (value, texts, share of the texts with a value). */
export function binCsvRows(s: FieldSummary, meta: { run: string; model: string; appVersion: string }): Row[] {
  return s.bins.map((b) => ({
    run: meta.run,
    model: meta.model,
    field: s.label,
    value: b.from !== undefined ? `${b.from}-${b.to}` : s.kind === 'categories' ? (b.key.startsWith('\u0000') ? 'no majority (tie)' : b.label) : (b.value ?? null),
    n: b.n,
    share: num(s.n ? b.n / s.n : null),
    // (A combined half point between two points of the scale, or a plain-text value beside the points seen.)
    not_a_scale_point: b.extra && s.kind === 'scale' ? 'yes' : '',
    app_version: meta.appVersion,
  }));
}

/**
 * The rows with their columns in a fixed order: the description and figures first, then the texts at each value (a
 * scale's values in numeric order, categories in the field's order), the app version last; columns empty in every row
 * (e.g. the shares of yes in a table of scales) are left out.
 */
export function csvColumns(rows: Row[]): [Row[], string[]] {
  const all = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const used = all.filter((c) => rows.some((r) => r[c] !== null && r[c] !== undefined && r[c] !== ''));
  const bins = used.filter((c) => c.startsWith('n_') && !['n_without_value', 'n_left_out'].includes(c));
  const numeric = bins.filter((c) => Number.isFinite(Number(c.slice(2)))).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
  const rest = bins.filter((c) => !numeric.includes(c));
  const front = used.filter((c) => !bins.includes(c) && c !== 'app_version');
  return [rows, [...front, ...numeric, ...rest, ...(used.includes('app_version') ? ['app_version'] : [])]];
}
