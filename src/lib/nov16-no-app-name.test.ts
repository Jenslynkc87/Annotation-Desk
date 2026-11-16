// No export names the app or the build it was made with (owner's choice, Nov 16, 2026), except the research zip's
// software_versions.json, a private record. Old backups (format "annotation-desk-study") still import.
import 'fake-indexeddb/auto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import * as dbApi from './db';
import { buildBackup, importBackup } from './export/backup';
import { codebookMarkdown } from './export/tables';
import { buildComparisonReport, buildExcel, buildResearchRepo, buildSupplementary } from './export/packages';
import { matchLabels, resultsTable } from './import/labels';
import type { ParsedTable } from './import/parse';
import { openaiAdapter } from './providers/openai';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type Run, type Study } from './types';

const BUILD = '0.1.0+c0ffee1 (2026-11-09)';
(globalThis as Record<string, unknown>).__APP_VERSION__ = BUILD;
const TRACE = /annotation[ _-]?desk|c0ffee1|2026-11-09\)/i;

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const prompt: PromptSpec = {
  ...DEFAULT_PROMPT,
  includeRationale: false,
  variables: [
    { name: 'tone', type: 'ordinal', values: ['-3', '-2', '-1', '0', '1', '2', '3'], description: '' },
    { name: 'tone_explanation', type: 'text', values: [], description: '' },
  ],
};
const study: Study = {
  id: 'nov16', name: 'Traces', description: 'Sample sample = validation (2026-10-24): 2 of 6 texts drawn at random; seed 11 (Annotation Desk sampling method 3).',
  createdAt: '', updatedAt: '', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt,
};
const docs: Doc[] = Array.from({ length: 6 }, (_, i) => ({
  id: `n16d${i}`, studyId: study.id, docId: `art_${i}`, text: `text ${i}`, meta: { file: `art_${i}.md`, tone_gold: String((i % 7) - 3) }, source: 'x', order: i, addedAt: '',
}));
const mkRun = (id: string, number: number, appVersion: string): Run => ({
  id, studyId: study.id, number, label: '', createdAt: '2026-11-10T00:00:00Z', finishedAt: '2026-11-10T00:01:00Z', mode: 'sync', scope: '',
  docIds: docs.map((d) => d.id), status: 'completed', batch: null, error: null,
  snapshot: { appVersion, model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt, promptVersion: 1, promptHash: 'h', outputSchema: null, requestBase: { model: 'm' } },
});
// One run made by this build, one by an earlier build, one by the first published version (a bare number).
const runs = [mkRun('n16a', 1, BUILD), mkRun('n16b', 2, '0.1.0+1234abc (2026-10-30)'), mkRun('n16c', 3, '0.1.0')];
const results: Result[] = runs.flatMap((run) =>
  docs.map((d, i) => ({
    id: `${run.id}:${d.id}:1`, runId: run.id, studyId: study.id, docId: d.id, replicate: 1, status: 'ok' as const,
    values: { tone: String((i % 7) - 3), tone_explanation: 'because' }, rationale: '', reasoningSummary: '', rawText: '', parseError: null, error: null,
    usage, latencyMs: 1, requestedAt: '2026-11-10T00:00:30Z', completedAt: '2026-11-10T00:00:31Z', responseId: 'r', modelReported: 'm', stopReason: 'end_turn',
  })),
);
const TRACE_ALL = new RegExp(`${TRACE.source}|1234abc|2026-10-30\\)`, 'i');

async function stored() {
  await dbApi.putStudy(study);
  await dbApi.putDocs(docs);
  for (const run of runs) await dbApi.putRun(run);
  for (const r of results) await dbApi.putResult(r, { id: r.id, runId: r.runId, studyId: r.studyId, requestPart: { messages: [] }, response: { ok: true } });
}

async function zipTexts(blob: Blob): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const out = new Map<string, string>();
  for (const [name, f] of Object.entries(zip.files)) if (!f.dir) out.set(name, name.endsWith('.xlsx') ? await xlsxText(await f.async('blob')) : await f.async('string'));
  return out;
}
async function xlsxText(blob: Blob): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await blob.arrayBuffer());
  const cells: string[] = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => cells.push(String(c.value)))));
  return cells.join('\n');
}

