// Tabular views used by every export format.
import Papa from 'papaparse';
import { agreement, type Agreement, type Level } from '../metrics';
import { normalizeLabel, outputFields } from '../prompt';
import { thinkingLabel } from '../providers/anthropic';
import type { Doc, Result, Run, Study } from '../types';
import { buildDocViews } from '../view';

export type Row = Record<string, string | number | null>;

export function toCsv(rows: Row[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  // UTF-8 BOM so Excel opens non-ASCII text correctly.
  return '﻿' + Papa.unparse({ fields: cols, data: rows.map((r) => cols.map((c) => r[c] ?? '')) });
}

export function toJsonl(items: unknown[]): string {
  return items.map((x) => JSON.stringify(x)).join('\n') + (items.length ? '\n' : '');
}

export function metaColumns(docs: Doc[]): string[] {
  return [...new Set(docs.flatMap((d) => Object.keys(d.meta)))];
}

export function corpusRows(docs: Doc[], includeText: boolean): Row[] {
  const cols = metaColumns(docs);
  return docs.map((d) => ({
    doc_id: d.docId,
    ...(includeText ? { text: d.text } : {}),
    n_characters: d.text.length,
    source: d.source,
    ...Object.fromEntries(cols.map((c) => [c, d.meta[c] ?? ''])),
  }));
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
      refusal_fallback: r.fallback ?? '',
      doc_id: doc?.docId ?? `(deleted ${r.docId})`,
      replicate: r.replicate,
      status: r.status,
    };
    for (const f of outputFields(run.snapshot.prompt)) row[f] = r.values[f] ?? '';
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
      row[f] = v.values[f] ?? '';
      if (reps > 1) row[`${f}_agreement_across_runs`] = v.consistency[f] !== undefined ? Math.round(v.consistency[f] * 1000) / 1000 : '';
    }
    if (opts.rationale && run.snapshot.prompt.includeRationale && run.snapshot.prompt.outputMode === 'structured') {
      row.rationale = v.results.find((r) => r.status === 'ok')?.rationale ?? '';
    }
    // Metadata (including any human labels) after the annotations; prefixed if a name collides.
    for (const c of cols) row[c in row ? `meta_${c}` : c] = d.meta[c] ?? '';
    row.n_ok = v.results.filter((r) => r.status === 'ok').length;
    row.n_error = v.results.filter((r) => r.status === 'error').length;
    rows.push(row);
  }
  return rows;
}

export interface AgreementRow {
  field: string;
  compared_with: string;
  level: Level;
  stats: Agreement;
}

/** Find metadata columns that look like human labels for a field, e.g. "sentiment", "sentiment_gold", "human_sentiment". */
export function goldColumnsFor(field: string, docs: Doc[]): string[] {
  const f = field.toLowerCase();
  return metaColumns(docs).filter((c) => {
    const x = c.toLowerCase();
    return x === f || x.startsWith(`${f}_`) || x.endsWith(`_${f}`) || x === `gold_${f}` || x === `human_${f}`;
  });
}

export function agreementForRun(run: Run, docs: Doc[], allRuns: Run[], results: Result[], extra: { field: string; column: string }[] = []): AgreementRow[] {
  const views = buildDocViews(docs, allRuns, results, run.id);
  const out: AgreementRow[] = [];
  const pairs: { field: string; column: string }[] = [];
  if (run.snapshot.prompt.outputMode === 'structured') {
    for (const v of run.snapshot.prompt.variables) for (const c of goldColumnsFor(v.name, docs)) pairs.push({ field: v.name, column: c });
  }
  for (const e of extra) if (!pairs.some((p) => p.field === e.field && p.column === e.column)) pairs.push(e);
  for (const { field, column } of pairs) {
    const variable = run.snapshot.prompt.variables.find((v) => v.name === field);
    const level: Level = variable?.type === 'ordinal' ? 'ordinal' : variable?.type === 'number' ? 'interval' : 'nominal';
    const xs: string[] = [];
    const ys: string[] = [];
    for (const d of docs) {
      const v = views.get(d.id)!;
      const x = normalizeLabel(v.values[field]);
      const y = normalizeLabel(d.meta[column]);
      if (v.status !== 'none' && x && y) {
        xs.push(x);
        ys.push(y);
      }
    }
    const allowed = variable && (variable.type === 'category' || variable.type === 'ordinal') ? variable.values.map((x) => normalizeLabel(x)).filter(Boolean) : [];
    out.push({ field, compared_with: column, level, stats: agreement(xs, ys, level, allowed) });
  }
  return out;
}

export function agreementRows(rows: AgreementRow[], runNumber: number): Row[] {
  return rows.map((a) => ({
    run: runNumber,
    field: a.field,
    compared_with: a.compared_with,
    level_of_measurement: a.level,
    n: a.stats.n,
    percent_agreement: a.stats.percentAgreement,
    cohen_kappa: a.stats.cohenKappa,
    weighted_kappa_quadratic: a.stats.weightedKappa,
    krippendorff_alpha: a.stats.krippendorffAlpha,
    gwet_ac1: a.stats.gwetAC1,
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
      batch_id: r.batch?.batchId ?? '',
      scope: r.scope,
      n_texts: r.docIds.length,
      replicates: r.snapshot.options.replicates,
      requests_ok: rs.filter((x) => x.status === 'ok').length,
      requests_failed: rs.filter((x) => x.status === 'error').length,
      provider: r.snapshot.model.provider,
      model_requested: r.snapshot.model.model,
      models_reported: [...new Set(rs.map((x) => x.modelReported).filter(Boolean))].join('; '),
      effort: r.snapshot.model.effort || 'default',
      thinking: r.snapshot.model.provider === 'anthropic' ? thinkingLabel(r.snapshot.model.model, r.snapshot.model.reasoningSummary) : '',
      temperature: r.snapshot.model.temperature ?? 'default',
      max_output_tokens: r.snapshot.model.maxOutputTokens,
      caching: r.snapshot.options.caching ? 'on' : 'off',
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

export function codebookMarkdown(run: Run): string {
  const p = run.snapshot.prompt;
  if (p.outputMode !== 'structured') return '# Codebook\n\nThe model was asked for a free-text response (no structured fields).\n';
  const lines = ['# Codebook', '', 'Fields the model was required to return (enforced with a JSON schema; see `output_schema.json`).', '', '| Field | Type | Allowed values | Description |', '|---|---|---|---|'];
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  if (p.includeRationale) lines.push('| rationale | free text | | Brief justification, generated before the labels |');
  for (const v of p.variables) lines.push(`| ${v.name} | ${v.type} | ${esc(v.values.filter((x) => x.trim()).join(', '))} | ${esc(v.description)} |`);
  return lines.join('\n') + '\n';
}
