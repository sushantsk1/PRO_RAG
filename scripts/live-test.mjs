import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.RAG_LIVE_TEST !== '1') {
  console.error('Set RAG_LIVE_TEST=1 to allow four live NVIDIA answer requests.');
  process.exit(2);
}

const base = process.env.RAG_BASE_URL?.replace(/\/$/, '');
if (!base) throw new Error('Set RAG_BASE_URL to the isolated live API URL.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function request(route, body) {
  const response = await fetch(`${base}${route}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status, 200, `${route}: ${JSON.stringify(data.error ?? data)}`);
  return data;
}

const config = await request('/config/status');
assert.equal(config.modelMode, 'nvidia', 'The server must run with MODEL_MODE=nvidia.');
assert.equal(config.nvidiaConfigured, true, 'The server must have an NVIDIA API key.');
const collections = await request('/collections?limit=100');
const collection = collections.items.find((item) => item.name === 'Northstar Support');
assert.ok(collection, 'Run node scripts/seed-demo.mjs against this API first.');
const documents = await request(`/documents?collectionId=${collection.id}&limit=100`);
const expectedNames = ['current-policy.md', 'legacy-policy.md', 'support-metrics.csv'];
assert.equal(documents.items.length, expectedNames.length, 'Use an isolated collection with only the three synthetic demo files.');
const ids = {};
for (const name of expectedNames) {
  const document = documents.items.find((item) => item.name === name);
  assert.ok(document && document.status === 'ready', `${name} must be indexed.`);
  const bytes = await readFile(path.join(root, 'docs', 'demo', name));
  assert.equal(document.sha256, createHash('sha256').update(bytes).digest('hex'), `${name} must match the repository sample.`);
  ids[name] = document.id;
}

const cases = [
  {
    name: 'current policy with date scope', question: 'What is the warranty period for purchases after September 2026?',
    documentIds: [], status: 'answered', answer: /24.month/i, cited: ['current-policy.md'],
  },
  {
    name: 'legacy policy', question: 'How long did the legacy hardware warranty last?',
    documentIds: [ids['legacy-policy.md']], status: 'answered', answer: /12 months/i, cited: ['legacy-policy.md'],
  },
  {
    name: 'support hours', question: 'When is live support available?',
    documentIds: [ids['current-policy.md']], status: 'answered', answer: /Monday through Friday.*09:00.*18:00.*India Standard Time/i, cited: ['current-policy.md'],
  },
  {
    name: 'CSV row answer', question: 'How many tickets did South have in August 2026?',
    documentIds: [ids['support-metrics.csv']], status: 'answered', answer: /\b110\b/, cited: ['support-metrics.csv'], row: 5,
  },
  {
    name: 'unsupported fact', question: 'What is the device battery chemistry?',
    documentIds: [ids['current-policy.md']], status: 'abstained', answer: /not contain enough evidence|not enough|cannot determine/i, cited: [],
  },
  {
    name: 'ambiguous policy versions', question: 'How long is the Northstar Devices hardware warranty?',
    documentIds: [ids['current-policy.md'], ids['legacy-policy.md']], status: 'abstained',
    answer: /24 month.*12 months/i, cited: ['current-policy.md', 'legacy-policy.md'],
  },
];

for (const item of cases) {
  const result = await request('/queries', {
    collectionId: collection.id, question: item.question, documentIds: item.documentIds,
    mode: 'hybrid', generate: true, topK: 6,
  });
  assert.equal(result.answerStatus, item.status, `${item.name}: ${result.answer}`);
  assert.match(result.answer, item.answer, item.name);
  assert.doesNotMatch(result.answer, /The source states:/, `${item.name}: stub output is not a live answer.`);
  const sources = new Map(result.sources.map((source) => [source.chunkId, source]));
  const citedNames = [];
  for (const citation of result.citations) {
    assert.ok(sources.has(citation.chunkId), `${item.name}: citation must resolve to a source.`);
    assert.ok(result.answer.includes(`[${citation.marker}]`), `${item.name}: citation marker must appear in the answer.`);
    const source = sources.get(citation.chunkId);
    citedNames.push(source.documentName);
    if (item.row) assert.equal(source.location.row, item.row, `${item.name}: cited row`);
  }
  for (const name of item.cited) assert.ok(citedNames.includes(name), `${item.name}: missing citation to ${name}.`);
  if (item.status === 'answered') assert.ok(result.citations.length > 0, `${item.name}: answer needs a citation.`);
  console.log(`PASS ${item.name}: ${result.answerStatus}; ${result.answer}; citations=${citedNames.join(',') || 'none'}`);
}

console.log('Six live-mode cases passed. Four answer cases called NVIDIA; two abstention guards used local checks.');
