import { useMemo, useState } from 'react';
import { calibrate, estimateRun, fmtRange, fmtTokens, fmtUsd, PRICE_SOURCES, usePriceOverrides, type Part } from '../lib/pricing';
import { currentStudy, remainingDocs, useStore } from '../lib/store';
import { words } from '../lib/subject';
import { Icon } from './ui';

type Scope = 'all' | 'selected' | 'remaining';

/**
 * What "Remaining" sends, in words (the rule of `remainingDocs`), for the Remaining button's and this panel's
 * tooltips: e.g. "texts that have no usable result from a run with the current prompt, model and effort (…)".
 */
export function remainingRule(w: { many: string }): string {
  return `${w.many} that have no usable result from a run with the current prompt, model and effort (${w.many} still waiting in a batch, or in a batch upload whose outcome is unknown, are left out)`;
}

/**
 * "Estimate cost" panel under the run buttons. Recomputed on every render, so it follows any change
 * to the model, effort, Now/Batch, caching, replicates, prompt, codebook or texts while it is open.
 */
export function CostEstimate({ selected, onClose }: { selected: Set<string>; onClose: () => void }) {
  const study = useStore((s) => currentStudy(s))!;
  const w = words(study.prompt);
  const docs = useStore((s) => s.docs);
  const runs = useStore((s) => s.runs);
  const results = useStore((s) => s.results);
  usePriceOverrides(); // re-estimate when the owner edits a price
  const [scope, setScope] = useState<Scope>(selected.size ? 'selected' : 'all');
  const effScope: Scope = scope === 'selected' && !selected.size ? 'all' : scope;

  // What "Remaining" would send (the same rule as the button, see `remainingRule`).
  const remaining = useMemo(() => remainingDocs(study, docs, runs, results).todo, [study, docs, runs, results]);

  const scopeDocs = useMemo(() => {
    if (effScope === 'selected') return docs.filter((d) => selected.has(d.id));
    if (effScope === 'remaining') return remaining;
    return docs;
  }, [effScope, docs, selected, remaining]);

  const cal = useMemo(() => calibrate(study.model, study.prompt, runs, results, docs), [study.model, study.prompt, runs, results, docs]);
  const e = estimateRun({
    docs: scopeDocs,
    prompt: study.prompt,
    model: study.model,
    caching: study.options.caching,
    replicates: study.options.replicates,
    batch: study.options.batch,
    calibration: cal,
  });
  const src = PRICE_SOURCES[study.model.provider];
  const remainingN = remaining.length;
  const tokens = (p: Part) => (p.basis === 'none' ? '0' : fmtRange(p.tokens, fmtTokens));
  const cost = (p: Part) => (p.basis === 'none' ? '—' : p.cost ? fmtRange(p.cost, fmtUsd) : '—');
  const perText = (p: Part) => `${fmtRange({ low: p.tokens.low / Math.max(1, e.requests), high: p.tokens.high / Math.max(1, e.requests) }, fmtTokens)} tokens per ${w.one}`;

  return (
    <div className="estimate" role="region" aria-label="Cost estimate">
      <div className="estimate-head">
        <div>
          <div className="estimate-total">
            {e.total ? fmtRange(e.total, fmtUsd) : 'No price known'} <span className="estimate-n">· {e.requests.toLocaleString()} annotation{e.requests === 1 ? '' : 's'}</span>
          </div>
          <div className="hint">
            {study.model.model}
            {e.effort !== 'none' && ` · ${e.effort} effort`} · {e.batch ? 'Batch (½ price)' : 'Now'}
            {study.options.replicates > 1 && ` · ${e.texts.toLocaleString()} ${w.many} × ${study.options.replicates}`}
          </div>
        </div>
        <button className="btn ghost small" onClick={onClose} aria-label="Close cost estimate">
          ✕
        </button>
      </div>

      <span className="seg compact" role="radiogroup" aria-label={`Which ${w.many}`}>
        <button role="radio" aria-checked={effScope === 'all'} className={effScope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
          All ({docs.length.toLocaleString()})
        </button>
        {selected.size > 0 && (
          <button role="radio" aria-checked={effScope === 'selected'} className={effScope === 'selected' ? 'on' : ''} onClick={() => setScope('selected')}>
            Selected ({selected.size.toLocaleString()})
          </button>
        )}
        <button role="radio" aria-checked={effScope === 'remaining'} className={effScope === 'remaining' ? 'on' : ''} onClick={() => setScope('remaining')} title={`What Remaining would send: the ${remainingRule(w)}`}>
          Remaining ({remainingN.toLocaleString()})
        </button>
      </span>

      <div className="hint" style={{ marginTop: 8 }}>
        A guide, not a quote: actual costs depend mostly on how long the model’s answers and reasoning turn out, and may differ.
        {!e.total && ' Type a price for this model in Setup → Model → Sampling & limits to see a cost.'}
      </div>
      {e.tooLong.length > 0 && (
        <div className="hint warn" style={{ marginTop: 4 }}>
          {e.tooLong.length} {e.tooLong.length === 1 ? `${w.one} is` : `${w.many} are`} probably too long for this model; those requests will most likely fail but are still counted.
        </div>
      )}

      <details className="more">
        <summary>How this is estimated</summary>
        <div className="more-body">
          <table className="data estimate-table">
            <thead>
              <tr>
                <th>Tokens</th>
                <th className="num">Count</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Input (prompt + {w.one})</td>
                <td className="num">{tokens(e.input)}</td>
                <td className="num">{cost(e.input)}</td>
              </tr>
              <tr>
                <td>Answer</td>
                <td className="num">{tokens(e.answer)}</td>
                <td className="num">{cost(e.answer)}</td>
              </tr>
              <tr>
                <td>Reasoning</td>
                <td className="num">{tokens(e.reasoning)}</td>
                <td className="num">{cost(e.reasoning)}</td>
              </tr>
            </tbody>
          </table>
          <ul className="estimate-notes hint">
            <li>
              <strong>Input:</strong> characters of the prompt, output schema and each {w.one}, divided by{' '}
              {e.input.basis === 'measured'
                ? `${e.charsPerToken.toFixed(2)} characters per token, measured on ${cal.inputN.toLocaleString()} earlier result${cal.inputN === 1 ? '' : 's'} with this model (±5%).`
                : `about ${e.charsPerToken} characters per token, a rule of thumb for English with this model’s tokenizer (−15% to +20%). It is replaced by a measured figure once this model has results in the study.`}
            </li>
            <li>
              <strong>Answer:</strong>{' '}
              {e.answer.basis === 'measured'
                ? `average of ${cal.answerN.toLocaleString()} earlier result${cal.answerN === 1 ? '' : 's'} with this model and these fields (−20% to +30%).`
                : `assumed from the ${study.prompt.outputMode === 'structured' ? 'codebook (a few tokens per label or score, a sentence to a paragraph per free-text field)' : 'plain-text output mode'}: ${perText(e.answer)}.`}
            </li>
            <li>
              <strong>Reasoning:</strong>{' '}
              {e.reasoning.basis === 'none'
                ? 'none: this model runs without reasoning at this setting.'
                : e.reasoning.basis === 'measured'
                  ? `average of ${cal.reasoningN.toLocaleString()} earlier result${cal.reasoningN === 1 ? '' : 's'} with this model at ${e.effort} effort (−20% to +30%). Billed as output.`
                  : `assumed for ${e.effort} effort: ${perText(e.reasoning)}. This is the least certain part; Test on 1 ${w.one} or a small random sample replaces it with a measured figure. Billed as output.`}
            </li>
            <li>
              <strong>Cache savings:</strong>{' '}
              {e.cache.assumed
                ? `assumed in the low end only. The fixed part of the prompt (about ${fmtTokens(e.cache.tokensPerRequest)} tokens) is written to the ${e.cache.ttl === '1h' ? '1-hour' : '5-minute'} cache once and then read at the cache price${e.cache.saving !== null ? `, saving up to ${fmtUsd(e.cache.saving)}` : ''}. The high end assumes no cache hits.`
                : `not assumed: ${e.cache.reason}.`}
            </li>
            {e.batch && (
              <li>
                <strong>Batch:</strong> half price applied to everything. Test on 1 {w.one} and Random sample always run now, at full price.
              </li>
            )}
            <li>
              <strong>Prices:</strong>{' '}
              {e.price
                ? `$${e.price.input} input and $${e.price.output} output per million tokens${e.ownPrice ? ' (your own price, set in Setup → Model)' : ''}${e.price.long ? `; $${e.price.long.input} / $${e.price.long.output} for requests over ${fmtTokens(e.price.long.over)} tokens` : ''}.`
                : 'none known for this model.'}{' '}
              <a href={src.url} target="_blank" rel="noreferrer">
                Official {study.model.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} pricing page
              </a>{' '}
              · Checked {src.checked}
              {src.note && ` (${src.note})`}.
            </li>
            <li>No paid API calls are made to estimate cost: it is worked out in your browser from {w.one} lengths, the codebook and earlier results in this study.</li>
          </ul>
        </div>
      </details>
    </div>
  );
}

/** The link that opens the panel. */
export function EstimateLink({ onClick }: { onClick: () => void }) {
  return (
    <button className="linkbtn estimate-link" onClick={onClick}>
      <Icon name="calculator" size={14} /> Estimate cost
    </button>
  );
}
