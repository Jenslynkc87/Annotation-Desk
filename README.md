# Annotation Desk

A browser-based research workbench for annotating texts with large language models (Anthropic Claude and OpenAI GPT), built for transparent, reproducible studies.

Everything runs in your browser. Your API key, texts and results never pass through any server other than the provider you choose, and nothing is stored outside your browser until you export it.

## What it does

- **Set up a study:** pick a provider and model (the list is loaded from your account), set the effort / reasoning level (medium to start), token limit and, where the model allows it, temperature, and write one prompt. Each text is added after the prompt between `<text>` tags, or wherever you put `{{text}}`; `{{id}}` and `{{meta.column}}` insert the id and metadata. An optional system prompt is available for setups that use one.
- **Structured output:** define the fields the model must return (category, ordinal scale, number, yes/no, free text), optionally preceded by a rationale. Responses are enforced with a JSON schema, so every annotation becomes a clean column.
- **Add texts:** drag and drop TXT, MD, PDF, DOCX or HTML files (one text each), a whole corpus as CSV, TSV, XLSX, JSON or JSONL (choose the text and ID columns; other columns become metadata), or paste text.
- **Tinker quickly:** test the prompt on one text or a random sample, look at the result and rationale, adjust, repeat. Each run is numbered and the prompt is versioned automatically, so earlier results stay comparable.
- **Run at scale:** run everything, a selection, or only texts not yet annotated with the current prompt; with optional prompt caching, the providers' Batch APIs (about 50% cheaper, results collected later), several annotations per text (retest reliability) and adjustable parallelism.
- **Inspect results:** a results list with per-text detail (rationale, reasoning summary, tokens, timing, the exact request and the full raw response), comparison against any metadata column, and an agreement panel (percent agreement, Cohen's κ, weighted κ, Krippendorff's α, Gwet's AC1, Spearman ρ, MAE, confusion matrix) for model vs. human labels, run vs. run, or replicate vs. replicate.
- **Export:**
  - **Excel** workbook for a run.
  - **Research repository** (.zip): every run, prompt version, the corpus, full request/response logs, results, a re-importable study backup and a reproducible script.
  - **Supplementary repository** (.zip): what a journal or OSF/Zenodo deposit needs for the reported run: `metadata.json`, prompt, codebook, results overview, agreement, a draft methods paragraph, and `annotate.py`, a standalone Python script that sends exactly the same requests, plus `annotate_template.py`, the same script with `{{PLACEHOLDERS}}` marking every inserted value. Texts and raw logs are optional (off by default).

## Using it

Open the hosted app, click **API keys**, paste a key from [console.anthropic.com](https://console.anthropic.com/settings/keys) or [platform.openai.com](https://platform.openai.com/api-keys), and create your first study.

Keys are kept only for the open tab unless you tick *Remember keys in this browser*. Studies are saved automatically in the browser (IndexedDB); use **Export → Study backup** to move a study to another computer or browser.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (metrics, exported script fidelity; needs python3 for the script tests)
npm run typecheck
npm run build      # static site in dist/
```

The app is a static site (Vite + React + TypeScript) and uses the official `@anthropic-ai/sdk` and `openai` SDKs directly from the browser.

## Deployment

`.github/workflows/deploy.yml` publishes `dist/` to GitHub Pages on every push to the default branch. Enable it once under **Settings → Pages → Source: GitHub Actions**. GitHub Pages on a private repository requires a paid plan; alternatively connect the repository to Cloudflare Pages or Netlify (build command `npm run build`, output directory `dist`).

## Methodological notes

- Every run freezes the model, settings and prompt it used; the exact shared request body is stored with the run and each text's message with its result.
- Claude models always run with (adaptive) thinking; effort controls how much they reason.
- Effort is always set explicitly (it starts at medium), because providers' defaults differ between models and can change. Runs made before this was the case are recorded as "model default". Models without an effort setting show "Not supported" and nothing is sent.
- Current Claude models don't accept a temperature setting, so none is sent or recorded for them.
- Every label comes from the chosen model: a text the model declines is recorded as failed (stop reason "refusal"), never re-run on another model.
- When iterating on prompts against human labels, keep a held-out set for the final agreement estimate, so prompt selection doesn't inflate it.
