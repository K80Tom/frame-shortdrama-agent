// 候选门禁闭环服务（#135）：状态机、不可变 Candidate、049 门禁绑定、
// 审批、Canary 启停与自动止损、Promote/Rollback（新 Registry Revision）、append-only 审计。
//
// 并发语义：所有状态变化都必须携带 expectedVersion（CAS）；陈旧操作返回 409，
// 绝不静默覆盖（EV-30）。失败重试不得跳过中间 Gate 与审批状态。

import type {
  EvolutionAuditEvent, EvolutionCandidate, EvolutionCandidateState, EvolutionGateBinding,
  EvolutionGateDomain, EvolutionGateScope, EvolutionGateVerdict, EvolutionRollout,
  EvolutionRolloutConfig, EvolutionRoutingDecision, EvaluationResultLike,
} from '@lyra/shared';
import { EvolutionGateError, EVOLUTION_DEFAULT_ROLLOUT, EVOLUTION_GATE_TRANSITIONS, canTransitionCandidate } from '@lyra/shared';
import { arbitrateEvolutionGate, evolutionGateSha256, EVOLUTION_CORE_GATE_RULE_VERSION } from './gate-arbiter';
import { EVOLUTION_HASH_ALGORITHM_VERSION, observeRolloutRun, routeRun, validateRolloutConfig } from './gate-canary';
import type { EvolutionGateRepository, EvolutionRegistryRevision } from './gate-repository';
import { randomEvolutionId } from './gate-repository';

