// Fourth verification round: exports and run names (October 23, 2026).
import 'fake-indexeddb/auto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import * as dbApi from './db';
import { buildComparisonReport, buildResearchRepo, buildSupplementary, type ExportData } from './export/packages';
import { fillScript, SCRIPT_TEMPLATE, scriptValues } from './export/python';
import { runName as runNameFromTables, runSummaryRows } from './export/tables';
import { getState, selectStudy } from './store';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type ResultLog, type Run, type Study } from './types';
import { retriedRequests, retryCounts, runName, runTitle } from './view';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const stancePrompt: PromptSpec = { ...DEFAULT_PROMPT, includeRationale: false, variables: [{ name: 'stance', type: 'category', values: ['for', 'against'], description: '' }] };
// A plain-text prompt as the editor leaves it: the hidden default codebook (a "label" field, rationale on) stays.
const plainPrompt: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'text' };

const mkRun = (id: string, number: number, docIds: string[], prompt: PromptSpec, extra: Partial<Run> = {}, replicates = 1, appVersion = 'test'): Run => ({
  id, studyId: 's', number, label: '', createdAt: '2026-10-01T10:00:00.000Z', finishedAt: '2026-10-01T11:00:00.000Z', mode: 'sync', scope: 'All', docIds, status: 'completed',
  batch: null, error: null,
  snapshot: {
    appVersion, model: DEFAULT_MODEL_SETTINGS, options: { ...DEFAULT_RUN_OPTIONS, replicates }, prompt, promptVersion: 1, promptHash: 'h', outputSchema: null,
    requestBase: { model: DEFAULT_MODEL_SETTINGS.model },
  },
  ...extra,
});
const mkDocs = (n: number, meta: (i: number) => Record<string, string> = () => ({}), studyId = 's'): Doc[] =>
  Array.from({ length: n }, (_, i) => ({ id: `d${i}`, studyId, docId: `art_${i}`, text: 't', meta: { file: `art_${i}.md`, ...meta(i) }, source: 'x', order: i, addedAt: '' }));
const mkResult = (run: Run, doc: Doc, rep: number, values: Record<string, string> | null, extra: Partial<Result> = {}): Result => ({
  id: `${run.id}:${doc.id}:${rep}`, runId: run.id, studyId: run.studyId, docId: doc.id, replicate: rep, status: values ? 'ok' : 'error', values: values ?? {}, rationale: '',
  reasoningSummary: '', rawText: values ? JSON.stringify(values) : '', parseError: null, error: values ? null : 'overloaded', usage, latencyMs: 1,
  requestedAt: '2026-10-01T10:00:00.000Z', completedAt: '2026-10-01T10:01:00.000Z', responseId: `${run.id}:${doc.id}:${rep}`, modelReported: DEFAULT_MODEL_SETTINGS.model,
  stopReason: values ? 'end_turn' : '', ...extra,
});
const mkStudy = (prompt: PromptSpec, id = 's'): Study => ({ id, name: 'Round four', description: '', createdAt: '', updatedAt: '', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt });

async function supplementary(d: ExportData, run: Run, includeLogs = false) {
  const { blob } = await buildSupplementary(d, run, { includeTexts: false, includeRationales: false, includeLogs });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const has = (suffix: string) => Object.keys(zip.files).some((k) => k.endsWith(suffix));
  const read = (suffix: string) => zip.file(Object.keys(zip.files).find((k) => k.endsWith(suffix))!)!.async('string');
  const readme = await read('README.md');
  const methods = readme.split('\n').find((l) => l.startsWith('> '))!.slice(2);
  const meta = JSON.parse(await read('metadata.json'));
  return { zip, has, read, readme, methods, meta };
}

async function workbook(blob: Blob) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await blob.arrayBuffer());
  return (name: string) => {
    const ws = wb.getWorksheet(name)!;
    const head = (ws.getRow(1).values as unknown[]).slice(1) as string[];
    return Array.from({ length: ws.rowCount - 1 }, (_, i) => Object.fromEntries(head.map((h, j) => [h, ws.getRow(i + 2).getCell(j + 1).value]))) as Record<string, unknown>[];
  };
}

