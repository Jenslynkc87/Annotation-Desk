import { useEffect, useMemo, useState } from 'react';
import { endBackground, setBackgroundProgress, startBackground, useBackground, type BackgroundKind, type BuildChoices } from '../lib/background';
import { buildBackup } from '../lib/export/backup';
import { agreementData, agreementHere, buildExcel, buildResearchRepo, buildSupplementary, type AgreementFor, type ExportData } from '../lib/export/packages';
import { labelPairs } from '../lib/export/tables';
import type { AgreementJob, AgreementMessage } from '../lib/report.worker';
import { batchChecksDone, currentStudy, getState, isBusy, toast, useStore } from '../lib/store';
import { dateStamp, download, errorMessage, fmtDateTime, slug } from '../lib/util';
import { words } from '../lib/subject';
import { retryInProgress, runInProgress, runName, runOrder, runTitle } from '../lib/view';
import { Icon } from './ui';

function exportData(): ExportData {
  const s = getState();
  return { study: currentStudy(s)!, docs: s.docs, runs: s.runs, results: s.results };
}

/**
 * The exports' agreement figures, computed in a background worker so the page stays responsive (their bootstrap
 * intervals take minutes on wide numeric scales, e.g. years or counts). It is sent only what agreement reads
 * (`agreementData`: not the texts). Without workers, computed here; the figures are the same either way (fixed seed).
 */
