import { randomBytes } from 'node:crypto';
import {
  AgentContractError, assertAgentTransition, digestOf, isTerminalAgentState,
  type AgentApprovalRequest, type AgentApprovalState, type AgentCheckpointPhase, type AgentEvent,
  type AgentRunAttempt, type AgentRunCheckpoint, type AgentRunRecord, type AgentRunState,
  type AgentStep, type FrozenAgentSnapshot,
} from '@lyra/shared';
import type { AgentContextSnapshot, AgentEventRecord, AgentRuntimeStore } from './run-store';

/**
 * 可恢复领域 Agent Runtime。
 *
 * 约束：
 * - 状态推进一律 CAS（expectedVersion），失败即 AGENT_RUN_STALE，不做“最后写入获胜”；
 * - lease 是唯一执行权凭证，心跳续租，过期后其他 Worker 才能接管；
 * - checkpoint 保存可恢复上下文摘要，Replay 只读事件，不重放副作用；
 * - 终态不可回退，恢复必须创建新的 attempt。
 */

export interface CreateRunInput {
  runId?: string;
  snapshot: FrozenAgentSnapshot;
  deadlineAt?: string;
  now?: () => Date;
}

export interface TransitionOptions {
  summary?: string;
  errorCode?: string;
  expectedVersion?: number;
}

export interface ClaimOptions {
  leaseOwner: string;
  ttlMs: number;
  now?: Date;
}

export class AgentRuntime {
  private readonly store: AgentRuntimeStore;
  private readonly now: () => Date;
  private readonly defaultLeaseTtlMs: number;

  constructor(store: AgentRuntimeStore, options: { now?: () => Date; leaseTtlMs?: number } = {}) {
    this.store = store;
    this.now = options.now ?? (() => new Date());
    this.defaultLeaseTtlMs = options.leaseTtlMs ?? 30_000;
  }

