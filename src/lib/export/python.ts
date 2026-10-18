// Generates a standalone Python script that reproduces a run's requests.
// The template marks every study-specific value as {{PLACEHOLDER}}; `fillScript` inserts the values.
import { effectiveTemplate } from '../prompt';
import type { Run, Study } from '../types';

/** Split a run's shared request body into readable parts + the remaining settings. */
export function splitRequestBase(run: Run) {
  const base = structuredClone(run.snapshot.requestBase) as Record<string, unknown>;
  const provider = run.snapshot.model.provider;
  delete base.model;
  let cacheControl: unknown = null;
  if (provider === 'anthropic') {
    const o = run.snapshot.options;
    if (o.caching) cacheControl = o.cacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
    delete base.system;
    const oc = base.output_config as Record<string, unknown> | undefined;
    if (oc) {
      delete oc.format;
      if (!Object.keys(oc).length) delete base.output_config;
    }
  } else {
    if (run.snapshot.options.caching && 'prompt_cache_options' in base) cacheControl = { mode: 'explicit' };
    delete base.instructions;
    const text = base.text as Record<string, unknown> | undefined;
    if (text) {
      delete text.format;
      if (!Object.keys(text).length) delete base.text;
    }
  }
  return { settings: base, cacheControl };
}

/** Python string literal; multi-line strings become readable triple-quoted literals. */
export function pyStr(s: string): string {
  if (!s.includes('\n')) return JSON.stringify(s);
  let body = s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  if (body.endsWith('"')) body = body.slice(0, -1) + '\\"';
  return `"""${body}"""`;
}

