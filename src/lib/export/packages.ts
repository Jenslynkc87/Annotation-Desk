// Builds the downloadable exports: Excel workbook, research repository, supplementary repository.
import JSZip from 'jszip';
import { getLogsForRun } from '../db';
import { fmtStat } from '../metrics';
import { comparableFields, fieldValue } from '../compare';
import { agreement, type Agreement, type CiStat } from '../metrics';
import { buildOutputSchema, effectiveTemplate, flattenJsonResponse, isExplanationKey, normalizeLabel } from '../prompt';
import { buildDocViews } from '../view';
import { thinkingLabel } from '../providers/anthropic';
import type { Doc, Result, Run, Study } from '../types';
import { dateStamp, nowIso, slug } from '../util';
import { buildBackup } from './backup';
import { fillScript, requirementsTxt, SCRIPT_TEMPLATE, scriptValues } from './python';
import {
  agreementForRun,
  agreementRows,
  cachingLabel,
  codebookMarkdown,
  corpusRows,
  dropRedundantId,
  resultsLong,
  resultsWide,
  runSummaryRows,
  toCsv,
  type Row,
} from './tables';

export interface ExportData {
  study: Study;
  docs: Doc[];
  runs: Run[];
  results: Result[];
}

const EXCEL_CELL_MAX = 32000;

function clipRows(rows: Row[]): Row[] {
  // Drop carriage returns (Windows line endings) so Excel doesn't show them as "_x000d_".
  const clean = (v: Row[string]) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null; // NaN would make Excel report a corrupt file
    if (typeof v !== 'string') return v;
    const t = v.replace(/\r\n?/g, '\n');
    return t.length > EXCEL_CELL_MAX ? t.slice(0, EXCEL_CELL_MAX) + ' …[truncated]' : t;
  };
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clean(v)])));
}

type Workbook = import('exceljs').Workbook;

const isProse = (c: string) => c === 'rationale' || c === 'reasoning_summary' || isExplanationKey(c) || c === 'draft_text';

/** One styled sheet: header row, frozen panes, filters, sensible column widths, numbers as numbers. */
function addSheet(wb: Workbook, name: string, rows: Row[], columns?: string[]) {
  const data = clipRows(rows.length ? rows : [{ note: 'No data' }]);
  const cols = rows.length && columns ? columns : [...new Set(data.flatMap((r) => Object.keys(r)))];
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', xSplit: cols[0] === 'doc_id' || cols[0] === 'file' || cols[0] === 'setting' ? 1 : 0, ySplit: 1 }] });
  ws.columns = cols.map((c) => {
    const long = c === 'text' || c === 'response' || c === 'value';
    const prose = isProse(c);
    // Short columns (file name, scores) are as wide as their longest value, up to a cap.
    const widest = data.reduce((m, r) => Math.max(m, String(r[c] ?? '').length), 0);
    return { header: c, key: c, width: long ? 40 : prose ? 70 : Math.min(60, Math.max(9, c.length + 3, widest + 2)) };
  });
  ws.addRows(data.map((r) => cols.map((c) => r[c] ?? null)));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003D73' } };
  head.alignment = { vertical: 'middle' };
  head.height = 28;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  // Wrap short prose columns; leave whole-article text and raw JSON on one line so rows stay compact.
  cols.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    const prose = isProse(c);
    col.alignment = { vertical: 'top', wrapText: prose };
    if (typeof data[0]?.[c] === 'number') col.alignment = { vertical: 'top', horizontal: 'center' };
  });
}

export async function buildExcel(d: ExportData, run: Run, opts: { text: boolean; rationale: boolean }): Promise<Blob> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const add = (name: string, rows: Row[]) => addSheet(wb, name, rows);
  add('Results', dropRedundantId(resultsWide(run, d.docs, d.runs, d.results, opts)));
  add('By replicate', resultsLong(d.study, [run], d.docs, d.results.filter((r) => r.runId === run.id), { rationale: opts.rationale, reasoning: true }));
  const agr = agreementForRun(run, d.docs, d.runs, d.results);
  if (agr.length) add('Agreement', agreementRows(agr, run.number));
  add('Settings', settingsRows(d.study, run));
  add('All runs', runSummaryRows(d.runs, d.results));
  const out = await wb.xlsx.writeBuffer();
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function settingsRows(study: Study, run: Run): Row[] {
  const m = run.snapshot.model;
  const o = run.snapshot.options;
  const p = run.snapshot.prompt;
  return [
    { setting: 'Study', value: study.name },
    ...(study.description.trim() ? [{ setting: 'Study notes (e.g. how samples were drawn)', value: study.description.trim() }] : []),
    { setting: 'Run', value: `#${run.number}${run.label ? ` (${run.label})` : ''}` },
    { setting: 'Started', value: run.createdAt },
    { setting: 'Finished', value: run.finishedAt },
    { setting: 'Provider', value: m.provider },
    { setting: 'Model', value: m.model },
    { setting: 'Effort / reasoning', value: m.effort || 'model default' },
    { setting: 'Thinking', value: m.provider === 'anthropic' ? thinkingLabel(m.model, m.reasoningSummary) : 'n/a (reasoning controlled by effort)' },
    { setting: 'Temperature', value: m.temperature ?? 'model default' },
    { setting: 'Max output tokens', value: m.maxOutputTokens },
    { setting: 'Runs per text', value: o.replicates },
    { setting: 'Prompt caching', value: cachingLabel(run) },
    { setting: 'Mode', value: run.mode === 'batch' ? 'Batch API' : 'immediate requests' },
    { setting: 'Prompt version', value: `v${run.snapshot.promptVersion} (${run.snapshot.promptHash})` },
    { setting: 'Prompt (sent with each text)', value: effectiveTemplate(p.userTemplate) },
    { setting: 'System prompt', value: p.system || '(none)' },
    { setting: 'Output', value: p.outputMode === 'structured' ? JSON.stringify(run.snapshot.outputSchema) : 'plain text' },
    { setting: 'Annotation Desk version', value: run.snapshot.appVersion },
  ];
}

