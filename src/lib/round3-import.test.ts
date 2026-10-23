// Round three of the review fixes: pasted tables, files and label sheets (regression tests).
import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { resultsLong, resultsWide, toCsv } from './export/tables';
import { matchLabels, modelAnswerColumns } from './import/labels';
import { parseFile, parsePastedTable, splitPasted } from './import/parse';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type Run, type Study } from './types';

const file = async (name: string, content: string | ArrayBuffer) => {
  const r = await parseFile(new File([content], name));
  if (r.kind !== 'table') throw new Error(r.kind === 'error' ? r.error : r.kind);
  return r.table;
};
const xlsx = (rows: unknown[][]) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
};
const lineOf = (p?: string[]) => (p ?? []).map((s) => /\((?:around )?line[^)]*\)/.exec(s)?.[0] ?? '');

describe('a pasted column from Excel (no tabs)', () => {
  it('keeps a cell with a line break (which Excel puts in quotes) as one value, without the quotes', () => {
    const t = parsePastedTable('note\r\n"line one\r\nline two"\r\nplain\r\n');
    expect([t.columns, t.rows, t.problems]).toEqual([['note'], [{ note: 'line one\r\nline two' }, { note: 'plain' }], []]);
    const u = parsePastedTable('name\r\nNiels Bohr\r\n"Karen Blixen\nIsak Dinesen"\r\nAda Lovelace\r\n');
    expect(u.rows.map((r) => r.name)).toEqual(['Niels Bohr', 'Karen Blixen\nIsak Dinesen', 'Ada Lovelace']);
  });
  it('undoes the doubled quotation marks inside such a cell', () => {
    const t = parsePastedTable('title\r\n"The ""Old"" Man\r\nand the Sea"\r\nLow\r\n');
    expect(t.rows.map((r) => r.title)).toEqual(['The "Old" Man\r\nand the Sea', 'Low']);
  });
  it('keeps other quotation marks as typed, also next to such a cell', () => {
    const t = parsePastedTable('title\n"Heroes"\n"The Ugly Duckling" and other tales\n"Karen\nBlixen"\nscreen 15"\n');
    expect(t.rows.map((r) => r.title)).toEqual(['"Heroes"', '"The Ugly Duckling" and other tales', 'Karen\nBlixen', 'screen 15"']);
    expect(t.problems).toEqual([]);
  });
  it('reads a quotation mark that is never closed as written, and says so', () => {
    const t = parsePastedTable('\ntitle\n"Heroes\nLow\n');
    expect(t.rows.map((r) => r.title)).toEqual(['"Heroes', 'Low']);
    expect(lineOf(t.problems)).toEqual(['(line 3)']);
    // A cell Excel quoted after it is still read as one value.
    const u = parsePastedTable('title\n"Heroes\n"Karen\nBlixen"\nLow\n');
    expect(u.rows.map((r) => r.title)).toEqual(['"Heroes', 'Karen\nBlixen', 'Low']);
    expect(lineOf(u.problems)).toEqual(['(line 2)']);
  });
});

describe('a pasted table with tabs', () => {
  it('keeps an Excel multi-line cell whole when another row is short, and names the short row’s own line', () => {
    const t = parsePastedTable('name\tnote\tborn\nBohr\t"Atom\nmodel"\t1885\nBlixen\tauthor\nAndersen\tfairy tales\t1805\n');
    expect(t.rows).toEqual([
      { name: 'Bohr', note: 'Atom\nmodel', born: '1885' },
      { name: 'Blixen', note: 'author', born: '' },
      { name: 'Andersen', note: 'fairy tales', born: '1805' },
    ]);
    expect(lineOf(t.problems)).toEqual(['(line 4)']);
  });
  it('keeps the whole text of a cell holding a tab (Excel puts it in quotes)', () => {
    const t = parsePastedTable('name\tnote\r\nBohr\t"a\tb"\r\nBlixen\tauthor\r\n');
    expect([t.rows, t.problems]).toEqual([[{ name: 'Bohr', note: 'a\tb' }, { name: 'Blixen', note: 'author' }], []]);
  });
  it('counts blank lines and the lines of a multi-line cell in the line numbers', () => {
    const t = parsePastedTable('\nname\tnote\tborn\nBohr\t"two\nlines"\t1885\n\nBlixen\tauthor\n');
    expect(lineOf(t.problems)).toEqual(['(line 6)']);
  });
});

