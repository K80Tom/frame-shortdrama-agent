import type { TenantContext } from '../../tenancy/context';

export type VectorStoreScope = Pick<TenantContext, 'workspaceId'>;

export class VectorStoreUnavailableError extends Error {
  readonly code = 'UNAVAILABLE';
  constructor(message = 'Vector projection is unavailable') {
    super(message);
    this.name = 'VectorStoreUnavailableError';
  }
}

export interface VectorProjectionRecord {
  projectId: string | null;
  assetId: string;
  chunkId: string;
  sourceVersion: string;
  kind: string;
  text: string;
  textHash: string;
  embeddingModel: string;
  vector: number[];
}

export interface VectorSearchQuery {
  projectId?: string;
  kind: string;
  vector: number[];
  limit?: number;
}

export interface VectorSearchHit {
  assetId: string;
  chunkId: string;
  sourceVersion: string;
  score: number;
}

/** Rebuildable projection only; PostgreSQL must hydrate and authorize every hit. */
export interface VectorStore {
  upsert(scope: VectorStoreScope, record: VectorProjectionRecord): Promise<void>;
  search(scope: VectorStoreScope, query: VectorSearchQuery): Promise<VectorSearchHit[]>;
  deleteByAssetIds(scope: VectorStoreScope, assetIds: string[], projectId?: string): Promise<void>;
}

/** Disabled vector mode. Callers should catch this and keep lexical retrieval available. */
export class NoopVectorStore implements VectorStore {
  async upsert(_scope: VectorStoreScope, _record: VectorProjectionRecord): Promise<void> {
    throw new VectorStoreUnavailableError();
  }
  async search(_scope: VectorStoreScope, _query: VectorSearchQuery): Promise<VectorSearchHit[]> {
    throw new VectorStoreUnavailableError();
  }
  async deleteByAssetIds(_scope: VectorStoreScope, _assetIds: string[], _projectId?: string): Promise<void> {
    throw new VectorStoreUnavailableError();
  }
}
