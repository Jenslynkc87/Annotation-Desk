// Second review round: exports, methods text, README notes and the comparison report.
import 'fake-indexeddb/auto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import * as dbApi from './db';
import { buildComparisonReport, buildExcel, buildResearchRepo, buildSupplementary, requestAsSent, type ExportData } from './export/packages';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type ResultLog, type Run, type Study } from './types';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const textPrompt: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'text', variables: [] };
const stancePrompt: PromptSpec = { ...DEFAULT_PROMPT, includeRationale: false, variables: [{ name: 'stance', type: 'category', values: ['for', 'against'], description: '' }] };
const scalePrompt = (name: string): PromptSpec => ({
  ...DEFAULT_PROMPT,
  includeRationale: false,
  variables: [{ name, type: 'ordinal', values: ['-3', '-2', '-1', '0', '1', '2', '3'], description: '' }],
});

const mkRun = (id: string, number: number, docIds: string[], prompt: PromptSpec, extra: Partial<Run> = {}, replicates = 1): Run => ({
  id, studyId: 's', number, label: '', createdAt: '2026-10-01T10:00:00Z', finishedAt: '2026-10-01T11:00:00Z', mode: 'sync', scope: 'All', docIds, status: 'completed', batch: null, error: null,
  snapshot: {
    appVersion: 'test', model: DEFAULT_MODEL_SETTINGS, options: { ...DEFAULT_RUN_OPTIONS, replicates }, prompt, promptVersion: 1, promptHash: 'h', outputSchema: null,
    requestBase: { model: DEFAULT_MODEL_SETTINGS.model },
  },
  ...extra,
});
const mkDocs = (n: number, meta: (i: number) => Record<string, string> = () => ({})): Doc[] =>
  Array.from({ length: n }, (_, i) => ({ id: `d${i}`, studyId: 's', docId: `art_${i}`, text: 't', meta: { file: `art_${i}.md`, ...meta(i) }, source: 'x', order: i, addedAt: '' }));
const mkResult = (run: Run, doc: Doc, rep: number, values: Record<string, string> | null, extra: Partial<Result> = {}): Result => ({
  id: `${run.id}:${doc.id}:${rep}`, runId: run.id, studyId: 's', docId: doc.id, replicate: rep, status: values ? 'ok' : 'error', values: values ?? {}, rationale: '',
  reasoningSummary: '', rawText: '', parseError: null, error: values ? null : 'overloaded', usage, latencyMs: 1, requestedAt: '2026-10-01T10:00:00Z',
  completedAt: '2026-10-01T10:01:00Z', responseId: `${run.id}:${doc.id}:${rep}`, modelReported: DEFAULT_MODEL_SETTINGS.model, stopReason: values ? 'end_turn' : '', ...extra,
});
const mkStudy = (prompt: PromptSpec): Study => ({ id: 's', name: 'Round two', description: '', createdAt: '', updatedAt: '', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt });

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

