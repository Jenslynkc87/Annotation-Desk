import { useEffect, useMemo, useState } from 'react';
import { getLog } from '../lib/db';
import { outputFields } from '../lib/prompt';
import { startRun, useStore } from '../lib/store';
import type { Result, ResultLog, Run } from '../lib/types';
import { fmtDateTime, fmtInt } from '../lib/util';
import { buildDocViews, runTitle, type RunFilter } from '../lib/view';
import { Drawer, Icon } from './ui';

export function DocDrawer({
  docId,
  docOrder,
  runFilter,
  onNavigate,
  onClose,
}: {
  docId: string;
  docOrder: string[];
  runFilter: RunFilter;
  onNavigate: (id: string) => void;
  onClose: () => void;
}) {
  const doc = useStore((s) => s.docs.find((d) => d.id === docId));
  const runs = useStore((s) => s.runs);
  const allResults = useStore((s) => s.results);
  const job = useStore((s) => s.job);
  const docResults = useMemo(() => allResults.filter((r) => r.docId === docId), [allResults, docId]);
  const view = useMemo(() => (doc ? buildDocViews([doc], runs, docResults, runFilter).get(doc.id) : undefined), [doc, runs, docResults, runFilter]);
  const [runId, setRunId] = useState<string | null>(null);
  useEffect(() => setRunId(view?.run?.id ?? null), [docId, view?.run?.id]);

  const idx = docOrder.indexOf(docId);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowDown' || e.key === 'j') idx < docOrder.length - 1 && onNavigate(docOrder[idx + 1]);
      if (e.key === 'ArrowUp' || e.key === 'k') idx > 0 && onNavigate(docOrder[idx - 1]);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [idx, docOrder, onNavigate]);

  if (!doc) return null;
  const runsForDoc = runs.filter((r) => docResults.some((x) => x.runId === r.id)).sort((a, b) => b.number - a.number);
  const run = runs.find((r) => r.id === runId) ?? null;
  const reps = run ? docResults.filter((r) => r.runId === run.id).sort((a, b) => a.replicate - b.replicate) : [];

  return (
    <Drawer
      title={<span className="mono">{doc.docId}</span>}
      onClose={onClose}
      actions={
        <>
          <button className="btn small" disabled={!!job} onClick={() => startRun({ docIds: [doc.id], scope: `Test: ${doc.docId}`, forceSync: true })} title="Annotate this text now with the current setup">
            <Icon name="flask" size={14} /> Test this text
          </button>
          <button className="btn small" disabled={idx <= 0} onClick={() => onNavigate(docOrder[idx - 1])} title="Previous (↑)">
            ‹
          </button>
          <button className="btn small" disabled={idx < 0 || idx >= docOrder.length - 1} onClick={() => onNavigate(docOrder[idx + 1])} title="Next (↓)">
            ›
          </button>
        </>
      }
    >
      <section>
        <p className="section-title">Text</p>
        <div className="textblock">{doc.text}</div>
        <div className="hint" style={{ marginTop: 6 }}>
          {fmtInt(doc.text.length)} characters · source: {doc.source}
        </div>
        {Object.keys(doc.meta).length > 0 && (
          <dl className="kv" style={{ marginTop: 10 }}>
            {Object.entries(doc.meta).map(([k, v]) => (
              <FragmentKV key={k} k={k} v={v} />
            ))}
          </dl>
        )}
      </section>

      <section>
        <div className="row" style={{ marginBottom: 10 }}>
          <p className="section-title" style={{ margin: 0 }}>
            Annotation
          </p>
          {runsForDoc.length > 0 && (
            <select className="select small" style={{ width: 'auto', marginLeft: 'auto' }} value={runId ?? ''} onChange={(e) => setRunId(e.target.value)}>
              {runsForDoc.map((r) => (
                <option key={r.id} value={r.id}>
                  Run {runTitle(r)} · prompt v{r.snapshot.promptVersion} · {r.snapshot.model.model}
                </option>
              ))}
            </select>
          )}
        </div>
        {!run && <div className="empty">Not annotated yet.</div>}
        {run && reps.map((r) => <ResultCard key={r.id} run={run} result={r} showRep={reps.length > 1} />)}
      </section>
    </Drawer>
  );
}

