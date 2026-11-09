BEGIN;

-- 039: Tool Registry / MCP / 方法包 / 可恢复 Agent Runtime 持久化。
--
-- 边界：
-- * tool_definitions、agent_definition_revisions 是平台级不可变目录，不含
--   Endpoint 或密钥；MCP 工具 Manifest 与 Skill 版本按 Workspace 隔离。
-- * 所有租户表都带 workspace_id，并注册 030 的租户触发器 + RLS。
-- * Run 的 snapshot_json 是运行期唯一可信输入，任何字段变化必须新建 Run。

CREATE TABLE tool_definitions (
  tool_id text NOT NULL CHECK (tool_id ~ '^[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*){0,7}$'),
  version text NOT NULL CHECK (version ~ '^\d+\.\d+\.\d+$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  definition_json jsonb NOT NULL CHECK (jsonb_typeof(definition_json) = 'object'),
  status text NOT NULL CHECK (status IN ('draft', 'frozen', 'deprecated', 'disabled')),
  adapter_digest text NOT NULL CHECK (adapter_digest ~ '^[a-f0-9]{64}$'),
  frozen_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tool_id, version),
  CONSTRAINT tool_definitions_frozen_time CHECK ((status = 'frozen') = (frozen_at IS NOT NULL))
);
CREATE INDEX tool_definitions_status_idx ON tool_definitions (status, tool_id, version);

CREATE TABLE agent_definition_revisions (
  agent_id text NOT NULL CHECK (agent_id ~ '^[a-z][a-z0-9_-]{2,127}$'),
  version text NOT NULL CHECK (version ~ '^\d+\.\d+\.\d+$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('draft', 'frozen', 'deprecated', 'disabled')),
  definition_json jsonb NOT NULL CHECK (jsonb_typeof(definition_json) = 'object'),
  created_at timestamptz NOT NULL,
  frozen_at timestamptz NULL,
  PRIMARY KEY (agent_id, version),
  CONSTRAINT agent_definition_frozen_time CHECK ((status = 'frozen') = (frozen_at IS NOT NULL))
);

CREATE TABLE workspace_tool_grants (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  tool_id text NOT NULL,
  version text NOT NULL CHECK (version ~ '^\d+\.\d+\.\d+$'),
  enabled boolean NOT NULL DEFAULT true,
  granted_by text NOT NULL CHECK (char_length(granted_by) BETWEEN 3 AND 160),
  reason text NULL CHECK (reason IS NULL OR char_length(reason) <= 500),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, tool_id, version),
  CONSTRAINT workspace_tool_grants_tool_fk FOREIGN KEY (tool_id, version)
    REFERENCES tool_definitions (tool_id, version) ON DELETE RESTRICT
);

CREATE TABLE skill_versions (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  skill_id text NOT NULL CHECK (skill_id ~ '^skl_[a-z0-9][a-z0-9_-]{1,63}$'),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 262144),
  content_digest text NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  frontmatter_json jsonb NOT NULL CHECK (jsonb_typeof(frontmatter_json) = 'object'),
  files_json jsonb NOT NULL CHECK (jsonb_typeof(files_json) = 'array'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  license_code text NOT NULL CHECK (char_length(license_code) BETWEEN 1 AND 64),
  commercial_use_allowed boolean NOT NULL DEFAULT false,
  nodes text[] NOT NULL DEFAULT '{}' CHECK (nodes <@ ARRAY[
    'script-adaptation', 'character-image', 'storyboard', 'video-prompt'
  ]::text[]),
  compatibility_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(compatibility_json) = 'object'),
  status text NOT NULL CHECK (status IN ('draft', 'published', 'deprecated')),
  -- 单一真相源映射：020/021 的 prompt_pack_imports 是方法正文来源；
  -- skill_versions 只是其 workspace 隔离的不可变版本快照，不是第二套方法中心。
  source_kind text NOT NULL CHECK (source_kind IN ('prompt_pack_import', 'builtin_library')),
  source_pack_id text NULL CHECK (source_pack_id IS NULL OR source_pack_id ~ '^[a-z0-9-]{1,80}$'),
  source_pack_digest text NULL CHECK (source_pack_digest IS NULL OR source_pack_digest ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL CHECK (char_length(created_by) BETWEEN 3 AND 160),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, skill_id, version),
  CONSTRAINT skill_versions_prompt_pack_fk FOREIGN KEY (source_pack_id)
    REFERENCES prompt_pack_imports (id) ON DELETE RESTRICT,
  CONSTRAINT skill_versions_source_mapping CHECK (
    (source_kind = 'prompt_pack_import'
      AND source_pack_id IS NOT NULL AND source_pack_digest IS NOT NULL)
    OR (source_kind = 'builtin_library'
      AND source_pack_id IS NULL AND source_pack_digest IS NULL)
  )
);
CREATE INDEX skill_versions_digest_idx ON skill_versions (workspace_id, skill_id, content_digest);
CREATE INDEX skill_versions_prompt_pack_idx ON skill_versions (source_pack_id, source_pack_digest);

