import { useState } from 'react';
import { ExportView } from './components/ExportView';
import { KeysDialog } from './components/KeysDialog';
import { RunsView } from './components/RunsView';
import { StudyMenu } from './components/StudyMenu';
import { Icon } from './components/ui';
import { Workbench } from './components/Workbench';
import { currentStudy, dismissToast, updateStudy, useStore } from './lib/store';

type Tab = 'workbench' | 'runs' | 'export';

export function App() {
  const ready = useStore((s) => s.ready);
  const study = useStore((s) => currentStudy(s));
  const saving = useStore((s) => s.saving);
  const nRuns = useStore((s) => s.runs.length);
  const keys = useStore((s) => s.keys);
  const toasts = useStore((s) => s.toasts);
  const [tab, setTab] = useState<Tab>('workbench');
  const [keysOpen, setKeysOpen] = useState(false);
  const keyCount = Object.values(keys).filter(Boolean).length;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div className="brand-mark">
              <svg width="46" height="46" viewBox="0 0 32 32" aria-hidden>
                <g fill="#fff" opacity=".6"><rect x="12" y="7" width="14" height="2.6" rx="1.3"/><rect x="12" y="23.4" width="10" height="2.6" rx="1.3"/></g>
                <g fill="#fff"><rect x="12" y="12.2" width="14" height="2.6" rx="1.3"/><rect x="12" y="17.6" width="11" height="2.6" rx="1.3"/></g>
                <path d="M9.5 11H7v10.2h2.5" fill="none" stroke="#f2b33d" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
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
            <span className={`badge ${keyCount ? 'ok' : 'warn'}`}>{keyCount ? `${keyCount} set` : 'none'}</span>
          </button>
          <span className="save-status" title="Studies, texts and results are stored in this browser (IndexedDB).">
            <Icon name="check" size={14} /> {saving ? 'Saving…' : 'Saved in this browser'}
          </span>
        </div>
      </header>

      <main className="page">
        {!ready || !study ? (
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
            {tab === 'workbench' && <Workbench onOpenKeys={() => setKeysOpen(true)} />}
            {tab === 'runs' && <RunsView />}
            {tab === 'export' && <ExportView />}
          </>
        )}
      </main>

      <footer className="footer">
        <span>Annotation Desk v{__APP_VERSION__} · Runs entirely in your browser. API calls go directly to the provider you choose.</span>
        <span>Data stays in this browser until you export or delete it.</span>
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
