// Which fields of a run agreement can be computed on, and their values per text.
import { scaleStep, type Level } from './metrics';
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
  /** Plain-text scores: answers of 0 and 1, but for a stray one or codes far off them (see `zeroOneScores`). */
  zeroOne?: boolean;
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
      // A yes/no in numbers (`zeroOneScores`): every answer from 0 to 1, or most answers 0 or 1 with at most one in a
      // hundred (at least one) near them, e.g. a stray 2 or −1, besides codes far off them (a 9 for "can't tell", far
      // as the rating-scale rule reads a label). A −3…3 scale whose answers are mostly 0 or 1 mostly has more −1s and
      // 2s; one that hasn't is still compared as numbers against numbers (only a field in words pairs as yes/no).
      const step = scaleStep([0, 1]);
      const far = (x: number) => x < -step || x > 1 + step;
      let zeroOrOne = 0;
      let near = 0;
      const farValues: number[] = [];
      for (const x of nums) {
        if (x === 0 || x === 1) zeroOrOne++;
        else if (far(x)) farValues.push(x);
        else if (x < 0 || x > 1) near++;
      }
      // The far answers must look like missing-value codes: one or two distinct values (9, 99, −9) and at most one in
      // ten. A percentage, 0–10 intensity or year field that is mostly 0 has many different far values: its own scale.
      const codes = new Set(farValues).size <= 2 && farValues.length <= nums.length / 10;
      const zeroOne = nums.every((x) => x >= 0 && x <= 1) || (zeroOrOne * 2 > nums.length && near <= Math.max(1, nums.length / 100) && codes);
      // Whole-number scores: the scale is every value from the lowest to the highest seen, so weighted κ measures
      // distances on the scale even where a value (e.g. −2) was never used. (No codebook says what the scale is.)
      let lo = Infinity;
      let hi = -Infinity;
      for (const x of nums) (lo = Math.min(lo, x)), (hi = Math.max(hi, x));
      const allowed = ordinal && hi - lo <= 100 ? Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i)) : [];
      const range: [number, number] = [lo, hi];
      return { key, label: key, level: ordinal ? ('ordinal' as const) : ('interval' as const), allowed, scaleSeen: true, range, yesNo: false, zeroOne };
    });
}

/** A codebook field (not free text) of a structured prompt, as `comparableFields` gives it. */
export function codebookField(p: PromptSpec, v: Variable): ComparableField {
  // Yes/no: its two values are its categories (a tie "false | true" is no third one).
  const allowed = v.type === 'category' || v.type === 'ordinal' ? v.values.map((x) => normalizeLabel(x)).filter(Boolean) : v.type === 'boolean' ? ['false', 'true'] : [];
  return {
    key: v.name,
    label: fieldLabel(p, v.name),
    level: v.type === 'ordinal' ? 'ordinal' : v.type === 'number' ? 'interval' : 'nominal',
    allowed,
    // Categories that are exactly yes and no (or true and false) are a Yes/no field too, so a coder's 1/0 or y/n reads
    // as yes/no.
    yesNo: v.type === 'boolean' || (v.type === 'category' && sameSet(allowed, ['false', 'true'])),
  };
}

const isNumber = (s: string) => s.trim() !== '' && Number.isFinite(Number(s));
const sameSet = (xs: string[], ys: string[]) => new Set(xs).size === ys.length && xs.every((x) => ys.includes(x));
/** A codebook scale of numbers: an ordinal scale, or category codes that are all numbers. */
const numericCodebook = (f: ComparableField) => !f.scaleSeen && f.allowed.length > 0 && f.allowed.every(isNumber);
/**
 * Plain-text scores of 0 and 1 ("flag": 1): a yes/no in numbers (see `combineFields`, `labelValue`). Also with a stray
 * answer between them (a 0.5) or beyond them (a 2), or codes far off (a 9 for "can't tell"), as `comparableFields`
 * judges it (`zeroOne`), any of which alone would otherwise turn every 1 and 0 into a disagreement; against a Yes/no
 * field such a value is left out and reported. (A field made elsewhere, without `zeroOne`: answers all from 0 to 1.)
 */
export const zeroOneScores = (f: ComparableField) => !!f.scaleSeen && (f.zeroOne ?? (!!f.range && f.range[0] >= 0 && f.range[1] <= 1));
/** No and yes as 0 and 1: plain-text scores of 0 and 1 (`zeroOneScores`), or a codebook whose values are exactly 0 and 1. */
export const zeroOneValues = (f: ComparableField) => zeroOneScores(f) || (!f.scaleSeen && sameSet(f.allowed, ['0', '1']));
/**
 * Plain-text scores of 0 and 1 (`zeroOneScores`) as compared with label columns: their scale grows from 0…1 rather
 * than from the range of the answers, so a far code the model used (9 for can't tell) is left out and reported, as
 * against a Yes/no run, while labels within 3 points (a −3…3 field that is mostly 0 or 1) are kept as before.
 */
export const labelScale = (f: ComparableField): ComparableField =>
  zeroOneScores(f) ? { ...f, range: [0, 1], allowed: f.level === 'ordinal' ? ['0', '1'] : f.allowed } : f;

/** A yes/no field, in words (`yesNo`: a Yes/no field, or categories yes and no) or in numbers (`zeroOneValues`). */
export const dichotomy = (f: ComparableField) => f.yesNo || zeroOneValues(f);

/**
 * The same field in two runs (e.g. in a comparison), so the result doesn't depend on which run comes first: the
 * values of both runs' scales (e.g. two codebooks, 0…3 and −3…3), and for plain-text scores, which have no
 * codebook, every whole number in the range seen in either run (and that range, from the lowest to the highest
 * answer of either run). A codebook of numbers and plain-text scores: the codebook's scale (see below). A yes/no on
 * both sides (`dichotomy`), in words on at least one (a Yes/no field, or categories yes and no) and in words or as 0
 * and 1 on the other (a codebook of 0 and 1, or plain-text scores of 0 and 1, `zeroOneScores`): a Yes/no field, so
 * both runs are read with the yes/no rule (1 and 0 as yes and no) and compared, and a value that is neither (a 0.5
 * median, a 9 for "can't tell") is left out and reported. (0 and 1 on both sides are compared as numbers, as before.)
 */
export function combineFields(a: ComparableField, b: ComparableField | undefined): ComparableField {
  if (!b) return a;
  if ((a.yesNo || b.yesNo) && dichotomy(a) && dichotomy(b)) {
    const yn = a.yesNo ? a : b;
    return { key: yn.key, label: yn.label, level: 'nominal', allowed: ['false', 'true'], yesNo: true };
  }
  const level: ComparableField['level'] = a.level === b.level ? a.level : a.level === 'nominal' || b.level === 'nominal' ? 'nominal' : 'interval';
  const scaleSeen = !!a.scaleSeen && !!b.scaleSeen;
  const ranges = [a.range, b.range].filter((r): r is [number, number] => !!r);
  const range: [number, number] | undefined =
    scaleSeen && ranges.length ? [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))] : undefined;
  const { range: _range, zeroOne: _zeroOne, ...rest } = a;
  const base = { ...rest, level, scaleSeen, ...(range ? { range } : {}), ...(scaleSeen ? { zeroOne: zeroOneScores(a) && zeroOneScores(b) } : {}), yesNo: a.yesNo && b.yesNo };
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
