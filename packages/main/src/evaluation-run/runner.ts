import {
  evaluationSnapshotDigest,
  isEvaluationRunTerminal,
  type EvaluationCaseAttempt,
  type EvaluationRun,
  type EvaluationRunEvent,
} from '@lyra/shared';
import { EvaluationRunService } from './service';
import {
  EvaluationExecutionError,
  caseBelongsToShard,
  type EvaluationCaseCatalog,
  type EvaluationLocalExecutor,
  type EvaluationLocalResult,
  type EvaluationRunCase,
} from './local-executor';

export interface EvaluationRunRunnerOptions {
  now?: () => Date;
}

export interface EvaluationRunExecutionOptions {
  signal?: AbortSignal;
  maxConcurrency?: number;
}

interface CasePlan {
  caseId: string;
  inputDigest: string;
  attemptNumber: number;
}

function executionError(error: unknown): EvaluationExecutionError {
  if (error instanceof EvaluationExecutionError) return error;
  return new EvaluationExecutionError('execution', 'EVALUATION_RUN_EXECUTION_FAILED',
    error instanceof Error ? error.message : '本地执行失败。');
}

function abortError(): EvaluationExecutionError {
  return new EvaluationExecutionError('cancelled', 'EVALUATION_RUN_CANCELLED', '本地执行已取消。');
}

/**
 * 本地执行器调度：稳定分片、并发上限、超时、取消、逐 sample 持久化与中断恢复。
 * 不读取“最新”数据集；只使用运行创建时冻结的 snapshot。
 */
