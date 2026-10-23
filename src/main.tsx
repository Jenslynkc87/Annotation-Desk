import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { init, isQuotaError, setOtherTab, storageError, toast } from './lib/store';
import { errorMessage } from './lib/util';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Anything that goes wrong outside a handler (e.g. a failed save) is shown, not left silent.
window.addEventListener('unhandledrejection', (e) =>
  toast(`Something went wrong: ${isQuotaError(e.reason) ? storageError(e.reason) : errorMessage(e.reason) || 'unknown error'}`, 'error'),
);

// One tab at a time: two tabs on the same data could send (and pay for) the same requests twice, or overwrite each
// other's changes. A second tab waits. It takes over only while it is the tab in view, and only once the first tab
// is closed (not when the first tab is merely reloaded: the reloaded tab gets the app back).
const LOCK = 'annotation-desk-app';
const hold = () => new Promise<void>(() => {});
let started = false;
const tryStart = () =>
  navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) return setOtherTab(true);
    started = true;
    setOtherTab(false);
    void init();
    return hold();
  });
if (navigator.locks) {
  void tryStart();
  const retry = () => {
    if (!started && document.visibilityState === 'visible') void tryStart();
  };
  document.addEventListener('visibilitychange', retry);
  window.addEventListener('focus', retry);
  setInterval(retry, 2000);
} else {
  void init();
}
