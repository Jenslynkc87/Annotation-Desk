// Round five of the review fixes: label sheets taken for results files exported by this app (regression tests).
import { describe, expect, it } from 'vitest';
import { resultsLong, resultsWide, toCsv } from './export/tables';
import { guessKeyColumn, matchLabels, ownLikeColumn, resultsTable } from './import/labels';
import { parseFile, type ParsedTable } from './import/parse';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type Run, type Study } from './types';

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const file = async (name: string, content: string) => {
  const r = await parseFile(new File([content], name));
  if (r.kind !== 'table') throw new Error(r.kind === 'error' ? r.error : r.kind);
  return r.table;
};
const ordinal = (name: string, values = ['-3', '-2', '-1', '0', '1', '2', '3']) => ({ name, type: 'ordinal' as const, values, description: '' });
const structured = (variables: PromptSpec['variables'], includeRationale = false): PromptSpec => ({ ...DEFAULT_PROMPT, outputMode: 'structured', includeRationale, variables });
const textPrompt: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'text', variables: [], includeRationale: false };
const articles = (n: number): Doc[] =>
  Array.from({ length: n }, (_, i) => ({ id: `d${i}`, studyId: 's', docId: `art_${i}`, text: `T${i}`, meta: { file: `art_${i}.md` }, source: `art_${i}.md`, order: i, addedAt: '' }));
let number = 0;
const mkRun = (id: string, docs: Doc[], prompt: PromptSpec, replicates = 1): Run => ({
  id, studyId: 's', number: ++number, label: '', createdAt: '', finishedAt: '', mode: 'sync', scope: 'All', docIds: docs.map((d) => d.id), status: 'completed', batch: null, error: null,
  snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: { ...DEFAULT_RUN_OPTIONS, replicates }, prompt, promptVersion: 1, promptHash: 'h', outputSchema: null, requestBase: {} },
});
const mkResult = (run: Run, d: Doc, rep: number, values: Record<string, string>, rationale = ''): Result => ({
  id: `${run.id}:${d.id}:${rep}`, runId: run.id, studyId: 's', docId: d.id, replicate: rep, status: 'ok', values, rationale, reasoningSummary: '', rawText: '{}', parseError: null,
  error: null, usage, latencyMs: 1, requestedAt: '', completedAt: '', responseId: `msg_${run.id}_${d.id}_${rep}`, modelReported: 'm', stopReason: 'end_turn',
});
/** A seeded random number in [0, 1). */
const random = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const check = (docs: Doc[], t: ParsedTable, key: string, runs: Run[], rs: Result[], prompts: PromptSpec[] = []) =>
  resultsTable(t, runs, rs, matchLabels(docs, t, key).updates, prompts, key);

