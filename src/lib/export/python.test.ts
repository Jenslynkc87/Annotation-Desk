import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { anthropicAdapter } from '../providers/anthropic';
import { openaiAdapter } from '../providers/openai';
import { buildOutputSchema, parseModelOutput, renderMessageParts } from '../prompt';
import { DEFAULT_MODEL_SETTINGS, DEFAULT_RUN_OPTIONS, type PromptSpec, type ProviderId, type Run, type Study } from '../types';
import { fillScript, pyStr, SCRIPT_TEMPLATE, scriptValues } from './python';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';

function hasPython(): boolean {
  try {
    execFileSync('python3', ['--version']);
    return true;
  } catch {
    return false;
  }
}

const TRICKY = 'Line one with "quotes" and \'single\' quotes.\nA backslash \\ and \\n literal, a triple """ quote,\nunicode: æøå — 你好 🎉\n{{not_a_placeholder}} and {{MODEL}} kept as written\nends with a quote"';

const promptWithMarkers: PromptSpec = {
  system: TRICKY,
  // A non-English column name comes first, so it also decides where the cached prefix ends.
  userTemplate: TRICKY + '\nKøn: {{meta.køn}}. ID {{id}} ({{meta.year}}):\n{{text}}\nAnswer now.',
  outputMode: 'structured',
  variables: [
    { name: 'stance', type: 'category', values: ['for', 'against'], description: 'Stance "towards" X' },
    { name: 'score', type: 'ordinal', values: ['0', '1', '2'], description: '' },
    { name: 'flag', type: 'boolean', values: [], description: '' },
  ],
  includeRationale: true,
};
// The common case: one prompt, no markers, no system prompt; the text is appended.
const promptPlain: PromptSpec = { ...promptWithMarkers, system: '', userTemplate: TRICKY };

function makeRun(provider: ProviderId, prompt: PromptSpec, openaiModel = 'gpt-mock-1'): { study: Study; run: Run } {
  const model = {
    ...DEFAULT_MODEL_SETTINGS,
    provider,
    model: provider === 'anthropic' ? 'claude-opus-5-5' : openaiModel,
    effort: 'high',
    temperature: provider === 'openai' ? 0.2 : null,
    reasoningSummary: true,
  };
  const options = { ...DEFAULT_RUN_OPTIONS, caching: true, cacheTtl: '1h' as const, replicates: 2 };
  const outputSchema = buildOutputSchema(prompt);
  const adapter = provider === 'anthropic' ? anthropicAdapter : openaiAdapter;
  const requestBase = adapter.buildRequestBase({ model, options, system: prompt.system, outputSchema, promptHash: 'abc123' });
  const study: Study = { id: 's', name: 'Test "study"', description: '', createdAt: '', updatedAt: '', model, options, prompt };
  const run: Run = {
    id: 'r', studyId: 's', number: 1, label: '', createdAt: '2026-01-01T00:00:00Z', finishedAt: null, mode: 'sync', scope: '', docIds: [],
    status: 'completed', batch: null, error: null,
    snapshot: { appVersion: 'test', model, options, prompt, promptVersion: 1, promptHash: 'abc123', outputSchema, requestBase },
  };
  return { study, run };
}

/** A new temporary folder holding the run's annotate.py and a corpus.csv. */
function scriptDir(study: Study, run: Run, corpus = 'doc_id,text\nd1,Some text\n'): string {
  const dir = mkdtempSync(join(tmpdir(), 'annot-'));
  writeFileSync(join(dir, 'annotate.py'), fillScript(SCRIPT_TEMPLATE, scriptValues(study, run, 'now')));
  writeFileSync(join(dir, 'corpus.csv'), corpus);
  return dir;
}

/** Runs the script with the model's answers given as [answer, stop reason], one text each: results.csv rows (as read
 *  by Python's csv module), the raw file and the log lines. */
