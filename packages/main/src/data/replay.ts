import type { DataAggregateType } from '@lyra/shared';
import type { StoredDataEvent } from './outbox';
import type { ProjectionStore } from './checkpoint';
import { DataProjector } from './projector';

export interface ReplayFilter {
  from?: string;
  to?: string;
  aggregateType?: DataAggregateType;
  aggregateId?: string;
  eventTypes?: readonly string[];
}

export interface ReplayEventSource {
  list(filter: ReplayFilter): Promise<StoredDataEvent[]>;
}

export interface ReplayRequest {
  replayId: string;
  consumerName: string;
  filter: ReplayFilter;
  dryRun?: boolean;
}

export interface ReplayEventSummary {
  eventId: string;
  eventType: string;
  aggregateType: DataAggregateType;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
}

export interface ReplayResult {
  replayId: string;
  namespace: string;
  dryRun: boolean;
  scanned: number;
  matched: number;
  projected: number;
  duplicates: number;
  gaps: number;
  quarantined: number;
  events: ReplayEventSummary[];
}

const REPLAY_ID = /^[a-z0-9][a-z0-9:-]{7,63}$/u;
const CONSUMER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,63}$/u;

function summary(event: StoredDataEvent): ReplayEventSummary {
  return {
    eventId: event.event.eventId,
    eventType: event.event.eventType,
    aggregateType: event.event.aggregateType,
    aggregateId: event.event.aggregateId,
    aggregateVersion: event.event.aggregateVersion,
    occurredAt: event.event.occurredAt,
  };
}

function inFilter(event: StoredDataEvent, filter: ReplayFilter): boolean {
  const value = event.event;
  if (filter.from && value.occurredAt < filter.from) return false;
  if (filter.to && value.occurredAt > filter.to) return false;
  if (filter.aggregateType && value.aggregateType !== filter.aggregateType) return false;
  if (filter.aggregateId && value.aggregateId !== filter.aggregateId) return false;
  if (filter.eventTypes && !filter.eventTypes.includes(value.eventType)) return false;
  return true;
}

/**
 * 范围重放：独立 replayId 命名空间 + 独立 ProjectionStore，不推进线上 checkpoint。
 * dry-run 只读 source 与过滤条件，不写投影、checkpoint 或 Outbox。
 */
export class DataReplayService {
  constructor(
    private readonly source: ReplayEventSource,
    private readonly store: ProjectionStore,
    private readonly options: { now?: () => Date } = {},
  ) {}

  async replay(request: ReplayRequest): Promise<ReplayResult> {
    if (!REPLAY_ID.test(request.replayId)) throw new Error('replayId 格式不合法。');
    if (!CONSUMER.test(request.consumerName)) throw new Error('consumerName 格式不合法。');
    const namespace = `${request.consumerName}:replay:${request.replayId}`;
    if (namespace.length > 128) throw new Error('replay 命名空间过长。');
    const all = await this.source.list(request.filter);
    const matched = all.filter(item => inFilter(item, request.filter));
    const result: ReplayResult = {
      replayId: request.replayId, namespace, dryRun: request.dryRun === true,
      scanned: all.length, matched: matched.length, projected: 0, duplicates: 0, gaps: 0, quarantined: 0,
      events: matched.map(summary),
    };
    if (request.dryRun) return result;

    const projector = new DataProjector(namespace, this.store, {
      allowInitialVersion: true,
      now: this.options.now,
    });
    for (const item of matched) {
      const projected = await projector.deliver(item.event);
      if (projected.status === 'projected') result.projected += 1;
      else if (projected.status === 'duplicate') result.duplicates += 1;
      else if (projected.status === 'gap') result.gaps += 1;
      else result.quarantined += 1;
    }
    return result;
  }
}