function runFolder(run: Run): string {
  return `run-${String(run.number).padStart(2, '0')}${run.label ? '-' + slug(run.label) : ''}`;
}

async function addRunLogs(zip: JSZip, run: Run, docs: Doc[]) {
  const logs = await getLogsForRun(run.id);
  const docById = new Map(docs.map((d) => [d.id, d.docId]));
  const order = (id: string) => id.split(':');
  logs.sort((a, b) => (order(a.id)[1] + order(a.id)[2]).localeCompare(order(b.id)[1] + order(b.id)[2]));
  zip.file(
    'requests.jsonl',
    jsonlBlob(
      logs.map((l) => {
        const [, docId, rep] = l.id.split(':');
        return { doc_id: docById.get(docId) ?? docId, replicate: Number(rep), request: { ...run.snapshot.requestBase, ...l.requestPart } };
      }),
    ),
  );
  zip.file(
    'responses.jsonl',
    jsonlBlob(
      logs.map((l) => {
        const [, docId, rep] = l.id.split(':');
        return { doc_id: docById.get(docId) ?? docId, replicate: Number(rep), response: l.response };
      }),
    ),
  );
}

/** JSON Lines as a Blob, one line per item: the whole file never has to fit in one string (a full run's logs hold every text). */
function jsonlBlob(items: unknown[]): Blob {
  return new Blob(items.map((x) => JSON.stringify(x) + '\n'), { type: 'application/jsonl' });
}

function promptFiles(zip: JSZip, run: Run) {
  const p = run.snapshot.prompt;
  zip.file('prompt.txt', effectiveTemplate(p.userTemplate));
  if (p.system.trim()) zip.file('system_prompt.txt', p.system);
  zip.file('output_schema.json', JSON.stringify(run.snapshot.outputSchema ?? buildOutputSchema(p), null, 2));
  zip.file('codebook.md', codebookMarkdown(run));
  zip.file('codebook.json', JSON.stringify({ outputMode: p.outputMode, includeRationale: p.includeRationale, variables: p.variables }, null, 2));
}

function scriptFiles(zip: JSZip, study: Study, run: Run, exportedAt: string) {
  zip.file('annotate_template.py', SCRIPT_TEMPLATE);
  zip.file('annotate.py', fillScript(SCRIPT_TEMPLATE, scriptValues(study, run, exportedAt)));
  zip.file('requirements.txt', requirementsTxt(run));
}

export interface ResearchOptions {
  includeLogs: boolean;
}

export async function buildResearchRepo(d: ExportData, opts: ResearchOptions): Promise<{ blob: Blob; name: string }> {
  const exportedAt = nowIso();
  const name = `${slug(d.study.name)}_research_${dateStamp()}`;
  const zip = new JSZip();
  const root = zip.folder(name)!;
  const finished = d.runs.filter((r) => d.results.some((x) => x.runId === r.id));

  root.file('study.json', JSON.stringify({ ...d.study, exportedAt }, null, 2));
  // Without the request/response logs: they are under runs/ already, and each holds the full text again, which
  // would make the zip too large to build in the browser for a full corpus. (Export → Study backup has them.)
  root.file('study-backup.json', await buildBackup(d.study, d.docs, d.runs, d.results, false));
  const corpus = root.folder('corpus')!;
  corpus.file('corpus.csv', toCsv(corpusRows(d.docs, true)));
  corpus.file('corpus.jsonl', jsonlBlob(d.docs.map((x) => ({ doc_id: x.docId, text: x.text, source: x.source, meta: x.meta }))));

  const results = root.folder('results')!;
  results.file('runs.csv', toCsv(runSummaryRows(d.runs, d.results)));
  results.file('results_all_runs_long.csv', toCsv(resultsLong(d.study, d.runs, d.docs, d.results, { rationale: true, reasoning: true })));
  const agr: Row[] = [];

  // One folder per prompt version.
  const prompts = root.folder('prompts')!;
  const seen = new Set<number>();
  for (const run of d.runs) {
    if (seen.has(run.snapshot.promptVersion)) continue;
    seen.add(run.snapshot.promptVersion);
    promptFiles(prompts.folder(`v${run.snapshot.promptVersion}`)!, run);
  }

  const runsDir = root.folder('runs')!;
  for (const run of d.runs) {
    const f = runsDir.folder(runFolder(run))!;
    f.file('run.json', JSON.stringify(run, null, 2));
    const rs = d.results.filter((r) => r.runId === run.id);
    f.file('results_long.csv', toCsv(resultsLong(d.study, [run], d.docs, rs, { rationale: true, reasoning: true })));
    f.file('results_wide.csv', toCsv(resultsWide(run, d.docs, d.runs, d.results, { text: false, rationale: true })));
    if (opts.includeLogs) await addRunLogs(f, run, d.docs);
    agr.push(...agreementRows(agreementForRun(run, d.docs, d.runs, d.results), run.number));
  }
  if (agr.length) results.file('agreement.csv', toCsv(agr));

  const latest = finished[finished.length - 1];
  if (latest) {
    results.file(`results_${runFolder(latest)}.xlsx`, await buildExcel(d, latest, { text: false, rationale: true }));
    scriptFiles(root.folder('scripts')!, d.study, latest, exportedAt);
  }
  root.file('README.md', researchReadme(d, exportedAt, latest, opts));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return { blob, name: `${name}.zip` };
}

