import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { ComparableField } from '../lib/compare';
import { fixed } from '../lib/metrics';
import { words } from '../lib/subject';
import { CATEGORY_SLOTS, categoryKey, groupColumns, runCounts, runItems, scaleLabel, scaleStops, summarizeByGroup, summarizeField, type Bin, type FieldSummary } from '../lib/summary';
import type { Doc, Run, Study } from '../lib/types';
import { fmtInt } from '../lib/util';
import { runName, runTitle, type DocView } from '../lib/view';
import { binCsvRows, csvColumns, fieldFigure, FIGURE_WIDTHS, PNG_DPI, rowsFigure, summaryCsvRows, svgToPng, type FigureRow } from '../lib/figure';
import { toCsv, type Row } from '../lib/export/tables';
import { toast } from '../lib/store';
import { dateStamp, download, errorMessage, slug } from '../lib/util';
import { Icon, Menu } from './ui';

type Words = ReturnType<typeof words>;

/**
 * Runs & agreement → Results: one run's answers at a glance. Every comparable field as a row (its distribution as one
 * bar, its mean), the chosen field as a chart with its figures, and optionally the chosen field split by a metadata
 * column (e.g. era). Texts count once, with their combined values, as in the Results table.
 */
export function RunSummary({
  study,
  runs,
  docs,
  load,
}: {
  study: Study;
  runs: Run[];
  docs: Doc[];
  /** A run's per-text views and its comparable fields (cached by the caller). */
  load: (run: Run) => { views: Map<string, DocView>; fields: ComparableField[] };
}) {
  const w = words({ subject: study.prompt.subject });
  const latest = runs[runs.length - 1];
  // The latest run (also a new one, once started) unless another was picked.
  const [runPick, setRunPick] = useState('');
  const run = runs.find((r) => r.id === runPick) ?? latest;
  const { views, fields } = useMemo(() => load(run), [load, run]);
  const items = useMemo(() => runItems(run, docs, views), [run, docs, views]);
  const replicates = run.snapshot.options.replicates;
  const counts = useMemo(() => runCounts(items, replicates), [items, replicates]);
  const summaries = useMemo(() => fields.map((f) => summarizeField(run, f, items)), [run, fields, items]);
  const [fieldPick, setFieldPick] = useState('');
  const chosen = summaries.find((s) => s.key === fieldPick) ?? summaries[0];
  const columns = useMemo(() => groupColumns(items), [items]);
  const [splitPick, setSplitPick] = useState('');
  const split = columns.includes(splitPick) ? splitPick : '';
  const field = fields.find((f) => f.key === chosen?.key);
  const groups = useMemo(() => (split && field ? summarizeByGroup(run, field, items, split) : []), [split, field, run, items]);
  const tip = useTip();
  const running = run.status === 'running' || run.status === 'submitted';
  // What the downloads are named after and carry (in the SVG's description and the CSV's columns).
  const name = `run${runName(run, runs)}`;
  const about = (what: string) =>
    `Study “${study.name || 'Untitled'}”, run #${runName(run, runs)} (${run.snapshot.model.model}, prompt v${run.snapshot.promptVersion}): ${what}. Annotation Desk ${__APP_VERSION__}, ${new Date().toISOString().slice(0, 10)}.`;
  const csvMeta = { run: `#${runName(run, runs)}`, model: run.snapshot.model.model, appVersion: __APP_VERSION__ };
  const file = (part: string) => `${slug(study.name || 'study')}_${name}_${part}`;

  return (
    <div className="card card-pad sum" onMouseMove={tip.move} onMouseLeave={tip.hide}>
      <div className="card-head">
        <h2>Results</h2>
        <span className="right">How one run’s answers are spread, field by field.</span>
      </div>
      <div className="sum-controls">
        <div className="field">
          <label htmlFor="sum-run">Run</label>
          <select id="sum-run" className="select" value={run.id} onChange={(e) => (tip.hide(), setRunPick(e.target.value === latest.id ? '' : e.target.value))}>
            {[...runs].reverse().map((r) => (
              <option key={r.id} value={r.id}>
                Run {runTitle(r, runs)} · v{r.snapshot.promptVersion} · {r.snapshot.model.model}
              </option>
            ))}
          </select>
        </div>
        {columns.length > 0 && summaries.length > 0 && (
          <div className="field">
            <label htmlFor="sum-split">Split by</label>
            <select id="sum-split" className="select" value={split} onChange={(e) => (tip.hide(), setSplitPick(e.target.value))}>
              <option value="">No split</option>
              {columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <Counts counts={counts} w={w} replicates={replicates} running={running} />

      {!counts.annotated ? (
        <div className="empty">
          <strong>{running ? 'No answers yet' : 'Nothing to show'}</strong>
          {running
            ? 'The figures appear here as answers come in.'
            : !counts.total
              ? `None of this run’s ${w.many} are in the study any more.`
              : counts.failed === counts.total
                ? `Every request in this run failed. “Retry failed” in the table above sends them again.`
                : 'This run stopped before an answer came back.'}
        </div>
      ) : !summaries.length ? (
        <div className="notice warn" style={{ marginTop: 12 }}>
          This run has no fields to chart: only free text. Fields of type Category, Ordinal scale, Number or Yes / no (or scores returned as JSON in plain-text
          answers) can be summarized.
        </div>
      ) : (
        <>
          {summaries.length > 1 && (
            <>
              <div className="sum-section-head" style={{ marginTop: 18 }}>
                <p className="section-title">
                  Fields <span className="sum-title-note">choose one to see it in detail</span>
                </p>
                <Downloads
                  name={file('fields')}
                  svg={(widthMm) => rowsFigure(rowsOf(summaries), { widthMm, oneField: false, description: about('every field'), manyWord: w.many })}
                  csv={() => summaryCsvRows(rowsOf(summaries), csvMeta)}
                />
              </div>
              <Rows
                rows={summaries.map((s) => ({ id: s.key, name: s.label, s }))}
                selected={chosen?.key}
                onSelect={(key) => (tip.hide(), setFieldPick(key))}
                w={w}
                ariaLabel="Fields of the run"
              />
            </>
          )}
          {chosen && (
            <Detail
              s={chosen}
              w={w}
              replicates={replicates}
              downloads={
                <Downloads
                  name={file(slug(chosen.label))}
                  svg={(widthMm) => fieldFigure(chosen, { widthMm, description: about(`the field “${chosen.label}”`), manyWord: w.many })}
                  csv={() => binCsvRows(chosen, csvMeta)}
                />
              }
            />
          )}
          {chosen && split && groups.length > 0 && (
            <>
              <div className="sum-section-head" style={{ marginTop: 22 }}>
                <p className="section-title">
                  {chosen.label} by {split}
                </p>
                <Downloads
                  name={file(`${slug(chosen.label)}-by-${slug(split)}`)}
                  svg={(widthMm) =>
                    rowsFigure(
                      groups.map((g) => ({ name: g.group, s: g.summary })),
                      { widthMm, oneField: true, description: about(`the field “${chosen.label}” by ${split}`), manyWord: w.many },
                    )
                  }
                  csv={() => summaryCsvRows(groups.map((g) => ({ name: g.group, s: g.summary })), { ...csvMeta, field: chosen.label, groupColumn: split })}
                />
              </div>
              <Rows rows={groups.map((g) => ({ id: g.group, name: g.group, s: g.summary, muted: g.none }))} w={w} ariaLabel={`${chosen.label} by ${split}`} oneField />
              <p className="hint" style={{ marginTop: 8 }}>
                Descriptive: groups are not tested against each other. No interval below 10 {w.many}.
              </p>
            </>
          )}
          <p className="hint" style={{ marginTop: 14 }}>
            Each {w.one} counts once{replicates > 1 ? ', with its combined value (the median on a scale, the mean for numbers, the majority for categories), as in the Results table' : ''}. Failed{' '}
            {w.many} and {w.many} without an answer are not counted. Intervals are 95% (t for means, Wilson for shares), from 10 {w.many}.
          </p>
        </>
      )}
      {tip.node}
    </div>
  );
}

/* ---------------------------------------------------------------- counts */

function Counts({ counts: c, w, replicates, running }: { counts: ReturnType<typeof runCounts>; w: Words; replicates: number; running: boolean }) {
  return (
    <p className="sum-counts">
      <strong>{fmtInt(c.annotated)}</strong> of {fmtInt(c.total)} {c.total === 1 ? w.one : w.many} annotated
      {c.failed > 0 && (
        <>
          {' · '}
          <span className="sum-err">{fmtInt(c.failed)} failed</span>
        </>
      )}
      {c.waiting > 0 && <> · {fmtInt(c.waiting)} without an answer{running ? ' yet' : ''}</>}
      {replicates > 1 && c.fewer > 0 && (
        <>
          {' · '}
          <span title="Some of their annotations failed or never came back: their values combine the others">
            {fmtInt(c.fewer)} with fewer than {replicates} annotations
          </span>
        </>
      )}
      {running && <span className="sum-live"> · updating as answers come in</span>}
    </p>
  );
}

/* ---------------------------------------------------------------- colors */

/** A value's color on the screen (`scaleStops`), from the panel's CSS colors. */
function scaleColor(s: Pick<FieldSummary, 'diverging' | 'range' | 'bins'>, v: number): string {
  const { stops, p } = scaleStops(s, v);
  return mix(stops.map((k) => `var(--sum-${k})`), p);
}

/** A color `p` of the way along `stops` (0 = the first, stops.length − 1 = the last), mixed in OKLab. */
function mix(stops: string[], p: number): string {
  const i = Math.max(0, Math.min(stops.length - 1, Math.floor(p)));
  const f = p - i;
  if (f < 0.001 || i === stops.length - 1) return stops[i];
  return `color-mix(in oklab, ${stops[i + 1]} ${Math.round(f * 100)}%, ${stops[i]})`;
}

/** Categories in a stacked bar: the codebook's first seven in the fixed palette order, the rest (and ties) gray. */
const categoryColor = (i: number, extra: boolean, total: number) => `var(--sum-${categoryKey(i, extra, total)})`;

/* ---------------------------------------------------------------- rows */

interface RowData {
  id: string;
  name: string;
  s: FieldSummary;
  muted?: boolean;
}

/** A share as a whole percentage; a share that rounds to 0 but isn't, as "<1%". */
const pct = (n: number, total: number) => (!total ? '—' : n > 0 && (n / total) * 100 < 0.5 ? '<1%' : `${Math.round((n / total) * 100)}%`);
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;
const num = (x: number | null, d = 2) => (x === null ? '—' : fixed(x, d).replace(/^-/, '−'));
const ciText = (ci: [number, number] | null, f: (x: number) => string) => (ci ? `${f(ci[0])} to ${f(ci[1])}` : '');

/**
 * Rows of distributions (one per field, or one per group of a field): a bar for each, the mean with its interval on
 * a shared axis, and the number of texts. Rows can be clickable (choose a field).
 */
function Rows({
  rows,
  selected,
  onSelect,
  w,
  ariaLabel,
  oneField,
}: {
  rows: RowData[];
  selected?: string;
  onSelect?: (id: string) => void;
  w: Words;
  ariaLabel: string;
  /** Every row is the same field (groups of it): a categories field's key is shown once, not under every row. */
  oneField?: boolean;
}) {
  const keyOnce = oneField ? rows.find((r) => r.s.kind === 'categories' && r.s.n)?.s : undefined;
  // Bars around 0 share one center, so the rows line up: as far left as the row reaching furthest below 0, and right.
  const div = rows.filter((r) => r.s.diverging && r.s.sides && r.s.n);
  const leftMax = Math.max(0, ...div.map((r) => (r.s.sides!.below + r.s.sides!.middle / 2) / r.s.n));
  const rightMax = Math.max(0, ...div.map((r) => (r.s.sides!.above + r.s.sides!.middle / 2) / r.s.n));
  const axis = meanAxis(rows, !!oneField);
  return (
    <div className={`sum-rows${axis ? '' : ' no-strip'}`} role={onSelect ? 'listbox' : 'table'} aria-label={ariaLabel}>
      <div className="sum-row sum-head" aria-hidden="true">
        <span />
        <span className="sum-h-bar">{div.length ? `Share of ${w.many}: below 0 · 0 · above 0` : `Share of ${w.many}`}</span>
        <span className="sum-h-strip">
          {axis && (
            <span className="sum-ticks">
              {axis.ticks.map((t) => (
                // (A label at either end stays inside the column.)
                <span key={t} className={axis.at(t) > 88 ? 'end' : axis.at(t) < 12 ? 'start' : undefined} style={{ left: `${axis.at(t)}%` }}>
                  {axis.label(t)}
                </span>
              ))}
            </span>
          )}
        </span>
        <span className="sum-h-mean">{meanHeader(rows)}</span>
        <span className="sum-h-n">{w.Many}</span>
      </div>
      {keyOnce && (
        <div className="sum-row sum-key">
          <span />
          <Legend s={keyOnce} />
        </div>
      )}
      {rows.map((r) => {
        const on = selected === r.id;
        const props = onSelect
          ? {
              role: 'option',
              'aria-selected': on,
              tabIndex: 0,
              onClick: () => onSelect(r.id),
              onKeyDown: (e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(r.id);
                }
              },
            }
          : { role: 'row' };
        return (
          <div key={r.id} className={`sum-row${onSelect ? ' clickable' : ''}${on ? ' selected' : ''}${r.muted ? ' muted' : ''}`} {...props}>
            <span className="sum-name" title={r.name}>
              {r.name}
            </span>
            <span className="sum-bar-cell">
              <RowBar s={r.s} leftMax={leftMax} rightMax={rightMax} w={w} />
              {!oneField && r.s.kind === 'categories' && r.s.n > 0 && <Legend s={r.s} />}
            </span>
            <span className="sum-strip-cell">{axis && <Strip s={r.s} axis={axis} />}</span>
            <span className="sum-mean">
              <MeanText s={r.s} />
            </span>
            <span className="sum-n">{fmtInt(r.s.n)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The heading of the rows' mean column: what the rows hold (means, shares of yes, the most common category). */
function meanHeader(rows: RowData[]): string {
  const means = rows.some((r) => r.s.mean !== null);
  const words = new Set(rows.flatMap((r) => (r.s.yes ? [r.s.yes.word] : [])));
  const yes = words.size === 0 ? '' : words.size > 1 ? 'share' : words.has('1') ? 'share of 1s' : 'yes';
  const cats = rows.some((r) => r.s.kind === 'categories' && !r.s.yes);
  if (!means && !yes) return 'Most common';
  if (!means) return `${yes[0].toUpperCase()}${yes.slice(1)}${cats ? ', or most common' : ' (95% CI)'}`;
  return yes ? `Mean or ${yes} (95% CI)` : 'Mean (95% CI)';
}

function MeanText({ s }: { s: FieldSummary }) {
  if (s.yes)
    return (
      <>
        <strong>{pct1(s.yes.share)}</strong> <span className="sum-ci">{ciText(s.yes.ci, pct1)}</span>
      </>
    );
  if (s.mean !== null)
    return (
      <>
        <strong>{num(s.mean)}</strong> <span className="sum-ci">{ciText(s.ci, (x) => num(x))}</span>
      </>
    );
  // Categories: the most common of the codebook's (not "No majority" or a value outside it).
  const top = s.bins.filter((b) => !b.extra).sort((a, b) => b.n - a.n)[0];
  return top && top.n ? (
    <span className="sum-ci">
      Most: <strong className="sum-ink">{top.label}</strong> ({pct(top.n, s.n)})
    </span>
  ) : (
    <span className="sum-ci">—</span>
  );
}

/** One distribution as a single bar: around 0 (rows share the center), else a full-width bar of parts. */
function RowBar({ s, leftMax, rightMax, w }: { s: FieldSummary; leftMax: number; rightMax: number; w: Words }) {
  if (!s.n) return <span className="sum-ci">no values</span>;
  const tipFor = (b: Bin) => `${s.label}: ${b.label}\n${fmtInt(b.n)} ${b.n === 1 ? w.one : w.many} (${pct(b.n, s.n)})`;
  const aria = s.bins
    .filter((b) => b.n)
    .map((b) => `${b.label}: ${pct(b.n, s.n)}`)
    .join(', ');
  if (s.diverging && s.sides) {
    const span = leftMax + rightMax || 1;
    const center = (leftMax / span) * 100;
    // From the middle outward: the 0 part straddles the center, values below 0 go left, above 0 go right.
    const parts: { b: Bin; from: number; to: number }[] = [];
    const mid = s.bins.find((b) => b.value === 0);
    const half = mid ? mid.n / s.n / 2 : 0;
    if (mid && mid.n) parts.push({ b: mid, from: center - (half / span) * 100, to: center + (half / span) * 100 });
    let left = center - (half / span) * 100;
    for (const b of s.bins.filter((x) => (x.value ?? 0) < 0).reverse()) {
      const width = (b.n / s.n / span) * 100;
      if (b.n) parts.push({ b, from: left - width, to: left });
      left -= width;
    }
    let right = center + (half / span) * 100;
    for (const b of s.bins.filter((x) => (x.value ?? 0) > 0)) {
      const width = (b.n / s.n / span) * 100;
      if (b.n) parts.push({ b, from: right, to: right + width });
      right += width;
    }
    return (
      <span className="sum-div">
        <span className="sum-side">{pct(s.sides.below, s.n)}</span>
        <span className="sum-track" role="img" aria-label={`${s.label}: ${aria}`}>
          <span className="sum-center" style={{ left: `${center}%` }} />
          {parts.map(({ b, from, to }) => (
            <span key={b.key} className="sum-seg" style={{ left: `${from}%`, width: `${to - from}%`, background: scaleColor(s, b.value ?? 0) }} data-tip={tipFor(b)} />
          ))}
        </span>
        <span className="sum-side right">{pct(s.sides.above, s.n)}</span>
      </span>
    );
  }
  // A bar of parts from left to right: a scale's points in order, categories in the codebook's order.
  let at = 0;
  const shown = s.bins.filter((b) => b.n);
  const color = (b: Bin) =>
    s.kind === 'categories' ? categoryColor(s.bins.indexOf(b), !!b.extra, s.bins.filter((x) => !x.extra).length) : s.kind === 'scale' ? scaleColor(s, b.value ?? 0) : 'var(--sum-seq-2)';
  return (
    <span className="sum-div">
      <span className="sum-track full" role="img" aria-label={`${s.label}: ${aria}`}>
        {s.kind === 'number' ? (
          <span className="sum-seg" style={{ left: 0, width: '100%', background: 'var(--sum-seq-1)' }} data-tip={`${s.label}: numbers from ${num(s.min)} to ${num(s.max)}`} />
        ) : (
          shown.map((b) => {
            const width = (b.n / s.n) * 100;
            const el = <span key={b.key} className="sum-seg" style={{ left: `${at}%`, width: `${width}%`, background: color(b) }} data-tip={tipFor(b)} />;
            at += width;
            return el;
          })
        )}
      </span>
    </span>
  );
}

/** The key to a categories bar: each category's color and name (others and ties share the gray). */
function Legend({ s }: { s: FieldSummary }) {
  const own = s.bins.filter((b) => !b.extra);
  // (Past eight categories, the eighth on share one gray with values outside the codebook and ties.)
  const colored = own.length > CATEGORY_SLOTS ? own.slice(0, CATEGORY_SLOTS - 1) : own;
  const gray = [...own.slice(colored.length), ...s.bins.filter((b) => b.extra && b.n)];
  return (
    <span className="sum-legend">
      {colored.map((b, i) => (
        <span key={b.key}>
          <i style={{ background: categoryColor(i, false, own.length) }} />
          {b.label}
        </span>
      ))}
      {gray.length > 0 && (
        <span>
          <i style={{ background: 'var(--sum-other)' }} />
          {gray.length === 1 ? gray[0].label : 'Others'}
        </span>
      )}
    </span>
  );
}

/* ---------------------------------------------------------------- mean strip */

interface Axis {
  ticks: number[];
  at: (x: number) => number;
  label: (x: number) => string;
  share: boolean;
}

/**
 * One axis for the rows' means with their intervals (or, when no row has a mean, their shares of yes): from the lowest
 * to the highest bound, a little wider, and taking in 0 on a scale around 0 (so which side of 0 a mean lies on is
 * seen). Rows in another unit (a share of yes beside means) get no mark on it. None when the means are on different
 * scales, or have none (Number fields), except for the groups of one field.
 */
function meanAxis(rows: RowData[], oneField: boolean): Axis | null {
  const means = rows.filter((r) => r.s.mean !== null);
  const share = !means.length;
  const use = share ? rows.filter((r) => r.s.yes) : means;
  if (!use.length) return null;
  // (Fields without a scale, e.g. two Number fields such as a year and a confidence, are not put on one axis; groups of
  // one field are.)
  const ranges = new Set(use.map((r) => JSON.stringify(r.s.range)));
  if (!share && !oneField && (ranges.size > 1 || use.some((r) => !r.s.range))) return null;
  const xs = use.flatMap((r) => (share ? [r.s.yes!.share, ...(r.s.yes!.ci ?? [])] : [r.s.mean!, ...(r.s.ci ?? [])]));
  if (use.some((r) => r.s.diverging)) xs.push(0);
  let lo = Math.min(...xs);
  let hi = Math.max(...xs);
  if (hi - lo < 1e-9) {
    lo -= share ? 0.05 : 0.5;
    hi += share ? 0.05 : 0.5;
  }
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  if (share) (lo = Math.max(0, lo)), (hi = Math.min(1, hi));
  const ticks = niceTicks(lo, hi);
  const at = (x: number) => ((x - lo) / (hi - lo)) * 100;
  return { ticks: ticks.filter((t) => at(t) >= 0 && at(t) <= 100), at, label: share ? (x) => `${Math.round(x * 100)}%` : (x) => scaleLabel(x), share };
}

/** Three or four round ticks between `lo` and `hi`. */
function niceTicks(lo: number, hi: number): number[] {
  const raw = (hi - lo) / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push(Math.round(t / step) * step);
  return out;
}

function Strip({ s, axis }: { s: FieldSummary; axis: Axis }) {
  // (A row in another unit than the axis, e.g. a share of yes beside means, gets no mark.)
  const m = axis.share ? s.yes?.share : s.mean;
  if (m === undefined || m === null) return null;
  const ci = axis.share ? s.yes?.ci : s.ci;
  const zero = !axis.share && s.diverging ? axis.at(0) : null;
  const tip = `${s.label}\n${axis.share ? `${s.yes?.word === '1' ? 'Share of 1s' : 'Yes'}: ${pct1(m)}` : `Mean: ${num(m)}`}${ci ? `\n95% CI ${ciText(ci, axis.share ? pct1 : (x) => num(x))}` : '\nNo interval below 10'}`;
  return (
    <span className="sum-strip" data-tip={tip}>
      <span className="sum-strip-base" />
      {zero !== null && <span className="sum-strip-zero" style={{ left: `${zero}%` }} />}
      {ci && <span className="sum-strip-ci" style={{ left: `${axis.at(ci[0])}%`, width: `${axis.at(ci[1]) - axis.at(ci[0])}%` }} />}
      <span className="sum-strip-dot" style={{ left: `${axis.at(m)}%` }} />
    </span>
  );
}

/* ---------------------------------------------------------------- detail */

function Detail({ s, w, replicates, downloads }: { s: FieldSummary; w: Words; replicates: number; downloads: ReactNode }) {
  return (
    <div className="sum-detail">
      <div className="sum-detail-head">
        <h3>{s.label}</h3>
        <span className="sum-kind">{kindText(s)}</span>
        {s.n > 0 && <span className="sum-head-right">{downloads}</span>}
      </div>
      {s.leftOut.n > 0 && (
        <div className="notice warn" style={{ marginBottom: 10 }}>
          {leftOutNote(s, w)}
        </div>
      )}
      {!s.n ? (
        <div className="hint">No {w.one} has a value for this field yet.</div>
      ) : (
        <div className="sum-detail-body">
          {s.kind === 'categories' ? <CategoryBars s={s} w={w} /> : <Columns s={s} w={w} />}
          <div className="sum-stats">
            <Tile k={`${w.Many} with a value`} v={fmtInt(s.n)} sub={s.missing ? `${fmtInt(s.missing)} annotated without one` : undefined} />
            {s.yes ? (
              <Tile
                k={s.yes.word === '1' ? 'Share of 1s' : 'Yes'}
                v={pct1(s.yes.share)}
                sub={[s.yes.ci ? `95% CI ${ciText(s.yes.ci, pct1)}` : '', s.yes.n < s.n ? `of the ${fmtInt(s.yes.n)} with ${s.yes.word === '1' ? '0 or 1' : 'yes or no'}` : ''].filter(Boolean).join('; ') || undefined}
              />
            ) : s.mean !== null ? (
              <>
                <Tile k="Mean" v={num(s.mean)} sub={s.ci ? `95% CI ${ciText(s.ci, (x) => num(x))}` : 'no interval below 10'} />
                <Tile k="Median" v={s.median === null ? '—' : scaleLabel(s.median)} sub={s.min !== null && s.max !== null ? `range ${scaleLabel(s.min)} to ${scaleLabel(s.max)}` : undefined} />
                <Tile k="Standard deviation" v={num(s.sd)} />
                {s.sides && (
                  <Tile
                    wide
                    k="Below 0 · 0 · above 0"
                    v={`${pct(s.sides.below, s.n)} · ${pct(s.sides.middle, s.n)} · ${pct(s.sides.above, s.n)}`}
                    sub={`${fmtInt(s.sides.below)} · ${fmtInt(s.sides.middle)} · ${fmtInt(s.sides.above)} ${w.many}`}
                  />
                )}
              </>
            ) : null}
          </div>
        </div>
      )}
      {replicates > 1 && s.kind === 'scale' && s.bins.some((b) => b.extra && b.n && !Number.isInteger(b.value)) && (
        <p className="hint" style={{ marginTop: 6 }}>
          Bars between two points are {w.many} whose annotations disagreed: their median falls halfway.
        </p>
      )}
    </div>
  );
}

/** Answers left out of the chart and the figures, and why: "3 texts have answers left out …: “NA”, “9”." */
function leftOutNote(s: FieldSummary, w: Words): string {
  const { n, values, offScale, scale } = s.leftOut;
  const notNumber = n - offScale;
  const why = [
    notNumber ? `${fmtInt(notNumber)} not a number` : '',
    offScale && scale ? `${fmtInt(offScale)} outside the scale (${scaleLabel(scale[0])} to ${scaleLabel(scale[1])})` : '',
  ].filter(Boolean);
  const shown = values.map((v) => `“${v}”`).join(', ') + (values.length === 5 && n > 5 ? ', …' : '');
  return `${fmtInt(n)} ${n === 1 ? `${w.one} has an answer` : `${w.many} have answers`} left out of the chart and the figures (${why.join(', ')}): ${shown}.`;
}

function kindText(s: FieldSummary): string {
  if (s.kind === 'categories') return s.yes ? 'yes / no' : 'categories';
  if (s.yes) return '0 or 1';
  if (s.kind === 'number') return 'numbers';
  return s.range ? `scale ${scaleLabel(s.range[0])} to ${scaleLabel(s.range[1])}` : 'scale';
}

function Tile({ k, v, sub, wide }: { k: string; v: string; sub?: string; wide?: boolean }) {
  return (
    <div className={`stat${wide ? ' sum-wide' : ''}`}>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

/**
 * Columns on a number line: a scale's points (and any combined half points between them), or a histogram. The height
 * is the number of texts; the share is printed on top where there is room; the mean is marked.
 */
function Columns({ s, w }: { s: FieldSummary; w: Words }) {
  const vals = s.bins.map((b) => b.value ?? 0);
  const lo0 = Math.min(...vals, ...(s.kind === 'scale' && s.range ? [s.range[0]] : []));
  const hi0 = Math.max(...vals, ...(s.kind === 'scale' && s.range ? [s.range[1]] : []));
  // The narrowest gap between bars sets their width and the margin at both ends.
  const sorted = [...new Set(vals)].sort((a, b) => a - b);
  let gap = Infinity;
  for (let i = 1; i < sorted.length; i++) gap = Math.min(gap, sorted[i] - sorted[i - 1]);
  if (!Number.isFinite(gap) || gap <= 0) gap = 1;
  const lo = lo0 - gap / 2;
  const hi = hi0 + gap / 2;
  const at = (x: number) => ((x - lo) / (hi - lo)) * 100;
  const slot = (gap / (hi - lo)) * 100;
  const max = Math.max(1, ...s.bins.map((b) => b.n));
  const histogram = s.bins[0]?.from !== undefined;
  const labelsFit = s.bins.length <= 13;
  // Tick labels: a scale's own points (not the half points between them); a histogram's two ends and middle.
  // (A histogram's bin edges, every other one when there are more than 6 bins.)
  const ticks: { x: number; label: string }[] = histogram
    ? [...s.bins.map((b) => ({ x: b.from!, label: b.fromLabel! })), { x: s.bins[s.bins.length - 1].to!, label: s.bins[s.bins.length - 1].toLabel! }].filter(
        (_, i, all) => all.length <= 7 || i % 2 === 0 || i === all.length - 1,
      )
    : s.bins.filter((b) => !(b.extra && b.value !== undefined && !Number.isInteger(b.value) && s.kind === 'scale')).map((b) => ({ x: b.value ?? 0, label: b.label }));
  const color = (b: Bin) => (s.kind === 'scale' ? scaleColor(s, b.value ?? 0) : 'var(--sum-seq-2)');
  return (
    <div className="sum-chart" role="img" aria-label={`${s.label}: ${s.bins.map((b) => `${b.label}: ${fmtInt(b.n)}`).join(', ')}${s.mean !== null ? `; mean ${num(s.mean)}` : ''}`}>
      <div className="sum-plot">
        {s.mean !== null && (
          <span className="sum-mean-mark" style={{ left: `${at(s.mean)}%` }}>
            <span className={`sum-mean-label${at(s.mean) > 70 ? ' left' : ''}`}>mean {num(s.mean)}</span>
          </span>
        )}
        {s.bins.map((b) => {
          // (The tallest bar reaches 86% of the plot, so its share fits above it.)
          const h = (b.n / max) * 86;
          return (
            <span key={b.key} className="sum-col-slot" style={{ left: `${at(b.value ?? 0)}%`, width: `${slot}%` }} data-tip={`${b.label}\n${fmtInt(b.n)} ${b.n === 1 ? w.one : w.many} (${pct(b.n, s.n)})`}>
              <span className={`sum-col${histogram ? ' touch' : ''}`} style={{ height: `${h}%`, background: color(b) }} />
              {labelsFit && b.n > 0 && (
                <span className="sum-col-label" style={{ bottom: `${h}%` }}>
                  {pct(b.n, s.n)}
                </span>
              )}
            </span>
          );
        })}
      </div>
      <div className="sum-axis">
        {ticks.map((t) => (
          <span key={`${t.x}`} style={{ left: `${at(t.x)}%` }}>
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Categories: one bar per category, names on the left, in the colors of the bars above (so this is their key). */
function CategoryBars({ s, w }: { s: FieldSummary; w: Words }) {
  const max = Math.max(1, ...s.bins.map((b) => b.n));
  const own = s.bins.filter((b) => !b.extra).length;
  return (
    <div className="sum-cats" role="table" aria-label={s.label}>
      {s.bins.map((b) => (
        <div key={b.key} className={`sum-cat${b.extra ? ' extra' : ''}`} role="row" data-tip={`${b.label}\n${fmtInt(b.n)} ${b.n === 1 ? w.one : w.many} (${pct(b.n, s.n)})`}>
          <span className="sum-cat-name" role="cell" title={b.label}>
            {b.label}
          </span>
          <span className="sum-cat-bar" role="cell">
            <span style={{ width: `${(b.n / max) * 100}%`, background: categoryColor(s.bins.indexOf(b), !!b.extra, own) }} />
          </span>
          <span className="sum-cat-n" role="cell">
            {fmtInt(b.n)} <span className="sum-ci">({pct(b.n, s.n)})</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- downloads */

const rowsOf = (summaries: FieldSummary[]): FigureRow[] => summaries.map((s) => ({ name: s.label, s }));

/**
 * The Download menu of a figure: SVG (vector) and PNG (600 dpi) at one column's or the full page's width, and the
 * numbers behind it as CSV. The figures are drawn for print (`src/lib/figure.ts`), not copied from the screen.
 */
function Downloads({ name, svg, csv }: { name: string; svg: (widthMm: number) => string; csv: () => Row[] }) {
  const [busy, setBusy] = useState(false);
  const stamp = dateStamp();
  const save = async (kind: 'svg' | 'png', mm: number) => {
    try {
      setBusy(true);
      const text = svg(mm);
      if (kind === 'svg') download(`${name}_${mm}mm_${stamp}.svg`, text, 'image/svg+xml');
      else download(`${name}_${mm}mm_${PNG_DPI}dpi_${stamp}.png`, await svgToPng(text, mm));
    } catch (e) {
      toast(`Download failed: ${errorMessage(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Menu
      button={(open) => (
        <button className="btn small ghost sum-dl" onClick={open} disabled={busy} title="Download this figure (SVG or PNG) or its numbers (CSV)">
          <Icon name="download" size={14} /> {busy ? 'Saving…' : 'Download'}
        </button>
      )}
    >
      {(close) => (
        <>
          {FIGURE_WIDTHS.map((x) => (
            <button key={`svg${x.mm}`} className="menu-item" onClick={() => (close(), void save('svg', x.mm))}>
              Figure, SVG <small>{x.label}</small>
            </button>
          ))}
          {FIGURE_WIDTHS.map((x) => (
            <button key={`png${x.mm}`} className="menu-item" onClick={() => (close(), void save('png', x.mm))}>
              Figure, PNG {PNG_DPI} dpi <small>{x.label}</small>
            </button>
          ))}
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => (close(), download(`${name}_${stamp}.csv`, toCsv(...csvColumns(csv())), 'text/csv'))}>
            Numbers, CSV
          </button>
          <div className="menu-note">SVG is vector: sharp at any size; opens in Word, PowerPoint, Inkscape and Illustrator, which can also save it as EPS or PDF.</div>
        </>
      )}
    </Menu>
  );
}

/* ---------------------------------------------------------------- tooltip */

/**
 * One tooltip for the whole card: any element with a `data-tip` shows it (lines split at "\n") near the pointer.
 * Moved and filled directly, so moving the pointer doesn't draw the card again.
 */
function useTip() {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useRef('');
  const hide = () => {
    if (ref.current) ref.current.style.display = 'none';
    shown.current = '';
  };
  const move = (e: MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    const text = ((e.target as HTMLElement).closest('[data-tip]') as HTMLElement | null)?.dataset.tip;
    if (!text) return hide();
    if (text !== shown.current) {
      const [first, ...rest] = text.split('\n');
      const head = document.createElement('strong');
      head.textContent = first;
      el.replaceChildren(
        head,
        ...rest.map((line) => {
          const d = document.createElement('div');
          d.textContent = line;
          return d;
        }),
      );
      shown.current = text;
    }
    el.style.display = 'block';
    el.style.left = `${Math.min(e.clientX + 14, window.innerWidth - 260)}px`;
    el.style.top = `${e.clientY + 16 > window.innerHeight - 80 ? e.clientY - 70 : e.clientY + 16}px`;
  };
  const node = <div ref={ref} className="sum-tip" role="tooltip" style={{ display: 'none' }} />;
  return { move, hide, node };
}
