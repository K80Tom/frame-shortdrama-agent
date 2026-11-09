import {
  RuntimeWorkerError,
  type RuntimeWorkerRole, type WorkerLeaseEventRecord, type WorkerLeaseSnapshot,
  type WorkerLeaseStore,
} from './contracts';

interface LeaseEntry {
  ownerInstanceId: string;
  role: RuntimeWorkerRole;
  state: WorkerLeaseSnapshot['state'];
  fencingToken: number;
  leaseExpiresAt: number;
  heartbeatAt: number;
  acquiredAt: number;
  releasedAt: number | null;
}

interface EventEntry extends Omit<WorkerLeaseEventRecord, 'occurredAt'> {
  occurredAt: number;
}

/** 内存租约存储：单测使用，语义与 PostgreSQL 实现一致（同 role 唯一 active）。 */
export class MemoryWorkerLeaseStore implements WorkerLeaseStore {
  private readonly leases = new Map<string, LeaseEntry>();
  private readonly eventLog: EventEntry[] = [];
  private eventSeq = 0;

  constructor(private readonly eventId: () => number = () => ++this.eventSeq) {}

  async acquire(input: { ownerInstanceId: string; role: RuntimeWorkerRole; leaseMs: number; now: string }):
    Promise<WorkerLeaseSnapshot | null> {
    const now = Date.parse(input.now);
    const existing = [...this.leases.values()].find(entry => entry.role === input.role && entry.state === 'active');
    let fencingToken: number;
    if (existing) {
      if (existing.leaseExpiresAt > now) return null;
      fencingToken = existing.fencingToken + 1;
      existing.state = 'preempted';
      existing.releasedAt = now;
      this.eventLog.push({ eventId: this.eventId(), ownerInstanceId: existing.ownerInstanceId, role: input.role, eventType: 'preempted', fencingToken: existing.fencingToken, occurredAt: now });
    } else {
      const maxFencing = Math.max(0, ...[...this.leases.values()].filter(entry => entry.role === input.role).map(entry => entry.fencingToken));
      fencingToken = maxFencing + 1;
    }
    const entry: LeaseEntry = {
      ownerInstanceId: input.ownerInstanceId, role: input.role, state: 'active', fencingToken,
      leaseExpiresAt: now + input.leaseMs, heartbeatAt: now, acquiredAt: now, releasedAt: null,
    };
    this.leases.set(entry.ownerInstanceId, entry);
    this.eventLog.push({ eventId: this.eventId(), ownerInstanceId: input.ownerInstanceId, role: input.role, eventType: 'acquired', fencingToken, occurredAt: now });
    return this.snapshot(entry);
  }

  async renew(input: { ownerInstanceId: string; role: RuntimeWorkerRole; leaseMs: number; now: string }):
    Promise<WorkerLeaseSnapshot> {
    const now = Date.parse(input.now);
    const entry = this.leases.get(input.ownerInstanceId);
    if (!entry || entry.state !== 'active' || entry.role !== input.role) {
      throw new RuntimeWorkerError(entry?.state === 'preempted' ? 'LEASE_PREEMPTED' : 'LEASE_LOST',
        entry?.state === 'preempted' ? '租约已被其他实例抢占。' : '租约不存在或已释放。');
    }
    entry.leaseExpiresAt = now + input.leaseMs;
    entry.heartbeatAt = now;
    this.eventLog.push({ eventId: this.eventId(), ownerInstanceId: entry.ownerInstanceId, role: entry.role, eventType: 'renewed', fencingToken: entry.fencingToken, occurredAt: now });
    return this.snapshot(entry);
  }

  async release(input: { ownerInstanceId: string; role: RuntimeWorkerRole; now: string }): Promise<void> {
    const now = Date.parse(input.now);
    const entry = this.leases.get(input.ownerInstanceId);
    if (!entry || entry.state !== 'active' || entry.role !== input.role) return;
    entry.state = 'released';
    entry.releasedAt = now;
    this.eventLog.push({ eventId: this.eventId(), ownerInstanceId: entry.ownerInstanceId, role: entry.role, eventType: 'released', fencingToken: entry.fencingToken, occurredAt: now });
  }

  async activeLease(role: RuntimeWorkerRole, now: string): Promise<WorkerLeaseSnapshot | null> {
    const at = Date.parse(now);
    const entry = [...this.leases.values()].find(item => item.role === role && item.state === 'active');
    if (!entry || entry.leaseExpiresAt <= at) return null;
    return this.snapshot(entry);
  }

  async events(role: RuntimeWorkerRole, limit = 100): Promise<WorkerLeaseEventRecord[]> {
    return [...this.eventLog].reverse().filter(event => event.role === role).slice(0, limit)
      .map(event => ({ ...event, occurredAt: new Date(event.occurredAt).toISOString() }));
  }

  private snapshot(entry: LeaseEntry): WorkerLeaseSnapshot {
    return {
      ownerInstanceId: entry.ownerInstanceId,
      role: entry.role,
      state: entry.state,
      fencingToken: entry.fencingToken,
      leaseExpiresAt: new Date(entry.leaseExpiresAt).toISOString(),
      heartbeatAt: new Date(entry.heartbeatAt).toISOString(),
      acquiredAt: new Date(entry.acquiredAt).toISOString(),
      releasedAt: entry.releasedAt === null ? null : new Date(entry.releasedAt).toISOString(),
    };
  }
}
