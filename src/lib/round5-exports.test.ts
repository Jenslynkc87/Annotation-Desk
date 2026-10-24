// Fifth verification round: exports at full size, run names, wording (October 24, 2026).
import 'fake-indexeddb/auto';
import JSZip from 'jszip';
import Papa from 'papaparse';
import { describe, expect, it, vi } from 'vitest';
import * as dbApi from './db';
import { buildBackup, importBackup } from './export/backup';
import { buildResearchRepo, buildSupplementary, ZipWriter, type ExportData } from './export/packages';
import { retryNotes, runSummaryRows, toCsv, toCsvBlob, type Row } from './export/tables';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type ResultLog, type Run, type Study } from './types';
import { buildDocViews, retriedRequests, retryCounts, runName } from './view';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const stancePrompt: PromptSpec = { ...DEFAULT_PROMPT, includeRationale: false, variables: [{ name: 'stance', type: 'category', values: ['for', 'against'], description: '' }] };

const mkRun = (id: string, number: number, docIds: string[], extra: Partial<Run> = {}, appVersion = 'test'): Run => ({
  id, studyId: 's5', number, label: '', createdAt: '2026-10-01T10:00:00.000Z', finishedAt: '2026-10-01T11:00:00.000Z', mode: 'sync', scope: 'All', docIds, status: 'completed',
  batch: null, error: null,
  snapshot: {
    appVersion, model: DEFAULT_MODEL_SETTINGS, options: { ...DEFAULT_RUN_OPTIONS, replicates: 1 }, prompt: stancePrompt, promptVersion: 1, promptHash: 'h', outputSchema: null,
    requestBase: { model: DEFAULT_MODEL_SETTINGS.model },
  },
  ...extra,
});
const mkDocs = (n: number, studyId = 's5'): Doc[] =>
  Array.from({ length: n }, (_, i) => ({ id: `d${i}`, studyId, docId: `art_${i}`, text: `Text ${i}, "quoted"\nline two`, meta: { file: `art_${i}.md` }, source: 'x', order: i, addedAt: '' }));
const mkResult = (run: Run, doc: Doc, values: Record<string, string> | null, extra: Partial<Result> = {}): Result => ({
  id: `${run.id}:${doc.id}:1`, runId: run.id, studyId: run.studyId, docId: doc.id, replicate: 1, status: values ? 'ok' : 'error', values: values ?? {}, rationale: '',
  reasoningSummary: '', rawText: values ? JSON.stringify(values) : '', parseError: null, error: values ? null : 'overloaded', usage, latencyMs: 1,
  requestedAt: run.createdAt, completedAt: run.createdAt, responseId: `${run.id}:${doc.id}`, modelReported: DEFAULT_MODEL_SETTINGS.model, stopReason: values ? 'end_turn' : '', ...extra,
});
const mkStudy = (id = 's5'): Study => ({ id, name: 'Round five', description: '', createdAt: '', updatedAt: '', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt: stancePrompt });
const log = (r: Result): ResultLog => ({ id: r.id, runId: r.runId, studyId: r.studyId, requestPart: { messages: [{ role: 'user', content: r.docId }] }, response: { id: r.responseId } });

async function unzip(blob: Blob) {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const names = Object.keys(zip.files);
  const read = (suffix: string) => zip.file(names.find((k) => k.endsWith(suffix))!)!.async('string');
  return { zip, names, read };
}
const csvRows = (s: string) => Papa.parse<Record<string, string>>(s.replace(/^﻿/, ''), { header: true, skipEmptyLines: true }).data;

