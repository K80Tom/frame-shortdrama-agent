import type { PoolClient } from 'pg';
import type { PostgresDatabase } from '../db/client';
import {
  OWNER_INSTANCE_ID_PATTERN, RuntimeWorkerError,
  type RuntimeWorkerRole, type WorkerLeaseEventRecord, type WorkerLeaseSnapshot,
  type WorkerLeaseStore,
} from './contracts';

interface LeaseRow {
  owner_instance_id: string;
  role: RuntimeWorkerRole;
  state: WorkerLeaseSnapshot['state'];
  fencing_token: string | number;
  lease_expires_at: Date;
  heartbeat_at: Date;
  acquired_at: Date;
  released_at: Date | null;
}

function toSnapshot(row: LeaseRow): WorkerLeaseSnapshot {
  if (!OWNER_INSTANCE_ID_PATTERN.test(row.owner_instance_id)) {
    throw new RuntimeWorkerError('LEASE_STORE_UNAVAILABLE', '租约实例标识损坏。');
  }
  return {
    ownerInstanceId: row.owner_instance_id,
    role: row.role,
    state: row.state,
    fencingToken: Number(row.fencing_token),
    leaseExpiresAt: row.lease_expires_at.toISOString(),
    heartbeatAt: row.heartbeat_at.toISOString(),
    acquiredAt: row.acquired_at.toISOString(),
    releasedAt: row.released_at?.toISOString() ?? null,
  };
}

/** worker_leases / worker_lease_events 的 PostgreSQL 权威实现。 */
export class PostgresWorkerLeaseStore implements WorkerLeaseStore {
  constructor(private readonly database: PostgresDatabase) {}

  async acquire(input: { ownerInstanceId: string; role: RuntimeWorkerRole; leaseMs: number; now: string }):
    Promise<WorkerLeaseSnapshot | null> {
    return this.database.runAsSystem('worker-lease.acquire', () => this.database.transaction(async (client: PoolClient) => {
      const now = new Date(input.now);
      const expires = new Date(now.getTime() + input.leaseMs);
      const active = await client.query<LeaseRow>(`
        SELECT owner_instance_id, role, state, fencing_token, lease_expires_at,
               heartbeat_at, acquired_at, released_at
        FROM worker_leases
        WHERE role = $1 AND state = 'active'
        FOR UPDATE
      `, [input.role]);
      const holder = active.rows[0];
      let fencingToken: number;
      if (holder) {
        if (new Date(holder.lease_expires_at).getTime() > now.getTime()) return null;
        fencingToken = Number(holder.fencing_token) + 1;
        await client.query(`
          UPDATE worker_leases SET state = 'preempted', released_at = $2, updated_at = $2
          WHERE owner_instance_id = $1
        `, [holder.owner_instance_id, now]);
        await client.query(`
          INSERT INTO worker_lease_events (owner_instance_id, role, event_type, fencing_token, occurred_at, detail)
          VALUES ($1, $2, 'preempted', $3, $4, $5::jsonb)
        `, [holder.owner_instance_id, input.role, holder.fencing_token, now,
          JSON.stringify({ takenOverBy: input.ownerInstanceId, expiredAt: holder.lease_expires_at })]);
      } else {
        const next = await client.query<{ next: string }>(`
          SELECT COALESCE(MAX(fencing_token), 0) + 1 AS next FROM worker_leases WHERE role = $1
        `, [input.role]);
        const nextRow = next.rows[0];
        if (!nextRow) return null;
        fencingToken = Number(nextRow.next);
      }
      try {
        const inserted = await client.query<LeaseRow>(`
          INSERT INTO worker_leases
            (owner_instance_id, role, state, fencing_token, lease_expires_at, heartbeat_at, acquired_at, updated_at)
          VALUES ($1, $2, 'active', $3, $4, $5, $5, $5)
          RETURNING owner_instance_id, role, state, fencing_token, lease_expires_at,
                    heartbeat_at, acquired_at, released_at
        `, [input.ownerInstanceId, input.role, fencingToken, expires, now]);
        const insertedRow = inserted.rows[0];
        if (!insertedRow) return null;
        const snapshot = toSnapshot(insertedRow);
        await client.query(`
          INSERT INTO worker_lease_events (owner_instance_id, role, event_type, fencing_token, occurred_at, detail)
          VALUES ($1, $2, 'acquired', $3, $5, $4::jsonb)
        `, [input.ownerInstanceId, input.role, fencingToken, JSON.stringify({ leaseMs: input.leaseMs }), now]);
        return snapshot;
      } catch (error) {
        if ((error as { code?: string }).code === '23505') return null;
        throw error;
      }
    }));
  }

