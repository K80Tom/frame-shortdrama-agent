import type { AssetKind } from '@lyra/shared';
import type { VectorStore, VectorStoreScope } from '../../infrastructure/vector-store';
import type { AssetVectorHit, AssetVectorRecord, AssetVectorStore } from './milvus';

/**
 * Compatibility bridge for the current HybridAssetRetriever. A request/runtime
 * must bind one authenticated workspace; no global default workspace is used.
 * textHash is the v2 source version until a PostgreSQL projection revision lands.
 */
export class ScopedAssetVectorStoreV2 implements AssetVectorStore {
  constructor(private readonly store: VectorStore, private readonly scope: VectorStoreScope,
    private readonly projectId: string | null = null) {}

  async upsert(record: AssetVectorRecord): Promise<void> {
    await this.store.upsert(this.scope, {
      projectId: this.projectId, assetId: record.assetId, chunkId: `asset:${record.assetId}`,
      sourceVersion: record.textHash, kind: record.kind, text: record.text, textHash: record.textHash,
      embeddingModel: record.embeddingModel, vector: record.vector,
    });
  }

  async search(vector: number[], kind: AssetKind, limit = 12): Promise<AssetVectorHit[]> {
    return (await this.store.search(this.scope, {
      ...(this.projectId ? { projectId: this.projectId } : {}), kind, vector, limit,
    })).map(hit => ({ assetId: hit.assetId, score: hit.score, sourceVersion: hit.sourceVersion }));
  }

  async deleteByAssetIds(assetIds: string[]): Promise<void> {
    await this.store.deleteByAssetIds(this.scope, assetIds, this.projectId ?? undefined);
  }
}
