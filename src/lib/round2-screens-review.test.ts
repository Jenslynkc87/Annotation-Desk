// Review of the second-round screen fixes (October 23, 2026): the shared-batch wording names neither study as the
// copy, the left-out notice uses curly apostrophes throughout, and guards that the Agreement panel (two label
// columns) and the Workbench's "Disagree with" follow the exports' and `agreement`'s rules.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { columnsFieldRun, copyElsewhere, leftOutReason, OTHER_STUDY_HERE } from '../components/RunsView';
import { comparableLabel } from '../components/Workbench';
import { agreementForRun, labelValue } from './export/tables';
import { agreement } from './metrics';
import { normalizeLabel } from './prompt';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type Run, type Variable } from './types';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const mkRun = (prompt: PromptSpec, docIds: string[], id: string, number: number): Run => ({
  id, studyId: 's', number, label: '', createdAt: '', finishedAt: null, mode: 'sync', scope: '', docIds, status: 'completed', batch: null, error: null,
  snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt, promptVersion: number, promptHash: 'h', outputSchema: null, requestBase: {} },
});
const mkResult = (run: string, doc: string, values: Record<string, string>): Result => ({
  id: `${run}:${doc}:1`, runId: run, studyId: 's', docId: doc, replicate: 1, status: 'ok', values, rationale: '', reasoningSummary: '', rawText: '',
  parseError: null, error: null, usage, latencyMs: 1, requestedAt: '', completedAt: '', responseId: `id-${run}-${doc}`, modelReported: 'm', stopReason: 'end_turn',
});
const variable = (name: string, type: Variable['type'], values: string[] = []): Variable => ({ name, type, values, description: '' });
const structured = (...variables: Variable[]): PromptSpec => ({ ...DEFAULT_PROMPT, outputMode: 'structured', variables });
const scale = ['-3', '-2', '-1', '0', '1', '2', '3'];

