import type { QueryResultRow } from 'pg';
import type { DataAggregateType } from '@lyra/shared';
import type { PostgresDatabase } from '../db/client';
import type { TenantDataEvent } from './tenant-event';

export interface ConsumerCheckpoint {
  consumerName: string;
  workspaceId: string;
  eventId: string;
  aggregateType: DataAggregateType;
  aggregateId: string;
  aggregateVersion: number;
  updatedAt: string;
}

export interface ProjectionRecord {
  projectionId: string;
  consumerName: string;
  workspaceId: string;
  eventId: string;
  aggregateType: DataAggregateType;
  aggregateId: string;
  aggregateVersion: number;
  output: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface DeadLetterRecord {
  consumerName: string;
  workspaceId: string;
  eventId: string;
  reason: string;
  attempts: number;
  createdAt: string;
}

export interface QuarantineRecord {
  consumerName: string;
  workspaceId: string;
  eventId: string;
  reason: string;
  schemaVersion: string;
  createdAt: string;
}

export interface ProjectionCommitInput {
  consumerName: string;
  event: TenantDataEvent;
  projection: ProjectionRecord;
  checkpoint: ConsumerCheckpoint;
}

export interface ProjectionCommitResult {
  applied: boolean;
  duplicate: boolean;
}

/**
 * Projector 唯一可见的写入口。实现必须把投影、处理记录和 checkpoint
 * 放在一个原子提交里；不允许先写投影、后推进 checkpoint。
 */
export interface ProjectionStore {
  getCheckpoint(consumerName: string, workspaceId?: string): Promise<ConsumerCheckpoint | null>;
  getAggregateVersion(consumerName: string, workspaceId: string, aggregateType: DataAggregateType,
    aggregateId: string): Promise<number | null>;
  hasProcessed(consumerName: string, eventId: string): Promise<boolean>;
  commit(input: ProjectionCommitInput): Promise<ProjectionCommitResult>;
  listProjections(consumerName: string): Promise<ProjectionRecord[]>;
  recordDeadLetter(input: DeadLetterRecord): Promise<void>;
  listDeadLetters(consumerName: string): Promise<DeadLetterRecord[]>;
  recordQuarantine(input: QuarantineRecord): Promise<void>;
  listQuarantine(consumerName: string): Promise<QuarantineRecord[]>;
}

interface ConsumerState {
  processed: Set<string>;
  projections: ProjectionRecord[];
  checkpoint: ConsumerCheckpoint | null;
  checkpoints: Map<string, ConsumerCheckpoint>;
  aggregateVersions: Map<string, number>;
  deadLetters: DeadLetterRecord[];
  quarantine: QuarantineRecord[];
}

const keyOf = (workspaceId: string, type: string, id: string): string => `${workspaceId}\u0000${type}\u0000${id}`;
const clone = <T>(value: T): T => structuredClone(value);

/** 离线测试与本地开发用；生产实现必须保持同样的原子提交语义。 */
export class InMemoryProjectionStore implements ProjectionStore {
  private readonly states = new Map<string, ConsumerState>();

  private state(consumerName: string): ConsumerState {
    let state = this.states.get(consumerName);
    if (!state) {
      state = {
        processed: new Set(), projections: [], checkpoint: null, checkpoints: new Map(),
        aggregateVersions: new Map(), deadLetters: [], quarantine: [],
      };
      this.states.set(consumerName, state);
    }
    return state;
  }

  async getCheckpoint(consumerName: string, workspaceId?: string): Promise<ConsumerCheckpoint | null> {
    const state = this.state(consumerName);
    const checkpoint = workspaceId ? state.checkpoints.get(workspaceId) ?? null : state.checkpoint;
    return checkpoint ? clone(checkpoint) : null;
  }

  async getAggregateVersion(consumerName: string, workspaceId: string, aggregateType: DataAggregateType,
    aggregateId: string): Promise<number | null> {
    return this.state(consumerName).aggregateVersions.get(keyOf(workspaceId, aggregateType, aggregateId)) ?? null;
  }

  async hasProcessed(consumerName: string, eventId: string): Promise<boolean> {
    return this.state(consumerName).processed.has(eventId);
  }

