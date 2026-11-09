import { randomUUID } from 'node:crypto';
import {
  AgentContractError, digestOf, isPaidSideEffect, type AgentApprovalRequest, type JsonObject,
  type ToolCallProposal, type ToolDefinition, type ToolInvocationRecord, type ToolInvocationState,
  type ToolPermissionLevel, type ToolResult, type ToolVersionRef,
} from '@lyra/shared';
import { clipObservation, validateToolArguments, validateToolOutput } from './tool-schema';
import { decideToolPermission, parseToolAccessMode, requiresBudgetReservation, type ToolAccessMode } from './tool-permission';
import type { ToolAdapter, ToolExecutionContext, ToolRegistry } from './tool-registry';

/** Adapter 业务错误。unknown 表示外部结果无法确认，只能对账，不能普通重试。 */
export class ToolAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly options: { retryable?: boolean; unknown?: boolean } = {},
  ) {
    super(message);
    this.name = 'ToolAdapterError';
  }
}

export interface ToolAttemptRecord {
  attemptId: string;
  invocationId: string;
  attemptNumber: number;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'inconclusive';
  startedAt: string;
  endedAt?: string;
  reasonCode?: string;
  summary?: string;
}

export interface ToolInvocationStore {
  create(record: ToolInvocationRecord): Promise<void>;
  get(invocationId: string): Promise<ToolInvocationRecord | undefined>;
  /** CAS：expectedVersion 不匹配时返回 false，绝不覆盖他人写入。 */
  update(expectedVersion: number, next: ToolInvocationRecord): Promise<boolean>;
  findByIdempotencyKey(workspaceId: string, key: string): Promise<ToolInvocationRecord | undefined>;
  listByRun(runId: string): Promise<ToolInvocationRecord[]>;
  appendAttempt(attempt: ToolAttemptRecord): Promise<void>;
  completeAttempt(attemptId: string, patch: Pick<ToolAttemptRecord, 'state' | 'endedAt' | 'reasonCode' | 'summary'>): Promise<void>;
}

export interface BudgetReservation {
  reservationId: string;
  amountMicros: number;
  remainingMicros: number;
}

export interface BudgetLedger {
  reserve(input: {
    workspaceId: string; agentRunId: string; invocationId: string; amountMicros: number; currency: string;
  }): Promise<BudgetReservation>;
  settle(input: { reservationId: string; actualMicros: number }): Promise<void>;
  release(input: { reservationId: string; reason: string }): Promise<void>;
}

export type ToolPreparation =
  | {
    kind: 'ready';
    invocation: ToolInvocationRecord;
  }
  | {
    kind: 'reused';
    invocation: ToolInvocationRecord;
    result: ToolResult;
  }
  | {
    kind: 'awaiting_confirmation';
    confirmationState: 'WAITING_CONFIRMATION';
    invocation: ToolInvocationRecord;
    approval: AgentApprovalRequest;
  }
  | {
    kind: 'denied';
    reasonCode: string;
    summary: string;
    definition: ToolDefinition;
  };

export interface ToolPrepareInput {
  workspaceId: string;
  agentId: string;
  agentRunId: string;
  stepId: string;
  proposal: ToolCallProposal;
  context: ToolExecutionContext;
  role: ToolExecutionContext['role'];
  grantedPermissions: ToolPermissionLevel[];
  workflow: { workflowId: string; stage: string; approvedPaidMicros: number } | null;
  mode?: ToolAccessMode;
  budgetRemainingMicros?: number;
  /** 人类已经批准该 Invocation 的恢复路径。 */
  approvedInvocation?: boolean;
  approvalTtlMs?: number;
  now?: Date;
}

export interface ToolExecuteOptions {
  /** 当前 Attempt 的租约持有者；为空时由 kernel 生成。 */
  leaseOwner?: string;
  /** 输出是否按 outputSchema 校验；内置 Tool 应开启，MCP 投影默认关闭。 */
  validateOutput?: boolean;
  /** 可注入 sleep 便于测试退避；默认真实等待。 */
  sleep?: (ms: number) => Promise<void>;
}

export interface ToolExecutionOutcome {
  invocation: ToolInvocationRecord;
  result: ToolResult;
}

const DEFAULT_OBSERVATION_CHARS = 6000;
export const WAITING_CONFIRMATION = 'WAITING_CONFIRMATION' as const;

