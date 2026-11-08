import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { canonicalDigest } from '@lyra/shared';
import type { PostgresDatabase } from '../db/client';
import { DataOutbox, type OutboxTransaction } from '../data/outbox';
import { createDataEventV2 } from '../data/tenant-event';
import {
  normalizeObjectKey, validateContentType, validateSha256,
  type ObjectDescriptor, type ObjectStorageProvider, type ObjectStorageScope,
} from '../infrastructure/object-storage';
import type { JobLease, PersistentJob } from '../jobs/contracts';
import { PostgresJobQueueRepository } from '../jobs/repository';
import { parseWorkspaceId } from '../tenancy/context';
import { parseMediaId } from './contracts';
import { objectKey } from './object-storage';

export const PRODUCTION_MEDIA_OBJECT_QUEUE = 'object_projection';
export const PRODUCTION_MEDIA_OBJECT_JOB_KIND = 'production_media.object_project';
export const PRODUCTION_MEDIA_OBJECT_PAYLOAD_SCHEMA = 'production-media-object/1' as const;

export type ProductionMediaObjectStatus = 'uploading' | 'ready' | 'failed' | 'deleting' | 'deleted';

export interface ProductionMediaObjectJobPayload {
  schemaVersion: typeof PRODUCTION_MEDIA_OBJECT_PAYLOAD_SCHEMA;
  objectId: string;
  mediaId: string;
  provider: ObjectStorageProvider;
  bucket: string;
  key: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  purpose: 'production.media';
  ownerType: 'production_media';
  ownerId: string;
}

export interface ProductionMediaObjectRecord {
  id: string;
  workspaceId: string;
  provider: ObjectStorageProvider;
  bucket: string;
  key: string;
  versionId: string | null;
  etag: string | null;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  purpose: string;
  ownerType: string;
  ownerId: string;
  jobId: string | null;
  status: ProductionMediaObjectStatus;
  lastError: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
  deletedAt: string | null;
}

export class ProductionMediaObjectRecordError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ProductionMediaObjectRecordError';
  }
}

interface ObjectRecordRow extends QueryResultRow {
  id: string; workspace_id: string; provider: ObjectStorageProvider; bucket: string; object_key: string;
  version_id: string | null; etag: string | null; sha256: string; size_bytes: string | number;
  content_type: string; purpose: string; owner_type: string; owner_id: string; job_id: string | null;
  status: ProductionMediaObjectStatus; last_error: string | null; version: number;
  created_at: unknown; updated_at: unknown; verified_at: unknown; deleted_at: unknown;
}

const COLUMNS = `id, workspace_id, provider, bucket, object_key, version_id, etag, sha256,
  size_bytes, content_type, purpose, owner_type, owner_id, job_id, status, last_error,
  version, created_at, updated_at, verified_at, deleted_at`;
const OBJECT_ID = /^obj_[a-f0-9]{32}$/u;
const BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;
const PROVIDERS = new Set<ObjectStorageProvider>(['local', 'minio', 's3', 'oss', 'cos']);

function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }
function nullIso(value: unknown): string | null { return value === null ? null : iso(value); }
function recordOf(row: ObjectRecordRow): ProductionMediaObjectRecord {
  return {
    id: row.id, workspaceId: row.workspace_id, provider: row.provider, bucket: row.bucket, key: row.object_key,
    versionId: row.version_id, etag: row.etag, sha256: row.sha256, sizeBytes: Number(row.size_bytes),
    contentType: row.content_type, purpose: row.purpose, ownerType: row.owner_type, ownerId: row.owner_id,
    jobId: row.job_id, status: row.status, lastError: row.last_error, version: row.version,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), verifiedAt: nullIso(row.verified_at),
    deletedAt: nullIso(row.deleted_at),
  };
}

