// Tests for the fixes from the adversarial review of October 22, 2026 (statistics, labels, runs, storage).
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { combineFields, comparableFields } from './compare';
import * as dbApi from './db';
import { agreementForRun, goldColumnsFor, resultsWide } from './export/tables';
import { clearPlan, matchLabels } from './import/labels';
import { parsePastedTable, readText, splitTabbed } from './import/parse';
import { agreement, cohenKappa } from './metrics';
import { anthropicAdapter } from './providers/anthropic';
import type { CallOutcome } from './providers/types';
import * as store from './store';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type Run } from './types';
import { buildDocViews } from './view';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const ordinal = (name: string) => ({ name, type: 'ordinal' as const, values: ['-3', '-2', '-1', '0', '1', '2', '3'], description: '' });
const text = { ...DEFAULT_PROMPT, outputMode: 'text' as const, variables: [] };
const mkRun = (prompt: PromptSpec, replicates = 1, docIds = ['d1'], id = 'r'): Run => ({
  id, studyId: 's', number: 1, label: '', createdAt: '', finishedAt: null, mode: 'sync', scope: '', docIds, status: 'completed', batch: null, error: null,
  snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: { ...DEFAULT_RUN_OPTIONS, replicates }, prompt, promptVersion: 1, promptHash: 'h', outputSchema: null, requestBase: {} },
});
const mkResult = (doc: string, rep: number, values: Record<string, string>, status: 'ok' | 'error' = 'ok', run = 'r'): Result => ({
  id: `${run}:${doc}:${rep}`, runId: run, studyId: 's', docId: doc, replicate: rep, status, values, rationale: '', reasoningSummary: '', rawText: values.response ?? '',
  parseError: null, error: null, usage, latencyMs: 1, requestedAt: '', completedAt: '', responseId: '', modelReported: 'm', stopReason: 'end_turn',
});
const mkDoc = (id: string, meta: Record<string, string> = {}): Doc => ({ id, studyId: 's', docId: id, text: 't', meta, source: `${id}.txt`, order: 1, addedAt: '' });

// Weighted kappa written out with value distances, as a reference independent of the app's code.
function kappaByValue(pairs: [number, number][], scale: number[], power: 1 | 2): number {
  const cats = [...new Set([...scale, ...pairs.flat()])];
  const range = Math.max(...cats) - Math.min(...cats);
  const n = pairs.length;
  const pa = new Map<number, number>();
  const pb = new Map<number, number>();
  for (const [a, b] of pairs) (pa.set(a, (pa.get(a) ?? 0) + 1), pb.set(b, (pb.get(b) ?? 0) + 1));
  const w = (x: number, y: number) => (Math.abs(x - y) / range) ** power;
  const po = pairs.reduce((s, [a, b]) => s + w(a, b), 0) / n;
  let pe = 0;
  for (const [a, ca] of pa) for (const [b, cb] of pb) pe += (w(a, b) * ca * cb) / (n * n);
  return 1 - po / pe;
}

describe('weighted kappa with combined labels between scale points', () => {
  const scale = ['-3', '-2', '-1', '0', '1', '2', '3'];
  const base: [string, string][] = [];
  for (let i = 0; i < 60; i++) base.push([String((i % 7) - 3), String(((i + (i % 3 === 0 ? 1 : 0)) % 7) - 3)]);
  it('weights by value, so a 0.5 is half a step and does not stretch every other distance', () => {
    const withHalf: [string, string][] = [...base, ['0.5', '1']];
    const nums = withHalf.map(([a, b]) => [Number(a), Number(b)] as [number, number]);
    expect(cohenKappa(withHalf, 'linear', scale)).toBeCloseTo(kappaByValue(nums, scale.map(Number), 1), 10);
    expect(cohenKappa(withHalf, 'quadratic', scale)).toBeCloseTo(kappaByValue(nums, scale.map(Number), 2), 10);
  });
  it('gives the same numbers as before for whole-number scales (counting steps)', () => {
    const nums = base.map(([a, b]) => [Number(a), Number(b)] as [number, number]);
    expect(cohenKappa(base, 'linear', scale)).toBeCloseTo(kappaByValue(nums, scale.map(Number), 1), 10);
  });
  it('leaves out (and reports) numbers outside the codebook scale, such as a missing-value code', () => {
    const a = base.map(([x]) => x);
    const b = base.map(([, y]) => y);
    const clean = agreement(a, b, 'ordinal', scale);
    const coded = agreement([...a, '1'], [...b, '99'], 'ordinal', scale);
    expect(coded.leftOut).toEqual({ n: 1, values: ['99'] });
    expect(coded.gwetAC2Linear).toBeCloseTo(clean.gwetAC2Linear!, 10);
    expect(coded.weightedKappaLinear).toBeCloseTo(clean.weightedKappaLinear!, 10);
  });
});