COMMENT ON TABLE skill_versions IS
  '020/021 prompt_pack_imports 的不可变、workspace 隔离版本快照；不是独立方法包中心。';
COMMENT ON COLUMN skill_versions.source_pack_id IS
  '对应 prompt_pack_imports.id；builtin_library 为仓库内置方法包时为空。';
COMMENT ON COLUMN skill_versions.source_pack_digest IS
  '来源方法包在导入时的 content digest；与 run_json.methodPacks[].digest 对齐。';

CREATE TABLE skill_workspace_admissions (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  skill_id text NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
  approved_by text NULL CHECK (approved_by IS NULL OR char_length(approved_by) BETWEEN 3 AND 160),
  approved_at timestamptz NULL,
  rejection_reason text NULL CHECK (rejection_reason IS NULL OR char_length(rejection_reason) <= 500),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, skill_id, version),
  CONSTRAINT skill_admissions_version_fk FOREIGN KEY (workspace_id, skill_id, version)
    REFERENCES skill_versions (workspace_id, skill_id, version) ON DELETE RESTRICT,
  CONSTRAINT skill_admissions_approved CHECK ((status = 'approved') = (approved_at IS NOT NULL))
);

CREATE TABLE skill_profile_revisions (
  profile_revision_id text PRIMARY KEY CHECK (profile_revision_id ~ '^skp_[a-f0-9]{24}$'),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
  status text NOT NULL CHECK (status IN ('draft', 'adopted', 'archived')),
  base_revision_id text NULL,
  bindings_json jsonb NOT NULL CHECK (jsonb_typeof(bindings_json) = 'array'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL CHECK (char_length(created_by) BETWEEN 3 AND 160),
  created_at timestamptz NOT NULL,
  adopted_by text NULL,
  adopted_at timestamptz NULL,
  UNIQUE (workspace_id, project_id, revision),
  CONSTRAINT skill_profile_adopted CHECK ((status = 'adopted') = (adopted_at IS NOT NULL))
);

CREATE TABLE mcp_server_revisions (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  server_id text NOT NULL CHECK (server_id ~ '^srv_[a-f0-9]{24,32}$'),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND char_length(slug) <= 64),
  transport text NOT NULL CHECK (transport IN ('http', 'sse')),
  url text NOT NULL CHECK (char_length(url) <= 2048),
  header_secret_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(header_secret_refs) = 'array'),
  protocol_versions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(protocol_versions) = 'array'),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 600000),
  initialization_timeout_ms integer NOT NULL CHECK (initialization_timeout_ms BETWEEN 1000 AND 600000),
  max_response_bytes integer NOT NULL CHECK (max_response_bytes BETWEEN 1024 AND 16777216),
  allowed_hosts jsonb NOT NULL CHECK (jsonb_typeof(allowed_hosts) = 'array'),
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  admission text NOT NULL CHECK (admission IN ('pending', 'approved', 'rejected', 'revoked')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, server_id, revision),
  CONSTRAINT mcp_server_slug_unique UNIQUE (workspace_id, slug, revision)
);

