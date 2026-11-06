import { describe, expect, it } from 'vitest';
import { comparableFields } from './compare';
import { describe as describeNumbers, groupColumns, histogram, runCounts, runItems, scaleLabel, summarizeByGroup, summarizeField, tCritical95 } from './summary';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_PROMPT, DEFAULT_RUN_OPTIONS, type Doc, type PromptSpec, type Result, type Run } from './types';
import { buildDocViews } from './view';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
function result(runId: string, docId: string, replicate: number, values: Record<string, string>, status: Result['status'] = 'ok'): Result {
  return {
    id: `${runId}:${docId}:${replicate}`, runId, studyId: 's', docId, replicate, status, values: status === 'ok' ? values : {}, rationale: '', reasoningSummary: '',
    rawText: '', parseError: null, error: status === 'ok' ? null : 'failed', usage, latencyMs: 1, requestedAt: '', completedAt: '', responseId: '', modelReported: '', stopReason: 'end_turn',
  };
}
function makeRun(prompt: PromptSpec, docIds: string[], replicates = 1): Run {
  return {
    id: 'r1', studyId: 's', number: 1, label: '', createdAt: '2026-11-05T10:00:00Z', finishedAt: null, mode: 'sync', scope: 'all', docIds, status: 'completed', batch: null, error: null,
    snapshot: { appVersion: 't', model: DEFAULT_MODEL_SETTINGS, options: { ...DEFAULT_RUN_OPTIONS, replicates }, prompt, promptVersion: 1, promptHash: 'h', outputSchema: null, requestBase: {} },
  };
}
const doc = (i: number, meta: Record<string, string> = {}): Doc => ({ id: `d${i}`, studyId: 's', docId: `art_${i}`, text: 't', meta, source: 'x', order: i, addedAt: '' });

const structured: PromptSpec = {
  ...DEFAULT_PROMPT,
  outputMode: 'structured',
  variables: [
    { name: 'orientation', label: 'Evaluative orientation', type: 'ordinal', values: ['-3', '-2', '-1', '0', '1', '2', '3'], description: '' },
    { name: 'orientation_explanation', type: 'text', values: [], description: '' },
    { name: 'tone', type: 'category', values: ['Critical', 'Neutral', 'Appreciative'], description: '' },
    { name: 'mentions_trump', type: 'boolean', values: [], description: '' },
  ],
};

function setup(rows: { o: string; tone: string; yn: string; era: string }[], extra: Result[] = []) {
  const docs = rows.map((r, i) => doc(i, { era: r.era, file: `art_${i}.md` }));
  const run = makeRun(structured, docs.map((d) => d.id));
  const results = [
    ...rows.map((r, i) => result(run.id, `d${i}`, 1, { orientation: r.o, orientation_explanation: 'because', tone: r.tone, mentions_trump: r.yn })),
    ...extra,
  ];
  const views = buildDocViews(docs, [run], results, run.id);
  const items = runItems(run, docs, views);
  const fields = comparableFields(run, views.values());
  return { run, docs, items, fields };
}

describe('Student t critical values (two-sided 95%)', () => {
  it('matches the tables from 9 degrees of freedom up', () => {
    // R: qt(0.975, df)
    const table: [number, number][] = [
      [9, 2.262157],
      [10, 2.228139],
      [20, 2.085963],
      [30, 2.042272],
      [100, 1.983972],
      [1000, 1.962339],
    ];
    for (const [df, t] of table) expect(Math.abs(tCritical95(df) - t)).toBeLessThan(0.0005);
  });
});

