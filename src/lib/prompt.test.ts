import { describe, expect, it } from 'vitest';
import { fieldLabel, slugKey, uniqueKey } from './prompt';
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
