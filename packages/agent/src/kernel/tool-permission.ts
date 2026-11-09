import {
  AgentContractError, type ToolDefinition, type ToolPermissionDecision, type ToolPermissionLevel,
  type ToolPermissionVerdict, type ToolSideEffect,
} from '@lyra/shared';
import { roleSatisfies } from './tool-registry';

/**
 * 工具权限校验。
 *
 * 只有三档对 Agent 可见的结论：
 * - read_only：只读、无副作用，可直接执行；
 * - confirmation_required：写入/外部/付费动作，必须人工确认（Run 进入 awaiting_approval）；
 * - forbidden：越权、Workflow-only、运行时内部能力或敏感输出，直接拒绝。
 *
 * 付费与外部写入没有 “full access” 旁路：即使 Run 声明完全访问，也只能被拒绝，
 * 不能把确认责任从人身上拿走。
 */

export type ToolAccessMode = 'default' | 'read_only_only' | 'confirm_all';

export interface ToolPermissionRequest {
  definition: ToolDefinition;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  grantedPermissions: ToolPermissionLevel[];
  /** 当前 Run 是否绑定了该 Workflow 及其阶段。 */
  workflow: { workflowId: string; stage: string; approvedPaidMicros: number } | null;
  mode: ToolAccessMode;
  budgetRemainingMicros?: number;
  /** 用户已经明确批准这一次 Invocation（恢复场景）。 */
  approvedInvocation?: boolean;
}

export function toolAccessTier(effect: ToolSideEffect): 'read_only' | 'confirmation_required' | 'forbidden' {
  if (effect === 'none') return 'read_only';
  if (effect === 'internal_write' || effect === 'external_write' || effect === 'paid_external') return 'confirmation_required';
  return 'forbidden';
}

export function decideToolPermission(request: ToolPermissionRequest): ToolPermissionVerdict {
  const { definition } = request;
  const base = { sideEffect: definition.sideEffect } as const;

  if (definition.status !== 'frozen') {
    return { ...base, decision: 'deny', reasonCode: 'AGENT_TOOL_NOT_FROZEN', rule: 'status:frozen' };
  }
  if (definition.executionOwner === 'runtime_internal') {
    return { ...base, decision: 'deny', reasonCode: 'AGENT_TOOL_RUNTIME_INTERNAL', rule: 'owner:runtime_internal' };
  }
  if (definition.executionOwner === 'workflow_only') {
    const workflow = request.workflow;
    if (!workflow) return { ...base, decision: 'deny', reasonCode: 'AGENT_TOOL_WORKFLOW_ONLY', rule: 'owner:workflow_only' };
    if (!definition.allowedWorkflowIds.includes(workflow.workflowId)) {
      return { ...base, decision: 'deny', reasonCode: 'AGENT_TOOL_WORKFLOW_NOT_ALLOWED', rule: 'workflow:not_allowed' };
    }
  }
  if (!roleSatisfies(request.role, definition.requiredPermission)) {
    return { ...base, decision: 'deny', reasonCode: 'AGENT_TOOL_PERMISSION_REQUIRED', rule: 'rbac:role' };
  }
  const grants = new Set(request.grantedPermissions);
  if (!grants.has(definition.requiredPermission)) {
    return { ...base, decision: 'deny', reasonCode: 'AGENT_TOOL_PERMISSION_REQUIRED', rule: 'rbac:grant' };
  }
  if (definition.sensitivity.output === 'restricted' && request.role !== 'owner' && request.role !== 'admin') {
    return { ...base, decision: 'deny', reasonCode: 'AGENT_TOOL_SENSITIVE_OUTPUT', rule: 'sensitivity:restricted' };
  }
  if (request.mode === 'read_only_only' && definition.sideEffect !== 'none') {
    return { ...base, decision: 'deny', reasonCode: 'AGENT_TOOL_READ_ONLY_MODE', rule: 'mode:read_only_only' };
  }

  if (definition.sideEffect === 'paid_external') {
    if (!definition.cost) {
      return { ...base, decision: 'deny', reasonCode: 'AGENT_TOOL_COST_POLICY_REQUIRED', rule: 'cost:missing' };
    }
    const remaining = request.budgetRemainingMicros;
    if (remaining !== undefined && definition.cost.estimateMicros > remaining) {
      return { ...base, decision: 'deny', reasonCode: 'AGENT_BUDGET_INSUFFICIENT', rule: 'budget:remaining' };
    }
    if (!request.workflow) {
      return { ...base, decision: 'deny', reasonCode: 'AGENT_TOOL_PAID_REQUIRES_WORKFLOW', rule: 'paid:workflow_required' };
    }
    if (request.workflow.approvedPaidMicros < definition.cost.estimateMicros) {
      // 尚未批准时进入人工确认；已经声称“已批准”但金额不足则直接拒绝，防止绕过估价。
      if (request.approvedInvocation) {
        return { ...base, decision: 'deny', reasonCode: 'AGENT_TOOL_PAID_APPROVAL_MISMATCH', rule: 'paid:approval_mismatch' };
      }
      return { ...base, decision: 'require_confirmation', reasonCode: 'AGENT_TOOL_CONFIRMATION_REQUIRED', rule: 'paid:confirm' };
    }
    if (request.approvedInvocation) {
      return { ...base, decision: 'allow', reasonCode: 'AGENT_TOOL_APPROVED', rule: 'approval:invocation' };
    }
    return { ...base, decision: 'require_confirmation', reasonCode: 'AGENT_TOOL_CONFIRMATION_REQUIRED', rule: 'paid:confirm' };
  }

  if (request.mode === 'confirm_all' && definition.sideEffect === 'none') {
    return { ...base, decision: 'require_confirmation', reasonCode: 'AGENT_TOOL_CONFIRMATION_REQUIRED', rule: 'mode:confirm_all' };
  }

  const tier = toolAccessTier(definition.sideEffect);
  if (tier === 'forbidden') {
    return { ...base, decision: 'deny', reasonCode: 'AGENT_TOOL_FORBIDDEN', rule: 'side_effect:forbidden' };
  }
  if (tier === 'read_only') {
    return { ...base, decision: 'allow', reasonCode: 'AGENT_TOOL_READ_ONLY', rule: null };
  }
  if (request.approvedInvocation) {
    return { ...base, decision: 'allow', reasonCode: 'AGENT_TOOL_APPROVED', rule: 'approval:invocation' };
  }
  return { ...base, decision: 'require_confirmation', reasonCode: 'AGENT_TOOL_CONFIRMATION_REQUIRED', rule: `side_effect:${definition.sideEffect}` };
}

/** 只有付费或外部写入需要预留预算；internal_write 只计一律不使用金额账本。 */
export function requiresBudgetReservation(definition: ToolDefinition): boolean {
  return definition.sideEffect === 'paid_external';
}

/** 禁止把模型自报权限当授权；未知声明直接拒绝。 */
export function parseToolAccessMode(value: unknown): ToolAccessMode {
  if (value === undefined || value === null || value === '') return 'default';
  if (value === 'default' || value === 'read_only_only' || value === 'confirm_all') return value;
  throw new AgentContractError(400, 'AGENT_ACCESS_MODE_INVALID', '工具访问模式不合法。');
}

export function decisionToState(decision: ToolPermissionDecision): 'queued' | 'awaiting_approval' | 'rejected' {
  if (decision === 'allow') return 'queued';
  if (decision === 'require_confirmation') return 'awaiting_approval';
  return 'rejected';
}