CREATE TABLE mcp_tool_manifests (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  manifest_id text NOT NULL CHECK (manifest_id ~ '^mcpm_[a-f0-9]{24}$'),
  server_id text NOT NULL,
  server_revision integer NOT NULL,
  remote_name text NOT NULL CHECK (char_length(remote_name) BETWEEN 1 AND 128),
  definition_json jsonb NOT NULL CHECK (jsonb_typeof(definition_json) = 'object'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  annotations_json jsonb NOT NULL CHECK (jsonb_typeof(annotations_json) = 'object'),
  sensitivity text NOT NULL CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
  discovered_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, manifest_id),
  CONSTRAINT mcp_manifest_server_fk FOREIGN KEY (workspace_id, server_id, server_revision)
    REFERENCES mcp_server_revisions (workspace_id, server_id, revision) ON DELETE RESTRICT,
  UNIQUE (workspace_id, manifest_id, manifest_digest)
);

CREATE TABLE mcp_workspace_admissions (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  server_id text NOT NULL,
  revision integer NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
  enabled_tools jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(enabled_tools) = 'array'),
  approved_by text NULL,
  approved_at timestamptz NULL,
  rejection_reason text NULL CHECK (rejection_reason IS NULL OR char_length(rejection_reason) <= 500),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, server_id, revision),
  CONSTRAINT mcp_admission_server_fk FOREIGN KEY (workspace_id, server_id, revision)
    REFERENCES mcp_server_revisions (workspace_id, server_id, revision) ON DELETE RESTRICT
);

CREATE TABLE agent_runs (
  run_id text PRIMARY KEY CHECK (run_id ~ '^run_[a-f0-9]{32}$'),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NULL,
  state text NOT NULL CHECK (state IN (
    'created', 'planning', 'awaiting_approval', 'queued', 'running', 'waiting_tool',
    'waiting_human', 'waiting_external', 'reconciling', 'interrupted', 'succeeded',
    'failed', 'cancelled', 'inconclusive'
  )),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  step_count smallint NOT NULL DEFAULT 0 CHECK (step_count >= 0),
  reason_summary text NOT NULL DEFAULT '' CHECK (char_length(reason_summary) <= 500),
  terminal_error_code text NULL CHECK (terminal_error_code IS NULL OR char_length(terminal_error_code) <= 120),
  lease_owner text NULL CHECK (lease_owner IS NULL OR char_length(lease_owner) BETWEEN 3 AND 160),
  lease_expires_at timestamptz NULL,
  heartbeat_at timestamptz NULL,
  deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT agent_runs_lease CHECK (
    (lease_owner IS NULL) = (lease_expires_at IS NULL)
  ),
  CONSTRAINT agent_runs_workspace_identity UNIQUE (workspace_id, run_id)
);
CREATE INDEX agent_runs_claim_idx ON agent_runs (state, deadline_at, created_at) WHERE state = 'queued';
CREATE INDEX agent_runs_workspace_state_idx ON agent_runs (workspace_id, state, updated_at DESC, run_id DESC);

CREATE TABLE agent_run_attempts (
  attempt_id text PRIMARY KEY CHECK (attempt_id ~ '^runa_[a-f0-9]{32}$'),
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  attempt_number smallint NOT NULL CHECK (attempt_number BETWEEN 1 AND 100),
  state text NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'cancelled', 'lost', 'interrupted')),
  lease_owner text NOT NULL CHECK (char_length(lease_owner) BETWEEN 3 AND 160),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NULL,
  error_json jsonb NULL CHECK (error_json IS NULL OR jsonb_typeof(error_json) = 'object'),
  CONSTRAINT agent_run_attempts_fk FOREIGN KEY (workspace_id, run_id)
    REFERENCES agent_runs (workspace_id, run_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, run_id, attempt_number),
  CONSTRAINT agent_run_attempts_end CHECK ((state = 'running') = (ended_at IS NULL))
);

CREATE TABLE agent_steps (
  step_id text PRIMARY KEY CHECK (step_id ~ '^stp_[a-f0-9]{16}$'),
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  step_index smallint NOT NULL CHECK (step_index BETWEEN 1 AND 64),
  state text NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'interrupted')),
  summary text NOT NULL CHECK (char_length(summary) <= 500),
  tool_call_count smallint NOT NULL DEFAULT 0 CHECK (tool_call_count BETWEEN 0 AND 256),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NULL,
  CONSTRAINT agent_steps_fk FOREIGN KEY (workspace_id, run_id)
    REFERENCES agent_runs (workspace_id, run_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, run_id, step_index),
  CONSTRAINT agent_steps_end CHECK ((state = 'running') = (ended_at IS NULL))
);

