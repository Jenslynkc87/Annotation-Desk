// Combining several annotations of a text (Nov 6, 2026): the three app-wide fixes after the Results panel's final check.
import 'fake-indexeddb/auto';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { comparableFields, scoreKeep } from './compare';
import { buildSupplementary } from './export/packages';
import { aggregate } from './metrics';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type Run, type Study } from './types';
import { buildDocViews } from './view';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const textPrompt: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'text', variables: [] };
const mkRun = (prompt: PromptSpec, docIds: string[], replicates: number, extra: Partial<Run> = {}): Run => ({
  id: 'r1', studyId: 's', number: 1, label: '', createdAt: '2026-10-01T10:00:00Z', finishedAt: '2026-10-01T11:00:00Z', mode: 'sync', scope: 'All', docIds, status: 'completed',
  batch: null, error: null,
  snapshot: {
    appVersion: 'test', model: DEFAULT_MODEL_SETTINGS, options: { ...DEFAULT_RUN_OPTIONS, replicates }, prompt, promptVersion: 1, promptHash: 'h', outputSchema: null,
    requestBase: { model: DEFAULT_MODEL_SETTINGS.model },
  },
  ...extra,
});
const mkDocs = (n: number): Doc[] =>
  Array.from({ length: n }, (_, i) => ({ id: `d${i}`, studyId: 's', docId: `art_${i}`, text: 't', meta: { file: `art_${i}.md` }, source: 'x', order: i, addedAt: '' }));
const mkResult = (run: Run, doc: Doc, rep: number, values: Record<string, string>): Result => ({
  id: `${run.id}:${doc.id}:${rep}`, runId: run.id, studyId: 's', docId: doc.id, replicate: rep, status: 'ok', values, rationale: '', reasoningSummary: '', rawText: '',
  parseError: null, error: null, usage, latencyMs: 1, requestedAt: '2026-10-01T10:00:00Z', completedAt: '2026-10-01T10:01:00Z', responseId: `${run.id}:${doc.id}:${rep}`,
  modelReported: DEFAULT_MODEL_SETTINGS.model, stopReason: 'end_turn',
});
/** A plain-text run with one JSON key, `key`, answered per text with the given values (one per annotation). */
function jsonRun(key: string, answers: number[][], extra: Partial<Run> = {}) {
  const docs = mkDocs(answers.length);
  const run = mkRun(textPrompt, docs.map((d) => d.id), answers[0].length, extra);
  const results = docs.flatMap((d, i) => answers[i].map((x, j) => mkResult(run, d, j + 1, { response: `{"${key}": ${x}, "${key}_explanation": "a${j}"}` })));
  const views = buildDocViews(docs, [run], results, run.id);
  const value = (i: number) => JSON.parse(views.get(docs[i].id)!.values.response)[key];
  return { docs, run, results, views, value };
}

describe('the majority vote ignores case and spacing, as the statistics do', () => {
  it('counts “Essay” and “essay” as one label, under the spelling given most often', () => {
    expect(aggregate(['Essay', 'essay'], 'majority')).toBe('Essay');
    expect(aggregate(['essay', 'Essay', 'Essay'], 'majority')).toBe('Essay');
    expect(aggregate(['Essay', 'essay', 'Review'], 'majority')).toBe('Essay');
    expect(aggregate(['very  positive', 'very positive', 'negative'], 'majority')).toBe('very  positive');
    // Different labels still tie, as before.
    expect(aggregate(['Essay', 'Review'], 'majority')).toBe('Essay | Review');
    expect(aggregate(['for', 'against'], 'majority')).toBe('against | for');
  });

  it('a free Category field (no listed values): no tie, the annotations agree, and the export counts no tie', async () => {
    const prompt: PromptSpec = { ...DEFAULT_PROMPT, includeRationale: false, variables: [{ name: 'genre', type: 'category', values: [], description: '' }] };
    const docs = mkDocs(3);
    const run = mkRun(prompt, docs.map((d) => d.id), 2);
    const votes = [['Essay', 'essay'], ['Review', 'Essay'], ['Review', 'review ']];
    const results = docs.flatMap((d, i) => votes[i].map((v, j) => mkResult(run, d, j + 1, { genre: v })));
    const views = buildDocViews(docs, [run], results, run.id);
    expect(docs.map((d) => views.get(d.id)!.values.genre)).toEqual(['Essay', 'Essay | Review', 'Review']);
    // (A tie matches no single annotation, as before.)
    expect(docs.map((d) => views.get(d.id)!.consistency.genre)).toEqual([1, 0, 1]);
    const study: Study = { id: 's', name: 'S', description: '', createdAt: '', updatedAt: '', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt };
    const { blob } = await buildSupplementary({ study, docs, runs: [run], results }, run, { includeTexts: false, includeRationales: false, includeLogs: false });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const meta = JSON.parse(await zip.file(Object.keys(zip.files).find((k) => k.endsWith('metadata.json'))!)!.async('string'));
    expect(meta.corpus.n_texts_with_tied_votes).toEqual({ genre: 1 });
  });

  it('plain-text JSON labels in words are voted on the same way', () => {
    const docs = mkDocs(1);
    const run = mkRun(textPrompt, ['d0'], 3);
    const results = ['Essay', 'essay', 'Review'].map((g, j) => mkResult(run, docs[0], j + 1, { response: `{"genre": "${g}"}` }));
    expect(JSON.parse(buildDocViews(docs, [run], results, run.id).get('d0')!.values.response).genre).toBe('Essay');
  });
});

