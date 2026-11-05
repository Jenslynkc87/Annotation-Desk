// Run summary: one run's labels at a glance (distribution, n, mean, SD, median), overall and split by a metadata
// column: a trend over a numeric column (years), or one bar per group (era, journal). Descriptive only, on screen only.
import { useMemo, useState } from 'react';
import { fieldValue } from '../lib/compare';
import { fixed } from '../lib/metrics';
import { currentStudy, useStore, withRemoved } from '../lib/store';
import { words } from '../lib/subject';
import { isGroupColumn, isNumericColumn, NO_GROUP, summarize, summarizeGroups, summaryField, type Summary } from '../lib/summary';
import { fmtInt } from '../lib/util';
import { runInProgress, runTitle } from '../lib/view';
import { runData, runFields, useThrottled } from './RunsView';

type Words = ReturnType<typeof words>;
type Group = { group: string; summary: Summary };

/** A number with a real minus sign. */
const num = (x: number | null, digits = 2) => (x === null ? '—' : fixed(x, digits).replace(/^-/, '−'));
const pct = (n: number, total: number) => (total ? `${((n / total) * 100).toFixed(1)}%` : '—');
const pointLabel = (s: Summary, p: string) => (s.kind === 'yesno' ? (p === 'true' ? 'Yes' : 'No') : p.replace(/^-/, '−'));
/** Texts in the bars (on a point or category). */
const inBars = (s: Summary) => s.counts.reduce((a, c) => a + c, 0);
const hasMean = (s: Summary) => s.kind === 'scale' || s.kind === 'numbers';
/** The value the trend follows: the mean, or for yes/no the share of yes. */
const trendValue = (s: Summary) => (s.kind === 'yesno' ? (inBars(s) ? s.counts[1] / inBars(s) : null) : s.mean);
/** At least this many texts for a point of the trend to be drawn filled. */
const FEW = 10;

