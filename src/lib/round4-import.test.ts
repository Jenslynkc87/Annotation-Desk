// Round four of the review fixes: pasted tables, files and label sheets (regression tests).
import { describe, expect, it } from 'vitest';
import { resultsLong, resultsWide, toCsv } from './export/tables';
import { matchLabels, modelAnswerColumns, resultsTable } from './import/labels';
import { parseFile, parsePastedTable } from './import/parse';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type Run, type Study } from './types';

const file = async (name: string, content: string) => {
  const r = await parseFile(new File([content], name));
  if (r.kind !== 'table') throw new Error(r.kind === 'error' ? r.error : r.kind);
  return r.table;
};
const lineOf = (p?: string[]) => (p ?? []).map((s) => /\((?:around )?line[^)]*\)/.exec(s)?.[0] ?? '');
const values = (t: { columns: string[]; rows: Record<string, string>[] }) => t.rows.map((r) => t.columns.map((c) => r[c]));

describe('tab pastes: ditto marks (") with a short or long row between them (G8)', () => {
  it('keep every row and the ditto marks, and name the misfit row', () => {
    const short = parsePastedTable('name\tcountry\tborn\nBohr\tDenmark\t1885\nBlixen\t"\t1885\nAndersen\tDenmark\nKierkegaard\t"\t1813\nIbsen\tNorway\t1828');
    expect(values(short)).toEqual([
      ['Bohr', 'Denmark', '1885'],
      ['Blixen', '"', '1885'],
      ['Andersen', 'Denmark', ''],
      ['Kierkegaard', '"', '1813'],
      ['Ibsen', 'Norway', '1828'],
    ]);
    expect(lineOf(short.problems)).toEqual(['(line 4)']);
    const long = parsePastedTable('name\tcountry\tborn\nBohr\tDenmark\t1885\nBlixen\t"\t1885\nAndersen\tDenmark\t1805\textra\nKierkegaard\t"\t1813\n');
    expect([long.rows.length, long.rows.map((r) => r.country), lineOf(long.problems)]).toEqual([4, ['Denmark', '"', 'Denmark', '"'], ['(line 4)']]);
    const first = parsePastedTable('country\tname\tborn\nDenmark\tBohr\t1885\n"\tBlixen\t1885\nDenmark\tAndersen\n"\tKierkegaard\t1813\n');
    expect([first.rows.length, first.rows.map((r) => r.country), lineOf(first.problems)]).toEqual([4, ['Denmark', '"', 'Denmark', '"'], ['(line 4)']]);
    const last = parsePastedTable('name\tcountry\tborn\nBohr\tDenmark\t1885\nBlixen\tDenmark\t"\nAndersen\tDenmark\nKierkegaard\tDenmark\t"\n');
    expect([last.rows.length, last.rows.map((r) => r.born), lineOf(last.problems)]).toEqual([4, ['1885', '"', '', '"'], ['(line 4)']]);
  });
  it('also with a line break in a cell between them (Word), or an opening quote and a later inch mark', () => {
    const word = parsePastedTable('name\tcity\tnote\nF Bohr\tCopenhagen\tphysicist\nG Blixen\t"\twriter\nbaroness\nH Andersen\t"\twriter\nI Ibsen\tSkien\tplaywright\n');
    expect([word.rows.length, word.rows.map((r) => r.name), lineOf(word.problems)]).toEqual([5, ['F Bohr', 'G Blixen', 'baroness', 'H Andersen', 'I Ibsen'], ['(line 4)']]);
    const inch = parsePastedTable('name\tnote\nBohr\t"Copenhagen founder\nX\ty\tz\nTV\tscreen 15"\nBlixen\tauthor');
    expect([values(inch), lineOf(inch.problems)]).toEqual([[['Bohr', '"Copenhagen founder'], ['X', 'y'], ['TV', 'screen 15"'], ['Blixen', 'author']], ['(line 3)']]);
    const ragged = parsePastedTable('name\tnote\nBohr\t"Copenhagen founder\nBlixen\tauthor\textra\nAndersen\tscreen 15"\n');
    expect([ragged.rows.length, lineOf(ragged.problems)]).toEqual([3, ['(line 3)']]);
  });
  it('still read a cell holding a tab on one line (Excel quotes it), also when another row is fine', () => {
    const t = parsePastedTable('name\tnote\tborn\nBohr\t"a\tb"\t1885\nIbsen\tx\t1828');
    expect([values(t), t.problems]).toEqual([[['Bohr', 'a\tb', '1885'], ['Ibsen', 'x', '1828']], []]);
  });
  it('keep such a cell whole when another row is short, and name only that row (F38)', () => {
    const t = parsePastedTable('name\tnote\tborn\nBohr\t"a\tb"\t1885\nCurie\tx\nDirac\ty\t1902\n');
    expect([values(t), lineOf(t.problems)]).toEqual([[['Bohr', 'a\tb', '1885'], ['Curie', 'x', ''], ['Dirac', 'y', '1902']], ['(line 3)']]);
  });
});

