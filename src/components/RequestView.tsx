import { useMemo } from 'react';

type Json = Record<string, unknown>;

/** Text parts of a message content (string, or array of text parts). */
function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as Json).text) : '')).join('');
  return '';
}

/** Pull the human-readable prompt out of a request so it can be shown with real line breaks. */
export function splitRequest(req: Json): { system: string; message: string; settings: Json } {
  const settings = structuredClone(req) as Json;
  let system = '';
  let message = '';
  // Anthropic: system + messages
  if ('system' in settings) {
    system = contentText(settings.system);
    delete settings.system;
  }
  if (Array.isArray(settings.messages)) {
    message = (settings.messages as Json[]).map((m) => contentText(m.content)).join('\n');
    delete settings.messages;
  }
  // OpenAI Responses: instructions + input
  if ('instructions' in settings) {
    system = String(settings.instructions);
    delete settings.instructions;
  }
  if ('input' in settings) {
    const input = settings.input;
    message = typeof input === 'string' ? input : Array.isArray(input) ? input.map((m) => contentText((m as Json).content ?? m)).join('\n') : '';
    delete settings.input;
  }
  return { system, message, settings };
}

/**
 * Shows a request the way the model reads it: system prompt and message with real line breaks,
 * and everything else (model, effort, schema, caching, …) as JSON.
 */
export function RequestView({ request }: { request: Json }) {
  const { system, message, settings } = useMemo(() => splitRequest(request), [request]);
  return (
    <div className="stack" style={{ gap: 14 }}>
      {system && (
        <div>
          <p className="section-title">System prompt</p>
          <pre className="textblock" style={{ maxHeight: 220 }}>{system}</pre>
        </div>
      )}
      <div>
        <p className="section-title">Message as the model reads it</p>
        <pre className="textblock" style={{ maxHeight: 420 }}>{message}</pre>
      </div>
      <div>
        <p className="section-title">Settings sent with it</p>
        <pre className="textblock mono" style={{ maxHeight: 320 }}>{JSON.stringify(settings, null, 2)}</pre>
      </div>
    </div>
  );
}
