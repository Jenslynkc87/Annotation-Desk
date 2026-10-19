import { useMemo, useState } from 'react';
import { drawStratifiedSample, SAMPLING_METHOD } from '../lib/sample';
import { currentStudy, markSample, useStore } from '../lib/store';
import { words } from '../lib/subject';
import { Modal, NumberField } from './ui';

/** Draw a stratified random sample (e.g. held-out validation texts) and mark it in a metadata column. */
export function SampleDialog({ onClose }: { onClose: () => void }) {
  const docs = useStore((s) => s.docs);
  const w = words({ subject: useStore((s) => currentStudy(s)!.prompt.subject) });
  const columns = useMemo(() => [...new Set(docs.flatMap((d) => Object.keys(d.meta)))], [docs]);
  const valuesOf = (c: string) => [...new Set(docs.map((d) => d.meta[c] ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  // Columns that group texts (era, journal, …): a few distinct values, not one per text.
  const groupColumns = columns.filter((c) => c !== 'file' && valuesOf(c).length >= 2 && valuesOf(c).length <= 200);
  const [size, setSize] = useState(100);
  const [strata, setStrata] = useState<string[]>([]);
  const [excludeCol, setExcludeCol] = useState('');
  const [excludeVal, setExcludeVal] = useState('');
  const [column, setColumn] = useState('sample');
  const [value, setValue] = useState('validation');
  const [seed, setSeed] = useState(() => 1 + Math.floor(Math.random() * 99999));
  const exclude = excludeCol && excludeVal ? { column: excludeCol, value: excludeVal } : null;
  const r = useMemo(() => drawStratifiedSample(docs, { size, strata, exclude, seed }), [docs, size, strata, excludeCol, excludeVal, seed]);
  const chosen = new Set(r.ids);
  const already = docs.filter((d) => d.meta[column] === value).length;
  // File types (e.g. .md and .txt) in the sample versus the eligible texts, to check the mix is similar.
  const types = useMemo(() => {
    const ext = (f: string | undefined) => (f?.includes('.') ? f.slice(f.lastIndexOf('.') + 1).toLowerCase() : '');
    const all = new Map<string, [number, number]>();
    for (const d of docs) {
      if (exclude && (d.meta[exclude.column] ?? '').trim().toLowerCase() === exclude.value.trim().toLowerCase()) continue;
      const e = ext(d.meta.file);
      if (!e) continue;
      const [n, k] = all.get(e) ?? [0, 0];
      all.set(e, [n + 1, k + (chosen.has(d.id) ? 1 : 0)]);
    }
    return all.size > 1 ? [...all.entries()] : [];
  }, [docs, r]);

  const apply = async () => {
    const date = new Date().toISOString().slice(0, 10);
    const note =
      `Sample ${column} = ${value} (${date}): ${r.ids.length} of ${r.eligible} ${w.many} drawn at random` +
      (strata.length ? ` within ${strata.join(' × ')} strata (proportional allocation, at least one per stratum)` : '') +
      (exclude ? `, excluding ${exclude.column} = ${exclude.value}` : '') +
      `; seed ${seed} (${SAMPLING_METHOD}).`;
    await markSample(column.trim(), value.trim(), r.ids, note, seed);
    onClose();
  };

  return (
    <Modal
      title="Draw a sample"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!r.ids.length || !column.trim() || !value.trim()} onClick={apply}>
            Mark {r.ids.length} {r.ids.length === 1 ? w.one : w.many} as {column} = {value}
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        Draws {w.many} at random, in proportion to the size of each group, with at least one per group. The same seed always gives the same sample;
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
                <input type="checkbox" checked={strata.includes(c)} onChange={(e) => setStrata(e.target.checked ? [...strata, c] : strata.filter((x) => x !== c))} />
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
        {already > 0 && <div>Replaces the {already} {already === 1 ? w.one : w.many} currently marked {column} = {value}.</div>}
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