export class ToolKernel {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly store: ToolInvocationStore,
    private readonly budget: BudgetLedger,
    private readonly options: { now?: () => Date; maxObservationChars?: number } = {},
  ) {}

  private now(): Date { return this.options.now?.() ?? new Date(); }

  /** 模型侧工具目录：内部 ID 映射为 function-calling 安全名称。 */
  modelTools(tools: ToolDefinition[]): Array<{ name: string; definition: ToolDefinition }> {
    return tools.filter(tool => tool.executionOwner !== 'runtime_internal').map(tool => ({
      name: modelFunctionName(tool.toolId),
      definition: tool,
    }));
  }

  /**
   * 第三层校验：提案只能来自当前可见集合，Runtime 再校验 manifest、Schema、
   * RBAC、Tenant、阶段、预算与副作用，然后才创建持久 Invocation。
   */
  async prepare(input: ToolPrepareInput): Promise<ToolPreparation> {
    const reference: ToolVersionRef = {
      toolId: input.proposal.toolId,
      version: input.proposal.version,
      manifestDigest: input.proposal.manifestDigest,
    };
    const definition = this.registry.resolve(reference);
    if (input.proposal.runId !== input.agentRunId) {
      throw new AgentContractError(409, 'AGENT_TOOL_PROPOSAL_RUN_MISMATCH', '工具提案不属于当前 AgentRun。');
    }
    if (!definition.allowedAgentIds.includes(input.agentId)) {
      throw new AgentContractError(403, 'AGENT_TOOL_NOT_ALLOWED_FOR_AGENT', `工具 ${definition.toolId} 未授权给 Agent ${input.agentId}。`);
    }
    const args = validateToolArguments(definition.inputSchema, input.proposal.arguments, {
      maxBytes: definition.limits.maxInputBytes,
      maxNodes: Math.min(definition.limits.maxItems, 4096),
    });
    const mode = parseToolAccessMode(input.mode);
    const verdict = decideToolPermission({
      definition, role: input.role, grantedPermissions: input.grantedPermissions,
      workflow: input.workflow, mode,
      ...(input.budgetRemainingMicros === undefined ? {} : { budgetRemainingMicros: input.budgetRemainingMicros }),
      ...(input.approvedInvocation ? { approvedInvocation: true } : {}),
    });

    const idempotencyKey = idempotencyKeyOf(definition, input.proposal, input.context);
    const existing = await this.store.findByIdempotencyKey(input.workspaceId, idempotencyKey);
    if (existing?.result && existing.state === 'succeeded') {
      return { kind: 'reused', invocation: existing, result: existing.result };
    }
    if (existing && ['queued', 'running', 'waiting_external', 'reconciling'].includes(existing.state)) {
      return { kind: 'reused', invocation: existing, result: pendingResult(existing) };
    }
    if (existing && existing.state === 'awaiting_approval') {
      if (!input.approvedInvocation) {
        return {
          kind: 'awaiting_confirmation',
          confirmationState: 'WAITING_CONFIRMATION',
          invocation: existing,
          approval: approvalFor(existing, definition, input, this.now()),
        };
      }
      const approved = await this.commit(existing, { state: 'approved' });
      return { kind: 'ready', invocation: approved };
    }
    if (existing && existing.state === 'rejected') {
      return {
        kind: 'denied',
        reasonCode: 'AGENT_TOOL_REJECTED',
        summary: '同一幂等键的调用此前已被拒绝，不能重复提交。',
        definition,
      };
    }
    if (existing && ['failed', 'cancelled', 'interrupted', 'inconclusive'].includes(existing.state)) {
      // 同一个幂等键已经产生过业务 Invocation，绝不能为了“重试”再插入一行；
      // 需要新的外部操作时必须使用新的 ToolCallId/输入摘要。
      return {
        kind: 'denied',
        reasonCode: 'AGENT_TOOL_INVOCATION_TERMINAL',
        summary: '同一幂等键的调用已进入终态或待对账，不能再次创建 Invocation。',
        definition,
      };
    }

    const timestamp = this.now().toISOString();
    const invocationId = `inv_${randomUUID().replace(/-/g, '')}`;
    const state: ToolInvocationState = verdict.decision === 'deny'
      ? 'rejected' : verdict.decision === 'require_confirmation' && !input.approvedInvocation ? 'awaiting_approval' : 'queued';
    const invocation: ToolInvocationRecord = {
      invocationId,
      workspaceId: input.workspaceId,
      agentRunId: input.agentRunId,
      stepId: input.stepId,
      tool: reference,
      state,
      version: 1,
      idempotencyKey,
      proposal: { ...input.proposal, arguments: args },
      attemptCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    if (verdict.decision === 'deny') {
      await this.store.create(invocation);
      return {
        kind: 'denied',
        reasonCode: verdict.reasonCode,
        summary: denialSummary(verdict.reasonCode),
        definition,
      };
    }

    if (state === 'awaiting_approval') {
      const approval = approvalFor(invocation, definition, input, this.now());
      invocation.approvalRequestId = approval.approvalId;
      await this.store.create(invocation);
      return { kind: 'awaiting_confirmation', confirmationState: 'WAITING_CONFIRMATION', invocation, approval };
    }

    await this.store.create(invocation);
    return { kind: 'ready', invocation };
  }

  /** 执行一次（含重试）。调用方必须已经通过 prepare 并持久化 Invocation。 */
  async execute(
    invocation: ToolInvocationRecord,
    context: ToolExecutionContext,
    options: ToolExecuteOptions = {},
  ): Promise<ToolExecutionOutcome> {
    if (invocation.workspaceId !== context.workspaceId) {
      throw new AgentContractError(403, 'AGENT_TOOL_WORKSPACE_MISMATCH', '工具 Invocation 与当前 Workspace 不一致。');
    }
    const definition = this.registry.resolve(invocation.tool);
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolvePromise => setTimeout(resolvePromise, ms)));
    let reservation: BudgetReservation | null = null;

    if (invocation.state !== 'queued' && invocation.state !== 'approved' && invocation.state !== 'running') {
      throw new AgentContractError(409, 'AGENT_TOOL_INVOCATION_NOT_EXECUTABLE', `Invocation 当前状态 ${invocation.state} 不能执行。`);
    }

    if (requiresBudgetReservation(definition)) {
      if (!definition.cost) throw new AgentContractError(409, 'AGENT_TOOL_COST_POLICY_REQUIRED', '付费工具缺少估价策略。');
      reservation = await this.budget.reserve({
        workspaceId: context.workspaceId, agentRunId: invocation.agentRunId, invocationId: invocation.invocationId,
        amountMicros: definition.cost.estimateMicros, currency: definition.cost.currency,
      });
    }

    const startedAt = this.now().toISOString();
    let current = await this.cas(invocation, 'running');
    const attemptNumber = current.attemptCount + 1;
    let activeAttemptId = `att_${randomUUID().replace(/-/g, '')}`;
    await this.store.appendAttempt({
      attemptId: activeAttemptId, invocationId: current.invocationId, attemptNumber, state: 'running', startedAt,
    });
    current = await this.commit(current, { attemptCount: attemptNumber });

    let lastCode = 'AGENT_TOOL_FAILED';
    let lastSummary = '工具执行失败。';
    for (let attempt = attemptNumber; attempt <= definition.retry.maxAttempts; attempt += 1) {
      try {
        const adapter = this.registry.adapterFor(invocation.tool);
        const raw = await withTimeout(adapter.execute(current.proposal.arguments, context), definition.retry.timeoutMs);
        if (options.validateOutput) validateToolOutput(definition.outputSchema, raw);
        const result = successResult(definition, current, activeAttemptId, raw, startedAt, this.now(), this.options.maxObservationChars);
        if (reservation) await this.budget.settle({ reservationId: reservation.reservationId, actualMicros: result.cost.settledMicros });
        const next = await this.commit(current, { state: 'succeeded', result });
        await this.store.completeAttempt(activeAttemptId, { state: 'succeeded', endedAt: result.endedAt, reasonCode: result.reasonCode, summary: result.summary });
        return { invocation: next, result };
      } catch (failure) {
        const info = classifyFailure(failure);
        lastCode = info.code;
        lastSummary = info.summary;
        const endedAt = this.now().toISOString();
        if (info.unknown) {
          const result = failureResult(definition, current, activeAttemptId, 'inconclusive', info.code, info.summary, startedAt, endedAt);
          const next = await this.commit(current, { state: 'reconciling', result });
          await this.store.completeAttempt(activeAttemptId, { state: 'inconclusive', endedAt, reasonCode: info.code, summary: info.summary });
          return { invocation: next, result };
        }
        const retryable = definition.retry.retryableCodes.includes(info.code) || info.retryable;
        if (retryable && attempt < definition.retry.maxAttempts) {
          await this.store.completeAttempt(activeAttemptId, { state: 'failed', endedAt, reasonCode: info.code, summary: info.summary });
          if (definition.retry.backoffMs > 0) await sleep(definition.retry.backoffMs * 2 ** (attempt - attemptNumber));
          activeAttemptId = `att_${randomUUID().replace(/-/g, '')}`;
          const retryStarted = this.now().toISOString();
          await this.store.appendAttempt({
            attemptId: activeAttemptId, invocationId: current.invocationId, attemptNumber: attempt + 1, state: 'running', startedAt: retryStarted,
          });
          current = await this.commit(current, { attemptCount: attempt + 1, state: 'running' });
          continue;
        }
        if (reservation) await this.budget.release({ reservationId: reservation.reservationId, reason: info.code });
        const result = failureResult(definition, current, activeAttemptId, 'failed', info.code, info.summary, startedAt, endedAt);
        const next = await this.commit(current, { state: 'failed', result });
        await this.store.completeAttempt(activeAttemptId, { state: 'failed', endedAt, reasonCode: info.code, summary: info.summary });
        return { invocation: next, result };
      }
    }
    const endedAt = this.now().toISOString();
    if (reservation) await this.budget.release({ reservationId: reservation.reservationId, reason: lastCode });
    const result = failureResult(definition, current, activeAttemptId, 'failed', lastCode, lastSummary, startedAt, endedAt);
    const next = await this.commit(current, { state: 'failed', result });
    return { invocation: next, result };
  }

  async cancel(invocation: ToolInvocationRecord, reason: string): Promise<ToolInvocationRecord> {
    if (invocation.state === 'succeeded' || invocation.state === 'failed') {
      throw new AgentContractError(409, 'AGENT_TOOL_INVOCATION_TERMINAL', '已结束的 Invocation 不能取消。');
    }
    const timestamp = this.now().toISOString();
    const next: ToolInvocationRecord = {
      ...invocation,
      state: 'cancelled',
      version: invocation.version + 1,
      updatedAt: timestamp,
      result: {
        invocationId: invocation.invocationId,
        attemptId: `cancel_${invocation.version}`,
        status: 'cancelled',
        reasonCode: 'AGENT_TOOL_CANCELLED',
        summary: reason.slice(0, 300),
        outputSchemaDigest: '0'.repeat(64),
        references: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        cost: { estimateMicros: 0, reservedMicros: 0, settledMicros: 0, currency: 'CNY' },
        provider: {}, startedAt: invocation.updatedAt, endedAt: timestamp,
        reconciliation: 'not_required', sensitivity: 'internal',
      },
    };
    await this.store.update(invocation.version, next);
    return next;
  }

  private async cas(invocation: ToolInvocationRecord, state: ToolInvocationState): Promise<ToolInvocationRecord> {
    return this.commit(invocation, { state });
  }

  /** 乐观锁提交：version 由当前记录推导，调用方永远不手写版本号。 */
  private async commit(
    current: ToolInvocationRecord,
    patch: Partial<Pick<ToolInvocationRecord, 'state' | 'result' | 'attemptCount' | 'approvalRequestId'>>,
  ): Promise<ToolInvocationRecord> {
    const timestamp = this.now().toISOString();
    const next: ToolInvocationRecord = {
      ...current, ...patch, version: current.version + 1, updatedAt: timestamp,
    };
    const applied = await this.store.update(current.version, next);
    if (!applied) throw new AgentContractError(409, 'AGENT_TOOL_INVOCATION_STALE', 'Invocation 已被其他执行器推进，拒绝覆盖。');
    return next;
  }

}