describe('methods text: failed requests, texts never sent, prose answers, ties, removed texts', () => {
  it('a cancelled run: failed requests and texts never sent are reported apart (N49, N110)', async () => {
    const docs = mkDocs(100);
    const run = mkRun('r1', 1, docs.map((d) => d.id), stancePrompt, { status: 'cancelled', finishedAt: '2026-10-01T10:30:00Z' });
    // 36 texts were sent before the run was cancelled; one of those requests failed.
    const results = docs.slice(0, 36).map((d, i) => mkResult(run, d, 1, i === 35 ? null : { stance: 'for' }));
    const { methods, meta } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(methods).toContain('1 of 36 requests did not return a usable annotation (an API error, a refusal or an answer that could not be read) and was excluded, leaving 1 text without a label.');
    expect(methods).toContain('64 texts in the run were not sent (the run was cancelled).');
    expect(methods).toContain('Altogether, 65 of the 100 texts in the run have no label.');
    expect(methods).not.toContain('leaving 65');
    expect(meta.corpus).toMatchObject({ n_texts_in_run: 100, n_texts_with_results: 36, n_texts_with_usable_labels: 35, n_texts_all_requests_failed: 1, n_texts_without_results: 64 });
  });

  it('one failed replicate leaves no text without a label, and is "was excluded" (N49)', async () => {
    const docs = mkDocs(4);
    const run = mkRun('r1', 1, docs.map((d) => d.id), stancePrompt, {}, 3);
    const results = docs.flatMap((d, i) => [1, 2, 3].map((rep) => mkResult(run, d, rep, i === 0 && rep === 2 ? null : { stance: 'for' })));
    const { methods } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(methods).toContain('1 of 12 requests did not return a usable annotation (an API error, a refusal or an answer that could not be read) and was excluded.');
    expect(methods).not.toMatch(/leaving|not sent|Altogether/);
  });

  it('texts removed from the study since: the sentence says where their requests still are (N47, N76)', async () => {
    const docs = mkDocs(4);
    const run = mkRun('r1', 1, docs.map((d) => d.id), stancePrompt);
    const results = docs.map((d) => mkResult(run, d, 1, { stance: 'for' }));
    const { methods, readme, read } = await supplementary({ study: mkStudy(stancePrompt), docs: docs.slice(1), runs: [run], results }, run);
    expect(methods).not.toContain('not included in N or the results');
    expect(methods).toContain('1 annotated text was later removed from the study; it is not included in N or the agreement figures (its requests remain in the request and token totals and in the per-request results).');
    expect(readme).toMatch(/results_by_replicate\.csv` \| One row per request, with status, tokens and timing; also the requests for the 1 text removed from the study since, marked “\(deleted …\)” \|/);
    // Paid requests stay on record.
    expect((await read('results_by_replicate.csv')).trim().split('\n')).toHaveLength(5);
  });

  it('plain-text JSON answers with replicates: answers in prose are counted, n_ok stays the ok answers (N116, N38, R4)', async () => {
    const docs = mkDocs(3);
    const run = mkRun('r1', 1, docs.map((d) => d.id), textPrompt, {}, 3);
    const json = (race: number) => ({ response: JSON.stringify({ race, race_explanation: 'because' }) });
    const results = docs.flatMap((d, i) => [1, 2, 3].map((rep) => mkResult(run, d, rep, i === 0 && rep === 3 ? { response: 'I would rather explain this in words.' } : json(rep))));
    const { methods, meta, readme, read } = await supplementary({ study: mkStudy(textPrompt), docs, runs: [run], results }, run);
    expect(meta.requests).toMatchObject({ ok: 9, failed: 0, answers_without_scores: 1 });
    expect(methods).toContain('1 of the 9 answers gave no scores (e.g. it was written in prose) and was left out when the answers were combined.');
    expect(readme).toContain('| Requests (ok / failed) | 9 / 0 (1 ok answer gave no scores and was left out) |');
    const csv = (await read('results/results.csv')).replace(/^﻿/, '').trim().split('\n');
    const head = csv[0].split(',');
    expect(csv[1].split(',')[head.indexOf('n_ok')]).toBe('3');
  });

  it('categorical labels with replicates: a tied vote is kept as "a | b" and counts as a disagreement (N115)', async () => {
    const docs = mkDocs(3);
    const run = mkRun('r1', 1, docs.map((d) => d.id), stancePrompt, {}, 2);
    const votes = [['for', 'against'], ['for', 'for'], ['against', 'against']];
    const results = docs.flatMap((d, i) => votes[i].map((v, j) => mkResult(run, d, j + 1, { stance: v })));
    const { methods, meta } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(methods).toContain('A tied vote is kept as both labels (e.g. “a | b”) and counts as a disagreement in the agreement figures (1 text for stance).');
    expect(meta.corpus.n_texts_with_tied_votes).toEqual({ stance: 1 });
  });

  it('model version reported by the API: only from usable answers (N79)', async () => {
    const docs = mkDocs(2);
    const run = mkRun('r1', 1, docs.map((d) => d.id), stancePrompt);
    // A day-one answer from the refusal fallback's model, now a failed result.
    const results = [mkResult(run, docs[0], 1, { stance: 'for' }), mkResult(run, docs[1], 1, null, { modelReported: 'claude-opus-4-8' })];
    const { methods, meta, readme } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(meta.model.reported_by_api).toEqual([DEFAULT_MODEL_SETTINGS.model]);
    expect(methods).not.toContain('claude-opus-4-8');
    expect(readme).not.toContain('claude-opus-4-8');
    const other = mkRun('r2', 2, docs.map((d) => d.id), stancePrompt);
    const both = [...results, ...docs.map((d) => mkResult(other, d, 1, { stance: 'for' }))];
    const runs = await workbook(await buildComparisonReport(run, other, docs, [run, other], both, 1));
    expect(runs('Runs').find((r) => r.setting === 'model_reported_by_api')!.first).toBe(DEFAULT_MODEL_SETTINGS.model);
  });

  it('a run that is not finished says so in the README, metadata and methods text (N120)', async () => {
    const docs = mkDocs(30);
    const run = mkRun('r1', 1, docs.map((d) => d.id), stancePrompt, { status: 'running', finishedAt: null });
    const results = docs.slice(0, 4).map((d) => mkResult(run, d, 1, { stance: 'for' }));
    const { methods, meta, readme } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(meta.run.status_when_exported).toBe('running');
    expect(readme).toContain('**This run was not finished when these materials were exported** (it was still running): they describe the results so far.');
    expect(methods).toContain('26 texts in the run had no result yet (the run was not finished when this was exported).');
    const settings = (await workbook(await buildExcel({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run, { text: false, rationale: false })))('Settings');
    expect(settings.find((r) => r.setting === 'Finished')!.value).toBe('not finished when exported (the results so far)');
  });
});

describe('README agreement notes (N117, N118, R5, R25)', () => {
  it('labels left out as not on the scale are shown, and the human–human rows are explained', async () => {
    const docs = mkDocs(12, (i) => ({ race_gold: i === 2 ? 'NA' : String(i % 3), race_coder2: String((i + (i % 4 === 0 ? 1 : 0)) % 3) }));
    const run = mkRun('r1', 1, docs.map((d) => d.id), scalePrompt('race'), { status: 'cancelled' });
    // The last text was never sent.
    const results = docs.slice(0, 11).map((d, i) => mkResult(run, d, 1, { race: String(i % 3) }));
    const { readme } = await supplementary({ study: mkStudy(scalePrompt('race')), docs, runs: [run], results }, run);
    // Model vs race_gold: 12 labelled, one never answered, one NA left out.
    expect(readme).toMatch(/\| race \| model \| race_gold \| 10 \(of 12; 1 not on the scale\) \|/);
    expect(readme).toContain('pairs with a value that doesn’t fit the field: not a number or outside the scale (the codebook’s), e.g. NA, 9 or 99 (“not on the scale”). Their number is n_left_out_not_on_scale in agreement.csv.');
    expect(readme).toContain('on this run’s texts, as the model rows are, also those without a usable model answer');
    expect(readme).toContain('1 text of this run with labels has no result (not sent, or no answer came back): its labels count as labelled and in the human–human rows, but it is not in this package.');
  });
});

describe('comparison report (N111, N112)', () => {
  it('texts a cancelled run never sent are not counted as annotated in both runs', async () => {
    const docs = mkDocs(20);
    const a = mkRun('a', 1, docs.map((d) => d.id), scalePrompt('tone'));
    const b = mkRun('b', 2, docs.map((d) => d.id), scalePrompt('tone'), { status: 'cancelled' });
    // The second run sent 12 texts; one of them failed.
    const results = [
      ...docs.map((d, i) => mkResult(a, d, 1, { tone: String((i % 7) - 3) })),
      ...docs.slice(0, 12).map((d, i) => mkResult(b, d, 1, i === 5 ? null : { tone: String((i % 7) - 3) })),
    ];
    const rows = await workbook(await buildComparisonReport(a, b, docs, [a, b], results, 1));
    expect(rows('Summary')[0]).toMatchObject({ n_compared: 11, n_texts_in_both_runs: 12 });
    const draft = String(rows('Draft text')[0].draft_text);
    expect(draft).toContain('N = 11 of 12 texts annotated in both runs');
    expect(rows('Notes').map((r) => r.note)).toContain(`Run #2 has no result for 8 of its 20 texts (e.g. the run was cancelled, stopped or not finished); they are not compared.`);
  });

  it('Review sheet: a half-point difference is not called "1 point"', async () => {
    const docs = mkDocs(4);
    const a = mkRun('a', 1, docs.map((d) => d.id), scalePrompt('tone'), {}, 2);
    const b = mkRun('b', 2, docs.map((d) => d.id), scalePrompt('tone'));
    // Combined first-run labels: 1.5, 0.5, 1, 2; second run: 3, 1, 2, 2.
    const first = [['1', '2'], ['0', '1'], ['1', '1'], ['2', '2']];
    const second = ['3', '1', '2', '2'];
    const results = [
      ...docs.flatMap((d, i) => first[i].map((v, j) => mkResult(a, d, j + 1, { tone: v }))),
      ...docs.map((d, i) => mkResult(b, d, 1, { tone: second[i] })),
    ];
    const review = (await workbook(await buildComparisonReport(a, b, docs, [a, b], results, 1)))('Review');
    const cat = Object.fromEntries(review.map((r) => [r.file, r.category]));
    expect(cat).toEqual({ 'art_0.md': 'between 1 and 2 points', 'art_1.md': 'less than 1 point', 'art_2.md': '1 point', 'art_3.md': 'agree (non-zero)' });
    // Larger differences first.
    expect(review.map((r) => r.file)).toEqual(['art_0.md', 'art_2.md', 'art_1.md', 'art_3.md']);
  });
});

describe('research zip: runs that share a number (N63)', () => {
  it('each run gets its own folder', async () => {
    const docs = mkDocs(2);
    const a = mkRun('aaaaaaaa-1111', 2, docs.map((d) => d.id), stancePrompt);
    const b = mkRun('bbbbbbbb-2222', 2, docs.map((d) => d.id), stancePrompt);
    const c = mkRun('cccccccc-3333', 3, docs.map((d) => d.id), stancePrompt, { label: 'pilot' });
    const results = [a, b, c].flatMap((r) => docs.map((d) => mkResult(r, d, 1, { stance: 'for' })));
    const { blob } = await buildResearchRepo({ study: mkStudy(stancePrompt), docs, runs: [a, b, c], results }, { includeLogs: false });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const runJson = Object.keys(zip.files).filter((k) => k.endsWith('/run.json')).map((k) => k.split('/').slice(-2, -1)[0]).sort();
    expect(runJson).toEqual(['run-02-aaaaaaaa', 'run-02-bbbbbbbb', 'run-03-pilot']);
    for (const [folder, run] of [['run-02-aaaaaaaa', a], ['run-02-bbbbbbbb', b]] as const) {
      const f = zip.file(Object.keys(zip.files).find((k) => k.endsWith(`runs/${folder}/run.json`))!)!;
      expect(JSON.parse(await f.async('string')).id).toBe(run.id);
    }
    expect(Object.keys(zip.files).some((k) => k.endsWith('results/results_run-03-pilot.xlsx'))).toBe(true);
  });
});

describe('request log: the request as sent (N54, N80)', () => {
  const legacyBase = { model: 'claude-opus-5-5', max_tokens: 100, fallbacks: 'default' };
  const part = { messages: [{ role: 'user', content: 'x' }] };
  const log = (extra: Partial<ResultLog> = {}): ResultLog => ({ id: 'l', runId: 'r', studyId: 's', requestPart: part, response: {}, ...extra });

  it('day-one immediate requests carried the refusal fallback; retries since, batches and logs that say so did not', () => {
    const run = mkRun('r', 1, [], stancePrompt);
    run.snapshot.requestBase = legacyBase;
    expect(requestAsSent(run, log(), 1)).toEqual({ ...legacyBase, ...part });
    const without = { model: 'claude-opus-5-5', max_tokens: 100, ...part };
    expect(requestAsSent(run, log(), 2)).toEqual(without);
    expect(requestAsSent(run, log({ requestPart: { custom_id: 't0', ...part } }), 1)).toEqual({ ...without, custom_id: 't0' });
    expect(requestAsSent(run, { ...log(), omitted: ['fallbacks'] } as ResultLog, 1)).toEqual(without);
    // Runs without it are untouched.
    const plain = mkRun('p', 2, [], stancePrompt);
    expect(requestAsSent(plain, log(), 3)).toEqual({ ...plain.snapshot.requestBase, ...part });
  });

  it('requests.jsonl writes each attempt as it was sent', async () => {
    const docs = mkDocs(2);
    const study = mkStudy(textPrompt);
    const run = mkRun('legacy', 1, docs.map((d) => d.id), textPrompt);
    run.snapshot.requestBase = legacyBase;
    await dbApi.putStudy(study);
    await dbApi.putDocs(docs);
    await dbApi.putRun(run);
    const lg = (r: Result): ResultLog => ({ id: r.id, runId: run.id, studyId: 's', requestPart: { messages: [{ role: 'user', content: r.docId }] }, response: {} });
    const ok = mkResult(run, docs[0], 1, { response: 'fine' });
    const failed = mkResult(run, docs[1], 1, null);
    await dbApi.putResult(ok, lg(ok));
    await dbApi.putResult(failed, lg(failed));
    // "Retry failed" today: the adapter left the fallback out.
    const retried = mkResult(run, docs[1], 1, { response: 'fine' }, { requestedAt: '2026-10-23T10:00:00Z', responseId: 'new' });
    await dbApi.putResult(retried, lg(retried));
    const { read } = await supplementary({ study, docs, runs: [run], results: [ok, retried] }, run, true);
    const lines = (await read('logs/requests.jsonl')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.doc_id, l.attempt, 'fallbacks' in l.request])).toEqual([
      ['art_0', 1, true],
      ['art_1', 1, true],
      ['art_1', 2, false],
    ]);
  });
});