function invalid(message: string): never {
  throw new ProductionMediaObjectRecordError('OBJECT_PROJECTION_INPUT_INVALID', message);
}
function conflict(message: string): never {
  throw new ProductionMediaObjectRecordError('OBJECT_PROJECTION_CONFLICT', message);
}
function timestamp(value: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    return invalid('对象投影时间无效。');
  }
  return value;
}

export function productionMediaObjectId(scope: ObjectStorageScope,
  input: Pick<ProductionMediaObjectJobPayload, 'provider' | 'bucket' | 'key'>): string {
  const workspaceId = parseWorkspaceId(scope.workspaceId);
  if (!PROVIDERS.has(input.provider) || !BUCKET.test(input.bucket)) return invalid('对象存储标识无效。');
  const key = normalizeObjectKey(input.key);
  return `obj_${createHash('sha256').update(JSON.stringify([
    workspaceId, input.provider, input.bucket, key,
  ])).digest('hex').slice(0, 32)}`;
}

export function createProductionMediaObjectPayload(scope: ObjectStorageScope, input: {
  mediaId: string; provider: ObjectStorageProvider; bucket: string; sha256: string;
  sizeBytes: number; contentType: string;
}): ProductionMediaObjectJobPayload {
  const mediaId = parseMediaId(input.mediaId);
  const sha256 = validateSha256(input.sha256);
  if (mediaId !== `media_${sha256}`) return invalid('媒体 ID 与 SHA-256 不一致。');
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 4 * 1024 * 1024 * 1024) {
    return invalid('媒体大小无效。');
  }
  const contentType = validateContentType(input.contentType);
  if (contentType !== 'video/mp4') return invalid('生产媒体必须为 video/mp4。');
  const key = objectKey({ sha256 });
  const partial = { provider: input.provider, bucket: input.bucket, key };
  return {
    schemaVersion: PRODUCTION_MEDIA_OBJECT_PAYLOAD_SCHEMA,
    objectId: productionMediaObjectId(scope, partial), mediaId,
    ...partial, sha256, sizeBytes: input.sizeBytes, contentType,
    purpose: 'production.media', ownerType: 'production_media', ownerId: mediaId,
  };
}

export function parseProductionMediaObjectPayload(value: unknown,
  workspaceIdValue: string): ProductionMediaObjectJobPayload {
  const workspaceId = parseWorkspaceId(workspaceIdValue);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('对象投影任务载荷无效。');
  const input = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'objectId', 'mediaId', 'provider', 'bucket', 'key', 'sha256',
    'sizeBytes', 'contentType', 'purpose', 'ownerType', 'ownerId']);
  if (Object.keys(input).some(key => !allowed.has(key)) || input.schemaVersion !== PRODUCTION_MEDIA_OBJECT_PAYLOAD_SCHEMA
    || typeof input.objectId !== 'string' || !OBJECT_ID.test(input.objectId)
    || typeof input.provider !== 'string' || !PROVIDERS.has(input.provider as ObjectStorageProvider)
    || typeof input.bucket !== 'string' || !BUCKET.test(input.bucket)
    || input.purpose !== 'production.media' || input.ownerType !== 'production_media') {
    return invalid('对象投影任务载荷无效。');
  }
  const mediaId = parseMediaId(input.mediaId);
  const sha256 = validateSha256(input.sha256);
  const key = normalizeObjectKey(input.key);
  const contentType = validateContentType(input.contentType);
  if (mediaId !== `media_${sha256}` || input.ownerId !== mediaId || contentType !== 'video/mp4'
    || key !== objectKey({ sha256 }) || !Number.isSafeInteger(input.sizeBytes)
    || (input.sizeBytes as number) < 1 || (input.sizeBytes as number) > 4 * 1024 * 1024 * 1024) {
    return invalid('对象投影任务载荷内容不一致。');
  }
  const payload = { ...input, mediaId, provider: input.provider as ObjectStorageProvider,
    bucket: input.bucket, key, sha256, sizeBytes: input.sizeBytes as number, contentType,
  } as ProductionMediaObjectJobPayload;
  if (productionMediaObjectId({ workspaceId }, payload) !== payload.objectId) {
    return invalid('对象投影标识与 workspace 不一致。');
  }
  return structuredClone(payload);
}

