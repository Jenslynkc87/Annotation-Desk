import { useEffect, useMemo, useState } from 'react';
import { buildBackup } from '../lib/export/backup';
import { buildExcel, buildResearchRepo, buildSupplementary, type ExportData } from '../lib/export/packages';
import { labelPairs, runName } from '../lib/export/tables';
import { currentStudy, getState, toast, useStore } from '../lib/store';
import { dateStamp, download, errorMessage, fmtDateTime, slug } from '../lib/util';
import { words } from '../lib/subject';
import { retryInProgress, runInProgress } from '../lib/view';
import { Icon } from './ui';

function exportData(): ExportData {
  const s = getState();
  return { study: currentStudy(s)!, docs: s.docs, runs: s.runs, results: s.results };
}

export function ExportView() {
  const runs = useStore((s) => s.runs);
  const results = useStore((s) => s.results);
  const docs = useStore((s) => s.docs);
  const withResults = runs.filter((r) => results.some((x) => x.runId === r.id));
  // The run picked; until then the latest finished run with results (else the latest with results, e.g. once the
  // first results arrive while this tab is open). Once shown it stays: a run that is still being sent doesn't take
  // its place when its first results come in.
  const [runId, setRunId] = useState('');
  const run = withResults.find((r) => r.id === runId) ?? [...withResults].reverse().find((r) => !runInProgress(r)) ?? withResults[withResults.length - 1];
  useEffect(() => {
    if (run && run.id !== runId) setRunId(run.id);
  }, [run, runId]);
  const [busy, setBusy] = useState('');
  const [supp, setSupp] = useState({ includeTexts: false, includeRationales: true, includeLogs: false });
  const [researchLogs, setResearchLogs] = useState(true);

  const go = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast(`Export failed: ${errorMessage(e)}`, 'error');
    } finally {
      setBusy('');
    }
  };

  const study = useStore((s) => currentStudy(s))!;
  // The label columns agreement is computed for (as in the exports: codebook fields, or scores in JSON answers), and
  // the columns named after a field that are not used, with the reason.
  const { gold, skipped } = useMemo(() => {
    if (!run) return { gold: [], skipped: [] };
    const { fields, pairs, skipped } = labelPairs(run, docs, runs, results, study);
    // Each column once, and not one used for another field (gender_role_gold is skipped for gender, used for gender_role).
    const notUsed = new Map<string, string>();
    for (const x of skipped) if (!pairs.some((p) => p.column === x.column) && !notUsed.has(x.column)) notUsed.set(x.column, `${x.column} (${x.reason})`);
    return {
      gold: pairs.map((p) => `${fields.find((f) => f.key === p.field)?.label ?? p.field} ↔ ${p.column}`),
      skipped: [...notUsed.values()],
    };
  }, [run, docs, runs, results, study]);
  // A run still being sent: how far it has got (texts with a usable answer; during Retry failed every text may have a
  // result already, failed ones among them).
  const progress = useMemo(() => {
    if (!run || !runInProgress(run)) return null;
    const present = new Set(docs.map((d) => d.id));
    const usable = new Set(results.filter((x) => x.runId === run.id && x.status === 'ok').map((x) => x.docId));
    const own = run.docIds.filter((id) => present.has(id));
    return { done: own.filter((id) => usable.has(id)).length, total: own.length };
  }, [run, docs, results]);
  const job = useStore((s) => s.job);
  const w = words({ subject: useStore((s) => currentStudy(s)!.prompt.subject) });

  return (
    <div className="stack">
      <div className="card card-pad">
        <div>
          <div className="field" style={{ marginBottom: 6, maxWidth: 640 }}>
            <label htmlFor="exp-run">Run to report</label>
            <select id="exp-run" className="select" value={run?.id ?? ''} onChange={(e) => setRunId(e.target.value)}>
              {!withResults.length && <option value="">No runs with results yet</option>}
              {[...withResults].reverse().map((r) => (
                <option key={r.id} value={r.id}>
                  Run #{runName(r, runs)}
                  {r.label ? ` · ${r.label}` : ''} · {r.scope} · prompt v{r.snapshot.promptVersion} · {r.snapshot.model.model} · {fmtDateTime(r.createdAt)}
                  {runInProgress(r) ? ' · still running' : ''}
                </option>
              ))}
            </select>
          </div>
          {progress && run && (
            <div className="notice warn" style={{ marginBottom: 8, maxWidth: 640 }}>
              {retryInProgress(run) ? 'Retry failed is still sending requests in this run' : run.status === 'submitted' ? 'This run’s batch is still being processed' : 'This run is not finished yet'} (
              {retryInProgress(run) && job?.runId === run.id && `${job.done.toLocaleString('en-US')} of ${job.total.toLocaleString('en-US')} requests done; `}
              {progress.done.toLocaleString('en-US')} of {progress.total.toLocaleString('en-US')} {w.many} have a usable answer so far). Excel and the supplementary package
              show the results so far, and say that the run was not finished.
            </div>
          )}
          <div className="hint">
            Excel and the supplementary package describe this one run (typically your final, full run). The research repository always includes every run.
            {gold.length > 0 && <> Agreement is computed automatically for: {gold.join(', ')}.</>}
            {skipped.length > 0 && <> Not used for agreement: {skipped.join(', ')}.</>}
          </div>
        </div>
      </div>

      <div className="export-grid">
        <div className="card card-pad export-card">
          <div className="card-head">
            <h2>Excel workbook</h2>
          </div>
          <p className="hint">Results for the chosen run, one row per {w.one}, plus per-replicate results, agreement, settings and a run overview.</p>
          <button
            className="btn primary export-btn"
            disabled={!run || !!busy}
            onClick={() =>
              go('excel', async () => {
                const blob = await buildExcel(exportData(), run!, { text: false, rationale: true });
                download(`${slug(study.name)}_run${runName(run!, runs)}_${dateStamp()}.xlsx`, blob);
              })
            }
          >
            <Icon name="download" /> {busy === 'excel' ? 'Building…' : 'Download Excel'}
          </button>
        </div>

        <div className="card card-pad export-card">
          <div className="card-head">
            <h2>Research repository</h2>
          </div>
          <p className="hint">Everything, for your own archive: all runs, all prompt versions, corpus, full request/response logs, results, and a re-importable backup.</p>
          <label className="check">
            <input type="checkbox" checked={researchLogs} onChange={(e) => setResearchLogs(e.target.checked)} /> Include full request and response logs
          </label>
          <button
            className="btn primary export-btn"
            disabled={!!busy || (!docs.length && !runs.length)}
            onClick={() =>
              go('research', async () => {
                const { blob, name } = await buildResearchRepo(exportData(), { includeLogs: researchLogs });
                download(name, blob);
              })
            }
          >
            <Icon name="download" /> {busy === 'research' ? 'Building…' : 'Download .zip'}
          </button>
        </div>

        <div className="card card-pad export-card">
          <div className="card-head">
            <h2>Supplementary repository</h2>
          </div>
          <p className="hint">
            What a journal or OSF/Zenodo deposit needs for the chosen run: metadata, prompt and codebook, results overview, agreement, a draft methods paragraph
            and a reproducible Python script (with a template marking every inserted value).
          </p>
          <label className="check">
            <input type="checkbox" checked={supp.includeTexts} onChange={(e) => setSupp({ ...supp, includeTexts: e.target.checked })} />
            <span>
              Include the {w.many}
              <div className="hint">Off by default: check copyright and privacy before sharing {w.many} publicly.</div>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={supp.includeRationales} onChange={(e) => setSupp({ ...supp, includeRationales: e.target.checked })} />
            <span>
              Include the model’s rationale
              <div className="hint">The separate rationale field. Fields of your codebook (e.g. explanations) are annotations and always included.</div>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={supp.includeLogs} onChange={(e) => setSupp({ ...supp, includeLogs: e.target.checked })} />
            <span>
              Include raw request/response logs
              <div className="hint">These contain the {w.many}.</div>
            </span>
          </label>
          <button
            className="btn primary export-btn"
            disabled={!run || !!busy}
            onClick={() =>
              go('supp', async () => {
                const { blob, name } = await buildSupplementary(exportData(), run!, supp);
                download(name, blob);
              })
            }
          >
            <Icon name="download" /> {busy === 'supp' ? 'Building…' : 'Download .zip'}
          </button>
        </div>
      </div>

      <div className="card card-pad">
        <div className="row">
          <div className="grow">
            <strong>Study backup</strong>
            <div className="hint">A single .json file with settings, {w.many}, runs and results. Import it on another computer or browser via Studies → Import.</div>
          </div>
          <button
            className="btn"
            disabled={!!busy}
            onClick={() =>
              go('backup', async () => {
                const d = exportData();
                // (The results as stored: read from the database, not as this page reads them by today's rules.)
                const b = await buildBackup(d.study, d.docs, d.runs, true);
                download(`${slug(d.study.name)}_backup_${dateStamp()}.json`, b);
              })
            }
          >
            <Icon name="download" /> Download backup
          </button>
        </div>
      </div>
    </div>
  );
}