export class InMemoryToolInvocationStore implements ToolInvocationStore {
  private readonly records = new Map<string, ToolInvocationRecord>();
  private readonly attempts = new Map<string, ToolAttemptRecord>();
  private readonly idempotency = new Map<string, string>();

  async create(record: ToolInvocationRecord): Promise<void> {
    if (this.records.has(record.invocationId)) throw new AgentContractError(409, 'AGENT_TOOL_INVOCATION_EXISTS', 'Invocation 已存在。');
    this.records.set(record.invocationId, clone(record));
    this.idempotency.set(`${record.workspaceId}:${record.idempotencyKey}`, record.invocationId);
  }

  async get(invocationId: string): Promise<ToolInvocationRecord | undefined> {
    const record = this.records.get(invocationId);
    return record ? clone(record) : undefined;
  }

  async update(expectedVersion: number, next: ToolInvocationRecord): Promise<boolean> {
    const current = this.records.get(next.invocationId);
    if (!current || current.version !== expectedVersion) return false;
    this.records.set(next.invocationId, clone(next));
    return true;
  }

  async findByIdempotencyKey(workspaceId: string, key: string): Promise<ToolInvocationRecord | undefined> {
    const id = this.idempotency.get(`${workspaceId}:${key}`);
    return id ? this.get(id) : undefined;
  }