// The published version (0.1.0) recorded a batch Retry failed with the number planned before uploading. Over the
// provider's limit it went up as several batches; when a later upload failed, the entry kept the planned number.
describe('a published-version batch retry with a group never uploaded (G0, G2)', () => {
  const docs = mkDocs(6);
  const t0 = '2026-10-16T10:00:00.000Z';
  const retryAt = '2026-10-16T12:00:00.000Z';
  const t1 = '2026-10-16T12:00:03.000Z';
  const legacyBatch = (extra: Partial<Run> = {}) =>
    mkRun('lb', 1, docs.map((d) => d.id), stancePrompt, {
      mode: 'batch',
      retries: [{ at: retryAt, requests: 6, asBatch: true }],
      batch: {
        provider: 'anthropic', batchId: 'b1', map: {}, lastStatus: 'ended', lastCheckedAt: null,
        parts: [
          { batchId: 'b1', status: 'collected', lastStatus: 'ended', submittedAt: t0 },
          { batchId: 'b2', status: 'collected', lastStatus: 'ended', submittedAt: t1 },
        ],
      },
      ...extra,
    }, 1, '0.1.0');

  it('counts the requests from the stored answers, as a lower bound, with the planned number', async () => {
    const run = legacyBatch();
    // d0–d3 re-sent in the batch that went up (their answers take its upload time); d4, d5 still failed from before.
    const results = docs.map((d, i) => (i < 4 ? mkResult(run, d, 1, { stance: 'for' }, { requestedAt: t1 }) : mkResult(run, d, 1, null, { requestedAt: t0 })));
    expect(retriedRequests(run, results)).toMatchObject({ requests: 4, lowerBound: true, planned: 6, legacySent: 4, tokensIncomplete: true, asBatch: 'all' });
    const { methods, meta } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(methods).toContain(
      'At least 4 requests without a usable answer (failed, or not sent before the run was stopped) were sent again with identical settings in a new batch (counted from the stored answers: the app version used for the run recorded only the number planned for the retry made with it, 6)',
    );
    expect(meta.requests.retried).toBe(4);
    expect(meta.requests.retried_note).toContain('recorded for Retry failed only the number of requests planned (6), not the number sent: counted from the stored answers, at least 4 were sent');
    const [row] = runSummaryRows([run], results);
    expect(row.requests_retried).toBe(4);
  });

  it('a batch retry that came back whole is reported exactly', async () => {
    const run = legacyBatch();
    const results = docs.map((d) => mkResult(run, d, 1, { stance: 'for' }, { requestedAt: t1 }));
    expect(retriedRequests(run, results)).toMatchObject({ requests: 6, lowerBound: false, planned: 6 });
    const { methods, meta } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(methods).toContain('6 requests without a usable answer (failed, or not sent before the run was stopped) were sent again with identical settings in a new batch.');
    expect(methods).not.toContain('At least');
    expect(meta.requests.retried_note).toBeUndefined();
  });

  it('while its batch is still being processed: how many is not known yet', async () => {
    const run = legacyBatch({ status: 'submitted', finishedAt: null });
    run.batch!.parts![1].status = 'submitted';
    const results = docs.map((d) => mkResult(run, d, 1, null, { requestedAt: t0 }));
    expect(retriedRequests(run, results)).toMatchObject({ requests: 0, lowerBound: true, planned: 6 });
    const { methods } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(methods).toContain(
      'Requests without a usable answer (failed, or not sent before the run was stopped) were sent again with identical settings in a new batch (how many is not known: the app version used for the run recorded only the number planned for the retry made with it, 6, and no stored answer dates from it), and the retry was still under way when this was exported',
    );
    expect(methods).not.toContain('6 requests without');
  });
});