export interface SupplementaryOptions {
  includeTexts: boolean;
  includeRationales: boolean;
  includeLogs: boolean;
}

export async function buildSupplementary(d: ExportData, run: Run, opts: SupplementaryOptions): Promise<{ blob: Blob; name: string }> {
  const exportedAt = nowIso();
  const name = `${slug(d.study.name)}_supplementary_${dateStamp()}`;
  const zip = new JSZip();
  const root = zip.folder(name)!;
  const rs = d.results.filter((r) => r.runId === run.id);
  const runDocs = d.docs.filter((x) => rs.some((r) => r.docId === x.id));

  const meta = supplementaryMetadata(d, run, exportedAt);
  root.file('metadata.json', JSON.stringify(meta, null, 2));
  promptFiles(root.folder('prompt')!, run);
  const res = root.folder('results')!;
  res.file('results.csv', toCsv(resultsWide(run, runDocs, d.runs, d.results, { text: opts.includeTexts, rationale: opts.includeRationales })));
  res.file('results_by_replicate.csv', toCsv(resultsLong(d.study, [run], runDocs, rs, { rationale: opts.includeRationales, reasoning: false })));
  const agr = agreementForRun(run, runDocs, d.runs, d.results);
  if (agr.length) res.file('agreement.csv', toCsv(agreementRows(agr, run.number)));
  if (opts.includeTexts) root.folder('data')!.file('corpus.csv', toCsv(corpusRows(runDocs, true)));
  if (opts.includeLogs) await addRunLogs(root.folder('logs')!, run, runDocs);
  scriptFiles(root.folder('scripts')!, d.study, run, exportedAt);
  root.file('README.md', supplementaryReadme(d, run, meta, agr, opts));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return { blob, name: `${name}.zip` };
}

function supplementaryMetadata(d: ExportData, run: Run, exportedAt: string) {
  const rs = d.results.filter((r) => r.runId === run.id);
  const started = rs.map((r) => r.requestedAt).sort();
  const times = rs.map((r) => r.completedAt).sort();
  const sum = (k: keyof Result['usage']) => rs.reduce((s, x) => s + x.usage[k], 0);
  const m = run.snapshot.model;
  const ok = rs.filter((r) => r.status === 'ok');
  return {
    software: { name: 'Annotation Desk', version: run.snapshot.appVersion },
    exported_at: exportedAt,
    study: d.study.name,
    // Notes kept with the study, e.g. how a validation sample was drawn (rule and seed).
    study_notes: d.study.description.trim() || null,
    run: { number: run.number, label: run.label, mode: run.mode === 'batch' ? 'batch API' : 'immediate requests', batch_id: run.batch ? (run.batch.parts ?? [run.batch]).map((p) => p.batchId).join('; ') : null, started_at: run.createdAt, finished_at: run.finishedAt },
    model: {
      provider: m.provider,
      requested: m.model,
      reported_by_api: [...new Set(rs.map((r) => r.modelReported).filter(Boolean))],
      effort: m.effort || 'model default',
      thinking: m.provider === 'anthropic' ? thinkingLabel(m.model, m.reasoningSummary) : null,
      reasoning_summary_requested: m.reasoningSummary,
      temperature: m.temperature ?? 'model default',
      max_output_tokens: m.maxOutputTokens,
    },
    prompt: { version: run.snapshot.promptVersion, sha256_prefix: run.snapshot.promptHash, output_mode: run.snapshot.prompt.outputMode, rationale_requested: run.snapshot.prompt.includeRationale },
    options: { replicates_per_text: run.snapshot.options.replicates, prompt_caching: cachingLabel(run) },
    request_settings: run.snapshot.requestBase,
    corpus: {
      n_texts_in_run: run.docIds.length,
      n_texts_with_results: new Set(rs.map((r) => r.docId)).size,
      n_texts_with_usable_labels: new Set(ok.map((r) => r.docId)).size,
    },
    requests: {
      total: rs.length,
      ok: ok.length,
      failed: rs.filter((r) => r.status === 'error').length,
      parse_errors: rs.filter((r) => r.parseError).length,
      first_requested_at: started[0] ?? null,
      last_completed_at: times[times.length - 1] ?? null,
    },
    tokens: {
      input: sum('inputTokens'),
      output: sum('outputTokens'),
      reasoning: sum('reasoningTokens'),
      cache_read: sum('cacheReadTokens'),
      cache_write: sum('cacheWriteTokens'),
    },
  };
}

