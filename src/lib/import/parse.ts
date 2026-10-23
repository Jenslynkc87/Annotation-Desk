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

/** Why a file not saved as UTF-8 is refused, for `n` such files. */
export function notUtf8(n: number): string {
  const [it, them] = n === 1 ? ['it', 'it'] : ['these files', 'them'];
  return `Not saved as UTF-8, so some letters (e.g. æ, ø, å, “ ”) would come out wrong. Save ${it} as UTF-8 (in Excel: “CSV UTF-8”; in a text editor: encoding UTF-8) and add ${them} again.`;
}

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
    throw new EncodingError(notUtf8(1));
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
        // The first row with something in it holds the column names (blank rows are skipped, as in CSV files), named as
        // for CSV files and pasted tables (not SheetJS's "__EMPTY").
        const [head = [], ...cells] = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false })
          .map((r) => r.map((v) => String(v ?? '')))
          .filter((r) => r.some((v) => v !== ''));
        const first = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1').s.c;
        const { columns, keep, problems } = nameColumns(head, cells, first);
        const rows = cells.map((r) => Object.fromEntries(keep.map((i, j) => [columns[j], r[i] ?? ''])));
        return { kind: 'table', table: { name: file.name, columns, rows, problems, sheet: wb.SheetNames[0], sheets: wb.SheetNames } };
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

/**
 * The columns of a table from its first row (`head`) and the rows below it, the same for every way in (file, sheet
 * or paste): names without spaces around them; a column with no name is called after its place (column_3, `offset`:
 * columns before the first), or left out when it holds nothing at all (e.g. trailing commas); a name used twice is
 * kept apart by a number. `keep`: the positions of the columns kept, in order.
 */
function nameColumns(head: string[], rows: string[][], offset = 0): { columns: string[]; keep: number[]; problems: string[] } {
  const keep: number[] = [];
  const named: string[] = [];
  const unnamed: string[] = [];
  head.forEach((h, i) => {
    let name = h.trim();
    if (!name) {
      if (rows.every((r) => (r[i] ?? '').trim() === '')) return;
      name = `column_${i + 1 + offset}`;
      unnamed.push(name);
    }
    keep.push(i);
    named.push(name);
  });
  const { names, renamed } = uniqueNames(named);
  const n = unnamed.length;
  return {
    columns: names,
    keep,
    problems: [
      ...(n
        ? [
            `${n === 1 ? 'A column has' : `${n} columns have`} no name in the first row, so ${n === 1 ? 'it is' : 'they are'} called ` +
              `${unnamed.slice(0, 5).map((c) => `“${c}”`).join(', ')}${n > 5 ? ', …' : ''} (after ${n === 1 ? 'its' : 'their'} place). Name ${n === 1 ? 'it' : 'them'} in the first row if you prefer.`,
          ]
        : []),
      ...renamedNote(renamed),
    ],
  };
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

/**
 * A CSV/TSV table; the first row holds the column names. `delimiter` '' = detect. `above`: lines above `text` (blank
 * lines cut off a paste), so that line numbers count from the top of what was pasted.
 */
function readDelimited(name: string, text: string, delimiter: string, above = 0): ParsedTable {
  const src = text.replace(/^\uFEFF/, '');
  const cells: string[][] = [];
  // Where each row starts (its first character that isn't a space or line break: blank lines are skipped), and the
  // position of each quotation mark Papa finds unclosed.
  const starts: number[] = [];
  const quoteAt: number[] = [];
  let cursor = 0;
  let cr = false;
  Papa.parse<string[]>(src, {
    header: false,
    skipEmptyLines: 'greedy',
    delimiter,
    step: (r) => {
      let i = cursor;
      while (i < src.length && /\s/.test(src[i])) i++;
      cells.push(r.data);
      starts.push(i);
      for (const e of r.errors) if (e.type === 'Quotes') quoteAt.push(typeof e.index === 'number' ? e.index : i);
      cursor = r.meta.cursor;
      cr = r.meta.linebreak === '\r';
    },
  });
  const [head = [], ...body] = cells;
  const { columns, keep, problems: names } = nameColumns(head, body);
  // A row with fewer values than the columns kept, or with values beyond the column names (trailing empty ones,
  // e.g. from a sheet's used range, lose nothing).
  const need = keep.length ? keep[keep.length - 1] + 1 : 0;
  const misfit = body.flatMap((r, k) => (r.length < need || r.slice(head.length).some((v) => v.trim() !== '') ? [k + 1] : []));
  const at = linesAt(src, [...misfit.map((k) => starts[k]), ...quoteAt], cr).map((l) => l + above);
  const lines = at.slice(0, misfit.length);
  // Papa reports one bad quotation mark up to three times: one line each.
  const quotes = [...new Set(at.slice(misfit.length))];
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
    ...names,
  ];
  const rows = body.map((r) => Object.fromEntries(keep.map((i, j) => [columns[j], r[i] ?? ''])));
  return { name, columns, rows, problems };
}

/**
 * Rows and cells of text as Excel and Word put it on the clipboard (cells separated by tabs; without a tab, one cell
 * per line). A cell is in quotes when it holds a line break or a quotation mark (doubled inside the quotes), and its
 * closing quotation mark ends the cell; any other quotation mark is part of the text, e.g. a cell that starts with
 * "The Old Man" or "Heroes". What lies between two quotation marks that holds a tab as well is several cells, not one
 * (e.g. ditto marks (") in two rows of a column), unless `tabs` (Excel also quotes a cell that holds a tab).
 * `lines`: the line each row starts on (from 1). `open`: the lines of a quotation mark at the start of a cell that is
 * not closed on its own line and doesn't make a quoted cell (read as written).
 */
