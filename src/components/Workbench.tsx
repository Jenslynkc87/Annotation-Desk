import { useEffect, useMemo, useState } from 'react';
import { combineFields, comparableFields, fieldValue, type ComparableField } from '../lib/compare';
import { labelValue, namedField } from '../lib/export/tables';
import { grownScale, isMissingLabel, ratingRange } from '../lib/metrics';
import { fieldLabel, normalizeLabel, outputFields, TEXT_RESPONSE_KEY, toNumber } from '../lib/prompt';
import { batchParts, batchPlan, cancelJob, checkBatch, currentStudy, getState, remainingDocs, removeDocs, startRun, toast, updateStudy, useStore } from '../lib/store';
import type { Doc, PromptSpec, Run, Variable } from '../lib/types';
import { provider } from '../lib/providers';
import { calibrate, describeEstimate, estimateRun, usePriceOverrides, type Estimate } from '../lib/pricing';
import { sample } from '../lib/util';
import { buildDocViews, runName, runTitle, type DocView, type RunFilter } from '../lib/view';
import { words, isEntries } from '../lib/subject';
import { CorpusImport } from './CorpusImport';
import { CostEstimate, EstimateLink, remainingRule } from './CostEstimate';
import { DocDrawer } from './DocDrawer';
import { SampleDialog } from './SampleDialog';
import { SetupPanel } from './SetupPanel';
import { Icon, Menu, NumberField } from './ui';

const PAGE = 50;

type StatusFilter = 'all' | 'done' | 'todo' | 'error' | 'mismatch';

/**
 * The list's filters that still apply: a metadata filter or a "Compare with" column on a column that is gone (e.g.
 * after Remove a column…, or a label sheet that cleared it) or a value no longer offered is dropped, and with the
 * compared column also "Disagree with" it.
 */
export function validFilters(
  f: { metaFilter: string; compareCol: string; statusFilter: StatusFilter },
  filterOptions: { c: string; values: string[] }[],
  metaColumns: string[],
): { metaFilter: string; compareCol: string; statusFilter: StatusFilter } {
  const [col, val] = f.metaFilter.split('\u001f');
  const metaFilter = f.metaFilter && filterOptions.some((o) => o.c === col && o.values.includes(val)) ? f.metaFilter : '';
  const compareCol = f.compareCol && metaColumns.includes(f.compareCol) ? f.compareCol : '';
  const statusFilter = f.statusFilter === 'mismatch' && !compareCol ? 'all' : f.statusFilter;
  return { metaFilter, compareCol, statusFilter };
}

/**
 * Which labels "Disagree with" (and the highlighting) compares, by the Agreement panel's rule (`agreement`): a
 * missing-value marker such as "NA" never; on a scale only numbers on it, with categories only the categories (or
 * a tie of them), unless most labelled pairs fall outside (then the values are compared as they are). Scores in
 * plain-text answers (a `ComparableField` with `scaleSeen`): on the range of the model's answers grown through the
 * labels near it (`grownScale`; any number when the answers go beyond −10…10). `pairs`: the (normalized) model
 * value and label of each text that has both.
 */
