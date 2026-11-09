import { randomBytes } from 'node:crypto';
import {
  OUTBOX_TASK_ID_PATTERN, OutboxTaskError, assertOutboxIdempotencyKey, assertOutboxPayload,
  assertOutboxTaskType, outboxRetryDelayMs, truncateOutboxError,
  type OutboxClaimInput, type OutboxCompleteInput, type OutboxConsumerRecord,
  type OutboxFailInput, type OutboxReplayInput, type OutboxReplayOutcome,
  type OutboxTaskAppendInput, type OutboxTaskAppendWithClientInput, type OutboxTaskRecord,
  type OutboxTaskState, type OutboxTaskStore,
} from './contracts';

interface TaskEntry {
  taskId: string;
  workspaceId: string;
  taskType: string;
  aggregateType: string | null;
  aggregateId: string | null;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  state: OutboxTaskState;
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  fencingToken: number;
  deliveredAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ReplayEntry {
  replayId: string;
  workspaceId: string;
  requestedBy: string;
  reason: string;
  filter: { workspaceId: string | null; taskType: string | null; before: string | null };
  scanned: number;
  requeued: number;
  createdAt: number;
}

export interface MemoryOutboxTaskStoreOptions {
  readonly now?: () => number;
}

/** 内存实现：单测使用；状态机/幂等/退避语义与 PostgreSQL 实现一致。 */
export class MemoryOutboxTaskStore implements OutboxTaskStore {
  private readonly tasks = new Map<string, TaskEntry>();
  private readonly consumerRecords = new Map<string, OutboxConsumerRecord>();
  private readonly replays = new Map<string, ReplayEntry>();

  constructor(private readonly options: MemoryOutboxTaskStoreOptions = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private toRecord(entry: TaskEntry): OutboxTaskRecord {
    return { ...entry, availableAt: new Date(entry.availableAt).toISOString(),
      leaseExpiresAt: entry.leaseExpiresAt === null ? null : new Date(entry.leaseExpiresAt).toISOString(),
      deliveredAt: entry.deliveredAt === null ? null : new Date(entry.deliveredAt).toISOString(),
      createdAt: new Date(entry.createdAt).toISOString(), updatedAt: new Date(entry.updatedAt).toISOString() };
  }

  async append(input: OutboxTaskAppendInput): Promise<OutboxTaskRecord> {
    const workspaceId = input.workspaceId;
    if (!workspaceId) throw new OutboxTaskError('OUTBOX_TASK_INVALID', '任务工作区缺失。');
    const created = this.createEntry(input, workspaceId, this.now());
    return this.toRecord(created);
  }

  async appendWithClient(_client: unknown, input: OutboxTaskAppendWithClientInput): Promise<OutboxTaskRecord | null> {
    const now = this.now();
    const existing = this.findByKey(input.workspaceId, input.idempotencyKey);
    if (existing) return null;
    return this.toRecord(this.createEntry(input, input.workspaceId, now));
  }

  async claimBatch(input: OutboxClaimInput): Promise<OutboxTaskRecord[]> {
    const now = input.now ? Date.parse(input.now) : this.now();
    if (!Number.isSafeInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 200) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', 'batchSize 必须在 1-200 之间。');
    }
    // 与 PostgreSQL 实现一致：领取前先回收过期 delivering 租约（崩溃恢复）。
    for (const entry of this.tasks.values()) {
      if (entry.state === 'delivering' && entry.leaseExpiresAt !== null && entry.leaseExpiresAt <= now) {
        entry.state = 'pending';
        entry.leaseOwner = null;
        entry.leaseExpiresAt = null;
        entry.updatedAt = now;
      }
    }
    const claimed: OutboxTaskRecord[] = [];
    const candidates = [...this.tasks.values()]
      .filter(entry => entry.state === 'pending' || entry.state === 'failed')
      .filter(entry => entry.availableAt <= now)
      .sort((a, b) => a.availableAt - b.availableAt || a.createdAt - b.createdAt
        || a.taskId.localeCompare(b.taskId));
    for (const entry of candidates) {
      if (claimed.length >= input.batchSize) break;
      entry.state = 'delivering';
      entry.leaseOwner = input.workerId;
      entry.leaseExpiresAt = now + input.leaseMs;
      entry.fencingToken += 1;
      entry.updatedAt = now;
      claimed.push(this.toRecord(entry));
    }
    return claimed;
  }

