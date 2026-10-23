// Which fields of a run agreement can be computed on, and their values per text.
import type { Level } from './metrics';
import { fieldLabel, flattenJsonResponse, normalizeLabel, TEXT_RESPONSE_KEY, toNumber } from './prompt';
import type { Run } from './types';
import type { DocView } from './view';

export interface ComparableField {
  key: string;
  label: string;
  level: Level;
  /** The codebook's allowed values (normalized), so statistics use the whole scale. */
  allowed: string[];
  /** Plain-text runs: `allowed` is the range of values seen, not a codebook scale (see `agreement`). */
  scaleSeen?: boolean;
  /**
   * Plain-text runs: the lowest and highest of the model's single answers, whole or not, from which `agreement`
   * grows the scale that labels are compared on (`allowed` holds its whole numbers for whole-number scores).
   */
  range?: [number, number];
  yesNo: boolean;
}

/**
 * Structured runs: the codebook fields (free-text fields excluded). Plain-text runs whose answers are JSON:
 * the numeric values in the answers (e.g. race_negative), not reasoning or other text.
 */
export function comparableFields(run: Run, views: Iterable<DocView>): ComparableField[] {
  const p = run.snapshot.prompt;
  if (p.outputMode === 'structured') {
    return p.variables
      .filter((v) => v.type !== 'text')
      .map((v) => ({
        key: v.name,
        label: fieldLabel(p, v.name),
        level: v.type === 'ordinal' ? 'ordinal' : v.type === 'number' ? 'interval' : 'nominal',
        // Yes/no: its two values are its categories (a tie "false | true" is no third one).
        allowed: v.type === 'category' || v.type === 'ordinal' ? v.values.map((x) => normalizeLabel(x)).filter(Boolean) : v.type === 'boolean' ? ['false', 'true'] : [],
        yesNo: v.type === 'boolean',
      }));
  }
  // Read from the separate answers, not the combined ones: the median of two answers can fall between whole
  // numbers (e.g. 1.5), which must not turn a field of whole-number scores into an interval field.
  const values = new Map<string, string[]>();
  for (const view of views) {
    if (view.run?.id !== run.id) continue;
    for (const r of view.results) {
      if (r.status !== 'ok') continue;
      const flat = flattenJsonResponse(r.values[TEXT_RESPONSE_KEY]);
      if (!flat) continue;
      for (const [k, v] of Object.entries(flat)) {
        if (v.trim() === '') continue;
        const list = values.get(k);
        if (list) list.push(v);
        else values.set(k, [v]);
      }
    }
  }
  // A field of scores, even if a few answers are not numbers (e.g. "NA", left out and reported by `agreement`).
  return [...values.entries()]
    .map(([key, vs]) => [key, vs.map(toNumber).filter(Number.isFinite)] as const)
    .filter(([key, nums]) => nums.length > 0 && nums.length >= (values.get(key)?.length ?? 0) / 2)
    .map(([key, nums]) => {
      const ordinal = nums.every(Number.isInteger);
      // Whole-number scores: the scale is every value from the lowest to the highest seen, so weighted κ measures
      // distances on the scale even where a value (e.g. −2) was never used. (No codebook says what the scale is.)
      let lo = Infinity;
      let hi = -Infinity;
      for (const x of nums) (lo = Math.min(lo, x)), (hi = Math.max(hi, x));
      const allowed = ordinal && hi - lo <= 100 ? Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i)) : [];
      const range: [number, number] = [lo, hi];
      return { key, label: key, level: ordinal ? ('ordinal' as const) : ('interval' as const), allowed, scaleSeen: true, range, yesNo: false };
    });
}

/**
 * The same field in two runs (e.g. in a comparison), so the result doesn't depend on which run comes first: the
 * values of both runs' scales (e.g. two codebooks, 0…3 and −3…3), and for plain-text scores, which have no
 * codebook, every whole number in the range seen in either run (and that range, from the lowest to the highest
 * answer of either run).
 */
export function combineFields(a: ComparableField, b: ComparableField | undefined): ComparableField {
  if (!b) return a;
  const level: ComparableField['level'] = a.level === b.level ? a.level : a.level === 'nominal' || b.level === 'nominal' ? 'nominal' : 'interval';
  const scaleSeen = !!a.scaleSeen && !!b.scaleSeen;
  const ranges = [a.range, b.range].filter((r): r is [number, number] => !!r);
  const range: [number, number] | undefined =
    scaleSeen && ranges.length ? [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))] : undefined;
  const { range: _range, ...rest } = a;
  const base = { ...rest, level, scaleSeen, ...(range ? { range } : {}), yesNo: a.yesNo && b.yesNo };
  if (level === 'interval' || (!a.allowed.length && !a.scaleSeen) || (!b.allowed.length && !b.scaleSeen)) return { ...base, allowed: [] };
  if (!a.allowed.length || !b.allowed.length) return { ...base, allowed: [] };
  const union = [...new Set([...a.allowed, ...b.allowed])];
  const nums = union.map(Number);
  if (!nums.every(Number.isFinite)) return { ...base, allowed: union };
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  // A range with no codebook behind it (plain-text scores) is filled in; codebook values are kept as they are.
  const filled = (a.scaleSeen || b.scaleSeen) && nums.every(Number.isInteger) && hi - lo <= 100;
  const allowed = filled ? Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i)) : [...union].sort((x, y) => Number(x) - Number(y));
  return { ...base, allowed };
}

/** A field's value in a run's (aggregated) values, reading inside JSON answers for plain-text runs. */
export function fieldValue(run: Run, values: Record<string, string>, key: string): string {
  if (run.snapshot.prompt.outputMode === 'structured') return values[key] ?? '';
  return flattenJsonResponse(values[TEXT_RESPONSE_KEY])?.[key] ?? '';
}
