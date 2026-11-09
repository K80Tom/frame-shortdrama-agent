import { randomBytes } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { PostgresDatabase } from '../../db/client';
import { tenantExecutionScope } from '../../tenancy/scope';
import { LEGACY_WORKSPACE_ID, parseWorkspaceId } from '../../tenancy/context';
import {
  OUTBOX_CONSUMER_NAME_PATTERN, OUTBOX_TASK_STATES, OUTBOX_TASK_ID_PATTERN, OUTBOX_TASK_TYPE_PATTERN,
  OutboxTaskError, assertOutboxIdempotencyKey, assertOutboxPayload, assertOutboxTaskType,
  outboxRetryDelayMs, truncateOutboxError,
  type OutboxClaimInput, type OutboxCompleteInput, type OutboxConsumerRecord,
  type OutboxFailInput, type OutboxReplayInput, type OutboxReplayOutcome, type OutboxTaskAppendInput,
  type OutboxTaskAppendWithClientInput, type OutboxTaskRecord, type OutboxTaskState,
  type OutboxTaskStore,
} from './contracts';

interface TaskRow extends QueryResultRow {
  task_id: string;
  workspace_id: string;
  task_type: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  idempotency_key: string;
  payload_json: Record<string, unknown>;
  state: OutboxTaskState;
  attempts: number;
  max_attempts: number;
  available_at: Date;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  fencing_token: string | number;
  delivered_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toTask(row: TaskRow): OutboxTaskRecord {
  return {
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    taskType: row.task_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    idempotencyKey: row.idempotency_key,
    payload: row.payload_json,
    state: row.state,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: row.available_at.toISOString(),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: iso(row.lease_expires_at),
    fencingToken: Number(row.fencing_token),
    deliveredAt: iso(row.delivered_at),
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const TASK_COLUMNS = `task_id, workspace_id, task_type, aggregate_type, aggregate_id, idempotency_key,
  payload_json, state, attempts, max_attempts, available_at, lease_owner, lease_expires_at,
  fencing_token, delivered_at, last_error, created_at, updated_at`;
const TASK_COLUMNS_PREFIXED = TASK_COLUMNS
  .split(',')
  .map(column => `task.${column.trim()}`)
  .join(', ');

function uniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === '23505';
}

function isUniqueAcrossSchemas(error: unknown): boolean {
  return uniqueViolation(error) && (error as { constraint?: string }).constraint === 'infra_outbox_workspace_idempotency';
}

/**
 * infra_outbox_tasks / infra_outbox_consumer_records / infra_outbox_replay_runs
 * 的 PostgreSQL 实现（030 租户契约 + RLS 强制隔离）。
 *
 * 作用域约定：append/appendWithClient/completeDelivery/markFailed/getTask/
 * listTasks 运行于调用方当前作用域（租户或系统）；claimBatch/
 * recoverExpiredLeases/requeueForReplay 内部进入审计系统作用域（跨工作区）。
 */
export class PostgresOutboxTaskStore implements OutboxTaskStore {
  constructor(private readonly database: PostgresDatabase) {}

  async append(input: OutboxTaskAppendInput): Promise<OutboxTaskRecord> {
    const workspaceId = input.workspaceId ?? currentTenantWorkspace(this.database);
    const validated = this.validate(input);
    try {
      const inserted = await this.database.query<TaskRow>(`
        INSERT INTO infra_outbox_tasks
          (task_id, workspace_id, task_type, aggregate_type, aggregate_id, idempotency_key,
           payload_json, state, attempts, max_attempts, available_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending', 0, $8, $9, $9, $9)
        RETURNING ${TASK_COLUMNS}
      `, [
        newOutboxTaskId(), workspaceId, validated.taskType, validated.aggregateType,
        validated.aggregateId, validated.idempotencyKey, validated.payload,
        validated.maxAttempts, validated.availableAt,
      ]);
      const insertedRow = inserted.rows[0];
      if (!insertedRow) throw new OutboxTaskError('OUTBOX_TASK_INVALID', '任务写入失败。');
      return toTask(insertedRow);
    } catch (error) {
      if (isUniqueAcrossSchemas(error)) {
        const existing = await this.findByKey(workspaceId, validated.idempotencyKey);
        if (existing) return existing;
      }
      throw error;
    }
  }

  async appendWithClient(client: PoolClient, input: OutboxTaskAppendWithClientInput): Promise<OutboxTaskRecord | null> {
    const validated = this.validate(input);
    const workspaceId = parseWorkspaceId(input.workspaceId);
    const result = await client.query<TaskRow>(`
      INSERT INTO infra_outbox_tasks
        (task_id, workspace_id, task_type, aggregate_type, aggregate_id, idempotency_key,
         payload_json, state, attempts, max_attempts, available_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending', 0, $8, $9, $9, $9)
      ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
      RETURNING ${TASK_COLUMNS}
    `, [
      newOutboxTaskId(), workspaceId, validated.taskType, validated.aggregateType,
      validated.aggregateId, validated.idempotencyKey, validated.payload,
      validated.maxAttempts, validated.availableAt,
    ]);
    return result.rows[0] ? toTask(result.rows[0]) : null;
  }

  async claimBatch(input: OutboxClaimInput): Promise<OutboxTaskRecord[]> {
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u.test(input.workerId)) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', 'workerId 格式无效。');
    }
    if (!Number.isSafeInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 200) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', 'batchSize 必须在 1-200 之间。');
    }
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1_000 || input.leaseMs > 3_600_000) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', '租约时长无效。');
    }
    return this.database.runAsSystem('outbox.claim', () => this.database.transaction(async client => {
      const now = input.now ? new Date(input.now) : new Date();
      const recovered = await client.query(`
        UPDATE infra_outbox_tasks
        SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = $1
        WHERE state = 'delivering' AND lease_expires_at <= $1
      `, [now]);
      void recovered;
      const claimed = await client.query<TaskRow>(`
        WITH candidates AS (
          SELECT task_id FROM infra_outbox_tasks
          WHERE state IN ('pending', 'failed') AND available_at <= $1
          ORDER BY available_at, created_at, task_id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        UPDATE infra_outbox_tasks task
        SET state = 'delivering', lease_owner = $3, lease_expires_at = $4,
            fencing_token = task.fencing_token + 1, updated_at = $1
        FROM candidates
        WHERE task.task_id = candidates.task_id
        RETURNING ${TASK_COLUMNS_PREFIXED}
      `, [now, input.batchSize, input.workerId, new Date(now.getTime() + input.leaseMs)]);
      return claimed.rows.map(toTask);
    }));
  }

  async completeDelivery(input: OutboxCompleteInput): Promise<'delivered' | 'already'> {
    const now = input.now ? new Date(input.now) : new Date();
    if (!OUTBOX_TASK_ID_PATTERN.test(input.taskId)) throw new OutboxTaskError('OUTBOX_TASK_INVALID', '任务标识无效。');
    if (!OUTBOX_CONSUMER_NAME_PATTERN.test(input.consumerName)) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', '消费者名称无效。');
    }
    return this.database.transaction(async client => {
      const updated = await client.query<TaskRow>(`
        UPDATE infra_outbox_tasks
        SET state = 'delivered', delivered_at = $3, updated_at = $3,
            lease_owner = NULL, lease_expires_at = NULL
        WHERE task_id = $1 AND workspace_id = $2
          AND state = 'delivering'
          AND lease_owner = $4 AND fencing_token = $5
        RETURNING ${TASK_COLUMNS}
      `, [input.taskId, input.workspaceId, now, input.workerId, input.fencingToken]);
      if (updated.rows[0]) {
        await client.query(`
          INSERT INTO infra_outbox_consumer_records
            (consumer_name, task_id, workspace_id, owner_instance_id, fencing_token, result_json, processed_at)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
          ON CONFLICT (consumer_name, task_id) DO NOTHING
        `, [input.consumerName, input.taskId, input.workspaceId, input.workerId,
          input.fencingToken, JSON.stringify(input.result ?? {}), now]);
        return 'delivered';
      }
      const current = await client.query<{ state: OutboxTaskState }>(
        'SELECT state FROM infra_outbox_tasks WHERE task_id = $1 AND workspace_id = $2',
        [input.taskId, input.workspaceId]);
      if (!current.rows[0]) throw new OutboxTaskError('OUTBOX_TASK_NOT_FOUND', '任务不存在。');
      if (current.rows[0].state === 'delivered') return 'already';
      throw new OutboxTaskError('OUTBOX_TASK_CONFLICT', '任务租约已变更，本次完成投递被拒绝。');
    });
  }

  async markFailed(input: OutboxFailInput): Promise<OutboxTaskRecord> {
    const now = input.now ? new Date(input.now) : new Date();
    const message = truncateOutboxError(input.message);
    return this.database.transaction(async client => {
      const current = await client.query<TaskRow>(`
        SELECT ${TASK_COLUMNS} FROM infra_outbox_tasks
        WHERE task_id = $1 AND workspace_id = $2 FOR UPDATE
      `, [input.taskId, input.workspaceId]);
      const row = current.rows[0];
      if (!row) throw new OutboxTaskError('OUTBOX_TASK_NOT_FOUND', '任务不存在。');
      if (row.state !== 'delivering' || row.lease_owner !== input.workerId
        || Number(row.fencing_token) !== input.fencingToken) {
        throw new OutboxTaskError('OUTBOX_TASK_CONFLICT', '任务租约已变更，本次失败登记被拒绝。');
      }
      const attempts = Number(row.attempts);
      const nextAttempts = attempts + 1;
      const dead = nextAttempts >= Number(row.max_attempts);
      const delay = outboxRetryDelayMs(input.retryBaseMs, nextAttempts);
      const updated = await client.query<TaskRow>(`
        UPDATE infra_outbox_tasks
        SET state = $3, attempts = $4, lease_owner = NULL, lease_expires_at = NULL,
            available_at = $5, last_error = $6, updated_at = $2
        WHERE task_id = $1
        RETURNING ${TASK_COLUMNS}
      `, [input.taskId, now, dead ? 'dead_letter' : 'failed', nextAttempts,
        new Date(now.getTime() + delay), message]);
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new OutboxTaskError('OUTBOX_TASK_INVALID', '失败登记写入失败。');
      return toTask(updatedRow);
    });
  }

  async recoverExpiredLeases(input: { now?: string; limit?: number } = {}): Promise<number> {
    const now = input.now ? new Date(input.now) : new Date();
    const limit = input.limit ?? 500;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', '回收上限无效。');
    }
    return this.database.runAsSystem('outbox.recover-leases', async () => {
      const result = await this.database.query<{ task_id: string }>(`
        UPDATE infra_outbox_tasks
        SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = $1
        WHERE task_id IN (
          SELECT task_id FROM infra_outbox_tasks
          WHERE state = 'delivering' AND lease_expires_at <= $1
          LIMIT $2
        )
        RETURNING task_id
      `, [now, limit]);
      return result.rowCount ?? 0;
    });
  }

  async getTask(input: { taskId: string; workspaceId?: string }): Promise<OutboxTaskRecord | null> {
    if (!OUTBOX_TASK_ID_PATTERN.test(input.taskId)) return null;
    const workspaceFilter = input.workspaceId ? 'AND workspace_id = $2' : '';
    const values: unknown[] = input.workspaceId ? [input.taskId, input.workspaceId] : [input.taskId];
    const rows = await this.database.query<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM infra_outbox_tasks WHERE task_id = $1 ${workspaceFilter}`, values);
    return rows.rows[0] ? toTask(rows.rows[0]) : null;
  }

  async listTasks(input: { workspaceId?: string; states?: readonly OutboxTaskState[]; limit?: number }):
    Promise<OutboxTaskRecord[]> {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', '列表上限无效。');
    }
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (input.workspaceId) {
      values.push(input.workspaceId);
      conditions.push(`workspace_id = $${values.length}`);
    }
    if (input.states?.length) {
      for (const state of input.states) {
        if (!OUTBOX_TASK_STATES.includes(state)) {
          throw new OutboxTaskError('OUTBOX_TASK_INVALID', '任务状态无效。');
        }
      }
      values.push(input.states);
      conditions.push(`state = ANY($${values.length}::text[])`);
    }
    values.push(limit);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await this.database.query<TaskRow>(`
      SELECT ${TASK_COLUMNS} FROM infra_outbox_tasks ${where}
      ORDER BY created_at DESC, task_id DESC LIMIT $${values.length}
    `, values);
    return rows.rows.map(toTask);
  }

  async getConsumerRecord(input: { consumerName: string; taskId: string }): Promise<OutboxConsumerRecord | null> {
    if (!OUTBOX_CONSUMER_NAME_PATTERN.test(input.consumerName)
      || !OUTBOX_TASK_ID_PATTERN.test(input.taskId)) return null;
    const rows = await this.database.query<{
      consumer_name: string; task_id: string; workspace_id: string; owner_instance_id: string | null;
      fencing_token: string | number; result_json: Record<string, unknown>; processed_at: Date;
    }>(`
      SELECT consumer_name, task_id, workspace_id, owner_instance_id, fencing_token, result_json, processed_at
      FROM infra_outbox_consumer_records WHERE consumer_name = $1 AND task_id = $2
    `, [input.consumerName, input.taskId]);
    const row = rows.rows[0];
    return row ? {
      consumerName: row.consumer_name,
      taskId: row.task_id,
      workspaceId: row.workspace_id,
      ownerInstanceId: row.owner_instance_id,
      fencingToken: Number(row.fencing_token),
      result: row.result_json,
      processedAt: row.processed_at.toISOString(),
    } : null;
  }

  async listConsumerRecords(input: { taskId: string; limit?: number }): Promise<OutboxConsumerRecord[]> {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', '列表上限无效。');
    }
    if (!OUTBOX_TASK_ID_PATTERN.test(input.taskId)) return [];
    const rows = await this.database.query<{
      consumer_name: string; task_id: string; workspace_id: string; owner_instance_id: string | null;
      fencing_token: string | number; result_json: Record<string, unknown>; processed_at: Date;
    }>(`
      SELECT consumer_name, task_id, workspace_id, owner_instance_id, fencing_token, result_json, processed_at
      FROM infra_outbox_consumer_records WHERE task_id = $1
      ORDER BY processed_at DESC LIMIT $2
    `, [input.taskId, limit]);
    return rows.rows.map(row => ({
      consumerName: row.consumer_name,
      taskId: row.task_id,
      workspaceId: row.workspace_id,
      ownerInstanceId: row.owner_instance_id,
      fencingToken: Number(row.fencing_token),
      result: row.result_json,
      processedAt: row.processed_at.toISOString(),
    }));
  }

  async requeueForReplay(input: OutboxReplayInput): Promise<OutboxReplayOutcome> {
    const now = input.now ? new Date(input.now) : new Date();
    if (!/^rply_[a-f0-9]{32}$/u.test(input.replayId)) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', '重放运行标识无效。');
    }
    if (typeof input.reason !== 'string' || input.reason.trim().length < 4 || input.reason.length > 500) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', '重放原因长度必须在 4-500 字符之间。');
    }
    return this.database.runAsSystem('outbox.replay', () => this.database.transaction(async client => {
      const workspaceId = input.workspaceId ?? LEGACY_WORKSPACE_ID;
      if (input.taskType) assertOutboxTaskType(input.taskType);
      const conditions = ['state IN (\'failed\', \'dead_letter\', \'delivered\')'];
      const values: unknown[] = [];
      if (input.workspaceId) {
        values.push(input.workspaceId);
        conditions.push(`workspace_id = $${values.length}`);
      }
      if (input.taskType) {
        values.push(input.taskType);
        conditions.push(`task_type = $${values.length}`);
      }
      if (input.before) {
        const before = new Date(input.before);
        if (Number.isNaN(before.getTime())) throw new OutboxTaskError('OUTBOX_TASK_INVALID', 'before 时间无效。');
        values.push(before);
        conditions.push(`updated_at <= $${values.length}`);
      }
      values.push(now);
      const updatedAtIndex = values.length;
      // 过滤参数与时间参数共用数组：SELECT 只绑定过滤条件，UPDATE 才附带 available_at/updated_at。
      const filterValues = values.slice(0, updatedAtIndex - 1);
      const scanned = await client.query<{ task_id: string }>(`
        SELECT task_id FROM infra_outbox_tasks WHERE ${conditions.join(' AND ')}
      `, filterValues);
      const requeued = await client.query(`
        UPDATE infra_outbox_tasks
        SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL, delivered_at = NULL,
            available_at = $${updatedAtIndex}, updated_at = $${updatedAtIndex}
        WHERE ${conditions.join(' AND ')}
      `, values);
      await client.query(`
        INSERT INTO infra_outbox_replay_runs
          (replay_id, workspace_id, requested_by, reason, filter_json, scanned, requeued, created_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
      `, [input.replayId, workspaceId, input.requestedBy, input.reason,
        JSON.stringify({ workspaceId: input.workspaceId ?? null, taskType: input.taskType ?? null, before: input.before ?? null }),
        scanned.rows.length, requeued.rowCount ?? 0, now]);
      return { replayId: input.replayId, scanned: scanned.rows.length, requeued: requeued.rowCount ?? 0 };
    }));
  }

  async getReplayRun(input: { replayId: string }):
    Promise<{ replayId: string; workspaceId: string; requestedBy: string; reason: string;
      scanned: number; requeued: number; createdAt: string } | null> {
    if (!/^rply_[a-f0-9]{32}$/u.test(input.replayId)) return null;
    return this.database.runAsSystem('outbox.replay.get', async () => {
      const rows = await this.database.query<{
        replay_id: string; workspace_id: string; requested_by: string; reason: string;
        scanned: number; requeued: number; created_at: Date;
      }>(`
        SELECT replay_id, workspace_id, requested_by, reason, scanned, requeued, created_at
        FROM infra_outbox_replay_runs WHERE replay_id = $1
      `, [input.replayId]);
      const row = rows.rows[0];
      if (!row) return null;
      return {
        replayId: row.replay_id,
        workspaceId: row.workspace_id,
        requestedBy: row.requested_by,
        reason: row.reason,
        scanned: Number(row.scanned),
        requeued: Number(row.requeued),
        createdAt: row.created_at.toISOString(),
      };
    });
  }

  private validate(input: OutboxTaskAppendInput): {
    taskType: string; idempotencyKey: string; payload: Record<string, unknown>;
    aggregateType: string | null; aggregateId: string | null; maxAttempts: number; availableAt: Date;
  } {
    const taskType = assertOutboxTaskType(input.taskType);
    const idempotencyKey = assertOutboxIdempotencyKey(input.idempotencyKey);
    const payload = assertOutboxPayload(input.payload);
    if ((input.aggregateType === undefined || input.aggregateType === null)
      !== (input.aggregateId === undefined || input.aggregateId === null)) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', 'aggregate_type 与 aggregate_id 必须成对出现。');
    }
    const maxAttempts = input.maxAttempts ?? 5;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', 'maxAttempts 必须在 1-100 之间。');
    }
    const availableAt = input.availableAt ? new Date(input.availableAt) : new Date();
    if (Number.isNaN(availableAt.getTime())) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', 'availableAt 时间无效。');
    }
    return {
      taskType, idempotencyKey, payload,
      aggregateType: input.aggregateType ?? null, aggregateId: input.aggregateId ?? null,
      maxAttempts, availableAt,
    };
  }

  private async findByKey(workspaceId: string, idempotencyKey: string): Promise<OutboxTaskRecord | null> {
    const rows = await this.database.query<TaskRow>(`
      SELECT ${TASK_COLUMNS} FROM infra_outbox_tasks
      WHERE workspace_id = $1 AND idempotency_key = $2
    `, [workspaceId, idempotencyKey]);
    return rows.rows[0] ? toTask(rows.rows[0]) : null;
  }
}

function currentTenantWorkspace(database: PostgresDatabase): string {
  void database;
  const scope = tenantExecutionScope.current();
  const workspaceId = scope?.kind === 'tenant' ? scope.tenant.workspaceId : null;
  if (!workspaceId) {
    throw new OutboxTaskError('OUTBOX_TASK_INVALID', '租户作用域缺失，无法确定任务工作区。');
  }
  return parseWorkspaceId(workspaceId);
}

function newOutboxTaskId(): string {
  return `iobx_${randomBytes(16).toString('hex')}`;
}
