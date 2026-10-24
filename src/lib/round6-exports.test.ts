// Sixth verification round: export jobs, progress lines, run names, retry wording, agreement off the page (October 24, 2026).
import 'fake-indexeddb/auto';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// When the slow steps start ("[…]"), among the progress steps the builders report.
const events: string[] = [];
vi.mock('./export/backup', async (orig) => {
  const m = await orig<typeof import('./export/backup')>();
  return { ...m, buildBackup: async (...a: Parameters<typeof m.buildBackup>) => (events.push('[backup]'), m.buildBackup(...a)) };
});
vi.mock('./db', async (orig) => {
  const m = await orig<typeof import('./db')>();
  return {
    ...m,
    logPagesForRun: async function* (...a: Parameters<typeof m.logPagesForRun>) {
      events.push(`[logs ${a[0]}]`);
      yield* m.logPagesForRun(...a);
    },
  };
});
vi.mock('exceljs', async (orig) => {
  const o = await orig<{ default: typeof import('exceljs') }>();
  class Workbook extends o.default.Workbook {
    constructor() {
      super();
      events.push('[workbook]');
    }
  }
  return { ...o, default: { ...o.default, Workbook } };
});

import { backgroundRunning, endBackground, setBackgroundProgress, startBackground } from './background';
import * as dbApi from './db';
import { agreementData, agreementHere, buildExcel, buildResearchRepo, buildSupplementary, ZipWriter, type AgreementFor, type ExportData } from './export/packages';
import { retryNotes, runSummaryRows } from './export/tables';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type ResultLog, type Run, type Study } from './types';
import { retriedRequests, runName, runTitle } from './view';

// (The agreement figures with intervals take a few seconds, more on a busy machine.)
vi.setConfig({ testTimeout: 30_000 });

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const textPrompt: PromptSpec = { system: '', userTemplate: 'Score as JSON.', outputMode: 'text', includeRationale: false, variables: [] };
const tonePrompt: PromptSpec = { system: '', userTemplate: 'Rate', outputMode: 'structured', includeRationale: false, variables: [{ name: 'tone', type: 'ordinal', values: ['1', '2', '3'], description: '' }] };