function assertRecordMatches(record: ProductionMediaObjectRecord, payload: ProductionMediaObjectJobPayload,
  jobId: string): void {
  if (record.id !== payload.objectId || record.provider !== payload.provider || record.bucket !== payload.bucket
    || record.key !== payload.key || record.sha256 !== payload.sha256 || record.sizeBytes !== payload.sizeBytes
    || record.contentType !== payload.contentType || record.purpose !== payload.purpose
    || record.ownerType !== payload.ownerType || record.ownerId !== payload.ownerId || record.jobId !== jobId) {
    conflict('同一对象投影标识已对应不同内容，未覆盖。');
  }
}

function assertLease(lease: JobLease): ProductionMediaObjectJobPayload {
  const payload = parseProductionMediaObjectPayload(lease.job.payload, lease.job.workspaceId);
  if (lease.job.queueName !== PRODUCTION_MEDIA_OBJECT_QUEUE || lease.job.kind !== PRODUCTION_MEDIA_OBJECT_JOB_KIND
    || lease.job.aggregateType !== 'object_record' || lease.job.aggregateId !== payload.objectId) {
    return invalid('任务队列、类型或聚合标识不匹配对象投影。');
  }
  return payload;
}

function leaseInput(lease: JobLease, now: string) {
  return { workspaceId: lease.job.workspaceId, jobId: lease.job.id, workerId: lease.workerId,
    fencingToken: lease.fencingToken, now: timestamp(now) };
}

function eventDigest(record: ProductionMediaObjectRecord): string {
  return canonicalDigest({ id: record.id, workspaceId: record.workspaceId, provider: record.provider,
    bucket: record.bucket, key: record.key, versionId: record.versionId, etag: record.etag,
    sha256: record.sha256, sizeBytes: record.sizeBytes, contentType: record.contentType,
    purpose: record.purpose, ownerType: record.ownerType, ownerId: record.ownerId,
    jobId: record.jobId, status: record.status, lastError: record.lastError, version: record.version,
    verifiedAt: record.verifiedAt, deletedAt: record.deletedAt });
}

async function appendRecordEvent(tx: OutboxTransaction, record: ProductionMediaObjectRecord,
  eventType: 'delivery.object.queued' | 'delivery.object.retry_scheduled'
    | 'delivery.object.ready' | 'delivery.object.failed', at: string): Promise<void> {
  await tx.append(createDataEventV2({
    workspaceId: record.workspaceId, eventType, aggregateType: 'delivery_artifact', aggregateId: record.id,
    aggregateVersion: record.version, occurredAt: at, recordedAt: at,
    correlationId: `object:${record.id}`, authoritativeRef: {
      kind: 'object_record', id: record.id, revisionId: `rev_${record.version}`, digest: eventDigest(record),
    }, payload: { objectId: record.id, mediaId: record.ownerId, jobId: record.jobId,
      provider: record.provider, status: record.status, sizeBytes: record.sizeBytes },
  }));
}

function descriptorStrings(descriptor: ObjectDescriptor): void {
  if ((descriptor.versionId !== null && (typeof descriptor.versionId !== 'string' || descriptor.versionId.length > 512))
    || (descriptor.etag !== null && (typeof descriptor.etag !== 'string' || descriptor.etag.length > 512))) {
    invalid('对象存储版本或 ETag 无效。');
  }
}

export class PostgresProductionMediaObjectRepository {
  private readonly outbox: DataOutbox;
  constructor(private readonly database: PostgresDatabase,
    private readonly jobs = new PostgresJobQueueRepository(database)) {
    this.outbox = new DataOutbox(database);
  }

