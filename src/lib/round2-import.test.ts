// Round two of the review fixes: pasted tables, files and label sheets (regression tests).
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { resultsWide } from './export/tables';
import { clearPlan, matchLabels, modelAnswerColumns } from './import/labels';
import { parseFile, parsePastedTable } from './import/parse';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type Run } from './types';

const csv = async (name: string, text: string) => {
  const r = await parseFile(new File([text], name));
  if (r.kind !== 'table') throw new Error(r.kind);
  return r.table;
};

describe('pasted tables with quotation marks as text', () => {
  it('keep ditto marks (") in their own rows', () => {
    const t = parsePastedTable(
      'name\tcountry\tborn\nNiels Bohr\tDenmark\t1885\nKaren Blixen\t"\t1885\nHans Christian Andersen\t"\t1805\nSøren Kierkegaard\t"\t1813\nHenrik Ibsen\tNorway\t1828\nEdvard Grieg\t"\t1843',
    );
    expect(t.rows.map((r) => [r.name, r.country, r.born])).toEqual([
      ['Niels Bohr', 'Denmark', '1885'],
      ['Karen Blixen', '"', '1885'],
      ['Hans Christian Andersen', '"', '1805'],
      ['Søren Kierkegaard', '"', '1813'],
      ['Henrik Ibsen', 'Norway', '1828'],
      ['Edvard Grieg', '"', '1843'],
    ]);
    expect(t.problems).toEqual([]);
  });
  it('keep a cell with an opening quote apart from a later cell ending in one (an inch mark)', () => {
    const t = parsePastedTable('name\tnote\nBohr\t"Copenhagen founder\nBlixen\tauthor\nAndersen\tscreen 15"\n');
    expect(t.rows).toEqual([
      { name: 'Bohr', note: '"Copenhagen founder' },
      { name: 'Blixen', note: 'author' },
      { name: 'Andersen', note: 'screen 15"' },
    ]);
  });
  it('still read Excel’s quoted cells with a line break', () => {
    const t = parsePastedTable('name\tnote\r\nBohr\t"line1\nline2 ""quoted"""\r\nBlixen\tauthor\r\n');
    expect(t.rows).toEqual([
      { name: 'Bohr', note: 'line1\nline2 "quoted"' },
      { name: 'Blixen', note: 'author' },
    ]);
    expect(t.problems).toEqual([]);
  });
  it('keep ditto marks apart in a paste that also has Excel’s quoted multi-line cells', () => {
    const t = parsePastedTable('name\tnote\tborn\nBohr\t"line1\nline2"\t1885\nCurie\t"\t1867\nSmith\t"\t1900\nJones\tx\t1901\n');
    expect(t.rows).toEqual([
      { name: 'Bohr', note: 'line1\nline2', born: '1885' },
      { name: 'Curie', note: '"', born: '1867' },
      { name: 'Smith', note: '"', born: '1900' },
      { name: 'Jones', note: 'x', born: '1901' },
    ]);
    // Ditto marks in the last column, and two side by side.
    const u = parsePastedTable('name\tborn\tcountry\tcity\nBohr\t1885\t"Den\nmark"\tCph\nCurie\t1867\t"\t"\nSmith\t1900\t"\t"\n');
    expect(u.rows.map((r) => [r.name, r.country, r.city])).toEqual([
      ['Bohr', 'Den\nmark', 'Cph'],
      ['Curie', '"', '"'],
      ['Smith', '"', '"'],
    ]);
    expect([t.problems, u.problems]).toEqual([[], []]);
  });
  it('read rows as written when neither reading fits, and name the lines that don’t (counted from the top)', () => {
    const t = parsePastedTable('\n\nname\tnote\nBohr\tphysicist\textra\n\nBlixen\tauthor\n');
    expect(t.rows).toEqual([
      { name: 'Bohr', note: 'physicist' },
      { name: 'Blixen', note: 'author' },
    ]);
    expect(t.problems?.[0]).toMatch(/^1 row has more or fewer cells than there are column names \(line 4\)/);
  });
});

describe('repeated column names', () => {
  it('keep both columns of a pasted table, the second renamed, and say so', () => {
    const t = parsePastedTable('name\tnote\tnote\nNiels Bohr\tphysicist\tNobel 1922\n');
    expect(t.columns).toEqual(['name', 'note', 'note_1']);
    expect(t.rows[0]).toEqual({ name: 'Niels Bohr', note: 'physicist', note_1: 'Nobel 1922' });
    expect(t.problems?.join(' ')).toMatch(/“note” → “note_1”/);
  });
  it('say so for a CSV file too', async () => {
    const t = await csv('people.csv', 'name,note,note\nBohr,physicist,Nobel 1922\n');
    expect(t.rows[0]).toEqual({ name: 'Bohr', note: 'physicist', note_1: 'Nobel 1922' });
    expect(t.problems?.join(' ')).toMatch(/“note” → “note_1”/);
  });
  it('and for a spreadsheet', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['name', 'note', 'note'], ['Bohr', 'physicist', 'Nobel 1922']]), 'Sheet1');
    const r = await parseFile(new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], 'people.xlsx'));
    if (r.kind !== 'table') throw new Error(r.kind);
    expect(r.table.rows[0]).toEqual({ name: 'Bohr', note: 'physicist', note_1: 'Nobel 1922' });
    expect(r.table.problems?.join(' ')).toMatch(/“note” → “note_1”/);
  });
});