export function comparableLabel(field: Variable | ComparableField | undefined, pairs: [string, string][]): (v: string) => boolean {
  let fits: ((v: string) => boolean) | null = null;
  // (On a scale or numeric codes, as in `agreement`: a number off it is always left out; only mostly words are compared as they are.)
  let onNumbers = false;
  if (field && 'key' in field) {
    if (field.scaleSeen) {
      onNumbers = true;
      const r = field.range;
      const values = pairs.flat().map(toNumber).filter(Number.isFinite);
      const [lo, hi] = ratingRange(r) ? grownScale(r, values) : [-Infinity, Infinity];
      fits = (v) => Number.isFinite(toNumber(v)) && toNumber(v) >= lo - 1e-9 && toNumber(v) <= hi + 1e-9;
    }
  } else if (field?.type === 'ordinal' || field?.type === 'number') {
    onNumbers = true;
    const scale = field.type === 'ordinal' ? field.values.map((x) => toNumber(x)).filter(Number.isFinite) : [];
    const lo = scale.length >= 2 ? Math.min(...scale) : -Infinity;
    const hi = scale.length >= 2 ? Math.max(...scale) : Infinity;
    fits = (v) => Number.isFinite(toNumber(v)) && toNumber(v) >= lo - 1e-9 && toNumber(v) <= hi + 1e-9;
  } else if (field?.type === 'category' || field?.type === 'boolean') {
    const cats = new Set(field.type === 'boolean' ? ['false', 'true'] : field.values.map((x) => normalizeLabel(x)).filter(Boolean));
    const codes = [...cats].map(toNumber);
    if (field.type === 'category' && cats.size >= 2 && codes.every(Number.isFinite)) {
      // Categories that are all numbers (e.g. codes 1 to 5) are judged on their range, as in `agreement`: a value
      // between two codes is compared, a number off the range (e.g. 99) is not.
      const [lo, hi] = [Math.min(...codes), Math.max(...codes)];
      const inRange = (v: string) => Number.isFinite(toNumber(v)) && toNumber(v) >= lo - 1e-9 && toNumber(v) <= hi + 1e-9;
      fits = (v) => inRange(v) || (v.includes(' | ') && v.split(' | ').every(inRange));
      onNumbers = true;
    } else if (cats.size >= 2) fits = (v) => cats.has(v) || (v.includes(' | ') && v.split(' | ').every((x) => cats.has(x)));
  }
  if (!fits) return (v) => !isMissingLabel(v);
  const onScale = fits;
  const missing = (v: string) => !onScale(v) && isMissingLabel(v);
  const labelled = pairs.filter(([x, y]) => !missing(x) && !missing(y));
  const kept = labelled.filter(([x, y]) => onScale(x) && onScale(y)).length;
  const isNumber = (v: string) => Number.isFinite(toNumber(v));
  const strict = onNumbers ? labelled.filter(([x, y]) => !isNumber(x) || !isNumber(y)).length * 2 <= labelled.length : kept > 0 && kept >= labelled.length / 2;
  return (v) => !missing(v) && (!strict || onScale(v));
}

/**
 * The codebook fields (not free text) "Compare with" can compare, each with the prompt it comes from: those of the
 * viewed run, if it is structured; in "Latest result per text", the current prompt's (if structured), then those of the
 * structured runs shown, newest first.
 */
export function codebookFields(viewedRun: Run | null, prompt: PromptSpec, views: Iterable<DocView>, runs: Run[]): Map<string, PromptSpec> {
  let prompts: PromptSpec[] = [];
  if (viewedRun) {
    if (viewedRun.snapshot.prompt.outputMode === 'structured') prompts = [viewedRun.snapshot.prompt];
  } else {
    const shown = new Set<string>();
    for (const v of views) if (v.run?.snapshot.prompt.outputMode === 'structured') shown.add(v.run.id);
    prompts = [...(prompt.outputMode === 'structured' ? [prompt] : []), ...runs.filter((r) => shown.has(r.id)).reverse().map((r) => r.snapshot.prompt)];
  }
  const out = new Map<string, PromptSpec>();
  for (const p of prompts)
    for (const key of outputFields(p)) {
      const v = p.variables.find((x) => x.name === key);
      if (v && v.type !== 'text' && !out.has(key)) out.set(key, p);
    }
  return out;
}

/**
 * What "Compare with <column>" compares, the same rule for both kinds of run: the field the column is named after
 * (race for race_gold, `namedField`), else the first, among the scores in plain-text JSON answers (`scoreFields`) and
 * the codebook fields shown (`codebookFields`); with the score's range or the codebook's variable (its scale, and
 * whether it is a yes/no field), taken from the run's own prompt. `fallback`: with neither, e.g. a plain-text answer.
 */
export function compareFieldFor(
  col: string,
  scoreFields: ComparableField[],
  codebook: Map<string, PromptSpec>,
  fallback: string,
): { key: string; field?: ComparableField; variable?: Variable; yesNo: boolean } {
  const keys = [...scoreFields.map((f) => f.key), ...codebook.keys()];
  const key = namedField(col, keys) ?? keys[0] ?? fallback;
  const field = scoreFields.find((f) => f.key === key);
  if (field) return { key, field, yesNo: false };
  const variable = codebook.get(key)?.variables.find((v) => v.name === key);
  return { key, variable, yesNo: variable?.type === 'boolean' };
}

/**
 * The batch notice's sentence about an upload of unknown outcome: when Retry failed, which looks for it first, is
 * offered (once the run's batches have ended and what they returned is saved: the results, or only the run's record).
 */
