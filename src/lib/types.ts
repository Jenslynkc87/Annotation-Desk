// Core data model. Everything here is persisted in IndexedDB and exported as-is
// in the research repository, so field names are part of the public file format.

export type ProviderId = 'anthropic' | 'openai';

export type VariableType = 'category' | 'ordinal' | 'number' | 'boolean' | 'text';

/** One annotation field the model must return (a codebook entry). */
export interface Variable {
  name: string; // machine key, used as JSON key and export column; derived from `label`
  /** Name as typed by the user (any characters); shown in the app. Falls back to `name`. */
  label?: string;
  type: VariableType;
  /** Allowed values for category / ordinal (ordinal values are integers). */
  values: string[];
  description: string;
}

export type OutputMode = 'structured' | 'text';

export interface ModelSettings {
  provider: ProviderId;
  model: string;
  /** Always set explicitly (starts at "medium"). '' = not sent: the model has no effort setting
   *  (runs made before effort became explicit used '' for the provider's default). */
  effort: string;
  /** Ask the provider to return a readable reasoning summary (stored per result). */
  reasoningSummary: boolean;
  /** null = not sent. */
  temperature: number | null;
  maxOutputTokens: number;
}

export interface RunOptions {
  /** OpenAI: keep requests in the OpenAI dashboard logs (the API's default). Undefined = on. */
  storeInLogs?: boolean;
  caching: boolean;
  /** Anthropic cache lifetime, set per run: 5m for immediate requests, 1h for batches. */
  cacheTtl: '5m' | '1h';
  batch: boolean;
  replicates: number;
  concurrency: number;
}

export interface PromptSpec {
  /** Optional system prompt (advanced); sent unchanged with every text. */
  system: string;
  /** The prompt sent with each text. {{text}}, {{id}} and {{meta.<column>}} are substituted;
   *  without {{text}}, the text is added at the end (see effectiveTemplate). */
  userTemplate: string;
  outputMode: OutputMode;
  variables: Variable[];
  /** Add a free-text "rationale" field to structured output. */
  includeRationale: boolean;
}

/** A named prompt (text, output mode and fields) kept in the study, to switch between several. */
export interface SavedPrompt {
  id: string;
  name: string;
  savedAt: string;
  prompt: PromptSpec;
}

export interface Study {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  model: ModelSettings;
  options: RunOptions;
  prompt: PromptSpec;
  savedPrompts?: SavedPrompt[];
}

export interface Doc {
  id: string; // internal key
  studyId: string;
  /** User-facing identifier (from an ID column or file name). Unique within a study. */
  docId: string;
  text: string;
  /** Metadata columns, including any gold/human labels. */
  meta: Record<string, string>;
  source: string; // file name or "pasted"
  order: number;
  addedAt: string;
}

export type RunStatus = 'running' | 'submitted' | 'completed' | 'cancelled' | 'failed';

/** Everything needed to reproduce a run, frozen when the run starts. */
export interface RunSnapshot {
  appVersion: string;
  model: ModelSettings;
  options: RunOptions;
  prompt: PromptSpec;
  promptVersion: number;
  promptHash: string;
  /** JSON schema sent for structured output (null in text mode). */
  outputSchema: Record<string, unknown> | null;
  /** Request body without the per-text message: the part shared by every request. */
  requestBase: Record<string, unknown>;
}

export interface Run {
  id: string;
  studyId: string;
  number: number; // 1, 2, 3 … within the study
  label: string;
  createdAt: string;
  finishedAt: string | null;
  mode: 'sync' | 'batch';
  scope: string; // human-readable description, e.g. "Random sample of 10"
  docIds: string[]; // internal doc ids included
  status: RunStatus;
  snapshot: RunSnapshot;
  batch: null | {
    provider: ProviderId;
    batchId: string;
    inputFileId?: string;
    /** custom_id -> [docInternalId, replicate] */
    map: Record<string, [string, number]>;
    lastStatus: string;
    lastCheckedAt: string | null;
  };
  error: string | null;
  /** Failed requests re-sent within this run (same frozen settings, always as immediate requests). */
  retries?: { at: string; requests: number }[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface Result {
  id: string; // `${runId}:${docId}:${replicate}`
  runId: string;
  studyId: string;
  docId: string; // internal doc id
  replicate: number; // 1-based
  status: 'ok' | 'error';
  /** Parsed field values (structured mode) or { response } (text mode). */
  values: Record<string, string>;
  rationale: string;
  reasoningSummary: string;
  rawText: string;
  parseError: string | null;
  error: string | null;
  usage: Usage;
  latencyMs: number | null;
  requestedAt: string;
  completedAt: string;
  responseId: string;
  modelReported: string;
  stopReason: string;
}

/** Heavy per-result data, loaded on demand. */
export interface ResultLog {
  id: string; // same as Result.id
  runId: string;
  studyId: string;
  /** The per-text part of the request (messages / input). Combine with run.snapshot.requestBase. */
  requestPart: Record<string, unknown>;
  response: unknown;
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  effort: 'medium',
  reasoningSummary: false,
  temperature: null,
  maxOutputTokens: 16000,
};

export const DEFAULT_RUN_OPTIONS: RunOptions = {
  caching: true,
  cacheTtl: '5m',
  batch: false,
  replicates: 1,
  concurrency: 4,
};

export const DEFAULT_PROMPT: PromptSpec = {
  system: '',
  userTemplate: '',
  outputMode: 'structured',
  variables: [{ name: 'label', type: 'category', values: [], description: '' }],
  includeRationale: true,
};
