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
              <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden>
                <path d="M8 7h16v4h-6v14h-4V11H8z" fill="#fff" />
                <rect x="6" y="19" width="20" height="3" rx="1" fill="#f2b33d" opacity=".9" />
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