describe('describing numbers', () => {
  it('gives the mean, SD (n − 1), median and a t interval from 10 values', () => {
    const xs = [-3, -1, 0, 0, 1, 1, 2, 2, 2, 3];
    const d = describeNumbers(xs);
    expect(d.mean).toBeCloseTo(0.7, 10);
    // var = sum((x - 0.7)^2) / 9
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - 0.7) ** 2, 0) / 9);
    expect(d.sd).toBeCloseTo(sd, 10);
    expect(d.median).toBe(1);
    expect(d.ci![0]).toBeCloseTo(0.7 - (2.262157 * sd) / Math.sqrt(10), 3);
    expect(d.ci![1]).toBeCloseTo(0.7 + (2.262157 * sd) / Math.sqrt(10), 3);
    expect([d.min, d.max]).toEqual([-3, 3]);
  });
  it('gives no interval below 10 values', () => {
    expect(describeNumbers([1, 2, 3]).ci).toBeNull();
    expect(describeNumbers([]).mean).toBeNull();
  });
});

describe('summarizing a structured run', () => {
  const rows = [
    { o: '-3', tone: 'Critical', yn: 'true', era: '1960s' },
    { o: '-1', tone: 'Critical', yn: 'false', era: '1960s' },
    { o: '0', tone: 'Neutral', yn: 'false', era: '1960s' },
    { o: '2', tone: 'Appreciative', yn: 'false', era: '1970s' },
    { o: '1', tone: 'Neutral', yn: 'true', era: '1970s' },
    { o: '-2', tone: 'Critical', yn: 'false', era: '' },
  ];

  it('counts texts and leaves out free-text fields', () => {
    const { items, fields } = setup(rows);
    expect(runCounts(items)).toEqual({ total: 6, annotated: 6, fewer: 0, failed: 0, waiting: 0 });
    expect(fields.map((f) => f.key)).toEqual(['orientation', 'tone', 'mentions_trump']);
  });

  it('draws an ordinal −3…3 scale around 0, with every point, and its figures', () => {
    const { run, items, fields } = setup(rows);
    const s = summarizeField(run, fields[0], items);
    expect(s.kind).toBe('scale');
    expect(s.diverging).toBe(true);
    expect(s.label).toBe('Evaluative orientation');
    expect(s.bins.map((b) => [b.label, b.n])).toEqual([
      ['−3', 1],
      ['−2', 1],
      ['−1', 1],
      ['0', 1],
      ['1', 1],
      ['2', 1],
      ['3', 0],
    ]);
    expect(s.n).toBe(6);
    expect(s.mean).toBeCloseTo(-0.5, 10);
    expect(s.median).toBe(-0.5);
    expect(s.sides).toEqual({ below: 3, middle: 1, above: 2 });
    expect(s.ci).toBeNull(); // fewer than 10 texts
  });

  it('keeps the codebook’s categories in order, with their own names, and no mean', () => {
    const { run, items, fields } = setup(rows);
    const s = summarizeField(run, fields[1], items);
    expect(s.kind).toBe('categories');
    expect(s.bins.map((b) => [b.label, b.n])).toEqual([
      ['Critical', 3],
      ['Neutral', 2],
      ['Appreciative', 1],
    ]);
    expect(s.mean).toBeNull();
    expect(s.yes).toBeNull();
  });

  it('gives a yes/no field’s share of yes', () => {
    const { run, items, fields } = setup(rows);
    const s = summarizeField(run, fields[2], items);
    expect(s.bins.map((b) => [b.label, b.n])).toEqual([
      ['Yes', 2],
      ['No', 4],
    ]);
    expect(s.yes?.share).toBeCloseTo(2 / 6, 10);
    expect(s.yes?.ci).toBeNull(); // fewer than 10
  });

  it('splits by a metadata column in natural order, texts without a value last', () => {
    const { run, items, fields } = setup(rows);
    expect(groupColumns(items)).toEqual(['era']); // file names differ for every text
    const g = summarizeByGroup(run, fields[0], items, 'era');
    expect(g.map((x) => [x.group, x.summary.n, x.summary.mean])).toEqual([
      ['1960s', 3, -4 / 3],
      ['1970s', 2, 1.5],
      ['(no value)', 1, -2],
    ]);
    expect(g[2].none).toBe(true);
  });

  it('counts failed and waiting texts apart, and combines the rest', () => {
    const docs = [doc(0), doc(1), doc(2), doc(3)];
    const run = makeRun(structured, docs.map((d) => d.id), 2);
    const results = [
      result(run.id, 'd0', 1, { orientation: '1', tone: 'Neutral', mentions_trump: 'true' }),
      result(run.id, 'd0', 2, { orientation: '2', tone: 'Critical', mentions_trump: 'false' }),
      result(run.id, 'd1', 1, { orientation: '-1', tone: 'Neutral', mentions_trump: 'false' }),
      result(run.id, 'd1', 2, {}, 'error'),
      result(run.id, 'd2', 1, {}, 'error'),
      result(run.id, 'd2', 2, {}, 'error'),
    ];
    const views = buildDocViews(docs, [run], results, run.id);
    const items = runItems(run, docs, views);
    expect(runCounts(items, 2)).toEqual({ total: 4, annotated: 2, fewer: 1, failed: 1, waiting: 1 });
    const fields = comparableFields(run, views.values());
    const o = summarizeField(run, fields[0], items);
    // d0: median of 1 and 2 = 1.5, a half point between the scale's points; d1: −1.
    expect(o.bins.filter((b) => b.n).map((b) => [b.label, b.n, !!b.extra])).toEqual([
      ['−1', 1, false],
      ['1.5', 1, true],
    ]);
    expect(o.bins.map((b) => b.value)).toEqual([-3, -2, -1, 0, 1, 1.5, 2, 3]);
    expect(o.mean).toBeCloseTo(0.25, 10);
    // Ties: d0's tone is a tie, its yes/no too.
    const tone = summarizeField(run, fields[1], items);
    expect(tone.bins.map((b) => [b.label, b.n, !!b.extra])).toEqual([
      ['Critical', 0, false],
      ['Neutral', 1, false],
      ['Appreciative', 0, false],
      ['No majority (tie)', 1, true],
    ]);
    const yn = summarizeField(run, fields[2], items);
    expect(yn.bins.map((b) => [b.label, b.n])).toEqual([
      ['Yes', 0],
      ['No', 1],
      ['No majority (tie)', 1],
    ]);
    // The share of yes is among texts with yes or no.
    expect(yn.yes).toMatchObject({ share: 0, n: 1 });
  });
});

