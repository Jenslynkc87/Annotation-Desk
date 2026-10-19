import { useRef, useState } from 'react';
import { importBackup } from '../lib/export/backup';
import { createStudy, currentStudy, duplicateStudy, getState, isBusy, refreshStudies, removeStudy, selectStudy, toast, useStore } from '../lib/store';
import { words } from '../lib/subject';
import { errorMessage, fmtDateTime } from '../lib/util';
import { Icon, Menu, Modal } from './ui';

export function StudyMenu() {
  const studies = useStore((s) => s.studies);
  const current = useStore((s) => currentStudy(s));
  // While a run is being sent or uploaded, the open study must stay open (and in place).
  const busy = useStore((s) => isBusy(s));
  const fileRef = useRef<HTMLInputElement>(null);
  const w = words({ subject: current?.prompt.subject });
  const [choosing, setChoosing] = useState(false);
  const start = (subject?: 'entries') => {
    setChoosing(false);
    void createStudy(subject ? 'Untitled model-knowledge study' : 'Untitled study', subject);
  };

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
                setChoosing(true);
              }}
            >
              <Icon name="plus" size={14} /> New study…
            </button>
            <button className="menu-item" disabled={busy} onClick={() => (close(), void duplicateStudy(false))}>
              Duplicate settings & prompt
            </button>
            <button className="menu-item" disabled={busy} onClick={() => (close(), void duplicateStudy(true))}>
              Duplicate with {w.many}
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
                if (confirm(`Delete "${cur.name}" with all ${s.docs.length} ${words(cur.prompt).many} and ${s.runs.length} runs?${note} This cannot be undone.`)) {
                  void removeStudy(cur.id);
                }
              }}
            >
              <Icon name="trash" size={14} /> Delete this study…
            </button>
          </>
        )}
      </Menu>
      {choosing && (
        <Modal title="New study" onClose={() => setChoosing(false)}>
          <p className="hint" style={{ marginTop: 0 }}>
            What will you annotate? This can't be changed later.
          </p>
          <div className="kind-choice">
            <button className="kind-option" onClick={() => start()}>
              <strong>Texts</strong>
              <span>Texts you add: articles, documents, posts, interviews, … The model reads each text.</span>
            </button>
            <button className="kind-option" onClick={() => start('entries')}>
              <strong>Entries, from the model’s own knowledge</strong>
              <span>
                People, organizations, works, places, events, … each described by a few details (e.g. name, year, country). The model answers from what it
                knows; no texts are needed.
              </span>
            </button>
          </div>
        </Modal>
      )}
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