// A later Retry failed replaced the answers of a published-version retry: their request times stay on the results.
describe('a published-version retry whose answers a later retry replaced (G22)', () => {
  it('is still counted, from the replaced attempts’ request times', async () => {
    const study = mkStudy(stancePrompt, 's-g22');
    const docs = mkDocs(3, () => ({}), study.id);
    const legacyAt = '2026-10-20T10:00:00.000Z';
    const todayAt = '2026-10-23T10:00:00.000Z';
    const run = mkRun('g22', 1, docs.map((d) => d.id), stancePrompt, { studyId: study.id, retries: [{ at: legacyAt, requests: 3 }, { at: todayAt, requests: 3, counted: 'sent' }] }, 1, '0.1.0');
    const log = (r: Result): ResultLog => ({ id: r.id, runId: r.runId, studyId: r.studyId, requestPart: {}, response: { id: r.responseId } });
    // The published retry's answers (failed again; that version overwrote the run's first ones), then today's.
    for (const d of docs) {
      const old = mkResult(run, d, 1, null, { requestedAt: '2026-10-20T10:00:01.000Z', responseId: `old-${d.id}` });
      await dbApi.putResult(old, log(old));
    }
    const results: Result[] = [];
    for (const d of docs) {
      const now = mkResult(run, d, 1, { stance: 'for' }, { requestedAt: '2026-10-23T10:00:01.000Z', responseId: `new-${d.id}` });
      await dbApi.putResult(now, log(now));
      results.push(now);
    }
    expect(results[0]).toMatchObject({ attempt: 2, replacedAt: ['2026-10-20T10:00:01.000Z'] });
    expect(retryCounts(run, results).map((c) => c.requests)).toEqual([3, 3]);
    expect(retriedRequests(run, results)).toMatchObject({ requests: 6, lowerBound: false });
    const { methods, meta } = await supplementary({ study, docs, runs: [run], results }, run);
    expect(methods).toContain('6 requests without a usable answer');
    expect(methods).not.toContain('At least');
    expect(meta.requests.retried_note).toBeUndefined();
  });

  it('no request of it left on record: says so without claiming no answer remains', () => {
    const docs = mkDocs(1);
    const run = mkRun('g22b', 1, ['d0'], stancePrompt, { retries: [{ at: '2026-10-20T10:00:00.000Z', requests: 2 }, { at: '2026-10-23T10:00:00.000Z', requests: 1, counted: 'sent' }] }, 1, '0.1.0');
    // Replaced before request times were kept on the results (only its log has it).
    const results = [mkResult(run, docs[0], 1, { stance: 'for' }, { requestedAt: '2026-10-23T10:00:01.000Z', attempt: 2 })];
    const [row] = runSummaryRows([run], results);
    expect(String(row.notes)).toContain('the number sent is not known (no stored answer dates from it)');
    expect(String(row.notes)).not.toContain('no answer to them remains');
  });
});

describe('responses.jsonl: a replaced attempt that could not be read (G23)', () => {
  it('gives its parse error, and the README says what such a line holds', async () => {
    const study = mkStudy(stancePrompt, 's-g23');
    const docs = mkDocs(1, () => ({}), study.id);
    const run = mkRun('g23', 1, ['d0'], stancePrompt, { studyId: study.id, retries: [{ at: '2026-10-02T09:00:00.000Z', requests: 1, counted: 'sent' }] });
    const log = (r: Result): ResultLog => ({ id: r.id, runId: r.runId, studyId: r.studyId, requestPart: { content: 'x' }, response: { text: r.rawText } });
    const bad = mkResult(run, docs[0], 1, null, { error: null, parseError: 'Missing field(s): stance', rawText: '{"rationale": "none"}', responseId: 'm1' });
    await dbApi.putResult(bad, log(bad));
    const good = mkResult(run, docs[0], 1, { stance: 'for' }, { requestedAt: '2026-10-02T09:00:01.000Z', responseId: 'm2' });
    await dbApi.putResult(good, log(good));
    const { read, readme } = await supplementary({ study, docs, runs: [run], results: [good] }, run, true);
    const lines = (await read('logs/responses.jsonl')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ attempt: 1, status: 'error', error: null, parse_error: 'Missing field(s): stance' });
    expect(lines[1].attempt).toBe(2);
    expect(lines[1]).not.toHaveProperty('parse_error');
    expect(readme).toContain('the response line of an earlier, replaced attempt also gives its status, error and parse_error');
  });
});