  async listByRun(runId: string): Promise<ToolInvocationRecord[]> {
    return [...this.records.values()].filter(record => record.agentRunId === runId).map(clone);
  }

  async appendAttempt(attempt: ToolAttemptRecord): Promise<void> { this.attempts.set(attempt.attemptId, { ...attempt }); }

  async completeAttempt(attemptId: string, patch: Pick<ToolAttemptRecord, 'state' | 'endedAt' | 'reasonCode' | 'summary'>): Promise<void> {
    const attempt = this.attempts.get(attemptId);
    if (attempt) this.attempts.set(attemptId, { ...attempt, ...patch });
  }

  attemptsOf(invocationId: string): ToolAttemptRecord[] {
    return [...this.attempts.values()].filter(attempt => attempt.invocationId === invocationId);
  }
}

/** 单 Workspace 预算账本的最小内存实现，用于离线测试与本地编排。 */
export class InMemoryBudgetLedger implements BudgetLedger {
  private readonly balances = new Map<string, number>();
  private readonly reservations = new Map<string, { workspaceId: string; amountMicros: number; settled: boolean }>();

  constructor(initial: Record<string, number> = {}) {
    for (const [workspaceId, micros] of Object.entries(initial)) this.balances.set(workspaceId, micros);
  }

  async reserve(input: { workspaceId: string; agentRunId: string; invocationId: string; amountMicros: number; currency: string }): Promise<BudgetReservation> {
    const balance = this.balances.get(input.workspaceId);
    if (balance === undefined) throw new AgentContractError(503, 'AGENT_BUDGET_UNAVAILABLE', '当前 Workspace 未配置预算账本。');
    if (input.amountMicros > balance) throw new AgentContractError(409, 'AGENT_BUDGET_INSUFFICIENT', '预算余额不足，不能提交付费工具。');
    const remaining = balance - input.amountMicros;
    this.balances.set(input.workspaceId, remaining);
    const reservationId = `res_${digestOf(input).slice(0, 24)}`;
    this.reservations.set(reservationId, { workspaceId: input.workspaceId, amountMicros: input.amountMicros, settled: false });
    return { reservationId, amountMicros: input.amountMicros, remainingMicros: remaining };
  }