describe('one-column pastes: a quoted span that starts or ends with a line break is read as written (G24)', () => {
  const note = /not closed at the end of a line/;
  it('two ditto lines', () => {
    const t = parsePastedTable('city\nCopenhagen\n"\n"\nAarhus');
    expect(t.rows.map((r) => r.city)).toEqual(['Copenhagen', '"', '"', 'Aarhus']);
    expect(t.problems).toEqual([expect.stringMatching(note)]);
    expect(lineOf(t.problems)).toEqual(['(line 3, 4)']);
    const u = parsePastedTable('note\n"\n"\nx\n');
    expect(u.rows.map((r) => r.note)).toEqual(['"', '"', 'x']);
  });
  it('a ditto line and a later line ending in an inch mark, or a value between two ditto lines', () => {
    const t = parsePastedTable('note\n"\nscreen 15"\nx\n');
    expect([t.rows.map((r) => r.note), lineOf(t.problems)]).toEqual([['"', 'screen 15"', 'x'], ['(line 2)']]);
    const u = parsePastedTable('city\n"\nOdense\n"');
    expect(u.rows.map((r) => r.city)).toEqual(['"', 'Odense', '"']);
    expect(u.problems).toEqual([expect.stringMatching(note)]);
  });
  it('the same in one column with a cell holding a tab (read with tabs)', () => {
    const t = parsePastedTable('c0\n"a\tb"\nNiels Bohr\n"line\n"\n');
    expect(t.rows.map((r) => r.c0)).toEqual(['a\tb', 'Niels Bohr', '"line', '"']);
    expect(lineOf(t.problems)).toEqual(['(line 4, 5)']);
  });
  it('still reads a cell with a line break inside it as one value', () => {
    const t = parsePastedTable('note\r\n"line one\r\nline two"\r\nplain\r\n');
    expect([t.rows.map((r) => r.note), t.problems]).toEqual([['line one\r\nline two', 'plain'], []]);
  });
});

describe('field-count warnings after rows of only delimiters (G30)', () => {
  it('name the misfit row’s own line in a CSV file', async () => {
    expect(lineOf((await file('m.csv', 'file,text,era\na.md,x,1\n,,\n,,\nb.md,y\n')).problems)).toEqual(['(line 5)']);
    expect(lineOf((await file('m.csv', 'file,text\na.md,x\n,\nb.md,y,z\n')).problems)).toEqual(['(line 4)']);
    expect(lineOf((await file('m.csv', 'file,text,era\r\na.md,x,1\r\n,,\r\n,,\r\nb.md,y\r\n')).problems)).toEqual(['(line 5)']);
    expect(lineOf((await file('m.csv', 'file,text,era\na.md,x,1\n"","",""\nb.md,y\n')).problems)).toEqual(['(line 4)']);
    expect(lineOf((await file('m.csv', 'file;text;era\na.md;x;1\n;;\nb.md;y\n')).problems)).toEqual(['(line 4)']);
    expect(lineOf((await file('m.csv', 'file,text,era\na.md,x,1\nb.md,y\n,,\nc.md,z\n')).problems)).toEqual(['(line 3, 5)']);
  });
  it('and in a paste typed with commas', () => {
    expect(lineOf(parsePastedTable('name,born\nBohr,1885\n,\n,\nBlixen\n').problems)).toEqual(['(line 5)']);
  });
  it('without changing the rows read', async () => {
    const t = await file('m.csv', 'file,text,era\na.md,x,1\n,,\n"",""\n\nb.md,y,2\n');
    expect([values(t), t.problems]).toEqual([[['a.md', 'x', '1'], ['b.md', 'y', '2']], []]);
  });
});

