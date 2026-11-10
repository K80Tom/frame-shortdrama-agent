// 门禁仲裁（#135 D）：消费 049 评测协议的 EvaluationResult，对基线与候选
// 评分卡做确定性比对。纯函数、零模型调用、零网络。
//
// 规则（ruleVersion 'evolution-core-gate-v1'）：
//   1. 核心质量指标（默认 role_consistency，角色一致性）候选不得劣于基线；
//      指标缺失（value=null）按“未知”处理，直接阻断，绝不按 0 计算。
//   2. 候选评测结果中不允许存在任何 fail（五态语义里的对象失败 = 严重失败）；
//      uncertain / skipped / evaluator_error 视为证据不完整（inconclusive），阻断。
//   3. 基线与候选各自至少有一条有效（pass）结果，否则无法比较，阻断。
//   4. 结论与全部输入摘要一起做确定性 sha256，形成可校验的 decisionDigest。

import { createHash } from 'node:crypto';
import type { EvaluationResultLike, EvolutionGateArbitrationInput, EvolutionGateVerdict } from '@lyra/shared';

export const EVOLUTION_CORE_GATE_RULE_VERSION = 'evolution-core-gate-v1';
/** 核心质量指标 key（角色一致性）。 */
export const CORE_METRIC_KEY = 'role_consistency';
/** 浮点比较容差：候选核心指标不低于基线即视为不劣化。 */
const EPSILON = 1e-9;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * 聚合单个主体的核心指标：优先取 version 层；否则对有值指标求算术平均。
 * 没有任何有效值返回 null（缺失 ≠ 0）。
 */
export function aggregateCoreMetric(
  results: readonly EvaluationResultLike[],
  key: string,
): number | null {
  const versionLayer = results
    .flatMap(result => result.metrics)
    .filter(metric => metric.key === key && metric.layer === 'version' && metric.value !== null);
  if (versionLayer.length > 0) {
    return versionLayer.reduce((sum, metric) => sum + (metric.value as number), 0) / versionLayer.length;
  }
  const anyLayer = results
    .flatMap(result => result.metrics)
    .filter(metric => metric.key === key && metric.value !== null);
  if (anyLayer.length === 0) return null;
  return anyLayer.reduce((sum, metric) => sum + (metric.value as number), 0) / anyLayer.length;
}

/** 汇总单侧结果的健康状态：有效 pass 数、失败、证据不完整分类。 */
export function summarizeResults(results: readonly EvaluationResultLike[]): {
  validPass: number;
  failures: string[];
  inconclusive: string[];
} {
  const failures: string[] = [];
  const inconclusive: string[] = [];
  let validPass = 0;
  for (const result of results) {
    if (result.status === 'pass') validPass += 1;
    else if (result.status === 'fail') failures.push(result.resultId);
    else inconclusive.push(result.resultId);
  }
  return { validPass, failures, inconclusive };
}

/**
 * 仲裁基线 vs 候选。确定性：相同输入永远得到相同 verdict（含相同 decisionDigest）。
 */
export function arbitrateEvolutionGate(input: EvolutionGateArbitrationInput): EvolutionGateVerdict {
  const ruleVersion = input.ruleVersion;
  const coreKey = input.coreMetricKey ?? CORE_METRIC_KEY;
  const reasons: string[] = [];

  const baselineSummary = summarizeResults(input.baselineResults);
  const candidateSummary = summarizeResults(input.candidateResults);

  if (candidateSummary.failures.length > 0) {
    reasons.push(`候选存在严重失败结果：${candidateSummary.failures.join(', ')}`);
  }
  if (candidateSummary.inconclusive.length > 0) {
    reasons.push(`候选证据不完整（uncertain/skipped/evaluator_error）：${candidateSummary.inconclusive.join(', ')}`);
  }
  if (candidateSummary.validPass === 0) {
    reasons.push('候选没有任何有效（pass）评测结果，无法建立评分卡');
  }
  if (baselineSummary.validPass === 0) {
    reasons.push('基线没有任何有效（pass）评测结果，无法比较');
  }

  const baselineCore = baselineSummary.validPass > 0 ? aggregateCoreMetric(input.baselineResults, coreKey) : null;
  const candidateCore = candidateSummary.validPass > 0 ? aggregateCoreMetric(input.candidateResults, coreKey) : null;

  let delta: number | null = null;
  if (baselineCore !== null && candidateCore !== null) {
    delta = candidateCore - baselineCore;
    if (delta < -EPSILON) {
      reasons.push(`核心质量（${coreKey}）劣于基线：baseline=${baselineCore.toFixed(4)} candidate=${candidateCore.toFixed(4)}`);
    }
  } else if (candidateSummary.validPass > 0 && baselineSummary.validPass > 0) {
    reasons.push(`核心质量（${coreKey}）缺失：baseline=${baselineCore === null ? '未知' : '有值'} candidate=${candidateCore === null ? '未知' : '有值'}，未知不按 0 计算`);
  }

  const decision: EvolutionGateVerdict['decision'] = reasons.length === 0 ? 'pass' : 'blocked';
  const baselineResultDigests = input.baselineResults.map(result => result.resultDigest).sort();
  const candidateResultDigests = input.candidateResults.map(result => result.resultDigest).sort();

  const digestPayload = JSON.stringify({
    schemaVersion: 'lyra-evolution-gate/1',
    ruleVersion,
    coreMetricKey: coreKey,
    baselineDigest: input.baselineDigest,
    candidateDigest: input.candidateDigest,
    baselineCore,
    candidateCore,
    decision,
    baselineResultDigests,
    candidateResultDigests,
  });

  return {
    decision,
    ruleVersion,
    coreMetric: { key: coreKey, baseline: baselineCore, candidate: candidateCore, delta },
    reasons,
    baselineResultDigests,
    candidateResultDigests,
    decisionDigest: sha256(digestPayload),
  };
}

/** 仲裁输入（复用契约别名，便于测试与调用方对齐）。 */
export type EvolutionGateInput = EvolutionGateArbitrationInput;

export { sha256 as evolutionGateSha256 };
