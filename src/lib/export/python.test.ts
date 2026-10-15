import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { anthropicAdapter } from '../providers/anthropic';
import { openaiAdapter } from '../providers/openai';
import { buildOutputSchema, renderUserMessage } from '../prompt';
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

const prompt: PromptSpec = {
  system: TRICKY,
  userTemplate: 'ID {{id}} ({{meta.year}}):\n{{text}}',
  outputMode: 'structured',
  variables: [
    { name: 'stance', type: 'category', values: ['for', 'against'], description: 'Stance "towards" X' },
    { name: 'score', type: 'ordinal', values: ['0', '1', '2'], description: '' },
    { name: 'flag', type: 'boolean', values: [], description: '' },
  ],
  includeRationale: true,
};

function makeRun(provider: ProviderId): { study: Study; run: Run } {
  const model = {
    ...DEFAULT_MODEL_SETTINGS,
    provider,
    model: provider === 'anthropic' ? 'claude-opus-5-5' : 'gpt-mock-1',
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
  for (const provider of ['anthropic', 'openai'] as const) {
    it(`rebuilds the exact ${provider} request (dry run)`, () => {
      if (!hasPython()) return;
      const { study, run } = makeRun(provider);
      const dir = mkdtempSync(join(tmpdir(), 'annot-'));
      writeFileSync(join(dir, 'annotate.py'), fillScript(SCRIPT_TEMPLATE, scriptValues(study, run, 'now')));
      writeFileSync(join(dir, 'corpus.csv'), 'doc_id,text,year\nd1,"Some text, with ""quotes""\nand a newline",2024\n');
      const out = execFileSync('python3', ['-I', join(dir, 'annotate.py'), join(dir, 'corpus.csv'), '--dry-run']).toString();
      const doc = { docId: 'd1', text: 'Some text, with "quotes"\nand a newline', meta: { year: '2024' } };
      const adapter = provider === 'anthropic' ? anthropicAdapter : openaiAdapter;
      const expected = { ...run.snapshot.requestBase, ...adapter.buildRequestPart(renderUserMessage(prompt.userTemplate, doc)) };
      expect(JSON.parse(out)).toEqual(expected);
    });
  }

  it('template keeps placeholders; filled script has none left', () => {
    const { study, run } = makeRun('anthropic');
    expect(SCRIPT_TEMPLATE).toContain('{{SYSTEM_PROMPT}}');
    const filled = fillScript(SCRIPT_TEMPLATE, scriptValues(study, run, 'now'));
    expect(filled).not.toMatch(/\{\{[A-Z_]+\}\}(?![^\n]*kept as written)/);
  });
});
