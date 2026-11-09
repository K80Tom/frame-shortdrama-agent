BEGIN;

-- AI 工作区：可恢复的 turn 轨迹与“预算/估价分离”的确认卡字段。
--
-- 一次 AssistantTurn 对应一个 AgentRun（一对一），并保存已完成的完整事件流；
-- 客户端断线后按 cursor 续读，不重放未完成的内存状态。

ALTER TABLE assistant_sessions
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_turn_cursor integer NOT NULL DEFAULT 0;

ALTER TABLE assistant_quotes
  ADD COLUMN IF NOT EXISTS budget_micros bigint,
  ADD COLUMN IF NOT EXISTS estimate_low_micros bigint,
  ADD COLUMN IF NOT EXISTS estimate_high_micros bigint,
  ADD COLUMN IF NOT EXISTS price_revision text,
  ADD COLUMN IF NOT EXISTS assumptions_json jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS assistant_turns (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  session_id text NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  agent_run_id text NOT NULL,
  cursor integer NOT NULL CHECK (cursor >= 1),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
  user_content text NOT NULL,
  context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  events_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_json jsonb,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT assistant_turns_cursor_unique UNIQUE (session_id, cursor)
);

CREATE INDEX IF NOT EXISTS assistant_turns_session_idx
  ON assistant_turns (workspace_id, session_id, cursor);
CREATE INDEX IF NOT EXISTS assistant_turns_run_idx
  ON assistant_turns (workspace_id, agent_run_id);

-- 与 030 相同的租户守卫：workspace_id 由事务级 lyra.workspace_id 决定。
DROP TRIGGER IF EXISTS lyra_workspace_scope_guard ON assistant_turns;
CREATE TRIGGER lyra_workspace_scope_guard
  BEFORE INSERT OR UPDATE OF workspace_id ON assistant_turns
  FOR EACH ROW EXECUTE FUNCTION lyra_enforce_workspace_scope();

ALTER TABLE assistant_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_turns FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lyra_workspace_isolation ON assistant_turns;
CREATE POLICY lyra_workspace_isolation ON assistant_turns
  USING (lyra_system_bypass_enabled() OR workspace_id = lyra_current_workspace_id())
  WITH CHECK (lyra_system_bypass_enabled() OR workspace_id = lyra_current_workspace_id());

COMMIT;