describe('results files exported by this app, added as labels (G12, G29)', () => {
  const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const prompt = (field: string, rationale = false): PromptSpec => ({
    ...DEFAULT_PROMPT,
    outputMode: 'structured',
    includeRationale: rationale,
    variables: [{ name: field, type: 'ordinal', values: ['-3', '-2', '-1', '0', '1', '2', '3'], description: '' }],
  });
  const docs: Doc[] = Array.from({ length: 12 }, (_, i) => ({
    id: `d${i}`, studyId: 's', docId: `art_${i}`, text: `T${i}`, meta: { file: `art_${i}.md`, era: i % 2 ? '1990s' : '2000s' }, source: `art_${i}.md`, order: i, addedAt: '',
  }));
  const run = (id: string, p: PromptSpec): Run => ({
    id, studyId: 's', number: 1, label: '', createdAt: '', finishedAt: '', mode: 'sync', scope: 'All', docIds: docs.map((d) => d.id), status: 'completed', batch: null, error: null,
    snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: { ...DEFAULT_RUN_OPTIONS, replicates: 1 }, prompt: p, promptVersion: 1, promptHash: 'h', outputSchema: null, requestBase: {} },
  });
  const results = (r: Run, field: string): Result[] =>
    docs.map((d, i) => ({
      id: `${r.id}:${d.id}:1`, runId: r.id, studyId: 's', docId: d.id, replicate: 1, status: 'ok', values: { [field]: String((i % 7) - 3) },
      rationale: `The article frames the topic in a way coded ${(i % 7) - 3} in section ${i}.`, reasoningSummary: '', rawText: '{}', parseError: null, error: null, usage,
      latencyMs: 1, requestedAt: '', completedAt: '', responseId: `m${i}`, modelReported: 'm', stopReason: 'end_turn',
    }));
  const study: Study = { id: 's', name: 'S', description: '', createdAt: '', updatedAt: '', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt: prompt('tone') };
  const old = run('old', prompt('tone'));
  const oldResults = results(old, 'tone');
  const wide = () => file('results.csv', toCsv(resultsWide(old, docs, [old], oldResults, { text: false, rationale: false })));
  const long = () => file('results_long.csv', toCsv(resultsLong(study, [old], docs, oldResults, { rationale: false, reasoning: false })));
  const check = (t: Awaited<ReturnType<typeof wide>>, runs: Run[], rs: Result[], prompts: PromptSpec[] = []) =>
    resultsTable(t, runs, rs, matchLabels(docs, t, 'doc_id').updates, prompts);

  it('are blocked in a study with no run that has their fields, by the study’s prompts or by the files’ own columns', async () => {
    for (const t of [await wide(), await long()]) {
      // The current (or a saved) prompt names the field: its column is the model's.
      const byPrompt = check(t, [], [], [prompt('tone')]);
      expect(byPrompt.answers).toEqual(['tone']);
      expect(byPrompt.columns).toEqual(expect.arrayContaining(['tone', 'n_ok', 'n_error'].filter((c) => t.columns.includes(c))));
      // No prompt or run names it (a field renamed since): still blocked by the columns only those files have.
      const unknown = check(t, [run('now', prompt('tone_score'))], results(run('now', prompt('tone_score')), 'tone_score'));
      expect(unknown.answers).toEqual([]);
      expect(unknown.strong.length).toBeGreaterThan(0);
      expect(unknown.columns).not.toContain('tone');
      expect(unknown.columns.length).toBeGreaterThan(0);
    }
    const t = await long();
    expect(check(t, [], []).strong).toEqual(expect.arrayContaining(['prompt_hash', 'response_id', 'model_requested', 'latency_ms', 'requested_at']));
    expect(check(t, [], []).shared).toEqual(expect.arrayContaining(['status', 'error', 'study', 'run']));
  });
  it('say whether the answer columns hold the model’s answers stored in this study', async () => {
    const t = await wide();
    expect(check(t, [old], oldResults).copied).toEqual(['tone']);
    // Another run with the same field but other answers: named like the field, not shown to be the model's.
    const other = run('other', prompt('tone'));
    const otherResults = results(other, 'tone').map((r) => ({ ...r, values: { tone: '3' } }));
    expect(check(t, [other], otherResults)).toMatchObject({ answers: ['tone'], copied: [], strong: ['n_ok', 'n_error'] });
  });
  it('never on common column names alone: a coder’s sheet with status, study, error or dates is not blocked', async () => {
    const r = run('r', prompt('tone'));
    const rs = results(r, 'tone');
    for (const cols of [['status', 'study'], ['status', 'error'], ['completed_at'], ['requested_at'], ['run', 'provider'], ['status', 'run', 'replicate']]) {
      const rows = docs.map((d, i) => ({ file: d.meta.file!, tone: String(i % 2), ...Object.fromEntries(cols.map((c) => [c, c.endsWith('_at') ? '2026-10-01' : 'x'])) }));
      const t = { name: 'coder.csv', columns: ['file', 'tone', ...cols], rows };
      expect(modelAnswerColumns(t, [r], rs, matchLabels(docs, t, 'file').updates, [prompt('tone')])).toEqual([]);
    }
  });
  it('a long table whose own columns were mostly deleted is still blocked when its answers are the model’s', async () => {
    const strong = ['prompt_hash', 'response_id', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens', 'latency_ms', 'requested_at', 'stop_reason', 'parse_error', 'model_requested', 'model_reported', 'run_label', 'prompt_version'];
    const rows = resultsLong(study, [old], docs, oldResults, { rationale: false, reasoning: false }).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !strong.includes(k))));
    const t = await file('results_long.csv', toCsv(rows));
    const got = check(t, [old], oldResults);
    expect(got).toMatchObject({ strong: [], copied: ['tone'], answers: ['tone'] });
    expect(got.columns).toEqual(['tone', 'study', 'run', 'provider', 'replicate', 'status', 'error', 'completed_at']);
    // A coder whose labels differ from the model's for some texts: not blocked.
    const coder = { ...t, rows: t.rows.map((r, i) => ({ ...r, tone: i < 3 ? '3' : r.tone })) };
    expect(check(coder, [old], oldResults).columns).toEqual([]);
  });
});