  async settle(input: { reservationId: string; actualMicros: number }): Promise<void> {
    const reservation = this.reservations.get(input.reservationId);
    if (!reservation || reservation.settled) throw new AgentContractError(409, 'AGENT_BUDGET_RESERVATION_INVALID', '预算预留不存在或已结算。');
    reservation.settled = true;
    const balance = this.balances.get(reservation.workspaceId) ?? 0;
    const delta = reservation.amountMicros - input.actualMicros;
    this.balances.set(reservation.workspaceId, balance + delta);
  }

  async release(input: { reservationId: string; reason: string }): Promise<void> {
    const reservation = this.reservations.get(input.reservationId);
    if (!reservation || reservation.settled) return;
    reservation.settled = true;
    this.balances.set(reservation.workspaceId, (this.balances.get(reservation.workspaceId) ?? 0) + reservation.amountMicros);
  }

  balanceOf(workspaceId: string): number { return this.balances.get(workspaceId) ?? 0; }
}

function modelFunctionName(toolId: string): string {
  const normalized = toolId.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_');
  return normalized.length <= 64 ? normalized : normalized.slice(0, 64);
}

function idempotencyKeyOf(definition: ToolDefinition, proposal: ToolCallProposal, context: ToolExecutionContext): string {
  switch (definition.idempotency.strategy) {
    case 'client_request_id':
      return `req:${context.requestId}`;
    case 'content_digest':
      return `arg:${digestOf({ tool: proposal.toolId, version: proposal.version, arguments: proposal.arguments })}`;
    case 'tool_call_id':
      return `call:${context.runId}:${context.toolCallId}`;
    case 'none':
    default:
      return `none:${context.runId}:${proposal.proposalId}`;
  }
}