describe('summarizing a plain-text run with JSON scores', () => {
  const prompt: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'text', variables: [] };
  function textSetup(answers: string[], scoreScale?: { min: number; max: number }) {
    const docs = answers.map((_, i) => doc(i));
    const run = { ...makeRun(prompt, docs.map((d) => d.id)), ...(scoreScale ? { scoreScale } : {}) };
    const results = answers.map((a, i) => result(run.id, `d${i}`, 1, { response: a }));
    const views = buildDocViews(docs, [run], results, run.id);
    const items = runItems(run, docs, views);
    return { run, items, fields: comparableFields(run, views.values()) };
  }

  it('leaves out answers that aren’t numbers (e.g. "NA") and reports them, and counts answers without the key', () => {
    const { run, items, fields } = textSetup(['{"score": 2, "explanation": "x"}', '{"score": -1}', '{"score": "NA"}', '{"score": 1}', 'Just prose.']);
    const f = fields.find((x) => x.key === 'score')!;
    const s = summarizeField(run, f, items);
    expect(s.kind).toBe('scale');
    expect(s.n).toBe(3);
    expect(s.leftOut).toEqual({ n: 1, values: ['NA'], offScale: 0, scale: null });
    expect(s.missing).toBe(1);
    // Scale: the whole numbers seen, −1 to 2.
    expect(s.bins.map((b) => b.label)).toEqual(['−1', '0', '1', '2']);
    expect(s.diverging).toBe(true);
  });

  it('uses the study’s declared scale for the points', () => {
    const { run, items, fields } = textSetup(['{"score": 2}', '{"score": 0}', '{"score": 1}'], { min: -3, max: 3 });
    const s = summarizeField(run, fields[0], items);
    expect(s.bins.map((b) => b.label)).toEqual(['−3', '−2', '−1', '0', '1', '2', '3']);
    expect(s.range).toEqual([-3, 3]);
  });

  it('draws 0/1 flags as a scale of two points, not around 0, with the share of 1s', () => {
    const { run, items, fields } = textSetup(['{"flag": 1}', '{"flag": 0}', '{"flag": 1}']);
    const s = summarizeField(run, fields[0], items);
    expect(s.kind).toBe('scale');
    expect(s.diverging).toBe(false);
    expect(s.bins.map((b) => [b.label, b.n])).toEqual([
      ['0', 1],
      ['1', 2],
    ]);
    expect(s.yes).toMatchObject({ share: 2 / 3, n: 3, word: '1' });
    expect(s.mean).toBeNull();
  });

  it('leaves a flag’s far codes (9 for can’t tell) out of the share and reports them', () => {
    const answers = [...Array(12).fill('{"flag": 1}'), ...Array(8).fill('{"flag": 0}'), '{"flag": 9}'];
    const { run, items, fields } = textSetup(answers);
    const s = summarizeField(run, fields[0], items);
    expect(s.yes?.share).toBeCloseTo(0.6, 10);
    expect(s.n).toBe(20);
    expect(s.leftOut).toEqual({ n: 1, values: ['9'], offScale: 1, scale: [0, 1] });
    // Wilson, not t: inside 0…1.
    const [lo, hi] = s.yes!.ci!;
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeLessThan(1);
  });

  it('leaves numbers off the study’s declared scale out of the figures', () => {
    const answers = ['{"score": 2}', '{"score": 0}', '{"score": 1}', '{"score": -1}', '{"score": 9}'];
    const { run, items, fields } = textSetup(answers, { min: -3, max: 3 });
    const s = summarizeField(run, fields[0], items);
    expect(s.n).toBe(4);
    expect(s.mean).toBeCloseTo(0.5, 10);
    expect(s.leftOut).toMatchObject({ n: 1, offScale: 1, scale: [-3, 3] });
    expect(s.bins.map((b) => b.label)).toEqual(['−3', '−2', '−1', '0', '1', '2', '3']);
  });

  it('draws probabilities between 0 and 1 as numbers, not as a flag', () => {
    const answers = Array.from({ length: 22 }, (_, i) => `{"p": ${(0.5 + i * 0.0225).toFixed(4)}}`);
    const { run, items, fields } = textSetup(answers);
    const s = summarizeField(run, fields[0], items);
    expect(s.kind).toBe('number');
    expect(s.yes).toBeNull();
    expect(s.mean).not.toBeNull();
  });

  it('draws a wide whole-number scale (0–100) as a histogram', () => {
    const answers = Array.from({ length: 101 }, (_, i) => `{"confidence": ${i}}`);
    const { run, items, fields } = textSetup(answers);
    const s = summarizeField(run, fields[0], items);
    expect(s.kind).toBe('number');
    expect(s.bins.length).toBeLessThanOrEqual(11);
    expect(s.bins.reduce((t, b) => t + b.n, 0)).toBe(101);
  });

  it('draws other numbers as a histogram', () => {
    const answers = Array.from({ length: 40 }, (_, i) => `{"confidence": ${(i * 2.5).toFixed(1)}}`);
    const { run, items, fields } = textSetup(answers);
    const s = summarizeField(run, fields[0], items);
    expect(s.kind).toBe('number');
    expect(s.bins).toHaveLength(10);
    expect(s.bins.reduce((t, b) => t + b.n, 0)).toBe(40);
    expect(s.ci).not.toBeNull();
  });
});

