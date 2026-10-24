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
  /** What is annotated: texts (absent), or entries (people, works, …) from the model's own knowledge, each
   *  described by a few columns. Chosen when the study is created; entries are added in <entry> tags. */
  subject?: 'entries';
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
  /** Set while a backup is being imported into this study; a study still marked is a partial import. */
  importIncomplete?: boolean;
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
    /** The first batch (the only one in runs made before runs could hold several). */
    batchId: string;
    inputFileId?: string;
    /** custom_id -> [docInternalId, replicate], for every batch of the run */
    map: Record<string, [string, number]>;
    lastStatus: string;
    lastCheckedAt: string | null;
    /** Every batch of the run: a run too large for one batch is sent as several, and failed requests of a
     *  batch run are re-sent as further batches. Missing in older runs (see `batchParts`). */
    parts?: BatchPart[];
    /** Set while a batch of this run is being uploaded (when it began, and its number of requests): if the page
     *  closes meanwhile, whether the provider received that batch is unknown. */
    uploading?: UploadAttempt;
    /** An upload whose outcome is unknown (connection lost, or the page closed during it): sending the same
     *  requests again could start a second, paid batch, so it is looked for at the provider first. */
    uploadUnknown?: UploadAttempt;
  };
  error: string | null;
  /** While a retry is being sent (status "running"): the run's status and error before it, restored if the page
   *  is closed meanwhile. */
  resumeStatus?: RunStatus;
  resumeError?: string | null;
  /** Failed requests re-sent within this run (same frozen settings). `asBatch`: re-sent as a new batch
   *  (batch runs from October 2026 on; earlier retries were always individual requests). `requests`: those
   *  actually sent (runs before October 22, 2026: those planned, even if a retry was stopped early).
   *  `counted: 'sent'`: written by a version that counts the requests sent (from October 23, 2026); an entry
   *  without it in a run of the published version (bare appVersion such as "0.1.0") holds the planned count.
   *  `interrupted`: the page closed while this retry was being sent, so `requests` counts those answered (a few
   *  more, at most the concurrency, may have gone out without an answer being recorded; kept with 0 too).
   *  `unanswered`: of the requests sent, those stopped before their answer was stored (Cancel, or a result that
   *  could not be saved; from October 23, 2026): sent, so counted, but their token use (if any) is not known. */
  retries?: { at: string; requests: number; asBatch?: boolean; counted?: 'sent'; interrupted?: boolean; unanswered?: number }[];
  /** Failed attempts replaced by a retry (from October 22, 2026): their number and token use, which the
   *  results no longer show (their logs are kept, see ResultLog.attempt). */
  replaced?: { requests: number; usage: Usage };
}

export interface UploadAttempt {
  since: string;
  requests: number;
  /** OpenAI: the uploaded input file (recorded as soon as the file has arrived, before the batch is started). */
  inputFileId?: string;
  /** The upload was a "Retry failed" (when that retry began), so a batch found later is recorded as that retry. */
  retryAt?: string;
  /** The batch is created with metadata naming this run and upload (OpenAI, from October 23, 2026): it is found
   *  by that or by its input file, never by its number of requests alone. */
  labelled?: boolean;
  /** The run's finish time before the upload (restored if the upload is cut off). */
  finishedBefore?: string | null;
  /** When the upload got no answer, if that happened while the page was open: a batch it created was created before
   *  then, so a later lookup by request count leaves out batches created afterwards. */
  endedAt?: string;
  /** A retry's upload: the run's earlier upload of unknown outcome it was sent after (the same requests; with its own
   *  `retryAt` when that one was a retry's too). A batch found by its number of requests that may have been created
   *  before the retry began may be that one's: it is recorded as either's (`BatchPart.eitherRetry`), not as this
   *  retry's (from October 24, 2026). */
  earlier?: Pick<UploadAttempt, 'since' | 'requests' | 'endedAt' | 'retryAt'>;
}

export interface BatchPart {
  batchId: string;
  inputFileId?: string;
  status: 'submitted' | 'collected' | 'failed';
  lastStatus: string;
  error?: string;
  /** When it was sent (older runs: the run's start). */
  submittedAt?: string;
  /** When the provider finished it (results collected from October 22, 2026 on). */
  endedAt?: string;
  /** Its results arrived but could not be stored (e.g. the browser's storage is full): not fetched again until
   *  the owner checks the run by hand. */
  saveFailed?: string;
  /** With `saveFailed`: its results were stored, only the run's record of them could not be saved. */
  resultsSaved?: boolean;
  /** Found by its number of requests for a retry's upload of unknown outcome, while an earlier upload of the same
   *  requests was unknown too, so it is either's: recorded as the earlier one's (`submittedAt`). Its answers' request
   *  names tell which it is: counted as that retry (begun at `at`, its upload at `since`) if they carry the retry's
   *  names, as the retry that made the earlier upload (begun at `earlierAt`, when it was a retry's) if they carry
   *  that one's, else as neither. */
  eitherRetry?: { at: string; since: string; earlierAt?: string };
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
  /** How many times this request was sent (absent = 1); earlier attempts' logs are kept as `${id}#${n}`. */
  attempt?: number;
  /** The token use of those earlier, replaced attempts (paid for too), kept with the result so it can't get lost. */
  replacedUsage?: Usage;
  /** When each of those attempts was sent, oldest first (attempts replaced from October 23, 2026 on; an attempt
   *  replaced before then is only in its log), so a retry's requests can be counted after a later retry replaced them. */
  replacedAt?: string[];
}

/** Heavy per-result data, loaded on demand. */
export interface ResultLog {
  id: string; // same as Result.id; `${Result.id}#${attempt}` for an earlier attempt replaced by a retry
  runId: string;
  studyId: string;
  /** The per-text part of the request (messages / input). Combine with run.snapshot.requestBase. */
  requestPart: Record<string, unknown>;
  response: unknown;
  /** An earlier, failed attempt that a retry replaced: which attempt it was, and its outcome. */
  attempt?: number;
  /** Settings of the run that were not sent with this request (the retired `fallbacks` of day-one runs). */
  omitted?: string[];
  replaced?: Pick<Result, 'status' | 'error' | 'parseError' | 'stopReason' | 'usage' | 'requestedAt' | 'completedAt'>;
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