  async enqueue(scope: ObjectStorageScope, payloadValue: ProductionMediaObjectJobPayload,
    atValue: string): Promise<{ record: ProductionMediaObjectRecord; job: PersistentJob; created: boolean }> {
    const workspaceId = parseWorkspaceId(scope.workspaceId);
    const payload = parseProductionMediaObjectPayload(payloadValue, workspaceId);
    const at = timestamp(atValue);
    return this.outbox.transaction(async tx => {
      const queued = await this.jobs.enqueueInTransaction(tx.client, { workspaceId }, {
        queueName: PRODUCTION_MEDIA_OBJECT_QUEUE, kind: PRODUCTION_MEDIA_OBJECT_JOB_KIND,
        aggregateType: 'object_record', aggregateId: payload.objectId,
        idempotencyKey: `object-projection:${payload.objectId}`, payload: { ...payload }, priority: 60,
        maxAttempts: 5, availableAt: at,
      });
      const inserted = await tx.client.query<ObjectRecordRow>(`
        INSERT INTO object_records (${COLUMNS})
        VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, $7, $8, $9, $10, $11, $12,
                'uploading', NULL, 1, $13::timestamptz, $13::timestamptz, NULL, NULL)
        ON CONFLICT (workspace_id, id) DO NOTHING
        RETURNING ${COLUMNS}
      `, [payload.objectId, workspaceId, payload.provider, payload.bucket, payload.key, payload.sha256,
        payload.sizeBytes, payload.contentType, payload.purpose, payload.ownerType, payload.ownerId,
        queued.job.id, at]);
      let record = inserted.rows[0] ? recordOf(inserted.rows[0]) : null;
      if (!record) {
        const existing = await tx.client.query<ObjectRecordRow>(`
          SELECT ${COLUMNS} FROM object_records WHERE workspace_id = $1 AND id = $2 FOR SHARE
        `, [workspaceId, payload.objectId]);
        record = existing.rows[0] ? recordOf(existing.rows[0]) : null;
      }
      if (!record) throw new ProductionMediaObjectRecordError('OBJECT_PROJECTION_PERSISTENCE_UNAVAILABLE',
        '对象投影元数据写入失败。');
      assertRecordMatches(record, payload, queued.job.id);
      if (inserted.rows[0]) await appendRecordEvent(tx, record, 'delivery.object.queued', at);
      return { record, job: queued.job, created: Boolean(inserted.rows[0]) };
    });
  }

  async complete(lease: JobLease, descriptor: ObjectDescriptor,
    atValue: string): Promise<ProductionMediaObjectRecord> {
    const payload = assertLease(lease);
    const at = timestamp(atValue);
    descriptorStrings(descriptor);
    if (descriptor.provider !== payload.provider || descriptor.bucket !== payload.bucket
      || descriptor.key !== payload.key || descriptor.sha256 !== payload.sha256
      || descriptor.size !== payload.sizeBytes || descriptor.contentType !== payload.contentType) {
      return conflict('对象存储验证结果与已冻结投影载荷不一致。');
    }
    return this.outbox.transaction(async tx => {
      const selected = await tx.client.query<ObjectRecordRow>(`
        SELECT ${COLUMNS} FROM object_records WHERE workspace_id = $1 AND id = $2 FOR UPDATE
      `, [lease.job.workspaceId, payload.objectId]);
      const current = selected.rows[0] ? recordOf(selected.rows[0]) : null;
      if (!current) throw new ProductionMediaObjectRecordError('OBJECT_PROJECTION_NOT_FOUND', '对象投影元数据不存在。');
      assertRecordMatches(current, payload, lease.job.id);
      if (!['uploading', 'ready'].includes(current.status)) return conflict('对象投影已进入不可完成的状态。');
      let ready = current;
      if (current.status !== 'ready') {
        const updated = await tx.client.query<ObjectRecordRow>(`
          UPDATE object_records SET version_id = $3, etag = $4, status = 'ready', last_error = NULL,
            verified_at = $5::timestamptz, updated_at = $5::timestamptz, version = version + 1
          WHERE workspace_id = $1 AND id = $2 AND status = 'uploading'
          RETURNING ${COLUMNS}
        `, [lease.job.workspaceId, payload.objectId, descriptor.versionId, descriptor.etag, at]);
        if (!updated.rows[0]) return conflict('对象投影状态已被其他 Worker 更改。');
        ready = recordOf(updated.rows[0]);
      }
      await this.jobs.completeInTransaction(tx.client, leaseInput(lease, at));
      if (current.status !== 'ready') await appendRecordEvent(tx, ready, 'delivery.object.ready', at);
      return ready;
    });
  }