describe('methods text: texts with only some annotations (G26)', () => {
  it('a text whose only answer failed is not described as labelled with fewer answers', async () => {
    const docs = mkDocs(6);
    const run = mkRun('g26', 1, docs.map((d) => d.id), stancePrompt, { status: 'cancelled' }, 3);
    // 5 texts complete; the 6th has 1 of 3 annotations, and it failed.
    const results = [...docs.slice(0, 5).flatMap((d) => [1, 2, 3].map((rep) => mkResult(run, d, rep, { stance: 'for' }))), mkResult(run, docs[5], 1, null)];
    const { methods, meta } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(meta.corpus.n_texts_partly_annotated).toBe(0);
    expect(methods).toContain('Each text was annotated 3 times');
    expect(methods).not.toContain('labels combine fewer answers');
    expect(methods).toContain('leaving 1 text without a label');
  });

  it('nor a plain-text text whose only answer gave no scores', async () => {
    const docs = mkDocs(3);
    const run = mkRun('g26b', 1, docs.map((d) => d.id), plainPrompt, { status: 'cancelled' }, 3);
    const json = (x: number) => ({ response: JSON.stringify({ tone: x, explanation: 'e' }) });
    const results = [...docs.slice(0, 2).flatMap((d) => [1, 2, 3].map((rep) => mkResult(run, d, rep, json(rep - 1)))), mkResult(run, docs[2], 1, { response: 'In prose.' })];
    const { methods, meta } = await supplementary({ study: mkStudy(plainPrompt), docs, runs: [run], results }, run);
    expect(meta.corpus.n_texts_partly_annotated).toBe(0);
    expect(methods).not.toContain('labels combine fewer answers');
  });

  it('a labelled text with fewer answers still is', async () => {
    const docs = mkDocs(2);
    const run = mkRun('g26c', 1, docs.map((d) => d.id), stancePrompt, { status: 'cancelled' }, 3);
    const results = [...[1, 2, 3].map((rep) => mkResult(run, docs[0], rep, { stance: 'for' })), mkResult(run, docs[1], 1, { stance: 'for' }), mkResult(run, docs[1], 2, null)];
    const { methods, meta } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(meta.corpus.n_texts_partly_annotated).toBe(1);
    expect(methods).toContain('for 1 text, 1 of its annotations has no answer recorded');
  });
});

describe('runs that share a number (G27, G36)', () => {
  const docs = mkDocs(2);
  const a = mkRun('aaaaaaaa-1111', 2, docs.map((d) => d.id), stancePrompt);
  const b = mkRun('bbbbbbbb-2222', 2, docs.map((d) => d.id), stancePrompt, { label: 'pilot' });
  const c = mkRun('cccccccc-3333', 3, docs.map((d) => d.id), stancePrompt);
  const runs = [a, b, c];

  it('runTitle names them as the exports do, given the study’s runs', () => {
    expect(runTitle(a, runs)).toBe('#2-aaaaaaaa');
    expect(runTitle(b, runs)).toBe('#2-bbbbbbbb · pilot');
    expect(runTitle(c, runs)).toBe('#3');
    // (Without the runs, as before.)
    expect(runTitle(b)).toBe('#2 · pilot');
    expect(runNameFromTables(b, runs)).toBe(runName(b, runs));
  });

  it('metadata.json gives the run’s name and id; the README and the script say which run it is', async () => {
    const results = runs.flatMap((r) => docs.map((d) => mkResult(r, d, 1, { stance: 'for' })));
    const { meta, readme, read } = await supplementary({ study: mkStudy(stancePrompt), docs, runs, results }, b);
    expect(meta.run).toMatchObject({ number: 2, name: '2-bbbbbbbb', id: 'bbbbbbbb-2222' });
    expect(readme).toContain('(run #2-bbbbbbbb, "pilot")');
    expect(readme).toContain('this one is named by its number and the start of its id (`run.id` in metadata.json)');
    expect(await read('scripts/annotate.py')).toContain('#2-bbbbbbbb (pilot), started');
    // A run with a number of its own: unchanged.
    const own = await supplementary({ study: mkStudy(stancePrompt), docs, runs, results }, c);
    expect(own.meta.run).toMatchObject({ number: 3, name: '3' });
    expect(own.readme).not.toContain('start of its id');
    expect(fillScript(SCRIPT_TEMPLATE, scriptValues(mkStudy(stancePrompt), c, 'now'))).toContain('#3, started');
  });
});