const mkStudy = (id: string, prompt = textPrompt): Study => ({ id, name: 'Round six', description: '', createdAt: '', updatedAt: '', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt });
const mkDocs = (studyId: string, n: number, meta: (i: number) => Record<string, string> = () => ({})): Doc[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${studyId}-d${i}`, studyId, docId: `art_${i}`, text: `Text ${i}.`, meta: { file: `art_${i}.md`, ...meta(i) }, source: 'x', order: i, addedAt: '' }));
const mkRun = (studyId: string, id: string, number: number, docs: Doc[], prompt = textPrompt, extra: Partial<Run> = {}): Run => ({
  id, studyId, number, label: '', createdAt: '2026-10-21T22:30:00.000Z', finishedAt: '2026-10-21T23:00:00.000Z', mode: 'sync', scope: 'All', docIds: docs.map((d) => d.id),
  status: 'completed', batch: null, error: null,
  snapshot: { appVersion: 'test', model: DEFAULT_MODEL_SETTINGS, options: { ...DEFAULT_RUN_OPTIONS, replicates: 1 }, prompt, promptVersion: 1, promptHash: 'h', outputSchema: null, requestBase: { model: 'm' } },
  ...extra,
});
const mkResult = (run: Run, doc: Doc, values: Record<string, string> | null, extra: Partial<Result> = {}): Result => ({
  id: `${run.id}:${doc.id}:1`, runId: run.id, studyId: run.studyId, docId: doc.id, replicate: 1, status: values ? 'ok' : 'error', values: values ?? {}, rationale: '',
  reasoningSummary: '', rawText: values ? JSON.stringify(values) : '', parseError: null, error: values ? null : 'overloaded', usage, latencyMs: 1,
  requestedAt: run.createdAt, completedAt: run.createdAt, responseId: `r-${doc.id}`, modelReported: 'm', stopReason: values ? 'end_turn' : '', ...extra,
});
const log = (r: Result): ResultLog => ({ id: r.id, runId: r.runId, studyId: r.studyId, requestPart: { messages: [{ role: 'user', content: r.docId }] }, response: { id: r.responseId } });

async function unzip(blob: Blob) {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const names = Object.keys(zip.files);
  return { names, read: (suffix: string) => zip.file(names.find((k) => k.endsWith(suffix))!)!.async('string') };
}

/** A plain-text study whose answers give a year (a wide numeric scale) and a tone, with labels for both. */
async function yearStudy(id: string, n = 40): Promise<ExportData> {
  const study = mkStudy(id);
  const docs = mkDocs(id, n, (i) => ({ year_gold: String(1950 + ((i * 7) % 70)), tone_gold: String((i % 7) - 3) }));
  const runs = [mkRun(id, `${id}-r1`, 1, docs), mkRun(id, `${id}-r2`, 2, docs, textPrompt, { createdAt: '2026-10-22T08:00:00.000Z' })];
  const results = runs.flatMap((run, k) =>
    docs.map((d, i) => mkResult(run, d, { response: JSON.stringify({ tone: ((i + k) % 7) - 3, year: 1950 + ((i * 7 + (i % 3 ? 0 : k + 1)) % 70) }) })),
  );
  await dbApi.putStudy(study);
  await dbApi.putDocs(docs);
  for (const r of runs) await dbApi.putRun(r);
  for (const r of results) await dbApi.putResult(r, log(r));
  return { study, docs, runs, results };
}

beforeEach(() => {
  events.length = 0;
});

describe('export jobs outlive the tab that started them (K6)', () => {
  it('one at a time: a second does not start while one runs; its progress is kept until it ends', () => {
    expect(backgroundRunning()).toBe(false);
    const study = { id: 's', name: 'Round six' };
    expect(startBackground('research', 'research repository', study)).toBe(true);
    expect(startBackground('excel', 'Excel workbook', study)).toBe(false);
    expect(startBackground('report', 'comparison report', study)).toBe(false);
    setBackgroundProgress('Writing corpus/corpus.csv');
    expect(backgroundRunning()).toBe(true);
    endBackground();
    expect(backgroundRunning()).toBe(false);
    expect(startBackground('excel', 'Excel workbook', study)).toBe(true);
    endBackground();
  });
});

describe('the progress line names the file being made, not the one before (K13, K20)', () => {
  const shownAt = (steps: string[], marker: string) => {
    const at = steps.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    return steps.slice(0, at).reverse().find((s) => !s.startsWith('['));
  };

  it('research zip: the backup, each run’s logs and the workbook are made after their own file is named', async () => {
    const d = await yearStudy('k13r');
    await buildResearchRepo(d, { includeLogs: true, onProgress: (s) => void events.push(s) });
    expect(shownAt(events, '[backup]')).toBe('Writing study-backup.json');
    expect(shownAt(events, `[logs ${d.runs[0].id}]`)).toBe('Writing runs/run-01/requests.jsonl');
    expect(shownAt(events, `[logs ${d.runs[1].id}]`)).toBe('Writing runs/run-02/requests.jsonl');
    expect(shownAt(events, '[workbook]')).toBe('Writing results/results_run-02.xlsx');
  });

  it('supplementary zip: the logs are read after logs/requests.jsonl is named', async () => {
    const d = await yearStudy('k13s');
    await buildSupplementary(d, d.runs[1], { includeTexts: false, includeRationales: true, includeLogs: true, onProgress: (s) => void events.push(s) });
    expect(shownAt(events, `[logs ${d.runs[1].id}]`)).toBe('Writing logs/requests.jsonl');
  });

  it('a file’s contents made by a function are made once the file has been named and the page has been told', async () => {
    const order: string[] = [];
    const zip = new ZipWriter(3, async (path) => {
      order.push(`named ${path}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`shown ${path}`);
    });
    await zip.folder('top').file('a.csv', () => (order.push('made a.csv'), 'a'));
    await zip.folder('top').file('b.csv', async () => (order.push('made b.csv'), new Blob(['b'])));
    expect(order).toEqual(['named top/a.csv', 'shown top/a.csv', 'made a.csv', 'named top/b.csv', 'shown top/b.csv', 'made b.csv']);
    const { read } = await unzip(zip.blob());
    expect([await read('top/a.csv'), await read('top/b.csv')]).toEqual(['a', 'b']);
  });
});

