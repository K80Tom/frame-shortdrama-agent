import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { canonicalDigest } from '@lyra/shared';
import type { PostgresDatabase } from '../db/client';
import { parseWorkspaceId } from '../tenancy/context';
import {
  JobQueueError,
  type ClaimJobInput,
  type CompleteJobInput,
  type EnqueueJobInput,
  type FailJobInput,
  type HeartbeatJobInput,
  type JobLease,
  type JobQueueRepository,
  type JobState,
  type PersistentJob,
  type RequeueTerminalJobInput,
  type RequeueTerminalJobResult,
  type SaveJobStepInput,
} from './contracts';

interface JobRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  queue_name: string;
  kind: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  idempotency_key: string;
  payload_json: Record<string, unknown>;
  state: JobState;
  priority: number;
  max_attempts: number;
  attempt_count: number;
  available_at: unknown;
  lease_owner: string | null;
  fencing_token: string | number;
  lease_expires_at: unknown;
  heartbeat_at: unknown;
  last_error: string | null;
  version: number;
  created_at: unknown;
  updated_at: unknown;
  completed_at: unknown;
}

const JOB_COLUMNS = `id, workspace_id, queue_name, kind, aggregate_type, aggregate_id,
  idempotency_key, payload_json, state, priority, max_attempts, attempt_count,
  available_at, lease_owner, fencing_token, lease_expires_at, heartbeat_at,
  last_error, version, created_at, updated_at, completed_at`;

const QUEUE = /^[a-z][a-z0-9_-]{1,63}$/u;
const KIND = /^[a-z][a-z0-9_.-]{2,95}$/u;
const AGGREGATE_TYPE = /^[a-z][a-z0-9_.-]{1,63}$/u;
const AGGREGATE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{2,159}$/u;
const WORKER = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u;
const JOB_ID = /^job_[a-f0-9]{32}$/u;
const STEP = /^[a-z][a-z0-9_.-]{1,95}$/u;

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}
function nullIso(value: unknown): string | null { return value === null ? null : iso(value); }

function jobOf(row: JobRow): PersistentJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    queueName: row.queue_name,
    kind: row.kind,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    idempotencyKey: row.idempotency_key,
    payload: row.payload_json,
    state: row.state,
    priority: row.priority,
    maxAttempts: row.max_attempts,
    attemptCount: row.attempt_count,
    availableAt: iso(row.available_at),
    leaseOwner: row.lease_owner,
    fencingToken: Number(row.fencing_token),
    leaseExpiresAt: nullIso(row.lease_expires_at),
    heartbeatAt: nullIso(row.heartbeat_at),
    lastError: row.last_error,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: nullIso(row.completed_at),
  };
}

function invalid(message: string): never {
  throw new JobQueueError(400, 'JOB_INPUT_INVALID', message);
}
function lost(): never {
  throw new JobQueueError(409, 'JOB_LEASE_LOST', '任务租约已过期或已被其他 Worker 接管。');
}

function timestamp(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    || Number.isNaN(Date.parse(value))) invalid(`${field} 必须是 UTC ISO 8601 时间。`);
  return new Date(value).toISOString();
}

function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || value < min || value > max) invalid(`${field} 超出允许范围。`);
  return value;
}