  async renew(input: { ownerInstanceId: string; role: RuntimeWorkerRole; leaseMs: number; now: string }):
    Promise<WorkerLeaseSnapshot> {
    return this.database.runAsSystem('worker-lease.renew', async () => {
      const now = new Date(input.now);
      const updated = await this.database.query<LeaseRow>(`
        UPDATE worker_leases
        SET lease_expires_at = $3, heartbeat_at = $2, updated_at = $2
        WHERE owner_instance_id = $1 AND role = $4 AND state = 'active'
        RETURNING owner_instance_id, role, state, fencing_token, lease_expires_at,
                  heartbeat_at, acquired_at, released_at
      `, [input.ownerInstanceId, now, new Date(now.getTime() + input.leaseMs), input.role]);
      if (updated.rows[0]) {
        const snapshot = toSnapshot(updated.rows[0]);
        await this.database.query(`
          INSERT INTO worker_lease_events (owner_instance_id, role, event_type, fencing_token, occurred_at, detail)
          VALUES ($1, $2, 'renewed', $3, $4, '{}'::jsonb)
        `, [input.ownerInstanceId, input.role, snapshot.fencingToken, now]);
        return snapshot;
      }
      const current = await this.database.query<{ state: WorkerLeaseSnapshot['state'] }>(
        'SELECT state FROM worker_leases WHERE owner_instance_id = $1', [input.ownerInstanceId]);
      const state = current.rows[0]?.state;
      throw new RuntimeWorkerError(state === 'preempted' ? 'LEASE_PREEMPTED' : 'LEASE_LOST',
        state === 'preempted' ? '租约已被其他实例抢占。' : '租约不存在或已释放。');
    });
  }

  async release(input: { ownerInstanceId: string; role: RuntimeWorkerRole; now: string }): Promise<void> {
    await this.database.runAsSystem('worker-lease.release', () => this.database.transaction(async (client: PoolClient) => {
      const now = new Date(input.now);
      const released = await client.query<LeaseRow>(`
        UPDATE worker_leases
        SET state = 'released', released_at = $2, updated_at = $2
        WHERE owner_instance_id = $1 AND role = $3 AND state = 'active'
        RETURNING owner_instance_id, role, state, fencing_token, lease_expires_at,
                  heartbeat_at, acquired_at, released_at
      `, [input.ownerInstanceId, now, input.role]);
      const row = released.rows[0];
      if (row) {
        await client.query(`
          INSERT INTO worker_lease_events (owner_instance_id, role, event_type, fencing_token, occurred_at, detail)
          VALUES ($1, $2, 'released', $3, $4, '{}'::jsonb)
        `, [row.owner_instance_id, row.role, row.fencing_token, now]);
      }
    }));
  }

  async activeLease(role: RuntimeWorkerRole, now: string): Promise<WorkerLeaseSnapshot | null> {
    return this.database.runAsSystem('worker-lease.active', async () => {
      const rows = await this.database.query<LeaseRow>(`
        SELECT owner_instance_id, role, state, fencing_token, lease_expires_at,
               heartbeat_at, acquired_at, released_at
        FROM worker_leases WHERE role = $1 AND state = 'active'
      `, [role]);
      const row = rows.rows[0];
      if (!row) return null;
      const snapshot = toSnapshot(row);
      if (new Date(snapshot.leaseExpiresAt).getTime() <= new Date(now).getTime()) return null;
      return snapshot;
    });
  }

  async events(role: RuntimeWorkerRole, limit = 100): Promise<WorkerLeaseEventRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new RuntimeWorkerError('LEASE_CONFIG_INVALID', '事件查询上限无效。');
    }
    return this.database.runAsSystem('worker-lease.events', async () => {
      const rows = await this.database.query<{
        event_id: string | number; owner_instance_id: string; role: RuntimeWorkerRole;
        event_type: WorkerLeaseEventRecord['eventType']; fencing_token: string | number; occurred_at: Date;
      }>(`
        SELECT event_id, owner_instance_id, role, event_type, fencing_token, occurred_at
        FROM worker_lease_events WHERE role = $1 ORDER BY event_id DESC LIMIT $2
      `, [role, limit]);
      return rows.rows.map(row => ({
        eventId: Number(row.event_id),
        ownerInstanceId: row.owner_instance_id,
        role: row.role,
        eventType: row.event_type,
        fencingToken: Number(row.fencing_token),
        occurredAt: row.occurred_at.toISOString(),
      }));
    });
  }
}
