import { useRef } from 'react';
import { importBackup } from '../lib/export/backup';
import { createStudy, currentStudy, duplicateStudy, getState, isBusy, refreshStudies, removeStudy, selectStudy, toast, useStore } from '../lib/store';
import { errorMessage, fmtDateTime } from '../lib/util';
import { Icon, Menu } from './ui';

export function StudyMenu() {
  const studies = useStore((s) => s.studies);
  const current = useStore((s) => currentStudy(s));
  // While a run is being sent or uploaded, the open study must stay open (and in place).
  const busy = useStore((s) => isBusy(s));
  const fileRef = useRef<HTMLInputElement>(null);

  const onImport = async (f: File | undefined) => {
    if (!f) return;
    try {
      toast(`Importing ${f.name}…`);
      const s = await importBackup(f);
      await refreshStudies();
      await selectStudy(s.id);
      toast(`Imported "${s.name}".`, 'success');
    } catch (e) {
      toast(`Import failed: ${errorMessage(e)}`, 'error');
    }
  };

  return (
    <>
      <Menu
        button={(toggle) => (
          <button className="btn" onClick={toggle} title="Switch, create or manage studies">
            Studies <span className="badge muted">{studies.length}</span> <Icon name="chevron" size={14} />
          </button>
        )}
      >
        {(close) => (
          <>
            {studies.map((s) => (
              <button
                key={s.id}
                disabled={busy && s.id !== current?.id}
                className={`menu-item ${s.id === current?.id ? 'active' : ''}`}
                onClick={() => {
                  close();
                  void selectStudy(s.id);
                }}
              >
                {s.name || 'Untitled'}
                <small>{fmtDateTime(s.updatedAt)}</small>
              </button>
            ))}
            <div className="menu-sep" />
            {busy && <div className="menu-note">A run is in progress: switch, add or delete studies when it has finished.</div>}
            <button
              className="menu-item"
              disabled={busy}
              onClick={() => {
                close();
                void createStudy('Untitled study');
              }}
            >
              <Icon name="plus" size={14} /> New study
            </button>
            <button className="menu-item" disabled={busy} onClick={() => (close(), void duplicateStudy(false))}>
              Duplicate settings & prompt
            </button>
            <button className="menu-item" disabled={busy} onClick={() => (close(), void duplicateStudy(true))}>
              Duplicate with texts
            </button>
            <button className="menu-item" disabled={busy} onClick={() => (close(), fileRef.current?.click())}>
              Import study backup (.json)…
            </button>
            <div className="menu-sep" />
            <button
              className="menu-item"
              style={{ color: 'var(--err)' }}
              disabled={busy}
              onClick={() => {
                close();
                const s = getState();
                const cur = currentStudy(s);
                if (!cur) return;
                const pending = s.runs.filter((r) => r.status === 'submitted').length;
                const note = pending ? ` ${pending} batch${pending === 1 ? ' is' : 'es are'} still processing and will be cancelled.` : '';
                if (confirm(`Delete "${cur.name}" with all ${s.docs.length} texts and ${s.runs.length} runs?${note} This cannot be undone.`)) {
                  void removeStudy(cur.id);
                }
              }}
            >
              <Icon name="trash" size={14} /> Delete this study…
            </button>
          </>
        )}
      </Menu>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          void onImport(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </>
  );
}

