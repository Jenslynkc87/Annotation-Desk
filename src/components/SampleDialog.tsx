import { useMemo, useState } from 'react';
import { dependentSamples, drawStratifiedSample, heldValue, orderStrata, sampleNote, takenNote } from '../lib/sample';
import { currentStudy, markSample, useStore } from '../lib/store';
import { words } from '../lib/subject';
import { Modal, NumberField } from './ui';

/** Draw a stratified random sample (e.g. held-out validation texts) and mark it in a metadata column. */
export function SampleDialog({ onClose }: { onClose: () => void }) {
  const docs = useStore((s) => s.docs);
  const w = words({ subject: useStore((s) => currentStudy(s)!.prompt.subject) });
  // The study notes: each sample's recorded draw, named by a later draw that leaves its texts out.
  const notes = useStore((s) => currentStudy(s)?.description ?? '');
  const columns = useMemo(() => [...new Set(docs.flatMap((d) => Object.keys(d.meta)))], [docs]);
  const valuesOf = (c: string) => [...new Set(docs.map((d) => d.meta[c] ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  // Columns that group texts (era, journal, …): a few distinct values, not one per text. Listed (and the ticked
  // strata kept) in the fixed order a draw uses, whatever order they are ticked (sampling method 3).
  const groupColumns = orderStrata(columns.filter((c) => c !== 'file' && valuesOf(c).length >= 2 && valuesOf(c).length <= 200));
  const [size, setSize] = useState(100);
  const [strata, setStrata] = useState<string[]>([]);
  const [excludeCol, setExcludeCol] = useState('');
  const [excludeVal, setExcludeVal] = useState('');
  const [column, setColumn] = useState('sample');
  const [value, setValue] = useState('validation');
  const [seed, setSeed] = useState(() => 1 + Math.floor(Math.random() * 99999));
  const [marking, setMarking] = useState(false);
  const exclude = excludeCol && excludeVal ? { column: excludeCol, value: excludeVal } : null;
  // Texts already marked with another value in the column (an earlier sample) are not drawn: samples marked in one
  // column don't overlap, and an earlier sample keeps the texts its note counts. (A redraw, the same value, may take them.)
  const markedAs = column.trim() && value.trim() ? { column: column.trim(), value: value.trim() } : null;
  const r = useMemo(
    () => drawStratifiedSample(docs, { size, strata, exclude, seed, markedAs }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docs, size, strata, excludeCol, excludeVal, seed, markedAs?.column, markedAs?.value],
  );
  const takenCount = r.taken.reduce((n, t) => n + t.n, 0);
  const chosen = new Set(r.ids);
  const emptyGroups = r.strata.filter((s) => s.drawn === 0).length;
  const markedNow = new Set(docs.filter((d) => d.meta[column.trim()] === value.trim()).map((d) => d.id));
  const already = markedNow.size;
  // A redraw: how many of the texts marked now it keeps (the same seed gives other texts when the eligible texts
  // differ from those of the recorded draw), and the later draws that left those texts out.
  const keeps = r.ids.filter((id) => markedNow.has(id)).length;
  const dependents = already && markedAs ? dependentSamples(notes, markedAs.column, markedAs.value, w) : [];
  // File types (e.g. .md and .txt) in the sample versus the eligible texts, to check the mix is similar.
  const types = useMemo(() => {
    const ext = (f: string | undefined) => (f?.includes('.') ? f.slice(f.lastIndexOf('.') + 1).toLowerCase() : '');
    const all = new Map<string, [number, number]>();
    for (const d of docs) {
      if (exclude && (d.meta[exclude.column] ?? '').trim().toLowerCase() === exclude.value.trim().toLowerCase()) continue;
      if (markedAs && heldValue(d, markedAs)) continue;
      const e = ext(d.meta.file);
      if (!e) continue;
      const [n, k] = all.get(e) ?? [0, 0];
      all.set(e, [n + 1, k + (chosen.has(d.id) ? 1 : 0)]);
    }
    return all.size > 1 ? [...all.entries()] : [];
  }, [docs, r]);

  const apply = async () => {
    const [col, val] = [column.trim(), value.trim()];
    const date = new Date().toISOString().slice(0, 10);
    const note = sampleNote({ column: col, value: val, date, strata, exclude, seed }, r, w, notes);
    setMarking(true);
    const ok = await markSample(col, val, r.ids, note, seed).finally(() => setMarking(false));
    if (ok) onClose();
  };

  return (
    <Modal
      title="Draw a sample"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={marking || !r.ids.length || !column.trim() || !value.trim()} onClick={apply}>
            Mark {r.ids.length} {r.ids.length === 1 ? w.one : w.many} as {column} = {value}
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        Draws {w.many} at random, in proportion to the size of each group
        {emptyGroups
          ? ` (${emptyGroups} of ${r.strata.length} groups get${emptyGroups === 1 ? 's' : ''} no ${w.one}, as the sample is smaller than the number of groups)`
          : ', with at least one per group'}
        . The same seed gives the same sample from the same eligible {w.many};
        the rule and seed are saved with the study. Afterwards, filter the list by {column} = {value}, choose Select → all shown, and run the
        selection.
      </p>
      <div className="grid2">
        <div className="field">
          <label htmlFor="s-size">Number of {w.many}</label>
          <NumberField id="s-size" className="input" min={1} value={size} onChange={setSize} />
        </div>
        <div className="field">
          <label htmlFor="s-seed">Seed</label>
          <NumberField id="s-seed" className="input" value={seed} onChange={setSeed} />
        </div>
      </div>
      <div className="field">
        <span className="label">Stratify by</span>
        <div className="row" style={{ gap: 14 }}>
          {groupColumns.length ? (
            groupColumns.map((c) => (
              <label key={c} className="check">
                <input type="checkbox" checked={strata.includes(c)} onChange={(e) => setStrata(groupColumns.filter((x) => (x === c ? e.target.checked : strata.includes(x))))} />
                {c}
              </label>
            ))
          ) : (
            <span className="hint">No grouping columns yet (add era, journal, … from a spreadsheet).</span>
          )}
        </div>
      </div>
      <div className="grid2">
        <div className="field">
          <label htmlFor="s-excol">Leave out {w.many} where</label>
          <select id="s-excol" className="select" value={excludeCol} onChange={(e) => (setExcludeCol(e.target.value), setExcludeVal(''))}>
            <option value="">(leave nothing out)</option>
            {columns.filter((c) => valuesOf(c).length <= 200).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        {excludeCol && (
          <div className="field">
            <label htmlFor="s-exval">is</label>
            <select id="s-exval" className="select" value={excludeVal} onChange={(e) => setExcludeVal(e.target.value)}>
              <option value="">Choose…</option>
              {valuesOf(excludeCol).map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="grid2">
        <div className="field">
          <label htmlFor="s-col">Mark in column</label>
          <input id="s-col" className="input" value={column} onChange={(e) => setColumn(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="s-val">with the value</label>
          <input id="s-val" className="input" value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
      </div>
      <div className="notice">
        <div>
          {r.ids.length} of {r.eligible.toLocaleString()} eligible {w.many}{strata.length ? `, from ${r.strata.length} groups` : ''}.
          {types.length > 0 && <> File types: {types.map(([e, [n, k]]) => `${e} ${k} in the sample (${Math.round((100 * n) / Math.max(1, r.eligible))}% of eligible ${w.many})`).join(', ')}.</>}
        </div>
        {takenCount > 0 && (
          <div>
            Leaves out {takenNote(r, column.trim(), w, notes).replace(/^not from /, '')}, so the samples don’t overlap. To draw from {takenCount === 1 ? 'it' : 'them'} as well,
            mark this sample in another column.
          </div>
        )}
        {already > 0 && (
          <div>
            Replaces the {already} {already === 1 ? w.one : w.many} currently marked {column} = {value} (this draw keeps {keeps === already ? (already === 1 ? 'it' : 'all of them') : `${keeps} of them`}).
          </div>
        )}
        {dependents.length > 0 && (
          <div>
            The draw{dependents.length === 1 ? '' : 's'} of {dependents.join(' and ')} left out the {w.many} now marked {column} = {value}. So that{' '}
            {dependents.length === 1 ? 'it' : 'they'} can still be reproduced, the note of the draw that marked them stays in the study notes, marked as
            replaced.
          </div>
        )}
      </div>
      {strata.length > 0 && (
        <div className="table-wrap" style={{ maxHeight: 240, marginTop: 10 }}>
          <table className="data">
            <thead>
              <tr>
                <th>{strata.join(' · ')}</th>
                <th className="num">{w.Many}</th>
                <th className="num">Drawn</th>
              </tr>
            </thead>
            <tbody>
              {r.strata.map((s) => (
                <tr key={s.key}>
                  <td>{s.key}</td>
                  <td className="num">{s.available}</td>
                  <td className="num">{s.drawn}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