describe('run names that carry a start time say it is UTC (K11)', () => {
  it('runs that share a number: their names end in Z, and runs that don’t keep their number', () => {
    const docs = mkDocs('k11', 2);
    const a = mkRun('k11', 'k11-a', 3, docs, textPrompt, { createdAt: '2026-10-21T22:30:00.000Z' });
    const b = mkRun('k11', 'k11-b', 3, docs, textPrompt, { createdAt: '2026-10-20T08:00:00.000Z', label: 'second tab' });
    const c = mkRun('k11', 'k11-c', 4, docs);
    const runs = [a, b, c];
    expect(runs.map((r) => runName(r, runs))).toEqual(['3-20261021-223000Z', '3-20261020-080000Z', 4]);
    expect(runTitle(b, runs)).toBe('#3-20261020-080000Z · second tab');
  });
});

describe('an Oct 18–20 batch retry next to a published-build retry counted as a lower bound (K19)', () => {
  it('the planned number and “counted from the stored answers” are about the other retry only; the dated one counts what it recorded', async () => {
    const study = mkStudy('k19', tonePrompt);
    const docs = mkDocs('k19', 10);
    const created = '2026-10-19T10:00:00.000Z';
    const run = mkRun('k19', 'k19-run', 1, docs, tonePrompt, {
      createdAt: created, finishedAt: null, mode: 'batch', status: 'submitted',
      retries: [{ at: '2026-10-19T12:00:00.000Z', requests: 6, asBatch: true }, { at: '2026-10-20T10:00:00.000Z', requests: 2, asBatch: true }],
      batch: {
        provider: 'anthropic', batchId: 'b1', map: {}, lastStatus: 'in_progress', lastCheckedAt: '',
        parts: [
          { batchId: 'b1', status: 'collected', lastStatus: 'ended' },
          { batchId: 'b2', status: 'collected', lastStatus: 'ended' },
          { batchId: 'b3', status: 'submitted', lastStatus: 'in_progress', submittedAt: '2026-10-20T10:00:05.000Z' },
        ],
      },
    });
    run.snapshot = { ...run.snapshot, appVersion: '0.1.0', options: { ...run.snapshot.options, batch: true } };
    // 6 failed at first; the Oct 19 retry fixed 4 (its answers dated at the run's start); 2 are in the published build's batch.
    const results = docs.map((d, i) => mkResult(run, d, i < 2 ? null : { tone: String((i % 3) + 1) }, { requestedAt: created, completedAt: created }));
    await dbApi.putStudy(study);
    await dbApi.putDocs(docs);
    await dbApi.putRun(run);
    for (const r of results) await dbApi.putResult(r, log(r));

    const retry = retriedRequests(run, results);
    expect(retry).toMatchObject({ requests: 6, lowerBound: true, legacy: 1, planned: 2, legacySent: 0, others: 1, undated: 1, undatedRequests: 6 });
    const notes = retryNotes(run, retry).both;
    expect(notes).toContain('recorded for one Retry failed only the number of requests planned (2), not the number sent: counted from the stored answers, the number sent is not known (no stored answer dates from it); with the run’s other retry, at least 6 in all');
    expect(notes).toContain('so the requests that retry sent are taken as the number it recorded (6)');
    expect(notes).not.toContain('planned (8)');
    expect(runSummaryRows([run], results)[0]).toMatchObject({ requests_retried: 6, notes });

    const { blob } = await buildSupplementary({ study, docs, runs: [run], results }, run, { includeTexts: false, includeRationales: false, includeLogs: false });
    const { read } = await unzip(blob);
    const methods = (await read('README.md')).split('\n').find((l) => l.startsWith('> '))!;
    expect(methods).toContain(
      'At least 6 requests without a usable answer (failed, or not sent before the run was stopped) were sent again with identical settings in a new batch (the app version used for the run recorded only the number planned for one of the retries made with it, 2, and no stored answer dates from it, so none of its requests are counted; another retry is counted as the number it recorded, 6, since that version dated its answers at the run’s start)',
    );
    expect(methods).not.toContain('counted from the stored answers');
    expect(JSON.parse(await read('metadata.json')).requests).toMatchObject({ retried: 6, retried_note: expect.stringContaining('planned (2)') });
  });
});

