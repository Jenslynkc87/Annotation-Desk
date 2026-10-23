// Third review round: exports, methods text and backup (verification of October 23, 2026).
import 'fake-indexeddb/auto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import * as dbApi from './db';
import { buildBackup, importBackup } from './export/backup';
import { buildComparisonReport, buildExcel, buildResearchRepo, buildSupplementary, type ExportData } from './export/packages';
import { runSummaryRows } from './export/tables';
import { getState, selectStudy } from './store';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type ResultLog, type Run, type Study } from './types';
import { retriedRequests } from './view';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const stancePrompt: PromptSpec = { ...DEFAULT_PROMPT, includeRationale: false, variables: [{ name: 'stance', type: 'category', values: ['for', 'against'], description: '' }] };

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
const mkStudy = (prompt: PromptSpec, id = 's'): Study => ({ id, name: 'Round three', description: '', createdAt: '', updatedAt: '', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt });

async function supplementary(d: ExportData, run: Run, includeLogs = false) {
  const { blob } = await buildSupplementary(d, run, { includeTexts: false, includeRationales: false, includeLogs });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const read = (suffix: string) => zip.file(Object.keys(zip.files).find((k) => k.endsWith(suffix))!)!.async('string');
  const readme = await read('README.md');
  const methods = readme.split('\n').find((l) => l.startsWith('> '))!.slice(2);
  const meta = JSON.parse(await read('metadata.json'));
  return { zip, read, readme, methods, meta };
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

const csvRows = (csv: string) => {
  const [head, ...rows] = csv.replace(/^﻿/, '').trim().split('\n').map((l) => l.split(','));
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
};

// The published version (build id "0.1.0", no commit) recorded the number a retry planned, even when its early stop
// cut the retry short: study B of the upgrade check (60 recorded, 5 sent, 3 answers stored).
describe('retries of the published version (gap: legacy retry counts)', () => {
  const docs = mkDocs(20);
  const retryAt = '2026-10-23T10:19:00.757Z';
  const legacy = () =>
    mkRun('b1', 1, docs.map((d) => d.id), stancePrompt, { status: 'failed', error: 'Retry stopped after 3 consecutive errors', retries: [{ at: retryAt, requests: 60 }] }, 3, '0.1.0');
  // The retry's 3 answers overwrote the run's own 3 failed ones (that version kept no earlier attempt).
  const legacyResults = (run: Run) => [1, 2, 3].map((rep) => mkResult(run, docs[0], rep, null, { requestedAt: '2026-10-23T10:19:00.767Z', error: 'Empty response (stop reason: refusal)' }));

  it('reports the requests counted from the stored answers, as a lower bound, and says why', async () => {
    const run = legacy();
    const results = legacyResults(run);
    const { methods, meta, readme } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(methods).not.toContain('60 requests');
    expect(methods).toContain(
      'At least 3 requests without a usable answer (failed, or not sent before the run was stopped) were sent again with identical settings (counted from the stored answers: the app version used for the run recorded only the number planned for the retry made with it, 60); after this, 3 of 3 requests did not return a usable annotation',
    );
    expect(meta.requests.retried).toBe(3);
    expect(meta.requests.retried_note).toContain('recorded for Retry failed only the number of requests planned (60)');
    expect(meta.tokens.note).toContain('token counts (which may be too low)');
    expect(readme).toContain('Annotation Desk 0.1.0, used for the run, recorded for Retry failed only the number of requests planned (60), not the number sent: counted from the stored answers, at least 3 were sent; it also did not keep the failed attempts that Retry failed replaced: their token use is missing from the token counts (which may be too low), and they are not counted as replaced by retries.');
    const [row] = runSummaryRows([run], results);
    expect(row.requests_retried).toBe(3);
    expect(String(row.notes)).toContain('counted from the stored answers, at least 3 were sent');
    expect(String(row.notes)).toContain('which may be too low');
  });

  it('after a retry of today’s version: that retry’s count, plus a lower bound for the old one', async () => {
    const run = legacy();
    const at2 = '2026-10-23T10:20:07.268Z';
    run.retries = [...run.retries!, { at: at2, requests: 60, counted: 'sent' }];
    run.status = 'completed';
    run.error = null;
    // Every request answered again; three of them replaced the old retry's answers (attempt 2).
    const results = docs.flatMap((d, i) => [1, 2, 3].map((rep) => mkResult(run, d, rep, { stance: 'for' }, { requestedAt: '2026-10-23T10:20:07.300Z', ...(i === 0 ? { attempt: 2, replacedUsage: usage } : {}) })));
    const { methods, meta } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(methods).toContain('At least 60 requests without a usable answer');
    expect(methods).not.toContain('120 requests');
    expect(meta.requests).toMatchObject({ retried: 60, replaced_by_retries: 3 });
    // (The old retry's own answers were all replaced: its number is not known, only the total's lower bound.)
    expect(meta.requests.retried_note).toBe(
      'Annotation Desk 0.1.0, used for the run, recorded for Retry failed only the number of requests planned (60), not the number sent: counted from the stored answers, the number sent is not known (no answer to them remains); with the run’s other retry, at least 60 in all.',
    );
  });

  it('no stored answer left from the old retry: the number is not known', () => {
    const run = legacy();
    expect(retriedRequests(run, [])).toMatchObject({ requests: 0, lowerBound: true, planned: 60 });
  });

  it('an old retry that sent everything it planned is reported as it is; batch retries and newer builds are taken at their word', async () => {
    const run = legacy();
    run.status = 'completed';
    run.error = null;
    run.retries = [{ at: retryAt, requests: 3 }];
    const results = legacyResults(run).map((r) => ({ ...r, status: 'ok' as const, values: { stance: 'for' }, error: null, stopReason: 'end_turn', rawText: '{}' }));
    const { methods, meta } = await supplementary({ study: mkStudy(stancePrompt), docs: docs.slice(0, 1), runs: [{ ...run, docIds: ['d0'] }], results }, { ...run, docIds: ['d0'] });
    expect(methods).toContain('3 requests without a usable answer (failed, or not sent before the run was stopped) were sent again with identical settings.');
    expect(methods).not.toContain('At least');
    expect(meta.requests.retried_note).toBeUndefined();
    // (Their earlier, failed attempts were overwritten by that version: the tokens may be too low.)
    expect(meta.tokens.note).toBeDefined();
    const batch = mkRun('b2', 2, [], stancePrompt, { mode: 'batch', retries: [{ at: retryAt, requests: 5, asBatch: true }] }, 1, '0.1.0');
    expect(retriedRequests(batch, [])).toMatchObject({ requests: 5, lowerBound: false });
    const newer = mkRun('b3', 3, [], stancePrompt, { retries: [{ at: retryAt, requests: 7 }] }, 1, '0.1.0+b9fd933 (2026-10-23)');
    expect(retriedRequests(newer, [])).toMatchObject({ requests: 7, lowerBound: false, tokensIncomplete: false });
  });
});

describe('methods text: order and gaps (F46, F71, F93)', () => {
  it('the retry comes before the failures that are left after it (F46)', async () => {
    const docs = mkDocs(40);
    const at = '2026-10-02T09:00:00.000Z';
    const run = mkRun('r1', 1, docs.map((d) => d.id), stancePrompt, { retries: [{ at, requests: 30, counted: 'sent' }] });
    const results = docs.map((d, i) => mkResult(run, d, 1, i < 26 ? null : { stance: 'for' }));
    const { methods } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(methods).toContain(
      '30 requests without a usable answer (failed, or not sent before the run was stopped) were sent again with identical settings; after this, 26 of 40 requests did not return a usable annotation',
    );
    expect(methods).not.toContain('then sent');
    expect(methods.indexOf('sent again')).toBeLessThan(methods.indexOf('did not return'));
  });

  it('a cancelled run with replicates: texts with only some of their annotations are reported (F71, F93)', async () => {
    const docs = mkDocs(10);
    const run = mkRun('r1', 1, docs.map((d) => d.id), stancePrompt, { status: 'cancelled' }, 3);
    // 5 texts complete, the 6th with 1 of 3, the rest never sent.
    const results = [...docs.slice(0, 5).flatMap((d) => [1, 2, 3].map((rep) => mkResult(run, d, rep, { stance: 'for' }))), mkResult(run, docs[5], 1, { stance: 'for' })];
    const { methods, meta } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(methods).not.toContain('Each text was annotated 3 times');
    expect(methods).toContain(
      'Each text was to be annotated 3 times, but for 1 text, 2 of its annotations have no answer recorded (not sent, or the run stopped before an answer arrived), so its labels combine fewer answers;',
    );
    expect(methods).toContain('4 texts in the run have no answer recorded (not sent, or the run stopped before an answer arrived; the run was cancelled).');
    expect(meta.corpus.n_texts_partly_annotated).toBe(1);
    expect(meta.requests.without_result_for_partly_annotated_texts).toBe(2);
  });
});

describe('exports during Retry failed (F84, F91)', () => {
  it('tokens and replaced attempts come from the results; the finish time says the retry is still sending', async () => {
    const docs = mkDocs(4);
    const at = '2026-10-02T09:00:00.000Z';
    // The run's own record of replaced attempts is updated only when the retry ends.
    const run = mkRun('r1', 1, docs.map((d) => d.id), stancePrompt, {
      status: 'running', resumeStatus: 'completed', resumeError: null, retries: [{ at, requests: 0, counted: 'sent' }],
    });
    const results = docs.map((d, i) =>
      i < 2 ? mkResult(run, d, 1, { stance: 'for' }, { requestedAt: '2026-10-02T09:00:01.000Z', attempt: 2, replacedUsage: { ...usage, inputTokens: 100 } }) : mkResult(run, d, 1, null),
    );
    const d: ExportData = { study: mkStudy(stancePrompt), docs, runs: [run], results };
    const { meta, readme, methods } = await supplementary(d, run);
    expect(meta.requests.replaced_by_retries).toBe(2);
    expect(meta.tokens.input).toBe(4 * 10 + 2 * 100);
    expect(meta.run.finished_at).toBeNull();
    expect(meta.run.retry_in_progress).toBe(true);
    expect(meta.requests.retried).toBe(2);
    expect(readme).toContain('(Retry failed was still sending requests): they describe the results so far.');
    expect(methods).toContain('2 requests without a usable answer');
    const book = await workbook(await buildExcel(d, run, { text: false, rationale: false }));
    expect(book('Settings').find((r) => r.setting === 'Finished')!.value).toBe('not finished when exported (Retry failed was still sending; the results so far)');
    const all = book('All runs')[0];
    expect(all.finished_at ?? null).toBeNull();
    expect(all).toMatchObject({ requests_replaced_by_retries: 2, input_tokens: 240, requests_retried: 2 });
  });
});

describe('runs that share a number (F85)', () => {
  it('the tables, README and file names tell them apart', async () => {
    const docs = mkDocs(2, (i) => ({ stance_gold: i ? 'for' : 'against' }));
    const a = mkRun('aaaaaaaa-1111', 2, docs.map((d) => d.id), stancePrompt);
    const b = mkRun('bbbbbbbb-2222', 2, docs.map((d) => d.id), stancePrompt);
    const c = mkRun('cccccccc-3333', 3, docs.map((d) => d.id), stancePrompt);
    const results = [a, b, c].flatMap((r) => docs.map((d) => mkResult(r, d, 1, { stance: 'for' })));
    const d: ExportData = { study: mkStudy(stancePrompt), docs, runs: [a, b, c], results };
    const { blob } = await buildResearchRepo(d, { includeLogs: false });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const read = (suffix: string) => zip.file(Object.keys(zip.files).find((k) => k.endsWith(suffix))!)!.async('string');
    expect(csvRows(await read('results/runs.csv')).map((r) => r.run)).toEqual(['2-aaaaaaaa', '2-bbbbbbbb', '3']);
    expect([...new Set(csvRows(await read('results/results_all_runs_long.csv')).map((r) => r.run))]).toEqual(['2-aaaaaaaa', '2-bbbbbbbb', '3']);
    expect([...new Set(csvRows(await read('results/agreement.csv')).map((r) => r.run))]).toEqual(['2-aaaaaaaa', '2-bbbbbbbb', '3']);
    const readme = await read('README.md');
    expect(readme).toContain('Python script reproducing run #3 ');
    expect(readme).toContain('its name in the tables’ `run` column (e.g. 2-aaaaaaaa)');
    // The supplementary package of one of them, and the comparison report.
    const supp = await supplementary(d, b);
    expect(supp.readme).toContain('(run #2-bbbbbbbb)');
    expect([...new Set(csvRows(await supp.read('results_by_replicate.csv')).map((r) => r.run))]).toEqual(['2-bbbbbbbb']);
    const report = await workbook(await buildComparisonReport(a, b, docs, [a, b, c], results, 1));
    expect(report('Runs').find((r) => r.setting === 'run')).toMatchObject({ first: '#2-aaaaaaaa', second: '#2-bbbbbbbb' });
  });
});

describe('comparison report (F86, F87)', () => {
  it('carries the build id and the runs’ app versions; its text counts are those of the Notes', async () => {
    const docs = mkDocs(10);
    const a = mkRun('a', 1, docs.map((d) => d.id), stancePrompt, {}, 1, '0.1.0');
    const b = mkRun('b', 2, docs.map((d) => d.id), stancePrompt, { status: 'cancelled' });
    const results = [...docs.map((d) => mkResult(a, d, 1, { stance: 'for' })), ...docs.slice(0, 6).map((d) => mkResult(b, d, 1, { stance: 'for' }))];
    // Two texts deleted from the study since.
    const report = await workbook(await buildComparisonReport(a, b, docs.slice(2), [a, b], results, 1));
    const runs = Object.fromEntries(report('Runs').map((r) => [r.setting, [r.first, r.second]]));
    expect(runs.app_version).toEqual(['0.1.0', 'test']);
    expect(runs.texts_in_run).toEqual(['8', '8']);
    expect(runs.texts_with_results).toEqual(['8', '4']);
    expect(runs.texts_removed_from_study_since).toEqual(['2', '2']);
    expect(runs.texts).toBeUndefined();
    const notes = report('Notes').map((r) => String(r.note));
    expect(notes[0]).toMatch(/^Exported from Annotation Desk test on \d{4}-\d\d-\d\d; the runs were made with 0\.1\.0 and test\.$/);
    expect(notes).toContain('Run #2 has no result for 4 of its 8 texts (e.g. the run was cancelled, stopped or not finished); they are not compared.');
  });
});

describe('codebook and logs (F89, F90)', () => {
  it('codebook.md gives the column a field named like a table column is exported as', async () => {
    const prompt: PromptSpec = { ...stancePrompt, variables: [{ name: 'status', type: 'category', values: ['open', 'closed'], description: '' }] };
    const docs = mkDocs(1);
    const run = mkRun('r1', 1, ['d0'], prompt);
    const { read } = await supplementary({ study: mkStudy(prompt), docs, runs: [run], results: [mkResult(run, docs[0], 1, { status: 'open' })] }, run);
    expect(await read('prompt/codebook.md')).toContain('| status | answer_status | category | open, closed |');
    expect(Object.keys(csvRows(await read('results_by_replicate.csv'))[0])).toContain('answer_status');
  });

  it('the request and response logs mark a text deleted since, as the CSVs do', async () => {
    const study = mkStudy(stancePrompt, 's-logs');
    const docs = mkDocs(2, () => ({}), study.id);
    const run = mkRun('logs1', 1, docs.map((d) => d.id), stancePrompt, { studyId: study.id });
    const results = docs.map((d) => mkResult(run, d, 1, { stance: 'for' }));
    for (const r of results) await dbApi.putResult({ ...r }, { id: r.id, runId: run.id, studyId: study.id, requestPart: { content: r.docId }, response: {} } as ResultLog);
    // The second text was deleted after the run.
    const { blob } = await buildResearchRepo({ study, docs: docs.slice(0, 1), runs: [run], results }, { includeLogs: true });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const read = (suffix: string) => zip.file(Object.keys(zip.files).find((k) => k.endsWith(suffix))!)!.async('string');
    for (const file of ['requests.jsonl', 'responses.jsonl'])
      expect((await read(file)).trim().split('\n').map((l) => JSON.parse(l).doc_id)).toEqual(['art_0', '(deleted d1)']);
    expect(csvRows(await read('runs/run-01/results_long.csv')).map((r) => r.doc_id)).toEqual(['art_0', '(deleted d1)']);
  });
});

describe('study backup: the records as stored (F81)', () => {
  it('writes what is in the database, not today’s reading of it; importing reads it by today’s rules again', async () => {
    const study = mkStudy(stancePrompt, 's-backup');
    const docs = mkDocs(2, () => ({}), study.id);
    const run = mkRun('bk1', 1, docs.map((d) => d.id), stancePrompt, { studyId: study.id }, 1, '0.1.0');
    // A day-one answer of the refusal fallback (stored as usable), and a cut-off answer stored with a parse error.
    const fallback = { ...mkResult(run, docs[0], 1, { stance: 'for' }), fallback: 'claude-other' } as Result;
    const cutOff = mkResult(run, docs[1], 1, null, { stopReason: 'max_tokens', rawText: '{"stance": "fo', parseError: 'Unexpected end of JSON input', error: null });
    await dbApi.putStudy(study);
    await dbApi.putDocs(docs);
    await dbApi.putRun(run);
    await dbApi.putMany('results', [fallback, cutOff]);
    await selectStudy(study.id);
    const shown = getState().results;
    expect(shown.find((r) => r.docId === 'd0')!.status).toBe('error');
    expect(shown.find((r) => r.docId === 'd1')!.parseError).toBeNull();

    const s = getState();
    const backup = JSON.parse(await (await buildBackup(study, s.docs, s.runs, false)).text());
    const byDoc = new Map<string, Result & { fallback?: string }>(backup.results.map((r: Result) => [r.docId, r]));
    expect(byDoc.get('d0')).toMatchObject({ status: 'ok', fallback: 'claude-other', error: null });
    expect(byDoc.get('d1')).toMatchObject({ parseError: 'Unexpected end of JSON input', error: null });
    // The research zip's copy too.
    const { blob } = await buildResearchRepo({ study, docs: s.docs, runs: s.runs, results: s.results }, { includeLogs: false });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const inZip = JSON.parse(await zip.file(Object.keys(zip.files).find((k) => k.endsWith('study-backup.json'))!)!.async('string'));
    expect(inZip.results.find((r: Result) => r.docId === 'd0')).toMatchObject({ status: 'ok', fallback: 'claude-other' });

    const imported = await importBackup(new Blob([JSON.stringify(backup)]));
    await selectStudy(imported.id);
    const again = getState().results;
    expect(again).toHaveLength(2);
    const d0 = getState().docs.find((d) => d.docId === 'art_0')!.id;
    expect(again.find((r) => r.docId === d0)).toMatchObject({ status: 'error' });
    expect(again.find((r) => r.docId !== d0)).toMatchObject({ parseError: null, status: 'error' });
  });
});

describe('README: labelled texts without a result (F10)', () => {
  it('a missing-value marker such as NA is no label', async () => {
    // A label sheet covering every text, with NA for the texts not coded; the run was cancelled after 4 of 10.
    const docs = mkDocs(10, (i) => ({ stance_gold: i < 3 ? 'for' : 'NA' }));
    const run = mkRun('r1', 1, docs.map((d) => d.id), stancePrompt, { status: 'cancelled' });
    const results = docs.slice(0, 4).map((d) => mkResult(run, d, 1, { stance: 'for' }));
    const { readme } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(readme).not.toMatch(/of this run with labels ha(s|ve) no result/);
    // A real label on a text never sent is still mentioned.
    docs[8].meta.stance_gold = 'against';
    expect((await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run)).readme).toContain('1 text of this run with labels has no result');
  });
});

