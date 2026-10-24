// Round six of the review fixes: label sheets and the table import dialog (regression tests).
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tableAddition } from '../components/CorpusImport';
import * as dbApi from './db';
import { buildExcel } from './export/packages';
import { resultsWide, toCsv } from './export/tables';
import { matchLabels, resultsTable } from './import/labels';
import { parseFile, parsePastedTable, type ParsedTable } from './import/parse';
import * as store from './store';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type Run, type Study } from './types';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const articles = (n: number): Doc[] =>
  Array.from({ length: n }, (_, i) => ({ id: `d${i}`, studyId: 's', docId: `art_${i}`, text: `T${i}`, meta: { file: `art_${i}.md` }, source: `art_${i}.md`, order: i, addedAt: '' }));
const plain = (userTemplate: string): PromptSpec => ({ ...DEFAULT_PROMPT, outputMode: 'text', variables: [], includeRationale: false, userTemplate });
const ordinal = (name: string) => ({ name, type: 'ordinal' as const, values: ['-3', '-2', '-1', '0', '1', '2', '3'], description: '' });
const structured = (variables: PromptSpec['variables']): PromptSpec => ({ ...DEFAULT_PROMPT, outputMode: 'structured', includeRationale: false, variables });
let number = 0;
const mkRun = (id: string, docs: Doc[], prompt: PromptSpec): Run => ({
  id, studyId: 's', number: ++number, label: '', createdAt: '', finishedAt: '', mode: 'sync', scope: 'All', docIds: docs.map((d) => d.id), status: 'completed', batch: null, error: null,
  snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt, promptVersion: 1, promptHash: `h${id}`, outputSchema: null, requestBase: {} },
});
const mkResult = (run: Run, d: Doc, values: Record<string, string>): Result => ({
  id: `${run.id}:${d.id}:1`, runId: run.id, studyId: 's', docId: d.id, replicate: 1, status: 'ok', values, rationale: '', reasoningSummary: '', rawText: '', parseError: null,
  error: null, usage, latencyMs: 1, requestedAt: '', completedAt: '', responseId: `msg_${run.id}_${d.id}`, modelReported: 'm', stopReason: 'end_turn',
});
const table = async (name: string, content: Blob | string) => {
  const r = await parseFile(new File([content], name));
  if (r.kind !== 'table') throw new Error(r.kind === 'error' ? r.error : r.kind);
  return r.table;
};
const withColumn = (t: ParsedTable, c: string, value: (row: Record<string, string>, i: number) => string): ParsedTable => ({
  ...t, columns: [...t.columns, c], rows: t.rows.map((r, i) => ({ ...r, [c]: value(r, i) })),
});
const check = (docs: Doc[], t: ParsedTable, key: string, runs: Run[], rs: Result[], prompts: PromptSpec[]) =>
  resultsTable(t, runs, rs, matchLabels(docs, t, key).updates, prompts, key);

