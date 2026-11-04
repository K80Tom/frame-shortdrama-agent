import type {
  EvaluationCaseAttempt,
  EvaluationRun,
  EvaluationRunEvent,
  EvaluationSampleAttempt,
} from '@lyra/shared';
import { EvaluationRunService } from './service';
import type { EvaluationCaseCatalog } from './local-executor';
import type { EvaluationRunExecutionOptions, EvaluationRunRunner } from './runner';

/**
 * 评测运行控制器：只做用例编排入口，不创建生产任务、不写生产状态。
 * HTTP 层若接入，只应调用本类，不应直接操作 Repository。
 */
export class EvaluationRunController {
  constructor(
    private readonly service: EvaluationRunService,
    private readonly runner: EvaluationRunRunner,
    private readonly catalog: EvaluationCaseCatalog,
  ) {}

  create(body: unknown): Promise<EvaluationRun> {
    return this.service.create(body);
  }

  get(runId: string): Promise<EvaluationRun> {
    return this.service.get(runId);
  }

  start(runId: string, options?: EvaluationRunExecutionOptions): Promise<EvaluationRun> {
    return this.runner.run(runId, options);
  }

  recover(runId: string): Promise<number> {
    return this.runner.recover(runId);
  }

  cancel(runId: string, expectedVersion: number): Promise<EvaluationRun> {
    return this.service.transition(runId, { expectedVersion, status: 'cancelled' });
  }

  replay(sourceRunId: string, body: unknown): Promise<EvaluationRun> {
    return this.service.replay(sourceRunId, body);
  }

  listCases(snapshot: EvaluationRun['snapshot']): ReturnType<EvaluationCaseCatalog['listCases']> {
    return this.catalog.listCases(snapshot);
  }

  listCaseAttempts(runId: string): Promise<EvaluationCaseAttempt[]> {
    return this.service.listCaseAttempts(runId);
  }

  listSampleAttempts(caseAttemptId: string): Promise<EvaluationSampleAttempt[]> {
    return this.service.listSampleAttempts(caseAttemptId);
  }

  listEvents(runId: string, afterSequence = 0): Promise<EvaluationRunEvent[]> {
    return this.service.listEvents(runId, afterSequence);
  }
}
