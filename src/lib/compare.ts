// Which fields of a run agreement can be computed on, and their values per text.
import type { Level } from './metrics';
import { fieldLabel, flattenJsonResponse, normalizeLabel, TEXT_RESPONSE_KEY } from './prompt';
import type { Run } from './types';
import type { DocView } from './view';

export interface ComparableField {
  key: string;
  label: string;
  level: Level;
  /** The codebook's allowed values (normalized), so statistics use the whole scale. */
  allowed: string[];
  yesNo: boolean;
}

const isNum = (s: string) => s.trim() !== '' && !Number.isNaN(Number(s));

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
        allowed: v.type === 'category' || v.type === 'ordinal' ? v.values.map((x) => normalizeLabel(x)).filter(Boolean) : [],
        yesNo: v.type === 'boolean',
      }));
  }
  const values = new Map<string, string[]>();
  for (const view of views) {
    if (view.run?.id !== run.id) continue;
    const flat = flattenJsonResponse(view.values[TEXT_RESPONSE_KEY]);
    if (!flat) continue;
    for (const [k, v] of Object.entries(flat)) if (v.trim() !== '') values.set(k, [...(values.get(k) ?? []), v]);
  }
  return [...values.entries()]
    .filter(([, vs]) => vs.every(isNum))
    .map(([key, vs]) => {
      const nums = vs.map(Number);
      const ordinal = nums.every(Number.isInteger);
      // Whole-number scores: the scale is every value from the lowest to the highest seen, so weighted κ measures
      // distances on the scale even where a value (e.g. −2) was never used. (No codebook says what the scale is.)
      const lo = Math.min(...nums);
      const hi = Math.max(...nums);
      const allowed = ordinal && hi - lo <= 100 ? Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i)) : [];
      return { key, label: key, level: ordinal ? ('ordinal' as const) : ('interval' as const), allowed, yesNo: false };
    });
}

/** A field's value in a run's (aggregated) values, reading inside JSON answers for plain-text runs. */
export function fieldValue(run: Run, values: Record<string, string>, key: string): string {
  if (run.snapshot.prompt.outputMode === 'structured') return values[key] ?? '';
  return flattenJsonResponse(values[TEXT_RESPONSE_KEY])?.[key] ?? '';
}