const agreementInWorker: AgreementFor = (d, runs) =>
  new Promise((resolve, reject) => {
    const here = () => agreementHere(d, runs).then(resolve, reject);
    let w: Worker;
    try {
      w = new Worker(new URL('../lib/report.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      here();
      return;
    }
    w.onmessage = (e: MessageEvent<AgreementMessage>) => {
      w.terminate();
      if ('rows' in e.data) resolve(e.data.rows);
      else reject(new Error(e.data.error));
    };
    // (The worker didn't start, e.g. a browser without module workers: computed here.)
    w.onerror = () => {
      w.terminate();
      here();
    };
    const job: AgreementJob = { agreement: { data: agreementData(d), runIds: runs.map((r) => r.id) } };
    try {
      w.postMessage(job);
    } catch {
      w.terminate();
      here();
    }
  });

/** Resolves once the page has shown what changed, so a step's name is on screen before its work blocks the page (at once in a hidden tab, which doesn't paint). */
const painted = () =>
  new Promise<void>((resolve) => {
    if (document.visibilityState !== 'visible') return resolve();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 100);
    requestAnimationFrame(() => setTimeout(done, 0));
  });

/** A build's progress line: the step (e.g. "Writing corpus/corpus.csv"), shown before the step starts. */
const showStep = (step: string) => {
  setBackgroundProgress(step);
  return painted();
};

/** Said while a download that reads stored results and logs as it goes has to wait for a run being sent. */
const SENDING = 'Wait until the run being sent has finished: this download reads the stored results and logs as it goes, so it would hold answers from before and after.';

/** The downloads that read stored results and logs while they are built (the study backup, the research zip, and the
 *  supplementary package with logs); the Excel workbook and the package without logs show the results so far. */
const readsAsItGoes = (kind: BackgroundKind, picked: BuildChoices) => kind === 'backup' || kind === 'research' || (kind === 'supp' && !!picked.supp?.includeLogs);

export function ExportView() {
  const runs = useStore((s) => s.runs);
  const results = useStore((s) => s.results);
  const docs = useStore((s) => s.docs);
  // The download being built (`startBackground`), kept outside this tab: leaving the tab and coming back still shows it
  // (the build goes on meanwhile), and a second one can't start before it is done. Its progress: the step it is on,
  // e.g. the file a zip is writing (a full corpus with logs takes many minutes).
  const building = useBackground();
  const study = useStore((s) => currentStudy(s))!;
  // (One of another study, e.g. its comparison report: every button waits, none says it is building this study's.)
  const otherStudy = building && building.study.id !== study.id ? building.study.name : null;
  const busy = otherStudy !== null ? 'other' : (building?.kind ?? '');
  // Opened again during a build of this study: its run and options are shown, not the defaults (and can't be changed
  // until it is done, so the screen matches what is being built).
  const [choices] = useState<BuildChoices>(() => (building && !otherStudy ? (building.choices ?? {}) : {}));
  const lock = (...kinds: BackgroundKind[]) => (kinds.includes(busy as BackgroundKind) ? { disabled: true, title: 'The download being built uses this choice: it can be changed once the file has been downloaded.' } : {});
  // (In the order the runs were made, as in the exports: of runs that share a number, the one started last comes last.)
  const withResults = [...runs].sort(runOrder).filter((r) => results.some((x) => x.runId === r.id));
  // The run picked; until then the latest finished run with results (else the latest with results, e.g. once the
  // first results arrive while this tab is open). Once shown it stays: a run that is still being sent doesn't take
  // its place when its first results come in.
  const [runId, setRunId] = useState(choices.runId ?? '');
  const run = withResults.find((r) => r.id === runId) ?? [...withResults].reverse().find((r) => !runInProgress(r)) ?? withResults[withResults.length - 1];
  useEffect(() => {
    if (run && run.id !== runId) setRunId(run.id);
  }, [run, runId]);
  const [supp, setSupp] = useState(choices.supp ?? { includeTexts: false, includeRationales: true, includeLogs: false });
  const [researchLogs, setResearchLogs] = useState(choices.researchLogs ?? true);

  const go = async (kind: BackgroundKind, label: string, fn: () => Promise<void>, picked: BuildChoices = {}) => {
    // A download that reads the stored results and logs as it goes waits for a run or Retry failed being sent, so it
    // doesn't hold answers from before and after it.
    if (readsAsItGoes(kind, picked) && isBusy()) {
      toast(SENDING, 'error');
      return;
    }
    // One download is built at a time (a second would compete with the first for memory and leave two files).
    if (!startBackground(kind, label, { id: study.id, name: study.name || 'Untitled' }, picked)) {
      toast('Another download is still being built: try again when it is done.', 'error');
      return;
    }
    try {
      // Batch results of this study being collected right now are stored first (the download reads them as stored;
      // no new collecting starts until it is done).
      await batchChecksDone(study.id);
      // (The download takes the open study's data: another study opened meanwhile would be built instead.)
      if (getState().currentId !== study.id) {
        toast(`Nothing was downloaded: another study was opened before the ${label} of “${study.name || 'Untitled'}” could start. Open that study and download it again.`, 'error');
        return;
      }
      await fn();
    } catch (e) {
      toast(`Export failed: ${errorMessage(e)}`, 'error');
    } finally {
      endBackground();
    }
  };
  const stepLine = (kind: BackgroundKind, extra = '') =>
    busy === kind && (
      <div className="hint">
        {building!.progress || 'Preparing'}…{extra}
      </div>
    );

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
  // A run or Retry failed being sent (or a batch being uploaded) from this page.
  const sending = useStore((s) => isBusy(s));
  const w = words({ subject: useStore((s) => currentStudy(s)!.prompt.subject) });

  return (
    <div className="stack">
      <div className="card card-pad">
        <div>
          <div className="field" style={{ marginBottom: 6, maxWidth: 640 }}>
            <label htmlFor="exp-run">Run to report</label>
            <select id="exp-run" className="select" value={run?.id ?? ''} onChange={(e) => setRunId(e.target.value)} {...lock('excel', 'supp')}>
              {!withResults.length && <option value="">No runs with results yet</option>}
              {[...withResults].reverse().map((r) => (
                <option key={r.id} value={r.id}>
                  Run {runTitle(r, runs)} · {r.scope} · prompt v{r.snapshot.promptVersion} · {r.snapshot.model.model} · {fmtDateTime(r.createdAt)}
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
          {busy === 'report' && <div className="hint">The {building!.label} is being built (Runs &amp; agreement): the downloads below can start once it is done.</div>}
          {otherStudy !== null && (
            <div className="hint">
              The {building!.label} of the study “{otherStudy}” is being built: the downloads below can start once it is done.
            </div>
          )}
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
              go(
                'excel',
                `Excel workbook of run #${runName(run!, runs)}`,
                async () => {
                  const blob = await buildExcel(exportData(), run!, { text: false, rationale: true, agreement: agreementInWorker, onProgress: showStep });
                  download(`${slug(study.name)}_run${runName(run!, runs)}_${dateStamp()}.xlsx`, blob);
                },
                { runId: run!.id },
              )
            }
          >
            <Icon name="download" /> {busy === 'excel' ? 'Building…' : 'Download Excel'}
          </button>
          {stepLine('excel')}
        </div>

        <div className="card card-pad export-card">
          <div className="card-head">
            <h2>Research repository</h2>
          </div>
          <p className="hint">Everything, for your own archive: all runs, all prompt versions, corpus, full request/response logs, results, and a re-importable backup.</p>
          <label className="check">
            <input type="checkbox" checked={researchLogs} onChange={(e) => setResearchLogs(e.target.checked)} {...lock('research')} /> Include full request and response logs
          </label>
          <button
            className="btn primary export-btn"
            disabled={!!busy || sending || (!docs.length && !runs.length)}
            title={sending ? SENDING : undefined}
            onClick={() =>
              go(
                'research',
                'research repository',
                async () => {
                  const { blob, name } = await buildResearchRepo(exportData(), { includeLogs: researchLogs, onProgress: showStep, agreement: agreementInWorker });
                  download(name, blob);
                },
                { researchLogs },
              )
            }
          >
            <Icon name="download" /> {busy === 'research' ? 'Building…' : 'Download .zip'}
          </button>
          {stepLine('research', ' (a full corpus with logs can take half an hour; keep this tab open)')}
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
            <input type="checkbox" checked={supp.includeTexts} onChange={(e) => setSupp({ ...supp, includeTexts: e.target.checked })} {...lock('supp')} />
            <span>
              Include the {w.many}
              <div className="hint">Off by default: check copyright and privacy before sharing {w.many} publicly.</div>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={supp.includeRationales} onChange={(e) => setSupp({ ...supp, includeRationales: e.target.checked })} {...lock('supp')} />
            <span>
              Include the model’s rationale
              <div className="hint">The separate rationale field. Fields of your codebook (e.g. explanations) are annotations and always included.</div>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={supp.includeLogs} onChange={(e) => setSupp({ ...supp, includeLogs: e.target.checked })} {...lock('supp')} />
            <span>
              Include raw request/response logs
              <div className="hint">These contain the {w.many}.</div>
            </span>
          </label>
          <button
            className="btn primary export-btn"
            disabled={!run || !!busy || (sending && supp.includeLogs)}
            title={sending && supp.includeLogs ? SENDING : undefined}
            onClick={() =>
              go(
                'supp',
                `supplementary package of run #${runName(run!, runs)}`,
                async () => {
                  const { blob, name } = await buildSupplementary(exportData(), run!, { ...supp, onProgress: showStep, agreement: agreementInWorker });
                  download(name, blob);
                },
                { runId: run!.id, supp },
              )
            }
          >
            <Icon name="download" /> {busy === 'supp' ? 'Building…' : 'Download .zip'}
          </button>
          {stepLine('supp')}
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
            disabled={!!busy || sending}
            title={sending ? SENDING : undefined}
            onClick={() =>
              go('backup', 'study backup', async () => {
                const d = exportData();
                // (The results as stored: read from the database, not as this page reads them by today's rules.)
                const b = await buildBackup(d.study, d.docs, d.runs, true);
                download(`${slug(d.study.name)}_backup_${dateStamp()}.json`, b);
              })
            }
          >
            <Icon name="download" /> {busy === 'backup' ? 'Building…' : 'Download backup'}
          </button>
        </div>
      </div>
    </div>
  );
}
