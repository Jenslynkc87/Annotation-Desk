import { describe, expect, it } from 'vitest';
import { agreement, BOOTSTRAP_RESAMPLES, cohenKappa, gwetAC1, gwetAC2Linear, krippendorffAlpha, meanAbsoluteError, meanDifference, seeded } from './metrics';

// Nov 9, 2026: the bootstrap counts each resample per distinct pair of labels (so 10,000 resamples take no longer
// than 2,000 did). These tests hold the short cut to the long way round: the drawn list of texts itself.

type Pair = [string, string];
const SCALE = ['-3', '-2', '-1', '0', '1', '2', '3'];

function randomPairs(n: number, seed: number, half = false): Pair[] {
  const rnd = seeded(seed);
  const out: Pair[] = [];
  for (let i = 0; i < n; i++) {
    const x = -3 + Math.floor(rnd() ** 1.7 * 7);
    const y = Math.max(-3, Math.min(3, x + Math.round((rnd() - 0.5) * 3)));
    out.push([half && rnd() < 0.15 && x < 3 ? String(x + 0.5) : String(x), String(y)]);
  }
  return out;
}

describe('coefficients from counted pairs', () => {
  it('equal the same coefficients from the full list', () => {
    const rnd = seeded(3);
    for (const half of [false, true]) {
      const cells = randomPairs(30, half ? 11 : 12, half);
      const times = cells.map(() => 1 + Math.floor(rnd() * 9));
      const full = cells.flatMap((p, i) => Array.from({ length: times[i] }, () => p));
      const both: [number | null, number | null][] = [
        [cohenKappa(cells, 'none', [], times), cohenKappa(full)],
        [cohenKappa(cells, 'linear', SCALE, times), cohenKappa(full, 'linear', SCALE)],
        [cohenKappa(cells, 'quadratic', SCALE, times), cohenKappa(full, 'quadratic', SCALE)],
        [krippendorffAlpha(cells, 'nominal', times), krippendorffAlpha(full, 'nominal')],
        [krippendorffAlpha(cells, 'ordinal', times), krippendorffAlpha(full, 'ordinal')],
        [krippendorffAlpha(cells, 'interval', times), krippendorffAlpha(full, 'interval')],
        [gwetAC1(cells, SCALE, true, times), gwetAC1(full, SCALE, true)],
        [gwetAC1(cells, [], false, times), gwetAC1(full)],
        [gwetAC2Linear(cells, SCALE, times), gwetAC2Linear(full, SCALE)],
        [gwetAC2Linear(cells, [], times), gwetAC2Linear(full)],
        [meanDifference(cells, times), meanDifference(full)],
        [meanAbsoluteError(cells, times), meanAbsoluteError(full)],
      ];
      for (const [counted, listed] of both) {
        expect(counted).not.toBeNull();
        expect(counted!).toBeCloseTo(listed!, 12);
      }
    }
  });
});

describe('bootstrap intervals', () => {
  it('use 10,000 resamples', () => {
    expect(BOOTSTRAP_RESAMPLES).toBe(10000);
  });

  it('are those of drawing the texts themselves, with the same seed', () => {
    for (const half of [false, true]) {
      const pairs = randomPairs(60, half ? 21 : 22, half);
      const stats: Record<string, (p: Pair[]) => number | null> = {
        cohenKappa: (p) => cohenKappa(p),
        weightedKappa: (p) => cohenKappa(p, 'quadratic', SCALE),
        weightedKappaLinear: (p) => cohenKappa(p, 'linear', SCALE),
        gwetAC2Linear: (p) => gwetAC2Linear(p, SCALE),
        krippendorffAlpha: (p) => krippendorffAlpha(p, 'ordinal'),
        gwetAC1: (p) => gwetAC1(p, SCALE, true),
        meanDifference: (p) => meanDifference(p),
        mae: (p) => meanAbsoluteError(p),
      };
      // The long way: every resample as a list of drawn texts.
      const rnd = seeded(20260101);
      const draws: Record<string, number[]> = Object.fromEntries(Object.keys(stats).map((k) => [k, []]));
      const sample: Pair[] = new Array(pairs.length);
      for (let b = 0; b < BOOTSTRAP_RESAMPLES; b++) {
        for (let i = 0; i < pairs.length; i++) sample[i] = pairs[Math.floor(rnd() * pairs.length)];
        for (const k of Object.keys(stats)) {
          const v = stats[k](sample);
          if (v !== null && Number.isFinite(v)) draws[k].push(v);
        }
      }
      const at = (xs: number[], q: number) => xs[Math.round(q * (xs.length - 1))];
      const ci = agreement(pairs.map((p) => p[0]), pairs.map((p) => p[1]), 'ordinal', SCALE).ci;
      for (const k of Object.keys(stats)) {
        const xs = draws[k].sort((x, y) => x - y);
        expect(xs.length).toBe(BOOTSTRAP_RESAMPLES);
        const got = ci[k as keyof typeof ci]!;
        expect(got[0]).toBeCloseTo(at(xs, 0.025), 12);
        expect(got[1]).toBeCloseTo(at(xs, 0.975), 12);
      }
    }
  }, 60000);
});