describe('the zips are written as they are built (H1)', () => {
  it('never reads a log, the corpus or the backup whole: each file is read a piece at a time', async () => {
    const study = mkStudy('s5-h1');
    const docs = mkDocs(4, study.id);
    const run = mkRun('h1run', 1, docs.map((d) => d.id), { studyId: study.id });
    await dbApi.putStudy(study);
    await dbApi.putDocs(docs);
    await dbApi.putRun(run);
    const results = docs.map((d) => mkResult(run, d, { stance: 'for' }));
    for (const r of results) await dbApi.putResult(r, log(r));
    const whole = [vi.spyOn(Blob.prototype, 'arrayBuffer'), vi.spyOn(Blob.prototype, 'text'), vi.spyOn(Blob.prototype, 'bytes')];
    const research = await buildResearchRepo({ study, docs, runs: [run], results }, { includeLogs: true });
    const supp = await buildSupplementary({ study, docs, runs: [run], results }, run, { includeTexts: true, includeRationales: true, includeLogs: true });
    expect(whole.map((s) => s.mock.calls.length)).toEqual([0, 0, 0]);
    whole.forEach((s) => s.mockRestore());
    // Every file is there and reads back: the logs, line by line.
    const { names, read } = await unzip(research.blob);
    expect(names.filter((n) => n.endsWith('/'))).toEqual(
      ['', 'corpus/', 'results/', 'prompts/', 'prompts/v1/', 'runs/', 'runs/run-01/', 'scripts/'].map((x) => `round-five_research_${names[0].split('_research_')[1].slice(0, 8)}/${x}`),
    );
    expect((await read('runs/run-01/requests.jsonl')).trim().split('\n').map((l) => JSON.parse(l).doc_id)).toEqual(docs.map((d) => d.docId));
    expect(csvRows(await read('corpus/corpus.csv')).map((r) => r.text)).toEqual(docs.map((d) => d.text));
    const s = await unzip(supp.blob);
    expect(csvRows(await s.read('results/results.csv')).map((r) => r.text)).toEqual(docs.map((d) => d.text));
    expect((await s.read('logs/responses.jsonl')).trim().split('\n')).toHaveLength(4);
  });

  it('a CSV built a few rows at a time is the same file as one built whole', async () => {
    const rows: Row[] = Array.from({ length: 2500 }, (_, i) => ({
      doc_id: `a${i}`,
      text: i % 3 ? `Line one, "two"\r\nthree ${'x'.repeat(i * 7)}` : ` leading space; ${i}`,
      score: i % 5 ? i - 3 : null,
      note: i % 7 ? '' : '=SUM(A1)',
      ...(i === 10 ? { extra: 'only here' } : {}),
    }));
    // (Bytes: Blob.text() would drop the byte-order mark.)
    const same = async (blob: Blob, s: string) => expect(Buffer.from(await blob.arrayBuffer()).equals(Buffer.from(s, 'utf8'))).toBe(true);
    for (const r of [rows, rows.slice(0, 1), []]) await same(toCsvBlob(r), toCsv(r));
    await same(toCsvBlob(rows, ['score', 'doc_id']), toCsv(rows, ['score', 'doc_id']));
  });

  it('folders come before their files, each once; non-ASCII names are marked UTF-8', async () => {
    const zip = new ZipWriter();
    const root = zip.folder('top');
    await root.folder('a').folder('b').file('x.txt', 'x');
    await root.file('a/c.txt', new Blob(['c']));
    await zip.file('top/ü.txt', '');
    const { zip: z, names } = await unzip(zip.blob());
    expect(names).toEqual(['top/', 'top/a/', 'top/a/b/', 'top/a/b/x.txt', 'top/a/c.txt', 'top/ü.txt']);
    expect(await z.file('top/a/c.txt')!.async('string')).toBe('c');
    expect(await z.file('top/ü.txt')!.async('string')).toBe('');
  });
});

