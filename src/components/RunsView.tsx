import { useMemo, useState } from 'react';
import { agreement, fmtPct, fmtStat, type Level } from '../lib/metrics';
import { normalizeLabel, outputFields } from '../lib/prompt';
import { cancelBatch, checkBatch, deleteRunById, renameRun, useStore } from '../lib/store';
import type { Run } from '../lib/types';
import { fmtDateTime, fmtInt } from '../lib/util';
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
                  <th className="num">Cache read</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const t = runTokens(results, r.id);
                  return (
                    <tr key={r.id}>
                      <td className="mono">#{r.number}</td>
                      <td>
                        <input
                          className="input small"
                          style={{ minWidth: 120 }}
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
                      <td className="num">{fmtInt(t.cacheRead)}</td>
                      <td>
                        <div className="row" style={{ flexWrap: 'nowrap' }}>
                          <button className="btn small" onClick={() => setInspect(r)}>
                            Settings
                          </button>
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
                            onClick={() => confirm(`Delete run #${r.number} and its ${t.ok + t.failed} results? This cannot be undone.`) && deleteRunById(r.id)}
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
            <dd>{inspect.snapshot.options.caching ? `On${inspect.snapshot.model.provider === 'anthropic' ? ` (${inspect.snapshot.options.cacheTtl})` : ''}` : 'Off'}</dd>
            <dt>Runs per text</dt>
            <dd>{inspect.snapshot.options.replicates}</dd>
            <dt>App version</dt>
            <dd>{inspect.snapshot.appVersion}</dd>
          </dl>
          <p className="section-title" style={{ marginTop: 16 }}>Instructions</p>
          <pre className="textblock">{inspect.snapshot.prompt.system || '(none)'}</pre>
          <p className="section-title" style={{ marginTop: 16 }}>Message per text</p>
          <pre className="textblock mono">{inspect.snapshot.prompt.userTemplate}</pre>
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
  const [b, setB] = useState(metaCols[0] ? encode({ kind: 'meta', col: metaCols[0] }) : runs.length > 1 ? encode({ kind: 'run', id: runs[runs.length - 2].id }) : '');
  const srcA = decode(a);
  const runA = srcA?.kind === 'run' ? runs.find((r) => r.id === srcA.id) : srcA?.kind === 'rep' ? runs.find((r) => r.id === srcA.runId) : undefined;
  const fields = runA ? outputFields(runA.snapshot.prompt) : [];
  const [field, setField] = useState('');
  const f = fields.includes(field) ? field : fields[0] ?? '';
  const variable = runA?.snapshot.prompt.variables.find((v) => v.name === f);
  const autoLevel: Level = variable?.type === 'ordinal' ? 'ordinal' : variable?.type === 'number' ? 'interval' : 'nominal';
  const [levelOverride, setLevelOverride] = useState<'' | Level>('');
  const level = levelOverride || autoLevel;

  const valuesFor = (src: Source | null): Map<string, string> => {
    const out = new Map<string, string>();
    if (!src) return out;
    if (src.kind === 'meta') {
      for (const d of docs) out.set(d.id, normalizeLabel(d.meta[src.col]));
    } else if (src.kind === 'run') {
      const views = buildDocViews(docs, runs, results, src.id);
      for (const [id, v] of views) if (v.status !== 'none') out.set(id, normalizeLabel(v.values[f]));
    } else {
      for (const r of results) if (r.runId === src.runId && r.replicate === src.rep && r.status === 'ok') out.set(r.docId, normalizeLabel(r.values[f]));
    }
    return out;
  };

  const stats = useMemo(() => {
    const va = valuesFor(srcA);
    const vb = valuesFor(decode(b));
    const xs: string[] = [];
    const ys: string[] = [];
    for (const d of docs) {
      const x = va.get(d.id);
      const y = vb.get(d.id);
      if (x && y) {
        xs.push(x);
        ys.push(y);
      }
    }
    const allowed = variable && (variable.type === 'category' || variable.type === 'ordinal') ? variable.values.map((x) => normalizeLabel(x)).filter(Boolean) : [];
    return agreement(xs, ys, level, allowed);
  }, [a, b, f, level, docs, runs, results]);

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

  const showMatrix = stats.categories.length > 1 && stats.categories.length <= 12;

  return (
    <div className="card card-pad">
      <div className="card-head">
        <h2>Agreement</h2>
        <span className="right">Compare a run with human labels, another run, or another replicate.</span>
      </div>
      <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <div className="field">
          <label>Model annotations</label>
          <select className="select" value={a} onChange={(e) => setA(e.target.value)}>
            {sourceOptions(false)}
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
          <label>Field</label>
          <select className="select" value={f} onChange={(e) => setField(e.target.value)}>
            {fields.map((x) => (
              <option key={x}>{x}</option>
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
      </div>

      {!b ? (
        <div className="hint">Choose what to compare with. To compare with human labels, import them as a column alongside your texts.</div>
      ) : stats.n === 0 ? (
        <div className="notice warn">No texts have a value in both sources for "{f}".</div>
      ) : (
        <>
          <div className="stat-grid" style={{ marginTop: 6 }}>
            <Stat k="Texts compared" v={fmtInt(stats.n)} />
            <Stat k="Percent agreement" v={fmtPct(stats.percentAgreement)} />
            <Stat k="Cohen's κ" v={fmtStat(stats.cohenKappa)} />
            {stats.weightedKappa !== null && <Stat k="Weighted κ (quadratic)" v={fmtStat(stats.weightedKappa)} />}
            <Stat k={`Krippendorff's α (${level})`} v={fmtStat(stats.krippendorffAlpha)} />
            <Stat k="Gwet's AC1" v={fmtStat(stats.gwetAC1)} />
            {stats.spearman !== null && <Stat k="Spearman ρ" v={fmtStat(stats.spearman)} />}
            {stats.mae !== null && <Stat k="Mean abs. error" v={fmtStat(stats.mae)} />}
          </div>
          <p className="hint">
            Labels are compared after trimming and lower-casing (yes/true and no/false are treated alike). Texts missing from either source are left out. When
            you iterate on prompts, keep a held-out set of labelled texts for the final estimate so the reported agreement isn't inflated by prompt selection.
          </p>
          {showMatrix && (
            <>
              <p className="section-title" style={{ marginTop: 14 }}>Confusion matrix (rows: model annotations, columns: compared with)</p>
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

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}