export function unknownUploadNote(running: number, notSaved: number, recordOnly: boolean): string {
  const until = [
    running ? (running > 1 ? 'these batches have ended' : 'this batch has ended') : '',
    notSaved ? (recordOnly ? 'the run’s record of its results is saved' : 'these results are saved') : '',
  ]
    .filter(Boolean)
    .join(' and ');
  return ` Another batch upload of this run may or may not have reached the provider. Retry failed (under Runs & agreement), which looks for it there first, is offered once ${until}; Delete looks for it too, and cancels it if found.`;
}

/**
 * The runs `remainingDocs` names by number, by their names (`runName`, with the study's `runs`): of runs that share a
 * number (two tabs of an earlier version), the one with an upload of unknown outcome. (A name is kept as it is.)
 */
export function unknownRunNames(unknownRuns: (number | string)[], runs: Run[]): (number | string)[] {
  return [
    ...new Set(
      unknownRuns.flatMap((n) => {
        if (typeof n !== 'number') return [n];
        const same = runs.filter((r) => r.number === n);
        const unsure = same.filter((r) => r.batch?.uploadUnknown || r.batch?.uploading);
        return (unsure.length ? unsure : same).map((r) => runName(r, runs)).concat(same.length ? [] : [n]);
      }),
    ),
  ];
}

