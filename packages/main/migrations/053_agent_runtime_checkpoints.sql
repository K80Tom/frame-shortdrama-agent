BEGIN;

-- 053 Agent Runtime 可恢复执行断点。
--
-- 目标：#136A 的恢复闭环。每个 Tool 调用在提交前与结果确认后各写一条
-- Checkpoint；Checkpoint 是“恢复到哪一步”的权威事实源，不是模型上下文缓存。
-- 与 agent_context_snapshots 的分工：
--   agent_context_snapshots：可恢复的模型/步骤上下文（较大的公开摘要）；
--   agent_run_checkpoints：带严格 sequence、pending Invocation 与阶段的执行断点。
--
-- 恢复语义：
-- - attempt 不可覆盖，崩溃后的新领取写入新的 agent_run_attempts 行；
-- - checkpoint 严格递增且唯一，重复投递不能插入同一 sequence；
-- - pending_invocation_id 指向尚未确认结果的工具调用，恢复必须先回读该行；
-- - 所有表强制 workspace RLS，裸 ID 不泄露存在性。

ALTER TABLE agent_runs
  ADD COLUMN current_attempt_id text NULL;
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_current_attempt_format
  CHECK (current_attempt_id IS NULL OR current_attempt_id ~ '^runa_[a-f0-9]{32}$');

-- Checkpoint 的 attempt 外键需要 workspace 级唯一身份；原表只有全局 PK。
ALTER TABLE agent_run_attempts
  ADD CONSTRAINT agent_run_attempts_workspace_identity UNIQUE (workspace_id, attempt_id);

CREATE TABLE agent_run_checkpoints (
  checkpoint_id text PRIMARY KEY CHECK (checkpoint_id ~ '^chk_[a-f0-9]{32}$'),
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NULL CHECK (attempt_id IS NULL OR attempt_id ~ '^runa_[a-f0-9]{32}$'),
  step_id text NULL CHECK (step_id IS NULL OR step_id ~ '^stp_[a-f0-9]{16}$'),
  sequence integer NOT NULL CHECK (sequence > 0),
  phase text NOT NULL CHECK (phase IN ('before_tool', 'after_tool', 'step_completed', 'run_completed')),
  payload_digest char(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  pending_invocation_id text NULL CHECK (pending_invocation_id IS NULL OR pending_invocation_id ~ '^inv_[a-f0-9]{32}$'),
  cursor text NULL CHECK (cursor IS NULL OR char_length(cursor) <= 200),
  created_at timestamptz NOT NULL,
  CONSTRAINT agent_run_checkpoints_run_fk FOREIGN KEY (workspace_id, run_id)
    REFERENCES agent_runs (workspace_id, run_id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_checkpoints_attempt_fk FOREIGN KEY (workspace_id, attempt_id)
    REFERENCES agent_run_attempts (workspace_id, attempt_id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_checkpoints_invocation_fk FOREIGN KEY (workspace_id, pending_invocation_id)
    REFERENCES agent_tool_invocations (workspace_id, invocation_id) ON DELETE RESTRICT,
  CONSTRAINT agent_run_checkpoints_sequence_unique UNIQUE (workspace_id, run_id, sequence)
);
CREATE INDEX agent_run_checkpoints_latest_idx
  ON agent_run_checkpoints (workspace_id, run_id, sequence DESC);
CREATE INDEX agent_run_checkpoints_phase_idx
  ON agent_run_checkpoints (workspace_id, run_id, phase, created_at DESC);

-- Agent 事件流本身也要接受新的 checkpoint 事件类型（Outbox 投影见下）。
ALTER TABLE agent_events DROP CONSTRAINT agent_events_event_type_check;
ALTER TABLE agent_events ADD CONSTRAINT agent_events_event_type_check CHECK (event_type IN (
  'run_state', 'step_started', 'text', 'tool_proposed', 'tool_denied', 'tool_started',
  'tool_result', 'approval_required', 'approval_decided', 'budget_reserved',
  'budget_settled', 'completed', 'error', 'checkpoint'
));

-- 接入既有 Outbox：Agent 权威事件与 Agent 事件写在同一事务中，不新建
-- Dispatcher/Projector。聚合版本使用 agent_events 的严格递增 sequence。
ALTER TABLE data_outbox_events DROP CONSTRAINT data_outbox_events_aggregate_type_check;
ALTER TABLE data_outbox_events ADD CONSTRAINT data_outbox_events_aggregate_type_check CHECK (aggregate_type IN (
  'novel_chapter', 'script', 'asset', 'production_run', 'production_attempt',
  'external_operation', 'quality_check', 'delivery_artifact', 'evaluation_run',
  'shot_spec', 'production_input', 'director_scene', 'object_version',
  'method_pack', 'method_profile',
  'agent_run', 'agent_tool_invocation'
));

-- 强制 workspace 作用域，复用 030 的 guard 与策略。
DO $$
BEGIN
  EXECUTE 'DROP TRIGGER IF EXISTS lyra_workspace_scope_guard ON agent_run_checkpoints';
  EXECUTE 'CREATE TRIGGER lyra_workspace_scope_guard '
    'BEFORE INSERT OR UPDATE OF workspace_id ON agent_run_checkpoints '
    'FOR EACH ROW EXECUTE FUNCTION lyra_enforce_workspace_scope()';
  EXECUTE 'ALTER TABLE agent_run_checkpoints ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE agent_run_checkpoints FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS lyra_workspace_isolation ON agent_run_checkpoints';
  EXECUTE 'CREATE POLICY lyra_workspace_isolation ON agent_run_checkpoints '
    'USING (lyra_system_bypass_enabled() OR workspace_id = lyra_current_workspace_id()) '
    'WITH CHECK (lyra_system_bypass_enabled() OR workspace_id = lyra_current_workspace_id())';
END;
$$;

COMMIT;
