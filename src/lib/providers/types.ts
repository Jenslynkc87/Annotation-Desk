import type { MessageParts } from '../prompt';
import type { ModelSettings, ProviderId, RunOptions, Usage } from '../types';

export interface ModelInfo {
  id: string;
  label: string;
  /** One-sentence explainer shown under the model picker (known models only). */
  description?: string;
  /** Effort / reasoning levels the model reports supporting; undefined = unknown. */
  effortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsStructuredOutput?: boolean;
  maxOutputTokens?: number;
}

export interface CallOutcome {
  rawText: string;
  reasoningSummary: string;
  usage: Usage;
  responseId: string;
  modelReported: string;
  stopReason: string;
  /** Set when a refused request was answered by a fallback model, e.g. "claude-opus-5-5 → claude-opus-4-8". */
  fallback: string;
  /** Full provider response object, stored verbatim in the log. */
  response: unknown;
}

export interface BatchItem {
  customId: string;
  part: Record<string, unknown>;
}

export interface BatchHandle {
  batchId: string;
  inputFileId?: string;
}

export interface BatchStatus {
  status: string;
  done: boolean;
  total: number;
  completed: number;
  failed: number;
}

export type BatchLine =
  | { customId: string; ok: true; outcome: CallOutcome }
  | { customId: string; ok: false; error: string; response?: unknown };

export interface RequestInputs {
  model: ModelSettings;
  options: RunOptions;
  system: string;
  outputSchema: Record<string, unknown> | null;
  promptHash: string;
}

export interface ProviderAdapter {
  id: ProviderId;
  label: string;
  keyHint: string;
  keyUrl: string;
  effortOptions: string[];
  listModels(apiKey: string): Promise<ModelInfo[]>;
  buildRequestBase(inp: RequestInputs): Record<string, unknown>;
  buildRequestPart(message: MessageParts, options: RunOptions): Record<string, unknown>;
  send(
    apiKey: string,
    base: Record<string, unknown>,
    part: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallOutcome>;
  submitBatch(apiKey: string, base: Record<string, unknown>, items: BatchItem[]): Promise<BatchHandle>;
  checkBatch(apiKey: string, batchId: string): Promise<BatchStatus>;
  fetchBatchResults(apiKey: string, batchId: string): Promise<BatchLine[]>;
  cancelBatch(apiKey: string, batchId: string): Promise<void>;
}

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};
