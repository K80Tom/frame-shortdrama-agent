import { RuntimeWorkerError } from './contracts';

export interface WorkerRuntimeOptionsConfig {
  readonly leaseMs: number;
  readonly heartbeatIntervalMs: number;
  readonly outbox: {
    readonly batchSize: number;
    readonly pollIntervalMs: number;
    readonly retryBaseMs: number;
    readonly maxAttempts: number;
  };
}

function integer(name: string, fallback: number, min: number, max: number, raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RuntimeWorkerError('LEASE_CONFIG_INVALID', `${name} 必须是 ${min}-${max} 之间的整数。`);
  }
  return value;
}

/**
 * 解析 Worker 运行时环境变量（启动期校验，配置错误直接抛错拒绝启动）。
 */
export function readWorkerRuntimeOptions(env: NodeJS.ProcessEnv): WorkerRuntimeOptionsConfig {
  const leaseMs = integer('LYRA_WORKER_LEASE_MS', 30_000, 5_000, 3_600_000, env.LYRA_WORKER_LEASE_MS);
  const heartbeatIntervalMs = env.LYRA_WORKER_HEARTBEAT_MS?.trim()
    ? integer('LYRA_WORKER_HEARTBEAT_MS', Math.floor(leaseMs / 3), 1_000, leaseMs - 1, env.LYRA_WORKER_HEARTBEAT_MS)
    : Math.max(1_000, Math.floor(leaseMs / 3));
  return {
    leaseMs,
    heartbeatIntervalMs,
    outbox: {
      batchSize: integer('LYRA_OUTBOX_BATCH_SIZE', 20, 1, 200, env.LYRA_OUTBOX_BATCH_SIZE),
      pollIntervalMs: integer('LYRA_OUTBOX_POLL_MS', 750, 50, 60_000, env.LYRA_OUTBOX_POLL_MS),
      retryBaseMs: integer('LYRA_OUTBOX_RETRY_BASE_MS', 2_000, 100, 300_000, env.LYRA_OUTBOX_RETRY_BASE_MS),
      maxAttempts: integer('LYRA_OUTBOX_MAX_ATTEMPTS', 5, 1, 100, env.LYRA_OUTBOX_MAX_ATTEMPTS),
    },
  };
}
