import type { TenantContext } from '../../tenancy/context';
import type { PostgresDatabase } from '../../db/client';
import type { JobTenantResolver } from '../../jobs/tenant';
import type { RuntimeTask } from '../../runtime/worker-runtime';
import {
  OUTBOX_CONSUMER_NAME_PATTERN, OutboxTaskError, truncateOutboxError,
  type OutboxTaskRecord, type OutboxTaskStore,
} from './contracts';

export interface OutboxTaskHandlerContext {
  readonly task: OutboxTaskRecord;
  readonly signal: AbortSignal;
}

/** Outbox 任务处理器：execute 的副作用必须幂等（at-least-once 投递）。 */
export interface OutboxTaskHandler {
  readonly taskType: string;
  execute(context: OutboxTaskHandlerContext): Promise<Record<string, unknown>>;
}

export type OutboxPollOutcome = {
  claimed: number;
  delivered: number;
  failed: number;
  skipped: number;
};

export interface OutboxTaskConsumerOptions {
  readonly database: PostgresDatabase;
  readonly store: OutboxTaskStore;
  readonly tenantResolver: JobTenantResolver;
  readonly handlers: readonly OutboxTaskHandler[];
  readonly ownerInstanceId: string;
  readonly consumerName: string;
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly retryBaseMs: number;
  /** 单次领取的任务租约时长（崩溃恢复窗口）。 */
  readonly claimLeaseMs: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onPollError?: (error: unknown) => void;
}

/**
 * Outbox 任务消费者（RuntimeTask）。
 *
 * 每轮：系统作用域领取（先回收过期 delivering 租约）→ 逐条进入任务工作区
 * 的租户作用域执行 → 同租户事务完成投递（条件 UPDATE + 消费者记录幂等去重）
 * 或登记失败退避。租约丢失后由运行时中止循环，残留 delivering 任务由
 * recoverExpiredLeases 在租约过期后回收重投。
 */
export class OutboxTaskConsumer implements RuntimeTask {
  readonly name = 'outbox-task-consumer';
  private readonly handlers = new Map<string, OutboxTaskHandler>();

  constructor(private readonly options: OutboxTaskConsumerOptions) {
    if (!OUTBOX_CONSUMER_NAME_PATTERN.test(options.consumerName)) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', '消费者名称无效。');
    }
    for (const handler of options.handlers) {
      if (this.handlers.has(handler.taskType)) {
        throw new OutboxTaskError('OUTBOX_TASK_INVALID', `任务类型重复注册：${handler.taskType}`);
      }
      this.handlers.set(handler.taskType, handler);
    }
  }

  get registeredTaskTypes(): string[] {
    return [...this.handlers.keys()].sort();
  }

  async start(signal: AbortSignal): Promise<void> {
    const sleep = this.options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    void (async () => {
      while (!signal.aborted) {
        try {
          await this.pollOnce(signal);
        } catch (error) {
          if (!signal.aborted) this.options.onPollError?.(error);
        }
        if (signal.aborted) break;
        await sleep(this.options.pollIntervalMs);
      }
    })();
  }

  async stop(): Promise<void> {
    // 循环由 abort 信号退出；在投递中的任务由租约回收机制兜底。
  }

  /** 单次轮询：领取并消费一批。测试可直接调用驱动全流程。 */
  async pollOnce(signal: AbortSignal = new AbortController().signal): Promise<OutboxPollOutcome> {
    const claimed = await this.options.database.runAsSystem('outbox.claim', () => this.options.store.claimBatch({
      workerId: this.options.ownerInstanceId,
      batchSize: this.options.batchSize,
      leaseMs: this.options.claimLeaseMs,
    }));
    let delivered = 0;
    let failed = 0;
    let skipped = 0;
    for (const task of claimed) {
      if (signal.aborted) break;
      const outcome = await this.consumeClaimed(task, signal);
      if (outcome === 'delivered') delivered += 1;
      else if (outcome === 'failed') failed += 1;
      else skipped += 1;
    }
    return { claimed: claimed.length, delivered, failed, skipped };
  }

  private async consumeClaimed(task: OutboxTaskRecord, signal: AbortSignal):
    Promise<'delivered' | 'failed' | 'skipped'> {
    const handler = this.handlers.get(task.taskType);
    let tenant: TenantContext;
    try {
      // 解析需要跨工作区读取成员与用户（RLS 下普通作用域不可见），必须走系统作用域。
      tenant = await this.options.database.runAsSystem('outbox.resolve-tenant',
        () => this.options.tenantResolver.resolve(task.workspaceId, `outbox:${task.taskId}`));
    } catch (error) {
      // 工作区没有可用成员：无法进入租户作用域，直接在系统作用域登记失败，
      // 避免任务在 delivering 态空转。
      await this.options.database.runAsSystem('outbox.consume.system', () => this.options.store.markFailed({
        taskId: task.taskId,
        workspaceId: task.workspaceId,
        workerId: this.options.ownerInstanceId,
        fencingToken: task.fencingToken,
        message: `租户解析失败：${truncateOutboxError(error instanceof Error ? error.message : error)}`,
        retryBaseMs: this.options.retryBaseMs,
      }));
      return 'failed';
    }
    return this.options.database.runWithTenant(tenant, async () => {
      const existing = await this.options.store.getConsumerRecord({
        consumerName: this.options.consumerName, taskId: task.taskId,
      });
      if (existing) {
        await this.options.store.completeDelivery({
          taskId: task.taskId,
          workspaceId: task.workspaceId,
          consumerName: this.options.consumerName,
          workerId: this.options.ownerInstanceId,
          fencingToken: task.fencingToken,
          result: { ...(existing.result ?? {}), skipped: true },
        });
        return 'skipped';
      }
      if (!handler) {
        await this.options.store.markFailed({
          taskId: task.taskId,
          workspaceId: task.workspaceId,
          workerId: this.options.ownerInstanceId,
          fencingToken: task.fencingToken,
          message: `没有注册的任务类型：${task.taskType}`,
          retryBaseMs: this.options.retryBaseMs,
        });
        return 'failed';
      }
      try {
        const result = await handler.execute({ task, signal });
        await this.options.store.completeDelivery({
          taskId: task.taskId,
          workspaceId: task.workspaceId,
          consumerName: this.options.consumerName,
          workerId: this.options.ownerInstanceId,
          fencingToken: task.fencingToken,
          result,
        });
        return 'delivered';
      } catch (error) {
        await this.options.store.markFailed({
          taskId: task.taskId,
          workspaceId: task.workspaceId,
          workerId: this.options.ownerInstanceId,
          fencingToken: task.fencingToken,
          message: error instanceof Error ? error.message : '未知的投递失败。',
          retryBaseMs: this.options.retryBaseMs,
        });
        return 'failed';
      }
    });
  }
}