describe('K2: a Results sheet whose answers the study doesn’t know by name: its answer columns are named', () => {
  const docs = articles(20);
  const p = plain('Return JSON with tone_explanation and tone (-3..3).');
  const pilot = mkRun('pilot', docs, p);
  const why = (i: number) => `Article ${i} reads as calm and measured overall, by its wording.`;
  const pilotResults = docs.map((d, i) => mkResult(pilot, d, { response: JSON.stringify({ tone_explanation: why(i), tone: (i % 7) - 3 }) }));
  const study = { id: 's', name: 'S', description: '', createdAt: '', updatedAt: '', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt: p, savedPrompts: [] } as unknown as Study;
  // The pilot's exported Results (CSV, and the Excel Results sheet), in which the owner coded tone_gold.
  const sheets = async () => {
    const csv = await table('results.csv', toCsv(resultsWide(pilot, docs, [pilot], pilotResults, { text: false, rationale: false }).map((r, i) => ({ ...r, tone_gold: String(i % 3) }))));
    const xl = await table('results.xlsx', await buildExcel({ study, docs, runs: [pilot], results: pilotResults }, pilot, { text: false, rationale: false }));
    return [
      [csv, 'doc_id'],
      [withColumn(xl, 'tone_gold', (_, i) => String(i % 3)), 'file'],
    ] as const;
  };

  it('a plain-text sheet from a run not in this study (deleted, or another study’s): tone and tone_explanation named, tone_gold not', async () => {
    for (const [t, key] of await sheets()) {
      expect(t.columns).toEqual(expect.arrayContaining(['tone', 'tone_explanation', 'response', 'n_ok', 'n_error', 'tone_gold']));
      const got = check(docs, t, key, [], [], [p]);
      expect(got.columns).toEqual(['response', 'n_ok', 'n_error']);
      expect(got.unknown).toEqual(['tone', 'tone_explanation']);
    }
  });
  it('… also when a later plain-text run with other JSON keys (tone_score, explanation) is in this study', async () => {
    const later = mkRun('later', docs, plain('Return JSON with explanation and tone_score.'));
    const laterResults = docs.map((d, i) => mkResult(later, d, { response: JSON.stringify({ explanation: `Other words ${i} about this article’s tone overall.`, tone_score: (i % 5) - 2 }) }));
    for (const [t, key] of await sheets()) expect(check(docs, t, key, [later], laterResults, [later.snapshot.prompt]).unknown).toEqual(['tone', 'tone_explanation']);
  });
  it('the pilot run in this study: its columns are found to be the model’s, and nothing else is named (H13)', async () => {
    for (const [t, key] of await sheets()) {
      expect(check(docs, t, key, [pilot], pilotResults, [p])).toMatchObject({ sure: true, unknown: [] });
      expect(check(docs, withColumn(t, 'note', () => 'see text'), key, [pilot], pilotResults, [p]).unknown).toEqual([]);
    }
  });
  it('a sheet with every field of a run here and another field’s answers and explanations: those named', async () => {
    const wide = mkRun('wide', docs, p);
    const wideResults = docs.map((d, i) => mkResult(wide, d, { response: JSON.stringify({ tone_explanation: why(i), tone: (i % 7) - 3, stance: i % 3, stance_explanation: `Stance ${i}.` }) }));
    const t = withColumn(await table('results.csv', toCsv(resultsWide(wide, docs, [wide], wideResults, { text: false, rationale: false }))), 'tone_gold', (_, i) => String(i % 3));
    // This study has the pilot (tone and tone_explanation only), not the run whose sheet it is.
    const got = check(docs, withColumn(t, 'note', () => 'see text'), 'doc_id', [pilot], pilotResults, [p]);
    expect(got.copied).toEqual(['tone', 'tone_explanation']);
    expect(got.unknown).toEqual(['stance', 'stance_explanation']);
  });
  it('structured: a field removed from the prompt after its run was deleted is named (a prompt alone shows no sheet complete)', async () => {
    const old = mkRun('old', docs, structured([ordinal('tone'), ordinal('stance')]));
    const oldResults = docs.map((d, i) => mkResult(old, d, { tone: String((i % 7) - 3), stance: String((i % 5) - 2) }));
    const t = await table('results.csv', toCsv(resultsWide(old, docs, [old], oldResults, { text: false, rationale: false }).map((r, i) => ({ ...r, tone_gold: String(i % 3) }))));
    expect(check(docs, t, 'doc_id', [], [], [structured([ordinal('tone')])])).toMatchObject({ columns: ['tone', 'n_ok', 'n_error'], unknown: ['stance'] });
    // With that run here, its fields are all there: nothing else named.
    expect(check(docs, t, 'doc_id', [old], oldResults, [structured([ordinal('tone')])]).unknown).toEqual([]);
  });
});

describe('K2 (review): a run here with some of the sheet’s fields shows the sheet is that run’s only when the sheet holds its answers', () => {
  const docs = articles(20);
  // The owner's JSON with one overall explanation (no <x>_explanation pairs).
  const p = plain('Return JSON with tone (-3..3) and explanation.');
  const pilot = mkRun('pilot', docs, p);
  const pilotResults = docs.map((d, i) => mkResult(pilot, d, { response: JSON.stringify({ tone: (i % 7) - 3, explanation: `Pilot words ${i}: the article reads as calm overall.` }) }));
  const sheet = async (run: Run, rs: Result[], extra: Record<string, (i: number) => string>) =>
    table('results.csv', toCsv(resultsWide(run, docs, [run], rs, { text: false, rationale: false }).map((r, i) => ({ ...r, ...Object.fromEntries(Object.entries(extra).map(([c, f]) => [c, f(i)])) }))));

  it('a sheet of another run (tone, stance, explanation) while the pilot (tone, explanation) is here: stance is named', async () => {
    const main = mkRun('main', docs, plain('Return JSON with tone, stance and explanation.'));
    const mainResults = docs.map((d, i) => mkResult(main, d, { response: JSON.stringify({ tone: (i % 5) - 2, stance: (i % 3) - 1, explanation: `Main words ${i}: a different reading of the article.` }) }));
    const t = await sheet(main, mainResults, { tone_gold: (i) => String(i % 3) });
    const got = check(docs, t, 'doc_id', [pilot], pilotResults, [p]);
    expect(got.copied).toEqual([]);
    expect(got.unknown).toEqual(['stance']);
  });
  it('the pilot’s own sheet: nothing else named, also not the owner’s explanations of their labels', async () => {
    const t = await sheet(pilot, pilotResults, { tone_gold: (i) => String(i % 3), tone_gold_explanation: (i) => `My reason ${i}.`, coder_explanation: () => 'checked' });
    expect(check(docs, t, 'doc_id', [pilot], pilotResults, [p]).unknown).toEqual([]);
  });
  it('structured: a run here with the sheet’s first field only, the sheet another run’s: its other field is named', async () => {
    const here = mkRun('here', docs, structured([ordinal('tone')]));
    const hereResults = docs.map((d, i) => mkResult(here, d, { tone: String((i % 7) - 3) }));
    const gone = mkRun('gone', docs, structured([ordinal('tone'), ordinal('stance')]));
    const goneResults = docs.map((d, i) => mkResult(gone, d, { tone: String((i % 4) - 1), stance: String((i % 5) - 2) }));
    const t = await sheet(gone, goneResults, { tone_gold: (i) => String(i % 3) });
    expect(check(docs, t, 'doc_id', [here], hereResults, [here.snapshot.prompt]).unknown).toEqual(['stance']);
    // The sheet of the run here (tone only) with the owner's own column: nothing named.
    const own = await sheet(here, hereResults, { tone_gold: (i) => String(i % 3) });
    expect(check(docs, own, 'doc_id', [here], hereResults, [here.snapshot.prompt]).unknown).toEqual([]);
  });
  it('entries: the Results sheet of a run here (short answers, which are never compared) with the owner’s answers: nothing named', async () => {
    const people: Doc[] = Array.from({ length: 12 }, (_, i) => ({ id: `e${i}`, studyId: 's', docId: `Person ${i}`, text: `name: Person ${i}`, meta: { name: `Person ${i}` }, source: 'paste', order: i, addedAt: '' }));
    const fame = mkRun('fame', people, { ...structured([ordinal('fame')]), subject: 'entries' });
    const fameResults = people.map((d, i) => mkResult(fame, d, { fame: String((i % 7) - 3) }));
    const rows = resultsWide(fame, people, [fame], fameResults, { text: false, rationale: false }).map((r, i) => ({ ...r, my_fame: String((i % 3) - 1) }));
    const t = await table('results.csv', toCsv(rows));
    const got = check(people, t, 'doc_id', [fame], fameResults, [fame.snapshot.prompt]);
    expect(got.columns).toEqual(['fame', 'n_ok', 'n_error']);
    expect(got.unknown).toEqual([]);
  });
});

