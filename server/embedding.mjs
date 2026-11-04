import path from 'node:path';

const DIMENSION = 384;

// A deterministic fixture embedder used only when explicitly enabled by tests.
export function stubEmbedding(text) {
  const vector = new Array(DIMENSION).fill(0);
  for (const token of String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 2166136261;
    for (const char of token) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    vector[(hash >>> 0) % DIMENSION] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

export class LocalEmbedder {
  constructor(config) {
    this.config = config;
    this.status = config.embeddingMode === 'stub' ? 'ready' : 'loading';
    this.pipelinePromise = null;
  }

  async embed(text) {
    if (this.config.embeddingMode === 'stub') return stubEmbedding(text);
    try {
      if (!this.pipelinePromise) {
        this.pipelinePromise = (async () => {
          const { pipeline, env } = await import('@huggingface/transformers');
          env.cacheDir = this.config.modelCacheDir ?? path.join(this.config.dataDir, 'models');
          const instance = await pipeline('feature-extraction', this.config.embeddingModel, { dtype: 'q8' });
          this.status = 'ready';
          return instance;
        })();
      }
      const extractor = await this.pipelinePromise;
      const result = await extractor(String(text), { pooling: 'mean', normalize: true });
      const values = Array.from(result.data);
      if (values.length !== DIMENSION || values.some((value) => !Number.isFinite(value))) throw new Error('Embedding model returned an unexpected vector.');
      return values;
    } catch (error) {
      this.pipelinePromise = null;
      this.status = 'unavailable';
      throw Object.assign(new Error('Local embedding model is unavailable. Check model download/cache and retry.'), { code: 'EMBEDDING_UNAVAILABLE', status: 503, cause: error });
    }
  }
}

export { DIMENSION };
