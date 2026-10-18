import { useMemo, useState } from 'react';
import { fieldLabel, isYesNoField, normalizeLabel, outputFields } from '../lib/prompt';
import { batchPlan, cancelJob, checkBatch, currentStudy, getState, promptFingerprint, removeDocs, startRun, toast, updateStudy, useStore } from '../lib/store';
import type { Doc } from '../lib/types';
import { provider } from '../lib/providers';
import { calibrate, describeEstimate, estimateRun, usePriceOverrides, type Estimate } from '../lib/pricing';
import { sample } from '../lib/util';
import { buildDocViews, runTitle, type RunFilter } from '../lib/view';
import { words, isEntries } from '../lib/subject';
import { CorpusImport } from './CorpusImport';
import { CostEstimate, EstimateLink } from './CostEstimate';
import { DocDrawer } from './DocDrawer';
import { SampleDialog } from './SampleDialog';
import { SetupPanel } from './SetupPanel';
import { Icon, Menu, NumberField } from './ui';

const PAGE = 50;

export function Workbench({ onOpenKeys }: { onOpenKeys: () => void }) {
  return (
    <div className="workbench">
      <SetupPanel onOpenKeys={onOpenKeys} />
      <div className="stack">
        <div className="card card-pad">
          <TextsAndResults />
        </div>
      </div>
    </div>
  );
}