describe('review of the round-three export fixes', () => {
  it('a retry still under way: the failures are those so far, not those left after it (F46 with F84)', async () => {
    const docs = mkDocs(4);
    const at = '2026-10-02T09:00:00.000Z';
    const running = (requests: number) =>
      mkRun('r1', 1, docs.map((d) => d.id), stancePrompt, { status: 'running', resumeStatus: 'completed', resumeError: null, retries: [{ at, requests, counted: 'sent' }] });
    // One answer of the retry is in; two requests still fail so far.
    let run = running(0);
    let results = docs.map((d, i) => (i === 0 ? mkResult(run, d, 1, { stance: 'for' }, { requestedAt: '2026-10-02T09:00:01.000Z', attempt: 2 }) : i === 3 ? mkResult(run, d, 1, { stance: 'for' }) : mkResult(run, d, 1, null)));
    let { methods, meta } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(methods).toContain('1 request without a usable answer (failed, or not sent before the run was stopped) was sent again with identical settings, and the retry was still under way when this was exported; so far, 2 of 4 requests did not return a usable annotation');
    expect(methods).not.toContain('after this');
    expect(meta.run.retry_in_progress).toBe(true);
    // No answer to the retry yet.
    run = running(0);
    results = docs.map((d, i) => (i === 3 ? mkResult(run, d, 1, { stance: 'for' }) : mkResult(run, d, 1, null)));
    ({ methods } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run));
    expect(methods).toContain('Requests without a usable answer (failed, or not sent before the run was stopped) were being sent again with identical settings when this was exported; so far, 3 of 4 requests');
    expect(methods).not.toContain('0 requests');
  });

  it('a retry batch not back yet: the same, and Excel gives no finish time', async () => {
    const docs = mkDocs(4);
    const run = mkRun('r1', 1, docs.map((d) => d.id), stancePrompt, { mode: 'batch', status: 'submitted', finishedAt: null, retries: [{ at: '2026-10-02T09:00:00.000Z', requests: 2, asBatch: true, counted: 'sent' }] });
    const results = docs.map((d, i) => mkResult(run, d, 1, i < 2 ? null : { stance: 'for' }));
    const d: ExportData = { study: mkStudy(stancePrompt), docs, runs: [run], results };
    const { methods, meta, readme } = await supplementary(d, run);
    expect(methods).toContain('2 requests without a usable answer (failed, or not sent before the run was stopped) were sent again with identical settings in a new batch, and the retry was still under way when this was exported; so far, 2 of 4 requests did not return');
    expect(meta.run).toMatchObject({ finished_at: null, retry_in_progress: true });
    expect(readme).toContain('(its batch was still being processed)');
    const book = await workbook(await buildExcel(d, run, { text: false, rationale: false }));
    expect(book('Settings').find((r) => r.setting === 'Finished')!.value).toBe('not finished when exported (the results so far)');
  });

  it('texts with only some of their annotations, in a run that was not stopped: no claim that it stopped (F71)', async () => {
    const docs = mkDocs(3);
    const run = mkRun('r1', 1, docs.map((d) => d.id), stancePrompt, { mode: 'batch' }, 3);
    // The batch came back without one request's result.
    const results = docs.flatMap((d, i) => [1, 2, 3].filter((rep) => !(i === 2 && rep === 3)).map((rep) => mkResult(run, d, rep, { stance: 'for' })));
    const { methods } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(methods).toContain('Each text was to be annotated 3 times, but for 1 text, 1 of its annotations has no result, so its labels combine fewer answers;');
    expect(methods).not.toContain('the run stopped');
  });

  it('runs that share a number: their own results_long.csv names them as runs.csv does, and their rows are not mixed (F85)', async () => {
    const docs = mkDocs(3);
    const a = mkRun('aaaaaaaa-1111', 2, docs.map((d) => d.id), stancePrompt);
    const b = mkRun('bbbbbbbb-2222', 2, docs.map((d) => d.id), stancePrompt);
    const results = [a, b].flatMap((r) => docs.map((d) => mkResult(r, d, 1, { stance: 'for' })));
    const { blob } = await buildResearchRepo({ study: mkStudy(stancePrompt), docs, runs: [a, b], results }, { includeLogs: false });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const read = (suffix: string) => zip.file(Object.keys(zip.files).find((k) => k.endsWith(suffix))!)!.async('string');
    expect(csvRows(await read('runs/run-02-bbbbbbbb/results_long.csv')).map((r) => r.run)).toEqual(['2-bbbbbbbb', '2-bbbbbbbb', '2-bbbbbbbb']);
    expect(csvRows(await read('results/results_all_runs_long.csv')).map((r) => r.run)).toEqual(['2-aaaaaaaa', '2-aaaaaaaa', '2-aaaaaaaa', '2-bbbbbbbb', '2-bbbbbbbb', '2-bbbbbbbb']);
  });

  it('README: a missing-value marker is no label, so it is not given as an example of a label left out (F10)', async () => {
    const docs = mkDocs(4, (i) => ({ stance_gold: i ? 'for' : 'NA' }));
    const run = mkRun('r1', 1, docs.map((d) => d.id), stancePrompt);
    const results = docs.map((d) => mkResult(run, d, 1, { stance: 'for' }));
    const { readme } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(readme).toMatch(/\| stance \| model \| stance_gold \| 3 \(of 3\) \|/);
    expect(readme).toContain('(a missing-value marker such as NA counts as no value)');
    expect(readme).not.toContain('e.g. NA or 99');
  });
});

// A retry cut short by the page closing records the requests answered; a few more may have gone out unanswered.
describe('an interrupted retry (lead, round three)', () => {
  it('is reported as a lower bound, with the reason', async () => {
    const docs = mkDocs(6);
    const retryAt = '2026-10-23T10:19:00.000Z';
    const run = mkRun('i1', 1, docs.map((d) => d.id), stancePrompt, { retries: [{ at: retryAt, requests: 4, counted: 'sent', interrupted: true }] });
    const results = docs.map((d, i) => mkResult(run, d, 1, { stance: 'for' }, i < 4 ? { requestedAt: '2026-10-23T10:19:01.000Z', attempt: 2, replacedUsage: usage } : {}));
    expect(retriedRequests(run, results)).toMatchObject({ requests: 4, interrupted: true, lowerBound: false });
    const { methods, meta } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(methods).toContain('At least 4 requests without a usable answer');
    expect(methods).toContain('a retry was interrupted by the page closing');
    expect(meta.requests.retried_note).toContain(`up to ${DEFAULT_RUN_OPTIONS.concurrency} more may have been sent`);
    const [row] = runSummaryRows([run], results);
    expect(String(row.notes)).toContain('was interrupted');
  });
});
