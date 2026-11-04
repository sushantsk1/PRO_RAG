# Live NVIDIA answer test — 2026-11-04

Environment: isolated local API on port 8795, `MODEL_MODE=nvidia`, local MiniLM embeddings, `nvidia/nemotron-3.5-lightning-30b-a3b`, three SHA-256 verified synthetic demo files. The API key was read from ignored `.ENV` and was not logged. The live test did not use the user's uploaded resume.

| Case | Result | Evidence |
| --- | --- | --- |
| Current warranty, purchase after September 2026 | Pass: 24 months | Cited `current-policy.md` |
| Legacy warranty | Pass: 12 months | Cited `legacy-policy.md` |
| Live support hours | Pass: Monday–Friday, 09:00–18:00 IST | Cited `current-policy.md` |
| South tickets, August 2026 | Pass: 110 | Cited `support-metrics.csv`, row 5 |
| Unsupported battery chemistry | Pass: abstained | No citation or invented fact |
| Warranty without purchase date | Pass: reported 24-month and 12-month policies, abstained | Cited both policy files |

`node scripts/live-test.mjs` passed all six cases. Four cases called NVIDIA for generated answers; two used local abstention checks. Each generated citation marker was verified against a returned source chunk. The default collection was not queried during live testing.

Additional checks after the parser and conflict fixes: `npm.cmd test` passed 7 unit tests; the stub-mode HTTP integration suite passed 10 tests, including eight formats, row-aware CSV/XLSX extraction, citation integrity, malformed files, retrieval, evaluation, deletion, and the OCR failure path. The UI build compiles, but its rendered layout was not inspected in a browser here. A successful scanned-PDF OCR extraction remains unverified because the local OCR asset was unavailable in this environment.

## Local dashboard incident

The first API process on port 8787 returned `NVIDIA_UPSTREAM_ERROR` because outbound network access failed with `EACCES`. The configured key and model returned HTTP 200 from a network-enabled process. After restarting the API with network access, a synthetic warranty query through port 8787 returned HTTP 200 with a cited 24-month answer. The provider now reports network-denied errors distinctly and rejects replies containing only a citation marker. The updated unit suite passes 8 tests.
