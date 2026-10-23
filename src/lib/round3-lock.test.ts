import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tabLock } from './tabLock';

// A stand-in for navigator.locks with one exclusive lock: requests are answered in order, a moment later (as in a
// browser), and `ifAvailable` requests get null while anyone holds it, this tab included.
function fakeLocks() {
  const f = {
    holder: null as 'me' | 'other' | null,
    requests: 0,
    request(name: string, _opts: LockOptions, cb: (lock: Lock | null) => unknown) {
      f.requests++;
      return new Promise((resolve, reject) =>
        setTimeout(() => {
          if (f.holder) return void Promise.resolve(cb(null)).then(resolve, reject);
          f.holder = 'me';
          Promise.resolve(cb({ name, mode: 'exclusive' } as Lock)).then((v) => {
            f.holder = null;
            resolve(v);
          }, reject);
        }, 1),
      );
    },
  };
  return f;
}

function setup(opts: { otherHolds?: boolean; focused?: boolean } = {}) {
  const locks = fakeLocks();
  if (opts.otherHolds) locks.holder = 'other';
  const state = { started: 0, otherTab: false, focused: opts.focused ?? true };
  const ask = tabLock(
    locks as unknown as Pick<LockManager, 'request'>,
    () => void state.started++,
    (other) => void (state.otherTab = other),
    () => state.focused,
  );
  return { locks, state, ask };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('one-tab lock (F11, F13, F23, F25, F30)', () => {
  it('visibilitychange and focus together send one request, and the tab that gets the app shows it', async () => {
    const { locks, state, ask } = setup();
    void ask();
    void ask();
    void ask();
    await vi.advanceTimersByTimeAsync(10);
    expect(locks.requests).toBe(1);
    expect(state.started).toBe(1);
    expect(state.otherTab).toBe(false);
    expect(locks.holder).toBe('me');
  });

  it('the same after the working tab was closed: the waiting tab takes over and stays open', async () => {
    const { locks, state, ask } = setup({ otherHolds: true, focused: false });
    const first = ask();
    await vi.advanceTimersByTimeAsync(10);
    expect(await first).toBe(false);
    expect(state.otherTab).toBe(true);
    locks.holder = null; // the working tab is closed
    // The user switches to this tab: visibilitychange and focus.
    state.focused = true;
    const a = ask();
    const b = ask();
    await vi.advanceTimersByTimeAsync(10);
    expect([await a, await b]).toEqual([true, true]);
    expect(state.started).toBe(1);
    expect(state.otherTab).toBe(false);
    // Later events send nothing.
    void ask();
    await vi.advanceTimersByTimeAsync(10);
    expect(locks.requests).toBe(2);
    expect(state.otherTab).toBe(false);
  });

  it('a click on Open here while the other tab is open is refused and says so; nothing starts', async () => {
    const { state, ask } = setup({ otherHolds: true });
    const p = ask();
    await vi.advanceTimersByTimeAsync(10);
    expect(await p).toBe(false);
    expect(state.started).toBe(0);
    expect(state.otherTab).toBe(true);
  });
});

describe('a waiting tab never asks on its own (F41, F96)', () => {
  it('a window merely in view does not take the app while the working tab reloads', async () => {
    const { locks, state, ask } = setup({ otherHolds: true, focused: false });
    void ask();
    // (At page load it asks again a few times for a moment, round four G25.)
    await vi.advanceTimersByTimeAsync(2000);
    expect(locks.requests).toBe(4);
    // The working tab is reloaded: the lock is free for a moment, then taken again by the reloaded page.
    for (let i = 0; i < 30; i++) {
      locks.holder = null;
      await vi.advanceTimersByTimeAsync(80);
      locks.holder = 'other';
      await vi.advanceTimersByTimeAsync(1920);
    }
    expect(locks.requests).toBe(4);
    expect(state.started).toBe(0);
    expect(state.otherTab).toBe(true);
  });

  it('closing the working tab brings this one to the front a moment early: it asks again shortly while focused', async () => {
    const { locks, state, ask } = setup({ otherHolds: true, focused: true });
    void ask();
    await vi.advanceTimersByTimeAsync(20);
    expect(state.otherTab).toBe(true);
    locks.holder = null; // the closed tab lets go of the lock ~20 ms later
    await vi.advanceTimersByTimeAsync(600);
    expect(state.started).toBe(1);
    expect(state.otherTab).toBe(false);
  });

  it('stops asking once the user leaves this tab, and asks a few times at most', async () => {
    const left = setup({ otherHolds: true, focused: false });
    void left.ask();
    await vi.advanceTimersByTimeAsync(2000); // the request at page load and its few repeats (round four G25)
    left.state.focused = true; // the user switches to this tab
    void left.ask();
    await vi.advanceTimersByTimeAsync(20);
    left.state.focused = false; // then clicks into the working window to reload it
    left.locks.holder = null;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(left.state.started).toBe(0);
    expect(left.locks.requests).toBe(5);

    const stays = setup({ otherHolds: true, focused: true });
    void stays.ask();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stays.locks.requests).toBe(4);
    expect(stays.state.started).toBe(0);
  });

  it('main.tsx has no timer of its own for the lock', () => {
    const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
    expect(main).not.toMatch(/setInterval/);
    expect(main).toMatch(/tabLock\(/);
  });
});

describe('without usable locks', () => {
  it('starts directly when the lock request fails', async () => {
    const state = { started: 0, otherTab: false };
    const ask = tabLock(
      { request: () => Promise.reject(new DOMException('no locks here', 'SecurityError')) } as unknown as Pick<LockManager, 'request'>,
      () => void state.started++,
      (other) => void (state.otherTab = other),
      () => true,
    );
    expect(await ask()).toBe(true);
    expect(await ask()).toBe(true);
    expect(state.started).toBe(1);
    expect(state.otherTab).toBe(false);
  });

  it('never starts without the lock when the lock was refused and only this tab’s own handling failed', async () => {
    // As in a browser: the request rejects with whatever its callback throws.
    const locks = {
      request: (_name: string, _opts: LockOptions, cb: (lock: Lock | null) => unknown) =>
        new Promise((resolve, reject) =>
          setTimeout(() => {
            try {
              resolve(cb(null));
            } catch (e) {
              reject(e);
            }
          }, 1),
        ),
    };
    let started = 0;
    const ask = tabLock(
      locks as unknown as Pick<LockManager, 'request'>,
      () => void started++,
      (other) => {
        if (other) throw new Error('could not show the notice');
      },
      () => false,
    );
    const p = ask();
    await vi.advanceTimersByTimeAsync(10);
    expect(await p).toBe(false);
    expect(started).toBe(0);
  });
});