describe('a pasted column without tabs', () => {
  it('is one value per line when the column name has no comma or semicolon', () => {
    const t = parsePastedTable('name\nBohr, Niels\nBlixen, Karen\n"The Ugly Duckling" and other tales\n"Either/Or"\n');
    expect(t.columns).toEqual(['name']);
    expect(t.rows.map((r) => r.name)).toEqual(['Bohr, Niels', 'Blixen, Karen', '"The Ugly Duckling" and other tales', '"Either/Or"']);
    expect(t.problems).toEqual([]);
  });
  it('is still read as typed comma-separated rows when the column names have commas', () => {
    expect(parsePastedTable('name,born\n"Bohr, Niels",1885\n').rows).toEqual([{ name: 'Bohr, Niels', born: '1885' }]);
  });
});

describe('an unclosed quotation mark in a CSV file', () => {
  it('is reported once, at its own line', async () => {
    const t = await csv('meta.csv', 'file,title,era\nart_1.md,Plain 1,1990\nart_5.md,"Doing gender" revisited,1995\nart_6.md,Plain 6,2000\n');
    const p = t.problems?.find((x) => x.includes('quotation mark'));
    expect(p).toMatch(/\(around line 3\)/);
  });
  it('is reported at its own line in a file whose lines end in \\r alone (old Mac)', async () => {
    const t = await csv('mac.csv', 'file,title\ra1,x\ra2,"open\ra3,z\r');
    expect(t.problems?.find((x) => x.includes('quotation mark'))).toMatch(/\(around line 3\)/);
  });
});

const doc = (id: string, docId: string, meta: Record<string, string> = {}, file = ''): Doc => ({
  id, studyId: 's', docId, text: 'T', meta: file ? { file, ...meta } : meta, source: file || 'people.xlsx', order: 0, addedAt: '',
});

describe('label sheets', () => {
  it('leave the values of texts hit by an ambiguous key as they are', () => {
    const docs = [doc('a', 'art_1', { race_gold: '1' }, 'art_1.md'), doc('b', 'art_1_2', { race_gold: '2' }, 'art_1.txt'), doc('c', 'art_2', { race_gold: '3' }, 'art_2.md')];
    const m = matchLabels(docs, { name: 'x.csv', columns: ['file', 'race_gold'], rows: [{ file: 'art_1', race_gold: '-1' }, { file: 'art_2.md', race_gold: '0' }] }, 'file');
    expect(m.ambiguous).toEqual(['art_1']);
    // Even when the values of unlisted texts are removed on purpose.
    expect([...clearPlan(docs, m, false).keys()]).toEqual([]);
  });
  it('count every text matched, and point to same-name entries stored with _2', () => {
    const names = Array.from({ length: 38 }, (_, i) => `Person ${i + 1}`);
    const docs = [...names, 'John Smith', 'John Smith_2'].map((n, i) => doc(`d${i}`, n, { name: n.replace(/_2$/, '') }));
    const rows = [...names, 'John Smith', 'John Smith'].map((n, i) => ({ name: n, coder2_fame: String(i % 3) }));
    rows[39].coder2_fame = '5';
    const m = matchLabels(docs, { name: 'answers.xlsx', columns: ['name', 'coder2_fame'], rows }, 'name');
    expect([m.matchedRows, m.matchedTexts, m.updates.size, m.conflicts]).toEqual([40, 39, 38, ['John Smith']]);
    expect(m.sameName).toEqual([{ key: 'John Smith', ids: ['John Smith', 'John Smith_2'] }]);
  });
  it('don’t take files that are really named so (smith_2.md), or a numbered paste (pasted_1), for same-name texts', () => {
    const docs = [doc('a', 'smith', {}, 'smith.md'), doc('b', 'smith_2', {}, 'smith_2.md'), doc('c', 'pasted'), doc('d', 'pasted_1')];
    const rows = [{ file: 'smith', race_coder: '1' }, { file: 'smith', race_coder: '2' }, { file: 'pasted', race_coder: '1' }, { file: 'pasted', race_coder: '2' }];
    const m = matchLabels(docs, { name: 'coders.csv', columns: ['file', 'race_coder'], rows }, 'file');
    expect([m.conflicts, m.sameName]).toEqual([['smith', 'pasted'], []]);
    // A second art_1 (from art_1.txt, stored as art_1_2) is one.
    const twice = [doc('a', 'art_1', {}, 'art_1.md'), doc('b', 'art_1_2', {}, 'art_1.txt')];
    const n = matchLabels(twice, { name: 'x.csv', columns: ['id', 'race_coder'], rows: [{ id: 'art_1.md', race_coder: '1' }, { id: 'art_1.md', race_coder: '2' }] }, 'id');
    expect(n.sameName).toEqual([{ key: 'art_1.md', ids: ['art_1', 'art_1_2'] }]);
  });
});

