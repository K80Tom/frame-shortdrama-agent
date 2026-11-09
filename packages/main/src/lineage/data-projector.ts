import type { DataEventProjector } from '../data/job-dispatcher';
import type { TenantDataEvent } from '../data/tenant-event';
import type { LineageProjector } from './projector';

/**
 * 把血缘 projector 适配成 Outbox 投影链中的一员。
 *
 * `unknown` 是“已提交 unknown 根节点”的成功结果，对 Outbox 来说同样是 projected；
 * 只有未提交（duplicate）才不推进 consumer checkpoint。
 */
export class LineageDataProjector implements DataEventProjector {
  constructor(private readonly projector: LineageProjector) {}

  async deliver(event: TenantDataEvent): Promise<{
    status: 'projected' | 'duplicate' | 'gap' | 'quarantined';
    reason?: string;
  }> {
    const result = await this.projector.deliver(event);
    return { status: result.status === 'duplicate' ? 'duplicate' : 'projected' };
  }
}
