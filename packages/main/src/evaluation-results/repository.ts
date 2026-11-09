import { randomBytes } from 'node:crypto';
import {
  EvaluationError,
  evaluationResultDigest,
  parseEvaluationResult,
  type EvaluationResult,
} from '@lyra/shared';

const clone = <T>(value: T): T => structuredClone(value);

export function evaluationResultId(): string {
  return `evalres_${randomBytes(16).toString('hex')}`;
}

function conflict(code: string, message: string): never {
  throw new EvaluationError(409, code, message);
}

/**
 * 统一评估结果仓储。只追加、不可覆盖。
 * 幂等由 result_digest 唯一约束保证：同一内容重放返回 (existing, created=false)。
 */
export interface EvaluationResultsRepository {
  append(result: EvaluationResult): Promise<{ result: EvaluationResult; created: boolean }>;
  getByDigest(digest: string): Promise<EvaluationResult | null>;
  listByRun(runId: string): Promise<EvaluationResult[]>;
  listBySubject(kind: string, id: string): Promise<EvaluationResult[]>;
  listByEvaluator(evaluatorId: string, version: string): Promise<EvaluationResult[]>;
}

/** 内存实现与 PostgreSQL 共用同一套顺序；PG Trigger 是第二道防线。 */
export class MemoryEvaluationResultsRepository implements EvaluationResultsRepository {
  private readonly byId = new Map<string, EvaluationResult>();
  private readonly byDigest = new Map<string, string>();

  async append(result: EvaluationResult): Promise<{ result: EvaluationResult; created: boolean }> {
    if (result.resultDigest !== evaluationResultDigest(result)) {
      conflict('EVALUATION_RESULT_DIGEST_MISMATCH', '结果摘要与内容不一致。');
    }
    const existingId = this.byDigest.get(result.resultDigest);
    if (existingId) {
      const existing = this.byId.get(existingId)!;
      return { result: clone(existing), created: false };
    }
    if (this.byId.has(result.resultId)) {
      conflict('EVALUATION_RESULT_CONFLICT', '结果 ID 已存在。');
    }
    parseEvaluationResult(clone(result));
    this.byId.set(result.resultId, clone(result));
    this.byDigest.set(result.resultDigest, result.resultId);
    return { result: clone(result), created: true };
  }

  async getByDigest(digest: string): Promise<EvaluationResult | null> {
    const id = this.byDigest.get(digest);
    const row = id ? this.byId.get(id) : undefined;
    return row ? clone(row) : null;
  }

  async listByRun(runId: string): Promise<EvaluationResult[]> {
    return [...this.byId.values()].filter(item => item.locator.runId === runId)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)).map(clone);
  }

  async listBySubject(kind: string, id: string): Promise<EvaluationResult[]> {
    return [...this.byId.values()].filter(item => item.subject.kind === kind && item.subject.id === id)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)).map(clone);
  }

  async listByEvaluator(evaluatorId: string, version: string): Promise<EvaluationResult[]> {
    return [...this.byId.values()]
      .filter(item => item.evaluator.evaluatorId === evaluatorId && item.evaluator.version === version)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)).map(clone);
  }
}