// The batch builds live from October 18 to 20, 2026 dated every batch answer at the run's start and kept no upload
// time on their batches.
describe('a batch Retry failed of the October 18–20 builds (H11)', () => {
  const docs = mkDocs(6);
  const t0 = '2026-10-19T10:00:00.000Z';
  const oct19 = (extra: Partial<Run> = {}) =>
    mkRun('oct19', 1, docs.map((d) => d.id), {
      createdAt: t0,
      mode: 'batch',
      retries: [{ at: '2026-10-19T11:00:00.000Z', requests: 5, asBatch: true }],
      batch: {
        provider: 'anthropic', batchId: 'b1', map: {}, lastStatus: 'ended', lastCheckedAt: null,
        parts: [{ batchId: 'b1', status: 'collected', lastStatus: 'ended' }, { batchId: 'b2', status: 'collected', lastStatus: 'ended' }],
      },
      ...extra,
    }, '0.1.0');

  it('keeps the number it recorded, with the tokens note', async () => {
    const run = oct19();
    const results = docs.map((d) => mkResult(run, d, { stance: 'for' }, { requestedAt: t0, completedAt: t0 }));
    expect(retryCounts(run, results)).toEqual([{ at: '2026-10-19T11:00:00.000Z', asBatch: true, requests: 5, planned: 5, unrecorded: true, undated: true }]);
    const retry = retriedRequests(run, results);
    expect(retry).toMatchObject({ requests: 5, lowerBound: false, tokensIncomplete: true, undated: 1 });
    const [row] = runSummaryRows([run], results);
    expect(row.requests_retried).toBe(5);
    expect(row.notes).toBe(
      'Annotation Desk 0.1.0, used for the run, dated the answers of a batch sent by Retry failed at the run’s start, so the requests that retry sent are taken as the number it recorded (5); it also did not keep the failed attempts that Retry failed replaced: their token use is missing from the token counts (which may be too low), and they are not counted as replaced by retries.',
    );
    expect(retryNotes(run, retry).requests).not.toContain('not known');
    const { blob } = await buildSupplementary({ study: mkStudy(), docs, runs: [run], results }, run, { includeTexts: false, includeRationales: false, includeLogs: false });
    const { read } = await unzip(blob);
    const readme = await read('README.md');
    expect(readme).toContain('5 requests without a usable answer (failed, or not sent before the run was stopped) were sent again with identical settings in a new batch.');
    expect(readme).not.toContain('not known');
    expect(JSON.parse(await read('metadata.json')).requests.retried).toBe(5);
  });

  it('two such retries', () => {
    const run = oct19({ retries: [{ at: '2026-10-19T11:00:00.000Z', requests: 5, asBatch: true }, { at: '2026-10-19T12:00:00.000Z', requests: 2, asBatch: true }] });
    const results = docs.map((d) => mkResult(run, d, { stance: 'for' }, { requestedAt: t0, completedAt: t0 }));
    expect(retryNotes(run, retriedRequests(run, results)).requests).toBe(
      'Annotation Desk 0.1.0, used for the run, dated the answers of a batch sent by Retry failed at the run’s start, so the requests those retries sent are taken as the numbers it recorded (7 in all).',
    );
  });

  it('a batch of the published build (with its upload time) is still counted from its answers', () => {
    const run = oct19();
    run.batch!.parts![1].submittedAt = '2026-10-19T11:00:02.000Z';
    const results = docs.map((d, i) => mkResult(run, d, { stance: 'for' }, { requestedAt: i < 3 ? '2026-10-19T11:00:02.000Z' : t0 }));
    expect(retryCounts(run, results)).toEqual([{ at: '2026-10-19T11:00:00.000Z', asBatch: true, requests: 3, planned: 5, unrecorded: true }]);
  });
});

