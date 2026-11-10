import { assertAgentClaim } from '@lyra/agent';
import { randomBytes } from 'node:crypto';
import type { PostgresDatabase } from '../db/client';
import {
  AgentContractError, digestOf,
  type AgentApprovalRequest, type AgentApprovalState, type AgentEvent, type AgentRunAttempt,
  type AgentRunCheckpoint, type AgentRunRecord, type AgentRunState, type AgentStep, type FrozenAgentSnapshot,
  type TenantDataEvent,
} from '@lyra/shared';
import { appendDataEvent } from '../data/outbox';
import type {
  AgentContextSnapshot, AgentEventRecord, AgentRuntimeStore,
} from '@lyra/agent';

/**
 * Postgres AgentRuntimeStore（迁移 039）。
 *
 * 所有写操作都带 version 或主键条件；查不到或被 RLS 过滤时返回 null / false，
 * 由 Runtime 转成 AGENT_RUN_STALE，不把“没权限”伪装成“已成功”。
 * 租户上下文由调用方通过 PostgresDatabase.runWithTenant 注入，本类不读环境变量。
 */

const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : new Date(value).toISOString();

interface RunRow {
  run_id: string; workspace_id: string; state: AgentRunState; version: number;
  snapshot_json: FrozenAgentSnapshot; attempt_count: number; step_count: number;
  current_attempt_id: string | null;
  reason_summary: string; terminal_error_code: string | null;
  lease_owner: string | null; lease_expires_at: Date | string | null;
  deadline_at: Date | string; created_at: Date | string; updated_at: Date | string;
}

interface AttemptRow {
  attempt_id: string; workspace_id: string; run_id: string; attempt_number: number; state: AgentRunAttempt['state'];
  lease_owner: string; started_at: Date | string; ended_at: Date | string | null;
  error_json: { code?: string } | null;
}
interface CheckpointRow {
  checkpoint_id: string; workspace_id: string; run_id: string; attempt_id: string | null;
  step_id: string | null; sequence: number; phase: AgentRunCheckpoint['phase'];
  payload_digest: string; payload_json: Record<string, unknown>;
  pending_invocation_id: string | null; cursor: string | null; created_at: Date | string;
}

interface EventRow { workspace_id: string; run_id: string; sequence: number; event_json: AgentEvent; created_at: Date | string }
interface StepRow {
  step_id: string; workspace_id: string; run_id: string; step_index: number; state: AgentStep['state'];
  summary: string; tool_call_count: number; started_at: Date | string; ended_at: Date | string | null;
}
interface SnapshotRow {
  snapshot_id: string; workspace_id: string; run_id: string; step_id: string | null;
  kind: AgentContextSnapshot['kind']; payload_digest: string; payload_json: Record<string, unknown>;
  cursor: string | null; created_at: Date | string;
}
interface ApprovalRow {
  approval_id: string; workspace_id: string; run_id: string; invocation_id: string | null;
  kind: AgentApprovalRequest['kind']; state: AgentApprovalState; summary: string;
  proposal_digest: string; estimate_micros: string | number; currency: string;
  requested_by: string; requested_at: Date | string; expires_at: Date | string;
  decided_by: string | null; decided_at: Date | string | null; decision_note: string | null;
}

