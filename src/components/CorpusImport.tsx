import { useMemo, useRef, useState } from 'react';
import {
  ACCEPTED_EXTENSIONS,
  baseName,
  describeRow,
  guessIdColumn,
  guessTextColumn,
  notUtf8,
  parseFile,
  parsePastedTable,
  splitPasted,
  type ParsedTable,
} from '../lib/import/parse';
import { clearPlan, guessKeyColumn, matchLabels, ownLikeColumn, resultsTable } from '../lib/import/labels';
import { templatePlaceholders } from '../lib/prompt';
import { addDocs, addLabels, currentStudy, getState, isBusy, removeMetaColumn, toast, useStore } from '../lib/store';
import { isEntries, words } from '../lib/subject';
import { runName } from '../lib/view';
import type { PromptSpec, Run } from '../lib/types';
import { countWords } from '../lib/util';
import { Icon, Modal } from './ui';

type NewDoc = { docId: string; text: string; meta: Record<string, string>; source: string };

/** Metadata columns the prompt inserts with {{meta.<column>}} (the study's prompt, and the prompts of its runs,
 *  which "Retry failed" sends again with the texts' current metadata). */
function promptColumns(prompt: PromptSpec, runs: Run[]): Set<string> {
  const templates = [prompt.userTemplate, ...runs.map((r) => r.snapshot.prompt.userTemplate)];
  return new Set(templates.flatMap((t) => templatePlaceholders(t)).filter((k) => k.startsWith('meta.')).map((k) => k.slice(5)));
}

