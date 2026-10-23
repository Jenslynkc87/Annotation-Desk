import type { ProviderId } from '../types';
import { anthropicAdapter } from './anthropic';
import { openaiAdapter } from './openai';
import { BatchFailedError, type ModelInfo, type ProviderAdapter } from './types';

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
};

export function provider(id: ProviderId): ProviderAdapter {
  return PROVIDERS[id];
}

/** Effort levels to offer for a model; [] = the model has no effort setting (nothing is sent). */
export function effortChoices(p: ProviderId, info: ModelInfo | undefined): string[] {
  return info?.effortLevels ?? provider(p).effortOptions;
}

/** Keep the current effort if the model supports it; otherwise medium (or the nearest available). */
export function pickEffort(current: string, choices: string[]): string {
  if (!choices.length) return '';
  if (choices.includes(current)) return current;
  return choices.includes('medium') ? 'medium' : choices[0];
}

/** An error that trying again won't fix: a failed batch, or a 4xx answer other than rate limits and timeouts. */
export function isPermanentError(e: unknown): boolean {
  if (e instanceof BatchFailedError) return true;
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && ![408, 409, 429].includes(status);
}

/**
 * An error that says the provider could not be reached at all (offline, the API host blocked by a browser
 * extension, firewall or proxy): no HTTP answer, and not a timeout or a cancel.
 */
export function isConnectionError(e: unknown): boolean {
  const err = e as { status?: unknown; name?: string; message?: string } | null;
  if (!err || typeof err !== 'object' || typeof err.status === 'number') return false;
  if (err.name === 'AbortError' || err.name === 'APIUserAbortError' || /timed? ?out/i.test(err.message ?? '')) return false;
  return /connection|failed to fetch|networkerror|network error|load failed/i.test(`${err.name ?? ''} ${err.message ?? ''}`);
}

/** Turn SDK errors into one readable line (stored with the result, so any API key in it is masked). */
export function describeApiError(e: unknown): string {
  return describe(e).replace(/\b(sk-[a-z]*-?)[A-Za-z0-9_-]{8,}/g, '$1…');
}

function describe(e: unknown): string {
  if (e && typeof e === 'object') {
    const err = e as { status?: number; message?: string; name?: string; code?: unknown; error?: { message?: unknown; code?: unknown; error?: { message?: string } } };
    if (err.name === 'AbortError' || err.name === 'APIUserAbortError') return 'Cancelled';
    // Anthropic's error body is { error: { message } }, OpenAI's { message, code }; the SDKs' own message starts with
    // the status ("429 You exceeded …"), which is said once, below.
    const inner = err.error?.error?.message ?? (typeof err.error?.message === 'string' ? err.error.message : undefined);
    const msg = inner ?? (err.status && err.message ? err.message.replace(new RegExp(`^${err.status}\\s+`), '') : err.message) ?? String(e);
    if (err.status === 401) return `Invalid API key (401): ${msg}`;
    // (OpenAI: an exhausted quota or inactive billing is a 429 too, but not a rate limit.)
    const code = err.code ?? err.error?.code;
    if (err.status === 429) return `${code === 'insufficient_quota' || code === 'billing_not_active' ? 'Quota or billing problem' : 'Rate limited'} (429): ${msg}`;
    if (err.status) return `HTTP ${err.status}: ${msg}`;
    if (msg.includes('Failed to fetch') || msg.toLowerCase().includes('connection')) {
      return `Network error: ${msg.replace(/[.\s]+$/, '')}. Check your connection or browser extensions blocking the API.`;
    }
    return msg;
  }
  return String(e);
}

export type { ProviderAdapter };
