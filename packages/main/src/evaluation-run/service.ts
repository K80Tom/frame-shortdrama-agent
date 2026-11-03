import {
  EvaluationError,
  EvaluationRunContractError,
  EVALUATION_RUN_STATUSES,
  canTransitionEvaluationRun,
  evaluationRunRequestDigest,
  evaluationSnapshotDigest,
  isEvaluationRunTerminal,
  parseEvaluationRunCreate,
  parseEvaluationRunReplay,
  type EvaluationCaseAttempt,
  type EvaluationRun,
  type EvaluationRunEvent,
  type EvaluationRunStatus,
  type EvaluationSampleAttempt,
  type FrozenEvaluationSnapshot,
} from '@lyra/shared';
import {
  assertCreateRecordDigest,
  evaluationRunId,
  type EvaluationRunRepository,
} from './repository';

const RUN_ID = /^evalrun_[a-f0-9]{32}$/u;
const CASE_ATTEMPT_ID = /^evalattempt_[a-f0-9]{32}$/u;

export interface EvaluationRunServiceOptions { now?: () => Date }

function contractError(error: unknown): never {
  if (error instanceof EvaluationRunContractError) {
    throw new EvaluationError(error.status, error.code, error.message, error.details);
  }
  throw error;
}
function badRequest(code: string, message: string): never {
  throw new EvaluationError(400, code, message, [{ path: 'body', code, message }]);
}
function conflict(code: string, message: string): never {
  throw new EvaluationError(409, code, message, [{ path: 'body', code, message }]);
}
function notFound(code: string, message: string): never {
  throw new EvaluationError(404, code, message, [{ path: 'body', code, message }]);
}

function parseRunId(value: string): string {
  if (!RUN_ID.test(value)) badRequest('EVALUATION_RUN_INPUT_INVALID', '评测运行 ID 格式不正确。');
  return value;
}
function parseCaseAttemptId(value: string): string {
  if (!CASE_ATTEMPT_ID.test(value)) badRequest('EVALUATION_RUN_INPUT_INVALID', 'case attempt ID 格式不正确。');
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    badRequest('EVALUATION_RUN_INPUT_INVALID', '请求体必须是对象。');
  }
  return value as Record<string, unknown>;
}

function expectedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    badRequest('EVALUATION_RUN_INPUT_INVALID', 'expectedVersion 必须是正整数。');
  }
  return value;
}

/**
 * EvaluationRun 的业务入口。
 *
 * 不注入 ProductionRepository，也不创建生产任务；生产引用只作为快照里的不可变 ID。
 */
