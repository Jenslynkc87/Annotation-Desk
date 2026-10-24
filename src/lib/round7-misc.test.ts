// Round seven of the review fixes: sample notes a redraw keeps, the "other columns" of a results sheet, and rows
// added again (regression tests, after the seventh verification of October 24, 2026). Providers are stubbed: nothing
// is sent anywhere (any request that does reach `fetch` fails the test).
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tableAddition } from '../components/CorpusImport';
import * as dbApi from './db';
import { sortAddition } from './dedupe';
import { buildBackup, importBackup } from './export/backup';
import { resultsWide, toCsv } from './export/tables';
import { matchLabels, resultsTable } from './import/labels';
import { parseFile, parsePastedTable, type ParsedTable } from './import/parse';
import { anthropicAdapter } from './providers/anthropic';
import type { BatchItem, CallOutcome, ListedBatch, ProviderAdapter } from './providers/types';
import { dependentSamples, drawStratifiedSample, leavesOutCurrent, replaceSampleNotes, sampleNote } from './sample';
import * as store from './store';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type Run } from './types';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const outcome = (rawText: string): CallOutcome => ({ rawText, reasoningSummary: '', usage, responseId: `id_${Math.random()}`, modelReported: 'm', stopReason: 'end_turn', response: {} });
const connectionError = () => new Error('Connection error.');

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

