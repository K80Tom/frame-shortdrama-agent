BEGIN;

-- #128 资产检索策略治理：观测、人工决策、不可变数据集 revision、候选载荷与 typed refs。
-- 所有表强制 workspace 作用域；不复制 #134 Dataset/Evaluation 或 #135 Candidate/Rollout 状态机。
CREATE TABLE IF NOT EXISTS asset_retrieval_observations (
  observation_id text PRIMARY KEY CHECK (observation_id ~ '^arobs_[a-f0-9]{32}$'),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NULL,
  shot_id text NULL,
  request_id text NOT NULL,
  client_request_id text NOT NULL,
  query_digest char(64) NOT NULL CHECK (query_digest ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL,
  content_digest char(64) NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  observation_json jsonb NOT NULL CHECK (jsonb_typeof(observation_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, observation_id),
  UNIQUE (workspace_id, client_request_id)
);
CREATE INDEX IF NOT EXISTS asset_retrieval_observations_workspace_observed_idx
  ON asset_retrieval_observations(workspace_id, observed_at, observation_id);

CREATE TABLE IF NOT EXISTS asset_retrieval_decisions (
  decision_id text PRIMARY KEY CHECK (decision_id ~ '^ardec_[a-f0-9]{32}$'),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  observation_id text NOT NULL,
  client_request_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accept', 'reject', 'override', 'regenerate', 'abstain')),
  selected_asset_id text NULL,
  selected_asset_version_id text NULL,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL,
  content_digest char(64) NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  decision_json jsonb NOT NULL CHECK (jsonb_typeof(decision_json) = 'object'),
  UNIQUE (workspace_id, decision_id),
  UNIQUE (workspace_id, observation_id),
  UNIQUE (workspace_id, client_request_id),
  FOREIGN KEY (workspace_id, observation_id)
    REFERENCES asset_retrieval_observations(workspace_id, observation_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS asset_retrieval_decisions_workspace_created_idx
  ON asset_retrieval_decisions(workspace_id, created_at, decision_id);

CREATE TABLE IF NOT EXISTS asset_retrieval_dataset_revisions (
  dataset_revision_id text PRIMARY KEY CHECK (dataset_revision_id ~ '^ardsrev_[a-f0-9]{32}$'),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('policy_search', 'regression', 'shadow', 'evaluation')),
  sample_count integer NOT NULL CHECK (sample_count >= 0),
  labeled_sample_count integer NOT NULL CHECK (labeled_sample_count >= 0),
  payload_digest char(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  revision_json jsonb NOT NULL CHECK (jsonb_typeof(revision_json) = 'object'),
  UNIQUE (workspace_id, dataset_revision_id)
);
CREATE INDEX IF NOT EXISTS asset_retrieval_dataset_revisions_workspace_created_idx
  ON asset_retrieval_dataset_revisions(workspace_id, created_at, dataset_revision_id);

CREATE TABLE IF NOT EXISTS asset_retrieval_policy_payloads (
  payload_id text PRIMARY KEY CHECK (payload_id ~ '^arpayload_[a-f0-9]{32}$'),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  dataset_revision_id text NOT NULL,
  base_policy_digest char(64) NOT NULL CHECK (base_policy_digest ~ '^[0-9a-f]{64}$'),
  payload_digest char(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  UNIQUE (workspace_id, payload_id),
  FOREIGN KEY (workspace_id, dataset_revision_id)
    REFERENCES asset_retrieval_dataset_revisions(workspace_id, dataset_revision_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS asset_retrieval_policy_payloads_workspace_created_idx
  ON asset_retrieval_policy_payloads(workspace_id, created_at, payload_id);

-- typed refs 只保存 #134/#135 的不可变身份，不复制逐样本或 Gate/Rollout 全量 JSON。
CREATE TABLE IF NOT EXISTS asset_retrieval_governance_refs (
  payload_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  candidate_version_id text NULL,
  evaluation_dataset_version_id text NULL,
  evaluation_dataset_revision_digest char(64) NULL
    CHECK (evaluation_dataset_revision_digest IS NULL OR evaluation_dataset_revision_digest ~ '^[0-9a-f]{64}$'),
  evaluation_run_id text NULL,
  scorecard_id text NULL,
  gate_decision_id text NULL,
  rollout_id text NULL,
  registry_entry_id text NULL,
  registry_revision integer NULL CHECK (registry_revision IS NULL OR registry_revision >= 0),
  policy_version_id text NULL,
  policy_digest char(64) NULL CHECK (policy_digest IS NULL OR policy_digest ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL,
  UNIQUE (workspace_id, payload_id),
  FOREIGN KEY (workspace_id, payload_id)
    REFERENCES asset_retrieval_policy_payloads(workspace_id, payload_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS asset_retrieval_governance_refs_workspace_candidate_idx
  ON asset_retrieval_governance_refs(workspace_id, candidate_version_id)
  WHERE candidate_version_id IS NOT NULL;

-- 观测、决策、数据集 revision 与候选载荷都是不可变事实：拒绝 UPDATE/DELETE。
CREATE OR REPLACE FUNCTION lyra_asset_retrieval_reject_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ASSET_RETRIEVAL_GOVERNANCE_IMMUTABLE: %', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'asset_retrieval_observations',
    'asset_retrieval_decisions',
    'asset_retrieval_dataset_revisions',
    'asset_retrieval_policy_payloads'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS lyra_asset_retrieval_immutable ON %I', table_name);
    EXECUTE format('CREATE TRIGGER lyra_asset_retrieval_immutable '
      'BEFORE UPDATE OR DELETE ON %I FOR EACH ROW '
      'EXECUTE FUNCTION lyra_asset_retrieval_reject_immutable()', table_name);
  END LOOP;
END;
$$;

-- 租户四件套：scope 触发器 + ENABLE/FORCE RLS + isolation policy。
-- 这里的表全部先声明 workspace_id，避免历史上 scope 触发器对无租户列的表报错。
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'asset_retrieval_observations',
    'asset_retrieval_decisions',
    'asset_retrieval_dataset_revisions',
    'asset_retrieval_policy_payloads',
    'asset_retrieval_governance_refs'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS lyra_workspace_scope_guard ON %I', table_name);
    EXECUTE format('CREATE TRIGGER lyra_workspace_scope_guard '
      'BEFORE INSERT OR UPDATE OF workspace_id ON %I FOR EACH ROW '
      'EXECUTE FUNCTION lyra_enforce_workspace_scope()', table_name);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS lyra_workspace_isolation ON %I', table_name);
    EXECUTE format('CREATE POLICY lyra_workspace_isolation ON %I '
      'USING (lyra_system_bypass_enabled() OR workspace_id = lyra_current_workspace_id()) '
      'WITH CHECK (lyra_system_bypass_enabled() OR workspace_id = lyra_current_workspace_id())', table_name);
  END LOOP;
END;
$$;

COMMIT;
