BEGIN;

-- 038 Worker 实例租约（owner_instance_id）。
--
-- PostgreSQL 是租约与 fencing 的权威事实源：每个 role 同时最多一行
-- active 租约（部分唯一索引强制）。Redis 只做快速互斥锁（性能优化），
-- Redis 不可用时回退到 PostgreSQL CAS，不会失去正确性（#124 §6：
-- Redis 不替代 PostgreSQL 领取与最终状态）。
-- 崩溃抢占：新实例只有在其 active 租约过期后才能接管，并使
-- fencing_token 单调递增；旧实例迟到的续约/写入会被 fencing 拒绝。
-- worker_lease_events 保留 acquired/renewed/released/preempted 的
-- 完整证据链，供接管与回滚演练审计。

CREATE TABLE worker_leases (
  owner_instance_id text PRIMARY KEY CHECK (owner_instance_id ~ '^wkri_[a-f0-9]{32}$'),
  role text NOT NULL CHECK (role IN ('api', 'worker', 'all')),
  state text NOT NULL CHECK (state IN ('active', 'released', 'preempted')),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  lease_expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL,
  released_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  CHECK (heartbeat_at >= acquired_at),
  CHECK ((state = 'active') = (released_at IS NULL))
);

-- 同一 role 全局只允许一个 active 租约持有者。
CREATE UNIQUE INDEX worker_leases_role_active_idx
  ON worker_leases (role) WHERE state = 'active';
CREATE INDEX worker_leases_expiry_idx
  ON worker_leases (role, lease_expires_at)
  WHERE state = 'active';

CREATE TABLE worker_lease_events (
  event_id bigserial PRIMARY KEY,
  owner_instance_id text NOT NULL CHECK (owner_instance_id ~ '^wkri_[a-f0-9]{32}$'),
  role text NOT NULL CHECK (role IN ('api', 'worker', 'all')),
  event_type text NOT NULL CHECK (event_type IN (
    'acquired', 'renewed', 'released', 'preempted'
  )),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  occurred_at timestamptz NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object')
);
CREATE INDEX worker_lease_events_owner_idx
  ON worker_lease_events (owner_instance_id, occurred_at);
CREATE INDEX worker_lease_events_role_idx
  ON worker_lease_events (role, event_id DESC);

-- 平台级运行时表：不携带 workspace_id，只有显式审计过的系统作用域
-- （Worker 领取/续约路径）可以读写。租户连接一律被 RLS 拒绝。
ALTER TABLE worker_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_lease_platform_access ON worker_leases
  USING (lyra_system_bypass_enabled())
  WITH CHECK (lyra_system_bypass_enabled());

ALTER TABLE worker_lease_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_lease_events FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_lease_event_platform_access ON worker_lease_events
  USING (lyra_system_bypass_enabled())
  WITH CHECK (lyra_system_bypass_enabled());

COMMIT;
