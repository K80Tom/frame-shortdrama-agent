import { randomBytes } from 'node:crypto';
import {
  EvaluationError,
  canTransitionEvaluationRun,
  evaluationSnapshotDigest,
  isEvaluationRunTerminal,
  parseEvaluationRun,
  type EvaluationCaseAttempt,
  type EvaluationRun,
  type EvaluationRunEvent,
  type EvaluationSampleAttempt,
  type FrozenEvaluationSnapshot,
} from '@lyra/shared';

const clone = <T>(value: T): T => structuredClone(value);

export function evaluationRunId(prefix: 'evalrun' | 'evalattempt' | 'evalsample' | 'evalrunevt'): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}

function conflict(code: string, message: string): never {
  throw new EvaluationError(409, code, message);
}
function notFound(code: string, message: string): never {
  throw new EvaluationError(404, code, message);
}

export interface EvaluationRunCreateRecord {
  runId: string;
  idempotencyKey: string;
  requestDigest: string;
  snapshot: FrozenEvaluationSnapshot;
  snapshotDigest: string;
  createdAt: string;
  replayedFromRunId?: string | null;
}

export interface EvaluationRunStatusUpdate {
  runId: string;
  expectedVersion: number;
  status: EvaluationRun['status'];
  at: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface CaseAttemptUpdate {
  caseAttemptId: string;
  runId: string;
  expectedStatus: EvaluationCaseAttempt['status'];
  status: EvaluationCaseAttempt['status'];
  endedAt: string | null;
  error: EvaluationCaseAttempt['error'];
}

export interface EvaluationRunRepository {
  createRun(input: EvaluationRunCreateRecord): Promise<{ run: EvaluationRun; created: boolean }>;
  getRun(runId: string): Promise<EvaluationRun | null>;
  updateRunStatus(input: EvaluationRunStatusUpdate): Promise<EvaluationRun>;
  createCaseAttempt(attempt: EvaluationCaseAttempt): Promise<EvaluationCaseAttempt>;
  updateCaseAttempt(update: CaseAttemptUpdate): Promise<EvaluationCaseAttempt>;
  createSampleAttempt(sample: EvaluationSampleAttempt): Promise<EvaluationSampleAttempt>;
  listCaseAttempts(runId: string): Promise<EvaluationCaseAttempt[]>;
  listSampleAttempts(caseAttemptId: string): Promise<EvaluationSampleAttempt[]>;
  appendEvent(event: EvaluationRunEvent): Promise<EvaluationRunEvent>;
  listEvents(runId: string, afterSequence?: number): Promise<EvaluationRunEvent[]>;
}

const ATTEMPT_TRANSITIONS: Readonly<Record<EvaluationCaseAttempt['status'], readonly EvaluationCaseAttempt['status'][]>> = {
  pending: ['running', 'completed', 'failed', 'interrupted', 'cancelled'],
  running: ['completed', 'failed', 'interrupted', 'cancelled'],
  completed: [], failed: [], interrupted: [], cancelled: [],
};

function attemptTransitionAllowed(from: EvaluationCaseAttempt['status'], to: EvaluationCaseAttempt['status']): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

/** 内存实现与 PostgreSQL 共用同一套业务顺序；PG Trigger 是第二道防线。 */
export class MemoryEvaluationRunRepository implements EvaluationRunRepository {
  private readonly runs = new Map<string, EvaluationRun>();
  private readonly idempotency = new Map<string, string>();
  private readonly caseAttempts = new Map<string, EvaluationCaseAttempt>();
  private readonly samples = new Map<string, EvaluationSampleAttempt>();
  private readonly events = new Map<string, EvaluationRunEvent>();

