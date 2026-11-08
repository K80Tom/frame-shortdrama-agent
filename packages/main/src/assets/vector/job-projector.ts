import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { AssetRecord } from '@lyra/shared';
import type { PostgresDatabase } from '../../db/client';
import type { VectorStore } from '../../infrastructure/vector-store';
import { NonRetryableJobError, type JobHandler, type JobHandlerContext } from '../../jobs/worker';
import type { PostgresJobQueueRepository } from '../../jobs/repository';
import type { AssetEmbeddingClient } from './embedding';
import { buildAssetVectorText } from './projection';

export const ASSET_VECTOR_QUEUE = 'projection';
export const ASSET_VECTOR_JOB_KIND = 'asset.vector.index.v2';

interface AssetCandidateRow extends QueryResultRow {
  workspace_id: string;
  id: string;
  kind: AssetRecord['kind'];
  name: string;
  description: string;
  resource_url: string;
  created_at: unknown;
}

interface ProjectionSourceRow extends QueryResultRow {
  workspace_id: string;
  source_id: string;
  source_version: string;
  status: 'stale' | 'queued' | 'indexing' | 'indexed' | 'failed' | 'deleted';
  indexed_version: string | null;
  job_id: string | null;
  fencing_token: string | number;
  id: string | null;
  kind: AssetRecord['kind'] | null;
  name: string | null;
  description: string | null;
  resource_url: string | null;
  created_at: unknown;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function assetOf(row: AssetCandidateRow | ProjectionSourceRow): AssetRecord {
  if (!row.id || !row.kind || row.name === null || row.description === null
    || row.resource_url === null || row.created_at === null) {
    throw new NonRetryableJobError('向量投影的 PostgreSQL 资产源不存在。');
  }
  return { id: row.id, kind: row.kind, name: row.name, description: row.description,
    resourceUrl: row.resource_url, createdAt: iso(row.created_at) };
}

function sourceVersion(asset: AssetRecord): string {
  return createHash('sha256').update(buildAssetVectorText(asset), 'utf8').digest('hex');
}

function safeError(error: unknown): string {
  return (error instanceof Error && error.message.trim() ? error.message : '向量投影失败。').slice(0, 2_000);
}

export interface AssetVectorJobReconcilerOptions {
  batchSize?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  logger?: Pick<Console, 'warn'>;
}

/**
 * Finds immutable PostgreSQL assets that do not yet have a v2 projection and
 * atomically creates projection metadata plus a durable job. No embedding call
 * occurs in this scanner.
 */
export class AssetVectorJobReconciler {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly logger: Pick<Console, 'warn'>;
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;

  constructor(private readonly database: PostgresDatabase, private readonly jobs: PostgresJobQueueRepository,
    private readonly options: { collection: string; embeddingModel: string } & AssetVectorJobReconcilerOptions) {
    this.batchSize = options.batchSize ?? 50;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? console;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 500) {
      throw new Error('batchSize must be 1..500');
    }
  }

  async runOnce(): Promise<number> {
    return this.database.runAsSystem('vector.projection.scan', async () => {
      const result = await this.database.query<AssetCandidateRow>(`
        SELECT asset.workspace_id, asset.id, asset.kind, asset.name, asset.description,
               asset.resource_url, asset.created_at
        FROM asset_catalog asset
        LEFT JOIN vector_projection_states state
          ON state.workspace_id = asset.workspace_id
         AND state.collection_name = $1
         AND state.source_type = 'asset'
         AND state.source_id = asset.id
        WHERE asset.workspace_id IS NOT NULL AND state.source_id IS NULL
        ORDER BY asset.created_at, asset.id
        LIMIT $2
      `, [this.options.collection, this.batchSize]);
      for (const row of result.rows) await this.enqueue(row);
      return result.rows.length;
    });
  }

  start(): void {
    if (this.running) return;
    this.controller = new AbortController();
    this.running = this.loop(this.controller.signal);
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.running;
    this.controller = undefined;
    this.running = undefined;
  }

