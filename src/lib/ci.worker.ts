// Bootstrap intervals for the Agreement panel, computed away from the page so it stays responsive
// (2,000 resamples of a full corpus take several seconds).
import { agreement, type Level } from './metrics';

export interface IntervalJob {
  a: string[];
  b: string[];
  level: Level;
  allowed: string[];
  tolerance: number;
  scaleSeen?: boolean;
  /** Plain-text scores: the range of the model's answers (see `agreement`). */
  range?: [number, number];
}

self.onmessage = (e: MessageEvent<IntervalJob>) => {
  const { a, b, level, allowed, tolerance, scaleSeen, range } = e.data;
  self.postMessage(agreement(a, b, level, allowed, tolerance, { scaleSeen, range }).ci);
};
