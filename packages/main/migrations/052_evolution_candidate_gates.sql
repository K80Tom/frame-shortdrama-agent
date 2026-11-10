BEGIN;

-- 052 统一候选门禁闭环（#135）：Candidate 不可变模型与状态机、049 评测协议的
-- 门禁绑定与仲裁结论、Canary 分流与止损、Promote/Rollback 的 Registry Revision、
-- append-only 审计。只新增表，不改写 019/045 的资产演进事实（EV-37）。
-- 租户四件套与 049 同构：作用域触发器 + FORCE RLS + 统一隔离策略。

-- 1) Candidate：创建后正文不可更新（payload 冻结），状态变化走 CAS。
CREATE TABLE evolution_gate_candidates (
  candidate_id text PRIMARY KEY CHECK (candidate_id ~ '^evocand_[a-f0-9]{32}$'),
  candidate_digest char(64) NOT NULL CHECK (candidate_digest ~ '^[0-9a-f]{64}$'),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  domain text NOT NULL CHECK (domain IN ('AssetRetrievalPolicy','script-adaptation','character-image','storyboard','video-prompt')),
  scope text NOT NULL CHECK (scope IN ('platform','workspace','project')),
  project_id text NULL,
  state text NOT NULL CHECK (state IN ('proposed','evaluating','gated','approved','canary','promoted','rolled_back','rejected','paused','failed')),
  baseline_revision text NOT NULL CHECK (char_length(baseline_revision) BETWEEN 1 AND 160),
  baseline_digest char(64) NOT NULL CHECK (baseline_digest ~ '^[0-9a-f]{64}$'),
  candidate_revision text NOT NULL CHECK (char_length(candidate_revision) BETWEEN 1 AND 160),
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  proposal_key text NOT NULL CHECK (char_length(proposal_key) BETWEEN 1 AND 200),
  generated_by text NOT NULL CHECK (generated_by IN ('human','rule','model')),
  token_limit integer NOT NULL CHECK (token_limit > 0),
  cost_limit_minor integer NOT NULL CHECK (cost_limit_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  max_candidates integer NOT NULL CHECK (max_candidates BETWEEN 1 AND 2),
  created_by text NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 96),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  state_version integer NOT NULL CHECK (state_version >= 1),
  state_digest char(64) NOT NULL CHECK (state_digest ~ '^[0-9a-f]{64}$'),
  -- project 作用域必须带 project_id；platform/workspace 不允许携带。
  CONSTRAINT evolution_gate_scope_shape CHECK (
    (scope = 'project') = (project_id IS NOT NULL)
  )
);
-- 复合外键的定位唯一键（租户内 candidate_id 唯一）。
CREATE UNIQUE INDEX evolution_gate_candidates_ws_id_uid ON evolution_gate_candidates (workspace_id, candidate_id);
CREATE INDEX evolution_gate_candidates_proposal_idx ON evolution_gate_candidates (workspace_id, proposal_key, created_at);
CREATE INDEX evolution_gate_candidates_state_idx ON evolution_gate_candidates (workspace_id, state, updated_at);

-- 2) 门禁绑定：Candidate ↔ 049 评测结论（含仲裁 digest），append-only。
CREATE TABLE evolution_gate_bindings (
  binding_id text PRIMARY KEY CHECK (binding_id ~ '^evobind_[a-f0-9]{32}$'),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  candidate_id text NOT NULL,
  candidate_digest char(64) NOT NULL CHECK (candidate_digest ~ '^[0-9a-f]{64}$'),
  baseline_digest char(64) NOT NULL CHECK (baseline_digest ~ '^[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN ('pass','blocked')),
  rule_version text NOT NULL CHECK (char_length(rule_version) BETWEEN 1 AND 80),
  verdict_json jsonb NOT NULL CHECK (jsonb_typeof(verdict_json) = 'object'),
  decision_digest char(64) NOT NULL CHECK (decision_digest ~ '^[0-9a-f]{64}$'),
  bound_at timestamptz NOT NULL,
  -- 绑定的 Candidate 必须与结果同租户（EV-31）。
  CONSTRAINT evolution_gate_binding_candidate_fk FOREIGN KEY (workspace_id, candidate_id)
    REFERENCES evolution_gate_candidates (workspace_id, candidate_id) ON DELETE RESTRICT
);
-- 一个 Candidate 允许多次绑定（重评后旧绑定保留历史）；同一 decision_digest 租户内唯一。
CREATE UNIQUE INDEX evolution_gate_binding_digest_uid ON evolution_gate_bindings (workspace_id, decision_digest);
CREATE INDEX evolution_gate_binding_candidate_idx ON evolution_gate_bindings (workspace_id, candidate_id, bound_at);

-- 3) Canary 分流：路由配置创建后不可变；观测计数与熔断可推进（CAS）。
CREATE TABLE evolution_gate_rollouts (
  rollout_id text PRIMARY KEY CHECK (rollout_id ~ '^evoroll_[a-f0-9]{32}$'),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  candidate_id text NOT NULL,
  candidate_digest char(64) NOT NULL CHECK (candidate_digest ~ '^[0-9a-f]{64}$'),
  baseline_digest char(64) NOT NULL CHECK (baseline_digest ~ '^[0-9a-f]{64}$'),
  domain text NOT NULL CHECK (domain IN ('AssetRetrievalPolicy','script-adaptation','character-image','storyboard','video-prompt')),
  scope text NOT NULL CHECK (scope IN ('platform','workspace','project')),
  project_id text NULL,
  status text NOT NULL CHECK (status IN ('active','paused','failed','promoted')),
  traffic_permyriad integer NOT NULL CHECK (traffic_permyriad BETWEEN 0 AND 10000),
  routing_key text NOT NULL CHECK (char_length(routing_key) BETWEEN 1 AND 160),
  hash_algorithm text NOT NULL CHECK (char_length(hash_algorithm) BETWEEN 1 AND 80),
  anomaly_threshold integer NOT NULL CHECK (anomaly_threshold BETWEEN 1 AND 100),
  min_runs integer NOT NULL CHECK (min_runs >= 1),
  sample_count integer NOT NULL CHECK (sample_count >= 0),
  candidate_count integer NOT NULL CHECK (candidate_count >= 0),
  consecutive_anomalies integer NOT NULL CHECK (consecutive_anomalies >= 0),
  stopped_reason text NULL,
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  state_version integer NOT NULL CHECK (state_version >= 1),
  CONSTRAINT evolution_gate_rollout_scope_shape CHECK ((scope = 'project') = (project_id IS NOT NULL)),
  CONSTRAINT evolution_gate_rollout_candidate_fk FOREIGN KEY (workspace_id, candidate_id)
    REFERENCES evolution_gate_candidates (workspace_id, candidate_id) ON DELETE RESTRICT
);
CREATE INDEX evolution_gate_rollouts_candidate_idx ON evolution_gate_rollouts (workspace_id, candidate_id, started_at);

