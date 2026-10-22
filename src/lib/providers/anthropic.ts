import Anthropic from '@anthropic-ai/sdk';
import type {
  BatchLine,
  BatchStatus,
  CallOutcome,
  ListedBatch,
  ModelInfo,
  ProviderAdapter,
  RequestInputs,
} from './types';
import { ZERO_USAGE } from './types';

function client(apiKey: string) {
  // Calls go straight from the browser to Anthropic; the key never touches another server.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 4 });
}

/** Uploading a batch (up to 256 MB) may take a while; never sent twice, since a repeat could start a second, paid batch. */
const UPLOAD = { timeout: 3_600_000, maxRetries: 0 };

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Claude models with adaptive thinking. Thinking is always requested for these: on the newest
 * models it is on regardless, and on Opus/Sonnet 4.6-4.8 it would otherwise be off.
 * Older models (e.g. Haiku 4.5) only support fixed thinking budgets and run without it.
 */
export function supportsAdaptiveThinking(model: string): boolean {
  return /^claude-(fable|mythos)/.test(model) || /^claude-(opus|sonnet|haiku)-([5-9]|4-[6-9])(\b|-|$)/.test(model);
}

/**
 * Temperature can't be set on these models: models after Opus 4.6 reject any value but 1, and on
 * Opus/Sonnet 4.6 it is incompatible with the thinking this app always sends.
 */
export function rejectsTemperature(model: string): boolean {
  return supportsAdaptiveThinking(model);
}

/** Human-readable thinking setting, for exports. */
export function thinkingLabel(model: string, summary: boolean): string {
  if (!supportsAdaptiveThinking(model)) return 'not used (model has no adaptive thinking)';
  return summary ? 'adaptive (on), summary recorded' : 'adaptive (on)';
}

export const FALLBACK_ANTHROPIC_MODELS: ModelInfo[] = [
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', description: "Anthropic's most capable model, for the hardest reasoning; also the most expensive." },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', description: "Anthropic's flagship for demanding, nuanced work; a strong default for annotation." },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', description: 'Fast and capable at half the price of Opus; a good fit for large corpora.' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', description: 'The fastest and cheapest Claude; suits clear-cut, high-volume labelling.' },
];

type Caps = Record<string, { supported?: boolean } & Record<string, unknown>> | undefined;

function supported(node: unknown): boolean | undefined {
  if (node && typeof node === 'object' && 'supported' in node) return Boolean((node as { supported: unknown }).supported);
  return undefined;
}

function toOutcome(msg: Anthropic.Message): CallOutcome {
  let text = '';
  let thinking = '';
  for (const block of msg.content as unknown as Array<Record<string, unknown> & { type: string }>) {
    if (block.type === 'text') text += block.text as string;
    else if (block.type === 'thinking') thinking += (thinking ? '\n\n' : '') + (block.thinking as string);
  }
  const u = msg.usage;
  let stop = msg.stop_reason ?? '';
  const details = (msg as unknown as { stop_details?: { category?: string | null } | null }).stop_details;
  if (stop === 'refusal' && details?.category) stop += ` (${details.category})`;
  return {
    rawText: text,
    reasoningSummary: thinking.trim(),
    usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      reasoningTokens: u.output_tokens_details?.thinking_tokens ?? 0,
    },
    responseId: msg.id,
    modelReported: msg.model,
    stopReason: stop,
    response: msg,
  };
}

/**
 * Leave out what the API no longer takes: `fallbacks` (the refusal fallback of the first version, October 15,
 * 2026, a beta feature) is still in the frozen settings of runs made then, and would be rejected when their
 * failed requests are re-sent.
 */
