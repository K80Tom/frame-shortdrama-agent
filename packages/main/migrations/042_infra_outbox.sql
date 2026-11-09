BEGIN;

-- 037 基础设施异步 Outbox（Worker 任务出件箱）。
--
-- 定位：与 data_outbox_events（DataEventV1/V2 领域事件 → 投影）互补的
-- Worker 运行任务出件箱。业务写入通过 appendWithClient 与本表在同一个
-- PostgreSQL 事务内落一条"待消费任务"，由 main-worker 异步消费并推进
-- pending → delivering → delivered / failed / dead_letter 状态机。
-- 它不承载领域事件语义（那归 #133 的 DataEvent/Projector），也不替代
-- jobs（周期调度与长任务执行）；只负责"与业务事实同事务提交的异步任务"。
--
-- 消费语义为 at-least-once：业务副作用必须由 handler 自身幂等保证，
-- infra_outbox_consumer_records 是消费者侧的幂等去重与处理证据链。

CREATE TABLE infra_outbox_tasks (
  task_id text PRIMARY KEY CHECK (task_id ~ '^iobx_[a-f0-9]{32}$'),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  task_type text NOT NULL CHECK (task_type ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  aggregate_type text NULL CHECK (
    aggregate_type IS NULL OR aggregate_type ~ '^[a-z][a-z0-9_.-]{1,63}$'
  ),
  aggregate_id text NULL CHECK (
    aggregate_id IS NULL OR aggregate_id ~ '^[A-Za-z][A-Za-z0-9_.:-]{2,159}$'
  ),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending', 'delivering', 'delivered', 'failed', 'dead_letter'
  )),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts smallint NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 100),
  available_at timestamptz NOT NULL,
  lease_owner text NULL CHECK (lease_owner IS NULL OR lease_owner ~ '^wkri_[a-f0-9]{32}$'),
  lease_expires_at timestamptz NULL,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  delivered_at timestamptz NULL,
  last_error text NULL CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT infra_outbox_workspace_idempotency UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT infra_outbox_aggregate_pair CHECK (
    (aggregate_type IS NULL) = (aggregate_id IS NULL)
  ),
  CONSTRAINT infra_outbox_delivered_time CHECK (
    (state = 'delivered') = (delivered_at IS NOT NULL)
  ),
  CONSTRAINT infra_outbox_delivering_lease CHECK (
    (state = 'delivering'
      AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'delivering'
      AND lease_owner IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX infra_outbox_claim_idx
  ON infra_outbox_tasks (available_at, created_at, task_id)
  WHERE state IN ('pending', 'failed');
CREATE INDEX infra_outbox_workspace_state_idx
  ON infra_outbox_tasks (workspace_id, state, updated_at DESC, task_id DESC);

-- 消费者处理记录：同一 (consumer_name, task_id) 只允许成功写入一次，
-- 既是幂等去重依据，也是可审计的处理证据链。
CREATE TABLE infra_outbox_consumer_records (
  consumer_name text NOT NULL CHECK (consumer_name ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  task_id text NOT NULL REFERENCES infra_outbox_tasks(task_id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  owner_instance_id text NULL CHECK (
    owner_instance_id IS NULL OR owner_instance_id ~ '^wkri_[a-f0-9]{32}$'
  ),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result_json) = 'object'),
  processed_at timestamptz NOT NULL,
  PRIMARY KEY (consumer_name, task_id)
);
CREATE INDEX infra_outbox_consumer_workspace_idx
  ON infra_outbox_consumer_records (workspace_id, processed_at DESC);

-- 重放运行记录：范围重放必须先登记发起人、原因、过滤条件与结果摘要，
-- 禁止通过删除或改写历史记录掩盖失败。
CREATE TABLE infra_outbox_replay_runs (
  replay_id text PRIMARY KEY CHECK (replay_id ~ '^rply_[a-f0-9]{32}$'),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  requested_by text NOT NULL CHECK (char_length(requested_by) BETWEEN 3 AND 160),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 4 AND 500),
  filter_json jsonb NOT NULL CHECK (jsonb_typeof(filter_json) = 'object'),
  scanned integer NOT NULL CHECK (scanned >= 0),
  requeued integer NOT NULL CHECK (requeued >= 0),
  created_at timestamptz NOT NULL
);

-- 与 030 的租户契约一致：workspace 作用域 + 系统旁路 + RLS 强制隔离。
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'infra_outbox_tasks', 'infra_outbox_consumer_records', 'infra_outbox_replay_runs'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS lyra_workspace_scope_guard ON %I', table_name);
    EXECUTE format(
      'CREATE TRIGGER lyra_workspace_scope_guard '
      'BEFORE INSERT OR UPDATE OF workspace_id ON %I '
      'FOR EACH ROW EXECUTE FUNCTION lyra_enforce_workspace_scope()',
      table_name
    );
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS lyra_workspace_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY lyra_workspace_isolation ON %I '
      'USING (lyra_system_bypass_enabled() OR workspace_id = lyra_current_workspace_id()) '
      'WITH CHECK (lyra_system_bypass_enabled() OR workspace_id = lyra_current_workspace_id())',
      table_name
    );
  END LOOP;
END;
$$;

COMMIT;
