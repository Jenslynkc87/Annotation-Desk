import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { ComparableField } from '../lib/compare';
import { fixed } from '../lib/metrics';
import { words } from '../lib/subject';
import {
  binCategoryKey,
  CATEGORY_SLOTS,
  columnInfo,
  filterColumns,
  filterItems,
  periodSteps,
  runCounts,
  runItems,
  scaleLabel,
  scaleStops,
  splitColumns,
  subsetLabel,
  summarizeByGroup,
  summarizeField,
  type Bin,
  type FieldSummary,
  type Group,
  type Subset,
  TIE_KEY,
  wholePercent,
  yesPercent,
} from '../lib/summary';
import type { Doc, Run, Study } from '../lib/types';
import { fmtInt } from '../lib/util';
import { runName, runTitle, type DocView } from '../lib/view';
import { axisRows, binCsvRows, csvColumns, FEW, fieldFigure, FIGURE_WIDTHS, niceTicks, PNG_DPI, rowsFigure, summaryCsvRows, svgToPng, tickLabel, timeFigure, timeMeans, timeStacks, type FigureRow, type TimeGroup } from '../lib/figure';
import { toCsv, type Row } from '../lib/export/tables';
import { toast } from '../lib/store';
import { download, errorMessage, slug } from '../lib/util';
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
  const allItems = useMemo(() => runItems(run, docs, views), [run, docs, views]);
  // The run's metadata columns: what its texts can be shown by (a subset) and split by.
  const columns = useMemo(() => columnInfo(allItems), [allItems]);
  const filterable = useMemo(() => filterColumns(columns), [columns]);
  const splittable = useMemo(() => splitColumns(columns), [columns]);
  // Show only: one value of a column, or a range of a column of numbers (blank ends are open).
  const [filterPick, setFilterPick] = useState<{ column: string; value: string; from: string; to: string }>({ column: '', value: '', from: '', to: '' });
  const fcol = filterable.find((c) => c.name === filterPick.column);
  const number = (t: string) => (t.trim() === '' || !Number.isFinite(Number(t)) ? undefined : Number(t));
  // (A range typed the wrong way round, 2000 to 1990, is read as 1990 to 2000.)
  const orderedRange = (column: string, from?: number, to?: number): Subset =>
    from !== undefined && to !== undefined && from > to ? { column, from: to, to: from } : { column, from, to };
  const subset: Subset | null = !fcol
    ? null
    : fcol.numeric
      ? orderedRange(fcol.name, number(filterPick.from), number(filterPick.to))
      : { column: fcol.name, value: fcol.values.includes(filterPick.value) ? filterPick.value : fcol.values[0] };
  const subsetKey = subset ? JSON.stringify(subset) : '';
  const shownSubset = subset && (subset.value !== undefined || subset.from !== undefined || subset.to !== undefined) ? subset : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => filterItems(allItems, shownSubset), [allItems, subsetKey]);
  const replicates = run.snapshot.options.replicates;
  const counts = useMemo(() => runCounts(items, replicates), [items, replicates]);
  const summaries = useMemo(() => fields.map((f) => summarizeField(run, f, items)), [run, fields, items]);
  const [fieldPick, setFieldPick] = useState('');
  const chosen = summaries.find((s) => s.key === fieldPick) ?? summaries[0];
  const [splitPick, setSplitPick] = useState('');
  const scol = splittable.find((c) => c.name === splitPick);
  const split = scol?.name ?? '';
  // A column of numbers is split in steps (each value, or periods such as five years) and drawn over its values.
  const steps = useMemo(() => (scol?.numeric ? periodSteps(scol) : null), [scol]);
  const [stepPick, setStepPick] = useState<number | null>(null);
  const step = steps ? (stepPick !== null && steps.steps.includes(stepPick) ? stepPick : steps.preferred) : 0;
  const [byMean, setByMean] = useState(false);
  const field = fields.find((f) => f.key === chosen?.key);
  const groups = useMemo(() => {
    if (!split || !field) return [];
    const g = summarizeByGroup(run, field, items, split, step, scol?.whole ?? true, !!scol?.numeric);
    if (!byMean || scol?.numeric) return g;
    // Lowest mean (or share of yes) first; groups without one, and "(no value)", last.
    const key = (x: Group) => (x.none ? Infinity : (x.summary.mean ?? x.summary.yes?.share ?? Infinity));
    return [...g].sort((a, b) => key(a) - key(b));
  }, [split, field, run, items, step, scol, byMean]);
  // Periods of a column of numbers are drawn over their values; each value of it (a few codes, −3…3) as rows, which
  // don't suggest even spacing between values that may be uneven.
  const overTime = !!scol?.numeric && step > 0;
  const tip = useTip();
  const running = run.status === 'running' || run.status === 'submitted';
  // What the downloads are named after and carry (in the SVG's description and the CSV's columns).
  const name = `run${runName(run, runs)}`;
  const shownLabel = shownSubset ? subsetLabel(shownSubset) : '';
  const about = (what: string) =>
    `Study “${study.name || 'Untitled'}”, run #${runName(run, runs)} (${run.snapshot.model.model}, prompt v${run.snapshot.promptVersion}): ${what}${shownLabel ? `, ${w.many} with ${shownLabel}` : ''}. Annotation Desk ${__APP_VERSION__}, ${localDate()}.`;
  const csvMeta = {
    study: study.name || 'Untitled',
    run: `#${runName(run, runs)}`,
    model: run.snapshot.model.model,
    promptVersion: run.snapshot.promptVersion,
    appVersion: __APP_VERSION__,
    ...(shownLabel ? { subset: shownLabel } : {}),
  };
  const file = (part: string) => `${fileSlug(study.name || 'study')}_${name}_${part}${shownLabel ? `_${fileSlug(shownLabel)}` : ''}`;
  const splitName = `${split}${steps && step > 0 ? ` (periods of ${step})` : ''}`;
  // The over-time axis: what its labels stand for, and what the data cover (the first and last periods may be partial).
  const axisName = steps && step > 0 ? `${split}, periods of ${step} labeled by their first value` : split;
  const coverage = scol?.numeric ? `${split} values from ${scaleLabel(scol.min)} to ${scaleLabel(scol.max)}` : '';
  const timeGroups: TimeGroup[] = overTime ? groups.filter((g) => !g.none).map((g) => ({ tick: g.from !== undefined ? scaleLabel(g.from) : g.group, name: g.group, s: g.summary })) : [];
  // Annotated texts without a number in the split column (left out of the over-time chart).
  const noneGroup = groups.find((g) => g.none);
  const noneCount = noneGroup ? noneGroup.summary.n + noneGroup.summary.missing + noneGroup.summary.leftOut.n : 0;

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
        {filterable.length > 0 && summaries.length > 0 && (
          <div className="field">
            <label htmlFor="sum-filter">Show</label>
            <div className="sum-pair">
              <select
                id="sum-filter"
                className="select"
                value={fcol?.name ?? ''}
                onChange={(e) => (tip.hide(), setFilterPick({ column: e.target.value, value: '', from: '', to: '' }))}
              >
                <option value="">All {w.many}</option>
                {filterable.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.numeric ? `${c.name}, a range…` : `One ${c.name}…`}
                  </option>
                ))}
              </select>
              {fcol && !fcol.numeric && (
                <select className="select" aria-label={`Value of ${fcol.name}`} value={subset?.value ?? ''} onChange={(e) => (tip.hide(), setFilterPick({ ...filterPick, value: e.target.value }))}>
                  {fcol.values.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              )}
              {fcol?.numeric && (
                <span className="sum-range">
                  <input
                    className="input"
                    type="number"
                    aria-label={`${fcol.name} from`}
                    placeholder={scaleLabel(fcol.min).replace('−', '-')}
                    value={filterPick.from}
                    onChange={(e) => setFilterPick({ ...filterPick, from: e.target.value })}
                  />
                  <span>to</span>
                  <input
                    className="input"
                    type="number"
                    aria-label={`${fcol.name} to`}
                    placeholder={scaleLabel(fcol.max).replace('−', '-')}
                    value={filterPick.to}
                    onChange={(e) => setFilterPick({ ...filterPick, to: e.target.value })}
                  />
                </span>
              )}
            </div>
          </div>
        )}
        {splittable.length > 0 && summaries.length > 0 && (
          <div className="field">
            <label htmlFor="sum-split">Split by</label>
            <div className="sum-pair">
              <select id="sum-split" className="select" value={split} onChange={(e) => (tip.hide(), setSplitPick(e.target.value), setStepPick(null))}>
                <option value="">No split</option>
                {splittable.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              {steps && steps.steps.length > 1 && (
                <select className="select" aria-label="Group the values" value={step} onChange={(e) => (tip.hide(), setStepPick(Number(e.target.value)))}>
                  {steps.steps.map((x) => (
                    <option key={x} value={x}>
                      {x === 0 ? 'each value' : `steps of ${x}`}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        )}
      </div>

      {!(shownLabel && !counts.total) && <Counts counts={counts} w={w} replicates={replicates} running={running} subset={shownLabel} />}

      {!counts.annotated ? (
        <div className="empty">
          <strong>{shownLabel && !counts.total ? `No ${w.many} with ${shownLabel}` : running ? 'No answers yet' : 'Nothing to show'}</strong>
          {shownLabel && !counts.total
            ? `None of this run’s ${w.many} has ${shownLabel}. Change or clear “Show” above.`
            : running
              ? `The figures appear here as answers come in${shownLabel ? ` for the ${w.many} with ${shownLabel}` : ''}.`
              : !counts.total
                ? `None of this run’s ${w.many} are in the study any more.`
                : counts.failed === counts.total
                  ? `Every request${shownLabel ? ` for the ${w.many} with ${shownLabel}` : ' in this run'} failed. “Retry failed” in the table above sends them again.`
                  : `This run stopped before an answer came back${shownLabel ? ` for the ${w.many} with ${shownLabel}` : ''}.`}
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
                  {chosen.label} by {splitName}
                </p>
                <span className="sum-head-tools">
                  {!overTime && groups.some((g) => g.summary.mean !== null || g.summary.yes) && (
                    <label className="check sum-sort">
                      <input type="checkbox" checked={byMean} onChange={(e) => setByMean(e.target.checked)} /> Sort by {groups.some((g) => g.summary.mean !== null) ? 'mean' : 'share'}
                    </label>
                  )}
                  {(!overTime || timeGroups.length > 0) && (
                  <Downloads
                    name={file(`${fileSlug(chosen.label)}-by-${fileSlug(split)}${steps && step > 0 ? `-${step}` : ''}`)}
                    svg={(widthMm) =>
                      overTime
                        ? timeFigure(timeGroups, {
                            widthMm,
                            column: axisName,
                            description: about(`the field “${chosen.label}” by ${axisName} (${coverage}); * marks periods with fewer than 10 ${w.many}`),
                            manyWord: w.many,
                          })
                        : rowsFigure(
                            groups.map((g) => ({ name: g.group, s: g.summary })),
                            { widthMm, oneField: true, description: about(`the field “${chosen.label}” by ${split}`), manyWord: w.many },
                          )
                    }
                    csv={() =>
                      summaryCsvRows(
                        // (The over-time figure leaves out texts without a number: so does its CSV.)
                        groups.filter((g) => !overTime || !g.none).map((g) => ({ name: g.group, s: g.summary, from: g.from, to: g.to })),
                        { ...csvMeta, field: chosen.label, groupColumn: split },
                      )
                    }
                  />
                  )}
                </span>
              </div>
              {overTime ? (
                <TimeChart groups={timeGroups} w={w} column={axisName} />
              ) : (
                <Rows rows={groups.map((g) => ({ id: g.group, name: g.group, s: g.summary, muted: g.none }))} w={w} ariaLabel={`${chosen.label} by ${split}`} oneField />
              )}
              <p className="hint" style={{ marginTop: 8 }}>
                Descriptive: groups are not tested against each other.
                {overTime && ` Periods start at multiples of ${step}, so the first and last may be only partly covered (${coverage}).`}
                {overTime && timeGroups.some((g) => g.s.n > 0 && g.s.n < FEW) && ` ${timeMeans(timeGroups) ? '* and hollow dots' : '*'}: fewer than ${FEW} ${w.many}, so one ${w.one} moves the shares by 10 points or more.`}
                {overTime && noneCount > 0 && ` ${fmtInt(noneCount)} annotated ${noneCount === 1 ? w.one : w.many} without a number in “${split}” ${noneCount === 1 ? 'is' : 'are'} left out of the chart.`}
              </p>
            </>
          )}
          <p className="hint" style={{ marginTop: 14 }}>
            Each {w.one} counts once{replicates > 1 ? ', with its combined value (the median on a scale, the mean for numbers, the majority for categories), as in the Results table' : ''}. Failed{' '}
            {w.many} and {w.many} without an answer are not counted. Intervals are 95% (t for means, Wilson for shares), from 10 {w.many}.
            {summaries.some((x) => x.bins.some((b) => b.key === TIE_KEY && b.n)) &&
              ` Shares of yes and of the most common category leave out the ${w.many} whose annotations had no majority (ties); the bars show them.`}
          </p>
        </>
      )}
      {tip.node}
    </div>
  );
}

/* ---------------------------------------------------------------- counts */

function Counts({ counts: c, w, replicates, running, subset }: { counts: ReturnType<typeof runCounts>; w: Words; replicates: number; running: boolean; subset: string }) {
  return (
    <p className="sum-counts">
      {subset && <span className="sum-subset">{subset}: </span>}
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
          <span title="Some of their annotations failed or never came back; their values combine the remaining annotations">
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

/** A categories field's bar part: its category's color (the codebook's first seven, in a fixed order), the tie gray, or the light gray of other values. */
const catColor = (s: Pick<FieldSummary, 'bins'>, b: Bin) => `var(--sum-${binCategoryKey(s, b)})`;

/* ---------------------------------------------------------------- rows */

interface RowData {
  id: string;
  name: string;
  s: FieldSummary;
  muted?: boolean;
}

/** A share as a whole percentage, from the counts; a share that rounds to 0 but isn't, as "<1%". */
const pct = (n: number, total: number) => (!total ? '—' : wholePercent(n, total));
/** An interval's bound as a percentage to one decimal (a share of yes itself: `yesPercent`, from its counts). */
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;
/** A figure with 2 decimals, or 1 from 100 up (a mean year reads 1886.5, not 1886.51); a real minus sign. */
const num = (x: number | null, d?: number) => (x === null ? '—' : fixed(x, d ?? (Math.abs(x) >= 100 ? 1 : 2)).replace(/^-/, '−'));
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
  const ids = rows.map((r) => r.id);
  // Bars around 0 share one center, so the rows line up: as far left as the row reaching furthest below 0, and right.
  const div = rows.filter((r) => r.s.diverging && r.s.sides && r.s.n);
  const leftMax = Math.max(0, ...div.map((r) => (r.s.sides!.below + r.s.sides!.middle / 2) / r.s.n));
  const rightMax = Math.max(0, ...div.map((r) => (r.s.sides!.above + r.s.sides!.middle / 2) / r.s.n));
  const axis = meanAxis(rows, !!oneField);
  const onAxis = new Set(axisRows(rows, !!oneField).map((r) => r.id));
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
          <Legend s={keyOnce} also={rows.map((r) => r.s)} />
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
              onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(r.id);
                }
                // (Up and down move through the fields, as in a list.)
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const next = ids[ids.indexOf(r.id) + (e.key === 'ArrowDown' ? 1 : -1)];
                  if (next === undefined) return;
                  onSelect(next);
                  const el = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
                  if (el instanceof HTMLElement) el.focus();
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
            <span className="sum-strip-cell">{axis && <Strip s={r.s} axis={axis} on={onAxis.has(r.id)} />}</span>
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
  const share = words.size === 0 ? '' : words.size > 1 ? 'share of yes or 1s' : words.has('1') ? 'share of 1s' : 'share of yes';
  const cats = rows.some((r) => r.s.kind === 'categories' && !r.s.yes);
  const parts = [means ? 'mean' : '', share, cats ? 'most common' : ''].filter(Boolean);
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}` : parts[0] ?? '';
  return `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}${means || share ? ' (95% CI)' : ''}`;
}

function MeanText({ s }: { s: FieldSummary }) {
  if (s.yes) {
    // (Ties left out of the share, as for the most common category: said on hover when there are any.)
    const left = s.n - s.yes.n;
    return (
      <span title={left ? `Share of the ${fmtInt(s.yes.n)} with ${s.yes.word === '1' ? '0 or 1' : 'yes or no'}; ${fmtInt(left)} without a majority left out` : undefined}>
        <strong>{yesPercent(s.yes)}</strong> <span className="sum-ci">{ciText(s.yes.ci, pct1)}</span>
      </span>
    );
  }
  if (s.mean !== null)
    return (
      <>
        <strong>{num(s.mean)}</strong> <span className="sum-ci">{ciText(s.ci, (x) => num(x))}</span>
      </>
    );
  // Categories: the most common of the codebook's (not "No majority" or a value outside it; all of them when tied), as a
  // share of the texts with a majority: ties left out of the denominator, as in the share of yes.
  const own = s.bins.filter((b) => !b.extra);
  const most = Math.max(0, ...own.map((b) => b.n));
  const tops = own.filter((b) => b.n === most);
  const ties = s.bins.find((b) => b.key === TIE_KEY)?.n ?? 0;
  if (!most) return <span className="sum-ci">—</span>;
  const names = tops.map((b) => b.label).join(', ');
  const share = `${pct(most, s.n - ties)}${tops.length > 1 ? ' each' : ''}`;
  return (
    <span className="sum-ci" title={`Most common: ${names} (${share}${ties ? ` of the ${fmtInt(s.n - ties)} with a majority; ${fmtInt(ties)} ties left out` : ''})`}>
      Most: <strong className="sum-ink">{names}</strong> ({share})
    </span>
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
  const color = (b: Bin) => (s.kind === 'categories' ? catColor(s, b) : s.kind === 'scale' ? scaleColor(s, b.value ?? 0) : 'var(--sum-seq-2)');
  return (
    <span className="sum-div">
      {s.kind === 'number' ? (
        // (Numbers have no parts to share out: their range, and the field's chart below.)
        <span className="sum-ci">
          numbers from {s.min === null ? '—' : scaleLabel(s.min)} to {s.max === null ? '—' : scaleLabel(s.max)}
        </span>
      ) : (
        <span className="sum-track full" role="img" aria-label={`${s.label}: ${aria}`}>
          {shown.map((b) => {
            const width = (b.n / s.n) * 100;
            const el = <span key={b.key} className="sum-seg" style={{ left: `${at}%`, width: `${width}%`, background: color(b) }} data-tip={tipFor(b)} />;
            at += width;
            return el;
          })}
        </span>
      )}
    </span>
  );
}

/**
 * The key to a categories bar: each category's color and name, then one light gray for other values (outside the
 * codebook, or past eight categories) and the darker gray of “No majority (tie)”, each only if some text has it, here
 * or in any of `also` (the other groups of a split, so the key covers every bar).
 */
function Legend({ s, also = [] }: { s: FieldSummary; also?: FieldSummary[] }) {
  const own = s.bins.filter((b) => !b.extra);
  const colored = own.length > CATEGORY_SLOTS ? own.slice(0, CATEGORY_SLOTS - 1) : own;
  const all = [s, ...also];
  const others = new Set([...own.slice(colored.length).map((b) => b.label), ...all.flatMap((x) => x.bins.filter((b) => b.extra && b.key !== TIE_KEY && b.n).map((b) => b.label))]);
  const ties = all.some((x) => x.bins.some((b) => b.key === TIE_KEY && b.n));
  return (
    <span className="sum-legend">
      {colored.map((b) => (
        <span key={b.key}>
          <i style={{ background: catColor(s, b) }} />
          {b.label}
        </span>
      ))}
      {others.size > 0 && (
        <span>
          <i style={{ background: 'var(--sum-other)' }} />
          {others.size === 1 ? [...others][0] : 'Other values'}
        </span>
      )}
      {ties && (
        <span>
          <i style={{ background: 'var(--sum-tie)' }} />
          No majority (tie)
        </span>
      )}
    </span>
  );
}

/* ---------------------------------------------------------------- over time */

/** A bar part's color on the screen: a scale's value, a category, or the one color of numbers. */
function binColor(s: FieldSummary, b: Bin): string {
  if (s.kind === 'categories') return catColor(s, b);
  return s.kind === 'scale' ? scaleColor(s, b.value ?? 0) : 'var(--sum-seq-2)';
}

/** The key to a scale's colors: its whole points (combined half points take the colors between them). */
function ScaleKey({ s }: { s: FieldSummary }) {
  return (
    <span className="sum-legend">
      {s.bins
        .filter((b) => !b.extra || Number.isInteger(b.value))
        .map((b) => (
          <span key={b.key}>
            <i style={{ background: scaleColor(s, b.value ?? 0) }} />
            {b.label}
          </span>
        ))}
    </span>
  );
}

/**
 * A field split by a column of numbers (years, volumes), in order along it: the shares as stacked columns (on a scale
 * around 0, below 0 down from the baseline and above 0 up, 0 straddling it; otherwise columns of 100%), and below, on
 * their own axis, the means (or shares of yes) with their 95% intervals. Same geometry as the downloaded figure.
 */
function TimeChart({ groups, w, column }: { groups: TimeGroup[]; w: Words; column: string }) {
  if (!groups.length) return <div className="hint">No {w.one} has a number in this column.</div>;
  const stacks = timeStacks(groups);
  const means = timeMeans(groups);
  const hasStacks = stacks.parts.some((p) => p.length);
  const N = groups.length;
  const x = (i: number) => `${((i + 0.5) / N) * 100}%`;
  const colW = `min(26px, ${(68 / N).toFixed(2)}%)`;
  const ys = (v: number) => ((stacks.hi - v) / (stacks.hi - stacks.lo)) * 100;
  const every = Math.max(1, Math.ceil(N / 14));
  const plural = (n: number) => `${fmtInt(n)} ${n === 1 ? w.one : w.many}`;
  // The key: from the period with the most values present (so a tie or an extra value seen anywhere is in it).
  const keyFrom = groups.filter((g) => g.s.n && g.s.kind !== 'number').reduce<FieldSummary | null>((a, g) => (!a || g.s.bins.filter((b) => b.n).length > a.bins.filter((b) => b.n).length ? g.s : a), null);
  const widestScale = groups.filter((g) => g.s.kind === 'scale' && g.s.n).reduce<FieldSummary | null>((a, g) => (!a || g.s.bins.length > a.bins.length ? g.s : a), null);
  const meanWord = means?.share ? (groups.some((g) => g.s.yes?.word === '1') ? 'Share of 1s' : 'Share of yes') : 'Mean';
  return (
    <div className="sum-time">
      {hasStacks && (
        <>
          <div className="sum-time-caption">{stacks.diverging ? `Share of ${w.many}: below 0 down, above 0 up` : `Share of ${w.many}`}</div>
          <div className="sum-time-plot tall">
            {stacks.ticks.map((t) => (
              <div key={t} className={`sum-time-grid${t === 0 && stacks.diverging ? ' zero' : ''}`} style={{ top: `${ys(t)}%` }}>
                <span>{tickLabel(Math.abs(t), true)}</span>
              </div>
            ))}
            {/* (Periods with fewer than 10 texts: an asterisk over the column.) */}
            {stacks.parts.map((parts, i) =>
              groups[i].s.n > 0 && groups[i].s.n < FEW && parts.length ? (
                <span key={`few-${i}`} className="sum-time-star" style={{ left: x(i), top: `${ys(Math.max(...parts.map((p) => p.to)))}%` }} aria-hidden="true">
                  *
                </span>
              ) : null,
            )}
            {stacks.parts.map((parts, i) =>
              parts.map((p) => (
                <span
                  key={`${i}-${p.b.key}`}
                  className="sum-time-seg"
                  style={{ left: x(i), width: colW, top: `${ys(p.to)}%`, height: `${ys(p.from) - ys(p.to)}%`, background: binColor(groups[i].s, p.b) }}
                  data-tip={`${groups[i].name}: ${p.b.label}\n${plural(p.b.n)} (${pct(p.b.n, groups[i].s.n)} of ${fmtInt(groups[i].s.n)})${groups[i].s.n < FEW ? `\nFewer than ${FEW} ${w.many}: one ${w.one} moves the shares by 10 points or more` : ''}`}
                />
              )),
            )}
          </div>
        </>
      )}
      {means && (
        <>
          <div className="sum-time-caption">{meanWord} (95% CI)</div>
          <div className="sum-time-plot short">
            {means.ticks.map((t) => (
              <div key={t} className={`sum-time-grid${t === 0 && !means.share ? ' zero' : ''}`} style={{ top: `${((means.hi - t) / (means.hi - means.lo)) * 100}%` }}>
                <span>{tickLabel(t, means.share)}</span>
              </div>
            ))}
            <svg className="sum-time-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              {lineRuns(means.points).map((run, k) => (
                <polyline
                  key={k}
                  points={run.map(({ i, m }) => `${((i + 0.5) / N) * 100},${((means.hi - m) / (means.hi - means.lo)) * 100}`).join(' ')}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
            {means.points.map((p, i) => {
              if (!p) return null;
              const ym = (v: number) => `${((means.hi - v) / (means.hi - means.lo)) * 100}%`;
              const f = means.share ? pct1 : (v: number) => num(v);
              // (A share of yes from its counts, and of the texts with yes or no: ties left out.)
              const y = groups[i].s.yes;
              const value = means.share && y ? `${yesPercent(y)}${y.n < groups[i].s.n ? ` of the ${fmtInt(y.n)} with ${y.word === '1' ? '0 or 1' : 'yes or no'}` : ''}` : f(p.m);
              return (
                <span key={i}>
                  {p.ci && <span className="sum-time-ci" style={{ left: x(i), top: ym(p.ci[1]), height: `calc(${ym(p.ci[0])} - ${ym(p.ci[1])})` }} />}
                  <span
                    className={`sum-time-dot${groups[i].s.n < FEW ? ' few' : ''}`}
                    style={{ left: x(i), top: ym(p.m) }}
                    data-tip={`${groups[i].name}\n${meanWord}: ${value}${p.ci ? `\n95% CI ${ciText(p.ci, f)}` : '\nNo interval below 10'}\n${plural(groups[i].s.n)}${groups[i].s.n < FEW ? ` (fewer than ${FEW})` : ''}`}
                  />
                </span>
              );
            })}
          </div>
        </>
      )}
      <div className="sum-time-axis">
        {/* (On a phone, every other label of these is left out too.) */}
        {groups.map((g, i) =>
          i % every ? null : (
            <span key={i} style={{ left: x(i) }} data-thin={i % (every * 2) ? '' : undefined}>
              {g.tick}
            </span>
          ),
        )}
      </div>
      <div className="sum-time-column">{column}</div>
      {hasStacks && keyFrom && (
        <div className="sum-time-key">{keyFrom.kind === 'categories' ? <Legend s={keyFrom} also={groups.map((g) => g.s)} /> : <ScaleKey s={widestScale ?? keyFrom} />}</div>
      )}
    </div>
  );
}

/** Runs of consecutive points with a value (a period without one breaks the line). */
function lineRuns(points: ({ m: number } | null)[]): { i: number; m: number }[][] {
  const runs: { i: number; m: number }[][] = [];
  let cur: { i: number; m: number }[] = [];
  points.forEach((p, i) => {
    if (p) cur.push({ i, m: p.m });
    else if (cur.length) (runs.push(cur), (cur = []));
  });
  if (cur.length) runs.push(cur);
  return runs.filter((r) => r.length > 1);
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
  const use = axisRows(rows, oneField);
  if (!use.length) return null;
  const share = use[0].s.mean === null;
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
  const ticks = niceTicks(lo, hi, 4);
  const at = (x: number) => ((x - lo) / (hi - lo)) * 100;
  return { ticks: ticks.filter((t) => at(t) >= 0 && at(t) <= 100), at, label: (x) => tickLabel(x, share), share };
}


function Strip({ s, axis, on }: { s: FieldSummary; axis: Axis; on: boolean }) {
  // (A row not on the axis, e.g. a share of yes or a Number field beside the −3…3 means, gets no mark.)
  if (!on) return null;
  const m = axis.share ? s.yes?.share : s.mean;
  if (m === undefined || m === null) return null;
  const ci = axis.share ? s.yes?.ci : s.ci;
  const zero = !axis.share && s.diverging ? axis.at(0) : null;
  const tip = `${s.label}\n${axis.share ? `${s.yes?.word === '1' ? 'Share of 1s' : 'Share of yes'}: ${s.yes ? yesPercent(s.yes) : pct1(m)}` : `Mean: ${num(m)}`}${ci ? `\n95% CI ${ciText(ci, axis.share ? pct1 : (x) => num(x))}` : '\nNo interval below 10'}`;
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
                k={s.yes.word === '1' ? 'Share of 1s' : 'Share of yes'}
                v={yesPercent(s.yes)}
                sub={
                  s.yes.ci || s.yes.n < s.n ? (
                    <>
                      {s.yes.ci && <CiLines ci={s.yes.ci} f={pct1} />}
                      {s.yes.ci && s.yes.n < s.n && <br />}
                      {s.yes.n < s.n && `of the ${fmtInt(s.yes.n)} with ${s.yes.word === '1' ? '0 or 1' : 'yes or no'}`}
                    </>
                  ) : undefined
                }
              />
            ) : s.mean !== null ? (
              <>
                <Tile k="Mean" v={num(s.mean)} sub={s.ci ? <CiLines ci={s.ci} f={(x) => num(x)} /> : 'no interval below 10'} />
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

/** “95% CI” over the interval, which stays on one line. */
function CiLines({ ci, f }: { ci: [number, number]; f: (x: number) => string }) {
  return (
    <>
      95% CI
      <br />
      <span className="sum-nowrap">{ciText(ci, f)}</span>
    </>
  );
}

function kindText(s: FieldSummary): string {
  if (s.kind === 'categories') return s.yes ? 'yes / no' : 'categories';
  if (s.yes) return '0 or 1';
  if (s.kind === 'number') return 'numbers';
  return s.range ? `scale ${scaleLabel(s.range[0])} to ${scaleLabel(s.range[1])}` : 'scale';
}

function Tile({ k, v, sub, wide }: { k: string; v: string; sub?: ReactNode; wide?: boolean }) {
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
        // (Every other edge past 6 bins, always including the last, so the labels stay evenly spaced.)
        (_, i, all) => all.length <= 7 || i % 2 === (all.length - 1) % 2,
      )
    : s.bins.filter((b) => !(b.extra && b.value !== undefined && !Number.isInteger(b.value) && s.kind === 'scale')).map((b) => ({ x: b.value ?? 0, label: b.label }));
  const color = (b: Bin) => (s.kind === 'scale' ? scaleColor(s, b.value ?? 0) : 'var(--sum-seq-2)');
  return (
    <div className="sum-chart" role="img" aria-label={`${s.label}: ${s.bins.map((b) => `${b.label}: ${fmtInt(b.n)}`).join(', ')}${s.mean !== null ? `; mean ${num(s.mean)}` : ''}`}>
      <div className="sum-plot">
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
      {/* The mean: a marker under the axis (a line through the plot would cross the bars' labels). */}
      {s.mean !== null && (
        <div className="sum-mean-row">
          <span className={`sum-mean-at${at(s.mean) > 75 ? ' left' : ''}`} style={{ left: `${at(s.mean)}%` }}>
            <i aria-hidden="true">▲</i> mean {num(s.mean)}
          </span>
        </div>
      )}
    </div>
  );
}

/** Categories: one bar per category, names on the left, in the colors of the bars above (so this is their key). */
function CategoryBars({ s, w }: { s: FieldSummary; w: Words }) {
  const max = Math.max(1, ...s.bins.map((b) => b.n));
  return (
    <div className="sum-cats" role="table" aria-label={s.label}>
      {s.bins.map((b) => (
        <div key={b.key} className={`sum-cat${b.extra ? ' extra' : ''}`} role="row" data-tip={`${b.label}\n${fmtInt(b.n)} ${b.n === 1 ? w.one : w.many} (${pct(b.n, s.n)})`}>
          <span className="sum-cat-name" role="cell" title={b.label}>
            {b.label}
          </span>
          <span className="sum-cat-bar" role="cell">
            <span style={{ width: `${(b.n / max) * 100}%`, background: catColor(s, b) }} />
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

/** Today in the owner's time zone, as 2026-11-06. */
function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * A name for a file: minus signs kept as “minus” and Nordic letters spelled out before the usual slug ("score −3 to −1"
 * → score-minus3-to-minus1, "Kønsroller" → konsroller), so names stay readable and distinct.
 */
export function fileSlug(text: string): string {
  const t = text
    .replace(/[−–]\s*(?=\d)|-(?=\d)/g, 'minus')
    .replace(/[øØ]/g, (c) => (c === 'ø' ? 'o' : 'O'))
    .replace(/[æÆ]/g, (c) => (c === 'æ' ? 'ae' : 'Ae'))
    .replace(/ß/g, 'ss');
  return slug(t);
}

/**
 * The Download menu of a figure: SVG (vector) and PNG (600 dpi) at one column's or the full page's width, and the
 * numbers behind it as CSV. The figures are drawn for print (`src/lib/figure.ts`), not copied from the screen.
 */
function Downloads({ name, svg, csv }: { name: string; svg: (widthMm: number) => string; csv: () => Row[] }) {
  const [busy, setBusy] = useState(false);
  // (The date of the download, in the owner's time zone, taken on the click.)
  const stamp = () => localDate().replace(/-/g, '');
  const save = async (kind: 'svg' | 'png', mm: number) => {
    try {
      setBusy(true);
      const text = svg(mm);
      if (kind === 'svg') download(`${name}_${mm}mm_${stamp()}.svg`, text, 'image/svg+xml');
      else download(`${name}_${mm}mm_${PNG_DPI}dpi_${stamp()}.png`, await svgToPng(text, mm));
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
          <button className="menu-item" onClick={() => (close(), download(`${name}_${stamp()}.csv`, toCsv(...csvColumns(csv())), 'text/csv'))}>
            Numbers, CSV
          </button>
          <div className="menu-note">SVG is vector: sharp at any size. Word and PowerPoint open it; Inkscape and Illustrator can also save it as EPS or PDF.</div>
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