describe('review of the round-two export fixes', () => {
  it('a run interrupted by closing the page is not called cancelled in the methods text', async () => {
    const docs = mkDocs(10);
    const error = 'Interrupted: the run stopped without being saved as finished (the page was closed or reloaded, or the browser’s storage was full). Completed results were kept.';
    const run = mkRun('r1', 1, docs.map((d) => d.id), stancePrompt, { status: 'cancelled', error });
    const results = docs.slice(0, 6).map((d) => mkResult(run, d, 1, { stance: 'for' }));
    const { methods } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(methods).toContain('4 texts in the run were not sent (the run was interrupted).');
    // Cancelled by the owner: still "cancelled".
    const cancelled = { ...run, error: null };
    expect((await supplementary({ study: mkStudy(stancePrompt), docs, runs: [cancelled], results }, cancelled)).methods).toContain('(the run was cancelled)');
  });

  it('README: texts never sent are mentioned only when they have labels; a category label left out is "not a category"', async () => {
    // Labels on the first 6 texts only (a validation sample); the run was cancelled after 8 of 20.
    const docs = mkDocs(20, (i): Record<string, string> => (i < 6 ? { stance_gold: i === 1 ? 'NA' : i % 2 ? 'for' : 'against', stance_coder2: i % 2 ? 'for' : 'against' } : {}));
    const run = mkRun('r1', 1, docs.map((d) => d.id), stancePrompt, { status: 'cancelled' });
    const results = docs.slice(0, 8).map((d, i) => mkResult(run, d, 1, { stance: i % 2 ? 'for' : 'against' }));
    const { readme } = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(readme).not.toMatch(/ha(s|ve) no result/);
    expect(readme).toMatch(/\| stance \| model \| stance_gold \| 5 \(of 6; 1 not a category\) \|/);
    expect(readme).toContain(', or not one of the codebook’s categories (“not a category”).');
    // The same run with labels on a text it never sent: that one is mentioned (model and human–human rows).
    docs[15].meta = { ...docs[15].meta, stance_gold: 'for', stance_coder2: 'for' };
    const again = await supplementary({ study: mkStudy(stancePrompt), docs, runs: [run], results }, run);
    expect(again.readme).toContain('1 text of this run with labels has no result (not sent, or no answer came back): its labels count as labelled and in the human–human rows, but it is not in this package.');
  });
});
