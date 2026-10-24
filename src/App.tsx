import { useEffect, useState } from 'react';
import { ExportView } from './components/ExportView';
import { KeysDialog } from './components/KeysDialog';
import { RunsView } from './components/RunsView';
import { StudyMenu } from './components/StudyMenu';
import { Icon } from './components/ui';
import { Workbench } from './components/Workbench';
import { useBackgroundRunning } from './lib/background';
import { currentStudy, dismissToast, isBusy, updateStudy, useStore } from './lib/store';

type Tab = 'workbench' | 'runs' | 'export';

/** `openHere` asks for the app when another tab runs it (see lib/tabLock.ts); undefined without Web Locks. */
export function App({ openHere }: { openHere?: () => Promise<boolean> }) {
  const ready = useStore((s) => s.ready);
  const study = useStore((s) => currentStudy(s));
  const saving = useStore((s) => s.saving);
  const saveError = useStore((s) => s.saveError);
  const otherTab = useStore((s) => s.otherTab);
  const nRuns = useStore((s) => s.runs.length);
  const keys = useStore((s) => s.keys);
  const toasts = useStore((s) => s.toasts);
  const [tab, setTab] = useState<Tab>('workbench');
  const [keysOpen, setKeysOpen] = useState(false);
  const keyCount = Object.values(keys).filter(Boolean).length;
  // A key that was set but failed its check (e.g. 401) should not look fine in the top bar.
  const modelsStatus = useStore((s) => s.modelsStatus);
  const modelsError = useStore((s) => s.modelsError);
  const failing = (Object.keys(keys) as (keyof typeof keys)[]).filter((p) => keys[p] && modelsStatus[p] === 'error');
  // Closing or reloading the tab stops a run that is being sent, a batch being uploaded, a backup being imported or a
  // download being built (lib/background.ts), and loses a change not yet saved: ask first.
  const building = useBackgroundRunning();
  const busy = useStore((s) => isBusy(s) || s.importing || !!s.saveError) || building;
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div className="brand-mark">
              <svg width="46" height="46" viewBox="0 0 32 32" aria-hidden>
                <g fill="#fff" opacity=".6"><rect x="12" y="7" width="14" height="2.6" rx="1.3"/><rect x="12" y="23.4" width="10" height="2.6" rx="1.3"/></g>
                <g fill="#fff"><rect x="12" y="12.2" width="14" height="2.6" rx="1.3"/><rect x="12" y="17.6" width="11" height="2.6" rx="1.3"/></g>
                <path d="M9.5 11H7v10.2h2.5" fill="none" stroke="#f2b33d" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div>
              <div className="brand-name">Annotation Desk</div>
              <div className="brand-sub">LLM-assisted text annotation for research</div>
            </div>
          </div>
          <div className="topbar-spacer" />
          {ready && <StudyMenu />}
          <button className="btn" onClick={() => setKeysOpen(true)}>
            <Icon name="key" /> API keys
            {failing.length ? (
              <span className="badge err" title={failing.map((p) => modelsError[p]).join(' ')}>
                check failed
              </span>
            ) : (
              <span className={`badge ${keyCount ? 'ok' : 'warn'}`}>{keyCount ? `${keyCount} set` : 'none'}</span>
            )}
          </button>
          {saveError ? (
            <span className="save-status err" title={`Your latest changes could not be saved: ${saveError}. They are tried again every few seconds.`}>
              Not saved: storage full?
            </span>
          ) : (
            <span className="save-status" title="Studies, texts and results are stored in this browser (IndexedDB).">
              <Icon name="check" size={14} /> {saving ? 'Saving…' : 'Saved in this browser'}
            </span>
          )}
        </div>
      </header>

      <main className="page">
        {otherTab ? (
          <OtherTabNotice openHere={openHere} />
        ) : !ready || !study ? (
          <div className="empty">Loading…</div>
        ) : (
          <>
            <div className="study-head">
              <input
                className="study-title"
                value={study.name}
                aria-label="Study name"
                onChange={(e) => updateStudy((s) => void (s.name = e.target.value))}
              />
            </div>
            <nav className="tabs">
              <button className={`tab ${tab === 'workbench' ? 'active' : ''}`} onClick={() => setTab('workbench')}>Workbench</button>
              <button className={`tab ${tab === 'runs' ? 'active' : ''}`} onClick={() => setTab('runs')}>
                Runs &amp; agreement<span className="count">{nRuns}</span>
              </button>
              <button className={`tab ${tab === 'export' ? 'active' : ''}`} onClick={() => setTab('export')}>Export</button>
            </nav>
            {/* Keyed by study: filters, selections and chosen runs belong to one study and start fresh in another. */}
            {tab === 'workbench' && <Workbench key={study.id} onOpenKeys={() => setKeysOpen(true)} />}
            {tab === 'runs' && <RunsView key={study.id} />}
            {tab === 'export' && <ExportView key={study.id} />}
          </>
        )}
      </main>

      <footer className="footer">
        <span>Annotation Desk v{__APP_VERSION__} · Runs entirely in your browser. API calls go directly to the provider you choose.</span>
        <span>Data is stored in this browser, which can clear it (e.g. when the disk is full): keep a study backup (Export).</span>
      </footer>

      {keysOpen && <KeysDialog onClose={() => setKeysOpen(false)} />}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span>{t.text}</span>
            <button onClick={() => dismissToast(t.id)} aria-label="Dismiss">✕</button>
          </div>
        ))}
      </div>
    </>
  );
}

/** Another tab or window runs the app. This tab asks again when the user comes back to it, or clicks Open here. */
function OtherTabNotice({ openHere }: { openHere?: () => Promise<boolean> }) {
  const [stillOpen, setStillOpen] = useState(false);
  return (
    <div className="notice warn" style={{ maxWidth: 640, margin: '40px auto' }}>
      <strong>Annotation Desk is already open in another tab or window of this browser.</strong> It works in one tab at a time, so that the
      same requests are never sent (and paid for) twice and changes don’t overwrite each other. Switch to the other tab, or close it: this tab
      then opens when you come back to it, or when you click Open here.
      {openHere && (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={async () => setStillOpen(!(await openHere()))}>
            Open here
          </button>
          {stillOpen && <span>It is still open in another tab or window: close it there first.</span>}
        </div>
      )}
    </div>
  );
}