-- 4) Registry Revision（Promote/Rollback 都追加新 Revision，不删不改；EV-27/28）。
CREATE TABLE evolution_registry_revisions (
  id text PRIMARY KEY CHECK (id ~ '^evorev_[a-f0-9]{32}$'),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  domain text NOT NULL CHECK (domain IN ('AssetRetrievalPolicy','script-adaptation','character-image','storyboard','video-prompt')),
  scope text NOT NULL CHECK (scope IN ('platform','workspace','project')),
  project_id text NULL,
  revision integer NOT NULL CHECK (revision > 0),
  action text NOT NULL CHECK (action IN ('promote','rollback')),
  candidate_id text NULL,
  candidate_digest char(64) NULL CHECK (candidate_digest IS NULL OR candidate_digest ~ '^[0-9a-f]{64}$'),
  active_digest char(64) NOT NULL CHECK (active_digest ~ '^[0-9a-f]{64}$'),
  active_revision text NOT NULL CHECK (char_length(active_revision) BETWEEN 1 AND 160),
  previous_digest char(64) NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  actor text NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 96),
  rollout_id text NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT evolution_registry_scope_shape CHECK ((scope = 'project') = (project_id IS NOT NULL)),
  CONSTRAINT evolution_registry_action_shape CHECK (
    (action = 'promote') = (candidate_id IS NOT NULL AND candidate_digest IS NOT NULL)
  )
);
-- PostgreSQL 表级 UNIQUE 不支持表达式：project_id 空值按空串参与唯一性，用表达式索引。
CREATE UNIQUE INDEX evolution_registry_revision_uid ON evolution_registry_revisions
  (workspace_id, domain, scope, COALESCE(project_id, ''), revision);

-- 5) append-only 审计事件。
CREATE TABLE evolution_gate_audit_events (
  event_id text PRIMARY KEY CHECK (event_id ~ '^evoaud_[a-f0-9]{32}$'),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  candidate_id text NULL,
  rollout_id text NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user','system')),
  actor_id text NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 96),
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 80),
  reason text NULL,
  from_state text NULL,
  to_state text NULL,
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details_json) = 'object'),
  occurred_at timestamptz NOT NULL
);
CREATE INDEX evolution_gate_audit_candidate_idx ON evolution_gate_audit_events (workspace_id, candidate_id, occurred_at);
CREATE INDEX evolution_gate_audit_rollout_idx ON evolution_gate_audit_events (workspace_id, rollout_id, occurred_at);

-- append-only 保护：绑定、Registry Revision、审计只允许 INSERT（EV-15/28）。
CREATE FUNCTION evolution_gate_bindings_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVOLUTION_GATE_BINDINGS_APPEND_ONLY';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER evolution_gate_bindings_append_only_trigger
  BEFORE UPDATE OR DELETE ON evolution_gate_bindings
  FOR EACH ROW EXECUTE FUNCTION evolution_gate_bindings_append_only();

CREATE FUNCTION evolution_registry_revisions_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVOLUTION_REGISTRY_REVISIONS_APPEND_ONLY';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER evolution_registry_revisions_append_only_trigger
  BEFORE UPDATE OR DELETE ON evolution_registry_revisions
  FOR EACH ROW EXECUTE FUNCTION evolution_registry_revisions_append_only();

CREATE FUNCTION evolution_gate_audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVOLUTION_GATE_AUDIT_APPEND_ONLY';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER evolution_gate_audit_events_append_only_trigger
  BEFORE UPDATE OR DELETE ON evolution_gate_audit_events
  FOR EACH ROW EXECUTE FUNCTION evolution_gate_audit_events_append_only();

-- 租户四件套（与 049 同构）：作用域触发器、FORCE RLS、统一隔离策略。
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['evolution_gate_candidates','evolution_gate_bindings','evolution_gate_rollouts',
    'evolution_registry_revisions','evolution_gate_audit_events'] LOOP
    EXECUTE format('CREATE TRIGGER lyra_workspace_scope_guard BEFORE INSERT OR UPDATE OF workspace_id ON %I '
      'FOR EACH ROW EXECUTE FUNCTION lyra_enforce_workspace_scope()', table_name);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY lyra_workspace_isolation ON %I '
      'USING (lyra_system_bypass_enabled() OR workspace_id=lyra_current_workspace_id()) '
      'WITH CHECK (lyra_system_bypass_enabled() OR workspace_id=lyra_current_workspace_id())', table_name);
  END LOOP;
END;
$$;

COMMIT;