// ---------- K25: the table import dialog counts what is added ----------

/** A browser's localStorage, in memory (Node has none). */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

describe('K25: the table import dialog’s counts are those of what is added', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('fetch', async (u: unknown) => {
      throw new Error(`unexpected request: ${String(u)}`);
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Paste `text` as entries with `shown` ticked: the dialog's counts, then what adding stores. */
  async function paste(text: string, shown: string[]) {
    const t = parsePastedTable(text);
    const a = tableAddition(t, { entry: true, shown, textCol: '', idCol: '', skipEmpty: true }, store.getState().docs);
    const before = store.getState().docs.length;
    await store.addDocs(a.items);
    const added = store.getState().docs.slice(before);
    return { a, added: added.map((d) => d.docId) };
  }

  it('rows the same in every column are counted once; a repeated name with other details still gets a suffix', async () => {
    for (const s of await dbApi.listStudies()) await dbApi.deleteStudy(s.id);
    await store.createStudy('Paste checks', 'entries');
    // One column with a name twice (or Excel's ditto mark): added once, so no _2 either.
    const c1 = await paste('name\nNiels Bohr\nJohn Smith\nJohn Smith\nAda Lovelace\n', ['name']);
    expect(c1.a.rows.length).toBe(4);
    expect(c1.a).toMatchObject({ nAdded: 3, repeated: [] });
    expect(c1.a.plan.twice).toEqual(['John Smith']);
    expect(c1.added).toEqual(['Niels Bohr', 'John Smith', 'Ada Lovelace']);
    // The same list again: nothing is added, and the dialog says so (Import is disabled at 0).
    const c2 = await paste('name\nNiels Bohr\nJohn Smith\nJohn Smith\nAda Lovelace\n', ['name']);
    expect(c2.a.nAdded).toBe(0);
    expect(c2.a.plan.already + c2.a.plan.elsewhere.length).toBe(4);
    expect(c2.added).toEqual([]);

    await store.createStudy('Answers', 'entries');
    // Two John Smiths with different answers of the owner's (not ticked): both added, the second as John Smith_2;
    // a third row the same as the first in every column is left out.
    const f = await paste('name\tborn\tmy_fame\nJohn Smith\t1900\t2\nJohn Smith\t1900\t2\nJohn Smith\t1900\t-1\nKaren Blixen\t1885\t3\n', ['name', 'born']);
    expect(f.a).toMatchObject({ nAdded: 3, repeated: ['John Smith'] });
    expect(f.a.plan.twice).toEqual(['John Smith']);
    expect(f.added).toEqual(['John Smith', 'John Smith_2', 'Karen Blixen']);
  });

  it('a corpus table (texts): a row repeated in every column is counted once, the rest with their own suffix', async () => {
    await store.createStudy('Corpus');
    const t = parsePastedTable('id,text,era\na1,First article.,1990\na1,First article.,1990\na1,Another text under the same ID.,2000\na2,Second article.,1990\n');
    const a = tableAddition(t, { entry: false, shown: [], textCol: 'text', idCol: 'id', skipEmpty: true }, store.getState().docs);
    expect(a).toMatchObject({ nAdded: 3, repeated: ['a1'] });
    await store.addDocs(a.items);
    expect(store.getState().docs.map((d) => d.docId)).toEqual(['a1', 'a1_2', 'a2']);
  });
});
