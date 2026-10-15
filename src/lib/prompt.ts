import type { Doc, PromptSpec, Variable } from './types';

export const RATIONALE_KEY = 'rationale';
export const TEXT_RESPONSE_KEY = 'response';

// Names may use any letter (e.g. {{meta.køn}}), like Python's \w in the exported script.
const PLACEHOLDER = /\{\{\s*([\p{L}\p{N}_.\- ]+?)\s*\}\}/gu;
/** Anything written as {{...}}, whether or not it is a valid placeholder. */
const ANY_BRACES = /\{\{([^{}]*)\}\}/gu;

/** Appended to a prompt that doesn't say where the text goes. The tags mark where the text starts and ends. */
export const TEXT_SUFFIX = '\n\n<text>\n{{text}}\n</text>';

/** The prompt as actually sent: if it has no {{text}} marker, each text is added at the end. */
export function effectiveTemplate(prompt: string): string {
  if (templatePlaceholders(prompt).includes('text')) return prompt;
  const base = prompt.trimEnd();
  return base ? base + TEXT_SUFFIX : '{{text}}';
}

export interface MessageParts {
  /** Everything before the first placeholder: identical for every text, so it can be cached. */
  prefix: string;
  /** The rest, with placeholders filled in for this text. */
  rest: string;
}

/** Split the prompt at its first placeholder and fill in the text. Mirrored exactly by the exported Python script. */
export function renderMessageParts(prompt: string, doc: Pick<Doc, 'docId' | 'text' | 'meta'>): MessageParts {
  const t = effectiveTemplate(prompt);
  const m = new RegExp(PLACEHOLDER.source, 'u').exec(t);
  const idx = m ? m.index : t.length;
  return { prefix: t.slice(0, idx), rest: fillPlaceholders(t.slice(idx), doc) };
}

export function renderMessage(prompt: string, doc: Pick<Doc, 'docId' | 'text' | 'meta'>): string {
  const { prefix, rest } = renderMessageParts(prompt, doc);
  return prefix + rest;
}

/** Substitute {{text}}, {{id}} and {{meta.<column>}}. */
function fillPlaceholders(template: string, doc: Pick<Doc, 'docId' | 'text' | 'meta'>): string {
  return template.replace(PLACEHOLDER, (whole, key: string) => {
    if (key === 'text') return doc.text;
    if (key === 'id') return doc.docId;
    if (key.startsWith('meta.')) {
      const col = key.slice(5);
      return doc.meta[col] ?? '';
    }
    return whole;
  });
}

export function templatePlaceholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/** {{...}} markers that can't be filled in (e.g. a name with brackets); they are sent as written. */
export function invalidPlaceholders(template: string): string[] {
  const valid = new RegExp(`^${PLACEHOLDER.source}$`, 'u');
  return [...template.matchAll(ANY_BRACES)].map((m) => m[0]).filter((s) => !valid.test(s));
}

/** Machine key from a display name: "Positive score" → "positive_score". */
export function slugKey(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s) return 'field';
  return /^[a-z_]/.test(s) ? s : `f_${s}`;
}

/** Unique key among the other fields' keys (and not the reserved "rationale"). */
export function uniqueKey(label: string, others: string[]): string {
  let key = slugKey(label);
  if (key === RATIONALE_KEY) key = `${key}_field`;
  const base = key;
  for (let n = 2; others.includes(key); n++) key = `${base}_${n}`;
  return key;
}

/** Display name for an output field key. */
export function fieldLabel(p: PromptSpec, key: string): string {
  if (key === RATIONALE_KEY) return 'Rationale';
  const v = p.variables.find((x) => x.name === key);
  return v?.label?.trim() || key;
}

export function validateVariableName(name: string, others: string[]): string | null {
  if (!name) return 'Name is required';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return 'Use letters, digits and _ (no spaces)';
  if (name === RATIONALE_KEY) return '"rationale" is reserved';
  if (others.includes(name)) return 'Duplicate name';
  return null;
}

function variableSchema(v: Variable): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (v.description.trim()) base.description = v.description.trim();
  const values = v.values.map((x) => x.trim()).filter(Boolean);
  switch (v.type) {
    case 'category':
      return values.length ? { ...base, type: 'string', enum: values } : { ...base, type: 'string' };
    case 'ordinal': {
      const nums = values.map(Number).filter((n) => Number.isInteger(n));
      return nums.length ? { ...base, type: 'integer', enum: nums } : { ...base, type: 'integer' };
    }
    case 'number':
      return { ...base, type: 'number' };
    case 'boolean':
      return { ...base, type: 'boolean' };
    case 'text':
      return { ...base, type: 'string' };
  }
}