describe('structured fields without a scale', () => {
  it('treats the values of a category field that lists none as its categories, most frequent first', () => {
    const prompt: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'structured', variables: [{ name: 'topic', type: 'category', values: [], description: '' }] };
    const docs = [0, 1, 2].map((i) => doc(i));
    const run = makeRun(prompt, docs.map((d) => d.id));
    const results = ['war', 'film', 'war'].map((t, i) => result(run.id, `d${i}`, 1, { topic: t }));
    const views = buildDocViews(docs, [run], results, run.id);
    const s = summarizeField(run, comparableFields(run, views.values())[0], runItems(run, docs, views));
    expect(s.bins.map((b) => [b.label, b.n, !!b.extra])).toEqual([
      ['war', 2, false],
      ['film', 1, false],
    ]);
  });

  it('gives a 0/1 ordinal codebook the share of 1s with a Wilson interval', () => {
    const prompt: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'structured', variables: [{ name: 'present', type: 'ordinal', values: ['0', '1'], description: '' }] };
    const docs = Array.from({ length: 30 }, (_, i) => doc(i));
    const run = makeRun(prompt, docs.map((d) => d.id));
    const results = docs.map((d, i) => result(run.id, d.id, 1, { present: i === 0 ? '1' : '0' }));
    const views = buildDocViews(docs, [run], results, run.id);
    const s = summarizeField(run, comparableFields(run, views.values())[0], runItems(run, docs, views));
    expect(s.yes?.share).toBeCloseTo(1 / 30, 10);
    // Wilson 95%: 0.0059 to 0.1667
    expect(s.yes!.ci![0]).toBeCloseTo(0.0059, 3);
    expect(s.yes!.ci![1]).toBeCloseTo(0.1667, 3);
  });
});

