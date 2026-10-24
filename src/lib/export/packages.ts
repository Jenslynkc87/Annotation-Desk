// Builds the downloadable exports: Excel workbook, research repository, supplementary repository.
import { ZipDeflate } from 'fflate';
import { logPagesForRun } from '../db';
import { fixed, fmtStat } from '../metrics';
import { combineFields, comparableFields, fieldValue } from '../compare';
import { agreement, type Agreement, type CiStat } from '../metrics';
import { buildOutputSchema, effectiveTemplate, flattenJsonResponse, isExplanationKey, normalizeLabel, TEXT_RESPONSE_KEY } from '../prompt';
import { buildDocViews, replacedAttempts, retriedRequests, retryInProgress, retryUnderWay, runInProgress, runOrder, type RetriedRequests } from '../view';
import { thinkingLabel } from '../providers/anthropic';
import { isEntries, words } from '../subject';
import type { Doc, Result, ResultLog, Run, Study } from '../types';
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
  labelPairs,
  labelValue,
  resultsLong,
  resultsWide,
  retryNotes,
  runName,
  runSummaryRows,
  runTag,
  sharesNumber,
  toCsvBlob,
  type Row,
} from './tables';

export interface ExportData {
  study: Study;
  docs: Doc[];
  runs: Run[];
  results: Result[];
}

/** The runs in the order they were made, so runs that share a number keep their order (and the latest is the last made) in every copy of the study. */
const inRunOrder = (d: ExportData): ExportData => ({ ...d, runs: [...d.runs].sort(runOrder) });

const MAX32 = 0xffffffff;
/** Deflate level: about as fast as the lowest (a full corpus's logs are gigabytes), and nearly as small as the default. */
const ZIP_LEVEL = 3;

interface ZipEntry {
  name: Uint8Array;
  utf8: boolean;
  dir: boolean;
  crc: number;
  size: number;
  compressed: number;
  offset: number;
}

/** A folder of a zip being written: files and folders go in, in that order. */
export interface ZipFolder {
  folder(name: string): ZipFolder;
  file(name: string, data: string | Blob): Promise<void>;
}

const set64 = (v: DataView, at: number, x: number) => {
  v.setUint32(at, x % 2 ** 32, true);
  v.setUint32(at + 4, Math.floor(x / 2 ** 32), true);
};

/**
 * A zip file written as it is built (for the research and supplementary packages). Each file is compressed as it is
 * read, a Blob a piece at a time, and its compressed data goes into Blobs of a few MB, so neither the inputs (a full
 * corpus's logs hold every text several times, gigabytes) nor the zip ever have to be in memory at once. Entries keep
 * the order they are added in, folders before their files. The zip format stops at 4 GB: past that, the entries that
 * need it get ZIP64 records (read by current unzip tools).
 */
export class ZipWriter {
  private parts: Blob[] = [];
  private entries: ZipEntry[] = [];
  private offset = 0;
  private dirs = new Set<string>();
  private busy = false;
  private time: number;
  private date: number;

  /** `onFile`: told each file's path as it starts (a full corpus takes many minutes, so the page shows what it is on). */
  constructor(
    private level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = ZIP_LEVEL,
    private onFile?: (path: string) => void,
  ) {
    // Local time, as zip tools show it.
    const d = new Date();
    this.time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    this.date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  }

  /** A folder (and the folders it is in), written now if new. */
  folder(path: string): ZipFolder {
    this.dir(path);
    return { folder: (name) => this.folder(`${path}/${name}`), file: (name, data) => this.file(`${path}/${name}`, data) };
  }

  private dir(path: string) {
    if (!path || this.dirs.has(path)) return;
    this.dir(path.slice(0, Math.max(0, path.lastIndexOf('/'))));
    this.dirs.add(path);
    this.add(path + '/', true, 0, 0, 0, []);
  }

  /** One file, compressed as it is read; the next may only start once this one is written. */
  async file(path: string, data: string | Blob): Promise<void> {
    if (this.busy) throw new Error('A zip file is written one file at a time.');
    this.busy = true;
    try {
      this.onFile?.(path);
      this.dir(path.slice(0, Math.max(0, path.lastIndexOf('/'))));
      const out: Blob[] = [];
      let pending: Uint8Array<ArrayBuffer>[] = [];
      let pendingBytes = 0;
      let compressed = 0;
      const z = new ZipDeflate(path, { level: this.level });
      z.ondata = (err, chunk, final) => {
        if (err) throw err;
        // (fflate's output: new arrays, never reused.)
        pending.push(chunk as Uint8Array<ArrayBuffer>);
        pendingBytes += chunk.length;
        compressed += chunk.length;
        // Into a Blob every few MB, so the browser can keep the archive out of the page's memory.
        if (pendingBytes >= 4_000_000 || final) {
          out.push(new Blob(pending));
          pending = [];
          pendingBytes = 0;
        }
      };
      if (typeof data === 'string') {
        const bytes = new TextEncoder().encode(data);
        for (let i = 0; i < bytes.length; i += 1 << 20) z.push(bytes.subarray(i, i + (1 << 20)));
      } else {
        const reader = data.stream().getReader();
        for (let r = await reader.read(); !r.done; r = await reader.read()) z.push(r.value);
      }
      z.push(new Uint8Array(0), true);
      this.add(path, false, z.crc >>> 0, z.size, compressed, out);
    } finally {
      this.busy = false;
    }
  }

  private add(path: string, dir: boolean, crc: number, size: number, compressed: number, data: Blob[]) {
    const name = new TextEncoder().encode(path);
    const e: ZipEntry = { name, utf8: /[^\x20-\x7e]/.test(path), dir, crc, size, compressed, offset: this.offset };
    const big = size >= MAX32 || compressed >= MAX32;
    const head = new Uint8Array(30 + name.length + (big ? 20 : 0));
    const v = new DataView(head.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, big ? 45 : 20, true);
    this.common(v, 6, e);
    v.setUint32(18, big ? MAX32 : compressed, true);
    v.setUint32(22, big ? MAX32 : size, true);
    v.setUint16(26, name.length, true);
    v.setUint16(28, big ? 20 : 0, true);
    head.set(name, 30);
    if (big) {
      // ZIP64 extra field: both sizes.
      v.setUint16(30 + name.length, 1, true);
      v.setUint16(32 + name.length, 16, true);
      set64(v, 34 + name.length, size);
      set64(v, 42 + name.length, compressed);
    }
    this.parts.push(new Blob([head]), ...data);
    this.offset += head.length + compressed;
    this.entries.push(e);
  }

  /** Flags, method, time, date and CRC: the same in the local and the central header. */
  private common(v: DataView, at: number, e: ZipEntry) {
    v.setUint16(at, e.utf8 ? 0x0800 : 0, true);
    v.setUint16(at + 2, e.dir ? 0 : 8, true);
    v.setUint16(at + 4, this.time, true);
    v.setUint16(at + 6, this.date, true);
    v.setUint32(at + 8, e.crc, true);
  }

  /** The finished zip: the central directory after the files. */
  blob(): Blob {
    const start = this.offset;
    const central = this.entries.map((e) => {
      // ZIP64: the values too large for their field, in this order.
      const wide = [...(e.size >= MAX32 || e.compressed >= MAX32 ? [e.size, e.compressed] : []), ...(e.offset >= MAX32 ? [e.offset] : [])];
      const extra = wide.length ? 4 + 8 * wide.length : 0;
      const h = new Uint8Array(46 + e.name.length + extra);
      const v = new DataView(h.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, wide.length ? 45 : 20, true);
      v.setUint16(6, wide.length ? 45 : 20, true);
      this.common(v, 8, e);
      const bigSizes = e.size >= MAX32 || e.compressed >= MAX32;
      v.setUint32(20, bigSizes ? MAX32 : e.compressed, true);
      v.setUint32(24, bigSizes ? MAX32 : e.size, true);
      v.setUint16(28, e.name.length, true);
      v.setUint16(30, extra, true);
      // (Comment, disk and internal attributes: 0. External: the MS-DOS directory flag.)
      v.setUint32(38, e.dir ? 0x10 : 0, true);
      v.setUint32(42, e.offset >= MAX32 ? MAX32 : e.offset, true);
      h.set(e.name, 46);
      if (wide.length) {
        v.setUint16(46 + e.name.length, 1, true);
        v.setUint16(48 + e.name.length, 8 * wide.length, true);
        wide.forEach((x, i) => set64(v, 50 + e.name.length + 8 * i, x));
      }
      return h;
    });
    const size = central.reduce((s, h) => s + h.length, 0);
    const count = this.entries.length;
    const big = start >= MAX32 || size >= MAX32 || count >= 0xffff;
    const tail: Uint8Array<ArrayBuffer>[] = [];
    if (big) {
      // ZIP64 end of central directory record, and the locator that points to it.
      const r = new Uint8Array(56 + 20);
      const v = new DataView(r.buffer);
      v.setUint32(0, 0x06064b50, true);
      set64(v, 4, 44);
      v.setUint16(12, 45, true);
      v.setUint16(14, 45, true);
      set64(v, 24, count);
      set64(v, 32, count);
      set64(v, 40, size);
      set64(v, 48, start);
      v.setUint32(56, 0x07064b50, true);
      set64(v, 64, start + size);
      v.setUint32(72, 1, true);
      tail.push(r);
    }
    const end = new Uint8Array(22);
    const v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, big ? 0xffff : count, true);
    v.setUint16(10, big ? 0xffff : count, true);
    v.setUint32(12, big ? MAX32 : size, true);
    v.setUint32(16, big ? MAX32 : start, true);
    tail.push(end);
    return new Blob([...this.parts, ...central, ...tail], { type: 'application/zip' });
  }
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

