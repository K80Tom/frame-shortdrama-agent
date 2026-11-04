import type { QueryResultRow } from 'pg';
import {
  EvaluationError,
  EvaluationRunContractError,
  evaluationRunEventDigest,
  isEvaluationRunTerminal,
  parseEvaluationCaseAttempt,
  parseEvaluationRun,
  parseEvaluationRunEvent,
  parseEvaluationSampleAttempt,
  type EvaluationCaseAttempt,
  type EvaluationRun,
  type EvaluationRunEvent,
  type EvaluationSampleAttempt,
} from '@lyra/shared';
import type { PostgresDatabase } from '../db/client';
import {
  assertCreateRecordDigest,
  evaluationRunId,
  type CaseAttemptUpdate,
  type EvaluationRunCreateRecord,
  type EvaluationRunRepository,
  type EvaluationRunStatusUpdate,
} from './repository';

const json = (value: unknown): string => JSON.stringify(value);
const nullIso = (value: unknown): string | null => value === null ? null : iso(value);

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  return new Date(String(value)).toISOString();
}

function conflict(code: string, message: string): never {
  throw new EvaluationError(409, code, message);
}
function notFound(code: string, message: string): never {
  throw new EvaluationError(404, code, message);
}

function failure(error: unknown): never {
  if (error instanceof EvaluationError) throw error;
  if (error instanceof EvaluationRunContractError) {
    throw new EvaluationError(error.status, error.code, error.message, error.details);
  }
  const record = error && typeof error === 'object' ? error as { code?: string; message?: string; constraint?: string } : {};
  const message = record.message ?? '';
  for (const code of [
    'EVALUATION_RUN_TERMINAL_IMMUTABLE', 'EVALUATION_RUN_TRANSITION_INVALID',
    'EVALUATION_RUN_CASE_ATTEMPT_IMMUTABLE', 'EVALUATION_RUN_SAMPLE_ATTEMPT_IMMUTABLE',
    'EVALUATION_HISTORY_APPEND_ONLY', 'EVALUATION_RUN_CASE_ATTEMPT_CONFLICT',
  ]) {
    if (message.includes(code)) {
      conflict(code, code === 'EVALUATION_HISTORY_APPEND_ONLY'
        ? '运行事件与 attempt 历史只允许追加。'
        : '数据库约束拒绝了该运行状态写入。');
    }
  }
  if (record.code === '23505') {
    switch (record.constraint) {
      case 'evaluation_run_idempotency':
        return conflict('EVALUATION_RUN_IDEMPOTENCY_CONFLICT', '同一幂等键对应了不同请求。');
      case 'evaluation_case_attempt_identity':
        return conflict('EVALUATION_RUN_CASE_ATTEMPT_CONFLICT', 'case attempt 序号已存在。');
      case 'evaluation_sample_attempt_identity':
        return conflict('EVALUATION_RUN_SAMPLE_ATTEMPT_CONFLICT', 'sample 序号已存在。');
      case 'evaluation_run_event_identity':
        return conflict('EVALUATION_HISTORY_APPEND_ONLY', '运行事件序号已存在。');
      default:
        return conflict('EVALUATION_RUN_IDEMPOTENCY_CONFLICT', '唯一约束冲突。');
    }
  }
  if (record.code === '23503') return notFound('EVALUATION_RUN_NOT_FOUND', '关联的评测运行或 attempt 不存在。');
  if (record.code === '23514') return conflict('EVALUATION_RUN_TRANSITION_INVALID', '数据库约束拒绝了该运行状态写入。');
  throw new EvaluationError(503, 'EVALUATION_PERSISTENCE_UNAVAILABLE', '评测运行暂时不可用，请稍后重试。');
}

interface RunRow extends QueryResultRow {
  run_id: string; idempotency_key: string; request_digest: string; snapshot_digest: string;
  snapshot_json: EvaluationRun['snapshot']; status: EvaluationRun['status']; run_version: number;
  replayed_from_run_id: string | null; created_at: unknown; updated_at: unknown;
  started_at: unknown; ended_at: unknown;
}
interface CaseAttemptRow extends QueryResultRow {
  case_attempt_id: string; run_id: string; case_id: string; shard_index: number; attempt_number: number;
  status: EvaluationCaseAttempt['status']; started_at: unknown; ended_at: unknown;
  error_json: EvaluationCaseAttempt['error'];
}
interface SampleAttemptRow extends QueryResultRow {
  sample_attempt_id: string; case_attempt_id: string; sample_index: number;
  status: EvaluationSampleAttempt['status']; output_digest: string | null; duration_ms: number;
  cost_micros: string | number; currency: string; error_json: EvaluationSampleAttempt['error'];
}
interface EventRow extends QueryResultRow {
  event_id: string; run_id: string; sequence: number; event_type: EvaluationRunEvent['eventType'];
  occurred_at: unknown; payload_json: EvaluationRunEvent['payload']; event_digest: string;
}

const RUN_COLUMNS = `run_id, idempotency_key, request_digest, snapshot_digest, snapshot_json, status,
  run_version, replayed_from_run_id, created_at, updated_at, started_at, ended_at`;
