import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.mjs';
import { generateAnswer, parseReply } from './provider.mjs';
import { conflictingEvidence } from './provider.mjs';

function fixtureConfig(dataDir, overrides = {}) {
  return {
    dataDir, port: 0, modelMode: 'stub', embeddingMode: 'stub', embeddingModel: 'stub',
    nvidiaApiKey: '', nvidiaModel: 'stub', nvidiaBaseUrl: '', nvidiaTimeoutMs: 1000,
    uploadLimitBytes: 25 * 1024 * 1024, documentLimit: 100, ...overrides,
  };
}

async function harness(t, overrides = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pro-rag-test-'));
  const { app, service } = createApp(fixtureConfig(dataDir, overrides));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    service.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  async function request(route, { method = 'GET', body, form } = {}) {
    const response = await fetch(base + route, {
      method,
      headers: form ? undefined : body === undefined ? undefined : { 'content-type': 'application/json' },
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: response.status, data: response.status === 204 ? null : await response.json() };
  }
  return { service, request };
}

test('document lifecycle, hybrid trace, citations, evaluation, and deletion', async (t) => {
  const { service, request } = await harness(t);
  const collection = (await request('/collections', { method: 'POST', body: { name: 'Demo' } })).data;
  const form = new FormData();
  form.set('collectionId', collection.id);
  form.append('files', new Blob(['Warranty coverage lasts 24 months from purchase.\nReturns are accepted within 30 days.'], { type: 'text/plain' }), 'warranty.txt');
  const uploaded = await request('/documents', { method: 'POST', form });
  assert.equal(uploaded.status, 202);
  await service.jobs;
  const document = (await request(`/documents/${uploaded.data.items[0].id}`)).data;
  assert.equal(document.status, 'ready');
  assert.ok(document.chunkCount > 0);
  const chunks = await request(`/documents/${document.id}/chunks`);
  assert.equal(chunks.status, 200);
  assert.match(chunks.data.items[0].text, /24 months/);
  const answer = await request('/queries', { method: 'POST', body: { collectionId: collection.id, question: 'What is the warranty coverage period?', mode: 'hybrid', generate: true } });
  assert.equal(answer.status, 200);
  assert.equal(answer.data.answerStatus, 'answered');
  assert.ok(answer.data.sources.length > 0);
  assert.ok(answer.data.citations.every((c) => answer.data.sources.some((s) => s.chunkId === c.chunkId)));
  assert.deepEqual(answer.data.trace.stages.map((s) => s.name), ['lexical', 'semantic', 'fusion', 'rerank']);
  const testCase = await request('/evaluations/cases', { method: 'POST', body: { collectionId: collection.id, question: 'What is the warranty coverage period?', expectedDocumentIds: [document.id], answerable: true } });
  assert.equal(testCase.status, 201);
  const advanced = await request('/evaluations/runs', { method: 'POST', body: { collectionId: collection.id, mode: 'hybrid' } });
  const baseline = await request('/evaluations/runs', { method: 'POST', body: { collectionId: collection.id, mode: 'baseline' } });
  assert.equal(advanced.status, 201);
  assert.equal(baseline.status, 201);
  assert.equal(advanced.data.recallAtK, 1);
  assert.equal(advanced.data.citationValidity, 1);
  assert.ok(Number.isFinite(baseline.data.citationValidity));
  const stats = (await request('/stats')).data;
  assert.equal(stats.readyDocumentCount, 1);
  assert.equal(stats.evaluationRunCount, 2);
  assert.equal((await request(`/documents/${document.id}`, { method: 'DELETE' })).status, 204);
  const after = await request('/queries', { method: 'POST', body: { collectionId: collection.id, question: 'What is the warranty coverage period?', mode: 'hybrid', generate: false } });
  assert.equal(after.status, 200);
  assert.equal(after.data.sources.length, 0);
});

test('duplicate, malformed, and empty uploads return safe errors', async (t) => {
  const { service, request } = await harness(t);
  const collection = (await request('/collections', { method: 'POST', body: { name: 'Errors' } })).data;
  const makeForm = (name, content) => {
    const form = new FormData();
    form.set('collectionId', collection.id);
    form.append('files', new Blob([content]), name);
    return form;
  };
  const first = await request('/documents', { method: 'POST', form: makeForm('one.txt', 'A useful warranty statement.') });
  assert.equal(first.status, 202);
  await service.jobs;
  const duplicate = await request('/documents', { method: 'POST', form: makeForm('two.txt', 'A useful warranty statement.') });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.error.code, 'DUPLICATE_DOCUMENT');
  const malformed = await request('/documents', { method: 'POST', form: makeForm('bad.pdf', 'not a pdf') });
  assert.equal(malformed.status, 400);
  assert.equal((await request('/stats')).data.documentCount, 1);
});

