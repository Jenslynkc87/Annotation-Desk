import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { init, isQuotaError, setOtherTab, storageError, toast } from './lib/store';
import { tabLock } from './lib/tabLock';
import { errorMessage } from './lib/util';
import './styles.css';

// One tab at a time (see lib/tabLock.ts). Browsers without Web Locks start directly.
const ask = navigator.locks
  ? tabLock(navigator.locks, () => void init(), setOtherTab, () => document.visibilityState === 'visible' && document.hasFocus())
  : undefined;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App openHere={ask} />
  </StrictMode>,
);

// Ask the browser to keep this site's data (studies, texts, results) even when the disk runs low; without this it may
// clear it without asking. The browser decides (Chrome and Edge silently, Firefox may ask once); asked again on each
// load, since Chrome grants it more readily to sites used often. Nothing changes if it is refused or unsupported.
try {
  void navigator.storage
    ?.persisted?.()
    .then((kept) => kept || navigator.storage.persist())
    .catch(() => undefined);
} catch {
  /* not available */
}

// Anything that goes wrong outside a handler (e.g. a failed save) is shown, not left silent.
window.addEventListener('unhandledrejection', (e) =>
  toast(`Something went wrong: ${isQuotaError(e.reason) ? storageError(e.reason) : errorMessage(e.reason) || 'unknown error'}`, 'error'),
);

// A waiting tab asks again only when the user turns to it: switches to it or clicks in it (or clicks Open here). The
// first request (at page load) is asked again a few times for a moment (see lib/tabLock.ts).
if (ask) {
  void ask();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void ask();
  });
  window.addEventListener('focus', () => void ask());
} else {
  void init();
}