/** JSON schema for structured output. The rationale (if any) comes first so the model reasons before labelling. */
export function buildOutputSchema(p: PromptSpec): Record<string, unknown> | null {
  if (p.outputMode !== 'structured') return null;
  const properties: Record<string, unknown> = {};
  if (p.includeRationale) {
    properties[RATIONALE_KEY] = {
      type: 'string',
      description: 'Brief justification for the annotation, citing the text where relevant.',
    };
  }
  for (const v of p.variables) properties[v.name] = variableSchema(v);
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

export function isYesNoField(p: PromptSpec, key: string): boolean {
  return p.variables.find((v) => v.name === key)?.type === 'boolean';
}

/**
 * Field names the results table and exports show, in order. This is the display order, separate from
 * the order the model writes in (`buildOutputSchema` follows the field list): a field named
 * "<score>_explanation" (or "_reasoning") is shown right after the field "<score>", wherever it sits in the list.
 */
export function outputFields(p: PromptSpec): string[] {
  if (p.outputMode !== 'structured') return [TEXT_RESPONSE_KEY];
  const names = p.variables.map((v) => v.name);
  const scoreOf = new Map<string, string>();
  for (const n of names) {
    for (const suffix of ['_explanation', '_reasoning']) {
      const base = n.endsWith(suffix) ? n.slice(0, -suffix.length) : '';
      if (base && names.includes(base)) scoreOf.set(n, base);
    }
  }
  // An explanation of an explanation is just a field: only pair explanations with fields that are not explanations themselves.
  for (const [n, base] of [...scoreOf]) if (scoreOf.has(base)) scoreOf.delete(n);
  const out: string[] = [];
  for (const n of names) {
    if (scoreOf.has(n)) continue;
    out.push(n);
    for (const m of names) if (scoreOf.get(m) === n) out.push(m);
  }
  return out;
}

function stripFences(s: string): string {
  const m = s.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : s.trim();
}

export function valueToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export interface ParsedOutput {
  values: Record<string, string>;
  rationale: string;
  parseError: string | null;
}

export function parseModelOutput(rawText: string, p: PromptSpec): ParsedOutput {
  if (p.outputMode === 'text') {
    // A JSON answer is split into columns in the exports; if it can't be read, those columns would be
    // silently empty, so it counts as failed. Answers without JSON (plain prose) are fine.
    const unreadable = rawText.includes('{') && !flattenJsonResponse(rawText);
    return { values: { [TEXT_RESPONSE_KEY]: rawText.trim() }, rationale: '', parseError: unreadable ? 'Answer contains JSON that could not be read' : null };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(stripFences(rawText));
  } catch {
    return { values: {}, rationale: '', parseError: 'Response was not valid JSON' };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { values: {}, rationale: '', parseError: 'Response was not a JSON object' };
  }
  const rec = obj as Record<string, unknown>;
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const v of p.variables) {
    if (v.name in rec) values[v.name] = valueToString(rec[v.name]);
    else missing.push(v.name);
  }
  return {
    values,
    rationale: valueToString(rec[RATIONALE_KEY]),
    parseError: missing.length ? `Missing field(s): ${missing.join(', ')}` : null,
  };
}

/**
 * For free-text runs whose answer happens to be a JSON object: one column per leaf, nested keys joined
 * with "_" (e.g. race_ethnicity_negative). Returns null when the answer is not a JSON object.
 */
export function flattenJsonResponse(raw: string | undefined): Record<string, string> | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(stripFences(raw));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out: Record<string, string> = {};
  const walk = (v: unknown, key: string) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, key ? `${key}_${k}` : k);
    } else out[key] = valueToString(v);
  };
  walk(obj, '');
  return out;
}

/**
 * Keys holding the model's written justification in JSON answers: "explanation" (preferred: Anthropic
 * models may refuse JSON output fields named "reasoning") or, in older prompts, "reasoning".
 */
export function isExplanationKey(k: string): boolean {
  return k === 'explanation' || k === 'reasoning' || k.endsWith('_explanation') || k.endsWith('_reasoning');
}

/** Canonical form for comparing labels across sources (gold columns, runs).
 *  For yes/no fields (`yesNo`), 1 and 0 also count as yes and no. */
export function normalizeLabel(v: string | undefined, yesNo = false): string {
  if (v === undefined) return '';
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === 'yes' || (yesNo && s === '1')) return 'true';
  if (s === 'false' || s === 'no' || (yesNo && s === '0')) return 'false';
  if (s !== '' && !Number.isNaN(Number(s))) return String(Number(s));
  return s;
}
