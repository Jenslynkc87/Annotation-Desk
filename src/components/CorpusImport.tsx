import { useMemo, useRef, useState } from 'react';
import {
  ACCEPTED_EXTENSIONS,
  baseName,
  describeRow,
  guessIdColumn,
  guessTextColumn,
  looksLikeEntries,
  parseFile,
  parsePastedTable,
  splitPasted,
  type ParsedTable,
} from '../lib/import/parse';
import { guessKeyColumn, matchLabels } from '../lib/import/labels';
import { addDocs, addLabels, toast, useStore } from '../lib/store';
import { countWords } from '../lib/util';
import { Icon, Modal } from './ui';

type NewDoc = { docId: string; text: string; meta: Record<string, string>; source: string };

/** The "text column" choice for tables that describe one entry per row (e.g. people or books) instead of holding texts. */
const ENTRY = '\u0001entry';

export function CorpusImport() {
  const nDocs = useStore((s) => s.docs.length);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState('');
  const [paste, setPaste] = useState(false);
  const [tables, setTables] = useState<ParsedTable[]>([]);
  const [labels, setLabels] = useState<ParsedTable | null>(null);
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
    if (zips.length) toast(`${zips.length === 1 ? zips[0].name : `${zips.length} zip files`} can’t be read directly. ${ZIP_NOTE}`, 'error');
    if (!files.length) return;
    const texts: NewDoc[] = [];
    const newTables: ParsedTable[] = [];
    const errors: string[] = [];
    for (let i = 0; i < files.length; i++) {
      setBusy(`Reading ${i + 1} of ${files.length}: ${files[i].name}`);
      const r = await parseFile(files[i]);
      if (r.kind === 'text') {
        if (r.file.text.trim()) texts.push({ docId: baseName(r.file.name), text: r.file.text, meta: { file: r.file.name }, source: r.file.name });
        else errors.push(`${r.file.name}: empty`);
      } else if (r.kind === 'table') newTables.push(r.table);
      else errors.push(`${r.name}: ${r.error}`);
    }
    setBusy('');
    if (texts.length) await addDocs(texts);
    if (newTables.length) setTables(newTables);
    if (errors.length) toast(`Skipped ${errors.length} file(s): ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '…' : ''}`, 'error');
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
          <strong>{busy || (nDocs ? 'Add more texts: drop files here or click to choose' : 'Drop files here or click to choose')}</strong>
          {!busy && (
            <div className="hint">
              One text per file (TXT, MD, PDF, DOCX, HTML) or a whole corpus as a table (CSV, TSV, XLSX, JSON, JSONL).
            </div>
          )}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept={ACCEPTED_EXTENSIONS.join(',')}
        onChange={(e) => {
          void handleFiles([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn small" onClick={() => setPaste(true)}>
          Paste text…
        </button>
        {nDocs > 0 && (
          <button className="btn small" onClick={() => labelsRef.current?.click()} title="Add human labels (an answer key) or metadata (era, journal, …) to the texts already here, matched by file name or ID">
            Add labels or metadata from a spreadsheet…
          </button>
        )}
      </div>
      <input
        ref={labelsRef}
        type="file"
        hidden
        accept=".csv,.tsv,.xlsx,.xls,.ods,.json,.jsonl"
        onChange={(e) => {
          void handleLabels(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {paste && (
        <PasteDialog
          onClose={() => setPaste(false)}
          onTable={(t) => {
            setPaste(false);
            setTables([t]);
          }}
        />
      )}
      {labels && <LabelsDialog table={labels} onDone={() => setLabels(null)} />}
      {tables.length > 0 && (
        <TableDialog
          table={tables[0]}
          onDone={() => setTables((t) => t.slice(1))}
          onUseAsLabels={() => {
            setLabels(tables[0]);
            setTables((t) => t.slice(1));
          }}
        />
      )}
    </>
  );
}

function PasteDialog({ onClose, onTable }: { onClose: () => void; onTable: (t: ParsedTable) => void }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'none' | 'blank' | 'line' | 'table'>('none');
  const [prefix, setPrefix] = useState('pasted');
  const asTable = mode === 'table';
  const table = useMemo(() => (asTable && text.trim() ? parsePastedTable(text) : null), [asTable, text]);
  const items = asTable ? [] : splitPasted(text, mode);
  const add = async () => {
    const docs = items.map((t, i) => ({ docId: items.length === 1 ? prefix : `${prefix}_${i + 1}`, text: t, meta: {}, source: 'pasted' }));
    await addDocs(docs);
    onClose();
  };
  return (
    <Modal
      title="Paste text"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          {asTable ? (
            <button className="btn primary" disabled={!table?.rows.length || table.columns.length < 2} onClick={() => table && onTable(table)}>
              Continue with {table?.rows.length.toLocaleString() ?? 0} row{table?.rows.length === 1 ? '' : 's'}…
            </button>
          ) : (
            <button className="btn primary" disabled={!items.length} onClick={add}>
              Add {items.length || ''} text{items.length === 1 ? '' : 's'}
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
      <div className="grid2" style={{ marginTop: 12 }}>
        <div className="field">
          <span className="label">What you paste</span>
          <select className="select" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="none">One text</option>
            <option value="blank">Several texts, split at blank lines</option>
            <option value="line">Several texts, one per line</option>
            <option value="table">A table: one row each, column names in the first row</option>
          </select>
        </div>
        {!asTable && (
          <div className="field">
            <span className="label">ID prefix</span>
            <input className="input mono" value={prefix} onChange={(e) => setPrefix(e.target.value.replace(/\s+/g, '_') || 'pasted')} />
          </div>
        )}
      </div>
      {asTable ? (
        <>
          <div className="hint">
            Copy the rows from Excel or a Word table (or type them, separated by commas), with the column names in the first row.
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

function TableDialog({ table, onDone, onUseAsLabels }: { table: ParsedTable; onDone: () => void; onUseAsLabels: () => void }) {
  const docs = useStore((s) => s.docs);
  // A metadata or label sheet dropped here would otherwise become one junk "text" per row.
  const matched = useMemo(() => (docs.length ? matchLabels(docs, table, guessKeyColumn(docs, table)).updates.size : 0), [docs, table]);
  // A table of short values (names, years, …) most likely describes one entry per row, rather than holding texts.
  const [textCol, setTextCol] = useState(() => (looksLikeEntries(table) ? ENTRY : guessTextColumn(table)));
  const [idCol, setIdCol] = useState(guessIdColumn(table));
  const [skipEmpty, setSkipEmpty] = useState(true);
  // Entries: the columns the model sees, in the table's order (not the coder's own answers).
  const [shown, setShown] = useState<string[]>([]);
  const entry = textCol === ENTRY;
  const textOf = (r: Record<string, string>) => (entry ? describeRow(r, shown) : String(r[textCol] ?? ''));
  // (Entries with no column ticked yet: count every row, the button waits for a column.)
  const rows = skipEmpty && (!entry || shown.length) ? table.rows.filter((r) => textOf(r).trim()) : table.rows;
  // For entries every column is also kept as metadata (filters, samples, comparisons).
  const metaCols = table.columns.filter((c) => c !== idCol && (entry || c !== textCol));
  const add = async () => {
    const base = baseName(table.name);
    const docs = rows.map((r, i) => {
      const fallback = entry && shown.length ? String(r[shown[0]] ?? '').trim() : '';
      return {
        docId: (idCol ? String(r[idCol] ?? '').trim() : '') || fallback || `${base}_${i + 1}`,
        text: textOf(r),
        meta: Object.fromEntries(metaCols.map((c) => [c, String(r[c] ?? '')])),
        source: table.name,
      };
    });
    await addDocs(docs);
    onDone();
  };
  return (
    <Modal
      title={`Import table: ${table.name}`}
      onClose={onDone}
      footer={
        <>
          <button className="btn" onClick={onDone}>Cancel</button>
          <button className="btn primary" disabled={(entry ? !shown.length : !textCol) || !rows.length} onClick={add}>
            Import {rows.length.toLocaleString()} {entry ? 'entries' : 'texts'}
          </button>
        </>
      }
    >
      {matched > 0 && matched >= table.rows.length / 2 && (
        <div className="notice warn" style={{ marginBottom: 12 }}>
          {matched.toLocaleString()} of {table.rows.length.toLocaleString()} rows match texts already in this study by file name or ID. If this file holds
          labels or metadata for those texts, add it as columns instead of importing new texts.{' '}
          <button className="btn small" onClick={onUseAsLabels}>
            Add as labels or metadata instead
          </button>
        </div>
      )}
      {table.problems?.map((p) => (
        <div key={p} className="notice warn" style={{ marginBottom: 12 }}>
          {p}
        </div>
      ))}
      <div className="grid2">
        <div className="field">
          <label>Text column</label>
          <select className="select" value={textCol} onChange={(e) => setTextCol(e.target.value)}>
            <option value={ENTRY}>None: each row is an entry</option>
            {table.columns.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>ID column</label>
          <select className="select" value={idCol} onChange={(e) => setIdCol(e.target.value)}>
            <option value="">{entry ? '(the first ticked column)' : '(number the rows)'}</option>
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
                <th key={c} className={c === textCol || c === idCol || (entry && shown.includes(c)) ? 'col-role' : ''}>
                  {c}
                  {c === textCol && <span className="badge" style={{ marginLeft: 6 }}>used as text</span>}
                  {entry && shown.includes(c) && <span className="badge" style={{ marginLeft: 6 }}>model sees</span>}
                  {c === idCol && <span className="badge" style={{ marginLeft: 6 }}>used as ID</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.slice(0, 5).map((r, i) => (
              <tr key={i}>
                {table.columns.slice(0, 6).map((c) => (
                  <td key={c} className={c === textCol || c === idCol || (entry && shown.includes(c)) ? 'col-role' : ''}>
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

function LabelsDialog({ table, onDone }: { table: ParsedTable; onDone: () => void }) {
  const docs = useStore((s) => s.docs);
  const [keyCol, setKeyCol] = useState(() => guessKeyColumn(docs, table));
  const m = useMemo(() => matchLabels(docs, table, keyCol), [docs, table, keyCol]);
  const list = (xs: string[]) => `${xs.slice(0, 5).join(', ')}${xs.length > 5 ? ', …' : ''}`;
  const apply = async () => {
    await addLabels(m.updates);
    onDone();
  };
  return (
    <Modal
      title={`Add labels: ${table.name}`}
      onClose={onDone}
      footer={
        <>
          <button className="btn" onClick={onDone}>Cancel</button>
          <button className="btn primary" disabled={!m.updates.size || !m.columns.length} onClick={apply}>
            Add labels to {m.updates.size.toLocaleString()} text{m.updates.size === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        Each row is matched to a text by its file name or ID; the other columns are added to that text as labels (e.g. human codes to compare
        with the model). Texts are not changed, and empty cells are skipped.
      </p>
      <div className="field">
        <label>Column with the file name or ID</label>
        <select className="select" value={keyCol} onChange={(e) => setKeyCol(e.target.value)}>
          {table.columns.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      <div className={`notice ${m.unmatched.length || m.ambiguous.length ? 'warn' : ''}`}>
        <div>
          <strong>{m.updates.size.toLocaleString()}</strong> of {table.rows.length.toLocaleString()} rows matched a text. Labels to add:{' '}
          {m.columns.length ? m.columns.join(', ') : '(none)'}.
        </div>
        {m.unmatched.length > 0 && <div>Not found ({m.unmatched.length}): {list(m.unmatched)}</div>}
        {m.ambiguous.length > 0 && <div>Matches more than one text, skipped ({m.ambiguous.length}): {list(m.ambiguous)}</div>}
        {m.replaced.length > 0 && <div>Already present, values will be replaced: {m.replaced.join(', ')}</div>}
      </div>
    </Modal>
  );
}