test('provider rejects invented markers and missing citations', () => {
  const sources = [{ chunkId: 'source-one', snippet: 'A fact' }];
  assert.equal(parseReply('Fact [S2]', sources).answerStatus, 'abstained');
  assert.equal(parseReply('Fact without a citation', sources).answerStatus, 'abstained');
  assert.equal(parseReply('[S1]', sources).answerStatus, 'abstained');
  assert.deepEqual(parseReply('Fact [S1]', sources).citations, [{ marker: 'S1', chunkId: 'source-one' }]);
});

test('provider identifies a network-denied NVIDIA call without leaking the key', async () => {
  const blocked = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(), { code: 'EACCES' }) });
  const source = { chunkId: 'sample', documentId: 'sample-doc', documentName: 'sample.txt', snippet: 'The sample warranty lasts 24 months.', location: {} };
  const config = { modelMode: 'nvidia', nvidiaApiKey: 'test-secret', nvidiaModel: 'sample-model', nvidiaBaseUrl: 'https://example.invalid/v1', nvidiaTimeoutMs: 1000 };
  await assert.rejects(
    generateAnswer('What is the warranty?', [source], config, { fetchImpl: async () => { throw blocked; } }),
    (error) => error.code === 'NVIDIA_NETWORK_DENIED' && error.status === 503 && !error.message.includes('test-secret'),
  );
});

test('offline embedding failure preserves baseline retrieval and reports hybrid degradation', async (t) => {
  const unavailable = Object.assign(new Error('Model unavailable'), { code: 'EMBEDDING_UNAVAILABLE', status: 503 });
  const embedder = { status: 'unavailable', embed: async () => { throw unavailable; } };
  const { service, request } = await harness(t, { embeddingMode: 'local' });
  service.embedder = embedder;
  service.engine.embedder = embedder;
  const collection = (await request('/collections', { method: 'POST', body: { name: 'Offline' } })).data;
  const form = new FormData();
  form.set('collectionId', collection.id);
  form.append('files', new Blob(['The warranty term lasts 24 months from purchase.']), 'offline.txt');
  const uploaded = await request('/documents', { method: 'POST', form });
  await service.jobs;
  const document = (await request(`/documents/${uploaded.data.items[0].id}`)).data;
  assert.equal(document.status, 'ready');
  assert.match(document.warning, /baseline search remains available/);
  const baseline = await request('/queries', { method: 'POST', body: { collectionId: collection.id, question: 'What is the warranty term?', mode: 'baseline', generate: false } });
  assert.equal(baseline.status, 200);
  assert.equal(baseline.data.sources.length, 1);
  const hybrid = await request('/queries', { method: 'POST', body: { collectionId: collection.id, question: 'What is the warranty term?', mode: 'hybrid', generate: false } });
  assert.equal(hybrid.status, 503);
  assert.equal(hybrid.data.error.code, 'EMBEDDING_UNAVAILABLE');
});

test('conflicting source claims produce a qualified, doubly cited abstention', () => {
  const sources = [
    { chunkId: 'a', documentId: 'doc-a', documentName: 'conflict-a.txt', snippet: 'The Helix support desk closes at 18:00 on weekdays.' },
    { chunkId: 'b', documentId: 'doc-b', documentName: 'conflict-b.txt', snippet: 'The Helix support desk closes at 20:00 on weekdays.' },
  ];
  const result = conflictingEvidence('When does the Helix support desk close on weekdays?', sources);
  assert.equal(result.answerStatus, 'abstained');
  assert.equal(result.citations.length, 2);
  assert.match(result.answer, /18:00.*20:00/);
});

test('hyphenated warranty durations in different policies trigger conflict handling', () => {
  const sources = [
    { chunkId: 'current', documentId: 'current-doc', documentName: 'current-policy.md', snippet: 'Northstar Devices provides a 24-month limited hardware warranty from the purchase date.' },
    { chunkId: 'legacy', documentId: 'legacy-doc', documentName: 'legacy-policy.md', snippet: 'The legacy limited hardware warranty lasts 12 months from the purchase date.' },
  ];
  const result = conflictingEvidence('How long is the Northstar Devices hardware warranty?', sources);
  assert.equal(result.answerStatus, 'abstained');
  assert.match(result.answer, /24 month.*12 months/);
  assert.deepEqual(result.citations.map((citation) => citation.chunkId), ['current', 'legacy']);
});
