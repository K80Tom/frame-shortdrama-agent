import { createHash } from 'node:crypto';
import type { AssetKind } from '@lyra/shared';
import { parseWorkspaceId } from '../../tenancy/context';
import type {
  VectorProjectionRecord, VectorSearchHit, VectorSearchQuery, VectorStore, VectorStoreScope,
} from '../../infrastructure/vector-store';
import { AssetVectorContractError, AssetVectorError } from './errors';

interface MilvusV2ClientLike {
  checkHealth?(): Promise<unknown>;
  getVersion?(): Promise<unknown>;
  hasCollection(input: { collection_name: string } | string): Promise<boolean | { value: boolean }> | boolean | { value: boolean };
  loadCollection(input: { collection_name: string } | string): Promise<unknown>;
  createCollection(input: Record<string, unknown>): Promise<unknown>;
  upsert(input: Record<string, unknown>): Promise<unknown>;
  search(input: Record<string, unknown>): Promise<unknown>;
  deleteEntities(input: Record<string, unknown>): Promise<unknown>;
}
interface MilvusV2ModuleLike {
  MilvusClient?: new (options: Record<string, unknown>) => MilvusV2ClientLike;
  DataType?: Record<string, unknown>;
  MetricType?: Record<string, unknown>;
}
export interface MilvusAssetVectorStoreV2Dependencies {
  client?: MilvusV2ClientLike;
  moduleValue?: MilvusV2ModuleLike;
}

const OUTPUT_FIELDS = [
  'workspace_id', 'project_id', 'asset_id', 'chunk_id', 'source_version', 'kind',
  'text_hash', 'embedding_model',
] as const;

/** Tenant-safe v2 projection. The legacy v1 class remains available for rollback/read-only observation. */
export class MilvusAssetVectorStoreV2 implements VectorStore {
  private client: MilvusV2ClientLike | undefined;
  private moduleValue: MilvusV2ModuleLike | undefined;
  private initialized = false;

