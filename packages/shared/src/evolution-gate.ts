// 统一自进化候选门禁闭环（#135）公共契约。
// 范围：Candidate 不可变模型与状态机、049 评测协议的门禁仲裁结论、
// Canary 分流与止损、Promote/Rollback 的 Registry Revision。
// 不包含：EvaluationRun/评分器本体（#134）、Failure Cluster 事实（#133）、
// 资产检索策略算法（#128）。所有摘要都是 sha256 hex（64 位小写）。

export const EVOLUTION_GATE_PROTOCOL_VERSION = 'lyra-evolution-gate/1';

/** V1 允许演进的对象域（与 #135 A1 一致）。 */
export const EVOLUTION_GATE_DOMAINS = Object.freeze([
  'AssetRetrievalPolicy',
  'script-adaptation',
  'character-image',
  'storyboard',
  'video-prompt',
] as const);
export type EvolutionGateDomain = (typeof EVOLUTION_GATE_DOMAINS)[number];

/** 作用域：platform / workspace / project（解析优先级 project > workspace > platform）。 */
export type EvolutionGateScope = 'platform' | 'workspace' | 'project';

/**
 * Candidate 状态机（派单核心闭环；rejected 为非终态旁路，rolled_back 通过
 * 新 Registry Revision 达成）。跳转只能按 EVOLUTION_GATE_TRANSITIONS 声明进行。
 */
export type EvolutionCandidateState =
  | 'proposed'
  | 'evaluating'
  | 'gated'
  | 'approved'
  | 'canary'
  | 'promoted'
  | 'rolled_back'
  | 'rejected'
  | 'paused'
  | 'failed';

export const EVOLUTION_CANDIDATE_STATES: readonly EvolutionCandidateState[] = Object.freeze([
  'proposed', 'evaluating', 'gated', 'approved', 'canary',
  'promoted', 'rolled_back', 'rejected', 'paused', 'failed',
]);

/** 合法状态跳转表；`*` 表示任意来源都允许进入 rejected/failed（审计仍记录 from）。 */
export const EVOLUTION_GATE_TRANSITIONS: Readonly<Record<EvolutionCandidateState, readonly EvolutionCandidateState[]>> = Object.freeze({
  proposed: ['evaluating', 'rejected'],
  evaluating: ['gated', 'rejected'],
  gated: ['approved', 'rejected'],
  approved: ['canary', 'rejected'],
  canary: ['promoted', 'paused', 'failed', 'rolled_back'],
  paused: ['canary', 'promoted', 'rolled_back'],
  failed: ['rolled_back'],
  promoted: ['rolled_back'],
  rolled_back: [],
  rejected: [],
});

export function canTransitionCandidate(from: EvolutionCandidateState, to: EvolutionCandidateState): boolean {
  if (from === to) return false;
  return EVOLUTION_GATE_TRANSITIONS[from].includes(to);
}

/** 终态：不再接受任何跳转。 */
export function isTerminalCandidateState(state: EvolutionCandidateState): boolean {
  return EVOLUTION_GATE_TRANSITIONS[state].length === 0;
}

/** 门禁仲裁结论；blocked 必须给出非空 reasons。 */
export interface EvolutionGateVerdict {
  decision: 'pass' | 'blocked';
  ruleVersion: string;
  /** 核心质量指标（角色一致性）基线/候选对比；缺失时为 null 并阻断。 */
  coreMetric: { key: string; baseline: number | null; candidate: number | null; delta: number | null };
  reasons: string[];
  /** 参与仲裁的结果摘要集合（各自 resultDigest），用于绑定与追溯。 */
  baselineResultDigests: readonly string[];
  candidateResultDigests: readonly string[];
  /** 仲裁结论的确定性摘要（覆盖结论、指标、结果摘要集合与规则版本）。 */
  decisionDigest: string;
}

/** 门禁绑定：Candidate 与评测证据/结论的不可变关联。 */
export interface EvolutionGateBinding {
  bindingId: string;
  workspaceId: string;
  candidateId: string;
  candidateDigest: string;
  baselineDigest: string;
  verdict: EvolutionGateVerdict;
  boundAt: string;
}

/** Canary 分流配置（默认约 5% 新运行；创建后路由配置不可变）。 */
export interface EvolutionRolloutConfig {
  /** 万分比流量（500 = 5%）。 */
  trafficPermyriad: number;
  routingKey: string;
  hashAlgorithmVersion: string;
  /** 熔断前允许的连续异常次数（默认 3）。 */
  consecutiveAnomalyThreshold: number;
  /** Promote 前需要的最小观测运行数。 */
  minRuns: number;
}

