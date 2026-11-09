import type { ObjectStorage, ObjectStorageScope } from '../infrastructure/object-storage';
import { ObjectStorageError } from '../infrastructure/object-storage';
import { JobQueueError, type JobLease, type JobQueueRepository } from '../jobs/contracts';
import type { JobTenantResolver } from '../jobs/tenant';
import { parseTenantContext } from '../tenancy/context';
import { tenantExecutionScope, type TenantExecutionScope } from '../tenancy/scope';
import { ProductionMediaError } from './contracts';
import { ProductionMediaObjectProjection } from './object-storage';
import {
  PRODUCTION_MEDIA_OBJECT_QUEUE,
  ProductionMediaObjectRecordError,
  createProductionMediaObjectPayload,
  parseProductionMediaObjectPayload,
  type PostgresProductionMediaObjectRepository,
  type ProductionMediaObjectRecord,
} from './object-records';
import type { ProductionMediaStore } from './store';

type ProjectionJobs = Pick<JobQueueRepository, 'claim' | 'heartbeat' | 'saveStep'>;
type ProjectionRecords = Pick<PostgresProductionMediaObjectRepository,
  'enqueue' | 'complete' | 'fail' | 'findByMedia'>;

export interface ProductionMediaObjectWorkerOptions {
  workerId: string;
  leaseMs?: number;
  heartbeatMs?: number;
  pollIntervalMs?: number;
  retryBackoffMs?: number;
  now?: () => Date;
  tenantResolver?: JobTenantResolver;
  executionScope?: Pick<TenantExecutionScope, 'runAsSystem' | 'runWithTenant'>;
  logger?: Pick<Console, 'warn'>;
}

export type ProductionMediaObjectWorkerResult =
  | { status: 'idle' }
  | { status: 'succeeded'; jobId: string; objectId: string; record: ProductionMediaObjectRecord }
  | { status: 'retry_scheduled' | 'failed'; jobId: string; objectId: string; errorCode: string };

/**
 * Producer-side boundary. It freezes the already verified local media identity
 * into PostgreSQL and a fenced job; no object-store mutation happens here.
 */
export class ProductionMediaObjectService {
  private readonly now: () => Date;
  constructor(private readonly local: ProductionMediaStore, private readonly objects: ObjectStorage,
    private readonly records: ProjectionRecords, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async enqueue(scope: ObjectStorageScope, mediaId: unknown) {
    const content = await this.local.content(mediaId);
    const payload = createProductionMediaObjectPayload(scope, {
      mediaId: content.object.id, provider: this.objects.provider, bucket: this.objects.bucket,
      sha256: content.object.sha256, sizeBytes: content.object.bytes, contentType: content.object.mimeType,
    });
    return this.records.enqueue(scope, payload, this.timestamp());
  }

  async content(scope: ObjectStorageScope, mediaId: unknown) {
    const record = await this.records.findByMedia(scope, mediaId);
    if (!record) throw new ProductionMediaError(404, 'OBJECT_MEDIA_NOT_FOUND', '媒体对象不存在。');
    if (record.status !== 'ready') throw new ProductionMediaError(409, 'OBJECT_MEDIA_NOT_READY',
      '媒体对象正在入库或需要重试，暂不可读取。');
    const loaded = await this.objects.get({ scope, key: record.key,
      expectedSha256: record.sha256, maxBytes: this.local.limits.maxBytes,...(record.versionId!==null?{providerVersionId:record.versionId}:{}) });
    if (loaded.object.provider !== record.provider || loaded.object.bucket !== record.bucket
      || (record.versionId!==null&&loaded.object.versionId!==record.versionId)
      || loaded.object.key !== record.key || loaded.object.sha256 !== record.sha256
      || loaded.object.size !== record.sizeBytes || loaded.body.length !== record.sizeBytes) {
      throw new ProductionMediaError(409, 'OBJECT_MEDIA_VERIFICATION_FAILED',
        '对象存储中的媒体与 PostgreSQL 登记信息不一致。');
    }
    return { record, bytes: Buffer.from(loaded.body) };
  }

  async access(scope: ObjectStorageScope, mediaId: unknown, expiresInSeconds = 300) {
    const record = await this.records.findByMedia(scope, mediaId);
    if (!record) throw new ProductionMediaError(404, 'OBJECT_MEDIA_NOT_FOUND', '媒体对象不存在。');
    if (record.status !== 'ready') throw new ProductionMediaError(409, 'OBJECT_MEDIA_NOT_READY',
      '媒体对象正在入库或需要重试，暂不可下载。');
    if (!this.objects.createPresignedGet) throw new ProductionMediaError(503, 'OBJECT_MEDIA_SIGNING_UNAVAILABLE',
      '当前存储后端不支持签名下载，请使用同源媒体接口。');
    return this.objects.createPresignedGet({ scope, key: record.key,
      expectedSha256: record.sha256, expiresInSeconds,...(record.versionId!==null?{providerVersionId:record.versionId}:{}) });
  }

  private timestamp(): string {
    const now = this.now();
    if (!Number.isFinite(now.valueOf())) throw new ProductionMediaObjectRecordError(
      'OBJECT_PROJECTION_CLOCK_INVALID', '对象投影时间源无效。');
    return now.toISOString();
  }
}

/** At-least-once consumer. Upload is immutable/idempotent; metadata + Outbox + job completion commit atomically. */
export class ProductionMediaObjectWorker {
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly pollIntervalMs: number;
  private readonly retryBackoffMs: number;
  private readonly now: () => Date;
  private readonly projection: ProductionMediaObjectProjection;
  private readonly tenantResolver: JobTenantResolver | undefined;
  private readonly executionScope: Pick<TenantExecutionScope, 'runAsSystem' | 'runWithTenant'>;
  private readonly logger: Pick<Console, 'warn'>;
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;