/**
 * A sheet name Excel accepts: none of [ ] : * ? / \, at most 31 characters, no apostrophe at either end, and
 * not the name of another sheet in any capitalization (ExcelJS refuses those, so no report would be made).
 */
function sheetName(wb: Workbook, wanted: string): string {
  const clean = (s: string) => s.replace(/[[\]:*?/\\]/g, '_').slice(0, 31).replace(/^'+|'+$/g, '');
  const taken = new Set(wb.worksheets.map((ws) => ws.name.toLowerCase()));
  let name = clean(wanted);
  for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${clean(wanted).slice(0, 31 - `_${k}`.length)}_${k}`;
  return name;
}

export async function buildExcel(data: ExportData, run: Run, opts: { text: boolean; rationale: boolean }): Promise<Blob> {
  const d = inRunOrder(data);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const add = (name: string, rows: Row[]) => addSheet(wb, name, rows);
  add('Results', dropRedundantId(resultsWide(run, d.docs, d.runs, d.results, opts)));
  add('By replicate', resultsLong(d.study, [run], d.docs, d.results.filter((r) => r.runId === run.id), { rationale: opts.rationale, reasoning: true }, d.runs));
  const agr = agreementForRun(run, d.docs, d.runs, d.results, d.study);
  if (agr.length) add('Agreement', agreementRows(agr, runName(run, d.runs)));
  add('Settings', settingsRows(d.study, run, d.runs));
  add('All runs', runSummaryRows(d.runs, d.results));
  const out = await wb.xlsx.writeBuffer();
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function settingsRows(study: Study, run: Run, runs: Run[]): Row[] {
  const m = run.snapshot.model;
  const o = run.snapshot.options;
  const p = run.snapshot.prompt;
  return [
    { setting: 'Study', value: study.name },
    ...(study.description.trim() ? [{ setting: 'Study notes (e.g. how samples were drawn)', value: study.description.trim() }] : []),
    { setting: 'Run', value: `#${runName(run, runs)}${run.label ? ` (${run.label})` : ''}` },
    { setting: 'Started', value: run.createdAt },
    // (During Retry failed the run keeps its earlier finish time, which is no longer when it finished.)
    {
      setting: 'Finished',
      value: runInProgress(run) ? `not finished when exported (${retryInProgress(run) ? 'Retry failed was still sending; ' : ''}the results so far)` : run.finishedAt,
    },
    { setting: 'Provider', value: m.provider },
    { setting: 'Model', value: m.model },
    { setting: 'Effort / reasoning', value: m.effort || 'model default' },
    { setting: 'Thinking', value: m.provider === 'anthropic' ? thinkingLabel(m.model, m.reasoningSummary) : 'n/a (reasoning controlled by effort)' },
    { setting: 'Temperature', value: m.temperature ?? 'model default' },
    { setting: 'Max output tokens', value: m.maxOutputTokens },
    { setting: `Annotations per ${words(p).one}`, value: o.replicates },
    { setting: 'Prompt caching', value: cachingLabel(run) },
    { setting: 'Mode', value: run.mode === 'batch' ? 'Batch API' : 'immediate requests' },
    { setting: 'Prompt version', value: `v${run.snapshot.promptVersion} (${run.snapshot.promptHash})` },
    { setting: `Prompt (sent with each ${p.subject === 'entries' ? 'entry' : 'text'})`, value: effectiveTemplate(p.userTemplate, p.subject) },
    { setting: 'System prompt', value: p.system || '(none)' },
    { setting: 'Output', value: p.outputMode === 'structured' ? JSON.stringify(run.snapshot.outputSchema) : 'plain text' },
    { setting: 'Annotation Desk version (run)', value: run.snapshot.appVersion },
    { setting: 'Annotation Desk version (this export)', value: __APP_VERSION__ },
  ];
}

const runFolderBase = (r: Run) => `run-${String(r.number).padStart(2, '0')}${r.label ? '-' + slug(r.label) : ''}`;

/**
 * Each run's folder in the research repository: run-NN[-label], plus when the run started for runs that share a
 * number (earlier versions gave some the same number, in two tabs), as in the tables' run column (`runName`), so
 * neither overwrites the other.
 */
function runFolders(runs: Run[]): Map<string, string> {
  return new Map(runs.map((r) => [r.id, sharesNumber(r, runs) ? `${runFolderBase(r)}-${runTag(r, runs)}` : runFolderBase(r)]));
}

/**
 * A logged request as it was sent: the run's shared settings plus the request's own part. Runs made with the first
 * version (October 15, 2026) keep its refusal fallback (`fallbacks`) in their frozen settings. It went out with
 * those runs' own immediate requests, and with retries sent by versions before the October 22 fixes (which
 * overwrote the earlier attempt's log and numbered no attempts). It never went out in a batch (every version's batch
 * upload left it out; a batch request's logged part holds its custom_id), nor with a retry sent by a later version:
 * the adapter leaves it out, and such a retry's attempts are numbered 2 or later (attempt numbers came with the same
 * fixes). A log that records what was left out (`omitted`) is taken at its word; without that record, a text first
 * sent by such a retry (attempt 1: it had never been sent) can't be told from a day-one request.
 */
export function requestAsSent(run: Run, log: ResultLog, attempt: number): Record<string, unknown> {
  const base = run.snapshot.requestBase;
  const omitted = new Set(log.omitted ?? []);
  if ('fallbacks' in base && (attempt >= 2 || 'custom_id' in (log.requestPart ?? {}))) omitted.add('fallbacks');
  return { ...Object.fromEntries(Object.entries(base).filter(([k]) => !omitted.has(k))), ...log.requestPart };
}

/**
 * The run's requests and responses as JSON Lines, in the study's order of texts, then replicate, then attempt (an
 * earlier attempt that "Retry failed" replaced comes first, with its outcome). The logs are read a page at a time
 * and each text's lines become their own Blob, which the zip reads a piece at a time: a full run's logs (each holds
 * a whole text) never have to be in memory at once.
 */
async function addRunLogs(zip: ZipFolder, run: Run, docs: Doc[], results: Result[]) {
  const docById = new Map(docs.map((d) => [d.id, d.docId]));
  const position = new Map(docs.map((d, i) => [d.id, i]));
  const attemptOf = new Map(results.filter((r) => r.runId === run.id).map((r) => [r.id, r.attempt ?? 1]));
  const parts: { doc: string; requests: Blob; responses: Blob }[] = [];
  // Log ids are `${run.id}:${doc}:${replicate}`, plus `#${attempt}` for a replaced attempt, so in id order a
  // text's logs come one after the other.
  const parse = (l: ResultLog) => {
    const [id, n] = l.id.split('#');
    const cut = id.lastIndexOf(':');
    return { l, id, doc: id.slice(run.id.length + 1, cut), replicate: Number(id.slice(cut + 1)), attempt: n ? Number(n) : 0 };
  };
  let pending: ReturnType<typeof parse>[] = [];
  const flush = () => {
    if (!pending.length) return;
    // The current attempt's log has no number: it is the result's attempt, i.e. after the replaced ones.
    for (const x of pending)
      if (!x.attempt) x.attempt = attemptOf.get(x.id) ?? Math.max(0, ...pending.filter((y) => y.id === x.id).map((y) => y.attempt)) + 1;
    pending.sort((p, q) => p.replicate - q.replicate || p.attempt - q.attempt);
    // (A text deleted from the study since is marked as in the CSVs.)
    const head = (x: (typeof pending)[number]) => ({ doc_id: docById.get(x.doc) ?? `(deleted ${x.doc})`, replicate: x.replicate, attempt: x.attempt });
    parts.push({
      doc: pending[0].doc,
      requests: jsonlBlob(pending.map((x) => ({ ...head(x), request: requestAsSent(run, x.l, x.attempt) }))),
      responses: jsonlBlob(
        // (A replaced attempt's outcome, with the reason an answer could not be read, as in the CSVs' parse_error.)
        pending.map((x) => ({
          ...head(x),
          ...(x.l.replaced ? { status: x.l.replaced.status, error: x.l.replaced.error, parse_error: x.l.replaced.parseError ?? null } : {}),
          response: x.l.response,
        })),
      ),
    });
    pending = [];
  };
  for await (const page of logPagesForRun(run.id)) {
    for (const l of page) {
      const x = parse(l);
      if (pending.length && pending[0].doc !== x.doc) flush();
      pending.push(x);
    }
  }
  flush();
  // Texts deleted from the study since: last.
  const at = (doc: string) => position.get(doc) ?? docs.length;
  parts.sort((p, q) => at(p.doc) - at(q.doc));
  await zip.file('requests.jsonl', new Blob(parts.map((p) => p.requests), { type: 'application/jsonl' }));
  await zip.file('responses.jsonl', new Blob(parts.map((p) => p.responses), { type: 'application/jsonl' }));
}

/**
 * JSON Lines as a Blob, one line per item, folded into a Blob every few MB: the whole file never has to fit in one
 * string, nor all its lines be in memory at once (a full run's logs, or the corpus, hold every text).
 */
function jsonlBlob(items: unknown[]): Blob {
  const parts: Blob[] = [];
  let lines: string[] = [];
  let length = 0;
  for (const x of items) {
    const line = JSON.stringify(x) + '\n';
    lines.push(line);
    length += line.length;
    if (length >= 4_000_000) {
      parts.push(new Blob(lines));
      lines = [];
      length = 0;
    }
  }
  parts.push(new Blob(lines));
  return new Blob(parts, { type: 'application/jsonl' });
}

/**
 * A run's prompt, system prompt, codebook and output schema. A plain-text run has no schema and no fields (its snapshot
 * still holds the editor's, which were not sent): codebook.md says so, and output_schema.json and codebook.json are
 * left out.
 */
