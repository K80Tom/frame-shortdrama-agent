import type { TenantDataEvent } from './tenant-event';
import type { DataEventProjector } from './job-dispatcher';

/**
 * 把同一 Outbox 事件扇出给多个幂等投影器（通用投影 + 血缘投影）。
 *
 * - 任一投影返回 gap/quarantined：整体阻断 ack，交由 Job retry/backoff；
 * - 任一返回 projected：整体 projected；
 * - 全部 duplicate：整体 duplicate。
 *
 * 每个投影器各自维护 consumer checkpoint / 幂等台账，因此某个投影器已经成功、
 * 另一个因 gap 重试时，前者只会看到 duplicate，不会重复写入。
 */
export class CompositeDataProjector implements DataEventProjector {
  private readonly projectors: readonly DataEventProjector[];

  constructor(projectors: readonly DataEventProjector[]) {
    if (!projectors.length) throw new Error('At least one data projector is required');
    this.projectors = [...projectors];
  }

  async deliver(event: TenantDataEvent): Promise<{
    status: 'projected' | 'duplicate' | 'gap' | 'quarantined';
    reason?: string;
  }> {
    let projected = false;
    for (const projector of this.projectors) {
      const result = await projector.deliver(event);
      if (result.status === 'gap' || result.status === 'quarantined') return result;
      if (result.status === 'projected') projected = true;
    }
    return projected ? { status: 'projected' } : { status: 'duplicate' };
  }
}
