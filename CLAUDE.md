# Annotation Desk: working notes

A browser-only research workbench for LLM-assisted text annotation (Anthropic + OpenAI). Static Vite + React + TypeScript app, data in IndexedDB, API calls made from the browser. Published on GitHub Pages (deploy workflow in `.github/workflows/`).

## How to work with the owner
- Write in American English with curly quotes. Use Danish only when asked. The app UI is English.
- The owner is a researcher, not a developer. Explain in plain language, say what changed and what was not verified.
- Push back when something seems like a bad idea. Do not add features unasked: the owner worries about mission creep, reporting overload and files piling up on their computer.
- Scope is deliberately small: core annotation, codebook with multiple fields, replicates, gold-label agreement, recorded prompt/model/settings. Not wanted: in-app human coding, audit planner, preregistration freeze, student tutorials/examples.
- Never alter the owner's texts (no cleanup or line-joining step). Keys are never stored in exports or logs.
- Exported scripts are Python. Commit and push to the designated branch; do not open pull requests unless asked.

## Where things are
- `src/lib/prompt.ts`: prompt rendering, output schema, parsing, `flattenJsonResponse`.
- `src/lib/providers/`: Anthropic and OpenAI adapters (requests, caching, batches, model lists).
- `src/lib/store.ts`: app state, runs, batch polling.
- `src/lib/export/`: `tables.ts` (row layouts), `packages.ts` (Excel via ExcelJS, research and supplementary zips), `python.ts` (exported script and requirements).
- `src/lib/metrics.ts`: agreement statistics (validated against Python packages).
- `src/components/`: UI. `tools/`: stand-alone helper scripts for the owner's corpus (`extract_pdfs.py`, `check_ligatures.py`).

## Decisions worth remembering
- One Prompt box. Each text is appended inside `<text>` tags (or placed at `{{text}}`). The fixed part before it is what gets cached.
- Effort has no "Default" option: it starts at medium and is always sent (except for models without an effort setting). Temperature is not sent to Claude models that reject it.
- No refusal fallback (removed on purpose): a label from another model is not a useful result. A refused text is a failed result.
- Plain-text runs that return JSON are split into columns in Excel/CSV. Each reasoning column goes after its scores.
- Excel Results sheet shows the file name (not `doc_id`) and has no text column. CSVs keep `doc_id` as the join key.
- Corpus: about 937 Markdown files extracted from scholarly PDFs. About 15 have lost fi/fl/ff letters and 36 have stray `<mark>` tags. The owner chose to leave them as they are.

## Checks before pushing
`npx tsc --noEmit -p .`, `npx vitest run`, `npx vite build`.