describe('comparison report while a run is not finished (G32)', () => {
  const docs = mkDocs(4);
  const at = '2026-10-02T09:00:00.000Z';
  const make = async (b: Run) => {
    const a = mkRun('a', 1, docs.map((d) => d.id), stancePrompt);
    const results = [...docs.map((d) => mkResult(a, d, 1, { stance: 'for' })), ...docs.map((d, i) => mkResult(b, d, 1, i < 2 ? null : { stance: 'for' }))];
    const report = await workbook(await buildComparisonReport(a, b, docs, [a, b], results, 1));
    return { status: report('Runs').find((r) => r.setting === 'status')!, notes: report('Notes').map((r) => String(r.note)) };
  };

  it('its Retry failed batch still being processed', async () => {
    const b = mkRun('b', 2, docs.map((d) => d.id), stancePrompt, { mode: 'batch', status: 'submitted', finishedAt: null, retries: [{ at, requests: 2, asBatch: true, counted: 'sent' }] });
    const { status, notes } = await make(b);
    expect(status).toMatchObject({ first: 'completed', second: 'not finished: its Retry failed batch was still being processed' });
    expect(notes).toContain('Run #2 was not finished when this report was made (its Retry failed batch was still being processed): the figures are those of its results so far and may change once it is done.');
  });

  it('Retry failed still sending', async () => {
    const b = mkRun('b', 2, docs.map((d) => d.id), stancePrompt, { status: 'running', resumeStatus: 'completed', resumeError: null, retries: [{ at, requests: 0, counted: 'sent' }] });
    const { status, notes } = await make(b);
    expect(status.second).toBe('not finished: Retry failed was still sending requests');
    expect(notes.some((n) => n.startsWith('Run #2 was not finished when this report was made (Retry failed was still sending requests)'))).toBe(true);
  });

  it('both finished: nothing said', async () => {
    const { status, notes } = await make(mkRun('b', 2, docs.map((d) => d.id), stancePrompt));
    expect(status).toMatchObject({ first: 'completed', second: 'completed' });
    expect(notes.some((n) => n.includes('not finished'))).toBe(false);
  });
});

describe('a plain-text run’s package (G39)', () => {
  it('requested no rationale and had no fields or schema', async () => {
    const docs = mkDocs(2);
    const run = mkRun('g39', 1, docs.map((d) => d.id), plainPrompt);
    const results = docs.map((d) => mkResult(run, d, 1, { response: 'Free text.' }));
    const d: ExportData = { study: mkStudy(plainPrompt), docs, runs: [run], results };
    const { meta, has, read, readme } = await supplementary(d, run);
    expect(meta.prompt).toMatchObject({ output_mode: 'text', rationale_requested: false });
    expect(has('prompt/codebook.json')).toBe(false);
    expect(has('prompt/output_schema.json')).toBe(false);
    expect(await read('prompt/codebook.md')).toContain('free-text response (no structured fields)');
    expect(readme).not.toContain('JSON schema the responses had to follow');
    expect(readme).not.toContain('`codebook.json`');
    expect(readme).toContain('| `prompt/codebook.md` | Says that the model returned free text: there were no fields and no output schema |');
    // The research zip's prompt folder too.
    const { blob } = await buildResearchRepo(d, { includeLogs: false });
    const files = Object.keys((await JSZip.loadAsync(await blob.arrayBuffer())).files);
    expect(files.some((f) => f.endsWith('prompts/v1/codebook.md'))).toBe(true);
    expect(files.some((f) => f.endsWith('prompts/v1/codebook.json') || f.endsWith('prompts/v1/output_schema.json'))).toBe(false);
  });

  it('a structured run keeps its schema and codebook files', async () => {
    const docs = mkDocs(1);
    const run = mkRun('g39s', 1, ['d0'], { ...stancePrompt, includeRationale: true });
    const { meta, has, readme } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results: [mkResult(run, docs[0], 1, { stance: 'for' })] }, run);
    expect(meta.prompt.rationale_requested).toBe(true);
    expect(has('prompt/codebook.json') && has('prompt/output_schema.json')).toBe(true);
    expect(readme).toContain('JSON schema the responses had to follow');
  });
});