function runWithAnswers(study: Study, run: Run, answers: [string, string][]) {
  run.snapshot.options = { ...run.snapshot.options, replicates: 1 };
  const dir = scriptDir(study, run, 'doc_id,text\n' + answers.map((_, i) => `d${i + 1},Text ${i + 1}\n`).join(''));
  const [out, log] = [join(dir, 'results.csv'), join(dir, 'log.jsonl')];
  const code = [
    'import sys, csv, json, importlib.util',
    'spec = importlib.util.spec_from_file_location("annotate", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'corpus, out, log, answers = sys.argv[2], sys.argv[3], sys.argv[4], json.loads(sys.argv[5])',
    'm.make_client = lambda: None',
    'm.call_model = lambda client, body: (lambda text, stop: (text, "", "claude", stop, {}, {}))(*answers.pop(0))',
    'sys.argv = ["annotate.py", corpus, "--out", out, "--log", log]',
    'm.main()',
    'with open(out, newline="", encoding="utf-8-sig") as f:',
    '    print(json.dumps(list(csv.DictReader(f))))',
  ].join('\n');
  const rows = JSON.parse(execFileSync('python3', ['-I', '-c', code, join(dir, 'annotate.py'), join(dir, 'corpus.csv'), out, log, JSON.stringify(answers)], { stdio: 'pipe' }).toString());
  return { rows: rows as Record<string, string>[], raw: readFileSync(out), log: readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}

describe('pyStr', () => {
  it('produces literals Python reads back exactly', () => {
    if (!hasPython()) return;
    for (const s of [TRICKY, 'plain', '', 'a"', '"""', 'x\\', 'multi\nline\\']) {
      const out = execFileSync('python3', ['-I', '-c', `import sys, json; sys.stdout.write(json.dumps(${pyStr(s)}))`]).toString();
      expect(JSON.parse(out)).toBe(s);
    }
  });
});

describe('exported script', () => {
  for (const [label, prompt] of [['with markers', promptWithMarkers], ['plain prompt', promptPlain]] as const)
  for (const provider of ['anthropic', 'openai'] as const) {
    it(`rebuilds the exact ${provider} request, ${label} (dry run)`, () => {
      if (!hasPython()) return;
      const { study, run } = makeRun(provider, prompt);
      const dir = mkdtempSync(join(tmpdir(), 'annot-'));
      writeFileSync(join(dir, 'annotate.py'), fillScript(SCRIPT_TEMPLATE, scriptValues(study, run, 'now')));
      writeFileSync(join(dir, 'corpus.csv'), 'doc_id,text,year,køn\nd1,"Some text, with ""quotes""\nand a newline",2024,kvinde\n');
      const out = execFileSync('python3', ['-I', join(dir, 'annotate.py'), join(dir, 'corpus.csv'), '--dry-run']).toString();
      const doc = { docId: 'd1', text: 'Some text, with "quotes"\nand a newline', meta: { year: '2024', køn: 'kvinde' } };
      const adapter = provider === 'anthropic' ? anthropicAdapter : openaiAdapter;
      const expected = { ...run.snapshot.requestBase, ...adapter.buildRequestPart(renderMessageParts(prompt.userTemplate, doc), run.snapshot.options, run.snapshot.model.model) };
      expect(JSON.parse(out)).toEqual(expected);
    });
  }

  for (const caching of [true, false])
    it(`rebuilds the exact GPT-6 request with explicit caching ${caching ? 'on' : 'off'}`, () => {
      if (!hasPython()) return;
      const { study, run } = makeRun('openai', promptPlain, 'gpt-6.1-sol');
      run.snapshot.options.caching = caching;
      run.snapshot.requestBase = openaiAdapter.buildRequestBase({ model: run.snapshot.model, options: run.snapshot.options, system: '', outputSchema: run.snapshot.outputSchema, promptHash: 'h' });
      const dir = mkdtempSync(join(tmpdir(), 'annot-'));
      writeFileSync(join(dir, 'annotate.py'), fillScript(SCRIPT_TEMPLATE, scriptValues(study, run, 'now')));
      writeFileSync(join(dir, 'corpus.csv'), 'doc_id,text,year\nd1,"Some text",2024\n');
      const out = JSON.parse(execFileSync('python3', ['-I', join(dir, 'annotate.py'), join(dir, 'corpus.csv'), '--dry-run']).toString());
      const doc = { docId: 'd1', text: 'Some text', meta: { year: '2024' } };
      const expected = { ...run.snapshot.requestBase, ...openaiAdapter.buildRequestPart(renderMessageParts(promptPlain.userTemplate, doc), run.snapshot.options, 'gpt-6.1-sol') };
      expect(out).toEqual(expected);
      expect(out.prompt_cache_options).toEqual({ mode: 'explicit' });
      // On: one breakpoint after the fixed prompt only. Off: plain string, nothing to cache.
      if (caching) expect(out.input[0].content.filter((c: Record<string, unknown>) => c.prompt_cache_breakpoint).length).toBe(1);
      else expect(typeof out.input).toBe('string');
    });

  it('reads texts longer than the csv module allows by default (dry run)', () => {
    if (!hasPython()) return;
    const { study, run } = makeRun('anthropic', promptPlain);
    const dir = mkdtempSync(join(tmpdir(), 'annot-'));
    writeFileSync(join(dir, 'annotate.py'), fillScript(SCRIPT_TEMPLATE, scriptValues(study, run, 'now')));
    const long = 'word '.repeat(40_000); // 200,000 characters
    writeFileSync(join(dir, 'corpus.csv'), `doc_id,text\nd1,${long}\n`);
    const out = JSON.parse(execFileSync('python3', ['-I', join(dir, 'annotate.py'), join(dir, 'corpus.csv'), '--dry-run'], { maxBuffer: 1 << 26 }).toString());
    expect(JSON.stringify(out)).toContain(long.trim());
  });

  it('judges plain-text answers with JSON as the app does', () => {
    if (!hasPython()) return;
    const { study, run } = makeRun('anthropic', { ...promptPlain, outputMode: 'text' });
    const dir = mkdtempSync(join(tmpdir(), 'annot-'));
    writeFileSync(join(dir, 'annotate.py'), fillScript(SCRIPT_TEMPLATE, scriptValues(study, run, 'now')));
    const answers = ['{"a": 1}', 'Here it is:\n```json\n{"a": 1}\n```', 'Answer: {"a": 1} done', '{"a": 1', 'Plain prose with {braces}', 'No JSON at all', '```json\n{"a": 1}\n```', '```json\n{"a": 1}',
      // The browser's JSON reader refuses NaN and Infinity (Python's accepts them) and trims a byte-order mark first.
      '{"a": NaN}', '{"a": -Infinity}', '﻿{"a": 1}', '﻿```json\n{"a": 1}\n```',
      // A byte-order mark just inside the fence: the browser's \s takes it, Python's doesn't.
      '```json\n﻿{"a": 1}\n```', '```json\n{"a": 1}﻿\n```'];
    const code = `import sys, json, runpy\nns = runpy.run_path(sys.argv[1], run_name="x")\nprint(json.dumps([ns["parse_output"](t)[1] for t in json.loads(sys.argv[2])]))`;
    const errors = JSON.parse(execFileSync('python3', ['-I', '-c', code, join(dir, 'annotate.py'), JSON.stringify(answers)]).toString());
    const p = run.snapshot.prompt;
    expect(errors).toEqual(answers.map((t) => parseModelOutput(t, p).parseError ?? ''));
    const unreadable = 'Answer contains JSON that could not be read';
    expect(errors).toEqual(['', unreadable, unreadable, unreadable, '', '', '', unreadable, unreadable, unreadable, '', '', '', '']);
  });

  it('counts answers as failed as the app does: cut off, refused, empty or unreadable', () => {
    if (!hasPython()) return;
    // [answer, stop reason] -> [status, parse_error, error], by the rules of the app's makeResult.
    const structured: [[string, string], [string, string, string]][] = [
      [['{"rationale": "why", "stance": "for", "score": 2, "flag": true}', 'end_turn'], ['ok', '', '']],
      [['{"rationale": "wh', 'max_tokens'], ['error', '', 'Incomplete answer (stop reason: max_tokens)']],
      [['', 'refusal (cyber)'], ['error', '', 'Empty response (stop reason: refusal (cyber))']],
      [['I can’t help with that.', 'refusal: I can’t help with that.'], ['error', '', 'Incomplete answer (stop reason: refusal: I can’t help with that.)']],
      [[' \n', 'end_turn'], ['error', '', 'Empty response (stop reason: end_turn)']],
      [['', ''], ['error', '', 'Empty response (stop reason: none)']],
      [['Sorry, no.', 'end_turn'], ['error', 'Response was not valid JSON', '']],
      [['{"rationale": "x", "stance": "for", "score": NaN, "flag": true}', 'end_turn'], ['error', 'Response was not valid JSON', '']],
      [['﻿{"rationale": "x", "stance": "for", "score": 1, "flag": false}', 'stop_sequence'], ['ok', '', '']],
      [['```json\n﻿{"rationale": "x", "stance": "against", "score": 0, "flag": true}\n```', 'end_turn'], ['ok', '', '']],
      [['{"stance": "for"}', 'completed'], ['error', 'Missing field(s): score, flag', '']],
    ];
    const text: [[string, string], [string, string, string]][] = [
      [['  The tone is negative.\n', 'end_turn'], ['ok', '', '']],
      [['', 'end_turn'], ['error', '', 'Empty response (stop reason: end_turn)']],
      [['{"tone": -2', 'end_turn'], ['error', 'Answer contains JSON that could not be read', '']],
      [['{"tone": -2', 'max_tokens'], ['error', '', 'Incomplete answer (stop reason: max_tokens)']],
      [['{"tone": NaN}', 'completed'], ['error', 'Answer contains JSON that could not be read', '']],
      [['The tone is', 'incomplete (max_output_tokens)'], ['error', '', 'Incomplete answer (stop reason: incomplete (max_output_tokens))']],
    ];
    for (const [prompt, cases] of [[promptPlain, structured], [{ ...promptPlain, outputMode: 'text' as const }, text]] as const) {
      const { study, run } = makeRun('anthropic', prompt);
      const { rows, raw, log } = runWithAnswers(study, run, cases.map((c) => c[0]));
      expect(rows.map((r) => [r.status, r.parse_error, r.error])).toEqual(cases.map((c) => c[1]));
      for (const [i, [[answer, stop]]] of cases.entries()) {
        const parsed = parseModelOutput(answer, prompt);
        // The labels are read as the app reads them (also from answers that count as failed).
        for (const [k, v] of Object.entries(parsed.values)) expect(rows[i][k]).toBe(v);
        if (answer.trim() && ['end_turn', 'stop_sequence', 'completed'].includes(stop)) expect(rows[i].parse_error).toBe(parsed.parseError ?? '');
      }
      // results.csv has a byte-order mark, as the app's CSVs do, so Excel reads æøå correctly.
      expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      // Each log line says when the answer came, as the results do.
      expect(log.map((l) => [l.doc_id, l.completed_at])).toEqual(rows.map((r) => [r.doc_id, r.completed_at]));
      expect(rows[0].completed_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    }
  });

  it('prints the dry run as UTF-8 when the console uses another code page (Windows, output sent to a file)', () => {
    if (!hasPython()) return;
    const { study, run } = makeRun('anthropic', { ...promptPlain, userTemplate: 'Tone from very negative (−3) to very positive (3).' });
    const dir = scriptDir(study, run);
    // As on Windows when the output is redirected: stdout in the ANSI code page, which has no minus sign "−".
    const code = 'import io, sys, runpy\nsys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="cp1252")\nsys.argv = [sys.argv[1], sys.argv[2], "--dry-run"]\nrunpy.run_path(sys.argv[0], run_name="__main__")';
    const out = execFileSync('python3', ['-I', '-c', code, join(dir, 'annotate.py'), join(dir, 'corpus.csv')], { stdio: 'pipe' }).toString('utf8');
    expect(JSON.stringify(JSON.parse(out))).toContain('(−3)');
  });

  it('gives the OpenAI client the same 30-minute timeout as the app', () => {
    if (!hasPython()) return;
    const { study, run } = makeRun('openai', promptPlain);
    const dir = scriptDir(study, run);
    // A stand-in for the openai package that records how the client is made.
    mkdirSync(join(dir, 'fake', 'openai'), { recursive: true });
    writeFileSync(join(dir, 'fake', 'openai', '__init__.py'), 'class OpenAI:\n    def __init__(self, **kw):\n        self.kw = kw\n');
    const code = 'import sys, json, runpy\nsys.path.insert(0, sys.argv[2])\nns = runpy.run_path(sys.argv[1], run_name="x")\nprint(json.dumps(ns["make_client"]().kw))';
    const kw = JSON.parse(execFileSync('python3', ['-I', '-c', code, join(dir, 'annotate.py'), join(dir, 'fake')]).toString());
    expect(kw).toEqual({ max_retries: 4, timeout: 1_800_000 / 1000 });
  });

  it('leaves out the retired refusal fallback of old Anthropic runs, and says so', () => {
    if (!hasPython()) return;
    const { study, run } = makeRun('anthropic', promptPlain);
    const plain = fillScript(SCRIPT_TEMPLATE, scriptValues(study, run, 'now'));
    const sent = { ...run.snapshot.requestBase };
    run.snapshot.requestBase = { ...sent, fallbacks: 'default' }; // as frozen in runs of the first version
    const dir = scriptDir(study, run);
    const out = JSON.parse(execFileSync('python3', ['-I', join(dir, 'annotate.py'), join(dir, 'corpus.csv'), '--dry-run']).toString());
    const doc = { docId: 'd1', text: 'Some text', meta: {} };
    expect(out).toEqual({ ...sent, ...anthropicAdapter.buildRequestPart(renderMessageParts(promptPlain.userTemplate, doc), run.snapshot.options, run.snapshot.model.model) });
    const note = "The original run used Anthropic's refusal fallback (a beta feature since\n        removed), which this script does not reproduce.";
    expect(readFileSync(join(dir, 'annotate.py'), 'utf8')).toContain(note);
    expect(plain).not.toContain('refusal fallback');
  });

  it('names the version that exported the script and, if different, the one that made the run', () => {
    const { study, run } = makeRun('anthropic', promptPlain);
    run.snapshot.appVersion = __APP_VERSION__;
    const same = fillScript(SCRIPT_TEMPLATE, scriptValues(study, run, 'now'));
    expect(same).toContain(`exported from Annotation Desk ${__APP_VERSION__}.\n`);
    expect(same).toContain('started 2026-01-01T00:00:00Z; exported now');
    run.snapshot.appVersion = '0.0.9';
    const older = fillScript(SCRIPT_TEMPLATE, scriptValues(study, run, 'now'));
    expect(older).toContain(`exported from Annotation Desk ${__APP_VERSION__}.\n`);
    expect(older).toContain('started 2026-01-01T00:00:00Z with Annotation Desk 0.0.9; exported now');
    // No resume: the usage text says what a new run does to earlier output.
    expect(older).toContain('Each run starts from the\nfirst row and overwrites --out');
  });

  it('rebuilds the exact request for an entry (model-knowledge study)', () => {
    if (!hasPython()) return;
    const prompt = { ...promptPlain, subject: 'entries' as const };
    const { study, run } = makeRun('anthropic', prompt);
    const dir = mkdtempSync(join(tmpdir(), 'annot-'));
    writeFileSync(join(dir, 'annotate.py'), fillScript(SCRIPT_TEMPLATE, scriptValues(study, run, 'now')));
    writeFileSync(join(dir, 'corpus.csv'), 'doc_id,text\nNiels Bohr,"name: Niels Bohr\nborn: 1885"\n');
    const out = JSON.parse(execFileSync('python3', ['-I', join(dir, 'annotate.py'), join(dir, 'corpus.csv'), '--dry-run']).toString());
    const doc = { docId: 'Niels Bohr', text: 'name: Niels Bohr\nborn: 1885', meta: {} };
    expect(out).toEqual({ ...run.snapshot.requestBase, ...anthropicAdapter.buildRequestPart(renderMessageParts(prompt.userTemplate, doc, 'entries'), run.snapshot.options, run.snapshot.model.model) });
    expect(JSON.stringify(out)).toContain('<entry>');
  });

  it('runs with an odd study name, a field named like its own columns, and a plain source column', () => {
    if (!hasPython()) return;
    const prompt: PromptSpec = {
      ...promptPlain,
      userTemplate: 'Rate {{meta.source}}.',
      variables: [{ name: 'status', type: 'category', values: ['active', 'retired'], description: '' }],
    };
    const { study, run } = makeRun('anthropic', prompt);
    study.name = 'C:\\New """odd"""\nname\\';
    run.label = 'ends with "';
    const dir = mkdtempSync(join(tmpdir(), 'annot-'));
    writeFileSync(join(dir, 'annotate.py'), fillScript(SCRIPT_TEMPLATE, scriptValues(study, run, 'now')));
    // The owner's own CSV: a plain "source" column (corpus.csv from the app would have meta_source).
    writeFileSync(join(dir, 'corpus.csv'), 'doc_id,text,source\na1,Some text,Journal X\n');
    const dry = JSON.parse(execFileSync('python3', ['-I', join(dir, 'annotate.py'), join(dir, 'corpus.csv'), '--dry-run']).toString());
    expect(JSON.stringify(dry)).toContain('"text":"Journal X.');
    const code = [
      'import sys, importlib.util',
      'spec = importlib.util.spec_from_file_location("annotate", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'm.make_client = lambda: None',
      `m.call_model = lambda client, body: ('{"rationale": "why", "status": "retired"}', "", "claude", "end_turn", {}, {})`,
      'sys.argv = ["annotate.py", sys.argv[2], "--out", sys.argv[3], "--log", sys.argv[4]]',
      'm.main()',
    ].join('\n');
    execFileSync('python3', ['-I', '-c', code, join(dir, 'annotate.py'), join(dir, 'corpus.csv'), join(dir, 'out.csv'), join(dir, 'log.jsonl')], { stdio: 'pipe' });
    const [header, first] = readFileSync(join(dir, 'out.csv'), 'utf8').trim().split(/\r?\n/).map((l) => l.split(','));
    const row = Object.fromEntries(header.map((h, i) => [h, first[i]]));
    expect([row.status, row.answer_status, row.rationale]).toEqual(['ok', 'retired', 'why']);
  });

  it('template keeps placeholders; filled script has none left', () => {
    const { study, run } = makeRun('anthropic', promptWithMarkers);
    expect(SCRIPT_TEMPLATE).toContain('{{PROMPT}}');
    const filled = fillScript(SCRIPT_TEMPLATE, scriptValues(study, run, 'now'));
    expect(filled).not.toMatch(/\{\{[A-Z_]+\}\}(?![^\n]*kept as written)/);
  });
});
