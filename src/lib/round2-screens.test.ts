// Tests for the second review round (October 23, 2026), screens: the Agreement panel's field for two label columns,
// the Workbench's filters after a column is removed and its "Disagree with" rule, and the wording of Remaining and
// of shared batches.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { remainingRule } from '../components/CostEstimate';
import { chosenField, columnsFieldRun, copyElsewhere, leftOutReason, NO_FIELD, OTHER_STUDY_HERE } from '../components/RunsView';
import { comparableLabel, remainingNotes, validFilters } from '../components/Workbench';
import type { ComparableField } from './compare';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type Run, type Study, type Variable } from './types';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const mkRun = (prompt: PromptSpec, docIds: string[], id: string, number: number): Run => ({
  id, studyId: 's', number, label: '', createdAt: '', finishedAt: null, mode: 'sync', scope: '', docIds, status: 'completed', batch: null, error: null,
  snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt, promptVersion: number, promptHash: 'h', outputSchema: null, requestBase: {} },
});
const mkResult = (run: string, doc: string, values: Record<string, string>): Result => ({
  id: `${run}:${doc}:1`, runId: run, studyId: 's', docId: doc, replicate: 1, status: 'ok', values, rationale: '', reasoningSummary: '', rawText: values.response ?? '',
  parseError: null, error: null, usage, latencyMs: 1, requestedAt: '', completedAt: '', responseId: `id-${doc}`, modelReported: 'm', stopReason: 'end_turn',
});
const mkDoc = (id: string, order: number, meta: Record<string, string> = {}): Doc => ({ id, studyId: 's', docId: id, text: 't', meta, source: `${id}.txt`, order, addedAt: '' });
const variable = (name: string, type: Variable['type'], values: string[] = []): Variable => ({ name, type, values, description: '' });
const scale = ['-3', '-2', '-1', '0', '1', '2', '3'];
const structured = (...variables: Variable[]): PromptSpec => ({ ...DEFAULT_PROMPT, outputMode: 'structured', variables });
const study = (prompt: PromptSpec): Study => ({ id: 's', name: 'S', description: '', createdAt: '', updatedAt: '', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt });

// Ten texts coded twice for race (−3…3) and for relevant (yes/no), with "NA" for one uncoded text.
const docs = Array.from({ length: 10 }, (_, i) =>
  mkDoc(`d${i}`, i, {
    race_gold: i === 9 ? 'NA' : String((i % 7) - 3),
    race_coder2: String(((i + 1) % 7) - 3),
    relevant_gold: i % 2 ? 'yes' : 'no',
    relevant_coder2: i % 3 ? '1' : '0',
  }),
);