  async commit(input: ProjectionCommitInput): Promise<ProjectionCommitResult> {
    const state = this.state(input.consumerName);
    if (state.processed.has(input.event.eventId)) return { applied: false, duplicate: true };
    // 先构造完整的新状态，再一次性替换，模拟同事务提交。
    const projections = [...state.projections, clone(input.projection)];
    const processed = new Set(state.processed);
    processed.add(input.event.eventId);
    const aggregateVersions = new Map(state.aggregateVersions);
    aggregateVersions.set(keyOf(input.projection.workspaceId,
      input.event.aggregateType, input.event.aggregateId), input.event.aggregateVersion);
    state.projections = projections;
    state.processed = processed;
    state.aggregateVersions = aggregateVersions;
    state.checkpoint = clone(input.checkpoint);
    state.checkpoints.set(input.checkpoint.workspaceId, clone(input.checkpoint));
    return { applied: true, duplicate: false };
  }

  async listProjections(consumerName: string): Promise<ProjectionRecord[]> {
    return this.state(consumerName).projections.map(clone);
  }

  async recordDeadLetter(input: DeadLetterRecord): Promise<void> {
    this.state(input.consumerName).deadLetters.push(clone(input));
  }

  async listDeadLetters(consumerName: string): Promise<DeadLetterRecord[]> {
    return this.state(consumerName).deadLetters.map(clone);
  }

  async recordQuarantine(input: QuarantineRecord): Promise<void> {
    this.state(input.consumerName).quarantine.push(clone(input));
  }

  async listQuarantine(consumerName: string): Promise<QuarantineRecord[]> {
    return this.state(consumerName).quarantine.map(clone);
  }
}

interface PgCheckpointRow extends QueryResultRow {
  consumer_name: string; workspace_id: string; event_id: string; aggregate_type: DataAggregateType;
  aggregate_id: string; aggregate_version: number; updated_at: unknown;
}
interface PgProjectionRow extends QueryResultRow {
  projection_id: string; consumer_name: string; workspace_id: string; event_id: string; aggregate_type: DataAggregateType;
  aggregate_id: string; aggregate_version: number; projection_json: Record<string, string | number | boolean | null>;
  created_at: unknown;
}
interface PgDeadLetterRow extends QueryResultRow {
  consumer_name: string; workspace_id: string; event_id: string; reason: string; attempts: number; created_at: unknown;
}
interface PgQuarantineRow extends QueryResultRow {
  consumer_name: string; workspace_id: string; event_id: string; reason: string; schema_version: string; created_at: unknown;
}

const iso = (value: unknown): string => value instanceof Date
  ? value.toISOString() : new Date(String(value)).toISOString();

/** 生产实现：投影、已处理记录、checkpoint 在同一个数据库事务里提交。 */
export class PostgresProjectionStore implements ProjectionStore {
  constructor(private readonly database: PostgresDatabase) {}

  async getCheckpoint(consumerName: string, workspaceId?: string): Promise<ConsumerCheckpoint | null> {
    const result = await this.database.query<PgCheckpointRow>(`
      SELECT consumer_name, workspace_id, event_id, aggregate_type, aggregate_id, aggregate_version, updated_at
      FROM data_consumer_checkpoints
      WHERE consumer_name = $1 AND ($2::text IS NULL OR workspace_id = $2)
      ORDER BY updated_at DESC, event_id DESC
      LIMIT 1
    `, [consumerName, workspaceId ?? null]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      consumerName: row.consumer_name, workspaceId: row.workspace_id,
      eventId: row.event_id, aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id, aggregateVersion: row.aggregate_version, updatedAt: iso(row.updated_at),
    };
  }

  async getAggregateVersion(consumerName: string, workspaceId: string, aggregateType: DataAggregateType,
    aggregateId: string): Promise<number | null> {
    const result = await this.database.query<{ version: number | null }>(`
      SELECT MAX(aggregate_version)::int AS version FROM data_projection_records
      WHERE consumer_name = $1 AND workspace_id = $2 AND aggregate_type = $3 AND aggregate_id = $4
    `, [consumerName, workspaceId, aggregateType, aggregateId]);
    return result.rows[0]?.version ?? null;
  }

  async hasProcessed(consumerName: string, eventId: string): Promise<boolean> {
    const result = await this.database.query<{ found: number }>(`
      SELECT 1 AS found FROM data_consumer_records
      WHERE consumer_name = $1 AND event_id = $2
    `, [consumerName, eventId]);
    return result.rows.length > 0;
  }

