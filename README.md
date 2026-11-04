# PRO_RAG Studio

A local document analysis studio built to demonstrate an advanced retrieval-augmented generation pipeline in interviews. It combines broad document ingestion, source-aware chunking, lexical and local semantic retrieval, rank fusion and reranking, grounded NVIDIA answers with citations, and a dashboard for inspection and evaluation.

New here? Start with the [beginner's guide](docs/BEGINNERS_GUIDE.md) for a walkthrough of setup, uploads, search, generated answers, and evaluation.

The app is designed for a single user on one computer. Parsing, storage, embeddings, retrieval, and evaluation use local open-source components. NVIDIA chat generation uses **your** API key and account allowance; verify your NVIDIA terms before making hosted calls. No paid database, OCR, telemetry, hosting, or evaluation account is required.

## Requirements

- Node.js 24 or newer
- npm and internet access for first install and local model/language asset downloads
- Optional NVIDIA API key for generated answers; ingestion, retrieval-only queries, and offline tests work without one

## Start locally

From the project root, install the API and UI dependencies:

```powershell
npm.cmd install
npm.cmd --prefix web install
```

On macOS/Linux use `npm` in place of `npm.cmd`.

Copy `.env.example` to `.env` and set `NVIDIA_API_KEY` when you want generated answers. The API also accepts the supplied uppercase `.ENV` file and lowercase `nvidia_api_key` name. Never commit either file. The supplied NVIDIA template's model is the default in `.env.example`. Only the NVIDIA key is used; unrelated credentials in your environment are ignored.

In one terminal:

```powershell
npm.cmd start
```

In a second terminal:

```powershell
npm.cmd --prefix web run dev
```

Open <http://127.0.0.1:5173>. The API listens on <http://127.0.0.1:8787> by default and binds to loopback. First use of advanced semantic retrieval may download a local ONNX model; OCR may also require language assets. The UI should show readiness or a useful error while those components initialize. Baseline lexical retrieval remains available.

## Interview demo

With the API running, `node scripts/seed-demo.mjs` creates the sample collection and three evaluation questions without a NVIDIA call. It is safe to rerun; existing sample files and questions are skipped.

1. Select **Northstar Support** in the Knowledge library. If you skipped the seed script, create it and upload the original sample files in [docs/demo](docs/demo).
2. Inspect the three ready documents: `current-policy.md`, `legacy-policy.md`, and `support-metrics.csv`.
3. Ask **“What is the warranty for purchases after September 2026?”** and inspect the source marker and selected chunk.
4. Ask **“How long is the Northstar Devices hardware warranty?”** to show both policy durations and their citations.
5. Ask **“What is the battery chemistry?”** to show insufficient-evidence behavior.
6. Compare baseline and hybrid retrieval on a small evaluation set; inspect the trace, latency, and source rankings.
7. Open the dashboard to explain document counts, ingestion outcomes, query latency, and evaluation results.

The fixtures under `tests/integration/fixtures` cover PDF, DOCX, PPTX, XLSX, CSV, TXT, Markdown, HTML, scanned PDF, and malformed cases for reproducible technical checks.

## Checks

Follow the [testing guide](docs/TESTING.md) for offline checks, a one-question smoke, or the repeatable six-case live test. The [live test report](docs/LIVE_TEST_REPORT.md) records the actual NVIDIA answer results.

```powershell
npm.cmd test
npm.cmd --prefix web run build
```

Automated tests use a stub model path and make no NVIDIA call.

## How it works

See the [architecture](docs/ARCHITECTURE.md) for the ingestion, retrieval, answer generation, and evaluation design.

## Limits

The app is intended for a portfolio-sized corpus, not a public multi-user deployment. PDF tables, complex layouts, handwriting, encrypted files, and images inside documents can extract imperfectly. Citations and deterministic evaluation make errors inspectable, but no RAG system can guarantee perfect answers for arbitrary documents. The server sends selected excerpts to NVIDIA only when generation is requested; keep sensitive documents out of a hosted-model demo unless you are allowed to send them.