// Requests a retry sent that Cancel (or a failed save) stopped before their answers were stored (F93 residual).
describe('a retry stopped while requests were under way (F93)', () => {
  it('counts them as sent and says they got no answer', async () => {
    const docs = mkDocs(8);
    const at = '2026-10-02T09:00:00.000Z';
    const run = mkRun('f93', 1, docs.map((d) => d.id), stancePrompt, { retries: [{ at, requests: 6, counted: 'sent', unanswered: 4 }] });
    const results = docs.map((d, i) => (i < 2 ? mkResult(run, d, 1, { stance: 'for' }, { requestedAt: '2026-10-02T09:00:01.000Z', attempt: 2, replacedUsage: usage }) : mkResult(run, d, 1, null)));
    expect(retriedRequests(run, results)).toMatchObject({ requests: 6, unanswered: 4, lowerBound: false });
    const { methods, meta } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(methods).toContain(
      '6 requests without a usable answer (failed, or not sent before the run was stopped) were sent again with identical settings (a retry was stopped while 4 of them were under way: they got no recorded answer); after this, 6 of 8 requests did not return',
    );
    expect(meta.requests.retried).toBe(6);
    expect(meta.requests.retried_note).toContain('4 requests sent by Retry failed were stopped (Cancel, or a result that could not be saved) before their answers were stored');
    expect(meta.tokens.note).toContain('their token use (if any) is not in the token counts');
    const [row] = runSummaryRows([run], results);
    expect(String(row.notes)).toContain('4 requests sent by Retry failed were stopped');
  });

  it('a retry interrupted by the page closing before any answer is still mentioned', async () => {
    const docs = mkDocs(2);
    const run = mkRun('f93b', 1, docs.map((d) => d.id), stancePrompt, { retries: [{ at: '2026-10-02T09:00:00.000Z', requests: 0, counted: 'sent', interrupted: true }] });
    const results = docs.map((d) => mkResult(run, d, 1, null));
    const { methods } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(methods).toContain('Requests without a usable answer (failed, or not sent before the run was stopped) were sent again with identical settings (a retry was interrupted by the page closing');
  });
});

// The published version marked a run left running as interrupted with the time the study was next opened (F88).
describe('a run the published version marked interrupted (F88 residual)', () => {
  it('is exported as finished at its last answer', async () => {
    const study = mkStudy(stancePrompt, 's-f88');
    const docs = mkDocs(2, () => ({}), study.id);
    const run = mkRun('f88', 1, docs.map((d) => d.id), stancePrompt, {
      studyId: study.id, status: 'cancelled', error: 'Interrupted (the page was closed or reloaded while running). Completed results were kept.', finishedAt: '2026-10-23T16:12:19.380Z',
    }, 1, '0.1.0');
    const results = [mkResult(run, docs[0], 1, { stance: 'for' }, { requestedAt: '2026-10-23T16:05:00.000Z', completedAt: '2026-10-23T16:05:02.908Z' })];
    await dbApi.putStudy(study);
    await dbApi.putDocs(docs);
    await dbApi.putRun(run);
    await dbApi.putMany('results', results);
    await selectStudy(study.id);
    const s = getState();
    const shown = s.runs.find((r) => r.id === 'f88')!;
    const { meta } = await supplementary({ study, docs: s.docs, runs: s.runs, results: s.results }, shown);
    expect(meta.requests.last_completed_at).toBe('2026-10-23T16:05:02.908Z');
    expect(meta.run.finished_at).toBe('2026-10-23T16:05:02.908Z');
    expect(runSummaryRows(s.runs, s.results).find((r) => r.run === 1)!.finished_at).toBe('2026-10-23T16:05:02.908Z');
  });
});

