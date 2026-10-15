import { useEffect, useMemo, useState } from 'react';
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

export function SetupPanel({ onOpenKeys }: { onOpenKeys: () => void }) {
  const study = useStore((s) => currentStudy(s))!;
  const keys = useStore((s) => s.keys);
  const models = useStore((s) => s.models);
  const modelsStatus = useStore((s) => s.modelsStatus);
  const modelsError = useStore((s) => s.modelsError);
  const docs = useStore((s) => s.docs);
  const [preview, setPreview] = useState<string | null>(null);

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
  const effortChoices = info?.effortLevels?.length ? info.effortLevels : adapter.effortOptions;
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

  return (
    <div className="card card-pad">
      <div className="card-head">
        <span className="step">01</span>
        <h2>Set up</h2>
        <button className="btn ghost small right" onClick={showPreview} title="Show the exact request that will be sent for the first text">
          Preview request
        </button>
      </div>

      {/* ---------- model ---------- */}
      <div className="section">
        <div className="field">
          <span className="label">Provider</span>
          <div className="seg" role="radiogroup">
            {(Object.keys(PROVIDERS) as ProviderId[]).map((id) => (
              <button key={id} className={m.provider === id ? 'on' : ''} onClick={() => setProvider(id)}>
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
          <div className="row">
            <input
              id="model"
              className="input grow mono"
              list="model-list"
              value={m.model}
              placeholder={m.provider === 'openai' ? 'e.g. a model id from your account' : 'claude-…'}
              onChange={(e) => updateStudy((s) => void (s.model.model = e.target.value.trim()))}
            />
            <datalist id="model-list">
              {list.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </datalist>
            <button className="btn small" disabled={!hasKey || modelsStatus[m.provider] === 'loading'} onClick={() => loadModels(m.provider)} title="Reload model list">
              <Icon name="refresh" size={14} />
            </button>
          </div>
          <div className="hint">
            {modelsStatus[m.provider] === 'loading' && 'Loading models from your account…'}
            {modelsStatus[m.provider] === 'error' && <span className="err">{modelsError[m.provider]}</span>}
            {modelsStatus[m.provider] === 'ok' && `${list.length} models available to your key. Type to search, or enter any model id.`}
            {modelsStatus[m.provider] === 'idle' && (hasKey ? '' : 'Add a key to list the models your account can use.')}
            {info && info.label !== info.id && <> · {info.label}</>}
          </div>
        </div>

        <div className="grid2">
          <div className="field">
            <label htmlFor="effort">{m.provider === 'anthropic' ? 'Effort' : 'Reasoning effort'}</label>
            <select id="effort" className="select" value={m.effort} onChange={(e) => updateStudy((s) => void (s.model.effort = e.target.value))}>
              <option value="">Model default</option>
              {effortChoices.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
            {!m.effort && <div className="hint">For reported runs, set this explicitly: defaults differ between models and can change.</div>}
          </div>
          {m.provider === 'anthropic' ? (
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
          ) : (
            <div />
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={m.reasoningSummary} onChange={(e) => updateStudy((s) => void (s.model.reasoningSummary = e.target.checked))} />
          <span>
            Record the model's reasoning summary
            <div className="hint">Stored per text next to the annotation{m.provider === 'anthropic' ? ' (turns thinking on)' : ''}. The raw chain of thought is never available.</div>
          </span>
        </label>

        <details className="more">
          <summary>Sampling & limits</summary>
          <div className="more-body grid2">
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
            {m.provider === 'anthropic' && (
              <label className="check" style={{ gridColumn: '1 / -1' }}>
                <input type="checkbox" checked={m.refusalFallback} onChange={(e) => updateStudy((s) => void (s.model.refusalFallback = e.target.checked))} />
                <span>
                  Refusal fallback
                  <div className="hint">
                    If a safety filter declines a request, the API re-runs it on a fallback model. The answering model is recorded per result and flagged.
                    Supported on {FALLBACK_MODELS.length} current models; not used with the Batch API. Turn off if every label must come from the chosen model.
                  </div>
                </span>
              </label>
            )}
            <div className="hint" style={{ gridColumn: '1 / -1' }}>
              Leave temperature empty unless you need it: many current reasoning models only accept their default and will return an error. The
              setting actually sent is recorded with every run.
            </div>
          </div>
        </details>
      </div>

      {/* ---------- prompt ---------- */}
      <div className="section">
        <div className="field">
          <label htmlFor="system">Instructions (system prompt)</label>
          <textarea
            id="system"
            className="textarea prompt"
            value={p.system}
            placeholder="Describe the task, the codebook / rubric, edge-case rules and examples. This part is identical for every text and can be cached."
            onChange={(e) => updateStudy((s) => void (s.prompt.system = e.target.value))}
          />
          <div className="hint row" style={{ justifyContent: 'space-between' }}>
            <span>
              {p.system.length.toLocaleString()} characters · ≈{approxTokens.toLocaleString()} tokens
            </span>
            {o.caching && p.system && approxTokens < 1024 && <span className="warn">Short prompts may be below the provider's minimum cacheable length.</span>}
          </div>
        </div>
        <div className="field">
          <label htmlFor="usertpl">Message per text</label>
          <textarea
            id="usertpl"
            className="textarea mono"
            rows={3}
            value={p.userTemplate}
            onChange={(e) => updateStudy((s) => void (s.prompt.userTemplate = e.target.value))}
          />
          <div className="hint">
            <code>{'{{text}}'}</code> is replaced by each text, <code>{'{{id}}'}</code> by its id
            {metaColumns.length > 0 && (
              <>
                , and metadata with{' '}
                {metaColumns.slice(0, 4).map((c, i) => (
                  <span key={c}>
                    {i > 0 && ', '}
                    <code>{`{{meta.${c}}}`}</code>
                  </span>
                ))}
                {metaColumns.length > 4 && ' …'}
              </>
            )}
            .
            {!p.userTemplate.includes('{{text}}') && <div className="warn">The template doesn't include {'{{text}}'}: the texts won't be sent.</div>}
            {unknownPlaceholders.length > 0 && <div className="warn">Unknown placeholder(s): {unknownPlaceholders.join(', ')} (sent as written).</div>}
          </div>
        </div>
      </div>

      {/* ---------- output ---------- */}
      <div className="section">
        <div className="field">
          <span className="label">Output</span>
          <div className="seg">
            <button className={p.outputMode === 'structured' ? 'on' : ''} onClick={() => updateStudy((s) => void (s.prompt.outputMode = 'structured'))}>
              Structured fields
            </button>
            <button className={p.outputMode === 'text' ? 'on' : ''} onClick={() => updateStudy((s) => void (s.prompt.outputMode = 'text'))}>
              Plain text
            </button>
          </div>
          <div className="hint">
            {p.outputMode === 'structured'
              ? 'The model must return exactly these fields (enforced with a JSON schema), so every result becomes a clean column.'
              : 'The full reply is stored as one column. Useful for open-ended tasks; harder to analyse.'}
          </div>
        </div>
        {p.outputMode === 'structured' && <VariableEditor />}
      </div>

      {/* ---------- run options ---------- */}
      <div className="section">
        <p className="section-title">Run options</p>
        <div className="grid2">
          <div className="field">
            <label htmlFor="reps">Runs per text</label>
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
        {o.replicates > 1 && <div className="hint" style={{ marginTop: -6, marginBottom: 10 }}>Each text is annotated {o.replicates}× (retest reliability). Results show the majority / mean.</div>}
        <label className="check">
          <input type="checkbox" checked={o.caching} onChange={(e) => updateStudy((s) => void (s.options.caching = e.target.checked))} />
          <span>
            Prompt caching
            <div className="hint">
              {m.provider === 'anthropic'
                ? 'Caches the instructions so repeated requests are cheaper and faster.'
                : 'OpenAI caches long prompts automatically; this adds a stable cache key to improve hit rates. Automatic caching itself cannot be turned off.'}
            </div>
          </span>
        </label>
        {o.caching && m.provider === 'anthropic' && (
          <div className="row" style={{ margin: '6px 0 6px 24px' }}>
            <span className="hint">Cache lifetime</span>
            <div className="seg">
              {(['5m', '1h'] as const).map((t) => (
                <button key={t} className={o.cacheTtl === t ? 'on' : ''} onClick={() => updateStudy((s) => void (s.options.cacheTtl = t))}>
                  {t === '5m' ? '5 min' : '1 hour'}
                </button>
              ))}
            </div>
          </div>
        )}
        <label className="check" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={o.batch} onChange={(e) => updateStudy((s) => void (s.options.batch = e.target.checked))} />
          <span>
            Batch API
            <div className="hint">About 50% cheaper; results arrive asynchronously (usually within an hour, at most 24 h). You can close the page and collect them later. Quick tests always run immediately.</div>
          </span>
        </label>
      </div>

      {preview && (
        <Modal title="Request preview (first text)" onClose={() => setPreview(null)}>
          <p className="hint" style={{ marginTop: 0 }}>
            This exact body is sent to {adapter.label} for each text (your API key is sent separately in a header and never stored with results).
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
                className="input mono"
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
                className="btn ghost small"
                title="Remove field"
                disabled={vars.length === 1}
                onClick={() => updateStudy((s) => void s.prompt.variables.splice(i, 1))}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
            {err && <div className="hint err">{err}</div>}
            {(v.type === 'category' || v.type === 'ordinal') && (
              <div className="field">
                <input
                  className="input"
                  placeholder={v.type === 'ordinal' ? 'Allowed values, e.g. 0, 1, 2' : 'Allowed values, e.g. positive, neutral, negative'}
                  value={v.values.join(', ')}
                  onChange={(e) => upd(i, (x) => void (x.values = e.target.value.split(',').map((s) => s.trimStart())))}
                />
                {v.type === 'ordinal' && v.values.some((x) => x.trim() && !Number.isInteger(Number(x))) && <div className="hint err">Ordinal values must be whole numbers.</div>}
              </div>
            )}
            <div className="field">
              <input className="input" placeholder="Short description for the model (optional)" value={v.description} onChange={(e) => upd(i, (x) => void (x.description = e.target.value))} />
            </div>
          </div>
        );
      })}
      <div className="row">
        <button className="btn small" onClick={() => updateStudy((s) => void s.prompt.variables.push({ name: `field_${s.prompt.variables.length + 1}`, type: 'category', values: [], description: '' }))}>
          <Icon name="plus" size={14} /> Add field
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={p.includeRationale} onChange={(e) => updateStudy((s) => void (s.prompt.includeRationale = e.target.checked))} />
        <span>
          Ask for a short rationale
          <div className="hint">Adds a "{RATIONALE_KEY}" field, written before the labels. Useful when adjudicating disagreements.</div>
        </span>
      </label>
    </div>
  );
}