const confirms: string[] = [];
beforeEach(() => {
  confirms.length = 0;
  (globalThis as Record<string, unknown>).confirm = (m: string) => (confirms.push(m), true);
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('fetch', async (u: unknown) => {
    throw new Error(`unexpected request: ${String(u)}`);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function emptyDatabase() {
  for (const s of await dbApi.listStudies()) await dbApi.deleteStudy(s.id);
}
const docIds = () => store.getState().docs.map((d) => d.docId);
const toasts = () => store.getState().toasts.map((t) => t.text);

// ---------- M6, M12: the notes a redraw keeps ----------

const w = { one: 'text', many: 'texts' };
const D = '2026-10-24';
const note = (value: string, rest: string, seed: number, size = '10 of 400') =>
  `Sample sample = ${value} (${D}): ${size} texts drawn at random${rest}; seed ${seed} (Annotation Desk sampling method 3).`;

describe('a redraw names (and keeps the notes of) only the draws that depend on it (M6)', () => {
  it('a note in the count form depends only on values drawn before it', () => {
    const notes = [
      note('a', '', 1),
      note('b', ', not from the 10 texts already marked sample = a (drawn 2026-10-24, 10 of 400 texts, seed 1)', 2),
      note('e', ', not from the 40 texts whose sample already holds another value (4 values)', 5),
      note('f', ', not from the 50 texts whose sample already holds another value (5 values)', 6),
    ].join('\n');
    // f was drawn after e's note: e didn't leave its texts out.
    expect(dependentSamples(notes, 'sample', 'f', w)).toEqual([]);
    expect(replaceSampleNotes(notes, 'sample', 'f', D, w).split('\n')).toEqual(notes.split('\n').slice(0, 3));
    // a was drawn before e and f, whose notes count it: both depend on it (and on b, also drawn before them).
    expect(dependentSamples(notes, 'sample', 'a', w)).toEqual(['sample = b', 'sample = e', 'sample = f']);
    expect(replaceSampleNotes(notes, 'sample', 'a', D, w)).toMatch(/^\(replaced 2026-10-24\) Sample sample = a /);
    // (A count-form note of the value redrawn itself counts other values only.)
    expect(replaceSampleNotes(notes, 'sample', 'f', D, w, note('f', ', not from the 50 texts whose sample already holds another value (5 values)', 7))).not.toContain('replaced');
  });

  it('a value is not read in a longer one that starts with it (“pilot, wave 2”, “v1.1”, “pilot and pretest”)', () => {
    for (const longer of ['pilot, wave 2', 'pilot.1', 'pilot and pretest']) {
      const notes = [
        note('pilot', '', 1),
        note(longer, '', 2),
        note('holdout', `, not from the 10 texts already marked sample = ${longer} (drawn 2026-10-24, 10 of 400 texts, seed 2)`, 3, '50 of 390'),
        note('test', `, excluding sample = ${longer} (drawn 2026-10-24, 10 of 400 texts, seed 2)`, 4, '5 of 390'),
      ].join('\n');
      expect(dependentSamples(notes, 'sample', 'pilot', w)).toEqual([]);
      expect(replaceSampleNotes(notes, 'sample', 'pilot', D, w)).not.toContain('replaced');
      // The longer value itself is still read, in every place a note writes one.
      expect(dependentSamples(notes, 'sample', longer, w)).toEqual(['sample = holdout', 'sample = test']);
    }
  });

  it('every way a note names a value is still read: labelled or not, first, among others or last', () => {
    const v = note('validation', '', 11, '20 of 300');
    const label = '(drawn 2026-10-24, 20 of 300 texts, seed 11)';
    const names = [
      `, not from the 20 texts already marked sample = validation ${label}`,
      `, not from the 20 texts already marked sample = validation ${label} and the 5 marked sample = pilot (no draw recorded)`,
      `, not from the 5 texts already marked sample = pilot (no draw recorded), the 20 marked sample = validation ${label} and the 3 marked sample = x (no draw recorded)`,
      `, excluding sample = validation ${label}`,
      `, excluding sample = validation ${label}, not from the 5 texts already marked sample = pilot (no draw recorded)`,
      // (Notes of October 24, 2026 and before name no draw.)
      ', not from the 20 texts already marked sample = validation',
      ', not from the 20 texts already marked sample = validation and the 5 marked sample = pilot',
      ', excluding sample = validation',
    ];
    for (const n of names) expect(dependentSamples(`${v}\n${note('holdout', n, 22, '100 of 280')}`, 'sample', 'validation', w)).toEqual(['sample = holdout']);
    // An unlabelled note written before the draw now marked can't have left out its texts.
    expect(dependentSamples(`${note('holdout', names[5], 22, '100 of 280')}\n${v}`, 'sample', 'validation', w)).toEqual([]);
  });

  it('with real draws: five values in one column, then the last redrawn, keeps no stray note', () => {
    const docs: Doc[] = Array.from({ length: 400 }, (_, i) => ({
      id: `d${i}`, studyId: 's', docId: `a${i}`, text: `t ${i}`, meta: { file: `a${String(i).padStart(3, '0')}.txt`, era: ['1960s', '1980s', '2000s'][i % 3] }, source: 'x', order: i, addedAt: '',
    }));
    let notes = '';
    const draw = (value: string, size: number, seed: number) => {
      const r = drawStratifiedSample(docs, { size, strata: ['era'], exclude: null, seed, markedAs: { column: 'sample', value } });
      const n = sampleNote({ column: 'sample', value, date: D, strata: ['era'], exclude: null, seed }, r, w, notes);
      const deps = dependentSamples(notes, 'sample', value, w);
      notes = `${replaceSampleNotes(notes, 'sample', value, D, w, n)}\n${n}`.trim();
      const chosen = new Set(r.ids);
      for (const d of docs) {
        if (chosen.has(d.id)) d.meta.sample = value;
        else if (d.meta.sample === value) delete d.meta.sample;
      }
      return deps;
    };
    for (const [v, seed] of [['a', 1], ['b', 2], ['c', 3], ['dd', 4], ['e', 5], ['f', 6]] as const) draw(v, 10, seed);
    expect(notes.split('\n').at(-1)).toContain('whose sample already holds another value (5 values)');
    expect(draw('f', 12, 7)).toEqual([]);
    expect(draw('f', 14, 8)).toEqual([]);
    expect(notes).not.toContain('replaced');
    // Redrawing a value drawn before the others keeps its note: their draws left its texts out.
    expect(draw('a', 12, 9)).toEqual(['sample = b', 'sample = c', 'sample = dd', 'sample = e', 'sample = f']);
    expect(notes.split('\n')[0]).toMatch(/^\(replaced 2026-10-24\) Sample sample = a .*; seed 1 /);
  });
});

describe('a fresh sample of the same value, leaving out the texts marked so now, keeps the note of their draw (M12)', () => {
  const docs = (): Doc[] =>
    Array.from({ length: 300 }, (_, i) => ({
      id: `d${i}`, studyId: 's', docId: `a${i}`, text: `text ${i}`, meta: { file: `a${String(i).padStart(3, '0')}.txt`, era: ['1960s', '1980s', '2000s'][i % 3] }, source: 'x', order: i, addedAt: '',
    }));
  const exclude = { column: 'sample', value: 'validation' };
  const markedAs = { column: 'sample', value: 'validation' };

  it('the old note is kept as replaced, the dialog says so, and the new sample is drawn again from the notes alone', () => {
    const all = docs();
    const r1 = drawStratifiedSample(all, { size: 20, strata: ['era'], exclude: null, seed: 11, markedAs });
    const n1 = sampleNote({ ...markedAs, date: D, strata: ['era'], exclude: null, seed: 11 }, r1, w, '');
    for (const d of all) if (r1.ids.includes(d.id)) d.meta.sample = 'validation';
    const r2 = drawStratifiedSample(all, { size: 20, strata: ['era'], exclude, seed: 12, markedAs });
    const n2 = sampleNote({ ...markedAs, date: D, strata: ['era'], exclude, seed: 12 }, r2, w, n1);
    expect(n2).toContain('excluding sample = validation (drawn 2026-10-24, 20 of 300 texts, seed 11); seed 12');
    // What the dialog shows: no other draw depends on them, this one does.
    expect(dependentSamples(n1, 'sample', 'validation', w)).toEqual([]);
    expect(leavesOutCurrent(n1, 'sample', 'validation', n2, w)).toBe(true);
    // (Without the note being added, as before: the note of the texts it left out was dropped.)
    expect(replaceSampleNotes(n1, 'sample', 'validation', D, w)).toBe('');
    const kept = replaceSampleNotes(n1, 'sample', 'validation', D, w, n2);
    expect(kept).toBe(`(replaced ${D}) ${n1}`);
    // From the notes: the seed-11 draw on the texts without marks, then the seed-12 draw leaving those out.
    const bare = docs();
    const v1 = drawStratifiedSample(bare, { size: 20, strata: ['era'], exclude: null, seed: Number(/seed (\d+) \(/.exec(kept)![1]), markedAs }).ids;
    for (const d of bare) if (v1.includes(d.id)) d.meta.sample = 'validation';
    expect(drawStratifiedSample(bare, { size: 20, strata: ['era'], exclude, seed: 12, markedAs }).ids).toEqual(r2.ids);
  });

  it('leaving out another value, or none, says nothing and keeps nothing', () => {
    const n1 = note('validation', '', 11, '20 of 300');
    const other = note('validation', ', excluding sample = pilot (no draw recorded)', 12, '20 of 290');
    const none = note('validation', ', not from the 40 texts whose sample already holds another value (4 values)', 13, '20 of 260');
    for (const n of [other, none]) {
      expect(leavesOutCurrent(n1, 'sample', 'validation', n, w)).toBe(false);
      expect(replaceSampleNotes(n1, 'sample', 'validation', D, w, n)).toBe('');
    }
    // Nothing marked validation by a draw: nothing to keep.
    expect(leavesOutCurrent('', 'sample', 'validation', note('validation', ', excluding sample = validation (no draw recorded)', 12), w)).toBe(false);
  });
});

// ---------- M7, M8: a results sheet's other columns ----------

const usageR = usage;
const plain = (t: string): PromptSpec => ({ ...DEFAULT_PROMPT, outputMode: 'text', variables: [], includeRationale: false, userTemplate: t });
const structured = (fields: string[], entries = false): PromptSpec => ({
  ...DEFAULT_PROMPT,
  ...(entries ? { subject: 'entries' as const } : {}),
  outputMode: 'structured',
  includeRationale: false,
  variables: fields.map((name) => ({ name, type: 'text' as const, values: [], description: '' })),
});
let number = 0;
const mkRun = (id: string, docs: Doc[], prompt: PromptSpec): Run => ({
  id, studyId: 's', number: ++number, label: '', createdAt: '', finishedAt: '', mode: 'sync', scope: 'All', docIds: docs.map((d) => d.id), status: 'completed', batch: null, error: null,
  snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt, promptVersion: 1, promptHash: `h${id}`, outputSchema: null, requestBase: {} },
});
const mkResult = (run: Run, d: Doc, values: Record<string, string>): Result => ({
  id: `${run.id}:${d.id}:1`, runId: run.id, studyId: 's', docId: d.id, replicate: 1, status: 'ok', values, rationale: '', reasoningSummary: '', rawText: '', parseError: null,
  error: null, usage: usageR, latencyMs: 1, requestedAt: '', completedAt: '', responseId: `msg_${run.id}_${d.id}`, modelReported: 'm', stopReason: 'end_turn',
});
const sheet = async (rows: Record<string, unknown>[]) => {
  const r = await parseFile(new File([toCsv(rows as never)], 'results.csv'));
  if (r.kind !== 'table') throw new Error(r.kind);
  return r.table;
};
/** The columns the labels dialog names as possibly the model's answers (its `others`). */
const named = (docs: Doc[], t: ParsedTable, runs: Run[], rs: Result[], prompts: PromptSpec[]) => {
  const m = matchLabels(docs, t, 'doc_id');
  return resultsTable(t, runs, rs, m.updates, prompts, 'doc_id', m.replaced).unknown.filter((c) => !m.replaced.includes(c));
};

describe('the other columns named don’t depend on which run’s answers load first (M7)', () => {
  const docs: Doc[] = Array.from({ length: 20 }, (_, i) => ({
    id: `d${i}`, studyId: 's', docId: `art_${i}`, text: `T${i}`, meta: { file: `art_${i}.md`, era: i % 2 ? '1990s' : '2010s' }, source: `art_${i}.md`, order: i, addedAt: '',
  }));
  const pilot = mkRun('pilot', docs, plain('Return JSON with tone_explanation, tone and flag.'));
  const pilotResults = docs.map((d, i) => mkResult(pilot, d, { response: JSON.stringify({ tone_explanation: `Pilot says article ${i} is calm and measured.`, tone: (i % 7) - 3, flag: i % 2 }) }));
  const main = mkRun('main', docs, plain('Return JSON with tone_explanation and tone.'));
  const mainResults = docs.map((d, i) => mkResult(main, d, { response: JSON.stringify({ tone_explanation: `Main run: article ${i} reads as balanced overall.`, tone: (i % 5) - 2 }) }));

  it('the main run’s Results sheet with the owner’s own columns: nothing else named, in either order', async () => {
    const rows = resultsWide(main, docs, [pilot, main], mainResults, { text: false, rationale: false }).map((r, i) => ({ ...r, tone_gold: String(i % 3), notes: i % 4 ? '' : 'check intro', tone_jk: String(i % 2) }));
    const t = await sheet(rows);
    for (const results of [[...pilotResults, ...mainResults], [...mainResults, ...pilotResults]]) expect(named(docs, t, [pilot, main], results, [main.snapshot.prompt])).toEqual([]);
  });

  it('the pilot’s sheet (its extra key flag known from its answers): nothing else named either', async () => {
    const t = await sheet(resultsWide(pilot, docs, [pilot, main], pilotResults, { text: false, rationale: false }).map((r) => ({ ...r, notes: 'x' })));
    for (const results of [[...pilotResults, ...mainResults], [...mainResults, ...pilotResults]]) expect(named(docs, t, [pilot, main], results, [main.snapshot.prompt])).toEqual([]);
  });

  it('a run of prose answers is read 20 times, not once per answer (a big study)', async () => {
    const many: Doc[] = Array.from({ length: 3000 }, (_, i) => ({ id: `p${i}`, studyId: 's', docId: `big_${i}`, text: `T${i}`, meta: {}, source: 'x', order: i, addedAt: '' }));
    const prose = mkRun('prose', many, plain('Describe the tone.'));
    const proseResults = many.map((d, i) => mkResult(prose, d, { response: `${i} The article reads as measured and calm.` }));
    const t = await sheet(docs.slice(0, 5).map((d, i) => ({ doc_id: d.docId, tone_explanation: `My own note ${i}.`, n_ok: 1, n_error: 0 })));
    const parse = vi.spyOn(JSON, 'parse');
    const m = matchLabels(docs, t, 'doc_id');
    resultsTable(t, [prose, main], [...proseResults, ...mainResults], m.updates, [main.snapshot.prompt], 'doc_id', m.replaced);
    expect(parse.mock.calls.length).toBeLessThan(100);
  });
});

describe('a deleted run’s extra field is named although a run here has the sheet’s other fields (M8)', () => {
  for (const entries of [true, false]) {
    it(`${entries ? 'entries' : 'texts'}: the field the run here lacks (died) is named, the owner’s own column after the export’s is not`, async () => {
      const docs: Doc[] = Array.from({ length: 20 }, (_, i) => ({
        id: `d${i}`, studyId: 's', docId: `Person ${i}`, text: `name: Person ${i}`, meta: (entries ? { name: `Person ${i}` } : { file: `p${i}.md` }) as Record<string, string>, source: 'x', order: i, addedAt: '',
      }));
      const pilot = mkRun('p', docs, structured(['born', 'country', 'died'], entries));
      const pilotResults = docs.map((d, i) => mkResult(pilot, d, { born: String(1900 + i), country: ['DK', 'SE', 'NO'][i % 3], died: String(1970 + i) }));
      // (The run here gives the same country for every one of them: in a text study, a copy of its answers.)
      const here = mkRun('m', docs, structured(['born', 'country'], entries));
      const hereResults = docs.map((d, i) => mkResult(here, d, { born: String(1900 + i + (i % 4 === 0 ? 1 : 0)), country: ['DK', 'SE', 'NO'][i % 3] }));
      const t = await sheet(resultsWide(pilot, docs, [pilot], pilotResults, { text: false, rationale: false }).map((r, i) => ({ ...r, died_check: String(1970 + i) })));
      expect(named(docs, t, [here], hereResults, [here.snapshot.prompt])).toEqual(['died']);
      // The run here's own sheet with the same column of the owner's: nothing named.
      const own = await sheet(resultsWide(here, docs, [here], hereResults, { text: false, rationale: false }).map((r, i) => ({ ...r, died_check: String(1970 + i) })));
      expect(named(docs, own, [here], hereResults, [here.snapshot.prompt])).toEqual([]);
    });
  }

  it('a run here’s own sheet, matched by its file column or with the owner’s column put beside a field: neither doc_id nor that column is named', async () => {
    const docs: Doc[] = Array.from({ length: 20 }, (_, i) => ({
      id: `d${i}`, studyId: 's', docId: `art_${i}`, text: `T${i}`, meta: { file: `art_${i}.md`, era: i % 2 ? '1990s' : '2010s' }, source: `art_${i}.md`, order: i, addedAt: '',
    }));
    const run = mkRun('r', docs, { ...structured(['tone', 'tone_explanation']) });
    const rs = docs.map((d, i) => mkResult(run, d, { tone: String((i % 7) - 3), tone_explanation: `Article ${i} is measured and calm in its framing of the issue.` }));
    const rows = resultsWide(run, docs, [run], rs, { text: false, rationale: false }) as Record<string, unknown>[];
    const beside = rows.map(({ doc_id, file, tone, ...rest }, i) => ({ doc_id, file, tone, tone_jk: String(i % 3), ...rest }));
    for (const [t, key] of [[await sheet(rows.map((r) => ({ ...r, notes: 'x' }))), 'file'], [await sheet(beside), 'doc_id'], [await sheet(beside), 'file']] as const) {
      const m = matchLabels(docs, t, key);
      expect(resultsTable(t, [run], rs, m.updates, [run.snapshot.prompt], key, m.replaced).unknown.filter((c) => !m.replaced.includes(c))).toEqual([]);
    }
  });
});

// ---------- M11, M19: rows added again ----------

const stored = (rows: { docId: string; text: string; meta: Record<string, string>; source: string }[]): Doc[] =>
  rows.map((r, i) => ({ ...r, id: `x${i}`, studyId: 's', order: i, addedAt: '' }));

describe('an extended paragraph table imported again adds a new paragraph whose words repeat an earlier one of its file (M11)', () => {
  const table = (rows: [string, string, string][]): ParsedTable => ({ name: 'paras.csv', columns: ['para_id', 'file', 'text'], rows: rows.map(([para_id, file, text]) => ({ para_id, file, text })) });
  const opts = { entry: false, shown: [], textCol: 'text', idCol: 'para_id', skipEmpty: true };
  const first: [string, string, string][] = [
    ['p01', 'art1.pdf', 'Intro.'],
    ['p02', 'art1.pdf', 'Notes'],
    ['p03', 'art1.pdf', 'Body.'],
  ];
  const extended: [string, string, string][] = [...first, ['p04', 'art1.pdf', 'More body.'], ['p05', 'art1.pdf', 'Notes'], ['p06', 'art2.pdf', 'Notes']];

  it('the dialog counts p05 as new (the same table again adds nothing)', () => {
    const before = stored(tableAddition(table(first), opts, []).items);
    const a = tableAddition(table(extended), opts, before);
    expect([a.nAdded, a.plan.already, a.plan.kept.map((x) => x.docId)]).toEqual([3, 3, ['p04', 'p05', 'p06']]);
    const all = stored(tableAddition(table(extended), opts, []).items);
    expect(tableAddition(table(extended), opts, all).nAdded).toBe(0);
    // (Stored with a suffix, p02_2, the same row is still found.)
    expect(sortAddition([{ docId: 'p02', text: 'Notes', meta: { file: 'art1.pdf' }, source: 'paras.csv' }], stored([{ docId: 'p02_2', text: 'Notes', meta: { file: 'art1.pdf' }, source: 'paras.csv' }])).already).toBe(1);
  });

  it('files dropped again, or a table row the same as a stored file, are still skipped by name and text', () => {
    const files = stored([{ docId: 'art1', text: 'Whole article.', meta: { file: 'art1.pdf' }, source: 'art1.pdf' }]);
    expect(sortAddition([{ docId: 'art1', text: 'Whole article.', meta: { file: 'art1.pdf' }, source: 'art1.pdf' }], files).already).toBe(1);
    expect(sortAddition([{ docId: 'p01', text: 'Whole article.', meta: { file: 'art1.pdf' }, source: 'paras.csv' }], files).already).toBe(1);
    // Numbered rows (no ID column) keep their rule too.
    const numbered = stored([{ docId: 'paras_2', text: 'Notes', meta: { file: 'art1.pdf' }, source: 'paras.csv' }]);
    expect(sortAddition([{ docId: 'paras_5', text: 'Notes', meta: { file: 'art1.pdf' }, source: 'paras.csv' }], numbered).already).toBe(1);
  });
});

describe('entries pasted again with the columns the model sees in another order are found (M19)', () => {
  const rows = [
    ['Niels Bohr', '1885', 'Denmark', '3'],
    ['Karen Blixen', '1885', 'Denmark', '2'],
    ['Greta Garbo', '1905', 'Sweden', '2'],
  ];
  const paste = (cols: string[], rs: string[][]) => parsePastedTable(`${cols.join('\t')}\n${rs.map((r) => r.join('\t')).join('\n')}\n`);
  const reorder = (r: string[]) => [r[2], r[0], r[1], r[3]];

  it('none of them is added again, with or without an ID column; new rows are', () => {
    const first = paste(['name', 'born', 'country', 'my_fame'], rows);
    const items = tableAddition(first, { entry: true, shown: ['name', 'born', 'country'], textCol: '', idCol: '', skipEmpty: true }, []).items;
    const here = stored(items);
    const again = paste(['country', 'name', 'born', 'my_fame'], [...rows.map(reorder), ['Denmark', 'Tove Ditlevsen', '1917', '1']]);
    const a = tableAddition(again, { entry: true, shown: ['country', 'name', 'born'], textCol: '', idCol: '', skipEmpty: true }, here);
    expect([a.nAdded, a.plan.already + a.plan.elsewhere.length, a.plan.kept.map((x) => x.docId)]).toEqual([1, 3, ['Tove Ditlevsen']]);
    // With an ID column.
    const ids = (cols: string[], rs: string[][]) => paste(['id', ...cols], rs.map((r, i) => [`p${i + 1}`, ...r]));
    const firstIds = tableAddition(ids(['name', 'born', 'country', 'my_fame'], rows), { entry: true, shown: ['name', 'born', 'country'], textCol: '', idCol: 'id', skipEmpty: true }, []).items;
    const b = tableAddition(ids(['country', 'name', 'born', 'my_fame'], rows.map(reorder)), { entry: true, shown: ['country', 'name', 'born'], textCol: '', idCol: 'id', skipEmpty: true }, stored(firstIds));
    expect([b.nAdded, b.plan.already]).toEqual([0, 3]);
  });

  it('in a text study, a text with its lines in another order is another text', () => {
    const here = stored([{ docId: 'a1', text: 'First line.\nSecond line.', meta: {}, source: 'corpus.csv' }]);
    expect(sortAddition([{ docId: 'a1', text: 'Second line.\nFirst line.', meta: {}, source: 'corpus.csv' }], here).kept).toHaveLength(1);
    expect(sortAddition([{ docId: 'a1', text: 'Second line.\nFirst line.', meta: {}, source: 'corpus.csv' }], here, true).kept).toHaveLength(0);
  });
});

// ---------- With the store (these need store.ts to use dedupe.ts and pass the new note, see the round's notes) ----------

describe('the store adds and marks as the dialogs count (M11, M12, M19)', () => {
  it('addDocs: the extended paragraph table stores p05', async () => {
    await emptyDatabase();
    await store.createStudy('Paragraphs');
    const t = (rows: [string, string][]) => ({ name: 'paras.csv', columns: ['para_id', 'file', 'text'], rows: rows.map(([para_id, text]) => ({ para_id, file: 'art1.pdf', text })) });
    const opts = { entry: false, shown: [], textCol: 'text', idCol: 'para_id', skipEmpty: true };
    const first: [string, string][] = [['p01', 'Intro.'], ['p02', 'Notes'], ['p03', 'Body.']];
    await store.addDocs(tableAddition(t(first), opts, store.getState().docs).items);
    await store.addDocs(tableAddition(t([...first, ['p04', 'More.'], ['p05', 'Notes']]), opts, store.getState().docs).items);
    expect(docIds()).toEqual(['p01', 'p02', 'p03', 'p04', 'p05']);
  });

  it('addDocs: entries pasted again with the columns in another order add only the new one', async () => {
    await emptyDatabase();
    await store.createStudy('Entries', 'entries');
    const paste = async (text: string, shown: string[]) => store.addDocs(tableAddition(parsePastedTable(text), { entry: true, shown, textCol: '', idCol: '', skipEmpty: true }, store.getState().docs).items);
    await paste('name\tborn\tcountry\nNiels Bohr\t1885\tDenmark\nGreta Garbo\t1905\tSweden\n', ['name', 'born', 'country']);
    const before = toasts().length;
    await paste('country\tname\tborn\nDenmark\tNiels Bohr\t1885\nSweden\tGreta Garbo\t1905\nDenmark\tTove Ditlevsen\t1917\n', ['country', 'name', 'born']);
    expect(docIds()).toEqual(['Niels Bohr', 'Greta Garbo', 'Tove Ditlevsen']);
    expect(toasts().slice(before)[0]).toBe('Skipped 2 entries already in this study (same name and identical details).');
  });

  it('markSample: a fresh validation sample leaving out the texts marked validation keeps their draw’s note', async () => {
    await emptyDatabase();
    await store.createStudy('Fresh validation');
    await store.addDocs(Array.from({ length: 300 }, (_, i) => ({ docId: `a${i}`, text: `text ${i}`, meta: { file: `a${String(i).padStart(3, '0')}.txt`, era: ['1960s', '1980s', '2000s'][i % 3] }, source: 'x' })));
    const today = new Date().toISOString().slice(0, 10);
    const draw = async (seed: number, exclude: { column: string; value: string } | null) => {
      const markedAs = { column: 'sample', value: 'validation' };
      const r = drawStratifiedSample(store.getState().docs, { size: 20, strata: ['era'], exclude, seed, markedAs });
      await store.markSample('sample', 'validation', r.ids, sampleNote({ ...markedAs, date: today, strata: ['era'], exclude, seed }, r, w, store.currentStudy()!.description), seed);
    };
    await draw(11, null);
    await draw(12, { column: 'sample', value: 'validation' });
    const lines = store.currentStudy()!.description.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(new RegExp(`^\\(replaced ${today}\\) Sample sample = validation \\(${today}\\): 20 of 300 texts .*; seed 11 `));
    expect(lines[1]).toContain(`excluding sample = validation (drawn ${today}, 20 of 300 texts, seed 11); seed 12`);
  });
});

// ---------- M5: a restored copy whose own retry upload is lost too still finds the remembered batch ----------

/** A provider's batches, as a stub of the adapter (as in round6-runs.test.ts); an ended batch can't be cancelled. */
function fakeBatches(adapter: ProviderAdapter) {
  type Made = { id: string; items: BatchItem[]; at: string; done: boolean; cancelled: boolean };
  const made: Made[] = [];
  let upload: () => 'ok' | 'lost' | Error = () => 'ok';
  const submit = vi.spyOn(adapter, 'submitBatch').mockImplementation(async (_k, _b, items) => {
    const how = upload();
    if (how instanceof Error) throw how;
    const id = `b${made.length + 1}`;
    made.push({ id, items, at: new Date().toISOString(), done: false, cancelled: false });
    if (how === 'lost') throw connectionError();
    return { batchId: id };
  });
  const list = vi.spyOn(adapter, 'listRecentBatches').mockImplementation(async () =>
    made.map((b): ListedBatch => ({ batchId: b.id, createdAt: b.at, requests: b.items.length, ...(b.cancelled ? { stopped: true } : {}) })).reverse(),
  );
  vi.spyOn(adapter, 'checkBatch').mockImplementation(async (_k, id) => {
    const b = made.find((x) => x.id === id);
    return { status: b?.done ? 'ended' : 'in_progress', done: !!b?.done, total: b?.items.length ?? 0, completed: 0, failed: 0, endedAt: b?.done ? new Date().toISOString() : undefined };
  });
  vi.spyOn(adapter, 'fetchBatchResults').mockImplementation(async (_k, id) => {
    const b = made.find((x) => x.id === id)!;
    return b.items.map((it) => ({ customId: it.customId, ok: true as const, outcome: { ...outcome(`answer ${it.customId} of ${id}`), responseId: `${id}_${it.customId}` } }));
  });
  vi.spyOn(adapter, 'cancelBatch').mockImplementation(async (_k, id) => {
    const b = made.find((x) => x.id === id);
    if (b?.done) throw Object.assign(new Error('Batch has already ended'), { status: 409 });
    if (b) [b.cancelled, b.done] = [true, true];
  });
  return { made, submit, list, uploads: (f: () => 'ok' | 'lost' | Error) => (upload = f) };
}

describe('a copy restored after a delete, whose own Retry failed loses its upload too, still finds the remembered batch (M5)', () => {
  const lastRun = () => store.getState().runs.at(-1)!;
  for (const shape of ['the delete finds it', 'a retry found it as either’s before the delete'] as const) {
    it(`${shape}, ended: the copy's next Retry failed adopts it, asks nothing and uploads nothing`, async () => {
      await emptyDatabase();
      await store.createStudy('Remembered');
      store.setKey('anthropic', 'sk-ant-test');
      store.updateStudy((s) => {
        s.prompt.userTemplate = 'Rate it.';
        s.prompt.outputMode = 'text';
        s.prompt.variables = [];
        s.options.batch = true;
      });
      await store.addDocs(Array.from({ length: 3 }, (_, i) => ({ docId: `t${i}`, text: `text ${i}`, meta: { file: `t${i}.txt` }, source: `t${i}.txt` })));
      const p = fakeBatches(anthropicAdapter);
      // U1 arrives (b1) without an answer, and can't be looked up.
      p.uploads(() => 'lost');
      p.list.mockRejectedValueOnce(connectionError());
      await store.startRun({ docIds: store.getState().docs.map((d) => d.id), scope: 'all' });
      const runId = lastRun().id;
      const older = await buildBackup(store.currentStudy()!, store.getState().docs, store.getState().runs, false);
      // Retry failed: no lookup, the upload (A2) never arrives, no lookup after it.
      p.list.mockRejectedValueOnce(connectionError()).mockRejectedValueOnce(connectionError());
      p.uploads(() => connectionError());
      await store.retryFailed(runId);
      const newer = await buildBackup(store.currentStudy()!, store.getState().docs, store.getState().runs, false);
      if (shape !== 'the delete finds it') await store.retryFailed(runId);
      p.made[0].done = true;
      await store.removeRun(runId);
      // The copy holding the other upload than the one the batch is remembered under.
      const copy = await importBackup(shape === 'the delete finds it' ? older : newer);
      await store.refreshStudies();
      await store.selectStudy(copy.id);
      // Its own Retry failed: no lookup, the upload never arrives, no lookup after it.
      p.list.mockRejectedValueOnce(connectionError()).mockRejectedValueOnce(connectionError());
      await store.retryFailed(lastRun().id);
      p.uploads(() => 'ok');
      confirms.length = 0;
      p.submit.mockClear();
      await store.retryFailed(lastRun().id);
      expect([confirms, p.submit.mock.calls.length, store.batchParts(lastRun()).map((x) => x.batchId)]).toEqual([[], 0, ['b1']]);
      await store.checkBatch(lastRun().id);
      expect([lastRun().status, store.getState().results.filter((r) => r.runId === lastRun().id && r.status === 'ok').length]).toEqual(['completed', 3]);
    });
  }
});
