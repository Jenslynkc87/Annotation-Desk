import type { Doc, PromptSpec, Variable } from './types';

export const RATIONALE_KEY = 'rationale';
export const TEXT_RESPONSE_KEY = 'response';

const PLACEHOLDER = /\{\{\s*([\w.\- ]+?)\s*\}\}/g;

/** Substitute {{text}}, {{id}} and {{meta.<column>}} in the user template. */
export function renderUserMessage(template: string, doc: Pick<Doc, 'docId' | 'text' | 'meta'>): string {
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

/** Field names the results table shows, in order. */
export function outputFields(p: PromptSpec): string[] {
  return p.outputMode === 'structured' ? p.variables.map((v) => v.name) : [TEXT_RESPONSE_KEY];
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
    return { values: { [TEXT_RESPONSE_KEY]: rawText.trim() }, rationale: '', parseError: null };
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

/** Canonical form for comparing labels across sources (gold columns, runs). */
export function normalizeLabel(v: string | undefined): string {
  if (v === undefined) return '';
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === 'yes') return 'true';
  if (s === 'false' || s === 'no') return 'false';
  if (s !== '' && !Number.isNaN(Number(s))) return String(Number(s));
  return s;
}