export function RunSummaryPanel() {
  const study = useStore((s) => currentStudy(s))!;
  const w = words({ subject: study.prompt.subject });
  const runs = useStore((s) => s.runs);
  const activeDocs = useStore((s) => s.docs);
  const removedDocs = useStore((s) => s.removedDocs);
  const docs = useMemo(() => withRemoved(activeDocs, removedDocs), [activeDocs, removedDocs]);
  const results = useThrottled(
    useStore((s) => s.results),
    1000,
  );
  const [runPick, setRunPick] = useState('');
  const run = runs.find((r) => r.id === runPick) ?? runs[runs.length - 1];
  const data = useMemo(() => runData(run, docs, results), [run, docs, results]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fields = useMemo(() => runFields(run, docs, results), [run, data]);
  const [fieldPick, setFieldPick] = useState('');
  const field = fields.find((f) => f.key === fieldPick) ?? fields[0];
  // The run's texts, also those removed from the study since.
  const runDocs = useMemo(() => {
    const ids = new Set(run.docIds);
    return docs.filter((d) => ids.has(d.id));
  }, [run, docs]);
  const items = useMemo(
    () =>
      field
        ? runDocs.map((d) => {
            const v = data.views.get(d.id);
            return { status: v?.status ?? ('none' as const), value: v ? fieldValue(run, v.values, field.key) : '', group: '' };
          })
        : [],
    [runDocs, data, field, run],
  );
  const summary = useMemo(() => (field ? summarize(field, items) : null), [field, items]);

  // Columns to split by: numbers along a line (years: a trend) or a few groups (era, journal).
  const splitColumns = useMemo(() => {
    const cols = [...new Set(runDocs.flatMap((d) => Object.keys(d.meta)))];
    return cols
      .map((c) => {
        const cells = runDocs.map((d) => d.meta[c]);
        return { col: c, trend: isNumericColumn(cells), group: isGroupColumn(cells) };
      })
      .filter((c) => c.trend || c.group);
  }, [runDocs]);
  const [splitPick, setSplitPick] = useState('');
  const split = splitColumns.find((c) => c.col === splitPick);
  const groups = useMemo(
    () => (field && split ? summarizeGroups(field, items.map((it, i) => ({ ...it, group: runDocs[i].meta[split.col] ?? '' }))) : []),
    [field, split, items, runDocs],
  );

  const sf = field ? summaryField(field) : null;
  const going = runInProgress(run);
  return (
    <div className="card card-pad">
      <div className="card-head">
        <h2>Run summary</h2>
        <span className="right">How one run’s labels are distributed, overall and across a metadata column.</span>
      </div>
      <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <div className="field">
          <label>Run</label>
          <select className="select" value={run.id} onChange={(e) => setRunPick(e.target.value)}>
            {[...runs].reverse().map((r) => (
              <option key={r.id} value={r.id}>
                Run {runTitle(r, runs)} · v{r.snapshot.promptVersion} · {r.snapshot.model.model}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Field</label>
          <select className="select" value={field?.key ?? ''} onChange={(e) => setFieldPick(e.target.value)} disabled={!fields.length}>
            {fields.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Split by</label>
          <select className="select" value={split?.col ?? ''} onChange={(e) => setSplitPick(e.target.value)} disabled={!field || !splitColumns.length}>
            <option value="">{splitColumns.length ? 'No split' : 'No column to split by'}</option>
            {splitColumns.map((c) => (
              <option key={c.col} value={c.col}>
                {c.col}
                {c.trend ? ' (trend)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!field || !summary || !sf ? (
        <div className="notice warn" style={{ marginTop: 6 }}>
          This run has no labels to summarize: its answers are free text. Fields of type Category, Ordinal scale, Number or Yes / no (or plain-text answers
          that return scores as JSON) can be summarized.
        </div>
      ) : (
        <>
          <div className="stat-grid" style={{ marginTop: 6 }}>
            <Stat k={`${w.Many} in the run`} v={fmtInt(summary.nTexts)} />
            <Stat k="With a label" v={fmtInt(summary.nValue)} sub={pct(summary.nValue, summary.nTexts)} />
            <Stat k="Failed" v={fmtInt(summary.nFailed)} sub={pct(summary.nFailed, summary.nTexts)} />
            {summary.nNotYet > 0 && <Stat k={going ? 'Not answered yet' : 'Not sent'} v={fmtInt(summary.nNotYet)} sub={pct(summary.nNotYet, summary.nTexts)} />}
            {summary.kind === 'yesno' && <Stat k="Yes" v={pct(summary.counts[1], inBars(summary))} sub={`${fmtInt(summary.counts[1])} of ${fmtInt(inBars(summary))}`} />}
            {hasMean(summary) && (
              <>
                <Stat k="Mean" v={num(summary.mean)} />
                <Stat k="SD" v={num(summary.sd)} />
                <Stat k="Median" v={num(summary.median)} />
              </>
            )}
            {summary.kind === 'numbers' && (
              <Stat k="Min · Q1 · Q3 · Max" v={`${num(summary.min, 1)} · ${num(summary.q1, 1)} · ${num(summary.q3, 1)} · ${num(summary.max, 1)}`} />
            )}
          </div>
          <Notes s={summary} w={w} />

          {summary.kind === 'scale' && inBars(summary) > 0 && <ScaleBars s={summary} />}
          {(summary.kind === 'categories' || summary.kind === 'yesno') && inBars(summary) > 0 && <CategoryBars s={summary} />}

          {split && groups.length > 0 && (
            <>
              <p className="section-title" style={{ marginTop: 18 }}>
                {split.trend && summary.kind !== 'categories' ? `${summary.kind === 'yesno' ? 'Share yes' : 'Mean'} by ${split.col}` : `By ${split.col}`}
              </p>
              {split.trend && summary.kind !== 'categories' ? (
                <Trend groups={groups} s={summary} column={split.col} w={w} />
              ) : summary.kind === 'scale' ? (
                <DivergingBars groups={groups} s={summary} />
              ) : summary.kind === 'yesno' ? (
                <ShareRows groups={groups} />
              ) : null}
              <details className="more" open={summary.kind === 'categories' || summary.kind === 'numbers'}>
                <summary>Table</summary>
                <div className="more-body">
                  <GroupTable groups={groups} s={summary} column={split.col} />
                </div>
              </details>
            </>
          )}

          <p className="hint" style={{ marginTop: 12 }}>
            Descriptive only. {run.snapshot.options.replicates > 1 ? `Each ${w.one}’s combined label is used (median on scales, majority otherwise), as in the exports. ` : ''}
            {sf.scaleSeen ? 'The scale is the range of the model’s answers; set the scale of the scores under Output to fix it. ' : ''}
            {going ? 'The run is still going: the figures cover the answers so far.' : ''}
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

/** What is not in the bars, and why. */
function Notes({ s, w }: { s: Summary; w: Words }) {
  const one = (n: number) => `${fmtInt(n)} ${n === 1 ? w.one : w.many}`;
  const notes: string[] = [];
  if (s.between) notes.push(`${one(s.between)} whose replicates split between two points (e.g. 0.5) ${s.between === 1 ? 'is' : 'are'} in the mean, SD and median but not in the bars.`);
  if (s.ties) notes.push(`${one(s.ties)} with tied replicates (no majority) ${s.ties === 1 ? 'is' : 'are'} left out.`);
  if (s.leftOut.n)
    notes.push(
      `${one(s.leftOut.n)} with a value ${s.kind === 'scale' ? 'off the scale' : s.kind === 'numbers' ? 'that is not a number' : 'that is not one of the field’s values'} ${s.leftOut.n === 1 ? 'is' : 'are'} left out: ${s.leftOut.values.map((v) => `“${v}”`).join(', ')}${s.leftOut.n > s.leftOut.values.length ? ', …' : ''}.`,
    );
  if (s.nBlank) notes.push(`${one(s.nBlank)} answered without a value for this field (blank or NA).`);
  return notes.length ? (
    <div className="hint" style={{ marginTop: 8 }}>
      {notes.join(' ')}
    </div>
  ) : null;
}

/** A bar's path: square at the baseline, 4px-rounded at the data end. */
function barPath(x: number, y0: number, bw: number, h: number): string {
  const r = Math.min(4, bw / 2, h);
  const top = y0 - h;
  return `M${x},${y0}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${y0}Z`;
}

/** Counts per scale point, in scale order, empty points included. */
function ScaleBars({ s }: { s: Summary }) {
  const W = 640;
  const [top, plotH, bottom] = [24, 150, 24];
  const total = inBars(s);
  const max = Math.max(1, ...s.counts);
  const band = (W - 16) / s.points.length;
  const bw = Math.min(band * 0.72, 64);
  const labelled = s.points.length <= 15;
  const every = labelled ? 1 : Math.ceil(s.points.length / 15);
  const y0 = top + plotH;
  return (
    <div className="chart" style={{ maxWidth: 720 }}>
      <svg viewBox={`0 0 ${W} ${top + plotH + bottom}`} role="img" aria-label="Number of labels per scale point">
        <line x1={8} x2={W - 8} y1={y0} y2={y0} className="chart-axis" />
        {s.points.map((p, i) => {
          const h = (s.counts[i] / max) * plotH;
          const x = 8 + i * band + (band - bw) / 2;
          return (
            <g key={p}>
              <title>{`${pointLabel(s, p)}: ${fmtInt(s.counts[i])} (${pct(s.counts[i], total)})`}</title>
              {/* (A hover target the height of the plot, so short bars are easy to point at.) */}
              <rect x={8 + i * band} y={top} width={band} height={plotH} fill="transparent" />
              {s.counts[i] > 0 && <path d={barPath(x, y0, bw, Math.max(h, 1))} className="chart-bar" />}
              {labelled && (
                <text x={x + bw / 2} y={y0 - h - 6} textAnchor="middle" className="chart-label">
                  {fmtInt(s.counts[i])}
                </text>
              )}
              {i % every === 0 && (
                <text x={x + bw / 2} y={y0 + 16} textAnchor="middle" className="chart-tick">
                  {pointLabel(s, p)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Categories (codebook order) or yes/no as horizontal bars, with count and share. */
function CategoryBars({ s }: { s: Summary }) {
  const total = inBars(s);
  const max = Math.max(1, ...s.counts);
  const order = s.kind === 'yesno' ? [1, 0] : s.points.map((_, i) => i);
  return (
    <div className="hbars">
      {order.map((i) => (
        <div className="hbar-row" key={s.points[i]} title={`${pointLabel(s, s.points[i])}: ${fmtInt(s.counts[i])} (${pct(s.counts[i], total)})`}>
          <span className="hbar-label">{pointLabel(s, s.points[i])}</span>
          <span className="hbar-track">
            <span className="hbar-fill" style={{ width: `${(s.counts[i] / max) * 100}%` }} />
          </span>
          <span className="hbar-value">
            {fmtInt(s.counts[i])} <span className="muted">({pct(s.counts[i], total)})</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Yes/no by group: the share of yes per group. */
function ShareRows({ groups }: { groups: Group[] }) {
  return (
    <div className="hbars">
      {groups.map(({ group, summary: s }) => {
        const n = inBars(s);
        return (
          <div className="hbar-row" key={group} title={`${group}: yes ${fmtInt(s.counts[1])} of ${fmtInt(n)}`}>
            <span className="hbar-label">{group}</span>
            <span className="hbar-track">
              <span className="hbar-fill" style={{ width: n ? `${(s.counts[1] / n) * 100}%` : 0 }} />
            </span>
            <span className="hbar-value">
              {pct(s.counts[1], n)} <span className="muted">(n = {fmtInt(n)})</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A scale by group: one 100% bar per group, centred on the scale's midpoint (points below it to the left, above to
 * the right, the midpoint itself split across the centre line), with n and mean at the end.
 */
function DivergingBars({ groups, s }: { groups: Group[]; s: Summary }) {
  const pts = s.points.map(Number);
  const mid = (pts[0] + pts[pts.length - 1]) / 2;
  const reach = Math.max(...pts.map((p) => Math.abs(p - mid)));
  // A point's colour: grey at the midpoint, deepening towards each end.
  const color = (p: number) => {
    const d = Math.abs(p - mid);
    if (d === 0) return 'var(--div-mid)';
    const t = Math.round(35 + (65 * d) / reach);
    return `color-mix(in oklab, var(${p < mid ? '--div-neg' : '--div-pos'}) ${t}%, var(--div-mid))`;
  };
  const rows = groups.map(({ group, summary: g }) => {
    const n = inBars(g);
    const share = g.counts.map((c) => (n ? c / n : 0));
    const left = share.reduce((a, x, i) => a + (pts[i] < mid ? x : pts[i] === mid ? x / 2 : 0), 0);
    const right = share.reduce((a, x, i) => a + (pts[i] > mid ? x : pts[i] === mid ? x / 2 : 0), 0);
    return { group, g, n, share, left, right };
  });
  const domain = Math.max(0.01, ...rows.map((r) => Math.max(r.left, r.right)));
  const toPct = (x: number) => (x / domain) * 50;
  return (
    <>
      <div className="div-legend">
        {s.points.map((p, i) => (
          <span key={p}>
            <span className="div-swatch" style={{ background: color(pts[i]) }} />
            {pointLabel(s, p)}
          </span>
        ))}
      </div>
      <div className="hbars">
        {rows.map((r) => {
          // Segments from the centre outwards on each side.
          const segs: { key: string; left: number; width: number; bg: string; tip: string }[] = [];
          const tip = (i: number) => `${r.group} · ${pointLabel(s, s.points[i])}: ${fmtInt(r.g.counts[i])} (${pct(r.g.counts[i], r.n)})`;
          let at = 50;
          for (let i = pts.length - 1; i >= 0; i--) {
            if (pts[i] > mid) continue;
            const wd = toPct(pts[i] === mid ? r.share[i] / 2 : r.share[i]);
            at -= wd;
            if (wd > 0) segs.push({ key: `l${i}`, left: at, width: wd, bg: color(pts[i]), tip: tip(i) });
          }
          at = 50;
          for (let i = 0; i < pts.length; i++) {
            if (pts[i] < mid) continue;
            const wd = toPct(pts[i] === mid ? r.share[i] / 2 : r.share[i]);
            if (wd > 0) segs.push({ key: `r${i}`, left: at, width: wd, bg: color(pts[i]), tip: tip(i) });
            at += wd;
          }
          return (
            <div className="hbar-row" key={r.group}>
              <span className="hbar-label" title={r.group}>
                {r.group}
              </span>
              <span className="div-track">
                {segs.map((x) => (
                  <span key={x.key} className="div-seg" title={x.tip} style={{ left: `${x.left}%`, width: `${x.width}%`, background: x.bg }} />
                ))}
                <span className="div-center" />
              </span>
              <span className="hbar-value">
                {r.g.mean === null ? '—' : `mean ${num(r.g.mean)}`} <span className="muted">(n = {fmtInt(r.g.nValue)})</span>
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** "Nice" tick values from lo to hi, at most about `count` of them. */
function ticks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let x = Math.ceil(lo / step) * step; x <= hi + 1e-9; x += step) out.push(Math.round(x * 1e6) / 1e6);
  return out;
}

/**
 * Mean (or share yes) by a numeric column such as year: one point per value, hollow where fewer than 10 texts, the
 * line broken where a whole-number column skips a value; n per value as a strip underneath.
 */
function Trend({ groups, s, column, w }: { groups: Group[]; s: Summary; column: string; w: Words }) {
  const pts = groups
    .filter((g) => g.group !== NO_GROUP)
    .map((g) => ({ x: Number(g.group), y: trendValue(g.summary), n: g.summary.kind === 'yesno' ? inBars(g.summary) : g.summary.nValue, label: g.group }))
    .filter((p) => Number.isFinite(p.x));
  const shown = pts.filter((p): p is typeof p & { y: number } => p.y !== null && p.n > 0);
  if (shown.length < 2) return <div className="hint">Too few values of “{column}” with labels for a trend.</div>;
  const W = 640;
  const [ml, mr, top, plotH, gap, stripH, bottom] = [44, 12, 12, 170, 12, 34, 22];
  const x0 = Math.min(...pts.map((p) => p.x));
  const x1 = Math.max(...pts.map((p) => p.x));
  // The y-axis: the whole scale (or 0–100% for yes/no); for numbers, the span of the means with a margin.
  let [y0, y1] = s.kind === 'scale' ? [Number(s.points[0]), Number(s.points[s.points.length - 1])] : s.kind === 'yesno' ? [0, 1] : [0, 0];
  if (s.kind === 'numbers') {
    const ys = shown.map((p) => p.y);
    const pad = (Math.max(...ys) - Math.min(...ys)) * 0.08 || 1;
    [y0, y1] = [Math.min(...ys) - pad, Math.max(...ys) + pad];
  }
  const sx = (x: number) => ml + ((x - x0) / (x1 - x0 || 1)) * (W - ml - mr);
  const sy = (y: number) => top + plotH - ((y - y0) / (y1 - y0 || 1)) * plotH;
  const yTicks = s.kind === 'scale' && s.points.length <= 11 ? s.points.map(Number) : ticks(y0, y1, 5);
  const fmtY = (y: number) => (s.kind === 'yesno' ? `${Math.round(y * 100)}%` : num(y, Number.isInteger(y) ? 0 : 1));
  const whole = pts.every((p) => Number.isInteger(p.x));
  // Line segments: broken where a whole-number column (years) has no labelled value.
  const lines: string[] = [];
  let d = '';
  shown.forEach((p, i) => {
    const prev = shown[i - 1];
    d += `${!prev || (whole && p.x - prev.x > 1) ? (d && lines.push(d), (d = ''), 'M') : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`;
  });
  if (d) lines.push(d);
  const nMax = Math.max(1, ...pts.map((p) => p.n));
  const stripTop = top + plotH + gap;
  const band = Math.max(1, Math.min(14, ((W - ml - mr) / Math.max(1, x1 - x0 + 1)) * 0.7));
  const midline = s.kind === 'scale' && y0 < 0 && y1 > 0 ? 0 : null;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${stripTop + stripH + bottom}`} role="img" aria-label={`${s.kind === 'yesno' ? 'Share yes' : 'Mean'} by ${column}`}>
        {yTicks.map((y) => (
          <g key={y}>
            <line x1={ml} x2={W - mr} y1={sy(y)} y2={sy(y)} className={y === midline ? 'chart-axis' : 'chart-grid'} />
            <text x={ml - 6} y={sy(y) + 4} textAnchor="end" className="chart-tick">
              {fmtY(y)}
            </text>
          </g>
        ))}
        {lines.map((p, i) => (
          <path key={i} d={p} className="chart-line" />
        ))}
        {shown.map((p) => (
          <g key={p.label}>
            <title>{`${column} ${p.label}: ${s.kind === 'yesno' ? `${(p.y * 100).toFixed(1)}% yes` : `mean ${num(p.y)}`} (n = ${fmtInt(p.n)})`}</title>
            <circle cx={sx(p.x)} cy={sy(p.y)} r={10} fill="transparent" />
            <circle cx={sx(p.x)} cy={sy(p.y)} r={4} className={p.n >= FEW ? 'chart-dot' : 'chart-dot hollow'} />
          </g>
        ))}
        {/* n per value */}
        <text x={ml - 6} y={stripTop + stripH / 2 + 4} textAnchor="end" className="chart-tick">
          n
        </text>
        {pts.map((p) => (
          <g key={`n${p.label}`}>
            <title>{`${column} ${p.label}: n = ${fmtInt(p.n)}`}</title>
            <rect x={sx(p.x) - band / 2} y={stripTop + stripH - (p.n / nMax) * stripH} width={band} height={Math.max((p.n / nMax) * stripH, p.n ? 1 : 0)} className="chart-nbar" />
          </g>
        ))}
        <line x1={ml} x2={W - mr} y1={stripTop + stripH} y2={stripTop + stripH} className="chart-axis" />
        {ticks(x0, x1, 8)
          .filter((x) => !whole || Number.isInteger(x))
          .map((x) => (
            <text key={x} x={sx(x)} y={stripTop + stripH + 16} textAnchor="middle" className="chart-tick">
              {String(x)}
            </text>
          ))}
      </svg>
      <div className="hint">
        Hollow points: fewer than {FEW} {w.many}. The bars underneath give the number of {w.many} with a label for each value of “{column}”
        {whole ? `; the line breaks where a value has none` : ''}. Largest: {fmtInt(nMax)}.
        {groups.some((g) => g.group === NO_GROUP) ? ` ${w.Many} without a value of “${column}” are in the table only.` : ''}
      </div>
    </div>
  );
}

/** The exact figures per group. */
function GroupTable({ groups, s, column }: { groups: Group[]; s: Summary; column: string }) {
  const showPoints = s.kind !== 'numbers' && s.points.length <= 12;
  return (
    <div className="table-wrap" style={{ borderTop: 0 }}>
      <table className="data" style={{ width: 'auto' }}>
        <thead>
          <tr>
            <th>{column}</th>
            <th className="num">n</th>
            {hasMean(s) && (
              <>
                <th className="num">Mean</th>
                <th className="num">SD</th>
                <th className="num">Median</th>
              </>
            )}
            {s.kind === 'numbers' && (
              <>
                <th className="num">Min</th>
                <th className="num">Max</th>
              </>
            )}
            {showPoints && s.points.map((p) => <th key={p} className="num">{pointLabel(s, p)}</th>)}
            <th className="num">Failed</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(({ group, summary: g }) => (
            <tr key={group}>
              <th>{group}</th>
              <td className="num">{fmtInt(g.nValue)}</td>
              {hasMean(s) && (
                <>
                  <td className="num">{num(g.mean)}</td>
                  <td className="num">{num(g.sd)}</td>
                  <td className="num">{num(g.median)}</td>
                </>
              )}
              {s.kind === 'numbers' && (
                <>
                  <td className="num">{num(g.min, 1)}</td>
                  <td className="num">{num(g.max, 1)}</td>
                </>
              )}
              {showPoints &&
                g.counts.map((c, i) => (
                  <td key={i} className="num" title={`${fmtInt(c)} of ${fmtInt(inBars(g))}`}>
                    {inBars(g) ? `${Math.round((c / inBars(g)) * 100)}%` : '—'}
                  </td>
                ))}
              <td className="num">{fmtInt(g.nFailed)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