  async createRun(input: EvaluationRunCreateRecord): Promise<{ run: EvaluationRun; created: boolean }> {
    const existingId = this.idempotency.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.runs.get(existingId)!;
      if (existing.requestDigest !== input.requestDigest) {
        conflict('EVALUATION_RUN_IDEMPOTENCY_CONFLICT', '同一幂等键对应了不同请求。');
      }
      return { run: clone(existing), created: false };
    }
    if (this.runs.has(input.runId)) conflict('EVALUATION_RUN_IDEMPOTENCY_CONFLICT', '运行 ID 已存在。');
    const run: EvaluationRun = {
      runId: input.runId,
      status: 'prepared',
      snapshot: clone(input.snapshot),
      snapshotDigest: input.snapshotDigest,
      requestDigest: input.requestDigest,
      idempotencyKey: input.idempotencyKey,
      version: 1,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      startedAt: null,
      endedAt: null,
      replayedFromRunId: input.replayedFromRunId ?? null,
    };
    parseEvaluationRun(run);
    this.runs.set(run.runId, clone(run));
    this.idempotency.set(input.idempotencyKey, run.runId);
    await this.appendEvent({
      eventId: evaluationRunId('evalrunevt'), runId: run.runId, sequence: 1, eventType: 'prepared',
      occurredAt: input.createdAt, payload: { status: 'prepared' },
    });
    return { run: clone(run), created: true };
  }

  async getRun(runId: string): Promise<EvaluationRun | null> {
    const run = this.runs.get(runId);
    return run ? clone(run) : null;
  }

  async updateRunStatus(input: EvaluationRunStatusUpdate): Promise<EvaluationRun> {
    const run = this.runs.get(input.runId);
    if (!run) return notFound('EVALUATION_RUN_NOT_FOUND', '评测运行不存在。');
    if (isEvaluationRunTerminal(run.status)) conflict('EVALUATION_RUN_TERMINAL_IMMUTABLE', '终态运行只读。');
    if (run.version !== input.expectedVersion) conflict('EVALUATION_RUN_VERSION_CONFLICT', '运行版本已变化，请刷新后重试。');
    if (!canTransitionEvaluationRun(run.status, input.status)) {
      conflict('EVALUATION_RUN_TRANSITION_INVALID', `不允许从 ${run.status} 迁移到 ${input.status}。`);
    }
    if (input.status === 'running' && input.startedAt === null) {
      conflict('EVALUATION_RUN_TRANSITION_INVALID', '开始运行必须提供 startedAt。');
    }
    if (isEvaluationRunTerminal(input.status) && input.endedAt === null) {
      conflict('EVALUATION_RUN_TRANSITION_INVALID', '终态运行必须提供 endedAt。');
    }
    const next: EvaluationRun = {
      ...clone(run),
      status: input.status,
      version: run.version + 1,
      updatedAt: input.at,
      startedAt: input.startedAt ?? run.startedAt,
      endedAt: input.endedAt,
    };
    parseEvaluationRun(next);
    this.runs.set(next.runId, clone(next));
    return clone(next);
  }

  async createCaseAttempt(attempt: EvaluationCaseAttempt): Promise<EvaluationCaseAttempt> {
    const run = this.runs.get(attempt.runId);
    if (!run) return notFound('EVALUATION_RUN_NOT_FOUND', '评测运行不存在。');
    if (isEvaluationRunTerminal(run.status)) conflict('EVALUATION_RUN_TERMINAL_IMMUTABLE', '终态运行不能追加 attempt。');
    const key = `${attempt.runId}\u0000${attempt.caseId}\u0000${attempt.attemptNumber}`;
    for (const existing of this.caseAttempts.values()) {
      if (`${existing.runId}\u0000${existing.caseId}\u0000${existing.attemptNumber}` === key) {
        conflict('EVALUATION_RUN_CASE_ATTEMPT_CONFLICT', 'case attempt 序号已存在。');
      }
    }
    if (this.caseAttempts.has(attempt.caseAttemptId)) conflict('EVALUATION_RUN_CASE_ATTEMPT_CONFLICT', 'case attempt ID 已存在。');
    this.caseAttempts.set(attempt.caseAttemptId, clone(attempt));
    return clone(attempt);
  }