describe('exports name neither the app nor its build (Nov 16, 2026)', () => {
  it('the supplementary package, with texts and logs, for every run', async () => {
    await stored();
    for (const run of runs) {
      const { blob } = await buildSupplementary({ study, docs, runs, results }, run, { includeTexts: true, includeRationales: true, includeLogs: true });
      const files = await zipTexts(blob);
      expect(files.size).toBeGreaterThan(5);
      for (const [name, text] of files) expect([name, TRACE_ALL.test(text)]).toEqual([name, false]);
      const meta = JSON.parse([...files].find(([n]) => n.endsWith('metadata.json'))![1]);
      expect(meta.software).toBeUndefined();
      // (No study notes in the public package: Nov 16, 2026.)
      expect(meta.study_notes).toBeUndefined();
    }
  });

  it('the research zip: only software_versions.json names them', async () => {
    await stored();
    const { blob } = await buildResearchRepo({ study, docs, runs, results }, { includeLogs: true });
    const files = await zipTexts(blob);
    const versions = [...files].filter(([n]) => n.endsWith('software_versions.json'));
    expect(versions).toHaveLength(1);
    for (const [name, text] of files) if (!name.endsWith('software_versions.json')) expect([name, TRACE_ALL.test(text)]).toEqual([name, false]);
    const record = JSON.parse(versions[0][1]);
    expect(record.exported_with).toBe(BUILD);
    expect(record.runs.map((r: { made_with: string }) => r.made_with)).toEqual([BUILD, '0.1.0+1234abc (2026-10-30)', '0.1.0']);
    // The README lists it, and says to keep it private.
    const readme = [...files].find(([n]) => n.endsWith('README.md'))![1];
    expect(readme).toContain('`software_versions.json`');
    expect(readme).toContain('keep it private');
  });

  it('the Excel workbook and the comparison report', async () => {
    for (const run of runs) expect(TRACE_ALL.test(await xlsxText(await buildExcel({ study, docs, runs, results }, run, { text: true, rationale: true })))).toBe(false);
    expect(TRACE_ALL.test(await xlsxText(await buildComparisonReport(runs[0], runs[1], docs, runs, results, 1)))).toBe(false);
  });

  it('a study backup keeps only a first-version run’s bare number, and imports again; old backups still import', async () => {
    await stored();
    const blob = await buildBackup(study, docs, runs, true);
    const text = await blob.text();
    expect(TRACE_ALL.test(text)).toBe(false);
    const head = JSON.parse(text.split('\n')[0].slice(0, -1) + '}');
    expect(head.format).toBe('annotation-study-backup');
    expect(head.appVersion).toBeUndefined();
    const imported = await importBackup(blob);
    const back = (await dbApi.loadStudyData(imported.id)).runs.sort((a, b) => a.number - b.number);
    expect(back.map((r) => r.snapshot.appVersion)).toEqual(['', '', '0.1.0']);
    // A backup written before: the old format name, with the app's version.
    const old = text.replace('"format":"annotation-study-backup"', '"format":"annotation-desk-study","appVersion":"0.1.0+1234abc (2026-10-30)"');
    const again = await importBackup(new Blob([old]));
    expect((await dbApi.loadStudyData(again.id)).runs).toHaveLength(3);
  });

  it('new OpenAI requests use a cache key that names no app', () => {
    const base = openaiAdapter.buildRequestBase({
      model: { ...DEFAULT_MODEL_SETTINGS, provider: 'openai', model: 'gpt-4.1' }, options: { ...DEFAULT_RUN_OPTIONS, caching: true }, system: '', outputSchema: null, promptHash: 'abc',
    });
    expect(base.prompt_cache_key).toBe('prompt-abc');
  });
});

