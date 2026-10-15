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

/**
 * Proportional allocation (largest remainder), at least one text per stratum when the sample is large
 * enough; within each stratum a seeded shuffle of the texts in file-name order, so the same seed and
 * corpus always give the same sample, whatever the import order.
 */
export function drawStratifiedSample(docs: Doc[], o: SampleOptions): SampleResult {
  const eligible = docs.filter((d) => !o.exclude || norm(d.meta[o.exclude.column]) !== norm(o.exclude.value));
  const groups = new Map<string, Doc[]>();
  for (const d of eligible) {
    const key = o.strata.map((c) => d.meta[c]?.trim() || '(none)').join(' · ') || 'all';
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const size = Math.min(Math.max(0, Math.round(o.size)), eligible.length);
  const n = (k: string) => groups.get(k)!.length;
  const quota = new Map(keys.map((k) => [k, (size * n(k)) / Math.max(1, eligible.length)]));
  const take = new Map(keys.map((k) => [k, Math.floor(quota.get(k)!)]));
  if (size >= keys.length) for (const k of keys) if (take.get(k)! === 0) take.set(k, 1);
  const total = () => [...take.values()].reduce((s, x) => s + x, 0);
  // Too few: add to the strata with the largest remainders. Too many (from the minimum of one): take from the largest.
  const byRemainder = [...keys].sort((a, b) => quota.get(b)! - Math.floor(quota.get(b)!) - (quota.get(a)! - Math.floor(quota.get(a)!)) || a.localeCompare(b));
  for (let i = 0; total() < size && i < 10 * keys.length; i++) {
    const k = byRemainder[i % byRemainder.length];
    if (take.get(k)! < n(k)) take.set(k, take.get(k)! + 1);
  }
  const bySize = [...keys].sort((a, b) => take.get(b)! - take.get(a)! || a.localeCompare(b));
  for (let i = 0; total() > size && i < 10 * keys.length; i++) {
    const k = bySize[i % bySize.length];
    if (take.get(k)! > 1) take.set(k, take.get(k)! - 1);
  }
  const rnd = seeded(o.seed);
  const ids: string[] = [];
  for (const k of keys) {
    const items = [...groups.get(k)!].sort((a, b) => (a.meta.file ?? a.docId).localeCompare(b.meta.file ?? b.docId));
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    ids.push(...items.slice(0, take.get(k)!).map((d) => d.id));
  }
  return { ids, strata: keys.map((k) => ({ key: k, available: n(k), drawn: take.get(k)! })), eligible: eligible.length };
}
