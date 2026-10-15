import { useMemo, useRef, useState } from 'react';
import {
  ACCEPTED_EXTENSIONS,
  baseName,
  guessIdColumn,
  guessTextColumn,
  parseFile,
  splitPasted,
  type ParsedTable,
} from '../lib/import/parse';
import { guessKeyColumn, matchLabels } from '../lib/import/labels';
import { addDocs, addLabels, toast, useStore } from '../lib/store';
import { countWords } from '../lib/util';
import { Icon, Modal } from './ui';

type NewDoc = { docId: string; text: string; meta: Record<string, string>; source: string };

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

  const handleFiles = async (files: File[]) => {
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
          void handleFiles([...e.dataTransfer.files]);
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
          <button className="btn small" onClick={() => labelsRef.current?.click()} title="Add human labels (an answer key) to the texts already here, matched by file name or ID">
            Add labels from a spreadsheet…
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
      {paste && <PasteDialog onClose={() => setPaste(false)} />}
      {labels && <LabelsDialog table={labels} onDone={() => setLabels(null)} />}
      {tables.length > 0 && <TableDialog table={tables[0]} onDone={() => setTables((t) => t.slice(1))} />}
    </>
  );
}

function PasteDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'none' | 'blank' | 'line'>('none');
  const [prefix, setPrefix] = useState('pasted');
  const items = splitPasted(text, mode);
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
          <button className="btn primary" disabled={!items.length} onClick={add}>
            Add {items.length || ''} text{items.length === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <textarea className="textarea" rows={12} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste one or more texts…" />
      <div className="grid2" style={{ marginTop: 12 }}>
        <div className="field">
          <span className="label">Split into separate texts</span>
          <select className="select" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="none">No: one text</option>
            <option value="blank">At blank lines (paragraphs)</option>
            <option value="line">At every line</option>
          </select>
        </div>
        <div className="field">
          <span className="label">ID prefix</span>
          <input className="input mono" value={prefix} onChange={(e) => setPrefix(e.target.value.replace(/\s+/g, '_') || 'pasted')} />
        </div>
      </div>
      <div className="hint">
        {items.length} text{items.length === 1 ? '' : 's'} · {countWords(text).toLocaleString()} words
      </div>
    </Modal>
  );
}

function TableDialog({ table, onDone }: { table: ParsedTable; onDone: () => void }) {
  const [textCol, setTextCol] = useState(guessTextColumn(table));
  const [idCol, setIdCol] = useState(guessIdColumn(table));
  const [skipEmpty, setSkipEmpty] = useState(true);
  const rows = skipEmpty ? table.rows.filter((r) => (r[textCol] ?? '').trim()) : table.rows;
  const metaCols = table.columns.filter((c) => c !== textCol && c !== idCol);
  const add = async () => {
    const base = baseName(table.name);
    const docs = rows.map((r, i) => ({
      docId: idCol ? String(r[idCol] ?? '').trim() || `${base}_${i + 1}` : `${base}_${i + 1}`,
      text: String(r[textCol] ?? ''),
      meta: Object.fromEntries(metaCols.map((c) => [c, String(r[c] ?? '')])),
      source: table.name,
    }));
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
          <button className="btn primary" disabled={!textCol || !rows.length} onClick={add}>
            Import {rows.length.toLocaleString()} texts
          </button>
        </>
      }
    >
      <div className="grid2">
        <div className="field">
          <label>Text column</label>
          <select className="select" value={textCol} onChange={(e) => setTextCol(e.target.value)}>
            {table.columns.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>ID column</label>
          <select className="select" value={idCol} onChange={(e) => setIdCol(e.target.value)}>
            <option value="">(number the rows)</option>
            {table.columns.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={skipEmpty} onChange={(e) => setSkipEmpty(e.target.checked)} /> Skip rows with an empty text
      </label>
      <p className="hint">
        All other columns are kept as metadata{metaCols.length ? `: ${metaCols.slice(0, 8).join(', ')}${metaCols.length > 8 ? '…' : ''}` : ''}. Columns with
        human or gold-standard labels can be compared with model annotations under <em>Runs &amp; agreement</em>.
      </p>
      <div className="table-wrap" style={{ maxHeight: 260 }}>
        <table className="data">
          <thead>
            <tr>
              {table.columns.slice(0, 6).map((c) => (
                <th key={c} className={c === textCol || c === idCol ? 'col-role' : ''}>
                  {c}
                  {c === textCol && <span className="badge" style={{ marginLeft: 6 }}>used as text</span>}
                  {c === idCol && <span className="badge" style={{ marginLeft: 6 }}>used as ID</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.slice(0, 5).map((r, i) => (
              <tr key={i}>
                {table.columns.slice(0, 6).map((c) => (
                  <td key={c} className={c === textCol || c === idCol ? 'col-role' : ''}>
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
