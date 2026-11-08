import type { AssetKind } from '@lyra/shared';
import { AssetVectorContractError, AssetVectorError } from './errors';

export interface AssetVectorRecord {
  assetId: string;
  kind: AssetKind;
  vector: number[];
  text: string;
  textHash: string;
  embeddingModel: string;
}
export interface AssetVectorHit {
  assetId: string;
  score: number;
  /** v2 projections expose the fact-source version; legacy v1 hits omit it. */
  sourceVersion?: string;
}

interface MilvusClientLike {
  hasCollection(input: { collection_name: string } | string): Promise<boolean | { value: boolean }> | boolean | { value: boolean };
  loadCollection(input: { collection_name: string } | string): Promise<unknown>;
  createCollection(input: Record<string, unknown>): Promise<unknown>;
  upsert(input: Record<string, unknown>): Promise<unknown>;
  search(input: Record<string, unknown>): Promise<unknown>;
  deleteEntities(input: Record<string, unknown>): Promise<unknown>;
}
interface MilvusModuleLike {
  MilvusClient?: new (options: Record<string, unknown>) => MilvusClientLike;
  DataType?: Record<string, unknown>;
  MetricType?: Record<string, unknown>;
}
export interface MilvusAssetVectorStoreDependencies {
  client?: MilvusClientLike;
  moduleValue?: MilvusModuleLike;
}
export interface AssetVectorStore {
  upsert(record: AssetVectorRecord): Promise<void>;
  search(vector: number[], kind: AssetKind, limit?: number): Promise<AssetVectorHit[]>;
  deleteByAssetIds(assetIds: string[]): Promise<void>;
}

const OUTPUT_FIELDS = ['asset_id', 'kind', 'text_hash', 'embedding_model'] as const;

/** Lazy SDK loading keeps the default lexical-only installation offline and testable. */
export class MilvusAssetVectorStore implements AssetVectorStore {
  private client: MilvusClientLike | undefined;
  private moduleValue: MilvusModuleLike | undefined;
  private initialized = false;

  constructor(private readonly options: {
    uri: string;
    user: string;
    password: string;
    collection: string;
  }, dependencies: MilvusAssetVectorStoreDependencies = {}) {
    this.client = dependencies.client;
    this.moduleValue = dependencies.moduleValue;
  }

  async upsert(record: AssetVectorRecord): Promise<void> {
    validateVector(record.vector);
    const client = await this.readyClient(true, record.vector.length);
    await client.upsert({ collection_name: this.options.collection, data: [{
      id: vectorId(record.assetId), vector: record.vector, asset_id: record.assetId, kind: record.kind,
      text: record.text.slice(0, 8192), text_hash: record.textHash, embedding_model: record.embeddingModel,
    }] });
  }

  async search(vector: number[], kind: AssetKind, limit = 12): Promise<AssetVectorHit[]> {
    validateVector(vector);
    // A search must never create a collection as a side effect.
    const client = await this.readyClient(false);
    const searchLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 12;
    const result: unknown = await client.search({
      collection_name: this.options.collection, data: [vector], limit: searchLimit,
      output_fields: [...OUTPUT_FIELDS], metric_type: 'COSINE',
      params: { ef: Math.min(512, Math.max(64, searchLimit * 2)) },
      expr: `kind == ${JSON.stringify(kind)}`,
    });
    const rows = result && typeof result === 'object' && !Array.isArray(result)
      && Array.isArray((result as { results?: unknown }).results)
      ? (result as { results: unknown[] }).results
      : Array.isArray(result) && Array.isArray(result[0]) ? result[0] : null;
    if (!rows) throw new AssetVectorContractError('Milvus search returned an unrecognized response');
    const best = new Map<string, number>();
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue;
      const value = raw as Record<string, unknown>;
      const entity = value.entity && typeof value.entity === 'object' ? value.entity as Record<string, unknown> : value;
      const assetId = typeof entity.asset_id === 'string' ? entity.asset_id : '';
      const score = typeof value.distance === 'number' ? value.distance : Number(value.score ?? value.distance);
      if (assetId && Number.isFinite(score)) best.set(assetId, Math.max(best.get(assetId) ?? -1, score));
    }
    return [...best].map(([assetId, score]) => ({ assetId, score }))
      .sort((left, right) => right.score - left.score || left.assetId.localeCompare(right.assetId));
  }

  async deleteByAssetIds(assetIds: string[]): Promise<void> {
    const ids = [...new Set(assetIds.filter(Boolean))];
    if (!ids.length) return;
    let client: MilvusClientLike;
    try { client = await this.readyClient(false); }
    catch (error) { if (error instanceof AssetVectorError) return; throw error; }
    await client.deleteEntities({ collection_name: this.options.collection,
      expr: `id in [${ids.map(id => JSON.stringify(vectorId(id))).join(', ')}]` });
  }

  private async readyClient(createIfMissing: boolean, vectorDimension?: number): Promise<MilvusClientLike> {
    if (!this.client) {
      const moduleValue = this.module();
      if (!moduleValue.MilvusClient) throw new AssetVectorError('MilvusClient is unavailable');
      this.client = new moduleValue.MilvusClient({
        address: this.options.uri.replace(/^https?:\/\//u, '').replace(/\/$/u, ''),
        username: this.options.user || undefined, password: this.options.password || undefined, timeout: 8_000,
      });
    }
    const client = this.client;
    if (!this.initialized) {
      const response = await client.hasCollection({ collection_name: this.options.collection });
      const exists = typeof response === 'boolean' ? response : response.value === true;
      if (!exists) {
        if (!createIfMissing) throw new AssetVectorError('Configured asset vector collection is unavailable');
        if (!vectorDimension) throw new AssetVectorContractError('Vector dimension is required to create the collection');
        const moduleValue = this.module();
        const dataType = moduleValue.DataType ?? {};
        const metricType = moduleValue.MetricType ?? {};
        await client.createCollection({
          collection_name: this.options.collection,
          fields: [
            { name: 'id', data_type: dataType.VarChar ?? 'VarChar', is_primary_key: true, max_length: 128 },
            { name: 'vector', data_type: dataType.FloatVector ?? 'FloatVector', dim: vectorDimension },
            { name: 'asset_id', data_type: dataType.VarChar ?? 'VarChar', max_length: 96 },
            { name: 'kind', data_type: dataType.VarChar ?? 'VarChar', max_length: 16 },
            { name: 'text', data_type: dataType.VarChar ?? 'VarChar', max_length: 8192 },
            { name: 'text_hash', data_type: dataType.VarChar ?? 'VarChar', max_length: 64 },
            { name: 'embedding_model', data_type: dataType.VarChar ?? 'VarChar', max_length: 256 },
          ],
          index_params: [{ field_name: 'vector', index_type: 'HNSW',
            metric_type: metricType.COSINE ?? 'COSINE', params: { M: 16, efConstruction: 200 } }],
        });
      }
      await client.loadCollection({ collection_name: this.options.collection });
      this.initialized = true;
    }
    return client;
  }

  private module(): MilvusModuleLike {
    if (this.moduleValue) return this.moduleValue;
    try { this.moduleValue = require('@zilliz/milvus2-sdk-node') as MilvusModuleLike; return this.moduleValue; }
    catch { throw new AssetVectorError('@zilliz/milvus2-sdk-node is not available'); }
  }
}

function vectorId(assetId: string): string { return `asset:${assetId}`; }
function validateVector(vector: number[]): void {
  if (!vector.length || vector.length > 16_384 || vector.some(value => !Number.isFinite(value))) {
    throw new AssetVectorContractError('A finite, non-empty vector is required');
  }
}