const CASE_COLUMNS = `case_attempt_id, run_id, case_id, shard_index, attempt_number, status,
  started_at, ended_at, error_json`;
const SAMPLE_COLUMNS = `sample_attempt_id, case_attempt_id, sample_index, status, output_digest,
  duration_ms, cost_micros, currency, error_json`;
const EVENT_COLUMNS = `event_id, run_id, sequence, event_type, occurred_at, payload_json, event_digest`;

function runOf(row: RunRow): EvaluationRun {
  return parseEvaluationRun({
    runId: row.run_id,
    status: row.status,
    snapshot: row.snapshot_json,
    snapshotDigest: row.snapshot_digest,
    requestDigest: row.request_digest,
    idempotencyKey: row.idempotency_key,
    version: row.run_version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    startedAt: nullIso(row.started_at),
    endedAt: nullIso(row.ended_at),
    replayedFromRunId: row.replayed_from_run_id,
  });
}

function caseAttemptOf(row: CaseAttemptRow): EvaluationCaseAttempt {
  return parseEvaluationCaseAttempt({
    caseAttemptId: row.case_attempt_id,
    runId: row.run_id,
    caseId: row.case_id,
    shardIndex: row.shard_index,
    attemptNumber: row.attempt_number,
    status: row.status,
    startedAt: iso(row.started_at),
    endedAt: nullIso(row.ended_at),
    error: row.error_json,
    samples: [],
  });
}

function sampleOf(row: SampleAttemptRow): EvaluationSampleAttempt {
  return parseEvaluationSampleAttempt({
    sampleAttemptId: row.sample_attempt_id,
    caseAttemptId: row.case_attempt_id,
    sampleIndex: row.sample_index,
    status: row.status,
    outputDigest: row.output_digest,
    durationMs: row.duration_ms,
    costMicros: Number(row.cost_micros),
    currency: row.currency,
    error: row.error_json,
  });
}

function eventOf(row: EventRow): EvaluationRunEvent {
  return parseEvaluationRunEvent({
    eventId: row.event_id,
    runId: row.run_id,
    sequence: row.sequence,
    eventType: row.event_type,
    occurredAt: iso(row.occurred_at),
    payload: row.payload_json,
  });
}