describe('histogram and labels', () => {
  it('labels bins of years with whole years at round edges', () => {
    const years = Array.from({ length: 50 }, (_, i) => 1965 + i);
    const bins = histogram(years);
    expect(bins[0].label).toBe('1965–1970');
    expect(bins[bins.length - 1].label).toBe('2010–2015');
    expect(bins.reduce((t, b) => t + b.n, 0)).toBe(50);
    expect(new Set(bins.map((b) => b.label)).size).toBe(bins.length);
  });
  it('labels small widths with the decimals they need', () => {
    const xs = Array.from({ length: 30 }, (_, i) => i * 0.08);
    const bins = histogram(xs);
    expect(bins[0].label).toBe('0.00–0.25');
    expect(bins.every((b) => /^−?\d+(\.\d+)?–−?\d+(\.\d+)?$/.test(b.label))).toBe(true);
    expect(new Set(bins.map((b) => b.label)).size).toBe(bins.length);
  });
  it('puts the highest value in the last bin', () => {
    const xs = Array.from({ length: 21 }, (_, i) => i * 5);
    const bins = histogram(xs);
    expect(bins).toHaveLength(10);
    expect(bins[9].n).toBe(3); // 90, 95, 100
    expect(bins[0].label).toBe('0–10');
  });
  it('shows a real minus sign', () => {
    expect(scaleLabel(-2.5)).toBe('−2.5');
    expect(scaleLabel(1 / 3)).toBe('0.33');
  });
});