describe('plain-text JSON scores', () => {
  const run = mkRun(text, 3);
  const answer = (race: number | string, e = 'x') => ({ response: JSON.stringify({ race, race_explanation: e }) });
  it('keep their whole-number scale when one text’s combined score is a half point', () => {
    const results = [
      mkResult('d1', 1, answer(1)), mkResult('d1', 2, answer(2)), mkResult('d1', 3, {}, 'error'),
      mkResult('d2', 1, answer(-3)), mkResult('d2', 2, answer(-3)), mkResult('d2', 3, answer(-3)),
      mkResult('d3', 1, answer(3)), mkResult('d3', 2, answer(3)), mkResult('d3', 3, answer(3)),
    ];
    const r = mkRun(text, 3, ['d1', 'd2', 'd3']);
    const views = buildDocViews([mkDoc('d1'), mkDoc('d2'), mkDoc('d3')], [r], results, 'r');
    expect(views.get('d1')!.values.response).toContain('"race":1.5');
    const [f] = comparableFields(r, views.values());
    expect([f.key, f.level, f.allowed[0], f.allowed.at(-1)]).toEqual(['race', 'ordinal', '-3', '3']);
  });
  it('combine only the answers that are JSON (a reply in prose has no scores) and leave out "NA"', () => {
    const results = [mkResult('d1', 1, answer(2, 'a')), mkResult('d1', 2, { response: 'I cannot rate this article.' }), mkResult('d1', 3, answer('NA', 'c'))];
    const v = buildDocViews([mkDoc('d1')], [run], results, 'r').get('d1')!;
    expect(JSON.parse(v.values.response)).toEqual({ race: 2, race_explanation: 'a' });
  });
  it('get the same scale whichever run comes first in a comparison', () => {
    const a = { key: 's', label: 's', level: 'ordinal' as const, allowed: ['-1', '0', '1'], scaleSeen: true, yesNo: false };
    const b = { ...a, allowed: ['0', '1', '2', '3'] };
    expect(combineFields(a, b).allowed).toEqual(combineFields(b, a).allowed);
    expect(combineFields(a, b).allowed).toEqual(['-1', '0', '1', '2', '3']);
    // And inside agreement: the range seen in either source, gaps filled.
    const x = ['-1', '0', '1', '1', '0', '-1', '1', '0', '1', '0', '-1', '1'];
    const y = ['3', '0', '1', '2', '0', '-1', '1', '0', '1', '0', '-1', '2'];
    expect(agreement(x, y, 'ordinal', a.allowed, 1, { scaleSeen: true }).weightedKappaLinear).toBeCloseTo(
      agreement(x, y, 'ordinal', ['-1', '0', '1', '2', '3'], 1, { scaleSeen: true }).weightedKappaLinear!,
      10,
    );
  });
});

describe('which columns count as human labels', () => {
  const race = { key: 'race', label: 'race', level: 'ordinal' as const, allowed: ['-3', '-2', '-1', '0', '1', '2', '3'], yesNo: false };
  const docs = [
    mkDoc('d1', { race_gold: '2', race_coder2: '1', race_note: 'unclear', race_confidence: '3', author_race: 'Black', race_negative_gold: '-1', gender_role_gold: '1' }),
    mkDoc('d2', { race_gold: '-1', race_coder2: '-1', race_note: 'fine', race_confidence: '2', author_race: 'white', race_negative_gold: '0', gender_role_gold: '0' }),
  ];
  it('takes label columns, not notes, ratings, columns of words or columns of a longer field', () => {
    expect(goldColumnsFor(race, docs, ['race', 'race_negative', 'gender', 'gender_role'])).toEqual(['race_gold', 'race_coder2']);
    expect(goldColumnsFor({ ...race, key: 'gender' }, docs, ['gender', 'gender_role'])).toEqual([]);
  });
  it('compares two coders on the run’s texts only, the same texts as the model', () => {
    const run = mkRun({ ...DEFAULT_PROMPT, variables: [ordinal('race')] }, 1, ['d1']);
    const rows = agreementForRun(run, docs, [run], [mkResult('d1', 1, { race: '2' })]);
    const hh = rows.find((r) => r.source === 'race_gold')!;
    expect([hh.compared_with, hh.nLabelled, hh.stats.n]).toEqual(['race_coder2', 1, 1]);
  });
});