describe('the public package has no methods text, and no empty rationale column (Nov 16, 2026)', () => {
  const supp = async (run: Run, rs: Result[], includeRationales = true) => {
    const { blob } = await buildSupplementary({ study, docs, runs: [run], results: rs }, run, { includeTexts: true, includeRationales, includeLogs: false });
    const files = await zipTexts(blob);
    const read = (suffix: string) => [...files].find(([n]) => n.endsWith(suffix))![1];
    const header = (suffix: string) => read(suffix).replace(/^﻿/, '').split(/\r?\n/)[0].split(',');
    return { read, header };
  };

  it('no draft methods paragraph in the README', async () => {
    const { read } = await supp(runs[0], results);
    expect(read('README.md')).not.toMatch(/Methods text|Edit as needed|were annotated with/);
  });

  it('no rationale column when the run asked for none, even with “include rationales” ticked', async () => {
    const { header } = await supp(runs[0], results);
    expect(header('results_by_replicate.csv')).not.toContain('rationale');
    expect(header('results.csv')).not.toContain('rationale');
  });

  it('a run that asked for a rationale keeps its column', async () => {
    const asked = { ...runs[0], snapshot: { ...runs[0].snapshot, prompt: { ...prompt, includeRationale: true } } };
    const rs = results.filter((r) => r.runId === asked.id).map((r) => ({ ...r, rationale: 'Short reason.' }));
    const { header, read } = await supp(asked, rs);
    // (With one annotation per text, the answers, rationale too, are in results.csv only.)
    expect(header('results.csv')).toContain('rationale');
    expect(read('results.csv')).toContain('Short reason.');
    expect(header('results_by_replicate.csv')).not.toContain('rationale');
    // Unticked: left out.
    expect((await supp(asked, rs, false)).header('results.csv')).not.toContain('rationale');
  });

  it('the research zip’s table of all runs has the column only when some run asked for one, blank for the others', async () => {
    const asked = { ...runs[1], snapshot: { ...runs[1].snapshot, prompt: { ...prompt, includeRationale: true } } };
    const rs = results.map((r) => (r.runId === asked.id ? { ...r, rationale: 'Why.' } : { ...r, rationale: 'stale' }));
    await stored();
    const without = await zipTexts((await buildResearchRepo({ study, docs, runs, results }, { includeLogs: false })).blob);
    const head = (files: Map<string, string>, suffix: string) => [...files].find(([n]) => n.endsWith(suffix))![1].replace(/^﻿/, '').split('\n')[0];
    expect(head(without, 'results_all_runs_long.csv')).not.toContain('rationale');
    const withOne = await zipTexts((await buildResearchRepo({ study, docs, runs: [runs[0], asked, runs[2]], results: rs }, { includeLogs: false })).blob);
    expect(head(withOne, 'results_all_runs_long.csv')).toContain('rationale');
    const all = [...withOne].find(([n]) => n.endsWith('results_all_runs_long.csv'))![1];
    expect(all).toContain('Why.');
    expect(all).not.toContain('stale');
  });
});