  async updateCaseAttempt(update: CaseAttemptUpdate): Promise<EvaluationCaseAttempt> {
    const attempt = this.caseAttempts.get(update.caseAttemptId);
    if (!attempt || attempt.runId !== update.runId) return notFound('EVALUATION_RUN_CASE_ATTEMPT_NOT_FOUND', 'case attempt 不存在。');
    if (attempt.status !== update.expectedStatus) conflict('EVALUATION_RUN_CASE_ATTEMPT_CONFLICT', 'case attempt 状态已变化。');
    if (attempt.status === 'completed' || attempt.status === 'failed' || attempt.status === 'interrupted'
      || attempt.status === 'cancelled') {
      conflict('EVALUATION_RUN_CASE_ATTEMPT_IMMUTABLE', '终态 case attempt 只读。');
    }
    if (!attemptTransitionAllowed(attempt.status, update.status)) {
      conflict('EVALUATION_RUN_TRANSITION_INVALID', `attempt 不允许从 ${attempt.status} 迁移到 ${update.status}。`);
    }
    if ((update.status === 'completed' || update.status === 'failed' || update.status === 'interrupted')
      && update.endedAt === null) conflict('EVALUATION_RUN_TRANSITION_INVALID', '终态 attempt 必须提供 endedAt。');
    const next: EvaluationCaseAttempt = {
      ...clone(attempt), status: update.status, endedAt: update.endedAt, error: update.error ?? null,
    };
    this.caseAttempts.set(next.caseAttemptId, clone(next));
    return clone(next);
  }

  async createSampleAttempt(sample: EvaluationSampleAttempt): Promise<EvaluationSampleAttempt> {
    const attempt = this.caseAttempts.get(sample.caseAttemptId);
    if (!attempt) return notFound('EVALUATION_RUN_CASE_ATTEMPT_NOT_FOUND', 'case attempt 不存在。');
    if (attempt.status === 'completed' || attempt.status === 'failed' || attempt.status === 'interrupted'
      || attempt.status === 'cancelled') {
      conflict('EVALUATION_RUN_CASE_ATTEMPT_IMMUTABLE', '终态 case attempt 不能追加 sample。');
    }
    for (const existing of this.samples.values()) {
      if (existing.caseAttemptId === sample.caseAttemptId && existing.sampleIndex === sample.sampleIndex) {
        conflict('EVALUATION_RUN_SAMPLE_ATTEMPT_CONFLICT', 'sample 序号已存在。');
      }
    }
    if (this.samples.has(sample.sampleAttemptId)) conflict('EVALUATION_RUN_SAMPLE_ATTEMPT_CONFLICT', 'sample ID 已存在。');
    this.samples.set(sample.sampleAttemptId, clone(sample));
    return clone(sample);
  }

  async listCaseAttempts(runId: string): Promise<EvaluationCaseAttempt[]> {
    return [...this.caseAttempts.values()].filter(item => item.runId === runId)
      .sort((a, b) => a.caseId.localeCompare(b.caseId) || a.attemptNumber - b.attemptNumber)
      .map(item => clone(item));
  }

  async listSampleAttempts(caseAttemptId: string): Promise<EvaluationSampleAttempt[]> {
    return [...this.samples.values()].filter(item => item.caseAttemptId === caseAttemptId)
      .sort((a, b) => a.sampleIndex - b.sampleIndex).map(item => clone(item));
  }

  async appendEvent(event: EvaluationRunEvent): Promise<EvaluationRunEvent> {
    if (this.events.has(event.eventId)) conflict('EVALUATION_HISTORY_APPEND_ONLY', '运行事件 ID 已存在。');
    for (const existing of this.events.values()) {
      if (existing.runId === event.runId && existing.sequence === event.sequence) {
        conflict('EVALUATION_HISTORY_APPEND_ONLY', '运行事件序号已存在。');
      }
    }
    this.events.set(event.eventId, clone(event));
    return clone(event);
  }

  async listEvents(runId: string, afterSequence = 0): Promise<EvaluationRunEvent[]> {
    return [...this.events.values()].filter(item => item.runId === runId && item.sequence > afterSequence)
      .sort((a, b) => a.sequence - b.sequence).map(item => clone(item));
  }
}

/** 共享快照摘要校验：仓储层不信任调用方传入的摘要。 */
export function assertCreateRecordDigest(input: EvaluationRunCreateRecord): void {
  if (evaluationSnapshotDigest(input.snapshot) !== input.snapshotDigest) {
    conflict('EVALUATION_RUN_SNAPSHOT_DIGEST_MISMATCH', '快照摘要与冻结内容不一致。');
  }
}