  async completeDelivery(input: OutboxCompleteInput): Promise<'delivered' | 'already'> {
    const now = input.now ? Date.parse(input.now) : this.now();
    const entry = this.tasks.get(input.taskId);
    if (!entry || entry.workspaceId !== input.workspaceId) {
      throw new OutboxTaskError('OUTBOX_TASK_NOT_FOUND', '任务不存在。');
    }
    if (entry.state === 'delivered') return 'already';
    if (entry.state !== 'delivering' || entry.leaseOwner !== input.workerId
      || entry.fencingToken !== input.fencingToken) {
      throw new OutboxTaskError('OUTBOX_TASK_CONFLICT', '任务租约已变更，本次完成投递被拒绝。');
    }
    entry.state = 'delivered';
    entry.deliveredAt = now;
    entry.updatedAt = now;
    entry.leaseOwner = null;
    entry.leaseExpiresAt = null;
    const key = `${input.consumerName}:${input.taskId}`;
    if (!this.consumerRecords.has(key)) {
      this.consumerRecords.set(key, {
        consumerName: input.consumerName,
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        ownerInstanceId: input.workerId,
        fencingToken: input.fencingToken,
        result: input.result ?? {},
        processedAt: new Date(now).toISOString(),
      });
    }
    return 'delivered';
  }

  async markFailed(input: OutboxFailInput): Promise<OutboxTaskRecord> {
    const now = input.now ? Date.parse(input.now) : this.now();
    const entry = this.tasks.get(input.taskId);
    if (!entry || entry.workspaceId !== input.workspaceId) {
      throw new OutboxTaskError('OUTBOX_TASK_NOT_FOUND', '任务不存在。');
    }
    if (entry.state !== 'delivering' || entry.leaseOwner !== input.workerId
      || entry.fencingToken !== input.fencingToken) {
      throw new OutboxTaskError('OUTBOX_TASK_CONFLICT', '任务租约已变更，本次失败登记被拒绝。');
    }
    const nextAttempts = entry.attempts + 1;
    const dead = nextAttempts >= entry.maxAttempts;
    entry.attempts = nextAttempts;
    entry.state = dead ? 'dead_letter' : 'failed';
    entry.leaseOwner = null;
    entry.leaseExpiresAt = null;
    entry.availableAt = now + outboxRetryDelayMs(input.retryBaseMs, nextAttempts);
    entry.lastError = truncateOutboxError(input.message);
    entry.updatedAt = now;
    return this.toRecord(entry);
  }

  async recoverExpiredLeases(input: { now?: string; limit?: number } = {}): Promise<number> {
    const now = input.now ? Date.parse(input.now) : this.now();
    const limit = input.limit ?? 500;
    let recovered = 0;
    for (const entry of this.tasks.values()) {
      if (recovered >= limit) break;
      if (entry.state === 'delivering' && entry.leaseExpiresAt !== null && entry.leaseExpiresAt <= now) {
        entry.state = 'pending';
        entry.leaseOwner = null;
        entry.leaseExpiresAt = null;
        entry.updatedAt = now;
        recovered += 1;
      }
    }
    return recovered;
  }

  async getTask(input: { taskId: string; workspaceId?: string }): Promise<OutboxTaskRecord | null> {
    const entry = this.tasks.get(input.taskId);
    if (!entry) return null;
    if (input.workspaceId && entry.workspaceId !== input.workspaceId) return null;
    return this.toRecord(entry);
  }

  async listTasks(input: { workspaceId?: string; states?: readonly OutboxTaskState[]; limit?: number }):
    Promise<OutboxTaskRecord[]> {
    const limit = input.limit ?? 50;
    return [...this.tasks.values()]
      .filter(entry => (!input.workspaceId || entry.workspaceId === input.workspaceId)
        && (!input.states || input.states.includes(entry.state)))
      .sort((a, b) => b.createdAt - a.createdAt || b.taskId.localeCompare(a.taskId))
      .slice(0, limit)
      .map(entry => this.toRecord(entry));
  }

  async getConsumerRecord(input: { consumerName: string; taskId: string }): Promise<OutboxConsumerRecord | null> {
    return this.consumerRecords.get(`${input.consumerName}:${input.taskId}`) ?? null;
  }

