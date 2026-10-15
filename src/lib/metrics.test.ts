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
    expect(aggregate(['a', 'b', 'a'], false)).toBe('a');
    expect(aggregate(['a', 'b'], false)).toBe('a | b');
  });
  it('mean for numeric', () => {
    expect(aggregate(['1', '2', '2'], true)).toBe('1.667');
  });
});