describe('filter and periods', () => {
  const prompt: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'structured', variables: [{ name: 'o', type: 'ordinal', values: ['-3', '-2', '-1', '0', '1', '2', '3'], description: '' }] };
  // Years 1949–2026, one text each, journal AQ before 2021, then alternately AQ and JAS; score falls by year.
  const years = Array.from({ length: 78 }, (_, i) => 1949 + i);
  const docs = years.map((y, i) => doc(i, { year: String(y), journal: y < 2021 || i % 2 ? 'AQ' : 'JAS', file: `f${i}` }));
  docs.push(doc(78, { year: 'unknown', journal: 'AQ' }));
  const run = makeRun(prompt, docs.map((d) => d.id));
  const score = (y: number) => String(Math.max(-3, Math.min(3, Math.round((1990 - y) / 15))));
  const results = docs.map((d, i) => result(run.id, d.id, 1, { o: i < 78 ? score(years[i]) : '0' }));
  const views = buildDocViews(docs, [run], results, run.id);
  const items = runItems(run, docs, views);
  const field = comparableFields(run, views.values())[0];

  it('knows numeric columns and offers round steps', async () => {
    const { columnInfo, periodSteps, splitColumns, filterColumns } = await import('./summary');
    const cols = columnInfo(items);
    const year = cols.find((c) => c.name === 'year')!;
    expect(year).toMatchObject({ numeric: true, min: 1949, max: 2026, whole: true });
    const { steps, preferred } = periodSteps(year);
    expect(steps).not.toContain(0); // 78 values: no split by each one
    expect(steps).toEqual(expect.arrayContaining([5, 10, 20, 25]));
    expect(preferred).toBe(5);
    expect(splitColumns(cols).map((c) => c.name)).toEqual(['year', 'journal']);
    expect(filterColumns(cols).map((c) => c.name)).toEqual(['year', 'journal']);
  });

  it('splits years in five-year periods starting at multiples of five, unknown years last', async () => {
    const { summarizeByGroup } = await import('./summary');
    const g = summarizeByGroup(run, field, items, 'year', 5, true);
    expect(g[0]).toMatchObject({ group: '1945–1949', from: 1945, to: 1950 });
    expect(g[0].summary.n).toBe(1);
    expect(g[1]).toMatchObject({ group: '1950–1954' });
    expect(g[1].summary.n).toBe(5);
    expect(g[g.length - 2]).toMatchObject({ group: '2025–2029' });
    expect(g[g.length - 2].summary.n).toBe(2);
    expect(g[g.length - 1]).toMatchObject({ group: '(no value)', none: true });
    expect(g.reduce((t, x) => t + x.summary.n, 0)).toBe(79);
    // 1950–1954: scores of 1950…1954 = round(40/15)=3, round(39/15)=3, 2.53→3, 2.47→2, 2.4→2
    expect(g[1].summary.mean).toBeCloseTo((3 + 3 + 3 + 2 + 2) / 5, 10);
  });

  it('shows only a subset: a value, or a range of numbers', async () => {
    const { filterItems, subsetLabel } = await import('./summary');
    expect(filterItems(items, { column: 'journal', value: 'JAS' }).length).toBe(3);
    const late = filterItems(items, { column: 'year', from: 2000, to: 2026 });
    expect(late.length).toBe(27);
    expect(subsetLabel({ column: 'year', from: 2000, to: 2026 })).toBe('year 2000 to 2026');
    expect(subsetLabel({ column: 'journal', value: 'JAS' })).toBe('journal = JAS');
    expect(filterItems(items, null)).toBe(items);
  });
});