describe('Agreement panel: the field of two label columns (N34, N59, N67, N127, R1, R6, R11)', () => {
  const race = variable('race', 'ordinal', scale);
  const relevant = variable('relevant', 'boolean');
  const early = mkRun(structured(race, relevant), docs.map((d) => d.id), 'r1', 1);
  // The latest run is a pilot of another prompt, without race or relevant.
  const pilot = mkRun(structured(variable('gender', 'category', ['f', 'm'])), ['d0'], 'r2', 2);
  const results = [...docs.map((d) => mkResult('r1', d.id, { race: '0', relevant: 'true' })), mkResult('r2', 'd0', { gender: 'f' })];

  it('takes the field from an earlier run when the latest run lacks it', () => {
    const m = columnsFieldRun('race_gold', 'race_coder2', study(pilot.snapshot.prompt), [early, pilot], docs, results);
    expect(m?.run.id).toBe('r1');
    expect(m?.field.key).toBe('race');
    expect(m?.field.level).toBe('ordinal');
    expect(m?.field.allowed).toEqual(['-3', '-2', '-1', '0', '1', '2', '3']);
    // The yes/no rule comes with the field (1/0 and yes/no are the same values).
    const y = columnsFieldRun('relevant_gold', 'relevant_coder2', null, [early, pilot], docs, results);
    expect(y?.field.yesNo).toBe(true);
  });

  it('prefers the newest run that has the field, and finds none for columns of two different fields', () => {
    const later = mkRun(structured(variable('tone', 'ordinal', scale), variable('race', 'ordinal', scale)), ['d0'], 'r3', 3);
    const m = columnsFieldRun('race_gold', 'race_coder2', null, [early, later, pilot], docs, [...results, mkResult('r3', 'd0', { race: '3', tone: '1' })]);
    expect(m?.run.id).toBe('r3');
    // A run whose race is on another scale (the labels are mostly not its values) is passed over, as in the exports.
    const other = mkRun(structured(variable('race', 'ordinal', ['1', '2', '3', '4', '5'])), ['d0'], 'r5', 5);
    expect(columnsFieldRun('race_gold', 'race_coder2', null, [early, other], docs, [...results, mkResult('r5', 'd0', { race: '3' })])?.run.id).toBe('r1');
    expect(columnsFieldRun('race_gold', 'relevant_coder2', null, [early, pilot], docs, results)).toBeUndefined();
  });

  it('finds a score field in the JSON answers of a plain-text run', () => {
    const text = mkRun({ ...DEFAULT_PROMPT, outputMode: 'text', variables: [] }, docs.map((d) => d.id), 'r4', 4);
    const rs = docs.map((d, i) => mkResult('r4', d.id, { response: `{"race": ${(i % 5) - 2}, "explanation": "x"}` }));
    const m = columnsFieldRun('race_gold', 'race_coder2', null, [text, pilot], docs, [...rs, mkResult('r2', 'd0', { gender: 'f' })]);
    expect(m?.run.id).toBe('r4');
    expect(m?.field.key).toBe('race');
    expect(m?.field.scaleSeen).toBe(true);
  });

  const f = (key: string): ComparableField => ({ key, label: key, level: 'ordinal', allowed: scale, yesNo: false });
  const fields = [f('relevant'), f('stance'), f('race')];
  const p1 = 'run:r1\u0001meta:relevant_gold';
  const p2 = 'meta:stance_gold\u0001meta:stance_coder2';
  const p3 = 'meta:race_gold\u0001meta:race_coder2';

  it('does not carry a field picked for an earlier pair over to a new pair of label columns', () => {
    // Picked Relevant for a run vs relevant_gold; then two stance coders: their own field applies.
    expect(chosenField({ pair: p1, key: 'relevant' }, p2, true, fields, fields[1])?.key).toBe('stance');
    // "None" picked for one pair of coders doesn't carry over either.
    expect(chosenField({ pair: p2, key: NO_FIELD }, p3, true, fields, fields[2])?.key).toBe('race');
    // For the pair it was picked for, the pick applies.
    expect(chosenField({ pair: p2, key: NO_FIELD }, p2, true, fields, fields[1])).toBeUndefined();
    expect(chosenField({ pair: p3, key: 'stance' }, p3, true, fields, fields[2])?.key).toBe('stance');
    // No field fits: None.
    expect(chosenField(null, p3, true, fields, undefined)).toBeUndefined();
    // A run on one side: the pick stays (the menu is the only way to say which field), else the first field.
    expect(chosenField({ pair: p1, key: 'race' }, 'run:r1\u0001meta:race_gold', false, fields, undefined)?.key).toBe('race');
    expect(chosenField(null, p1, false, fields, undefined)?.key).toBe('relevant');
  });

  it('names the scale when labels are left out as off the scale', () => {
    expect(leftOutReason('ordinal', [-3, 3])).toBe('a label isn’t a number or is outside the scale (−3 to 3)');
    expect(leftOutReason('interval')).toBe('a label isn’t a number or is outside the scale');
    expect(leftOutReason('nominal')).toBe('a label isn’t one of the field’s values');
  });
});

