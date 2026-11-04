import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = path.join(repo, 'tests/integration/fixtures/policy.txt');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function json(base, route, method = 'GET', body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  return { status: response.status, data: raw ? JSON.parse(raw) : null, raw };
}

async function ready(base, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await json(base, '/health');
      if (result.status === 200) return;
    } catch { /* startup pending */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('API did not become healthy in time');
}

test('local fake NVIDIA failures preserve corpus and hide credentials', async () => {
  const workingDir = await mkdtemp(path.join(tmpdir(), 'pro-rag-provider-test-'));
  const apiPort = await freePort();
  const fakePort = await freePort();
  const apiBase = `http://127.0.0.1:${apiPort}/api/v1`;
  let mode = 'unauthorized';
  const fake = http.createServer((request, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    request.resume();
    if (mode === 'timeout') return;
    const status = { unauthorized: 401, rate_limit: 429, upstream: 500 }[mode] || 200;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(status === 200
      ? { choices: [{ message: { content: 'Warranty lasts 24 months [S1].' } }] }
      : { error: { message: 'local simulated failure' } }));
  });
  await new Promise(resolve => fake.listen(fakePort, '127.0.0.1', resolve));
  const child = spawn(process.execPath, [path.join(repo, 'server/main.mjs')], {
    cwd: workingDir,
    env: {
      ...process.env,
      PORT: String(apiPort),
      DATA_DIR: path.join(workingDir, 'data'),
      EMBEDDING_MODE: 'stub',
      MODEL_MODE: 'nvidia',
      NVIDIA_API_KEY: 'local-dummy-token',
      NVIDIA_MODEL: 'local-fault-model',
      NVIDIA_BASE_URL: `http://127.0.0.1:${fakePort}/v1`,
      NVIDIA_TIMEOUT_MS: '250'
    },
    stdio: 'pipe'
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });

  try {
    await ready(apiBase);
    const created = await json(apiBase, '/collections', 'POST', { name: 'Fault test' });
    assert.equal(created.status, 201);
    const collectionId = created.data.id;
    const bytes = await readFile(fixture);
    const form = new FormData();
    form.set('collectionId', collectionId);
    form.append('files', new Blob([bytes]), 'policy.txt');
    const upload = await fetch(`${apiBase}/documents`, { method: 'POST', body: form });
    assert.equal(upload.status, 202);
    const documentId = (await upload.json()).items[0].id;
    let document;
    for (let i = 0; i < 50; i++) {
      document = (await json(apiBase, `/documents/${documentId}`)).data;
      if (document.status === 'ready') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(document.status, 'ready');

    for (const [faultMode, expectedStatus, expectedCode] of [
      ['unauthorized', 502, 'NVIDIA_UNAUTHORIZED'],
      ['rate_limit', 502, 'NVIDIA_RATE_LIMITED'],
      ['upstream', 502, 'NVIDIA_UPSTREAM_ERROR'],
      ['timeout', 504, 'NVIDIA_TIMEOUT']
    ]) {
      mode = faultMode;
      const answer = await json(apiBase, '/queries', 'POST', {
        collectionId, question: 'How long is Aster warranty coverage?', mode: 'baseline', generate: true
      });
      assert.equal(answer.status, expectedStatus, `${faultMode}: ${JSON.stringify(answer.data)}`);
      assert.equal(answer.data.error.code, expectedCode);
      assert.doesNotMatch(answer.raw, /local-dummy-token/);
      const retrieval = await json(apiBase, '/queries', 'POST', {
        collectionId, question: 'How long is Aster warranty coverage?', mode: 'baseline', generate: false
      });
      assert.equal(retrieval.status, 200);
      assert.ok(retrieval.data.sources.some(source => source.documentId === documentId));
    }
    assert.doesNotMatch(output, /local-dummy-token/);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    await new Promise(resolve => fake.close(resolve));
    await rm(workingDir, { recursive: true, force: true });
  }
});