function readCells(text: string, tabs = false): { rows: string[][]; lines: number[]; open: number[] } {
  const rows: string[][] = [];
  const lines = [1];
  const open: number[] = [];
  let row: string[] = [];
  let line = 1;
  let i = 0;
  const n = text.length;
  const endOfCell = (j: number) => j >= n || text[j] === '\t' || text[j] === '\n' || (text[j] === '\r' && text[j + 1] === '\n');
  for (;;) {
    let cell: string | null = null;
    if (text[i] === '"') {
      // Up to the closing quotation mark (a doubled one is part of the text).
      let j = i + 1;
      let v = '';
      let doubled = false;
      while (j < n) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            v += '"';
            doubled = true;
            j += 2;
            continue;
          }
          break;
        }
        v += text[j++];
      }
      const closed = j < n && endOfCell(j + 1);
      const tab = v.includes('\t');
      if (closed && (v.includes('\n') || doubled || (tabs && tab)) && (tabs || !tab)) {
        cell = v;
        line += v.split('\n').length - 1;
        i = j + 1;
      } else if (j >= n || v.includes('\n')) open.push(line);
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
      lines.push(++line);
    }
  }
  rows.push(row);
  return { rows, lines, open };
}

/** The same, without line numbers. */
export function splitTabbed(text: string): string[][] {
  return readCells(text).rows;
}

/**
 * A table pasted as text: rows copied from Excel or a Word table (columns separated by tabs) or typed with
 * commas, the column names in the first row. The values are kept as pasted (only the column names are trimmed).
 */
export function parsePastedTable(text: string): ParsedTable {
  // One column is fine too (e.g. a list of names under a heading). Only blank lines are trimmed at either end:
  // a leading tab is an empty first cell (e.g. an Excel header row whose first cell is blank).
  const lead = /^(?:[ \t]*\r?\n)*/.exec(text)![0];
  const body = text.slice(lead.length).replace(/(?:\r?\n[ \t]*)+$/, '');
  // Line numbers count from the top of what was pasted.
  const above = lead.split('\n').length - 1;
  const blank = (r: string[]) => r.every((c) => c.trim() === '');
  const table = (rows: string[][], problems: string[]): ParsedTable => {
    const [head = [], ...rest] = rows;
    // Blank lines (e.g. between pasted blocks) are not rows.
    const lines = rest.filter((r) => !blank(r));
    const { columns, keep, problems: names } = nameColumns(head, lines);
    return { name: 'pasted', columns, rows: lines.map((r) => Object.fromEntries(keep.map((i, j) => [columns[j], r[i] ?? '']))), problems: [...problems, ...names] };
  };
  if (!body.includes('\t')) {
    // Typed with commas (or semicolons) between the values; otherwise one column (e.g. names copied from a single
    // column in Excel, which puts no tab on the clipboard): one value per line, so “Bohr, Niels” stays one name,
    // except a cell Excel put in quotes because it holds a line break.
    if (/[,;]/.test(/^[^\r\n]*/.exec(body)![0])) return readDelimited('pasted', body, '', above);
    const { rows, open } = readCells(body);
    const at = open.map((l) => l + above);
    return table(rows, at.length
      ? [
          `A value starts with a quotation mark (") that is not closed at the end of a line (line ${at.slice(0, 5).join(', ')}${at.length > 5 ? ', …' : ''}), so it was kept as written, ` +
            'one value per line. Check the row count: a value with a line break must be in quotes, with any quotation mark in it doubled ("say ""hi""").',
        ]
      : []);
  }
  // Read as written (a row per line, a cell per tab), unless that doesn't give every row as many cells as there are
  // column names and Excel's quoting does (a cell in quotes holds a line break, a quotation mark or, if nothing else
  // fits, a tab). So quotation marks as text, e.g. ditto marks (") or a title that starts with one, never join rows.
  // If none fits, the reading as written or Excel's quoting without tabs, whichever leaves fewer rows that don't
  // (quoted cells holding tabs could swallow whole rows).
  const misfits = (rows: string[][]) => rows.flatMap((r, k) => (k > 0 && !blank(r) && r.length !== rows[0].length ? [k] : []));
  const literal = body.split(/\r?\n/).map((l) => l.split('\t'));
  const readings = [{ rows: literal, lines: literal.map((_, k) => k + 1) }, readCells(body), readCells(body, true)];
  const bad = readings.map((r) => misfits(r.rows));
  const best = bad.findIndex((b) => !b.length);
  const k = best >= 0 ? best : bad[1].length < bad[0].length ? 1 : 0;
  const mismatch = bad[k].map((r) => readings[k].lines[r] + above);
  return table(readings[k].rows, mismatch.length
    ? [
        `${mismatch.length} row${mismatch.length === 1 ? ' has' : 's have'} more or fewer cells than there are column names (line ${mismatch.slice(0, 5).join(', ')}${mismatch.length > 5 ? ', …' : ''}), ` +
          'so some values may be under the wrong column. Check those rows.',
      ]
    : []);
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

/**
 * Split pasted text into items, kept exactly as pasted, as a dropped file is (nothing trimmed: an indented first
 * line keeps its indent). One text is the whole paste; split, each item is what lies between the separators (a line
 * break; at blank lines, a line break and the blank lines after it), without blank lines at either end.
 */
export function splitPasted(text: string, mode: 'none' | 'blank' | 'line'): string[] {
  if (!text.trim()) return [];
  if (mode === 'none') return [text];
  const t = text.replace(/^(?:[^\S\r\n]*\r?\n)+/, '').replace(/(?:\r?\n[^\S\r\n]*)+$/, '');
  const parts = mode === 'blank' ? t.split(/\r?\n(?:[^\S\r\n]*\r?\n)+/) : t.split(/\r?\n/);
  return parts.filter((p) => p.trim() !== '');
}
