import { useState } from 'react';
import { buildBackup } from '../lib/export/backup';
import { buildExcel, buildResearchRepo, buildSupplementary, type ExportData } from '../lib/export/packages';
import { goldColumnsFor } from '../lib/export/tables';
import { currentStudy, getState, toast, useStore } from '../lib/store';
import { dateStamp, download, errorMessage, fmtDateTime, slug } from '../lib/util';
import { runTitle } from '../lib/view';
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
  const [runId, setRunId] = useState(withResults[withResults.length - 1]?.id ?? '');
  const run = runs.find((r) => r.id === runId);
  const [busy, setBusy] = useState('');
  const [excelText, setExcelText] = useState(true);
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

  const gold = run && run.snapshot.prompt.outputMode === 'structured' ? run.snapshot.prompt.variables.flatMap((v) => goldColumnsFor(v.name, docs).map((c) => `${v.name} ↔ ${c}`)) : [];
  const study = currentStudy(getState())!;

  return (
    <div className="stack">
      <div className="card card-pad">
        <div>
          <div className="field" style={{ marginBottom: 6, maxWidth: 640 }}>
            <label htmlFor="exp-run">Run to report</label>
            <select id="exp-run" className="select" value={runId} onChange={(e) => setRunId(e.target.value)}>
              {!withResults.length && <option value="">No runs with results yet</option>}
              {[...withResults].reverse().map((r) => (
                <option key={r.id} value={r.id}>
                  Run {runTitle(r)} · {r.scope} · prompt v{r.snapshot.promptVersion} · {r.snapshot.model.model} · {fmtDateTime(r.createdAt)}
                </option>
              ))}
            </select>
          </div>
          <div className="hint">
            Excel and the supplementary package describe this one run (typically your final, full run). The research repository always includes every run.
            {gold.length > 0 && <> Agreement is computed automatically for: {gold.join(', ')}.</>}
          </div>
        </div>
      </div>

      <div className="export-grid">
        <div className="card card-pad export-card">
          <div className="card-head">
            <h2>Excel workbook</h2>
          </div>
          <p className="hint">Results for the chosen run, one row per text, plus per-replicate results, agreement, settings and a run overview.</p>
          <label className="check">
            <input type="checkbox" checked={excelText} onChange={(e) => setExcelText(e.target.checked)} /> Include the texts
          </label>
          <ul className="filelist">
            <li>Results · By replicate · Agreement · Settings · All runs</li>
          </ul>
          <button
            className="btn primary export-btn"
            disabled={!run || !!busy}
            onClick={() =>
              go('excel', async () => {
                const blob = await buildExcel(exportData(), run!, { text: excelText, rationale: true });
                download(`${slug(study.name)}_run${run!.number}_${dateStamp()}.xlsx`, blob);
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
          <ul className="filelist">
            <li>README.md · study.json · study-backup.json</li>
            <li>corpus/ · prompts/vN/ · runs/run-NN/</li>
            <li>results/ · scripts/</li>
          </ul>
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
              Include the texts
              <div className="hint">Off by default: check copyright and privacy before sharing texts publicly.</div>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={supp.includeRationales} onChange={(e) => setSupp({ ...supp, includeRationales: e.target.checked })} /> Include model rationales
          </label>
          <label className="check">
            <input type="checkbox" checked={supp.includeLogs} onChange={(e) => setSupp({ ...supp, includeLogs: e.target.checked })} />
            <span>
              Include raw request/response logs
              <div className="hint">These contain the texts.</div>
            </span>
          </label>
          <ul className="filelist">
            <li>README.md · metadata.json</li>
            <li>prompt/ · results/ · scripts/{supp.includeTexts ? ' · data/' : ''}{supp.includeLogs ? ' · logs/' : ''}</li>
          </ul>
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
            <div className="hint">A single .json file with settings, texts, runs and results. Import it on another computer or browser via Studies → Import.</div>
          </div>
          <button
            className="btn"
            disabled={!!busy}
            onClick={() =>
              go('backup', async () => {
                const d = exportData();
                const b = await buildBackup(d.study, d.docs, d.runs, d.results, true);
                download(`${slug(d.study.name)}_backup_${dateStamp()}.json`, JSON.stringify(b), 'application/json');
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
