import type {
  AgentApprovalRequest, AgentApprovalState, AgentEvent, AgentRunAttempt, AgentRunCheckpoint,
  AgentRunRecord, AgentStep,
} from '@lyra/shared';

/**
 * Run 持久化端口。
 *
 * agent 包只定义形状；实现由 main 注入（Postgres + 迁移 039）。所有 update 都带
 * expectedVersion，返回 false 表示被其他 Worker 抢先推进，调用方必须重新读取。
 */

export interface AgentEventRecord {
  runId: string;
  sequence: number;
  event: AgentEvent;
  at: string;
}

export interface AgentContextSnapshot {
  snapshotId: string;
  runId: string;
  stepId: string | null;
  kind: 'step' | 'tool' | 'resume' | 'approval';
  payloadDigest: string;
  payload: Record<string, unknown>;
  /** 恢复游标：下一个待执行步骤或事件序号。 */
  cursor: string | null;
  createdAt: string;
}

export interface AgentRuntimeStore {
  createRun(record: AgentRunRecord): Promise<void>;
  getRun(runId: string): Promise<AgentRunRecord | null>;
  updateRun(expectedVersion: number, next: AgentRunRecord): Promise<boolean>;

  createAttempt(attempt: AgentRunAttempt): Promise<void>;
  completeAttempt(attemptId: string, patch: Pick<AgentRunAttempt, 'state' | 'endedAt' | 'errorCode'>): Promise<void>;
  listAttempts(runId: string): Promise<AgentRunAttempt[]>;

  appendCheckpoint(checkpoint: AgentRunCheckpoint): Promise<void>;
  latestCheckpoint(runId: string): Promise<AgentRunCheckpoint | null>;
  listCheckpoints(runId: string, afterSequence?: number, limit?: number): Promise<AgentRunCheckpoint[]>;

  appendEvent(runId: string, event: AgentEvent): Promise<AgentEventRecord>;
  listEvents(runId: string, afterSequence?: number, limit?: number): Promise<AgentEventRecord[]>;

  createStep(step: AgentStep): Promise<void>;
  getStep(stepId: string): Promise<AgentStep | null>;
  updateStep(stepId: string, next: AgentStep): Promise<boolean>;
  listSteps(runId: string): Promise<AgentStep[]>;

  appendContextSnapshot(snapshot: AgentContextSnapshot): Promise<void>;
  latestContextSnapshot(runId: string): Promise<AgentContextSnapshot | null>;

  createApproval(request: AgentApprovalRequest): Promise<void>;
  getApproval(approvalId: string): Promise<AgentApprovalRequest | null>;
  updateApproval(approvalId: string, next: AgentApprovalRequest): Promise<boolean>;
  listApprovals(runId: string): Promise<AgentApprovalRequest[]>;
}

export class InMemoryAgentRuntimeStore implements AgentRuntimeStore {
  private readonly runs = new Map<string, AgentRunRecord>();
  private readonly events = new Map<string, AgentEventRecord[]>();
  private readonly steps = new Map<string, AgentStep>();
  private readonly snapshots = new Map<string, AgentContextSnapshot[]>();
  private readonly approvals = new Map<string, AgentApprovalRequest>();
  private readonly attempts = new Map<string, AgentRunAttempt>();
  private readonly checkpoints = new Map<string, AgentRunCheckpoint[]>();

  async createRun(record: AgentRunRecord): Promise<void> {
    if (this.runs.has(record.runId)) throw new Error(`Run 已存在：${record.runId}`);
    this.runs.set(record.runId, structuredClone(record));
  }

  async getRun(runId: string): Promise<AgentRunRecord | null> {
    const record = this.runs.get(runId);
    return record ? structuredClone(record) : null;
  }

  async updateRun(expectedVersion: number, next: AgentRunRecord): Promise<boolean> {
    const current = this.runs.get(next.runId);
    if (!current || current.version !== expectedVersion) return false;
    this.runs.set(next.runId, structuredClone(next));
    return true;
  }

  async createAttempt(attempt: AgentRunAttempt): Promise<void> {
    if (this.attempts.has(attempt.attemptId)) throw new Error(`Attempt 已存在：${attempt.attemptId}`);
    this.attempts.set(attempt.attemptId, structuredClone(attempt));
  }