describe('plain-text codes off a fixed scale are left out of the median, as “NA” is', () => {
  // Scores on −3…3 (the study's declared scale), a few answers 9 (“can't tell”) or 5 (off the scale).
  const rest = Array.from({ length: 18 }, (_, i) => [(i % 7) - 3, (i % 7) - 3, ((i + 1) % 7) - 3]);
  it('on a declared −3…3 scale: 1, 2 and 9 combine to 1.5, not 2; 2 and 5 to 2', () => {
    const { value, run, views } = jsonRun('race', [[1, 2, 9], [2, 5, 2], ...rest], { scoreScale: { min: -3, max: 3 } });
    expect(comparableFields(run, views.values()).find((f) => f.key === 'race')!.range).toEqual([-3, 3]);
    expect([value(0), value(1)]).toEqual([1.5, 2]);
  });
  it('every answer off the scale: combined as before (then left out and reported by the statistics)', () => {
    const { value } = jsonRun('race', [[9, 9, 9], [9, 99, 9], ...rest], { scoreScale: { min: -3, max: 3 } });
    expect([value(0), value(1)]).toEqual([9, 9]);
  });
  it('without a declared scale and not a yes/no: nothing is left out (only the range seen is known)', () => {
    const { value } = jsonRun('race', [[1, 2, 9], ...rest]);
    expect(value(0)).toBe(2);
  });
  it('a yes/no in numbers (mostly 0 and 1): a 9 is a code, left out; a stray 2 is not', () => {
    const flags = Array.from({ length: 30 }, (_, i) => [i % 2, i % 2, i % 3 ? 1 : 0]);
    const { value, run, views } = jsonRun('flag', [[1, 9, 9], [0, 1, 9], [1, 2, 1], ...flags]);
    expect(comparableFields(run, views.values()).find((f) => f.key === 'flag')!.zeroOne).toBe(true);
    expect([value(0), value(1), value(2)]).toEqual([1, 0.5, 1]);
  });
  it('a view of one text (as the label-sheet check builds) combines as the run does when given the run’s scales', () => {
    const { docs, run, results, value } = jsonRun('race', [[1, 2, 9], ...rest], { scoreScale: { min: -3, max: 3 } });
    const own = results.filter((r) => r.docId === docs[0].id);
    const one = buildDocViews([docs[0]], [run], own, run.id, (r) => scoreKeep(r, results)).get(docs[0].id)!;
    expect(JSON.parse(one.values.response).race).toBe(value(0));
  });
  it('the exports say how many were left out, only when some were', async () => {
    const supp = async (answers: number[][]) => {
      const { docs, run, results } = jsonRun('race', answers, { scoreScale: { min: -3, max: 3 } });
      const study: Study = { id: 's', name: 'S', description: '', createdAt: '', updatedAt: '', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt: textPrompt };
      const { blob } = await buildSupplementary({ study, docs, runs: [run], results }, run, { includeTexts: false, includeRationales: false, includeLogs: false });
      const zip = await JSZip.loadAsync(await blob.arrayBuffer());
      const read = (suffix: string) => zip.file(Object.keys(zip.files).find((k) => k.endsWith(suffix))!)!.async('string');
      return { meta: JSON.parse(await read('metadata.json')), readme: await read('README.md') };
    };
    const some = await supp([[1, 2, 9], [2, 5, 2], [9, 9, 9], ...rest]);
    expect(some.meta.requests.scores_off_scale_left_out_when_combined).toBe(2);
    expect(some.readme).toContain(
      '2 scores off the scale (e.g. a code such as 9 for “can’t tell”) were left out when the answers were combined, like a missing value, where another answer for the same text was on the scale.',
    );
    const none = await supp(rest);
    expect(none.meta.requests.scores_off_scale_left_out_when_combined).toBeUndefined();
    expect(none.readme).not.toContain('off the scale');
  });
  it('the explanation shown is that of an annotation on the scale', () => {
    const { views, docs } = jsonRun('race', [[2, 9, 2], ...rest], { scoreScale: { min: -3, max: 3 } });
    expect(JSON.parse(views.get(docs[0].id)!.values.response).race_explanation).toBe('a0');
  });
});

describe('a plain-text 0/1 key with a code, in a study with a declared score scale', () => {
  const flags = Array.from({ length: 30 }, (_, i) => [i % 2]);
  it('is a yes/no, as without the scale (it was read on −3…3)', () => {
    const { run, views } = jsonRun('flag', [[9], ...flags], { scoreScale: { min: -3, max: 3 } });
    const f = comparableFields(run, views.values())[0];
    expect([f.scaleSeen, f.zeroOne]).toEqual([true, true]);
  });
  it('still a scale when the other value is on it (a stray 2), or the code is (a 9 on 0…10)', () => {
    const stray = jsonRun('flag', [[2], ...flags], { scoreScale: { min: -3, max: 3 } });
    expect(comparableFields(stray.run, stray.views.values())[0].range).toEqual([-3, 3]);
    const onScale = jsonRun('flag', [[9], ...flags], { scoreScale: { min: 0, max: 10 } });
    expect(comparableFields(onScale.run, onScale.views.values())[0].range).toEqual([0, 10]);
  });
  it('only 0 and 1: a yes/no, as before', () => {
    const { run, views } = jsonRun('flag', flags, { scoreScale: { min: -3, max: 3 } });
    expect(comparableFields(run, views.values())[0].zeroOne).toBe(true);
  });
});