describe('H17: a sheet keyed by response_id (survey answers) is not taken for an export', () => {
  // Open-ended survey answers imported from a table whose ID column is response_id (Qualtrics' ResponseId after
  // janitor::clean_names), so each text's ID is an R_… value.
  const ids = Array.from({ length: 30 }, (_, i) => `R_${(1e6 + i * 7919).toString(36)}`);
  const docs: Doc[] = ids.map((id, i) => ({ id: `d${i}`, studyId: 's', docId: id, text: `answer ${i}`, meta: {}, source: 'survey.csv', order: i, addedAt: '' }));
  const p = structured([ordinal('sentiment', ['-1', '0', '1'])]);
  const run = mkRun('r', docs, p);
  const rs = docs.map((d, i) => mkResult(run, d, 1, { sentiment: String((i % 3) - 1) }));
  const sheet = (cols: string[], value: (c: string, i: number) => string): ParsedTable => ({
    name: 'codes.csv', columns: cols, rows: ids.map((id, i) => Object.fromEntries(cols.map((c) => [c, c === 'response_id' ? id : value(c, i)]))),
  });

  it('the key column is not judged: a coder’s or a metadata sheet keyed by response_id is accepted', () => {
    for (const cols of [['response_id', 'sentiment_gold'], ['response_id', 'sentiment_coder1', 'sentiment_coder2'], ['response_id', 'status', 'progress', 'sentiment_gold'], ['response_id', 'gender', 'age_group']]) {
      const t = sheet(cols, (c, i) => (c === 'status' ? 'IP Address' : c === 'progress' ? '100' : c === 'gender' ? 'f' : c === 'age_group' ? 'young' : String((i % 3) - 1)));
      const key = guessKeyColumn(docs, t);
      expect(key).toBe('response_id');
      for (const [runs, results] of [[[run], rs], [[], []]] as const) expect(check(docs, t, key, [...runs], [...results], [p]).columns).toEqual([]);
    }
  });
  it('a response_id column that is not the key: blocked, but only as a possible export (the notice says to rename it if it is the owner’s)', () => {
    const t = { ...sheet(['response_id', 'sentiment_gold'], (_, i) => String(i % 3)), columns: ['doc', 'response_id', 'sentiment_gold'] };
    t.rows = t.rows.map((r, i) => ({ ...r, doc: ids[i], response_id: `RR${i}` }));
    const got = check(docs, t, 'doc', [run], rs, [p]);
    expect(got).toMatchObject({ strong: ['response_id'], sure: false, copied: [] });
    expect(got.columns).toEqual(['response_id']);
  });
  it('a response_id column beside the model’s explanations: blocked for the explanations, and response_id is no proof (the notice doesn’t call it the exports’ alone)', () => {
    const q = structured([ordinal('sentiment', ['-1', '0', '1']), { name: 'sentiment_explanation', type: 'text', values: [], description: '' }]);
    const run2 = mkRun('rx', docs, q);
    const why = (i: number) => `Answer ${i} sounds mostly content with the service.`;
    const rs2 = docs.map((d, i) => mkResult(run2, d, 1, { sentiment: String((i % 3) - 1), sentiment_explanation: why(i) }));
    const t: ParsedTable = { name: 'review.csv', columns: ['doc', 'response_id', 'sentiment_explanation', 'sentiment_gold'], rows: ids.map((id, i) => ({ doc: id, response_id: `RR${i}`, sentiment_explanation: why(i), sentiment_gold: '0' })) };
    const got = check(docs, t, 'doc', [run2], rs2, [q]);
    expect(got).toMatchObject({ strong: ['response_id'], copied: ['sentiment_explanation'], sure: true });
    expect(got.strong.filter((c) => !ownLikeColumn(c))).toEqual([]);
    expect(['n_ok', 'prompt_hash', 'status'].map(ownLikeColumn)).toEqual([false, false, false]);
  });
  it('real exports keyed by doc_id are still blocked as exports, also when no run has their field', async () => {
    const study: Study = { id: 's', name: 'S', description: '', createdAt: '', updatedAt: '', model: DEFAULT_MODEL_SETTINGS, options: DEFAULT_RUN_OPTIONS, prompt: p };
    const wide = await file('results.csv', toCsv(resultsWide(run, docs, [run], rs, { text: false, rationale: false })));
    const long = await file('results_long.csv', toCsv(resultsLong(study, [run], docs, rs, { rationale: false, reasoning: false })));
    for (const t of [wide, long]) {
      const key = guessKeyColumn(docs, t);
      expect(key).toBe('doc_id');
      expect(check(docs, t, key, [run], rs, [p])).toMatchObject({ sure: true, copied: ['sentiment'] });
      expect(check(docs, t, key, [], [], []).columns.length).toBeGreaterThan(0);
    }
    // response_id as the key of a long table matches no text: nothing can be added (and it is still blocked).
    const m = matchLabels(docs, long, 'response_id');
    expect(m.updates.size).toBe(0);
    expect(resultsTable(long, [run], rs, m.updates, [p], 'response_id').sure).toBe(true);
  });
});