export const EVOLUTION_DEFAULT_ROLLOUT: Omit<EvolutionRolloutConfig, 'routingKey'> = Object.freeze({
  trafficPermyriad: 500,
  hashAlgorithmVersion: 'sha256-permyriad-v1',
  consecutiveAnomalyThreshold: 3,
  minRuns: 10,
});

export interface EvolutionRollout {
  rolloutId: string;
  workspaceId: string;
  candidateId: string;
  candidateDigest: string;
  baselineDigest: string;
  domain: EvolutionGateDomain;
  scope: EvolutionGateScope;
  projectId: string | null;
  config: EvolutionRolloutConfig;
  status: 'active' | 'paused' | 'failed' | 'promoted';
  sampleCount: number;
  candidateCount: number;
  consecutiveAnomalies: number;
  stoppedReason: string | null;
  startedAt: string;
  updatedAt: string;
  stateVersion: number;
}

/** 分流结果：同 routing key 在同一 Rollout 内稳定。 */
export interface EvolutionRoutingDecision {
  rolloutId: string;
  bucket: number;
  routedTo: 'candidate' | 'baseline';
}

/** 不可变 Candidate。 */
export interface EvolutionCandidate {
  candidateId: string;
  workspaceId: string;
  domain: EvolutionGateDomain;
  scope: EvolutionGateScope;
  projectId: string | null;
  state: EvolutionCandidateState;
  /** 基线版本与摘要（创建时冻结）。 */
  baselineRevision: string;
  baselineDigest: string;
  /** 候选版本与摘要（创建时冻结）。 */
  candidateRevision: string;
  candidateDigest: string;
  /** 机器可读结构化 Diff（不含密钥/签名 URL/媒体字节/本地绝对路径）。 */
  diff: Readonly<Record<string, { from: unknown; to: unknown }>>;
  /** 人类可读摘要。 */
  summary: string;
  /** 生成方式与生成器版本。 */
  generatedBy: 'human' | 'rule' | 'model';
  generatorVersion: string;
  /** Token/金额硬上限（冻结）。 */
  tokenLimit: number;
  costLimitMinor: number;
  currency: string;
  /** 同一 Proposal 的去重键（proposal 为空时用 domain+scope+baseline）。 */
  proposalKey: string;
  maxCandidatesPerProposal: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** 状态 CAS 版本；变更接口必须携带 expectedVersion。 */
  stateVersion: number;
  /** 当前状态的确定性摘要（含 payload digest 与版本）。 */
  stateDigest: string;
}

/** append-only 审计事件。 */
export interface EvolutionAuditEvent {
  eventId: string;
  workspaceId: string;
  candidateId: string | null;
  rolloutId: string | null;
  actorType: 'user' | 'system';
  actorId: string;
  action: string;
  reason: string | null;
  fromState: EvolutionCandidateState | null;
  toState: EvolutionCandidateState | null;
  details: Readonly<Record<string, unknown>>;
  occurredAt: string;
}

/** 服务层错误；HTTP 语义与 #135 H 对齐。 */
export class EvolutionGateError extends Error {
  constructor(readonly status: 403 | 404 | 409 | 422, readonly code: string, message: string) {
    super(message);
    this.name = 'EvolutionGateError';
  }
}

/** 仲裁输入：基线与候选各自的评测结果（来自 049 evaluation_results）。 */
export interface EvolutionGateArbitrationInput {
  ruleVersion: string;
  baselineDigest: string;
  candidateDigest: string;
  baselineResults: readonly EvaluationResultLike[];
  candidateResults: readonly EvaluationResultLike[];
  /** 核心质量指标 key；默认角色一致性。 */
  coreMetricKey?: string;
}

/** 与 @lyra/shared EvaluationResult 结构兼容的最小投影（避免 main 测试强依赖完整解析）。 */
export interface EvaluationResultLike {
  resultId: string;
  resultDigest: string;
  subject: { kind: string; id: string; revisionId: string | null; digest: string };
  status: 'pass' | 'fail' | 'uncertain' | 'skipped' | 'evaluator_error';
  metrics: readonly { key: string; layer: string; value: number | null; status: string }[];
}
