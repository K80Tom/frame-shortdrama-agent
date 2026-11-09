import type { PostgresDatabase } from '../db/client';
import {
  assertPaidGenerationReservation,
  PaidGenerationError,
  validatePaidGenerationInput,
  type PaidGenerationInterceptor,
  type PaidGenerationReservation,
  type PaidGenerationReservationStatus,
  type PaidGenerationReserveInput,
} from './paid-generation';

interface ReservationRow {
  id: string;
  workspace_id: string;
  operation_key: string;
  provider: string;
  model: string;
  estimate_micros: string | number;
  actual_micros: string | number | null;
  currency: string;
  budget_limit_micros: string | number;
  run_id: string | null;
  task_id: string | null;
  status: PaidGenerationReservationStatus;
  created_at: Date | string;
}

const toMicros = (value: string | number | null | undefined): number => {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PaidGenerationError(503, 'BUDGET_PERSISTENCE_INVALID', '预算账本包含无效金额。');
  }
  return parsed;
};

function rowToReservation(row: ReservationRow, interceptorId: string): PaidGenerationReservation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    operationKey: row.operation_key,
    provider: row.provider,
    model: row.model,
    estimatedMicros: toMicros(row.estimate_micros),
    actualMicros: row.actual_micros === null ? null : toMicros(row.actual_micros),
    currency: row.currency,
    budgetLimitMicros: toMicros(row.budget_limit_micros),
    runId: row.run_id,
    taskId: row.task_id,
    status: row.status,
    interceptorId,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function persistenceFailure(error: unknown): never {
  if (error instanceof PaidGenerationError) throw error;
  const code = (error as { code?: string } | null)?.code;
  if (code === '23505') {
    throw new PaidGenerationError(409, 'BUDGET_RESERVATION_CONFLICT', '同一 operationKey 已存在预算预留。');
  }
  throw new PaidGenerationError(503, 'BUDGET_PERSISTENCE_UNAVAILABLE',
    '预算账本暂时不可用；不能在没有预留凭证的情况下调用付费模型。');
}

/**
 * PostgreSQL budget ledger. A reservation row is created inside one transaction
 * under an advisory lock; only the transaction that inserted the row may spend.
 * The unique (workspace_id, operation_key) constraint is the second line of
 * defence against two app instances racing the same business operation.
 */
export class PostgresPaidGenerationInterceptor implements PaidGenerationInterceptor {
  readonly id: string;
  constructor(private readonly database: PostgresDatabase,
    options: { id?: string } = {}) {
    this.id = options.id ?? `postgres-budget-${database.constructor.name}`;
  }

