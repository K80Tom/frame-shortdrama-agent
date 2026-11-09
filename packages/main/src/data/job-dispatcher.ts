import type { DataOutboxRepository } from './repository';
import type { StoredDataEvent } from './outbox';
import type { TenantDataEvent } from './tenant-event';
import type { JobQueueRepository } from '../jobs/contracts';
import type { JobHandler, JobHandlerContext } from '../jobs/worker';
import { tenantExecutionScope, type TenantExecutionScope } from '../tenancy/scope';

export const DATA_PROJECTION_QUEUE = 'projection';
export const DATA_PROJECTION_JOB_KIND = 'data.outbox.project';

/** 一个 Outbox 事件可同时投递给多个幂等投影器；任一 gap/quarantine 都会阻断 ack。 */
export interface DataEventProjector {
  deliver(event: TenantDataEvent): Promise<{
    status: 'projected' | 'duplicate' | 'gap' | 'quarantined';
    reason?: string;
  }>;
}

function unref(timer: ReturnType<typeof setTimeout>): void { timer.unref?.(); }
function eventOf(stored: StoredDataEvent) { return stored.event; }

export interface DataDispatchJobPumpOptions {
  batchSize?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  executionScope?: Pick<TenantExecutionScope, 'runAsSystem'>;
  logger?: Pick<Console, 'warn'>;
}

/**
 * Dispatcher phase 1: turn each pending outbox row into a durable, fenced job.
 * It does not project inline, so multiple Worker containers can safely share
 * the queue and a process restart cannot lose an in-flight event.
 */
export class DataDispatchJobPump {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly executionScope: Pick<TenantExecutionScope, 'runAsSystem'>;
  private readonly logger: Pick<Console, 'warn'>;
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;

  constructor(private readonly outbox: DataOutboxRepository, private readonly jobs: JobQueueRepository,
    options: DataDispatchJobPumpOptions = {}) {
    this.batchSize = options.batchSize ?? 50;
    this.pollIntervalMs = options.pollIntervalMs ?? 750;
    this.now = options.now ?? (() => new Date());
    this.executionScope = options.executionScope ?? tenantExecutionScope;
    this.logger = options.logger ?? console;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 500) {
      throw new Error('batchSize must be 1..500');
    }
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 10 || this.pollIntervalMs > 60_000) {
      throw new Error('pollIntervalMs must be 10..60000');
    }
  }

  async runOnce(): Promise<number> {
    return this.executionScope.runAsSystem('data.dispatch.scan', async () => {
      const pending = await this.outbox.listPending(this.batchSize, this.now().toISOString());
      for (const stored of pending) {
        const event = eventOf(stored);
        const queued = await this.jobs.enqueue({ workspaceId: stored.workspaceId }, {
          queueName: DATA_PROJECTION_QUEUE,
          kind: DATA_PROJECTION_JOB_KIND,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          idempotencyKey: `outbox:${event.eventId}`,
          payload: { eventId: event.eventId },
          priority: 60,
          maxAttempts: 5,
          availableAt: this.now().toISOString(),
        });
        if (!queued.created && ['failed', 'dead_letter'].includes(queued.job.state)) {
          // Projection delivery is idempotent. This is an explicit safe-replay
          // decision: requeueTerminal preserves all attempts/checkpoints and a
          // stable recovery key makes a repeated scanner pass a no-op.
          await this.jobs.requeueTerminal({
            workspaceId: stored.workspaceId,
            jobId: queued.job.id,
            expectedVersion: queued.job.version,
            recoveryKey: `outbox:${event.eventId}:terminal-v${queued.job.version}`,
            reason: `Recover pending outbox event ${event.eventId}`,
            availableAt: this.now().toISOString(),
          });
        } else if (!queued.created && queued.job.state === 'succeeded') {
          // The handler publishes the outbox row before completing the job. If
          // a repaired/imported row violates that invariant, close it instead
          // of letting it permanently occupy the oldest scan window.
          await this.outbox.markPublished(stored.outboxId, this.now().toISOString());
        }
      }
      return pending.length;
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

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let found = 0;
      try { found = await this.runOnce(); }
      catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 1_000) : '未知错误';
        this.logger.warn(`Data dispatcher scan failed: ${message}`);
      }
      // Always yield. A full window can consist entirely of already-enqueued
      // rows, so looping immediately would burn CPU and starve later events.
      if (!signal.aborted) await this.wait(signal);
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, this.pollIntervalMs);
      unref(timer);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
}

/** Dispatcher phase 2: the durable job delivers one event idempotently. */
export class DataOutboxJobHandler implements JobHandler {
  readonly queueName = DATA_PROJECTION_QUEUE;
  readonly kind = DATA_PROJECTION_JOB_KIND;

  constructor(private readonly outbox: DataOutboxRepository, private readonly projector: DataEventProjector,
    private readonly options: { maxAttempts?: number; retryBaseMs?: number; now?: () => Date } = {}) {}

  async handle(context: JobHandlerContext): Promise<void> {
    const eventId = context.lease.job.payload.eventId;
    if (typeof eventId !== 'string' || !/^evt_[a-f0-9]{32}$/u.test(eventId)) {
      throw new Error('投影任务缺少有效 eventId。');
    }
    const stored = await this.outbox.getByEventId(eventId);
    if (!stored || stored.workspaceId !== context.lease.job.workspaceId) {
      throw new Error('投影任务引用的 Outbox 事件不存在或工作区不匹配。');
    }
    let result: Awaited<ReturnType<DataEventProjector['deliver']>>;
    try {
      result = await this.projector.deliver(eventOf(stored));
      if (result.status === 'gap') throw new Error(result.reason ?? 'DATA_OUTBOX_ORDER_GAP');
    } catch (error) {
      const attempts = stored.attempts + 1;
      const delay = (this.options.retryBaseMs ?? 1_000) * Math.min(2 ** Math.max(0, attempts - 1), 60);
      const at = new Date((this.options.now ?? (() => new Date()))().getTime() + delay).toISOString();
      const message = error instanceof Error ? error.message : '投影失败。';
      await this.outbox.markFailure(stored.outboxId, message, at, this.options.maxAttempts ?? 5);
      throw error;
    }
    // From this point the projection commit is already durable. A lost job
    // lease must leave the outbox pending so the next fenced attempt observes
    // a duplicate and publishes it; never turn a successful projection into a
    // dead-letter merely because its final acknowledgement raced a takeover.
    await context.assertLease();
    await this.outbox.markPublished(stored.outboxId, this.timestamp());
    await context.checkpoint('outbox.projected', {
      eventId,
      status: result.status,
      aggregateVersion: stored.event.aggregateVersion,
    }, { outboxId: stored.outboxId });
  }

  private timestamp(): string { return (this.options.now ?? (() => new Date()))().toISOString(); }
}