/** JSON value -> Python literal (True/False/None), pretty-printed. */
export function pyLiteral(v: unknown, indent = 0): string {
  const pad = '    '.repeat(indent);
  const padIn = '    '.repeat(indent + 1);
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'None';
  if (typeof v === 'string') return pyStr(v);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (v.every((x) => typeof x !== 'object' || x === null)) return `[${v.map((x) => pyLiteral(x)).join(', ')}]`;
    return `[\n${v.map((x) => padIn + pyLiteral(x, indent + 1)).join(',\n')},\n${pad}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return '{}';
  return `{\n${entries.map(([k, x]) => `${padIn}${JSON.stringify(k)}: ${pyLiteral(x, indent + 1)}`).join(',\n')},\n${pad}}`;
}

export const SCRIPT_TEMPLATE = `"""
LLM annotation script exported from Annotation Desk {{APP_VERSION}}.

Study:  {{STUDY_NAME}}
Run:    {{RUN_DESCRIPTION}}

This script reproduces the requests sent in the run above: the same model,
prompt, output schema and request settings. Values marked with {{...}} in
annotate_template.py are inserted from the study.

Usage
-----
    pip install -r requirements.txt
    export {{API_KEY_ENV}}=...            # your own API key
    python annotate.py corpus.csv --id-column doc_id --text-column text

    python annotate.py corpus.csv --dry-run   # print the first request, send nothing

Outputs: results.csv (one row per text x replicate) and log.jsonl (every
request and full response, without the API key).

Note: hosted models can change or be retired, and sampling is not fully
deterministic, so re-running may not reproduce every label exactly. The
original run's logs are the authoritative record.
"""

import argparse
import csv
import datetime as dt
import json
import os
import re
import sys
import time

# ===================== STUDY CONFIGURATION (inserted) =====================

PROVIDER = {{PROVIDER}}  # "anthropic" or "openai"

MODEL = {{MODEL}}

# The prompt sent with each text. {{text}} marks where the text is inserted;
# {{id}} and {{meta.<column>}} insert its id and metadata columns.
PROMPT = {{PROMPT}}

# Optional system prompt, sent unchanged with every request ("" = none).
SYSTEM_PROMPT = {{SYSTEM_PROMPT}}

# JSON schema the response must follow (None = free-text output).
OUTPUT_SCHEMA = {{OUTPUT_SCHEMA}}

# Fields written to results.csv.
FIELDS = {{FIELDS}}

# Remaining request settings, exactly as sent by Annotation Desk
# (token limit, effort / reasoning, thinking, temperature, caching key, ...).
REQUEST_SETTINGS = {{REQUEST_SETTINGS}}

# Prompt caching marker (None = off), applied to the fixed part of the prompt
# before the first {{...}} marker. Anthropic: cache_control; OpenAI (GPT-5.6+): breakpoint.
CACHE_CONTROL = {{CACHE_CONTROL}}

# Number of times each text is annotated.
REPLICATES = {{REPLICATES}}

# ==================== END OF STUDY CONFIGURATION ==========================


PLACEHOLDER = re.compile(r"\\{\\{\\s*([\\w.\\- ]+?)\\s*\\}\\}")


def message_parts(row, doc_id, text):
    """Split PROMPT at its first {{...}} marker: (fixed prefix, rest with values filled in)."""

    def sub(m):
        key = m.group(1)
        if key == "text":
            return text
        if key == "id":
            return doc_id
        if key.startswith("meta."):
            return str(row.get(key[5:], "") or "")
        return m.group(0)

    first = PLACEHOLDER.search(PROMPT)
    idx = first.start() if first else len(PROMPT)
    return PROMPT[:idx], PLACEHOLDER.sub(sub, PROMPT[idx:])


def build_request(prefix, rest):
    body = json.loads(json.dumps(REQUEST_SETTINGS))
    body["model"] = MODEL
    if PROVIDER == "anthropic":
        if SYSTEM_PROMPT.strip():
            if CACHE_CONTROL:
                body["system"] = [{"type": "text", "text": SYSTEM_PROMPT, "cache_control": CACHE_CONTROL}]
            else:
                body["system"] = SYSTEM_PROMPT
        if OUTPUT_SCHEMA is not None:
            body.setdefault("output_config", {})["format"] = {"type": "json_schema", "schema": OUTPUT_SCHEMA}
        if CACHE_CONTROL and prefix.strip() and rest.strip():
            content = [{"type": "text", "text": prefix, "cache_control": CACHE_CONTROL}, {"type": "text", "text": rest}]
        else:
            content = prefix + rest
        body["messages"] = [{"role": "user", "content": content}]
    else:
        if SYSTEM_PROMPT.strip():
            body["instructions"] = SYSTEM_PROMPT
        if OUTPUT_SCHEMA is not None:
            body.setdefault("text", {})["format"] = {
                "type": "json_schema",
                "name": "annotation",
                "schema": OUTPUT_SCHEMA,
                "strict": True,
            }
        if CACHE_CONTROL and prefix.strip() and rest.strip():
            # Explicit caching: only the fixed part of the prompt is written to the cache.
            body["input"] = [{"role": "user", "content": [
                {"type": "input_text", "text": prefix, "prompt_cache_breakpoint": CACHE_CONTROL},
                {"type": "input_text", "text": rest},
            ]}]
        else:
            body["input"] = prefix + rest
    return body


def call_model(client, body):
    """Send one request; return (text, reasoning_summary, model, stop_reason, usage, raw_response)."""
    if PROVIDER == "anthropic":
        body = dict(body)
        # Parameters the SDK has no argument for (e.g. temperature) are sent unchanged in the request body.
        extra = {k: body.pop(k) for k in ("temperature",) if k in body}
        with client.messages.stream(**body, extra_body=extra or None) as stream:
            msg = stream.get_final_message()
        text = "".join(b.text for b in msg.content if b.type == "text")
        thinking = "\\n\\n".join(b.thinking for b in msg.content if b.type == "thinking" and b.thinking)
        u = msg.usage
        usage = {
            "input_tokens": u.input_tokens,
            "output_tokens": u.output_tokens,
            "cache_read_tokens": u.cache_read_input_tokens or 0,
            "cache_write_tokens": u.cache_creation_input_tokens or 0,
        }
        stop = msg.stop_reason or ""
        category = getattr(getattr(msg, "stop_details", None), "category", None)
        if stop == "refusal" and category:
            stop += f" ({category})"
        return text, thinking, msg.model, stop, usage, msg.model_dump()
    resp = client.responses.create(**body)
    text = resp.output_text or ""
    summary = []
    refusal = ""
    for item in resp.output or []:
        if item.type == "reasoning":
            summary += [s.text for s in (item.summary or []) if getattr(s, "text", None)]
        if item.type == "message":
            refusal += "".join(c.refusal for c in item.content if c.type == "refusal")
    u = resp.usage
    details = u.input_tokens_details if u else None
    usage = {
        "input_tokens": u.input_tokens if u else 0,
        "output_tokens": u.output_tokens if u else 0,
        "cache_read_tokens": (getattr(details, "cached_tokens", 0) or 0) if details else 0,
        "cache_write_tokens": (getattr(details, "cache_write_tokens", 0) or 0) if details else 0,
    }
    stop = resp.status or ""
    reason = getattr(resp.incomplete_details, "reason", None) if resp.incomplete_details else None
    if reason:
        stop += f" ({reason})"
    if refusal:
        stop = "refusal: " + refusal
    return text, "\\n\\n".join(summary), resp.model, stop, usage, resp.model_dump()


def as_text(v):
    """Field value as text, written the way Annotation Desk writes it (3.0 -> "3", True -> "true")."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return str(v).lower()
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    return str(v)


def parse_output(text):
    # As in Annotation Desk: a whole answer in a \`\`\`json fence is read without the fence.
    fenced = re.match(r"^\`\`\`(?:json)?\\s*([\\s\\S]*?)\\s*\`\`\`$", text.strip())
    cleaned = fenced.group(1) if fenced else text.strip()
    if OUTPUT_SCHEMA is None:
        # As in Annotation Desk: an answer containing JSON ({"...) that can't be read counts as failed.
        if re.search(r'\\{\\s*"', text):
            try:
                readable = isinstance(json.loads(cleaned), dict)
            except json.JSONDecodeError:
                readable = False
            if not readable:
                return {"response": text.strip()}, "Answer contains JSON that could not be read"
        return {"response": text.strip()}, ""
    try:
        obj = json.loads(cleaned)
    except json.JSONDecodeError:
        return {}, "Response was not valid JSON"
    if not isinstance(obj, dict):
        return {}, "Response was not a JSON object"
    values = {f: as_text(obj.get(f)) for f in FIELDS}
    if "rationale" in obj:
        values["rationale"] = as_text(obj["rationale"])
    missing = [f for f in FIELDS if f not in obj]
    return values, ("Missing field(s): " + ", ".join(missing)) if missing else ""


def make_client():
    if PROVIDER == "anthropic":
        import anthropic

        return anthropic.Anthropic(max_retries=4)
    import openai

    return openai.OpenAI(max_retries=4)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("corpus", help="CSV file with one text per row")
    ap.add_argument("--id-column", default="doc_id")
    ap.add_argument("--text-column", default="text")
    ap.add_argument("--out", default="results.csv")
    ap.add_argument("--log", default="log.jsonl")
    ap.add_argument("--limit", type=int, default=None, help="only annotate the first N texts")
    ap.add_argument("--dry-run", action="store_true", help="print the first request and exit")
    args = ap.parse_args()

    # Long articles: Python's csv module refuses fields over 131,072 characters by default.
    csv.field_size_limit(min(sys.maxsize, 2**31 - 1))
    with open(args.corpus, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if args.limit:
        rows = rows[: args.limit]
    if not rows:
        sys.exit("No rows found in " + args.corpus)
    if args.text_column not in rows[0]:
        sys.exit(f"Column '{args.text_column}' not found. Columns: {', '.join(rows[0].keys())}")

    if args.dry_run:
        r = rows[0]
        print(json.dumps(build_request(*message_parts(r, r.get(args.id_column, "1"), r[args.text_column])), indent=2, ensure_ascii=False))
        return

    client = make_client()
    extra = ["rationale"] if OUTPUT_SCHEMA and "rationale" in OUTPUT_SCHEMA.get("properties", {}) else []
    columns = ["doc_id", "replicate", "status", *FIELDS, *extra, "parse_error", "error", "model_reported",
               "stop_reason", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
               "latency_s", "completed_at"]
    with open(args.out, "w", newline="", encoding="utf-8") as out, open(args.log, "a", encoding="utf-8") as log:
        writer = csv.DictWriter(out, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for i, row in enumerate(rows, 1):
            doc_id = row.get(args.id_column) or str(i)
            prefix, rest = message_parts(row, doc_id, row[args.text_column])
            for rep in range(1, REPLICATES + 1):
                body = build_request(prefix, rest)
                started = time.time()
                record = {"doc_id": doc_id, "replicate": rep}
                try:
                    text, summary, model, stop, usage, raw = call_model(client, body)
                    values, parse_error = parse_output(text)
                    record.update(values)
                    record.update(usage)
                    # As in Annotation Desk: a cut-off, refused, empty or unreadable answer counts as failed.
                    incomplete = stop not in ("", "end_turn", "stop_sequence", "completed")
                    problem = ("Incomplete answer" if text else "Empty response") + f" (stop reason: {stop})"
                    record.update(status="error" if incomplete or parse_error else "ok", parse_error=parse_error,
                                  error=problem if incomplete else "",
                                  model_reported=model, stop_reason=stop)
                    log.write(json.dumps({"doc_id": doc_id, "replicate": rep, "request": body, "response": raw,
                                          "reasoning_summary": summary}, ensure_ascii=False, default=str) + "\\n")
                except Exception as e:  # keep going; failed requests are recorded
                    record.update(status="error", error=str(e))
                    log.write(json.dumps({"doc_id": doc_id, "replicate": rep, "request": body, "error": str(e)},
                                         ensure_ascii=False) + "\\n")
                record["latency_s"] = round(time.time() - started, 2)
                record["completed_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
                writer.writerow(record)
                out.flush()
            print(f"[{i}/{len(rows)}] {doc_id}", file=sys.stderr)


if __name__ == "__main__":
    main()
`;

export function scriptValues(study: Study, run: Run, exportedAt: string): Record<string, string> {
  const { settings, cacheControl } = splitRequestBase(run);
  const p = run.snapshot.prompt;
  const fields = p.outputMode === 'structured' ? p.variables.map((v) => v.name) : ['response'];
  const provider = run.snapshot.model.provider;
  return {
    APP_VERSION: run.snapshot.appVersion,
    STUDY_NAME: study.name.replace(/"""/g, "'''"),
    RUN_DESCRIPTION: `#${run.number}${run.label ? ` (${run.label})` : ''}, started ${run.createdAt}; exported ${exportedAt}`,
    API_KEY_ENV: provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY',
    PROVIDER: JSON.stringify(provider),
    MODEL: JSON.stringify(run.snapshot.model.model),
    PROMPT: pyStr(effectiveTemplate(p.userTemplate, p.subject)),
    SYSTEM_PROMPT: pyStr(p.system),
    OUTPUT_SCHEMA: pyLiteral(run.snapshot.outputSchema),
    FIELDS: pyLiteral(fields),
    REQUEST_SETTINGS: pyLiteral(settings),
    CACHE_CONTROL: pyLiteral(cacheControl),
    REPLICATES: String(run.snapshot.options.replicates),
  };
}

/** Replace only the configuration placeholders; {{text}}/{{id}}/{{meta.x}} inside prompts are left alone. */
export function fillScript(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => (key in values ? values[key] : whole));
}

/** Minimum SDK versions the generated script was tested with (October 2026). */
export function requirementsTxt(run: Run): string {
  const anthropic = run.snapshot.model.provider === 'anthropic';
  return [
    '# Python packages needed by annotate.py. Install with:  pip install -r requirements.txt',
    `# Minimum versions the script was tested with; for exact reproduction, record the versions you used (pip freeze).`,
    anthropic ? 'anthropic>=1.14.0' : 'openai>=3.31.0',
    '',
  ].join('\n');
}