/** A button's action that must not run twice at once (a double click would add every text twice). */
function useOnce(): [boolean, (f: () => Promise<unknown>) => Promise<void>] {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const once = async (f: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await f();
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return [busy, once];
}

/**
 * Whether a dialog appeared less than half a second ago: the second click of a double click on the previous dialog's
 * button (e.g. Import, with another table waiting) lands on this one's, and must not import what was never seen.
 */
function useJustShown(): () => boolean {
  const [shownAt] = useState(() => performance.now());
  return () => performance.now() - shownAt < 500;
}

const TABLE_EXTENSIONS = '.csv,.tsv,.xlsx,.xls,.ods,.json,.jsonl';

export function CorpusImport() {
  const nDocs = useStore((s) => s.docs.length);
  // A model-knowledge study takes entries (rows of a table), not text files.
  const entries = useStore((s) => isEntries(currentStudy(s)!.prompt));
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState('');
  const [paste, setPaste] = useState(false);
  const [tables, setTables] = useState<ParsedTable[]>([]);
  const [labels, setLabels] = useState<ParsedTable | null>(null);
  const [removing, setRemoving] = useState(false);
  const hasMeta = useStore((s) => s.docs.some((d) => Object.keys(d.meta).some((c) => c !== 'file')));
  const inputRef = useRef<HTMLInputElement>(null);
  const labelsRef = useRef<HTMLInputElement>(null);

  const handleLabels = async (file: File | undefined) => {
    if (!file) return;
    const r = await parseFile(file);
    if (r.kind === 'table') setLabels(r.table);
    else toast(r.kind === 'error' ? `${r.name}: ${r.error}` : 'Labels must be a table (CSV, TSV, XLSX, JSON or JSONL).', 'error');
  };

  const ZIP_NOTE = 'Extract the zip first, then drop the extracted files (or the folder’s files) here.';

  const handleFiles = async (all: File[]) => {
    const zips = all.filter((f) => /\.zip$/i.test(f.name));
    const files = all.filter((f) => !/\.zip$/i.test(f.name));
    if (zips.length) toast(`${zips.map((f) => f.name).join(', ')} can’t be read directly. ${ZIP_NOTE}`, 'error');
    if (!files.length) return;
    // The study the files are for: if another study is opened while they are being read, nothing is added.
    const studyId = getState().currentId ?? undefined;
    const texts: NewDoc[] = [];
    const newTables: ParsedTable[] = [];
    // Files not added, by reason.
    const errors = new Map<string, string[]>();
    const skip = (name: string, reason: string) => (errors.get(reason) ?? errors.set(reason, []).get(reason)!).push(name);
    for (let i = 0; i < files.length; i++) {
      setBusy(`Reading ${i + 1} of ${files.length}: ${files[i].name}`);
      const r = await parseFile(files[i]);
      if (r.kind === 'text' && entries) {
        skip(r.file.name, 'This study takes entries as a table (one row each), not text files.');
      } else if (r.kind === 'text') {
        if (r.file.text.trim()) texts.push({ docId: baseName(r.file.name), text: r.file.text, meta: { file: r.file.name }, source: r.file.name });
        else skip(r.file.name, 'Empty.');
      } else if (r.kind === 'table') newTables.push(r.table);
      else skip(r.name, r.error.replace(/([^.])$/, '$1.'));
    }
    setBusy('');
    if (texts.length) await addDocs(texts, studyId);
    if (newTables.length) setTables(newTables);
    if (errors.size) {
      // Kept until dismissed, so the files can be fixed one by one: each reason once (the most common first), with
      // the names of all its files.
      const groups = [...errors].sort((a, b) => b[1].length - a[1].length);
      const n = groups.reduce((k, [, names]) => k + names.length, 0);
      const parts = groups.map(([reason, names]) => `${names.join(', ')}: ${reason === notUtf8(1) ? notUtf8(names.length) : reason}`);
      toast(`Skipped ${n.toLocaleString()} file${n === 1 ? '' : 's'}. ${parts.join(' ')}`, 'error', true);
    }
  };

  return (
    <>
      <div
        className={`drop ${over ? 'over' : ''} ${nDocs ? 'compact' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const dropped = [...e.dataTransfer.files];
          if (!dropped.length) toast(`Nothing arrived. Files dragged from inside a zip can’t be read. ${ZIP_NOTE}`, 'error');
          else void handleFiles(dropped);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
      >
        <Icon name="upload" size={nDocs ? 18 : 22} />
        <div>
          <strong>
            {busy ||
              (entries
                ? `${nDocs ? 'Add more entries' : 'Add entries'}: drop a spreadsheet here or click to choose`
                : nDocs
                  ? 'Add more texts: drop files here or click to choose'
                  : 'Drop files here or click to choose')}
          </strong>
          {!busy && (
            <div className="hint">
              {entries
                ? 'One row per entry, with the column names in the first row (e.g. name, born, country): CSV, XLSX, JSON or JSONL. Or paste the rows below.'
                : 'One text per file (TXT, MD, PDF, DOCX, HTML) or a whole corpus as a table (CSV, TSV, XLSX, JSON, JSONL).'}
            </div>
          )}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept={entries ? TABLE_EXTENSIONS : ACCEPTED_EXTENSIONS.join(',')}
        onChange={(e) => {
          void handleFiles([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      <div className="row" style={{ marginTop: 10 }}>
        <button className={`btn small ${entries ? 'primary' : ''}`} onClick={() => setPaste(true)}>
          {entries ? 'Paste entries…' : 'Paste text…'}
        </button>
        {nDocs > 0 && (
          <button
            className="btn small"
            onClick={() => labelsRef.current?.click()}
            title={
              entries
                ? 'Add your own answers (an answer key) to the entries already here, matched by ID. The model does not see them.'
                : 'Add human labels (an answer key) or metadata to the texts already here, matched by file name or ID'
            }
          >
            {entries ? 'Add your answers from a spreadsheet…' : 'Add labels or metadata from a spreadsheet…'}
          </button>
        )}
        {hasMeta && (
          <button className="btn small" onClick={() => setRemoving(true)} title={`Remove a column added by mistake (or an outdated one) from every ${entries ? 'entry' : 'text'}`}>
            Remove a column…
          </button>
        )}
      </div>
      {removing && <RemoveColumnDialog onDone={() => setRemoving(false)} />}
      <input
        ref={labelsRef}
        type="file"
        hidden
        accept={TABLE_EXTENSIONS}
        onChange={(e) => {
          void handleLabels(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {paste && (
        <PasteDialog
          tableOnly={entries}
          onClose={() => setPaste(false)}
          onTable={(t) => {
            setPaste(false);
            setTables([t]);
          }}
        />
      )}
      {labels && <LabelsDialog entries={entries} table={labels} onDone={() => setLabels(null)} />}
      {/* The next table waits while a sheet is being added as labels (otherwise its dialog, on top, could replace that sheet unseen). */}
      {tables.length > 0 && !labels && (
        <TableDialog
          key={`${tables.length}:${tables[0].name}`}
          entries={entries}
          table={tables[0]}
          // Only this table leaves the queue (e.g. not the next one, when its import ends after it was closed).
          onDone={(table) => setTables((t) => (t[0] === table ? t.slice(1) : t))}
          onUseAsLabels={(table) => {
            setLabels(table);
            setTables((t) => (t[0] === table ? t.slice(1) : t));
          }}
        />
      )}
    </>
  );
}

function PasteDialog({ tableOnly, onClose, onTable }: { tableOnly: boolean; onClose: () => void; onTable: (t: ParsedTable) => void }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'none' | 'blank' | 'line' | 'table'>(tableOnly ? 'table' : 'none');
  const [prefix, setPrefix] = useState('pasted');
  const asTable = mode === 'table';
  const table = useMemo(() => (asTable && text.trim() ? parsePastedTable(text) : null), [asTable, text]);
  const items = asTable ? [] : splitPasted(text, mode);
  const [adding, once] = useOnce();
  const add = () =>
    once(async () => {
      const docs = items.map((t, i) => ({ docId: items.length === 1 ? prefix : `${prefix}_${i + 1}`, text: t, meta: {}, source: 'pasted' }));
      // (Not saved, e.g. storage full: the dialog stays open with what was pasted.)
      if (await addDocs(docs)) onClose();
    });
  // While the texts are being saved, closing wouldn't stop it.
  const close = () => !adding && onClose();
  return (
    <Modal
      title={tableOnly ? 'Paste entries' : 'Paste text'}
      onClose={close}
      confirmEscape={text.trim() && !adding ? 'Close without adding what you pasted?' : undefined}
      footer={
        <>
          <button className="btn" onClick={close} disabled={adding}>Cancel</button>
          {asTable ? (
            <button className="btn primary" disabled={!table?.rows.length || !table.columns.length} onClick={() => table && onTable(table)}>
              Continue with {table?.rows.length.toLocaleString() ?? 0} row{table?.rows.length === 1 ? '' : 's'}…
            </button>
          ) : (
            <button className="btn primary" disabled={!items.length || adding} onClick={add}>
              {adding ? 'Adding…' : `Add ${items.length || ''} text${items.length === 1 ? '' : 's'}`}
            </button>
          )}
        </>
      }
    >
      <textarea
        className="textarea"
        rows={12}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={asTable ? 'name\tborn\tcountry\nNiels Bohr\t1885\tDenmark\nKaren Blixen\t1885\tDenmark' : 'Paste one or more texts…'}
      />
      {!tableOnly && (
      <div className="grid2" style={{ marginTop: 12 }}>
        <div className="field">
          <span className="label">Split into separate texts</span>
          <select className="select" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="none">No: one text</option>
            <option value="blank">At blank lines (paragraphs)</option>
            <option value="line">At every line</option>
          </select>
        </div>
        {!asTable && (
          <div className="field">
            <span className="label">ID prefix</span>
            <input className="input mono" value={prefix} onChange={(e) => setPrefix(e.target.value.replace(/\s+/g, '_') || 'pasted')} />
          </div>
        )}
      </div>
      )}
      {asTable ? (
        <>
          <div className="hint" style={{ marginTop: 8 }}>
            One row per entry, with the column names in the first row. Copy the rows from Excel or a Word table, or type them separated by commas.
            {table && table.columns.length > 0 && (
              <>
                {' '}
                {table.rows.length.toLocaleString()} row{table.rows.length === 1 ? '' : 's'} · columns: {table.columns.join(', ')}
              </>
            )}
          </div>
          {table?.problems?.map((p) => (
            <div key={p} className="hint warn">
              {p}
            </div>
          ))}
        </>
      ) : (
        <div className="hint">
          {items.length} text{items.length === 1 ? '' : 's'} · {countWords(text).toLocaleString()} words
        </div>
      )}
    </Modal>
  );
}

function TableDialog({
  entries,
  table,
  onDone,
  onUseAsLabels,
}: {
  entries: boolean;
  table: ParsedTable;
  onDone: (table: ParsedTable) => void;
  onUseAsLabels: (table: ParsedTable) => void;
}) {
  const docs = useStore((s) => s.docs);
  // A metadata or label sheet dropped here would otherwise become one junk "text" per row.
  const matched = useMemo(() => (docs.length ? matchLabels(docs, table, guessKeyColumn(docs, table)).updates.size : 0), [docs, table]);
  const [textCol, setTextCol] = useState(() => guessTextColumn(table));
  const [idCol, setIdCol] = useState(guessIdColumn(table));
  const [skipEmpty, setSkipEmpty] = useState(true);
  // Entries: the columns the model sees, in the table's order (not the coder's own answers).
  const [shown, setShown] = useState<string[]>(() => (table.columns.length === 1 ? [...table.columns] : []));
  // In a model-knowledge study each row is an entry, described by the columns the model sees.
  const entry = entries;
  const textOf = (r: Record<string, string>) => (entry ? describeRow(r, shown) : String(r[textCol] ?? ''));
  // (Entries with no column ticked yet: count every row, the button waits for a column.)
  const rows = skipEmpty && (!entry || shown.length) ? table.rows.filter((r) => textOf(r).trim()) : table.rows;
  // For entries every column is also kept as metadata (filters, samples, comparisons).
  const metaCols = table.columns.filter((c) => c !== idCol && (entry || c !== textCol));
  // Entries without an ID column: the first ticked column with a different value in each row (e.g. the title, not
  // the author), so that answers in a spreadsheet can be matched to the entries later.
  const unique = (c: string) => new Set(rows.map((r) => String(r[c] ?? '').trim())).size === rows.length;
  const autoId = entry && !idCol ? (shown.find(unique) ?? shown[0] ?? '') : '';
  const base = baseName(table.name);
  const idOf = (r: Record<string, string>, i: number) => String(r[idCol || autoId] ?? '').trim() || `${base}_${i + 1}`;
  const ids = rows.map(idOf);
  const seen = new Set<string>();
  const repeated = ids.filter((x) => seen.has(x) || (seen.add(x), false));
  const [adding, once] = useOnce();
  const justShown = useJustShown();
  const add = () =>
    !justShown() &&
    once(async () => {
      const docs = rows.map((r, i) => {
        return {
          docId: ids[i],
          text: textOf(r),
          meta: Object.fromEntries(metaCols.map((c) => [c, String(r[c] ?? '')])),
          source: table.name,
        };
      });
      // (Not saved, e.g. storage full: the dialog stays open, so the table isn't lost from the queue.)
      if (await addDocs(docs)) onDone(table);
    });
  // While the rows are being saved, closing wouldn't stop it: Cancel waits.
  const close = () => !adding && onDone(table);
  return (
    <Modal
      title={entry ? `Add entries: ${table.name}` : `Import table: ${table.name}`}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close} disabled={adding}>Cancel</button>
          <button className="btn primary" disabled={(entry ? !shown.length : !textCol) || !rows.length || adding} onClick={add}>
            {adding ? 'Importing…' : `Import ${rows.length.toLocaleString()} ${entry ? 'entries' : 'texts'}`}
          </button>
        </>
      }
    >
      {matched > 0 && matched >= table.rows.length / 2 && (
        <div className="notice warn" style={{ marginBottom: 12 }}>
          {matched.toLocaleString()} of {table.rows.length.toLocaleString()} rows match {entry ? 'entries' : 'texts'} already in this study by name or ID. If this file holds
          labels or metadata for those {entry ? 'entries' : 'texts'}, add it as columns instead of importing them again.{' '}
          <button className="btn small" disabled={adding} onClick={() => onUseAsLabels(table)}>
            Add as labels or metadata instead
          </button>
        </div>
      )}
      {repeated.length > 0 && (
        <div className="notice warn" style={{ marginBottom: 12 }}>
          {repeated.length.toLocaleString()} {entry ? (repeated.length === 1 ? 'entry has' : 'entries have') : repeated.length === 1 ? 'text has' : 'texts have'} the same ID as another
          (e.g. “{repeated[0]}”) and will get _2, _3 and so on (a row the same as another in every column is added once). Choose an ID column with a different value in each row, so that labels or answers in a spreadsheet can be
          matched to them later.
        </div>
      )}
      {table.problems?.map((p) => (
        <div key={p} className="notice warn" style={{ marginBottom: 12 }}>
          {p}
        </div>
      ))}
      <SheetNote table={table} />
      <div className="grid2">
        {!entry && (
          <div className="field">
            <label>Text column</label>
            <select className="select" value={textCol} onChange={(e) => setTextCol(e.target.value)}>
              {table.columns.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label>ID column</label>
          <select className="select" value={idCol} onChange={(e) => setIdCol(e.target.value)}>
            <option value="">{entry ? '(first ticked column whose values all differ)' : '(number the rows)'}</option>
            {table.columns.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>
      {entry && (
        <div className="field">
          <span className="label">Columns the model sees</span>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
            {table.columns.map((c) => (
              <label key={c} className="check">
                <input
                  type="checkbox"
                  checked={shown.includes(c)}
                  onChange={(e) => setShown(table.columns.filter((x) => (x === c ? e.target.checked : shown.includes(x))))}
                />
                {c}
              </label>
            ))}
          </div>
          <div className="hint">
            Tick what identifies each entry (e.g. name, year, country). Leave out your own answers: they stay with each entry, to compare with the model under{' '}
            <em>Runs &amp; agreement</em>.
          </div>
          {shown.length > 0 && rows[0] && (
            <>
              <p className="section-title" style={{ marginTop: 10 }}>
                What the model gets for the first row (after your prompt)
              </p>
              <pre className="textblock">{textOf(rows[0])}</pre>
            </>
          )}
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={skipEmpty} onChange={(e) => setSkipEmpty(e.target.checked)} /> Skip rows with {entry ? 'nothing in the ticked columns' : 'an empty text'}
      </label>
      <p className="hint">
        {entry ? 'All columns are also kept as metadata' : 'All other columns are kept as metadata'}
        {metaCols.length ? `: ${metaCols.slice(0, 8).join(', ')}${metaCols.length > 8 ? '…' : ''}` : ''}. Columns with human or gold-standard labels can be compared
        with model annotations under <em>Runs &amp; agreement</em>.
      </p>
      <div className="table-wrap" style={{ maxHeight: 260 }}>
        <table className="data">
          <thead>
            <tr>
              {table.columns.slice(0, 6).map((c) => (
                <th key={c} className={(!entry && c === textCol) || c === idCol || (entry && shown.includes(c)) ? 'col-role' : ''}>
                  {c}
                  {!entry && c === textCol && <span className="badge" style={{ marginLeft: 6 }}>used as text</span>}
                  {entry && shown.includes(c) && <span className="badge" style={{ marginLeft: 6 }}>model sees</span>}
                  {c === (idCol || autoId) && <span className="badge" style={{ marginLeft: 6 }}>used as ID</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.slice(0, 5).map((r, i) => (
              <tr key={i}>
                {table.columns.slice(0, 6).map((c) => (
                  <td key={c} className={(!entry && c === textCol) || c === idCol || (entry && shown.includes(c)) ? 'col-role' : ''}>
                    <div className="snippet">{r[c]}</div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

/** Which sheet of a workbook was read, when it has several. */
function SheetNote({ table }: { table: ParsedTable }) {
  if (!table.sheets || table.sheets.length < 2) return null;
  return (
    <div className="hint" style={{ marginBottom: 10 }}>
      Read the sheet “{table.sheet}”, the first of {table.sheets.length} ({table.sheets.join(', ')}). To use another sheet, move it to the front in Excel or
      save it as CSV.
    </div>
  );
}

function LabelsDialog({ entries, table, onDone }: { entries: boolean; table: ParsedTable; onDone: () => void }) {
  const docs = useStore((s) => s.docs);
  const runs = useStore((s) => s.runs);
  const results = useStore((s) => s.results);
  const prompt = useStore((s) => currentStudy(s)!.prompt);
  const saved = useStore((s) => currentStudy(s)!.savedPrompts);
  const [keyCol, setKeyCol] = useState(() => guessKeyColumn(docs, table));
  // Texts the sheet doesn't list keep their values, unless asked (e.g. a corrected sheet for all texts).
  const [removeUnlisted, setRemoveUnlisted] = useState(false);
  const m = useMemo(() => matchLabels(docs, table, keyCol), [docs, table, keyCol]);
  const clear = useMemo(() => clearPlan(docs, m, !removeUnlisted), [docs, m, removeUnlisted]);
  // Texts this sheet doesn't list but that have a value in one of its columns already (kept unless asked).
  const unlisted = useMemo(
    () => docs.filter((d) => !m.updates.has(d.id) && !m.untouched.has(d.id) && m.replaced.some((c) => (d.meta[c] ?? '') !== '')).length,
    [docs, m],
  );
  // A results file exported from this app: its answer columns are the model's, not human labels (field names from the
  // runs and from the current and saved prompts, so also before a run or after one is deleted). Only the columns that
  // would be added are judged, not the one rows are matched by (e.g. a survey's response_id).
  const exported = useMemo(
    () => resultsTable(table, runs, results, m.updates, [prompt, ...(saved ?? []).map((x) => x.prompt)], keyCol),
    [table, runs, results, m, prompt, saved, keyCol],
  );
  // Its other columns not yet in this study that may hold the answers of a field named differently now (never a label
  // column such as tone_gold; none when the sheet has every field of a run or prompt here).
  const others = exported.unknown.filter((c) => !m.replaced.includes(c));
  // Answer columns whose values were not shown to be the model's (e.g. a coder's own labels beside the model's
  // explanations): named as such, never as the model's.
  const unconfirmed = exported.answers.filter((c) => !exported.copied.includes(c));
  const toDelete = exported.columns.filter((c) => !unconfirmed.includes(c));
  const removedBy = (c: string) => [...clear.values()].filter((cols) => cols.includes(c)).length;
  const inPrompt = useMemo(() => promptColumns(prompt, runs), [prompt, runs]);
  const emptied = m.replaced.filter((c) => inPrompt.has(c) && removedBy(c) > 0);
  const list = (xs: string[]) => `${xs.slice(0, 5).join(', ')}${xs.length > 5 ? ', …' : ''}`;
  const plural = (xs: string[]) => (xs.length === 1 ? '' : 's');
  const [one, many] = entries ? ['entry', 'entries'] : ['text', 'texts'];
  const blocked = m.conflicts.length > 0 || exported.columns.length > 0;
  // When only columns a sheet of the owner's may have too point to an export (status, completed_at, response_id):
  // the notice says it may be one, and how to add it if it is the owner's own.
  const own = [...exported.strong, ...exported.shared];
  // Of those, the columns only such files have (not response_id, which a survey's sheet may have too).
  const proof = exported.strong.filter((c) => !ownLikeColumn(c));
  const weak = own.filter((c) => !proof.includes(c));
  const sameAs = (c: string) => {
    const x = exported.sameAs[c];
    const run = runs.find((r) => r.id === x?.run);
    return `run #${run ? runName(run, runs) : '?'}’s answers for all ${(x?.texts ?? 0).toLocaleString()} ${x?.texts === 1 ? one : many} with a value there`;
  };
  // Several rows for texts that the study has twice under one name (John Smith, John Smith_2) need other advice.
  const sameName = m.sameName;
  const otherConflicts = m.conflicts.filter((k) => !sameName.some((x) => x.key === k));
  const [adding, once] = useOnce();
  const justShown = useJustShown();
  const apply = () =>
    !justShown() &&
    once(async () => {
      if (await addLabels(m.updates, clear)) onDone();
    });
  // While the values are being saved, closing wouldn't stop it: Cancel waits.
  const close = () => !adding && onDone();
  return (
    <Modal
      title={`${entries ? 'Add answers' : 'Add labels'}: ${table.name}`}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close} disabled={adding}>Cancel</button>
          <button className="btn primary" disabled={!m.updates.size || !m.columns.length || blocked || adding} onClick={apply}>
            {adding ? 'Adding…' : `Add to ${m.updates.size.toLocaleString()} ${m.updates.size === 1 ? one : many}`}
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        {entries ? (
          <>
            Each row is matched to an entry by its ID; the other columns are added to that entry (e.g. your own answers, to compare with the model). The model
            does not see these columns: what it is sent was fixed when the entries were added.
          </>
        ) : (
          <>
            Each row is matched to a text by its file name or ID; the other columns are added to that text as labels (e.g. human codes to compare with the
            model). Texts are not changed.
          </>
        )}{' '}
        For the {many} it lists, a column that is already there gets this sheet’s values: a blank cell leaves no value (“NA” keeps {entries ? 'an entry' : 'a text'} out
        of the comparison). {entries ? 'Entries' : 'Texts'} it doesn’t list keep theirs.
      </p>
      {exported.columns.length > 0 && !exported.sure && (
        <div className="notice warn" style={{ marginBottom: 12 }}>
          <strong>This may be a results file exported from Annotation Desk</strong>: it has the column{plural(own)} {list(own)} those files have
          {exported.copied.length === 1 && (
            <>
              , and its column {exported.copied[0]} is the same as {sameAs(exported.copied[0])}
            </>
          )}
          {exported.copied.length > 1 && <>, and its columns {exported.copied.map((c) => `${c} (the same as ${sameAs(c)})`).join(', ')}</>}. If it is
          your own sheet, rename {own.length === 1 ? 'that column' : 'those columns'} (e.g. {own[0]} to my_{own[0]}) or delete {own.length === 1 ? 'it' : 'them'}, then
          add it again. If it is a results file, use a sheet with only your own columns (the {entries ? 'ID' : 'file name or ID'} and your{' '}
          {entries ? 'answers' : 'labels'}): the model’s answers added here would count as {entries ? 'your own answers' : 'human labels'}.
        </div>
      )}
      {exported.columns.length > 0 && exported.sure && (
        <div className="notice warn" style={{ marginBottom: 12 }}>
          <strong>This is a results file exported from Annotation Desk</strong>:{' '}
          {proof.length > 0 ? (
            <>
              it has the column{plural(proof)} {list(proof)}, which only those files have.
            </>
          ) : (
            <>
              its column{plural(exported.copied)} {list(exported.copied)} {exported.copied.length === 1 ? 'holds' : 'hold'} the model’s answers stored in this study,
              for nearly every {one} it lists
              {weak.length > 0 && (
                <>
                  , and it has the column{plural(weak)} {list(weak)} those files have
                </>
              )}
              .
            </>
          )}{' '}
          {exported.answers.length === 0 ? (
            <>
              None of its columns is named like a field of this study (e.g. a field renamed since, or a file from another study), so the app can’t tell which
              of them hold the model’s answers; added here, they would count as {entries ? 'your own answers' : 'human labels'}.
            </>
          ) : exported.copied.length > 0 ? (
            <>
              {proof.length > 0 ? (
                <>
                  Its column{plural(exported.copied)} {list(exported.copied)} {exported.copied.length === 1 ? 'holds' : 'hold'} the model’s answers, which are
                  already in this study (under <em>Runs &amp; agreement</em>); added
                </>
              ) : (
                'Added'
              )}{' '}
              here, they would count as {entries ? 'your own answers' : 'human labels'}.
              {unconfirmed.length > 0 && (
                <>
                  {' '}
                  Its column{plural(unconfirmed)} {list(unconfirmed)} {unconfirmed.length === 1 ? 'is' : 'are'} named like this study’s fields: in such a file{' '}
                  {unconfirmed.length === 1 ? 'it holds' : 'they hold'} the model’s answers too.
                </>
              )}
            </>
          ) : (
            <>
              Its column{plural(exported.answers)} {list(exported.answers)} {exported.answers.length === 1 ? 'is' : 'are'} named like this study’s fields: in such
              a file {exported.answers.length === 1 ? 'it holds' : 'they hold'} the model’s answers, which added here would count as {entries ? 'your own answers' : 'human labels'}.
            </>
          )}{' '}
          To add {entries ? 'your answers' : 'human labels'}, use a sheet with only your own columns (the {entries ? 'ID' : 'file name or ID'} and your{' '}
          {entries ? 'answers' : 'labels'}), or delete from this sheet{' '}
          {exported.answers.length === 0 ? (
            <>
              the run’s columns ({exported.columns.join(', ')}) and every column with the model’s answers
              {others.length > 0 && <> (among {list(others)})</>}
            </>
          ) : (
            <>
              the {exported.copied.length === 0 ? 'run’s' : toDelete.length > exported.copied.length ? 'model’s and the run’s' : 'model’s'} columns (
              {toDelete.join(', ')})
              {unconfirmed.length > 0 && (
                <>
                  , and {unconfirmed.join(', ')} unless {unconfirmed.length === 1 ? 'it holds' : 'they hold'} your own {entries ? 'answers' : 'labels'}
                </>
              )}
              {others.length > 0 && <>, and any of its other columns ({list(others)}) that holds the model’s answers (e.g. of a field named differently now)</>}
            </>
          )}
          , then add it again.
        </div>
      )}
      {table.problems?.map((p) => (
        <div key={p} className="notice warn" style={{ marginBottom: 12 }}>
          {p}
        </div>
      ))}
      <SheetNote table={table} />
      <div className="field">
        <label>Column with the {entries ? 'ID' : 'file name or ID'}</label>
        <select className="select" value={keyCol} onChange={(e) => setKeyCol(e.target.value)}>
          {table.columns.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      <div className={`notice ${m.unmatched.length || m.ambiguous.length || blocked || clear.size || sameName.length ? 'warn' : ''}`}>
        <div>
          <strong>{m.matchedRows.toLocaleString()}</strong> of {table.rows.length.toLocaleString()} rows matched {m.matchedTexts.toLocaleString()}{' '}
          {m.matchedTexts === 1 ? one : many}. Columns to add: {m.columns.length ? m.columns.join(', ') : '(none)'}.
        </div>
        {otherConflicts.length > 0 && (
          <div>
            <strong>
              Several rows for the same {one} with different values ({otherConflicts.length}): {list(otherConflicts)}.
            </strong>{' '}
            Only one row per {one} can be used, e.g. not one row per coder: put each coder’s labels in a column of their own (race_coder1, race_coder2, …).
            Nothing is added until the sheet is fixed.
          </div>
        )}
        {sameName.length > 0 && (
          <div>
            <strong>
              This study has more than one {one} called {list(sameName.map((x) => `“${x.key}”`))}, and the sheet lists {sameName.length === 1 ? 'that name' : 'those names'}{' '}
              more than once.
            </strong>{' '}
            They were stored as {sameName.slice(0, 5).map((x) => x.ids.join(', ')).join('; ')}
            {sameName.length > 5 ? '; …' : ''}. Rows are matched by {entries ? 'ID' : 'file name or ID'}, so every row with that name would go to the
            first. Nothing is added until each row has the ID its {one} has here (e.g. {sameName[0].ids[1]}).
          </div>
        )}
        {m.repeated.length > 0 && (
          <div>
            Listed more than once, with no value that differs, so the rows are merged ({m.repeated.length}): {list(m.repeated)}
          </div>
        )}
        {m.unmatched.length > 0 && <div>Not found ({m.unmatched.length}): {list(m.unmatched)}</div>}
        {m.ambiguous.length > 0 && (
          <div>
            Matches more than one {one}, skipped and left as they are ({m.ambiguous.length}): {list(m.ambiguous)}
          </div>
        )}
        {m.skipped.length > 0 && <div>Not added: the sheet’s {m.skipped.join(', ')} column ({m.skipped.length === 1 ? 'it' : 'they'} would rename the {many}: each keeps the name of its own file).</div>}
        {m.replaced.length > 0 && (
          <div>
            Already present, replaced for the {many} this sheet lists:{' '}
            {m.replaced.map((c) => {
              const n = removedBy(c);
              return `${c}${n ? ` (${n.toLocaleString()} earlier value${n === 1 ? '' : 's'} removed: blank here${removeUnlisted ? ' or not listed' : ''})` : ''}`;
            }).join(', ')}
            .
          </div>
        )}
        {emptied.length > 0 && (
          <div>
            The prompt inserts {emptied.map((c) => `{{meta.${c}}}`).join(', ')}: {entries ? 'an entry' : 'a text'} whose value is removed gets an empty value there in later requests (also
            with Retry failed).
          </div>
        )}
      </div>
      {unlisted > 0 && (
        <label className="check" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={removeUnlisted} onChange={(e) => setRemoveUnlisted(e.target.checked)} /> Also remove the values of the{' '}
          {unlisted.toLocaleString()} {unlisted === 1 ? one : many} this sheet doesn’t list (in {list(m.replaced)}), e.g. when this sheet replaces an earlier one
          for all {many}
        </label>
      )}
    </Modal>
  );
}

/** Remove a metadata column (e.g. labels added by mistake) from every text; the texts themselves are not changed. */
function RemoveColumnDialog({ onDone }: { onDone: () => void }) {
  const docs = useStore((s) => s.docs);
  const runs = useStore((s) => s.runs);
  const prompt = useStore((s) => currentStudy(s)!.prompt);
  const busy = useStore((s) => isBusy(s));
  const w = words(prompt);
  // Not the file name: texts are matched and named by it.
  const cols = useMemo(() => [...new Set(docs.flatMap((d) => Object.keys(d.meta)))].filter((c) => c !== 'file'), [docs]);
  const [col, setCol] = useState(cols[0] ?? '');
  const n = docs.filter((d) => col in d.meta).length;
  const inPrompt = useMemo(() => promptColumns(prompt, runs), [prompt, runs]).has(col);
  const remove = async () => {
    if (!confirm(`Remove the column "${col}" from ${n.toLocaleString()} ${n === 1 ? w.one : w.many}? This cannot be undone (add it again from a spreadsheet if needed).`)) return;
    if (await removeMetaColumn(col)) onDone();
  };
  return (
    <Modal
      title="Remove a column"
      onClose={onDone}
      footer={
        <>
          <button className="btn" onClick={onDone}>Cancel</button>
          <button className="btn danger" disabled={!col || busy} onClick={remove}>
            Remove “{col}”
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        Removes a label or metadata column from every {w.one} in this study, e.g. one added by mistake or replaced by a corrected sheet. The {w.many} and the runs
        are not changed.
      </p>
      <div className="field">
        <label>Column</label>
        <select className="select" value={col} onChange={(e) => setCol(e.target.value)}>
          {cols.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      <div className="hint">{n.toLocaleString()} {n === 1 ? `${w.one} has` : `${w.many} have`} a value in this column.</div>
      {inPrompt && (
        <div className="notice warn" style={{ marginTop: 10 }}>
          The prompt inserts <code>{`{{meta.${col}}}`}</code>: after this, later requests (also with Retry failed) get an empty value there.
        </div>
      )}
    </Modal>
  );
}