describe('line numbers of rows that split wrongly', () => {
  it('count blank lines and multi-line cells in a CSV file', async () => {
    expect(lineOf((await file('m.csv', 'file,title\na1,x\n\na2,y,extra\na3,z\n')).problems)).toEqual(['(line 4)']);
    expect(lineOf((await file('m.csv', 'file,title\n\na1,x\n\na2,y,extra\n')).problems)).toEqual(['(line 5)']);
    expect(lineOf((await file('m.csv', 'file,title\na1,"two\nlines"\na2,y,extra\n')).problems)).toEqual(['(line 4)']);
    expect(lineOf((await file('m.csv', '\uFEFFfile,title\r\na1,x\r\n\r\na2,y,extra\r\n')).problems)).toEqual(['(line 4)']);
  });
  it('count from the top of what was pasted (typed with commas)', () => {
    expect(lineOf(parsePastedTable('\n\nfile,title\na1,"open\na2,z').problems)).toEqual(['(around line 4)']);
    expect(lineOf(parsePastedTable('\n\nname,born\nSmith, John,1950\n').problems)).toEqual(['(line 4)']);
  });
});

describe('column names', () => {
  it('are trimmed in typed tables (the values are kept as typed)', () => {
    const t = parsePastedTable('name, born, country\nNiels Bohr, 1885, Denmark\n');
    expect([t.columns, t.rows[0]]).toEqual([['name', 'born', 'country'], { name: 'Niels Bohr', born: ' 1885', country: ' Denmark' }]);
  });
  it('leave out empty unnamed columns of a CSV file (trailing commas), and name one that holds values after its place', async () => {
    const t = await file('meta.csv', 'file,era,,\na.md,1990,,\nb.md,2000,,\n');
    expect([t.columns, t.rows[0], t.problems]).toEqual([['file', 'era'], { file: 'a.md', era: '1990' }, []]);
    const u = await file('meta.csv', 'file,,era\na.md,x,1990\n');
    expect([u.columns, u.rows[0]]).toEqual([['file', 'column_2', 'era'], { file: 'a.md', column_2: 'x', era: '1990' }]);
    expect(u.problems?.join(' ')).toMatch(/no name in the first row.*“column_2”/);
  });
  it('do the same in a spreadsheet: never “__EMPTY”', async () => {
    const t = await file('meta.xlsx', xlsx([['file', '', 'era', null, ' note '], ['a.md', 'x', '1990', null, 'n'], ['b.md', '', '2000', null, '']]));
    expect(t.columns).toEqual(['file', 'column_2', 'era', 'note']);
    expect(t.rows).toEqual([
      { file: 'a.md', column_2: 'x', era: '1990', note: 'n' },
      { file: 'b.md', column_2: '', era: '2000', note: '' },
    ]);
  });
  it('take the column names from a spreadsheet’s first row with something in it (blank rows above skipped, as in CSV files)', async () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([]);
    XLSX.utils.sheet_add_aoa(ws, [['file', 'era'], ['a.md', 1990]], { origin: 'B3' });
    ws['!ref'] = 'A1:C4';
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const t = await file('meta.xlsx', XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
    expect([t.columns, t.rows, t.problems]).toEqual([['file', 'era'], [{ file: 'a.md', era: '1990' }], []]);
  });
});

describe('pasted texts', () => {
  it('are kept as pasted: nothing trimmed, only the separators taken out', () => {
    const text = '\n  indented first line\nsecond line  \n\n    indented paragraph\n\n\n';
    expect(splitPasted(text, 'none')).toEqual([text]);
    expect(splitPasted(text, 'blank')).toEqual(['  indented first line\nsecond line  ', '    indented paragraph']);
    expect(splitPasted(text, 'line')).toEqual(['  indented first line', 'second line  ', '    indented paragraph']);
    expect(splitPasted('a\r\n \r\nb\r\n', 'blank')).toEqual(['a', 'b']);
    expect(splitPasted(' \n\t\n', 'none')).toEqual([]);
  });
});

describe('same-name entries (John Smith, John Smith_2)', () => {
  const doc = (id: string, docId: string): Doc => ({ id, studyId: 's', docId, text: 'T', meta: { name: docId.replace(/_2$/, '') }, source: 'people.xlsx', order: 0, addedAt: '' });
  const docs = [doc('a', 'Ada Lovelace'), doc('j1', 'John Smith'), doc('j2', 'John Smith_2')];
  it('a sheet listing the name twice is not merged into the first, even when the rows agree or fill different columns', () => {
    for (const rows of [
      [{ name: 'John Smith', fame: '2' }, { name: 'John Smith', fame: '2' }],
      [{ name: 'John Smith', fame: '2', era: '' }, { name: 'John Smith', fame: '', era: '1900s' }],
    ]) {
      const m = matchLabels(docs, { name: 'answers.csv', columns: ['name', 'fame', 'era'], rows: [{ name: 'Ada Lovelace', fame: '3', era: '' }, ...rows.map((r) => ({ era: '', ...r }))] }, 'name');
      expect([m.updates.has('j1'), m.updates.has('j2'), m.updates.has('a'), m.conflicts, m.repeated]).toEqual([false, false, true, ['John Smith'], []]);
      expect(m.sameName).toEqual([{ key: 'John Smith', ids: ['John Smith', 'John Smith_2'] }]);
      expect(m.untouched.has('j1')).toBe(true);
    }
  });
});