  async listConsumerRecords(input: { taskId: string; limit?: number }): Promise<OutboxConsumerRecord[]> {
    const limit = input.limit ?? 50;
    return [...this.consumerRecords.values()]
      .filter(record => record.taskId === input.taskId)
      .sort((a, b) => Date.parse(b.processedAt) - Date.parse(a.processedAt))
      .slice(0, limit);
  }

  async requeueForReplay(input: OutboxReplayInput): Promise<OutboxReplayOutcome> {
    const now = input.now ? Date.parse(input.now) : this.now();
    const before = input.before ? Date.parse(input.before) : null;
    if (input.before && (before === null || Number.isNaN(before))) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', 'before 时间无效。');
    }
    let scanned = 0;
    let requeued = 0;
    for (const entry of this.tasks.values()) {
      if (input.workspaceId && entry.workspaceId !== input.workspaceId) continue;
      if (input.taskType && entry.taskType !== input.taskType) continue;
      if (before !== null && entry.updatedAt > before) continue;
      if (entry.state !== 'failed' && entry.state !== 'dead_letter' && entry.state !== 'delivered') continue;
      scanned += 1;
      entry.state = 'pending';
      entry.leaseOwner = null;
      entry.leaseExpiresAt = null;
      entry.deliveredAt = null;
      entry.availableAt = now;
      entry.updatedAt = now;
      requeued += 1;
    }
    const workspaceId = input.workspaceId ?? 'ws_00000000000000000000000000000000';
    this.replays.set(input.replayId, {
      replayId: input.replayId, workspaceId, requestedBy: input.requestedBy, reason: input.reason,
      filter: { workspaceId: input.workspaceId ?? null, taskType: input.taskType ?? null, before: input.before ?? null },
      scanned, requeued, createdAt: now,
    });
    return { replayId: input.replayId, scanned, requeued };
  }

  async getReplayRun(input: { replayId: string }):
    Promise<{ replayId: string; workspaceId: string; requestedBy: string; reason: string;
      scanned: number; requeued: number; createdAt: string } | null> {
    const entry = this.replays.get(input.replayId);
    return entry
      ? { replayId: entry.replayId, workspaceId: entry.workspaceId, requestedBy: entry.requestedBy,
        reason: entry.reason, scanned: entry.scanned, requeued: entry.requeued,
        createdAt: new Date(entry.createdAt).toISOString() }
      : null;
  }

  private createEntry(input: OutboxTaskAppendInput, workspaceId: string, now: number): TaskEntry {
    const taskType = assertOutboxTaskType(input.taskType);
    const idempotencyKey = assertOutboxIdempotencyKey(input.idempotencyKey);
    const payload = assertOutboxPayload(input.payload);
    const existing = this.findByKey(workspaceId, idempotencyKey);
    if (existing) return existing;
    if ((input.aggregateType ?? null) === null !== ((input.aggregateId ?? null) === null)) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', 'aggregate_type 与 aggregate_id 必须成对出现。');
    }
    const maxAttempts = input.maxAttempts ?? 5;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', 'maxAttempts 必须在 1-100 之间。');
    }
    const availableAt = input.availableAt ? Date.parse(input.availableAt) : now;
    if (Number.isNaN(availableAt)) throw new OutboxTaskError('OUTBOX_TASK_INVALID', 'availableAt 时间无效。');
    const entry: TaskEntry = {
      taskId: `iobx_${randomBytes(16).toString('hex')}`,
      workspaceId, taskType, aggregateType: input.aggregateType ?? null, aggregateId: input.aggregateId ?? null,
      idempotencyKey, payload, state: 'pending', attempts: 0, maxAttempts,
      availableAt: Number.isNaN(availableAt) ? now : availableAt,
      leaseOwner: null, leaseExpiresAt: null, fencingToken: 0, deliveredAt: null,
      lastError: null, createdAt: now, updatedAt: now,
    };
    this.tasks.set(entry.taskId, entry);
    return entry;
  }

  private findByKey(workspaceId: string, idempotencyKey: string): TaskEntry | null {
    return [...this.tasks.values()].find(entry => entry.workspaceId === workspaceId
      && entry.idempotencyKey === idempotencyKey) ?? null;
  }
}

export { OUTBOX_TASK_ID_PATTERN };
