import {
  AgentContractError, type JsonObject, type ToolPermissionLevel, type ToolSensitivity, type ToolVersionRef,
} from './contracts';

/** AgentDefinition / FrozenSnapshot / Run 状态机公共契约。 */

export type AgentStatus = 'draft' | 'frozen' | 'deprecated' | 'disabled';

export interface AgentToolBinding {
  toolId: string;
  /** 精确版本或 ^1.2.3 / ^1 / ^1.2；冻结后扩大范围必须产生新版本。 */
  range: string;
}

export interface AgentLimits {
  maxSteps: number;
  maxChildDepth: number;
  maxConcurrency: number;
  stepTimeoutMs: number;
  runTimeoutMs: number;
  maxToolCalls: number;
  maxTokens: number;
  maxBudgetMicros: number;
  currency: string;
}

/** 生产 Run 只能引用 frozen Definition。 */
export interface AgentDefinition {
  agentId: string;
  version: string;
  displayName: string;
  domain: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  inputSchemaDigest: string;
  outputSchemaDigest: string;
  manifestDigest: string;
  promptRevisionDigest: string;
  /** 方法包 Profile 冻结引用；null 表示不使用项目方法配置。 */
  methodProfileRevisionId: string | null;
  methodProfileDigest: string | null;
  allowedTools: AgentToolBinding[];
  allowedChildAgentIds: string[];
  limits: AgentLimits;
  requiredPermissions: ToolPermissionLevel[];
  sensitivity: { input: ToolSensitivity; output: ToolSensitivity };
  codeDigest: string;
  status: AgentStatus;
  frozenAt?: string;
}

export type AgentRunState =
  | 'created'
  | 'planning'
  | 'awaiting_approval'
  | 'queued'
  | 'running'
  | 'waiting_tool'
  | 'waiting_human'
  | 'waiting_external'
  | 'reconciling'
  | 'interrupted'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'inconclusive';

export interface FrozenAgentSnapshot {
  workspaceId: string;
  projectId: string | null;
  userId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  parentRunId: string | null;
  productionRunId: string | null;
  workflowTaskId: string | null;
  agent: { agentId: string; version: string; manifestDigest: string };
  inputRevisions: Array<{ kind: string; id: string; digest: string }>;
  prompt: { revisionDigest: string };
  /**
   * 方法包冻结引用。`packVersionIds` 使用 `prompt-pack:<packId>@<digest>`，
   * 与 production `run_json.methodPacks[].id/digest` 同一真相源；`skl_*` 版本
   * 只是该来源在 039 的不可变 workspace 快照，不能另建方法中心。
   */
  method: { profileRevisionId: string | null; profileDigest: string | null; packVersionIds: string[] };
  model: { connectionRevision: string; model: string };
  tools: ToolVersionRef[];
  workflow: { version: string; digest: string } | null;
  code: { buildDigest: string };
  budget: { maxMicros: number; currency: string };
  timeout: { stepMs: number; runMs: number };
  maxSteps: number;
  seed: string | null;
  contextSnapshotDigest: string;
  createdAt: string;
}

const PROMPT_PACK_VERSION_REF = /^prompt-pack:[a-z0-9-]{1,80}@[a-f0-9]{64}$/;

/**
 * 方法包冻结引用的唯一格式。`run_json.methodPacks[]` 的 `{id,digest}` 必须经此
 * 生成 Snapshot 的 `method.packVersionIds`，避免出现第二套版本命名。
 */
export function promptPackVersionId(packId: string, digest: string): string {
  if (!/^[a-z0-9-]{1,80}$/.test(packId)) {
    throw new AgentContractError(400, 'AGENT_SNAPSHOT_METHOD_MISMATCH', `方法包 ID 不合法：${packId}。`);
  }
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new AgentContractError(400, 'AGENT_SNAPSHOT_METHOD_MISMATCH', '方法包摘要必须是 64 位十六进制。');
  }
  return `prompt-pack:${packId}@${digest}`;
}

export function isPromptPackVersionId(value: string): boolean {
  return PROMPT_PACK_VERSION_REF.test(value);
}

export interface AgentRunRecord {
  runId: string;
  workspaceId: string;
  state: AgentRunState;
  version: number;
  snapshot: FrozenAgentSnapshot;
  attemptCount: number;
  stepCount: number;
  /** 可公开的执行摘要，不保存模型隐藏推理。 */
  reasonSummary: string;
  terminalErrorCode?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  deadlineAt: string;
  createdAt: string;
  updatedAt: string;
}

export type AgentApprovalKind = 'tool_confirmation' | 'paid_action' | 'plan_review';
export type AgentApprovalState = 'pending' | 'approved' | 'rejected' | 'expired';

export interface AgentApprovalRequest {
  approvalId: string;
  runId: string;
  invocationId: string | null;
  kind: AgentApprovalKind;
  state: AgentApprovalState;
  /** 面向人类的摘要：要执行什么、为什么、预计费用。 */
  summary: string;
  /** 冻结的提案参数摘要；恢复时必须与当前 Invocation 一致。 */
  proposalDigest: string;
  estimateMicros: number;
  currency: string;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
}

