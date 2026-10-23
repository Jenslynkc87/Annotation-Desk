import Papa from 'papaparse';
import { toNumber } from '../prompt';

export interface ParsedText {
  name: string;
  text: string;
}

export interface ParsedTable {
  name: string;
  columns: string[];
  rows: Record<string, string>[];
  /** Rows that didn't split into as many values as there are columns, or quotes that don't close (shown before importing). */
  problems?: string[];
  /** Spreadsheets: the sheet that was read (the first), and all of them. */
  sheet?: string;
  sheets?: string[];
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

/** Thrown for a file that is not UTF-8 (or UTF-16 with a byte-order mark). */
class EncodingError extends Error {}

/**
 * A text file's contents. UTF-8 (the usual), or UTF-16 when the file starts with its byte-order mark. Anything
 * else (e.g. a Danish Excel "CSV" saved in Windows-1252) is refused rather than read with letters replaced by "�":
 * the texts must arrive exactly as written.
 */
export async function readText(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new EncodingError(
      'Not saved as UTF-8, so some letters (e.g. æ, ø, å, “ ”) would come out wrong. Save it as UTF-8 (in Excel: “CSV UTF-8”; in a text editor: encoding UTF-8) and add it again.',
    );
  }
}

export async function parseFile(file: File): Promise<ParsedFile> {
  const e = ext(file.name);
  try {
    switch (e) {
      // Plain-text and Word files are kept exactly as written (no trimming).
      case '.txt':
      case '.md':
        return { kind: 'text', file: { name: file.name, text: await readText(file) } };
      case '.html':
      case '.htm': {
        const doc = new DOMParser().parseFromString(await readText(file), 'text/html');
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
        return { kind: 'table', table: readDelimited(file.name, await readText(file), e === '.tsv' ? '\t' : '') };
      }
      case '.xlsx':
      case '.xls':
      case '.ods': {
        const XLSX = await import('xlsx');
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellNF: true });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        // Cells as shown (dates, percentages, 2.0, 00123), unless the display is not the same number: Excel's
        // "General" display turns 9783161484100 into "9.78316E+12", a "0" format shows 2.5 as "3", "#,##0" adds
        // commas. Those keep the full number (15 significant digits, as Excel keeps them: 0.30000000000000004 is 0.3).
        for (const [ref, cell] of Object.entries(sheet)) {
          if (ref.startsWith('!') || cell?.t !== 'n' || !Number.isFinite(cell.v)) continue;
          const full = String(Number(cell.v.toPrecision(15)));
          const fmt = String(cell.z ?? 'General');
          if (fmt === 'General' || (!XLSX.SSF.is_date(fmt) && !fmt.includes('%') && toNumber(String(cell.w ?? '')) !== Number(full))) cell.w = full;
        }
        const objs = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
        // A column name used twice is kept apart by a number (note, note_1); say so. The names as SheetJS gives them:
        const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
        range.e.r = range.s.r;
        const [head = []] = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '', raw: false, range });
        const counts = new Map<string, number>();
        const renamed: [string, string][] = [];
        for (const raw of head.map(String)) {
          const v = raw === '' ? '__EMPTY' : raw;
          let vv = v;
          let k = counts.get(v) ?? 0;
          if (!k) counts.set(v, 1);
          else {
            do vv = `${v}_${k++}`;
            while (counts.get(vv));
            counts.set(v, k);
            counts.set(vv, 1);
          }
          if (vv !== v && raw.trim() !== '') renamed.push([v, vv]);
        }
        const table = tableFromObjects(file.name, objs);
        return { kind: 'table', table: { ...table, problems: renamedNote(renamed), sheet: wb.SheetNames[0], sheets: wb.SheetNames } };
      }
      case '.json': {
        const data = JSON.parse(await readText(file));
        const arr = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : null;
        if (!arr) return { kind: 'error', name: file.name, error: 'Expected a JSON array of objects.' };
        return { kind: 'table', table: tableFromObjects(file.name, arr) };
      }
      case '.jsonl': {
        const objs = (await readText(file))
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

/** A note on columns renamed because their name was already taken (`renamed`: [name, new name]); nothing is lost. */
function renamedNote(renamed: [string, string][]): string[] {
  const n = renamed.length;
  if (!n) return [];
  return [
    `${n === 1 ? 'A column has' : `${n} columns have`} the same name as an earlier column, so ${n === 1 ? 'it is' : 'they are'} kept under a new name: ` +
      `${renamed.slice(0, 5).map(([a, b]) => `“${a}” → “${b}”`).join(', ')}${n > 5 ? ', …' : ''}. Rename ${n === 1 ? 'it' : 'them'} in the sheet if you prefer other names.`,
  ];
}

/** Column names made unique as Papa does it for CSV files (note, note → note, note_1), so no column overwrites another. */
function uniqueNames(names: string[]): { names: string[]; renamed: [string, string][] } {
  const used = new Set(names);
  const count = new Map<string, number>();
  const renamed: [string, string][] = [];
  const out = names.map((c) => {
    const k = count.get(c) ?? 0;
    count.set(c, k + 1);
    if (!k) return c;
    let s = k;
    let v: string;
    do v = `${c}_${s++}`;
    while (used.has(v));
    used.add(v);
    renamed.push([c, v]);
    return v;
  });
  return { names: out, renamed };
}

/** The line (1-based) of each character position in `text`; `cr`: lines end in \r alone (old Mac files). */
function linesAt(text: string, positions: number[], cr = false): number[] {
  const order = [...positions.keys()].sort((a, b) => positions[a] - positions[b]);
  const out: number[] = [];
  const end = cr ? '\r' : '\n';
  let line = 1;
  let i = 0;
  for (const k of order) {
    for (; i < positions[k] && i < text.length; i++) if (text[i] === end) line++;
    out[k] = line;
  }
  return out;
}

/** A CSV/TSV table; the first row holds the column names. `delimiter` '' = detect. */
function readDelimited(name: string, text: string, delimiter: string): ParsedTable {
  const res = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: 'greedy', delimiter });
  const lines = res.errors.filter((x) => x.type === 'FieldMismatch').map((x) => (x.row ?? 0) + 2);
  // Papa reports one bad quotation mark up to three times, by its position in the file (its row number counts the
  // column names' row too): one line each.
  const quoteErrors = res.errors.filter((x) => x.type === 'Quotes');
  const quotes = [
    ...new Set(
      quoteErrors.every((x) => typeof x.index === 'number')
        ? linesAt(text, quoteErrors.map((x) => x.index as number), res.meta.linebreak === '\r')
        : quoteErrors.map((x) => (x.row ?? 0) + 1),
    ),
  ];
  const renamed = Object.entries(res.meta.renamedHeaders ?? {})
    .filter(([, was]) => was.trim() !== '')
    .map(([now, was]) => [was, now] as [string, string]);
  const problems = [
    ...(lines.length
      ? [
          `${lines.length} row${lines.length === 1 ? ' has' : 's have'} more or fewer values than there are column names (line ${lines.slice(0, 5).join(', ')}${lines.length > 5 ? ', …' : ''}). ` +
            'A value with a comma in it (e.g. Smith, John) must be in "quotes", or copy the rows from Excel or Word instead.',
        ]
      : []),
    ...(quotes.length
      ? [
          `A value starts with a quotation mark (") that is never closed (around line ${quotes.slice(0, 3).join(', ')}${quotes.length > 3 ? ', …' : ''}), so the rows after it may have been read as part of that value. ` +
            'Check the row count; put such a value in quotes with the quotation mark doubled ("say ""hi"""), or save the table as XLSX.',
        ]
      : []),
    ...renamedNote(renamed),
  ];
  const columns = (res.meta.fields ?? []).filter((c) => c.trim() !== '');
  const rows = res.data.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? ''])));
  return { name, columns, rows, problems };
}