describe('review of round four (pastes, files and label sheets)', () => {
  it('G8: ditto marks around a short row stay apart also when an Excel cell with a line break is read whole', () => {
    const t = parsePastedTable('name\tnote\tborn\nBohr\t"Atom\nmodel"\t1885\nBlixen\t"\t1885\nCurie\tx\nDirac\t"\t1902\n');
    expect([values(t), lineOf(t.problems)]).toEqual([
      [['Bohr', 'Atom\nmodel', '1885'], ['Blixen', '"', '1885'], ['Curie', 'x', ''], ['Dirac', '"', '1902']],
      ['(line 5)'],
    ]);
  });
  it('G30 (guard): still the right line after delimiter-only rows before the header (with a BOM) or before a cell with a line break', async () => {
    expect(lineOf((await file('m.csv', '﻿,,\nfile,text,era\na.md,x,1\nb.md,y\n')).problems)).toEqual(['(line 4)']);
    const t = await file('m.csv', 'file,text,era\na.md,x,1\n,,\nb.md,"two\nlines",2\nc.md,y\n');
    expect([values(t), lineOf(t.problems)]).toEqual([[['a.md', 'x', '1'], ['b.md', 'two\nlines', '2'], ['c.md', 'y', '']], ['(line 6)']]);
  });
  it('G29: a coder’s sheet with the model’s explanations beside the coder’s own labels: only the explanations are shown to be the model’s', () => {
    const p: PromptSpec = {
      ...DEFAULT_PROMPT,
      outputMode: 'structured',
      includeRationale: false,
      variables: [
        { name: 'tone', type: 'ordinal', values: ['-3', '-2', '-1', '0', '1', '2', '3'], description: '' },
        { name: 'tone_explanation', type: 'text', values: [], description: '' },
      ],
    };
    const docs: Doc[] = Array.from({ length: 12 }, (_, i) => ({
      id: `d${i}`, studyId: 's', docId: `art_${i}`, text: `T${i}`, meta: { file: `art_${i}.md` }, source: `art_${i}.md`, order: i, addedAt: '',
    }));
    const r = {
      id: 'r', studyId: 's', number: 1, label: '', createdAt: '', finishedAt: '', mode: 'sync', scope: 'All', docIds: docs.map((d) => d.id), status: 'completed', batch: null, error: null,
      snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt: p, promptVersion: 1, promptHash: 'h', outputSchema: null, requestBase: {} },
    } as Run;
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
    const rs = docs.map((d, i) => ({
      id: `r:${d.id}`, runId: 'r', studyId: 's', docId: d.id, replicate: 1, status: 'ok', values: { tone: String((i % 7) - 3), tone_explanation: `The article frames the topic as case ${i}.` },
      rationale: '', reasoningSummary: '', rawText: '{}', parseError: null, error: null, usage, latencyMs: 1, requestedAt: '', completedAt: '', responseId: `m${i}`, modelReported: 'm', stopReason: 'end_turn',
    })) as Result[];
    const rows = docs.map((d, i) => ({ file: d.meta.file!, tone: String((i + 2) % 3), tone_explanation: `The article frames the topic as case ${i}.`, status: 'done', study: 'pilot' }));
    for (const cols of [['file', 'tone', 'tone_explanation'], ['file', 'tone', 'tone_explanation', 'status', 'study']]) {
      const t = { name: 'review.csv', columns: cols, rows };
      // The notice calls only `copied` the model's; the other answer columns are "named like this study's fields".
      expect(resultsTable(t, [r], rs, matchLabels(docs, t, 'file').updates, [p])).toMatchObject({ answers: ['tone', 'tone_explanation'], copied: ['tone_explanation'], strong: [] });
    }
  });
});
