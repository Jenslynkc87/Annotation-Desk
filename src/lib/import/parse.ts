import Papa from 'papaparse';

export interface ParsedText {
  name: string;
  text: string;
}

export interface ParsedTable {
  name: string;
  columns: string[];
  rows: Record<string, string>[];
  /** Rows that didn't split into as many values as there are columns (shown before importing). */
  problems?: string[];
}

export type ParsedFile =
  | { kind: 'text'; file: ParsedText }
  | { kind: 'table'; table: ParsedTable }
  | { kind: 'error'; name: string; error: string };

export const ACCEPTED_EXTENSIONS = [
  '.txt', '.md', '.html', '.htm', '.pdf', '.docx',
  '.csv', '.tsv', '.xlsx', '.xls', '.ods', '.json', '.jsonl',
];

function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

export function baseName(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function tableFromObjects(name: string, objs: unknown[]): ParsedTable {
  const columns: string[] = [];
  const rows = objs
    .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o))
    .map((o) => {
      const row: Record<string, string> = {};
      for (const [k, v] of Object.entries(o)) {
        if (!columns.includes(k)) columns.push(k);
        row[k] = cell(v);
      }
      return row;
    });
  return { name, columns, rows };
}

async function pdfText(buf: ArrayBuffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = '';
    const lines: string[] = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = '';
      }
    }
    if (line) lines.push(line);
    pages.push(lines.join('\n'));
  }
  return pages.join('\n\n').replace(/[ \t]+\n/g, '\n').trim();
}

export async function parseFile(file: File): Promise<ParsedFile> {
  const e = ext(file.name);
  try {
    switch (e) {
      // Plain-text and Word files are kept exactly as written (no trimming).
      case '.txt':
      case '.md':
        return { kind: 'text', file: { name: file.name, text: await file.text() } };
      case '.html':
      case '.htm': {
        const doc = new DOMParser().parseFromString(await file.text(), 'text/html');
        doc.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
        const text = (doc.body?.innerText ?? doc.body?.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
        return { kind: 'text', file: { name: file.name, text } };
      }
      case '.pdf': {
        const text = await pdfText(await file.arrayBuffer());
        if (!text) return { kind: 'error', name: file.name, error: 'No extractable text (scanned PDF? OCR is not supported).' };
        return { kind: 'text', file: { name: file.name, text } };
      }
      case '.docx': {
        const mammoth = (await import('mammoth/mammoth.browser.js')).default;
        const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
        return { kind: 'text', file: { name: file.name, text: value } };
      }
      case '.csv':
      case '.tsv': {
        return { kind: 'table', table: readDelimited(file.name, await file.text(), e === '.tsv' ? '\t' : '') };
      }
      case '.xlsx':
      case '.xls':
      case '.ods': {
        const XLSX = await import('xlsx');
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellNF: true });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        // Cells shown as typed (dates, percentages), except plain numbers: Excel's "General" display would turn
        // 9783161484100 into "9.78316E+12" and cut decimals, so those keep every digit.
        for (const [ref, cell] of Object.entries(sheet)) {
          // (15 significant digits, as Excel keeps them: a formula's 0.30000000000000004 shows as 0.3.)
          if (!ref.startsWith('!') && cell?.t === 'n' && cell.z === 'General' && Number.isFinite(cell.v)) cell.w = String(Number(cell.v.toPrecision(15)));
        }
        const objs = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
        return { kind: 'table', table: tableFromObjects(file.name, objs) };
      }
      case '.json': {
        const data = JSON.parse(await file.text());
        const arr = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : null;
        if (!arr) return { kind: 'error', name: file.name, error: 'Expected a JSON array of objects.' };
        return { kind: 'table', table: tableFromObjects(file.name, arr) };
      }
      case '.jsonl': {
        const objs = (await file.text())
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l));
        return { kind: 'table', table: tableFromObjects(file.name, objs) };
      }
      default:
        return { kind: 'error', name: file.name, error: `Unsupported file type "${e || 'none'}".` };
    }
  } catch (err) {
    return { kind: 'error', name: file.name, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A CSV/TSV table; the first row holds the column names. `delimiter` '' = detect. */
function readDelimited(name: string, text: string, delimiter: string): ParsedTable {
  const res = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: 'greedy', delimiter });
  const lines = res.errors.filter((x) => x.type === 'FieldMismatch').map((x) => (x.row ?? 0) + 2);
  const problems = lines.length
    ? [
        `${lines.length} row${lines.length === 1 ? ' has' : 's have'} more or fewer values than there are column names (line ${lines.slice(0, 5).join(', ')}${lines.length > 5 ? ', …' : ''}). ` +
          'A value with a comma in it (e.g. Smith, John) must be in "quotes", or copy the rows from Excel or Word instead.',
      ]
    : [];
  const columns = (res.meta.fields ?? []).filter((c) => c.trim() !== '');
  const rows = res.data.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? ''])));
  return { name, columns, rows, problems };
}

/**
 * A table pasted as text: rows copied from Excel or a Word table (columns separated by tabs) or typed with
 * commas, the column names in the first row.
 */
export function parsePastedTable(text: string): ParsedTable {
  const t = readDelimited('pasted', text.trim(), text.includes('\t') ? '\t' : '');
  if (t.rows.length && t.columns.length < 2) t.problems = [...(t.problems ?? []), 'Only one column was found: separate the columns with tabs (copy from Excel or Word) or commas.'];
  return t;
}

/** Guess which column holds the text: the one with the longest average content. */
export function guessTextColumn(t: ParsedTable): string {
  const pref = t.columns.find((c) => /^(text|content|body|document|conversation|paragraph|response)$/i.test(c));
  if (pref) return pref;
  let best = t.columns[0] ?? '';
  let bestLen = -1;
  for (const c of t.columns) {
    const sample = t.rows.slice(0, 50);
    const avg = sample.reduce((s, r) => s + (r[c]?.length ?? 0), 0) / Math.max(1, sample.length);
    if (avg > bestLen) {
      bestLen = avg;
      best = c;
    }
  }
  return best;
}

/** A table of short values only (names, years, places), not one with a column of texts: likely one entry per row. */
export function looksLikeEntries(t: ParsedTable): boolean {
  const sample = t.rows.slice(0, 50);
  return t.columns.length > 1 && t.columns.every((c) => sample.reduce((s, r) => s + (r[c]?.length ?? 0), 0) / Math.max(1, sample.length) < 200);
}

/** A row as the model reads it when it describes an entry: "column: value" for the chosen columns, empty ones left out. */
export function describeRow(row: Record<string, string>, columns: string[]): string {
  return columns
    .map((c) => [c, (row[c] ?? '').trim()])
    .filter(([, v]) => v)
    .map(([c, v]) => `${c}: ${v}`)
    .join('\n');
}

export function guessIdColumn(t: ParsedTable): string {
  return t.columns.find((c) => /^(id|doc_?id|text_?id|item_?id|uid|key)$/i.test(c)) ?? '';
}

/** Split pasted text into items. */
export function splitPasted(text: string, mode: 'none' | 'blank' | 'line'): string[] {
  const t = text.replace(/\r\n/g, '\n').trim();
  if (!t) return [];
  if (mode === 'none') return [t];
  const parts = mode === 'blank' ? t.split(/\n\s*\n/) : t.split('\n');
  return parts.map((p) => p.trim()).filter(Boolean);
}