  async createRun(input: CreateRunInput): Promise<AgentRunRecord> {
    const snapshot = input.snapshot;
    if (!snapshot.workspaceId || !snapshot.userId) throw new AgentContractError(400, 'AGENT_SNAPSHOT_INVALID', 'Snapshot 缺少 Workspace 或用户。');
    if (!Array.isArray(snapshot.tools)) throw new AgentContractError(400, 'AGENT_SNAPSHOT_INVALID', 'Snapshot 缺少冻结工具列表。');
    const timestamp = (input.now?.() ?? this.now()).toISOString();
    const runId = input.runId ?? newRunId();
    if (!/^run_[a-f0-9]{32}$/.test(runId)) throw new AgentContractError(400, 'AGENT_RUN_ID_INVALID', 'Run ID 必须形如 run_<32 位十六进制>。');
    const deadline = input.deadlineAt ?? new Date(new Date(timestamp).getTime() + snapshot.timeout.runMs).toISOString();
    const record: AgentRunRecord = {
      runId,
      workspaceId: snapshot.workspaceId,
      state: 'created',
      version: 1,
      snapshot,
      attemptCount: 0,
      stepCount: 0,
      reasonSummary: 'Run 已创建，等待规划。',
      deadlineAt: deadline,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.createRun(record);
    await this.store.appendEvent(runId, { type: 'run_state', state: 'created', version: 1, summary: record.reasonSummary });
    return clone(record);
  }

  async getRun(runId: string): Promise<AgentRunRecord> {
    const run = await this.store.getRun(runId);
    if (!run) throw new AgentContractError(404, 'AGENT_RUN_NOT_FOUND', `Run 不存在：${runId}。`);
    return run;
  }

  async transition(runId: string, to: AgentRunState, options: TransitionOptions = {}): Promise<AgentRunRecord> {
    const run = await this.getRun(runId);
    if (isTerminalAgentState(run.state)) throw new AgentContractError(409, 'AGENT_RUN_TERMINAL', `Run 已处于终态 ${run.state}。`);
    assertAgentTransition(run.state, to);
    if (options.expectedVersion !== undefined && run.version !== options.expectedVersion) {
      throw new AgentContractError(409, 'AGENT_RUN_STALE', 'Run 已被其他执行器推进，请重新读取。');
    }
    const timestamp = this.now().toISOString();
    const next: AgentRunRecord = {
      ...run,
      state: to,
      version: run.version + 1,
      updatedAt: timestamp,
      reasonSummary: (options.summary ?? run.reasonSummary).slice(0, 500),
      ...(options.errorCode && isTerminalAgentState(to) ? { terminalErrorCode: options.errorCode } : {}),
      ...(to === 'interrupted' ? { leaseOwner: undefined, leaseExpiresAt: undefined } : {}),
    };
    const applied = await this.store.updateRun(run.version, next);
    if (!applied) throw new AgentContractError(409, 'AGENT_RUN_STALE', 'Run 已被其他执行器推进，请重新读取。');
    await this.store.appendEvent(runId, { type: 'run_state', state: to, version: next.version, summary: next.reasonSummary });
    if (isTerminalAgentState(to)) {
      await this.store.appendEvent(runId, {
        type: 'completed',
        state: to as 'succeeded' | 'failed' | 'cancelled' | 'inconclusive',
        summary: next.reasonSummary,
      });
    }
    if (run.currentAttemptId && (isTerminalAgentState(to) || to === 'interrupted' || to === 'queued')) {
      // 离开 running 回到 queued 表示旧 Worker 不再推进；旧 Attempt 必须结束，
      // 下一次 claim 只能创建新 Attempt，不能留下两个 running。
      await this.store.completeAttempt(run.currentAttemptId, {
        state: to === 'succeeded' ? 'succeeded'
          : to === 'failed' ? 'failed'
            : to === 'cancelled' ? 'cancelled'
              : to === 'inconclusive' ? 'lost' : 'interrupted',
        endedAt: timestamp,
        errorCode: options.errorCode,
      });
    }
    return clone(next);
  }

  /** 获取执行权并进入 running；同一 owner 重复调用等价于心跳。 */
  async claim(runId: string, options: ClaimOptions): Promise<AgentRunRecord> {
    const run = await this.getRun(runId);
    if (isTerminalAgentState(run.state)) throw new AgentContractError(409, 'AGENT_RUN_TERMINAL', `Run 已处于终态 ${run.state}。`);
    const timestamp = (options.now ?? this.now()).toISOString();
    if (new Date(timestamp) >= new Date(run.deadlineAt)) {
      await this.transition(runId, 'failed', { summary: 'Run 超过截止时间。', errorCode: 'AGENT_RUN_DEADLINE_EXCEEDED' });
      throw new AgentContractError(409, 'AGENT_RUN_DEADLINE_EXCEEDED', 'Run 已超过截止时间。');
    }
    if (run.leaseOwner === options.leaseOwner) return this.heartbeat(runId, options.leaseOwner, options.ttlMs);
    if (run.leaseOwner && run.leaseExpiresAt && new Date(run.leaseExpiresAt) > new Date(timestamp)) {
      throw new AgentContractError(409, 'AGENT_RUN_LEASE_HELD', `Run 租约由 ${run.leaseOwner} 持有。`);
    }
    if (run.state !== 'queued') {
      throw new AgentContractError(409, 'AGENT_RUN_NOT_CLAIMABLE', `Run 处于 ${run.state}，只有 queued 可以领取。`);
    }
    assertAgentTransition(run.state, 'running');
    const ttl = options.ttlMs > 0 ? options.ttlMs : this.defaultLeaseTtlMs;
    const attemptNumber = run.attemptCount + 1;
    const attempt: AgentRunAttempt = {
      attemptId: `runa_${randomBytes(16).toString('hex')}`,
      runId,
      attemptNumber,
      state: 'running',
      leaseOwner: options.leaseOwner,
      startedAt: timestamp,
    };
    const next: AgentRunRecord = {
      ...run,
      state: 'running',
      version: run.version + 1,
      updatedAt: timestamp,
      attemptCount: attemptNumber,
      currentAttemptId: attempt.attemptId,
      leaseOwner: options.leaseOwner,
      leaseExpiresAt: new Date(new Date(timestamp).getTime() + ttl).toISOString(),
      reasonSummary: '执行器已接管 Run。',
    };
    const applied = await this.store.claimRun(run.version, next, attempt);
    if (!applied) throw new AgentContractError(409, 'AGENT_RUN_STALE', '领取租约时 Run 已被其他执行器推进。');
    return clone(next);
  }

  async heartbeat(runId: string, leaseOwner: string, ttlMs: number): Promise<AgentRunRecord> {
    const run = await this.getRun(runId);
    if (isTerminalAgentState(run.state)) throw new AgentContractError(409, 'AGENT_RUN_TERMINAL', 'Run 已结束。');
    if (run.leaseOwner !== leaseOwner) throw new AgentContractError(409, 'AGENT_RUN_LEASE_MISMATCH', '租约不属于当前执行器。');
    const timestamp = this.now().toISOString();
    const next: AgentRunRecord = {
      ...run,
      version: run.version + 1,
      updatedAt: timestamp,
      leaseExpiresAt: new Date(new Date(timestamp).getTime() + Math.max(1, ttlMs)).toISOString(),
    };
    const applied = await this.store.updateRun(run.version, next);
    if (!applied) throw new AgentContractError(409, 'AGENT_RUN_STALE', '心跳时 Run 已被推进。');
    return clone(next);
  }

  async releaseLease(runId: string, leaseOwner: string): Promise<AgentRunRecord> {
    const run = await this.getRun(runId);
    if (run.leaseOwner !== leaseOwner) throw new AgentContractError(409, 'AGENT_RUN_LEASE_MISMATCH', '租约不属于当前执行器。');
    const timestamp = this.now().toISOString();
    const next: AgentRunRecord = {
      ...run, version: run.version + 1, updatedAt: timestamp, leaseOwner: undefined, leaseExpiresAt: undefined,
    };
    const applied = await this.store.updateRun(run.version, next);
    if (!applied) throw new AgentContractError(409, 'AGENT_RUN_STALE', '释放租约时 Run 已被推进。');
    return clone(next);
  }

  async interrupt(runId: string, reason: string, expectedVersion?: number): Promise<AgentRunRecord> {
    const run = await this.getRun(runId);
    if (isTerminalAgentState(run.state)) throw new AgentContractError(409, 'AGENT_RUN_TERMINAL', 'Run 已结束。');
    if (run.state === 'interrupted') return run;
    return this.transition(runId, 'interrupted', {
      summary: reason.slice(0, 500), errorCode: 'AGENT_RUN_INTERRUPTED', ...(expectedVersion ? { expectedVersion } : {}),
    });
  }

  /** 人工恢复：interrupted → queued，原 snapshot 不变，下一次 claim 产生新 attempt。 */
  async resume(runId: string, actor: string, expectedVersion?: number): Promise<AgentRunRecord> {
    const run = await this.getRun(runId);
    if (run.state !== 'interrupted') throw new AgentContractError(409, 'AGENT_RUN_NOT_INTERRUPTED', '只有 interrupted 的 Run 可以恢复。');
    void actor;
    return this.transition(runId, 'queued', {
      summary: '人工恢复，等待执行器接管。', ...(expectedVersion ? { expectedVersion } : {}),
    });
  }

  async enforceDeadline(runId: string): Promise<AgentRunRecord> {
    const run = await this.getRun(runId);
    if (isTerminalAgentState(run.state)) return run;
    if (this.now().getTime() < new Date(run.deadlineAt).getTime()) return run;
    return this.transition(runId, 'failed', { summary: 'Run 超过截止时间。', errorCode: 'AGENT_RUN_DEADLINE_EXCEEDED' });
  }

  async startStep(runId: string, summary: string): Promise<AgentStep> {
    const run = await this.getRun(runId);
    if (run.state !== 'running') throw new AgentContractError(409, 'AGENT_RUN_NOT_RUNNING', '只有 running 的 Run 可以开始步骤。');
    if (run.stepCount >= run.snapshot.maxSteps) {
      throw new AgentContractError(409, 'AGENT_RUN_STEP_LIMIT', 'Run 已达到最大步骤数。');
    }
    const timestamp = this.now().toISOString();
    const step: AgentStep = {
      stepId: newStepId(),
      runId,
      index: run.stepCount + 1,
      state: 'running',
      summary: summary.slice(0, 300),
      toolCallCount: 0,
      startedAt: timestamp,
    };
    const next: AgentRunRecord = { ...run, stepCount: step.index, version: run.version + 1, updatedAt: timestamp };
    const applied = await this.store.updateRun(run.version, next);
    if (!applied) throw new AgentContractError(409, 'AGENT_RUN_STALE', '开始步骤时 Run 已被推进。');
    await this.store.createStep(step);
    await this.store.appendEvent(runId, { type: 'step_started', stepId: step.stepId, index: step.index });
    return clone(step);
  }

  async completeStep(stepId: string, state: 'completed' | 'failed' | 'interrupted', summary: string, toolCallCount = 0): Promise<AgentStep> {
    const step = await this.store.getStep(stepId);
    if (!step) throw new AgentContractError(404, 'AGENT_STEP_NOT_FOUND', '步骤不存在。');
    if (step.state !== 'running') throw new AgentContractError(409, 'AGENT_STEP_ALREADY_ENDED', '步骤已结束。');
    const next: AgentStep = {
      ...step,
      state,
      summary: summary.slice(0, 500),
      toolCallCount: Math.max(step.toolCallCount, toolCallCount),
      endedAt: this.now().toISOString(),
    };
    await this.store.updateStep(stepId, next);
    return clone(next);
  }

  /** 保存可恢复上下文；payload 必须可 JSON 序列化且不超过 256KB。 */
  async recordContextSnapshot(runId: string, input: {
    kind: AgentContextSnapshot['kind'];
    payload: Record<string, unknown>;
    stepId?: string | null;
    cursor?: string | null;
  }): Promise<AgentContextSnapshot> {
    await this.getRun(runId);
    let serialized: string;
    try { serialized = JSON.stringify(input.payload); }
    catch { throw new AgentContractError(400, 'AGENT_CONTEXT_NOT_SERIALIZABLE', 'Context Snapshot 无法序列化。'); }
    if (serialized.length > 256 * 1024) throw new AgentContractError(413, 'AGENT_CONTEXT_TOO_LARGE', 'Context Snapshot 超过 256KB。');
    const digest = digestOf(input.payload);
    const snapshot: AgentContextSnapshot = {
      snapshotId: `cps_${digest.slice(0, 24)}`,
      runId,
      stepId: input.stepId ?? null,
      kind: input.kind,
      payloadDigest: digest,
      payload: structuredClone(input.payload),
      cursor: input.cursor ?? null,
      createdAt: this.now().toISOString(),
    };
    await this.store.appendContextSnapshot(snapshot);
    return clone(snapshot);
  }

  async latestContextSnapshot(runId: string): Promise<AgentContextSnapshot | null> {
    return this.store.latestContextSnapshot(runId);
  }

  /**
   * 写入 Tool 执行断点。必须在每个 Tool 调用前后各写一次：
   * before_tool 记录 pending Invocation，after_tool 记录已确认结果。
   */
  async recordCheckpoint(runId: string, input: {
    phase: AgentCheckpointPhase;
    payload: Record<string, unknown>;
    stepId?: string | null;
    pendingInvocationId?: string | null;
    cursor?: string | null;
    summary?: string;
  }): Promise<AgentRunCheckpoint> {
    const run = await this.getRun(runId);
    let serialized: string;
    try { serialized = JSON.stringify(input.payload); }
    catch { throw new AgentContractError(400, 'AGENT_CHECKPOINT_NOT_SERIALIZABLE', 'Checkpoint 无法序列化。'); }
    if (serialized.length > 256 * 1024) {
      throw new AgentContractError(413, 'AGENT_CHECKPOINT_TOO_LARGE', 'Checkpoint 超过 256KB。');
    }
    if (input.cursor && input.cursor.length > 200) {
      throw new AgentContractError(400, 'AGENT_CHECKPOINT_INVALID', 'Checkpoint cursor 不能超过 200 字符。');
    }
    const latest = await this.store.latestCheckpoint(runId);
    const sequence = (latest?.sequence ?? 0) + 1;
    const checkpoint: AgentRunCheckpoint = {
      checkpointId: `chk_${randomBytes(16).toString('hex')}`,
      runId,
      attemptId: run.currentAttemptId ?? null,
      stepId: input.stepId ?? null,
      sequence,
      phase: input.phase,
      payloadDigest: digestOf(input.payload),
      payload: structuredClone(input.payload),
      pendingInvocationId: input.pendingInvocationId ?? null,
      cursor: input.cursor ?? null,
      createdAt: this.now().toISOString(),
    };
    await this.store.appendCheckpoint(checkpoint);
    const summary = (input.summary
      ?? (checkpoint.pendingInvocationId
        ? `工具执行断点 ${checkpoint.pendingInvocationId}`
        : `执行断点 ${checkpoint.phase}`)).slice(0, 500);
    await this.store.appendEvent(runId, {
      type: 'checkpoint', checkpointId: checkpoint.checkpointId, phase: checkpoint.phase,
      sequence: checkpoint.sequence, stepId: checkpoint.stepId,
      pendingInvocationId: checkpoint.pendingInvocationId, summary,
    });
    return clone(checkpoint);
  }

  async latestCheckpoint(runId: string): Promise<AgentRunCheckpoint | null> {
    await this.getRun(runId);
    return this.store.latestCheckpoint(runId);
  }

  /** 兼容外部按 Issue 术语调用的别名；语义与 recordCheckpoint 完全一致。 */
  async checkpoint(
    runId: string,
    input: Parameters<AgentRuntime['recordCheckpoint']>[1],
  ): Promise<AgentRunCheckpoint> {
    return this.recordCheckpoint(runId, input);
  }

  async listCheckpoints(runId: string, afterSequence = 0, limit = 500): Promise<AgentRunCheckpoint[]> {
    await this.getRun(runId);
    return this.store.listCheckpoints(runId, afterSequence, Math.min(1000, Math.max(1, limit)));
  }

  async listAttempts(runId: string): Promise<AgentRunAttempt[]> {
    await this.getRun(runId);
    return this.store.listAttempts(runId);
  }

  /** 只读重放：返回指定序号之后的事件，不触发任何副作用。 */
  async replay(runId: string, afterSequence = 0, limit = 500): Promise<AgentEventRecord[]> {
    await this.getRun(runId);
    return this.store.listEvents(runId, afterSequence, Math.min(1000, Math.max(1, limit)));
  }

  async createApproval(request: AgentApprovalRequest): Promise<AgentApprovalRequest> {
    const run = await this.getRun(request.runId);
    if (isTerminalAgentState(run.state)) throw new AgentContractError(409, 'AGENT_RUN_TERMINAL', 'Run 已结束，不能再发起审批。');
    if (request.state !== 'pending') throw new AgentContractError(400, 'AGENT_APPROVAL_STATE_INVALID', '新审批必须是 pending。');
    if (new Date(request.expiresAt) <= this.now()) throw new AgentContractError(400, 'AGENT_APPROVAL_EXPIRY_INVALID', '审批有效期必须晚于当前时间。');
    await this.store.createApproval(request);
    return clone(request);
  }

  /** 挂起 Run 等待人工确认；approval 与 Run 状态在同一事务里由 main 落库。 */
  async suspendForApproval(runId: string, approval: AgentApprovalRequest, summary: string): Promise<AgentRunRecord> {
    await this.createApproval(approval);
    const run = await this.transition(runId, 'awaiting_approval', { summary });
    await this.store.appendEvent(runId, { type: 'approval_required', stepId: approval.invocationId ?? '', approval });
    return run;
  }

  async decideApproval(input: {
    approvalId: string; decision: 'approved' | 'rejected'; actor: string; note?: string;
  }): Promise<{ approval: AgentApprovalRequest; run: AgentRunRecord }> {
    const approval = await this.store.getApproval(input.approvalId);
    if (!approval) throw new AgentContractError(404, 'AGENT_APPROVAL_NOT_FOUND', '审批请求不存在。');
    if (approval.state !== 'pending') throw new AgentContractError(409, 'AGENT_APPROVAL_ALREADY_DECIDED', `审批已是 ${approval.state} 状态。`);
    if (this.now().getTime() >= new Date(approval.expiresAt).getTime()) {
      const applied = await this.store.updateApproval(approval.approvalId, { ...approval, state: 'expired' });
      if (!applied) throw new AgentContractError(409, 'AGENT_APPROVAL_STALE', '审批已被并发决定，不能按过期处理。');
      throw new AgentContractError(409, 'AGENT_APPROVAL_EXPIRED', '审批已过期，请重新发起。');
    }
    const decided: AgentApprovalRequest = {
      ...approval,
      state: input.decision,
      decidedBy: input.actor,
      decidedAt: this.now().toISOString(),
      decisionNote: (input.note ?? '').slice(0, 500),
    };
    // 必须使用持久化 CAS 的返回值判定胜负；输掉 CAS 的并发决策不能继续写事件或推 Run。
    const applied = await this.store.updateApproval(approval.approvalId, decided);
    if (!applied) throw new AgentContractError(409, 'AGENT_APPROVAL_STALE', '审批已被其他并发决策修改，本次决定未生效。');
    await this.store.appendEvent(approval.runId, {
      type: 'approval_decided', approvalId: approval.approvalId, state: decided.state as AgentApprovalState, decidedBy: input.actor,
    });
    const run = await this.getRun(approval.runId);
    const next = run.state === 'awaiting_approval'
      ? await this.transition(approval.runId, input.decision === 'approved' ? 'queued' : 'failed', {
        summary: input.decision === 'approved' ? '人工已批准，等待执行。' : '人工拒绝执行。',
        errorCode: input.decision === 'approved' ? undefined : 'AGENT_APPROVAL_REJECTED',
      })
      : run;
    return { approval: clone(decided), run: next };
  }

  /** 过期审批：若 Run 已无待审批项，则失败而不是永久挂起。 */
  async expireApprovals(runId: string): Promise<{ expired: number; run: AgentRunRecord }> {
    const run = await this.getRun(runId);
    const approvals = await this.store.listApprovals(runId);
    let expired = 0;
    for (const approval of approvals) {
      if (approval.state !== 'pending') continue;
      if (this.now().getTime() < new Date(approval.expiresAt).getTime()) continue;
      const applied = await this.store.updateApproval(approval.approvalId, { ...approval, state: 'expired' });
      if (!applied) continue;
      await this.store.appendEvent(runId, { type: 'approval_decided', approvalId: approval.approvalId, state: 'expired', decidedBy: 'system' });
      expired += 1;
    }
    const stillPending = (await this.store.listApprovals(runId)).some(approval => approval.state === 'pending');
    const next = run.state === 'awaiting_approval' && !stillPending
      ? await this.transition(runId, 'failed', { summary: '审批全部过期。', errorCode: 'AGENT_APPROVAL_EXPIRED' })
      : run;
    return { expired, run: next };
  }

  listApprovals(runId: string): Promise<AgentApprovalRequest[]> {
    return this.store.listApprovals(runId);
  }

  async listSteps(runId: string): Promise<AgentStep[]> {
    return this.store.listSteps(runId);
  }
}

/** 恢复前核对审批绑定：proposal 参数、估价或 Run 任一变化都必须重新确认。 */
export function assertApprovalBinding(approval: AgentApprovalRequest, input: {
  runId: string; proposalDigest: string; estimateMicros: number; currency: string;
}): void {
  if (approval.runId !== input.runId) throw new AgentContractError(409, 'AGENT_APPROVAL_RUN_MISMATCH', '审批不属于当前 Run。');
  if (approval.proposalDigest !== input.proposalDigest) throw new AgentContractError(409, 'AGENT_APPROVAL_PROPOSAL_CHANGED', '提案参数已变化，原审批失效。');
  if (approval.estimateMicros !== input.estimateMicros || approval.currency !== input.currency) {
    throw new AgentContractError(409, 'AGENT_APPROVAL_COST_CHANGED', '估价已变化，原审批失效。');
  }
}

function newRunId(): string {
  return `run_${randomBytes(16).toString('hex')}`;
}

function newStepId(): string {
  return `stp_${randomBytes(8).toString('hex')}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export type { AgentEvent };
