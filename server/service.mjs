import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LocalStore } from './store.mjs';
import { LocalEmbedder } from './embedding.mjs';
import { RetrievalEngine } from './retrieval.mjs';
import { formatOf, SUPPORTED_FORMATS } from './parser.mjs';
import { parseIsolatedDocument } from './isolated-parser.mjs';
import { generateAnswer } from './provider.mjs';

const timestamp = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const error = (status, code, message, details = {}) => Object.assign(new Error(message), { status, code, details });
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const MIN_ANSWER_CONFIDENCE = 0.3;

function collectionView(store, collection) {
  const docs = store.all('document', collection.id);
  return {
    ...collection,
    documentCount: docs.length,
    readyDocumentCount: docs.filter((d) => d.status === 'ready').length,
    chunkCount: docs.reduce((sum, d) => sum + (d.status === 'ready' ? d.chunkCount : 0), 0),
  };
}

function publicDocument(document) {
  const { filePath, ocrRequested, ...view } = document;
  return view;
}

export class RagService {
  constructor(config, options = {}) {
    this.config = config;
    this.store = new LocalStore(config.dataDir);
    this.embedder = options.embedder ?? new LocalEmbedder(config);
    this.parse = options.parse ?? parseIsolatedDocument;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.engine = new RetrievalEngine(this.store, this.embedder);
    this.jobs = Promise.resolve();
    this.ocrStatus = 'untested';
    for (const document of this.store.all('document')) {
      if (['queued', 'processing'].includes(document.status)) {
        this.store.put('document', { ...document, status: 'failed', progress: 0, error: 'Processing was interrupted. Retry this document.', updatedAt: timestamp() });
      }
    }
  }

  getCollection(collectionId) {
    const collection = this.store.get('collection', collectionId);
    if (!collection) throw error(404, 'NOT_FOUND', 'Collection not found.');
    return collectionView(this.store, collection);
  }

  listCollections(limit, cursor) {
    return this.store.page(this.store.all('collection').map((c) => collectionView(this.store, c)), limit, cursor);
  }

  createCollection({ name, description = '' }) {
    if (this.store.all('collection').some((c) => c.name.toLowerCase() === name.toLowerCase())) throw error(409, 'DUPLICATE_COLLECTION', 'A collection with this name already exists.');
    return collectionView(this.store, this.store.put('collection', { id: id(), name, description, createdAt: timestamp(), updatedAt: timestamp() }));
  }

  updateCollection(collectionId, patch) {
    const current = this.getCollection(collectionId);
    if (patch.name && this.store.all('collection').some((c) => c.id !== collectionId && c.name.toLowerCase() === patch.name.toLowerCase())) throw error(409, 'DUPLICATE_COLLECTION', 'A collection with this name already exists.');
    return collectionView(this.store, this.store.put('collection', { ...current, ...patch, updatedAt: timestamp() }));
  }

  async deleteCollection(collectionId) {
    this.getCollection(collectionId);
    for (const document of this.store.all('document', collectionId)) await this.deleteDocument(document.id);
    this.store.deleteWhere('eval_case', () => true, collectionId);
    this.store.deleteWhere('eval_run', () => true, collectionId);
    this.store.deleteWhere('query', () => true, collectionId);
    this.store.delete('collection', collectionId);
  }

  getDocument(documentId) {
    const value = this.store.get('document', documentId);
    if (!value) throw error(404, 'NOT_FOUND', 'Document not found.');
    return publicDocument(value);
  }

  listDocuments(collectionId, { limit, cursor, status } = {}) {
    this.getCollection(collectionId);
    return this.store.page(this.store.all('document', collectionId).filter((d) => !status || d.status === status).map(publicDocument), limit, cursor);
  }