describe('H18: a coder’s sheet with two common workflow columns is judged run by run', () => {
  const docs = articles(100);
  const p = structured([ordinal('tone'), { name: 'mentions_gender', type: 'boolean', values: [], description: '' }], true);
  const toneOf = (i: number) => String((i % 7) - 3);
  const coderSheet = (field: string, value: (i: number) => string, extra: Record<string, (i: number) => string>): ParsedTable => ({
    name: 'coder.xlsx', columns: ['file', field, ...Object.keys(extra)],
    rows: docs.map((d, i) => ({ file: d.meta.file!, [field]: value(i), ...Object.fromEntries(Object.entries(extra).map(([c, f]) => [c, f(i)])) })),
  });
  const workflow = { status: () => 'coded', completed_at: (i: number) => `2026-09-1${i % 9}` };

  it('three runs that each agree exactly with the coder on 80–90% of the texts (every text matching some run): not blocked', () => {
    const rnd = random(11);
    const runs = ['m1', 'm2', 'm3'].map((id) => mkRun(id, docs, p));
    const shift = (v: string) => String(Math.max(-3, Math.min(3, Number(v) + (rnd() < 0.5 ? -1 : 1))));
    const rs = runs.flatMap((run) => docs.map((d, i) => mkResult(run, d, 1, { tone: rnd() < 0.82 ? toneOf(i) : shift(toneOf(i)), mentions_gender: 'false' })));
    // (So the old rule, some answer of some run for 95% of the texts, would block it.)
    expect(docs.filter((d, i) => rs.some((r) => r.docId === d.id && r.values.tone === toneOf(i))).length).toBeGreaterThanOrEqual(95);
    const got = check(docs, coderSheet('tone', toneOf, workflow), 'file', runs, rs, [p]);
    expect(got.columns).toEqual([]);
  });
  it('one run of five replicates, each agreeing with the coder on about 75% of the texts: not blocked', () => {
    const rnd = random(99);
    const run = mkRun('r5', docs, p, 5);
    const other = (v: string) => (v === '3' ? '2' : String(Number(v) + 1));
    const rs = docs.flatMap((d, i) => [1, 2, 3, 4, 5].map((k) => mkResult(run, d, k, { tone: rnd() < 0.75 ? toneOf(i) : other(toneOf(i)) })));
    expect(check(docs, coderSheet('tone', toneOf, { status: () => 'done', error: () => 'none' }), 'file', [run], rs, [p]).columns).toEqual([]);
  });
  it('a coder who agrees with one run on all texts but one, or with a yes/no field on 99 of 100: not blocked', () => {
    const run = mkRun('one', docs, p);
    const gender = (i: number) => (i % 3 ? 'false' : 'true');
    const rs = docs.map((d, i) => mkResult(run, d, 1, { tone: toneOf(i), mentions_gender: gender(i) }));
    expect(check(docs, coderSheet('tone', (i) => (i === 50 ? '3' : toneOf(i)), workflow), 'file', [run], rs, [p]).columns).toEqual([]);
    const flip = (i: number) => (i === 7 ? (gender(i) === 'true' ? 'false' : 'true') : gender(i));
    expect(check(docs, coderSheet('mentions_gender', flip, workflow), 'file', [run], rs, [p]).columns).toEqual([]);
  });
  it('a column the same as one run’s answers on every text is still the model’s: blocked, as a possible export', () => {
    const runs = ['a', 'b'].map((id) => mkRun(id, docs, p));
    const rs = [...docs.map((d) => mkResult(runs[0], d, 1, { tone: '0' })), ...docs.map((d, i) => mkResult(runs[1], d, 1, { tone: toneOf(i) }))];
    const got = check(docs, coderSheet('tone', toneOf, workflow), 'file', runs, rs, [p]);
    expect(got).toMatchObject({ copied: ['tone'], strong: [], shared: ['status', 'completed_at'], sure: false, sameAs: { tone: { run: 'b', texts: 100 } } });
    expect(got.columns).toEqual(['tone', 'status', 'completed_at']);
  });
  it('an entries study: the owner’s answers equal to the model’s on every entry are not taken for a copy (lead)', () => {
    // Facts the model knows: a correct reference column agrees with it everywhere.
    const ep: PromptSpec = { ...p, subject: 'entries' };
    const run = mkRun('e1', docs, ep);
    const rs = docs.map((d, i) => mkResult(run, d, 1, { tone: toneOf(i) }));
    expect(check(docs, coderSheet('tone', toneOf, workflow), 'file', [run], rs, [ep]).columns).toEqual([]);
  });
  it('the combined labels of a run with several replicates (as its Results sheet gives them) count as that run’s answers', () => {
    const run = mkRun('r3', docs, p, 3);
    // Replicate 3 differs on every tenth text: the median is the other two's answer.
    const rs = docs.flatMap((d, i) => [1, 2, 3].map((k) => mkResult(run, d, k, { tone: k === 3 && i % 10 === 1 ? String(-Number(toneOf(i)) || 1) : toneOf(i) })));
    const got = check(docs, coderSheet('tone', toneOf, workflow), 'file', [run], rs, [p]);
    expect(got).toMatchObject({ copied: ['tone'], sure: false, sameAs: { tone: { run: 'r3', texts: 100 } } });
  });
  it('plain-text JSON scores: the median of three replicates copied is the model’s, a coder at 90% is not', () => {
    const run = mkRun('t3', docs, textPrompt, 3);
    const answer = (score: number, i: number) => JSON.stringify({ tone_explanation: `Section ${i} reads as ${score}.`, tone: score });
    // Three scores a point apart, in a different order for each text: the median comes from replicate 1, 2 or 3.
    const rs = docs.flatMap((d, i) => [1, 2, 3].map((k) => mkResult(run, d, k, { response: answer(Number(toneOf(i)) + ((k + i) % 3), i) })));
    const median = (i: number) => String([1, 2, 3].map((k) => JSON.parse(rs[i * 3 + k - 1].values.response).tone).sort((a, b) => a - b)[1]);
    // Not every median is a replicate's own answer in the same replicate, so only the combined labels match all texts.
    expect([1, 2, 3].some((k) => docs.every((_, i) => String(JSON.parse(rs[i * 3 + k - 1].values.response).tone) === median(i)))).toBe(false);
    expect(check(docs, coderSheet('tone', median, workflow), 'file', [run], rs, [textPrompt])).toMatchObject({ copied: ['tone'], sameAs: { tone: { run: 't3' } } });
    const coder = (i: number) => (i % 10 === 3 ? String(Number(median(i)) + 1) : median(i));
    expect(check(docs, coderSheet('tone', coder, workflow), 'file', [run], rs, [textPrompt]).columns).toEqual([]);
  });
  it('explanations are still matched against any answer of any run or replicate (an exact copy of a long text is not chance)', () => {
    const runs = ['a', 'b'].map((id) => mkRun(id, docs, p, 2));
    const why = (run: string, k: number, i: number) => `Run ${run}, replicate ${k}: the article’s tone in section ${i} is mostly neutral.`;
    const rs = runs.flatMap((run) => docs.flatMap((d, i) => [1, 2].map((k) => mkResult(run, d, k, { tone: toneOf(i) }, why(run.id, k, i)))));
    // A reviewer's sheet: rationales taken from different runs and replicates, with their own labels.
    const t: ParsedTable = { name: 'review.csv', columns: ['file', 'rationale', 'tone'], rows: docs.map((d, i) => ({ file: d.meta.file!, rationale: why(i % 2 ? 'a' : 'b', 1 + (i % 3 ? 1 : 0), i), tone: String(i % 2) })) };
    expect(check(docs, t, 'file', runs, rs, [p])).toMatchObject({ copied: ['rationale'], sure: true });
  });
});

