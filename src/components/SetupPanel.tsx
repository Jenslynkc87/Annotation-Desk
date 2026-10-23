import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from 'react';
import { invalidPlaceholders, RATIONALE_KEY, renderMessageParts, templatePlaceholders, toNumber, uniqueKey } from '../lib/prompt';
import { FALLBACK_ANTHROPIC_MODELS, rejectsTemperature } from '../lib/providers/anthropic';
import { KNOWN_OPENAI_MODELS, supportsExplicitCaching } from '../lib/providers/openai';
import { effortChoices as effortChoicesFor, pickEffort, PROVIDERS, provider } from '../lib/providers';
import { buildSnapshot, currentStudy, getState, loadModels, updateStudy, useStore } from '../lib/store';
import { samePrompt, upsertSavedPrompt } from '../lib/savedPrompts';
import type { ProviderId, SavedPrompt, Variable, VariableType } from '../lib/types';
import { builtInPrice, PRICES_AS_OF, setPriceOverride, usePriceOverrides } from '../lib/pricing';
import { nowIso, uid } from '../lib/util';
import { isEntries, words } from '../lib/subject';
import { RequestView } from './RequestView';
import { Icon, Menu, Modal, NumberField } from './ui';

const TYPE_LABELS: Record<VariableType, string> = {
  category: 'Category',
  ordinal: 'Ordinal scale',
  number: 'Number',
  boolean: 'Yes / no',
  text: 'Free text',
};

const CUSTOM = '__custom__';

