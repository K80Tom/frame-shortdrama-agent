/**
 * Worker 运行时拓扑契约（移植自融光 runtime/async-outbox.worker.ts 的
 * owner_instance_id 租约模型）。
 *
 * PostgreSQL 的 worker_leases 表是租约与 fencing 的权威事实源；
 * Redis 租约锁只做快速互斥优化。同一 role 全局最多一个 active 实例。
 */

export type RuntimeWorkerRole = 'api' | 'worker' | 'all';

export const OWNER_INSTANCE_ID_PATTERN = /^wkri_[a-f0-9]{32}$/u;

export function newOwnerInstanceId(randomBytes: (size: number) => Buffer): string {
  return `wkri_${randomBytes(16).toString('hex')}`;
}

export type WorkerLeaseState = 'active' | 'released' | 'preempted';
export type WorkerLeaseEventType = 'acquired' | 'renewed' | 'released' | 'preempted';

export interface WorkerLeaseSnapshot {
  readonly ownerInstanceId: string;
  readonly role: RuntimeWorkerRole;
  readonly state: WorkerLeaseState;
  readonly fencingToken: number;
  readonly leaseExpiresAt: string;
  readonly heartbeatAt: string;
  readonly acquiredAt: string;
  readonly releasedAt: string | null;
}

export interface WorkerLeaseEventRecord {
  readonly eventId: number;
  readonly ownerInstanceId: string;
  readonly role: RuntimeWorkerRole;
  readonly eventType: WorkerLeaseEventType;
  readonly fencingToken: number;
  readonly occurredAt: string;
}

export class RuntimeWorkerError extends Error {
  constructor(public readonly code:
    | 'LEASE_HELD_BY_OTHER'
    | 'LEASE_LOST'
    | 'LEASE_PREEMPTED'
    | 'LEASE_NOT_ACTIVE'
    | 'LEASE_CONFIG_INVALID'
    | 'LEASE_STORE_UNAVAILABLE', message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'RuntimeWorkerError';
  }
}

/** worker_leases + worker_lease_events 的存储端口；PostgreSQL 与内存实现共用。 */
export interface WorkerLeaseStore {
  /**
   * 原子获取租约。同 role 已有未过期 active 租约时返回 null（被其他实例持有）；
   * 同 role active 租约已过期时执行抢占：旧行置 preempted 并写事件，新行
   * fencing_token = 旧行 + 1。
   */
  acquire(input: { ownerInstanceId: string; role: RuntimeWorkerRole; leaseMs: number; now: string }):
    Promise<WorkerLeaseSnapshot | null>;
  /** 心跳续约；调用者不再持有 active 租约时抛 LEASE_LOST。fencing_token 不变。 */
  renew(input: { ownerInstanceId: string; role: RuntimeWorkerRole; leaseMs: number; now: string }):
    Promise<WorkerLeaseSnapshot>;
  /** 主动释放；未持有时不报错。 */
  release(input: { ownerInstanceId: string; role: RuntimeWorkerRole; now: string }): Promise<void>;
  /** 当前同 role 的 active 租约（含过期未回收的），不存在返回 null。 */
  activeLease(role: RuntimeWorkerRole, now: string): Promise<WorkerLeaseSnapshot | null>;
  /** 审计证据链（按时间倒序）。 */
  events(role: RuntimeWorkerRole, limit?: number): Promise<WorkerLeaseEventRecord[]>;
}
