-- P0.2: immutable script/source-index records and draft-only breakdown work.
-- This migration deliberately does not add PlanRevision, model receipts, costs,
-- scheduler leases, or automatic execution.  Those need their own contracts.

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (char_length(btrim(title)) > 0),
  current_script_version_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE script_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  raw_text TEXT NOT NULL CHECK (char_length(btrim(raw_text)) > 0),
  content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  source_index_json JSONB NOT NULL CHECK (jsonb_typeof(source_index_json) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, version)
);

ALTER TABLE projects
  ADD CONSTRAINT projects_current_script_version_fk
  FOREIGN KEY (current_script_version_id) REFERENCES script_versions(id)
  ON DELETE SET NULL;

CREATE INDEX script_versions_project_version_idx ON script_versions (project_id, version DESC);

CREATE TABLE breakdown_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target TEXT NOT NULL CHECK (target = 'breakdown'),
  script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
  requirements_json JSONB NOT NULL CHECK (jsonb_typeof(requirements_json) = 'object'),
  model_config_json JSONB NOT NULL CHECK (jsonb_typeof(model_config_json) = 'object'),
  scope_json JSONB NOT NULL CHECK (jsonb_typeof(scope_json) = 'object'),
  mode TEXT NOT NULL CHECK (mode IN ('auto', 'checkpoints')),
  human_checkpoints_json JSONB NOT NULL CHECK (jsonb_typeof(human_checkpoints_json) = 'array'),
  status TEXT NOT NULL CHECK (status = 'draft'),
  max_model_calls INTEGER NOT NULL CHECK (max_model_calls > 0 AND max_model_calls <= 8),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens >= 256 AND max_output_tokens <= 32768),
  sealed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX breakdown_runs_project_created_idx ON breakdown_runs (project_id, created_at DESC);

CREATE TABLE breakdown_tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES breakdown_runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type = 'extractFacts'),
  scope_json JSONB NOT NULL CHECK (jsonb_typeof(scope_json) = 'object'),
  input_manifest_json JSONB NOT NULL CHECK (jsonb_typeof(input_manifest_json) = 'object'),
  state TEXT NOT NULL CHECK (state = 'pending'),
  max_model_calls INTEGER NOT NULL CHECK (max_model_calls > 0 AND max_model_calls <= 8),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens >= 256 AND max_output_tokens <= 32768),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, type)
);

CREATE INDEX breakdown_tasks_run_idx ON breakdown_tasks (run_id);