describe('results tables exported by this app, added as labels', () => {
  const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const prompt: PromptSpec = {
    ...DEFAULT_PROMPT,
    outputMode: 'structured',
    includeRationale: false,
    variables: [
      { name: 'race_explanation', type: 'text', values: [], description: '' },
      { name: 'race', type: 'ordinal', values: ['-3', '-2', '-1', '0', '1', '2', '3'], description: '' },
    ],
  };
  const docs: Doc[] = Array.from({ length: 6 }, (_, i) => ({
    id: `d${i}`, studyId: 's', docId: `art_${i}`, text: `Text ${i}`, meta: { file: `art_${i}.md`, era: i % 2 ? '1990s' : '2000s' }, source: `art_${i}.md`, order: i, addedAt: '',
  }));
  const run = (reps: number, p = prompt): Run => ({
    id: 'r1', studyId: 's', number: 1, label: '', createdAt: '', finishedAt: '', mode: 'sync', scope: 'All', docIds: docs.map((d) => d.id), status: 'completed', batch: null, error: null,
    snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: { ...DEFAULT_RUN_OPTIONS, replicates: reps }, prompt: p, promptVersion: 1, promptHash: 'h1', outputSchema: null, requestBase: {} },
  });
  const results = (r: Run): Result[] =>
    docs.flatMap((d, i) =>
      Array.from({ length: r.snapshot.options.replicates }, (_, k) => ({
        id: `r1:${d.id}:${k + 1}`, runId: 'r1', studyId: 's', docId: d.id, replicate: k + 1, status: 'ok' as const,
        values: { race: String((i % 7) - 3), race_explanation: `The text treats race as a category in paragraph ${i}.` },
        rationale: '', reasoningSummary: '', rawText: '{}', parseError: null, error: null, usage, latencyMs: 100, requestedAt: '', completedAt: '', responseId: `msg_${i}_${k}`,
        modelReported: 'claude-x', stopReason: 'end_turn',
      })),
    );
  const study: Study = { id: 's', name: 'S', description: '', createdAt: '', updatedAt: '', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt };
  // The table as exported, read back from a CSV file with a coder's column added (as the owner would do in Excel).
  const roundTrip = async (rows: Record<string, string | number | null>[], drop: string[] = []) => {
    const withGold = rows.map((r, i) => ({ ...Object.fromEntries(Object.entries(r).filter(([k]) => !drop.includes(k))), race_gold: String((i % 3) - 1) }));
    return file('results.csv', toCsv(withGold));
  };
  const check = (t: Awaited<ReturnType<typeof roundTrip>>, r: Run, rs: Result[]) => {
    const key = t.columns.includes('doc_id') ? 'doc_id' : 'file';
    return modelAnswerColumns(t, [r], rs, matchLabels(docs, t, key).updates);
  };

  it('blocks a long (one row per request) table with one replicate', async () => {
    const r = run(1);
    const rs = results(r);
    const t = await roundTrip(resultsLong(study, [r], docs, rs, { rationale: false, reasoning: false }));
    const cols = check(t, r, rs);
    expect(cols).toEqual(expect.arrayContaining(['race', 'race_explanation', 'status', 'prompt_hash', 'response_id']));
    expect(cols).not.toContain('race_gold');
    expect(cols.slice(0, 2)).toEqual(['race', 'race_explanation']);
    // Also when the owner deleted most of the technical columns.
    const u = await roundTrip(resultsLong(study, [r], docs, rs, { rationale: false, reasoning: false }), ['prompt_hash', 'response_id', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens', 'latency_ms', 'requested_at', 'completed_at', 'stop_reason', 'parse_error', 'model_requested', 'model_reported', 'run_label', 'prompt_version']);
    expect(check(u, r, rs)).toEqual(expect.arrayContaining(['race', 'race_explanation', 'run', 'replicate', 'status']));
  });
  it('blocks a Results sheet whose n_ok and n_error were deleted (replicate agreement, or the model’s explanations word for word)', async () => {
    const r3 = run(3);
    const rs3 = results(r3);
    const wide3 = await roundTrip(resultsWide(r3, docs, [r3], rs3, { text: false, rationale: false }), ['n_ok', 'n_error']);
    expect(check(wide3, r3, rs3)).toEqual(expect.arrayContaining(['race', 'race_explanation', 'race_replicate_agreement']));
    const r1 = run(1);
    const rs1 = results(r1);
    const wide1 = await roundTrip(resultsWide(r1, docs, [r1], rs1, { text: false, rationale: false }), ['n_ok', 'n_error']);
    expect(wide1.columns).not.toContain('n_ok');
    expect(check(wide1, r1, rs1)).toEqual(['race', 'race_explanation']);
  });
  it('leaves a coder’s own sheet alone, also with explanations of its own and a status column', async () => {
    const r = run(1);
    const rs = results(r);
    const t = await file('coder.csv', toCsv(docs.map((d, i) => ({ file: d.meta.file, race: String(i % 2), race_explanation: `My own reading of paragraph ${i} of this text.`, status: 'done' }))));
    expect(check(t, r, rs)).toEqual([]);
  });
});

describe('review of round three', () => {
  it('same-name rows: not for rows that name a text by its own file name, but for texts named from an ID column', () => {
    const d = (id: string, docId: string, source: string, meta: Record<string, string> = {}): Doc => ({ id, studyId: 's', docId, text: 'T', meta, source, order: 0, addedAt: '' });
    // smith.md and smith.txt (stored as smith_2): two rows for smith.md agree, so they are merged into it.
    const files = [d('a', 'smith', 'smith.md', { file: 'smith.md' }), d('b', 'smith_2', 'smith.txt', { file: 'smith.txt' })];
    const m = matchLabels(files, { name: 'x.csv', columns: ['file', 'race_gold'], rows: [{ file: 'smith.md', race_gold: '1' }, { file: 'smith.md', race_gold: '1' }] }, 'file');
    expect([m.conflicts, m.sameName, m.repeated, m.updates.get('a')]).toEqual([[], [], ['smith.md'], { race_gold: '1' }]);
    // Texts from a table whose ID column repeats a value (X, X_2): rows naming X twice can't be told apart.
    const rows = [d('a', 'X', 'corpus.csv'), d('b', 'X_2', 'corpus.csv')];
    const n = matchLabels(rows, { name: 'x.csv', columns: ['id', 'race_gold'], rows: [{ id: 'X', race_gold: '1' }, { id: 'X', race_gold: '1' }] }, 'id');
    expect([n.conflicts, n.sameName, n.updates.size]).toEqual([['X'], [{ key: 'X', ids: ['X', 'X_2'] }], 0]);
  });

  describe('results tables of plain-text runs', () => {
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
    const textPrompt: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'text', variables: [], includeRationale: false };
    const docs: Doc[] = Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, studyId: 's', docId: `art_${i}`, text: 'T', meta: { file: `art_${i}.md` }, source: `art_${i}.md`, order: i, addedAt: '' }));
    const run: Run = {
      id: 'r1', studyId: 's', number: 1, label: '', createdAt: '', finishedAt: '', mode: 'sync', scope: 'All', docIds: docs.map((d) => d.id), status: 'completed', batch: null, error: null,
      snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: { ...DEFAULT_RUN_OPTIONS, replicates: 1 }, prompt: textPrompt, promptVersion: 1, promptHash: 'h', outputSchema: null, requestBase: {} },
    };
    const results: Result[] = docs.map((d, i) => ({
      id: `r1:${d.id}:1`, runId: 'r1', studyId: 's', docId: d.id, replicate: 1, status: 'ok', rationale: '', reasoningSummary: '', rawText: '', parseError: null, error: null, usage,
      values: { response: JSON.stringify({ explanation: `Race is discussed in section ${i} of the article.`, race: (i % 7) - 3 }) }, latencyMs: 1, requestedAt: '', completedAt: '',
      responseId: '', modelReported: 'm', stopReason: 'end_turn',
    }));
    it('a Results sheet without n_ok and n_error is blocked, with the score column too', async () => {
      const t = await file('results.csv', toCsv(resultsWide(run, docs, [run], results, { text: false, rationale: false }).map((r, i) => {
        const { n_ok: _a, n_error: _b, response: _c, ...rest } = r;
        return { ...rest, race_gold: String(i % 3) };
      })));
      expect(t.columns).not.toContain('n_ok');
      const cols = modelAnswerColumns(t, [run], results, matchLabels(docs, t, 'doc_id').updates);
      expect(cols).toEqual(expect.arrayContaining(['race', 'explanation']));
      expect(cols).not.toContain('race_gold');
    });
    it('an ordinary label sheet doesn’t make the app read every answer', () => {
      const t = { name: 'gold.csv', columns: ['file', 'race_gold', 'era'], rows: docs.map((d, i) => ({ file: d.meta.file!, race_gold: String(i % 3), era: '1990s' })) };
      const spy = vi.spyOn(JSON, 'parse');
      try {
        expect(modelAnswerColumns(t, [run], results, matchLabels(docs, t, 'file').updates)).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });
});