describe('runs that share a number (H19)', () => {
  // Two tabs of the published version: run 2 started in each; the one with the smaller id started later.
  const study = mkStudy('s5-h19');
  const docs = mkDocs(3, study.id);
  const early = mkRun('ffff0000-1111', 2, docs.map((d) => d.id), { studyId: study.id, createdAt: '2026-10-19T09:00:00.000Z', snapshot: { ...mkRun('x', 1, []).snapshot, model: { ...DEFAULT_MODEL_SETTINGS, model: 'claude-opus-5-5' } } });
  const late = mkRun('0000ffff-2222', 2, docs.map((d) => d.id), { studyId: study.id, createdAt: '2026-10-19T09:30:00.000Z', label: 'second tab', snapshot: { ...mkRun('x', 1, []).snapshot, model: { ...DEFAULT_MODEL_SETTINGS, model: 'claude-sonnet-5-5' } } });
  const first = mkRun('aaaa0000-0000', 1, docs.map((d) => d.id), { studyId: study.id, createdAt: '2026-10-18T09:00:00.000Z' });

  async function research(d: ExportData) {
    const { read, names } = await unzip((await buildResearchRepo(d, { includeLogs: false })).blob);
    const rel = (n: string) => n.slice(n.indexOf('/') + 1);
    return {
      folders: names.filter((n) => /\/runs\/[^/]+\/$/.test(n)).map(rel),
      xlsx: names.filter((n) => n.endsWith('.xlsx')).map(rel),
      runColumn: csvRows(await read('results/runs.csv')).map((r) => r.run),
      script: (await read('scripts/annotate.py')).split('\n').filter((l) => /^(MODEL =|Run: )/.test(l.trim())).map((l) => l.replace(/; exported .*/, '')),
      readme: await read('README.md'),
    };
  }

  it('the latest run is the one started last, and their names stay the same in a copy made from a backup', async () => {
    await dbApi.putStudy(study);
    await dbApi.putDocs(docs);
    // (Stored in id order, as the database gives runs that share a number.)
    for (const r of [late, early, first]) await dbApi.putRun(r);
    for (const run of [first, early, late]) for (const d of docs) await dbApi.putResult(mkResult(run, d, { stance: 'for' }), log(mkResult(run, d, { stance: 'for' })));
    const loaded = await dbApi.loadStudyData(study.id);
    const before = await research({ study, ...loaded });
    expect(before.folders).toEqual(['runs/run-01/', 'runs/run-02-20261019-090000Z/', 'runs/run-02-second-tab-20261019-093000Z/']);
    expect(before.runColumn).toEqual(['1', '2-20261019-090000Z', '2-20261019-093000Z']);
    expect(before.xlsx).toEqual(['results/results_run-02-second-tab-20261019-093000Z.xlsx']);
    expect(before.script.join('\n')).toContain('claude-sonnet-5-5');
    expect(before.readme).toContain('`results/results_run-02-second-tab-20261019-093000Z.xlsx` | Excel workbook for the latest run');
    expect(before.readme).toContain('ends in when it started (UTC;');
    // "Latest result per text": the run started last too.
    expect(buildDocViews(docs, loaded.runs, loaded.results, 'latest').get(docs[0].id)!.run!.id).toBe(late.id);

    // Moved to another browser by Export → Study backup and Studies → Import study backup: new ids, same names.
    const copy = await importBackup(await buildBackup(study, loaded.docs, loaded.runs, true));
    const moved = await dbApi.loadStudyData(copy.id);
    expect(moved.runs.map((r) => r.id)).not.toContain(late.id);
    const after = await research({ study: copy, ...moved });
    expect(after.folders).toEqual(before.folders);
    expect(after.runColumn).toEqual(before.runColumn);
    expect(after.xlsx).toEqual(before.xlsx);
    expect(after.script).toEqual(before.script);
    const twins = moved.runs.filter((r) => r.number === 2);
    expect(twins.map((r) => runName(r, moved.runs)).sort()).toEqual(['2-20261019-090000Z', '2-20261019-093000Z']);
  });

  it('two that started in the same second: to the millisecond (kept by a copy too); in the same millisecond, also the start of the id', () => {
    const a = { ...early, createdAt: '2026-10-19T09:00:00.100Z' };
    const b = { ...late, createdAt: '2026-10-19T09:00:00.900Z' };
    const c = { ...late, id: 'cccc0000-3333', createdAt: '2026-10-19T09:00:05.000Z' };
    expect([a, b, c].map((r) => runName(r, [a, b, c]))).toEqual(['2-20261019-090000.100Z', '2-20261019-090000.900Z', '2-20261019-090005Z']);
    // (The same names for the copies a backup import makes, with new ids.)
    const copies = [a, b, c].map((r, i) => ({ ...r, id: `0${i}new` }));
    expect(copies.map((r) => runName(r, copies))).toEqual(['2-20261019-090000.100Z', '2-20261019-090000.900Z', '2-20261019-090005Z']);
    const d = { ...b, createdAt: a.createdAt };
    expect([runName(a, [a, d]), runName(d, [a, d])]).toEqual(['2-20261019-090000.100Z-ffff0000', '2-20261019-090000.100Z-0000ffff']);
  });
});

