// Tabular views used by every export format.
import Papa from 'papaparse';
import { agreement, type Agreement, type Level } from '../metrics';
import { TEXT_RESPONSE_KEY, flattenJsonResponse, isExplanationKey, normalizeLabel, outputFields } from '../prompt';
import { thinkingLabel } from '../providers/anthropic';
import { supportsExplicitCaching } from '../providers/openai';
import type { Doc, Result, Run, Study } from '../types';
import { buildDocViews } from '../view';

export type Row = Record<string, string | number | null>;

export function toCsv(rows: Row[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  // UTF-8 BOM so Excel opens non-ASCII text correctly.
  return '﻿' + Papa.unparse({ fields: cols, data: rows.map((r) => cols.map((c) => r[c] ?? '')) });
}

export function metaColumns(docs: Doc[]): string[] {
  return [...new Set(docs.flatMap((d) => Object.keys(d.meta)))];
}

export function corpusRows(docs: Doc[], includeText: boolean): Row[] {
  const cols = metaColumns(docs);
  // A metadata column with the same name as one of ours (e.g. "source") gets a prefix instead of overwriting it.
  const own = new Set(['doc_id', 'text', 'n_characters', 'source']);
  return docs.map((d) => ({
    doc_id: d.docId,
    ...(includeText ? { text: d.text } : {}),
    n_characters: d.text.length,
    source: d.source,
    ...Object.fromEntries(cols.map((c) => [own.has(c) ? `meta_${c}` : c, d.meta[c] ?? ''])),
  }));
}

/** Free-text runs that answered with JSON get one extra column per value; the raw response column stays. */
function jsonColumns(run: Run, response: string | undefined): Row {
  if (run.snapshot.prompt.outputMode !== 'text') return {};
  const flat = flattenJsonResponse(response) ?? {};
  // The model writes its reasoning first (better answers), but readers want the scores first:
  // within each group (e.g. each domain) put the reasoning column last.
  const isReasoning = isExplanationKey;
  const groupOf = (k: string) => (k.includes('_') ? k.slice(0, k.lastIndexOf('_')) : '');
  const order: string[] = [];
  for (const k of Object.keys(flat)) if (!order.includes(groupOf(k))) order.push(groupOf(k));
  const sorted = Object.keys(flat).sort((a, b) => order.indexOf(groupOf(a)) - order.indexOf(groupOf(b)) || Number(isReasoning(a)) - Number(isReasoning(b)));
  // Flat names ("race", "race_explanation"): each explanation goes right after its own score.
  const scoreOf = (k: string) => {
    for (const suffix of ['_explanation', '_reasoning']) if (k.endsWith(suffix) && k.slice(0, -suffix.length) in flat) return k.slice(0, -suffix.length);
    return null;
  };
  const keys: string[] = [];
  const place = (k: string) => {
    keys.push(k);
    for (const m of sorted) if (scoreOf(m) === k) place(m);
  };
  for (const k of sorted) if (scoreOf(k) === null) place(k);
  return Object.fromEntries(keys.map((k) => [k, numify(flat[k])]));
}

/** Numbers as numbers (so Excel can sort and sum them); anything else unchanged.
 *  Only values that read back identically are converted, so codes like "007" or "3.50" stay as written. */
function numify(v: string | undefined): string | number {
  if (v === undefined) return '';
  const t = v.trim();
  return /^-?\d+(\.\d+)?$/.test(t) && String(Number(t)) === t ? Number(t) : v;
}

function isNumericVar(run: Run, f: string): boolean {
  const t = run.snapshot.prompt.variables.find((x) => x.name === f)?.type;
  return t === 'number' || t === 'ordinal';
}

function hasJson(run: Run, response: string | undefined): boolean {
  return run.snapshot.prompt.outputMode === 'text' && flattenJsonResponse(response) !== null;
}

/** Identifying columns first (id, file name), annotations next, bulky columns (raw JSON answer, full text) last. */
function readingOrder(row: Row, rawLast: boolean): Row {
  const front = ['doc_id', 'file'].filter((k) => k in row);
  const back = [...(rawLast ? [TEXT_RESPONSE_KEY] : []), 'text'].filter((k) => k in row);
  const middle = Object.keys(row).filter((k) => !front.includes(k) && !back.includes(k));
  return Object.fromEntries([...front, ...middle, ...back].map((k) => [k, row[k]]));
}

/** One row per request (text × replicate). */
export function resultsLong(study: Study, runs: Run[], docs: Doc[], results: Result[], opts: { rationale: boolean; reasoning: boolean }): Row[] {
  const docById = new Map(docs.map((d) => [d.id, d]));
  const runById = new Map(runs.map((r) => [r.id, r]));
  const rows: Row[] = [];
  const sorted = [...results].sort((a, b) => {
    const ra = runById.get(a.runId)?.number ?? 0;
    const rb = runById.get(b.runId)?.number ?? 0;
    return ra - rb || (docById.get(a.docId)?.order ?? 0) - (docById.get(b.docId)?.order ?? 0) || a.replicate - b.replicate;
  });
  for (const r of sorted) {
    const run = runById.get(r.runId);
    if (!run) continue;
    const doc = docById.get(r.docId);
    const row: Row = {
      study: study.name,
      run: run.number,
      run_label: run.label,
      prompt_version: run.snapshot.promptVersion,
      prompt_hash: run.snapshot.promptHash,
      provider: run.snapshot.model.provider,
      model_requested: run.snapshot.model.model,
      model_reported: r.modelReported,
      doc_id: doc?.docId ?? `(deleted ${r.docId})`,
      replicate: r.replicate,
      status: r.status,
    };
    for (const f of outputFields(run.snapshot.prompt)) row[f] = isNumericVar(run, f) ? numify(r.values[f]) : (r.values[f] ?? '');
    Object.assign(row, jsonColumns(run, r.values[TEXT_RESPONSE_KEY]));
    if (opts.rationale) row.rationale = r.rationale;
    if (opts.reasoning) row.reasoning_summary = r.reasoningSummary;
    Object.assign(row, {
      parse_error: r.parseError ?? '',
      error: r.error ?? '',
      stop_reason: r.stopReason,
      input_tokens: r.usage.inputTokens,
      output_tokens: r.usage.outputTokens,
      reasoning_tokens: r.usage.reasoningTokens,
      cache_read_tokens: r.usage.cacheReadTokens,
      cache_write_tokens: r.usage.cacheWriteTokens,
      latency_ms: r.latencyMs,
      requested_at: r.requestedAt,
      completed_at: r.completedAt,
      response_id: r.responseId,
    });
    rows.push(row);
  }
  return rows;
}

/** One row per text for a single run: metadata + aggregated annotations. */
export function resultsWide(run: Run, docs: Doc[], allRuns: Run[], results: Result[], opts: { text: boolean; rationale: boolean }): Row[] {
  const views = buildDocViews(docs, allRuns, results, run.id);
  const fields = outputFields(run.snapshot.prompt);
  const reps = run.snapshot.options.replicates;
  const cols = metaColumns(docs);
  const rows: Row[] = [];
  for (const d of docs) {
    const v = views.get(d.id)!;
    if (v.status === 'none') continue;
    const row: Row = { doc_id: d.docId };
    if (opts.text) row.text = d.text;
    for (const f of fields) {
      row[f] = isNumericVar(run, f) ? numify(v.values[f]) : (v.values[f] ?? '');
      // (Plain-text answers are combined value by value, so a share of identical answers says nothing.)
      if (reps > 1 && run.snapshot.prompt.outputMode === 'structured') row[`${f}_agreement_across_runs`] = v.consistency[f] !== undefined ? Math.round(v.consistency[f] * 1000) / 1000 : '';
    }
    Object.assign(row, jsonColumns(run, v.values[TEXT_RESPONSE_KEY]));
    if (opts.rationale && run.snapshot.prompt.includeRationale && run.snapshot.prompt.outputMode === 'structured') {
      row.rationale = v.results.find((r) => r.status === 'ok')?.rationale ?? '';
    }
    // Metadata (including any human labels) after the annotations; prefixed if a name collides.
    for (const c of cols) row[c in row ? `meta_${c}` : c] = numify(d.meta[c]);
    row.n_ok = v.results.filter((r) => r.status === 'ok').length;
    row.n_error = v.results.filter((r) => r.status === 'error').length;
    rows.push(readingOrder(row, hasJson(run, v.values[TEXT_RESPONSE_KEY])));
  }
  return rows;
}

export interface AgreementRow {
  field: string;
  /** "model" for the run's annotations, or a metadata column (human–human comparison). */
  source: string;
  compared_with: string;
  level: Level;
  stats: Agreement;
  /** Texts with a value in `compared_with` (for the model: among the run's texts). `stats.n` of them were compared. */
  nLabelled: number;
}

/** Find metadata columns that look like human labels for a field, e.g. "sentiment", "sentiment_gold", "human_sentiment".
 *  Coders' notes (e.g. "sentiment_explanation") are not labels. */
export function goldColumnsFor(field: string, docs: Doc[]): string[] {
  const f = field.toLowerCase();
  return metaColumns(docs).filter((c) => {
    const x = c.toLowerCase();
    if (isExplanationKey(x) && !isExplanationKey(f)) return false;
    return x === f || x.startsWith(`${f}_`) || x.endsWith(`_${f}`) || x === `gold_${f}` || x === `human_${f}`;
  });
}

export function agreementForRun(run: Run, docs: Doc[], allRuns: Run[], results: Result[], extra: { field: string; column: string }[] = []): AgreementRow[] {
  const views = buildDocViews(docs, allRuns, results, run.id);
  const out: AgreementRow[] = [];
  const pairs: { field: string; column: string }[] = [];
  if (run.snapshot.prompt.outputMode === 'structured') {
    // Free-text fields (e.g. explanations) have no agreement to compute: every answer is its own category.
    for (const v of run.snapshot.prompt.variables) if (v.type !== 'text') for (const c of goldColumnsFor(v.name, docs)) pairs.push({ field: v.name, column: c });
  }
  for (const e of extra) if (!pairs.some((p) => p.field === e.field && p.column === e.column)) pairs.push(e);
  const inRun = new Set(run.docIds);
  const setup = (field: string) => {
    const variable = run.snapshot.prompt.variables.find((v) => v.name === field);
    const level: Level = variable?.type === 'ordinal' ? 'ordinal' : variable?.type === 'number' ? 'interval' : 'nominal';
    const allowed = variable && (variable.type === 'category' || variable.type === 'ordinal') ? variable.values.map((x) => normalizeLabel(x)).filter(Boolean) : [];
    return { level, allowed, yesNo: variable?.type === 'boolean' };
  };
  for (const { field, column } of pairs) {
    const { level, allowed, yesNo } = setup(field);
    const xs: string[] = [];
    const ys: string[] = [];
    let nLabelled = 0;
    for (const d of docs) {
      const y = normalizeLabel(d.meta[column], yesNo);
      if (!y || !inRun.has(d.id)) continue;
      nLabelled++;
      const v = views.get(d.id)!;
      const x = normalizeLabel(v.values[field], yesNo);
      if (v.status !== 'none' && x) {
        xs.push(x);
        ys.push(y);
      }
    }
    out.push({ field, source: 'model', compared_with: column, level, stats: agreement(xs, ys, level, allowed), nLabelled });
  }
  // Human–human baseline: two label columns for the same field (e.g. stance_gold and stance_coder2).
  const fields = [...new Set(pairs.map((p) => p.field))];
  for (const field of fields) {
    const cols = pairs.filter((p) => p.field === field).map((p) => p.column);
    const { level, allowed, yesNo } = setup(field);
    for (let i = 0; i < cols.length; i++)
      for (let j = i + 1; j < cols.length; j++) {
        const xs: string[] = [];
        const ys: string[] = [];
        let nLabelled = 0;
        for (const d of docs) {
          const y = normalizeLabel(d.meta[cols[j]], yesNo);
          if (!y) continue;
          nLabelled++;
          const x = normalizeLabel(d.meta[cols[i]], yesNo);
          if (x) {
            xs.push(x);
            ys.push(y);
          }
        }
        out.push({ field, source: cols[i], compared_with: cols[j], level, stats: agreement(xs, ys, level, allowed), nLabelled });
      }
  }
  return out;
}

export function agreementRows(rows: AgreementRow[], runNumber: number): Row[] {
  const round = (x: number) => Math.round(x * 10000) / 10000;
  const withCi = (name: string, value: number | null, ci: [number, number] | null | undefined): Row => ({
    [name]: value,
    [`${name}_ci_low`]: ci ? round(ci[0]) : null,
    [`${name}_ci_high`]: ci ? round(ci[1]) : null,
  });
  return rows.map((a) => ({
    run: runNumber,
    field: a.field,
    annotations: a.source === 'model' ? `model (run ${runNumber})` : a.source,
    compared_with: a.compared_with,
    level_of_measurement: a.stats.level,
    n: a.stats.n,
    n_with_label: a.nLabelled,
    n_left_out_label_not_a_number: a.stats.leftOut.n,
    ...withCi('percent_agreement', a.stats.percentAgreement, a.stats.ci.percentAgreement),
    ...withCi('cohen_kappa', a.stats.cohenKappa, a.stats.ci.cohenKappa),
    ...withCi('weighted_kappa_linear', a.stats.weightedKappaLinear, a.stats.ci.weightedKappaLinear),
    ...withCi('weighted_kappa_quadratic', a.stats.weightedKappa, a.stats.ci.weightedKappa),
    ...withCi('krippendorff_alpha', a.stats.krippendorffAlpha, a.stats.ci.krippendorffAlpha),
    ...withCi('gwet_ac1', a.stats.gwetAC1, a.stats.ci.gwetAC1),
    ...withCi('gwet_ac2_linear', a.stats.gwetAC2Linear, a.stats.ci.gwetAC2Linear),
    spearman_rho: a.stats.spearman,
    pearson_r: a.stats.pearson,
    mean_absolute_error: a.stats.mae,
  }));
}

export function runSummaryRows(runs: Run[], results: Result[]): Row[] {
  return runs.map((r) => {
    const rs = results.filter((x) => x.runId === r.id);
    const sum = (k: keyof Result['usage']) => rs.reduce((s, x) => s + x.usage[k], 0);
    return {
      run: r.number,
      label: r.label,
      started_at: r.createdAt,
      finished_at: r.finishedAt,
      status: r.status,
      mode: r.mode,
      batch_id: (r.batch?.parts ?? (r.batch ? [r.batch] : [])).map((p) => p.batchId).join('; '),
      scope: r.scope,
      n_texts: r.docIds.length,
      replicates: r.snapshot.options.replicates,
      requests_ok: rs.filter((x) => x.status === 'ok').length,
      requests_failed: rs.filter((x) => x.status === 'error').length,
      requests_retried: (r.retries ?? []).reduce((s, x) => s + x.requests, 0),
      provider: r.snapshot.model.provider,
      model_requested: r.snapshot.model.model,
      models_reported: [...new Set(rs.map((x) => x.modelReported).filter(Boolean))].join('; '),
      effort: r.snapshot.model.effort || 'default',
      thinking: r.snapshot.model.provider === 'anthropic' ? thinkingLabel(r.snapshot.model.model, r.snapshot.model.reasoningSummary) : '',
      temperature: r.snapshot.model.temperature ?? 'default',
      max_output_tokens: r.snapshot.model.maxOutputTokens,
      caching: cachingLabel(r),
      prompt_version: r.snapshot.promptVersion,
      prompt_hash: r.snapshot.promptHash,
      input_tokens: sum('inputTokens'),
      output_tokens: sum('outputTokens'),
      reasoning_tokens: sum('reasoningTokens'),
      cache_read_tokens: sum('cacheReadTokens'),
      cache_write_tokens: sum('cacheWriteTokens'),
      app_version: r.snapshot.appVersion,
      error: r.error ?? '',
    };
  });
}

/** How prompt caching was handled in a run, for exports. Older OpenAI models cache whatever the setting says. */
export function cachingLabel(run: Run): string {
  const { provider, model } = run.snapshot.model;
  if (provider === 'openai' && !supportsExplicitCaching(model)) return 'automatic (OpenAI caches long prompts; cannot be turned off)';
  if (!run.snapshot.options.caching) return 'off';
  return provider === 'anthropic' ? `on (${run.snapshot.options.cacheTtl})` : 'on';
}

export function codebookMarkdown(run: Run): string {
  const p = run.snapshot.prompt;
  if (p.outputMode !== 'structured') return '# Codebook\n\nThe model was asked for a free-text response (no structured fields).\n';
  const lines = ['# Codebook', '', 'Fields the model was required to return (enforced with a JSON schema; see `output_schema.json`).', '', '| Field | Column name | Type | Allowed values | Description |', '|---|---|---|---|---|'];
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  if (p.includeRationale) lines.push('| Rationale | rationale | free text | | Brief justification, generated before the labels |');
  for (const v of p.variables) lines.push(`| ${esc(v.label?.trim() || v.name)} | ${v.name} | ${v.type} | ${esc(v.values.filter((x) => x.trim()).join(', '))} | ${esc(v.description)} |`);
  return lines.join('\n') + '\n';
}

/** For the Excel sheet only: doc_id is just the file name minus extension for uploaded files, so show only the file name. CSVs keep doc_id as the join key. */
export function dropRedundantId(rows: Row[]): Row[] {
  const stem = (f: unknown) => String(f ?? '').replace(/\.[^./\\]+$/, '');
  if (!rows.length || !rows.every((r) => 'file' in r && r.doc_id === stem(r.file))) return rows;
  return rows.map(({ doc_id: _id, ...rest }) => rest);
}