describe('a lean public package (Nov 16, 2026)', () => {
  const docsWithMeta: Doc[] = docs.map((d, i) => ({ ...d, source: `art_${i}.md`, meta: { ...d.meta, seq: String(i), journal: 'AQ' } }));
  const build = async (opts: { includeTexts: boolean; includeLogs: boolean; metaColumns?: string[] }, run: Run = runs[0], rs: Result[] = results.filter((r) => r.runId === run.id)) => {
    await stored();
    const { blob } = await buildSupplementary({ study, docs: docsWithMeta, runs, results: rs }, run, { includeRationales: true, ...opts });
    const files = await zipTexts(blob);
    const read = (suffix: string) => [...files].find(([n]) => n.endsWith(suffix))?.[1];
    const header = (suffix: string) => read(suffix)!.replace(/^﻿/, '').split(/\r?\n/)[0].split(',');
    return { files, read, header, meta: JSON.parse(read('metadata.json')!) };
  };

  it('results_by_replicate.csv: no column with one value for the whole run, none empty throughout; response_id kept', async () => {
    const { header, read } = await build({ includeTexts: false, includeLogs: false });
    // One annotation per text: no replicate column, and the answers are in results.csv only (the README says so).
    expect(header('results_by_replicate.csv')).toEqual(['doc_id', 'status', 'stop_reason', 'input_tokens', 'output_tokens', 'requested_at', 'completed_at', 'response_id']);
    expect(read('README.md')).toContain('(the annotations are in `results.csv`)');
    // Three annotations per text: the answers per request, and the replicate.
    const three = { ...runs[0], snapshot: { ...runs[0].snapshot, options: { ...DEFAULT_RUN_OPTIONS, replicates: 3 } } };
    const rs = docs.flatMap((d) => [1, 2, 3].map((rep) => ({ ...results[0], id: `${three.id}:${d.id}:${rep}`, docId: d.id, replicate: rep })));
    const more = await build({ includeTexts: false, includeLogs: false }, three, rs);
    expect(more.header('results_by_replicate.csv')).toEqual([
      'doc_id', 'replicate', 'status', 'tone', 'tone_explanation', 'stop_reason', 'input_tokens', 'output_tokens', 'requested_at', 'completed_at', 'response_id',
    ]);
    expect(more.read('README.md')).not.toContain('(the annotations are in');
  });

  it('metadata.json names the output schema instead of repeating it; no codebook.md (research zip: no column-name column when it only repeats the field)', async () => {
    const { meta, read, files } = await build({ includeTexts: false, includeLogs: false });
    expect(JSON.stringify(meta)).not.toContain('"properties"');
    expect([...files.keys()].some((n) => n.includes('codebook'))).toBe(false);
    expect(read('README.md')).not.toContain('codebook');
    expect(codebookMarkdown(runs[0]).split('\n').find((l) => l.startsWith('| Field'))).toBe('| Field | Type | Allowed values | Description |');
    // The template script is kept (the owner asked for it); neither script mentions a site.
    expect([...files.keys()].some((n) => n.endsWith('annotate_template.py'))).toBe(true);
    expect(read('README.md')).toContain('annotate_template.py');
    for (const f of ['annotate.py', 'annotate_template.py']) expect(read(f)).not.toMatch(/the site|JavaScript/);
  });

  it('results.csv: no file column repeating doc_id, no n_ok or n_error; the metadata columns chosen', async () => {
    const all = await build({ includeTexts: false, includeLogs: false });
    expect(all.header('results.csv')).toEqual(['doc_id', 'tone', 'tone_explanation', 'tone_gold', 'seq', 'journal']);
    const some = await build({ includeTexts: true, includeLogs: false, metaColumns: ['journal'] });
    expect(some.header('results.csv')).toEqual(['doc_id', 'tone', 'tone_explanation', 'journal', 'text']);
    // data/corpus.csv: the same columns, and no source repeating the file name.
    expect(some.header('corpus.csv')).toEqual(['doc_id', 'text', 'n_characters', 'journal']);
  });

  it('n_ok only when a text has fewer annotations than planned', async () => {
    const three = { ...runs[0], snapshot: { ...runs[0].snapshot, options: { ...DEFAULT_RUN_OPTIONS, replicates: 3 } } };
    const rs = docs.flatMap((d) => [1, 2, 3].map((rep) => ({ ...results[0], id: `${three.id}:${d.id}:${rep}`, docId: d.id, replicate: rep })));
    expect((await build({ includeTexts: false, includeLogs: false }, three, rs)).header('results.csv')).not.toContain('n_ok');
    const fewer = await build({ includeTexts: false, includeLogs: false }, three, rs.slice(1));
    expect(fewer.header('results.csv')).toContain('n_ok');
    expect(fewer.header('results.csv')).not.toContain('n_error');
  });

  it('metadata.json: no notes, label or ids; counters only when not 0', async () => {
    const { meta } = await build({ includeTexts: false, includeLogs: false });
    expect(meta.study_notes).toBeUndefined();
    expect(Object.keys(meta.run).sort()).toEqual(['finished_at', 'mode', 'number', 'started_at']);
    expect(Object.keys(meta.corpus).sort()).toEqual(['n_texts_in_run', 'n_texts_with_results', 'n_texts_with_usable_labels']);
    expect(Object.keys(meta.requests).sort()).toEqual(['failed', 'first_requested_at', 'last_completed_at', 'ok', 'total']);
  });

  it('no codebook.json, no CSV note; with logs but no texts, the README says the logs hold them', async () => {
    const { files, read } = await build({ includeTexts: false, includeLogs: true });
    expect([...files.keys()].some((n) => n.endsWith('codebook.json'))).toBe(false);
    const readme = read('README.md')!;
    expect(readme).not.toContain('codebook.json');
    expect(readme).not.toContain('analysis software');
    expect(readme).toContain('not included as a separate file, but `logs/requests.jsonl` holds every request with its full text');
    expect(readme).not.toContain('are not included in this package');
    expect((await build({ includeTexts: false, includeLogs: false })).read('README.md')).toContain('are not included in this package');
  });
});