describe('H13: the results-file notice names no label column as one that may hold the model’s answers', () => {
  const docs = articles(12).map((d, i) => ({ ...d, meta: { ...d.meta, era: i % 2 ? '1990s' : '2010s' } }));
  const p = structured([ordinal('tone'), { name: 'tone_explanation', type: 'text', values: [], description: '' }]);
  const run = mkRun('r1', docs, p);
  const rs = docs.map((d, i) => mkResult(run, d, 1, { tone: toneOf(i), tone_explanation: `The tone of article ${i} is ${toneOf(i)}.` }));
  function toneOf(i: number) {
    return String((i % 7) - 3);
  }
  const withColumns = async (extra: Record<string, (i: number) => string>, drop: string[] = []) => {
    const rows = resultsWide(run, docs, [run], rs, { text: false, rationale: false }).map((r, i) => ({
      ...Object.fromEntries(Object.entries(r).filter(([k]) => !drop.includes(k))),
      ...Object.fromEntries(Object.entries(extra).map(([c, f]) => [c, f(i)])),
    }));
    return file('results.csv', toCsv(rows));
  };

  it('the owner’s gold or coder columns beside an exported Results sheet with every field: none listed', async () => {
    const extras: Record<string, (i: number) => string>[] = [{ tone_gold: (i) => String(i % 3) }, { tone_coder1: (i) => String(i % 3), tone_coder2: (i) => String(i % 2) }, { tone_gold: () => '1', note: () => 'see text' }];
    for (const extra of extras) {
      const t = await withColumns(extra);
      const got = check(docs, t, 'doc_id', [run], rs, [p]);
      expect(got).toMatchObject({ sure: true, copied: ['tone', 'tone_explanation'], unknown: [] });
    }
  });
  it('a plain-text run’s Results sheet without its response column still has every field (the keys of its JSON answers)', async () => {
    const t3 = mkRun('t3', docs, textPrompt, 3);
    const answer = (i: number) => JSON.stringify({ tone_explanation: `Article ${i} is calm.`, tone: (i % 7) - 3 });
    const trs = docs.flatMap((d, i) => [1, 2, 3].map((k) => mkResult(t3, d, k, { response: answer(i) })));
    const rows = resultsWide(t3, docs, [t3], trs, { text: false, rationale: false }).map((r, i) => {
      const { response: _r, ...rest } = r;
      return { ...rest, tone_gold: String(i % 3), note: 'see text' };
    });
    const t = await file('results.csv', toCsv(rows));
    expect(t.columns).not.toContain('response');
    expect(check(docs, t, 'doc_id', [t3], trs, [textPrompt])).toMatchObject({ sure: true, unknown: [] });
  });
  it('a field renamed since (the sheet lacks one of every run’s and prompt’s fields): other columns listed, label columns not', async () => {
    const now = structured([ordinal('tone'), ordinal('framing')]);
    const t = await withColumns({ frame: (i) => String(i % 3), tone_gold: (i) => String(i % 3), gold_standard_tone: () => '0' }, ['tone_explanation']);
    expect(check(docs, t, 'doc_id', [], [], [now]).unknown).toEqual(['era', 'frame']);
  });
  it('a sheet with no column named like a field: columns beside which a label column is named are listed, the label column not', () => {
    const t: ParsedTable = {
      name: 'other-study.csv', columns: ['doc_id', 'frame', 'frame_explanation', 'frame_gold', 'notes', 'n_ok', 'n_error'],
      rows: docs.map((d, i) => ({ doc_id: d.docId, frame: String(i % 3), frame_explanation: 'x', frame_gold: String(i % 2), notes: '', n_ok: '1', n_error: '0' })),
    };
    expect(check(docs, t, 'doc_id', [run], rs, [p])).toMatchObject({ answers: [], unknown: ['frame', 'frame_explanation', 'notes'] });
  });
});