export type AgentEvent =
  | { type: 'run_state'; state: AgentRunState; version: number; summary: string }
  | { type: 'step_started'; stepId: string; index: number }
  | { type: 'text'; stepId: string; text: string }
  | { type: 'tool_proposed'; stepId: string; proposalId: string; toolId: string; version: string }
  | { type: 'tool_denied'; stepId: string; proposalId: string; reasonCode: string; summary: string }
  | { type: 'tool_started'; stepId: string; invocationId: string; toolId: string }
  | { type: 'tool_result'; stepId: string; invocationId: string; status: string; summary: string; reasonCode: string }
  | { type: 'approval_required'; stepId: string; approval: AgentApprovalRequest }
  | { type: 'approval_decided'; approvalId: string; state: AgentApprovalState; decidedBy: string }
  | { type: 'budget_reserved'; invocationId: string; amountMicros: number; currency: string }
  | { type: 'budget_settled'; invocationId: string; reservedMicros: number; settledMicros: number }
  | { type: 'completed'; state: 'succeeded' | 'failed' | 'cancelled' | 'inconclusive'; summary: string }
  | { type: 'error'; code: string; summary: string };

export interface AgentStep {
  stepId: string;
  runId: string;
  index: number;
  state: 'running' | 'completed' | 'failed' | 'interrupted';
  /** 可公开的执行摘要与工具调用计数。 */
  summary: string;
  toolCallCount: number;
  startedAt: string;
  endedAt?: string;
}

const ID_PATTERN = /^[a-z][a-z0-9_-]{2,127}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export function assertAgentDefinition(definition: AgentDefinition): void {
  if (!ID_PATTERN.test(definition.agentId)) throw new AgentContractError(500, 'AGENT_DEFINITION_ID_INVALID', 'Agent ID 不合法。');
  if (!VERSION_PATTERN.test(definition.version)) throw new AgentContractError(500, 'AGENT_DEFINITION_VERSION_INVALID', 'Agent 版本必须是 semver。');
  if (!definition.promptRevisionDigest || !definition.codeDigest || !definition.manifestDigest) {
    throw new AgentContractError(500, 'AGENT_DEFINITION_DIGEST_REQUIRED', 'Agent Definition 必须冻结 Prompt、Code 与 manifest digest。');
  }
  const limits = definition.limits;
  if (limits.maxSteps < 1 || limits.maxSteps > 64) throw new AgentContractError(500, 'AGENT_LIMIT_INVALID', 'maxSteps 必须在 1 到 64 之间。');
  if (limits.maxToolCalls < 0 || limits.maxToolCalls > 256) throw new AgentContractError(500, 'AGENT_LIMIT_INVALID', 'maxToolCalls 必须在 0 到 256 之间。');
  if (limits.stepTimeoutMs < 1 || limits.runTimeoutMs < limits.stepTimeoutMs) {
    throw new AgentContractError(500, 'AGENT_LIMIT_INVALID', '运行超时必须不小于单步超时。');
  }
  if (limits.maxBudgetMicros < 0 || !Number.isSafeInteger(limits.maxBudgetMicros)) {
    throw new AgentContractError(500, 'AGENT_LIMIT_INVALID', '预算上限必须是非负安全整数。');
  }
  if (definition.allowedTools.length > 64) throw new AgentContractError(500, 'AGENT_TOOL_ALLOWLIST_TOO_LARGE', '单个 Agent 最多绑定 64 个工具。');
}

/** 终态不可再被普通推进；恢复/重放必须创建新记录。 */
export function isTerminalAgentState(state: AgentRunState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'inconclusive';
}

export function isSuspendedAgentState(state: AgentRunState): boolean {
  return state === 'awaiting_approval' || state === 'waiting_tool' || state === 'waiting_human' || state === 'waiting_external' || state === 'interrupted';
}

export function agentRunCanResume(state: AgentRunState): boolean {
  return state === 'interrupted' || state === 'queued' || state === 'created' || state === 'planning';
}

export const AGENT_TRANSITIONS: Readonly<Record<AgentRunState, readonly AgentRunState[]>> = Object.freeze({
  created: ['planning', 'queued', 'cancelled', 'failed'],
  planning: ['running', 'awaiting_approval', 'queued', 'failed', 'cancelled', 'interrupted'],
  awaiting_approval: ['running', 'queued', 'failed', 'cancelled', 'interrupted'],
  queued: ['running', 'cancelled', 'failed', 'interrupted'],
  running: ['waiting_tool', 'waiting_human', 'waiting_external', 'awaiting_approval', 'succeeded', 'failed', 'cancelled', 'inconclusive', 'interrupted', 'queued'],
  waiting_tool: ['running', 'failed', 'cancelled', 'interrupted'],
  waiting_human: ['running', 'failed', 'cancelled', 'interrupted'],
  waiting_external: ['running', 'reconciling', 'failed', 'cancelled', 'interrupted', 'inconclusive'],
  reconciling: ['running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'inconclusive'],
  interrupted: ['queued', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
  inconclusive: [],
});

export function assertAgentTransition(from: AgentRunState, to: AgentRunState): void {
  if (!AGENT_TRANSITIONS[from].includes(to)) {
    throw new AgentContractError(409, 'AGENT_RUN_TRANSITION_INVALID', `AgentRun 不能从 ${from} 进入 ${to}。`);
  }
}