export class EvaluationRunRunner {
  private eventChain: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly service: EvaluationRunService,
    private readonly executor: EvaluationLocalExecutor,
    private readonly catalog: EvaluationCaseCatalog,
    private readonly options: EvaluationRunRunnerOptions = {},
  ) {}

  private log(runId: string, eventType: EvaluationRunEvent['eventType'],
    payload: EvaluationRunEvent['payload']): Promise<EvaluationRunEvent> {
    const task = this.eventChain.then(() => this.service.appendRunEvent(runId, eventType, payload));
    this.eventChain = task.then(() => undefined, () => undefined);
    return task;
  }

  /** 将上次进程留下的 running/pending attempt 标为中断；历史 sample 原样保留。 */
  async recover(runId: string): Promise<number> {
    const run = await this.service.get(runId);
    if (isEvaluationRunTerminal(run.status)) return 0;
    const attempts = await this.service.listCaseAttempts(runId);
    let recovered = 0;
    for (const attempt of attempts) {
      if (attempt.status !== 'running' && attempt.status !== 'pending') continue;
      const error = {
        category: 'execution' as const,
        code: 'EVALUATION_RUN_INTERRUPTED',
        message: '进程中断，该 attempt 已标记为 interrupted。',
      };
      await this.service.finishCase(attempt.caseAttemptId, runId, 'interrupted', error);
      await this.log(runId, 'case_attempt_failed', {
        caseId: attempt.caseId,
        caseAttemptId: attempt.caseAttemptId,
        errorCode: error.code,
        reason: error.message,
      });
      recovered += 1;
    }
    return recovered;
  }

  async run(runId: string, execution: EvaluationRunExecutionOptions = {}): Promise<EvaluationRun> {
    let run = await this.service.get(runId);
    if (isEvaluationRunTerminal(run.status)) return run;
    await this.recover(runId);
    run = await this.service.get(runId);
    if (isEvaluationRunTerminal(run.status)) return run;

    if (execution.signal?.aborted) {
      return this.service.transition(runId, { expectedVersion: run.version, status: 'cancelled' });
    }
    if (run.status !== 'running') {
      run = await this.service.transition(runId, { expectedVersion: run.version, status: 'running' });
    }

    const cases = await this.catalog.listCases(run.snapshot);
    const unique = [...new Map(cases.map(item => [item.caseId, item])).values()]
      .filter(item => caseBelongsToShard(item.caseId, run.snapshot.shards.shardCount,
        run.snapshot.shards.shardIndex))
      .sort((a, b) => a.caseId.localeCompare(b.caseId));
    for (const item of unique) {
      if (!/^[a-z0-9][a-z0-9_-]{2,63}$/u.test(item.caseId) || !/^[a-f0-9]{64}$/u.test(item.inputDigest)) {
        throw new EvaluationExecutionError('validation', 'EVALUATION_RUN_CASE_INVALID', 'case 目录包含非法 ID 或摘要。');
      }
    }

    const existing = await this.service.listCaseAttempts(runId);
    const plans = this.planCases(unique, existing);
    const concurrency = Math.max(1, Math.min(execution.maxConcurrency ?? run.snapshot.shards.concurrency, 64));
    let cursor = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= plans.length) return;
        const plan = plans[index];
        if (!plan) return;
        if (execution.signal?.aborted) return;
        await this.runCase(runId, plan, run, execution.signal);
      }
    });
    await Promise.all(workers);

    const final = await this.service.get(runId);
    if (isEvaluationRunTerminal(final.status)) return final;
    if (execution.signal?.aborted) {
      return this.service.transition(runId, { expectedVersion: final.version, status: 'cancelled' });
    }
    return this.service.transition(runId, { expectedVersion: final.version, status: 'completed' });
  }

  private planCases(cases: EvaluationRunCase[], attempts: EvaluationCaseAttempt[]): CasePlan[] {
    const byCase = new Map<string, EvaluationCaseAttempt[]>();
    for (const attempt of attempts) {
      byCase.set(attempt.caseId, [...(byCase.get(attempt.caseId) ?? []), attempt]);
    }
    return cases.flatMap(item => {
      const prior = byCase.get(item.caseId) ?? [];
      if (prior.some(attempt => attempt.status === 'completed' || attempt.status === 'failed'
        || attempt.status === 'cancelled')) return [];
      const maxAttempt = prior.reduce((max, attempt) => Math.max(max, attempt.attemptNumber), 0);
      return [{
        caseId: item.caseId,
        inputDigest: item.inputDigest,
        attemptNumber: Math.max(1, maxAttempt + 1),
      }];
    });
  }

  private async runCase(runId: string, plan: CasePlan, run: EvaluationRun, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const attempt = await this.service.beginCase(runId, plan.caseId, run.snapshot.shards.shardIndex,
      plan.attemptNumber);
    await this.log(runId, 'case_attempt_started', {
      caseId: plan.caseId, caseAttemptId: attempt.caseAttemptId,
    });
    const samples = run.snapshot.shards.samplesPerCase;
    for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
      if (signal?.aborted) {
        await this.closeCase(runId, attempt, 'cancelled', abortError());
        return;
      }
      let result: EvaluationLocalResult;
      try {
        result = await this.executeSample(run, plan, sampleIndex, attempt.attemptNumber, signal);
      } catch (error) {
        const failure = executionError(error);
        const sampleStatus = failure.category === 'cancelled' ? 'cancelled' as const : 'failed' as const;
        await this.service.recordSample(runId, attempt.caseAttemptId, sampleIndex, null, 0, 0, 'CNY',
          sampleStatus, { category: failure.category, code: failure.code, message: failure.message });
        await this.closeCase(runId, attempt, sampleStatus === 'cancelled' ? 'cancelled' : 'failed', failure);
        return;
      }
      await this.service.recordSample(runId, attempt.caseAttemptId, sampleIndex, result.outputDigest,
        result.durationMs, result.costMicros, result.currency, 'completed', null);
      await this.log(runId, 'sample_attempt_completed', {
        caseId: plan.caseId, caseAttemptId: attempt.caseAttemptId, sampleIndex,
      });
    }
    await this.closeCase(runId, attempt, 'completed', null);
  }

  private async closeCase(runId: string, attempt: EvaluationCaseAttempt,
    status: 'completed' | 'failed' | 'cancelled', error: EvaluationExecutionError | null): Promise<void> {
    await this.service.finishCase(attempt.caseAttemptId, runId, status,
      error ? { category: error.category, code: error.code, message: error.message } : null);
    await this.log(runId, status === 'completed' ? 'case_attempt_completed' : 'case_attempt_failed', {
      caseId: attempt.caseId,
      caseAttemptId: attempt.caseAttemptId,
      ...(error ? { errorCode: error.code, reason: error.message } : {}),
    });
  }

  private async executeSample(run: EvaluationRun, plan: CasePlan, sampleIndex: number,
    attemptNumber: number, externalSignal?: AbortSignal): Promise<EvaluationLocalResult> {
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      controller.abort();
    };
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new EvaluationExecutionError('timeout', 'EVALUATION_RUN_TIMEOUT', '本地执行超时。'));
      }, run.snapshot.shards.timeoutMs);
    });
    const abort = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(
        timedOut ? new EvaluationExecutionError('timeout', 'EVALUATION_RUN_TIMEOUT', '本地执行超时。')
          : new EvaluationExecutionError('cancelled', 'EVALUATION_RUN_CANCELLED', '本地执行已取消。'),
      ), { once: true });
    });
    try {
      return await Promise.race([
        this.executor.execute({
          runId: run.runId,
          caseId: plan.caseId,
          inputDigest: plan.inputDigest,
          sampleIndex,
          attemptNumber,
          snapshot: run.snapshot,
          signal: controller.signal,
        }),
        timeout,
        abort,
      ]);
    } catch (error) {
      if (timedOut) throw new EvaluationExecutionError('timeout', 'EVALUATION_RUN_TIMEOUT', '本地执行超时。');
      if (cancelled || externalSignal?.aborted) throw abortError();
      throw executionError(error);
    } finally {
      if (timer) clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    }
  }
}