  constructor(private readonly local: ProductionMediaStore, objects: ObjectStorage,
    private readonly jobs: ProjectionJobs, private readonly records: ProjectionRecords,
    options: ProductionMediaObjectWorkerOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u.test(options.workerId)) {
      throw new Error('Production media object workerId is invalid.');
    }
    this.workerId = options.workerId;
    this.leaseMs = bounded(options.leaseMs ?? 60_000, 1_000, 24 * 60 * 60 * 1_000, 'leaseMs');
    this.heartbeatMs = bounded(options.heartbeatMs ?? Math.max(1_000, Math.floor(this.leaseMs / 3)),
      250, Math.max(250, this.leaseMs - 100), 'heartbeatMs');
    this.pollIntervalMs = bounded(options.pollIntervalMs ?? 750, 10, 60_000, 'pollIntervalMs');
    this.retryBackoffMs = bounded(options.retryBackoffMs ?? 5_000, 0, 60 * 60 * 1_000, 'retryBackoffMs');
    this.now = options.now ?? (() => new Date());
    this.projection = new ProductionMediaObjectProjection(local, objects);
    this.tenantResolver = options.tenantResolver;
    this.executionScope = options.executionScope ?? tenantExecutionScope;
    this.logger = options.logger ?? console;
  }

  start(): void {
    if (this.running) return;
    this.controller = new AbortController();
    this.running = this.run(this.controller.signal);
  }

  async stop(): Promise<void> {
    this.controller?.abort(new Error('Object projection worker shutdown requested'));
    await this.running;
    this.running = undefined;
    this.controller = undefined;
  }

  async runOnce(): Promise<ProductionMediaObjectWorkerResult> {
    const lease = await this.executionScope.runAsSystem('object.projection.claim', () => this.jobs.claim({
      queueName: PRODUCTION_MEDIA_OBJECT_QUEUE,
      workerId: this.workerId, leaseMs: this.leaseMs, now: this.timestamp(),
    }));
    if (!lease) return { status: 'idle' };
    if (!this.tenantResolver) return this.executeLease(lease);
    let tenant;
    try {
      tenant = parseTenantContext(await this.tenantResolver.resolve(lease.job.workspaceId, lease.job.id));
    } catch (error) {
      return this.executionScope.runAsSystem('object.projection.tenant_failure', () =>
        this.failLease(lease, lease.job.aggregateId ?? 'obj_unknown', error));
    }
    return this.executionScope.runWithTenant(tenant, () => this.executeLease(lease));
  }