function withoutRetiredParams(params: Record<string, unknown>): Record<string, unknown> {
  const { fallbacks: _f, ...rest } = params;
  return rest;
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  keyHint: 'sk-ant-…',
  keyUrl: 'https://console.anthropic.com/settings/keys',
  effortOptions: EFFORTS,

  async listModels(apiKey) {
    const out: ModelInfo[] = [];
    for await (const m of client(apiKey).models.list({ limit: 100 })) {
      const caps = (m as unknown as { capabilities?: Caps }).capabilities;
      const effortNode = caps?.effort as Record<string, unknown> | undefined;
      const effortLevels =
        effortNode && supported(effortNode) ? EFFORTS.filter((e) => supported(effortNode[e])) : effortNode ? [] : undefined;
      const thinkingTypes = (caps?.thinking as { types?: Record<string, unknown> } | undefined)?.types;
      out.push({
        id: m.id,
        label: m.display_name || m.id,
        description: FALLBACK_ANTHROPIC_MODELS.find((k) => k.id === m.id)?.description,
        effortLevels,
        supportsAdaptiveThinking: thinkingTypes ? supported(thinkingTypes.adaptive) : undefined,
        supportsStructuredOutput: supported(caps?.structured_outputs),
        maxOutputTokens: (m as unknown as { max_tokens?: number }).max_tokens,
      });
    }
    return out;
  },

  buildRequestBase({ model, options, system, outputSchema }: RequestInputs) {
    const body: Record<string, unknown> = {
      model: model.model,
      max_tokens: model.maxOutputTokens,
    };
    if (system.trim()) {
      if (options.caching) {
        const cache: Record<string, unknown> = { type: 'ephemeral' };
        if (options.cacheTtl === '1h') cache.ttl = '1h';
        body.system = [{ type: 'text', text: system, cache_control: cache }];
      } else {
        body.system = system;
      }
    }
    if (supportsAdaptiveThinking(model.model)) {
      body.thinking = model.reasoningSummary ? { type: 'adaptive', display: 'summarized' } : { type: 'adaptive' };
    }
    const outputConfig: Record<string, unknown> = {};
    if (model.effort) outputConfig.effort = model.effort;
    if (outputSchema) outputConfig.format = { type: 'json_schema', schema: outputSchema };
    if (Object.keys(outputConfig).length) body.output_config = outputConfig;
    if (model.temperature !== null && !rejectsTemperature(model.model)) body.temperature = model.temperature;
    return body;
  },

  buildRequestPart({ prefix, rest }, options, _modelId) {
    // Cache the fixed start of the prompt (everything before the text) as its own block.
    if (options.caching && prefix.trim() && rest.trim()) {
      const cache: Record<string, unknown> = { type: 'ephemeral' };
      if (options.cacheTtl === '1h') cache.ttl = '1h';
      return {
        messages: [{ role: 'user', content: [{ type: 'text', text: prefix, cache_control: cache }, { type: 'text', text: rest }] }],
      };
    }
    return { messages: [{ role: 'user', content: prefix + rest }] };
  },

  async send(apiKey, base, part, signal) {
    const params = withoutRetiredParams({ ...base, ...part });
    // Streaming avoids HTTP timeouts on long thinking; we only keep the final message.
    const msg = await client(apiKey).messages.stream(params as unknown as Anthropic.MessageCreateParamsNonStreaming, { signal }).finalMessage();
    return toOutcome(msg);
  },

  async submitBatch(apiKey, base, items) {
    const batch = await client(apiKey).messages.batches.create(
      {
        requests: items.map((it) => ({
          custom_id: it.customId,
          params: withoutRetiredParams({ ...base, ...it.part }) as unknown as Anthropic.MessageCreateParamsNonStreaming,
        })),
      },
      UPLOAD,
    );
    return { batchId: batch.id };
  },

  async checkBatch(apiKey, batchId): Promise<BatchStatus> {
    const b = await client(apiKey).messages.batches.retrieve(batchId);
    const c = b.request_counts;
    const total = c.processing + c.succeeded + c.errored + c.canceled + c.expired;
    return {
      status: b.processing_status,
      done: b.processing_status === 'ended',
      total,
      completed: c.succeeded,
      failed: c.errored + c.canceled + c.expired,
      endedAt: b.ended_at ?? undefined,
    };
  },

  async listRecentBatches(apiKey, sinceIso) {
    const since = Date.parse(sinceIso) - 120_000;
    const out: ListedBatch[] = [];
    // Newest first: stop at the first batch created before the upload began.
    for await (const b of client(apiKey).messages.batches.list({ limit: 20 })) {
      if (Date.parse(b.created_at) < since) break;
      const c = b.request_counts;
      out.push({ batchId: b.id, createdAt: b.created_at, requests: c.processing + c.succeeded + c.errored + c.canceled + c.expired });
    }
    return out;
  },

  async fetchBatchResults(apiKey, batchId) {
    const lines: BatchLine[] = [];
    for await (const r of await client(apiKey).messages.batches.results(batchId)) {
      if (r.result.type === 'succeeded') {
        lines.push({ customId: r.custom_id, ok: true, outcome: toOutcome(r.result.message) });
      } else if (r.result.type === 'errored') {
        lines.push({ customId: r.custom_id, ok: false, error: r.result.error.error.message, response: r.result });
      } else {
        lines.push({ customId: r.custom_id, ok: false, error: `Request ${r.result.type}`, response: r.result });
      }
    }
    return lines;
  },

  async cancelBatch(apiKey, batchId) {
    await client(apiKey).messages.batches.cancel(batchId);
  },
};

export { ZERO_USAGE };
