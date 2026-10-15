import OpenAI from 'openai';
import type { BatchLine, BatchStatus, CallOutcome, ModelInfo, ProviderAdapter, RequestInputs } from './types';

function client(apiKey: string) {
  // Calls go straight from the browser to OpenAI; the key never touches another server.
  return new OpenAI({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 4 });
}

const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Current text models per OpenAI's model overview (checked October 2026). Shown before a key is added
 *  and used to label/order the list loaded from the user's account. */
export const KNOWN_OPENAI_MODELS: ModelInfo[] = [
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', description: "OpenAI's most capable model, built for complex reasoning; the most expensive.", effortLevels: ALL_EFFORTS },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', description: 'Near-flagship performance at lower cost; a balanced default for annotation.', effortLevels: ALL_EFFORTS },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', description: "OpenAI's most efficient model, for focused, high-volume tasks.", effortLevels: ['none', ...ALL_EFFORTS] },
];

const EXCLUDE = /(audio|realtime|transcribe|tts|image|embedding|search|moderation|dall-e|whisper|davinci|babbage|instruct|computer|sora)/i;
const INCLUDE = /^(gpt|o\d|chatgpt)/i;

interface ResponseLike {
  id: string;
  model: string;
  status?: string | null;
  incomplete_details?: { reason?: string | null } | null;
  output_text?: string;
  output?: Array<{
    type: string;
    content?: Array<{ type: string; text?: string; refusal?: string }>;
    summary?: Array<{ text?: string }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number } | null;
    output_tokens_details?: { reasoning_tokens?: number } | null;
  } | null;
}

function toOutcome(r: ResponseLike): CallOutcome {
  let text = '';
  let summary = '';
  let refusal = '';
  for (const item of r.output ?? []) {
    if (item.type === 'message') {
      for (const c of item.content ?? []) {
        if (c.type === 'output_text' && c.text) text += c.text;
        if (c.type === 'refusal' && c.refusal) refusal += c.refusal;
      }
    } else if (item.type === 'reasoning') {
      for (const s of item.summary ?? []) if (s.text) summary += (summary ? '\n\n' : '') + s.text;
    }
  }
  if (!text && r.output_text) text = r.output_text;
  let stop = r.status ?? '';
  if (r.incomplete_details?.reason) stop += ` (${r.incomplete_details.reason})`;
  if (refusal) stop = `refusal: ${refusal}`;
  const u = r.usage;
  return {
    rawText: text,
    reasoningSummary: summary.trim(),
    usage: {
      inputTokens: u?.input_tokens ?? 0,
      outputTokens: u?.output_tokens ?? 0,
      cacheReadTokens: u?.input_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: 0,
      reasoningTokens: u?.output_tokens_details?.reasoning_tokens ?? 0,
    },
    responseId: r.id,
    modelReported: r.model,
    stopReason: stop,
    fallback: '',
    response: r,
  };
}

export const openaiAdapter: ProviderAdapter = {
  id: 'openai',
  label: 'OpenAI (GPT)',
  keyHint: 'sk-…',
  keyUrl: 'https://platform.openai.com/api-keys',
  effortOptions: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],

  async listModels(apiKey) {
    const out: (ModelInfo & { created: number })[] = [];
    for await (const m of client(apiKey).models.list()) {
      if (INCLUDE.test(m.id) && !EXCLUDE.test(m.id)) out.push({ id: m.id, label: m.id, created: m.created });
    }
    // Known current models first (with names and effort levels), then everything else, newest first.
    const ids = new Set(out.map((m) => m.id));
    const known = KNOWN_OPENAI_MODELS.filter((k) => ids.has(k.id));
    const rest = out.filter((m) => !KNOWN_OPENAI_MODELS.some((k) => k.id === m.id)).sort((a, b) => b.created - a.created);
    return [...known, ...rest.map(({ created: _c, ...m }) => m)];
  },

  buildRequestBase({ model, options, system, outputSchema, promptHash }: RequestInputs) {
    const body: Record<string, unknown> = {
      model: model.model,
      max_output_tokens: model.maxOutputTokens,
      // Do not keep responses on OpenAI's side; everything is logged locally instead.
      store: false,
    };
    if (system.trim()) body.instructions = system;
    const reasoning: Record<string, unknown> = {};
    if (model.effort) reasoning.effort = model.effort;
    if (model.reasoningSummary) reasoning.summary = 'auto';
    if (Object.keys(reasoning).length) body.reasoning = reasoning;
    if (outputSchema) {
      body.text = { format: { type: 'json_schema', name: 'annotation', schema: outputSchema, strict: true } };
    }
    if (model.temperature !== null) body.temperature = model.temperature;
    // OpenAI caches long prompt prefixes automatically. A stable cache key improves hit rates;
    // with caching "off" we simply don't send one (automatic caching cannot be disabled).
    if (options.caching) body.prompt_cache_key = `annotation-desk-${promptHash}`;
    return body;
  },

  buildRequestPart({ prefix, rest }) {
    // OpenAI caches identical prompt prefixes automatically.
    return { input: prefix + rest };
  },

  async send(apiKey, base, part, signal) {
    const params = { ...base, ...part } as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming;
    const r = await client(apiKey).responses.create(params, { signal });
    return toOutcome(r as unknown as ResponseLike);
  },

  async submitBatch(apiKey, base, items) {
    const c = client(apiKey);
    const jsonl = items
      .map((it) => JSON.stringify({ custom_id: it.customId, method: 'POST', url: '/v1/responses', body: { ...base, ...it.part } }))
      .join('\n');
    const file = await c.files.create({
      file: new File([jsonl], 'annotation-batch.jsonl', { type: 'application/jsonl' }),
      purpose: 'batch',
    });
    const batch = await c.batches.create({
      input_file_id: file.id,
      endpoint: '/v1/responses',
      completion_window: '24h',
    });
    return { batchId: batch.id, inputFileId: file.id };
  },

  async checkBatch(apiKey, batchId): Promise<BatchStatus> {
    const b = await client(apiKey).batches.retrieve(batchId);
    const c = b.request_counts;
    const terminal = ['completed', 'failed', 'expired', 'cancelled'];
    return {
      status: b.status,
      done: terminal.includes(b.status),
      total: c?.total ?? 0,
      completed: c?.completed ?? 0,
      failed: c?.failed ?? 0,
    };
  },

  async fetchBatchResults(apiKey, batchId) {
    const c = client(apiKey);
    const b = await c.batches.retrieve(batchId);
    const lines: BatchLine[] = [];
    for (const fileId of [b.output_file_id, b.error_file_id]) {
      if (!fileId) continue;
      const text = await (await c.files.content(fileId)).text();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as {
          custom_id: string;
          response?: { status_code: number; body: unknown } | null;
          error?: { message?: string } | null;
        };
        if (row.response && row.response.status_code === 200) {
          lines.push({ customId: row.custom_id, ok: true, outcome: toOutcome(row.response.body as ResponseLike) });
        } else {
          const bodyErr = (row.response?.body as { error?: { message?: string } } | undefined)?.error?.message;
          lines.push({
            customId: row.custom_id,
            ok: false,
            error: row.error?.message ?? bodyErr ?? `HTTP ${row.response?.status_code ?? '?'}`,
            response: row,
          });
        }
      }
    }
    if (b.errors?.data?.length && !lines.length) {
      throw new Error(b.errors.data.map((e) => e.message).join('; '));
    }
    return lines;
  },

  async cancelBatch(apiKey, batchId) {
    await client(apiKey).batches.cancel(batchId);
  },
};