describe('logs and Cancel (H20)', () => {
  it('the READMEs say requests stopped before their answer was stored have no line', async () => {
    const docs = mkDocs(3);
    const stopped = mkRun('h20', 1, docs.map((d) => d.id), { retries: [{ at: '2026-10-01T10:30:00.000Z', requests: 2, counted: 'sent', unanswered: 1 }] });
    const plain = mkRun('h20b', 2, docs.map((d) => d.id));
    const results = [stopped, plain].flatMap((run) =>
      docs.map((d, i) => mkResult(run, d, { stance: 'for' }, run === stopped && i === 1 ? { attempt: 2, replacedUsage: usage, replacedAt: [run.createdAt], requestedAt: '2026-10-01T10:30:01.000Z' } : {})),
    );
    const d: ExportData = { study: mkStudy(), docs, runs: [stopped, plain], results };
    const opts = { includeTexts: false, includeRationales: false, includeLogs: true };
    const supp = await unzip((await buildSupplementary(d, stopped, opts)).blob);
    const row = (await supp.read('README.md')).split('\n').find((l) => l.startsWith('| `logs/requests.jsonl`'))!;
    expect(row).toBe(
      '| `logs/requests.jsonl`, `responses.jsonl` | Every request body and full API response stored; requests under way when a run or a Retry failed was stopped (Cancel, a result that could not be saved, or the page closing) may have been sent but have no line; a request that Retry failed sent again has a line for each stored attempt (same doc_id and replicate; attempt 1, 2, …), and the response line of an earlier, replaced attempt also gives its status, error and parse_error |',
    );
    // A run nothing stopped: as before.
    const other = await unzip((await buildSupplementary(d, plain, opts)).blob);
    expect((await other.read('README.md')).split('\n').find((l) => l.startsWith('| `logs/requests.jsonl`'))).toBe('| `logs/requests.jsonl`, `responses.jsonl` | Every request body and full API response |');
    const research = await unzip((await buildResearchRepo(d, { includeLogs: true })).blob);
    expect(await research.read('README.md')).toContain(
      '| `runs/run-NN/requests.jsonl`, `responses.jsonl` | Every request body sent and raw API response stored; requests under way when a run or a Retry failed was stopped (Cancel, a result that could not be saved, or the page closing) may have been sent but have no line; a request that Retry failed sent again has a line for each stored attempt',
    );
    // An immediate run stopped by Cancel, without retries.
    const cancelled = await unzip((await buildSupplementary({ ...d, runs: [{ ...plain, status: 'cancelled' }] }, { ...plain, status: 'cancelled' }, opts)).blob);
    expect(await cancelled.read('README.md')).toContain('Every request body and full API response stored; requests under way when a run');
  });

  const logsRow = async (d: ExportData, run: Run) =>
    (await (await unzip((await buildSupplementary(d, run, { includeTexts: false, includeRationales: false, includeLogs: true })).blob)).read('README.md'))
      .split('\n')
      .find((l) => l.startsWith('| `logs/requests.jsonl`'))!;
  const T1 = '2026-10-01T12:00:00.000Z';

  it('also once a later Retry failed has sent the stopped requests again (the run is “completed” then)', async () => {
    const docs = mkDocs(3);
    // Cancel left t0 failed and t1, t2 under way (no result); Retry failed then answered all three.
    const run = mkRun('h20c', 1, docs.map((d) => d.id), { retries: [{ at: T1, requests: 3, counted: 'sent' }] });
    const results = docs.map((d, i) =>
      mkResult(run, d, { stance: 'for' }, { requestedAt: T1, completedAt: T1, ...(i === 0 ? { attempt: 2, replacedUsage: usage, replacedAt: [run.createdAt] } : {}) }),
    );
    const d: ExportData = { study: mkStudy(), docs, runs: [run], results };
    expect(await logsRow(d, run)).toContain('Every request body and full API response stored; requests under way when a run or a Retry failed was stopped');
    const research = await unzip((await buildResearchRepo(d, { includeLogs: true })).blob);
    expect(await research.read('README.md')).toContain('Every request body sent and raw API response stored; requests under way');
    // A retry that only replaced stored failed answers: nothing was stopped, nothing is missing.
    const whole = docs.map((d, i) => mkResult(run, d, { stance: 'for' }, i === 0 ? { attempt: 2, replacedUsage: usage, replacedAt: [run.createdAt], requestedAt: T1 } : {}));
    expect(await logsRow({ ...d, results: whole }, run)).toBe(
      '| `logs/requests.jsonl`, `responses.jsonl` | Every request body and full API response; a request that Retry failed sent again has a line for each attempt (same doc_id and replicate; attempt 1, 2, …), and the response line of an earlier, replaced attempt also gives its status, error and parse_error |',
    );
  });

  it('a retry of the published version, which overwrote the attempt it replaced', async () => {
    const docs = mkDocs(3);
    const run = mkRun('h20l', 1, docs.map((d) => d.id), { retries: [{ at: T1, requests: 1 }] }, '0.1.0');
    const results = docs.map((d, i) => mkResult(run, d, { stance: 'for' }, i === 1 ? { requestedAt: T1, completedAt: T1 } : {}));
    expect(await logsRow({ study: mkStudy(), docs, runs: [run], results }, run)).toBe(
      '| `logs/requests.jsonl`, `responses.jsonl` | Every request body and full API response stored; a version before October 22, 2026 did not keep the failed attempts its Retry failed replaced: they have no line |',
    );
  });
});