export class EvaluationRunService {
  private readonly now: () => Date;
  constructor(private readonly repository: EvaluationRunRepository, options: EvaluationRunServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  private timestamp(): string { return this.now().toISOString(); }

  async create(body: unknown): Promise<EvaluationRun> {
    try {
      const input = parseEvaluationRunCreate(body);
      const at = this.timestamp();
      const snapshotDigest = evaluationSnapshotDigest(input.snapshot);
      const requestDigest = evaluationRunRequestDigest(input);
      const record = {
        runId: evaluationRunId('evalrun'),
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        snapshot: input.snapshot,
        snapshotDigest,
        createdAt: at,
      };
      assertCreateRecordDigest(record);
      return (await this.repository.createRun(record)).run;
    } catch (error) {
      return contractError(error);
    }
  }

  async get(runId: string): Promise<EvaluationRun> {
    const run = await this.repository.getRun(parseRunId(runId));
    if (!run) return notFound('EVALUATION_RUN_NOT_FOUND', '评测运行不存在。');
    return run;
  }

  async transition(runId: string, body: unknown): Promise<EvaluationRun> {
    const input = object(body);
    const version = expectedVersion(input.expectedVersion);
    const status = input.status;
    if (typeof status !== 'string' || !EVALUATION_RUN_STATUSES.includes(status as EvaluationRunStatus)) {
      badRequest('EVALUATION_RUN_INPUT_INVALID', `status 必须是 ${EVALUATION_RUN_STATUSES.join(' / ')}。`);
    }
    return this.transitionTo(parseRunId(runId), version, status as EvaluationRunStatus);
  }

  private async transitionTo(runId: string, version: number, status: EvaluationRunStatus): Promise<EvaluationRun> {
    const run = await this.get(runId);
    if (isEvaluationRunTerminal(run.status)) conflict('EVALUATION_RUN_TERMINAL_IMMUTABLE', '终态运行只读。');
    if (!canTransitionEvaluationRun(run.status, status)) {
      conflict('EVALUATION_RUN_TRANSITION_INVALID', `不允许从 ${run.status} 迁移到 ${status}。`);
    }
    const at = this.timestamp();
    const startedAt = status === 'running' ? (run.startedAt ?? at) : run.startedAt;
    const endedAt = isEvaluationRunTerminal(status) ? at : null;
    return this.repository.updateRunStatus({
      runId, expectedVersion: version, status, at, startedAt, endedAt,
    });
  }

  async replay(sourceRunId: string, body: unknown): Promise<EvaluationRun> {
    const source = await this.get(parseRunId(sourceRunId));
    if (!isEvaluationRunTerminal(source.status)) {
      conflict('EVALUATION_RUN_REPLAY_INVALID', '只有终态运行可以重放。');
    }
    let replay;
    try {
      replay = parseEvaluationRunReplay({ ...object(body), sourceRunId });
    } catch (error) {
      return contractError(error);
    }
    const at = this.timestamp();
    const snapshotDigest = evaluationSnapshotDigest(source.snapshot);
    const requestDigest = evaluationRunRequestDigest({ idempotencyKey: replay.idempotencyKey, snapshot: source.snapshot });
    const record = {
      runId: evaluationRunId('evalrun'),
      idempotencyKey: replay.idempotencyKey,
      requestDigest,
      snapshot: source.snapshot,
      snapshotDigest,
      createdAt: at,
      replayedFromRunId: source.runId,
    };
    assertCreateRecordDigest(record);
    return (await this.repository.createRun(record)).run;
  }

  async listCaseAttempts(runId: string): Promise<EvaluationCaseAttempt[]> {
    await this.get(parseRunId(runId));
    return this.repository.listCaseAttempts(runId);
  }

  async listSampleAttempts(caseAttemptId: string): Promise<EvaluationSampleAttempt[]> {
    return this.repository.listSampleAttempts(parseCaseAttemptId(caseAttemptId));
  }

  async listEvents(runId: string, afterSequence = 0): Promise<EvaluationRunEvent[]> {
    await this.get(parseRunId(runId));
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      badRequest('EVALUATION_RUN_INPUT_INVALID', 'afterSequence 必须是非负整数。');
    }
    return this.repository.listEvents(runId, afterSequence);
  }

  async appendEvent(runId: string, eventType: EvaluationRunEvent['eventType'], payload: EvaluationRunEvent['payload'],
    sequence: number): Promise<EvaluationRunEvent> {
    await this.get(parseRunId(runId));
    if (!Number.isInteger(sequence) || sequence < 1) badRequest('EVALUATION_RUN_INPUT_INVALID', 'sequence 必须是正整数。');
    const event: EvaluationRunEvent = {
      eventId: evaluationRunId('evalrunevt'), runId, sequence, eventType, occurredAt: this.timestamp(), payload,
    };
    return this.repository.appendEvent(event);
  }

