import { renderMessageParts } from './prompt';
import { provider } from './providers';
import type { Doc, Run } from './types';

/**
 * Results whose text is gone: versions before November 2026 deleted a text's record when it was deleted from the
 * study, so its runs' results kept only an internal id. Each request the run sent is logged, text and all, so such a
 * result can be matched to a text in the study (or one kept as removed) whose request would be exactly the same.
 */

/** A text's request in a run, as sent (the per-text part; a batch's request name left out), as one string. */
export function requestKey(run: Run, doc: Pick<Doc, 'docId' | 'text' | 'meta'>): string {
  const s = run.snapshot;
  return JSON.stringify(provider(s.model.provider).buildRequestPart(renderMessageParts(s.prompt.userTemplate, doc, s.prompt.subject), s.options, s.model.model));
}

/** A logged request in the same form (batch requests are logged with their name, custom_id, first). */
export function loggedKey(requestPart: Record<string, unknown>): string {
  const { custom_id: _name, ...part } = requestPart;
  return JSON.stringify(part);
}

/** A short fingerprint of a long string (cyrb53), so candidates can be looked up without keeping their requests. */
function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${s.length}:${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
}

/** One lost text: its old internal id, and a logged request of it with the run that sent it. */
export interface LostText {
  id: string;
  run: Run;
  requestPart: Record<string, unknown>;
}

/**
 * For each lost text, the one candidate whose request in that run would be identical to the logged one. A lost text
 * that matches no candidate, or more than one (identical texts under two names, with a prompt that doesn't use the
 * name), is left out: never guessed.
 */
export function matchLostTexts(lost: LostText[], candidates: Doc[]): Map<string, string> {
  const out = new Map<string, string>();
  // The candidates' requests, per run setup that renders them differently (prompt, options, model).
  const byRun = new Map<string, Map<string, Doc[]>>();
  const setupOf = (run: Run) => JSON.stringify([run.snapshot.prompt.userTemplate, run.snapshot.prompt.subject ?? '', run.snapshot.options, run.snapshot.model.provider, run.snapshot.model.model]);
  for (const x of lost) {
    const setup = setupOf(x.run);
    let index = byRun.get(setup);
    if (!index) {
      index = new Map();
      for (const d of candidates) {
        const k = hash(requestKey(x.run, d));
        index.set(k, [...(index.get(k) ?? []), d]);
      }
      byRun.set(setup, index);
    }
    const logged = loggedKey(x.requestPart);
    const same = (index.get(hash(logged)) ?? []).filter((d) => requestKey(x.run, d) === logged);
    if (same.length === 1) out.set(x.id, same[0].id);
  }
  return out;
}
