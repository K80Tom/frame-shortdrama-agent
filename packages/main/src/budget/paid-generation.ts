import { randomBytes } from 'node:crypto';

/**
 * Lyra paid-generation interceptor.
 *
 * Every real model submission (commercial video, ComfyUI paid execution and TTS)
 * must obtain one reservation from this port *before* the network call. The
 * reservation is keyed by (workspaceId, operationKey) so a retry cannot open a
 * second hold for the same business operation. A definite provider failure
 * releases the hold; an uncertain submission remains `unknown` (never auto
 * resent) and keeps the budget reserved for reconciliation.
 */

export class PaidGenerationError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'PaidGenerationError';
  }
}

export type PaidGenerationReservationStatus = 'reserved' | 'committed' | 'unknown' | 'released';

export interface PaidGenerationReserveInput {
  workspaceId: string;
  operationKey: string;
  provider: string;
  model: string;
  estimateMicros: number;
  currency: string;
  /** The budget ceiling the caller is authorized to spend for this operation. */
  budgetLimitMicros: number;
  runId?: string | null;
  taskId?: string | null;
}

export interface PaidGenerationReservation {
  id: string;
  workspaceId: string;
  operationKey: string;
  provider: string;
  model: string;
  estimatedMicros: number;
  /** Set only after a committed settlement; null while open. */
  actualMicros?: number | null;
  currency: string;
  budgetLimitMicros: number;
  runId: string | null;
  taskId: string | null;
  status: PaidGenerationReservationStatus;
  /** Internal brand so an arbitrary object cannot be passed as a permit. */
  interceptorId: string;
  createdAt: string;
}

export interface PaidGenerationInterceptor {
  readonly id: string;
  reserve(input: PaidGenerationReserveInput): Promise<PaidGenerationReservation>;
  commit(reservation: PaidGenerationReservation, actualMicros: number): Promise<PaidGenerationReservation>;
  release(reservation: PaidGenerationReservation, reason: string): Promise<PaidGenerationReservation>;
  /** Network/provider failure where the request may have been accepted. */
  markUnknown(reservation: PaidGenerationReservation, reason: string): Promise<PaidGenerationReservation>;
}

export interface PaidGenerationSettlement {
  state: 'succeeded' | 'failed' | 'unknown';
  actualMicros?: number;
  reason?: string;
}

const WORKSPACE = /^ws_[a-f0-9]{32}$/u;
const OPERATION = /^[A-Za-z0-9_.:-]{1,160}$/u;
const PROVIDER = /^[A-Za-z0-9_.:-]{1,80}$/u;
const CURRENCY = /^[A-Z]{3}$/u;

function invalid(message: string): never {
  throw new PaidGenerationError(400, 'BUDGET_REQUEST_INVALID', message);
}

function boundedText(value: string, max: number): string {
  if (value.length > max || /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) invalid('预算备注包含非法控制字符。');
  return value;
}

export function validatePaidGenerationInput(input: PaidGenerationReserveInput): PaidGenerationReserveInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('预算预留请求格式无效。');
  if (typeof input.workspaceId !== 'string' || !WORKSPACE.test(input.workspaceId)) invalid('预算预留缺少有效工作区。');
  if (typeof input.operationKey !== 'string' || !OPERATION.test(input.operationKey)) invalid('预算预留缺少有效 operationKey。');
  if (typeof input.provider !== 'string' || !PROVIDER.test(input.provider)) invalid('预算预留缺少有效供应商。');
  if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200
    || /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(input.model)) invalid('预算预留缺少有效模型。');
  if (!Number.isSafeInteger(input.estimateMicros) || input.estimateMicros < 0 || input.estimateMicros > 1_000_000_000_000) {
    invalid('预算预留金额无效。');
  }
  if (!Number.isSafeInteger(input.budgetLimitMicros) || input.budgetLimitMicros < 0
    || input.budgetLimitMicros > 1_000_000_000_000) invalid('预算上限无效。');
  if (typeof input.currency !== 'string' || !CURRENCY.test(input.currency)) invalid('预算币种无效。');
  if (input.runId !== undefined && input.runId !== null
    && (typeof input.runId !== 'string' || input.runId.length > 160)) invalid('预算关联运行无效。');
  if (input.taskId !== undefined && input.taskId !== null
    && (typeof input.taskId !== 'string' || input.taskId.length > 160)) invalid('预算关联任务无效。');
  return {
    ...input,
    runId: input.runId ?? null,
    taskId: input.taskId ?? null,
  };
}

export function assertPaidGenerationReservation(interceptor: PaidGenerationInterceptor,
  reservation: PaidGenerationReservation,
  expected: Pick<PaidGenerationReserveInput, 'workspaceId' | 'operationKey' | 'provider' | 'model' | 'estimateMicros' | 'currency'>): void {
  if (!reservation || typeof reservation !== 'object' || reservation.interceptorId !== interceptor.id) {
    throw new PaidGenerationError(402, 'BUDGET_RESERVATION_REQUIRED', '没有 Lyra 预算预留凭证，禁止调用付费模型。');
  }
  if (reservation.status !== 'reserved') {
    throw new PaidGenerationError(409, 'BUDGET_RESERVATION_NOT_OPEN',
      `预算预留当前为 ${reservation.status}，禁止重复提交付费模型。`);
  }
  for (const key of ['workspaceId', 'operationKey', 'provider', 'model', 'currency'] as const) {
    if (reservation[key] !== expected[key]) {
      throw new PaidGenerationError(409, 'BUDGET_RESERVATION_MISMATCH', '预算预留与本次供应商请求不一致，禁止提交。');
    }
  }
  if (reservation.estimatedMicros !== expected.estimateMicros) {
    throw new PaidGenerationError(409, 'BUDGET_RESERVATION_MISMATCH', '预算预留与本次供应商请求不一致，禁止提交。');
  }
}

