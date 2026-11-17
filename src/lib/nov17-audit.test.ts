// Points from the Nov 17, 2026 audit of the Lab's research mode that also applied to Desk.
import { describe, expect, it } from 'vitest';
import { agreement } from './metrics';
import { asSent, flattenJsonResponse, lookAlikeValues, promptMetaColumns, renderMessage } from './prompt';
import { drawStratifiedSample, SAMPLING_METHOD } from './sample';
import type { Doc } from './types';

const doc = (id: string, meta: Record<string, string>): Doc => ({ id, studyId: 's', docId: id, text: `text ${id}`, order: 0, addedAt: '', source: `${id}.md`, meta: { file: `${id}.md`, ...meta } });

describe('category values that read alike', () => {
  it('are named, so the codebook editor can warn', () => {
    expect(lookAlikeValues(['01', '1', 'other'])).toEqual([['01', '1']]);
    expect(lookAlikeValues(['Essay', 'essay ', 'review'])).toEqual([['Essay', 'essay']]);
    expect(lookAlikeValues(['-3', '-2', '-1', '0', '1', '2', '3'])).toEqual([]);
    expect(lookAlikeValues(['positive', 'positive'])).toEqual([]);
  });
});

describe('numeric category codes', () => {
  it('leave out a whole number that is no code (a coder’s 2 where the codes are 1 and 3)', () => {
    const a = agreement(['1', '3', '1'], ['1', '2', '1'], 'nominal', ['1', '3'], 1, { withIntervals: false });
    expect(a.n).toBe(2);
    expect(a.leftOut.n).toBe(1);
    expect(a.percentAgreement).toBe(1);
  });
  it('still compare a value between two codes (a 1.5), as before', () => {
    const a = agreement(['1', '3', '1.5'], ['1', '3', '1'], 'nominal', ['1', '3'], 1, { withIntervals: false });
    expect(a.n).toBe(3);
  });
  it('leave an ordinal −3…3 scale as it was: every number on the scale and half points count', () => {
    const x = ['-3', '-2', '0', '0.5', '2', '3', '1', '-1'];
    const y = ['-3', '-1', '0', '1', '2', '2', '1', '-2'];
    const a = agreement(x, y, 'ordinal', ['-3', '-2', '-1', '0', '1', '2', '3'], 1, { withIntervals: false });
    expect(a.n).toBe(8);
    expect(a.leftOut.n).toBe(0);
  });
});

describe('plain-text JSON keys that flatten to one column', () => {
  it('leave that column blank when the values differ, in either order', () => {
    expect(flattenJsonResponse('{"stance":{"score":-3},"stance_score":3}')).toEqual({ stance_score: '' });
    expect(flattenJsonResponse('{"stance_score":3,"stance":{"score":-3}}')).toEqual({ stance_score: '' });
  });
  it('keep a value given twice alike, and every answer without a clash, as before', () => {
    expect(flattenJsonResponse('{"stance":{"score":2},"stance_score":2}')).toEqual({ stance_score: '2' });
    expect(flattenJsonResponse('{"race":{"negative":1,"explanation":"x"},"constructor":4}')).toEqual({ race_negative: '1', race_explanation: 'x', constructor: '4' });
  });
});

describe('sampling method 4', () => {
  const look = [doc('a', { x: 'a · b', y: 'c' }), doc('b', { x: 'a', y: 'b · c' }), doc('c', { x: '', y: 'z' }), doc('d', { x: '(none)', y: 'z' })];
  it('keeps strata apart whose joined names coincide (method 3 merged them)', () => {
    expect(SAMPLING_METHOD).toBe('sampling method 4');
    expect(drawStratifiedSample(look, { size: 4, strata: ['x', 'y'], exclude: null, seed: 1 }).strata).toHaveLength(4);
    expect(drawStratifiedSample(look, { size: 4, strata: ['x', 'y'], exclude: null, seed: 1, method: 3 }).strata).toHaveLength(2);
  });
  it('draws exactly as method 3 wherever no names coincide', () => {
    const docs = Array.from({ length: 600 }, (_, i) => doc(`t${i}`, { era: ['1950s', '1970s', '1990s', ''][i % 4], journal: i % 7 ? 'AQ' : 'JAS' }));
    for (const seed of [1, 42, 9999]) {
      for (const size of [7, 60, 333]) {
        const o = { size, strata: ['journal', 'era'], exclude: null, seed };
        expect(drawStratifiedSample(docs, o)).toEqual(drawStratifiedSample(docs, { ...o, method: 3 }));
      }
    }
  });
});

describe('metadata a prompt inserts', () => {
  const prompt = 'Rate this. Year: {{meta.year}}.';
  it('is named, and a run sends the values it first sent', () => {
    expect(promptMetaColumns(prompt)).toEqual(['year']);
    expect(promptMetaColumns('Rate the article.')).toEqual([]);
    const d = doc('a', { year: '2024' });
    const run = { metaSent: { a: { year: '1990' } } };
    expect(renderMessage(prompt, asSent(run, d))).toContain('Year: 1990.');
    expect(renderMessage(prompt, asSent({}, d))).toContain('Year: 2024.');
  });
  it('leaves a prompt without {{meta.…}} exactly as before', () => {
    const d = doc('a', { year: '2024' });
    expect(asSent({}, d)).toBe(d);
  });
});