  async completeAttempt(attemptId: string, patch: Pick<AgentRunAttempt, 'state' | 'endedAt' | 'errorCode'>): Promise<void> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return;
    this.attempts.set(attemptId, structuredClone({ ...attempt, ...patch }));
  }

  async listAttempts(runId: string): Promise<AgentRunAttempt[]> {
    return [...this.attempts.values()]
      .filter(attempt => attempt.runId === runId)
      .sort((left, right) => left.attemptNumber - right.attemptNumber)
      .map(attempt => structuredClone(attempt));
  }

  async appendCheckpoint(checkpoint: AgentRunCheckpoint): Promise<void> {
    const list = this.checkpoints.get(checkpoint.runId) ?? [];
    if (list.some(item => item.sequence === checkpoint.sequence)) {
      throw new Error(`Checkpoint sequence 已存在：${checkpoint.sequence}`);
    }
    list.push(structuredClone(checkpoint));
    list.sort((left, right) => left.sequence - right.sequence);
    this.checkpoints.set(checkpoint.runId, list);
  }

  async latestCheckpoint(runId: string): Promise<AgentRunCheckpoint | null> {
    const list = this.checkpoints.get(runId);
    return list && list.length > 0 ? structuredClone(list[list.length - 1]!) : null;
  }

  async listCheckpoints(runId: string, afterSequence = 0, limit = 500): Promise<AgentRunCheckpoint[]> {
    return (this.checkpoints.get(runId) ?? [])
      .filter(checkpoint => checkpoint.sequence > afterSequence)
      .slice(0, Math.min(1000, Math.max(1, limit)))
      .map(checkpoint => structuredClone(checkpoint));
  }

  async appendEvent(runId: string, event: AgentEvent): Promise<AgentEventRecord> {
    const list = this.events.get(runId) ?? [];
    const record: AgentEventRecord = {
      runId, sequence: list.length + 1, event: structuredClone(event), at: new Date().toISOString(),
    };
    list.push(record);
    this.events.set(runId, list);
    return structuredClone(record);
  }

  async listEvents(runId: string, afterSequence = 0, limit = 500): Promise<AgentEventRecord[]> {
    return (this.events.get(runId) ?? [])
      .filter(event => event.sequence > afterSequence)
      .slice(0, Math.max(1, limit))
      .map(record => structuredClone(record));
  }

  async createStep(step: AgentStep): Promise<void> {
    this.steps.set(step.stepId, structuredClone(step));
  }

  async getStep(stepId: string): Promise<AgentStep | null> {
    const step = this.steps.get(stepId);
    return step ? structuredClone(step) : null;
  }

  async updateStep(stepId: string, next: AgentStep): Promise<boolean> {
    if (!this.steps.has(stepId)) return false;
    this.steps.set(stepId, structuredClone(next));
    return true;
  }

  async listSteps(runId: string): Promise<AgentStep[]> {
    return [...this.steps.values()]
      .filter(step => step.runId === runId)
      .sort((left, right) => left.index - right.index)
      .map(step => structuredClone(step));
  }

  async appendContextSnapshot(snapshot: AgentContextSnapshot): Promise<void> {
    const list = this.snapshots.get(snapshot.runId) ?? [];
    list.push(structuredClone(snapshot));
    this.snapshots.set(snapshot.runId, list);
  }

  async latestContextSnapshot(runId: string): Promise<AgentContextSnapshot | null> {
    const list = this.snapshots.get(runId);
    return list && list.length > 0 ? structuredClone(list[list.length - 1]!) : null;
  }

  async createApproval(request: AgentApprovalRequest): Promise<void> {
    if (this.approvals.has(request.approvalId)) throw new Error(`Approval 已存在：${request.approvalId}`);
    this.approvals.set(request.approvalId, structuredClone(request));
  }

  async getApproval(approvalId: string): Promise<AgentApprovalRequest | null> {
    const request = this.approvals.get(approvalId);
    return request ? structuredClone(request) : null;
  }

  async updateApproval(approvalId: string, next: AgentApprovalRequest): Promise<boolean> {
    const current = this.approvals.get(approvalId);
    if (!current || current.state !== 'pending' || next.approvalId !== approvalId) return false;
    this.approvals.set(approvalId, structuredClone(next));
    return true;
  }

  async listApprovals(runId: string): Promise<AgentApprovalRequest[]> {
    return [...this.approvals.values()]
      .filter(request => request.runId === runId)
      .map(request => structuredClone(request));
  }
}

export type { AgentApprovalState };
