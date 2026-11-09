import type { QueryResultRow } from 'pg';
import {
  EvaluationError,
  evaluationResultDigest,
  parseEvaluationResult,
  type EvaluationResult,
} from '@lyra/shared';
import type { PostgresDatabase } from '../db/client';
import type { EvaluationResultsRepository } from './repository';

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString()
    : typeof value === 'string' ? new Date(value).toISOString()
    : new Date(String(value)).toISOString();

function conflict(code: string, message: string): never {
  throw new EvaluationError(409, code, message);
}

function failure(error: unknown): never {
  if (error instanceof EvaluationError) throw error;
  const record = error && typeof error === 'object' ? error as { code?: string; message?: string; constraint?: string } : {};
  const message = record.message ?? '';
  if (message.includes('EVALUATION_RESULTS_APPEND_ONLY')) {
    conflict('EVALUATION_RESULTS_APPEND_ONLY', '评估结果只允许追加，不能覆盖或删除。');
  }
  if (record.code === '23505') {
    // result_digest 唯一冲突 = 幂等重放；调用方在事务内已先查过，这里兜底。
    return conflict('EVALUATION_RESULT_DIGEST_CONFLICT', '同一结果摘要已存在。');
  }
  if (record.code === '23503') {
    throw new EvaluationError(404, 'EVALUATION_RUN_NOT_FOUND', '结果引用的评测运行不存在。');
  }
  if (record.code === '23514') {
    conflict('EVALUATION_RESULT_LOCATOR_INVALID', '结果定位不满足闭合约束。');
  }
  throw new EvaluationError(503, 'EVALUATION_PERSISTENCE_UNAVAILABLE', '评测结果存储暂时不可用。');
}

interface ResultRow extends QueryResultRow {
  result_id: string; result_digest: string; run_id: string | null; case_id: string | null;
  sample_index: number | null; subject_kind: string; subject_id: string;
  subject_revision_id: string | null; subject_digest: string; evaluator_id: string;
  evaluator_version: string; evaluator_digest: string; status: EvaluationResult['status'];
  confidence: number | null; duration_ms: number; error_json: EvaluationResult['error'];
  legacy_json: EvaluationResult['legacy']; evidence_json: EvaluationResult['evidence'];
  metrics_json: EvaluationResult['metrics']; result_json: unknown;
  occurred_at: unknown; recorded_at: unknown;
}

const COLUMNS = `result_id, result_digest, run_id, case_id, sample_index, subject_kind, subject_id,
  subject_revision_id, subject_digest, evaluator_id, evaluator_version, evaluator_digest, status,
  confidence, duration_ms, error_json, legacy_json, evidence_json, metrics_json, result_json,
  occurred_at, recorded_at`;

function resultOf(row: ResultRow): EvaluationResult {
  // 优先用完整对象往返解析，保证仓储读出的结果与写入时同一契约。
  if (row.result_json && typeof row.result_json === 'object') {
    return parseEvaluationResult(row.result_json);
  }
  return parseEvaluationResult({
    schemaVersion: 'lyra-evaluator-result/1',
    resultId: row.result_id,
    locator: { runId: row.run_id, caseId: row.case_id, sampleIndex: row.sample_index },
    subject: {
      kind: row.subject_kind, id: row.subject_id,
      revisionId: row.subject_revision_id, digest: row.subject_digest,
    },
    evaluator: {
      evaluatorId: row.evaluator_id, version: row.evaluator_version, digest: row.evaluator_digest,
    },
    status: row.status,
    inputSummary: '', outputSummary: '', confidence: row.confidence, durationMs: row.duration_ms,
    evidence: row.evidence_json, metrics: row.metrics_json, error: row.error_json, legacy: row.legacy_json,
    resultDigest: row.result_digest,
    occurredAt: iso(row.occurred_at), recordedAt: iso(row.recorded_at),
  });
}

/** PostgreSQL 主实现；追加式由 BEFORE UPDATE/DELETE Trigger 兜底。 */
export class PostgresEvaluationResultsRepository implements EvaluationResultsRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async append(result: EvaluationResult): Promise<{ result: EvaluationResult; created: boolean }> {
    if (result.resultDigest !== evaluationResultDigest(result)) {
      conflict('EVALUATION_RESULT_DIGEST_MISMATCH', '结果摘要与内容不一致。');
    }
    try {
      return await this.database.transaction(async client => {
        const existing = await client.query<ResultRow>(
          `SELECT ${COLUMNS} FROM evaluation_results WHERE result_digest = $1`,
          [result.resultDigest],
        );
        if (existing.rows[0]) return { result: resultOf(existing.rows[0]!), created: false };
        await client.query(
          `INSERT INTO evaluation_results (
             result_id, result_digest, run_id, case_id, sample_index, subject_kind, subject_id,
             subject_revision_id, subject_digest, evaluator_id, evaluator_version, evaluator_digest,
             status, confidence, duration_ms, error_json, legacy_json, evidence_json, metrics_json,
             result_json, occurred_at, recorded_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
          [
            result.resultId, result.resultDigest, result.locator.runId, result.locator.caseId,
            result.locator.sampleIndex, result.subject.kind, result.subject.id,
            result.subject.revisionId, result.subject.digest, result.evaluator.evaluatorId,
            result.evaluator.version, result.evaluator.digest, result.status, result.confidence,
            result.durationMs, JSON.stringify(result.error), JSON.stringify(result.legacy),
            JSON.stringify(result.evidence), JSON.stringify(result.metrics), JSON.stringify(result),
            result.occurredAt, result.recordedAt,
          ],
        );
        return { result, created: true };
      });
    } catch (error) {
      return failure(error);
    }
  }

  async getByDigest(digest: string): Promise<EvaluationResult | null> {
    try {
      const row = await this.database.query<ResultRow>(
        `SELECT ${COLUMNS} FROM evaluation_results WHERE result_digest = $1`, [digest]);
      return row.rows[0] ? resultOf(row.rows[0]!) : null;
    } catch (error) {
      return failure(error);
    }
  }

  async listByRun(runId: string): Promise<EvaluationResult[]> {
    try {
      const row = await this.database.query<ResultRow>(
        `SELECT ${COLUMNS} FROM evaluation_results WHERE run_id = $1 ORDER BY recorded_at`, [runId]);
      return row.rows.map(resultOf);
    } catch (error) {
      return failure(error);
    }
  }

  async listBySubject(kind: string, id: string): Promise<EvaluationResult[]> {
    try {
      const row = await this.database.query<ResultRow>(
        `SELECT ${COLUMNS} FROM evaluation_results WHERE subject_kind = $1 AND subject_id = $2
         ORDER BY recorded_at`, [kind, id]);
      return row.rows.map(resultOf);
    } catch (error) {
      return failure(error);
    }
  }

  async listByEvaluator(evaluatorId: string, version: string): Promise<EvaluationResult[]> {
    try {
      const row = await this.database.query<ResultRow>(
        `SELECT ${COLUMNS} FROM evaluation_results WHERE evaluator_id = $1 AND evaluator_version = $2
         ORDER BY recorded_at`, [evaluatorId, version]);
      return row.rows.map(resultOf);
    } catch (error) {
      return failure(error);
    }
  }
}