/** Collapsible setup section; open/closed state is remembered per browser. */
function Section({ id, title, summary, children }: { id: string; title: string; summary: ReactNode; children: ReactNode }) {
  const key = `annotation-desk-section-${id}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== 'closed';
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(key, open ? 'closed' : 'open');
    } catch {
      /* ignore */
    }
  };
  return (
    <section className={`setup-section ${open ? 'open' : ''}`}>
      <button className="setup-section-head" onClick={toggle} aria-expanded={open}>
        <span className="setup-section-title">{title}</span>
        {!open && <span className="setup-section-summary">{summary}</span>}
        <span className="chev" aria-hidden>
          <Icon name="chevron" size={14} />
        </span>
      </button>
      {open && <div className="setup-section-body">{children}</div>}
    </section>
  );
}

export function SetupPanel({ onOpenKeys }: { onOpenKeys: () => void }) {
  const study = useStore((s) => currentStudy(s))!;
  const keys = useStore((s) => s.keys);
  const models = useStore((s) => s.models);
  const modelsStatus = useStore((s) => s.modelsStatus);
  const modelsError = useStore((s) => s.modelsError);
  const docs = useStore((s) => s.docs);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [customModel, setCustomModel] = useState(false);
  const priceOverrides = usePriceOverrides();

  const m = study.model;
  const o = study.options;
  const p = study.prompt;
  const w = words(p);
  const adapter = provider(m.provider);
  const hasKey = !!keys[m.provider];

  useEffect(() => {
    if (hasKey && modelsStatus[m.provider] === 'idle') void loadModels(m.provider);
  }, [hasKey, m.provider, modelsStatus]);

  const list = models[m.provider] ?? (m.provider === 'anthropic' ? FALLBACK_ANTHROPIC_MODELS : KNOWN_OPENAI_MODELS);
  const info = list.find((x) => x.id === m.model);
  const showCustom = customModel || !list.length || (!!m.model && !info);
  const effortChoices = effortChoicesFor(m.provider, info);
  const effortLabel = m.provider === 'anthropic' ? 'Effort' : 'Reasoning effort';
  const noTemperature = m.provider === 'anthropic' && rejectsTemperature(m.model);
  const metaColumns = useMemo(() => [...new Set(docs.flatMap((d) => Object.keys(d.meta)))].slice(0, 30), [docs]);
  const allMetaColumns = useMemo(() => new Set(docs.flatMap((d) => Object.keys(d.meta))), [docs]);
  // {{meta.x}} without such a column is filled in empty; any other unknown or malformed {{…}} is sent as written.
  const missingColumns = templatePlaceholders(p.userTemplate).filter((k) => k.startsWith('meta.') && !allMetaColumns.has(k.slice(5)));
  const unknownPlaceholders = [...templatePlaceholders(p.userTemplate).filter((k) => k !== 'text' && k !== 'id' && !k.startsWith('meta.')), ...invalidPlaceholders(p.userTemplate)];

  const ownPrice = priceOverrides[m.model];
  const price = ownPrice ?? builtInPrice(m.model);
  // What is typed in a price box shows as typed; it becomes your own price once it is a number (an emptied box
  // changes nothing, and shows the price again when you leave it).
  const [priceDraft, setPriceDraft] = useState<{ which: 'input' | 'output'; text: string } | null>(null);
  const priceProps = (which: 'input' | 'output') => ({
    value: priceDraft?.which === which ? priceDraft.text : (price?.[which] ?? ''),
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      const text = e.target.value;
      setPriceDraft({ which, text });
      if (text.trim() === '' || !(Number(text) >= 0)) return;
      const cur = price ?? { input: 0, output: 0 };
      setPriceOverride(m.model, { input: cur.input, output: cur.output, [which]: Number(text) });
    },
    onBlur: () => setPriceDraft(null),
  });

  // Keep the settings valid for the chosen model: an effort it supports (medium by default) and no
  // temperature where the model rejects one. The dropdowns then always show what is sent.
  const effortKey = effortChoices.join(',');
  useEffect(() => {
    const effort = pickEffort(m.effort, effortChoices);
    if (effort !== m.effort || (noTemperature && m.temperature !== null)) {
      updateStudy((s) => {
        s.model.effort = effort;
        if (noTemperature) s.model.temperature = null;
      });
    }
  }, [m.effort, effortKey, noTemperature, m.temperature]);

  const setProvider = (id: ProviderId) =>
    updateStudy((s) => {
      if (s.model.provider === id) return;
      s.model.provider = id;
      s.model.model = id === 'anthropic' ? 'claude-opus-5-5' : 'gpt-6.1-sol';
      s.model.effort = 'medium';
    });

  const showPreview = async () => {
    const st = currentStudy(getState())!;
    const snap = await buildSnapshot(st, st.options.batch);
    const doc = getState().docs[0] ?? { docId: 'example', text: `(your ${words(st.prompt).one} appears here)`, meta: {} };
    const part = provider(st.model.provider).buildRequestPart(renderMessageParts(st.prompt.userTemplate, doc, st.prompt.subject), snap.options, st.model.model);
    setPreview({ ...snap.requestBase, ...part });
  };

  const modelSummary = [m.model || 'no model', m.effort ? `${effortLabel.toLowerCase()} ${m.effort}` : null, m.temperature !== null && !noTemperature ? `temp ${m.temperature}` : null]
    .filter(Boolean)
    .join(' · ');
  const outputSummary =
    p.outputMode === 'text' ? 'Plain text' : `${p.variables.length} field${p.variables.length === 1 ? '' : 's'}: ${p.variables.map((v) => v.name).join(', ')}`;
  const runSummary = [`${o.replicates}× per ${w.one}`, o.caching ? 'caching on' : 'caching off'].join(' · ');

  return (
    <div className="card setup-card">
      <div className="card-head card-pad" style={{ paddingBottom: 0 }}>
        <span className="step">01</span>
        <h2>Set up</h2>
        <button className="btn ghost small right" onClick={showPreview} title={`Show the exact request that will be sent for the first ${w.one}`}>
          Preview request
        </button>
      </div>

      <Section id="model" title="Model" summary={modelSummary}>
        <div className="field">
          <span className="label">Provider</span>
          <div className="seg block" role="radiogroup" aria-label="Provider">
            {(Object.keys(PROVIDERS) as ProviderId[]).map((id) => (
              <button key={id} role="radio" aria-checked={m.provider === id} className={m.provider === id ? 'on' : ''} onClick={() => setProvider(id)}>
                {PROVIDERS[id].label}
              </button>
            ))}
          </div>
          {!hasKey && (
            <div className="hint warn">
              No {adapter.label} key yet. <button className="linkbtn" onClick={onOpenKeys}>Add API key</button>
            </div>
          )}
        </div>

        <div className="grid2 model-row">
          <div className="field">
            <label htmlFor="model">Model</label>
            {!showCustom ? (
              <select
                id="model"
                className="select"
                value={m.model}
                onChange={(e) => {
                  if (e.target.value === CUSTOM) setCustomModel(true);
                  else updateStudy((s) => void (s.model.model = e.target.value));
                }}
              >
                {!m.model && <option value="">Choose…</option>}
                {list.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
                <option value={CUSTOM}>Other model id…</option>
              </select>
            ) : (
              <input
                id="model"
                className="input"
                value={m.model}
                autoFocus={customModel}
                placeholder="Model id"
                onChange={(e) => updateStudy((s) => void (s.model.model = e.target.value.trim()))}
              />
            )}
          </div>
          <div className="field">
            <label htmlFor="effort" title="How much the model reasons before answering">
              {effortLabel}
            </label>
            <select
              id="effort"
              className="select"
              value={m.effort}
              disabled={!effortChoices.length}
              onChange={(e) => updateStudy((s) => void (s.model.effort = e.target.value))}
            >
              {!effortChoices.length && <option value="">Not supported by this model</option>}
              {effortChoices.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="hint tight">
          {info?.description ?? (m.model ? <span className="mono">{m.model}</span> : 'Choose a model.')}
          {showCustom && list.length > 0 && (
            <>
              {' '}
              <button className="linkbtn" onClick={() => setCustomModel(false)}>
                Back to the list
              </button>
            </>
          )}
        </div>
        <div className="hint" style={{ marginTop: 4 }}>
          {modelsStatus[m.provider] === 'loading' && 'Loading models from your account…'}
          {modelsStatus[m.provider] === 'error' && <span className="err">{modelsError[m.provider]} </span>}
          {modelsStatus[m.provider] === 'ok' && (
            <>
              {list.length} models on your account ·{' '}
              <button className="linkbtn" onClick={() => loadModels(m.provider)}>
                refresh
              </button>
            </>
          )}
        </div>

        <details className="more">
          <summary>Sampling & limits</summary>
          <div className="more-body">
            <div className="grid2">
              <div className="field">
                <label htmlFor="temp">Temperature</label>
                <input
                  id="temp"
                  className="input"
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  placeholder={noTemperature ? 'Not supported' : 'Model default'}
                  disabled={noTemperature}
                  value={m.temperature ?? ''}
                  onChange={(e) => updateStudy((s) => void (s.model.temperature = e.target.value === '' ? null : Number(e.target.value)))}
                />
              </div>
              <div className="field">
                <label htmlFor="maxtok">Max output tokens</label>
                <NumberField id="maxtok" className="input" min={16} step={256} value={m.maxOutputTokens} onChange={(n) => updateStudy((s) => void (s.model.maxOutputTokens = n))} />
              </div>
            </div>
            <div className="hint tight">
              {noTemperature
                ? 'Current Claude models do not accept a temperature setting, so none is sent.'
                : 'Leave temperature empty unless needed: many reasoning models reject anything but their default.'}
            </div>
            <div className="grid2" style={{ marginTop: 12 }}>
              <div className="field">
                <label htmlFor="conc">Parallel requests</label>
                <NumberField id="conc" className="input" min={1} max={16} value={o.concurrency} disabled={o.batch} onChange={(n) => updateStudy((s) => void (s.options.concurrency = n))} />
              </div>
            </div>
            <div className="hint tight">How many {w.many} are sent at once (not used for batches). Lower it if you hit rate limits.</div>
            <div className="grid2" style={{ marginTop: 12 }}>
              <div className="field">
                <label htmlFor="price-in">Price per million input tokens ($)</label>
                <input id="price-in" className="input" type="number" min="0" step="any" placeholder="Unknown" {...priceProps('input')} />
              </div>
              <div className="field">
                <label htmlFor="price-out">Price per million output tokens ($)</label>
                <input id="price-out" className="input" type="number" min="0" step="any" placeholder="Unknown" {...priceProps('output')} />
              </div>
            </div>
            <div className="hint tight">
              Used only for the cost estimate before a run. Built-in prices are list prices as of {PRICES_AS_OF} and can go out of date; type your own to override
              them.{ownPrice && (
                <>
                  {' '}
                  <button className="linkbtn" onClick={() => setPriceOverride(m.model, null)}>
                    Use built-in
                  </button>
                </>
              )}
            </div>
            <label className="check" style={{ marginTop: 14 }}>
              <input type="checkbox" checked={m.reasoningSummary} onChange={(e) => updateStudy((s) => void (s.model.reasoningSummary = e.target.checked))} />
              <span>
                Record the model's reasoning summary
                <div className="hint">A readable summary of the model's reasoning, saved with each result.</div>
              </span>
            </label>
          </div>
        </details>
      </Section>

      <Section id="prompt" title="Prompt" summary={p.userTemplate.trim() ? `${p.userTemplate.slice(0, 60).replace(/\s+/g, ' ')}…` : p.system.trim() ? 'System prompt only' : 'Empty'}>
        <SavedPrompts />
        <div className="field">
          <label htmlFor="prompt" className="sr-only">
            Prompt
          </label>
          <textarea
            id="prompt"
            className="textarea prompt"
            value={p.userTemplate}
            placeholder={
              isEntries(p)
                ? 'Your instructions, e.g.:\n\nFrom your own knowledge, rate how internationally known this person is (1–3). If you do not know who this is, answer "unknown".'
                : 'Your instructions, e.g.:\n\nClassify the sentiment of the review as positive, negative or neutral.\n- Mixed reviews are neutral.\n- Sarcasm counts as negative.'
            }
            onChange={(e) => updateStudy((s) => void (s.prompt.userTemplate = e.target.value))}
          />
          <div className="hint">
            {isEntries(p)
              ? 'Paste your prompt here. Each entry’s details are added after it automatically, between <entry> tags.'
              : 'Paste your prompt here. Each text from your corpus is added after it automatically.'}
          </div>
          {missingColumns.length > 0 && <div className="hint warn">No such column: {missingColumns.join(', ')} (filled in empty).</div>}
          {unknownPlaceholders.length > 0 && <div className="hint warn">Unknown placeholder(s): {unknownPlaceholders.join(', ')} (sent as written).</div>}
        </div>
        <details className="more" open={!!p.system.trim()}>
          <summary>Advanced</summary>
          <div className="more-body">
            <p className="hint" style={{ marginTop: 0 }}>
              The {w.many} are added between <code>{isEntries(p) ? '<entry>' : '<text>'}</code> tags. To place {isEntries(p) ? 'an entry' : 'a text'} inside your prompt instead (e.g. before a final instruction),
              write <code>{'{{text}}'}</code> at that spot{metaColumns.length > 0 && (
                <>
                  ; <code>{`{{meta.${metaColumns[0]}}}`}</code> inserts a metadata column
                </>
              )}
              .
            </p>
            <label htmlFor="system" className="label" style={{ display: 'block', margin: '10px 0 5px' }}>
              System prompt (optional)
            </label>
            <textarea
              id="system"
              className="textarea"
              rows={4}
              value={p.system}
              placeholder="Rarely needed. Standing instructions sent separately from the prompt, e.g. a role: “You are an expert in educational assessment.”"
              onChange={(e) => updateStudy((s) => void (s.prompt.system = e.target.value))}
            />
            <div className="hint">Sent unchanged with every request, separately from the prompt. Leave empty unless you want to follow a setup that uses one.</div>
          </div>
        </details>
      </Section>

      <Section id="output" title="Output" summary={outputSummary}>
        <div className="field">
          <div className="seg block" role="radiogroup" aria-label="Output format">
            <button role="radio" aria-checked={p.outputMode === 'structured'} className={p.outputMode === 'structured' ? 'on' : ''} onClick={() => updateStudy((s) => void (s.prompt.outputMode = 'structured'))}>
              Structured fields
            </button>
            <button role="radio" aria-checked={p.outputMode === 'text'} className={p.outputMode === 'text' ? 'on' : ''} onClick={() => updateStudy((s) => void (s.prompt.outputMode = 'text'))}>
              Plain text
            </button>
          </div>
          <div className="hint">
            {p.outputMode === 'structured'
              ? 'The model must return exactly these fields, so every result becomes a clean column.'
              : 'The whole reply is stored as one column.'}
          </div>
        </div>
        {p.outputMode === 'structured' && <VariableEditor />}
      </Section>

      <Section id="run" title="Run options" summary={runSummary}>
        <div className="grid2">
          <div className="field">
            <label htmlFor="reps">Annotations per {w.one}</label>
            <NumberField id="reps" className="input" min={1} max={10} value={o.replicates} onChange={(n) => updateStudy((s) => void (s.options.replicates = n))} />
          </div>
        </div>
        <div className="hint tight">{o.replicates > 1 ? `Each ${w.one} is annotated ${o.replicates}×; results show the majority (categories), the median (ordinal scales) or the mean (numbers), and how consistent the repeats were.${p.variables.some((v) => v.type === 'ordinal') && o.replicates % 2 === 0 ? ' Use an odd number so the median of an ordinal scale is a whole number.' : ''}` : 'Use 2 or more to measure how consistent the model is.'}</div>

        <label className="check" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={o.caching} onChange={(e) => updateStudy((s) => void (s.options.caching = e.target.checked))} />
          <span>
            Prompt caching
            <div className="hint">
              {m.provider === 'anthropic'
                ? 'Saves cost when the fixed part of your prompt is long (about 400+ words; more on older models).'
                : supportsExplicitCaching(m.model)
                  ? `Caches only the fixed part of your prompt (not the ${w.many}). Off: nothing is cached or written.`
                  : 'This OpenAI model caches long prompts automatically and it cannot be turned off.'}
            </div>
          </span>
        </label>
        {m.provider === 'openai' && (
          <label className="check" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={o.storeInLogs !== false} onChange={(e) => updateStudy((s) => void (s.options.storeInLogs = e.target.checked))} />
            <span>
              Show requests in OpenAI's logs
              <div className="hint">Lets you inspect them on platform.openai.com. OpenAI keeps stored requests for a limited time; turn off for confidential texts.</div>
            </span>
          </label>
        )}
      </Section>

      {preview && (
        <Modal title={`Request preview (first ${w.one})`} onClose={() => setPreview(null)} wide>
          <p className="hint" style={{ marginTop: 0 }}>
            This exact body is sent to {adapter.label} for each {w.one}. Your API key travels separately in a header and is never stored.
          </p>
          <RequestView request={preview} />
        </Modal>
      )}
    </div>
  );
}

/** Named prompts (text, output mode and fields) kept in the study, so the corpus and run settings stay put while the prompt is switched. */
function SavedPrompts() {
  const study = useStore((s) => currentStudy(s)!);
  const saved = study.savedPrompts ?? [];
  const save = () => {
    const name = window.prompt('Name for this prompt and its fields (e.g. Prompt 3):')?.trim();
    if (!name) return;
    const existing = saved.find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
    if (existing && !confirm(`Replace the saved prompt “${existing.name}” with the current one?`)) return;
    updateStudy((s) => void (s.savedPrompts = upsertSavedPrompt(s.savedPrompts ?? [], name, s.prompt, uid(), nowIso())));
  };
  const load = (sp: SavedPrompt) => {
    const kept = saved.some((x) => samePrompt(x.prompt, study.prompt));
    if (!kept && !confirm(`Replace the current prompt and fields with “${sp.name}”? The current ones are not saved under a name.`)) return;
    // The kind of study (texts or entries) stays as it is.
    updateStudy((s) => void (s.prompt = { ...structuredClone(sp.prompt), subject: s.prompt.subject }));
  };
  const remove = (sp: SavedPrompt) => {
    if (confirm(`Delete the saved prompt “${sp.name}”? Runs already made with it are not affected.`)) updateStudy((s) => void (s.savedPrompts = (s.savedPrompts ?? []).filter((x) => x.id !== sp.id)));
  };
  return (
    <div className="row" style={{ marginBottom: 8 }}>
      <Menu
        align="left"
        button={(t) => (
          <button className="btn small" onClick={t} title="Keep several prompts, each with its own fields, and switch between them">
            Saved prompts <Icon name="chevron" size={12} />
          </button>
        )}
      >
        {(close) => (
          <>
            <button className="menu-item" onClick={() => (close(), save())}>
              Save current prompt and fields…
            </button>
            {saved.length > 0 && <div className="menu-sep" />}
            {saved.map((sp) => (
              <div key={sp.id} className="row" style={{ gap: 0 }}>
                <button className="menu-item" style={{ flex: 1 }} onClick={() => (close(), load(sp))} title="Load this prompt and its fields">
                  {sp.name}
                  {samePrompt(sp.prompt, study.prompt) && <span className="badge" style={{ marginLeft: 'auto' }}>in use</span>}
                </button>
                <button className="btn ghost small icon" title="Delete this saved prompt" aria-label={`Delete saved prompt ${sp.name}`} onClick={() => (close(), remove(sp))}>
                  <Icon name="trash" size={15} />
                </button>
              </div>
            ))}
          </>
        )}
      </Menu>
    </div>
  );
}

function VariableEditor() {
  const p = useStore((s) => currentStudy(s)!.prompt);
  const vars = p.variables;
  const upd = (i: number, f: (v: Variable) => void) => updateStudy((s) => f(s.prompt.variables[i]));

  return (
    <div className="vars">
      {vars.map((v, i) => {
        return (
          <div className="var" key={i}>
            <div className="var-top">
              <input
                className="input"
                value={v.label ?? v.name}
                aria-label="Field name"
                placeholder="Name, e.g. Positive score"
                onChange={(e) =>
                  upd(i, (x) => {
                    x.label = e.target.value;
                    x.name = uniqueKey(e.target.value, vars.filter((_, j) => j !== i).map((o) => o.name));
                  })
                }
              />
              <button
                className="btn ghost small icon move"
                title="Move up (the model writes the fields in this order)"
                aria-label="Move field up"
                disabled={i === 0}
                onClick={() => updateStudy((s) => void s.prompt.variables.splice(i - 1, 2, s.prompt.variables[i], s.prompt.variables[i - 1]))}
              >
                ↑
              </button>
              <button
                className="btn ghost small icon move"
                title="Move down (the model writes the fields in this order)"
                aria-label="Move field down"
                disabled={i === vars.length - 1}
                onClick={() => updateStudy((s) => void s.prompt.variables.splice(i, 2, s.prompt.variables[i + 1], s.prompt.variables[i]))}
              >
                ↓
              </button>
              <button
                className="btn ghost small icon"
                title="Remove field"
                aria-label="Remove field"
                disabled={vars.length === 1}
                onClick={() => {
                  const filled = v.description.trim() || v.values.some((x) => x.trim());
                  if (filled && !confirm(`Remove the field “${v.label?.trim() || v.name}” with its description and values?`)) return;
                  updateStudy((s) => void s.prompt.variables.splice(i, 1));
                }}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
            {/* The type on a row of its own (with the allowed values), so the name gets the full width. */}
            <div className="var-row">
              <select className="select" value={v.type} aria-label="Field type" onChange={(e) => upd(i, (x) => void (x.type = e.target.value as VariableType))}>
                {Object.entries(TYPE_LABELS).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
              {(v.type === 'category' || v.type === 'ordinal') && (
                <input
                  className="input"
                  aria-label="Allowed values"
                  placeholder={v.type === 'ordinal' ? 'Allowed values, e.g. 0, 1, 2' : 'Allowed values, e.g. positive, neutral, negative'}
                  value={v.values.join(', ')}
                  onChange={(e) => upd(i, (x) => void (x.values = e.target.value.split(',').map((s) => s.trimStart())))}
                />
              )}
            </div>
            {v.type === 'ordinal' && v.values.some((x) => x.trim() && !Number.isInteger(toNumber(x))) && <div className="hint err">Ordinal values must be whole numbers.</div>}
            <input className="input" aria-label="Field description" placeholder="Description for the model (optional)" value={v.description} onChange={(e) => upd(i, (x) => void (x.description = e.target.value))} />
          </div>
        );
      })}
      <div>
        <button
          className="btn small"
          onClick={() =>
            updateStudy((s) => {
              const others = s.prompt.variables.map((v) => v.name);
              s.prompt.variables.push({ name: uniqueKey(`field_${others.length + 1}`, others), type: 'category', values: [], description: '' });
            })
          }
        >
          <Icon name="plus" size={14} /> Add field
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={p.includeRationale} onChange={(e) => updateStudy((s) => void (s.prompt.includeRationale = e.target.checked))} />
        <span>
          Ask for a short rationale
          <div className="hint">Adds a "{RATIONALE_KEY}" field, written before the labels; useful when checking disagreements.</div>
        </span>
      </label>
    </div>
  );
}
