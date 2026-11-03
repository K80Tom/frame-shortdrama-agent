import type { DataEventV1 } from '@lyra/shared';
import type { DataOutboxRepository } from './repository';
import type { StoredDataEvent } from './outbox';
import type { DataProjector } from './projector';

export interface DataDispatcherOptions {
  batchSize?: number;
  maxAttempts?: number;
  backoffMs?: number;
  now?: () => Date;
}

export interface DispatchSummary {
  scanned: number;
  projected: number;
  duplicates: number;
  gaps: number;
  quarantined: number;
  failed: number;
  deadLettered: number;
}

function eventOf(stored: StoredDataEvent): DataEventV1 { return stored.event; }

/**
 * Outbox 消费者：逐条投递、失败退避、版本缺口不阻塞其他 aggregate。
 * 投影/处理记录/checkpoint 的原子性由 ProjectionStore.commit 保证。
 */
export class DataDispatcher {
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly outbox: DataOutboxRepository,
    private readonly projector: DataProjector,
    options: DataDispatcherOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 50;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.backoffMs = options.backoffMs ?? 1000;
    this.now = options.now ?? (() => new Date());
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 500) {
      throw new Error('batchSize must be 1..500.');
    }
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 100) {
      throw new Error('maxAttempts must be 1..100.');
    }
    if (!Number.isInteger(this.backoffMs) || this.backoffMs < 0) throw new Error('backoffMs must be non-negative.');
  }

  private timestamp(): string { return this.now().toISOString(); }

  private retryAt(attempts: number): string {
    const delay = this.backoffMs * Math.min(2 ** Math.max(0, attempts - 1), 60);
    return new Date(Date.parse(this.timestamp()) + delay).toISOString();
  }

  async runOnce(): Promise<DispatchSummary> {
    const pending = await this.outbox.listPending(this.batchSize, this.timestamp());
    const summary: DispatchSummary = {
      scanned: pending.length, projected: 0, duplicates: 0, gaps: 0, quarantined: 0, failed: 0, deadLettered: 0,
    };
    for (const stored of pending) {
      const event = eventOf(stored);
      try {
        const result = await this.projector.deliver(event);
        if (result.status === 'projected') {
          await this.outbox.markPublished(stored.outboxId, this.timestamp());
          summary.projected += 1;
        } else if (result.status === 'duplicate') {
          await this.outbox.markPublished(stored.outboxId, this.timestamp());
          summary.duplicates += 1;
        } else if (result.status === 'quarantined') {
          // 未识别 schema 不再重试；原因已写入隔离区。
          await this.outbox.markPublished(stored.outboxId, this.timestamp());
          summary.quarantined += 1;
        } else {
          const failed = await this.outbox.markFailure(stored.outboxId,
            result.reason ?? 'DATA_OUTBOX_ORDER_GAP', this.retryAt(stored.attempts + 1), this.maxAttempts);
          summary.gaps += 1;
          if (failed.status === 'dead_letter') summary.deadLettered += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '投影失败。';
        const failed = await this.outbox.markFailure(stored.outboxId, message,
          this.retryAt(stored.attempts + 1), this.maxAttempts);
        summary.failed += 1;
        if (failed.status === 'dead_letter') summary.deadLettered += 1;
      }
    }
    return summary;
  }
}