/**
 * Rows and cells of tab-separated text as Excel and Word put it on the clipboard: a cell is in quotes only when it
 * holds a line break (inner quotation marks doubled); any other quotation mark is part of the text, e.g. a cell
 * that starts with "The Old Man". What lies between two quotation marks that holds a tab as well is several cells,
 * not one (e.g. ditto marks (") in two rows of a column).
 */
export function splitTabbed(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  const n = text.length;
  const endOfCell = (j: number) => j >= n || text[j] === '\t' || text[j] === '\n' || (text[j] === '\r' && text[j + 1] === '\n');
  for (;;) {
    let cell: string | null = null;
    if (text[i] === '"') {
      // A quoted cell: up to the closing quotation mark, which must end the cell, and only if it holds a line break
      // and no tab.
      let j = i + 1;
      let v = '';
      while (j < n) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            v += '"';
            j += 2;
            continue;
          }
          break;
        }
        v += text[j++];
      }
      if (j < n && endOfCell(j + 1) && v.includes('\n') && !v.includes('\t')) {
        cell = v;
        i = j + 1;
      }
    }
    if (cell === null) {
      let j = i;
      while (!endOfCell(j)) j++;
      cell = text.slice(i, j);
      i = j;
    }
    row.push(cell);
    if (i >= n) break;
    if (text[i] === '\t') i++;
    else {
      i += text[i] === '\r' ? 2 : 1;
      rows.push(row);
      row = [];
    }
  }
  rows.push(row);
  return rows;
}