/** PostgreSQL 是主实现；所有状态顺序先在 Service 判断，再由 Trigger 兜底。 */
export class PostgresEvaluationRunRepository implements EvaluationRunRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async createRun(input: EvaluationRunCreateRecord): Promise<{ run: EvaluationRun; created: boolean }> {
    assertCreateRecordDigest(input);
    try {
      return await this.database.transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `lyra:evaluation-run:${input.idempotencyKey}`,
        ]);
        const existing = await client.query<RunRow>(
          `SELECT ${RUN_COLUMNS} FROM evaluation_runs WHERE idempotency_key = $1`, [input.idempotencyKey],
        );
        if (existing.rows[0]) {
          const run = runOf(existing.rows[0]);
          if (run.requestDigest !== input.requestDigest) {
            return conflict('EVALUATION_RUN_IDEMPOTENCY_CONFLICT', '同一幂等键对应了不同请求。');
          }
          return { run, created: false };
        }
        const inserted = await client.query<RunRow>(`
          INSERT INTO evaluation_runs (
            ${RUN_COLUMNS}
          ) VALUES ($1, $2, $3, $4, $5::jsonb, 'prepared', 1, $6, $7, $7, NULL, NULL)
          RETURNING ${RUN_COLUMNS}
        `, [input.runId, input.idempotencyKey, input.requestDigest, input.snapshotDigest,
          json(input.snapshot), input.replayedFromRunId ?? null, input.createdAt]);
        const run = runOf(inserted.rows[0]!);
        const event: EvaluationRunEvent = {
          eventId: evaluationRunId('evalrunevt'), runId: run.runId, sequence: 1,
          eventType: 'prepared', occurredAt: input.createdAt, payload: { status: 'prepared' },
        };
        await client.query(`
          INSERT INTO evaluation_run_events (${EVENT_COLUMNS})
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        `, [event.eventId, event.runId, event.sequence, event.eventType, event.occurredAt,
          json(event.payload), evaluationRunEventDigest(event)]);
        return { run, created: true };
      });
    } catch (error) {
      return failure(error);
    }
  }

  async getRun(runId: string): Promise<EvaluationRun | null> {
    const result = await this.database.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM evaluation_runs WHERE run_id = $1`, [runId],
    );
    return result.rows[0] ? runOf(result.rows[0]) : null;
  }

  async updateRunStatus(input: EvaluationRunStatusUpdate): Promise<EvaluationRun> {
    try {
      const result = await this.database.query<RunRow>(`
        UPDATE evaluation_runs
           SET status = $3, run_version = run_version + 1, updated_at = $4,
               started_at = COALESCE($5, started_at), ended_at = $6
         WHERE run_id = $1 AND run_version = $2
         RETURNING ${RUN_COLUMNS}
      `, [input.runId, input.expectedVersion, input.status, input.at, input.startedAt, input.endedAt]);
      if (result.rows[0]) return runOf(result.rows[0]);
      const current = await this.getRun(input.runId);
      if (!current) return notFound('EVALUATION_RUN_NOT_FOUND', '评测运行不存在。');
      if (isEvaluationRunTerminal(current.status)) {
        return conflict('EVALUATION_RUN_TERMINAL_IMMUTABLE', '终态运行只读。');
      }
      return conflict('EVALUATION_RUN_VERSION_CONFLICT', '运行版本已变化，请刷新后重试。');
    } catch (error) {
      return failure(error);
    }
  }

  async createCaseAttempt(attempt: EvaluationCaseAttempt): Promise<EvaluationCaseAttempt> {
    try {
      const result = await this.database.query<CaseAttemptRow>(`
        INSERT INTO evaluation_case_attempts (${CASE_COLUMNS})
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        RETURNING ${CASE_COLUMNS}
      `, [attempt.caseAttemptId, attempt.runId, attempt.caseId, attempt.shardIndex, attempt.attemptNumber,
        attempt.status, attempt.startedAt, attempt.endedAt, attempt.error === null ? null : json(attempt.error)]);
      return caseAttemptOf(result.rows[0]!);
    } catch (error) {
      return failure(error);
    }
  }

  async updateCaseAttempt(update: CaseAttemptUpdate): Promise<EvaluationCaseAttempt> {
    try {
      const result = await this.database.query<CaseAttemptRow>(`
        UPDATE evaluation_case_attempts
           SET status = $4, ended_at = $5, error_json = $6::jsonb
         WHERE case_attempt_id = $1 AND run_id = $2 AND status = $3
         RETURNING ${CASE_COLUMNS}
      `, [update.caseAttemptId, update.runId, update.expectedStatus, update.status,
        update.endedAt, update.error === null ? null : json(update.error)]);
      if (result.rows[0]) return caseAttemptOf(result.rows[0]);
      const existing = await this.database.query<CaseAttemptRow>(
        `SELECT ${CASE_COLUMNS} FROM evaluation_case_attempts WHERE case_attempt_id = $1`, [update.caseAttemptId],
      );
      if (!existing.rows[0]) return notFound('EVALUATION_RUN_CASE_ATTEMPT_NOT_FOUND', 'case attempt 不存在。');
      return conflict('EVALUATION_RUN_CASE_ATTEMPT_CONFLICT', 'case attempt 状态已变化。');
    } catch (error) {
      return failure(error);
    }
  }

  async createSampleAttempt(sample: EvaluationSampleAttempt): Promise<EvaluationSampleAttempt> {
    try {
      const result = await this.database.query<SampleAttemptRow>(`
        INSERT INTO evaluation_sample_attempts (${SAMPLE_COLUMNS})
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        RETURNING ${SAMPLE_COLUMNS}
      `, [sample.sampleAttemptId, sample.caseAttemptId, sample.sampleIndex, sample.status,
        sample.outputDigest, sample.durationMs, sample.costMicros, sample.currency,
        sample.error === null ? null : json(sample.error)]);
      return sampleOf(result.rows[0]!);
    } catch (error) {
      return failure(error);
    }
  }

  async listCaseAttempts(runId: string): Promise<EvaluationCaseAttempt[]> {
    const result = await this.database.query<CaseAttemptRow>(`
      SELECT ${CASE_COLUMNS} FROM evaluation_case_attempts WHERE run_id = $1
      ORDER BY case_id, attempt_number
    `, [runId]);
    return result.rows.map(caseAttemptOf);
  }

  async listSampleAttempts(caseAttemptId: string): Promise<EvaluationSampleAttempt[]> {
    const result = await this.database.query<SampleAttemptRow>(`
      SELECT ${SAMPLE_COLUMNS} FROM evaluation_sample_attempts WHERE case_attempt_id = $1
      ORDER BY sample_index
    `, [caseAttemptId]);
    return result.rows.map(sampleOf);
  }

  async appendEvent(event: EvaluationRunEvent): Promise<EvaluationRunEvent> {
    try {
      const parsed = parseEvaluationRunEvent(event);
      const result = await this.database.query<EventRow>(`
        INSERT INTO evaluation_run_events (${EVENT_COLUMNS})
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        RETURNING ${EVENT_COLUMNS}
      `, [parsed.eventId, parsed.runId, parsed.sequence, parsed.eventType, parsed.occurredAt,
        json(parsed.payload), evaluationRunEventDigest(parsed)]);
      return eventOf(result.rows[0]!);
    } catch (error) {
      return failure(error);
    }
  }

  async listEvents(runId: string, afterSequence = 0): Promise<EvaluationRunEvent[]> {
    const result = await this.database.query<EventRow>(`
      SELECT ${EVENT_COLUMNS} FROM evaluation_run_events
      WHERE run_id = $1 AND sequence > $2 ORDER BY sequence
    `, [runId, afterSequence]);
    return result.rows.map(eventOf);
  }
}

