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
  /** When the provider finished the batch (ISO time), if it has. */
  endedAt?: string;
}

/** A batch as the provider lists it (to find one whose upload got no answer). */
export interface ListedBatch {
  batchId: string;
  createdAt: string;
  requests: number;
  inputFileId?: string;
  /** OpenAI: its status (e.g. "validating") and the metadata it was created with. */
  status?: string;
  metadata?: Record<string, string>;
  /** Cancelled (or being cancelled) or expired: someone stopped it, so it is never taken for a lost upload by its
   *  number of requests alone. */
  stopped?: boolean;
}

/** How long before an upload began a batch it created may seem to have been created: the provider's clock may differ
 *  from this computer's by some minutes. */
export const CLOCK_MARGIN_MS = 600_000;

/** For an upload: metadata to create the batch with (OpenAI; never keys or texts), and a call made as soon as the
 *  input file has arrived (OpenAI), before the batch is started, so the file is on record if no answer comes. */
export interface SubmitOptions {
  metadata?: Record<string, string>;
  onFile?: (inputFileId: string) => Promise<void>;
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
  buildRequestPart(message: MessageParts, options: RunOptions, modelId: string): Record<string, unknown>;
  send(
    apiKey: string,
    base: Record<string, unknown>,
    part: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallOutcome>;
  submitBatch(apiKey: string, base: Record<string, unknown>, items: BatchItem[], opts?: SubmitOptions): Promise<BatchHandle>;
  checkBatch(apiKey: string, batchId: string): Promise<BatchStatus>;
  /** Batches created since `sinceIso` (newest first; `CLOCK_MARGIN_MS` of leeway for clock differences). */
  listRecentBatches(apiKey: string, sinceIso: string): Promise<ListedBatch[]>;
  fetchBatchResults(apiKey: string, batchId: string): Promise<BatchLine[]>;
  cancelBatch(apiKey: string, batchId: string): Promise<void>;
}

/** Thrown when a finished batch reports errors instead of results (e.g. OpenAI's validation or token limits). */
export class BatchFailedError extends Error {}

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};