async function promptFiles(zip: ZipFolder, run: Run) {
  const p = run.snapshot.prompt;
  await zip.file('prompt.txt', effectiveTemplate(p.userTemplate, p.subject));
  if (p.system.trim()) await zip.file('system_prompt.txt', p.system);
  await zip.file('codebook.md', codebookMarkdown(run));
  if (p.outputMode !== 'structured') return;
  await zip.file('output_schema.json', JSON.stringify(run.snapshot.outputSchema ?? buildOutputSchema(p), null, 2));
  await zip.file('codebook.json', JSON.stringify({ outputMode: p.outputMode, includeRationale: p.includeRationale, variables: p.variables }, null, 2));
}

async function scriptFiles(zip: ZipFolder, study: Study, run: Run, exportedAt: string, runs: Run[]) {
  await zip.file('annotate_template.py', SCRIPT_TEMPLATE);
  await zip.file('annotate.py', fillScript(SCRIPT_TEMPLATE, scriptValues(study, run, exportedAt, runs)));
  await zip.file('requirements.txt', requirementsTxt(run));
}

export interface ResearchOptions {
  includeLogs: boolean;
  /** Told the path of each file as it is written. */
  onProgress?: (path: string) => void;
}

export async function buildResearchRepo(data: ExportData, opts: ResearchOptions): Promise<{ blob: Blob; name: string }> {
  const d = inRunOrder(data);
  const exportedAt = nowIso();
  const name = `${slug(d.study.name)}_research_${dateStamp()}`;
  const zip = new ZipWriter(ZIP_LEVEL, opts.onProgress);
  const root = zip.folder(name);
  // (The latest: the run with results made last.)
  const finished = d.runs.filter((r) => d.results.some((x) => x.runId === r.id));

  await root.file('study.json', JSON.stringify({ ...d.study, exportedAt }, null, 2));
  // Without the request/response logs: they are under runs/ already, and each holds the full text again. (Export →
  // Study backup has them.) The results as stored, read from the database.
  await root.file('study-backup.json', await buildBackup(d.study, d.docs, d.runs, false));
  const corpus = root.folder('corpus');
  await corpus.file('corpus.csv', toCsvBlob(corpusRows(d.docs, true)));
  await corpus.file('corpus.jsonl', jsonlBlob(d.docs.map((x) => ({ doc_id: x.docId, text: x.text, source: x.source, meta: x.meta }))));

  const results = root.folder('results');
  await results.file('runs.csv', toCsvBlob(runSummaryRows(d.runs, d.results)));
  await results.file('results_all_runs_long.csv', toCsvBlob(resultsLong(d.study, d.runs, d.docs, d.results, { rationale: true, reasoning: true })));
  const agr: Row[] = [];

  // One folder per prompt version.
  const prompts = root.folder('prompts');
  const seen = new Set<number>();
  for (const run of d.runs) {
    if (seen.has(run.snapshot.promptVersion)) continue;
    seen.add(run.snapshot.promptVersion);
    await promptFiles(prompts.folder(`v${run.snapshot.promptVersion}`), run);
  }

  const runsDir = root.folder('runs');
  const folders = runFolders(d.runs);
  for (const run of d.runs) {
    const f = runsDir.folder(folders.get(run.id)!);
    await f.file('run.json', JSON.stringify(run, null, 2));
    const rs = d.results.filter((r) => r.runId === run.id);
    await f.file('results_long.csv', toCsvBlob(resultsLong(d.study, [run], d.docs, rs, { rationale: true, reasoning: true }, d.runs)));
    await f.file('results_wide.csv', toCsvBlob(resultsWide(run, d.docs, d.runs, d.results, { text: false, rationale: true })));
    if (opts.includeLogs) await addRunLogs(f, run, d.docs, d.results);
    agr.push(...agreementRows(agreementForRun(run, d.docs, d.runs, d.results, d.study), runName(run, d.runs)));
  }
  if (agr.length) await results.file('agreement.csv', toCsvBlob(agr));

  const latest = finished[finished.length - 1];
  if (latest) {
    await results.file(`results_${folders.get(latest.id)}.xlsx`, await buildExcel(d, latest, { text: false, rationale: true }));
    await scriptFiles(root.folder('scripts'), d.study, latest, exportedAt, d.runs);
  }
  await root.file('README.md', researchReadme(d, exportedAt, latest, folders, opts));
  return { blob: zip.blob(), name: `${name}.zip` };
}

export interface SupplementaryOptions {
  includeTexts: boolean;
  includeRationales: boolean;
  includeLogs: boolean;
  /** Told the path of each file as it is written. */
  onProgress?: (path: string) => void;
}

export async function buildSupplementary(data: ExportData, run: Run, opts: SupplementaryOptions): Promise<{ blob: Blob; name: string }> {
  const d = inRunOrder(data);
  const exportedAt = nowIso();
  const name = `${slug(d.study.name)}_supplementary_${dateStamp()}`;
  const zip = new ZipWriter(ZIP_LEVEL, opts.onProgress);
  const root = zip.folder(name);
  const rs = d.results.filter((r) => r.runId === run.id);
  const runDocs = d.docs.filter((x) => rs.some((r) => r.docId === x.id));

  const meta = supplementaryMetadata(d, run, exportedAt);
  await root.file('metadata.json', JSON.stringify(meta, null, 2));
  await promptFiles(root.folder('prompt'), run);
  const res = root.folder('results');
  await res.file('results.csv', toCsvBlob(resultsWide(run, runDocs, d.runs, d.results, { text: opts.includeTexts, rationale: opts.includeRationales })));
  await res.file('results_by_replicate.csv', toCsvBlob(resultsLong(d.study, [run], runDocs, rs, { rationale: opts.includeRationales, reasoning: false }, d.runs)));
  // All texts: the run's texts with a label count as labelled even without a usable answer (as in Excel).
  const agr = agreementForRun(run, d.docs, d.runs, d.results, d.study);
  if (agr.length) await res.file('agreement.csv', toCsvBlob(agreementRows(agr, runName(run, d.runs))));
  if (opts.includeTexts) await root.folder('data').file('corpus.csv', toCsvBlob(corpusRows(runDocs, true)));
  if (opts.includeLogs) await addRunLogs(root.folder('logs'), run, runDocs, rs);
  await scriptFiles(root.folder('scripts'), d.study, run, exportedAt, d.runs);
  await root.file('README.md', supplementaryReadme(d, run, meta, agr, opts));
  return { blob: zip.blob(), name: `${name}.zip` };
}