  private async enqueue(row: AssetCandidateRow): Promise<void> {
    const asset = assetOf(row);
    const version = sourceVersion(asset);
    const at = this.now().toISOString();
    await this.database.transaction(async client => {
      const queued = await this.jobs.enqueueInTransaction(client, { workspaceId: row.workspace_id }, {
        queueName: ASSET_VECTOR_QUEUE,
        kind: ASSET_VECTOR_JOB_KIND,
        aggregateType: 'asset',
        aggregateId: asset.id,
        idempotencyKey: `vector:v2:${row.workspace_id}:${asset.id}:${version}`,
        payload: { assetId: asset.id, sourceVersion: version, collection: this.options.collection },
        priority: 40,
        maxAttempts: 5,
        availableAt: at,
      });
      await client.query(`
        INSERT INTO vector_projection_states
          (workspace_id, collection_name, source_type, source_id, source_version,
           status, embedding_model, embedding_dimension, text_hash, indexed_version,
           job_id, last_error, version, created_at, updated_at, indexed_at, fencing_token)
        VALUES ($1, $2, 'asset', $3, $4, 'queued', $5, NULL, $4, NULL,
                $6, NULL, 1, $7::timestamptz, $7::timestamptz, NULL, 0)
        ON CONFLICT (workspace_id, collection_name, source_type, source_id) DO NOTHING
      `, [row.workspace_id, this.options.collection, asset.id, version,
        this.options.embeddingModel, queued.job.id, at]);
    });
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let count = 0;
      try { count = await this.runOnce(); }
      catch (error) { this.logger.warn(`Vector projection scan failed: ${safeError(error)}`); }
      if (count < this.batchSize && !signal.aborted) await this.wait(signal);
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, this.pollIntervalMs);
      timer.unref?.();
      signal.addEventListener('abort', finish, { once: true });
    });
  }
}

/** Paid embedding + Milvus write. It only runs after a durable job is claimed. */
export class AssetVectorProjectionJobHandler implements JobHandler {
  readonly queueName = ASSET_VECTOR_QUEUE;
  readonly kind = ASSET_VECTOR_JOB_KIND;

  constructor(private readonly database: PostgresDatabase, private readonly dependencies: {
    collection: string;
    embeddingModel: string;
    embedding: AssetEmbeddingClient;
    store: VectorStore;
    now?: () => Date;
  }) {}

  async handle(context: JobHandlerContext): Promise<void> {
    const { job } = context.lease;
    const assetId = job.payload.assetId;
    const requestedVersion = job.payload.sourceVersion;
    const collection = job.payload.collection;
    if (typeof assetId !== 'string' || !/^asset_[a-f0-9]{32}$/u.test(assetId)
      || typeof requestedVersion !== 'string' || !/^[a-f0-9]{64}$/u.test(requestedVersion)
      || collection !== this.dependencies.collection) {
      throw new NonRetryableJobError('向量投影任务负载无效。');
    }
    const source = await this.begin(job.workspaceId, assetId, requestedVersion,
      job.id, context.lease.fencingToken);
    if (source.status === 'indexed' && source.indexed_version === requestedVersion) return;
    const asset = assetOf(source);
    const text = buildAssetVectorText(asset);
    const actualVersion = createHash('sha256').update(text, 'utf8').digest('hex');
    if (actualVersion !== requestedVersion) {
      await this.failProjection(job.workspaceId, assetId, job.id, context.lease.fencingToken,
        '资产源版本已变更，需重新排队。');
      throw new NonRetryableJobError('资产源版本已变更，需重新排队。');
    }
    try {
      await context.checkpoint('vector.source_loaded', { assetId, sourceVersion: requestedVersion });
      const vector = await this.dependencies.embedding.embedText(text);
      await context.assertLease();
      await context.checkpoint('vector.embedded', { assetId, sourceVersion: requestedVersion,
        embeddingModel: this.dependencies.embeddingModel, dimension: vector.length });
      await this.dependencies.store.upsert({ workspaceId: job.workspaceId }, {
        projectId: null,
        assetId,
        chunkId: `asset:${assetId}`,
        sourceVersion: requestedVersion,
        kind: asset.kind,
        text,
        textHash: requestedVersion,
        embeddingModel: this.dependencies.embeddingModel,
        vector,
      });
      // A stale attempt may have written a deterministic, stale vector, but it
      // cannot publish metadata after this fenced checkpoint fails.
      await context.assertLease();
      await context.checkpoint('vector.milvus_upserted', { assetId, sourceVersion: requestedVersion,
        collection: this.dependencies.collection });
      const updated = await this.database.query(`
        UPDATE vector_projection_states
        SET status = 'indexed', indexed_version = source_version,
            embedding_model = $6, embedding_dimension = $7, text_hash = $4,
            last_error = NULL, indexed_at = $8::timestamptz,
            updated_at = $8::timestamptz, version = version + 1
        WHERE workspace_id = $1 AND collection_name = $2
          AND source_type = 'asset' AND source_id = $3 AND source_version = $4
          AND job_id = $5 AND fencing_token = $9
        RETURNING source_id
      `, [job.workspaceId, this.dependencies.collection, assetId, requestedVersion,
        job.id, this.dependencies.embeddingModel, vector.length, this.timestamp(), context.lease.fencingToken]);
      if (!updated.rows[0]) throw new Error('向量投影租约已失效。');
      await context.checkpoint('vector.projection_committed', { assetId, sourceVersion: requestedVersion });
    } catch (error) {
      await this.failProjection(job.workspaceId, assetId, job.id, context.lease.fencingToken, safeError(error));
      throw error;
    }
  }

