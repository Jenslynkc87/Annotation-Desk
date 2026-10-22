import { describe, expect, it } from 'vitest';
import { aggregate, agreement, cohenKappa, gwetAC1, krippendorffAlpha } from './metrics';

// Reference values computed with the Python packages `krippendorff`, scikit-learn and scipy.
const s = (xs: number[]) => xs.map(String);
const zip = (a: string[], b: string[]) => a.map((x, i) => [x, b[i]] as [string, string]);

describe('agreement metrics', () => {
  const a = s([0, 1, 0, 0, 0, 0, 0, 0, 1, 0]);
  const b = s([1, 1, 1, 0, 0, 1, 0, 0, 0, 0]);
  const x = s([1, 2, 3, 3, 2, 1, 0, 2, 3, 1]);
  const y = s([1, 2, 2, 3, 2, 0, 0, 1, 3, 2]);

  it('matches krippendorff (nominal, binary)', () => {
    expect(krippendorffAlpha(zip(a, b), 'nominal')).toBeCloseTo(0.0952381, 6);
  });
  it('matches krippendorff nominal/ordinal/interval', () => {
    expect(krippendorffAlpha(zip(x, y), 'nominal')).toBeCloseTo(0.4794521, 6);
    expect(krippendorffAlpha(zip(x, y), 'ordinal')).toBeCloseTo(0.8084553, 6);
    expect(krippendorffAlpha(zip(x, y), 'interval')).toBeCloseTo(0.8118812, 6);
  });
  it('matches sklearn cohen kappa (plain and quadratic)', () => {
    expect(cohenKappa(zip(a, b))).toBeCloseTo(0.0909091, 6);
    expect(cohenKappa(zip(x, y))).toBeCloseTo(0.4594595, 6);
    expect(cohenKappa(zip(x, y), 'quadratic')).toBeCloseTo(0.8039216, 6);
  });
  it('computes spearman and drops missing pairs', () => {
    const r = agreement([...x, ''], [...y, '2'], 'ordinal');
    expect(r.n).toBe(10);
    expect(r.spearman).toBeCloseTo(0.8131191, 6);
    expect(r.percentAgreement).toBeCloseTo(0.6, 6);
  });
  it('gwet AC1 is defined under prevalence imbalance', () => {
    // 18 agreements on "0", one each way disagreement: kappa collapses, AC1 stays high.
    const p = [...Array(18).fill(['0', '0']), ['1', '0'], ['0', '1']] as [string, string][];
    expect(cohenKappa(p)).toBeLessThan(0);
    expect(gwetAC1(p)!).toBeGreaterThan(0.85);
  });
});

describe('aggregate', () => {
  it('majority vote with ties', () => {
    expect(aggregate(['a', 'b', 'a'], 'majority')).toBe('a');
    expect(aggregate(['a', 'b'], 'majority')).toBe('a | b');
  });
  it('mean for numbers, median for ordinal scales', () => {
    expect(aggregate(['1', '2', '2'], 'mean')).toBe('1.667');
    expect(aggregate(['3', '1', '2'], 'median')).toBe('2');
    expect(aggregate(['1', '3', '3', '', '1', '2'], 'median')).toBe('2');
    expect(aggregate(['2', '3'], 'median')).toBe('2.5');
  });
});