describe('results table', () => {
  it('keeps a human label named like a JSON score out of the model’s column, in every row', () => {
    const run = mkRun(text, 1, ['d1', 'd2', 'd3']);
    const docs = [mkDoc('d1', { race: '3' }), mkDoc('d2', { race: '-2' }), mkDoc('d3', { race: '1' })];
    const results = [mkResult('d1', 1, { response: '{"race": 2}' }), mkResult('d2', 1, {}, 'error'), mkResult('d3', 1, { response: 'prose' })];
    const rows = resultsWide(run, docs, [run], results, { text: false, rationale: false });
    expect(rows.map((r) => [r.race, r.meta_race])).toEqual([[2, 3], ['', -2], ['', 1]]);
    expect(new Set(rows.map((r) => Object.keys(r).join(','))).size).toBe(1);
  });
  it('gives the share of agreeing replicates only for fields that have one, under a clear name', () => {
    const p = { ...DEFAULT_PROMPT, variables: [ordinal('race'), { name: 'race_explanation', type: 'text' as const, values: [], description: '' }] };
    const run = mkRun(p, 3);
    const rs = [1, 2, 3].map((k) => mkResult('d1', k, { race: k === 3 ? '1' : '2', race_explanation: 'e' }));
    const [row] = resultsWide(run, [mkDoc('d1')], [run], rs, { text: false, rationale: false });
    expect(row.race_replicate_agreement).toBe(0.667);
    expect(Object.keys(row).filter((k) => k.includes('agreement'))).toEqual(['race_replicate_agreement']);
  });
});

describe('label spreadsheets', () => {
  const docs = [mkDoc('a', { file: 'a.md', race_gold: '1' }), mkDoc('b', { file: 'b.md', race_gold: '2' }), mkDoc('c', { file: 'Müller.md' })];
  const sheet = (rows: Record<string, string>[]) => ({ name: 'x.csv', columns: Object.keys(rows[0]), rows });
  it('refuse several rows for one text with different values (e.g. one row per coder)', () => {
    const m = matchLabels(docs, sheet([{ file: 'a.md', race_gold: '1' }, { file: 'a.md', race_gold: '3' }, { file: 'b.md', race_gold: '2' }]), 'file');
    expect([m.conflicts, m.updates.has('a'), m.matchedRows]).toEqual([['a.md'], false, 3]);
  });
  it('replace a column: blank cells and texts left out lose their old value, unless kept on purpose', () => {
    const m = matchLabels(docs, sheet([{ file: 'a.md', race_gold: '' }]), 'file');
    expect([...clearPlan(docs, m, false).entries()]).toEqual([['a', ['race_gold']], ['b', ['race_gold']]]);
    expect([...clearPlan(docs, m, true).entries()]).toEqual([['a', ['race_gold']]]);
  });
  it('never rename a text through a file column, and match names whatever their Unicode form', () => {
    const m = matchLabels(docs, sheet([{ id: 'Müller', file: 'other.pdf', era: '1990s' }]), 'id');
    expect([m.updates.get('c'), m.skipped]).toEqual([{ era: '1990s' }, ['file']]);
  });
});

describe('reading files and pasted tables', () => {
  it('keeps a quotation mark at the start of a pasted cell as text', () => {
    const t = parsePastedTable('name\tnote\n"Bohr\tAtom\nBlixen\tauthor\n');
    expect(t.rows).toEqual([{ name: '"Bohr', note: 'Atom' }, { name: 'Blixen', note: 'author' }]);
    expect(splitTabbed('a\t"two\nlines"\nb\tc')).toEqual([['a', 'two\nlines'], ['b', 'c']]);
  });
  it('refuses a file that isn’t UTF-8 instead of replacing letters, and reads UTF-16', async () => {
    await expect(readText(new Blob([new Uint8Array([0x52, 0xe6, 0x6b, 0x6b, 0x65])]))).rejects.toThrow(/UTF-8/);
    expect(await readText(new Blob([new Uint8Array([0xff, 0xfe, 0x52, 0x00, 0xe6, 0x00])]))).toBe('Ræ');
    expect(await readText(new Blob([new Uint8Array([0xef, 0xbb, 0xbf, 0x52, 0xc3, 0xa6])]))).toBe('Ræ');
  });
});

