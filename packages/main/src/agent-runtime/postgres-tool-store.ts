import {
  AgentContractError,
  type ToolInvocationRecord,
} from '@lyra/shared';
import type { BudgetLedger, BudgetReservation, ToolAttemptRecord, ToolInvocationStore } from '@lyra/agent';
import type { PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import type { PostgresDatabase } from '../db/client';

/**
 * ToolInvocationStore + BudgetLedger 的 PostgreSQL 实现（迁移 039）。
 * 预算与工具调用都使用行锁/CAS；任何“余额不足”都是显式拒绝，不做静默降级。
 */

interface InvocationRow {
  invocation_id: string; workspace_id: string; run_id: string; step_id: string;
  tool_id: string; tool_version: string; manifest_digest: string; state: ToolInvocationRecord['state'];
  version: number; idempotency_key: string; proposal_json: ToolInvocationRecord['proposal'];
  attempt_count: number; approval_request_id: string | null;
  result_json: ToolInvocationRecord['result'] | null; created_at: Date | string; updated_at: Date | string;
}

const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const invocationOf = (row: InvocationRow): ToolInvocationRecord => ({
  invocationId: row.invocation_id,
  workspaceId: row.workspace_id,
  agentRunId: row.run_id,
  stepId: row.step_id,
  tool: { toolId: row.tool_id, version: row.tool_version, manifestDigest: row.manifest_digest },
  state: row.state,
  version: Number(row.version),
  idempotencyKey: row.idempotency_key,
  proposal: row.proposal_json,
  attemptCount: Number(row.attempt_count),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  ...(row.approval_request_id ? { approvalRequestId: row.approval_request_id } : {}),
  ...(row.result_json ? { result: row.result_json } : {}),
});

export class PostgresToolInvocationStore implements ToolInvocationStore {
  constructor(private readonly database: PostgresDatabase) {}

  async create(record: ToolInvocationRecord): Promise<void> {
    try {
      await this.database.query(`
        INSERT INTO agent_tool_invocations (
          invocation_id, workspace_id, run_id, step_id, tool_id, tool_version, manifest_digest,
          state, version, idempotency_key, proposal_json, attempt_count, approval_request_id,
          result_json, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14::jsonb,$15,$16)
      `, [
        record.invocationId, record.workspaceId, record.agentRunId, record.stepId,
        record.tool.toolId, record.tool.version, record.tool.manifestDigest, record.state, record.version,
        record.idempotencyKey, JSON.stringify(record.proposal), record.attemptCount,
        record.approvalRequestId ?? null, record.result ? JSON.stringify(record.result) : null,
        record.createdAt, record.updatedAt,
      ]);
    } catch (error) {
      throw pgError(error, 'AGENT_TOOL_INVOCATION_EXISTS', '工具调用记录已存在或参数不合法。');
    }
  }

  async get(invocationId: string): Promise<ToolInvocationRecord | undefined> {
    const result = await this.database.query<InvocationRow>(`
      SELECT * FROM agent_tool_invocations WHERE invocation_id = $1
    `, [invocationId]);
    return result.rows[0] ? invocationOf(result.rows[0]) : undefined;
  }

  async update(expectedVersion: number, next: ToolInvocationRecord): Promise<boolean> {
    const result = await this.database.query(`
      UPDATE agent_tool_invocations SET
        state = $3, version = $4, attempt_count = $5, approval_request_id = $6,
        result_json = $7::jsonb, updated_at = $8
      WHERE workspace_id = $9 AND invocation_id = $1 AND version = $2
    `, [
      next.invocationId, expectedVersion, next.state, next.version, next.attemptCount,
      next.approvalRequestId ?? null, next.result ? JSON.stringify(next.result) : null,
      next.updatedAt, next.workspaceId,
    ]);
    return result.rowCount === 1;
  }

  async findByIdempotencyKey(workspaceId: string, key: string): Promise<ToolInvocationRecord | undefined> {
    const result = await this.database.query<InvocationRow>(`
      SELECT * FROM agent_tool_invocations WHERE workspace_id = $1 AND idempotency_key = $2
      ORDER BY created_at DESC LIMIT 1
    `, [workspaceId, key]);
    return result.rows[0] ? invocationOf(result.rows[0]) : undefined;
  }

  async listByRun(runId: string): Promise<ToolInvocationRecord[]> {
    const result = await this.database.query<InvocationRow>(`
      SELECT * FROM agent_tool_invocations WHERE run_id = $1 ORDER BY created_at, invocation_id
    `, [runId]);
    return result.rows.map(invocationOf);
  }

  async appendAttempt(attempt: ToolAttemptRecord): Promise<void> {
    const invocation = await this.get(attempt.invocationId);
    if (!invocation) throw new AgentContractError(404, 'AGENT_TOOL_INVOCATION_NOT_FOUND', '工具调用记录不存在。');
    await this.database.query(`
      INSERT INTO agent_tool_attempts (
        attempt_id, workspace_id, invocation_id, attempt_number, state, started_at, ended_at, reason_code, summary
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [attempt.attemptId, invocation.workspaceId, attempt.invocationId, attempt.attemptNumber,
      attempt.state, attempt.startedAt, attempt.endedAt ?? null, attempt.reasonCode ?? null, attempt.summary ?? null]);
  }

  async completeAttempt(attemptId: string, patch: Pick<ToolAttemptRecord, 'state' | 'endedAt' | 'reasonCode' | 'summary'>): Promise<void> {
    await this.database.query(`
      UPDATE agent_tool_attempts SET state = $2, ended_at = $3, reason_code = $4, summary = $5
      WHERE attempt_id = $1
    `, [attemptId, patch.state, patch.endedAt ?? null, patch.reasonCode ?? null, patch.summary ?? null]);
  }
}

interface AccountRow { available_micros: string | number; reserved_micros: string | number }
interface ReservationRow {
  reservation_id: string; workspace_id: string; amount_micros: string | number;
  actual_micros: string | number | null; currency: string; state: 'reserved' | 'settled' | 'released';
}

export class PostgresBudgetLedger implements BudgetLedger {
  constructor(private readonly database: PostgresDatabase) {}

  /** 仅在 workspace 首次开通预算时写入初始额度；已存在账户不会被覆盖。 */
  async ensureAccount(workspaceId: string, currency: string, balanceMicros: number): Promise<void> {
    await this.database.query(`
      INSERT INTO agent_budget_accounts (workspace_id, currency, available_micros, reserved_micros, version, updated_at)
      VALUES ($1,$2,$3,0,1,clock_timestamp())
      ON CONFLICT (workspace_id, currency) DO NOTHING
    `, [workspaceId, currency, Math.max(0, Math.trunc(balanceMicros))]);
  }

  async reserve(input: {
    workspaceId: string; agentRunId: string; invocationId: string; amountMicros: number; currency: string;
  }): Promise<BudgetReservation> {
    const amount = Math.max(0, Math.trunc(input.amountMicros));
    return this.database.transaction(async client => {
      // 同一 Invocation 的预留必须串行化；唯一约束只是最后一道防线。
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        input.workspaceId, input.invocationId,
      ]);
      const existing = await client.query<ReservationRow>(`
        SELECT * FROM agent_budget_reservations
        WHERE workspace_id = $1 AND invocation_id = $2 FOR UPDATE
      `, [input.workspaceId, input.invocationId]);
      const previous = existing.rows[0];
      if (previous) {
        if (previous.state !== 'reserved') {
          throw new AgentContractError(409, 'AGENT_BUDGET_RESERVATION_TERMINAL', '该 Invocation 的预算预留已结算或已释放，不能重复预留。');
        }
        const account = await client.query<AccountRow>(`
          SELECT available_micros FROM agent_budget_accounts
          WHERE workspace_id = $1 AND currency = $2
        `, [input.workspaceId, previous.currency]);
        return {
          reservationId: previous.reservation_id,
          amountMicros: Number(previous.amount_micros),
          remainingMicros: Number(account.rows[0]?.available_micros ?? 0),
        };
      }
      const account = await client.query<AccountRow>(`
        SELECT available_micros, reserved_micros FROM agent_budget_accounts
        WHERE workspace_id = $1 AND currency = $2 FOR UPDATE
      `, [input.workspaceId, input.currency]);
      const row = account.rows[0];
      if (!row) throw new AgentContractError(409, 'AGENT_BUDGET_ACCOUNT_MISSING', '预算账户未开通。');
      const available = Number(row.available_micros);
      if (available < amount) throw new AgentContractError(409, 'AGENT_BUDGET_EXCEEDED', '预算不足，已拒绝本次调用。');
      const updated = await client.query<AccountRow>(`
        UPDATE agent_budget_accounts SET
          available_micros = available_micros - $3, reserved_micros = reserved_micros + $3,
          version = version + 1, updated_at = clock_timestamp()
        WHERE workspace_id = $1 AND currency = $2
        RETURNING available_micros, reserved_micros
      `, [input.workspaceId, input.currency, amount]);
      const next = updated.rows[0];
      const reservationId = `res_${randomBytes(12).toString('hex')}`;
      await client.query(`
        INSERT INTO agent_budget_reservations (
          reservation_id, workspace_id, agent_run_id, invocation_id, amount_micros, actual_micros,
          currency, state, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,NULL,$6,'reserved',clock_timestamp(),clock_timestamp())
      `, [reservationId, input.workspaceId, input.agentRunId, input.invocationId, amount, input.currency]);
      return { reservationId, amountMicros: amount, remainingMicros: Number(next?.available_micros ?? 0) };
    });
  }

  async settle(input: { reservationId: string; actualMicros: number }): Promise<void> {
    const actual = Math.max(0, Math.trunc(input.actualMicros));
    await this.database.transaction(async client => {
      const reservation = await client.query<ReservationRow>(`
        SELECT * FROM agent_budget_reservations WHERE reservation_id = $1 FOR UPDATE
      `, [input.reservationId]);
      const row = reservation.rows[0];
      if (!row) throw new AgentContractError(404, 'AGENT_BUDGET_RESERVATION_NOT_FOUND', '预算预留不存在。');
      if (row.state !== 'reserved') throw new AgentContractError(409, 'AGENT_BUDGET_RESERVATION_SETTLED', '预算预留已结算或已释放。');
      const reservedAmount = Number(row.amount_micros);
      const refund = reservedAmount - actual;
      if (refund >= 0) {
        await client.query(`
          UPDATE agent_budget_accounts SET
            available_micros = available_micros + $3, reserved_micros = reserved_micros - $4,
            version = version + 1, updated_at = clock_timestamp()
          WHERE workspace_id = $1 AND currency = $2
        `, [row.workspace_id, row.currency, refund, reservedAmount]);
      } else {
        const extra = -refund;
        const account = await client.query<AccountRow>(`
          SELECT available_micros FROM agent_budget_accounts
          WHERE workspace_id = $1 AND currency = $2 FOR UPDATE
        `, [row.workspace_id, row.currency]);
        if (Number(account.rows[0]?.available_micros ?? 0) < extra) {
          throw new AgentContractError(409, 'AGENT_BUDGET_SETTLEMENT_OVERSPENT', '实际费用超过预留且余额不足。');
        }
        await client.query(`
          UPDATE agent_budget_accounts SET
            available_micros = available_micros - $3, reserved_micros = reserved_micros - $4,
            version = version + 1, updated_at = clock_timestamp()
          WHERE workspace_id = $1 AND currency = $2
        `, [row.workspace_id, row.currency, extra, reservedAmount]);
      }
      await client.query(`
        UPDATE agent_budget_reservations SET state = 'settled', actual_micros = $2, updated_at = clock_timestamp()
        WHERE reservation_id = $1
      `, [input.reservationId, actual]);
    });
  }

  async release(input: { reservationId: string; reason: string }): Promise<void> {
    await this.database.transaction(async client => {
      const reservation = await client.query<ReservationRow>(`
        SELECT * FROM agent_budget_reservations WHERE reservation_id = $1 FOR UPDATE
      `, [input.reservationId]);
      const row = reservation.rows[0];
      // 终态幂等：重复 release 不能重复退款，也不能让清理路径报错后掩盖原始失败。
      if (!row || row.state !== 'reserved') return;
      await this.releaseRow(client, row);
    });
  }

  async releaseForInvocation(input: { workspaceId: string; invocationId: string; reason: string }): Promise<void> {
    await this.database.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        input.workspaceId, input.invocationId,
      ]);
      const reservation = await client.query<ReservationRow>(`
        SELECT * FROM agent_budget_reservations
        WHERE workspace_id = $1 AND invocation_id = $2 FOR UPDATE
      `, [input.workspaceId, input.invocationId]);
      const row = reservation.rows[0];
      if (!row || row.state !== 'reserved') return;
      await this.releaseRow(client, row);
    });
  }

  private async releaseRow(client: PoolClient, row: ReservationRow): Promise<void> {
    const amount = Number(row.amount_micros);
    await client.query(`
      UPDATE agent_budget_accounts SET
        available_micros = available_micros + $3, reserved_micros = reserved_micros - $3,
        version = version + 1, updated_at = clock_timestamp()
      WHERE workspace_id = $1 AND currency = $2
    `, [row.workspace_id, row.currency, amount]);
    await client.query(`
      UPDATE agent_budget_reservations SET state = 'released', updated_at = clock_timestamp()
      WHERE reservation_id = $1
    `, [row.reservation_id]);
  }
}

function pgError(error: unknown, code: string, message: string): AgentContractError {
  if (error instanceof AgentContractError) return error;
  const pgCode = error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
  if (pgCode === '23505') return new AgentContractError(409, code, message);
  return new AgentContractError(500, 'AGENT_PERSISTENCE_ERROR', '工具调用数据写入失败。');
}