// Review of the round-four fixes: cases next to the ones above.
describe('review: published-version retries and stopped requests', () => {
  it('a published-version batch retry collected by today’s version: exact, and the attempts it replaced are kept', async () => {
    const study = mkStudy(stancePrompt, 's-rv1');
    const docs = mkDocs(3, () => ({}), study.id);
    const run = mkRun('rv1', 1, docs.map((d) => d.id), stancePrompt, { studyId: study.id, mode: 'batch', retries: [{ at: '2026-10-16T12:00:00.000Z', requests: 3, asBatch: true }] }, 1, '0.1.0');
    const log = (r: Result): ResultLog => ({ id: r.id, runId: r.runId, studyId: r.studyId, requestPart: {}, response: { id: r.responseId } });
    // The first batch's failed answers (stored by the published version), then the retry batch's, collected today.
    for (const d of docs) {
      const old = mkResult(run, d, 1, null, { requestedAt: '2026-10-16T10:00:00.000Z', responseId: `old-${d.id}` });
      await dbApi.putResult(old, log(old));
    }
    const results: Result[] = [];
    for (const d of docs) {
      const now = mkResult(run, d, 1, { stance: 'for' }, { requestedAt: '2026-10-16T12:00:03.000Z', responseId: `new-${d.id}` });
      await dbApi.putResult(now, log(now));
      results.push(now);
    }
    expect(retriedRequests(run, results)).toMatchObject({ requests: 3, lowerBound: false, tokensIncomplete: false });
    const { methods, meta } = await supplementary({ study, docs, runs: [run], results }, run);
    expect(methods).toContain('3 requests without a usable answer (failed, or not sent before the run was stopped) were sent again with identical settings in a new batch.');
    expect(meta.requests.retried_note).toBeUndefined();
    expect(meta.tokens.note).toBeUndefined();
    expect(meta.requests.replaced_by_retries).toBe(3);
  });

  it('a published-version retry stays counted while today’s Retry failed is replacing its answers', () => {
    const docs = mkDocs(3);
    const run = mkRun('rv2', 1, docs.map((d) => d.id), stancePrompt, {
      status: 'running', resumeStatus: 'completed', resumeError: null,
      retries: [{ at: '2026-10-20T10:00:00.000Z', requests: 3 }, { at: '2026-10-23T10:00:00.000Z', requests: 0, counted: 'sent' }],
    }, 1, '0.1.0');
    const again = (i: number) => ({ requestedAt: `2026-10-23T10:00:0${i}.000Z`, attempt: 2, replacedAt: [`2026-10-20T10:00:0${i}.000Z`] });
    const results = [mkResult(run, docs[0], 1, { stance: 'for' }, again(1)), mkResult(run, docs[1], 1, { stance: 'for' }, again(2)), mkResult(run, docs[2], 1, null, { requestedAt: '2026-10-20T10:00:03.000Z' })];
    expect(retryCounts(run, results).map((c) => [c.requests, c.planned])).toEqual([[3, 3], [2, undefined]]);
  });

  it('requests stopped by Cancel: their texts keep any earlier result', () => {
    const docs = mkDocs(2);
    const after = { requestedAt: '2026-10-02T09:00:01.000Z', attempt: 2, replacedUsage: usage };
    const one = mkRun('rv3', 1, ['d0', 'd1'], stancePrompt, { retries: [{ at: '2026-10-02T09:00:00.000Z', requests: 2, counted: 'sent', unanswered: 1 }] });
    const [row] = runSummaryRows([one], [mkResult(one, docs[0], 1, { stance: 'for' }, after), mkResult(one, docs[1], 1, null)]);
    expect(row.notes).toBe(
      '1 request sent by Retry failed was stopped (Cancel, or a result that could not be saved) before its answer was stored: counted as sent, it left no result (its text keeps any earlier one), and its token use (if any) is not in the token counts.',
    );
    const two = mkRun('rv4', 1, ['d0', 'd1'], stancePrompt, { retries: [{ at: '2026-10-02T09:00:00.000Z', requests: 2, counted: 'sent', unanswered: 2 }] });
    expect(String(runSummaryRows([two], docs.map((d) => mkResult(two, d, 1, null)))[0].notes)).toContain('counted as sent, they left no result (their texts keep any earlier one)');
  });
});

describe('review: comparison report with a first run not finished (G32)', () => {
  const docs = mkDocs(2);
  const status = async (b: Run) => {
    const a = mkRun('a', 1, docs.map((d) => d.id), stancePrompt);
    const results = [...docs.map((d) => mkResult(a, d, 1, { stance: 'for' })), mkResult(b, docs[0], 1, { stance: 'for' })];
    const report = await workbook(await buildComparisonReport(a, b, docs, [a, b], results, 1));
    return [String(report('Runs').find((r) => r.setting === 'status')!.second), report('Notes').map((r) => String(r.note)).filter((n) => n.includes('not finished when'))];
  };

  it('its batch still being processed, or the run still being sent', async () => {
    expect(await status(mkRun('b', 2, docs.map((d) => d.id), stancePrompt, { mode: 'batch', status: 'submitted', finishedAt: null }))).toEqual([
      'not finished: its batch was still being processed',
      ['Run #2 was not finished when this report was made (its batch was still being processed): the figures are those of its results so far and may change once it is done.'],
    ]);
    expect((await status(mkRun('b', 2, docs.map((d) => d.id), stancePrompt, { status: 'running', finishedAt: null })))[0]).toBe('not finished: it was still running');
  });
});