function methodsParagraph(run: Run, meta: ReturnType<typeof supplementaryMetadata>): string {
  const m = run.snapshot.model;
  const { total, failed } = meta.requests;
  const retried = (run.retries ?? []).reduce((s, x) => s + x.requests, 0);
  const retriedAs = run.mode !== 'batch' ? '' : (run.retries ?? []).every((x) => x.asBatch) ? ' in a new batch' : (run.retries ?? []).every((x) => !x.asBatch) ? ' as individual requests' : '';
  const cached = meta.tokens.cache_read + meta.tokens.cache_write > 0;
  const reps = run.snapshot.options.replicates;
  const dates = [meta.requests.first_requested_at, meta.requests.last_completed_at].filter(Boolean).map((x) => x!.slice(0, 10));
  const period = dates.length ? (dates[0] === dates[1] ? `on ${dates[0]}` : `between ${dates[0]} and ${dates[1]}`) : '';
  const effortName = m.provider === 'anthropic' ? 'effort' : 'reasoning effort';
  const settings = [
    m.effort ? `${effortName} "${m.effort}"` : `the provider's default ${effortName} (not set explicitly)`,
    m.temperature !== null ? `temperature ${m.temperature}` : null,
    `a maximum of ${m.maxOutputTokens.toLocaleString('en-US')} output tokens`,
  ].filter((x): x is string => !!x);
  const settingsText = settings.length > 1 ? `${settings.slice(0, -1).join(', ')} and ${settings[settings.length - 1]}` : settings[0];
  return [
    `Texts (N = ${meta.corpus.n_texts_with_usable_labels.toLocaleString('en-US')}) were annotated with ${m.model} (${m.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API${meta.model.reported_by_api.length ? `; model version reported by the API: ${meta.model.reported_by_api.join(', ')}` : ''}) ${period}, using ${settingsText}.`,
    run.snapshot.prompt.outputMode === 'structured'
      ? `The model was required to return the fields listed in the codebook as JSON conforming to a schema (structured outputs)${run.snapshot.prompt.includeRationale ? ', preceded by a brief rationale' : ''}.`
      : 'The model returned free-text responses.',
    reps > 1
      ? run.snapshot.prompt.outputMode === 'structured'
        ? `Each text was annotated ${reps} times; categorical labels were aggregated by majority vote, ordinal labels by the median and numeric labels by the mean.`
        : `Each text was annotated ${reps} times; numbers in the answers were combined by the median, other values by majority vote.`
      : '',
    failed
      ? `${failed.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} requests did not return a usable annotation (an API error, a refusal or an answer that could not be read) and were excluded${meta.corpus.n_texts_in_run > meta.corpus.n_texts_with_usable_labels ? `, leaving ${(meta.corpus.n_texts_in_run - meta.corpus.n_texts_with_usable_labels).toLocaleString('en-US')} of ${meta.corpus.n_texts_in_run.toLocaleString('en-US')} texts without a label` : ''}.`
      : '',
    retried
      ? `${retried.toLocaleString('en-US')} request${retried === 1 ? '' : 's'} without a usable answer ${retried === 1 ? 'was' : 'were'} re-sent with identical settings${retriedAs}.`
      : '',
    `Requests were sent ${run.mode === 'batch' ? 'through the provider\'s batch API' : 'individually'}${cached ? ' with prompt caching' : ''}. The full prompt, request settings and an executable script are provided in the supplementary material.`,
  ]
    .filter(Boolean)
    .join(' ');
}