  async beginCase(runId: string, caseId: string, shardIndex: number, attemptNumber: number): Promise<EvaluationCaseAttempt> {
    const run = await this.get(parseRunId(runId));
    if (isEvaluationRunTerminal(run.status)) conflict('EVALUATION_RUN_TERMINAL_IMMUTABLE', '终态运行不能追加 attempt。');
    if (typeof caseId !== 'string' || !/^[a-z0-9][a-z0-9_-]{2,63}$/u.test(caseId)) {
      badRequest('EVALUATION_RUN_INPUT_INVALID', 'caseId 格式不正确。');
    }
    if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex > 255) {
      badRequest('EVALUATION_RUN_INPUT_INVALID', 'shardIndex 必须是 0..255。');
    }
    if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > 100) {
      badRequest('EVALUATION_RUN_INPUT_INVALID', 'attemptNumber 必须是 1..100。');
    }
    const attempt: EvaluationCaseAttempt = {
      caseAttemptId: evaluationRunId('evalattempt'), runId, caseId, shardIndex, attemptNumber,
      status: 'running', startedAt: this.timestamp(), endedAt: null, error: null, samples: [],
    };
    return this.repository.createCaseAttempt(attempt);
  }

  async finishCase(caseAttemptId: string, runId: string, status: 'completed' | 'failed' | 'interrupted' | 'cancelled',
    error: EvaluationCaseAttempt['error'] = null): Promise<EvaluationCaseAttempt> {
    const attempt = (await this.repository.listCaseAttempts(parseRunId(runId)))
      .find(item => item.caseAttemptId === caseAttemptId);
    if (!attempt) return notFound('EVALUATION_RUN_CASE_ATTEMPT_NOT_FOUND', 'case attempt 不存在。');
    return this.repository.updateCaseAttempt({
      caseAttemptId: parseCaseAttemptId(caseAttemptId), runId, expectedStatus: attempt.status,
      status, endedAt: this.timestamp(), error,
    });
  }

  async recordSample(runId: string, caseAttemptId: string, sampleIndex: number,
    outputDigest: string | null, durationMs: number, costMicros: number, currency: string,
    status: EvaluationSampleAttempt['status'] = 'completed',
    error: EvaluationSampleAttempt['error'] = null): Promise<EvaluationSampleAttempt> {
    const run = await this.get(parseRunId(runId));
    if (isEvaluationRunTerminal(run.status)) conflict('EVALUATION_RUN_TERMINAL_IMMUTABLE', '终态运行不能追加 sample。');
    if (!Number.isInteger(sampleIndex) || sampleIndex < 0 || sampleIndex > 19) {
      badRequest('EVALUATION_RUN_INPUT_INVALID', 'sampleIndex 必须是 0..19。');
    }
    if (status === 'completed') {
      if (typeof outputDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(outputDigest)) {
        badRequest('EVALUATION_RUN_INPUT_INVALID', '完成的 sample 必须提供 64 位 hex outputDigest。');
      }
    } else if (outputDigest !== null) {
      badRequest('EVALUATION_RUN_INPUT_INVALID', '未完成的 sample 不能提供 outputDigest。');
    }
    if ((status === 'failed' || status === 'interrupted') && error === null) {
      badRequest('EVALUATION_RUN_INPUT_INVALID', '失败或中断的 sample 必须记录错误。');
    }
    if (!Number.isInteger(durationMs) || durationMs < 0) badRequest('EVALUATION_RUN_INPUT_INVALID', 'durationMs 必须是非负整数。');
    if (!Number.isInteger(costMicros) || costMicros < 0) badRequest('EVALUATION_RUN_INPUT_INVALID', 'costMicros 必须是非负整数。');
    if (!/^[A-Z]{3}$/u.test(currency)) badRequest('EVALUATION_RUN_INPUT_INVALID', 'currency 必须是三位大写币种。');
    const sample: EvaluationSampleAttempt = {
      sampleAttemptId: evaluationRunId('evalsample'), caseAttemptId: parseCaseAttemptId(caseAttemptId), sampleIndex,
      status, outputDigest: status === 'completed' ? outputDigest : null, durationMs, costMicros, currency, error,
    };
    return this.repository.createSampleAttempt(sample);
  }

  async appendRunEvent(runId: string, eventType: EvaluationRunEvent['eventType'],
    payload: EvaluationRunEvent['payload']): Promise<EvaluationRunEvent> {
    const events = await this.listEvents(runId);
    const next = (events.at(-1)?.sequence ?? 0) + 1;
    return this.appendEvent(runId, eventType, payload, next);
  }
}

export type { FrozenEvaluationSnapshot };
