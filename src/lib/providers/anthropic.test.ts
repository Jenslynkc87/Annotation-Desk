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
