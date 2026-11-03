import { createHash } from 'node:crypto';
import { DataEventContractError, canonicalDigest, type DataEventPayload, type DataEventV1 } from '@lyra/shared';
import type { QueryResultRow } from 'pg';
import type { PostgresDatabase } from '../db/client';
import { createDataEvent } from './event';
import { DataOutbox } from './outbox';

interface LegacyProductionOutboxRow extends QueryResultRow {
  id: string;
  run_id: string;
  sequence: number;
  event_type: string;
  payload_json: Record<string, unknown>;
  created_at: Date | string;
  delivered_at: Date | string | null;
}

export interface LegacyMigrationResult {
  before: number;
  migrated: number;
  skipped: number;
  after: number;
}

const LEGACY_SOURCE = 'production_outbox_events';

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function safeLegacyPayload(eventType: string, payload: Record<string, unknown>,
  sequence: number): DataEventPayload {
  const result: Record<string, string | number | boolean | null | Array<string | number | boolean | null>> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!/^[a-z][a-zA-Z0-9]{0,63}$/u.test(key)) continue;
    if (value === null || typeof value === 'boolean') {
      result[key] = value;
      continue;
    }
    if (typeof value === 'string' && value.length <= 512) {
      result[key] = value;
      continue;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      result[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.length <= 16
      && value.every(item => item === null || typeof item === 'boolean'
        || (typeof item === 'string' && item.length <= 512)
        || (typeof item === 'number' && Number.isSafeInteger(item)))) {
      result[key] = value as Array<string | number | boolean | null>;
    }
  }
  if (Object.keys(result).length === 0 || eventType === 'production.run.operations_reconciled') {
    result.legacySequence = sequence;
  }
  return result;
}

/**
 * 旧 production_outbox_events 只做映射，不修改原表。eventId 由旧主键确定性派生，
 * 重复执行迁移不会生成第二个 eventId；delivered_at 只转换为已投递状态。
 */
export function legacyProductionEvent(row: LegacyProductionOutboxRow): DataEventV1 {
  const sourceDigest = canonicalDigest({
    id: row.id, runId: row.run_id, sequence: row.sequence, eventType: row.event_type,
    payload: row.payload_json, createdAt: iso(row.created_at), deliveredAt: row.delivered_at === null ? null : iso(row.delivered_at),
  });
  const eventId = `evt_${createHash('sha256').update(`${LEGACY_SOURCE}:${row.id}`).digest('hex').slice(0, 32)}`;
  return createDataEvent({
    eventType: row.event_type,
    aggregateType: 'production_run',
    aggregateId: row.run_id,
    aggregateVersion: row.sequence,
    occurredAt: iso(row.created_at),
    recordedAt: iso(row.created_at),
    correlationId: `legacy:${row.run_id}`,
    idempotencyKey: `legacy:${row.run_id}:${row.sequence}`,
    authoritativeRef: {
      kind: 'production_outbox_event', id: row.id, revisionId: null, digest: sourceDigest,
    },
    payload: safeLegacyPayload(row.event_type, row.payload_json, row.sequence),
  });
}

export async function migrateLegacyProductionOutbox(database: PostgresDatabase): Promise<LegacyMigrationResult> {
  const beforeResult = await database.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM production_outbox_events',
  );
  const before = beforeResult.rows[0]?.count ?? 0;
  let migrated = 0;
  let skipped = 0;
  const outbox = new DataOutbox(database);
  await outbox.transaction(async tx => {
    const rows = await tx.client.query<LegacyProductionOutboxRow>(`
      SELECT id, run_id, sequence, event_type, payload_json, created_at, delivered_at
      FROM production_outbox_events ORDER BY created_at, id
    `);
    for (const row of rows.rows) {
      const existing = await tx.client.query<{ event_digest: string }>(`
        SELECT event_digest FROM data_outbox_events
        WHERE legacy_source = $1 AND legacy_event_id = $2
      `, [LEGACY_SOURCE, row.id]);
      if (existing.rows[0]) {
        skipped += 1;
        continue;
      }
      const event = legacyProductionEvent(row);
      await tx.append(event, {
        legacySource: LEGACY_SOURCE,
        legacyEventId: row.id,
        status: row.delivered_at === null ? 'pending' : 'published',
        publishedAt: row.delivered_at === null ? null : iso(row.delivered_at),
        availableAt: iso(row.created_at),
      });
      migrated += 1;
    }
  });
  // 只核对“当前旧表行”的映射数量。旧行已随业务清理删除时，历史遗留的
  // legacy_source 行不应让再次执行迁移误报数量不一致。
  const afterResult = await database.query<{ count: number }>(`
    SELECT COUNT(*)::int AS count FROM data_outbox_events e
    WHERE e.legacy_source = $1
      AND e.legacy_event_id IN (SELECT id FROM production_outbox_events)
  `, [LEGACY_SOURCE]);
  const after = afterResult.rows[0]?.count ?? 0;
  if (after !== before) {
    throw new DataEventContractError(409, 'DATA_OUTBOX_LEGACY_COUNT_MISMATCH',
      `旧 Outbox 迁移数量不一致：before=${before}, after=${after}。`);
  }
  return { before, migrated, skipped, after };
}