/**
 * A table pasted as text: rows copied from Excel or a Word table (columns separated by tabs) or typed with
 * commas, the column names in the first row.
 */
export function parsePastedTable(text: string): ParsedTable {
  // One column is fine too (e.g. a list of names under a heading). Only blank lines are trimmed at either end:
  // a leading tab is an empty first cell (e.g. an Excel header row whose first cell is blank).
  const lead = /^(?:[ \t]*\r?\n)*/.exec(text)![0];
  const body = text.slice(lead.length).replace(/(?:\r?\n[ \t]*)+$/, '');
  // Line numbers count from the top of what was pasted.
  const above = lead.split('\n').length - 1;
  if (!body.includes('\t')) {
    // Typed with commas (or semicolons) between the values; otherwise one column (e.g. names copied from a single
    // column in Excel, which puts no tab on the clipboard): one value per line, so “Bohr, Niels” stays one name.
    const [head = '', ...rest] = body.split(/\r?\n/);
    if (/[,;]/.test(head)) return readDelimited('pasted', body, '');
    const name = head.trim();
    return { name: 'pasted', columns: name ? [name] : [], rows: name ? rest.filter((l) => l.trim() !== '').map((l) => ({ [name]: l })) : [], problems: [] };
  }
  // Read as written (a row per line, a cell per tab), unless that doesn't give every row as many cells as there are
  // column names and Excel's quoting does (a cell in quotes holds a line break). So quotation marks as text,
  // e.g. ditto marks (") or a title that starts with one, never join rows.
  const blank = (r: string[]) => r.every((c) => c.trim() === '');
  const misfits = (rows: string[][]) => rows.flatMap((r, k) => (k > 0 && !blank(r) && r.length !== rows[0].length ? [k] : []));
  const literal = body.split(/\r?\n/).map((l) => l.split('\t'));
  const bad = misfits(literal);
  const quoted = bad.length ? splitTabbed(body) : [];
  const read = bad.length && !misfits(quoted).length ? quoted : literal;
  const mismatch = read === literal ? bad.map((k) => k + 1 + above) : [];
  const [head = [], ...rest] = read;
  // Blank lines (e.g. between pasted blocks) are not rows.
  const lines = rest.filter((r) => !blank(r));
  const keep = head.map((c, i) => [c.trim(), i] as const).filter(([c]) => c !== '');
  const { names, renamed } = uniqueNames(keep.map(([c]) => c));
  return {
    name: 'pasted',
    columns: names,
    rows: lines.map((r) => Object.fromEntries(keep.map(([, i], j) => [names[j], r[i] ?? '']))),
    problems: [
      ...(mismatch.length
        ? [
            `${mismatch.length} row${mismatch.length === 1 ? ' has' : 's have'} more or fewer cells than there are column names (line ${mismatch.slice(0, 5).join(', ')}${mismatch.length > 5 ? ', …' : ''}), ` +
              'so some values may be under the wrong column. Check those rows.',
          ]
        : []),
      ...renamedNote(renamed),
    ],
  };
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