describe('the Excel workbook, leaner (Nov 16, 2026)', () => {
  const headers = async (run: Run, rs: Result[], allRuns: Run[] = runs) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await (await buildExcel({ study, docs, runs: allRuns, results: rs }, run, { text: false, rationale: false })).arrayBuffer());
    const out: Record<string, string[]> = {};
    wb.eachSheet((ws) => (out[ws.name] = (ws.getRow(1).values as unknown[]).slice(1).map(String)));
    return out;
  };

  it('By replicate: no run-wide constants (Settings gives them) and no column empty throughout; Results keeps n_ok and n_error', async () => {
    const h = await headers(runs[0], results);
    expect(h['By replicate']).toEqual([
      'model_reported', 'doc_id', 'replicate', 'status', 'tone', 'tone_explanation', 'stop_reason', 'input_tokens', 'output_tokens', 'requested_at', 'completed_at', 'response_id',
    ]);
    expect(h.Results).toEqual(expect.arrayContaining(['n_ok', 'n_error']));
  });

  it('All runs: a column only when some run has a value in it', async () => {
    expect((await headers(runs[0], results))['All runs']).not.toEqual(expect.arrayContaining(['label']));
    const labelled = [{ ...runs[0], label: 'pilot' }, ...runs.slice(1)];
    expect((await headers(labelled[0], results, labelled))['All runs']).toContain('label');
    expect((await headers(runs[0], results))['All runs']).not.toContain('batch_id');
  });
});

describe('a lean results table can’t be added as human labels (Nov 16, 2026)', () => {
  const many: Doc[] = Array.from({ length: 30 }, (_, i) => ({ id: `L${i}`, studyId: 's', docId: `art_${i}`, text: `T${i}`, meta: { era: i % 2 ? 'early' : 'late' }, source: `art_${i}.md`, order: i, addedAt: '' }));
  const p: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'structured', includeRationale: false, variables: [prompt.variables[0]] };
  const run: Run = { ...mkRun('lean', 1, ''), docIds: many.map((d) => d.id), snapshot: { ...mkRun('lean', 1, '').snapshot, prompt: p } };
  const score = (i: number) => String((i % 7) - 3);
  const rs: Result[] = many.map((d, i) => ({ ...results[0], id: `lean:${d.id}`, runId: 'lean', docId: d.id, values: { tone: score(i) } }));
  const sheet = (cols: string[], value: (c: string, i: number) => string): ParsedTable => ({
    name: 'results.csv', columns: ['doc_id', ...cols], rows: many.map((d, i) => ({ doc_id: d.docId, ...Object.fromEntries(cols.map((c) => [c, value(c, i)])) })),
  });
  const judge = (t: ParsedTable) => {
    const m = matchLabels(many, t, 'doc_id');
    return resultsTable(t, [run], rs, m.updates, [p], 'doc_id', m.replaced);
  };
  const meta = (c: string, i: number) => (c === 'era' ? many[i].meta.era : score(i));

  it('the public results.csv of a scores-only run (the run’s answers beside the texts’ own metadata): blocked, as a possible export', () => {
    expect(judge(sheet(['tone', 'era'], meta))).toMatchObject({ columns: ['tone'], copied: ['tone'], sure: false });
  });
  it('a coder’s sheet is still accepted: labels in their own column, or differing from the model’s anywhere', () => {
    expect(judge(sheet(['tone_gold', 'era'], meta)).columns).toEqual([]);
    expect(judge(sheet(['tone', 'era'], (c, i) => (c === 'tone' && i === 4 ? '3' : meta(c, i)))).columns).toEqual([]);
  });
});

describe('the public README says how a text’s annotations are combined (Nov 16, 2026)', () => {
  it('one factual line with several annotations per text, none with one', async () => {
    await stored();
    const readme = async (run: Run, rs: Result[]) => {
      const { blob } = await buildSupplementary({ study, docs, runs: [run], results: rs }, run, { includeTexts: false, includeRationales: false, includeLogs: false });
      const zip = await JSZip.loadAsync(await blob.arrayBuffer());
      return zip.file(Object.keys(zip.files).find((n) => n.endsWith('README.md'))!)!.async('string');
    };
    const three = { ...runs[0], snapshot: { ...runs[0].snapshot, options: { ...DEFAULT_RUN_OPTIONS, replicates: 3 } } };
    const rs = docs.flatMap((d) => [1, 2, 3].map((rep) => ({ ...results[0], id: `${three.id}:${d.id}:${rep}`, docId: d.id, replicate: rep })));
    expect(await readme(three, rs)).toContain(
      'Each text’s 3 annotations are combined in `results.csv` (failed ones left out): scales by the median (with an even number of annotations, the midpoint of the middle two, e.g. 1.5); each explanation is the one from the annotation closest to the combined values.',
    );
    expect(await readme(runs[0], results.filter((r) => r.runId === runs[0].id))).not.toContain('are combined');
  });
});
