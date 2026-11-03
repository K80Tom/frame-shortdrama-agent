import { randomBytes } from 'node:crypto';
import {
  DATA_EVENT_SCHEMA_VERSION,
  dataEventDigest,
  dataEventIdempotencyKey,
  parseDataEventV1,
  type DataAggregateType,
  type DataEventPayload,
  type DataEventV1,
} from '@lyra/shared';

export class DataEventError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Array<{ path: string; code: string; message: string }> = [],
  ) {
    super(message);
    this.name = 'DataEventError';
  }
}

export function newDataEventId(): string {
  return `evt_${randomBytes(16).toString('hex')}`;
}

export interface CreateDataEventInput {
  eventId?: string;
  eventType: string;
  aggregateType: DataAggregateType;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
  recordedAt?: string;
  correlationId: string;
  causationId?: string | null;
  idempotencyKey?: string;
  authoritativeRef: {
    kind: string;
    id: string;
    revisionId?: string | null;
    digest: string;
  };
  payload: DataEventPayload;
}

/**
 * 业务层统一的事件构造器。eventId 与推荐的幂等键只在这里生成，
 * 仓储层只负责把已校验的事件放进同一个业务事务。
 */
export function createDataEvent(input: CreateDataEventInput): DataEventV1 {
  const event: DataEventV1 = parseDataEventV1({
    eventId: input.eventId ?? newDataEventId(),
    eventType: input.eventType,
    schemaVersion: DATA_EVENT_SCHEMA_VERSION,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    occurredAt: input.occurredAt,
    recordedAt: input.recordedAt ?? input.occurredAt,
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    idempotencyKey: input.idempotencyKey ?? dataEventIdempotencyKey(
      input.aggregateType, input.aggregateId, input.aggregateVersion, input.eventType,
    ),
    authoritativeRef: {
      kind: input.authoritativeRef.kind,
      id: input.authoritativeRef.id,
      revisionId: input.authoritativeRef.revisionId ?? null,
      digest: input.authoritativeRef.digest,
    },
    payload: input.payload,
  });
  // 摘要必须可复算；构造时就暴露错误，而不是到投递时才发现。
  dataEventDigest(event);
  return event;
}

export function assertSameEvent(left: DataEventV1, right: DataEventV1): void {
  if (dataEventDigest(left) !== dataEventDigest(right)) {
    throw new DataEventError(409, 'DATA_OUTBOX_DUPLICATE_EVENT', '同一 eventId 对应了不同事件内容。');
  }
}
