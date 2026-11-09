import { OWNER_INSTANCE_ID_PATTERN, RuntimeWorkerError,
  type RuntimeWorkerRole, type WorkerLeaseSnapshot, type WorkerLeaseStore } from './contracts';
import type { RedisLeaseLock } from './redis-lease';

export interface WorkerInstanceLeaseManagerOptions {
  readonly ownerInstanceId: string;
  readonly role: RuntimeWorkerRole;
  /** 租约时长；心跳按其约 1/3 自动推导，可用 heartbeatIntervalMs 覆盖。 */
  readonly leaseMs: number;
  readonly heartbeatIntervalMs?: number;
  readonly store: WorkerLeaseStore;
  /** 可选的 Redis 快速互斥锁；缺失或故障时回退为 PostgreSQL 单一权威。 */
  readonly lock?: RedisLeaseLock;
  readonly now?: () => string;
}

/**
 * Worker 实例租约管理器。
 *
 * acquire → 心跳续约（fencing_token 不变）→ 释放 的生命周期封装：
 * - 同 role 存在未过期 active 租约时 acquire 返回 LEASE_HELD_BY_OTHER；
 * - active 租约过期后允许接管，fencing_token 单调 +1，旧实例此后的一切
 *   续约与写入都会被 fencing/状态校验拒绝；
 * - Redis 锁只是同 role 互斥的快速路径，失败不阻断 PostgreSQL 权威流程。
 */
export class WorkerInstanceLeaseManager {
  readonly ownerInstanceId: string;
  readonly role: RuntimeWorkerRole;
  readonly leaseMs: number;
  readonly heartbeatIntervalMs: number;
  private current: WorkerLeaseSnapshot | null = null;

  constructor(private readonly options: WorkerInstanceLeaseManagerOptions) {
    if (!OWNER_INSTANCE_ID_PATTERN.test(options.ownerInstanceId)) {
      throw new RuntimeWorkerError('LEASE_CONFIG_INVALID', 'owner_instance_id 格式无效。');
    }
    if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 5_000 || options.leaseMs > 3_600_000) {
      throw new RuntimeWorkerError('LEASE_CONFIG_INVALID', '租约时长必须在 5 秒到 1 小时之间。');
    }
    const heartbeat = options.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(options.leaseMs / 3));
    if (!Number.isSafeInteger(heartbeat) || heartbeat < 1_000 || heartbeat >= options.leaseMs) {
      throw new RuntimeWorkerError('LEASE_CONFIG_INVALID', '心跳间隔必须小于租约时长。');
    }
    this.ownerInstanceId = options.ownerInstanceId;
    this.role = options.role;
    this.leaseMs = options.leaseMs;
    this.heartbeatIntervalMs = heartbeat;
  }

  get snapshot(): WorkerLeaseSnapshot | null {
    return this.current;
  }

  get fencingToken(): number | null {
    return this.current?.fencingToken ?? null;
  }

  /** 阻塞获取租约；同 role 已有存活持有者时抛 LEASE_HELD_BY_OTHER。 */
  async acquire(): Promise<WorkerLeaseSnapshot> {
    if (this.current?.state === 'active'
      && Date.parse(this.current.leaseExpiresAt) > Date.parse(this.options.now?.() ?? new Date().toISOString())) {
      throw new RuntimeWorkerError('LEASE_NOT_ACTIVE', '本实例已持有租约，禁止重复获取。');
    }
    const snapshot = await this.options.store.acquire({
      ownerInstanceId: this.ownerInstanceId, role: this.role, leaseMs: this.leaseMs,
      now: this.options.now?.() ?? new Date().toISOString(),
    });
    if (!snapshot) throw new RuntimeWorkerError('LEASE_HELD_BY_OTHER', `角色 ${this.role} 已有其他实例持有租约。`);
    this.current = snapshot;
    if (this.options.lock) {
      const fastPath = await this.options.lock.tryAcquire(this.ownerInstanceId, this.leaseMs)
        .catch(() => false);
      if (!fastPath) {
        // Redis 里可能残留已崩溃实例的锁（PG 权威租约已过期）。锁 TTL 到期
        // 前清除一次；仍失败也不影响正确性，只损失快速互斥。
        await this.options.lock.forceDelete().catch(() => undefined);
        await this.options.lock.tryAcquire(this.ownerInstanceId, this.leaseMs).catch(() => false);
      }
    }
    return snapshot;
  }

  /** 心跳续约；租约丢失/被抢占时抛出对应错误（fencing_token 不变）。 */
  async renew(): Promise<WorkerLeaseSnapshot> {
    const snapshot = await this.options.store.renew({
      ownerInstanceId: this.ownerInstanceId, role: this.role, leaseMs: this.leaseMs,
      now: this.options.now?.() ?? new Date().toISOString(),
    });
    this.current = snapshot;
    if (this.options.lock) {
      await this.options.lock.renew(this.ownerInstanceId, this.leaseMs).catch(() => false);
    }
    return snapshot;
  }

  /** 优雅停机：释放 PG 租约与 Redis 锁（幂等，未持有时为无操作）。 */
  async release(): Promise<void> {
    await this.options.store.release({
      ownerInstanceId: this.ownerInstanceId, role: this.role,
      now: this.options.now?.() ?? new Date().toISOString(),
    }).catch(error => {
      if (error instanceof RuntimeWorkerError && error.code === 'LEASE_STORE_UNAVAILABLE') throw error;
      return undefined;
    });
    if (this.options.lock) {
      await this.options.lock.release(this.ownerInstanceId).catch(() => false);
    }
    this.current = null;
  }
}
