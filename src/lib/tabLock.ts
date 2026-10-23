// One tab at a time: two tabs on the same data could send (and pay for) the same requests twice, or overwrite each
// other's changes. The tab that runs the app holds a Web Lock until it is closed or reloaded. Another tab shows a
// notice and asks for the lock again only when the user turns to it (switches to it, clicks in it, or clicks
// "Open here"), never on a timer of its own: a window that is merely in view must not take the app from a tab that is
// being reloaded (the lock is free for a moment during a reload).

export const LOCK = 'annotation-desk-app';

/**
 * Returns `ask`: asks for the app without waiting for it (true when this tab runs it). If refused, it asks again a
 * few times for a moment afterwards, but only while this tab keeps the focus.
 */
export function tabLock(
  locks: Pick<LockManager, 'request'>,
  start: () => void,
  setOther: (other: boolean) => void,
  focused: () => boolean,
): () => Promise<boolean> {
  let started = false;
  // One request at a time: e.g. visibilitychange and focus fire together when the user switches to this tab.
  let pending: Promise<boolean> | undefined;
  let again: ReturnType<typeof setTimeout> | undefined;

  const begin = () => {
    started = true;
    setOther(false);
    start();
  };
  const once = () =>
    new Promise<boolean>((resolve) => {
      let answered = false;
      locks
        .request(LOCK, { ifAvailable: true }, (lock) => {
          answered = true;
          if (!lock) {
            // A refusal never hides a running app (this tab's own lock would refuse a second request).
            if (!started) setOther(true);
            resolve(started);
            return;
          }
          begin();
          resolve(true);
          return new Promise<void>(() => {}); // held until this tab is closed or reloaded
        })
        .catch(() => {
          // Locks unusable here (e.g. a sandboxed frame): start without them, as in browsers that have none. Not when
          // the lock did answer and only this tab's own handling failed: another tab may hold it.
          if (!answered && !started) begin();
          resolve(started);
        });
    });
  const attempt = () => {
    if (started) return Promise.resolve(true);
    pending ??= once().finally(() => (pending = undefined));
    return pending;
  };
  // Closing the working tab brings this one to the front a moment before the closed tab lets go of the lock (about
  // 20 ms in Chrome): ask again shortly while this tab keeps the focus. A tab the user has left stops asking.
  const ask = (tries: number): Promise<boolean> => {
    clearTimeout(again);
    return attempt().then((ok) => {
      if (!ok && tries > 1) {
        clearTimeout(again);
        again = setTimeout(() => {
          if (focused()) void ask(tries - 1);
        }, 500);
      }
      return ok;
    });
  };
  return () => ask(4);
}
