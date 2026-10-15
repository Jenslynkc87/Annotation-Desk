import { describe, expect, it } from 'vitest';
import { anthropicAdapter, supportsAdaptiveThinking } from './anthropic';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_RUN_OPTIONS } from '../types';

describe('adaptive thinking', () => {
  it('is used for current and 4.6+ models only', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-4-6'])
      expect(supportsAdaptiveThinking(m), m).toBe(true);
    for (const m of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-haiku-20240307', 'gpt-5'])
      expect(supportsAdaptiveThinking(m), m).toBe(false);
  });

  it('is always sent, with a summary only when requested', () => {
    const base = (reasoningSummary: boolean, model = 'claude-opus-5-5') =>
      anthropicAdapter.buildRequestBase({ model: { ...DEFAULT_MODEL_SETTINGS, model, reasoningSummary }, options: DEFAULT_RUN_OPTIONS, system: 'x', outputSchema: null, promptHash: 'h' });
    expect(base(false).thinking).toEqual({ type: 'adaptive' });
    expect(base(true).thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(base(false, 'claude-haiku-4-5').thinking).toBeUndefined();
  });
});

import { supportsExplicitCaching } from './openai';
describe('OpenAI explicit caching', () => {
  it('applies to GPT-5.6 and later only', () => {
    for (const m of ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol']) expect(supportsExplicitCaching(m), m).toBe(true);
    for (const m of ['gpt-5.5', 'gpt-5', 'gpt-4.1', 'o3', 'gpt-mock-1']) expect(supportsExplicitCaching(m), m).toBe(false);
  });
});

import { effortChoices, pickEffort } from './index';
describe('temperature and effort', () => {
  const base = (model: string, temperature: number | null) =>
    anthropicAdapter.buildRequestBase({ model: { ...DEFAULT_MODEL_SETTINGS, model, temperature }, options: DEFAULT_RUN_OPTIONS, system: '', outputSchema: null, promptHash: 'h' });
  it('never sends a temperature to models that reject it', () => {
    expect(base('claude-opus-5-5', 0.2).temperature).toBeUndefined();
    expect(base('claude-sonnet-4-6', 0.2).temperature).toBeUndefined();
    expect(base('claude-haiku-4-5', 0.2).temperature).toBe(0.2);
  });
  it('starts at medium and keeps only levels the model supports', () => {
    expect(DEFAULT_MODEL_SETTINGS.effort).toBe('medium');
    expect(pickEffort('xhigh', ['low', 'medium', 'high', 'max'])).toBe('medium');
    expect(pickEffort('high', ['low', 'medium', 'high'])).toBe('high');
    expect(pickEffort('medium', [])).toBe('');
    expect(effortChoices('anthropic', { id: 'claude-haiku-4-5', label: '', effortLevels: [] })).toEqual([]);
    expect(effortChoices('anthropic', undefined)).toContain('medium');
  });
});
