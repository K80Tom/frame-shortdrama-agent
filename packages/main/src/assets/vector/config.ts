import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export interface AssetVectorConfig {
  embeddingEndpoint: string;
  embeddingModel: string;
  embeddingApiKey: string;
  embeddingTimeoutMs: number;
  milvusUri: string;
  milvusUser: string;
  milvusPassword: string;
  milvusCollection: string;
  queryCostMicros: number;
  manifestPath: string;
  revision: string;
}

/** Null means the optional vector enhancement is disabled and lexical RAG remains active. */
export function readAssetVectorConfig(
  env: NodeJS.ProcessEnv,
  options: { requireEnabled?: boolean } = {},
): AssetVectorConfig | null {
  const enabled = /^(?:1|true|yes)$/iu.test(env.ASSET_VECTOR_ENABLED?.trim() ?? '');
  if (!enabled && !options.requireEnabled) return null;
  const required = [
    'ASSET_EMBEDDING_ENDPOINT', 'ASSET_EMBEDDING_MODEL', 'ASSET_EMBEDDING_API_KEY', 'MILVUS_URI',
  ] as const;
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`向量检索已启用，但缺少配置：${missing.join('、')}`);
  const embeddingEndpoint = env.ASSET_EMBEDDING_ENDPOINT!.trim();
  try {
    const parsed = new URL(embeddingEndpoint);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('invalid endpoint');
    }
  } catch {
    throw new Error('ASSET_EMBEDDING_ENDPOINT 必须是不含凭据、查询参数或片段的完整 HTTPS 接口。');
  }
  const embeddingTimeoutMs = integer(env.ASSET_EMBEDDING_TIMEOUT_MS, 120_000, 1_000, 600_000,
    'ASSET_EMBEDDING_TIMEOUT_MS');
  const queryCostMicros = integer(env.ASSET_EMBEDDING_QUERY_COST_MICROS, 100_000, 0, 100_000_000,
    'ASSET_EMBEDDING_QUERY_COST_MICROS');
  const milvusUri = env.MILVUS_URI!.trim();
  if (/\s|\/\/[^/@\s]+:[^/@\s]+@/u.test(milvusUri)) throw new Error('MILVUS_URI 不能包含空白或内嵌凭据。');
  const milvusCollection = env.MILVUS_COLLECTION?.trim() || 'ohao_asset_vectors_v1';
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(milvusCollection)) throw new Error('MILVUS_COLLECTION 格式不正确。');
  const model = env.ASSET_EMBEDDING_MODEL!.trim();
  const revision = createHash('sha256').update(JSON.stringify({
    embeddingEndpoint, model, apiKey: env.ASSET_EMBEDDING_API_KEY!.trim(), embeddingTimeoutMs,
    milvusUri, milvusUser: env.MILVUS_USER?.trim() ?? '', milvusPassword: env.MILVUS_PASSWORD ?? '',
    milvusCollection,
  })).digest('hex');
  return {
    embeddingEndpoint, embeddingModel: model, embeddingApiKey: env.ASSET_EMBEDDING_API_KEY!.trim(),
    embeddingTimeoutMs, milvusUri, milvusUser: env.MILVUS_USER?.trim() ?? '',
    milvusPassword: env.MILVUS_PASSWORD ?? '', milvusCollection, queryCostMicros,
    manifestPath: resolve(env.ASSET_VECTOR_MANIFEST_PATH?.trim() || 'outputs/private/asset-vector-manifest.json'),
    revision,
  };
}

function integer(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const value = raw?.trim() ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min}-${max} 的整数。`);
  return value;
}