describe('methods text: retry notes in one parenthesis (H28)', () => {
  const docs = mkDocs(8);
  const methodsOf = async (run: Run) => {
    const results = docs.map((d, i) => mkResult(run, d, i < 6 ? { stance: 'for' } : null));
    const { read } = await unzip((await buildSupplementary({ study: mkStudy(), docs, runs: [run], results }, run, { includeTexts: false, includeRationales: false, includeLogs: false })).blob);
    return (await read('README.md')).split('\n').find((l) => l.startsWith('> '))!.slice(2);
  };

  it('an interrupted retry and one stopped by Cancel', async () => {
    const run = mkRun('h28', 1, docs.map((d) => d.id), {
      retries: [
        { at: '2026-10-01T10:30:00.000Z', requests: 6, counted: 'sent', unanswered: 4 },
        { at: '2026-10-01T10:40:00.000Z', requests: 12, counted: 'sent', interrupted: true },
      ],
    });
    const methods = await methodsOf(run);
    expect(methods).toContain(
      'At least 18 requests without a usable answer (failed, or not sent before the run was stopped) were sent again with identical settings (a retry was interrupted by the page closing: requests under way then got no recorded answer and are not counted; another retry was stopped while 4 of them were under way: they got no recorded answer); after this,',
    );
    expect(methods).not.toContain(') (');
  });

  it('two retries stopped by Cancel', async () => {
    const run = mkRun('h28b', 1, docs.map((d) => d.id), {
      retries: [
        { at: '2026-10-01T10:30:00.000Z', requests: 6, counted: 'sent', unanswered: 4 },
        { at: '2026-10-01T10:40:00.000Z', requests: 5, counted: 'sent', unanswered: 3 },
      ],
    });
    expect(await methodsOf(run)).toContain('were sent again with identical settings (2 retries were stopped while 7 of them were under way: they got no recorded answer); after this,');
  });
});