  documentChunks(documentId, limit, cursor) {
    const document = this.getDocument(documentId);
    if (document.status !== 'ready') throw error(409, 'DOCUMENT_NOT_READY', 'This document is not searchable yet.');
    return this.store.page(this.store.all('chunk', document.collectionId).filter((c) => c.documentId === documentId).map((c) => ({
      id: c.id, chunkId: c.id, location: c.location, text: c.text, createdAt: c.createdAt,
    })), limit, cursor);
  }

  validateUpload(collectionId, files) {
    this.getCollection(collectionId);
    if (!files.length || files.length > 10) throw error(400, 'VALIDATION_ERROR', 'Upload 1 to 10 files.', { files: 'Upload 1 to 10 files.' });
    const existing = this.store.all('document', collectionId);
    if (existing.length + files.length > this.config.documentLimit) throw error(422, 'COLLECTION_LIMIT', 'This collection has reached its document limit.');
    const knownHashes = new Set(existing.map((d) => d.sha256));
    for (const file of files) {
      const format = formatOf(file.originalname);
      if (!SUPPORTED_FORMATS.includes(format)) throw error(415, 'UNSUPPORTED_FORMAT', `Unsupported file format: ${format || 'unknown'}.`);
      if (!file.buffer?.length) throw error(400, 'VALIDATION_ERROR', 'Empty files cannot be uploaded.', { files: 'Remove empty files.' });
      if (file.buffer.length > this.config.uploadLimitBytes) throw error(413, 'FILE_TOO_LARGE', 'File exceeds 25 MiB.');
      if (['docx', 'pptx', 'xlsx'].includes(format) && !file.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw error(400, 'VALIDATION_ERROR', `${file.originalname} is not a valid Office archive.`);
      if (format === 'pdf' && !file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw error(400, 'VALIDATION_ERROR', `${file.originalname} is not a PDF.`);
      const hash = sha256(file.buffer);
      if (knownHashes.has(hash)) throw error(409, 'DUPLICATE_DOCUMENT', `${file.originalname} already exists in this collection.`);
      knownHashes.add(hash);
    }
  }

  upload(collectionId, files, { ocr = false } = {}) {
    this.validateUpload(collectionId, files);
    const queued = [];
    for (const file of files) {
      const documentId = id();
      const format = formatOf(file.originalname);
      const filePath = path.join(this.store.filesDir, `${documentId}.${format}`);
      fs.writeFileSync(filePath, file.buffer, { flag: 'wx' });
      const document = this.store.put('document', {
        id: documentId, collectionId, name: path.basename(file.originalname).slice(0, 180), format,
        mimeType: file.mimetype || 'application/octet-stream', sizeBytes: file.buffer.length,
        sha256: sha256(file.buffer), status: 'queued', progress: 0, extractionMode: null,
        locationSummary: '', chunkCount: 0, warning: null, error: null,
        filePath, ocrRequested: ocr && format === 'pdf', createdAt: timestamp(), updatedAt: timestamp(),
      });
      queued.push(publicDocument(document));
      this.enqueue(documentId);
    }
    return { items: queued };
  }

  enqueue(documentId) {
    this.jobs = this.jobs.catch(() => null).then(() => this.processDocument(documentId));
  }

  async processDocument(documentId) {
    const document = this.store.get('document', documentId);
    if (!document || document.status !== 'queued') return;
    this.store.put('document', { ...document, status: 'processing', progress: 10, updatedAt: timestamp() });
    try {
      const parsed = await this.parse(document.filePath, document.format, { ocr: document.ocrRequested });
      if (!parsed.parts?.length) throw new Error('No searchable text found.');
      const chunks = [];
      let embeddingUnavailable = false;
      for (const [index, part] of parsed.parts.entries()) {
        const text = String(part.text ?? '').trim();
        if (!text) continue;
        let embedding = null;
        if (!embeddingUnavailable) {
          try { embedding = await this.embedder.embed(text); }
          catch (cause) {
            if (cause.code !== 'EMBEDDING_UNAVAILABLE') throw cause;
            embeddingUnavailable = true;
          }
        }
        chunks.push({
          id: id(), documentId, collectionId: document.collectionId, index, text,
          location: part.location, embedding, createdAt: timestamp(),
        });
        this.store.put('document', { ...document, status: 'processing', progress: Math.min(95, 20 + Math.round(75 * (index + 1) / parsed.parts.length)), updatedAt: timestamp() });
      }
      if (!chunks.length) throw new Error('No searchable text found.');
      const current = this.store.get('document', documentId);
      if (!current || current.status !== 'processing') return;
      const uniqueLocations = [...new Set(chunks.map((c) => c.location.type))];
      const warning = [
        parsed.warning,
        document.ocrRequested && !parsed.ocrVerified ? 'Local OCR did not yield recognized text; only the document text layer was indexed.' : null,
        embeddingUnavailable ? 'Local embeddings unavailable; baseline search remains available. Hybrid search will re-embed when the model is ready.' : null,
      ].filter(Boolean).join(' ');
      this.store.replaceChunks({ ...current, extractionMode: parsed.mode, locationSummary: uniqueLocations.join(', '), warning: warning || null }, chunks);
      if (document.ocrRequested) this.ocrStatus = parsed.ocrVerified ? 'ready' : 'unavailable';
      await this.engine.refresh();
    } catch (cause) {
      if (document.ocrRequested) this.ocrStatus = 'unavailable';
      const current = this.store.get('document', documentId);
      if (current) this.store.put('document', { ...current, status: 'failed', progress: 0, error: cause.code === 'EMBEDDING_UNAVAILABLE' ? 'Local embedding model unavailable. Check model download/cache and retry.' : cause.code === 'OCR_UNAVAILABLE' ? 'Local OCR unavailable. Check OCR language assets and retry.' : (cause.name === 'AbortError' ? 'Document parsing timed out.' : String(cause.message || 'Could not read document.').slice(0, 220)), updatedAt: timestamp() });
    }
  }

  retryDocument(documentId) {
    const document = this.store.get('document', documentId);
    if (!document) throw error(404, 'NOT_FOUND', 'Document not found.');
    if (document.status !== 'failed') throw error(409, 'DOCUMENT_NOT_READY', 'Only failed documents can be retried.');
    const queued = this.store.put('document', { ...document, status: 'queued', progress: 0, error: null, updatedAt: timestamp() });
    this.enqueue(documentId);
    return publicDocument(queued);
  }

  async deleteDocument(documentId) {
    const document = this.store.get('document', documentId);
    if (!document) throw error(404, 'NOT_FOUND', 'Document not found.');
    this.store.deleteWhere('chunk', (chunk) => chunk.documentId === documentId, document.collectionId);
    this.store.delete('document', documentId);
    try { fs.unlinkSync(document.filePath); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    await this.engine.refresh();
  }

  async ensureEmbeddings(collectionId) {
    const ready = new Set(this.store.all('document', collectionId).filter((d) => d.status === 'ready').map((d) => d.id));
    const missing = this.store.all('chunk', collectionId).filter((chunk) => ready.has(chunk.documentId) && !Array.isArray(chunk.embedding));
    if (!missing.length) return;
    for (const chunk of missing) {
      const embedding = await this.embedder.embed(chunk.text);
      this.store.put('chunk', { ...chunk, embedding });
    }
    for (const document of this.store.all('document', collectionId)) {
      if (ready.has(document.id) && document.warning?.includes('Local embeddings unavailable')) {
        this.store.put('document', { ...document, warning: null, updatedAt: timestamp() });
      }
    }
    await this.engine.refresh();
  }

  async query(request) {
    this.getCollection(request.collectionId);
    for (const docId of request.documentIds ?? []) {
      const doc = this.store.get('document', docId);
      if (!doc || doc.collectionId !== request.collectionId) throw error(404, 'NOT_FOUND', 'Filtered document not found in this collection.');
    }
    const started = performance.now();
    if (request.mode === 'hybrid') await this.ensureEmbeddings(request.collectionId);
    const { sources, trace, confidence } = await this.engine.retrieve(request);
    const generated = request.generate === false
      ? { answer: null, answerStatus: 'retrieval_only', citations: [] }
      : confidence < MIN_ANSWER_CONFIDENCE
        ? { answer: 'The selected documents do not contain enough evidence to answer.', answerStatus: 'abstained', citations: [] }
        : await generateAnswer(request.question, sources, this.config, { fetchImpl: this.fetchImpl });
    const result = this.store.put('query', {
      id: id(), collectionId: request.collectionId, question: request.question,
      mode: request.mode, answerStatus: generated.answerStatus, answer: generated.answer,
      citations: generated.citations, sources, trace, latencyMs: Math.round(performance.now() - started), createdAt: timestamp(),
    });
    return result;
  }

  listQueries(limit, cursor, collectionId = null) {
    return this.store.page(this.store.all('query', collectionId).map(({ id, collectionId: cid, question, answerStatus, answer, createdAt, latencyMs }) => ({ id, collectionId: cid, question, answerStatus, answer, createdAt, latencyMs })), limit, cursor);
  }

  stats(collectionId = null) {
    if (collectionId) this.getCollection(collectionId);
    const collections = this.store.all('collection');
    const docs = this.store.all('document', collectionId);
    const queries = this.store.all('query', collectionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const runs = this.store.all('eval_run', collectionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const formatCounts = [...new Set(docs.map((d) => d.format))].sort().map((format) => ({ format, count: docs.filter((d) => d.format === format).length }));
    return {
      collectionCount: collectionId ? 1 : collections.length,
      documentCount: docs.length,
      readyDocumentCount: docs.filter((d) => d.status === 'ready').length,
      failedDocumentCount: docs.filter((d) => d.status === 'failed').length,
      processingDocumentCount: docs.filter((d) => ['queued', 'processing'].includes(d.status)).length,
      chunkCount: docs.filter((d) => d.status === 'ready').reduce((sum, d) => sum + d.chunkCount, 0),
      formatCounts,
      recentQueries: queries.slice(0, 5).map(({ id: qid, question, latencyMs, answerStatus, createdAt }) => ({ id: qid, question, latencyMs, answerStatus, createdAt })),
      averageQueryLatencyMs: queries.length ? Math.round(queries.reduce((sum, q) => sum + q.latencyMs, 0) / queries.length) : null,
      evaluationRunCount: runs.length,
      lastEvaluationRun: runs[0] ? this.runSummary(runs[0]) : null,
    };
  }

  createCase({ collectionId, question, expectedDocumentIds, answerable }) {
    this.getCollection(collectionId);
    for (const docId of expectedDocumentIds) {
      const doc = this.store.get('document', docId);
      if (!doc || doc.collectionId !== collectionId) throw error(404, 'NOT_FOUND', 'Expected document not found in collection.');
    }
    return this.store.put('eval_case', { id: id(), collectionId, question, expectedDocumentIds, answerable, createdAt: timestamp() });
  }

  runSummary(run) {
    const { results, ...summary } = run;
    return summary;
  }

  evaluationFingerprints(collectionId, cases) {
    const normalizedCases = cases.map((item) => ({
      id: item.id,
      question: item.question,
      answerable: item.answerable,
      expectedDocumentIds: [...item.expectedDocumentIds].sort(),
    })).sort((a, b) => a.id.localeCompare(b.id));
    const readyDocuments = this.store.all('document', collectionId)
      .filter((document) => document.status === 'ready')
      .map((document) => ({ id: document.id, sha256: document.sha256 }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const readyIds = new Set(readyDocuments.map((document) => document.id));
    const chunks = this.store.all('chunk', collectionId)
      .filter((chunk) => readyIds.has(chunk.documentId))
      .map((chunk) => ({
        documentId: chunk.documentId,
        index: chunk.index,
        text: chunk.text,
        location: chunk.location,
      }))
      .sort((a, b) => a.documentId.localeCompare(b.documentId) || a.index - b.index);
    return {
      caseSetFingerprint: sha256(JSON.stringify(normalizedCases)),
      corpusFingerprint: sha256(JSON.stringify({
        embeddingModel: this.config.embeddingModel,
        readyDocuments,
        chunks,
      })),
    };
  }

  async runEvaluation({ collectionId, mode, topK }) {
    this.getCollection(collectionId);
    const cases = this.store.all('eval_case', collectionId);
    if (!cases.length) throw error(422, 'NO_EVALUATION_CASES', 'Add an evaluation case before running a benchmark.');
    if (mode === 'hybrid') await this.ensureEmbeddings(collectionId);
    const fingerprints = this.evaluationFingerprints(collectionId, cases);
    const results = [];
    for (const testCase of cases) {
      const started = performance.now();
      try {
        const { sources, confidence } = await this.engine.retrieve({ collectionId, question: testCase.question, documentIds: [], mode, topK });
        const retrievedDocumentIds = [...new Set(sources.map((s) => s.documentId))];
        const firstRank = sources.findIndex((s) => testCase.expectedDocumentIds.includes(s.documentId));
        const generated = confidence < MIN_ANSWER_CONFIDENCE
          ? { answerStatus: 'abstained', citations: [] }
          : await generateAnswer(testCase.question, sources, { ...this.config, modelMode: 'stub' });
        const citationValid = generated.citations.every((c) => sources.some((s) => s.chunkId === c.chunkId)) && (testCase.answerable ? generated.citations.length > 0 : generated.citations.length === 0);
        results.push({
          caseId: testCase.id, question: testCase.question, expectedDocumentIds: testCase.expectedDocumentIds, retrievedDocumentIds,
          hit: firstRank >= 0, reciprocalRank: firstRank >= 0 ? 1 / (firstRank + 1) : 0,
          citationValid, abstentionCorrect: testCase.answerable ? generated.answerStatus !== 'abstained' : generated.answerStatus === 'abstained',
          latencyMs: Math.round(performance.now() - started), error: null,
        });
      } catch (cause) {
        results.push({ caseId: testCase.id, question: testCase.question, expectedDocumentIds: testCase.expectedDocumentIds, retrievedDocumentIds: [], hit: false, reciprocalRank: 0, citationValid: false, abstentionCorrect: false, latencyMs: Math.round(performance.now() - started), error: String(cause.message).slice(0, 200) });
      }
    }
    const avg = (field) => results.reduce((sum, item) => sum + Number(item[field] ?? 0), 0) / results.length;
    const answerableIds = new Set(cases.filter((item) => item.answerable).map((item) => item.id));
    const answerableResults = results.filter((item) => answerableIds.has(item.caseId));
    const retrievalAvg = (field) => answerableResults.length
      ? answerableResults.reduce((sum, item) => sum + Number(item[field] ?? 0), 0) / answerableResults.length
      : null;
    const run = this.store.put('eval_run', {
      id: id(), collectionId, mode, topK, caseCount: cases.length, ...fingerprints,
      recallAtK: retrievalAvg('hit'), mrr: retrievalAvg('reciprocalRank'), citationValidity: avg('citationValid'),
      abstentionAccuracy: avg('abstentionCorrect'), averageLatencyMs: Math.round(avg('latencyMs')),
      results, createdAt: timestamp(),
    });
    return run;
  }

  configStatus() {
    return {
      nvidiaConfigured: Boolean(this.config.nvidiaApiKey), modelMode: this.config.modelMode, model: this.config.nvidiaModel,
      embeddingStatus: this.embedder.status, embeddingModel: this.config.embeddingModel,
      ocrAvailable: this.ocrStatus === 'ready', ocrStatus: this.ocrStatus,
      supportedFormats: SUPPORTED_FORMATS, uploadLimitBytes: this.config.uploadLimitBytes, localOnly: true,
    };
  }

  close() { this.store.close(); }
}

export { error };