  async reserve(raw: PaidGenerationReserveInput): Promise<PaidGenerationReservation> {
    const input = validatePaidGenerationInput(raw);
    try {
      return await this.database.transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`lyra:model-generation-budget:${input.workspaceId}:${input.operationKey}`]);
        const existing = await client.query<ReservationRow>(`SELECT id, workspace_id, operation_key, provider, model,
          estimate_micros, actual_micros, currency, budget_limit_micros, run_id, task_id, status, created_at
          FROM model_generation_budget_reservations
          WHERE workspace_id=$1 AND operation_key=$2`, [input.workspaceId, input.operationKey]);
        if (existing.rows[0]) {
          const row = existing.rows[0];
          if (row.provider !== input.provider || row.model !== input.model
            || toMicros(row.estimate_micros) !== input.estimateMicros || row.currency !== input.currency
            || toMicros(row.budget_limit_micros) !== input.budgetLimitMicros) {
            throw new PaidGenerationError(409, 'BUDGET_RESERVATION_CONFLICT', '同一 operationKey 已用于另一笔预算。');
          }
          return rowToReservation(row, this.id);
        }
        const totals = await client.query<{ open_micros: string; committed_micros: string }>(`SELECT
          COALESCE(SUM(estimate_micros) FILTER (WHERE status IN ('reserved','unknown')), 0)::text AS open_micros,
          COALESCE(SUM(actual_micros) FILTER (WHERE status='committed'), 0)::text AS committed_micros
          FROM model_generation_budget_reservations WHERE workspace_id=$1`, [input.workspaceId]);
        const open = toMicros(totals.rows[0]?.open_micros);
        const committed = toMicros(totals.rows[0]?.committed_micros);
        const available = input.budgetLimitMicros - open - committed;
        if (available < input.estimateMicros) {
          throw new PaidGenerationError(402, 'BUDGET_EXCEEDED', '本次模型生成的预留金额超过 Lyra 已授权预算。');
        }
        const id = `pgbudget_${input.workspaceId.slice(-8)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        const inserted = await client.query<ReservationRow>(`INSERT INTO model_generation_budget_reservations
          (workspace_id, id, operation_key, provider, model, estimate_micros, actual_micros, currency,
           budget_limit_micros, run_id, task_id, status)
          VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10,'reserved')
          RETURNING id, workspace_id, operation_key, provider, model, estimate_micros, actual_micros, currency,
            budget_limit_micros, run_id, task_id, status, created_at`,
        [input.workspaceId, id, input.operationKey, input.provider, input.model, input.estimateMicros,
          input.currency, input.budgetLimitMicros, input.runId, input.taskId]);
        return rowToReservation(inserted.rows[0]!, this.id);
      });
    } catch (error) { return persistenceFailure(error); }
  }

  async commit(raw: PaidGenerationReservation, actualMicros: number): Promise<PaidGenerationReservation> {
    const reservation = assertOwned(this.id, raw);
    if (reservation.status !== 'reserved' && reservation.status !== 'unknown') {
      throw new PaidGenerationError(409, 'BUDGET_SETTLEMENT_CONFLICT', '预算预留已结算，不能重复扣费。');
    }
    if (!Number.isSafeInteger(actualMicros) || actualMicros < 0 || actualMicros > reservation.estimatedMicros) {
      throw new PaidGenerationError(409, 'BUDGET_ACTUAL_COST_UNAUTHORIZED', '供应商实际费用超过预算预留上限。');
    }
    try {
      return await this.database.transaction(async client => {
        const updated = await client.query<ReservationRow>(`UPDATE model_generation_budget_reservations
          SET status='committed', actual_micros=$4, updated_at=now()
          WHERE workspace_id=$1 AND operation_key=$2 AND id=$3 AND status IN ('reserved','unknown')
          RETURNING id, workspace_id, operation_key, provider, model, estimate_micros, actual_micros, currency,
            budget_limit_micros, run_id, task_id, status, created_at`,
        [reservation.workspaceId, reservation.operationKey, reservation.id, actualMicros]);
        if (!updated.rows[0]) {
          throw new PaidGenerationError(409, 'BUDGET_SETTLEMENT_CONFLICT', '预算预留已被其他操作结算。');
        }
        return rowToReservation(updated.rows[0], this.id);
      });
    } catch (error) { return persistenceFailure(error); }
  }

  async release(raw: PaidGenerationReservation, reason: string): Promise<PaidGenerationReservation> {
    const reservation = assertOwned(this.id, raw);
    try {
      return await this.database.transaction(async client => {
        const updated = await client.query<ReservationRow>(`UPDATE model_generation_budget_reservations
          SET status='released', failure_reason=$4, updated_at=now()
          WHERE workspace_id=$1 AND operation_key=$2 AND id=$3 AND status IN ('reserved','unknown')
          RETURNING id, workspace_id, operation_key, provider, model, estimate_micros, actual_micros, currency,
            budget_limit_micros, run_id, task_id, status, created_at`,
        [reservation.workspaceId, reservation.operationKey, reservation.id, sanitizeReason(reason)]);
        if (!updated.rows[0]) {
          throw new PaidGenerationError(409, 'BUDGET_SETTLEMENT_CONFLICT', '预算预留已扣费或已被释放，不能重复释放。');
        }
        return rowToReservation(updated.rows[0], this.id);
      });
    } catch (error) { return persistenceFailure(error); }
  }

  async markUnknown(raw: PaidGenerationReservation, reason: string): Promise<PaidGenerationReservation> {
    const reservation = assertOwned(this.id, raw);
    try {
      return await this.database.transaction(async client => {
        const updated = await client.query<ReservationRow>(`UPDATE model_generation_budget_reservations
          SET status='unknown', failure_reason=$4, updated_at=now()
          WHERE workspace_id=$1 AND operation_key=$2 AND id=$3 AND status='reserved'
          RETURNING id, workspace_id, operation_key, provider, model, estimate_micros, actual_micros, currency,
            budget_limit_micros, run_id, task_id, status, created_at`,
        [reservation.workspaceId, reservation.operationKey, reservation.id, sanitizeReason(reason)]);
        if (!updated.rows[0]) {
          throw new PaidGenerationError(409, 'BUDGET_SETTLEMENT_CONFLICT', '预算预留已结算，不能再次标记为不明。');
        }
        return rowToReservation(updated.rows[0], this.id);
      });
    } catch (error) { return persistenceFailure(error); }
  }
}

function assertOwned(interceptorId: string, reservation: PaidGenerationReservation): PaidGenerationReservation {
  if (!reservation || reservation.interceptorId !== interceptorId) {
    throw new PaidGenerationError(402, 'BUDGET_RESERVATION_REQUIRED', '预算预留凭证不属于当前账本。');
  }
  return reservation;
}

function sanitizeReason(reason: string): string {
  const value = String(reason).replace(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, ' ').trim();
  return value.slice(0, 300);
}

export { assertPaidGenerationReservation };
