// Canary 分流与自动止损（#135 G）。
//
// 分流只在 ProductionRun 创建阶段发生：
//   bucket = sha256(`${algoVersion}|${workspaceId}|${projectId ?? ''}|${routingKey}|${rolloutId}`) 取低 4 位 hex % 10000
//   bucket < trafficPermyriad → candidate，否则 baseline。
// 同一 routing key 在同一 Rollout 内永远落同一版本（EV-22）；算法版本写入
// rollout 配置，可追溯。
//
// 熔断：按时间顺序记录运行结果，连续异常达到阈值即停止向新 Run 分流候选
// （状态 failed，reason 记录），已创建/运行中的 Run 不受影响（EV-23/25/26）。

import { createHash } from 'node:crypto';
import type { EvolutionRollout, EvolutionRolloutConfig, EvolutionRoutingDecision } from '@lyra/shared';
import { EvolutionGateError } from '@lyra/shared';

export const EVOLUTION_HASH_ALGORITHM_VERSION = 'sha256-permyriad-v1';

function permyriadBucket(algorithmVersion: string, workspaceId: string, projectId: string | null,
  routingKey: string, rolloutId: string): number {
  const payload = [algorithmVersion, workspaceId, projectId ?? '', routingKey, rolloutId].join('|');
  const digest = createHash('sha256').update(payload).digest('hex');
  return parseInt(digest.slice(0, 4), 16) % 10000;
}

/** 稳定路由：只依赖配置与标识，不依赖时间与计数。 */
export function routeRun(rollout: Pick<EvolutionRollout, 'rolloutId' | 'workspaceId' | 'projectId' | 'config' | 'status'>,
  projectId: string | null, routingKey: string): EvolutionRoutingDecision {
  if (rollout.status !== 'active') {
    throw new EvolutionGateError(409, 'EVOLUTION_ROLLOUT_NOT_ACTIVE', '灰度分流未在 active 状态，不再分配新运行。');
  }
  const bucket = permyriadBucket(rollout.config.hashAlgorithmVersion, rollout.workspaceId, projectId,
    routingKey, rollout.rolloutId);
  return {
    rolloutId: rollout.rolloutId,
    bucket,
    routedTo: bucket < rollout.config.trafficPermyriad ? 'candidate' : 'baseline',
  };
}

/** 观测账本输入：单次运行观测结果。 */
export interface RolloutObservation {
  anomaly: boolean;
  /** 该 Run 是否被分流到候选版本（用于 candidateCount 统计）。 */
  routedToCandidate?: boolean;
  reason?: string;
}

/**
 * 推进一次观测：计数 +1；连续异常达到阈值时自动止损（status='failed'）。
 * 返回新的 rollout 状态（纯函数，不落库；调用方负责持久化与审计）。
 */
export function observeRolloutRun(rollout: EvolutionRollout, observation: RolloutObservation): EvolutionRollout {
  if (rollout.status !== 'active') {
    throw new EvolutionGateError(409, 'EVOLUTION_ROLLOUT_NOT_ACTIVE', '灰度已停止，不再接受观测。');
  }
  const next: EvolutionRollout = {
    ...rollout,
    sampleCount: rollout.sampleCount + 1,
    candidateCount: rollout.candidateCount + (observation.routedToCandidate ? 1 : 0),
    consecutiveAnomalies: observation.anomaly ? rollout.consecutiveAnomalies + 1 : 0,
    stateVersion: rollout.stateVersion + 1,
    updatedAt: new Date().toISOString(),
  };
  if (observation.anomaly && next.consecutiveAnomalies >= rollout.config.consecutiveAnomalyThreshold) {
    next.status = 'failed';
    next.stoppedReason = observation.reason ?? `连续 ${next.consecutiveAnomalies} 次异常，自动止损`;
  }
  return next;
}

/** 校验 rollout 配置（创建 Canary 时）。 */
export function validateRolloutConfig(config: EvolutionRolloutConfig): void {
  if (!Number.isInteger(config.trafficPermyriad) || config.trafficPermyriad < 0 || config.trafficPermyriad > 10000) {
    throw new EvolutionGateError(422, 'EVOLUTION_ROLLOUT_INVALID', '流量比例必须是 0..10000 的整数万分比。');
  }
  if (typeof config.routingKey !== 'string' || !config.routingKey.trim() || config.routingKey.length > 160) {
    throw new EvolutionGateError(422, 'EVOLUTION_ROLLOUT_INVALID', 'routingKey 必须是 1..160 字符。');
  }
  if (!Number.isInteger(config.consecutiveAnomalyThreshold) || config.consecutiveAnomalyThreshold < 1) {
    throw new EvolutionGateError(422, 'EVOLUTION_ROLLOUT_INVALID', '连续异常阈值必须是不小于 1 的整数。');
  }
  if (!Number.isInteger(config.minRuns) || config.minRuns < 1) {
    throw new EvolutionGateError(422, 'EVOLUTION_ROLLOUT_INVALID', '最小观测运行数必须是不小于 1 的整数。');
  }
}