  constructor(private readonly options: {
    uri: string;
    user: string;
    password: string;
    collection: string;
  }, dependencies: MilvusAssetVectorStoreV2Dependencies = {}) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(options.collection)) {
      throw new AssetVectorContractError('Milvus v2 collection name is invalid');
    }
    this.client = dependencies.client;
    this.moduleValue = dependencies.moduleValue;
  }

  /** Connectivity-only probe. It never creates or loads a collection. */
  async probe(): Promise<boolean> {
    const client = this.rawClient();
    try {
      if (client.checkHealth) {
        const response = await client.checkHealth();
        if (typeof response === 'boolean') return response;
        if (response && typeof response === 'object') {
          const value = (response as { isHealthy?: unknown; is_healthy?: unknown }).isHealthy
            ?? (response as { is_healthy?: unknown }).is_healthy;
          return value === true;
        }
        return false;
      }
      if (client.getVersion) {
        const response = await client.getVersion();
        if (typeof response === 'string') return response.trim().length > 0;
        return Boolean(response && typeof response === 'object'
          && typeof (response as { version?: unknown }).version === 'string'
          && (response as { version: string }).version.trim());
      }
      throw new AssetVectorError('Milvus health probe is unavailable');
    } catch (error) {
      if (error instanceof AssetVectorError) throw error;
      throw new AssetVectorError('Milvus health probe failed');
    }
  }

  async upsert(scope: VectorStoreScope, raw: VectorProjectionRecord): Promise<void> {
    const workspaceId = parseWorkspaceId(scope.workspaceId);
    const record = validateRecord(raw);
    const client = await this.readyClient(true, record.vector.length);
    await client.upsert({ collection_name: this.options.collection, data: [{
      id: vectorId(workspaceId, record), workspace_id: workspaceId, project_id: record.projectId ?? '',
      asset_id: record.assetId, chunk_id: record.chunkId, source_version: record.sourceVersion,
      kind: record.kind, text: record.text.slice(0, 8192), text_hash: record.textHash,
      embedding_model: record.embeddingModel, vector: record.vector,
    }] });
  }

  async search(scope: VectorStoreScope, raw: VectorSearchQuery): Promise<VectorSearchHit[]> {
    const workspaceId = parseWorkspaceId(scope.workspaceId);
    const query = validateQuery(raw);
    // An empty PostgreSQL-authorized set is authoritative: return no rows instead
    // of dropping the filter and letting Milvus widen the candidate set.
    if (query.assetIds !== undefined && query.assetIds.length === 0) return [];
    // Search is read-only and must never provision a missing collection.
    const client = await this.readyClient(false);
    const limit = Number.isSafeInteger(query.limit) ? Math.min(Math.max(query.limit!, 1), 100) : 12;
    const filters = [`workspace_id == ${literal(workspaceId)}`, `kind == ${literal(query.kind)}`];
    if (query.projectId) filters.push(`project_id == ${literal(query.projectId)}`);
    if (query.assetIds?.length) filters.push(`asset_id in [${query.assetIds.map(literal).join(', ')}]`);
    const result = await client.search({
      collection_name: this.options.collection, data: [query.vector], limit,
      output_fields: [...OUTPUT_FIELDS], metric_type: 'COSINE',
      params: { ef: Math.min(512, Math.max(64, limit * 2)) }, expr: filters.join(' and '),
    });
    const rows = searchRows(result);
    const best = new Map<string, VectorSearchHit>();
    for (const rawRow of rows) {
      if (!rawRow || typeof rawRow !== 'object') continue;
      const row = rawRow as Record<string, unknown>;
      const entity = row.entity && typeof row.entity === 'object'
        ? row.entity as Record<string, unknown> : row;
      // Defense in depth: never trust a backend result that violates the scalar filter.
      if (entity.workspace_id !== workspaceId || entity.kind !== query.kind
        || (query.projectId && entity.project_id !== query.projectId)
        || (query.assetIds?.length && !query.assetIds.includes(validScalarOrEmpty(entity.asset_id)))) continue;
      const assetId = validScalarOrEmpty(entity.asset_id);
      const chunkId = validScalarOrEmpty(entity.chunk_id);
      const sourceVersion = validScalarOrEmpty(entity.source_version);
      const score = typeof row.distance === 'number' ? row.distance : Number(row.score ?? row.distance);
      if (!assetId || !chunkId || !sourceVersion || !Number.isFinite(score)) continue;
      const key = `${assetId}\0${chunkId}\0${sourceVersion}`;
      const previous = best.get(key);
      if (!previous || score > previous.score) best.set(key, { assetId, chunkId, sourceVersion, score });
    }
    return [...best.values()].sort((left, right) => right.score - left.score
      || left.assetId.localeCompare(right.assetId) || left.chunkId.localeCompare(right.chunkId));
  }

  async deleteByAssetIds(scope: VectorStoreScope, rawIds: string[], rawProjectId?: string): Promise<void> {
    const workspaceId = parseWorkspaceId(scope.workspaceId);
    const ids = [...new Set(rawIds.map(validScalar).filter(Boolean))];
    if (!ids.length) return;
    const projectId = rawProjectId ? validScalar(rawProjectId) : undefined;
    let client: MilvusV2ClientLike;
    try { client = await this.readyClient(false); }
    catch (error) { if (error instanceof AssetVectorError) return; throw error; }
    const filters = [`workspace_id == ${literal(workspaceId)}`,
      `asset_id in [${ids.map(literal).join(', ')}]`];
    if (projectId) filters.push(`project_id == ${literal(projectId)}`);
    await client.deleteEntities({ collection_name: this.options.collection, expr: filters.join(' and ') });
  }

  private async readyClient(createIfMissing: boolean, vectorDimension?: number): Promise<MilvusV2ClientLike> {
    const client = this.rawClient();
    if (!this.initialized) {
      const response = await client.hasCollection({ collection_name: this.options.collection });
      const exists = typeof response === 'boolean' ? response : response.value === true;
      if (!exists) {
        if (!createIfMissing) throw new AssetVectorError('Configured Milvus v2 collection is unavailable');
        if (!vectorDimension) throw new AssetVectorContractError('Vector dimension is required to create Milvus v2');
        const moduleValue = this.module();
        const dataType = moduleValue.DataType ?? {};
        const varchar = dataType.VarChar ?? 'VarChar';
        await client.createCollection({
          collection_name: this.options.collection,
          fields: [
            { name: 'id', data_type: varchar, is_primary_key: true, max_length: 80 },
            { name: 'vector', data_type: dataType.FloatVector ?? 'FloatVector', dim: vectorDimension },
            { name: 'workspace_id', data_type: varchar, max_length: 64 },
            { name: 'project_id', data_type: varchar, max_length: 128 },
            { name: 'asset_id', data_type: varchar, max_length: 128 },
            { name: 'chunk_id', data_type: varchar, max_length: 128 },
            { name: 'source_version', data_type: varchar, max_length: 128 },
            { name: 'kind', data_type: varchar, max_length: 32 },
            { name: 'text', data_type: varchar, max_length: 8192 },
            { name: 'text_hash', data_type: varchar, max_length: 64 },
            { name: 'embedding_model', data_type: varchar, max_length: 256 },
          ],
          index_params: [{ field_name: 'vector', index_type: 'HNSW',
            metric_type: (moduleValue.MetricType ?? {}).COSINE ?? 'COSINE',
            params: { M: 16, efConstruction: 200 } }],
        });
      }
      await client.loadCollection({ collection_name: this.options.collection });
      this.initialized = true;
    }
    return client;
  }

  private rawClient(): MilvusV2ClientLike {
    if (!this.client) {
      const moduleValue = this.module();
      if (!moduleValue.MilvusClient) throw new AssetVectorError('MilvusClient is unavailable');
      this.client = new moduleValue.MilvusClient({
        address: this.options.uri.replace(/^https?:\/\//u, '').replace(/\/$/u, ''),
        username: this.options.user || undefined, password: this.options.password || undefined, timeout: 8_000,
      });
    }
    return this.client;
  }

  private module(): MilvusV2ModuleLike {
    if (this.moduleValue) return this.moduleValue;
    try { this.moduleValue = require('@zilliz/milvus2-sdk-node') as MilvusV2ModuleLike; return this.moduleValue; }
    catch { throw new AssetVectorError('@zilliz/milvus2-sdk-node is not available'); }
  }
}

