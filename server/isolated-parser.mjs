import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('./parse-worker.mjs', import.meta.url));

export function parseIsolatedDocument(filePath, format, options = {}) {
  return new Promise((resolve, reject) => {
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(name)));
    const child = fork(workerPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [], env: cleanEnv });
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error(message), { code: options.ocr ? 'OCR_UNAVAILABLE' : 'PARSER_FAILED' }));
    };
    const timer = setTimeout(() => {
      child.kill();
      fail(options.ocr ? 'Local OCR timed out. Check language assets and retry.' : 'Document parsing timed out.');
    }, options.ocr ? 130000 : 55000);
    child.on('message', (reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reply?.ok) resolve(reply.value);
      else reject(Object.assign(new Error(reply?.message ?? 'Document parsing failed.'), { code: reply?.code ?? (options.ocr ? 'OCR_UNAVAILABLE' : 'PARSER_FAILED') }));
    });
    child.on('error', (cause) => fail(`Parser process could not start: ${cause.message}`));
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!settled) fail(options.ocr ? 'Local OCR process failed. Check language assets and retry.' : `Document parser process failed (${code}).`);
    });
    child.send({ filePath, format, options });
  });
}
