/** Local NVIDIA-compatible fault server for manual/automated API error tests. */
import http from 'node:http';

const mode = process.env.FAULT_MODE || 'ok';
const port = Number(process.env.FAULT_PORT || 9999);
const statuses = { unauthorized: 401, rate_limit: 429, upstream: 500 };

const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Not found' } }));
    return;
  }
  request.resume();
  if (mode === 'timeout') return;
  const status = statuses[mode] || 200;
  response.writeHead(status, { 'content-type': 'application/json' });
  if (status === 200) {
    response.end(JSON.stringify({
      id: 'local-fault-provider',
      choices: [{ index: 0, message: { role: 'assistant', content: 'The warranty is 24 months [S1].' }, finish_reason: 'stop' }]
    }));
  } else {
    response.end(JSON.stringify({ error: { message: `simulated ${mode}` } }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Local fault provider listening on 127.0.0.1:${port} in ${mode} mode`);
});
