# Annotation Desk

A browser-based research workbench for annotating texts with large language models (Anthropic Claude and OpenAI GPT), built for transparent, reproducible studies.

Everything runs in your browser. Your API key, texts and results never pass through any server other than the provider you choose, and nothing is stored outside your browser until you export it.

## What it does

- **Set up a study:** pick a provider and model (the list is loaded from your account), set the effort / reasoning level (medium to start), token limit and, where the model allows it, temperature, and write one prompt. Each text is added after the prompt between `<text>` tags, or wherever you put `{{text}}`; `{{id}}` and `{{meta.column}}` insert the id and metadata. An optional system prompt is available for setups that use one.
- **Structured output:** define the fields the model must return (category, ordinal scale, number, yes/no, free text), optionally preceded by a rationale. Responses are enforced with a JSON schema, so every annotation becomes a clean column.
- **Add texts:** drag and drop TXT, MD, PDF, DOCX or HTML files (one text each), a whole corpus as CSV, TSV, XLSX, JSON or JSONL (choose the text and ID columns; other columns become metadata), or paste text.
- **Or annotate entries from the model's own knowledge:** a second kind of study (Studies → New study…) for people, organizations, works, places or events, each described by a few details pasted as a table or added from a spreadsheet (one row per entry; you choose which columns the model sees, your own answers stay aside for comparison). Each entry is sent after the prompt between `<entry>` tags.
- **Add an answer key:** human labels can be added later from a spreadsheet, matched to the texts by file name or ID (the texts are not changed). A corrected sheet replaces the values of the texts it lists (a blank cell clears one), and a column added by mistake can be removed.
- **Tinker quickly:** test the prompt on one text or a random sample, look at the result and rationale, adjust, repeat. Each run is numbered and the prompt is versioned automatically, so earlier results stay comparable.
- **Run at scale:** run everything, a selection, or only texts not yet annotated with the current prompt and model; with optional prompt caching, the providers' Batch APIs (about 50% cheaper, results collected later), several annotations per text (retest reliability) and adjustable parallelism.
- **Retry failed requests** within the same run, with its frozen settings, so one run stays one complete dataset (in a batch run, as a new batch at batch price). A batch run too large for one batch is sent as several, after a warning.
- **Inspect results:** a results list with per-text detail (rationale, reasoning summary, tokens, timing, the exact request and the full raw response), comparison against any metadata column, and an agreement panel (percent agreement, Cohen's κ, weighted κ, Krippendorff's α, Gwet's AC1, Spearman ρ, MAE, confusion matrix) for model vs. human labels, run vs. run, or replicate vs. replicate.
- **Compare two runs** (e.g. two models): agreement within a chosen tolerance (exact, ±1, ±2 points), systematic difference (does one score higher?), and a downloadable Excel comparison report with intervals, confusion tables, both runs' settings and draft text for a paper. Plain-text runs that answer in JSON are compared on their numeric scores.
- **Draw a sample:** a stratified random sample (e.g. 100 held-out articles within era × journal groups, pilots left out), reproducible from a seed and marked in a column; filter the text list by it and run exactly those texts.
- **Agreement with uncertainty:** 95% bootstrap intervals for every agreement statistic, the number of labelled texts compared, and human–human agreement (two coders' columns) as a baseline.
- **Export:**
  - **Excel** workbook for a run.
  - **Research repository** (.zip): every run, prompt version, the corpus, full request/response logs, results, a re-importable study backup and a reproducible script.
  - **Supplementary repository** (.zip): what a journal or OSF/Zenodo deposit needs for the reported run: `metadata.json`, prompt, codebook, results overview, agreement, a draft methods paragraph, and `annotate.py`, a standalone Python script that sends exactly the same requests, plus `annotate_template.py`, the same script with `{{PLACEHOLDERS}}` marking every inserted value. Texts and raw logs are optional (off by default).

## Using it

Open the hosted app, click **API keys**, paste a key from [console.anthropic.com](https://console.anthropic.com/settings/keys) or [platform.openai.com](https://platform.openai.com/api-keys), and create your first study.

Keys are kept only for the open tab unless you tick *Remember keys in this browser*. Studies are saved automatically in the browser (IndexedDB); use **Export → Study backup** to move a study to another computer or browser, and keep one, since a browser can clear a site's data (e.g. when the disk is full). The app works in one tab at a time: a second tab waits until the first is closed, so the same requests are never sent twice.

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
- Every label comes from the chosen model: a text the model declines is recorded as failed (stop reason "refusal"), never re-run on another model. An empty answer counts as failed too.
- Weighted κ weighs a disagreement by the distance between the two values over the codebook's scale (on a whole-number scale the same as counting steps), so a combined label between two scale points (the median of an even number of annotations, e.g. 0.5) gets partial credit. Gwet's AC1 and AC2 keep the scale's points as their categories (such a value counts half for each neighbor when chance agreement is estimated). Labels outside the scale (e.g. a missing-value code such as 99) and markers such as "NA" are left out and reported; for scores in plain-text answers, the scale is the range of the model's scores.
- Human–human agreement (two coders' columns) is computed on the same texts as the model's agreement for that run.
- Retrying failed requests keeps the replaced attempts' logs and counts their tokens; each retry is recorded with the number of requests it actually sent.
- When iterating on prompts against human labels, keep a held-out set for the final agreement estimate, so prompt selection doesn't inflate it.