  async commit(input: ProjectionCommitInput): Promise<ProjectionCommitResult> {
    return this.database.transaction(async client => {
      const inserted = await client.query<{ event_id: string }>(`
        INSERT INTO data_consumer_records (consumer_name, workspace_id, event_id, processed_at)
        VALUES ($1, $2, $3, $4::timestamptz)
        ON CONFLICT (consumer_name, event_id) DO NOTHING
        RETURNING event_id
      `, [input.consumerName, input.projection.workspaceId,
        input.event.eventId, input.checkpoint.updatedAt]);
      if (!inserted.rows[0]) return { applied: false, duplicate: true };
      await client.query(`
        INSERT INTO data_projection_records
          (projection_id, consumer_name, workspace_id, event_id, aggregate_type, aggregate_id,
           aggregate_version, projection_json, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)
      `, [input.projection.projectionId, input.consumerName, input.projection.workspaceId,
        input.event.eventId,
        input.event.aggregateType, input.event.aggregateId, input.event.aggregateVersion,
        JSON.stringify(input.projection.output), input.projection.createdAt]);
      await client.query(`
        INSERT INTO data_consumer_checkpoints
          (consumer_name, workspace_id, event_id, aggregate_type, aggregate_id, aggregate_version, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
        ON CONFLICT (consumer_name, workspace_id) DO UPDATE SET
          event_id = EXCLUDED.event_id,
          aggregate_type = EXCLUDED.aggregate_type,
          aggregate_id = EXCLUDED.aggregate_id,
          aggregate_version = EXCLUDED.aggregate_version,
          updated_at = EXCLUDED.updated_at
      `, [input.consumerName, input.projection.workspaceId, input.event.eventId,
        input.event.aggregateType, input.event.aggregateId,
        input.event.aggregateVersion, input.checkpoint.updatedAt]);
      return { applied: true, duplicate: false };
    });
  }

  async listProjections(consumerName: string): Promise<ProjectionRecord[]> {
    const result = await this.database.query<PgProjectionRow>(`
      SELECT projection_id, consumer_name, workspace_id, event_id, aggregate_type, aggregate_id,
             aggregate_version, projection_json, created_at
      FROM data_projection_records WHERE consumer_name = $1
      ORDER BY created_at, projection_id
    `, [consumerName]);
    return result.rows.map(row => ({
      projectionId: row.projection_id, consumerName: row.consumer_name,
      workspaceId: row.workspace_id, eventId: row.event_id,
      aggregateType: row.aggregate_type, aggregateId: row.aggregate_id,
      aggregateVersion: row.aggregate_version, output: row.projection_json, createdAt: iso(row.created_at),
    }));
  }

  async recordDeadLetter(input: DeadLetterRecord): Promise<void> {
    await this.database.query(`
      INSERT INTO data_dead_letters (consumer_name, workspace_id, event_id, reason, attempts, created_at)
      VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
      ON CONFLICT (consumer_name, event_id) DO UPDATE SET
        reason = EXCLUDED.reason,
        attempts = GREATEST(data_dead_letters.attempts, EXCLUDED.attempts)
    `, [input.consumerName, input.workspaceId, input.eventId,
      input.reason.slice(0, 1000), input.attempts, input.createdAt]);
  }

  async listDeadLetters(consumerName: string): Promise<DeadLetterRecord[]> {
    const result = await this.database.query<PgDeadLetterRow>(`
      SELECT consumer_name, workspace_id, event_id, reason, attempts, created_at
      FROM data_dead_letters WHERE consumer_name = $1 ORDER BY created_at, event_id
    `, [consumerName]);
    return result.rows.map(row => ({
      consumerName: row.consumer_name, workspaceId: row.workspace_id,
      eventId: row.event_id, reason: row.reason,
      attempts: row.attempts, createdAt: iso(row.created_at),
    }));
  }

  async recordQuarantine(input: QuarantineRecord): Promise<void> {
    await this.database.query(`
      INSERT INTO data_quarantine_records (consumer_name, workspace_id, event_id, reason, schema_version, created_at)
      VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
      ON CONFLICT (consumer_name, event_id) DO UPDATE SET
        reason = EXCLUDED.reason,
        schema_version = EXCLUDED.schema_version
    `, [input.consumerName, input.workspaceId, input.eventId,
      input.reason.slice(0, 1000), input.schemaVersion, input.createdAt]);
  }

  async listQuarantine(consumerName: string): Promise<QuarantineRecord[]> {
    const result = await this.database.query<PgQuarantineRow>(`
      SELECT consumer_name, workspace_id, event_id, reason, schema_version, created_at
      FROM data_quarantine_records WHERE consumer_name = $1 ORDER BY created_at, event_id
    `, [consumerName]);
    return result.rows.map(row => ({
      consumerName: row.consumer_name, workspaceId: row.workspace_id,
      eventId: row.event_id, reason: row.reason,
      schemaVersion: row.schema_version, createdAt: iso(row.created_at),
    }));
  }
}
