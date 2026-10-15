import { useRef } from 'react';
import { importBackup } from '../lib/export/backup';
import { createStudy, currentStudy, duplicateStudy, getState, refreshStudies, removeStudy, selectStudy, toast, useStore } from '../lib/store';
import { errorMessage, fmtDateTime } from '../lib/util';
import { Icon, Menu } from './ui';

export function StudyMenu() {
  const studies = useStore((s) => s.studies);
  const current = useStore((s) => currentStudy(s));
  const fileRef = useRef<HTMLInputElement>(null);

  const onImport = async (f: File | undefined) => {
    if (!f) return;
    try {
      const s = await importBackup(await f.text());
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
            <button
              className="menu-item"
              onClick={() => {
                close();
                void createStudy('Untitled study');
              }}
            >
              <Icon name="plus" size={14} /> New study
            </button>
            <button className="menu-item" onClick={() => (close(), void duplicateStudy(false))}>
              Duplicate settings & prompt
            </button>
            <button className="menu-item" onClick={() => (close(), void duplicateStudy(true))}>
              Duplicate with texts
            </button>
            <button className="menu-item" onClick={() => (close(), fileRef.current?.click())}>
              Import study backup (.json)…
            </button>
            <div className="menu-sep" />
            <button
              className="menu-item"
              style={{ color: 'var(--err)' }}
              onClick={() => {
                close();
                const s = getState();
                const cur = currentStudy(s);
                if (!cur) return;
                if (confirm(`Delete "${cur.name}" with all ${s.docs.length} texts and ${s.runs.length} runs? This cannot be undone.`)) {
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

