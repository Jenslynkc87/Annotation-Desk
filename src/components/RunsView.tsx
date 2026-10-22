import { useEffect, useMemo, useState } from 'react';
import { agreement, fixed, fmtPct, fmtStat, type Agreement, type Level } from '../lib/metrics';
import { combineFields, comparableFields, fieldValue } from '../lib/compare';
import { computeIntervals } from '../lib/intervals';
import type { ReportJob, ReportMessage } from '../lib/report.worker';
import { words } from '../lib/subject';
import { buildComparisonReport } from '../lib/export/packages';
import { effectiveTemplate, normalizeLabel, toNumber } from '../lib/prompt';
import { cachingLabel, goldColumnsFor, knownFieldNames, preferredGoldColumn } from '../lib/export/tables';
import { batchParts, cancelBatch, checkBatch, currentStudy, deleteRunById, getState, isBusy, renameRun, retryableCount, retryFailed, sharedBatches, toast, useStore } from '../lib/store';
import type { Run } from '../lib/types';
import { dateStamp, download, errorMessage, fmtDateTime, fmtInt, slug } from '../lib/util';
import { buildDocViews, runTitle, runTokens } from '../lib/view';
import { Modal } from './ui';

const STATUS_BADGE: Record<Run['status'], string> = {
  running: 'warn',
  submitted: 'warn',
  completed: 'ok',
  cancelled: 'muted',
  failed: 'err',
};

