import type { QueryResultRow } from 'pg';
import {
  DataEventContractError,
  parseDataEventV1,
  type DataEventV1,
} from '@lyra/shared';
import type { PostgresDatabase } from '../db/client';
import { DataEventError } from './event';
import type { DataOutboxStatus, StoredDataEvent } from './outbox';

export interface DataOutboxRepository {
  listPending(limit: number, now: string): Promise<StoredDataEvent[]>;
  getByEventId(eventId: string): Promise<StoredDataEvent | null>;
  markPublished(outboxId: string, at: string): Promise<StoredDataEvent>;
  markFailure(outboxId: string, error: string, availableAt: string, maxAttempts: number): Promise<StoredDataEvent>;
}

interface OutboxRow extends QueryResultRow {
  outbox_id: string; event_id: string; event_type: string; schema_version: string;
  aggregate_type: DataEventV1['aggregateType']; aggregate_id: string; aggregate_version: number;
  occurred_at: unknown; recorded_at: unknown; correlation_id: string; causation_id: string | null;
  idempotency_key: string; authoritative_ref_json: DataEventV1['authoritativeRef'];
  payload_json: DataEventV1['payload']; event_digest: string; status: DataOutboxStatus;
  attempts: number; available_at: unknown; published_at: unknown; last_error: string | null;
  legacy_source: string | null; legacy_event_id: string | null; created_at: unknown;
}

const COLUMNS = `outbox_id, event_id, event_type, schema_version, aggregate_type, aggregate_id,
  aggregate_version, occurred_at, recorded_at, correlation_id, causation_id, idempotency_key,
  authoritative_ref_json, payload_json, event_digest, status, attempts, available_at,
  published_at, last_error, legacy_source, legacy_event_id, created_at`;

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  return new Date(String(value)).toISOString();
}
function nullIso(value: unknown): string | null { return value === null ? null : iso(value); }

function storedOf(row: OutboxRow): StoredDataEvent {
  try {
    return {
      outboxId: row.outbox_id,
      event: parseDataEventV1({
        eventId: row.event_id,
        eventType: row.event_type,
        schemaVersion: row.schema_version,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        aggregateVersion: row.aggregate_version,
        occurredAt: iso(row.occurred_at),
        recordedAt: iso(row.recorded_at),
        correlationId: row.correlation_id,
        causationId: row.causation_id,
        idempotencyKey: row.idempotency_key,
        authoritativeRef: row.authoritative_ref_json,
        payload: row.payload_json,
      }),
      eventDigest: row.event_digest,
      status: row.status,
      attempts: row.attempts,
      availableAt: iso(row.available_at),
      publishedAt: nullIso(row.published_at),
      lastError: row.last_error,
      legacySource: row.legacy_source,
      legacyEventId: row.legacy_event_id,
      createdAt: iso(row.created_at),
    };
  } catch (error) {
    if (error instanceof DataEventContractError) {
      throw new DataEventError(error.status, error.code, error.message, error.details);
    }
    throw error;
  }
}

export class PostgresDataOutboxRepository implements DataOutboxRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async listPending(limit: number, now: string): Promise<StoredDataEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new DataEventError(400, 'DATA_EVENT_INPUT_INVALID', 'limit 必须是 1..500 的整数。');
    }
    const result = await this.database.query<OutboxRow>(`
      SELECT ${COLUMNS} FROM data_outbox_events
      WHERE status IN ('pending', 'failed') AND available_at <= $1::timestamptz
      ORDER BY occurred_at, outbox_id
      LIMIT $2
    `, [now, limit]);
    return result.rows.map(storedOf);
  }

  async getByEventId(eventId: string): Promise<StoredDataEvent | null> {
    const result = await this.database.query<OutboxRow>(
      `SELECT ${COLUMNS} FROM data_outbox_events WHERE event_id = $1`, [eventId],
    );
    return result.rows[0] ? storedOf(result.rows[0]) : null;
  }

  async markPublished(outboxId: string, at: string): Promise<StoredDataEvent> {
    const result = await this.database.query<OutboxRow>(`
      UPDATE data_outbox_events
         SET status = 'published', published_at = $2, last_error = NULL
       WHERE outbox_id = $1
       RETURNING ${COLUMNS}
    `, [outboxId, at]);
    if (!result.rows[0]) throw new DataEventError(404, 'DATA_OUTBOX_NOT_FOUND', 'Outbox 事件不存在。');
    return storedOf(result.rows[0]);
  }

  async markFailure(outboxId: string, error: string, availableAt: string, maxAttempts: number): Promise<StoredDataEvent> {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new DataEventError(400, 'DATA_EVENT_INPUT_INVALID', 'maxAttempts 必须是 1..100 的整数。');
    }
    const result = await this.database.query<OutboxRow>(`
      UPDATE data_outbox_events
         SET attempts = attempts + 1,
             last_error = $2,
             status = CASE WHEN attempts + 1 >= $4 THEN 'dead_letter' ELSE 'failed' END,
             available_at = $3
       WHERE outbox_id = $1 AND status <> 'published'
       RETURNING ${COLUMNS}
    `, [outboxId, error.slice(0, 1000), availableAt, maxAttempts]);
    if (!result.rows[0]) throw new DataEventError(404, 'DATA_OUTBOX_NOT_FOUND', 'Outbox 事件不存在或已投递。');
    return storedOf(result.rows[0]);
  }
}
