// Stratified random sample of texts (e.g. a held-out validation sample), reproducible from a seed.
import { seeded } from './metrics';
import type { Doc } from './types';

export interface SampleOptions {
  size: number;
  /** Metadata columns to stratify by (e.g. era, journal); none = simple random sample. */
  strata: string[];
  /** Leave out texts whose `column` equals `value` (e.g. pilot = yes). */
  exclude: { column: string; value: string } | null;
  /**
   * The column and value the sample will be marked with (e.g. sample = holdout): texts whose `column` already holds
   * another value (an earlier sample, e.g. sample = validation) are left out, so samples marked in one column stay
   * disjoint; texts with this same value (a redraw) are not. The draw's note says how many were left out
   * (`SampleResult.taken`).
   */
  markedAs?: { column: string; value: string } | null;
  seed: number;
  /** 3 (the default) takes the strata columns in the fixed order of `orderStrata`; 2 takes them in the order
   *  given (as they were ticked), to redraw a sample recorded with method 2. */
  method?: 2 | 3;
}

export interface Stratum {
  key: string;
  available: number;
  drawn: number;
}

export interface SampleResult {
  ids: string[];
  strata: Stratum[];
  eligible: number;
  /** Texts left out because their marking column already holds another value (`markedAs`), per value, most first. */
  taken: { value: string; n: number }[];
}

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

/** Character by character: the same order in every browser. (Sorting by the browser's language puts e.g.
 *  "Aa…", "Æ…" or capitals differently in a Danish and an English browser, and then the same seed would
 *  draw a different sample.) */
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Recorded with each draw, so a later reader knows which rules made the sample from the seed. */
export const SAMPLING_METHOD = 'Annotation Desk sampling method 3';

/** The strata columns in the order a draw uses them (method 3): by name, character by character, whatever order
 *  they were ticked and whatever order the metadata columns were added in. The sample dialog lists them so. */
export const orderStrata = (strata: string[]) => [...strata].sort(byCode);

/**
 * The value a text already holds in the column a sample is marked in, when it is another value than the sample's
 * (so the text belongs to another sample there); '' otherwise. (Compared as marking does: the value exactly.)
 */
export function heldValue(d: Doc, markedAs: { column: string; value: string }): string {
  const held = d.meta[markedAs.column] ?? '';
  return held.trim() !== '' && held !== markedAs.value ? held : '';
}

/**
 * Proportional allocation (largest remainder), at least one text per stratum when the sample is large
 * enough; within each stratum a seeded shuffle of the texts in file-name order, so the same seed, corpus and
 * strata columns always give the same sample, whatever the import order, the order the columns were ticked or
 * the browser (method 3: strata columns ordered by name; method 2, October 2026, took them in the order they
 * were ticked; method 1, before that, sorted by the browser's language and ranked remainders before the
 * minimum of one). Eligible: every text except those left out by `exclude` and, with `markedAs` (the dialog always
 * gives it, since October 24, 2026), those already marked with another value in the sample's column; the note
 * names both, so the same call on the texts as they were reproduces the draw.
 */
export function drawStratifiedSample(docs: Doc[], o: SampleOptions): SampleResult {
  const strata = o.method === 2 ? o.strata : orderStrata(o.strata);
  const notExcluded = docs.filter((d) => !o.exclude || norm(d.meta[o.exclude.column]) !== norm(o.exclude.value));
  const takenBy = new Map<string, number>();
  const eligible = notExcluded.filter((d) => {
    const held = o.markedAs ? heldValue(d, o.markedAs) : '';
    if (held) takenBy.set(held, (takenBy.get(held) ?? 0) + 1);
    return !held;
  });
  const taken = [...takenBy].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n || byCode(a.value, b.value));
  const groups = new Map<string, Doc[]>();
  for (const d of eligible) {
    const key = strata.map((c) => d.meta[c]?.trim() || '(none)').join(' · ') || 'all';
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  const keys = [...groups.keys()].sort(byCode);
  const size = Math.min(Math.max(0, Math.round(o.size)), eligible.length);
  const n = (k: string) => groups.get(k)!.length;
  const quota = new Map(keys.map((k) => [k, (size * n(k)) / Math.max(1, eligible.length)]));
  const take = new Map(keys.map((k) => [k, Math.floor(quota.get(k)!)]));
  if (size >= keys.length) for (const k of keys) if (take.get(k)! === 0) take.set(k, 1);
  const total = () => [...take.values()].reduce((s, x) => s + x, 0);
  // Too few: add to the strata furthest below their share (a stratum raised to one is not). Too many (from the
  // minimum of one): take from the largest.
  const short = (k: string) => quota.get(k)! - take.get(k)!;
  const byRemainder = [...keys].sort((a, b) => short(b) - short(a) || byCode(a, b));
  // Round after round in this order until the total is right (each round changes at least one stratum, or ends).
  for (let moved = true; total() < size && moved; ) {
    moved = false;
    for (const k of byRemainder) {
      if (total() >= size) break;
      if (take.get(k)! < n(k)) take.set(k, take.get(k)! + 1), (moved = true);
    }
  }
  const bySize = [...keys].sort((a, b) => take.get(b)! - take.get(a)! || byCode(a, b));
  for (let moved = true; total() > size && moved; ) {
    moved = false;
    for (const k of bySize) {
      if (total() <= size) break;
      if (take.get(k)! > 1) take.set(k, take.get(k)! - 1), (moved = true);
    }
  }
  const rnd = seeded(o.seed);
  const ids: string[] = [];
  for (const k of keys) {
    const items = [...groups.get(k)!].sort((a, b) => byCode(a.meta.file ?? a.docId, b.meta.file ?? b.docId));
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    ids.push(...items.slice(0, take.get(k)!).map((d) => d.id));
  }
  return { ids, strata: keys.map((k) => ({ key: k, available: n(k), drawn: take.get(k)! })), eligible: eligible.length, taken };
}

/**
 * For the note saved with a sample: the texts left out because they already belong to another sample in its column,
 * e.g. "not from the 20 texts already marked sample = validation" ('' when none were; with more than three values, how
 * many texts and values).
 */
export function takenNote(r: SampleResult, column: string, w: { one: string; many: string } = { one: 'text', many: 'texts' }): string {
  if (!r.taken.length) return '';
  // (A column of other metadata picked to mark in, e.g. journal: their number, not a list of every value.)
  if (r.taken.length > 3) return `not from the ${r.taken.reduce((n, t) => n + t.n, 0)} ${w.many} whose ${column} already holds another value (${r.taken.length} values)`;
  const parts = r.taken.map((t, i) => (i === 0 ? `the ${t.n} ${t.n === 1 ? w.one : w.many} already marked ${column} = ${t.value}` : `the ${t.n} marked ${column} = ${t.value}`));
  return `not from ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]}`;
}

/** How the texts were spread over the strata, for the note saved with a sample: "at least one per stratum" only
 *  when every stratum got one (it can't when the sample is smaller than the number of strata). */
export function allocationNote(r: SampleResult, one = 'text'): string {
  const empty = r.strata.filter((s) => s.drawn === 0).length;
  return empty
    ? `proportional allocation; ${empty} of ${r.strata.length} strata received no ${one} because the sample is smaller than the number of strata`
    : 'proportional allocation, at least one per stratum';
}