export function RunsView() {
  const runs = useStore((s) => s.runs);
  const results = useStore((s) => s.results);
  const docs = useStore((s) => s.docs);
  const busy = useStore((s) => isBusy(s));
  // While batches are being uploaded (a new run or a retry), runs are not deleted: the upload adds to its run.
  const uploading = useStore((s) => !!s.submitting);
  const [inspect, setInspect] = useState<Run | null>(null);
  const sorted = [...runs].reverse();

  return (
    <div className="stack">
      <div className="card card-pad">
        <div className="card-head">
          <h2>Runs</h2>
          <span className="right">Every run freezes the prompt, model and settings it used.</span>
        </div>
        {!runs.length ? (
          <div className="empty">
            <strong>No runs yet</strong>
            Test your prompt on the Workbench to create the first run.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Label</th>
                  <th>Started</th>
                  <th>Scope</th>
                  <th>Model</th>
                  <th>Prompt</th>
                  <th>Status</th>
                  <th className="num">OK / failed</th>
                  <th className="num">Tokens in / out</th>
                  <th className="num" title="Tokens read from the cache / written to it">Cache read / write</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const t = runTokens(results, r.id, r.replaced);
                  const retry = retryableCount(r, results, docs);
                  return (
                    <tr key={r.id}>
                      <td className="mono">#{r.number}</td>
                      <td>
                        <input
                          className="input small"
                          style={{ width: 150 }}
                          placeholder="Add label…"
                          defaultValue={r.label}
                          onBlur={(e) => e.target.value !== r.label && renameRun(r.id, e.target.value)}
                        />
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.createdAt)}</td>
                      <td>{r.scope}</td>
                      <td className="mono">
                        {r.snapshot.model.model}
                        {r.snapshot.model.effort && <span className="hint"> · {r.snapshot.model.effort}</span>}
                      </td>
                      <td>
                        <span className="badge" title={`hash ${r.snapshot.promptHash}`}>v{r.snapshot.promptVersion}</span>
                        {r.snapshot.options.replicates > 1 && <span className="badge muted" style={{ marginLeft: 4 }}>×{r.snapshot.options.replicates}</span>}
                      </td>
                      <td>
                        <span className={`badge ${STATUS_BADGE[r.status]}`} title={r.error ?? ''}>
                          {r.mode === 'batch' && 'batch · '}
                          {r.status}
                        </span>
                        {r.status === 'submitted' && r.batch && <div className="hint">{r.batch.lastStatus}</div>}
                        {r.error && <div className="hint err" style={{ maxWidth: 260 }}>{r.error}</div>}
                      </td>
                      <td className="num">
                        {t.ok} / {t.failed}
                      </td>
                      <td className="num">
                        {fmtInt(t.input)} / {fmtInt(t.output)}
                      </td>
                      <td className="num">
                        {fmtInt(t.cacheRead)} / {fmtInt(t.cacheWrite)}
                      </td>
                      <td>
                        <div className="row" style={{ flexWrap: 'nowrap' }}>
                          <button className="btn small" onClick={() => setInspect(r)}>
                            Settings
                          </button>
                          {retry > 0 && (
                            <button
                              className="btn small"
                              disabled={busy}
                              title="Re-send the failed (or never sent) requests in this run, with the same frozen settings; new answers replace the failed ones"
                              onClick={() => {
                                // Batch runs retry as a new batch (half price, results later); others right away (full price).
                                const asBatch = r.mode === 'batch';
                                const what = `${retry.toLocaleString()} request${retry === 1 ? '' : 's'} in run #${r.number}`;
                                if (asBatch && !confirm(`Re-send ${what} as a new batch (half price; results usually within an hour, collected into the same run)?`)) return;
                                if (!asBatch && retry > 50 && !confirm(`Re-send ${what} now (immediate requests, full price)?`)) return;
                                void retryFailed(r.id);
                              }}
                            >
                              Retry failed ({retry})
                            </button>
                          )}
                          {r.status === 'submitted' && (
                            <>
                              <button className="btn small" onClick={() => checkBatch(r.id)}>
                                Check
                              </button>
                              <button
                                className="btn small"
                                onClick={async () => {
                                  // A batch a copy of this study (imported from a backup) also waits for stops there too.
                                  const shared = [...new Set((await sharedBatches(r).catch(() => new Map<string, string>())).values())];
                                  const also = shared.length ? ` It is also the batch of ${shared.map((x) => `"${x}"`).join(', ')} (a copy from a backup), which would lose it too.` : '';
                                  if (!confirm(`Cancel this batch at the provider?${also}`)) return;
                                  const why = await cancelBatch(r.id);
                                  toast(why || 'Cancellation requested. Results finished before cancelling will still be collected.', why ? 'error' : 'info');
                                }}
                              >
                                Cancel
                              </button>
                            </>
                          )}
                          <button
                            className="btn small danger"
                            disabled={r.status === 'running' || uploading}
                            onClick={async () => {
                              // A batch that a copy of this study (from a backup) also waits for is left running for that copy.
                              const shared = r.status === 'submitted' ? await sharedBatches(r).catch(() => new Map<string, string>()) : new Map<string, string>();
                              const pending =
                                r.status === 'submitted'
                                  ? shared.size
                                    ? ` Its batch is left running for ${[...new Set(shared.values())].map((x) => `"${x}"`).join(', ')} (a copy from a backup), which collects it.`
                                    : ' The batch is still running at the provider and will be cancelled.'
                                  : '';
                              if (!confirm(`Delete run #${r.number} and its ${t.ok + t.failed} results?${pending} This cannot be undone.`)) return;
                              // A batch that could not be cancelled would go on (and be charged) with nowhere to deliver its results: ask.
                              const why = r.status === 'submitted' ? await cancelBatch(r.id, { keepShared: true }) : '';
                              if (why && !confirm(`${why}\n\nDelete run #${r.number} anyway? A batch still running at the provider may be charged, and its results can't be collected here.`)) return;
                              await deleteRunById(r.id);
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {runs.length > 0 && <AgreementPanel />}

      {inspect && (
        <Modal title={`Run #${inspect.number} settings`} onClose={() => setInspect(null)}>
          <dl className="kv">
            <dt>Provider / model</dt>
            <dd className="mono">
              {inspect.snapshot.model.provider} / {inspect.snapshot.model.model}
            </dd>
            <dt>Prompt version</dt>
            <dd>
              v{inspect.snapshot.promptVersion} <span className="mono hint">({inspect.snapshot.promptHash})</span>
            </dd>
            <dt>Mode</dt>
            <dd>{inspect.mode === 'batch' ? `Batch (${batchParts(inspect).map((p) => p.batchId).join(', ')})` : 'Immediate'}</dd>
            <dt>Caching</dt>
            <dd>{cachingLabel(inspect)}</dd>
            <dt>Annotations per {words(inspect.snapshot.prompt).one}</dt>
            <dd>{inspect.snapshot.options.replicates}</dd>
            {inspect.retries?.length ? (
              <>
                <dt>Retries</dt>
                <dd>{inspect.retries.map((x) => `${x.requests} request${x.requests === 1 ? '' : 's'} re-sent ${fmtDateTime(x.at)}`).join('; ')}</dd>
              </>
            ) : null}
            <dt>App version</dt>
            <dd>{inspect.snapshot.appVersion}</dd>
          </dl>
          <p className="section-title" style={{ marginTop: 16 }}>Prompt (sent with each {words(inspect.snapshot.prompt).one})</p>
          <pre className="textblock">{effectiveTemplate(inspect.snapshot.prompt.userTemplate, inspect.snapshot.prompt.subject)}</pre>
          {inspect.snapshot.prompt.system.trim() && (
            <>
              <p className="section-title" style={{ marginTop: 16 }}>System prompt</p>
              <pre className="textblock">{inspect.snapshot.prompt.system}</pre>
            </>
          )}
          <p className="section-title" style={{ marginTop: 16 }}>Shared request body</p>
          <pre className="textblock mono">{JSON.stringify(inspect.snapshot.requestBase, null, 2)}</pre>
        </Modal>
      )}
    </div>
  );
}

type Source = { kind: 'run'; id: string } | { kind: 'meta'; col: string } | { kind: 'rep'; runId: string; rep: number };

function encode(s: Source): string {
  return s.kind === 'run' ? `run:${s.id}` : s.kind === 'meta' ? `meta:${s.col}` : `rep:${s.runId}:${s.rep}`;
}
function decode(v: string): Source | null {
  const [k, a, b] = v.split(':');
  if (k === 'run' && a) return { kind: 'run', id: a };
  if (k === 'meta' && a !== undefined) return { kind: 'meta', col: v.slice(5) };
  if (k === 'rep' && a && b) return { kind: 'rep', runId: a, rep: Number(b) };
  return null;
}

/** Choice in the Field menu for two label columns that belong to no field: compare their values as they are. */
const NO_FIELD = '\u0000none';

function AgreementPanel() {
  const study = useStore((s) => currentStudy(s))!;
  const w = words({ subject: study.prompt.subject });
  const runs = useStore((s) => s.runs);
  const docs = useStore((s) => s.docs);
  const results = useStore((s) => s.results);
  const metaCols = useMemo(() => [...new Set(docs.flatMap((d) => Object.keys(d.meta)))], [docs]);
  const latest = runs[runs.length - 1];
  const [aPicked, setA] = useState(encode({ kind: 'run', id: latest.id }));
  // Pre-select a label column only when it belongs to a field (e.g. sentiment ↔ sentiment_gold), the clearest first.
  const [bPicked, setB] = useState(() => {
    const first = comparableFields(latest, buildDocViews(docs, runs, results, latest.id).values())[0];
    const col = first ? preferredGoldColumn(first.key, goldColumnsFor(first, docs, knownFieldNames(study, runs))) : undefined;
    return col ? encode({ kind: 'meta', col }) : '';
  });
  // A run picked here may have been deleted since: fall back to the latest run (left) or nothing (right).
  const exists = (v: string) => {
    const s = decode(v);
    return !!s && (s.kind === 'meta' || runs.some((r) => r.id === (s.kind === 'run' ? s.id : s.runId)));
  };
  const a = exists(aPicked) ? aPicked : encode({ kind: 'run', id: latest.id });
  const b = exists(bPicked) ? bPicked : '';
  const srcA = decode(a);
  const runOf = (src: Source | null) =>
    src?.kind === 'run' ? runs.find((r) => r.id === src.id) : src?.kind === 'rep' ? runs.find((r) => r.id === src.runId) : undefined;
  const srcB = decode(b);
  const bothColumns = srcA?.kind === 'meta' && srcB?.kind === 'meta';
  // Either side may be a label column (e.g. two human coders); the field list comes from whichever side is a run
  // (for two label columns: from the latest run, so that their field's scale and level apply, as in the exports).
  const runA = runOf(srcA) ?? runOf(srcB) ?? (bothColumns ? latest : undefined);
  const runB = runOf(srcA) ? runOf(srcB) : undefined;
  // Fields agreement can be computed on (codebook fields, or the numeric scores in JSON answers). Two runs:
  // plain-text scores get the range seen in either run, so it doesn't matter which side is which.
  const fieldsA = useMemo(() => (runA ? comparableFields(runA, buildDocViews(docs, runs, results, runA.id).values()) : []), [runA, docs, runs, results]);
  const fieldsB = useMemo(() => (runB && runB !== runA ? comparableFields(runB, buildDocViews(docs, runs, results, runB.id).values()) : []), [runA, runB, docs, runs, results]);
  const fields = useMemo(() => fieldsA.map((x) => combineFields(x, fieldsB.find((y) => y.key === x.key))), [fieldsA, fieldsB]);
  const known = useMemo(() => knownFieldNames(study, runs, fieldsA.map((x) => x.key)), [study, runs, fieldsA]);
  // Two label columns: the field both belong to by name (e.g. race_gold and race_coder2 → race), unless one is chosen.
  const columnsField = useMemo(
    () =>
      srcA?.kind === 'meta' && srcB?.kind === 'meta'
        ? fields.find((x) => {
            const cols = goldColumnsFor(x, docs, known);
            return cols.includes(srcA.col) && cols.includes(srcB.col);
          })
        : undefined,
    [srcA, srcB, fields, docs, known],
  );
  const [field, setField] = useState('');
  const cf = bothColumns ? (field === NO_FIELD ? undefined : (fields.find((x) => x.key === field) ?? columnsField)) : (fields.find((x) => x.key === field) ?? fields[0]);
  const f = cf?.key ?? '';
  const autoLevel: Level = cf?.level ?? 'nominal';
  const [levelOverride, setLevelOverride] = useState<'' | Level>('');
  const level = levelOverride || autoLevel;
  const [tolerance, setTolerance] = useState(1);

  const yesNo = !!cf?.yesNo;
  const valuesFor = (src: Source | null): Map<string, string> => {
    const out = new Map<string, string>();
    if (!src) return out;
    if (src.kind === 'meta') {
      for (const d of docs) out.set(d.id, normalizeLabel(d.meta[src.col], yesNo));
      return out;
    }
    const run = runOf(src);
    if (!run) return out;
    if (src.kind === 'run') {
      const views = buildDocViews(docs, runs, results, src.id);
      for (const [id, v] of views) if (v.status !== 'none') out.set(id, normalizeLabel(fieldValue(run, v.values, f), yesNo));
    } else {
      for (const r of results)
        if (r.runId === src.runId && r.replicate === src.rep && r.status === 'ok') out.set(r.docId, normalizeLabel(fieldValue(run, r.values, f), yesNo));
    }
    return out;
  };

  const { stats: figures, nLabelled, xs, ys } = useMemo(() => {
    const va = valuesFor(srcA);
    const vb = valuesFor(decode(b));
    // Coverage: texts with a value in the second source (for a run on the left: among that run's texts).
    const runLeft = runOf(srcA);
    const inScope = runLeft ? new Set(runLeft.docIds) : null;
    const xs: string[] = [];
    const ys: string[] = [];
    let nLabelled = 0;
    for (const d of docs) {
      const y = vb.get(d.id);
      if (!y || (inScope && !inScope.has(d.id))) continue;
      nLabelled++;
      const x = va.get(d.id);
      if (x) {
        xs.push(x);
        ys.push(y);
      }
    }
    // The figures at once; the 95% intervals (several seconds on a full corpus) follow from a background worker.
    return { stats: agreement(xs, ys, level, cf?.allowed ?? [], tolerance, { withIntervals: false, scaleSeen: cf?.scaleSeen }), nLabelled, xs, ys };
  }, [a, b, cf, level, yesNo, tolerance, docs, runs, results]);
  // What the intervals depend on: unchanged when results arrive for other runs (e.g. while a run is going).
  const job = useMemo(() => ({ a: xs, b: ys, level, allowed: cf?.allowed ?? [], tolerance, scaleSeen: cf?.scaleSeen }), [xs, ys, level, cf, tolerance]);
  const jobKey = useMemo(() => JSON.stringify(job), [job]);
  const [intervals, setIntervals] = useState<{ key: string; ci: Agreement['ci'] } | null>(null);
  useEffect(() => {
    if (figures.n < 10) return; // too few texts for intervals
    let stop = () => {};
    // A short pause first, so quick changes don't start a job each time.
    const t = setTimeout(() => (stop = computeIntervals(job, (ci) => setIntervals({ key: jobKey, ci }))), 300);
    return () => {
      clearTimeout(t);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobKey]);
  const stats: Agreement = intervals?.key === jobKey ? { ...figures, ci: intervals.ci } : figures;
  const ciPending = figures.n >= 10 && intervals?.key !== jobKey;
  const ciText = (ci: [number, number] | null | undefined, pct = false) => (ciPending ? 'computing 95% CI…' : formatCi(ci, pct));

  const sourceOptions = (allowMeta: boolean) => (
    <>
      <optgroup label="Runs">
        {[...runs].reverse().map((r) => (
          <option key={r.id} value={encode({ kind: 'run', id: r.id })}>
            Run {runTitle(r)} · v{r.snapshot.promptVersion} · {r.snapshot.model.model}
          </option>
        ))}
      </optgroup>
      {runs.some((r) => r.snapshot.options.replicates > 1) && (
        <optgroup label="Single replicates (retest)">
          {[...runs]
            .reverse()
            .filter((r) => r.snapshot.options.replicates > 1)
            .flatMap((r) =>
              Array.from({ length: r.snapshot.options.replicates }, (_, i) => (
                <option key={`${r.id}-${i}`} value={encode({ kind: 'rep', runId: r.id, rep: i + 1 })}>
                  Run {runTitle(r)} · replicate {i + 1}
                </option>
              )),
            )}
        </optgroup>
      )}
      {allowMeta && metaCols.length > 0 && (
        <optgroup label="Metadata columns (e.g. human labels)">
          {metaCols.map((c) => (
            <option key={c} value={encode({ kind: 'meta', col: c })}>
              {c}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );

  // (Two label columns need no run fields: their values are compared as they are.)
  const isFreeText = !bothColumns && !!runA && !fields.length;
  // false, or how far the report has got (e.g. "field 2 of 5").
  const [reporting, setReporting] = useState<string | false>(false);
  const [groupBy, setGroupBy] = useState('');
  // Columns that group texts (e.g. era, journal): a few distinct values, not one per text.
  const groupColumns = useMemo(
    () =>
      metaCols.filter((c) => {
        const n = new Set(docs.map((d) => d.meta[c] ?? '').filter(Boolean)).size;
        return n >= 2 && n <= 30;
      }),
    [metaCols, docs],
  );
  const downloadReport = async () => {
    const ra = runOf(srcA);
    const rb = runOf(decode(b));
    if (!ra || !rb) return;
    // Named now: the page stays usable while the report is built, so another study may be open when it is done.
    const file = `${slug(currentStudy(getState())?.name ?? 'study')}_run${ra.number}_vs_run${rb.number}_${dateStamp()}.xlsx`;
    setReporting('');
    // Built in a background worker, so the page stays responsive (the intervals take minutes on a full corpus).
    // The report doesn't use the texts, so they aren't sent. Without workers, it is built right here.
    const direct = () => buildComparisonReport(ra, rb, docs, runs, results, tolerance, groupBy);
    const job: ReportJob = { runA: ra, runB: rb, docs: docs.map((d) => ({ ...d, text: '' })), runs, results: results.filter((r) => r.runId === ra.id || r.runId === rb.id), tolerance, groupBy };
    const build = () =>
      new Promise<Blob>((resolve, reject) => {
        const fallback = () => direct().then(resolve, reject);
        let w: Worker;
        try {
          w = new Worker(new URL('../lib/report.worker.ts', import.meta.url), { type: 'module' });
        } catch {
          fallback();
          return;
        }
        let started = false;
        w.onmessage = (e: MessageEvent<ReportMessage>) => {
          started = true;
          if ('progress' in e.data) return setReporting(e.data.progress);
          w.terminate();
          if ('blob' in e.data) resolve(e.data.blob);
          else reject(new Error(e.data.error));
        };
        // The worker didn't start (e.g. a browser without module workers): build it here. Failed later: say so.
        w.onerror = (e) => {
          w.terminate();
          if (started) reject(new Error(e.message || 'the background worker stopped'));
          else fallback();
        };
        try {
          w.postMessage(job);
        } catch {
          w.terminate();
          fallback();
        }
      });
    try {
      const blob = await build();
      download(file, blob);
    } catch (e) {
      toast(`Report failed: ${errorMessage(e)}`, 'error');
    } finally {
      setReporting(false);
    }
  };
  // A metadata column where (almost) every row is different is an identifier, not a set of labels. (Not in fewer
  // than 30 rows, e.g. a small pilot whose scores all differ, and not numbers compared as numbers, e.g. 0–100.)
  const bValues = srcB?.kind === 'meta' ? docs.map((d) => d.meta[srcB.col] ?? '') : [];
  const looksLikeIds =
    srcB?.kind === 'meta' &&
    docs.length >= 30 &&
    new Set(bValues).size > docs.length * 0.7 &&
    !(level === 'interval' && bValues.every((v) => v.trim() === '' || Number.isFinite(toNumber(v))));
  const showMatrix = !isFreeText && !looksLikeIds && stats.categories.length > 1 && stats.categories.length <= 12;

  return (
    <div className="card card-pad">
      <div className="card-head">
        <h2>Agreement</h2>
        <span className="right">Compare a run with human labels, another run or replicate, or two human coders with each other.</span>
      </div>
      <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <div className="field">
          <label>Annotations</label>
          <select className="select" value={a} onChange={(e) => setA(e.target.value)}>
            {sourceOptions(true)}
          </select>
        </div>
        <div className="field">
          <label>Compared with</label>
          <select className="select" value={b} onChange={(e) => setB(e.target.value)}>
            <option value="">Choose…</option>
            {sourceOptions(true)}
          </select>
        </div>
        <div className="field">
          <label>{bothColumns ? 'Field (scale and level)' : 'Field'}</label>
          <select className="select" value={bothColumns && !cf ? NO_FIELD : f} onChange={(e) => setField(e.target.value)}>
            {bothColumns && <option value={NO_FIELD}>None: compare the values as they are</option>}
            {fields.map((x) => (
              <option key={x.key} value={x.key}>
                {x.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Level of measurement</label>
          <select className="select" value={levelOverride} onChange={(e) => setLevelOverride(e.target.value as Level | '')}>
            <option value="">Auto ({autoLevel})</option>
            <option value="nominal">Nominal</option>
            <option value="ordinal">Ordinal</option>
            <option value="interval">Interval</option>
          </select>
        </div>
        {level !== 'nominal' && (
          <div className="field">
            <label>Counts as agreeing if within</label>
            <select className="select" value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))}>
              <option value={0}>Exact match only</option>
              <option value={1}>1 point</option>
              <option value={2}>2 points</option>
            </select>
          </div>
        )}
      </div>
      {srcA?.kind === 'run' && srcB?.kind === 'run' && a !== b && (
        <div className="row" style={{ margin: '2px 0 12px' }}>
          <button className="btn small" disabled={reporting !== false} onClick={downloadReport} title="All comparable fields of the two runs in one Excel file, with intervals, systematic differences and draft text for a paper">
            {reporting === false ? 'Download comparison report (Excel)' : `Building…${reporting ? ` ${reporting}` : ''}`}
          </button>
          {groupColumns.length > 0 && (
            <select className="select small" style={{ width: 'auto' }} value={groupBy} onChange={(e) => setGroupBy(e.target.value)} title="Adds a sheet with the same figures per group (exploratory)">
              <option value="">No breakdown</option>
              {groupColumns.map((c) => (
                <option key={c} value={c}>
                  Break down by {c}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {isFreeText ? (
        <div className="notice warn" style={{ marginTop: 6 }}>
          This run has nothing agreement can be computed on: free-text answers would make every distinct answer its own category. Use fields of type
          Category, Ordinal scale, Number or Yes / no (under Output in the setup), or have plain-text answers return their scores as JSON.
        </div>
      ) : looksLikeIds ? (
        <div className="notice warn" style={{ marginTop: 6 }}>
          "{srcB?.kind === 'meta' ? srcB.col : ''}" looks like an identifier (nearly every {w.one} has a different value), not a set of labels. Choose the column that
          holds your human labels.
        </div>
      ) : !b ? (
        <div className="hint">Choose what to compare with. To compare with human labels, import them as a column alongside your {w.many}.</div>
      ) : stats.n === 0 ? (
        <div className="notice warn">No {w.many} have a value in both sources for "{f}".</div>
      ) : (
        <>
          {stats.leftOut.n > 0 && (
            <div className="notice warn" style={{ marginTop: 6 }}>
              {fmtInt(stats.leftOut.n)} {stats.leftOut.n === 1 ? `${w.one} was` : `${w.many} were`} left out because a label isn't a number or is outside the scale:{' '}
              {stats.leftOut.values.map((v) => `“${v}”`).join(', ')}
              {stats.leftOut.values.length === 5 ? ', …' : ''}.
            </div>
          )}
          <Glance stats={stats} w={w} />
          <p className="section-title" style={{ marginTop: 18 }}>Agreement statistics</p>
          <div className="stat-grid" style={{ marginTop: 6 }}>
            <Stat k={`${w.Many} compared`} v={fmtInt(stats.n)} sub={`of ${fmtInt(nLabelled)} with a value in the second source`} />
            <Stat k="Percent agreement" v={fmtPct(stats.percentAgreement)} sub={ciText(stats.ci.percentAgreement, true)} />
            {stats.withinTolerance !== null && stats.tolerance > 0 && (
              <Stat k={`Within ±${stats.tolerance} point${stats.tolerance === 1 ? '' : 's'}`} v={fmtPct(stats.withinTolerance)} sub={ciText(stats.ci.withinTolerance, true)} />
            )}
            <Stat k="Cohen's κ" v={fmtStat(stats.cohenKappa)} sub={ciText(stats.ci.cohenKappa)} />
            {stats.weightedKappaLinear !== null && <Stat k="Weighted κ (linear)" v={fmtStat(stats.weightedKappaLinear)} sub={ciText(stats.ci.weightedKappaLinear)} />}
            {stats.weightedKappa !== null && <Stat k="Weighted κ (quadratic)" v={fmtStat(stats.weightedKappa)} sub={ciText(stats.ci.weightedKappa)} />}
            <Stat k={`Krippendorff's α (${stats.level})`} v={fmtStat(stats.krippendorffAlpha)} sub={ciText(stats.ci.krippendorffAlpha)} />
            <Stat k="Gwet's AC1" v={fmtStat(stats.gwetAC1)} sub={ciText(stats.ci.gwetAC1)} />
            {stats.gwetAC2Linear !== null && <Stat k="Gwet's AC2 (linear)" v={fmtStat(stats.gwetAC2Linear)} sub={ciText(stats.ci.gwetAC2Linear)} />}
            {stats.spearman !== null && <Stat k="Spearman ρ" v={fmtStat(stats.spearman)} />}
            {stats.meanDifference !== null && (
              <Stat k="Mean difference (second − first)" v={fmtStat(stats.meanDifference)} sub={ciText(stats.ci.meanDifference)} />
            )}
            {stats.mae !== null && <Stat k="Mean absolute difference" v={fmtStat(stats.mae)} sub={ciText(stats.ci.mae)} />}
          </div>
          <p className="hint">
            Labels are compared after trimming and lower-casing (yes/true and no/false are treated alike, and for yes/no fields also 1 and 0). {w.Many} missing from either source are left out. Intervals: 95% bootstrap (2,000 resamples of {w.many}). When
            you iterate on prompts, keep a held-out set of labelled {w.many} for the final estimate so the reported agreement isn't inflated by prompt selection.
          </p>
          {showMatrix && (
            <>
              <p className="section-title" style={{ marginTop: 14 }}>Confusion matrix (rows: annotations, columns: compared with)</p>
              <div className="table-wrap" style={{ borderTop: 0 }}>
                <table className="data" style={{ width: 'auto' }}>
                  <thead>
                    <tr>
                      <th />
                      {stats.categories.map((c) => (
                        <th key={c} className="num">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {stats.categories.map((r) => (
                      <tr key={r}>
                        <th>{r}</th>
                        {stats.categories.map((c) => (
                          <td key={c} className="num" style={r === c ? { fontWeight: 650, background: 'var(--ok-bg)' } : stats.confusion[r][c] ? { background: 'var(--err-bg)' } : undefined}>
                            {stats.confusion[r][c] || ''}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

type Words = ReturnType<typeof words>;
const plural = (n: number, w: Words) => `${fmtInt(n)} ${n === 1 ? w.one : w.many}`;
const share = (n: number, total: number) => `${Math.round((n / Math.max(1, total)) * 100)}%`;

/** Plain-language summary: how many texts (entries) got the same answer, how far apart the others are, and the commonest mix-ups. */
function Glance({ stats, w }: { stats: Agreement; w: Words }) {
  const n = stats.n;
  const g = stats.gaps;
  const same = g ? g.same : Math.round((stats.percentAgreement ?? 0) * n);
  const diff = n - same;
  const small = g ? g.secondHigherSmall + g.secondLowerSmall : 0;
  const large = g ? g.secondHigherLarge + g.secondLowerLarge : 0;
  const higher = g ? g.secondHigherSmall + g.secondHigherLarge : 0;
  const lower = g ? g.secondLowerSmall + g.secondLowerLarge : 0;
  const segments = g
    ? [
        { n: same, cls: 'same', label: 'Same answer' },
        { n: small, cls: 'near', label: 'Off by 1' },
        { n: large, cls: 'far', label: 'Off by 2 or more' },
      ]
    : [
        { n: same, cls: 'same', label: 'Same answer' },
        { n: diff, cls: 'far', label: 'Different answer' },
      ];
  const mixups = g
    ? []
    : stats.categories
        .flatMap((a) => stats.categories.filter((b) => b !== a && stats.confusion[a][b] > 0).map((b) => ({ a, b, n: stats.confusion[a][b] })))
        .sort((x, y) => y.n - x.n)
        .slice(0, 3);
  return (
    <div className="glance">
      <p className="section-title" style={{ marginTop: 6 }}>At a glance</p>
      <p className="glance-head">
        <strong>{plural(same, w)}</strong> ({share(same, n)}) got the same answer from both sides
        {diff > 0 ? (
          <>
            ; <strong>{plural(diff, w)}</strong> ({share(diff, n)}) got different answers.
          </>
        ) : (
          '.'
        )}
      </p>
      <div className="glance-bar" role="img" aria-label={segments.map((x) => `${x.label}: ${x.n}`).join(', ')}>
        {segments.map((x) => (
          <div key={x.cls} className={`glance-seg ${x.cls}`} style={{ width: `${(x.n / Math.max(1, n)) * 100}%` }} title={`${x.label}: ${x.n}`} />
        ))}
      </div>
      <div className="glance-legend">
        {segments.map((x) => (
          <span key={x.cls}>
            <i className={`glance-dot ${x.cls}`} /> {x.label}: <strong>{fmtInt(x.n)}</strong> ({share(x.n, n)})
          </span>
        ))}
      </div>
      {g && diff > 0 && (
        <ul className="glance-list">
          <li>
            When they differ, the “Compared with” side gives the <strong>higher</strong> value in {plural(higher, w)} and the <strong>lower</strong> value in{' '}
            {plural(lower, w)}.
          </li>
          {stats.oppositeDirection !== null && stats.midpoint !== null && (
            <li>
              In {plural(Math.round(stats.oppositeDirection * n), w)} ({share(Math.round(stats.oppositeDirection * n), n)}) the two land on opposite sides of the middle of the scale ({stats.midpoint}), i.e. they
              disagree about the direction, not just the degree.
            </li>
          )}
        </ul>
      )}
      {mixups.length > 0 && (
        <ul className="glance-list">
          <li className="glance-title">Most common mix-ups (Annotations → Compared with):</li>
          {mixups.map((m) => (
            <li key={`${m.a}|${m.b}`}>
              “{m.a}” where the other side says “{m.b}”: <strong>{plural(m.n, w)}</strong>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "95% CI 0.71–0.86" (percentages for percent agreement); empty when there are too few texts. */
function formatCi(ci: [number, number] | null | undefined, pct = false): string {
  if (!ci) return '';
  const f = (x: number) => (pct ? `${(x * 100).toFixed(1)}%` : fixed(x, 2));
  return `95% CI ${f(ci[0])}–${f(ci[1])}`;
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