/** Test/worker-local implementation. Production uses the PostgreSQL ledger. */
export class InMemoryPaidGenerationInterceptor implements PaidGenerationInterceptor {
  readonly id = `memory-budget-${randomBytes(8).toString('hex')}`;
  private readonly reservations = new Map<string, PaidGenerationReservation>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) { this.now = options.now ?? (() => new Date()); }

  private key(workspaceId: string, operationKey: string) { return `${workspaceId}\u0000${operationKey}`; }

  private committedMicros(workspaceId: string): number {
    return [...this.reservations.values()].filter(item => item.workspaceId === workspaceId && item.status === 'committed')
      .reduce((sum, item) => sum + (this.actual.get(item.id) ?? 0), 0);
  }

  private openMicros(workspaceId: string): number {
    return [...this.reservations.values()].filter(item => item.workspaceId === workspaceId
      && (item.status === 'reserved' || item.status === 'unknown'))
      .reduce((sum, item) => sum + item.estimatedMicros, 0);
  }

  private actual = new Map<string, number>();

  async reserve(raw: PaidGenerationReserveInput): Promise<PaidGenerationReservation> {
    const input = validatePaidGenerationInput(raw);
    const key = this.key(input.workspaceId, input.operationKey);
    const existing = this.reservations.get(key);
    if (existing) {
      if (existing.provider !== input.provider || existing.model !== input.model
        || existing.estimatedMicros !== input.estimateMicros || existing.currency !== input.currency
        || existing.budgetLimitMicros !== input.budgetLimitMicros) {
        throw new PaidGenerationError(409, 'BUDGET_RESERVATION_CONFLICT', '同一 operationKey 已用于另一笔预算。');
      }
      return { ...existing };
    }
    const committed = this.committedMicros(input.workspaceId);
    const available = input.budgetLimitMicros - committed - this.openMicros(input.workspaceId);
    if (!Number.isSafeInteger(available) || available < input.estimateMicros) {
      throw new PaidGenerationError(402, 'BUDGET_EXCEEDED', '本次模型生成的预留金额超过 Lyra 已授权预算。');
    }
    const reservation: PaidGenerationReservation = {
      id: `pgbudget_${randomBytes(16).toString('hex')}`,
      workspaceId: input.workspaceId,
      operationKey: input.operationKey,
      provider: input.provider,
      model: input.model,
      estimatedMicros: input.estimateMicros,
      currency: input.currency,
      budgetLimitMicros: input.budgetLimitMicros,
      runId: input.runId ?? null,
      taskId: input.taskId ?? null,
      status: 'reserved',
      interceptorId: this.id,
      createdAt: this.now().toISOString(),
    };
    this.reservations.set(key, reservation);
    return { ...reservation };
  }

  private owned(reservation: PaidGenerationReservation): PaidGenerationReservation {
    if (!reservation || reservation.interceptorId !== this.id) {
      throw new PaidGenerationError(402, 'BUDGET_RESERVATION_REQUIRED', '预算预留凭证不属于当前拦截器。');
    }
    const found = this.reservations.get(this.key(reservation.workspaceId, reservation.operationKey));
    if (!found || found.id !== reservation.id) {
      throw new PaidGenerationError(409, 'BUDGET_RESERVATION_UNKNOWN', '预算预留不存在或已失效。');
    }
    return found;
  }

  async commit(raw: PaidGenerationReservation, actualMicros: number): Promise<PaidGenerationReservation> {
    const reservation = this.owned(raw);
    if (reservation.status !== 'reserved' && reservation.status !== 'unknown') {
      throw new PaidGenerationError(409, 'BUDGET_SETTLEMENT_CONFLICT', '预算预留已结算，不能重复扣费。');
    }
    if (!Number.isSafeInteger(actualMicros) || actualMicros < 0 || actualMicros > reservation.estimatedMicros) {
      throw new PaidGenerationError(409, 'BUDGET_ACTUAL_COST_UNAUTHORIZED', '供应商实际费用超过预算预留上限。');
    }
    reservation.status = 'committed';
    this.actual.set(reservation.id, actualMicros);
    return { ...reservation, actualMicros };
  }

  async release(raw: PaidGenerationReservation, reason: string): Promise<PaidGenerationReservation> {
    const reservation = this.owned(raw);
    if (reservation.status === 'committed') throw new PaidGenerationError(409, 'BUDGET_SETTLEMENT_CONFLICT', '已扣费预留不能释放。');
    if (reservation.status !== 'released') reservation.status = 'released';
    void boundedText(reason, 300);
    return { ...reservation };
  }

  async markUnknown(raw: PaidGenerationReservation, reason: string): Promise<PaidGenerationReservation> {
    const reservation = this.owned(raw);
    if (reservation.status === 'committed') throw new PaidGenerationError(409, 'BUDGET_SETTLEMENT_CONFLICT', '已扣费预留不能标记 unknown。');
    if (reservation.status === 'reserved') reservation.status = 'unknown';
    void boundedText(reason, 300);
    return { ...reservation };
  }
}

export function settlementForFailure(status: number | null): PaidGenerationSettlement {
  if (status === null) return { state: 'unknown', reason: '供应商网络结果不明，保留预算预留等待对账。' };
  if (status >= 500 || status === 408 || status === 429) {
    return { state: 'unknown', reason: `供应商返回 HTTP ${status}，提交结果不明。` };
  }
  return { state: 'failed', reason: `供应商明确拒绝请求（HTTP ${status}），释放预算预留。` };
}
