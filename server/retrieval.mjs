import { create, insert, search } from '@orama/orama';
import { DIMENSION } from './embedding.mjs';

const now = () => performance.now();
const tokens = (text) => [...new Set(String(text).toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((word) => word.length > 2 && !['the', 'and', 'what', 'how', 'does', 'for', 'with', 'from', 'this', 'that', 'are'].includes(word));

function scoreRerank(question, candidate) {
  const q = tokens(question);
  const words = new Set(tokens(candidate.text));
  const coverage = q.length ? q.filter((term) => words.has(term)).length / q.length : 0;
  const phrase = candidate.text.toLowerCase().includes(question.toLowerCase().trim()) ? 1 : 0;
  const semantic = Math.max(0, candidate.scores.semantic ?? 0);
  const lexical = Math.min(1, Math.max(0, candidate.scores.lexical ?? 0) / 5);
  return 0.45 * coverage + 0.3 * semantic + 0.2 * lexical + 0.05 * phrase;
}

export class RetrievalEngine {
  constructor(store, embedder) {
    this.store = store;
    this.embedder = embedder;
    this.index = null;
    this.indexPromise = this.rebuild();
  }

  async rebuild() {
    const db = await create({ schema: { id: 'string', collectionId: 'string', documentId: 'string', text: 'string', embedding: `vector[${DIMENSION}]` } });
    const ready = new Set(this.store.all('document').filter((d) => d.status === 'ready').map((d) => d.id));
    for (const chunk of this.store.all('chunk')) {
      if (!ready.has(chunk.documentId)) continue;
      const indexed = { id: chunk.id, collectionId: chunk.collectionId, documentId: chunk.documentId, text: chunk.text };
      if (Array.isArray(chunk.embedding) && chunk.embedding.length === DIMENSION) indexed.embedding = chunk.embedding;
      await insert(db, indexed);
    }
    this.index = db;
    return db;
  }

  refresh() {
    this.indexPromise = this.indexPromise.catch(() => null).then(() => this.rebuild());
    return this.indexPromise;
  }

  async retrieve({ collectionId, question, documentIds = [], mode = 'hybrid', topK = 6 }) {
    await this.indexPromise;
    const where = documentIds.length
      ? { and: [{ collectionId }, { documentId: documentIds }] }
      : { collectionId };
    const stages = [];
    const start = now();
    const lexicalResult = await search(this.index, { term: question, properties: ['text'], mode: 'fulltext', limit: Math.max(topK * 4, 24), where });
    const lexicalHits = lexicalResult.hits ?? [];
    stages.push({ name: 'lexical', durationMs: Math.round(now() - start), candidateCount: lexicalHits.length });
    let semanticHits = [];
    if (mode === 'hybrid') {
      const t = now();
      const vector = await this.embedder.embed(question);
      const result = await search(this.index, { mode: 'vector', vector: { value: vector, property: 'embedding' }, similarity: 0, limit: Math.max(topK * 4, 24), where });
      semanticHits = result.hits ?? [];
      stages.push({ name: 'semantic', durationMs: Math.round(now() - t), candidateCount: semanticHits.length });
    }
    const tFusion = now();
    const rank = new Map();
    for (const [kind, hits] of [['lexical', lexicalHits], ['semantic', semanticHits]]) {
      hits.forEach((hit, index) => {
        const id = hit.document.id;
        const entry = rank.get(id) ?? { id, scores: { lexical: null, semantic: null, fusion: 0, rerank: null } };
        entry.scores[kind] = hit.score;
        entry.scores.fusion += 1 / (60 + index + 1);
        rank.set(id, entry);
      });
    }
    const fused = [...rank.values()].sort((a, b) => b.scores.fusion - a.scores.fusion).slice(0, Math.max(topK * 3, 18));
    stages.push({ name: 'fusion', durationMs: Math.round(now() - tFusion), candidateCount: fused.length });
    const tRerank = now();
    const documents = new Map(this.store.all('document', collectionId).map((d) => [d.id, d]));
    const candidates = fused.map((entry) => {
      const chunk = this.store.get('chunk', entry.id);
      if (!chunk || !documents.has(chunk.documentId) || documents.get(chunk.documentId).status !== 'ready') return null;
      const score = scoreRerank(question, { ...chunk, scores: entry.scores });
      return { ...chunk, scores: { ...entry.scores, rerank: score } };
    }).filter(Boolean).sort((a, b) => b.scores.rerank - a.scores.rerank).slice(0, topK);
    stages.push({ name: 'rerank', durationMs: Math.round(now() - tRerank), candidateCount: candidates.length });
    const sources = candidates.map((chunk) => ({
      chunkId: chunk.id,
      documentId: chunk.documentId,
      collectionId: chunk.collectionId,
      documentName: documents.get(chunk.documentId)?.name ?? 'Unknown',
      location: chunk.location,
      snippet: chunk.text.slice(0, 1000),
      scores: chunk.scores,
    }));
    const confidence = candidates.length ? candidates[0].scores.rerank : 0;
    return { sources, trace: { stages, reranker: 'heuristic', filters: { documentIds } }, confidence };
  }
}
