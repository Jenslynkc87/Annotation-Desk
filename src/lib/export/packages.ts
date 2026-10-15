// Builds the downloadable exports: Excel workbook, research repository, supplementary repository.
import JSZip from 'jszip';
import { getLogsForRun } from '../db';
import { fmtStat } from '../metrics';
import { buildOutputSchema, effectiveTemplate } from '../prompt';
import { thinkingLabel } from '../providers/anthropic';
import type { Doc, Result, Run, Study } from '../types';
import { dateStamp, nowIso, slug } from '../util';
import { buildBackup } from './backup';
import { fillScript, requirementsTxt, SCRIPT_TEMPLATE, scriptValues } from './python';
import {
  agreementForRun,
  agreementRows,
  codebookMarkdown,
  corpusRows,
  dropRedundantId,
  resultsLong,
  resultsWide,
  runSummaryRows,
  toCsv,
  toJsonl,
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

export async function buildExcel(d: ExportData, run: Run, opts: { text: boolean; rationale: boolean }): Promise<Blob> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const add = (name: string, rows: Row[]) => {
    const data = clipRows(rows.length ? rows : [{ note: 'No data' }]);
    const cols = [...new Set(data.flatMap((r) => Object.keys(r)))];
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', xSplit: cols[0] === 'doc_id' || cols[0] === 'file' || cols[0] === 'setting' ? 1 : 0, ySplit: 1 }] });
    ws.columns = cols.map((c) => {
      const long = c === 'text' || c === 'response' || c === 'value';
      const prose = c === 'rationale' || c === 'reasoning_summary' || c.endsWith('_reasoning');
      return { header: c, key: c, width: long ? 40 : prose ? 70 : Math.min(32, Math.max(9, c.length + 3)) };
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
      const prose = c === 'rationale' || c === 'reasoning_summary' || c.endsWith('_reasoning');
      col.alignment = { vertical: 'top', wrapText: prose };
      if (typeof data[0]?.[c] === 'number') col.alignment = { vertical: 'top', horizontal: 'center' };
    });
  };
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
    { setting: 'Prompt caching', value: o.caching ? 'on' : 'off' },
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
    toJsonl(
      logs.map((l) => {
        const [, docId, rep] = l.id.split(':');
        return { doc_id: docById.get(docId) ?? docId, replicate: Number(rep), request: { ...run.snapshot.requestBase, ...l.requestPart } };
      }),
    ),
  );
  zip.file(
    'responses.jsonl',
    toJsonl(
      logs.map((l) => {
        const [, docId, rep] = l.id.split(':');
        return { doc_id: docById.get(docId) ?? docId, replicate: Number(rep), response: l.response };
      }),
    ),
  );
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
  root.file('study-backup.json', JSON.stringify(await buildBackup(d.study, d.docs, d.runs, d.results, opts.includeLogs)));
  const corpus = root.folder('corpus')!;
  corpus.file('corpus.csv', toCsv(corpusRows(d.docs, true)));
  corpus.file('corpus.jsonl', toJsonl(d.docs.map((x) => ({ doc_id: x.docId, text: x.text, source: x.source, meta: x.meta }))));

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
    results.file(`results_${runFolder(latest)}.xlsx`, await buildExcel(d, latest, { text: true, rationale: true }));
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
  return {
    software: { name: 'Annotation Desk', version: run.snapshot.appVersion },
    exported_at: exportedAt,
    study: d.study.name,
    run: { number: run.number, label: run.label, mode: run.mode === 'batch' ? 'batch API' : 'immediate requests', batch_id: run.batch?.batchId ?? null, started_at: run.createdAt, finished_at: run.finishedAt },
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
    options: { replicates_per_text: run.snapshot.options.replicates, prompt_caching: run.snapshot.options.caching },
    request_settings: run.snapshot.requestBase,
    corpus: { n_texts_in_run: run.docIds.length, n_texts_with_results: new Set(rs.map((r) => r.docId)).size },
    requests: {
      total: rs.length,
      ok: rs.filter((r) => r.status === 'ok').length,
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
    `Texts (N = ${meta.corpus.n_texts_with_results.toLocaleString('en-US')}) were annotated with ${m.model} (${m.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API${meta.model.reported_by_api.length ? `; model version reported by the API: ${meta.model.reported_by_api.join(', ')}` : ''}) ${period}, using ${settingsText}.`,
    run.snapshot.prompt.outputMode === 'structured'
      ? `The model was required to return the fields listed in the codebook as JSON conforming to a schema (structured outputs)${run.snapshot.prompt.includeRationale ? ', preceded by a brief rationale' : ''}.`
      : 'The model returned free-text responses.',
    reps > 1 ? `Each text was annotated ${reps} times; categorical labels were aggregated by majority vote and numeric labels by the mean.` : '',
    `Requests were sent ${run.mode === 'batch' ? 'through the provider\'s batch API' : 'individually'}${run.snapshot.options.caching ? ' with prompt caching enabled' : ''}. The full prompt, request settings and an executable script are provided in the supplementary material.`,
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
    `| Texts annotated | ${meta.corpus.n_texts_with_results} |`,
    `| Annotations per text | ${meta.options.replicates_per_text} |`,
    `| Requests (ok / failed) | ${meta.requests.ok} / ${meta.requests.failed} |`,
    `| Annotation period | ${meta.requests.first_requested_at ?? '—'} to ${meta.requests.last_completed_at ?? '—'} |`,
    `| Prompt version / hash | v${meta.prompt.version} / \`${meta.prompt.sha256_prefix}\` |`,
    '',
  ];
  if (agr.length) {
    lines.push('## Agreement with human labels', '', '| Field | Compared with | N | % agreement | Cohen\'s κ | Krippendorff\'s α | Gwet\'s AC1 |', '|---|---|---|---|---|---|---|');
    for (const a of agr) {
      lines.push(`| ${a.field} | ${a.compared_with} | ${a.stats.n} | ${a.stats.percentAgreement === null ? '—' : (a.stats.percentAgreement * 100).toFixed(1) + '%'} | ${fmtStat(a.stats.cohenKappa)} | ${fmtStat(a.stats.krippendorffAlpha)} (${a.level}) | ${fmtStat(a.stats.gwetAC1)} |`);
    }
    lines.push('');
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
    ['`study-backup.json`', 'Full backup, re-importable via Studies → Import study backup'],
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