/** A small seeded generator, so the data are the same on every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('Shared-batch and left-out wording', () => {
  it('names neither study as the copy: the other may be the original', () => {
    // Deleting the restored copy on computer B cancels the batch the original on computer A waits for.
    expect(copyElsewhere()).not.toMatch(/^A copy of this study/);
    expect(copyElsewhere()).toContain('or the study this one was copied from');
    expect(copyElsewhere()).toContain('another browser or on another computer');
    expect(copyElsewhere(3)).toContain('the same batches would lose them too');
    // "it" in "the study it was copied from" could be read as the other study.
    expect(OTHER_STUDY_HERE).toContain('the study this one was copied from');
  });

  it('uses curly apostrophes throughout the left-out notice', () => {
    for (const s of [leftOutReason('ordinal', [-3, 3]), leftOutReason('interval'), leftOutReason('nominal')]) expect(s).not.toContain("'");
    expect(leftOutReason('ordinal', [0, 4])).toBe('a label isn’t a number or is outside the scale (0 to 4)');
  });
});

describe('Agreement panel, two label columns: the same figures as the exported human–human row', () => {
  const r = rng(7);
  const labels = [...scale, 'NA', 'n/a', '99'];
  const docs: Doc[] = Array.from({ length: 80 }, (_, i) => ({
    id: `d${i}`, studyId: 's', docId: `d${i}`, text: 't', source: `d${i}.txt`, order: i, addedAt: '',
    meta: {
      stance_gold: labels[Math.floor(r() * (i % 9 === 0 ? labels.length : scale.length))],
      stance_coder2: labels[Math.floor(r() * (i % 11 === 0 ? labels.length : scale.length))],
      relevant_gold: r() < 0.5 ? 'yes' : 'no',
      relevant_coder2: r() < 0.5 ? '1' : '0',
    },
  }));
  const early = mkRun(structured(variable('stance', 'ordinal', scale), variable('relevant', 'boolean')), docs.map((d) => d.id), 'r1', 1);
  // The latest run is a pilot of another prompt on one text.
  const pilot = mkRun(structured(variable('gender', 'category', ['f', 'm'])), ['d0'], 'r2', 2);
  const runs = [early, pilot];
  const results = [...docs.map((d) => mkResult('r1', d.id, { stance: '1', relevant: 'true' })), mkResult('r2', 'd0', { gender: 'f' })];

  for (const [a, b] of [['stance_gold', 'stance_coder2'], ['relevant_gold', 'relevant_coder2']]) {
    it(`${a} vs ${b}`, () => {
      const m = columnsFieldRun(a, b, null, runs, docs, results)!;
      expect(m.run.id).toBe('r1');
      // What the panel computes (RunsView's valuesFor and loop), on every text with both labels.
      const xs: string[] = [];
      const ys: string[] = [];
      for (const d of docs) {
        // A missing-value marker counts as a blank cell (round three).
        const y = labelValue(d.meta[b], m.field);
        const x = labelValue(d.meta[a], m.field);
        if (x && y) (xs.push(x), ys.push(y));
      }
      const panel = agreement(xs, ys, m.field.level, m.field.allowed, 1, { withIntervals: false, scaleSeen: m.field.scaleSeen, range: m.field.range });
      const row = agreementForRun(early, docs, runs, results).find((x) => x.source === a && x.compared_with === b)!;
      expect(panel.n).toBe(row.stats.n);
      expect(panel.leftOut.n).toBe(row.stats.leftOut.n);
      for (const k of ['cohenKappa', 'weightedKappaLinear', 'weightedKappa', 'krippendorffAlpha', 'gwetAC1', 'gwetAC2Linear'] as const) expect(panel[k]).toBe(row.stats[k]);
    });
  }
});

describe('Workbench "Disagree with": the texts the Agreement panel counts as disagreeing', () => {
  const cases: [Variable, string[], boolean][] = [
    [variable('stance', 'ordinal', scale), [...scale, '1.5', 'NA', 'n/a', '99', '-7', 'low'], false],
    [variable('stance', 'category', ['Pro', 'Contra', 'Neutral']), ['pro', 'contra', 'neutral', 'pro | contra', 'NA', 'maybe', '-'], false],
    [variable('relevant', 'boolean'), ['yes', 'no', '1', '0', 'true', 'NA', 'unclear'], true],
    // Mostly words on a scale: compared as they are, NA still left out.
    [variable('stance', 'ordinal', scale), ['low', 'high', 'mid', '2', 'NA'], false],
    // Category codes that are all numbers: judged on their range (round three), so 1.5 and "1 | 2" are compared, 99 not.
    [variable('frame', 'category', ['1', '2', '3', '4']), ['1', '2', '3', '4', '1.5', '1 | 2', '99', 'NA'], false],
    // Mostly a 99 code on a scale: still left out (round three), not compared as it is.
    [variable('stance', 'ordinal', scale), ['99', '99', '99', '99', '99', '1', '2', 'NA'], false],
  ];
  cases.forEach(([v, pool, yesNo], i) => {
    it(`${v.type} case ${i + 1}`, () => {
      const r = rng(100 + i);
      const pairs: [string, string][] = Array.from({ length: 200 }, () => [
        normalizeLabel(pool[Math.floor(r() * pool.length)], yesNo),
        normalizeLabel(pool[Math.floor(r() * pool.length)], yesNo),
      ]);
      const ok = comparableLabel(v, pairs);
      const shown = pairs.filter(([x, y]) => ok(x) && ok(y));
      const allowed = v.type === 'boolean' ? ['false', 'true'] : v.values.map((x) => normalizeLabel(x)).filter(Boolean);
      const st = agreement(pairs.map((p) => p[0]), pairs.map((p) => p[1]), v.type === 'ordinal' ? 'ordinal' : 'nominal', allowed, 1, { withIntervals: false });
      expect(shown.length).toBe(st.n);
      expect(shown.filter(([x, y]) => x !== y).length).toBe(Math.round(st.n * (1 - (st.percentAgreement ?? 1))));
    });
  });
});
