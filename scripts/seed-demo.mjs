import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = (process.env.RAG_BASE_URL || 'http://127.0.0.1:8787/api/v1').replace(/\/$/, '');
const collectionName = 'Northstar Support';
const names = ['current-policy.md', 'legacy-policy.md', 'support-metrics.csv'];

async function request(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options);
  if (response.status === 204) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status} at ${route}`);
  return body;
}

async function waitUntilReady(documentId) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const document = await request(`/documents/${documentId}`);
    if (document.status === 'ready') return document;
    if (document.status === 'failed') throw new Error(`${document.name}: ${document.error || 'ingestion failed'}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Document ${documentId} did not finish within two minutes.`);
}

async function main() {
  const collections = await request('/collections?limit=100');
  let collection = collections.items.find((item) => item.name === collectionName);
  if (!collection) {
    collection = await request('/collections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: collectionName, description: 'Original sample policies and support metrics for a quota-free RAG demo.' }),
    });
  }

  const current = await request(`/documents?collectionId=${collection.id}&limit=100`);
  const existing = new Map(current.items.map((item) => [item.name, item]));
  const missing = names.filter((name) => !existing.has(name));
  if (missing.length) {
    const form = new FormData();
    form.set('collectionId', collection.id);
    form.set('ocr', 'false');
    for (const name of missing) {
      const bytes = await readFile(path.join(root, 'docs', 'demo', name));
      form.append('files', new Blob([bytes]), name);
    }
    const uploaded = await request('/documents', { method: 'POST', body: form });
    for (const item of uploaded.items) existing.set(item.name, item);
  }
  for (const name of names) existing.set(name, await waitUntilReady(existing.get(name).id));

  const cases = await request(`/evaluations/cases?collectionId=${collection.id}&limit=100`);
  const knownQuestions = new Set(cases.items.map((item) => item.question));
  const examples = [
    { question: 'What is the warranty for purchases after September 2026?', expected: ['current-policy.md'], answerable: true },
    { question: 'How long did the legacy hardware warranty last?', expected: ['legacy-policy.md'], answerable: true },
    { question: 'What is the device battery chemistry?', expected: [], answerable: false },
  ];
  for (const item of examples) {
    if (knownQuestions.has(item.question)) continue;
    await request('/evaluations/cases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        collectionId: collection.id,
        question: item.question,
        expectedDocumentIds: item.expected.map((name) => existing.get(name).id),
        answerable: item.answerable,
      }),
    });
  }

  console.log(`Demo ready: ${collectionName} (${collection.id}), ${names.length} indexed files, ${examples.length} evaluation questions.`);
  console.log('Open http://127.0.0.1:5173. This script makes no NVIDIA request.');
}

main().catch((error) => {
  console.error(`Demo seeding failed: ${error.message}`);
  process.exitCode = 1;
});