const HEX64 = /^[0-9a-f]{64}$/;
/** 候选正文与审计中禁止出现的敏感模式（EV-32：密钥/Bearer/私有地址/本地绝对路径）。 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/,
  /Bearer\s+[A-Za-z0-9._-]{8,}/i,
  /(?:ghp|github_pat)_[A-Za-z0-9_]{10,}/,
  /\/Users\/[A-Za-z0-9._-]+/,
  /\/home\/[A-Za-z0-9._-]+/,
  /[A-Za-z]:\\\\(?:Users|Windows)/,
];

export interface CreateCandidateInput {
  domain: EvolutionGateDomain;
  scope: EvolutionGateScope;
  projectId?: string | null;
  baselineRevision: string;
  baselineDigest: string;
  candidateRevision: string;
  diff: Record<string, { from: unknown; to: unknown }>;
  summary: string;
  generatedBy: 'human' | 'rule' | 'model';
  generatorVersion: string;
  tokenLimit: number;
  costLimitMinor: number;
  currency?: string;
  proposalKey?: string;
  maxCandidatesPerProposal?: number;
  createdBy: string;
}

export interface EvolveInput {
  expectedVersion: number;
  actorId: string;
  reason?: string;
}

export interface BindGateInput extends EvolveInput {
  baselineResults: readonly EvaluationResultLike[];
  candidateResults: readonly EvaluationResultLike[];
  coreMetricKey?: string;
  ruleVersion?: string;
}

export interface StartCanaryInput extends EvolveInput {
  config?: Partial<Omit<EvolutionRolloutConfig, 'routingKey'>>;
  routingKey?: string;
}

export interface ObserveInput {
  expectedVersion: number;
  anomaly: boolean;
  routedToCandidate?: boolean;
  reason?: string;
}

export class EvolutionGateService {
  constructor(private readonly repository: EvolutionGateRepository, private readonly now: () => Date = () => new Date()) {}

  // ---------- 创建（不可变 Candidate） ----------

  async createCandidate(workspaceId: string, input: CreateCandidateInput): Promise<EvolutionCandidate> {
    if (input.scope === 'project' && !input.projectId) {
      throw new EvolutionGateError(422, 'EVOLUTION_SCOPE_INVALID', 'project 作用域必须提供 projectId。');
    }
    if (input.scope !== 'project' && input.projectId) {
      throw new EvolutionGateError(422, 'EVOLUTION_SCOPE_INVALID', 'platform/workspace 作用域不允许携带 projectId。');
    }
    if (!HEX64.test(input.baselineDigest) || !input.baselineRevision.trim()) {
      throw new EvolutionGateError(422, 'EVOLUTION_CANDIDATE_INVALID', '基线版本与摘要必须有效（digest 为 sha256 hex）。');
    }
    if (!input.candidateRevision.trim()) {
      throw new EvolutionGateError(422, 'EVOLUTION_CANDIDATE_INVALID', '候选版本必须有效。');
    }
    if (!input.summary.trim() || input.summary.length > 500) {
      throw new EvolutionGateError(422, 'EVOLUTION_CANDIDATE_INVALID', '候选必须提供 1..500 字符的人类可读摘要。');
    }
    if (!Number.isInteger(input.tokenLimit) || input.tokenLimit <= 0
      || !Number.isInteger(input.costLimitMinor) || input.costLimitMinor < 0) {
      throw new EvolutionGateError(422, 'EVOLUTION_BUDGET_INVALID', 'Token/金额硬上限必须为正整数（金额可为 0）。');
    }
    const maxCandidates = input.maxCandidatesPerProposal ?? 2;
    if (maxCandidates < 1 || maxCandidates > 2) {
      throw new EvolutionGateError(422, 'EVOLUTION_BUDGET_INVALID', '每个 Proposal 最多允许 2 个 Candidate。');
    }
    this.assertDiffSafe(input.diff);

    const proposalKey = input.proposalKey ?? `${input.domain}|${input.scope}|${input.projectId ?? ''}|${input.baselineDigest}`;
    const existing = await this.repository.countCandidatesByProposal(workspaceId, proposalKey);
    if (existing >= maxCandidates) {
      throw new EvolutionGateError(422, 'EVOLUTION_CANDIDATE_QUOTA', `该 Proposal 的 Candidate 数已达上限（${maxCandidates}）。`);
    }

    const timestamp = this.now().toISOString();
    const candidateDigestPayload = JSON.stringify({
      schemaVersion: 'lyra-evolution-gate/1',
      domain: input.domain,
      scope: input.scope,
      projectId: input.projectId ?? null,
      baselineRevision: input.baselineRevision,
      baselineDigest: input.baselineDigest,
      candidateRevision: input.candidateRevision,
      diff: input.diff,
      summary: input.summary,
      generatedBy: input.generatedBy,
      generatorVersion: input.generatorVersion,
      tokenLimit: input.tokenLimit,
      costLimitMinor: input.costLimitMinor,
      currency: input.currency ?? 'CNY',
    });
    const candidate: EvolutionCandidate = {
      candidateId: randomEvolutionId('evocand'),
      workspaceId,
      domain: input.domain,
      scope: input.scope,
      projectId: input.projectId ?? null,
      state: 'proposed',
      baselineRevision: input.baselineRevision,
      baselineDigest: input.baselineDigest,
      candidateRevision: input.candidateRevision,
      candidateDigest: evolutionGateSha256(candidateDigestPayload),
      diff: input.diff,
      summary: input.summary.trim(),
      generatedBy: input.generatedBy,
      generatorVersion: input.generatorVersion,
      tokenLimit: input.tokenLimit,
      costLimitMinor: input.costLimitMinor,
      currency: input.currency ?? 'CNY',
      proposalKey,
      maxCandidatesPerProposal: maxCandidates,
      createdBy: input.createdBy,
      createdAt: timestamp,
      updatedAt: timestamp,
      stateVersion: 1,
      stateDigest: '',
    };
    candidate.stateDigest = this.stateDigest(candidate);
    await this.repository.insertCandidate(candidate);
    await this.audit(workspaceId, {
      candidateId: candidate.candidateId,
      rolloutId: null,
      actorType: 'user',
      actorId: input.createdBy,
      action: 'candidate.created',
      reason: input.summary.trim(),
      fromState: null,
      toState: 'proposed',
      details: { candidateDigest: candidate.candidateDigest, baselineDigest: candidate.baselineDigest, proposalKey },
    });
    return candidate;
  }

  // ---------- 状态机（CAS） ----------

  async startEvaluation(workspaceId: string, candidateId: string, input: EvolveInput): Promise<EvolutionCandidate> {
    return this.transition(workspaceId, candidateId, input, 'evaluating', 'evaluation.started');
  }

  /**
   * 绑定 049 评测结论并做门禁仲裁：decision=pass 才允许进入 gated；
   * blocked 保留绑定作为历史，但状态留在 evaluating（可补充证据重评）。
   */
  async bindGate(workspaceId: string, candidateId: string, input: BindGateInput):
    Promise<{ candidate: EvolutionCandidate; binding: EvolutionGateBinding }> {
    const candidate = await this.loadCandidate(workspaceId, candidateId);
    this.assertFresh(candidate, input.expectedVersion);
    const verdict = arbitrateEvolutionGate({
      ruleVersion: input.ruleVersion ?? EVOLUTION_CORE_GATE_RULE_VERSION,
      baselineDigest: candidate.baselineDigest,
      candidateDigest: candidate.candidateDigest,
      baselineResults: input.baselineResults,
      candidateResults: input.candidateResults,
      coreMetricKey: input.coreMetricKey,
    });
    const binding: EvolutionGateBinding = {
      bindingId: randomEvolutionId('evobind'),
      workspaceId,
      candidateId,
      candidateDigest: candidate.candidateDigest,
      baselineDigest: candidate.baselineDigest,
      verdict,
      boundAt: this.now().toISOString(),
    };
    await this.repository.insertBinding(binding);
    await this.audit(workspaceId, {
      candidateId,
      rolloutId: null,
      actorType: 'user',
      actorId: input.actorId,
      action: 'gate.bound',
      reason: verdict.decision === 'pass' ? '门禁通过' : verdict.reasons.join('; ').slice(0, 500),
      fromState: candidate.state,
      toState: candidate.state,
      details: { decision: verdict.decision, decisionDigest: verdict.decisionDigest, ruleVersion: verdict.ruleVersion },
    });
    if (verdict.decision !== 'pass') {
      return { candidate, binding };
    }
    // gated 状态重绑 pass：幂等刷新门禁证据（不重复跳转、不动 stateVersion）。
    if (candidate.state === 'gated') {
      await this.audit(workspaceId, {
        candidateId,
        rolloutId: null,
        actorType: 'user',
        actorId: input.actorId,
        action: 'gate.passed',
        reason: '门禁通过（重绑刷新证据）',
        fromState: 'gated',
        toState: 'gated',
        details: { decisionDigest: verdict.decisionDigest },
      });
      return { candidate, binding };
    }
    const updated = await this.applyTransition(workspaceId, candidate, input.expectedVersion, 'gated',
      'gate.passed', input.actorId, { decisionDigest: verdict.decisionDigest });
    return { candidate: updated, binding };
  }

  async approve(workspaceId: string, candidateId: string, input: EvolveInput): Promise<EvolutionCandidate> {
    if (!input.reason || !input.reason.trim()) {
      throw new EvolutionGateError(422, 'EVOLUTION_REASON_REQUIRED', '批准必须提供非空人工理由。');
    }
    const candidate = await this.loadCandidate(workspaceId, candidateId);
    this.assertFresh(candidate, input.expectedVersion);
    // 状态机守卫优先于门禁证据检查：proposed 不能越过 evaluating/gated/approval 语义。
    if (!canTransitionCandidate(candidate.state, 'approved')) {
      throw new EvolutionGateError(422, 'EVOLUTION_TRANSITION_INVALID',
        `当前状态 ${candidate.state} 不允许直接批准。`);
    }
    const binding = await this.repository.getLatestBinding(workspaceId, candidateId);
    if (!binding || binding.verdict.decision !== 'pass') {
      throw new EvolutionGateError(422, 'EVOLUTION_GATE_NOT_PASSED', '没有有效的 pass 门禁结论，禁止批准（completed/review/error/inconclusive 均不可）。');
    }
    if (binding.candidateDigest !== candidate.candidateDigest || binding.baselineDigest !== candidate.baselineDigest) {
      throw new EvolutionGateError(422, 'EVOLUTION_GATE_STALE', '门禁绑定与当前 Candidate/Baseline 摘要不一致，必须重新评测。');
    }
    return this.applyTransition(workspaceId, candidate, input.expectedVersion, 'approved',
      'candidate.approved', input.actorId, { bindingId: binding.bindingId, approver: input.actorId });
  }

  async reject(workspaceId: string, candidateId: string, input: EvolveInput): Promise<EvolutionCandidate> {
    if (!input.reason || !input.reason.trim()) {
      throw new EvolutionGateError(422, 'EVOLUTION_REASON_REQUIRED', '拒绝必须提供非空人工理由。');
    }
    return this.transition(workspaceId, candidateId, input, 'rejected', 'candidate.rejected');
  }

  // ---------- Canary ----------

  async startCanary(workspaceId: string, candidateId: string, input: StartCanaryInput):
    Promise<{ candidate: EvolutionCandidate; rollout: EvolutionRollout }> {
    const candidate = await this.loadCandidate(workspaceId, candidateId);
    this.assertFresh(candidate, input.expectedVersion);
    const config: EvolutionRolloutConfig = {
      ...EVOLUTION_DEFAULT_ROLLOUT,
      ...input.config,
      routingKey: input.routingKey ?? `candidate:${candidate.candidateId}`,
      hashAlgorithmVersion: EVOLUTION_HASH_ALGORITHM_VERSION,
    };
    validateRolloutConfig(config);
    const updated = await this.applyTransition(workspaceId, candidate, input.expectedVersion, 'canary',
      'canary.started', input.actorId, { trafficPermyriad: config.trafficPermyriad });
    const timestamp = this.now().toISOString();
    const rollout: EvolutionRollout = {
      rolloutId: randomEvolutionId('evoroll'),
      workspaceId,
      candidateId,
      candidateDigest: candidate.candidateDigest,
      baselineDigest: candidate.baselineDigest,
      domain: candidate.domain,
      scope: candidate.scope,
      projectId: candidate.projectId,
      config,
      status: 'active',
      sampleCount: 0,
      candidateCount: 0,
      consecutiveAnomalies: 0,
      stoppedReason: null,
      startedAt: timestamp,
      updatedAt: timestamp,
      stateVersion: 1,
    };
    await this.repository.insertRollout(rollout);
    await this.audit(workspaceId, {
      candidateId,
      rolloutId: rollout.rolloutId,
      actorType: 'user',
      actorId: input.actorId,
      action: 'canary.started',
      reason: input.reason?.trim() ?? null,
      fromState: 'approved',
      toState: 'canary',
      details: { trafficPermyriad: config.trafficPermyriad, hashAlgorithmVersion: config.hashAlgorithmVersion },
    });
    return { candidate: updated, rollout };
  }

  /** 稳定路由（只读）：分流只发生在 ProductionRun 创建阶段。 */
  async route(workspaceId: string, rolloutId: string, routingKey: string): Promise<EvolutionRoutingDecision> {
    const rollout = await this.loadRollout(workspaceId, rolloutId);
    return routeRun(rollout, rollout.projectId, routingKey);
  }

  async observe(workspaceId: string, rolloutId: string, input: ObserveInput):
    Promise<{ rollout: EvolutionRollout; candidate: EvolutionCandidate | null }> {
    const rollout = await this.loadRollout(workspaceId, rolloutId);
    if (rollout.stateVersion !== input.expectedVersion) {
      throw new EvolutionGateError(409, 'EVOLUTION_STALE_STATE', '灰度状态已变化（CAS），请刷新后重试。');
    }
    const next = observeRolloutRun(rollout, { anomaly: input.anomaly, routedToCandidate: input.routedToCandidate, reason: input.reason });
    const ok = await this.repository.updateRollout(workspaceId, rolloutId, input.expectedVersion, next);
    if (!ok) throw new EvolutionGateError(409, 'EVOLUTION_STALE_STATE', '灰度状态已变化（CAS），请刷新后重试。');

    let candidate: EvolutionCandidate | null = null;
    if (next.status === 'failed') {
      // 自动止损：候选从 canary 进入 failed，不再给新 Run 分流（EV-25）。
      const current = await this.loadCandidate(workspaceId, rollout.candidateId);
      if (current.state === 'canary') {
        candidate = await this.applyTransition(workspaceId, current, current.stateVersion, 'failed',
          'canary.auto_stopped', 'system', { rolloutId, stoppedReason: next.stoppedReason ?? 'auto' });
      }
      await this.audit(workspaceId, {
        candidateId: rollout.candidateId,
        rolloutId,
        actorType: 'system',
        actorId: 'system',
        action: 'canary.auto_stopped',
        reason: next.stoppedReason,
        fromState: 'canary',
        toState: 'failed',
        details: { consecutiveAnomalies: next.consecutiveAnomalies },
      });
    }
    return { rollout: next, candidate };
  }

  async stopCanary(workspaceId: string, rolloutId: string, input: EvolveInput & { rolloutExpectedVersion: number }):
    Promise<{ rollout: EvolutionRollout; candidate: EvolutionCandidate | null }> {
    if (!input.reason || !input.reason.trim()) {
      throw new EvolutionGateError(422, 'EVOLUTION_REASON_REQUIRED', '人工停止必须提供非空理由。');
    }
    const rollout = await this.loadRollout(workspaceId, rolloutId);
    if (rollout.status !== 'active') {
      throw new EvolutionGateError(409, 'EVOLUTION_ROLLOUT_NOT_ACTIVE', '灰度不在 active 状态。');
    }
    if (rollout.stateVersion !== input.rolloutExpectedVersion) {
      throw new EvolutionGateError(409, 'EVOLUTION_STALE_STATE', '灰度状态已变化（CAS），请刷新后重试。');
    }
    const next: EvolutionRollout = { ...rollout, status: 'paused', stoppedReason: input.reason.trim(),
      stateVersion: rollout.stateVersion + 1, updatedAt: this.now().toISOString() };
    const ok = await this.repository.updateRollout(workspaceId, rolloutId, input.rolloutExpectedVersion, next);
    if (!ok) throw new EvolutionGateError(409, 'EVOLUTION_STALE_STATE', '灰度状态已变化（CAS），请刷新后重试。');

    const current = await this.loadCandidate(workspaceId, rollout.candidateId);
    let candidate: EvolutionCandidate | null = null;
    if (current.state === 'canary') {
      candidate = await this.applyTransition(workspaceId, current, current.stateVersion, 'paused',
        'canary.stopped', input.actorId, { rolloutId });
    }
    await this.audit(workspaceId, {
      candidateId: rollout.candidateId,
      rolloutId,
      actorType: 'user',
      actorId: input.actorId,
      action: 'canary.stopped',
      reason: input.reason.trim(),
      fromState: 'canary',
      toState: 'paused',
      details: { rolloutId },
    });
    return { rollout: next, candidate };
  }

  // ---------- Promote / Rollback ----------

  async promote(workspaceId: string, rolloutId: string, input: EvolveInput & { rolloutExpectedVersion: number }):
    Promise<{ candidate: EvolutionCandidate; revision: EvolutionRegistryRevision }> {
    if (!input.reason || !input.reason.trim()) {
      throw new EvolutionGateError(422, 'EVOLUTION_REASON_REQUIRED', 'Promote 必须提供非空人工理由。');
    }
    const rollout = await this.loadRollout(workspaceId, rolloutId);
    if (rollout.stateVersion !== input.rolloutExpectedVersion) {
      throw new EvolutionGateError(409, 'EVOLUTION_STALE_STATE', '灰度状态已变化（CAS），请刷新后重试。');
    }
    if (rollout.status !== 'active' && rollout.status !== 'paused') {
      throw new EvolutionGateError(422, 'EVOLUTION_PROMOTE_INVALID', `灰度状态为 ${rollout.status}，不允许 Promote。`);
    }
    if (rollout.sampleCount < rollout.config.minRuns) {
      throw new EvolutionGateError(422, 'EVOLUTION_PROMOTE_INVALID',
        `未达到最小观测样本量：${rollout.sampleCount}/${rollout.config.minRuns}。`);
    }
    const candidate = await this.loadCandidate(workspaceId, rollout.candidateId);
    if (candidate.state !== 'canary' && candidate.state !== 'paused') {
      throw new EvolutionGateError(422, 'EVOLUTION_PROMOTE_INVALID', `候选状态为 ${candidate.state}，不允许 Promote。`);
    }
    const candidateUpdated = await this.applyTransition(workspaceId, candidate, candidate.stateVersion, 'promoted',
      'candidate.promoted', input.actorId, { rolloutId });
    const revision = await this.appendRevision(workspaceId, {
      domain: rollout.domain, scope: rollout.scope, projectId: rollout.projectId,
      action: 'promote', candidateId: candidate.candidateId, candidateDigest: candidate.candidateDigest,
      activeDigest: candidate.candidateDigest, activeRevision: candidate.candidateRevision,
      previousDigest: rollout.baselineDigest, reason: input.reason.trim(), actor: input.actorId, rolloutId,
    });
    const rolloutNext: EvolutionRollout = { ...rollout, status: 'promoted',
      stateVersion: rollout.stateVersion + 1, updatedAt: this.now().toISOString() };
    await this.repository.updateRollout(workspaceId, rolloutId, rollout.stateVersion, rolloutNext);
    await this.audit(workspaceId, {
      candidateId: candidate.candidateId,
      rolloutId,
      actorType: 'user',
      actorId: input.actorId,
      action: 'candidate.promoted',
      reason: input.reason.trim(),
      fromState: candidate.state,
      toState: 'promoted',
      details: { revision: revision.revision, activeDigest: revision.activeDigest },
    });
    return { candidate: candidateUpdated, revision };
  }

  /** 回滚：追加一个指向已知安全版本（基线）的新 Registry Revision；历史全部保留（EV-28）。 */
  async rollback(workspaceId: string, candidateId: string, input: EvolveInput):
    Promise<{ candidate: EvolutionCandidate; revision: EvolutionRegistryRevision }> {
    if (!input.reason || !input.reason.trim()) {
      throw new EvolutionGateError(422, 'EVOLUTION_REASON_REQUIRED', '回滚必须提供非空人工理由。');
    }
    const candidate = await this.loadCandidate(workspaceId, candidateId);
    this.assertFresh(candidate, input.expectedVersion);
    if (!['canary', 'paused', 'failed', 'promoted'].includes(candidate.state)) {
      throw new EvolutionGateError(422, 'EVOLUTION_ROLLBACK_INVALID', `候选状态为 ${candidate.state}，不允许回滚。`);
    }
    const candidateUpdated = await this.applyTransition(workspaceId, candidate, input.expectedVersion, 'rolled_back',
      'candidate.rolled_back', input.actorId, { restoredDigest: candidate.baselineDigest });
    const revision = await this.appendRevision(workspaceId, {
      domain: candidate.domain, scope: candidate.scope, projectId: candidate.projectId,
      action: 'rollback', candidateId: null, candidateDigest: null,
      activeDigest: candidate.baselineDigest, activeRevision: candidate.baselineRevision,
      previousDigest: candidate.candidateDigest, reason: input.reason.trim(), actor: input.actorId, rolloutId: null,
    });
    await this.audit(workspaceId, {
      candidateId,
      rolloutId: null,
      actorType: 'user',
      actorId: input.actorId,
      action: 'candidate.rolled_back',
      reason: input.reason.trim(),
      fromState: candidate.state,
      toState: 'rolled_back',
      details: { revision: revision.revision, restoredDigest: revision.activeDigest },
    });
    return { candidate: candidateUpdated, revision };
  }

  async history(workspaceId: string, candidateId: string): Promise<EvolutionAuditEvent[]> {
    return this.repository.listAudit(workspaceId, candidateId);
  }

  // ---------- 内部 ----------

  private stateDigest(candidate: EvolutionCandidate): string {
    return evolutionGateSha256(JSON.stringify({
      candidateDigest: candidate.candidateDigest, state: candidate.state, stateVersion: candidate.stateVersion,
    }));
  }

  private async loadCandidate(workspaceId: string, candidateId: string): Promise<EvolutionCandidate> {
    const candidate = await this.repository.getCandidate(workspaceId, candidateId);
    if (!candidate) throw new EvolutionGateError(404, 'EVOLUTION_CANDIDATE_NOT_FOUND', '候选不存在或不属于当前工作区。');
    return candidate;
  }

  private async loadRollout(workspaceId: string, rolloutId: string): Promise<EvolutionRollout> {
    const rollout = await this.repository.getRollout(workspaceId, rolloutId);
    if (!rollout) throw new EvolutionGateError(404, 'EVOLUTION_ROLLOUT_NOT_FOUND', '灰度不存在或不属于当前工作区。');
    return rollout;
  }

  private assertFresh(candidate: EvolutionCandidate, expectedVersion: number): void {
    if (candidate.stateVersion !== expectedVersion) {
      throw new EvolutionGateError(409, 'EVOLUTION_STALE_STATE', '候选状态已变化（CAS），请刷新后重试。');
    }
  }

  private async transition(workspaceId: string, candidateId: string, input: EvolveInput,
    to: EvolutionCandidateState, action: string): Promise<EvolutionCandidate> {
    const candidate = await this.loadCandidate(workspaceId, candidateId);
    this.assertFresh(candidate, input.expectedVersion);
    return this.applyTransition(workspaceId, candidate, input.expectedVersion, to, action, input.actorId, {});
  }

  private async applyTransition(workspaceId: string, candidate: EvolutionCandidate, expectedVersion: number,
    to: EvolutionCandidateState, action: string, actorId: string,
    details: Record<string, unknown>): Promise<EvolutionCandidate> {
    const allowed = EVOLUTION_GATE_TRANSITIONS[candidate.state];
    if (!allowed.includes(to)) {
      throw new EvolutionGateError(422, 'EVOLUTION_TRANSITION_INVALID',
        `不允许的状态跳转：${candidate.state} → ${to}（允许：${allowed.join(', ') || '无'}）。`);
    }
    if (candidate.stateVersion !== expectedVersion) {
      throw new EvolutionGateError(409, 'EVOLUTION_STALE_STATE', '候选状态已变化（CAS），请刷新后重试。');
    }
    const next: EvolutionCandidate = {
      ...candidate,
      state: to,
      stateVersion: candidate.stateVersion + 1,
      updatedAt: this.now().toISOString(),
    };
    next.stateDigest = this.stateDigest(next);
    const ok = await this.repository.updateCandidateState(workspaceId, candidate.candidateId, expectedVersion, next);
    if (!ok) throw new EvolutionGateError(409, 'EVOLUTION_STALE_STATE', '候选状态已变化（CAS），请刷新后重试。');
    await this.audit(workspaceId, {
      candidateId: candidate.candidateId,
      rolloutId: (details.rolloutId as string | undefined) ?? null,
      actorType: actorId === 'system' ? 'system' : 'user',
      actorId,
      action,
      reason: null,
      fromState: candidate.state,
      toState: to,
      details,
    });
    return next;
  }

  private async appendRevision(workspaceId: string, input: Omit<EvolutionRegistryRevision,
    'id' | 'workspaceId' | 'revision' | 'createdAt'>): Promise<EvolutionRegistryRevision> {
    const existing = await this.repository.listRegistryRevisions(workspaceId, input.domain);
    const nextRevision = existing.reduce((max, revision) => Math.max(max, revision.revision), 0) + 1;
    const revision: EvolutionRegistryRevision = {
      id: randomEvolutionId('evorev'),
      workspaceId,
      revision: nextRevision,
      createdAt: this.now().toISOString(),
      ...input,
    };
    const ok = await this.repository.insertRegistryRevision(revision);
    if (!ok) throw new EvolutionGateError(409, 'EVOLUTION_REVISION_CONFLICT', 'Registry Revision 并发冲突，请重试。');
    return revision;
  }

  private assertDiffSafe(diff: Record<string, { from: unknown; to: unknown }>): void {
    for (const [key, change] of Object.entries(diff)) {
      if (!/^[a-z][a-zA-Z0-9_.]{0,63}$/.test(key)) {
        throw new EvolutionGateError(422, 'EVOLUTION_DIFF_FIELD_INVALID', `Diff 字段名不允许：${key}`);
      }
      const serialized = JSON.stringify(change);
      for (const pattern of SENSITIVE_PATTERNS) {
        if (pattern.test(serialized)) {
          throw new EvolutionGateError(422, 'EVOLUTION_DIFF_UNSAFE', `Diff 包含疑似敏感内容（字段 ${key}），拒绝创建。`);
        }
      }
    }
  }

  private async audit(workspaceId: string, event: Omit<EvolutionAuditEvent, 'eventId' | 'workspaceId' | 'occurredAt'>):
    Promise<void> {
    await this.repository.appendAudit({
      eventId: randomEvolutionId('evoaud'),
      workspaceId,
      occurredAt: this.now().toISOString(),
      ...event,
    });
  }
}