function supplementaryMetadata(d: ExportData, run: Run, exportedAt: string) {
  // Requests and tokens: everything sent (and paid for), also for texts deleted from the study since. Texts: only
  // those still in the study, as in results.csv and the agreement figures.
  const rs = d.results.filter((r) => r.runId === run.id);
  const present = new Set(d.docs.map((x) => x.id));
  const started = rs.map((r) => r.requestedAt).sort();
  const times = rs.map((r) => r.completedAt).sort();
  // Failed attempts that "Retry failed" replaced: from the results, so also those of a retry still being sent.
  const replaced = replacedAttempts(run, rs);
  const sum = (k: keyof Result['usage']) => rs.reduce((s, x) => s + x.usage[k], 0) + (replaced?.usage[k] ?? 0);
  const retry = retriedRequests(run, rs);
  const notes = retryNotes(run, retry);
  const m = run.snapshot.model;
  const ok = rs.filter((r) => r.status === 'ok');
  // A text has a usable label if it has a usable answer; in a plain-text run whose answers give scores as JSON,
  // only if its (combined) answer has a score (not, e.g., a reply in prose).
  const views = buildDocViews(d.docs, d.runs, d.results, run.id);
  const scoreKeys = run.snapshot.prompt.outputMode === 'text' ? comparableFields(run, views.values()).map((f) => f.key) : [];
  const answered = [...new Set(ok.map((r) => r.docId))].filter((id) => present.has(id));
  const hasScores = (id: string) => !scoreKeys.length || scoreKeys.some((k) => fieldValue(run, views.get(id)?.values ?? {}, k) !== '');
  const usable = answered.filter(hasScores);
  // The run's texts without a label, by cause (with the texts answered without scores, they add up to the
  // difference): every request failed, or no result at all (not sent, or no answer recorded: the run was cancelled,
  // stopped or isn't finished, possibly with requests under way; or no answer came back for them).
  const inRun = run.docIds.filter((id) => present.has(id));
  const withResults = new Set(rs.map((r) => r.docId));
  const okDocs = new Set(answered);
  // With several annotations per text: labelled texts with results for only some of them (a run stopped part way
  // through a text), and how many of their requests have no result. (A text whose answers all failed, or gave no
  // scores, has no label: it is counted among the texts without one.)
  const reps = run.snapshot.options.replicates;
  const perText = new Map<string, number>();
  for (const r of rs) perText.set(r.docId, (perText.get(r.docId) ?? 0) + 1);
  const labelled = new Set(usable);
  const partly = inRun.filter((id) => labelled.has(id) && perText.get(id)! < reps);
  // Plain-text runs whose answers give scores as JSON: ok answers without them (e.g. in prose). With several answers
  // per text, such an answer is left out when they are combined, like a failed one, but it still counts as ok.
  const withoutScores = scoreKeys.length ? ok.filter((r) => !flattenJsonResponse(r.values[TEXT_RESPONSE_KEY])).length : 0;
  // Categorical labels combined by majority vote: texts whose vote was tied (kept as "a | b", see aggregate()).
  const prompt = run.snapshot.prompt;
  const voted = prompt.outputMode === 'structured' && run.snapshot.options.replicates > 1 ? prompt.variables.filter((v) => v.type === 'category' || v.type === 'boolean') : [];
  const tied = Object.fromEntries(
    voted.map((v) => [v.name, usable.filter((id) => isTie((views.get(id)?.results ?? []).filter((r) => r.status === 'ok').map((r) => r.values[v.name] ?? ''))).length]),
  );
  return {
    software: { name: 'Annotation Desk', version: __APP_VERSION__, version_used_for_run: run.snapshot.appVersion },
    exported_at: exportedAt,
    study: d.study.name,
    // Notes kept with the study, e.g. how a validation sample was drawn (rule and seed).
    study_notes: d.study.description.trim() || null,
    run: {
      number: run.number,
      // As the tables and README name it ("5-20261022-221754" for runs that share a number), and its id.
      name: String(runName(run, d.runs)),
      id: run.id,
      label: run.label,
      mode: run.mode === 'batch' ? 'batch API' : 'immediate requests',
      batch_id: run.batch ? (run.batch.parts ?? [run.batch]).map((p) => p.batchId).join('; ') : null,
      started_at: run.createdAt,
      // (Null while the run is being sent, also during Retry failed, when the run still has its earlier finish time.)
      finished_at: runInProgress(run) ? null : run.finishedAt,
      // "running" or "submitted": the run was not finished when exported, and this describes the results so far.
      status_when_exported: run.status,
      // (A Retry failed still being sent, or its batch not back yet: the counts are those so far.)
      ...(retryUnderWay(run) ? { retry_in_progress: true } : {}),
    },
    model: {
      provider: m.provider,
      requested: m.model,
      // The usable answers' (a failed one may name another model, e.g. a day-one refusal fallback's, now excluded).
      reported_by_api: [...new Set(ok.map((r) => r.modelReported).filter(Boolean))],
      effort: m.effort || 'model default',
      thinking: m.provider === 'anthropic' ? thinkingLabel(m.model, m.reasoningSummary) : null,
      reasoning_summary_requested: m.reasoningSummary,
      temperature: m.temperature ?? 'model default',
      max_output_tokens: m.maxOutputTokens,
    },
    // (A plain-text run asked for no rationale, whatever its snapshot's hidden codebook setting says.)
    prompt: {
      version: run.snapshot.promptVersion,
      sha256_prefix: run.snapshot.promptHash,
      output_mode: run.snapshot.prompt.outputMode,
      rationale_requested: run.snapshot.prompt.outputMode === 'structured' && run.snapshot.prompt.includeRationale,
    },
    options: { replicates_per_text: run.snapshot.options.replicates, prompt_caching: cachingLabel(run) },
    request_settings: run.snapshot.requestBase,
    corpus: {
      n_texts_in_run: inRun.length,
      n_texts_with_results: inRun.filter((id) => withResults.has(id)).length,
      n_texts_with_usable_labels: usable.length,
      ...(scoreKeys.length ? { n_texts_answer_without_scores: answered.length - usable.length } : {}),
      n_texts_all_requests_failed: inRun.filter((id) => withResults.has(id) && !okDocs.has(id)).length,
      n_texts_without_results: inRun.filter((id) => !withResults.has(id)).length,
      ...(reps > 1 ? { n_texts_partly_annotated: partly.length } : {}),
      ...(voted.length ? { n_texts_with_tied_votes: tied } : {}),
      // Annotated (sent, with a result), then deleted from the study: not in results.csv or the agreement figures.
      n_texts_removed_from_study_since: run.docIds.filter((id) => !present.has(id) && withResults.has(id)).length,
    },
    requests: {
      total: rs.length,
      ok: ok.length,
      failed: rs.filter((r) => r.status === 'error').length,
      parse_errors: rs.filter((r) => r.parseError).length,
      ...(scoreKeys.length ? { answers_without_scores: withoutScores } : {}),
      // Requests of the partly annotated texts with no result (not sent, or no answer recorded).
      ...(reps > 1 ? { without_result_for_partly_annotated_texts: partly.reduce((s, id) => s + reps - perText.get(id)!, 0) } : {}),
      // Requests "Retry failed" sent again (at least this many when retried_note says so).
      retried: retry.requests,
      ...(notes.requests ? { retried_note: notes.requests } : {}),
      // Failed attempts that "Retry failed" replaced: not in the totals above, but in the tokens and the logs.
      replaced_by_retries: replaced?.requests ?? 0,
      first_requested_at: started[0] ?? null,
      last_completed_at: times[times.length - 1] ?? null,
    },
    tokens: {
      input: sum('inputTokens'),
      output: sum('outputTokens'),
      reasoning: sum('reasoningTokens'),
      cache_read: sum('cacheReadTokens'),
      cache_write: sum('cacheWriteTokens'),
      ...(notes.tokens ? { note: notes.tokens } : {}),
    },
  };
}

/** Did a majority vote tie (two or more values with the most votes)? Counted as aggregate() does. */
function isTie(values: string[]): boolean {
  const counts = new Map<string, number>();
  for (const v of values) if (v !== '') counts.set(v, (counts.get(v) ?? 0) + 1);
  const max = Math.max(0, ...counts.values());
  return [...counts.values()].filter((c) => c === max).length > 1;
}

