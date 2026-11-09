import {
  OutboxTaskError, type OutboxConsumerRecord, type OutboxTaskRecord, type OutboxTaskStore,
} from './contracts';
import { isWhitelistedOutboxTaskType } from './handlers';

export interface OutboxSubmitInput {
  readonly taskType: string;
  readonly payload: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly aggregateType?: string | null;
  readonly aggregateId?: string | null;
  readonly maxAttempts?: number;
  readonly availableAt?: string;
}

/** Outbox 任务应用服务：供 HTTP 控制器与 Worker 装配复用。 */
export class OutboxTaskService {
  constructor(private readonly store: OutboxTaskStore) {}

  /** 租户作用域内提交任务（幂等键冲突返回既有任务）。 */
  async submit(input: OutboxSubmitInput): Promise<OutboxTaskRecord> {
    if (!isWhitelistedOutboxTaskType(input.taskType)) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', `不支持的任务类型：${input.taskType}`);
    }
    if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', '任务负载必须是 JSON 对象。');
    }
    return this.store.append({
      taskType: input.taskType,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      aggregateType: input.aggregateType ?? null,
      aggregateId: input.aggregateId ?? null,
      maxAttempts: input.maxAttempts,
      availableAt: input.availableAt,
    });
  }

  /** 租户作用域内查询任务与消费者证据链。 */
  async status(taskId: string): Promise<{ task: OutboxTaskRecord; consumers: OutboxConsumerRecord[] } | null> {
    const task = await this.store.getTask({ taskId });
    if (!task) return null;
    const consumers = await this.store.listConsumerRecords({ taskId, limit: 20 });
    return { task, consumers };
  }

  async list(): Promise<OutboxTaskRecord[]> {
    return this.store.listTasks({ limit: 50 });
  }
}