describe('Workbench filters and Disagree with (N104, N121, N128)', () => {
  it('drops a metadata filter and a comparison on a removed column', () => {
    const options = [{ c: 'sample', values: ['pilot', 'validation'] }];
    const before = { metaFilter: 'era\u001f1950s', compareCol: 'tone_gold', statusFilter: 'mismatch' as const };
    expect(validFilters(before, options, ['sample'])).toEqual({ metaFilter: '', compareCol: '', statusFilter: 'all' });
    // Still there: kept.
    const kept = { metaFilter: 'sample\u001fvalidation', compareCol: 'sample', statusFilter: 'mismatch' as const };
    expect(validFilters(kept, options, ['sample'])).toEqual(kept);
    // A value no longer in the column is dropped too.
    expect(validFilters({ ...kept, metaFilter: 'sample\u001fold' }, options, ['sample']).metaFilter).toBe('');
  });

  it('leaves "NA" and numbers off the scale out of the disagreements, as the Agreement panel does', () => {
    const ordinal = variable('tone', 'ordinal', scale);
    const pairs: [string, string][] = [['1', '1'], ['2', '-1'], ['0', 'na'], ['1', '99'], ['3', '3']];
    const ok = comparableLabel(ordinal, pairs);
    expect(['2', '-1', '1.5', '-3'].every(ok)).toBe(true);
    expect(['na', 'n/a', '99', '4'].some(ok)).toBe(false);
    // Categories (and ties of them); a missing-value marker is never a disagreement.
    const cat = comparableLabel(variable('stance', 'category', ['Pro', 'Contra']), [['pro', 'contra'], ['pro', 'NA']]);
    expect([cat('pro'), cat('pro | contra'), cat('na'), cat('maybe')]).toEqual([true, true, false, false]);
    expect(comparableLabel(variable('relevant', 'boolean'), [])('n/a')).toBe(false);
    // Mostly words on a scale: compared as they are (as `agreement` does), but still not "NA".
    const words = comparableLabel(ordinal, [['1', 'low'], ['2', 'high'], ['0', 'low'], ['1', 'NA']]);
    expect([words('low'), words('na')]).toEqual([true, false]);
  });
});

describe('Remaining and shared batches: wording (N56, N123, N42/N65/N72/N96/N129, N69, N64, N134, R9, R13, R30)', () => {
  const w = { one: 'text', many: 'texts' };
  it('says what Remaining leaves out, and where to send texts of an upload whose outcome is unknown', () => {
    const n = remainingNotes({ waiting: 0, unknown: 3, unknownRuns: [4] }, w);
    expect(n.waiting).toBe('');
    expect(n.unknown).toContain('3 texts are left out');
    expect(n.unknown).toContain('in run #4, whose batch upload may have reached the provider');
    expect(n.unknown).toContain('Retry failed on run #4');
    const two = remainingNotes({ waiting: 1, unknown: 1, unknownRuns: [2, 5] }, { one: 'entry', many: 'entries' });
    expect(two.waiting).toBe('1 entry is still waiting in a batch and left out.');
    expect(two.unknown).toContain('1 entry is left out: it is in runs #2, #5');
  });

  it('describes the Remaining rule with model and effort, batches and unknown uploads', () => {
    const r = remainingRule(w);
    expect(r).toContain('current prompt, model and effort');
    expect(r).toContain('still waiting in a batch');
    expect(r).toContain('upload whose outcome is unknown');
    expect(remainingRule({ many: 'entries' })).toMatch(/^entries that have/);
  });

  it('calls the other study neither the original nor the copy, and warns about copies in other browsers', () => {
    expect(OTHER_STUDY_HERE).toContain('a copy from a backup or the study this one was copied from');
    expect(copyElsewhere()).toContain('another browser or on another computer');
    expect(copyElsewhere()).toContain('the same batch would lose it too');
    expect(copyElsewhere(2)).toContain('the same batches would lose them too');
  });
});
