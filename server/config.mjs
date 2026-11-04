import fs from 'node:fs';
import path from 'node:path';

export function loadConfig(overrides = {}) {
  const envPath = ['.env', '.ENV'].find((file) => fs.existsSync(file));
  if (envPath && typeof process.loadEnvFile === 'function') process.loadEnvFile(envPath);
  const env = process.env;
  const dataDir = path.resolve(overrides.dataDir ?? env.DATA_DIR ?? './data');
  return {
    port: Number(overrides.port ?? env.PORT ?? 8787),
    dataDir,
    nvidiaApiKey: overrides.nvidiaApiKey ?? env.NVIDIA_API_KEY ?? env.nvidia_api_key ?? '',
    nvidiaModel: overrides.nvidiaModel ?? env.NVIDIA_MODEL ?? 'nvidia/nemotron-3.5-lightning-30b-a3b',
    nvidiaBaseUrl: overrides.nvidiaBaseUrl ?? env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
    nvidiaTimeoutMs: Number(overrides.nvidiaTimeoutMs ?? env.NVIDIA_TIMEOUT_MS ?? 30000),
    nvidiaEnableThinking: overrides.nvidiaEnableThinking ?? env.NVIDIA_ENABLE_THINKING === 'true',
    embeddingModel: overrides.embeddingModel ?? env.EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2',
    modelCacheDir: path.resolve(overrides.modelCacheDir ?? env.MODEL_CACHE_DIR ?? './data/models'),
    modelMode: overrides.modelMode ?? env.MODEL_MODE ?? 'nvidia',
    embeddingMode: overrides.embeddingMode ?? env.EMBEDDING_MODE ?? 'local',
    uploadLimitBytes: 25 * 1024 * 1024,
    documentLimit: 100,
  };
}