function supplementaryReadme(d: ExportData, run: Run, meta: ReturnType<typeof supplementaryMetadata>, agr: ReturnType<typeof agreementForRun>, opts: SupplementaryOptions): string {
  const lines = [
    `# ${d.study.name}: LLM annotation materials`,
    '',
    `Supplementary materials for the LLM-based annotation (run #${run.number}${run.label ? `, "${run.label}"` : ''}), exported from Annotation Desk ${run.snapshot.appVersion} on ${meta.exported_at.slice(0, 10)}.`,
    '',
    '## Summary',
    '',
    '| | |',
    '|---|---|',
    `| Provider / model | ${meta.model.provider} / \`${meta.model.requested}\` |`,
    `| Model reported by API | ${meta.model.reported_by_api.map((x) => `\`${x}\``).join(', ') || '—'} |`,
    `| Effort / reasoning | ${meta.model.effort} |`,
    `| Temperature | ${meta.model.temperature} |`,
    `| Max output tokens | ${meta.model.max_output_tokens} |`,
    `| Texts with a usable annotation | ${meta.corpus.n_texts_with_usable_labels} of ${meta.corpus.n_texts_in_run} |`,
    `| Annotations per text | ${meta.options.replicates_per_text} |`,
    `| Requests (ok / failed) | ${meta.requests.ok} / ${meta.requests.failed} |`,
    `| Annotation period | ${meta.requests.first_requested_at ?? '—'} to ${meta.requests.last_completed_at ?? '—'} |`,
    `| Prompt version / hash | v${meta.prompt.version} / \`${meta.prompt.sha256_prefix}\` |`,
    '',
  ];
  if (agr.length) {
    const ci = (x: [number, number] | null | undefined, pct = false) =>
      x ? ` [${pct ? (x[0] * 100).toFixed(1) : x[0].toFixed(2)}, ${pct ? (x[1] * 100).toFixed(1) : x[1].toFixed(2)}]` : '';
    lines.push(
      '## Agreement with human labels',
      '',
      '| Field | Annotations | Compared with | N compared (of labelled) | % agreement | Cohen\'s κ | Krippendorff\'s α | Gwet\'s AC1 |',
      '|---|---|---|---|---|---|---|---|',
    );
    for (const a of agr) {
      const s = a.stats;
      lines.push(
        `| ${a.field} | ${a.source === 'model' ? 'model' : a.source} | ${a.compared_with} | ${s.n} (of ${a.nLabelled}) | ${s.percentAgreement === null ? '—' : (s.percentAgreement * 100).toFixed(1) + '%' + ci(s.ci.percentAgreement, true)} | ${fmtStat(s.cohenKappa)}${ci(s.ci.cohenKappa)} | ${fmtStat(s.krippendorffAlpha)}${ci(s.ci.krippendorffAlpha)} (${s.level}) | ${fmtStat(s.gwetAC1)}${ci(s.ci.gwetAC1)} |`,
      );
    }
    lines.push(
      '',
      'Brackets: 95% bootstrap intervals (2,000 resamples of texts). "Of labelled": texts with a human label; those without a usable model answer are not compared. Rows with a column name under Annotations compare two human label columns (human–human baseline).',
      '',
    );
  }
  lines.push(
    '## Methods text (draft)',
    '',
    '> ' + methodsParagraph(run, meta),
    '',
    'Edit as needed; check every detail against `metadata.json`.',
    '',
    '## Files',
    '',
    '| File | Contents |',
    '|---|---|',
    '| `metadata.json` | Machine-readable record of model, settings, dates, counts and token use |',
    '| `prompt/prompt.txt` | The prompt sent with each text; `{{text}}` marks where the text was inserted |',
    ...(run.snapshot.prompt.system.trim() ? ['| `prompt/system_prompt.txt` | System prompt sent with every request |'] : []),
    '| `prompt/output_schema.json` | JSON schema the responses had to follow |',
    '| `prompt/codebook.md`, `codebook.json` | Annotation fields, types and allowed values |',
    `| \`results/results.csv\` | One row per text${opts.includeTexts ? ' (with text)' : ''}: metadata and annotations${run.snapshot.options.replicates > 1 ? ' (aggregated across replicates)' : ''} |`,
    '| `results/results_by_replicate.csv` | One row per request, with status, tokens and timing |',
  );
  if (agr.length) lines.push('| `results/agreement.csv` | Agreement statistics |');
  if (opts.includeTexts) lines.push('| `data/corpus.csv` | The annotated texts and their metadata |');
  if (opts.includeLogs) lines.push('| `logs/requests.jsonl`, `responses.jsonl` | Every request body and full API response |');
  lines.push(
    '| `scripts/annotate.py` | Python script reproducing the requests (values inserted) |',
    '| `scripts/annotate_template.py` | The same script with `{{PLACEHOLDERS}}` marking every study-specific value |',
    '| `scripts/requirements.txt` | Python package the script needs (install with `pip install -r requirements.txt`) |',
    '',
    '## Reproducing',
    '',
    '```bash',
    'cd scripts',
    'pip install -r requirements.txt',
    `export ${run.snapshot.model.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'}=...`,
    `python annotate.py ${opts.includeTexts ? '../data/corpus.csv' : 'your_corpus.csv'} --id-column doc_id --text-column text`,
    '```',
    '',
    'Hosted models may be updated or retired and generation is not fully deterministic, so a re-run may not reproduce every label exactly.',
    '',
  );
  if (!opts.includeTexts) lines.push('The annotated texts are not included in this package (e.g. for copyright or privacy reasons).', '');
  return lines.join('\n');
}

function researchReadme(d: ExportData, exportedAt: string, latest: Run | undefined, opts: ResearchOptions): string {
  const rows: [string, string][] = [
    ['`study.json`', 'Current study settings (model, prompt, fields, options)'],
    ['`study-backup.json`', 'Backup (settings, texts, runs, results; the request/response logs are under `runs/`), re-importable via Studies → Import study backup'],
    ['`corpus/corpus.csv`, `corpus.jsonl`', 'All texts with metadata'],
    ['`prompts/vN/`', 'Each prompt version: prompt, system prompt (if used), output schema, codebook'],
    ['`runs/run-NN/run.json`', 'Frozen run configuration (model, settings, prompt, exact shared request body)'],
    ['`runs/run-NN/results_long.csv`', 'One row per request: annotations, rationale, reasoning summary, status, tokens, timing'],
    ['`runs/run-NN/results_wide.csv`', 'One row per text: aggregated annotations'],
  ];
  if (opts.includeLogs) rows.push(['`runs/run-NN/requests.jsonl`, `responses.jsonl`', 'Every request body sent and every raw API response']);
  rows.push(
    ['`results/runs.csv`', 'Overview of all runs'],
    ['`results/results_all_runs_long.csv`', 'All responses from all runs in one table'],
    ['`results/agreement.csv`', 'Agreement between model fields and matching metadata columns (only if such columns exist)'],
  );
  if (latest) {
    rows.push([`\`results/results_${runFolder(latest)}.xlsx\``, 'Excel workbook for the latest run']);
    rows.push(['`scripts/`', 'Python script reproducing the latest run (`annotate.py`) and its template with placeholders']);
  }
  return [
    `# ${d.study.name}: research repository`,
    '',
    `Complete record of this annotation study, exported from Annotation Desk ${__APP_VERSION__} on ${exportedAt}.`,
    '',
    `- ${d.docs.length.toLocaleString('en-US')} texts, ${d.runs.length} run(s), ${d.results.length.toLocaleString('en-US')} model responses.`,
    '- API keys are never stored or exported.',
    '',
    '## Layout',
    '',
    '| Path | Contents |',
    '|---|---|',
    ...rows.map(([a, b]) => `| ${a} | ${b} |`),
    '',
    'Token counts: Anthropic reports input tokens excluding cached tokens; OpenAI reports input tokens including cached tokens.',
    '',
  ].join('\n');
}

