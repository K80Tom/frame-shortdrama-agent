import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';

/**
 * 046 model_generation_calls 台账端口：记录供应商任务号（unknown 对账锚点）与终态。
 * 语义：handler 在 submit 成功后第一时间落 provider_task_id；崩溃后重投时
 * 以 operation_key 找回任务号续查，绝不二次提交。
 */
export interface ModelGenerationCallEntry {
  callId: string;
  operationKey: string;
  provider: string;
  model: string;
  promptDigest: string;
  controlInputDigest?: string | null;
  reservationId?: string | null;
  providerTaskId?: string | null;
}

export interface ModelGenerationAudit {
  /** 找回该 operation 最近一次已提交的供应商任务号（无则 null）。 */
  findProviderTaskId(workspaceId: string, operationKey: string): Promise<string | null>;
  /** 按任务号找回当时的台账行 id（恢复路径用于补写终态）。 */
  findCallId(workspaceId: string, operationKey: string, providerTaskId: string): Promise<string | null>;
  recordSubmitted(workspaceId: string, entry: ModelGenerationCallEntry): Promise<void>;
  recordCompleted(workspaceId: string, callId: string, providerTaskId: string,
    costMicros?: number | null): Promise<void>;
  recordFailed(workspaceId: string, callId: string, errorCode: string): Promise<void>;
}

export function newModelGenerationCallId(random: (size: number) => Buffer = randomBytes): string {
  return `mgcall_${random(8).toString('hex')}`;
}

export function promptDigestOf(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

export class InMemoryModelGenerationAudit implements ModelGenerationAudit {
  readonly rows: Array<Record<string, unknown>> = [];

  async findProviderTaskId(workspaceId: string, operationKey: string): Promise<string | null> {
    const found = this.rows.filter(row => row.workspaceId === workspaceId && row.operationKey === operationKey
      && typeof row.providerTaskId === 'string');
    const last = found.at(-1);
    return last ? String(last.providerTaskId) : null;
  }

  async findCallId(workspaceId: string, operationKey: string, providerTaskId: string): Promise<string | null> {
    const found = this.rows.filter(row => row.workspaceId === workspaceId && row.operationKey === operationKey
      && row.providerTaskId === providerTaskId);
    const last = found.at(-1);
    return last ? String(last.callId) : null;
  }

  async recordSubmitted(workspaceId: string, entry: ModelGenerationCallEntry): Promise<void> {
    const existing = this.rows.find(row => row.workspaceId === workspaceId && row.callId === entry.callId);
    if (existing) return;
    this.rows.push({ ...entry, workspaceId, status: 'submitted', costMicros: null,
      errorCode: null, createdAt: new Date().toISOString() });
  }

  async recordCompleted(workspaceId: string, callId: string, providerTaskId: string,
    costMicros?: number | null): Promise<void> {
    const row = this.rows.find(item => item.workspaceId === workspaceId && item.callId === callId);
    if (!row) throw new Error(`model_generation_calls 缺少 ${callId} 的提交记录。`);
    row.status = 'completed';
    row.providerTaskId = providerTaskId;
    row.costMicros = costMicros ?? null;
  }

  async recordFailed(workspaceId: string, callId: string, errorCode: string): Promise<void> {
    const row = this.rows.find(item => item.workspaceId === workspaceId && item.callId === callId);
    if (!row) throw new Error(`model_generation_calls 缺少 ${callId} 的提交记录。`);
    row.status = 'failed';
    row.errorCode = errorCode;
  }
}

type Queryable = Pick<PoolClient, 'query'>;

export class PostgresModelGenerationAudit implements ModelGenerationAudit {
  constructor(private readonly database: Queryable) {}

  async findProviderTaskId(workspaceId: string, operationKey: string): Promise<string | null> {
    const result = await this.database.query<{ provider_task_id: string | null }>(
      `SELECT provider_task_id FROM model_generation_calls
       WHERE workspace_id = $1 AND operation_key = $2 AND provider_task_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`, [workspaceId, operationKey]);
    return result.rows[0]?.provider_task_id ?? null;
  }

  async findCallId(workspaceId: string, operationKey: string, providerTaskId: string): Promise<string | null> {
    const result = await this.database.query<{ id: string }>(
      `SELECT id FROM model_generation_calls
       WHERE workspace_id = $1 AND operation_key = $2 AND provider_task_id = $3
       ORDER BY created_at DESC LIMIT 1`, [workspaceId, operationKey, providerTaskId]);
    return result.rows[0]?.id ?? null;
  }

  async recordSubmitted(workspaceId: string, entry: ModelGenerationCallEntry): Promise<void> {
    await this.database.query(
      `INSERT INTO model_generation_calls (workspace_id, id, operation_key, provider, model,
         prompt_digest, control_input_digest, reservation_id, provider_task_id, status,
         created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'submitted', now(), now())
       ON CONFLICT (workspace_id, id) DO NOTHING`,
      [workspaceId, entry.callId, entry.operationKey, entry.provider, entry.model,
        entry.promptDigest, entry.controlInputDigest ?? null, entry.reservationId ?? null,
        entry.providerTaskId ?? null]);
  }

  async recordCompleted(workspaceId: string, callId: string, providerTaskId: string,
    costMicros?: number | null): Promise<void> {
    await this.database.query(
      `UPDATE model_generation_calls SET status = 'completed', provider_task_id = $3,
         cost_micros = COALESCE($4, cost_micros), updated_at = now()
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, callId, providerTaskId, costMicros ?? null]);
  }

  async recordFailed(workspaceId: string, callId: string, errorCode: string): Promise<void> {
    await this.database.query(
      `UPDATE model_generation_calls SET status = 'failed', error_code = $3, updated_at = now()
       WHERE workspace_id = $1 AND id = $2`, [workspaceId, callId, errorCode]);
  }
}
