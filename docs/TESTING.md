# Test without using NVIDIA quota

The dashboard makes a NVIDIA request only for a question submitted with **Generate answer** checked. That box starts checked; uncheck it for a local evidence-only search. API clients likewise control this with the `generate` request field. Uploading files, inspecting passages, asking in retrieval-only mode, and running the evaluation page use local components. Automated backend and HTTP tests use a stub model.

## 1. Fast offline checks

From the project root in PowerShell:

```powershell
npm.cmd test
npm.cmd --prefix web run build
```

These commands need no NVIDIA key and make no NVIDIA request. The UI build checks compilation; it does not replace a browser walkthrough.

## 2. Full offline API exercise

The HTTP suite tests eight formats, document locations, malformed files, duplicates, retrieval, citations, abstention, conflicts, evaluation comparisons, deletion, and a scanned-PDF OCR failure path. Use an empty data directory for each run so old fixtures do not collide.

In terminal A, from the project root:

```powershell
$env:PORT='8791'
$env:MODEL_MODE='stub'
$env:EMBEDDING_MODE='stub'
$env:DATA_DIR="./data/test-$([guid]::NewGuid().ToString('N'))"
node server/main.mjs
```

In terminal B, from the same root:

```powershell
$env:RAG_BASE_URL='http://127.0.0.1:8791/api/v1'
$env:RAG_TEST_OCR='1'
node --test tests/integration/api.test.mjs
```

Stop terminal A with Ctrl+C after the suite. The `RAG_TEST_OCR` case can report a missing local OCR language asset; it verifies that the document fails clearly and the API remains healthy. This does not call NVIDIA.

## 3. Check the local semantic model

For a real local-embedding run, restart terminal A with a new data directory and `EMBEDDING_MODE='local'`, keeping `MODEL_MODE='stub'`. The first run may download the quantized MiniLM model to the ignored local cache. On the **Ask documents** page, uncheck **Generate answer** and choose **Hybrid**. Inspect the trace for lexical, semantic, fusion, and rerank stages and nonempty semantic scores. This uses local CPU inference and no NVIDIA quota.

## 4. Run real NVIDIA answer checks

The user-supplied `.ENV` is already ignored by Git and the server accepts its lowercase `nvidia_api_key`. With a new server process, set `MODEL_MODE='nvidia'` or remove the test override. Keep `NVIDIA_ENABLE_THINKING=false` for a bounded response. Start the UI with `npm.cmd --prefix web run dev`.

1. Run `node scripts/seed-demo.mjs` to create the original sample collection and evaluation questions, or create a collection and upload `docs/demo/current-policy.md` manually. Seeding makes no NVIDIA call.
2. Uncheck **Generate answer**, then ask **What is the warranty period for purchases after September 2026?** Confirm retrieval sources and trace locally.
3. Check **Generate answer (send selected excerpts to NVIDIA)** and submit that same question **once**.
4. Confirm the answer cites the uploaded policy. If the endpoint returns a quota or access error, stop there; the indexed collection remains available for local tests.

For a repeatable live check of six cases, start a separate server using an empty data directory. This keeps personal documents out of the NVIDIA requests:

```powershell
$env:PORT='8795'
$env:DATA_DIR='./data/live-test'
$env:MODEL_MODE='nvidia'
$env:EMBEDDING_MODE='local'
node server/main.mjs
```

In another terminal, seed the three synthetic files and run the gated test:

```powershell
$env:RAG_BASE_URL='http://127.0.0.1:8795/api/v1'
node scripts/seed-demo.mjs
$env:RAG_LIVE_TEST='1'
node scripts/live-test.mjs
```

The script verifies the three indexed files against local SHA-256 hashes before querying. It checks four NVIDIA generated answers for factual values and real citations, plus two locally handled abstention cases. It makes no automatic retries. Use an empty collection for each run; the script refuses collections with extra files.

If the dashboard reports `NVIDIA_NETWORK_DENIED`, the API process cannot make outbound requests. Restart the API from a terminal with internet access. This was observed when the server ran inside a restricted workspace process; a direct request from a network-enabled process using the same key and model succeeded. The API now distinguishes this condition from NVIDIA HTTP errors.

The evaluation page deliberately uses a stub answer path even when the server is in NVIDIA mode, so it does not spend API quota. The app never auto-retries a generation request. The verified live results from 2026-11-04 are recorded in [LIVE_TEST_REPORT.md](LIVE_TEST_REPORT.md).

NVIDIA currently labels the selected Nemotron model a [free development endpoint](https://build.nvidia.com/explore), and its [NIM documentation](https://docs.api.nvidia.com/nim/docs/run-anywhere) describes free prototyping access for developer-program members. Your account's entitlement and rate limits still control actual calls.
