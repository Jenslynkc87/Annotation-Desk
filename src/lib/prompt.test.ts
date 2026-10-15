import { describe, expect, it } from 'vitest';
import { fieldLabel, flattenJsonResponse, invalidPlaceholders, normalizeLabel, parseModelOutput, renderMessage, renderMessageParts, slugKey, uniqueKey } from './prompt';
import { DEFAULT_PROMPT } from './types';

describe('field names', () => {
  it('derives machine keys from display names', () => {
    expect(slugKey('Positive score')).toBe('positive_score');
    expect(slugKey('Sentiment (1–7)')).toBe('sentiment_1_7');
    expect(slugKey('Stærk følelse på skala')).toBe('staerk_folelse_pa_skala');
    expect(slugKey('2nd pass')).toBe('f_2nd_pass');
    expect(slugKey('')).toBe('field');
  });
  it('keeps keys unique and avoids the reserved name', () => {
    expect(uniqueKey('Score', ['score'])).toBe('score_2');
    expect(uniqueKey('Score', ['score', 'score_2'])).toBe('score_3');
    expect(uniqueKey('Rationale', [])).toBe('rationale_field');
  });
  it('shows the typed name, falling back to the key', () => {
    const p = { ...DEFAULT_PROMPT, variables: [{ name: 'positive_score', label: 'Positive score', type: 'number' as const, values: [], description: '' }, { name: 'old', type: 'text' as const, values: [], description: '' }] };
    expect(fieldLabel(p, 'positive_score')).toBe('Positive score');
    expect(fieldLabel(p, 'old')).toBe('old');
    expect(fieldLabel(p, 'rationale')).toBe('Rationale');
  });
});

describe('flattenJsonResponse', () => {
  it('flattens nested objects into underscore-joined columns', () => {
    const raw = '```json\n{"race":{"reasoning":"x","negative":2,"positive":0},"note":"hi"}\n```';
    expect(flattenJsonResponse(raw)).toEqual({ race_reasoning: 'x', race_negative: '2', race_positive: '0', note: 'hi' });
  });
  it('returns null for non-JSON or non-object answers', () => {
    expect(flattenJsonResponse('Positive')).toBeNull();
    expect(flattenJsonResponse('[1,2]')).toBeNull();
    expect(flattenJsonResponse('')).toBeNull();
  });
});

describe('placeholders', () => {
  const doc = { docId: 'd1', text: 'T', meta: { køn: 'kvinde', 'Gender (self)': 'x' } };
  it('fills names with any letters, e.g. {{meta.køn}}', () => {
    expect(renderMessage('Køn: {{meta.køn}}\n{{text}}', doc)).toBe('Køn: kvinde\nT');
    expect(renderMessageParts('Intro {{ meta.køn }} {{text}}', doc).prefix).toBe('Intro ');
  });
  it('lists markers that cannot be filled in', () => {
    expect(invalidPlaceholders('{{meta.Gender (self)}} {{text}} {{meta.køn}}')).toEqual(['{{meta.Gender (self)}}']);
  });
});

describe('normalizeLabel', () => {
  it('treats 1/0 as yes/no only for yes/no fields', () => {
    expect(normalizeLabel('1', true)).toBe('true');
    expect(normalizeLabel('0', true)).toBe('false');
    expect(normalizeLabel('1')).toBe('1');
    expect(normalizeLabel(' Yes ')).toBe('true');
  });
});

describe('plain-text answers with JSON', () => {
  const text = { ...DEFAULT_PROMPT, outputMode: 'text' as const };
  it('fails an answer whose JSON cannot be read, accepts prose and readable JSON', () => {
    expect(parseModelOutput('{"score": 2, "reasoning": "cut off', text).parseError).toBe('Answer contains JSON that could not be read');
    expect(parseModelOutput('Here you go: {"score": 2}', text).parseError).not.toBeNull();
    expect(parseModelOutput('```json\n{"score": 2}\n```', text).parseError).toBeNull();
    expect(parseModelOutput('The text is broadly supportive.', text).parseError).toBeNull();
  });
});
