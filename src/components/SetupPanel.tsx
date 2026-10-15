import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { RATIONALE_KEY, renderUserMessage, templatePlaceholders, validateVariableName } from '../lib/prompt';
import { FALLBACK_ANTHROPIC_MODELS, FALLBACK_MODELS } from '../lib/providers/anthropic';
import { PROVIDERS, provider } from '../lib/providers';
import { buildSnapshot, currentStudy, getState, loadModels, updateStudy, useStore } from '../lib/store';
import type { ProviderId, Variable, VariableType } from '../lib/types';
import { Icon, Modal } from './ui';

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
  const [preview, setPreview] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState(false);

  const m = study.model;
  const o = study.options;
  const p = study.prompt;
  const adapter = provider(m.provider);
  const hasKey = !!keys[m.provider];

  useEffect(() => {
    if (hasKey && modelsStatus[m.provider] === 'idle') void loadModels(m.provider);
  }, [hasKey, m.provider, modelsStatus]);

  const list = models[m.provider] ?? (m.provider === 'anthropic' ? FALLBACK_ANTHROPIC_MODELS : []);
  const info = list.find((x) => x.id === m.model);
  const showCustom = customModel || !list.length || (!!m.model && !info);
  const effortChoices = info?.effortLevels?.length ? info.effortLevels : adapter.effortOptions;
  const effortLabel = m.provider === 'anthropic' ? 'Effort' : 'Reasoning effort';
  const metaColumns = useMemo(() => [...new Set(docs.flatMap((d) => Object.keys(d.meta)))].slice(0, 30), [docs]);
  const approxTokens = Math.round(p.system.length / 4);
  const unknownPlaceholders = templatePlaceholders(p.userTemplate).filter(
    (k) => k !== 'text' && k !== 'id' && !(k.startsWith('meta.') && metaColumns.includes(k.slice(5))),
  );

  const setProvider = (id: ProviderId) =>
    updateStudy((s) => {
      if (s.model.provider === id) return;
      s.model.provider = id;
      s.model.model = id === 'anthropic' ? 'claude-opus-5-5' : '';
      s.model.effort = '';
      s.model.thinking = 'default';
    });

  const showPreview = async () => {
    const st = currentStudy(getState())!;
    const snap = await buildSnapshot(st);
    const doc = getState().docs[0] ?? { docId: 'example', text: '(your text appears here)', meta: {} };
    const part = provider(st.model.provider).buildRequestPart(renderUserMessage(st.prompt.userTemplate, doc));
    setPreview(JSON.stringify({ ...snap.requestBase, ...part }, null, 2));
  };

  const modelSummary = [m.model || 'no model', m.effort ? `${effortLabel.toLowerCase()} ${m.effort}` : null, m.temperature !== null ? `temp ${m.temperature}` : null]
    .filter(Boolean)
    .join(' · ');
  const outputSummary =
    p.outputMode === 'text' ? 'Plain text' : `${p.variables.length} field${p.variables.length === 1 ? '' : 's'}: ${p.variables.map((v) => v.name).join(', ')}`;
  const runSummary = [
    `${o.replicates}× per text`,
    o.caching ? 'caching on' : 'caching off',
    o.batch ? 'batch' : `${o.concurrency} parallel`,
  ].join(' · ');

  return (
    <div className="card setup-card">
      <div className="card-head card-pad" style={{ paddingBottom: 0 }}>
        <span className="step">01</span>
        <h2>Set up</h2>
        <button className="btn ghost small right" onClick={showPreview} title="Show the exact request that will be sent for the first text">
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

        <div className="field">
          <label htmlFor="model">Model</label>
          <div className="row nowrap">
            {!showCustom ? (
              <select
                id="model"
                className="select grow"
                value={m.model}
                onChange={(e) => {
                  if (e.target.value === CUSTOM) setCustomModel(true);
                  else updateStudy((s) => void (s.model.model = e.target.value));
                }}
              >
                {!m.model && <option value="">Choose a model…</option>}
                {list.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label !== x.id ? `${x.label}  (${x.id})` : x.id}
                  </option>
                ))}
                <option value={CUSTOM}>Other model id…</option>
              </select>
            ) : (
              <input
                id="model"
                className="input grow"
                value={m.model}
                autoFocus={customModel}
                placeholder={m.provider === 'openai' ? 'Model id, e.g. from platform.openai.com' : 'Model id, e.g. claude-opus-5-5'}
                onChange={(e) => updateStudy((s) => void (s.model.model = e.target.value.trim()))}
              />
            )}
            {showCustom && list.length > 0 && (
              <button className="btn small" onClick={() => setCustomModel(false)} title="Choose from the list">
                List
              </button>
            )}
            <button className="btn small icon" disabled={!hasKey || modelsStatus[m.provider] === 'loading'} onClick={() => loadModels(m.provider)} title="Reload models from your account" aria-label="Reload models">
              <Icon name="refresh" size={14} />
            </button>
          </div>
          <div className="hint">
            {modelsStatus[m.provider] === 'loading' && 'Loading models from your account…'}
            {modelsStatus[m.provider] === 'error' && <span className="err">{modelsError[m.provider]}</span>}
            {modelsStatus[m.provider] === 'ok' && `${list.length} models available to your key.`}
            {modelsStatus[m.provider] === 'idle' && !hasKey && 'Add a key to list the models your account can use.'}
          </div>
        </div>

        <div className={m.provider === 'anthropic' ? 'grid2' : ''}>
          <div className="field">
            <label htmlFor="effort">{effortLabel}</label>
            <select id="effort" className="select" value={m.effort} onChange={(e) => updateStudy((s) => void (s.model.effort = e.target.value))}>
              <option value="">Model default</option>
              {effortChoices.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </div>
          {m.provider === 'anthropic' && (
            <div className="field">
              <label htmlFor="thinking">Thinking</label>
              <select
                id="thinking"
                className="select"
                value={m.reasoningSummary ? 'adaptive' : m.thinking}
                disabled={m.reasoningSummary}
                onChange={(e) => updateStudy((s) => void (s.model.thinking = e.target.value as typeof m.thinking))}
              >
                <option value="default">Model default</option>
                <option value="adaptive">On (adaptive)</option>
                <option value="disabled">Off</option>
              </select>
            </div>
          )}
        </div>
        {!m.effort && <div className="hint tight">Tip: set {effortLabel.toLowerCase()} explicitly for reported runs; defaults differ between models.</div>}

        <label className="check" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={m.reasoningSummary} onChange={(e) => updateStudy((s) => void (s.model.reasoningSummary = e.target.checked))} />
          <span>
            Record the model's reasoning summary
            <div className="hint">Saved with each result{m.provider === 'anthropic' ? '; turns thinking on' : ''}.</div>
          </span>
        </label>

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
                  placeholder="Model default"
                  value={m.temperature ?? ''}
                  onChange={(e) => updateStudy((s) => void (s.model.temperature = e.target.value === '' ? null : Number(e.target.value)))}
                />
              </div>
              <div className="field">
                <label htmlFor="maxtok">Max output tokens</label>
                <input
                  id="maxtok"
                  className="input"
                  type="number"
                  min="16"
                  step="256"
                  value={m.maxOutputTokens}
                  onChange={(e) => updateStudy((s) => void (s.model.maxOutputTokens = Math.max(16, Number(e.target.value) || 16000)))}
                />
              </div>
            </div>
            <div className="hint tight">Leave temperature empty unless needed: many reasoning models reject anything but their default.</div>
            {m.provider === 'anthropic' && (
              <label className="check" style={{ marginTop: 12 }}>
                <input type="checkbox" checked={m.refusalFallback} onChange={(e) => updateStudy((s) => void (s.model.refusalFallback = e.target.checked))} />
                <span>
                  Refusal fallback
                  <div className="hint">
                    If a safety filter declines a text, retry it on a fallback model. Flagged per result; never used in batch runs
                    {!FALLBACK_MODELS.includes(m.model) && m.model ? '; not available for this model' : ''}.
                  </div>
                </span>
              </label>
            )}
          </div>
        </details>
      </Section>

      <Section id="prompt" title="Prompt" summary={p.system ? `${p.system.slice(0, 60).replace(/\s+/g, ' ')}…` : 'Empty'}>
        <div className="field">
          <label htmlFor="system">Instructions (system prompt)</label>
          <textarea
            id="system"
            className="textarea prompt"
            value={p.system}
            placeholder="Describe the task, the codebook or rubric, edge-case rules and examples. Sent unchanged with every text."
            onChange={(e) => updateStudy((s) => void (s.prompt.system = e.target.value))}
          />
          <div className="hint row" style={{ justifyContent: 'space-between' }}>
            <span>
              {p.system.length.toLocaleString()} characters · ≈{approxTokens.toLocaleString()} tokens
            </span>
            {o.caching && p.system && approxTokens < 512 && <span>Probably too short to be cached</span>}
          </div>
        </div>
        <div className="field">
          <label htmlFor="usertpl">Message per text</label>
          <textarea id="usertpl" className="textarea mono" rows={2} value={p.userTemplate} onChange={(e) => updateStudy((s) => void (s.prompt.userTemplate = e.target.value))} />
          <div className="hint">
            <code>{'{{text}}'}</code> becomes each text, <code>{'{{id}}'}</code> its id
            {metaColumns.length > 0 && (
              <>
                , <code>{`{{meta.${metaColumns[0]}}}`}</code> a metadata column
              </>
            )}
            .
            {!p.userTemplate.includes('{{text}}') && <div className="warn">This template doesn't include {'{{text}}'}, so the texts won't be sent.</div>}
            {unknownPlaceholders.length > 0 && <div className="warn">Unknown placeholder(s): {unknownPlaceholders.join(', ')} (sent as written).</div>}
          </div>
        </div>
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
            <label htmlFor="reps">Annotations per text</label>
            <input
              id="reps"
              className="input"
              type="number"
              min={1}
              max={10}
              value={o.replicates}
              onChange={(e) => updateStudy((s) => void (s.options.replicates = Math.min(10, Math.max(1, Math.round(Number(e.target.value)) || 1))))}
            />
          </div>
          <div className="field">
            <label htmlFor="conc">Parallel requests</label>
            <input
              id="conc"
              className="input"
              type="number"
              min={1}
              max={16}
              value={o.concurrency}
              disabled={o.batch}
              onChange={(e) => updateStudy((s) => void (s.options.concurrency = Math.min(16, Math.max(1, Math.round(Number(e.target.value)) || 1))))}
            />
          </div>
        </div>
        <div className="hint tight">{o.replicates > 1 ? `Each text is annotated ${o.replicates}×; results show the majority (or mean) and how consistent the repeats were.` : 'Use 2 or more to measure how consistent the model is.'}</div>

        <label className="check" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={o.caching} onChange={(e) => updateStudy((s) => void (s.options.caching = e.target.checked))} />
          <span className="grow">
            <span className="row" style={{ justifyContent: 'space-between' }}>
              Prompt caching
              {o.caching && m.provider === 'anthropic' && (
                <span className="seg compact" onClick={(e) => e.preventDefault()}>
                  {(['5m', '1h'] as const).map((t) => (
                    <button key={t} className={o.cacheTtl === t ? 'on' : ''} onClick={() => updateStudy((s) => void (s.options.cacheTtl = t))}>
                      {t === '5m' ? '5 min' : '1 hour'}
                    </button>
                  ))}
                </span>
              )}
            </span>
            <div className="hint">
              {m.provider === 'anthropic'
                ? 'Reuses the instructions between requests: cheaper and faster.'
                : 'OpenAI caches long prompts automatically; this adds a cache key for better hit rates.'}
            </div>
          </span>
        </label>
        <label className="check" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={o.batch} onChange={(e) => updateStudy((s) => void (s.options.batch = e.target.checked))} />
          <span>
            Batch API
            <div className="hint">About half the price; results arrive later (usually within an hour). Tests always run immediately.</div>
          </span>
        </label>
      </Section>

      {preview && (
        <Modal title="Request preview (first text)" onClose={() => setPreview(null)}>
          <p className="hint" style={{ marginTop: 0 }}>
            This exact body is sent to {adapter.label} for each text. Your API key travels separately in a header and is never stored.
          </p>
          <pre className="textblock mono" style={{ maxHeight: '60vh' }}>
            {preview}
          </pre>
        </Modal>
      )}
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
        const err = validateVariableName(v.name, vars.filter((_, j) => j !== i).map((x) => x.name));
        return (
          <div className="var" key={i}>
            <div className="var-top">
              <input
                className="input"
                value={v.name}
                aria-label="Field name"
                placeholder="field_name"
                onChange={(e) => upd(i, (x) => void (x.name = e.target.value.replace(/\s+/g, '_')))}
              />
              <select className="select" value={v.type} aria-label="Field type" onChange={(e) => upd(i, (x) => void (x.type = e.target.value as VariableType))}>
                {Object.entries(TYPE_LABELS).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
              <button
                className="btn ghost small icon"
                title="Remove field"
                aria-label="Remove field"
                disabled={vars.length === 1}
                onClick={() => updateStudy((s) => void s.prompt.variables.splice(i, 1))}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
            {err && <div className="hint err">{err}</div>}
            {(v.type === 'category' || v.type === 'ordinal') && (
              <input
                className="input"
                aria-label="Allowed values"
                placeholder={v.type === 'ordinal' ? 'Allowed values, e.g. 0, 1, 2' : 'Allowed values, e.g. positive, neutral, negative'}
                value={v.values.join(', ')}
                onChange={(e) => upd(i, (x) => void (x.values = e.target.value.split(',').map((s) => s.trimStart())))}
              />
            )}
            {v.type === 'ordinal' && v.values.some((x) => x.trim() && !Number.isInteger(Number(x))) && <div className="hint err">Ordinal values must be whole numbers.</div>}
            <input className="input" aria-label="Field description" placeholder="Description for the model (optional)" value={v.description} onChange={(e) => upd(i, (x) => void (x.description = e.target.value))} />
          </div>
        );
      })}
      <div>
        <button className="btn small" onClick={() => updateStudy((s) => void s.prompt.variables.push({ name: `field_${s.prompt.variables.length + 1}`, type: 'category', values: [], description: '' }))}>
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
