import { useState } from 'react';
import { PROVIDERS } from '../lib/providers';
import { loadModels, setKey, setRememberKeys, useStore } from '../lib/store';
import type { ProviderId } from '../lib/types';
import { Modal } from './ui';

export function KeysDialog({ onClose }: { onClose: () => void }) {
  const keys = useStore((s) => s.keys);
  const remember = useStore((s) => s.rememberKeys);
  const status = useStore((s) => s.modelsStatus);
  const errors = useStore((s) => s.modelsError);
  const [draft, setDraft] = useState<Record<ProviderId, string>>({ ...keys });

  const save = async (p: ProviderId) => {
    setKey(p, draft[p]);
    if (draft[p].trim()) await loadModels(p);
  };
  // A key typed but not yet saved is kept on closing (it is checked in the background), not silently dropped.
  const close = () => {
    for (const p of Object.keys(PROVIDERS) as ProviderId[]) if (draft[p].trim() !== keys[p]) void save(p);
    onClose();
  };

  return (
    <Modal title="API keys" onClose={close} footer={<button className="btn primary" onClick={close}>Done</button>}>
      {(Object.keys(PROVIDERS) as ProviderId[]).map((p) => {
        const a = PROVIDERS[p];
        return (
          <div className="field" key={p}>
            <label htmlFor={`key-${p}`}>{a.label}</label>
            <div className="row">
              <input
                id={`key-${p}`}
                className="input grow mono"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={a.keyHint}
                value={draft[p]}
                onChange={(e) => setDraft((d) => ({ ...d, [p]: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && save(p)}
              />
              <button className="btn" onClick={() => save(p)} disabled={draft[p] === keys[p] && status[p] === 'ok'}>
                {status[p] === 'loading' ? 'Checking…' : 'Save & check'}
              </button>
            </div>
            <div className="hint">
              {status[p] === 'ok' && <span className="badge ok">Key works</span>}{' '}
              {status[p] === 'error' && <span className="hint err">{errors[p]}</span>}
              {status[p] !== 'error' && (
                <>
                  Create a key at{' '}
                  <a href={a.keyUrl} target="_blank" rel="noreferrer">
                    {new URL(a.keyUrl).host}
                  </a>
                  .
                </>
              )}
            </div>
          </div>
        );
      })}
      <label className="check" style={{ marginTop: 8 }}>
        <input type="checkbox" checked={remember} onChange={(e) => setRememberKeys(e.target.checked)} />
        <span>
          Remember keys in this browser
          <div className="hint">
            Off: keys are kept only until you close or reload the tab. On: stored unencrypted in this browser's local storage. Use on a
            personal computer only.
          </div>
        </span>
      </label>
      <div className="notice" style={{ marginTop: 14 }}>
        Requests go straight from your browser to the provider. Keys are never included in exports, logs or saved studies.
      </div>
    </Modal>
  );
}
