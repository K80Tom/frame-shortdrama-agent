import type { AssetVectorConfig } from './config';
import { DoubaoAssetEmbeddingClient } from './embedding';
import { HybridAssetRetriever } from './hybrid';
import { MilvusAssetVectorStore } from './milvus';

export function createConfiguredAssetRetriever(config: AssetVectorConfig): HybridAssetRetriever {
  return new HybridAssetRetriever({
    embedding: new DoubaoAssetEmbeddingClient({ endpoint: config.embeddingEndpoint,
      model: config.embeddingModel, apiKey: config.embeddingApiKey, timeoutMs: config.embeddingTimeoutMs }),
    store: new MilvusAssetVectorStore({ uri: config.milvusUri, user: config.milvusUser,
      password: config.milvusPassword, collection: config.milvusCollection }),
    model: config.embeddingModel, revision: config.revision, queryCostMicros: config.queryCostMicros,
  });
}
