import { useRef, useState } from 'react';
import { importBackup } from '../lib/export/backup';
import {
  batchParts,
  createStudy,
  currentStudy,
  duplicateStudy,
  getState,
  isBusy,
  refreshStudies,
  removeStudy,
  selectStudy,
  setImporting,
  sharedBatches,
  sharedUnknownUpload,
  storageError,
  toast,
  unknownUpload,
  useStore,
} from '../lib/store';
import { words } from '../lib/subject';
import { fmtDateTime } from '../lib/util';
import { runName } from '../lib/view';
import { copyElsewhere, OTHER_STUDY_HERE, quoted } from './RunsView';
import { Icon, Menu, Modal } from './ui';

export function StudyMenu() {
  const studies = useStore((s) => s.studies);
  const current = useStore((s) => currentStudy(s));
  // While a run is being sent or uploaded, the open study must stay open (and in place).
  const busy = useStore((s) => isBusy(s));
  const importing = useStore((s) => s.importing);
  const fileRef = useRef<HTMLInputElement>(null);
  const w = words({ subject: current?.prompt.subject });
  const [choosing, setChoosing] = useState(false);
  const start = (subject?: 'entries') => {
    setChoosing(false);
    void createStudy(subject ? 'Untitled model-knowledge study' : 'Untitled study', subject);
  };

  const onImport = async (f: File | undefined) => {
    if (!f) return;
    // (Meanwhile, closing the tab asks first: a partial study would be removed at the next start.)
    setImporting(true);
    try {
      toast(`Importing ${f.name}…`);
      const s = await importBackup(f);
      toast(`Imported “${s.name}”.`, 'success');
      try {
        await refreshStudies();
        await selectStudy(s.id);
      } catch (e) {
        toast(`The imported study is saved, but could not be opened: ${storageError(e)}`, 'error');
      }
    } catch (e) {
      // (A full storage often comes with no message at all.)
      toast(`Import failed: ${storageError(e)}`, 'error');
    } finally {
      setImporting(false);
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
            <button className="menu-item" disabled={busy || importing} onClick={() => (close(), fileRef.current?.click())}>
              {importing ? 'Importing a study backup…' : 'Import study backup (.json)…'}
            </button>
            <div className="menu-sep" />
            <button
              className="menu-item"
              style={{ color: 'var(--err)' }}
              disabled={busy}
              onClick={async () => {
                close();
                const s = getState();
                const cur = currentStudy(s);
                if (!cur) return;
                // Batches still processing are cancelled, except one that another study here also waits for (a copy of
                // this study made through a backup, or the study it was copied from): that one is left running for it,
                // which collects it. A copy in another browser can't be seen from here: the note says so.
                let cancelled = 0;
                const kept = new Set<string>();
                const copies = new Set<string>();
                for (const r of s.runs.filter((x) => x.status === 'submitted')) {
                  const shared = await sharedBatches(r).catch(() => new Map<string, string>());
                  for (const p of batchParts(r).filter((x) => x.status === 'submitted')) {
                    if (shared.has(p.batchId)) {
                      kept.add(p.batchId);
                      copies.add(shared.get(p.batchId)!);
                    } else cancelled++;
                  }
                }
                const left = kept.size;
                // Batch uploads of unknown outcome may have reached the provider: looked up there and cancelled if found,
                // except one another study here shares (a copy, or the study it was copied from): left to it.
                const unsure: string[] = [];
                const leftUploads: string[] = [];
                const sharers = new Set<string>();
                for (const r of s.runs.filter((x) => unknownUpload(x))) {
                  const others = await sharedUnknownUpload(r).catch(() => [] as string[]);
                  others.forEach((x) => sharers.add(x));
                  (others.length ? leftUploads : unsure).push(`#${runName(r, s.runs)}`);
                }
                const runsWord = (list: string[]) => `run${list.length === 1 ? '' : 's'} ${list.join(', ')}`;
                const note =
                  (cancelled ? ` ${cancelled} batch${cancelled === 1 ? ' is' : 'es are'} still processing and will be cancelled. ${copyElsewhere(cancelled)}` : '') +
                  (left
                    ? ` ${left === 1 ? 'A batch' : `${left} batches`} still processing ${left === 1 ? 'is' : 'are'} left running: ${quoted([...copies])} (${OTHER_STUDY_HERE}) also ${copies.size === 1 ? 'waits' : 'wait'} for ${left === 1 ? 'it' : 'them'}.`
                    : '') +
                  (unsure.length
                    ? ` A batch upload of ${runsWord(unsure)} may have reached the provider: ${unsure.length === 1 ? 'it is' : 'they are'} looked up there first and cancelled if found.`
                    : '') +
                  (leftUploads.length
                    ? ` A batch upload of unknown outcome of ${runsWord(leftUploads)} is left for ${quoted([...sharers])} (${OTHER_STUDY_HERE}), which ${sharers.size === 1 ? 'shares' : 'share'} that upload.`
                    : '');
                if (confirm(`Delete “${cur.name}” with all ${s.docs.length} ${words(cur.prompt).many} and ${s.runs.length} runs?${note} This cannot be undone.`)) {
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