// ---------- run vs run comparison report ----------

/**
 * Excel report comparing two runs (e.g. two models) on every field both can be compared on: exact and
 * within-tolerance agreement, chance-corrected agreement, systematic difference, confusion tables, settings
 * and draft text for a paper. All intervals are 95% bootstrap intervals over texts.
 */
/** A fixed number in [0, 1) derived from a text (FNV-1a), so random draws are the same every time. */
function stableRandom(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return Math.round(((h >>> 0) / 4294967296) * 1e6) / 1e6;
}

export async function buildComparisonReport(
  runA: Run,
  runB: Run,
  docs: Doc[],
  runs: Run[],
  results: Result[],
  tolerance: number,
  /** Optional metadata column (e.g. era): adds a sheet with the same figures per group. */
  groupBy = '',
): Promise<Blob> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const viewsA = buildDocViews(docs, runs, results, runA.id);
  const viewsB = buildDocViews(docs, runs, results, runB.id);
  const keysB = new Set(comparableFields(runB, viewsB.values()).map((f) => f.key));
  const fields = comparableFields(runA, viewsA.values()).filter((f) => keysB.has(f.key));
  const inA = new Set(runA.docIds);
  const both = docs.filter((d) => inA.has(d.id) && runB.docIds.includes(d.id));
  const name = (r: Run) => `${r.snapshot.model.model} (run #${r.number})`;

  // Per field: the texts with a usable value in both runs.
  const compared = fields.map((f) => {
    const items: { doc: Doc; x: string; y: string }[] = [];
    for (const d of both) {
      const va = viewsA.get(d.id)!;
      const vb = viewsB.get(d.id)!;
      if (va.status === 'none' || vb.status === 'none') continue;
      const x = normalizeLabel(fieldValue(runA, va.values, f.key), f.yesNo);
      const y = normalizeLabel(fieldValue(runB, vb.values, f.key), f.yesNo);
      if (x && y) items.push({ doc: d, x, y });
    }
    const all = agreement(items.map((i) => i.x), items.map((i) => i.y), f.level, f.allowed, tolerance);
    // Shared zeros ("no evaluation" from both runs) inflate agreement: also report texts where at least one run is non-zero.
    const zeroOnScale = all.meanDifference !== null && (f.allowed.includes('0') || items.some((i) => i.x === '0' || i.y === '0'));
    const nz = items.filter((i) => i.x !== '0' || i.y !== '0');
    // Only when some texts got 0 from both runs; otherwise the row would repeat the one above.
    const nonZero = zeroOnScale && nz.length < items.length ? agreement(nz.map((i) => i.x), nz.map((i) => i.y), f.level, f.allowed, tolerance) : null;
    return { f, items, all, nonZero };
  });

  const r4 = (x: number | null | undefined) => (x === null || x === undefined ? null : Math.round(x * 10000) / 10000);
  const withCi = (label: string, s: Agreement, key: CiStat, value: number | null): Row =>
    value === null ? {} : { [label]: r4(value), [`${label}_ci_low`]: r4(s.ci[key]?.[0]), [`${label}_ci_high`]: r4(s.ci[key]?.[1]) };
  const tolName = `within_${tolerance}_point${tolerance === 1 ? '' : 's'}`;
  const summaryRow = (label: string, texts: string, s: Agreement): Row => ({
    field: label,
    texts,
    level: s.level,
    n_compared: s.n,
    n_texts_in_both_runs: both.length,
    ...(s.leftOut.n ? { n_left_out_not_a_number: s.leftOut.n } : {}),
    ...withCi('exact_agreement', s, 'percentAgreement', s.percentAgreement),
    ...(tolerance > 0 ? withCi(tolName, s, 'withinTolerance', s.withinTolerance) : {}),
    ...withCi('differ_2_or_more_points', s, 'largeDifference', s.largeDifference),
    ...withCi('opposite_direction', s, 'oppositeDirection', s.oppositeDirection),
    ...withCi('weighted_kappa_linear', s, 'weightedKappaLinear', s.weightedKappaLinear),
    ...withCi('weighted_kappa_quadratic', s, 'weightedKappa', s.weightedKappa),
    ...withCi('krippendorff_alpha', s, 'krippendorffAlpha', s.krippendorffAlpha),
    ...withCi('cohen_kappa', s, 'cohenKappa', s.cohenKappa),
    ...withCi('gwet_ac2_linear', s, 'gwetAC2Linear', s.gwetAC2Linear),
    ...withCi('gwet_ac1', s, 'gwetAC1', s.gwetAC1),
    ...withCi('mean_difference_second_minus_first', s, 'meanDifference', s.meanDifference),
    ...withCi('mean_absolute_difference', s, 'mae', s.mae),
    ...(s.spearman !== null ? { spearman_rho: r4(s.spearman) } : {}),
  });
  addSheet(
    wb,
    'Summary',
    compared.flatMap(({ f, all, nonZero }) => [
      summaryRow(f.label, 'all', all),
      ...(nonZero ? [summaryRow(f.label, 'at least one non-zero', nonZero)] : []),
    ]),
  );
  addSheet(
    wb,
    'Draft text',
    compared.map(({ f, all, nonZero }) => ({
      field: f.label,
      draft_text: comparisonSentence(f.label, name(runA), name(runB), all, both.length) + (nonZero ? ' ' + nonZeroSentence(nonZero) : ''),
    })),
  );

  // Every compared score, ordered for expert review: opposite directions first, then the largest differences.
  const reasoningOf = (run: Run, values: Record<string, string>, rationale: string, key: string) => {
    const flat = run.snapshot.prompt.outputMode === 'structured' ? values : (flattenJsonResponse(values.response) ?? {});
    const group = key.includes('_') ? key.slice(0, key.lastIndexOf('_')) : '';
    for (const name of ['explanation', 'reasoning']) {
      const v = flat[`${key}_${name}`] ?? (group ? flat[`${group}_${name}`] : undefined) ?? flat[name];
      if (v) return v;
    }
    return rationale ?? '';
  };
  const firstRationale = (views: typeof viewsA, id: string) => views.get(id)?.results.find((r) => r.status === 'ok')?.rationale ?? '';
  const review = compared.flatMap(({ f, items, all }) =>
    items.map(({ doc, x, y }) => {
      const numeric = all.meanDifference !== null;
      const diff = numeric ? Number(y) - Number(x) : null;
      const mid = all.midpoint;
      const opposite = numeric && mid !== null && ((Number(x) < mid && Number(y) > mid) || (Number(x) > mid && Number(y) < mid));
      const category =
        x === y ? (numeric ? (Number(x) === 0 ? 'agree (zero)' : 'agree (non-zero)') : 'agree') : opposite ? 'opposite direction' : diff !== null && Math.abs(diff) >= 2 ? '2+ points' : numeric ? '1 point' : 'differ';
      return {
        file: doc.meta.file ?? doc.docId,
        field: f.label,
        ...(groupBy ? { [groupBy]: doc.meta[groupBy] ?? '' } : {}),
        first: numeric ? Number(x) : x,
        second: numeric ? Number(y) : y,
        difference: diff,
        category,
        first_explanation: reasoningOf(runA, viewsA.get(doc.id)!.values, firstRationale(viewsA, doc.id), f.key),
        second_explanation: reasoningOf(runB, viewsB.get(doc.id)!.values, firstRationale(viewsB, doc.id), f.key),
        // Sort by category, then by this column, to draw a reproducible random selection within a category.
        random: stableRandom(`${doc.meta.file ?? doc.docId}|${f.key}`),
        judgment: '',
        note: '',
      };
    }),
  );
  const rank: Record<string, number> = { 'opposite direction': 0, '2+ points': 1, differ: 1, '1 point': 2, agree: 3, 'agree (non-zero)': 3, 'agree (zero)': 4 };
  review.sort((p, q) => rank[p.category] - rank[q.category] || Math.abs(q.difference ?? 0) - Math.abs(p.difference ?? 0));
  addSheet(wb, 'Review', review);

  if (groupBy) {
    // Exploratory: the same figures per group (e.g. per era); small groups give wide intervals.
    const groups = [...new Set(both.map((d) => d.meta[groupBy] ?? ''))].sort((p, q) => p.localeCompare(q, undefined, { numeric: true }));
    addSheet(
      wb,
      `By ${groupBy}`.replace(/[[\]:*?/\\]/g, '_').slice(0, 31),
      compared.flatMap(({ f, items }) =>
        groups.map((g) => {
          const sub = items.filter((i) => (i.doc.meta[groupBy] ?? '') === g);
          const { field, texts: _t, ...rest } = summaryRow(f.label, '', agreement(sub.map((i) => i.x), sub.map((i) => i.y), f.level, f.allowed, tolerance));
          return { field, [groupBy]: g || '(none)', ...rest, n_texts_in_both_runs: both.filter((d) => (d.meta[groupBy] ?? '') === g).length };
        }),
      ),
    );
  }

  const settings = (r: Run) => ({
    run: `#${r.number}${r.label ? ` (${r.label})` : ''}`,
    provider: r.snapshot.model.provider,
    model: r.snapshot.model.model,
    model_reported_by_api: [...new Set(results.filter((x) => x.runId === r.id).map((x) => x.modelReported).filter(Boolean))].join(', '),
    effort: r.snapshot.model.effort || 'model default',
    max_output_tokens: String(r.snapshot.model.maxOutputTokens),
    prompt_version: `v${r.snapshot.promptVersion} (${r.snapshot.promptHash})`,
    mode: r.mode === 'batch' ? 'batch API' : 'immediate requests',
    started: r.createdAt,
    texts: String(r.docIds.length),
    annotations_per_text: String(r.snapshot.options.replicates),
  });
  const sa = settings(runA);
  const sb = settings(runB);
  addSheet(wb, 'Runs', Object.keys(sa).map((k) => ({ setting: k, first: sa[k as keyof typeof sa], second: sb[k as keyof typeof sb] })));

  // One confusion table per field (rows: first run, columns: second run); skipped for long numeric scales.
  const used = new Set<string>();
  for (const { f, all } of compared) {
    if (all.categories.length < 2 || all.categories.length > 15) continue;
    let sheet = `Table ${f.label}`.replace(/[[\]:*?/\\]/g, '_').slice(0, 31);
    for (let k = 2; used.has(sheet); k++) sheet = `${sheet.slice(0, 28)}_${k}`;
    used.add(sheet);
    const corner = 'first \\ second';
    addSheet(
      wb,
      sheet,
      all.categories.map((r) => ({ [corner]: r, ...Object.fromEntries(all.categories.map((c) => [c, all.confusion[r][c]])) })),
      // Explicit order: JavaScript would put number-like keys ("0", "1", …) before "-3" and the row labels.
      [corner, ...all.categories],
    );
  }

  addSheet(wb, 'Notes', [
    { note: `First: ${name(runA)}. Second: ${name(runB)}. Texts compared: those annotated in both runs with a usable value for the field.` },
    { note: `Exact agreement: share of texts with the same value.${tolerance > 0 ? ` Within ${tolerance} point${tolerance === 1 ? '' : 's'}: share whose scores differ by at most that much.` : ''} Differ by 2 or more points and opposite direction (one below the scale midpoint, the other above): serious disagreements.` },
    { note: '"At least one non-zero" rows repeat the statistics on texts where at least one run gave a score other than 0, because shared zeros inflate agreement.' },
    { note: 'Weighted kappa (linear or quadratic weights over the codebook scale), Gwet\'s AC2 (linear weights) and Krippendorff\'s alpha give partial credit for near misses; Cohen\'s kappa and Gwet\'s AC1 treat values as categories. AC1/AC2 stay stable when one score (e.g. 0) dominates, where kappa can drop sharply.' },
    { note: 'Mean difference = second minus first (positive: the second run scores higher on average). Mean absolute difference: average distance regardless of direction.' },
    { note: 'Brackets / _ci_low and _ci_high: 95% bootstrap intervals (2,000 resamples of texts, fixed seed, so the same data gives the same interval).' },
    { note: 'Review sheet: every compared score, opposite directions first, then the largest differences. To draw at random within a category (e.g. 30 opposite-direction cases), sort by category and then by "random", and take the first rows; the numbers never change, so the draw is reproducible. The judgment and note columns are for your own labels.' },
    ...(groupBy ? [{ note: `"By ${groupBy}" sheet: the same figures per ${groupBy}; exploratory, as small groups give wide intervals.` }] : []),
  ]);
  const out = await wb.xlsx.writeBuffer();
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
const num2 = (x: number | null) => (x === null ? '—' : x.toFixed(2));