// ---------- runs (the provider is stubbed: nothing is sent anywhere) ----------

const outcome = (rawText: string, stopReason = 'end_turn'): CallOutcome => ({ rawText, reasoningSummary: '', usage, responseId: `id_${Math.random()}`, modelReported: 'm', stopReason, response: {} });
const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });

async function freshStudy(n: number, setup: (p: PromptSpec) => void = () => {}) {
  await store.createStudy('Test');
  store.setKey('anthropic', 'sk-ant-test');
  store.updateStudy((s) => {
    s.prompt.userTemplate = 'Rate it.';
    s.prompt.outputMode = 'text';
    s.prompt.variables = [];
    setup(s.prompt);
  });
  await store.addDocs(Array.from({ length: n }, (_, i) => ({ docId: `t${i}`, text: `text ${i}`, meta: { file: `t${i}.txt` }, source: `t${i}.txt` })));
  return store.getState().docs.map((d) => d.id);
}

afterEach(() => vi.restoreAllMocks());

describe('immediate runs', () => {
  it('count an empty answer as failed, and a refusal without a JSON error', async () => {
    const ids = await freshStudy(2);
    vi.spyOn(anthropicAdapter, 'send').mockImplementationOnce(async () => outcome('  ')).mockImplementationOnce(async () => outcome('', 'refusal'));
    await store.startRun({ docIds: ids, scope: 'all' });
    const rs = store.getState().results;
    expect(rs.map((r) => [r.status, r.parseError, r.error])).toEqual([
      ['error', null, 'Empty response (stop reason: end_turn)'],
      ['error', null, 'Empty response (stop reason: refusal)'],
    ]);
  });
  it('go on past texts that are always refused, and stop only for errors that point to the settings', async () => {
    const ids = await freshStudy(8);
    const send = vi.spyOn(anthropicAdapter, 'send').mockImplementation(async () => outcome('', 'refusal'));
    await store.startRun({ docIds: ids, scope: 'all' });
    expect(send).toHaveBeenCalledTimes(8);
    const ids2 = await freshStudy(40);
    send.mockClear();
    send.mockImplementation(async () => {
      throw apiError(401, 'invalid x-api-key');
    });
    await store.startRun({ docIds: ids2, scope: 'all' });
    // (Requests already under way when the third error came in finish: a few more than three, far fewer than 40.)
    expect(send.mock.calls.length).toBeLessThanOrEqual(3 + 2 * DEFAULT_RUN_OPTIONS.concurrency);
    expect(store.getState().runs.at(-1)!.status).toBe('failed');
  });
  it('record a retry with the requests it sent, and keep the replaced attempts’ tokens and logs', async () => {
    const ids = await freshStudy(3);
    vi.spyOn(anthropicAdapter, 'send').mockImplementation(async () => outcome('', 'refusal'));
    await store.startRun({ docIds: ids, scope: 'all' });
    const run = store.getState().runs.at(-1)!;
    vi.spyOn(anthropicAdapter, 'send').mockImplementation(async () => outcome('fine'));
    await store.retryFailed(run.id);
    const after = store.getState().runs.find((r) => r.id === run.id)!;
    expect(after.retries?.map((x) => x.requests)).toEqual([3]);
    expect(after.replaced).toEqual({ requests: 3, usage: { ...usage, inputTokens: 30, outputTokens: 15 } });
    const logs = await dbApi.getLogsForRun(run.id);
    expect(logs.filter((l) => l.attempt === 1 && l.replaced?.status === 'error')).toHaveLength(3);
    expect(store.getState().results.filter((r) => r.runId === run.id).every((r) => r.status === 'ok' && r.attempt === 2)).toBe(true);
  });
  it('refuse to delete texts while a run is going', async () => {
    const ids = await freshStudy(2);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(anthropicAdapter, 'send').mockImplementation(async () => (await gate, outcome('ok')));
    const running = store.startRun({ docIds: ids, scope: 'all' });
    await vi.waitFor(() => expect(store.getState().job).not.toBeNull());
    await store.removeDocs(ids);
    expect(store.getState().docs).toHaveLength(2);
    release();
    await running;
    expect(store.getState().job).toBeNull();
  });
  it('count texts annotated by another model as remaining', async () => {
    const ids = await freshStudy(2);
    vi.spyOn(anthropicAdapter, 'send').mockImplementation(async () => outcome('ok'));
    await store.startRun({ docIds: ids, scope: 'all' });
    const s = () => store.currentStudy()!;
    const st = store.getState();
    expect(store.remainingDocs(s(), st.docs, st.runs, st.results).todo).toHaveLength(0);
    store.updateStudy((x) => void (x.model.model = 'claude-sonnet-5-5'));
    expect(store.remainingDocs(s(), st.docs, st.runs, st.results).todo).toHaveLength(2);
    // Renaming a field's display name is not a new prompt.
    expect(store.promptKey({ ...DEFAULT_PROMPT, variables: [{ ...ordinal('race'), label: 'Race' }] })).toBe(store.promptKey({ ...DEFAULT_PROMPT, variables: [ordinal('race')] }));
  });
});

