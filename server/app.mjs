import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { RagService, error } from './service.mjs';

function object(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw error(400, 'VALIDATION_ERROR', 'Expected a JSON object.');
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw error(400, 'VALIDATION_ERROR', 'Unknown request fields.', { fields: unknown.join(', ') });
  return body;
}

function str(value, field, min, max, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) throw error(400, 'VALIDATION_ERROR', `Invalid ${field}.`, { [field]: `Use ${min} to ${max} characters.` });
  return value.trim();
}

function bool(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw error(400, 'VALIDATION_ERROR', `Invalid ${field}.`, { [field]: 'Use true or false.' });
  return value;
}

function count(value, field, fallback, min, max) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw error(400, 'VALIDATION_ERROR', `Invalid ${field}.`, { [field]: `Use an integer from ${min} to ${max}.` });
  return number;
}

function ids(value, field, max = 100) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || !/^[0-9a-f-]{36}$/.test(item))) throw error(400, 'VALIDATION_ERROR', `Invalid ${field}.`, { [field]: 'Use an array of document IDs.' });
  return [...new Set(value)];
}

export function createApp(config, options = {}) {
  const app = express();
  const service = new RagService(config, options);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.uploadLimitBytes, files: 10, fields: 2 } });
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (origin) {
      if (!['http://127.0.0.1:5173', 'http://localhost:5173'].includes(origin)) return next(error(403, 'ORIGIN_FORBIDDEN', 'This local API only accepts the local dashboard origin.'));
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  const api = express.Router();

  api.get('/health', (_req, res) => res.json({ status: 'ok', version: '1', time: new Date().toISOString(), indexStatus: service.engine.index ? 'ready' : 'building' }));
  api.get('/config/status', (_req, res) => res.json(service.configStatus()));

  api.get('/collections', (req, res) => res.json(service.listCollections(req.query.limit, req.query.cursor)));
  api.post('/collections', (req, res) => {
    const body = object(req.body, ['name', 'description']);
    res.status(201).json(service.createCollection({ name: str(body.name, 'name', 1, 80), description: body.description === undefined ? '' : str(body.description, 'description', 0, 500) }));
  });
  api.patch('/collections/:id', (req, res) => {
    const body = object(req.body, ['name', 'description']);
    if (!Object.keys(body).length) throw error(400, 'VALIDATION_ERROR', 'No update fields supplied.');
    const patch = {};
    if (body.name !== undefined) patch.name = str(body.name, 'name', 1, 80);
    if (body.description !== undefined) patch.description = str(body.description, 'description', 0, 500);
    res.json(service.updateCollection(req.params.id, patch));
  });
  api.delete('/collections/:id', async (req, res) => { await service.deleteCollection(req.params.id); res.sendStatus(204); });

  api.post('/documents', upload.array('files', 10), (req, res) => {
    const collectionId = str(req.body.collectionId, 'collectionId', 36, 36);
    const ocr = req.body.ocr === undefined ? false : req.body.ocr === 'true' ? true : req.body.ocr === 'false' ? false : null;
    if (ocr === null) throw error(400, 'VALIDATION_ERROR', 'Invalid ocr flag.', { ocr: 'Use true or false.' });
    res.status(202).json(service.upload(collectionId, req.files ?? [], { ocr }));
  });
  api.get('/documents', (req, res) => {
    const collectionId = str(req.query.collectionId, 'collectionId', 36, 36);
    const status = req.query.status;
    if (status !== undefined && !['queued', 'processing', 'ready', 'failed'].includes(status)) throw error(400, 'VALIDATION_ERROR', 'Invalid status filter.');
    res.json(service.listDocuments(collectionId, { limit: req.query.limit, cursor: req.query.cursor, status }));
  });
  api.get('/documents/:id', (req, res) => res.json(service.getDocument(req.params.id)));
  api.get('/documents/:id/chunks', (req, res) => res.json(service.documentChunks(req.params.id, req.query.limit, req.query.cursor)));
  api.post('/documents/:id/retry', (req, res) => res.status(202).json(service.retryDocument(req.params.id)));
  api.delete('/documents/:id', async (req, res) => { await service.deleteDocument(req.params.id); res.sendStatus(204); });

  api.post('/queries', async (req, res) => {
    const body = object(req.body, ['collectionId', 'question', 'documentIds', 'mode', 'topK', 'generate']);
    const mode = body.mode ?? 'hybrid';
    if (!['baseline', 'hybrid'].includes(mode)) throw error(400, 'VALIDATION_ERROR', 'Invalid retrieval mode.');
    res.json(await service.query({
      collectionId: str(body.collectionId, 'collectionId', 36, 36),
      question: str(body.question, 'question', 2, 2000),
      documentIds: ids(body.documentIds, 'documentIds'),
      mode, topK: count(body.topK, 'topK', 6, 1, 20), generate: bool(body.generate, 'generate', true),
    }));
  });
  api.get('/queries', (req, res) => res.json(service.listQueries(req.query.limit, req.query.cursor, req.query.collectionId ?? null)));
  api.get('/queries/:id', (req, res) => {
    const result = service.store.get('query', req.params.id);
    if (!result) throw error(404, 'NOT_FOUND', 'Query not found.');
    res.json(result);
  });
  api.get('/stats', (req, res) => res.json(service.stats(req.query.collectionId ?? null)));

  api.get('/evaluations/cases', (req, res) => res.json(service.store.page(service.store.all('eval_case', req.query.collectionId ?? null), req.query.limit, req.query.cursor)));
  api.post('/evaluations/cases', (req, res) => {
    const body = object(req.body, ['collectionId', 'question', 'expectedDocumentIds', 'answerable']);
    const answerable = bool(body.answerable, 'answerable', true);
    const expectedDocumentIds = ids(body.expectedDocumentIds, 'expectedDocumentIds');
    if (answerable && !expectedDocumentIds.length) throw error(400, 'VALIDATION_ERROR', 'Answerable cases need an expected document.', { expectedDocumentIds: 'Select at least one source.' });
    res.status(201).json(service.createCase({ collectionId: str(body.collectionId, 'collectionId', 36, 36), question: str(body.question, 'question', 2, 2000), expectedDocumentIds, answerable }));
  });
  api.delete('/evaluations/cases/:id', (req, res) => {
    if (!service.store.delete('eval_case', req.params.id)) throw error(404, 'NOT_FOUND', 'Evaluation case not found.');
    res.sendStatus(204);
  });
  api.post('/evaluations/runs', async (req, res) => {
    const body = object(req.body, ['collectionId', 'mode', 'topK']);
    if (!['baseline', 'hybrid'].includes(body.mode)) throw error(400, 'VALIDATION_ERROR', 'Invalid retrieval mode.');
    res.status(201).json(await service.runEvaluation({ collectionId: str(body.collectionId, 'collectionId', 36, 36), mode: body.mode, topK: count(body.topK, 'topK', 6, 1, 20) }));
  });
  api.get('/evaluations/runs', (req, res) => res.json(service.store.page(service.store.all('eval_run', req.query.collectionId ?? null).map((run) => service.runSummary(run)), req.query.limit, req.query.cursor)));
  api.get('/evaluations/runs/:id', (req, res) => {
    const run = service.store.get('eval_run', req.params.id);
    if (!run) throw error(404, 'NOT_FOUND', 'Evaluation run not found.');
    res.json(run);
  });

  app.use('/api/v1', api);
  app.use((req, res, next) => next(error(404, 'NOT_FOUND', 'Route not found.')));
  app.use((cause, req, res, _next) => {
    const requestId = crypto.randomUUID();
    let status = Number(cause.status ?? cause.statusCode ?? 500);
    let code = cause.code ?? 'INTERNAL_ERROR';
    let message = cause.message ?? 'Unexpected server error.';
    if (cause instanceof multer.MulterError) {
      status = cause.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      code = cause.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'VALIDATION_ERROR';
      message = cause.code === 'LIMIT_FILE_SIZE' ? 'File exceeds 25 MiB.' : 'Invalid upload.';
    }
    if (cause.type === 'entity.too.large') { status = 413; code = 'VALIDATION_ERROR'; message = 'JSON body exceeds 1 MiB.'; }
    if (cause instanceof SyntaxError && 'body' in cause) { status = 400; code = 'VALIDATION_ERROR'; message = 'Malformed JSON body.'; }
    if (!Number.isInteger(status) || status < 400 || status > 599) status = 500;
    if (status === 500) { code = 'INTERNAL_ERROR'; message = 'Unexpected server error.'; }
    res.status(status).json({ error: { code, message, details: cause.details ?? {}, requestId } });
  });

  return { app, service };
}