function safeObject(value: Record<string, unknown>, field: string, maxBytes: number): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} 必须是对象。`);
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { return invalid(`${field} 不能序列化。`); }
  if (Buffer.byteLength(encoded) > maxBytes) invalid(`${field} 过大。`);
  return encoded;
}

function queueName(value: string): string {
  if (!QUEUE.test(value)) invalid('queueName 格式无效。');
  return value;
}
function workerId(value: string): string {
  if (!WORKER.test(value)) invalid('workerId 格式无效。');
  return value;
}
function jobId(value: string): string {
  if (!JOB_ID.test(value)) invalid('jobId 格式无效。');
  return value;
}
function fencingToken(value: number): number {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, 'fencingToken');
}

function recoveryText(value: string, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > max
    || value.includes('\0') || /[\uD800-\uDFFF]/u.test(value)) invalid(`${field} 格式无效。`);
  return value.trim();
}

function assertEnqueue(input: EnqueueJobInput) {
  queueName(input.queueName);
  if (!KIND.test(input.kind)) invalid('kind 格式无效。');
  const hasType = input.aggregateType !== undefined && input.aggregateType !== null;
  const hasId = input.aggregateId !== undefined && input.aggregateId !== null;
  if (hasType !== hasId) invalid('aggregateType 与 aggregateId 必须同时提供。');
  if (hasType && !AGGREGATE_TYPE.test(input.aggregateType!)) invalid('aggregateType 格式无效。');
  if (hasId && !AGGREGATE_ID.test(input.aggregateId!)) invalid('aggregateId 格式无效。');
  if (typeof input.idempotencyKey !== 'string'
    || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) invalid('idempotencyKey 格式无效。');
  safeObject(input.payload, 'payload', 64 * 1024);
  boundedInteger(input.priority ?? 50, 0, 100, 'priority');
  boundedInteger(input.maxAttempts ?? 5, 1, 100, 'maxAttempts');
  timestamp(input.availableAt, 'availableAt');
}

function leaseInput(input: CompleteJobInput) {
  return {
    workspaceId: parseWorkspaceId(input.workspaceId),
    jobId: jobId(input.jobId),
    workerId: workerId(input.workerId),
    fencingToken: fencingToken(input.fencingToken),
    now: timestamp(input.now, 'now'),
  };
}

/** PostgreSQL queue with at-least-once delivery and fencing on every mutation. */
export class PostgresJobQueueRepository implements JobQueueRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async enqueue(tenant: { workspaceId: string }, input: EnqueueJobInput) {
    return this.database.transaction(client => this.enqueueInTransaction(client, tenant, input));
  }

  async enqueueInTransaction(client: PoolClient, tenant: { workspaceId: string }, input: EnqueueJobInput):
    Promise<{ job: PersistentJob; created: boolean }> {
    const workspaceId = parseWorkspaceId(tenant.workspaceId);
    assertEnqueue(input);
    const id = `job_${randomBytes(16).toString('hex')}`;
    const createdAt = new Date().toISOString();
    const inserted = await client.query<JobRow>(`
      INSERT INTO jobs (${JOB_COLUMNS})
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'queued', $9, $10, 0,
              $11::timestamptz, NULL, 0, NULL, NULL, NULL, 1,
              $12::timestamptz, $12::timestamptz, NULL)
      ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
      RETURNING ${JOB_COLUMNS}
    `, [id, workspaceId, input.queueName, input.kind, input.aggregateType ?? null,
      input.aggregateId ?? null, input.idempotencyKey, safeObject(input.payload, 'payload', 64 * 1024),
      input.priority ?? 50, input.maxAttempts ?? 5, input.availableAt, createdAt]);
    if (inserted.rows[0]) return { job: jobOf(inserted.rows[0]), created: true };
    const existing = await client.query<JobRow>(`
      SELECT ${JOB_COLUMNS} FROM jobs WHERE workspace_id = $1 AND idempotency_key = $2
    `, [workspaceId, input.idempotencyKey]);
    const row = existing.rows[0];
    if (!row) throw new JobQueueError(409, 'JOB_IDEMPOTENCY_CONFLICT', '任务幂等写入发生冲突。');
    if (row.queue_name !== input.queueName || row.kind !== input.kind
      || canonicalDigest(row.payload_json) !== canonicalDigest(input.payload)) {
      throw new JobQueueError(409, 'JOB_IDEMPOTENCY_CONFLICT', '同一幂等键对应了不同任务。');
    }
    return { job: jobOf(row), created: false };
  }

  async claim(input: ClaimJobInput): Promise<JobLease | null> {
    const queue = queueName(input.queueName);
    const worker = workerId(input.workerId);
    const leaseMs = boundedInteger(input.leaseMs, 1_000, 24 * 60 * 60 * 1_000, 'leaseMs');
    const now = timestamp(input.now, 'now');
    return this.database.transaction(async client => {
      // A bounded loop skips expired jobs that exhausted their attempts while
      // atomically closing their last attempt as lost/dead-letter.
      for (let scanned = 0; scanned < 100; scanned += 1) {
        const candidate = await client.query<JobRow>(`
          SELECT ${JOB_COLUMNS} FROM jobs
          WHERE queue_name = $1 AND (
            (state = 'queued' AND available_at <= $2::timestamptz)
            OR (state = 'running' AND lease_expires_at <= $2::timestamptz)
          )
          ORDER BY priority DESC, available_at, created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `, [queue, now]);
        const previous = candidate.rows[0];
        if (!previous) return null;
        if (previous.state === 'running') {
          await client.query(`
            UPDATE job_attempts
            SET status = 'lost', ended_at = $3::timestamptz,
                error_json = '{"code":"LEASE_EXPIRED"}'::jsonb
            WHERE job_id = $1 AND fencing_token = $2 AND status = 'running'
          `, [previous.id, previous.fencing_token, now]);
        }
        if (previous.attempt_count >= previous.max_attempts) {
          await client.query(`
            UPDATE jobs SET state = 'dead_letter', lease_owner = NULL,
              lease_expires_at = NULL, heartbeat_at = NULL,
              last_error = 'JOB_ATTEMPTS_EXHAUSTED', completed_at = $2::timestamptz,
              updated_at = $2::timestamptz, version = version + 1
            WHERE id = $1
          `, [previous.id, now]);
          continue;
        }
        const claimed = await client.query<JobRow>(`
          UPDATE jobs SET state = 'running', attempt_count = attempt_count + 1,
            lease_owner = $2, fencing_token = fencing_token + 1,
            lease_expires_at = $3::timestamptz + ($4::int * interval '1 millisecond'),
            heartbeat_at = $3::timestamptz, last_error = NULL,
            updated_at = $3::timestamptz, version = version + 1
          WHERE id = $1
          RETURNING ${JOB_COLUMNS}
        `, [previous.id, worker, now, leaseMs]);
        const row = claimed.rows[0]!;
        const attemptId = `jobatt_${randomBytes(16).toString('hex')}`;
        await client.query(`
          INSERT INTO job_attempts
            (id, workspace_id, job_id, attempt_number, fencing_token, worker_id, status, started_at, ended_at, error_json)
          VALUES ($1, $2, $3, $4, $5, $6, 'running', $7::timestamptz, NULL, NULL)
        `, [attemptId, row.workspace_id, row.id, row.attempt_count,
          row.fencing_token, worker, now]);
        const job = jobOf(row);
        return {
          job,
          attemptId,
          attemptNumber: job.attemptCount,
          workerId: worker,
          fencingToken: job.fencingToken,
          leaseExpiresAt: job.leaseExpiresAt!,
        };
      }
      return null;
    });
  }

  async heartbeat(input: HeartbeatJobInput): Promise<PersistentJob> {
    const identity = leaseInput(input);
    const leaseMs = boundedInteger(input.leaseMs, 1_000, 24 * 60 * 60 * 1_000, 'leaseMs');
    const result = await this.database.query<JobRow>(`
      UPDATE jobs SET heartbeat_at = $5::timestamptz,
        lease_expires_at = $5::timestamptz + ($6::int * interval '1 millisecond'),
        updated_at = $5::timestamptz, version = version + 1
      WHERE workspace_id = $1 AND id = $2 AND state = 'running'
        AND lease_owner = $3 AND fencing_token = $4
        AND lease_expires_at > $5::timestamptz
      RETURNING ${JOB_COLUMNS}
    `, [identity.workspaceId, identity.jobId, identity.workerId,
      identity.fencingToken, identity.now, leaseMs]);
    const row = result.rows[0];
    if (!row) return lost();
    return jobOf(row);
  }

  private async finish(client: PoolClient, input: CompleteJobInput,
    state: 'succeeded' | 'failed' | 'dead_letter', lastError: string | null,
    availableAt?: string): Promise<PersistentJob> {
    const identity = leaseInput(input);
    const terminal = state !== 'failed' || availableAt === undefined;
    const result = await client.query<JobRow>(`
      UPDATE jobs SET state = $6, lease_owner = NULL, lease_expires_at = NULL,
        heartbeat_at = NULL, last_error = $7, available_at = COALESCE($8::timestamptz, available_at),
        completed_at = CASE WHEN $9::boolean THEN $5::timestamptz ELSE NULL END,
        updated_at = $5::timestamptz, version = version + 1
      WHERE workspace_id = $1 AND id = $2 AND state = 'running'
        AND lease_owner = $3 AND fencing_token = $4
        AND lease_expires_at > $5::timestamptz
      RETURNING ${JOB_COLUMNS}
    `, [identity.workspaceId, identity.jobId, identity.workerId, identity.fencingToken,
      identity.now, state, lastError, availableAt ?? null, terminal]);
    const row = result.rows[0];
    if (!row) return lost();
    await client.query(`
      UPDATE job_attempts SET status = $4, ended_at = $5::timestamptz,
        error_json = $6::jsonb
      WHERE job_id = $1 AND workspace_id = $2 AND fencing_token = $3 AND status = 'running'
    `, [identity.jobId, identity.workspaceId, identity.fencingToken,
      state === 'succeeded' ? 'succeeded' : 'failed', identity.now,
      lastError === null ? null : JSON.stringify({ message: lastError })]);
    return jobOf(row);
  }

  async complete(input: CompleteJobInput): Promise<PersistentJob> {
    return this.database.transaction(client => this.completeInTransaction(client, input));
  }

  async completeInTransaction(client: PoolClient, input: CompleteJobInput): Promise<PersistentJob> {
    return this.finish(client, input, 'succeeded', null);
  }

  async fail(input: FailJobInput): Promise<PersistentJob> {
    return this.database.transaction(client => this.failInTransaction(client, input));
  }

  async failInTransaction(client: PoolClient, input: FailJobInput): Promise<PersistentJob> {
    if (typeof input.error !== 'string' || !input.error.trim()) invalid('error 不能为空。');
    const retryAt = input.retryAt === undefined ? input.now : timestamp(input.retryAt, 'retryAt');
    const identity = leaseInput(input);
    const current = await client.query<JobRow>(`
        SELECT ${JOB_COLUMNS} FROM jobs
        WHERE workspace_id = $1 AND id = $2 AND state = 'running'
          AND lease_owner = $3 AND fencing_token = $4
          AND lease_expires_at > $5::timestamptz
        FOR UPDATE
    `, [identity.workspaceId, identity.jobId, identity.workerId,
      identity.fencingToken, identity.now]);
    const row = current.rows[0];
    if (!row) return lost();
    if (input.retryable && row.attempt_count < row.max_attempts) {
      const result = await client.query<JobRow>(`
          UPDATE jobs SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL,
            heartbeat_at = NULL, last_error = $6, available_at = $7::timestamptz,
            completed_at = NULL, updated_at = $5::timestamptz, version = version + 1
          WHERE workspace_id = $1 AND id = $2 AND state = 'running'
            AND lease_owner = $3 AND fencing_token = $4
          RETURNING ${JOB_COLUMNS}
      `, [identity.workspaceId, identity.jobId, identity.workerId,
        identity.fencingToken, identity.now, input.error.slice(0, 2000), retryAt]);
      await client.query(`
          UPDATE job_attempts SET status = 'failed', ended_at = $4::timestamptz,
            error_json = $5::jsonb
          WHERE job_id = $1 AND workspace_id = $2 AND fencing_token = $3 AND status = 'running'
      `, [identity.jobId, identity.workspaceId, identity.fencingToken,
        identity.now, JSON.stringify({ message: input.error.slice(0, 2000) })]);
      return jobOf(result.rows[0]!);
    }
    return this.finish(client, input, input.retryable ? 'dead_letter' : 'failed', input.error.slice(0, 2000));
  }

  async requeueTerminal(input: RequeueTerminalJobInput): Promise<RequeueTerminalJobResult> {
    const workspaceId = parseWorkspaceId(input.workspaceId);
    const id = jobId(input.jobId);
    const expectedVersion = boundedInteger(input.expectedVersion, 1, Number.MAX_SAFE_INTEGER, 'expectedVersion');
    const recoveryKey = recoveryText(input.recoveryKey, 'recoveryKey', 200);
    const reason = recoveryText(input.reason, 'reason', 1_000);
    const availableAt = timestamp(input.availableAt, 'availableAt');
    const recoveryKeyDigest = createHash('sha256').update(recoveryKey, 'utf8').digest('hex');
    const stepKey = `requeue.${recoveryKeyDigest}`;
    return this.database.transaction(async client => {
      const selected = await client.query<JobRow>(`
        SELECT ${JOB_COLUMNS} FROM jobs
        WHERE workspace_id = $1 AND id = $2
        FOR UPDATE
      `, [workspaceId, id]);
      const current = selected.rows[0];
      if (!current) throw new JobQueueError(404, 'JOB_NOT_FOUND', '任务不存在。');
      const marker = await client.query(`
        SELECT 1 FROM job_steps
        WHERE workspace_id = $1 AND job_id = $2 AND step_key = $3
      `, [workspaceId, id, stepKey]);
      if (marker.rows[0]) return { job: jobOf(current), requeued: false };
      if (!['failed', 'dead_letter'].includes(current.state)) {
        throw new JobQueueError(409, 'JOB_REQUEUE_NOT_TERMINAL', '只能重排已失败或 dead-letter 任务。');
      }
      if (current.version !== expectedVersion) {
        throw new JobQueueError(409, 'JOB_REQUEUE_CONFLICT', '任务已被其他恢复操作更改。');
      }
      if (current.attempt_count >= 100) {
        throw new JobQueueError(409, 'JOB_REQUEUE_EXHAUSTED', '任务已达到最大历史尝试数，需要人工处置。');
      }
      const updated = await client.query<JobRow>(`
        UPDATE jobs
        SET state = 'queued', max_attempts = GREATEST(max_attempts, attempt_count + 1),
            available_at = $4::timestamptz, lease_owner = NULL,
            lease_expires_at = NULL, heartbeat_at = NULL,
            last_error = $5, completed_at = NULL,
            updated_at = $4::timestamptz, version = version + 1
        WHERE workspace_id = $1 AND id = $2 AND version = $3
          AND state IN ('failed', 'dead_letter')
        RETURNING ${JOB_COLUMNS}
      `, [workspaceId, id, expectedVersion, availableAt, `REQUEUED: ${reason}`.slice(0, 2_000)]);
      if (!updated.rows[0]) throw new JobQueueError(409, 'JOB_REQUEUE_CONFLICT', '任务重排发生并发冲突。');
      await client.query(`
        INSERT INTO job_steps
          (workspace_id, job_id, step_key, status, checkpoint_json, output_ref_json,
           error_json, version, created_at, updated_at, completed_at)
        VALUES ($1, $2, $3, 'succeeded', $4::jsonb, NULL, NULL, 1,
                $5::timestamptz, $5::timestamptz, $5::timestamptz)
      `, [workspaceId, id, stepKey, JSON.stringify({ recoveryKeyDigest, reason,
        previousState: current.state, previousVersion: current.version,
        preservedAttemptCount: current.attempt_count }), availableAt]);
      return { job: jobOf(updated.rows[0]), requeued: true };
    });
  }

  async saveStep(input: SaveJobStepInput): Promise<void> {
    const identity = leaseInput(input);
    if (!STEP.test(input.stepKey)) invalid('stepKey 格式无效。');
    const checkpoint = safeObject(input.checkpoint, 'checkpoint', 64 * 1024);
    const outputRef = input.outputRef == null ? null : safeObject(input.outputRef, 'outputRef', 16 * 1024);
    const error = input.error == null ? null : safeObject(input.error, 'error', 16 * 1024);
    await this.database.transaction(async client => {
      const lease = await client.query(`
        SELECT 1 FROM jobs
        WHERE workspace_id = $1 AND id = $2 AND state = 'running'
          AND lease_owner = $3 AND fencing_token = $4
          AND lease_expires_at > $5::timestamptz
        FOR UPDATE
      `, [identity.workspaceId, identity.jobId, identity.workerId,
        identity.fencingToken, identity.now]);
      if (!lease.rows[0]) return lost();
      const completed = ['succeeded', 'failed', 'skipped'].includes(input.status) ? identity.now : null;
      await client.query(`
        INSERT INTO job_steps
          (workspace_id, job_id, step_key, status, checkpoint_json, output_ref_json,
           error_json, version, created_at, updated_at, completed_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, 1,
                $8::timestamptz, $8::timestamptz, $9::timestamptz)
        ON CONFLICT (job_id, step_key) DO UPDATE SET
          status = EXCLUDED.status,
          checkpoint_json = EXCLUDED.checkpoint_json,
          output_ref_json = EXCLUDED.output_ref_json,
          error_json = EXCLUDED.error_json,
          version = job_steps.version + 1,
          updated_at = EXCLUDED.updated_at,
          completed_at = EXCLUDED.completed_at
      `, [identity.workspaceId, identity.jobId, input.stepKey, input.status,
        checkpoint, outputRef, error, identity.now, completed]);
    });
  }

  async get(tenant: { workspaceId: string }, id: string): Promise<PersistentJob | null> {
    const result = await this.database.query<JobRow>(`
      SELECT ${JOB_COLUMNS} FROM jobs WHERE workspace_id = $1 AND id = $2
    `, [parseWorkspaceId(tenant.workspaceId), jobId(id)]);
    return result.rows[0] ? jobOf(result.rows[0]) : null;
  }
}