describe('review of the filter and periods (Nov 6)', () => {
  const prompt: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'structured', variables: [{ name: 'o', type: 'ordinal', values: ['-3', '-2', '-1', '0', '1', '2', '3'], description: '' }] };
  const mk = (metas: Record<string, string>[], scores?: string[]) => {
    const docs = metas.map((m, i) => doc(i, m));
    const run = makeRun(prompt, docs.map((d) => d.id));
    const results = docs.map((d, i) => result(run.id, d.id, 1, { o: scores?.[i] ?? '0' }));
    const views = buildDocViews(docs, [run], results, run.id);
    return { run, items: runItems(run, docs, views), field: comparableFields(run, views.values())[0] };
  };

  it('offers whole steps only for whole numbers (no 2.5-year periods)', async () => {
    const { columnInfo, periodSteps } = await import('./summary');
    const { items } = mk(Array.from({ length: 78 }, (_, i) => ({ year: String(1949 + i) })));
    const { steps } = periodSteps(columnInfo(items).find((c) => c.name === 'year')!);
    expect(steps.every(Number.isInteger)).toBe(true);
    expect(steps).toEqual(expect.arrayContaining([2, 5, 10, 20, 25]));
  });

  it('groups a column of numbers by each number, in numeric order, text values without a number', async () => {
    const { summarizeByGroup } = await import('./summary');
    const labels = ['-1', '-2', '0', '2', '-3', '2.0', 'n.d.', '−3'];
    const { run, items, field } = mk(labels.map((v) => ({ gold: v })));
    const g = summarizeByGroup(run, field, items, 'gold', 0, true, true);
    expect(g.map((x) => [x.group, x.summary.n])).toEqual([
      ['−3', 2],
      ['−2', 1],
      ['−1', 1],
      ['0', 1],
      ['2', 2],
      ['(no value)', 1],
    ]);
  });

  it('keeps every period between the first and the last, empty ones too', async () => {
    const { summarizeByGroup } = await import('./summary');
    const years = [1950, 1951, 1972, 1973];
    const { run, items, field } = mk(years.map((y) => ({ year: String(y) })));
    const g = summarizeByGroup(run, field, items, 'year', 5, true, true);
    expect(g.map((x) => [x.group, x.summary.n])).toEqual([
      ['1950–1954', 2],
      ['1955–1959', 0],
      ['1960–1964', 0],
      ['1965–1969', 0],
      ['1970–1974', 2],
    ]);
  });

  it('labels periods of fractions as half-open', async () => {
    const { summarizeByGroup } = await import('./summary');
    const { run, items, field } = mk([{ p: '0.2' }, { p: '0.25' }, { p: '0.31' }]);
    const g = summarizeByGroup(run, field, items, 'p', 0.1, false, true);
    expect(g.map((x) => x.group)).toEqual(['0.2–<0.3', '0.3–<0.4']);
  });

  it('can show and split by a column only some texts have (a sample marked validation)', async () => {
    const { columnInfo, filterColumns, splitColumns, filterItems } = await import('./summary');
    const { items } = mk([{ sample: 'validation' }, {}, {}, { sample: 'validation' }, {}]);
    const cols = columnInfo(items);
    expect(filterColumns(cols).map((c) => c.name)).toEqual(['sample']);
    expect(splitColumns(cols).map((c) => c.name)).toEqual(['sample']);
    expect(filterItems(items, { column: 'sample', value: 'validation' }).length).toBe(2);
  });

  it('leaves out columns of numbers too wide for round steps (catalog numbers)', async () => {
    const { columnInfo, splitColumns } = await import('./summary');
    const { items } = mk(Array.from({ length: 60 }, (_, i) => ({ jstor: String(1000000 + i * 137713) })));
    expect(splitColumns(columnInfo(items)).map((c) => c.name)).toEqual([]);
  });

  it('gives categories without a codebook the same order (and colors) in every group', async () => {
    const { summarizeByGroup } = await import('./summary');
    const p2: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'structured', variables: [{ name: 't', type: 'category', values: [], description: '' }] };
    const docs = ['1950', '1950', '1950', '1951', '1951', '1951', '1951'].map((y, i) => doc(i, { year: y }));
    const run = makeRun(p2, docs.map((d) => d.id));
    const vals = ['x', 'x', 'y', 'y', 'y', 'y', 'x'];
    const results = docs.map((d, i) => result(run.id, d.id, 1, { t: vals[i] }));
    const views = buildDocViews(docs, [run], results, run.id);
    const items = runItems(run, docs, views);
    const g = summarizeByGroup(run, comparableFields(run, views.values())[0], items, 'year', 0, true, true);
    expect(g.map((x) => x.summary.bins.map((b) => b.key))).toEqual([
      ['y', 'x'],
      ['y', 'x'],
    ]);
  });

  it('names a typed range exactly', async () => {
    const { subsetLabel } = await import('./summary');
    expect(subsetLabel({ column: 'p', from: 0.125, to: 0.5 })).toBe('p 0.125 to 0.5');
    expect(subsetLabel({ column: 'x', from: -2 })).toBe('x from −2');
  });
});

