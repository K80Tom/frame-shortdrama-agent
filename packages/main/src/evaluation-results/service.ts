import {
  EvaluationError,
  EvaluatorContractError,
  parseEvaluationResult,
  summarizeMetric,
  type EvaluationResult,
  type MetricLayer,
  type MetricObservation,
  type MetricSummary,
  type MissingResultPolicy,
} from '@lyra/shared';
import type { EvaluationResultsRepository } from './repository';

export interface EvaluationResultsServiceOptions { now?: () => Date }

function contractError(error: unknown): never {
  if (error instanceof EvaluatorContractError) {
    throw new EvaluationError(error.status, error.code, error.message, error.details);
  }
  throw error;
}

function notFound(code: string, message: string): never {
  throw new EvaluationError(404, code, message);
}

/**
 * 统一评估结果的业务入口。
 *
 * 只追加、不可覆盖；不创建运行、不触发付费模型。结果由适配器（rule/model/human/hybrid）
 * 在外部构造并经 parseEvaluationResult 闭合校验后传入。
 */
export class EvaluationResultsService {
  private readonly now: () => Date;
  constructor(private readonly repository: EvaluationResultsRepository,
    options: EvaluationResultsServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /** 追加一条已构造好的结果；同一 resultDigest 重放返回既有记录。 */
  async record(body: unknown): Promise<{ result: EvaluationResult; created: boolean }> {
    try {
      const result = parseEvaluationResult(body);
      return this.repository.append(result);
    } catch (error) {
      return contractError(error);
    }
  }

  async getByDigest(digest: string): Promise<EvaluationResult> {
    const result = await this.repository.getByDigest(digest);
    if (!result) notFound('EVALUATION_RESULT_NOT_FOUND', '评估结果不存在。');
    return result;
  }

  async listByRun(runId: string): Promise<EvaluationResult[]> {
    return this.repository.listByRun(runId);
  }

  async listBySubject(kind: string, id: string): Promise<EvaluationResult[]> {
    return this.repository.listBySubject(kind, id);
  }

  async listByEvaluator(evaluatorId: string, version: string): Promise<EvaluationResult[]> {
    return this.repository.listByEvaluator(evaluatorId, version);
  }

  /**
   * 对一组结果按指标 key 做分层聚合。顺序无关；低于 minSampleSize 只能 uncertain。
   * 未知/缺失保留原始状态，不按 0 计入。
   */
  summarize(
    results: readonly EvaluationResult[],
    key: string,
    layer: MetricLayer,
    minSampleSize: number,
    policy: MissingResultPolicy,
  ): MetricSummary {
    const observations: MetricObservation[] = [];
    for (const result of results) {
      const metric = result.metrics.find(item => item.key === key && item.layer === layer);
      observations.push({
        value: metric ? metric.value : null,
        status: metric ? metric.status : result.status,
      });
    }
    return summarizeMetric(key, layer, observations, minSampleSize, policy);
  }
}