function methodsParagraph(run: Run, meta: ReturnType<typeof supplementaryMetadata>, retry: RetriedRequests): string {
  const m = run.snapshot.model;
  const { total, failed } = meta.requests;
  const c = meta.corpus;
  const noScores = c.n_texts_answer_without_scores ?? 0;
  const withoutScores = meta.requests.answers_without_scores ?? 0;
  const removed = c.n_texts_removed_from_study_since;
  const cached = meta.tokens.cache_read + meta.tokens.cache_write > 0;
  const reps = run.snapshot.options.replicates;
  const dates = [meta.requests.first_requested_at, meta.requests.last_completed_at].filter(Boolean).map((x) => x!.slice(0, 10));
  const period = dates.length ? (dates.length < 2 || dates[0] === dates[1] ? `on ${dates[0]}` : `between ${dates[0]} and ${dates[1]}`) : '';
  const effortName = m.provider === 'anthropic' ? 'effort' : 'reasoning effort';
  const settings = [
    m.effort ? `${effortName} "${m.effort}"` : `the provider's default ${effortName} (not set explicitly)`,
    m.temperature !== null ? `temperature ${m.temperature}` : null,
    `a maximum of ${m.maxOutputTokens.toLocaleString('en-US')} output tokens`,
  ].filter((x): x is string => !!x);
  const w = words(run.snapshot.prompt);
  const settingsText = settings.length > 1 ? `${settings.slice(0, -1).join(', ')} and ${settings[settings.length - 1]}` : settings[0];
  const n = (k: number) => k.toLocaleString('en-US');
  const items = (k: number) => `${n(k)} ${k === 1 ? w.one : w.many}`;
  const was = (k: number) => (k === 1 ? 'was' : 'were');
  const have = (k: number) => (k === 1 ? 'has' : 'have');
  const inProgress = runInProgress(run);
  // A tied majority vote keeps both labels ("a | b"): it matches no single label, so it counts as a disagreement.
  const tied = Object.entries(c.n_texts_with_tied_votes ?? {}).filter(([, k]) => k > 0);
  const label = (name: string) => run.snapshot.prompt.variables.find((v) => v.name === name)?.label?.trim() || name;
  const ties = c.n_texts_with_tied_votes
    ? ` A tied vote is kept as both labels (e.g. “a | b”) and counts as a disagreement in the agreement figures${tied.length ? ` (${tied.map(([f, k], i) => `${i ? n(k) : items(k)} for ${label(f)}`).join(', ')})` : '; no vote was tied'}.`
    : '';
  // Texts with results for only some of their annotations (e.g. the run stopped part way through them): their labels
  // combine fewer answers. Only an immediate run that stopped can have sent requests without recording an answer.
  const partly = c.n_texts_partly_annotated ?? 0;
  const missing = meta.requests.without_result_for_partly_annotated_texts ?? 0;
  // A run left "running" by a closed or reloaded page is stored as cancelled, with an error saying it was interrupted.
  const stopped = run.status === 'cancelled' ? (/^Interrupted\b/.test(run.error ?? '') ? 'interrupted' : 'cancelled') : run.status === 'failed' ? 'stopped' : '';
  const noAnswer = inProgress
    ? 'no result yet'
    : stopped && run.mode !== 'batch'
      ? 'no answer recorded (not sent, or the run stopped before an answer arrived)'
      : 'no result';
  const annotated = partly
    ? `Each ${w.one} was to be annotated ${reps} times, but for ${items(partly)}, ${n(missing)} of ${partly === 1 ? 'its' : 'their'} annotations ${have(missing)} ${noAnswer}, so ${partly === 1 ? 'its labels combine' : 'their labels combine'} fewer answers`
    : `Each ${w.one} was annotated ${reps} times`;
  // The run's texts without a label, by cause; the total once at the end when there is more than one cause.
  const allFailed = c.n_texts_all_requests_failed;
  const notSent = c.n_texts_without_results;
  const unlabelled = c.n_texts_in_run - c.n_texts_with_usable_labels;
  // (Requests under way when an immediate run stopped may have been sent: no answer was recorded for them.)
  const notSentText = inProgress
    ? `${items(notSent)} in the run had no result yet (the run was not finished when this was exported).`
    : stopped
      ? run.mode === 'batch'
        ? `${items(notSent)} in the run ${have(notSent)} no result (the run was ${stopped}).`
        : `${items(notSent)} in the run ${have(notSent)} no answer recorded (not sent, or the run stopped before an answer arrived; the run was ${stopped}).`
      : `No answer was received for ${items(notSent)} in the run.`;
  const causes = [allFailed, noScores, notSent].filter((k) => k > 0).length;
  const failedText = failed
    ? `${n(failed)} of ${n(total)} request${total === 1 ? '' : 's'} did not return a usable annotation (an API error, a refusal or an answer that could not be read) and ${was(failed)} excluded${allFailed ? `, leaving ${items(allFailed)} without a label` : ''}`
    : '';
  // "Retry failed" first, then what failed after it (the counts above are those after every retry; with a retry still
  // under way, those so far). Retries by versions that recorded only the number planned: the requests counted from
  // the stored answers, a lower bound.
  const k = retry.requests;
  const retrying = retryUnderWay(run);
  const retriedAs =
    run.mode !== 'batch' ? '' : retry.asBatch === 'all' ? ' in a new batch' : retry.asBatch === 'none' ? ' as individual requests' : ', individually or in a new batch';
  const howMany = !retry.lowerBound && !retry.interrupted ? `${n(k)} request${k === 1 ? '' : 's'}` : k ? `At least ${n(k)} request${k === 1 ? '' : 's'}` : 'Requests';
  const planned = `the app version used for the run recorded only the number planned for the ${retry.legacy === 1 ? 'retry' : 'retries'} made with it, ${n(retry.planned)}`;
  const u = retry.unanswered;
  const [ni, ns] = [retry.retriesInterrupted, retry.retriesStopped];
  // One parenthesis for every note, joined by semicolons.
  const notes = [
    retry.lowerBound ? (k ? `counted from the stored answers: ${planned}` : `how many is not known: ${planned}, and no stored answer dates from ${retry.legacy === 1 ? 'it' : 'them'}`) : '',
    ni ? `${ni === 1 ? 'a retry was' : `${n(ni)} retries were`} interrupted by the page closing: requests under way then got no recorded answer and are not counted` : '',
    // (Cancel, or a result that could not be saved: sent, so counted, but with no answer.)
    u
      ? `${ns === 1 ? (ni ? 'another retry was' : 'a retry was') : `${n(ns)} ${ni ? 'other ' : ''}retries were`} stopped while ${n(u)} of them ${u === 1 ? 'was' : 'were'} under way: ${u === 1 ? 'it' : 'they'} got no recorded answer`
      : '',
  ].filter(Boolean);
  const legacyNote = notes.length ? ` (${notes.join('; ')})` : '';
  const retryText =
    retrying && !k && !retry.lowerBound && !retry.interrupted
      ? `Requests without a usable answer (failed, or not sent before the run was stopped) were being sent again with identical settings${retriedAs} when this was exported`
      : k || retry.lowerBound || retry.interrupted
        ? `${howMany} without a usable answer (failed, or not sent before the run was stopped) ${k === 1 ? 'was' : 'were'} sent again with identical settings${retriedAs}${legacyNote}${retrying ? ', and the retry was still under way when this was exported' : ''}`
        : '';
  return [
    `${w.Many} (N = ${meta.corpus.n_texts_with_usable_labels.toLocaleString('en-US')}) were annotated with ${m.model} (${m.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API${meta.model.reported_by_api.length ? `; model version reported by the API: ${meta.model.reported_by_api.join(', ')}` : ''}) ${period}, using ${settingsText}.`,
    isEntries(run.snapshot.prompt)
      ? 'No source texts were supplied: the model answered from its own knowledge, given a few identifying details for each entry (see the prompt and the list of entries).'
      : '',
    run.snapshot.prompt.outputMode === 'structured'
      ? `The model was required to return the fields listed in the codebook as JSON conforming to a schema (structured outputs)${run.snapshot.prompt.includeRationale ? ', preceded by a brief rationale' : ''}.`
      : 'The model returned free-text responses.',
    reps > 1
      ? run.snapshot.prompt.outputMode === 'structured'
        ? `${annotated}; categorical labels were aggregated by majority vote, ordinal labels by the median and numeric labels by the mean.${ties}`
        : `${annotated}; numbers in the answers were combined by the median, other values by majority vote.`
      : '',
    retryText ? `${retryText}${failedText ? `; ${retrying ? 'so far' : 'after this'}, ${failedText}` : ''}.` : failedText ? `${failedText}.` : '',
    // Answers without scores: with several per text, left out when combining (n of the ok answers); a text with no
    // answer that has scores is excluded.
    reps > 1 && withoutScores
      ? `${n(withoutScores)} of the ${n(meta.requests.ok)} answers gave no scores (e.g. ${withoutScores === 1 ? 'it was' : 'they were'} written in prose) and ${was(withoutScores)} left out when the answers were combined${noScores ? `; ${items(noScores)} had no answer with scores and ${was(noScores)} excluded` : ''}.`
      : noScores
        ? `${items(noScores)} ${was(noScores)} answered without scores (e.g. in prose) and ${was(noScores)} excluded.`
        : '',
    notSent ? notSentText : '',
    causes > 1 ? `Altogether, ${n(unlabelled)} of the ${items(c.n_texts_in_run)} in the run have no label.` : '',
    removed
      ? `${n(removed)} annotated ${removed === 1 ? w.one : w.many} ${was(removed)} later removed from the study; ${removed === 1 ? 'it is' : 'they are'} not included in N or the agreement figures (${removed === 1 ? 'its' : 'their'} requests remain in the request and token totals and in the per-request results).`
      : '',
    `Requests were sent ${run.mode === 'batch' ? 'through the provider\'s batch API' : 'individually'}${cached ? ' with prompt caching' : ''}. The full prompt, request settings and an executable script are provided in the supplementary material.`,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Why requests sent may have no line in a run's logs (none: complete). Those under way when an immediate run or a retry
 * was stopped (Cancel, a result that could not be saved, the page closing) got no result, so no log, also once a later
 * Retry failed has sent them again (their first stored answer is then the retry's); and versions before October 22,
 * 2026 overwrote the failed attempt a retry replaced.
 */
const LOG_GAPS = [
  'requests under way when a run or a Retry failed was stopped (Cancel, a result that could not be saved, or the page closing) may have been sent but have no line',
  'a version before October 22, 2026 did not keep the failed attempts its Retry failed replaced: they have no line',
];
function logGaps(run: Run, results: Result[], retry: RetriedRequests): string[] {
  // (Retries of a version that overwrote the attempt they replaced look the same as a first answer: not those.)
  const since = (run.retries ?? []).filter((x) => x.counted || !retry.tokensIncomplete).map((x) => x.at).sort()[0];
  const firstStoredByRetry =
    !!since && results.some((r) => r.runId === run.id && ((r.attempt ?? 1) > 1 ? (r.replacedAt?.[0] ?? '') : r.requestedAt) >= since);
  const stopped = retry.unanswered > 0 || retry.interrupted || (run.mode !== 'batch' && (run.status === 'cancelled' || run.status === 'failed' || firstStoredByRetry));
  return LOG_GAPS.filter((_, i) => (i ? retry.tokensIncomplete : stopped));
}

/** The CSVs are written for analysis software, exactly as the values are (not escaped for spreadsheet programs). */
const CSV_NOTE = 'The CSV files are for analysis software: they keep every value exactly as it is (a value starting with =, +, - or @ is not escaped, so a spreadsheet program may read it as a formula).';

function supplementaryReadme(d: ExportData, run: Run, meta: ReturnType<typeof supplementaryMetadata>, agr: ReturnType<typeof agreementForRun>, opts: SupplementaryOptions): string {
  const w = words(run.snapshot.prompt);
  const items = (k: number) => `${k.toLocaleString('en-US')} ${k === 1 ? w.one : w.many}`;
  const withoutScores = meta.requests.answers_without_scores ?? 0;
  const removed = meta.corpus.n_texts_removed_from_study_since;
  const retry = retriedRequests(run, d.results.filter((r) => r.runId === run.id));
  // Retries by a version that recorded only the number planned, or didn't keep the attempts a retry replaced.
  const notes = retryNotes(run, retry);
  const lines = [
    `# ${d.study.name}: LLM annotation materials`,
    '',
    `Supplementary materials for the LLM-based annotation (run #${runName(run, d.runs)}${run.label ? `, "${run.label}"` : ''}), exported from Annotation Desk ${meta.software.version}${meta.software.version_used_for_run !== meta.software.version ? ` (the run was made with ${meta.software.version_used_for_run})` : ''} on ${meta.exported_at.slice(0, 10)}.` +
      // (Runs that share a number: given twice by an earlier version open in two tabs.)
      (sharesNumber(run, d.runs) ? ` Another run of the study has the same number (#${run.number}), given twice by an earlier version open in two tabs: this one is named by its number and when it started (UTC; \`run.started_at\` in metadata.json).` : ''),
    '',
    ...(runInProgress(run)
      ? [
          `**This run was not finished when these materials were exported** (${run.status === 'submitted' ? 'its batch was still being processed' : retryInProgress(run) ? 'Retry failed was still sending requests' : 'it was still running'}): they describe the results so far.`,
          '',
        ]
      : []),
    ...(notes.both ? [notes.both, ''] : []),
    '## Summary',
    '',
    '| | |',
    '|---|---|',
    `| Provider / model | ${meta.model.provider} / \`${meta.model.requested}\` |`,
    `| Model reported by API | ${meta.model.reported_by_api.map((x) => `\`${x}\``).join(', ') || '—'} |`,
    `| Effort / reasoning | ${meta.model.effort} |`,
    `| Temperature | ${meta.model.temperature} |`,
    `| Max output tokens | ${meta.model.max_output_tokens} |`,
    `| ${w.Many} with a usable annotation | ${meta.corpus.n_texts_with_usable_labels} of ${meta.corpus.n_texts_in_run} |`,
    `| Annotations per ${w.one} | ${meta.options.replicates_per_text} |`,
    `| Requests (ok / failed) | ${meta.requests.ok} / ${meta.requests.failed}${withoutScores ? ` (${withoutScores} ok answer${withoutScores === 1 ? '' : 's'} gave no scores and ${withoutScores === 1 ? 'was' : 'were'} left out)` : ''} |`,
    ...(meta.requests.replaced_by_retries > 0
      ? [`| Failed attempts replaced by Retry failed | ${meta.requests.replaced_by_retries} (their tokens are included in the token totals; their logs are kept) |`]
      : []),
    `| Annotation period | ${meta.requests.first_requested_at ?? '—'} to ${meta.requests.last_completed_at ?? '—'} |`,
    `| Prompt version / hash | v${meta.prompt.version} / \`${meta.prompt.sha256_prefix}\` |`,
    '',
  ];
  if (agr.length) {
    const ci = (x: [number, number] | null | undefined, pct = false) =>
      x ? ` [${pct ? (x[0] * 100).toFixed(1) : fixed(x[0], 2)}, ${pct ? (x[1] * 100).toFixed(1) : fixed(x[1], 2)}]` : '';
    lines.push(
      '## Agreement with human labels',
      '',
      '| Field | Annotations | Compared with | N compared (of labelled) | % agreement | Cohen\'s κ | Krippendorff\'s α | Gwet\'s AC1 |',
      '|---|---|---|---|---|---|---|---|',
    );
    // Categories with a numeric codebook (e.g. codes 1 to 5) are judged on its range, like a scale (see `agreement`).
    const notCategory = (s: Agreement) => s.level === 'nominal' && !s.leftOut.range;
    for (const a of agr) {
      const s = a.stats;
      lines.push(
        `| ${a.field} | ${a.source === 'model' ? 'model' : a.source} | ${a.compared_with} | ${s.n} (of ${a.nLabelled}${s.leftOut.n ? `; ${s.leftOut.n} ${notCategory(s) ? 'not a category' : 'not on the scale'}` : ''}) | ${s.percentAgreement === null ? '—' : (s.percentAgreement * 100).toFixed(1) + '%' + ci(s.ci.percentAgreement, true)} | ${fmtStat(s.cohenKappa)}${ci(s.ci.cohenKappa)} | ${fmtStat(s.krippendorffAlpha)}${ci(s.ci.krippendorffAlpha)} (${s.level}) | ${fmtStat(s.gwetAC1)}${ci(s.ci.gwetAC1)} |`,
      );
    }
    // The run's texts with no result (not sent, or no answer came back) that have a label in a compared column: they
    // count as labelled (and in the human–human rows), but results.csv and data/corpus.csv leave them out. (A
    // missing-value marker such as "NA" is no label, as in the figures.)
    const sentIds = new Set(d.results.filter((r) => r.runId === run.id).map((r) => r.docId));
    const inRunIds = new Set(run.docIds);
    const { fields, pairs } = labelPairs(run, d.docs, d.runs, d.results, d.study);
    const fieldOf = new Map(fields.map((f) => [f.key, f]));
    const hasLabel = (x: Doc) => pairs.some((p) => labelValue(x.meta[p.column], fieldOf.get(p.field)!) !== '');
    const labelledNoResult = d.docs.filter((x) => inRunIds.has(x.id) && !sentIds.has(x.id) && hasLabel(x)).length;
    const humanRows = agr.some((a) => a.source !== 'model');
    lines.push(
      '',
      `Brackets: 95% bootstrap intervals (2,000 resamples of ${w.many}). “Of labelled”: this run’s ${w.many} with a value in the “Compared with” column (a missing-value marker such as NA counts as no value). Not compared: ${w.many} without a usable value under Annotations (no usable model answer, or no label in that column), and pairs with a value that doesn’t fit the field: not a number, or outside the scale (${run.snapshot.prompt.outputMode === 'text' ? 'for scores in plain-text answers whose values all lie within −10…10, a rating scale: more than 3 points, or half the range of the model’s scores if more, beyond that range and the labels near it; with larger numbers, e.g. percentages or years, no number is left out' : 'the codebook’s'}), e.g. a word or 99 (“not on the scale”)${agr.some((a) => notCategory(a.stats)) ? ', or not one of the codebook’s categories (“not a category”)' : ''}. Their number is n_left_out_not_on_scale in agreement.csv.` +
        (humanRows
          ? ` Rows with a column name under Annotations compare two human label columns (human–human baseline) on this run’s ${w.many}, as the model rows are, also those without a usable model answer.`
          : '') +
        (labelledNoResult
          ? ` ${items(labelledNoResult)} of this run with labels ${labelledNoResult === 1 ? 'has' : 'have'} no result (not sent, or no answer came back): ${labelledNoResult === 1 ? 'its labels count' : 'their labels count'} as labelled${humanRows ? ' and in the human–human rows' : ''}, but ${labelledNoResult === 1 ? 'it is' : 'they are'} not in this package.`
          : ''),
      '',
    );
  }
  lines.push(
    '## Methods text (draft)',
    '',
    '> ' + methodsParagraph(run, meta, retry),
    '',
    'Edit as needed; check every detail against `metadata.json`.',
    '',
    '## Files',
    '',
    '| File | Contents |',
    '|---|---|',
    '| `metadata.json` | Machine-readable record of model, settings, dates, counts and token use |',
    `| \`prompt/prompt.txt\` | The prompt sent with each ${w.one}; \`{{text}}\` marks where ${w.one === 'entry' ? 'the entry’s details were' : 'the text was'} inserted |`,
    ...(run.snapshot.prompt.system.trim() ? ['| `prompt/system_prompt.txt` | System prompt sent with every request |'] : []),
    ...(run.snapshot.prompt.outputMode === 'structured'
      ? ['| `prompt/output_schema.json` | JSON schema the responses had to follow |', '| `prompt/codebook.md`, `codebook.json` | Annotation fields, types and allowed values |']
      : ['| `prompt/codebook.md` | Says that the model returned free text: there were no fields and no output schema |']),
    `| \`results/results.csv\` | One row per ${w.one}${opts.includeTexts ? ` (with ${w.one === 'entry' ? 'its details' : 'text'})` : ''}: metadata and annotations${run.snapshot.options.replicates > 1 ? ' (aggregated across replicates)' : ''} |`,
    `| \`results/results_by_replicate.csv\` | One row per request, with status, tokens and timing${removed ? `; also the requests for the ${items(removed)} removed from the study since, marked “(deleted …)”` : ''} |`,
  );
  if (agr.length) lines.push('| `results/agreement.csv` | Agreement statistics |');
  if (opts.includeTexts) lines.push(`| \`data/corpus.csv\` | The annotated ${w.many} and their metadata |`);
  if (opts.includeLogs) {
    const gaps = logGaps(run, d.results, retry);
    lines.push(
      `| \`logs/requests.jsonl\`, \`responses.jsonl\` | Every request body and full API response${gaps.length ? ` stored; ${gaps.join('; ')}` : ''}${meta.requests.replaced_by_retries > 0 ? `; a request that Retry failed sent again has a line for each ${gaps.length ? 'stored ' : ''}attempt (same doc_id and replicate; attempt 1, 2, …), and the response line of an earlier, replaced attempt also gives its status, error and parse_error` : ''} |`,
    );
  }
  lines.push(
    '| `scripts/annotate.py` | Python script reproducing the requests (values inserted) |',
    '| `scripts/annotate_template.py` | The same script with `{{PLACEHOLDERS}}` marking every study-specific value |',
    '| `scripts/requirements.txt` | Python package the script needs (install with `pip install -r requirements.txt`) |',
    '',
    CSV_NOTE,
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
  if (!opts.includeTexts) lines.push(`The annotated ${w.many} are not included in this package (e.g. for copyright or privacy reasons).`, '');
  return lines.join('\n');
}

function researchReadme(d: ExportData, exportedAt: string, latest: Run | undefined, folders: Map<string, string>, opts: ResearchOptions): string {
  const w = words(d.study.prompt);
  const rows: [string, string][] = [
    ['`study.json`', 'Current study settings (model, prompt, fields, options)'],
    ['`study-backup.json`', `Backup (settings, ${w.many}, runs, results; without the request/response logs${opts.includeLogs ? ', which are under `runs/`' : ''}), re-importable via Studies → Import study backup`],
    ['`corpus/corpus.csv`, `corpus.jsonl`', `All ${w.many} with metadata`],
    ['`prompts/vN/`', 'Each prompt version: prompt, system prompt (if used), codebook, and for structured output the output schema and codebook.json'],
    ['`runs/run-NN/run.json`', 'Frozen run configuration (model, settings, prompt, exact shared request body)'],
    ['`runs/run-NN/results_long.csv`', 'One row per request: annotations, rationale, reasoning summary, status, tokens, timing'],
    ['`runs/run-NN/results_wide.csv`', `One row per ${w.one}: aggregated annotations`],
  ];
  if (opts.includeLogs) {
    const all = d.runs.flatMap((r) => {
      const rs = d.results.filter((x) => x.runId === r.id);
      return logGaps(r, rs, retriedRequests(r, rs));
    });
    const gaps = LOG_GAPS.filter((g) => all.includes(g));
    rows.push([
      '`runs/run-NN/requests.jsonl`, `responses.jsonl`',
      `${gaps.length ? `Every request body sent and raw API response stored; ${gaps.join('; ')}` : 'Every request body sent and every raw API response'}; a request that Retry failed sent again has a line for each ${gaps.length ? 'stored ' : ''}attempt (same doc_id and replicate; \`attempt\` 1, 2, …), and the response line of an earlier, replaced attempt also gives its status, error and parse_error`,
    ]);
  }
  rows.push(
    ['`results/runs.csv`', 'Overview of all runs'],
    ['`results/results_all_runs_long.csv`', 'All responses from all runs in one table'],
    ['`results/agreement.csv`', 'Agreement between model fields and matching metadata columns (only if such columns exist)'],
  );
  if (latest) {
    rows.push([`\`results/results_${folders.get(latest.id)}.xlsx\``, 'Excel workbook for the latest run']);
    rows.push([
      '`scripts/`',
      `Python script reproducing run #${runName(latest, d.runs)} (\`annotate.py\`) and its template with placeholders. \`corpus/corpus.csv\` holds every ${w.one} in the study: to reproduce that run, use its ${w.many} (the doc_ids in \`runs/${folders.get(latest.id)}/results_long.csv\`)`,
    ]);
  }
  // Runs that share a number (given by earlier versions in two tabs): their folders and run names end in when the run
  // started.
  const shared = d.runs.filter((r) => sharesNumber(r, d.runs));
  return [
    `# ${d.study.name}: research repository`,
    '',
    `Complete record of this annotation study, exported from Annotation Desk ${__APP_VERSION__} on ${exportedAt}.`,
    '',
    `- ${d.docs.length.toLocaleString('en-US')} ${w.many}, ${d.runs.length} run(s), ${d.results.length.toLocaleString('en-US')} model responses.`,
    '- API keys are never stored or exported.',
    '',
    '## Layout',
    '',
    '| Path | Contents |',
    '|---|---|',
    ...rows.map(([a, b]) => `| ${a} | ${b} |`),
    '',
    ...(shared.length
      ? [
          `Some runs share a number (${[...new Set(shared.map((r) => `#${r.number}`))].join(', ')}; given twice by an earlier version when the app was open in two tabs): each one’s folder, and its name in the tables’ \`run\` column (e.g. ${runName(shared[0], d.runs)}), ends in when it started (UTC; \`createdAt\` in its run.json, \`started_at\` in results/runs.csv).`,
          '',
        ]
      : []),
    ...(latest ? [`${CSV_NOTE} To read the results in Excel, open the .xlsx workbook instead.`, ''] : [CSV_NOTE, '']),
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
  /** Told how far the slow part (the bootstrap intervals) has got, e.g. "field 2 of 5". */
  onProgress?: (note: string) => void,
): Promise<Blob> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const w = words(runA.snapshot.prompt);
  const viewsA = buildDocViews(docs, runs, results, runA.id);
  const viewsB = buildDocViews(docs, runs, results, runB.id);
  const fieldsB = new Map(comparableFields(runB, viewsB.values()).map((f) => [f.key, f]));
  // Plain-text scores: the range seen in either run, so the figures don't depend on which run is first.
  const fields = comparableFields(runA, viewsA.values()).flatMap((f) => (fieldsB.has(f.key) ? [combineFields(f, fieldsB.get(f.key))] : []));
  // Texts annotated in both runs: with a result (usable or failed) in each, not those a run never sent (e.g. one
  // cancelled or stopped part way).
  const sent = (views: typeof viewsA, run: Run) => new Set(run.docIds.filter((id) => views.has(id) && views.get(id)!.status !== 'none'));
  const [sentA, sentB] = [sent(viewsA, runA), sent(viewsB, runB)];
  const both = docs.filter((d) => sentA.has(d.id) && sentB.has(d.id));
  const name = (r: Run) => `${r.snapshot.model.model} (run #${runName(r, runs)})`;
  // For the Notes: a run with texts it never sent (cancelled, stopped or not finished); they are not compared.
  const unsentNote = (run: Run, sentSet: Set<string>) => {
    const own = new Set(run.docIds);
    const total = docs.filter((d) => own.has(d.id)).length;
    const missing = total - sentSet.size;
    return missing > 0
      ? [{ note: `Run #${runName(run, runs)} has no result for ${missing.toLocaleString('en-US')} of its ${total.toLocaleString('en-US')} ${w.many} (e.g. the run was cancelled, stopped or not finished); they are not compared.` }]
      : [];
  };
  // A run still being sent, or its batch (or that of its Retry failed) not back yet: the figures are those so far.
  const unfinished = (r: Run) =>
    !runInProgress(r) ? '' : r.status === 'submitted' ? (retryUnderWay(r) ? 'its Retry failed batch was still being processed' : 'its batch was still being processed') : retryInProgress(r) ? 'Retry failed was still sending requests' : 'it was still running';
  const unfinishedNote = (run: Run) =>
    unfinished(run) ? [{ note: `Run #${runName(run, runs)} was not finished when this report was made (${unfinished(run)}): the figures are those of its results so far and may change once it is done.` }] : [];

  // Per field: the texts with a usable value in both runs.
  const compared = fields.map((f, i) => {
    onProgress?.(`field ${i + 1} of ${fields.length}`);
    const items: { doc: Doc; x: string; y: string }[] = [];
    for (const d of both) {
      const va = viewsA.get(d.id)!;
      const vb = viewsB.get(d.id)!;
      const x = normalizeLabel(fieldValue(runA, va.values, f.key), f.yesNo);
      const y = normalizeLabel(fieldValue(runB, vb.values, f.key), f.yesNo);
      if (x && y) items.push({ doc: d, x, y });
    }
    const all = agreement(items.map((i) => i.x), items.map((i) => i.y), f.level, f.allowed, tolerance, { scaleSeen: f.scaleSeen, range: f.range });
    // Shared zeros ("no evaluation" from both runs) inflate agreement: also report texts where at least one run is non-zero.
    const zeroOnScale = all.meanDifference !== null && (f.allowed.includes('0') || items.some((i) => i.x === '0' || i.y === '0'));
    const nz = items.filter((i) => i.x !== '0' || i.y !== '0');
    // Only when some texts got 0 from both runs; otherwise the row would repeat the one above.
    const nonZero = zeroOnScale && nz.length < items.length ? agreement(nz.map((i) => i.x), nz.map((i) => i.y), f.level, f.allowed, tolerance, { scaleSeen: f.scaleSeen, range: f.range }) : null;
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
    ...(s.leftOut.n ? { n_left_out_not_on_scale: s.leftOut.n } : {}),
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
      draft_text: comparisonSentence(f.label, name(runA), name(runB), all, both.length, w) + (nonZero ? ' ' + nonZeroSentence(nonZero, w) : ''),
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
  const isNum = (v: string) => v.trim() !== '' && !Number.isNaN(Number(v));
  const review = compared.flatMap(({ f, items, all }) => {
    const numeric = all.meanDifference !== null;
    // Scores left out of the statistics (n_left_out_not_on_scale): not a number (e.g. "NA") or off the scale they were
    // measured on (the codebook's; for plain-text scores, the range of the answers as the statistics grew it).
    const range = all.leftOut.range;
    const onScale = (v: string) => isNum(v) && (!range || (Number(v) >= range[0] - 1e-9 && Number(v) <= range[1] + 1e-9));
    return items.map(({ doc, x, y }) => {
      const leftOut = numeric && all.leftOut.n > 0 && !(onScale(x) && onScale(y));
      const diff = numeric && !leftOut ? Number(y) - Number(x) : null;
      const mid = all.midpoint;
      const opposite = numeric && mid !== null && ((Number(x) < mid && Number(y) > mid) || (Number(x) > mid && Number(y) < mid));
      // By the size of the difference, as in the Summary (2 or more points; within 1 point). Combined labels from an
      // even number of answers can be half points: 0.5 is "less than 1 point", 1.5 "between 1 and 2 points".
      const size = diff === null ? null : Math.abs(diff);
      const category = leftOut
        ? (isNum(x) && isNum(y) ? 'not on the scale' : 'not a number')
        : x === y ? (numeric ? (Number(x) === 0 ? 'agree (zero)' : 'agree (non-zero)') : 'agree')
          : opposite ? 'opposite direction'
            : size === null ? 'differ'
              : size >= 2 - 1e-9 ? '2+ points' : size > 1 + 1e-9 ? 'between 1 and 2 points' : size >= 1 - 1e-9 ? '1 point' : 'less than 1 point';
      return {
        doc,
        row: {
          file: doc.meta.file ?? doc.docId,
          field: f.label,
          // A value that isn't a number (left out): as the run wrote it.
          first: numeric ? (isNum(x) ? Number(x) : fieldValue(runA, viewsA.get(doc.id)!.values, f.key).trim()) : x,
          second: numeric ? (isNum(y) ? Number(y) : fieldValue(runB, viewsB.get(doc.id)!.values, f.key).trim()) : y,
          difference: diff,
          category,
          first_explanation: reasoningOf(runA, viewsA.get(doc.id)!.values, viewsA.get(doc.id)!.rationale, f.key),
          second_explanation: reasoningOf(runB, viewsB.get(doc.id)!.values, viewsB.get(doc.id)!.rationale, f.key),
          // Sort by category, then by this column, to draw a reproducible random selection within a category.
          random: stableRandom(`${doc.meta.file ?? doc.docId}|${f.key}`),
          judgment: '',
          note: '',
        },
      };
    });
  });
  const rank: Record<string, number> = { 'opposite direction': 0, '2+ points': 1, differ: 1, 'between 1 and 2 points': 2, '1 point': 2, 'less than 1 point': 2, agree: 3, 'agree (non-zero)': 3, 'agree (zero)': 4, 'not on the scale': 5, 'not a number': 5 };
  review.sort((p, q) => rank[p.row.category] - rank[q.row.category] || Math.abs(q.row.difference ?? 0) - Math.abs(p.row.difference ?? 0));

  // Exploratory: the same figures per group (e.g. per era); small groups give wide intervals.
  const groups = groupBy ? [...new Set(both.map((d) => d.meta[groupBy] ?? ''))].sort((p, q) => p.localeCompare(q, undefined, { numeric: true })) : [];
  const byGroup = compared.flatMap(({ f, items }, i) => {
    if (groups.length) onProgress?.(`by ${groupBy}, field ${i + 1} of ${compared.length}`);
    return groups.map((g) => {
      const sub = items.filter((x) => (x.doc.meta[groupBy] ?? '') === g);
      const { field, texts: _t, ...rest } = summaryRow(f.label, '', agreement(sub.map((x) => x.x), sub.map((x) => x.y), f.level, f.allowed, tolerance, { scaleSeen: f.scaleSeen, range: f.range }));
      return { g, field, rest: { ...rest, n_texts_in_both_runs: both.filter((d) => (d.meta[groupBy] ?? '') === g).length } };
    });
  });
  // A breakdown column named like one of the report's own columns (e.g. "field" or "level") gets a prefix, so
  // neither overwrites the other. (Sheet name and notes keep its own name.)
  const own = new Set([
    ...review.flatMap((r) => Object.keys(r.row)),
    ...compared.flatMap(({ f, all }) => Object.keys(summaryRow(f.label, '', all))),
    ...byGroup.flatMap((r) => Object.keys(r.rest)),
  ]);
  const groupCol = own.has(groupBy) ? `group_${groupBy}` : groupBy;
  addSheet(
    wb,
    'Review',
    review.map(({ doc, row: { file, field, ...rest } }) => ({ file, field, ...(groupBy ? { [groupCol]: doc.meta[groupBy] ?? '' } : {}), ...rest })),
  );
  if (groupBy) addSheet(wb, sheetName(wb, `By ${groupBy}`), byGroup.map(({ g, field, rest }) => ({ field, [groupCol]: g || '(none)', ...rest })));

  // The run's texts still in the study, as in the Notes, and those of them with a result (usable or failed).
  const present = new Set(docs.map((d) => d.id));
  const removedSince = (r: Run) => r.docIds.filter((id) => !present.has(id)).length;
  const removed = removedSince(runA) + removedSince(runB) > 0;
  const settings = (r: Run): Record<string, string> => ({
    run: `#${runName(r, runs)}${r.label ? ` (${r.label})` : ''}`,
    provider: r.snapshot.model.provider,
    model: r.snapshot.model.model,
    model_reported_by_api: [...new Set(results.filter((x) => x.runId === r.id && x.status === 'ok').map((x) => x.modelReported).filter(Boolean))].join(', '),
    effort: r.snapshot.model.effort || 'model default',
    max_output_tokens: String(r.snapshot.model.maxOutputTokens),
    prompt_version: `v${r.snapshot.promptVersion} (${r.snapshot.promptHash})`,
    mode: r.mode === 'batch' ? 'batch API' : 'immediate requests',
    started: r.createdAt,
    status: unfinished(r) ? `not finished: ${unfinished(r)}` : r.status,
    texts_in_run: String(r.docIds.length - removedSince(r)),
    texts_with_results: String((r === runA ? sentA : sentB).size),
    ...(removed ? { texts_removed_from_study_since: String(removedSince(r)) } : {}),
    annotations_per_text: String(r.snapshot.options.replicates),
    app_version: r.snapshot.appVersion,
  });
  const sa = settings(runA);
  const sb = settings(runB);
  addSheet(wb, 'Runs', Object.keys(sa).map((k) => ({ setting: k, first: sa[k], second: sb[k] })));

  // One confusion table per field (rows: first run, columns: second run); skipped for long numeric scales.
  for (const { f, all } of compared) {
    if (all.categories.length < 2 || all.categories.length > 15) continue;
    const sheet = sheetName(wb, `Table ${f.label}`);
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
    { note: `Exported from Annotation Desk ${__APP_VERSION__} on ${nowIso().slice(0, 10)}${runA.snapshot.appVersion === runB.snapshot.appVersion ? `; both runs were made with ${runA.snapshot.appVersion}` : `; the runs were made with ${runA.snapshot.appVersion} and ${runB.snapshot.appVersion}`}.` },
    { note: `First: ${name(runA)}. Second: ${name(runB)}. ${w.Many} compared: those annotated in both runs with a usable value for the field.` },
    ...unsentNote(runA, sentA),
    ...unsentNote(runB, sentB),
    ...unfinishedNote(runA),
    ...unfinishedNote(runB),
    { note: `Exact agreement: share of ${w.many} with the same value.${tolerance > 0 ? ` Within ${tolerance} point${tolerance === 1 ? '' : 's'}: share whose scores differ by at most that much.` : ''} Differ by 2 or more points and opposite direction (one below the scale midpoint, the other above): serious disagreements.` },
    { note: `"At least one non-zero" rows repeat the statistics on ${w.many} where at least one run gave a score other than 0, because shared zeros inflate agreement.` },
    { note: 'Weighted kappa (linear or quadratic weights by the distance between values over the codebook scale; plain-text runs: over the range of scores seen in either run), Gwet\'s AC2 (linear weights) and Krippendorff\'s alpha give partial credit for near misses; Cohen\'s kappa and Gwet\'s AC1 treat values as categories. AC1/AC2 stay stable when one score (e.g. 0) dominates, where kappa can drop sharply.' },
    { note: 'Mean difference = second minus first (positive: the second run scores higher on average). Mean absolute difference: average distance regardless of direction.' },
    { note: `Brackets / _ci_low and _ci_high: 95% bootstrap intervals (2,000 resamples of ${w.many}, fixed seed, so the same data gives the same interval).` },
    { note: 'Review sheet: every compared score, opposite directions first, then the largest differences. To draw at random within a category (e.g. 30 opposite-direction cases), sort by category and then by "random", and take the first rows; the numbers never change, so the draw is reproducible. The judgment and note columns are for your own labels.' },
    ...(review.some((r) => rank[r.row.category] === 5) ? [{ note: 'Review sheet, last rows: scores left out of the statistics (“not a number”, e.g. NA, or “not on the scale”), with the values as the runs gave them.' }] : []),
    ...(groupBy ? [{ note: `"By ${groupBy}" sheet: the same figures per ${groupBy}; exploratory, as small groups give wide intervals.` }] : []),
  ]);
  const out = await wb.xlsx.writeBuffer();
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
const num2 = (x: number | null) => (x === null ? '—' : fixed(x, 2));

/** Draft sentence for a paper describing how well two runs agree on one field. */
export function comparisonSentence(label: string, a: string, b: string, s: Agreement, nBoth: number, w = words({})): string {
  if (!s.n) return `No ${w.many} had a usable value for ${label} in both runs.`;
  const ciP = (k: CiStat) => (s.ci[k] ? ` (95% CI ${pct(s.ci[k]![0])}–${pct(s.ci[k]![1])})` : '');
  const ciN = (k: CiStat) => (s.ci[k] ? ` [${num2(s.ci[k]![0])}, ${num2(s.ci[k]![1])}]` : '');
  const n = `N = ${s.n.toLocaleString('en-US')}${s.n < nBoth ? ` of ${nBoth.toLocaleString('en-US')} ${w.many} annotated in both runs` : ''}`;
  if (s.meanDifference === null) {
    return `For ${label}, ${a} and ${b} gave the same label for ${pct(s.percentAgreement)} of ${w.many}${ciP('percentAgreement')}; Cohen's κ = ${num2(s.cohenKappa)}${ciN('cohenKappa')}, Krippendorff's α = ${num2(s.krippendorffAlpha)}${ciN('krippendorffAlpha')} (${n}).`;
  }
  const within = s.tolerance > 0 && s.withinTolerance !== null ? ` and scores within ${s.tolerance} point${s.tolerance === 1 ? '' : 's'} for ${pct(s.withinTolerance)}${ciP('withinTolerance')}` : '';
  const serious = ` Scores differed by 2 or more points for ${pct(s.largeDifference)} of ${w.many}${s.oppositeDirection !== null ? ` and in direction for ${pct(s.oppositeDirection)}` : ''}.`;
  const kappa = s.weightedKappaLinear !== null ? `linear-weighted κ = ${num2(s.weightedKappaLinear)}${ciN('weightedKappaLinear')}, ` : '';
  const first = `For ${label}, ${a} and ${b} gave identical scores for ${pct(s.percentAgreement)} of ${w.many}${ciP('percentAgreement')}${within}; ${kappa}linear-weighted Gwet's AC2 = ${num2(s.gwetAC2Linear)}${ciN('gwetAC2Linear')}, Krippendorff's α (${s.level}) = ${num2(s.krippendorffAlpha)}${ciN('krippendorffAlpha')} (${n}).`;
  const d = s.meanDifference;
  const ci = s.ci.meanDifference;
  const shift =
    ci && (ci[0] > 0 || ci[1] < 0)
      ? ` ${b} scored on average ${fixed(Math.abs(d), 2)} points ${d > 0 ? 'higher' : 'lower'} than ${a} (95% CI ${fixed(ci[0], 2)} to ${fixed(ci[1], 2)}).`
      : ` There was no clear systematic difference between the two (mean difference ${fixed(d, 2)}${ci ? `, 95% CI ${fixed(ci[0], 2)} to ${fixed(ci[1], 2)}` : ''}).`;
  return first + serious + shift;
}

/** The same figures on texts where at least one run gave a non-zero score. */
function nonZeroSentence(s: Agreement, w: ReturnType<typeof words>): string {
  if (!s.n) return `No ${w.one} received a non-zero score from either run.`;
  return `On the ${s.n.toLocaleString('en-US')} ${w.many} where at least one run gave a non-zero score, exact agreement was ${pct(s.percentAgreement)}, linear-weighted κ = ${num2(s.weightedKappaLinear)} and AC2 = ${num2(s.gwetAC2Linear)}.`;
}
