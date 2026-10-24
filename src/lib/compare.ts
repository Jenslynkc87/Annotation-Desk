// Which fields of a run agreement can be computed on, and their values per text.
import type { Level } from './metrics';
import { fieldLabel, flattenJsonResponse, normalizeLabel, TEXT_RESPONSE_KEY, toNumber } from './prompt';
import type { PromptSpec, Result, Run, Variable } from './types';
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
   * A numeric codebook combined with plain-text scores (`combineFields`): the codebook's own lowest and highest
   * point, so the scale's midpoint stays the codebook's when `allowed` is widened to take in the model's answers.
   */
  range?: [number, number];
  yesNo: boolean;
}

/**
 * Each answer's JSON values, read once (an answer doesn't change), so the Workbench can look again on every update of
 * a run: the keys with a value, in order, and each value as a number (NaN for text). Not the text itself (e.g. the
 * explanations): kept for every answer of a full corpus, that would double the memory the answers take.
 */
const numbersOf = new WeakMap<Result, { raw: string | undefined; keys: string[] | null; nums: number[] }>();
// (Answers mostly have the same keys: one list for those in a row.)
let lastKeys: string[] = [];
function answerNumbers(r: Result): { keys: string[]; nums: number[] } | null {
  const raw = r.values[TEXT_RESPONSE_KEY];
  let c = numbersOf.get(r);
  if (!c || c.raw !== raw) {
    const flat = flattenJsonResponse(raw);
    let keys = flat ? Object.keys(flat).filter((k) => flat[k].trim() !== '') : null;
    if (keys) keys = lastKeys = keys.length === lastKeys.length && keys.every((k, i) => k === lastKeys[i]) ? lastKeys : keys;
    numbersOf.set(r, (c = { raw, keys, nums: keys ? keys.map((k) => toNumber(flat![k])) : [] }));
  }
  return c.keys ? (c as { keys: string[]; nums: number[] }) : null;
}

/**
 * Structured runs: the codebook fields (free-text fields excluded). Plain-text runs whose answers are JSON:
 * the numeric values in the answers (e.g. race_negative), not reasoning or other text.
 */
export function comparableFields(run: Run, views: Iterable<DocView>): ComparableField[] {
  const p = run.snapshot.prompt;
  if (p.outputMode === 'structured') return p.variables.filter((v) => v.type !== 'text').map((v) => codebookField(p, v));
  // Read from the separate answers, not the combined ones: the median of two answers can fall between whole
  // numbers (e.g. 1.5), which must not turn a field of whole-number scores into an interval field.
  // (Each key's values as numbers, NaN for text.)
  const values = new Map<string, number[]>();
  for (const view of views) {
    if (view.run?.id !== run.id) continue;
    for (const r of view.results) {
      if (r.status !== 'ok') continue;
      const answer = answerNumbers(r);
      if (!answer) continue;
      answer.keys.forEach((k, i) => {
        const list = values.get(k);
        if (list) list.push(answer.nums[i]);
        else values.set(k, [answer.nums[i]]);
      });
    }
  }
  // A field of scores, even if a few answers are not numbers (e.g. "NA", left out and reported by `agreement`).
  return [...values.entries()]
    .map(([key, xs]) => [key, xs.filter(Number.isFinite)] as const)
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

/** A codebook field (not free text) of a structured prompt, as `comparableFields` gives it. */
export function codebookField(p: PromptSpec, v: Variable): ComparableField {
  return {
    key: v.name,
    label: fieldLabel(p, v.name),
    level: v.type === 'ordinal' ? 'ordinal' : v.type === 'number' ? 'interval' : 'nominal',
    // Yes/no: its two values are its categories (a tie "false | true" is no third one).
    allowed: v.type === 'category' || v.type === 'ordinal' ? v.values.map((x) => normalizeLabel(x)).filter(Boolean) : v.type === 'boolean' ? ['false', 'true'] : [],
    yesNo: v.type === 'boolean',
  };
}

const isNumber = (s: string) => s.trim() !== '' && Number.isFinite(Number(s));
/** A codebook scale of numbers: an ordinal scale, or category codes that are all numbers. */
const numericCodebook = (f: ComparableField) => !f.scaleSeen && f.allowed.length > 0 && f.allowed.every(isNumber);

/**
 * The same field in two runs (e.g. in a comparison), so the result doesn't depend on which run comes first: the
 * values of both runs' scales (e.g. two codebooks, 0…3 and −3…3), and for plain-text scores, which have no
 * codebook, every whole number in the range seen in either run (and that range, from the lowest to the highest
 * answer of either run). A codebook of numbers and plain-text scores: the codebook's scale (see below).
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
  // A codebook of numbers on one side, plain-text scores on the other: the codebook's scale at whatever level results
  // (also interval, when one plain-text answer was 2.5), so Gwet's q, the split of a half point, the weights and the
  // midpoint are the codebook's. Where the plain-text answers reach beyond it, it is widened to the whole numbers of
  // their range (for a codebook of whole numbers), else to that range's ends, so no answer of the model is left out;
  // `range` keeps the codebook's own ends, so a stray answer (a 4 next to −3…3) doesn't move the midpoint that
  // decides "opposite direction".
  const coded = numericCodebook(a) && b.scaleSeen ? a : numericCodebook(b) && a.scaleSeen ? b : null;
  if (coded) {
    const other = coded === a ? b : a;
    const points = coded.allowed.map(Number);
    const [lo, hi] = [Math.min(...points), Math.max(...points)];
    const seen = other.range ?? (other.allowed.length ? [Math.min(...other.allowed.map(Number)), Math.max(...other.allowed.map(Number))] : null);
    const extra: number[] = [];
    if (seen) {
      const whole = points.every(Number.isInteger);
      const [from, to] = whole ? [Math.floor(seen[0]), Math.ceil(seen[1])] : seen;
      if (whole && Math.max(hi, to) - Math.min(lo, from) <= 100) {
        for (let x = from; x < lo; x++) extra.push(x);
        for (let x = hi + 1; x <= to; x++) extra.push(x);
      } else extra.push(...[from, to].filter((x) => x < lo || x > hi));
    }
    const allowed = [...coded.allowed, ...extra.map(String)];
    return { ...base, allowed: [...new Set(allowed)].sort((x, y) => Number(x) - Number(y)), range: [lo, hi] };
  }
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
