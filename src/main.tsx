import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { init, setOtherTab, toast } from './lib/store';
import { errorMessage } from './lib/util';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Anything that goes wrong outside a handler (e.g. a failed save) is shown, not left silent.
window.addEventListener('unhandledrejection', (e) => toast(`Something went wrong: ${errorMessage(e.reason) || 'unknown error'}`, 'error'));

// One tab at a time: two tabs on the same data could send (and pay for) the same requests twice, or overwrite each
// other's changes. A second tab waits, and opens by itself once the first one is closed.
const LOCK = 'annotation-desk-app';
const hold = () => new Promise<void>(() => {});
if (navigator.locks) {
  void navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
    if (lock) {
      void init();
      return hold();
    }
    setOtherTab(true);
    void navigator.locks.request(LOCK, async () => {
      setOtherTab(false);
      void init();
      return hold();
    });
  });
} else {
  void init();
}