/** What the Remaining button leaves out, said when it is clicked (`remainingDocs`'s `waiting`, `unknown` and `unknownRuns`). */
export function remainingNotes(
  r: { waiting: number; unknown: number; unknownRuns: (number | string)[] },
  w: { one: string; many: string },
  allRuns: Run[] = [],
): { waiting: string; unknown: string } {
  const are = (n: number) => `${n.toLocaleString()} ${n === 1 ? `${w.one} is` : `${w.many} are`}`;
  const names = unknownRunNames(r.unknownRuns, allRuns);
  const runs = `run${names.length === 1 ? '' : 's'} ${names.map((n) => `#${n}`).join(', ')}`;
  return {
    waiting: r.waiting ? `${are(r.waiting)} still waiting in a batch and left out.` : '',
    unknown: r.unknown
      ? `${are(r.unknown)} left out: ${r.unknown === 1 ? 'it is' : 'they are'} in ${runs}, whose batch upload may have reached the provider. Retry failed on ${runs} (under Runs & agreement) looks for that batch at the provider first, so it isn't paid for twice.`
      : '',
  };
}

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
  const [statusPicked, setStatusFilter] = useState<StatusFilter>('all');
  // Filter on a metadata column, e.g. sample = validation or era = 1980s ("column␟value"; '' = no filter).
  const [metaPicked, setMetaFilter] = useState('');
  const [sampling, setSampling] = useState(false);
  const [runFilter, setRunFilter] = useState<RunFilter>('latest');
  const [comparePicked, setCompareCol] = useState('');
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
  // A filter or comparison on a column that is gone no longer applies, and is cleared (so it doesn't come back
  // if a column of that name is added again).
  const { metaFilter, compareCol, statusFilter } = validFilters({ metaFilter: metaPicked, compareCol: comparePicked, statusFilter: statusPicked }, filterOptions, metaColumns);
  useEffect(() => {
    if (metaFilter !== metaPicked) setMetaFilter(metaFilter);
    if (compareCol !== comparePicked) setCompareCol(compareCol);
    if (statusFilter !== statusPicked) setStatusFilter(statusFilter);
  }, [metaFilter, metaPicked, compareCol, comparePicked, statusFilter, statusPicked]);
  // Columns to show: the current prompt's fields, plus any extra fields of the run being viewed.
  const fields = useMemo(() => {
    const f = outputFields(study.prompt);
    const viewedRun = runFilter === 'latest' ? null : runs.find((r) => r.id === runFilter);
    if (viewedRun) for (const x of outputFields(viewedRun.snapshot.prompt)) if (!f.includes(x)) f.push(x);
    return f;
  }, [study.prompt, runFilter, runs]);
  const viewedRun = runFilter === 'latest' ? null : (runs.find((r) => r.id === runFilter) ?? null);
  // Codebook fields that can be compared with a column: the viewed run's, or in "Latest" the current prompt's and those
  // of the structured runs shown.
  const codebook = useMemo(() => codebookFields(viewedRun, study.prompt, views.values(), runs), [viewedRun, study.prompt, views, runs]);
  // Display names: look the key up in the current prompt, then in the viewed run's prompt (or the prompt of a structured
  // run shown).
  const promptOf = (key: string) => {
    const inCurrent = study.prompt.variables.some((v) => v.name === key);
    return inCurrent ? study.prompt : (codebook.get(key) ?? viewedRun?.snapshot.prompt ?? study.prompt);
  };
  const fieldName = (key: string) => fieldLabel(promptOf(key), key);
  // Plain-text runs whose answers are JSON (the owner's layout): their scores, read inside the answers, as in the
  // Agreement panel (`comparableFields`). Those of the run being viewed; in "Latest result per text" with a plain-text
  // prompt, those of the plain-text runs shown (their ranges joined, as for two runs in the panel).
  const scoreFields = useMemo(() => {
    const textRuns = viewedRun
      ? viewedRun.snapshot.prompt.outputMode === 'text'
        ? [viewedRun]
        : []
      : study.prompt.outputMode === 'text'
        ? [...new Set([...views.values()].map((v) => v.run).filter((r): r is Run => !!r && r.snapshot.prompt.outputMode === 'text'))]
        : [];
    const byKey = new Map<string, ComparableField>();
    for (const run of textRuns) for (const f of comparableFields(run, views.values())) byKey.set(f.key, combineFields(f, byKey.get(f.key)));
    return [...byKey.values()];
  }, [viewedRun, study.prompt.outputMode, views]);
  // The field compared with a column (`compareFieldFor`): the one the column is named after (race for race_gold), else
  // the first, among the plain-text scores and the codebook fields shown.
  const fieldFor = (col: string) => compareFieldFor(col, scoreFields, codebook, fields[0]);
  const { key: compareField, field: scoreField, variable: compareVar, yesNo: compareYesNo } = fieldFor(compareCol);
  // The compared field gets a column of its own where none shows it (e.g. a structured run's score in "Latest" under a
  // plain-text prompt), so its value can be seen and marked.
  const shownFields = compareCol && codebook.has(compareField) && !fields.includes(compareField) ? [...fields, compareField] : fields;
  // The compared value of a text, read inside the JSON answer for a plain-text run (also under a structured prompt).
  const modelValue = (v: DocView) =>
    normalizeLabel(compareField === TEXT_RESPONSE_KEY || !v.run ? (v.values[compareField] ?? '') : fieldValue(v.run, v.values, compareField), compareYesNo);
  // A label: for scores, a missing-value marker such as "NA" is a blank cell (`labelValue`), as in the panel.
  const labelOf = (d: Doc) => (scoreField ? labelValue(d.meta[compareCol], scoreField) : normalizeLabel(d.meta[compareCol], compareYesNo));
  // Labels the comparison leaves out, as the Agreement panel does (e.g. "NA", or a number off the scale).
  const comparable = useMemo(() => {
    const pairs: [string, string][] = [];
    if (compareCol)
      for (const d of docs) {
        const v = views.get(d.id)!;
        const val = modelValue(v);
        const gold = labelOf(d);
        if (v.status !== 'none' && v.status !== 'error' && val && gold) pairs.push([val, gold]);
      }
    return comparableLabel(scoreField ?? compareVar, pairs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs, views, compareCol, compareField, compareYesNo, compareVar, scoreField]);

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
        // Only texts with both a model value and a label (as the highlighted cells), not every unlabelled one, and
        // not those whose label the comparison leaves out (e.g. "NA").
        const val = modelValue(v);
        const gold = labelOf(d);
        if (!compareCol || v.status === 'none' || v.status === 'error' || !val || !gold || val === gold || !comparable(val) || !comparable(gold)) return false;
      }
      if (!q) return true;
      return d.docId.toLowerCase().includes(q) || d.text.toLowerCase().includes(q) || Object.values(v.values).some((x) => x.toLowerCase().includes(q));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs, views, query, statusFilter, metaFilter, compareCol, compareField, compareYesNo, comparable, scoreField]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE));
  const curPage = Math.min(page, pageCount - 1);
  const pageDocs = filtered.slice(curPage * PAGE, curPage * PAGE + PAGE);
  const pendingBatches = runs.filter((r) => r.status === 'submitted');
  const reps = study.options.replicates;

  // Texts deleted (e.g. with Delete all) leave the selection, so "Selected" never counts texts that are gone.
  useEffect(() => {
    const present = new Set(docs.map((d) => d.id));
    setSelected((s) => ([...s].every((id) => present.has(id)) ? s : new Set([...s].filter((id) => present.has(id)))));
  }, [docs]);

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
        ? `\n\nThis is ${plan.bySize ? `about ${Math.round(plan.mb)} MB, more than ${plan.provider} accepts in one batch (${plan.limitMb} MB, of which this app uses at most 95%)` : `${plan.requests.toLocaleString()} requests, more than ${plan.provider} accepts in one batch (${plan.limitRequests.toLocaleString()})`}, so it will be sent as ${plan.batches} batches in the same run (all at batch price; the results are collected together).`
        : '';
    if (n <= 50 && !long) return true;
    return confirm(
      `${batch ? 'Submit a batch of' : 'Send'} ${n.toLocaleString()} requests to ${study.model.model}${reps > 1 ? ` (${ds.length.toLocaleString()} ${w.many} × ${reps} annotations)` : ''}? Provider charges apply: ${describeEstimate(est)}.${long}${split}`,
    );
  };

  const runDocs = async (ds: Doc[], scope: string, forceSync: boolean) => {
    if (!ds.length) return;
    if (!confirmLarge(ds, study.options.batch && !forceSync)) return;
    await startRun({ docIds: ds.map((d) => d.id), scope, forceSync });
  };

  const remaining = async () => {
    // Texts still waiting in a batch with this prompt, model and effort are on their way, and those in a batch upload
    // whose outcome is unknown may be: sending them again would pay twice.
    const r = remainingDocs(study, docs, runs, getState().results);
    const { todo, waiting, unknown } = r;
    // (By name: runs that share a number are told apart.)
    const notes = remainingNotes({ ...r, unknownRuns: r.unknownRunNames }, w, runs);
    if (!todo.length) {
      const or = [waiting ? ', or is waiting in a batch' : '', unknown ? ', or is in a batch upload whose outcome is unknown' : ''].join('');
      return alert(
        or
          ? `Every ${w.one} has a result with the current prompt, model and effort${or}. ${[notes.waiting, notes.unknown].filter(Boolean).join(' ')}`
          : `Every ${w.one} already has a result with the current prompt, model and effort.`,
      );
    }
    if (waiting) toast(notes.waiting);
    // (Stays until dismissed: those texts are not sent, and the way to send them is elsewhere.)
    if (unknown) toast(notes.unknown, 'info', true);
    await runDocs(todo, `Not yet annotated with the current prompt, model and effort (${todo.length})`, false);
  };

  const testDoc = docs.find((d) => selected.has(d.id)) ?? docs[0];
  const busy = !!job || !!submitting;
  // The progress of a run and its Cancel button, shown whatever else is on the page.
  const progress = (
    <>
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
    </>
  );

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
                <button className="btn" disabled={busy} onClick={() => runDocs(docs.filter((d) => selected.has(d.id)), `Selected ${w.many} (${selected.size})`, false)}>
                  Selected ({selected.size})
                </button>
              )}
              <button className="btn" disabled={busy} onClick={() => runDocs(docs, `All ${w.many} (${docs.length})`, false)} title={study.options.batch ? `Submit every ${w.one} as a batch` : `Annotate every ${w.one} now`}>
                All ({docs.length.toLocaleString()})
              </button>
              <button className="btn" disabled={busy} onClick={remaining} title={`Starts a new run with the ${remainingRule(w)}. To complete a finished run instead, use Retry failed under Runs & agreement.`}>
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

          {progress}
          {pendingBatches.map((r) => {
            // Batches that ended but whose results could not be saved are not checked again until the owner asks.
            const waiting = batchParts(r).filter((p) => p.status === 'submitted');
            const notSaved = waiting.filter((p) => p.saveFailed).length;
            // (Results stored, but not the run's record of them: say so, not that the results were lost.)
            const recordOnly = notSaved > 0 && waiting.filter((p) => p.saveFailed).every((p) => p.resultsSaved);
            const running = waiting.filter((p) => !p.saveFailed);
            // A batch of the run being uploaded from this page (its first, or a Retry failed's) has not ended: it
            // just hasn't been accepted yet.
            const uploading = !!r.batch?.uploading && !running.length;
            return (
              <div className="notice" key={r.id} style={{ marginTop: 10 }}>
                <div className="row">
                  <span>
                    {running.length
                      ? `Batch run ${runTitle(r, runs)} is processing (${running.map((p) => p.lastStatus).join('; ') || 'submitted'}). `
                      : uploading
                        ? `Batch run ${runTitle(r, runs)}: a batch is being uploaded (see above). `
                        : `Batch run ${runTitle(r, runs)} has ended. `}
                    {notSaved
                      ? recordOnly
                        ? `${running.length ? `The results of ${notSaved === 1 ? 'a batch that ended were' : `${notSaved} batches that ended were`}` : 'Its results were'} saved, but the run’s record of them could not be: free some space, then click Check now.`
                        : `${running.length ? `The results of ${notSaved === 1 ? 'a batch that ended' : `${notSaved} batches that ended`}` : 'Its results'} could not be saved: free some space, then click Check now.`
                      : r.batch && keys[r.batch.provider]
                        ? `${uploading ? 'Once the provider has accepted it, results' : 'Results'} appear here automatically while this page is open.`
                        : `Not being checked: add your ${r.batch ? provider(r.batch.provider).label : ''} API key to collect the results.`}{' '}
                    {running.length > 0 && 'Unfinished requests expire 24 hours after submission.'}
                    {/* Retry failed, which looks for such an upload at the provider first, is offered only once the run's batches have ended and are saved. */}
                    {r.batch?.uploadUnknown && (running.length > 0 || notSaved > 0) && unknownUploadNote(running.length, notSaved, recordOnly)}
                  </span>
                  <button className="btn small" style={{ marginLeft: 'auto' }} onClick={() => checkBatch(r.id)}>
                    Check now
                  </button>
                </div>
              </div>
            );
          })}

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
                  Run {runTitle(r, runs)} · prompt v{r.snapshot.promptVersion}
                </option>
              ))}
            </select>
            {metaColumns.length > 0 && fields.length > 0 && (
              <select
                className="select small"
                style={{ width: 'auto' }}
                value={compareCol}
                onChange={(e) => setCompareCol(e.target.value)}
                title={`Compare ${scoreFields.length + codebook.size > 1 ? 'a field (the one a column is named after, else the first)' : fieldName(compareField)} with a metadata column (e.g. human labels)`}
              >
                <option value="">Compare with…</option>
                {metaColumns.map((c) => (
                  <option key={c} value={c}>
                    {fieldName(fieldFor(c).key)} vs {c}
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
                  {busy && <div className="menu-note">A run is in progress: delete {w.many} when it has finished.</div>}
                  <button
                    className="menu-item"
                    style={{ color: 'var(--err)' }}
                    disabled={!selected.size || busy}
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
                    disabled={busy}
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
                  {shownFields.map((f) => (
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
                  // The compared value and label, and the cell that shows the value (a plain-text run's whole answer
                  // when its score has no column of its own).
                  const [nv, ng] = compareCol ? [modelValue(v), labelOf(d)] : ['', ''];
                  const cmp = nv && ng && comparable(nv) && comparable(ng) ? (nv === ng ? 'match' : 'mismatch') : '';
                  const cmpCell = v.run?.snapshot.prompt.outputMode === 'text' && !shownFields.includes(compareField) ? TEXT_RESPONSE_KEY : compareField;
                  return (
                    <tr
                      key={d.id}
                      className={`clickable ${selected.has(d.id) ? 'selected' : ''}`}
                      tabIndex={0}
                      onClick={() => setOpenDoc(d.id)}
                      onKeyDown={(e) => e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpenDoc(d.id))}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" className="cbx" aria-label={`Select ${d.docId}`} checked={selected.has(d.id)} onChange={() => toggle(d.id)} />
                      </td>
                      <td className="mono" style={{ whiteSpace: 'nowrap' }}>{d.docId}</td>
                      <td>
                        <div className="snippet">{entries ? d.text.split('\n').join(' · ') : d.text.slice(0, 300)}</div>
                      </td>
                      {shownFields.map((f, i) => {
                        // (A plain-text run's score under a structured prompt's column of the same name.)
                        const val = v.values[f] ?? (v.run && f !== TEXT_RESPONSE_KEY ? fieldValue(v.run, v.values, f) : '');
                        return (
                          <td key={f}>
                            {v.status === 'error' ? (
                              // One badge per failed text, not one per column.
                              i === 0 && <span className="badge err">failed</span>
                            ) : (
                              <span className={`val ${f === cmpCell ? cmp : ''}`} title={v.consistency[f] !== undefined ? `${Math.round(v.consistency[f] * 100)}% of the annotations agree` : undefined}>
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
                          <span className={`badge ${v.status === 'partial' ? 'warn' : 'muted'}`} title={`Run ${runTitle(v.run, runs)} · prompt v${v.run.snapshot.promptVersion} · ${v.run.snapshot.model.model}`}>
                            #{runName(v.run, runs)} · v{v.run.snapshot.promptVersion}
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
            {!pageDocs.length && <div className="empty">No {w.many} match.</div>}
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
      {!docs.length && progress}
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
