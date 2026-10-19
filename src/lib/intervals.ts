import type { IntervalJob } from './ci.worker';
import { agreement, type Agreement } from './metrics';

let running: Worker | null = null;

/**
 * Compute the 95% bootstrap intervals in a background worker and call `done` with them. Only one job runs at
 * a time: starting a new one (e.g. another field picked) stops the previous one. Returns a function that
 * stops this job. Where workers aren't available, the intervals are computed right away instead.
 */
export function computeIntervals(job: IntervalJob, done: (ci: Agreement['ci']) => void): () => void {
  running?.terminate();
  const direct = () => done(agreement(job.a, job.b, job.level, job.allowed, job.tolerance, { scaleSeen: job.scaleSeen }).ci);
  let w: Worker;
  try {
    w = new Worker(new URL('./ci.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    direct();
    return () => {};
  }
  running = w;
  const stop = () => {
    w.terminate();
    if (running === w) running = null;
  };
  w.onmessage = (e: MessageEvent<Agreement['ci']>) => {
    stop();
    done(e.data);
  };
  w.onerror = () => {
    stop();
    direct();
  };
  w.postMessage(job);
  return stop;
}
