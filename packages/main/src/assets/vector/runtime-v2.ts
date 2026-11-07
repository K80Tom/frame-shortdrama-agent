import { NoopVectorStore, type VectorStore, type VectorStoreScope } from '../../infrastructure/vector-store';
import { tenantExecutionScope, type TenantExecutionScope } from '../../tenancy/scope';
import {
  ASSET_RETRIEVAL_HYBRID_RULE_VERSION,
  retrieveAssetForGeneration,
  type AssetRetriever,
} from '../retrieval';
import type { AssetVectorConfig } from './config';
import { DoubaoAssetEmbeddingClient, type AssetEmbeddingClient } from './embedding';
import { HybridAssetRetriever } from './hybrid';
import type { AssetVectorStore } from './milvus';
import {
  MilvusAssetVectorStoreV2, type MilvusAssetVectorStoreV2Dependencies,
} from './milvus-v2';
import { ScopedAssetVectorStoreV2 } from './scoped-v2';

export interface MilvusV2Config {
  enabled: boolean;
  uri: string;
  user: string;
  password: string;
  collection: string;
}

export interface AssetVectorV2Runtime {
  enabled: boolean;
  collection: string;
  store: VectorStore;
  bind(scope: VectorStoreScope, projectId?: string | null): AssetVectorStore;
  probe(): Promise<boolean>;
}

export function readMilvusV2Config(env: NodeJS.ProcessEnv): MilvusV2Config {
  const enabledRaw = env.MILVUS_ENABLED ?? env.ASSET_VECTOR_ENABLED;
  const enabled = /^(?:1|true|yes)$/iu.test(enabledRaw?.trim() ?? '');
  const uri = (env.MILVUS_URI ?? env.MILVUS_ADDRESS ?? '').trim();
  if (enabled && !uri) throw new Error('Milvus v2 已启用，但缺少 MILVUS_URI/MILVUS_ADDRESS。');
  if (uri && (/\s/u.test(uri) || /\/\/[^/@\s]+:[^/@\s]+@/u.test(uri))) {
    throw new Error('Milvus 地址不能包含空白或内嵌凭据。');
  }
  const collection = env.MILVUS_COLLECTION_V2?.trim() || 'lyra_asset_vectors_v2';
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(collection)) {
    throw new Error('MILVUS_COLLECTION_V2 格式不正确。');
  }
  return { enabled, uri, user: env.MILVUS_USER?.trim() ?? '', password: env.MILVUS_PASSWORD ?? '', collection };
}

/** Lazy Milvus runtime: constructing it never creates a collection or performs network I/O. */
export function createAssetVectorV2Runtime(env: NodeJS.ProcessEnv,
  dependencies: MilvusAssetVectorStoreV2Dependencies = {}): AssetVectorV2Runtime {
  const config = readMilvusV2Config(env);
  const milvus = config.enabled
    ? new MilvusAssetVectorStoreV2({ uri: config.uri, user: config.user,
      password: config.password, collection: config.collection }, dependencies) : null;
  const store: VectorStore = milvus ?? new NoopVectorStore();
  return { enabled: config.enabled, collection: config.collection, store,
    bind: (scope, projectId = null) => new ScopedAssetVectorStoreV2(store, scope, projectId),
    probe: async () => {
      if (!milvus) return false;
      try { return await milvus.probe(); }
      catch { return false; }
    } };
}

/**
 * Semantic retrieval binds Milvus only after an authenticated request or
 * claimed Worker job has entered a tenant scope. An unscoped caller performs
 * no paid embedding call and falls back to the PostgreSQL-hydrated lexical path.
 */
export function createTenantAwareAssetRetriever(config: AssetVectorConfig,
  runtime: AssetVectorV2Runtime, dependencies: {
    embedding?: AssetEmbeddingClient;
    executionScope?: Pick<TenantExecutionScope, 'current'>;
  } = {}): AssetRetriever {
  const semanticProvider = { model: config.embeddingModel, revision: config.revision,
    queryCostMicros: config.queryCostMicros };
  const embedding = dependencies.embedding ?? new DoubaoAssetEmbeddingClient({ endpoint: config.embeddingEndpoint,
    model: config.embeddingModel, apiKey: config.embeddingApiKey, timeoutMs: config.embeddingTimeoutMs });
  const executionScope = dependencies.executionScope ?? tenantExecutionScope;
  return {
    semanticProvider,
    async retrieve(query, assets, policy) {
      const current = executionScope.current();
      if (!runtime.enabled || current?.kind !== 'tenant') {
        const lexical = retrieveAssetForGeneration(query, assets, policy);
        return { ...lexical, ruleVersion: ASSET_RETRIEVAL_HYBRID_RULE_VERSION,
          mode: 'hybrid_semantic_lexical', semantic: { status: 'degraded', attempted: false,
            model: config.embeddingModel, candidateCount: 0, reason: 'projection_unavailable' } };
      }
      return new HybridAssetRetriever({ embedding,
        store: runtime.bind({ workspaceId: current.tenant.workspaceId }),
        model: config.embeddingModel, revision: config.revision,
        queryCostMicros: config.queryCostMicros }).retrieve(query, assets, policy);
    },
  };
}