  async fail(lease: JobLease, errorCode: string, retryable: boolean, retryAtValue: string,
    atValue: string): Promise<{ record: ProductionMediaObjectRecord; job: PersistentJob }> {
    const payload = assertLease(lease);
    const at = timestamp(atValue);
    const retryAt = timestamp(retryAtValue);
    const safeError = typeof errorCode === 'string' && /^[A-Z][A-Z0-9_]{2,95}$/u.test(errorCode)
      ? errorCode : 'OBJECT_PROJECTION_FAILED';
    return this.outbox.transaction(async tx => {
      const selected = await tx.client.query<ObjectRecordRow>(`
        SELECT ${COLUMNS} FROM object_records WHERE workspace_id = $1 AND id = $2 FOR UPDATE
      `, [lease.job.workspaceId, payload.objectId]);
      const current = selected.rows[0] ? recordOf(selected.rows[0]) : null;
      if (!current) throw new ProductionMediaObjectRecordError('OBJECT_PROJECTION_NOT_FOUND', '对象投影元数据不存在。');
      assertRecordMatches(current, payload, lease.job.id);
      if (current.status !== 'uploading') return conflict('只有上传中的对象投影可以记录失败。');
      const job = await this.jobs.failInTransaction(tx.client, {
        ...leaseInput(lease, at), error: safeError, retryable, retryAt,
      });
      const status: ProductionMediaObjectStatus = job.state === 'queued' ? 'uploading' : 'failed';
      const updated = await tx.client.query<ObjectRecordRow>(`
        UPDATE object_records SET status = $3, last_error = $4,
          updated_at = $5::timestamptz, version = version + 1
        WHERE workspace_id = $1 AND id = $2 AND status = 'uploading'
        RETURNING ${COLUMNS}
      `, [lease.job.workspaceId, payload.objectId, status, safeError, at]);
      if (!updated.rows[0]) return conflict('对象投影状态已被其他 Worker 更改。');
      const record = recordOf(updated.rows[0]);
      await appendRecordEvent(tx, record, status === 'uploading'
        ? 'delivery.object.retry_scheduled' : 'delivery.object.failed', at);
      return { record, job };
    });
  }

  async get(scope: ObjectStorageScope, objectId: string): Promise<ProductionMediaObjectRecord | null> {
    const workspaceId = parseWorkspaceId(scope.workspaceId);
    if (!OBJECT_ID.test(objectId)) return invalid('对象投影标识无效。');
    const result = await this.database.query<ObjectRecordRow>(`
      SELECT ${COLUMNS} FROM object_records WHERE workspace_id = $1 AND id = $2
    `, [workspaceId, objectId]);
    return result.rows[0] ? recordOf(result.rows[0]) : null;
  }

  async findByMedia(scope: ObjectStorageScope, mediaIdValue: unknown): Promise<ProductionMediaObjectRecord | null> {
    const workspaceId = parseWorkspaceId(scope.workspaceId);
    const mediaId = parseMediaId(mediaIdValue);
    const result = await this.database.query<ObjectRecordRow>(`
      SELECT ${COLUMNS}
      FROM object_records
      WHERE workspace_id = $1 AND owner_type = 'production_media' AND owner_id = $2
        AND status <> 'deleted'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `, [workspaceId, mediaId]);
    return result.rows[0] ? recordOf(result.rows[0]) : null;
  }
}