function validateRecord(raw: VectorProjectionRecord): VectorProjectionRecord {
  const record = { ...raw, projectId: raw.projectId === null ? null : validScalar(raw.projectId),
    assetId: validScalar(raw.assetId), chunkId: validScalar(raw.chunkId),
    sourceVersion: validScalar(raw.sourceVersion), kind: validKind(raw.kind),
    embeddingModel: validScalar(raw.embeddingModel) };
  if (typeof record.text !== 'string' || !record.text.trim() || record.text.length > 64_000
    || !/^[a-f0-9]{64}$/u.test(record.textHash)) {
    throw new AssetVectorContractError('Milvus v2 source text or text hash is invalid');
  }
  validateVector(record.vector);
  return record;
}
function validateQuery(raw: VectorSearchQuery): VectorSearchQuery {
  const query = { ...raw, projectId: raw.projectId ? validScalar(raw.projectId) : undefined,
    kind: validKind(raw.kind),
    assetIds: raw.assetIds === undefined ? undefined
      : [...new Set(raw.assetIds.map(validScalar))].slice(0, 200) };
  validateVector(query.vector);
  return query;
}
function validKind(value: string): AssetKind {
  if (!['character', 'location', 'prop'].includes(value)) {
    throw new AssetVectorContractError('Milvus v2 asset kind is invalid');
  }
  return value as AssetKind;
}
function validScalar(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new AssetVectorContractError('Milvus v2 scalar identifier is invalid');
  }
  return value;
}
function validScalarOrEmpty(value: unknown): string {
  try { return typeof value === 'string' ? validScalar(value) : ''; } catch { return ''; }
}
function validateVector(vector: number[]): void {
  if (!Array.isArray(vector) || !vector.length || vector.length > 16_384
    || vector.some(value => !Number.isFinite(value))) {
    throw new AssetVectorContractError('A finite, non-empty vector is required');
  }
}
function vectorId(workspaceId: string, record: VectorProjectionRecord): string {
  return `vec_${createHash('sha256').update(JSON.stringify([
    workspaceId, record.projectId, record.assetId, record.chunkId, record.sourceVersion,
  ])).digest('hex')}`;
}
function literal(value: string): string { return JSON.stringify(validScalar(value)); }
function searchRows(result: unknown): unknown[] {
  if (result && typeof result === 'object' && !Array.isArray(result)
    && Array.isArray((result as { results?: unknown }).results)) return (result as { results: unknown[] }).results;
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
  throw new AssetVectorContractError('Milvus v2 search returned an unrecognized response');
}
