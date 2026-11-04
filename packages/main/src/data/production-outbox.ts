import { createHash } from 'node:crypto';
import { canonicalDigest, type DataEventPayload, type DataEventV1, type OutboxEvent, type StoredProductionRun } from '@lyra/shared';
import { createDataEvent } from './event';

function projectPayload(payload: Record<string, unknown>, sequence: number): DataEventPayload {
  const result: Record<string, string | number | boolean | null | Array<string | number | boolean | null>> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!/^[a-z][a-zA-Z0-9]{0,63}$/u.test(key)) continue;
    if (value === null || typeof value === 'boolean') {
      result[key] = value;
    } else if (typeof value === 'string' && value.length <= 512) {
      result[key] = value;
    } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
      result[key] = value;
    } else if (Array.isArray(value) && value.length <= 16
      && value.every(item => item === null || typeof item === 'boolean'
        || (typeof item === 'string' && item.length <= 512)
        || (typeof item === 'number' && Number.isSafeInteger(item)))) {
      result[key] = value as Array<string | number | boolean | null>;
    }
  }
  if (Object.keys(result).length === 0) result.sequence = sequence;
  return result;
}

/** 生产状态事实 -> DataEventV1；eventId 由旧 outbox 主键确定性派生。 */
export function productionOutboxDataEvent(run: StoredProductionRun, event: OutboxEvent): DataEventV1 {
  return createDataEvent({
    eventId: productionOutboxEventId(event.id),
    eventType: event.type,
    aggregateType: 'production_run',
    aggregateId: run.id,
    aggregateVersion: event.sequence,
    occurredAt: event.createdAt,
    recordedAt: event.createdAt,
    correlationId: `production:${run.id}`,
    idempotencyKey: `production:${run.id}:${event.sequence}`,
    authoritativeRef: {
      kind: 'production_outbox_event',
      id: event.id,
      revisionId: null,
      digest: canonicalDigest(event),
    },
    payload: projectPayload(event.payload, event.sequence),
  });
}

export function productionOutboxEventId(eventId: string): string {
  return `evt_${createHash('sha256').update(`production-outbox:${eventId}`).digest('hex').slice(0, 32)}`;
}