describe('full scale and intervals', () => {
  const x = s([1, 2, 3, 3, 2, 1, 5, 2, 3, 1]);
  const y = s([1, 2, 2, 3, 2, 1, 5, 1, 3, 2]);
  it('weighted kappa uses the whole codebook scale (sklearn labels=[1..5])', () => {
    // Weights by value: 1 vs 5 is four points apart even when 4 was never used (sklearn without labels= counts
    // positions among the values seen, 0.8387097, as this app did before October 22, 2026).
    expect(cohenKappa(zip(x, y), 'quadratic')).toBeCloseTo(0.8920863, 6);
    expect(cohenKappa(zip(x, y), 'quadratic', s([1, 2, 3, 4, 5]))).toBeCloseTo(0.8920863, 6);
    expect(agreement(x, y, 'ordinal', s([1, 2, 3, 4, 5])).weightedKappa).toBeCloseTo(0.8920863, 6);
  });
  it('gives the same 95% interval every time, around the estimate', () => {
    const r1 = agreement([...x, ...x, ...x], [...y, ...y, ...y], 'ordinal', s([1, 2, 3, 4, 5]));
    const r2 = agreement([...x, ...x, ...x], [...y, ...y, ...y], 'ordinal', s([1, 2, 3, 4, 5]));
    expect(r1.ci).toEqual(r2.ci);
    const [lo, hi] = r1.ci.cohenKappa!;
    expect(lo).toBeLessThanOrEqual(r1.cohenKappa!);
    expect(hi).toBeGreaterThanOrEqual(r1.cohenKappa!);
  });
  it('gives no interval for very few texts', () => {
    expect(agreement(['a', 'b', 'a'], ['a', 'b', 'b'], 'nominal').ci.cohenKappa).toBeNull();
  });
});

describe('tolerance and systematic difference', () => {
  const a = s([1, 2, 3, 4, 5, 3, 2, 4, 1, 5, 3, 2]);
  const b = s([1, 3, 3, 2, 5, 4, 2, 4, 3, 5, 4, 2]);
  it('counts agreement within a tolerance and the mean difference (second − first)', () => {
    const r = agreement(a, b, 'ordinal', s([1, 2, 3, 4, 5]), 1);
    expect(r.percentAgreement).toBeCloseTo(7 / 12, 9);
    expect(r.withinTolerance).toBeCloseTo(10 / 12, 9);
    expect(r.meanDifference).toBeCloseTo(3 / 12, 9);
    expect(r.mae).toBeCloseTo(7 / 12, 9);
    expect(agreement(a, b, 'ordinal', [], 2).withinTolerance).toBeCloseTo(12 / 12, 9);
    expect(agreement(a, b, 'ordinal', [], 0).withinTolerance).toBeCloseTo(7 / 12, 9);
    expect(r.ci.meanDifference![0]).toBeLessThan(r.meanDifference!);
  });
  it('leaves tolerance and difference empty for categories', () => {
    const r = agreement(['x', 'y'], ['x', 'x'], 'nominal');
    expect(r.withinTolerance).toBeNull();
    expect(r.meanDifference).toBeNull();
  });
});

describe('serious disagreement and linear weights (−3…+3 scale)', () => {
  const scale = s([-3, -2, -1, 0, 1, 2, 3]);
  const x = s([-3, -1, 0, 0, 2, 3, 1, 0, -2, 0, 1, 0]);
  const y = s([-2, 1, 0, 0, 2, 1, 1, 0, -3, 1, 0, 0]);
  it('matches sklearn linear-weighted kappa', () => {
    expect(agreement(x, y, 'ordinal', scale).weightedKappaLinear).toBeCloseTo(0.5675676, 6);
  });
  it('counts differences of 2+ points and opposite directions around the midpoint 0', () => {
    const r = agreement(x, y, 'ordinal', scale);
    expect(r.midpoint).toBe(0);
    expect(r.largeDifference).toBeCloseTo(2 / 12, 9);
    expect(r.oppositeDirection).toBeCloseTo(1 / 12, 9);
  });
  it('uses the scale midpoint on a 1–7 scale', () => {
    expect(agreement(s([3, 5, 4]), s([5, 4, 4]), 'ordinal', s([1, 2, 3, 4, 5, 6, 7])).oppositeDirection).toBeCloseTo(1 / 3, 9);
  });

  it('counts same, small and large gaps with their direction', () => {
    const r = agreement(['0', '1', '1', '-2', '3', '0'], ['0', '2', '0', '1', '3', '-3'], 'ordinal', ['-3', '-2', '-1', '0', '1', '2', '3']);
    expect(r.gaps).toEqual({ same: 2, secondHigherSmall: 1, secondLowerSmall: 1, secondHigherLarge: 1, secondLowerLarge: 1 });
  });
});