function FragmentKV({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v || <span className="hint">—</span>}</dd>
    </>
  );
}

function ResultCard({ run, result: r, showRep }: { run: Run; result: Result; showRep: boolean }) {
  const [log, setLog] = useState<ResultLog | null | undefined>(undefined);
  const fields = outputFields(run.snapshot.prompt);
  const loadLog = async () => setLog((await getLog(r.id)) ?? null);

  return (
    <div className="card card-pad" style={{ marginBottom: 12, boxShadow: 'none' }}>
      <div className="row" style={{ marginBottom: 10 }}>
        {showRep && <span className="badge">Replicate {r.replicate}</span>}
        <span className={`badge ${r.status === 'ok' ? 'ok' : 'err'}`}>{r.status === 'ok' ? 'OK' : 'Error'}</span>
        {r.parseError && <span className="badge warn">{r.parseError}</span>}
        {r.fallback && <span className="badge warn" title="A safety filter declined the request and a fallback model answered">Fallback: {r.fallback}</span>}
        <span className="hint" style={{ marginLeft: 'auto' }}>
          {fmtDateTime(r.completedAt)}
          {r.latencyMs !== null && ` · ${(r.latencyMs / 1000).toFixed(1)} s`}
        </span>
      </div>
      {r.error && <div className="notice err" style={{ marginBottom: 10 }}>{r.error}</div>}
      {r.status === 'ok' && (
        <dl className="kv">
          {fields.map((f) => (
            <FragmentKV key={f} k={f} v={r.values[f] ?? ''} />
          ))}
        </dl>
      )}
      {r.rationale && (
        <>
          <p className="section-title" style={{ marginTop: 14 }}>Rationale</p>
          <div className="textblock">{r.rationale}</div>
        </>
      )}
      {r.reasoningSummary && (
        <details className="more" style={{ marginTop: 10 }}>
          <summary>Reasoning summary</summary>
          <div className="more-body">
            <div className="textblock">{r.reasoningSummary}</div>
          </div>
        </details>
      )}
      <details className="more" style={{ marginTop: 6 }}>
        <summary>Technical details</summary>
        <div className="more-body">
          <dl className="kv">
            <dt>Model (requested)</dt>
            <dd className="mono">{run.snapshot.model.model}</dd>
            <dt>Model (reported)</dt>
            <dd className="mono">{r.modelReported || '—'}</dd>
            <dt>Stop reason</dt>
            <dd>{r.stopReason || '—'}</dd>
            <dt>Tokens in / out</dt>
            <dd>
              {fmtInt(r.usage.inputTokens)} / {fmtInt(r.usage.outputTokens)}
              {r.usage.reasoningTokens > 0 && ` (incl. ${fmtInt(r.usage.reasoningTokens)} reasoning)`}
            </dd>
            <dt>Cache read / write</dt>
            <dd>
              {fmtInt(r.usage.cacheReadTokens)} / {fmtInt(r.usage.cacheWriteTokens)}
            </dd>
            <dt>Response id</dt>
            <dd className="mono">{r.responseId || '—'}</dd>
            <dt>Run</dt>
            <dd>
              {runTitle(run)} · {run.mode === 'batch' ? 'batch' : 'immediate'} · prompt v{run.snapshot.promptVersion} ({run.snapshot.promptHash})
            </dd>
          </dl>
          {r.rawText && (
            <>
              <p className="section-title" style={{ marginTop: 12 }}>Raw model output</p>
              <pre className="textblock mono">{r.rawText}</pre>
            </>
          )}
          {log === undefined ? (
            <button className="linkbtn" style={{ marginTop: 10 }} onClick={loadLog}>
              Show full request and response
            </button>
          ) : log === null ? (
            <div className="hint">No log stored for this result.</div>
          ) : (
            <>
              <p className="section-title" style={{ marginTop: 12 }}>Request (shared part + this text)</p>
              <pre className="textblock mono">{JSON.stringify({ ...run.snapshot.requestBase, ...log.requestPart }, null, 2)}</pre>
              <p className="section-title" style={{ marginTop: 12 }}>Response</p>
              <pre className="textblock mono">{JSON.stringify(log.response, null, 2)}</pre>
            </>
          )}
        </div>
      </details>
    </div>
  );
}