/** Draft sentence for a paper describing how well two runs agree on one field. */
export function comparisonSentence(label: string, a: string, b: string, s: Agreement, nBoth: number): string {
  if (!s.n) return `No texts had a usable value for ${label} in both runs.`;
  const ciP = (k: CiStat) => (s.ci[k] ? ` (95% CI ${pct(s.ci[k]![0])}–${pct(s.ci[k]![1])})` : '');
  const ciN = (k: CiStat) => (s.ci[k] ? ` [${num2(s.ci[k]![0])}, ${num2(s.ci[k]![1])}]` : '');
  const n = `N = ${s.n.toLocaleString('en-US')}${s.n < nBoth ? ` of ${nBoth.toLocaleString('en-US')} texts annotated in both runs` : ''}`;
  if (s.meanDifference === null) {
    return `For ${label}, ${a} and ${b} gave the same label for ${pct(s.percentAgreement)} of texts${ciP('percentAgreement')}; Cohen's κ = ${num2(s.cohenKappa)}${ciN('cohenKappa')}, Krippendorff's α = ${num2(s.krippendorffAlpha)}${ciN('krippendorffAlpha')} (${n}).`;
  }
  const within = s.tolerance > 0 && s.withinTolerance !== null ? ` and scores within ${s.tolerance} point${s.tolerance === 1 ? '' : 's'} for ${pct(s.withinTolerance)}${ciP('withinTolerance')}` : '';
  const serious = ` Scores differed by 2 or more points for ${pct(s.largeDifference)} of texts${s.oppositeDirection !== null ? ` and in direction for ${pct(s.oppositeDirection)}` : ''}.`;
  const kappa = s.weightedKappaLinear !== null ? `linear-weighted κ = ${num2(s.weightedKappaLinear)}${ciN('weightedKappaLinear')}, ` : '';
  const first = `For ${label}, ${a} and ${b} gave identical scores for ${pct(s.percentAgreement)} of texts${ciP('percentAgreement')}${within}; ${kappa}linear-weighted Gwet's AC2 = ${num2(s.gwetAC2Linear)}${ciN('gwetAC2Linear')}, Krippendorff's α (${s.level}) = ${num2(s.krippendorffAlpha)}${ciN('krippendorffAlpha')} (${n}).`;
  const d = s.meanDifference;
  const ci = s.ci.meanDifference;
  const shift =
    ci && (ci[0] > 0 || ci[1] < 0)
      ? ` ${b} scored on average ${Math.abs(d).toFixed(2)} points ${d > 0 ? 'higher' : 'lower'} than ${a} (95% CI ${ci[0].toFixed(2)} to ${ci[1].toFixed(2)}).`
      : ` There was no clear systematic difference between the two (mean difference ${d.toFixed(2)}${ci ? `, 95% CI ${ci[0].toFixed(2)} to ${ci[1].toFixed(2)}` : ''}).`;
  return first + serious + shift;
}

/** The same figures on texts where at least one run gave a non-zero score. */
function nonZeroSentence(s: Agreement): string {
  if (!s.n) return 'No text received a non-zero score from either run.';
  return `On the ${s.n.toLocaleString('en-US')} texts where at least one run gave a non-zero score, exact agreement was ${pct(s.percentAgreement)}, linear-weighted κ = ${num2(s.weightedKappaLinear)} and AC2 = ${num2(s.gwetAC2Linear)}.`;
}
