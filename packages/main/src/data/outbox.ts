import { randomBytes } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  DataEventContractError,
  dataEventDigest,
  parseDataEventV1,
  type DataEventV1,
} from '@lyra/shared';
import type { PostgresDatabase } from '../db/client';
import { DataEventError, assertSameEvent } from './event';

export type DataOutboxStatus = 'pending' | 'published' | 'failed' | 'dead_letter';

export interface OutboxAppendOptions {
  legacySource?: string | null;
  legacyEventId?: string | null;
  status?: DataOutboxStatus;
  publishedAt?: string | null;
  availableAt?: string | null;
  lastError?: string | null;
}

export interface StoredDataEvent {
  outboxId: string;
  event: DataEventV1;
  eventDigest: string;
  status: DataOutboxStatus;
  attempts: number;
  availableAt: string;
  publishedAt: string | null;
  lastError: string | null;
  legacySource: string | null;
  legacyEventId: string | null;
  createdAt: string;
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

const OUTBOX_COLUMNS = `outbox_id, event_id, event_type, schema_version, aggregate_type, aggregate_id,
  aggregate_version, occurred_at, recorded_at, correlation_id, causation_id, idempotency_key,
  authoritative_ref_json, payload_json, event_digest, status, attempts, available_at,
  published_at, last_error, legacy_source, legacy_event_id, created_at`;

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  return new Date(String(value)).toISOString();
}
function nullIso(value: unknown): string | null { return value === null ? null : iso(value); }
const json = (value: unknown): string => JSON.stringify(value);

function contractFailure(error: unknown): never {
  if (error instanceof DataEventError) throw error;
  if (error instanceof DataEventContractError) {
    throw new DataEventError(error.status, error.code, error.message, error.details);
  }
  const record = error && typeof error === 'object'
    ? error as { code?: string; constraint?: string; message?: string } : {};
  if (record.code === '23505') {
    if (record.constraint === 'data_outbox_event_id_unique') {
      throw new DataEventError(409, 'DATA_OUTBOX_DUPLICATE_EVENT', '事件 ID 已存在但内容不一致。');
    }
    if (record.constraint === 'data_outbox_aggregate_version_unique') {
      throw new DataEventError(409, 'DATA_OUTBOX_AGGREGATE_VERSION_CONFLICT', '同一聚合版本已有其他事件。');
    }
    if (record.constraint === 'data_outbox_legacy_identity') {
      throw new DataEventError(409, 'DATA_OUTBOX_LEGACY_DUPLICATE', '旧 Outbox 事件已迁移。');
    }
    throw new DataEventError(409, 'DATA_OUTBOX_DUPLICATE_EVENT', '唯一约束拒绝了重复事件。');
  }
  throw error;
}

function eventOf(row: OutboxRow): StoredDataEvent {
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
}

/**
 * 只能通过 DataOutbox.transaction 拿到的追加器。业务写入与事件 INSERT
 * 共用同一个 PoolClient；回调抛错时外层事务整体回滚。
 */
export class OutboxTransaction {
  constructor(readonly client: PoolClient) {}

  async append(event: DataEventV1, options: OutboxAppendOptions = {}): Promise<StoredDataEvent> {
    return appendDataEvent(this.client, event, options);
  }
}

export class DataOutbox {
  constructor(private readonly database: PostgresDatabase) {}

  async transaction<T>(work: (tx: OutboxTransaction) => Promise<T>): Promise<T> {
    return this.database.transaction(async client => work(new OutboxTransaction(client)));
  }
}

/** 由业务 Repository 在已有事务内调用。 */
export async function appendDataEvent(client: PoolClient, event: DataEventV1,
  options: OutboxAppendOptions = {}): Promise<StoredDataEvent> {
  try {
    const parsed = parseDataEventV1(event);
    const digest = dataEventDigest(parsed);
    const status = options.status ?? (options.publishedAt ? 'published' : 'pending');
    const outboxId = `obox_${randomBytes(16).toString('hex')}`;
    const availableAt = options.availableAt ?? parsed.recordedAt;
    const createdAt = parsed.recordedAt;
    const result = await client.query<OutboxRow>(`
      INSERT INTO data_outbox_events (${OUTBOX_COLUMNS})
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb,
              $15, $16, 0, $17, $18, $19, $20, $21, $22)
      ON CONFLICT (event_id) DO NOTHING
      RETURNING ${OUTBOX_COLUMNS}
    `, [outboxId, parsed.eventId, parsed.eventType, parsed.schemaVersion, parsed.aggregateType,
      parsed.aggregateId, parsed.aggregateVersion, parsed.occurredAt, parsed.recordedAt,
      parsed.correlationId, parsed.causationId, parsed.idempotencyKey, json(parsed.authoritativeRef),
      json(parsed.payload), digest, status, availableAt, options.publishedAt ?? null,
      options.lastError ?? null, options.legacySource ?? null, options.legacyEventId ?? null, createdAt]);
    if (result.rows[0]) return eventOf(result.rows[0]);

    const existing = await client.query<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM data_outbox_events WHERE event_id = $1`, [parsed.eventId],
    );
    if (!existing.rows[0]) throw new DataEventError(409, 'DATA_OUTBOX_DUPLICATE_EVENT', '事件写入未返回结果。');
    const stored = eventOf(existing.rows[0]);
    if (stored.eventDigest !== digest) {
      assertSameEvent(stored.event, parsed);
    }
    return stored;
  } catch (error) {
    return contractFailure(error);
  }
}