CREATE TABLE agent_action_proposals (
  proposal_id text PRIMARY KEY CHECK (char_length(proposal_id) BETWEEN 4 AND 80),
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  step_id text NOT NULL,
  tool_id text NOT NULL,
  tool_version text NOT NULL CHECK (tool_version ~ '^\d+\.\d+\.\d+$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  arguments_json jsonb NOT NULL CHECK (jsonb_typeof(arguments_json) = 'object'),
  reason_summary text NOT NULL CHECK (char_length(reason_summary) <= 500),
  created_at timestamptz NOT NULL,
  CONSTRAINT agent_proposals_run_fk FOREIGN KEY (workspace_id, run_id)
    REFERENCES agent_runs (workspace_id, run_id) ON DELETE RESTRICT
);

CREATE TABLE agent_tool_invocations (
  invocation_id text PRIMARY KEY CHECK (invocation_id ~ '^inv_[a-f0-9]{32}$'),
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  step_id text NOT NULL,
  tool_id text NOT NULL,
  tool_version text NOT NULL CHECK (tool_version ~ '^\d+\.\d+\.\d+$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN (
    'proposed', 'rejected', 'awaiting_approval', 'approved', 'queued', 'running',
    'waiting_external', 'interrupted', 'succeeded', 'failed', 'cancelled', 'reconciling', 'inconclusive'
  )),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  proposal_json jsonb NOT NULL CHECK (jsonb_typeof(proposal_json) = 'object'),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
  approval_request_id text NULL,
  result_json jsonb NULL CHECK (result_json IS NULL OR jsonb_typeof(result_json) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT agent_invocations_run_fk FOREIGN KEY (workspace_id, run_id)
    REFERENCES agent_runs (workspace_id, run_id) ON DELETE RESTRICT,
  CONSTRAINT agent_invocations_workspace_identity UNIQUE (workspace_id, invocation_id),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX agent_invocations_run_idx ON agent_tool_invocations (workspace_id, run_id, state, created_at);

CREATE TABLE agent_budget_accounts (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  currency text NOT NULL CHECK (char_length(currency) BETWEEN 3 AND 8),
  available_micros bigint NOT NULL DEFAULT 0 CHECK (available_micros >= 0),
  reserved_micros bigint NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, currency)
);

CREATE TABLE agent_budget_reservations (
  reservation_id text PRIMARY KEY CHECK (reservation_id ~ '^res_[a-f0-9]{24}$'),
  workspace_id text NOT NULL,
  agent_run_id text NOT NULL,
  invocation_id text NOT NULL,
  amount_micros bigint NOT NULL CHECK (amount_micros >= 0),
  actual_micros bigint NULL CHECK (actual_micros IS NULL OR actual_micros >= 0),
  currency text NOT NULL CHECK (char_length(currency) BETWEEN 3 AND 8),
  state text NOT NULL CHECK (state IN ('reserved', 'settled', 'released')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT agent_budget_reservations_fk FOREIGN KEY (workspace_id, agent_run_id)
    REFERENCES agent_runs (workspace_id, run_id) ON DELETE RESTRICT,
  CONSTRAINT agent_budget_settled CHECK ((state = 'settled') = (actual_micros IS NOT NULL)),
  -- 每个 Invocation 最多一条预留；reserve 必须幂等复用，不得重复扣余额。
  CONSTRAINT agent_budget_invocation_unique UNIQUE (workspace_id, invocation_id)
);
CREATE INDEX agent_budget_reservations_run_idx ON agent_budget_reservations (workspace_id, agent_run_id, state);

CREATE TABLE agent_tool_attempts (
  attempt_id text PRIMARY KEY CHECK (attempt_id ~ '^att_[a-f0-9]{32}$'),
  workspace_id text NOT NULL,
  invocation_id text NOT NULL,
  attempt_number smallint NOT NULL CHECK (attempt_number BETWEEN 1 AND 10),
  state text NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'cancelled', 'inconclusive')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NULL,
  reason_code text NULL CHECK (reason_code IS NULL OR char_length(reason_code) <= 120),
  summary text NULL CHECK (summary IS NULL OR char_length(summary) <= 2000),
  CONSTRAINT agent_tool_attempts_fk FOREIGN KEY (workspace_id, invocation_id)
    REFERENCES agent_tool_invocations (workspace_id, invocation_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, invocation_id, attempt_number)
);

CREATE TABLE agent_approval_requests (
  approval_id text PRIMARY KEY CHECK (approval_id ~ '^apr_[a-f0-9]{24}$'),
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  invocation_id text NULL,
  kind text NOT NULL CHECK (kind IN ('tool_confirmation', 'paid_action', 'plan_review')),
  state text NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'expired')),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 1000),
  proposal_digest text NOT NULL CHECK (proposal_digest ~ '^[a-f0-9]{64}$'),
  estimate_micros bigint NOT NULL DEFAULT 0 CHECK (estimate_micros >= 0),
  currency text NOT NULL CHECK (char_length(currency) BETWEEN 3 AND 8),
  requested_by text NOT NULL CHECK (char_length(requested_by) BETWEEN 3 AND 160),
  requested_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  decided_by text NULL,
  decided_at timestamptz NULL,
  decision_note text NULL CHECK (decision_note IS NULL OR char_length(decision_note) <= 500),
  CONSTRAINT agent_approvals_run_fk FOREIGN KEY (workspace_id, run_id)
    REFERENCES agent_runs (workspace_id, run_id) ON DELETE RESTRICT,
  CONSTRAINT agent_approvals_workspace_identity UNIQUE (workspace_id, approval_id),
  CONSTRAINT agent_approvals_expiry CHECK (expires_at > requested_at),
  CONSTRAINT agent_approvals_decision CHECK ((state = 'pending') = (decided_at IS NULL))
);