function TextsAndResults() {
  const study = useStore((s) => currentStudy(s))!;
  const w = words(study.prompt);
  const entries = isEntries(study.prompt);
  const docs = useStore((s) => s.docs);
  const runs = useStore((s) => s.runs);
  const results = useStore((s) => s.results);
  const job = useStore((s) => s.job);
  const submitting = useStore((s) => s.submitting);
  const keys = useStore((s) => s.keys);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'done' | 'todo' | 'error' | 'mismatch'>('all');
  // Filter on a metadata column, e.g. sample = validation or era = 1980s ("column␟value"; '' = no filter).
  const [metaFilter, setMetaFilter] = useState('');
  const [sampling, setSampling] = useState(false);
  const [runFilter, setRunFilter] = useState<RunFilter>('latest');
  const [compareCol, setCompareCol] = useState('');
  const [page, setPage] = useState(0);
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const [sampleN, setSampleN] = useState(10);
  const [showEstimate, setShowEstimate] = useState(false);

  const views = useMemo(() => buildDocViews(docs, runs, results, runFilter), [docs, runs, results, runFilter]);
  const metaColumns = useMemo(() => [...new Set(docs.flatMap((d) => Object.keys(d.meta)))], [docs]);
  const filterOptions = useMemo(
    () =>
      metaColumns
        .map((c) => ({ c, values: [...new Set(docs.map((d) => d.meta[c] ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) }))
        .filter((x) => x.values.length >= 1 && x.values.length <= 30),
    [metaColumns, docs],
  );
  // Columns to show: the current prompt's fields, plus any extra fields of the run being viewed.
  const fields = useMemo(() => {
    const f = outputFields(study.prompt);
    const viewedRun = runFilter === 'latest' ? null : runs.find((r) => r.id === runFilter);
    if (viewedRun) for (const x of outputFields(viewedRun.snapshot.prompt)) if (!f.includes(x)) f.push(x);
    return f;
  }, [study.prompt, runFilter, runs]);
  const compareField = fields[0];
  const compareYesNo = isYesNoField(study.prompt, compareField);
  // Display names: look the key up in the current prompt, then in the viewed run's prompt.
  const fieldName = (key: string) => {
    const viewedRun = runFilter === 'latest' ? null : runs.find((r) => r.id === runFilter);
    const inCurrent = study.prompt.variables.some((v) => v.name === key);
    return fieldLabel(inCurrent || !viewedRun ? study.prompt : viewedRun.snapshot.prompt, key);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return docs.filter((d) => {
      const v = views.get(d.id)!;
      if (statusFilter === 'done' && v.status === 'none') return false;
      if (statusFilter === 'todo' && v.status !== 'none') return false;
      if (statusFilter === 'error' && v.status !== 'error' && v.status !== 'partial') return false;
      if (metaFilter) {
        const [col, val] = metaFilter.split('\u001f');
        if (d.meta[col] !== val) return false;
      }
      if (statusFilter === 'mismatch') {
        if (!compareCol || v.status === 'none') return false;
        if (normalizeLabel(v.values[compareField], compareYesNo) === normalizeLabel(d.meta[compareCol], compareYesNo)) return false;
      }
      if (!q) return true;
      return d.docId.toLowerCase().includes(q) || d.text.toLowerCase().includes(q) || Object.values(v.values).some((x) => x.toLowerCase().includes(q));
    });
  }, [docs, views, query, statusFilter, metaFilter, compareCol, compareField, compareYesNo]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE));
  const curPage = Math.min(page, pageCount - 1);
  const pageDocs = filtered.slice(curPage * PAGE, curPage * PAGE + PAGE);
  const pendingBatches = runs.filter((r) => r.status === 'submitted');
  const reps = study.options.replicates;

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allPageSelected = pageDocs.length > 0 && pageDocs.every((d) => selected.has(d.id));

  usePriceOverrides(); // re-estimate when the owner edits a price
  const estimateFor = (ds: Doc[], batch: boolean): Estimate =>
    estimateRun({
      docs: ds,
      prompt: study.prompt,
      model: study.model,
      caching: study.options.caching,
      replicates: reps,
      batch,
      calibration: calibrate(study.model, study.prompt, runs, results, docs),
    });
  // Only the length check is shown all the time; the cost is in the Estimate cost panel.
  const tooLongCount = useMemo(
    () => (docs.length ? estimateFor(docs, false).tooLong.length : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docs, study.prompt, study.model.model, study.model.maxOutputTokens],
  );

  const confirmLarge = (ds: Doc[], batch: boolean) => {
    const est = estimateFor(ds, batch);
    const n = est.requests;
    const long = est.tooLong.length
      ? `\n\n${est.tooLong.length} ${est.tooLong.length === 1 ? `${w.one} is` : `${w.many} are`} probably too long for this model (about ${Math.round((est.window ?? 0) / 1000)}k tokens including the answer), e.g. ${est.tooLong
          .slice(0, 3)
          .map((d) => d.docId)
          .join(', ')}. Those requests will most likely fail.`
      : '';
    // Over the provider's batch limit: say so before anything is sent (it goes out as several batches).
    const plan = batch && n > 50 ? batchPlan(study, ds) : null;
    const split =
      plan && plan.batches > 1
        ? `\n\nThis is about ${Math.round(plan.mb)} MB, more than the ${plan.limitMb} MB ${plan.provider} accepts in one batch, so it will be sent as ${plan.batches} batches in the same run (all at batch price; the results are collected together).`
        : '';
    if (n <= 50 && !long) return true;
    return confirm(
      `${batch ? 'Submit a batch of' : 'Send'} ${n.toLocaleString()} requests to ${study.model.model}${reps > 1 ? ` (${ds.length} ${w.many} × ${reps} runs)` : ''}? Provider charges apply: ${describeEstimate(est)}.${long}${split}`,
    );
  };

  const runDocs = async (ds: Doc[], scope: string, forceSync: boolean) => {
    if (!ds.length) return;
    if (!confirmLarge(ds, study.options.batch && !forceSync)) return;
    await startRun({ docIds: ds.map((d) => d.id), scope, forceSync });
  };

  const remaining = async () => {
    const hash = await promptFingerprint(study);
    const doneIds = new Set(
      getState()
        .results.filter((r) => r.status === 'ok' && runs.find((x) => x.id === r.runId)?.snapshot.promptHash === hash)
        .map((r) => r.docId),
    );
    // Texts still waiting in a batch with this prompt are on their way: sending them again would pay twice.
    const waiting = new Set(runs.filter((r) => r.status === 'submitted' && r.snapshot.promptHash === hash).flatMap((r) => r.docIds));
    const todo = docs.filter((d) => !doneIds.has(d.id) && !waiting.has(d.id));
    const inBatch = docs.filter((d) => !doneIds.has(d.id) && waiting.has(d.id)).length;
    const batchNote = inBatch ? ` ${inBatch.toLocaleString()} ${inBatch === 1 ? `${w.one} is` : `${w.many} are`} still waiting in a batch and left out.` : '';
    if (!todo.length) return alert(`Every ${w.one} already has a result with the current prompt.${batchNote}`);
    if (inBatch) toast(batchNote.trim());
    await runDocs(todo, `Not yet annotated with the current prompt (${todo.length})`, false);
  };

  const testDoc = docs.find((d) => selected.has(d.id)) ?? docs[0];
  const busy = !!job || !!submitting;

  return (
    <>
      <div className="card-head">
        <span className="step">02</span>
        <h2>{w.Many} &amp; results</h2>
        <span className="right">
          {docs.length.toLocaleString()} {docs.length === 1 ? w.one : w.many}
        </span>
      </div>
      <CorpusImport />

      {docs.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="runbar">
            <div className="runbar-group">
              <span className="runbar-label">Try</span>
              <button className="btn primary" disabled={busy || !testDoc} onClick={() => runDocs([testDoc], `Test: ${testDoc.docId}`, true)} title={`Annotate one ${w.one} right away: the first selected ${w.one}, or else the first ${w.one}`}>
                <Icon name="flask" /> Test on 1 {w.one}
              </button>
              <span className="btn-group">
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => runDocs(sample(docs, Math.min(sampleN, docs.length)), `Random sample of ${Math.min(sampleN, docs.length)}`, true)}
                  title="Annotate a random sample right away"
                >
                  <Icon name="play" size={14} /> Random sample of
                </button>
                <NumberField className="input" min={1} aria-label="Sample size" value={sampleN} onChange={setSampleN} />
              </span>
            </div>
            <div className="runbar-group">
              <span className="runbar-label">Run</span>
              <span className="seg compact" role="radiogroup" aria-label="How to run">
                <button role="radio" aria-checked={!study.options.batch} className={!study.options.batch ? 'on' : ''} onClick={() => updateStudy((s) => void (s.options.batch = false))} title="Send the requests now and see results as they arrive">
                  Now
                </button>
                <button role="radio" aria-checked={study.options.batch} className={study.options.batch ? 'on' : ''} onClick={() => updateStudy((s) => void (s.options.batch = true))} title="Submit as a batch: about half the price, results arrive later">
                  Batch · ½ price
                </button>
              </span>
              {selected.size > 0 && (
                <button className="btn" disabled={busy} onClick={() => runDocs(docs.filter((d) => selected.has(d.id)), `Selected texts (${selected.size})`, false)}>
                  Selected ({selected.size})
                </button>
              )}
              <button className="btn" disabled={busy} onClick={() => runDocs(docs, `All ${w.many} (${docs.length})`, false)} title={study.options.batch ? `Submit every ${w.one} as a batch` : `Annotate every ${w.one} now`}>
                All ({docs.length.toLocaleString()})
              </button>
              <button className="btn" disabled={busy} onClick={remaining} title={`Starts a new run with the ${w.many} that have no usable result for the current prompt. To complete a finished run instead, use Retry failed under Runs & agreement.`}>
                Remaining
              </button>
            </div>
          </div>
          {reps > 1 && <div className="hint" style={{ marginTop: 6 }}>Each {w.one} is annotated {reps}× per run.</div>}
          {tooLongCount > 0 && (
            <div className="hint warn" style={{ marginTop: 6 }}>
              {tooLongCount} {tooLongCount === 1 ? `${w.one} is` : `${w.many} are`} probably too long for this model.
            </div>
          )}
          {showEstimate ? <CostEstimate selected={selected} onClose={() => setShowEstimate(false)} /> : <EstimateLink onClick={() => setShowEstimate(true)} />}

          {submitting && !job && <div className="progress-label">{submitting}</div>}
          {job && (
            <div>
              <div className="progress">
                <div style={{ width: `${(job.done / Math.max(1, job.total)) * 100}%` }} />
              </div>
              <div className="progress-label">
                <span>
                  {job.done} of {job.total} requests{job.failed ? ` · ${job.failed} failed` : ''}
                </span>
                <button className="btn small danger" onClick={cancelJob}>
                  <Icon name="stop" size={12} /> Cancel
                </button>
              </div>
            </div>
          )}
          {pendingBatches.map((r) => (
            <div className="notice" key={r.id} style={{ marginTop: 10 }}>
              <div className="row">
                <span>
                  Batch run {runTitle(r)} is processing ({r.batch?.lastStatus ?? 'submitted'}).{' '}
                  {r.batch && keys[r.batch.provider]
                    ? 'Results appear here automatically while this page is open.'
                    : `Not being checked: add your ${r.batch ? provider(r.batch.provider).label : ''} API key to collect the results.`}{' '}
                  Unfinished requests expire 24 hours after submission.
                </span>
                <button className="btn small" style={{ marginLeft: 'auto' }} onClick={() => checkBatch(r.id)}>
                  Check now
                </button>
              </div>
            </div>
          ))}

          <div className="toolbar">
            <input className="input small" style={{ flex: '1 1 180px', maxWidth: 260 }} placeholder={`Search ${w.many} and results…`} value={query} onChange={(e) => (setQuery(e.target.value), setPage(0))} />
            <select className="select small" style={{ width: 'auto' }} value={statusFilter} onChange={(e) => (setStatusFilter(e.target.value as typeof statusFilter), setPage(0))}>
              <option value="all">All {w.many}</option>
              <option value="done">With results</option>
              <option value="todo">Without results</option>
              <option value="error">With errors</option>
              {compareCol && <option value="mismatch">Disagree with {compareCol}</option>}
            </select>
            {filterOptions.length > 0 && (
              <select className="select small" style={{ width: 'auto' }} value={metaFilter} onChange={(e) => (setMetaFilter(e.target.value), setPage(0))} title={`Show only ${w.many} with this metadata value`}>
                <option value="">Any metadata</option>
                {filterOptions.map(({ c, values }) => (
                  <optgroup key={c} label={c}>
                    {values.map((v) => (
                      <option key={v} value={`${c}\u001f${v}`}>
                        {c} = {v}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
            <select className="select small" style={{ width: 'auto' }} value={runFilter} onChange={(e) => (setRunFilter(e.target.value), setPage(0))} title="Which run's results to show">
              <option value="latest">Latest result per {w.one}</option>
              {[...runs].reverse().map((r) => (
                <option key={r.id} value={r.id}>
                  Run {runTitle(r)} · prompt v{r.snapshot.promptVersion}
                </option>
              ))}
            </select>
            {metaColumns.length > 0 && fields.length > 0 && (
              <select className="select small" style={{ width: 'auto' }} value={compareCol} onChange={(e) => setCompareCol(e.target.value)} title={`Compare ${fieldName(compareField)} with a metadata column (e.g. human labels)`}>
                <option value="">Compare with…</option>
                {metaColumns.map((c) => (
                  <option key={c} value={c}>
                    {fieldName(compareField)} vs {c}
                  </option>
                ))}
              </select>
            )}
            <span className="grow" />
            <Menu
              button={(t) => (
                <button className="btn small" onClick={t}>
                  {selected.size ? `${selected.size} selected` : 'Select'} <Icon name="chevron" size={12} />
                </button>
              )}
            >
              {(close) => (
                <>
                  <button className="menu-item" onClick={() => (close(), setSelected(new Set(filtered.map((d) => d.id))))}>
                    Select all {filtered.length.toLocaleString()} shown
                  </button>
                  <button className="menu-item" onClick={() => (close(), setSelected(new Set()))}>
                    Clear selection
                  </button>
                  <button className="menu-item" onClick={() => (close(), setSampling(true))}>
                    Draw a sample…
                  </button>
                  <div className="menu-sep" />
                  <button
                    className="menu-item"
                    style={{ color: 'var(--err)' }}
                    disabled={!selected.size}
                    onClick={() => {
                      close();
                      if (confirm(`Delete ${selected.size} selected ${selected.size === 1 ? w.one : w.many}? Their results stay in past runs but are hidden.`)) {
                        void removeDocs([...selected]);
                        setSelected(new Set());
                      }
                    }}
                  >
                    Delete selected {w.many}
                  </button>
                  <button
                    className="menu-item"
                    style={{ color: 'var(--err)' }}
                    onClick={() => {
                      close();
                      if (confirm(`Delete all ${docs.length} ${w.many} from this study? Runs are kept.`)) void removeDocs(docs.map((d) => d.id));
                    }}
                  >
                    Delete all {w.many}
                  </button>
                </>
              )}
            </Menu>
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 28 }}>
                    <input
                      type="checkbox"
                      className="cbx"
                      aria-label="Select page"
                      checked={allPageSelected}
                      onChange={() =>
                        setSelected((s) => {
                          const n = new Set(s);
                          for (const d of pageDocs) {
                            if (allPageSelected) n.delete(d.id);
                            else n.add(d.id);
                          }
                          return n;
                        })
                      }
                    />
                  </th>
                  <th>ID</th>
                  <th>{entries ? 'Details sent to the model' : 'Text'}</th>
                  {fields.map((f) => (
                    <th key={f}>{fieldName(f)}</th>
                  ))}
                  {compareCol && <th>{compareCol}</th>}
                  <th>Run</th>
                </tr>
              </thead>
              <tbody>
                {pageDocs.map((d) => {
                  const v = views.get(d.id)!;
                  const gold = compareCol ? d.meta[compareCol] ?? '' : '';
                  return (
                    <tr key={d.id} className={`clickable ${selected.has(d.id) ? 'selected' : ''}`} onClick={() => setOpenDoc(d.id)}>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" className="cbx" aria-label={`Select ${d.docId}`} checked={selected.has(d.id)} onChange={() => toggle(d.id)} />
                      </td>
                      <td className="mono" style={{ whiteSpace: 'nowrap' }}>{d.docId}</td>
                      <td>
                        <div className="snippet">{entries ? d.text.split('\n').join(' · ') : d.text.slice(0, 300)}</div>
                      </td>
                      {fields.map((f, i) => {
                        const val = v.values[f] ?? '';
                        const cmp = compareCol && f === compareField && val && gold ? (normalizeLabel(val, compareYesNo) === normalizeLabel(gold, compareYesNo) ? 'match' : 'mismatch') : '';
                        return (
                          <td key={f}>
                            {v.status === 'error' ? (
                              // One badge per failed text, not one per column.
                              i === 0 && <span className="badge err">failed</span>
                            ) : (
                              <span className={`val ${cmp}`} title={v.consistency[f] !== undefined ? `${Math.round(v.consistency[f] * 100)}% of runs agree` : undefined}>
                                {f === 'response' ? <span className="snippet" style={{ fontWeight: 400 }}>{val}</span> : val || (v.status === 'none' ? '' : '—')}
                                {v.consistency[f] !== undefined && v.consistency[f] < 1 && <span className="badge warn" style={{ marginLeft: 6 }}>{Math.round(v.consistency[f] * 100)}%</span>}
                              </span>
                            )}
                          </td>
                        );
                      })}
                      {compareCol && <td className="val">{gold}</td>}
                      <td>
                        {v.run ? (
                          <span className={`badge ${v.status === 'partial' ? 'warn' : 'muted'}`} title={`Run ${runTitle(v.run)} · prompt v${v.run.snapshot.promptVersion} · ${v.run.snapshot.model.model}`}>
                            #{v.run.number} · v{v.run.snapshot.promptVersion}
                          </span>
                        ) : (
                          <span className="hint">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!pageDocs.length && <div className="empty">No texts match.</div>}
          </div>
          <div className="pager">
            <span>
              {filtered.length.toLocaleString()} shown{filtered.length !== docs.length && ` of ${docs.length.toLocaleString()}`}
            </span>
            {pageCount > 1 && (
              <span className="row">
                <button className="btn small" disabled={curPage === 0} onClick={() => setPage(curPage - 1)}>
                  ‹ Prev
                </button>
                Page {curPage + 1} of {pageCount}
                <button className="btn small" disabled={curPage >= pageCount - 1} onClick={() => setPage(curPage + 1)}>
                  Next ›
                </button>
              </span>
            )}
          </div>
        </div>
      )}
      {!docs.length && (
        <div className="empty" style={{ paddingBottom: 10 }}>
          <strong>No {w.many} yet</strong>
          {entries ? 'Add entries above, then test your prompt on a single entry.' : 'Add files or paste text above, then test your prompt on a single text.'}
        </div>
      )}

      {sampling && <SampleDialog onClose={() => setSampling(false)} />}
      {openDoc && (
        <DocDrawer
          docId={openDoc}
          docOrder={filtered.map((d) => d.id)}
          runFilter={runFilter}
          onNavigate={setOpenDoc}
          onClose={() => setOpenDoc(null)}
        />
      )}
    </>
  );
}
