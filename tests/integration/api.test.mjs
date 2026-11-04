import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const baseUrl = process.env.RAG_BASE_URL;
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function request(method, route, body, form = false) {
  const headers = form || body === undefined ? {} : { 'content-type': 'application/json' };
  const response = await fetch(new URL(`${baseUrl.replace(/\/$/, '')}${route}`), {
    method,
    headers,
    body: form ? body : body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  return { status: response.status, data, raw };
}

function expectStatus(result, status) {
  assert.equal(result.status, status, JSON.stringify(result.data));
}

async function upload(collectionId, names, ocr = false) {
  const form = new FormData();
  form.set('collectionId', collectionId);
  form.set('ocr', String(ocr));
  for (const name of names) {
    const bytes = await readFile(path.join(fixtureDir, name));
    form.append('files', new Blob([bytes]), name);
  }
  return request('POST', '/documents', form, true);
}

async function waitForDocument(id) {
  const deadline = Date.now() + Number(process.env.RAG_INGEST_TIMEOUT_MS || 120_000);
  let last;
  while (Date.now() < deadline) {
    last = await request('GET', `/documents/${id}`);
    expectStatus(last, 200);
    if (['ready', 'failed'].includes(last.data.status)) return last.data;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.fail(`Document ${id} did not finish processing. Last status: ${JSON.stringify(last?.data)}`);
}

test('contract-level local RAG flow', { skip: !baseUrl && 'Set RAG_BASE_URL to a running stub-mode API' }, async t => {
  let collectionId;
  const documents = new Map();

  await t.test('health, config and empty stats do not expose a key', async () => {
    const health = await request('GET', '/health');
    expectStatus(health, 200);
    assert.equal(health.data.status, 'ok');
    const config = await request('GET', '/config/status');
    expectStatus(config, 200);
    assert.equal(config.data.localOnly, true);
    assert.ok(Array.isArray(config.data.supportedFormats));
    assert.doesNotMatch(config.raw, /nvapi-[A-Za-z0-9_-]+/);
    const stats = await request('GET', '/stats');
    expectStatus(stats, 200);
    assert.equal(typeof stats.data.documentCount, 'number');
  });

  await t.test('collection and multi-format ingestion with source locations', async () => {
    const created = await request('POST', '/collections', { name: `Integration ${Date.now()}` });
    expectStatus(created, 201);
    collectionId = created.data.id;
    assert.ok(collectionId);
    const names = ['shipping.pdf', 'returns.docx', 'launch.pptx', 'metrics.xlsx', 'products.csv', 'policy.txt', 'onboarding.md', 'incident.html'];
    const uploaded = await upload(collectionId, names);
    expectStatus(uploaded, 202);
    assert.equal(uploaded.data.items.length, names.length);
    for (const item of uploaded.data.items) {
      const final = await waitForDocument(item.id);
      assert.equal(final.status, 'ready', `${final.name}: ${final.error}`);
      assert.ok(final.chunkCount > 0, `${final.name} must be searchable`);
      const chunks = await request('GET', `/documents/${item.id}/chunks`);
      expectStatus(chunks, 200);
      assert.ok(chunks.data.items.length > 0);
      assert.ok(chunks.data.items.every(chunk => chunk.location && chunk.text));
      documents.set(final.name, final);
    }
    const pdfChunks = await request('GET', `/documents/${documents.get('shipping.pdf').id}/chunks`);
    assert.ok(pdfChunks.data.items.some(chunk => chunk.location.page === 1), 'PDF page number should survive parsing');
    const slideChunks = await request('GET', `/documents/${documents.get('launch.pptx').id}/chunks`);
    assert.ok(slideChunks.data.items.some(chunk => chunk.location.slide === 1), 'PPTX slide number should survive parsing');
    const sheetChunks = await request('GET', `/documents/${documents.get('metrics.xlsx').id}/chunks`);
    assert.ok(sheetChunks.data.items.some(chunk => chunk.location.sheet), 'XLSX sheet name should survive parsing');
    assert.ok(sheetChunks.data.items.some(chunk => /Metric: Revenue; Value: 120000/.test(chunk.text) && chunk.location.row === 2),
      'XLSX row must keep its header and value together');
    const csvChunks = await request('GET', `/documents/${documents.get('products.csv').id}/chunks`);
    assert.ok(csvChunks.data.items.some(chunk => /product: Beacon; region: West; inventory: 73/.test(chunk.text) && chunk.location.row === 2),
      'CSV row must keep its header and value together');
  });

  await t.test('duplicate, empty and malformed uploads are not searchable', async () => {
    const duplicate = await upload(collectionId, ['policy.txt']);
    expectStatus(duplicate, 409);
    assert.equal(duplicate.data.error.code, 'DUPLICATE_DOCUMENT');
    const empty = await upload(collectionId, ['empty.txt']);
    assert.ok([202, 400, 422].includes(empty.status), JSON.stringify(empty.data));
    if (empty.status !== 202) assert.ok(empty.data.error?.code, 'Rejected empty file should have a structured error');
    if (empty.status === 202) {
      const final = await waitForDocument(empty.data.items[0].id);
      assert.equal(final.status, 'failed');
      assert.equal(final.chunkCount, 0);
    }
    const corrupt = await upload(collectionId, ['broken.pdf']);
    assert.ok([202, 400, 422].includes(corrupt.status), JSON.stringify(corrupt.data));
    if (corrupt.status !== 202) assert.ok(corrupt.data.error?.code, 'Rejected corrupt file should have a structured error');
    if (corrupt.status === 202) {
      const final = await waitForDocument(corrupt.data.items[0].id);
      assert.equal(final.status, 'failed');
      assert.equal(final.chunkCount, 0);
    }
    const unsupported = await upload(collectionId, ['unsupported.bin']);
    expectStatus(unsupported, 415);
  });

  await t.test('scanned PDF OCR status is conservative and actionable', {
    skip: process.env.RAG_TEST_OCR !== '1' && 'Set RAG_TEST_OCR=1 for the optional local OCR check'
  }, async () => {
    const before = await request('GET', '/config/status');
    expectStatus(before, 200);
    assert.ok(['untested', 'ready', 'unavailable'].includes(before.data.ocrStatus));
    assert.equal(before.data.ocrAvailable, before.data.ocrStatus === 'ready');
    const uploaded = await upload(collectionId, ['scanned.pdf'], true);
    expectStatus(uploaded, 202);
    const final = await waitForDocument(uploaded.data.items[0].id);
    const after = await request('GET', '/config/status');
    expectStatus(after, 200);
    if (final.status === 'ready') {
      assert.equal(after.data.ocrStatus, 'ready');
      assert.equal(after.data.ocrAvailable, true);
      const chunks = await request('GET', `/documents/${final.id}/chunks`);
      expectStatus(chunks, 200);
      assert.ok(chunks.data.items.some(chunk => /SCANNED\s+PROOF/i.test(chunk.text)),
        `OCR did not find the rendered text: ${JSON.stringify(chunks.data.items)}`);
    } else {
      assert.equal(after.data.ocrStatus, 'unavailable');
      assert.equal(after.data.ocrAvailable, false);
      assert.match(final.error || '', /OCR|asset|text|parser|timed out/i);
      assert.equal(final.chunkCount, 0);
    }
  });

  await t.test('baseline retrieval, filters and citations use real source IDs', async () => {
    const query = await request('POST', '/queries', {
      collectionId, question: 'How long is Aster warranty coverage?', mode: 'baseline', generate: false, topK: 6
    });
    expectStatus(query, 200);
    assert.equal(query.data.answerStatus, 'retrieval_only');
    assert.ok(query.data.sources.some(source => source.documentId === documents.get('policy.txt').id));
    assert.ok(query.data.trace.stages.some(stage => stage.name === 'lexical'));
    const filtered = await request('POST', '/queries', {
      collectionId, question: 'How long is Aster warranty coverage?', mode: 'baseline', generate: false,
      documentIds: [documents.get('shipping.pdf').id]
    });
    expectStatus(filtered, 200);
    assert.ok(filtered.data.sources.every(source => source.documentId === documents.get('shipping.pdf').id));
    const generated = await request('POST', '/queries', {
      collectionId, question: 'How long is Aster warranty coverage?', mode: 'baseline', generate: true
    });
    expectStatus(generated, 200);
    assert.ok(['answered', 'abstained'].includes(generated.data.answerStatus));
    const sourceIds = new Set(generated.data.sources.map(source => source.chunkId));
    assert.ok(generated.data.citations.every(citation => sourceIds.has(citation.chunkId)));
    const hybrid = await request('POST', '/queries', {
      collectionId, question: 'How long is Aster warranty coverage?', mode: 'hybrid', generate: false, topK: 6
    });
    expectStatus(hybrid, 200);
    const stages = hybrid.data.trace.stages.map(stage => stage.name);
    for (const required of ['lexical', 'semantic', 'fusion', 'rerank']) {
      assert.ok(stages.includes(required), `Hybrid trace lacks ${required}`);
    }
    assert.ok(hybrid.data.trace.stages.every(stage => stage.durationMs >= 0));
  });

  await t.test('evaluation compares local baseline and hybrid on the same case', async () => {
    const created = await request('POST', '/evaluations/cases', {
      collectionId,
      question: 'How long is Aster warranty coverage?',
      expectedDocumentIds: [documents.get('policy.txt').id],
      answerable: true
    });
    expectStatus(created, 201);
    const baseline = await request('POST', '/evaluations/runs', { collectionId, mode: 'baseline', topK: 6 });
    expectStatus(baseline, 201);
    assert.equal(baseline.data.caseCount, 1);
    assert.equal(typeof baseline.data.recallAtK, 'number');
    assert.equal(typeof baseline.data.mrr, 'number');
    assert.ok(baseline.data.results.length === 1);
    assert.notEqual(baseline.data.citationValidity, null, 'Answerable stub case should report citation validity');
    assert.ok(baseline.data.caseSetFingerprint);
    assert.ok(baseline.data.corpusFingerprint);
    const config = await request('GET', '/config/status');
    if (config.data.embeddingStatus === 'ready') {
      const hybrid = await request('POST', '/evaluations/runs', { collectionId, mode: 'hybrid', topK: 6 });
      expectStatus(hybrid, 201);
      assert.equal(hybrid.data.caseCount, baseline.data.caseCount);
      assert.equal(hybrid.data.caseSetFingerprint, baseline.data.caseSetFingerprint);
      assert.equal(hybrid.data.corpusFingerprint, baseline.data.corpusFingerprint);
    }
    const secondCase = await request('POST', '/evaluations/cases', {
      collectionId, question: 'What is the battery chemistry?', expectedDocumentIds: [], answerable: false
    });
    expectStatus(secondCase, 201);
    const changedCases = await request('POST', '/evaluations/runs', { collectionId, mode: 'baseline', topK: 6 });
    expectStatus(changedCases, 201);
    assert.notEqual(changedCases.data.caseSetFingerprint, baseline.data.caseSetFingerprint);
    assert.equal(changedCases.data.corpusFingerprint, baseline.data.corpusFingerprint);
    assert.equal(changedCases.data.recallAtK, baseline.data.recallAtK,
      'An unanswerable case must not lower retrieval recall');
    assert.equal(changedCases.data.mrr, baseline.data.mrr,
      'An unanswerable case must not lower reciprocal rank');

    const added = await upload(collectionId, ['incremental.txt']);
    expectStatus(added, 202);
    const final = await waitForDocument(added.data.items[0].id);
    assert.equal(final.status, 'ready');
    const changedCorpus = await request('POST', '/evaluations/runs', { collectionId, mode: 'baseline', topK: 6 });
    expectStatus(changedCorpus, 201);
    assert.equal(changedCorpus.data.caseSetFingerprint, changedCases.data.caseSetFingerprint);
    assert.notEqual(changedCorpus.data.corpusFingerprint, changedCases.data.corpusFingerprint);
  });

  await t.test('unsupported question does not yield a certain answer', async () => {
    const unsupported = await request('POST', '/queries', {
      collectionId,
      question: 'What is the battery chemistry?',
      documentIds: [documents.get('policy.txt').id],
      mode: 'hybrid',
      generate: true
    });
    expectStatus(unsupported, 200);
    assert.ok(
      unsupported.data.answerStatus === 'abstained' || /not enough|insufficient|no evidence|cannot determine/i.test(unsupported.data.answer || ''),
      `Unsupported question was answered as fact: ${JSON.stringify(unsupported.data)}`
    );

  });

  await t.test('conflicting evidence is qualified and cites both positions', async () => {
    const conflicts = await upload(collectionId, ['conflict-a.txt', 'conflict-b.txt']);
    expectStatus(conflicts, 202);
    const conflictDocs = [];
    for (const item of conflicts.data.items) {
      const final = await waitForDocument(item.id);
      assert.equal(final.status, 'ready');
      conflictDocs.push(final);
    }
    const answer = await request('POST', '/queries', {
      collectionId,
      question: 'When does the Helix support desk close on weekdays?',
      documentIds: conflictDocs.map(doc => doc.id),
      mode: 'hybrid',
      generate: true
    });
    expectStatus(answer, 200);
    if (answer.data.answerStatus !== 'abstained') {
      assert.match(answer.data.answer, /18:00/);
      assert.match(answer.data.answer, /20:00/);
      const citedDocuments = new Set(answer.data.citations.map(citation =>
        answer.data.sources.find(source => source.chunkId === citation.chunkId)?.documentId));
      assert.ok(conflictDocs.every(doc => citedDocuments.has(doc.id)),
        `Conflicting positions must both be cited: ${JSON.stringify(answer.data)}`);
    }
  });

  await t.test('deletion removes a document from subsequent results', async () => {
    const target = documents.get('policy.txt');
    const deleted = await request('DELETE', `/documents/${target.id}`);
    expectStatus(deleted, 204);
    const query = await request('POST', '/queries', {
      collectionId, question: 'Aster warranty coverage lasts how many months?', mode: 'baseline', generate: false
    });
    expectStatus(query, 200);
    assert.ok(query.data.sources.every(source => source.documentId !== target.id));
    const stats = await request('GET', '/stats');
    expectStatus(stats, 200);
    assert.ok(stats.data.documentCount >= 7);
  });
});