CREATE TABLE agent_approval_decisions (
  decision_id text PRIMARY KEY CHECK (decision_id ~ '^apd_[a-f0-9]{24}$'),
  workspace_id text NOT NULL,
  approval_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected', 'expired')),
  actor text NOT NULL CHECK (char_length(actor) BETWEEN 3 AND 160),
  note text NULL CHECK (note IS NULL OR char_length(note) <= 500),
  created_at timestamptz NOT NULL,
  CONSTRAINT agent_approval_decisions_fk FOREIGN KEY (workspace_id, approval_id)
    REFERENCES agent_approval_requests (workspace_id, approval_id) ON DELETE RESTRICT
);

CREATE TABLE agent_context_snapshots (
  snapshot_id text PRIMARY KEY CHECK (snapshot_id ~ '^cps_[a-f0-9]{24}$'),
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  step_id text NULL,
  kind text NOT NULL CHECK (kind IN ('step', 'tool', 'resume', 'approval')),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  cursor text NULL CHECK (cursor IS NULL OR char_length(cursor) <= 200),
  created_at timestamptz NOT NULL,
  CONSTRAINT agent_context_snapshots_fk FOREIGN KEY (workspace_id, run_id)
    REFERENCES agent_runs (workspace_id, run_id) ON DELETE RESTRICT
);
CREATE INDEX agent_context_snapshots_latest_idx ON agent_context_snapshots (workspace_id, run_id, created_at DESC);

CREATE TABLE agent_events (
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (event_type IN (
    'run_state', 'step_started', 'text', 'tool_proposed', 'tool_denied', 'tool_started',
    'tool_result', 'approval_required', 'approval_decided', 'budget_reserved',
    'budget_settled', 'completed', 'error'
  )),
  event_json jsonb NOT NULL CHECK (jsonb_typeof(event_json) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, run_id, sequence),
  CONSTRAINT agent_events_fk FOREIGN KEY (workspace_id, run_id)
    REFERENCES agent_runs (workspace_id, run_id) ON DELETE RESTRICT
);

-- 租户隔离：复用 030 的触发器与 RLS 策略，禁止任何表绕过 workspace 上下文。
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_tool_grants', 'skill_versions', 'skill_workspace_admissions',
    'skill_profile_revisions', 'mcp_server_revisions', 'mcp_tool_manifests',
    'mcp_workspace_admissions', 'agent_runs', 'agent_run_attempts', 'agent_steps',
    'agent_action_proposals', 'agent_tool_invocations', 'agent_tool_attempts',
    'agent_approval_requests', 'agent_approval_decisions', 'agent_context_snapshots',
    'agent_events', 'agent_budget_accounts', 'agent_budget_reservations'
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