describe('exports compute agreement off the page (K22)', () => {
  it('through the function they are given, once per export (the latest run’s workbook reuses the research zip’s), with the same figures', async () => {
    const d = await yearStudy('k22');
    const calls: string[][] = [];
    const counting: AgreementFor = async (x, runs) => (calls.push(runs.map((r) => r.id)), agreementHere(x, runs));
    const viaFn = await unzip((await buildResearchRepo(d, { includeLogs: false, agreement: counting })).blob);
    expect(calls).toEqual([d.runs.map((r) => r.id)]);
    const here = await unzip((await buildResearchRepo(d, { includeLogs: false })).blob);
    const agr = await viaFn.read('results/agreement.csv');
    expect(agr).toBe(await here.read('results/agreement.csv'));
    // Intervals for the year field (a wide numeric scale) are there.
    expect(agr).toMatch(/year,model \(run 1\),year_gold,/);

    calls.length = 0;
    await buildSupplementary(d, d.runs[0], { includeTexts: false, includeRationales: true, includeLogs: false, agreement: counting });
    await buildExcel(d, d.runs[1], { text: false, rationale: true, agreement: counting });
    expect(calls).toEqual([[d.runs[0].id], [d.runs[1].id]]);
  }, 60_000);

  it('a worker gets the study without its texts: the figures are the same', async () => {
    const d = await yearStudy('k22w', 30);
    const sent = structuredClone(agreementData(d));
    expect(sent.docs.every((x) => x.text === '') && sent.results.every((r) => r.rawText === '')).toBe(true);
    expect(await agreementHere(sent, sent.runs)).toEqual(await agreementHere(d, d.runs));
  });

  it('nor the answers’ raw text, rationale and reasoning: the same figures for a structured run with replicates and two coders', async () => {
    const id = 'k22s';
    const prompt: PromptSpec = { ...tonePrompt, includeRationale: true, variables: [...tonePrompt.variables, { name: 'stance', type: 'category', values: ['pro', 'con'], description: '' }] };
    const study = mkStudy(id, prompt);
    const docs = mkDocs(id, 24, (i) => ({ tone_gold: String((i % 3) + 1), tone_coder2: String(((i + (i % 4 ? 0 : 1)) % 3) + 1), stance_gold: i % 2 ? 'pro' : 'con' }));
    const run = mkRun(id, `${id}-r1`, 1, docs, prompt, { snapshot: { ...mkRun(id, 'x', 1, docs, prompt).snapshot, options: { ...DEFAULT_RUN_OPTIONS, replicates: 3 } } });
    const results = docs.flatMap((d, i) =>
      [1, 2, 3].map((rep) => {
        const values = { tone: String(((i + (rep === 3 && i % 5 === 0 ? 1 : 0)) % 3) + 1), stance: (i + rep) % 3 ? 'pro' : 'con' };
        return mkResult(run, d, values, { id: `${run.id}:${d.id}:${rep}`, replicate: rep, rationale: `Because ${i}/${rep}.`, reasoningSummary: 'Thought.' });
      }),
    );
    const d: ExportData = { study, docs, runs: [run], results };
    const here = await agreementHere(d, [run]);
    expect(here[0].map((r) => `${r.field}:${r.source}:${r.compared_with}`)).toEqual(['tone:model:tone_gold', 'tone:model:tone_coder2', 'stance:model:stance_gold', 'tone:tone_gold:tone_coder2']);
    const sent = structuredClone(agreementData(d));
    expect(await agreementHere(sent, sent.runs)).toEqual(here);
  });

  it('while the figures are not ready, the progress line says so', async () => {
    const d = await yearStudy('k22p', 12);
    let release = () => {};
    const slow: AgreementFor = (x, runs) => new Promise((r) => (release = () => r(agreementHere(x, runs))));
    const steps: string[] = [];
    const excel = buildExcel(d, d.runs[0], { text: false, rationale: true, agreement: slow, onProgress: (s) => void steps.push(s) });
    await vi.waitFor(() => expect(steps).toContain('Computing agreement'));
    release();
    await excel;
    expect(steps).toEqual(['Writing the sheets', 'Computing agreement', 'Writing the file']);

    steps.length = 0;
    const research = buildResearchRepo(d, { includeLogs: false, agreement: slow, onProgress: (s) => void steps.push(s) });
    await vi.waitFor(() => expect(steps).toContain('Computing agreement'));
    release();
    await research;
    const at = steps.indexOf('Computing agreement');
    expect(steps[at - 1]).toMatch(/^Writing runs\/run-02\//);
    expect(steps[at + 1]).toBe('Writing results/agreement.csv');
  });
});