  private async executeLease(lease: JobLease): Promise<ProductionMediaObjectWorkerResult> {
    let objectId = lease.job.aggregateId ?? 'obj_unknown';
    const heartbeat = this.startHeartbeat(lease);
    try {
      const payload = parseProductionMediaObjectPayload(lease.job.payload, lease.job.workspaceId);
      objectId = payload.objectId;
      const local = await this.local.content(payload.mediaId);
      if (local.object.sha256 !== payload.sha256 || local.object.bytes !== payload.sizeBytes
        || local.object.mimeType !== payload.contentType || local.bytes.length !== payload.sizeBytes) {
        throw new ProductionMediaObjectRecordError('OBJECT_PROJECTION_LOCAL_MISMATCH',
          '本地媒体与已冻结的对象投影任务不一致。');
      }
      await heartbeat.pulse();
      await this.jobs.saveStep({ ...leaseIdentity(lease, this.timestamp()), stepKey: 'local_verified',
        status: 'succeeded', checkpoint: { mediaId: payload.mediaId, sha256: payload.sha256,
          sizeBytes: payload.sizeBytes } });
      const descriptor = await this.projection.project({ workspaceId: lease.job.workspaceId }, payload.mediaId);
      await heartbeat.pulse();
      await this.jobs.saveStep({ ...leaseIdentity(lease, this.timestamp()), stepKey: 'object_verified',
        status: 'succeeded', checkpoint: { objectId: payload.objectId, sha256: descriptor.sha256,
          sizeBytes: descriptor.size }, outputRef: { provider: descriptor.provider, bucket: descriptor.bucket,
          key: descriptor.key, versionId: descriptor.versionId, etag: descriptor.etag } });
      await heartbeat.pulse();
      await heartbeat.stop();
      const record = await this.records.complete(lease, descriptor, this.timestamp());
      return { status: 'succeeded', jobId: lease.job.id, objectId, record };
    } catch (error) {
      await heartbeat.stop().catch(() => undefined);
      if (error instanceof JobQueueError && error.code === 'JOB_LEASE_LOST') throw error;
      return this.failLease(lease, objectId, error);
    }
  }

  private async failLease(lease: JobLease, objectId: string,
    error: unknown): Promise<ProductionMediaObjectWorkerResult> {
    const errorCode = projectionErrorCode(error);
    const retryable = isRetryableProjectionError(error);
    const now = this.timestamp();
    const retryAt = new Date(Date.parse(now) + this.retryBackoffMs).toISOString();
    const failed = await this.records.fail(lease, errorCode, retryable, retryAt, now);
    return { status: failed.job.state === 'queued' ? 'retry_scheduled' : 'failed',
      jobId: lease.job.id, objectId, errorCode };
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let worked = false;
      try { worked = (await this.runOnce()).status !== 'idle'; }
      catch (error) {
        this.logger.warn(`Object projection worker poll failed: ${projectionErrorCode(error)}`);
      }
      if (!worked && !signal.aborted) await this.wait(this.pollIntervalMs, signal);
    }
  }

  private startHeartbeat(lease: JobLease) {
    let stopped = false;
    let failure: unknown;
    let tail: Promise<void> = Promise.resolve();
    const schedule = () => {
      if (stopped || failure) return tail;
      tail = tail.then(async () => {
        await this.jobs.heartbeat({ ...leaseIdentity(lease, this.timestamp()), leaseMs: this.leaseMs });
      }).catch(error => { failure = error; });
      return tail;
    };
    const timer = setInterval(() => { void schedule(); }, this.heartbeatMs);
    timer.unref();
    return {
      pulse: async () => {
        await schedule();
        if (failure) throw failure;
      },
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await tail;
        if (failure) throw failure;
      },
    };
  }

  private timestamp(): string {
    const now = this.now();
    if (!Number.isFinite(now.valueOf())) throw new ProductionMediaObjectRecordError(
      'OBJECT_PROJECTION_CLOCK_INVALID', '对象投影时间源无效。');
    return now.toISOString();
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      timer.unref();
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  }
}

function leaseIdentity(lease: JobLease, now: string) {
  return { workspaceId: lease.job.workspaceId, jobId: lease.job.id,
    workerId: lease.workerId, fencingToken: lease.fencingToken, now };
}

function projectionErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    && /^[A-Z][A-Z0-9_]{2,95}$/u.test((error as { code: string }).code)) {
    return (error as { code: string }).code;
  }
  return 'OBJECT_PROJECTION_INTERNAL';
}

function isRetryableProjectionError(error: unknown): boolean {
  if (error instanceof ObjectStorageError) {
    return ['OBJECT_STORAGE_UNAVAILABLE', 'OBJECT_WRITE_UNVERIFIED'].includes(error.code);
  }
  if (error instanceof ProductionMediaObjectRecordError) {
    return ['OBJECT_PROJECTION_PERSISTENCE_UNAVAILABLE'].includes(error.code);
  }
  if (error instanceof ProductionMediaError) return error.status >= 500;
  if (error instanceof JobQueueError) return error.code !== 'JOB_INPUT_INVALID' && error.code !== 'JOB_LEASE_LOST';
  return true;
}

function bounded(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} is out of range.`);
  return value;
}
