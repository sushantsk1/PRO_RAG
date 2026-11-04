# Beginner's guide to PRO_RAG Studio

PRO_RAG Studio lets you upload documents, search their contents, and ask questions with citations. It runs on your computer. Answer generation is optional and uses your NVIDIA API key.

## The quickest way to try it

Open PowerShell in the `PRO_RAG` folder. Install dependencies once:

```powershell
npm.cmd install
npm.cmd --prefix web install
```

Keep two terminals open while using the app:

| Terminal | Command | What it runs |
| --- | --- | --- |
| 1 | `npm.cmd start` | The local API at `http://127.0.0.1:8787` |
| 2 | `npm.cmd --prefix web run dev` | The dashboard at `http://127.0.0.1:5173` |

Open [the dashboard](http://127.0.0.1:5173). You do not need to run `npm.cmd install` each time. Leave both terminals open; use **Ctrl+C** in each terminal when you are finished. If a port is already in use, check whether the app is already running before starting another copy. [The API health page](http://127.0.0.1:8787/api/v1/health) should show `"status":"ok"`.

To add ready-made practice documents, run this once in a third terminal while the API is running:

```powershell
node scripts/seed-demo.mjs
```

This creates the **Northstar Support** collection with sample policies, a CSV file, and three evaluation questions. Seeding makes no NVIDIA request. It is safe to run again; it skips sample files and questions already present.

## Three words to know

| Word | Meaning |
| --- | --- |
| **Collection** | A group of related documents, such as product manuals or a portfolio. Select the collection before uploading or asking. |
| **Passage** or **chunk** | A small piece of a document that the app can search and cite. A PDF passage may show a page; a spreadsheet passage may show a sheet and row. |
| **Citation** | A marker such as `[S1]` in an answer. It points to the matching evidence card below the answer. |

Keep unrelated material in separate collections. For example, put a resume in a **Portfolio** collection and product policies in **Northstar Support**. This makes answers easier to check.

## What each screen does

| Screen | Use it for |
| --- | --- |
| **Overview** | See document counts, recent questions, formats, and activity. |
| **Knowledge library** | Create or select a collection, upload files, inspect indexed passages, retry failed files, or delete files. |
| **Ask documents** | Search, optionally generate an answer, inspect citations, and see how passages were retrieved. |
| **Evaluate** | Save test questions and compare keyword search with hybrid search. |
| **Settings** | Check API, NVIDIA key, embedding, and OCR status; review supported formats and privacy. |

## Add your own documents

1. Open **Knowledge library**.
2. Under **New collection**, enter a name and click **Create**. Or use **Active collection** to choose an existing one.
3. Drag files into **Add documents** or click **Browse files**. Supported formats are PDF, DOCX, PPTX, XLSX, CSV, TXT, MD, and HTML. Each file can be up to 25 MB.
4. For a scanned PDF with no selectable text, check **Try local OCR for scanned PDFs**. Leave it off for ordinary text PDFs. OCR may require local language assets and may fail on poor scans.
5. Click **Upload & index**. Wait for each document's status to become **Ready**. **Queued** and **Processing** mean it is still being indexed.
6. Click a document name to inspect the passages the app actually extracted. If the text is missing or incorrect, its answers may be unreliable. A **Failed** file shows an error and a retry button.

Uploading and indexing use local components and do not call NVIDIA.

## Ask your first question without using NVIDIA

1. Open **Ask documents** and select the collection that contains your document.
2. Enter a specific question, such as **What is the warranty for purchases after September 2026?** for the sample collection.
3. Keep **Hybrid** selected and uncheck **Generate answer**. It starts checked.
4. Click **Search evidence**.
5. Read **Evidence & citations**. Look at the document name, page or row, and passage text. The **Retrieval trace** shows the search stages and their timings.

This is retrieval-only mode: it finds evidence but does not write an answer or spend NVIDIA quota. If the wrong document appears, open **Filter sources** and select only the relevant file, then search again. With no filter selected, the app searches all ready documents in the collection.

## Generate an answer with citations

**Generate answer (send selected excerpts to NVIDIA)** is checked by default. If you unchecked it for an evidence-only search, check it again and click **Ask & answer**. The app sends your question and the selected passages to the configured NVIDIA endpoint. The original file and API key stay on the server; the key is not shown in the browser.

Read the answer and click each `[S#]` marker to jump to its evidence card. Compare the claim with the passage itself. A citation proves where the text came from; it does not guarantee the model interpreted it correctly. When the evidence is missing or conflicting, the app may say it cannot give a definite answer.

**Hybrid** combines keyword and local semantic search, then fuses and reranks candidates. **Baseline** uses keyword search only. **Top K** controls how many passages are returned. Start with the default of 6. NVIDIA is called only when you submit a question with **Generate answer** checked; opening the page or viewing history does not call it.

For a quick demonstration, try these questions in **Northstar Support**:

1. **What is the warranty for purchases after September 2026?** — current policy, 24 months.
2. **How long did the legacy hardware warranty last?** — older policy, 12 months.
3. **How many tickets did South have in August 2026?** — CSV row, 110.
4. **What is the device battery chemistry?** — the sample documents do not say, so the app should abstain.

## Compare search modes in Evaluate

1. Open **Evaluate** and select a collection with ready documents.
2. Under **Add a test question**, enter a question. Keep **Answerable from this collection** checked and select the document that should contain the answer. For an unsupported question, uncheck it.
3. Click **Add case**. Add several questions for a useful comparison.
4. Under **Run a comparison**, run **Hybrid retrieval** and **Keyword baseline**. Run both against the same questions and unchanged documents.
5. Open **Past runs** to see recall, MRR, citation validity, abstention accuracy, and latency. Use **Export JSON** if you want to share a run.

The evaluation screen uses a local stub answer path. It compares retrieval and citation behavior without making NVIDIA requests. It does not grade the factual quality of a live NVIDIA answer. If you add or delete documents or cases between the two runs, run both modes again to get a fair comparison.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| A terminal returns to the prompt | Check the [API health page](http://127.0.0.1:8787/api/v1/health). If it is down, run `npm.cmd start` and keep that terminal open. If it is healthy, an API process is already running; do not start a second one on port 8787. |
| Dashboard cannot connect | Make sure the API and dashboard are both running. Check ports 8787 and 5173, then refresh the browser. |
| Document stays **Failed** | Open the file in **Knowledge library** and read its error. For a scanned PDF, retry with local OCR. For a corrupt or protected file, provide a readable copy. |
| No evidence found | Check that the document is **Ready**, the correct collection is selected, and **Filter sources** is not excluding it. Try a clearer question. |
| NVIDIA generation fails | Check **Settings** for NVIDIA configuration. `NVIDIA_NETWORK_DENIED` means the API process cannot reach NVIDIA; restart it from a terminal with internet access. You can still search with **Generate answer** unchecked. |
| `npm warn allow-scripts` during install | This warning does not stop the API. Confirm startup using the health page. |

For technical checks and the repeatable live answer test, see [Testing](TESTING.md). For the system design, see [Architecture](ARCHITECTURE.md).
