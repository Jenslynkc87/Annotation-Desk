import { describe, expect, it } from 'vitest';
import { buildOutputSchema, fieldLabel, outputFields, flattenJsonResponse, invalidPlaceholders, isExplanationKey, normalizeLabel, parseModelOutput, renderMessage, renderMessageParts, slugKey, uniqueKey } from './prompt';
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
    // Prose that merely uses braces is not JSON.
    expect(parseModelOutput('Both groups {a, b} are named.', text).parseError).toBeNull();
  });
});

describe('explanation fields in JSON answers', () => {
  it('recognizes explanation and the older reasoning names', () => {
    for (const k of ['explanation', 'race_explanation', 'reasoning', 'race_reasoning']) expect(isExplanationKey(k)).toBe(true);
    for (const k of ['race_negative', 'score', 'explanations_count']) expect(isExplanationKey(k)).toBe(false);
  });
});

describe('field order: generation vs display', () => {
  const v = (name: string, type: 'ordinal' | 'text') => ({ name, type, values: type === 'ordinal' ? ['-1', '0', '1'] : [], description: '' });
  const prompt = {
    ...DEFAULT_PROMPT,
    outputMode: 'structured' as const,
    includeRationale: false,
    variables: [
      v('race_ethnicity_explanation', 'text'),
      v('race_ethnicity', 'ordinal'),
      v('gender_sexuality_explanation', 'text'),
      v('gender_sexuality', 'ordinal'),
    ],
  };
  it('the model writes the fields in list order, each explanation before its score', () => {
    const schema = buildOutputSchema(prompt) as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(['race_ethnicity_explanation', 'race_ethnicity', 'gender_sexuality_explanation', 'gender_sexuality']);
    expect(schema.required).toEqual(Object.keys(schema.properties));
  });
  it('the tables show each explanation right after its own score', () => {
    expect(outputFields(prompt)).toEqual(['race_ethnicity', 'race_ethnicity_explanation', 'gender_sexuality', 'gender_sexuality_explanation']);
  });
  it('leaves other field lists as they are', () => {
    const p = { ...prompt, variables: [v('a', 'ordinal'), v('explanation', 'text'), v('b_explanation', 'text')] };
    expect(outputFields(p)).toEqual(['a', 'explanation', 'b_explanation']);
  });
});

describe('entries (model-knowledge studies)', () => {
  it('are added between <entry> tags', () => {
    const doc = { docId: 'Niels Bohr', text: 'name: Niels Bohr\nborn: 1885', meta: {} };
    expect(renderMessage('Rate this person.', doc, 'entries')).toBe('Rate this person.\n\n<entry>\nname: Niels Bohr\nborn: 1885\n</entry>');
    expect(renderMessage('Rate this person.', doc)).toContain('<text>');
  });
});