  private async begin(workspaceId: string, assetId: string, sourceVersionValue: string,
    jobId: string, fence: number): Promise<ProjectionSourceRow> {
    return this.database.transaction(async (client: PoolClient) => {
      const current = await client.query<ProjectionSourceRow>(`
        SELECT state.workspace_id, state.source_id, state.source_version, state.status,
               state.indexed_version, state.job_id, state.fencing_token,
               asset.id, asset.kind, asset.name, asset.description, asset.resource_url, asset.created_at
        FROM vector_projection_states state
        LEFT JOIN asset_catalog asset
          ON asset.workspace_id = state.workspace_id AND asset.id = state.source_id
        WHERE state.workspace_id = $1 AND state.collection_name = $2
          AND state.source_type = 'asset' AND state.source_id = $3
        FOR UPDATE OF state
      `, [workspaceId, this.dependencies.collection, assetId]);
      const row = current.rows[0];
      if (!row || row.job_id !== jobId || row.source_version !== sourceVersionValue) {
        throw new NonRetryableJobError('向量投影状态与任务不匹配。');
      }
      if (row.status === 'indexed' && row.indexed_version === sourceVersionValue) return row;
      const claimed = await client.query<ProjectionSourceRow>(`
        UPDATE vector_projection_states
        SET status = 'indexing', fencing_token = $6, last_error = NULL,
            updated_at = $5::timestamptz, version = version + 1
        WHERE workspace_id = $1 AND collection_name = $2
          AND source_type = 'asset' AND source_id = $3 AND job_id = $4
          AND fencing_token < $6
        RETURNING workspace_id, source_id, source_version, status, indexed_version,
                  job_id, fencing_token, NULL::text AS id, NULL::text AS kind,
                  NULL::text AS name, NULL::text AS description,
                  NULL::text AS resource_url, NULL::timestamptz AS created_at
      `, [workspaceId, this.dependencies.collection, assetId, jobId, this.timestamp(), fence]);
      if (!claimed.rows[0]) throw new Error('向量投影租约竞争失败。');
      return { ...row, status: 'indexing', fencing_token: fence };
    });
  }

  private async failProjection(workspaceId: string, assetId: string, jobId: string,
    fence: number, error: string): Promise<void> {
    await this.database.query(`
      UPDATE vector_projection_states
      SET status = 'failed', last_error = $6, updated_at = $5::timestamptz, version = version + 1
      WHERE workspace_id = $1 AND collection_name = $2
        AND source_type = 'asset' AND source_id = $3 AND job_id = $4 AND fencing_token = $7
        AND status = 'indexing'
    `, [workspaceId, this.dependencies.collection, assetId, jobId, this.timestamp(), error.slice(0, 2_000), fence]);
  }

  private timestamp(): string { return (this.dependencies.now ?? (() => new Date()))().toISOString(); }
}