const runOf = (row: RunRow): AgentRunRecord => ({
  runId: row.run_id,
  workspaceId: row.workspace_id,
  state: row.state,
  version: Number(row.version),
  snapshot: row.snapshot_json,
  attemptCount: Number(row.attempt_count),
  stepCount: Number(row.step_count),
  ...(row.current_attempt_id ? { currentAttemptId: row.current_attempt_id } : {}),
  reasonSummary: row.reason_summary,
  ...(row.terminal_error_code ? { terminalErrorCode: row.terminal_error_code } : {}),
  ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
  ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
  deadlineAt: iso(row.deadline_at),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const stepOf = (row: StepRow): AgentStep => ({
  stepId: row.step_id, runId: row.run_id, index: Number(row.step_index), state: row.state,
  summary: row.summary, toolCallCount: Number(row.tool_call_count), startedAt: iso(row.started_at),
  ...(row.ended_at ? { endedAt: iso(row.ended_at) } : {}),
});

const snapshotOf = (row: SnapshotRow): AgentContextSnapshot => ({
  snapshotId: row.snapshot_id, runId: row.run_id, stepId: row.step_id, kind: row.kind,
  payloadDigest: row.payload_digest, payload: row.payload_json, cursor: row.cursor, createdAt: iso(row.created_at),
});

const approvalOf = (row: ApprovalRow): AgentApprovalRequest => ({
  approvalId: row.approval_id, runId: row.run_id,
  invocationId: row.invocation_id, kind: row.kind, state: row.state, summary: row.summary,
  proposalDigest: row.proposal_digest, estimateMicros: Number(row.estimate_micros), currency: row.currency,
  requestedBy: row.requested_by, requestedAt: iso(row.requested_at), expiresAt: iso(row.expires_at),
  ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
  ...(row.decided_at ? { decidedAt: iso(row.decided_at) } : {}),
  ...(row.decision_note ? { decisionNote: row.decision_note } : {}),
});

const attemptOf = (row: AttemptRow): AgentRunAttempt => ({
  attemptId: row.attempt_id, runId: row.run_id, attemptNumber: Number(row.attempt_number),
  state: row.state, leaseOwner: row.lease_owner, startedAt: iso(row.started_at),
  ...(row.ended_at ? { endedAt: iso(row.ended_at) } : {}),
  ...(row.error_json?.code ? { errorCode: row.error_json.code } : {}),
});

const checkpointOf = (row: CheckpointRow): AgentRunCheckpoint => ({
  checkpointId: row.checkpoint_id, runId: row.run_id, attemptId: row.attempt_id,
  stepId: row.step_id, sequence: Number(row.sequence), phase: row.phase,
  payloadDigest: row.payload_digest, payload: row.payload_json,
  pendingInvocationId: row.pending_invocation_id, cursor: row.cursor, createdAt: iso(row.created_at),
});

/**
 * 把 AgentEvent 投影为统一 Outbox 的 DataEventV2（不新建 Dispatcher）。
 * text 事件只留在 Agent 事件流，不进入 Outbox；其余事件只暴露可公开标量。
 */
function outboxEventOf(
  workspaceId: string, runId: string, sequence: number, event: AgentEvent, at: string,
): TenantDataEvent | null {
  const eventType = eventTypeOf(event);
  if (!eventType) return null;
  const payload: Record<string, string | number | boolean | null> = {};
  const add = (key: string, value: string | number | boolean | undefined | null): void => {
    if (value !== undefined && value !== null) payload[key] = value;
  };
  const summary = 'summary' in event ? String(event.summary).slice(0, 512) : '';
  add('summary', summary);
  if (event.type === 'run_state') { add('state', event.state); add('version', event.version); }
  if (event.type === 'step_started') { add('stepId', event.stepId); add('stepIndex', event.index); }
  if (event.type === 'checkpoint') {
    add('checkpointId', event.checkpointId); add('phase', event.phase);
    add('checkpointSequence', event.sequence); add('pendingInvocationId', event.pendingInvocationId);
    if (event.stepId) add('stepId', event.stepId);
  }
  if (event.type === 'tool_proposed') { add('proposalId', event.proposalId); add('toolId', event.toolId); add('version', event.version); }
  if (event.type === 'tool_denied') { add('reasonCode', event.reasonCode); add('proposalId', event.proposalId); }
  if (event.type === 'tool_started' || event.type === 'tool_result') {
    add('invocationId', event.invocationId);
    if (event.type === 'tool_started') add('toolId', event.toolId);
    if (event.type === 'tool_result') { add('status', event.status); add('reasonCode', event.reasonCode); }
  }
  if (event.type === 'approval_required') {
    add('approvalId', event.approval.approvalId); add('approvalState', event.approval.state);
    add('kind', event.approval.kind); add('estimateMicros', event.approval.estimateMicros);
    add('currency', event.approval.currency);
  }
  if (event.type === 'approval_decided') { add('approvalId', event.approvalId); add('approvalState', event.state); add('decidedBy', event.decidedBy); }
  if (event.type === 'budget_reserved') { add('invocationId', event.invocationId); add('amountMicros', event.amountMicros); add('currency', event.currency); }
  if (event.type === 'budget_settled') { add('invocationId', event.invocationId); add('reservedMicros', event.reservedMicros); add('settledMicros', event.settledMicros); }
  if (event.type === 'completed') add('state', event.state);
  if (event.type === 'error') add('code', event.code);
  return {
    eventId: `evt_${randomBytes(16).toString('hex')}`,
    eventType,
    schemaVersion: 'lyra.data.event/v2',
    aggregateType: 'agent_run',
    aggregateId: runId,
    aggregateVersion: sequence,
    occurredAt: at,
    recordedAt: at,
    correlationId: `agent-run:${runId}`,
    causationId: null,
    idempotencyKey: `agent.run:${runId}:${sequence}`,
    authoritativeRef: { kind: 'agent_run', id: runId, revisionId: null, digest: digestOf({ workspaceId, runId, sequence, event }) },
    payload,
    workspaceId,
  };
}

function eventTypeOf(event: AgentEvent): string | null {
  switch (event.type) {
    case 'run_state': return 'agent.run.state';
    case 'step_started': return 'agent.step.started';
    case 'checkpoint': return 'agent.run.checkpoint';
    case 'tool_proposed': return 'agent.tool.proposed';
    case 'tool_denied': return 'agent.tool.denied';
    case 'tool_started': return 'agent.tool.started';
    case 'tool_result': return 'agent.tool.result';
    case 'approval_required': return 'agent.approval.required';
    case 'approval_decided': return 'agent.approval.decided';
    case 'budget_reserved': return 'agent.budget.reserved';
    case 'budget_settled': return 'agent.budget.settled';
    case 'completed': return 'agent.run.completed';
    case 'error': return 'agent.run.error';
    case 'text': return null;
    default: return null;
  }
}

export class PostgresAgentRuntimeStore implements AgentRuntimeStore {
  constructor(private readonly database: Pick<PostgresDatabase, 'query' | 'transaction'>) {}

  async createRun(record: AgentRunRecord): Promise<void> {
    try {
      await this.database.query(`
        INSERT INTO agent_runs (
          run_id, workspace_id, project_id, state, version, snapshot_json, snapshot_digest,
          attempt_count, step_count, current_attempt_id, reason_summary, terminal_error_code,
          lease_owner, lease_expires_at, heartbeat_at, deadline_at, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      `, [
        record.runId, record.workspaceId, record.snapshot.projectId, record.state, record.version,
        JSON.stringify(record.snapshot), record.snapshot.contextSnapshotDigest,
        record.attemptCount, record.stepCount, record.currentAttemptId ?? null,
        record.reasonSummary, record.terminalErrorCode ?? null,
        record.leaseOwner ?? null, record.leaseExpiresAt ?? null,
        record.leaseOwner ? record.updatedAt : null, record.deadlineAt, record.createdAt, record.updatedAt,
      ]);
    } catch (error) {
      throw persistenceError(error, 'AGENT_RUN_ALREADY_EXISTS', 'Run 创建失败：ID 已存在或数据不合法。');
    }
  }

  async getRun(runId: string): Promise<AgentRunRecord | null> {
    const result = await this.database.query<RunRow>(`SELECT * FROM agent_runs WHERE run_id = $1`, [runId]);
    return result.rows[0] ? runOf(result.rows[0]) : null;
  }

  async updateRun(expectedVersion: number, next: AgentRunRecord): Promise<boolean> {
    const result = await this.database.query(`
      UPDATE agent_runs SET
        state = $3, version = $4, reason_summary = $5, terminal_error_code = $6,
        attempt_count = $7, step_count = $8, current_attempt_id = $9,
        lease_owner = $10, lease_expires_at = $11,
        heartbeat_at = $12, updated_at = $13
      WHERE workspace_id = $14 AND run_id = $1 AND version = $2
    `, [
      next.runId, expectedVersion, next.state, next.version, next.reasonSummary, next.terminalErrorCode ?? null,
      next.attemptCount, next.stepCount, next.currentAttemptId ?? null,
      next.leaseOwner ?? null, next.leaseExpiresAt ?? null,
      next.leaseOwner ? next.updatedAt : null, next.updatedAt, next.workspaceId,
    ]);
    return result.rowCount === 1;
  }

  async claimRun(expectedVersion: number, next: AgentRunRecord, attempt: AgentRunAttempt): Promise<boolean> {
    assertAgentClaim(expectedVersion, next, attempt);
    return this.database.transaction(async client => {
      const row = (await client.query<{version: number;state: string;attempt_count: number}>(
        'SELECT version,state,attempt_count FROM agent_runs WHERE workspace_id=$1 AND run_id=$2 FOR UPDATE',
        [next.workspaceId, next.runId])).rows[0];
      if (!row || row.version !== expectedVersion || row.state !== 'queued') return false;
      if (row.attempt_count + 1 !== next.attemptCount) throw new AgentContractError(409, 'AGENT_ATTEMPT_CONFLICT', 'Attempt 序号冲突。');
      const scoped: Pick<PostgresDatabase, 'query' | 'transaction'> = {
        query: (sql, values = []) => client.query(sql, [...values]), transaction: work => work(client),
      };
      const store = new PostgresAgentRuntimeStore(scoped);
      if (!await store.updateRun(expectedVersion, next)) return false;
      await store.createAttempt(attempt);
      await store.appendEvent(next.runId, { type: 'run_state', state: 'running', version: next.version, summary: next.reasonSummary });
      return true;
    });
  }

  async createAttempt(attempt: AgentRunAttempt): Promise<void> {
    await this.database.query(`
      INSERT INTO agent_run_attempts (
        attempt_id, workspace_id, run_id, attempt_number, state, lease_owner, started_at, ended_at, error_json
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
    `, [attempt.attemptId, await this.requireWorkspaceOfRun(attempt.runId), attempt.runId,
      attempt.attemptNumber, attempt.state, attempt.leaseOwner, attempt.startedAt,
      attempt.endedAt ?? null, attempt.errorCode ? JSON.stringify({ code: attempt.errorCode }) : null]);
  }

  async completeAttempt(
    attemptId: string,
    patch: Pick<AgentRunAttempt, 'state' | 'endedAt' | 'errorCode'>,
  ): Promise<void> {
    await this.database.query(`
      UPDATE agent_run_attempts SET state = $2, ended_at = $3, error_json = $4::jsonb
      WHERE attempt_id = $1
    `, [attemptId, patch.state, patch.endedAt ?? null,
      patch.errorCode ? JSON.stringify({ code: patch.errorCode }) : null]);
  }

  async listAttempts(runId: string): Promise<AgentRunAttempt[]> {
    const result = await this.database.query<AttemptRow>(`
      SELECT * FROM agent_run_attempts WHERE run_id = $1 ORDER BY attempt_number
    `, [runId]);
    return result.rows.map(attemptOf);
  }

  async appendCheckpoint(checkpoint: AgentRunCheckpoint): Promise<void> {
    const workspaceId = await this.requireWorkspaceOfRun(checkpoint.runId);
    try {
      await this.database.query(`
        INSERT INTO agent_run_checkpoints (
          checkpoint_id, workspace_id, run_id, attempt_id, step_id, sequence, phase,
          payload_digest, payload_json, pending_invocation_id, cursor, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
      `, [checkpoint.checkpointId, workspaceId, checkpoint.runId, checkpoint.attemptId,
        checkpoint.stepId, checkpoint.sequence, checkpoint.phase, checkpoint.payloadDigest,
        JSON.stringify(checkpoint.payload), checkpoint.pendingInvocationId, checkpoint.cursor, checkpoint.createdAt]);
    } catch (error) {
      const pgCode = error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
      if (pgCode === '23505') {
        throw new AgentContractError(409, 'AGENT_CHECKPOINT_STALE', 'Checkpoint sequence 已被其他执行器写入。');
      }
      throw persistenceError(error, 'AGENT_CHECKPOINT_PERSISTENCE_ERROR', 'Checkpoint 写入失败。');
    }
  }

  async latestCheckpoint(runId: string): Promise<AgentRunCheckpoint | null> {
    const result = await this.database.query<CheckpointRow>(`
      SELECT * FROM agent_run_checkpoints WHERE run_id = $1
      ORDER BY sequence DESC LIMIT 1
    `, [runId]);
    return result.rows[0] ? checkpointOf(result.rows[0]) : null;
  }

  async listCheckpoints(runId: string, afterSequence = 0, limit = 500): Promise<AgentRunCheckpoint[]> {
    const result = await this.database.query<CheckpointRow>(`
      SELECT * FROM agent_run_checkpoints WHERE run_id = $1 AND sequence > $2
      ORDER BY sequence LIMIT $3
    `, [runId, afterSequence, Math.min(1000, Math.max(1, limit))]);
    return result.rows.map(checkpointOf);
  }

  async appendEvent(runId: string, event: AgentEvent): Promise<AgentEventRecord> {
    const workspaceId = await this.requireWorkspaceOfRun(runId);
    return this.database.transaction(async client => {
      await client.query(`SELECT 1 FROM agent_runs WHERE workspace_id = $1 AND run_id = $2 FOR UPDATE`, [workspaceId, runId]);
      const sequenceResult = await client.query<{ next: string | number }>(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS next
        FROM agent_events WHERE workspace_id = $1 AND run_id = $2
      `, [workspaceId, runId]);
      const sequence = Number(sequenceResult.rows[0]?.next ?? 1);
      const inserted = await client.query<EventRow>(`
        INSERT INTO agent_events (workspace_id, run_id, sequence, event_type, event_json, created_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,clock_timestamp())
        RETURNING *
      `, [workspaceId, runId, sequence, event.type, JSON.stringify(event)]);
      const row = inserted.rows[0];
      if (!row) throw new AgentContractError(500, 'AGENT_EVENT_PERSISTENCE_ERROR', '事件写入失败。');
      const at = iso(row.created_at);
      const dataEvent = outboxEventOf(workspaceId, runId, sequence, event, at);
      // 权威事件与 Outbox 同一事务；Outbox 失败则整个事件回滚。
      if (dataEvent) await appendDataEvent(client, dataEvent);
      return { runId, sequence, event: row.event_json, at };
    });
  }

  async listEvents(runId: string, afterSequence = 0, limit = 500): Promise<AgentEventRecord[]> {
    const result = await this.database.query<EventRow>(`
      SELECT * FROM agent_events WHERE run_id = $1 AND sequence > $2
      ORDER BY sequence LIMIT $3
    `, [runId, afterSequence, Math.min(1000, Math.max(1, limit))]);
    return result.rows.map(row => ({ runId: row.run_id, sequence: Number(row.sequence), event: row.event_json, at: iso(row.created_at) }));
  }

  async createStep(step: AgentStep): Promise<void> {
    const workspaceId = await this.requireWorkspaceOfRun(step.runId);
    await this.database.query(`
      INSERT INTO agent_steps (step_id, workspace_id, run_id, step_index, state, summary, tool_call_count, started_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [step.stepId, workspaceId, step.runId, step.index, step.state, step.summary, step.toolCallCount, step.startedAt]);
  }

  async getStep(stepId: string): Promise<AgentStep | null> {
    const result = await this.database.query<StepRow>(`SELECT * FROM agent_steps WHERE step_id = $1`, [stepId]);
    return result.rows[0] ? stepOf(result.rows[0]) : null;
  }

  async updateStep(stepId: string, next: AgentStep): Promise<boolean> {
    const result = await this.database.query(`
      UPDATE agent_steps SET state = $2, summary = $3, tool_call_count = $4, ended_at = $5
      WHERE step_id = $1
    `, [stepId, next.state, next.summary, next.toolCallCount, next.endedAt ?? null]);
    return result.rowCount === 1;
  }

  async listSteps(runId: string): Promise<AgentStep[]> {
    const result = await this.database.query<StepRow>(`
      SELECT * FROM agent_steps WHERE run_id = $1 ORDER BY step_index
    `, [runId]);
    return result.rows.map(stepOf);
  }

  async appendContextSnapshot(snapshot: AgentContextSnapshot): Promise<void> {
    const workspaceId = await this.requireWorkspaceOfRun(snapshot.runId);
    await this.database.query(`
      INSERT INTO agent_context_snapshots (
        snapshot_id, workspace_id, run_id, step_id, kind, payload_digest, payload_json, cursor, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
    `, [snapshot.snapshotId, workspaceId, snapshot.runId, snapshot.stepId, snapshot.kind,
      snapshot.payloadDigest, JSON.stringify(snapshot.payload), snapshot.cursor, snapshot.createdAt]);
  }

  async latestContextSnapshot(runId: string): Promise<AgentContextSnapshot | null> {
    const result = await this.database.query<SnapshotRow>(`
      SELECT * FROM agent_context_snapshots WHERE run_id = $1
      ORDER BY created_at DESC, snapshot_id DESC LIMIT 1
    `, [runId]);
    return result.rows[0] ? snapshotOf(result.rows[0]) : null;
  }

  async createApproval(request: AgentApprovalRequest): Promise<void> {
    const workspaceId = await this.requireWorkspaceOfRun(request.runId);
    await this.database.query(`
      INSERT INTO agent_approval_requests (
        approval_id, workspace_id, run_id, invocation_id, kind, state, summary, proposal_digest,
        estimate_micros, currency, requested_by, requested_at, expires_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [request.approvalId, workspaceId, request.runId, request.invocationId, request.kind, request.state,
      request.summary, request.proposalDigest, request.estimateMicros, request.currency,
      request.requestedBy, request.requestedAt, request.expiresAt]);
  }

  async getApproval(approvalId: string): Promise<AgentApprovalRequest | null> {
    const result = await this.database.query<ApprovalRow>(`SELECT * FROM agent_approval_requests WHERE approval_id = $1`, [approvalId]);
    return result.rows[0] ? approvalOf(result.rows[0]) : null;
  }

  async updateApproval(approvalId: string, next: AgentApprovalRequest): Promise<boolean> {
    const result = await this.database.query(`
      UPDATE agent_approval_requests SET
        state = $2, decided_by = $3, decided_at = $4, decision_note = $5
      WHERE approval_id = $1 AND state = 'pending'
    `, [approvalId, next.state, next.decidedBy ?? null, next.decidedAt ?? null, next.decisionNote ?? null]);
    if (result.rowCount !== 1) return false;
    if (next.state !== 'pending') {
      const workspaceId = await this.requireWorkspaceOfRun(next.runId);
      await this.database.query(`
        INSERT INTO agent_approval_decisions (decision_id, workspace_id, approval_id, decision, actor, note, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [`apd_${next.approvalId.slice(4)}`, workspaceId, approvalId, next.state, next.decidedBy ?? 'system',
        next.decisionNote ?? null, next.decidedAt ?? new Date().toISOString()]);
    }
    return true;
  }

  async listApprovals(runId: string): Promise<AgentApprovalRequest[]> {
    const result = await this.database.query<ApprovalRow>(`
      SELECT * FROM agent_approval_requests WHERE run_id = $1 ORDER BY requested_at, approval_id
    `, [runId]);
    return result.rows.map(approvalOf);
  }

  private async requireWorkspaceOfRun(runId: string): Promise<string> {
    const result = await this.database.query<{ workspace_id: string }>(`
      SELECT workspace_id FROM agent_runs WHERE run_id = $1
    `, [runId]);
    const workspaceId = result.rows[0]?.workspace_id;
    if (!workspaceId) throw new AgentContractError(404, 'AGENT_RUN_NOT_FOUND', `Run 不存在：${runId}。`);
    return workspaceId;
  }
}

function persistenceError(error: unknown, code: string, message: string): AgentContractError {
  if (error instanceof AgentContractError) return error;
  const pgCode = error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
  if (pgCode === '23505') return new AgentContractError(409, code, message);
  return new AgentContractError(500, 'AGENT_PERSISTENCE_ERROR', 'Agent 运行数据写入失败。');
}