function approvalFor(
  invocation: ToolInvocationRecord, definition: ToolDefinition, input: ToolPrepareInput, now: Date,
): AgentApprovalRequest {
  const ttl = input.approvalTtlMs ?? 15 * 60 * 1000;
  return {
    // 迁移 039 的 approval_id 列固定为 apr_<24hex>，与 decision_id 一一对应。
    approvalId: `apr_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    runId: input.agentRunId,
    invocationId: invocation.invocationId,
    kind: isPaidSideEffect(definition.sideEffect) ? 'paid_action' : 'tool_confirmation',
    state: 'pending',
    summary: `${definition.displayName}：${definition.description}${definition.cost ? `（预计 ${(definition.cost.estimateMicros / 1_000_000).toFixed(2)} ${definition.cost.currency}）` : ''}`.slice(0, 500),
    proposalDigest: digestOf({ tool: invocation.tool, arguments: invocation.proposal.arguments }),
    estimateMicros: definition.cost?.estimateMicros ?? 0,
    currency: definition.cost?.currency ?? 'CNY',
    requestedBy: input.context.userId,
    requestedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
  };
}

function denialSummary(code: string): string {
  const map: Record<string, string> = {
    AGENT_TOOL_NOT_FROZEN: '该工具尚未冻结，不能在生产运行中使用。',
    AGENT_TOOL_RUNTIME_INTERNAL: '该能力属于 Runtime 内部能力，不向 Agent 开放。',
    AGENT_TOOL_WORKFLOW_ONLY: '该工具只能由冻结 Workflow 在指定阶段执行。',
    AGENT_TOOL_WORKFLOW_NOT_ALLOWED: '当前 Workflow 未被授权使用该工具。',
    AGENT_TOOL_PERMISSION_REQUIRED: '当前用户角色或授权不足以调用该工具。',
    AGENT_TOOL_SENSITIVE_OUTPUT: '该工具输出敏感等级过高，需要管理员权限。',
    AGENT_TOOL_READ_ONLY_MODE: '当前运行只允许只读工具。',
    AGENT_BUDGET_INSUFFICIENT: '预算余额不足。',
    AGENT_TOOL_COST_POLICY_REQUIRED: '付费工具缺少估价策略。',
    AGENT_TOOL_PAID_REQUIRES_WORKFLOW: '付费工具必须由冻结 Workflow 发起。',
    AGENT_TOOL_PAID_NOT_APPROVED: '本次付费金额尚未获得人工批准。',
    AGENT_TOOL_FORBIDDEN: '该工具副作用等级被禁止。',
  };
  return map[code] ?? '工具调用被运行时拒绝。';
}

function successResult(
  definition: ToolDefinition, invocation: ToolInvocationRecord, attemptId: string,
  raw: unknown, startedAt: string, endedAtDate: Date, maxObservationChars = DEFAULT_OBSERVATION_CHARS,
): ToolResult {
  const outcome = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as JsonObject : null;
  const summary = typeof outcome?.summary === 'string' ? outcome.summary : clipObservation(raw, maxObservationChars, definition.limits.maxItems);
  const references = Array.isArray(outcome?.references)
    ? (outcome!.references as Array<Record<string, unknown>>).slice(0, definition.limits.maxItems).flatMap(reference => {
      const kind = reference.kind;
      const id = reference.id;
      if (typeof kind !== 'string' || typeof id !== 'string') return [];
      if (!['entity', 'revision', 'artifact', 'evidence', 'event', 'object'].includes(kind)) return [];
      return [{
        kind: kind as ToolResult['references'][number]['kind'], id,
        ...(typeof reference.revision === 'string' ? { revision: reference.revision } : {}),
        ...(typeof reference.digest === 'string' ? { digest: reference.digest } : {}),
      }];
    })
    : [];
  const estimate = definition.cost?.estimateMicros ?? 0;
  const settled = typeof outcome?.costMicros === 'number' && Number.isSafeInteger(outcome.costMicros)
    ? Math.max(0, outcome.costMicros) : estimate;
  return {
    invocationId: invocation.invocationId,
    attemptId,
    status: 'succeeded',
    reasonCode: 'AGENT_TOOL_SUCCEEDED',
    summary: summary.slice(0, maxObservationChars),
    outputSchemaDigest: definition.outputSchemaDigest,
    references,
    usage: {
      inputTokens: numeric(outcome?.usage, 'inputTokens'),
      outputTokens: numeric(outcome?.usage, 'outputTokens'),
      cachedTokens: numeric(outcome?.usage, 'cachedTokens'),
    },
    cost: { estimateMicros: estimate, reservedMicros: estimate, settledMicros: settled, currency: definition.cost?.currency ?? 'CNY' },
    provider: {
      ...(typeof outcome?.provider === 'string' ? { provider: outcome.provider.slice(0, 64) } : {}),
      ...(typeof outcome?.model === 'string' ? { model: outcome.model.slice(0, 128) } : {}),
      ...(definition.providers.modelConnections[0] ? { connectionRevision: definition.providers.modelConnections[0] } : {}),
    },
    startedAt,
    endedAt: endedAtDate.toISOString(),
    reconciliation: 'not_required',
    sensitivity: definition.sensitivity.output,
  };
}

function failureResult(
  definition: ToolDefinition, invocation: ToolInvocationRecord, attemptId: string,
  status: 'failed' | 'inconclusive', code: string, summary: string, startedAt: string, endedAt: string,
): ToolResult {
  return {
    invocationId: invocation.invocationId,
    attemptId,
    status: status === 'inconclusive' ? 'inconclusive' : 'failed',
    reasonCode: code,
    summary: summary.slice(0, 500),
    outputSchemaDigest: definition.outputSchemaDigest,
    references: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    cost: {
      estimateMicros: definition.cost?.estimateMicros ?? 0,
      reservedMicros: definition.cost?.estimateMicros ?? 0,
      settledMicros: 0,
      currency: definition.cost?.currency ?? 'CNY',
    },
    provider: {},
    startedAt,
    endedAt,
    reconciliation: status === 'inconclusive' ? 'pending' : 'not_required',
    sensitivity: definition.sensitivity.output,
  };
}

function pendingResult(invocation: ToolInvocationRecord): ToolResult {
  return {
    invocationId: invocation.invocationId,
    attemptId: 'pending',
    status: 'inconclusive',
    reasonCode: 'AGENT_TOOL_IN_PROGRESS',
    summary: '同一幂等键的工具调用仍在执行或等待对账。',
    outputSchemaDigest: '0'.repeat(64),
    references: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    cost: { estimateMicros: 0, reservedMicros: 0, settledMicros: 0, currency: 'CNY' },
    provider: {}, startedAt: invocation.createdAt, endedAt: invocation.updatedAt,
    reconciliation: 'pending', sensitivity: 'internal',
  };
}

function classifyFailure(failure: unknown): { code: string; summary: string; retryable: boolean; unknown: boolean } {
  if (failure instanceof ToolAdapterError) {
    return {
      code: failure.code, summary: failure.message.slice(0, 500),
      retryable: failure.options.retryable === true, unknown: failure.options.unknown === true,
    };
  }
  if (failure instanceof AgentContractError) {
    return { code: failure.code, summary: failure.message.slice(0, 500), retryable: false, unknown: false };
  }
  if (failure instanceof Error && failure.name === 'TimeoutError') {
    return { code: 'AGENT_TOOL_TIMEOUT', summary: '工具执行超时；外部结果未知，需要先对账。', retryable: false, unknown: true };
  }
  return { code: 'AGENT_TOOL_FAILED', summary: '工具执行失败，未返回可公开的错误细节。', retryable: false, unknown: false };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error('tool timeout');
          error.name = 'TimeoutError';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function numeric(value: unknown, key: string): number {
  if (!value || typeof value !== 'object') return 0;
  const item = (value as JsonObject)[key];
  return typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 ? item : 0;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
