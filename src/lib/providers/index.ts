import type { ProviderId } from '../types';
import { anthropicAdapter } from './anthropic';
import { openaiAdapter } from './openai';
import type { ProviderAdapter } from './types';

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
};

export function provider(id: ProviderId): ProviderAdapter {
  return PROVIDERS[id];
}

/** Turn SDK errors into one readable line. */
export function describeApiError(e: unknown): string {
  if (e && typeof e === 'object') {
    const err = e as { status?: number; message?: string; name?: string; error?: { error?: { message?: string } } };
    if (err.name === 'AbortError' || err.name === 'APIUserAbortError') return 'Cancelled';
    const inner = err.error?.error?.message;
    const msg = inner ?? err.message ?? String(e);
    if (err.status === 401) return `Invalid API key (401): ${msg}`;
    if (err.status === 429) return `Rate limited (429): ${msg}`;
    if (err.status) return `HTTP ${err.status}: ${msg}`;
    if (msg.includes('Failed to fetch') || msg.toLowerCase().includes('connection')) {
      return `Network error: ${msg}. Check your connection or browser extensions blocking the API.`;
    }
    return msg;
  }
  return String(e);
}

export type { ProviderAdapter };
