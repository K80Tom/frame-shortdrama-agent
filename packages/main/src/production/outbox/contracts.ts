import type { PoolClient } from 'pg';

/**
 * Worker 异步任务出件箱（基础设施 Outbox）。
 *
 * 与 DataEvent/Outbox（#133 领域事件 → 投影）互补：本模块承载"必须与业务
 * 事实同事务提交、随后由 Worker 异步消费"的任务（例如 staging 资源 GC、
 * 运行冒烟）。消费语义 at-least-once：handler 必须自身幂等，
 * infra_outbox_consumer_records 提供 (consumer_name, task_id) 级幂等去重
 * 与处理证据链。
 */
export const OUTBOX_TASK_ID_PATTERN = /^iobx_[a-f0-9]{32}$/u;
export const OUTBOX_TASK_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{2,95}$/u;
export const OUTBOX_CONSUMER_NAME_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/u;
export const OUTBOX_PAYLOAD_MAX_BYTES = 65_536;

export type OutboxTaskState = 'pending' | 'delivering' | 'delivered' | 'failed' | 'dead_letter';

export const OUTBOX_TASK_STATES: readonly OutboxTaskState[] =
  ['pending', 'delivering', 'delivered', 'failed', 'dead_letter'];

export interface OutboxTaskRecord {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly taskType: string;
  readonly aggregateType: string | null;
  readonly aggregateId: string | null;
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
  readonly state: OutboxTaskState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly fencingToken: number;
  readonly deliveredAt: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OutboxConsumerRecord {
  readonly consumerName: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly ownerInstanceId: string | null;
  readonly fencingToken: number;
  readonly result: Record<string, unknown>;
  readonly processedAt: string;
}

export class OutboxTaskError extends Error {
  constructor(public readonly code:
    | 'OUTBOX_TASK_INVALID'
    | 'OUTBOX_TASK_NOT_FOUND'
    | 'OUTBOX_TASK_CONFLICT'
    | 'OUTBOX_HANDLER_MISSING', message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'OutboxTaskError';
  }
}

export interface OutboxTaskAppendInput {
  readonly taskType: string;
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
  /** 系统/Worker 内部追加时必须显式给出工作区；租户作用域下可省略。 */
  readonly workspaceId?: string;
  readonly aggregateType?: string | null;
  readonly aggregateId?: string | null;
  readonly maxAttempts?: number;
  readonly availableAt?: string;
}

export interface OutboxTaskAppendWithClientInput extends OutboxTaskAppendInput {
  readonly workspaceId: string;
}

export interface OutboxClaimInput {
  readonly workerId: string;
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly now?: string;
}

export interface OutboxCompleteInput {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly consumerName: string;
  readonly workerId: string;
  readonly fencingToken: number;
  readonly result: Record<string, unknown>;
  readonly now?: string;
}

export interface OutboxFailInput {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly workerId: string;
  readonly fencingToken: number;
  readonly message: string;
  readonly retryBaseMs: number;
  readonly now?: string;
}

export interface OutboxReplayInput {
  readonly replayId: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly workspaceId?: string | null;
  readonly taskType?: string | null;
  readonly before?: string | null;
  readonly now?: string;
}

export interface OutboxReplayOutcome {
  readonly replayId: string;
  readonly scanned: number;
  readonly requeued: number;
}

/** infra_outbox_* 三表的存储端口；PostgreSQL 与内存实现共用。 */
export interface OutboxTaskStore {
  /** 在调用方当前作用域追加任务（单发）；幂等键冲突时返回既有任务。 */
  append(input: OutboxTaskAppendInput): Promise<OutboxTaskRecord>;
  /**
   * 与业务事实同事务追加：必须传入调用方事务的 client，禁止独立提交。
   * 幂等键冲突时静默返回既有任务（读取需再查一次）。
   */
  appendWithClient(client: PoolClient, input: OutboxTaskAppendWithClientInput): Promise<OutboxTaskRecord | null>;
  /** 系统作用域领取：先回收过期 delivering 租约，再 SKIP LOCKED 原子领取。 */
  claimBatch(input: OutboxClaimInput): Promise<OutboxTaskRecord[]>;
  /** 租户作用域完成投递：条件 UPDATE + 消费者记录同事务写入（幂等）。 */
  completeDelivery(input: OutboxCompleteInput): Promise<'delivered' | 'already'>;
  /** 租户作用域标记失败：指数退避重试或进入 dead_letter。 */
  markFailed(input: OutboxFailInput): Promise<OutboxTaskRecord>;
  /** 系统作用域回收过期 delivering 租约（崩溃恢复）。 */
  recoverExpiredLeases(input: { now?: string; limit?: number }): Promise<number>;
  getTask(input: { taskId: string; workspaceId?: string }): Promise<OutboxTaskRecord | null>;
  listTasks(input: { workspaceId?: string; states?: readonly OutboxTaskState[]; limit?: number }):
    Promise<OutboxTaskRecord[]>;
  getConsumerRecord(input: { consumerName: string; taskId: string }): Promise<OutboxConsumerRecord | null>;
  listConsumerRecords(input: { taskId: string; limit?: number }): Promise<OutboxConsumerRecord[]>;
  /** 系统作用域范围重放：登记 replay_runs 后把可重试任务推回 pending。 */
  requeueForReplay(input: OutboxReplayInput): Promise<OutboxReplayOutcome>;
  getReplayRun(input: { replayId: string }):
    Promise<{ replayId: string; workspaceId: string; requestedBy: string; reason: string;
      scanned: number; requeued: number; createdAt: string } | null>;
}

export function assertOutboxTaskType(value: unknown): string {
  if (typeof value !== 'string' || !OUTBOX_TASK_TYPE_PATTERN.test(value)) {
    throw new OutboxTaskError('OUTBOX_TASK_INVALID', '任务类型格式无效。');
  }
  return value;
}

export function assertOutboxIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 200) {
    throw new OutboxTaskError('OUTBOX_TASK_INVALID', '幂等键长度必须在 8-200 字符之间。');
  }
  return value;
}

export function assertOutboxPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OutboxTaskError('OUTBOX_TASK_INVALID', '任务负载必须是 JSON 对象。');
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > OUTBOX_PAYLOAD_MAX_BYTES) {
    throw new OutboxTaskError('OUTBOX_TASK_INVALID', '任务负载过大。');
  }
  return value as Record<string, unknown>;
}

/** 指数退避：base * 2^(attempts-1)，封顶 1 小时。 */
export function outboxRetryDelayMs(retryBaseMs: number, attempts: number): number {
  if (!Number.isSafeInteger(retryBaseMs) || retryBaseMs < 1) return 2_000;
  if (!Number.isSafeInteger(attempts) || attempts < 1) return retryBaseMs;
  return Math.min(retryBaseMs * 2 ** (attempts - 1), 3_600_000);
}

export function truncateOutboxError(message: unknown): string {
  const text = typeof message === 'string' && message.trim() ? message.trim() : '未知的投递失败。';
  return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
}