describe('final check (Nov 6)', () => {
  const prompt: PromptSpec = { ...DEFAULT_PROMPT, outputMode: 'text', variables: [] };
  const mk = (answers: string[], metas: Record<string, string>[]) => {
    const docs = answers.map((_, i) => doc(i, metas[i]));
    const run = makeRun(prompt, docs.map((d) => d.id));
    const results = answers.map((a, i) => result(run.id, `d${i}`, 1, { response: a }));
    const views = buildDocViews(docs, [run], results, run.id);
    return { run, items: runItems(run, docs, views), fields: comparableFields(run, views.values()) };
  };

  it('counts every group of a split on the whole field’s histogram bins, so zeros in one are real', async () => {
    const { summarizeByGroup } = await import('./summary');
    // 0–100 scores: the first era low, the second high.
    const answers = Array.from({ length: 60 }, (_, i) => `{"confidence": ${i < 30 ? i : 40 + i}}`);
    const { run, items, fields } = mk(answers, answers.map((_, i) => ({ era: i < 30 ? 'early' : 'late' })));
    const all = summarizeField(run, fields[0], items);
    expect(all.kind).toBe('number');
    const g = summarizeByGroup(run, fields[0], items, 'era');
    for (const x of g) {
      expect(x.summary.bins.map((b) => b.key)).toEqual(all.bins.map((b) => b.key));
    }
    // Each group's counts add up to its texts, and the two groups to the whole.
    expect(g.map((x) => x.summary.bins.reduce((t, b) => t + b.n, 0))).toEqual([30, 30]);
    expect(all.bins.map((b) => b.n)).toEqual(all.bins.map((_, k) => g[0].summary.bins[k].n + g[1].summary.bins[k].n));
  });

  it('reads every group of a split as the whole field is (a flag stays a flag)', async () => {
    const { summarizeByGroup } = await import('./summary');
    // A flag with one far code: in the small group the 9 is a third of its answers.
    const answers = [...Array(30).fill('{"flag": 1}'), ...Array(20).fill('{"flag": 0}'), '{"flag": 0}', '{"flag": 1}', '{"flag": 9}'];
    const metas = answers.map((_, i) => ({ g: i < 50 ? 'a' : 'b' }));
    const { run, items, fields } = mk(answers, metas);
    const g = summarizeByGroup(run, fields[0], items, 'g');
    expect(g.map((x) => [x.summary.kind, x.summary.yes?.word])).toEqual([
      ['scale', '1'],
      ['scale', '1'],
    ]);
    expect(g[1].summary.leftOut.offScale).toBe(1);
  });

  it('labels each value of a column of decimals exactly', async () => {
    const { summarizeByGroup } = await import('./summary');
    const { run, items, fields } = mk(['{"s": 1}', '{"s": 2}'], [{ w: '0.125' }, { w: '0.126' }]);
    expect(summarizeByGroup(run, fields[0], items, 'w', 0, false, true).map((x) => x.group)).toEqual(['0.125', '0.126']);
  });

  it('rounds halves away from 0 on both sides, and percentages from the counts', async () => {
    const { wholePercent, yesPercent } = await import('./summary');
    expect(scaleLabel(-2.875)).toBe('−2.88');
    expect(scaleLabel(2.875)).toBe('2.88');
    expect(scaleLabel(-0.001)).toBe('0');
    expect(wholePercent(92, 160)).toBe('58%');
    expect(wholePercent(1, 300)).toBe('<1%');
    expect(wholePercent(1, 200)).toBe('1%');
    expect(yesPercent({ share: 23 / 80, n: 80 })).toBe('28.8%');
    expect(yesPercent({ share: 1 / 2, n: 2 })).toBe('50.0%');
  });
});