describe('a results file exported from this app, added as labels', () => {
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const run = (id: string, prompt: PromptSpec, replicates = 1): Run => ({
    id, studyId: 's', number: 1, label: '', createdAt: '', finishedAt: null, mode: 'sync', scope: '', docIds: ['a', 'b'], status: 'completed', batch: null, error: null,
    snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: { ...DEFAULT_RUN_OPTIONS, replicates }, prompt, promptVersion: 1, promptHash: 'h', outputSchema: null, requestBase: {} },
  });
  const result = (runId: string, docId: string, rep: number, values: Record<string, string>): Result => ({
    id: `${runId}:${docId}:${rep}`, runId, studyId: 's', docId, replicate: rep, status: 'ok', values, rationale: 'because', reasoningSummary: '', rawText: '',
    parseError: null, error: null, usage, latencyMs: 1, requestedAt: '', completedAt: '', responseId: '', modelReported: 'm', stopReason: 'end_turn',
  });
  const docs = [doc('a', 'a', { era: '1990s', race_coder2: '1' }, 'a.md'), doc('b', 'b', { era: '2000s', race_coder2: '2' }, 'b.md')];
  const sheet = (columns: string[]) => ({ name: 'results.xlsx', columns, rows: [] });
  const structured = run('r1', {
    ...DEFAULT_PROMPT,
    outputMode: 'structured',
    variables: [
      { name: 'race_explanation', type: 'text', values: [], description: '' },
      { name: 'race', type: 'ordinal', values: ['-3', '-2', '-1', '0', '1', '2', '3'], description: '' },
    ],
  }, 3);
  const structuredResults = ['a', 'b'].flatMap((d) => [1, 2, 3].map((k) => result('r1', d, k, { race: String(k - 1), race_explanation: 'e' })));
  const text = run('r2', { ...DEFAULT_PROMPT, outputMode: 'text', variables: [] });
  const textResults = ['a', 'b'].map((d) => result('r2', d, 1, { response: '{"race": {"score": 2, "explanation": "x"}, "status": "done"}' }));
  // The columns of the Results sheet as the exports write them, plus a coder's column the owner added.
  const exported = (r: Run, rs: Result[]) => [...Object.keys(resultsWide(r, docs, [structured, text], rs, { text: false, rationale: true })[0]), 'race_gold'];

  it('names the model’s answer columns of an exported Results sheet (codebook fields)', () => {
    const cols = exported(structured, structuredResults);
    expect(cols).toEqual(expect.arrayContaining(['race', 'race_explanation', 'era', 'race_coder2', 'n_ok', 'n_error', 'race_gold']));
    const m = modelAnswerColumns(sheet(cols), [structured, text], [...structuredResults, ...textResults]);
    expect(m).toEqual(expect.arrayContaining(['race', 'race_explanation', 'race_replicate_agreement', 'rationale', 'n_ok', 'n_error']));
    expect(m).not.toEqual(expect.arrayContaining(['era']));
    expect(m.filter((c) => ['doc_id', 'era', 'race_coder2', 'race_gold'].includes(c))).toEqual([]);
  });
  it('names the model’s answer columns of an exported Results sheet (JSON keys of plain-text answers)', () => {
    const cols = exported(text, textResults);
    const m = modelAnswerColumns(sheet(cols), [structured, text], [...structuredResults, ...textResults]);
    expect(m).toEqual(expect.arrayContaining(['race_score', 'race_explanation', 'answer_status', 'n_ok', 'n_error']));
    expect(m.filter((c) => ['doc_id', 'era', 'race_coder2', 'race_gold'].includes(c))).toEqual([]);
  });
  it('leaves other sheets alone, including one with only a coder’s column named like the field', () => {
    expect(modelAnswerColumns(sheet(['file', 'race', 'race_explanation']), [structured], structuredResults)).toEqual([]);
    expect(modelAnswerColumns(sheet(['file', 'race_gold', 'n_ok', 'n_error']), [structured], structuredResults)).toEqual([]);
  });
});
