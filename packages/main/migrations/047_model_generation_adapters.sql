BEGIN;

-- 044: 模型生成执行层（#127 / #130）
--
-- 边界：
-- * 预算预留账本只记录金额、业务键和供应商任务号；不保存 Prompt、签名 URL
--   或 Authorization。operation_key + workspace_id 唯一，重试不能二次预留。
-- * ComfyUI 工作流版本不可变；发布前必须同时通过 object_info 校验与连通性测试。
-- * 所有租户表复用 030 的 workspace 触发器与 RLS 策略。

CREATE TABLE model_generation_budget_reservations (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK (id ~ '^pgbudget_[A-Za-z0-9_]{8,80}$'),
  operation_key text NOT NULL CHECK (operation_key ~ '^[A-Za-z0-9_.:-]{1,160}$'),
  provider text NOT NULL CHECK (provider ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
  estimate_micros bigint NOT NULL CHECK (estimate_micros >= 0),
  actual_micros bigint NULL CHECK (actual_micros IS NULL OR actual_micros >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  budget_limit_micros bigint NOT NULL CHECK (budget_limit_micros >= 0),
  run_id text NULL CHECK (run_id IS NULL OR char_length(run_id) <= 160),
  task_id text NULL CHECK (task_id IS NULL OR char_length(task_id) <= 160),
  status text NOT NULL CHECK (status IN ('reserved', 'committed', 'unknown', 'released')),
  failure_reason text NULL CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT model_generation_budget_operation_unique UNIQUE (workspace_id, operation_key),
  CONSTRAINT model_generation_budget_actual_limit CHECK (
    actual_micros IS NULL OR actual_micros <= estimate_micros
  ),
  CONSTRAINT model_generation_budget_settled CHECK (
    (status = 'committed') = (actual_micros IS NOT NULL)
  )
);
CREATE INDEX model_generation_budget_open_idx
  ON model_generation_budget_reservations (workspace_id, status, created_at);

CREATE TABLE comfyui_workflows (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  workflow_id text NOT NULL CHECK (workflow_id ~ '^cfw_[a-z0-9][a-z0-9_-]{1,63}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  created_by text NOT NULL CHECK (char_length(created_by) BETWEEN 3 AND 160),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, workflow_id)
);

CREATE TABLE comfyui_workflow_versions (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  workflow_id text NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  api_format jsonb NOT NULL CHECK (jsonb_typeof(api_format) = 'object'),
  workflow_hash text NOT NULL CHECK (workflow_hash ~ '^[a-f0-9]{64}$'),
  validation_status text NOT NULL CHECK (validation_status IN ('pending', 'valid', 'invalid')),
  validation_message text NULL CHECK (validation_message IS NULL OR char_length(validation_message) <= 1000),
  test_status text NOT NULL CHECK (test_status IN ('pending', 'passed', 'failed')),
  test_api_config_hash text NULL CHECK (test_api_config_hash IS NULL OR test_api_config_hash ~ '^[a-f0-9]{64}$'),
  published_at timestamptz NULL,
  created_by text NOT NULL CHECK (char_length(created_by) BETWEEN 3 AND 160),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, workflow_id, version),
  CONSTRAINT comfyui_workflow_versions_fk FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES comfyui_workflows (workspace_id, workflow_id) ON DELETE RESTRICT,
  CONSTRAINT comfyui_workflow_versions_publishable CHECK (
    (published_at IS NULL)
    OR (validation_status = 'valid' AND test_status = 'passed' AND test_api_config_hash IS NOT NULL)
  )
);
CREATE INDEX comfyui_workflow_versions_latest_idx
  ON comfyui_workflow_versions (workspace_id, workflow_id, version DESC);

CREATE TABLE model_generation_calls (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK (id ~ '^mgcall_[a-z0-9]{16,64}$'),
  operation_key text NOT NULL CHECK (operation_key ~ '^[A-Za-z0-9_.:-]{1,160}$'),
  provider text NOT NULL CHECK (provider ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
  prompt_digest text NOT NULL CHECK (prompt_digest ~ '^[a-f0-9]{64}$'),
  control_input_digest text NULL CHECK (control_input_digest IS NULL OR control_input_digest ~ '^[a-f0-9]{64}$'),
  reservation_id text NULL CHECK (reservation_id IS NULL OR reservation_id ~ '^pgbudget_[A-Za-z0-9_]{8,80}$'),
  provider_task_id text NULL CHECK (provider_task_id IS NULL OR char_length(provider_task_id) <= 160),
  status text NOT NULL CHECK (status IN ('submitted', 'completed', 'failed', 'unknown')),
  error_code text NULL CHECK (error_code IS NULL OR char_length(error_code) <= 80),
  cost_micros bigint NULL CHECK (cost_micros IS NULL OR cost_micros >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT model_generation_calls_reservation_fk
    FOREIGN KEY (workspace_id, reservation_id)
    REFERENCES model_generation_budget_reservations (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX model_generation_calls_operation_idx
  ON model_generation_calls (workspace_id, operation_key);

-- 租户隔离：复用 030 的触发器与 RLS 策略。
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'model_generation_budget_reservations', 'comfyui_workflows',
    'comfyui_workflow_versions', 'model_generation_calls'
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