describe('batch uploads without an answer', () => {
  it('find the batch at the provider instead of sending it again', async () => {
    const ids = await freshStudy(3);
    store.updateStudy((s) => void (s.options.batch = true));
    const submit = vi.spyOn(anthropicAdapter, 'submitBatch').mockImplementation(async () => {
      throw new Error('Connection error.');
    });
    const list = vi.spyOn(anthropicAdapter, 'listRecentBatches').mockResolvedValue([]);
    await store.startRun({ docIds: ids, scope: 'all' });
    const run = store.getState().runs.at(-1)!;
    expect([run.status, run.batch?.uploadUnknown?.requests]).toEqual(['failed', 3]);
    // Later the batch shows up at the provider: Retry failed adopts it and sends nothing.
    list.mockResolvedValue([{ batchId: 'msgbatch_late', createdAt: new Date().toISOString(), requests: 3 }]);
    await store.retryFailed(run.id);
    const after = store.getState().runs.find((r) => r.id === run.id)!;
    expect(submit).toHaveBeenCalledTimes(1);
    expect([after.status, store.batchParts(after).map((p) => p.batchId)]).toEqual(['submitted', ['msgbatch_late']]);
  });
  it('remove a new run of which nothing went up when the provider refused it', async () => {
    const ids = await freshStudy(2);
    store.updateStudy((s) => void (s.options.batch = true));
    vi.spyOn(anthropicAdapter, 'submitBatch').mockRejectedValue(apiError(400, 'bad request'));
    const before = store.getState().runs.length;
    await store.startRun({ docIds: ids, scope: 'all' });
    expect(store.getState().runs.length).toBe(before);
  });
});

describe('samples and studies', () => {
  it('replace the note of an earlier draw of the same sample', async () => {
    const ids = await freshStudy(4);
    await store.markSample('sample', 'validation', ids.slice(0, 2), `${store.sampleNotePrefix('sample', 'validation')}2026-10-22): seed 1.`, 1);
    await store.markSample('sample', 'validation', ids.slice(2), `${store.sampleNotePrefix('sample', 'validation')}2026-10-22): seed 2.`, 2);
    expect(store.currentStudy()!.description).toBe('Sample sample = validation (2026-10-22): seed 2.');
    expect(store.getState().docs.filter((d) => d.meta.sample === 'validation').map((d) => d.id)).toEqual(ids.slice(2));
  });
  it('count an answer of the refusal fallback (first version) as failed when a study is opened', async () => {
    const ids = await freshStudy(1);
    vi.spyOn(anthropicAdapter, 'send').mockImplementation(async () => outcome('fine'));
    await store.startRun({ docIds: ids, scope: 'all' });
    const r = store.getState().results.at(-1)!;
    await dbApi.putResult({ ...r, fallback: 'claude-opus-5-5 → claude-sonnet-5-5' } as Result, null);
    await store.selectStudy(store.currentStudy()!.id);
    const now = store.getState().results.find((x) => x.id === r.id)!;
    expect([now.status, now.error?.startsWith('Refused by the requested model')]).toEqual(['error', true]);
  });
});
