import { useMemo, useState } from 'react';
import { agreement, fmtPct, fmtStat, type Level } from '../lib/metrics';
import { comparableFields, fieldValue } from '../lib/compare';
import { buildComparisonReport } from '../lib/export/packages';
import { effectiveTemplate, normalizeLabel, outputFields } from '../lib/prompt';
import { cachingLabel, goldColumnsFor } from '../lib/export/tables';
import { cancelBatch, checkBatch, currentStudy, deleteRunById, getState, renameRun, retryableCount, retryFailed, toast, useStore } from '../lib/store';
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
  const busy = useStore((s) => !!s.job);
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
                  const t = runTokens(results, r.id);
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
                              onClick={() => retryFailed(r.id)}
                            >
                              Retry failed ({retry})
                            </button>
                          )}
                          {r.status === 'submitted' && (
                            <>
                              <button className="btn small" onClick={() => checkBatch(r.id)}>
                                Check
                              </button>
                              <button className="btn small" onClick={() => confirm('Cancel this batch at the provider?') && cancelBatch(r.id)}>
                                Cancel
                              </button>
                            </>
                          )}
                          <button
                            className="btn small danger"
                            disabled={r.status === 'running'}
                            onClick={async () => {
                              const pending = r.status === 'submitted' ? ' The batch is still running at the provider and will be cancelled.' : '';
                              if (!confirm(`Delete run #${r.number} and its ${t.ok + t.failed} results?${pending} This cannot be undone.`)) return;
                              if (pending) await cancelBatch(r.id);
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
            <dd>{inspect.mode === 'batch' ? `Batch (${inspect.batch?.batchId ?? ''})` : 'Immediate'}</dd>
            <dt>Caching</dt>
            <dd>{cachingLabel(inspect)}</dd>
            <dt>Runs per text</dt>
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
          <p className="section-title" style={{ marginTop: 16 }}>Prompt (sent with each text)</p>
          <pre className="textblock">{effectiveTemplate(inspect.snapshot.prompt.userTemplate)}</pre>
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

function AgreementPanel() {
  const runs = useStore((s) => s.runs);
  const docs = useStore((s) => s.docs);
  const results = useStore((s) => s.results);
  const metaCols = useMemo(() => [...new Set(docs.flatMap((d) => Object.keys(d.meta)))], [docs]);
  const latest = runs[runs.length - 1];
  const [a, setA] = useState(encode({ kind: 'run', id: latest.id }));
  // Pre-select a metadata column only when its name matches an output field (e.g. sentiment ↔ sentiment_gold).
  const firstField = latest ? outputFields(latest.snapshot.prompt)[0] : '';
  const matching = firstField ? goldColumnsFor(firstField, docs)[0] : undefined;
  const [b, setB] = useState(matching ? encode({ kind: 'meta', col: matching }) : '');
  const srcA = decode(a);
  const runOf = (src: Source | null) =>
    src?.kind === 'run' ? runs.find((r) => r.id === src.id) : src?.kind === 'rep' ? runs.find((r) => r.id === src.runId) : undefined;
  // Either side may be a label column (e.g. two human coders); the field list comes from whichever side is a run.
  const runA = runOf(srcA) ?? runOf(decode(b));
  // Fields agreement can be computed on (codebook fields, or the numeric scores in JSON answers).
  const fields = useMemo(() => (runA ? comparableFields(runA, buildDocViews(docs, runs, results, runA.id).values()) : []), [runA, docs, runs, results]);
  const bothColumns = srcA?.kind === 'meta' && decode(b)?.kind === 'meta';
  const [field, setField] = useState('');
  const cf = fields.find((x) => x.key === field) ?? fields[0];
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

  const { stats, nLabelled } = useMemo(() => {
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
    return { stats: agreement(xs, ys, level, cf?.allowed ?? [], tolerance), nLabelled };
  }, [a, b, f, level, yesNo, tolerance, docs, runs, results]);

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

  const isFreeText = !!runA && !fields.length;
  const [reporting, setReporting] = useState(false);
  const downloadReport = async () => {
    const ra = runOf(srcA);
    const rb = runOf(decode(b));
    if (!ra || !rb) return;
    setReporting(true);
    try {
      const blob = await buildComparisonReport(ra, rb, docs, runs, results, tolerance);
      download(`${slug(currentStudy(getState())?.name ?? 'study')}_run${ra.number}_vs_run${rb.number}_${dateStamp()}.xlsx`, blob);
    } catch (e) {
      toast(`Report failed: ${errorMessage(e)}`, 'error');
    } finally {
      setReporting(false);
    }
  };
  const srcB = decode(b);
  // A metadata column where (almost) every row is different is an identifier, not a set of labels.
  const bDistinct = srcB?.kind === 'meta' ? new Set(docs.map((d) => d.meta[srcB.col] ?? '')).size : 0;
  const looksLikeIds = srcB?.kind === 'meta' && docs.length >= 5 && bDistinct > docs.length * 0.7;
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
        {!bothColumns && (
          <div className="field">
            <label>Field</label>
            <select className="select" value={f} onChange={(e) => setField(e.target.value)}>
              {fields.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </select>
          </div>
        )}
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
        <div style={{ margin: '2px 0 12px' }}>
          <button className="btn small" disabled={reporting} onClick={downloadReport} title="All comparable fields of the two runs in one Excel file, with intervals, systematic differences and draft text for a paper">
            {reporting ? 'Building…' : 'Download comparison report (Excel)'}
          </button>
        </div>
      )}

      {isFreeText ? (
        <div className="notice warn" style={{ marginTop: 6 }}>
          This run has nothing agreement can be computed on: free-text answers would make every distinct answer its own category. Use fields of type
          Category, Ordinal scale, Number or Yes / no (under Output in the setup), or have plain-text answers return their scores as JSON.
        </div>
      ) : looksLikeIds ? (
        <div className="notice warn" style={{ marginTop: 6 }}>
          "{srcB?.kind === 'meta' ? srcB.col : ''}" looks like an identifier (nearly every text has a different value), not a set of labels. Choose the column that
          holds your human labels.
        </div>
      ) : !b ? (
        <div className="hint">Choose what to compare with. To compare with human labels, import them as a column alongside your texts.</div>
      ) : stats.n === 0 ? (
        <div className="notice warn">No texts have a value in both sources for "{f}".</div>
      ) : (
        <>
          <div className="stat-grid" style={{ marginTop: 6 }}>
            <Stat k="Texts compared" v={fmtInt(stats.n)} sub={`of ${fmtInt(nLabelled)} with a value in the second source`} />
            <Stat k="Percent agreement" v={fmtPct(stats.percentAgreement)} sub={ciText(stats.ci.percentAgreement, true)} />
            {stats.withinTolerance !== null && stats.tolerance > 0 && (
              <Stat k={`Within ±${stats.tolerance} point${stats.tolerance === 1 ? '' : 's'}`} v={fmtPct(stats.withinTolerance)} sub={ciText(stats.ci.withinTolerance, true)} />
            )}
            <Stat k="Cohen's κ" v={fmtStat(stats.cohenKappa)} sub={ciText(stats.ci.cohenKappa)} />
            {stats.weightedKappa !== null && <Stat k="Weighted κ (quadratic)" v={fmtStat(stats.weightedKappa)} sub={ciText(stats.ci.weightedKappa)} />}
            <Stat k={`Krippendorff's α (${level})`} v={fmtStat(stats.krippendorffAlpha)} sub={ciText(stats.ci.krippendorffAlpha)} />
            <Stat k="Gwet's AC1" v={fmtStat(stats.gwetAC1)} sub={ciText(stats.ci.gwetAC1)} />
            {stats.spearman !== null && <Stat k="Spearman ρ" v={fmtStat(stats.spearman)} />}
            {stats.meanDifference !== null && (
              <Stat k="Mean difference (second − first)" v={fmtStat(stats.meanDifference)} sub={ciText(stats.ci.meanDifference)} />
            )}
            {stats.mae !== null && <Stat k="Mean absolute difference" v={fmtStat(stats.mae)} sub={ciText(stats.ci.mae)} />}
          </div>
          <p className="hint">
            Labels are compared after trimming and lower-casing (yes/true and no/false are treated alike, and for yes/no fields also 1 and 0). Texts missing from either source are left out. Intervals: 95% bootstrap (2,000 resamples of texts). When
            you iterate on prompts, keep a held-out set of labelled texts for the final estimate so the reported agreement isn't inflated by prompt selection.
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

/** "95% CI 0.71–0.86" (percentages for percent agreement); empty when there are too few texts. */
function ciText(ci: [number, number] | null | undefined, pct = false): string {
  if (!ci) return '';
  const f = (x: number) => (pct ? `${(x * 100).toFixed(1)}%` : x.toFixed(2));
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
