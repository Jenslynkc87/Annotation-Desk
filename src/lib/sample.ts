// Stratified random sample of texts (e.g. a held-out validation sample), reproducible from a seed.
import { seeded } from './metrics';
import type { Doc } from './types';

export interface SampleOptions {
  size: number;
  /** Metadata columns to stratify by (e.g. era, journal); none = simple random sample. */
  strata: string[];
  /** Leave out texts whose `column` equals `value` (e.g. pilot = yes). */
  exclude: { column: string; value: string } | null;
  seed: number;
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
}

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

/** Character by character: the same order in every browser. (Sorting by the browser's language puts e.g.
 *  "Aa…", "Æ…" or capitals differently in a Danish and an English browser, and then the same seed would
 *  draw a different sample.) */
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Recorded with each draw, so a later reader knows which rules made the sample from the seed. */
export const SAMPLING_METHOD = 'Annotation Desk sampling method 2';

/**
 * Proportional allocation (largest remainder), at least one text per stratum when the sample is large
 * enough; within each stratum a seeded shuffle of the texts in file-name order, so the same seed and
 * corpus always give the same sample, whatever the import order and in any browser (method 2; method 1,
 * before October 2026, sorted by the browser's language and ranked remainders before the minimum of one).
 */
export function drawStratifiedSample(docs: Doc[], o: SampleOptions): SampleResult {
  const eligible = docs.filter((d) => !o.exclude || norm(d.meta[o.exclude.column]) !== norm(o.exclude.value));
  const groups = new Map<string, Doc[]>();
  for (const d of eligible) {
    const key = o.strata.map((c) => d.meta[c]?.trim() || '(none)').join(' · ') || 'all';
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
  return { ids, strata: keys.map((k) => ({ key: k, available: n(k), drawn: take.get(k)! })), eligible: eligible.length };
}
