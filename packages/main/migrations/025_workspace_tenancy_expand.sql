BEGIN;

-- Stage 1 multi-tenant expand migration.
--
-- The reserved legacy principal is disabled and exists only so pre-Stage-1 rows
-- have a deterministic owner. Runtime authentication must never issue a tenant
-- context for this principal. Existing writers remain compatible because the
-- added workspace_id columns stay nullable until the repository cut-over and a
-- later contract migration.

CREATE TABLE users (
  id text PRIMARY KEY CHECK (id ~ '^usr_[a-f0-9]{32}$'),
  subject text NOT NULL UNIQUE CHECK (char_length(subject) BETWEEN 3 AND 200),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('human', 'service', 'migration')),
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE workspaces (
  id text PRIMARY KEY CHECK (id ~ '^ws_[a-f0-9]{32}$'),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  status text NOT NULL CHECK (status IN ('active', 'suspended')),
  created_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE workspace_members (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  status text NOT NULL CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx
  ON workspace_members (user_id, status, workspace_id);

INSERT INTO users (id, subject, display_name, kind, status, created_at, updated_at)
VALUES (
  'usr_00000000000000000000000000000000',
  'migration:pre-stage-1',
  'Pre-Stage-1 migration owner',
  'migration',
  'disabled',
  '1970-01-01T00:00:00Z',
  '1970-01-01T00:00:00Z'
);

INSERT INTO workspaces (id, slug, name, status, created_by_user_id, created_at, updated_at)
VALUES (
  'ws_00000000000000000000000000000000',
  'legacy-import',
  'Pre-Stage-1 imported data',
  'suspended',
  'usr_00000000000000000000000000000000',
  '1970-01-01T00:00:00Z',
  '1970-01-01T00:00:00Z'
);

INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
VALUES (
  'ws_00000000000000000000000000000000',
  'usr_00000000000000000000000000000000',
  'owner',
  'inactive',
  '1970-01-01T00:00:00Z',
  '1970-01-01T00:00:00Z'
);

-- All tenant-owned tables receive the reserved workspace as an ADD COLUMN
-- constant default. PostgreSQL backfills this without firing immutable domain
-- triggers. The default is removed immediately so a forgotten tenant write is
-- visible as NULL during the expand window instead of silently leaking into the
-- legacy workspace. Registry policy and registry events remain platform-global.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'projects', 'script_versions', 'breakdown_runs', 'breakdown_tasks',
    'breakdown_attempts', 'model_calls', 'plan_revisions', 'plan_checks',
    'plan_issues', 'plan_adoptions', 'storyboard_attempts',
    'storyboard_revisions', 'storyboard_adoptions', 'novel_sources',
    'novel_chapters', 'novel_revisions', 'novel_attempts', 'asset_catalog',
    'asset_media', 'desktop_asset_jobs', 'asset_generation_candidates',
    'video_automation_runs', 'production_runs', 'production_outbox_events',
    'assistant_sessions', 'assistant_messages', 'assistant_quotes',
    'prompt_pack_states', 'prompt_pack_imports', 'evaluation_datasets',
    'evaluation_dataset_revisions', 'evaluation_cases', 'evaluation_rubrics',
    'evaluation_rubric_revisions', 'evaluation_rubric_dimensions',
    'evaluation_revision_usage', 'evaluation_lifecycle_events',
    'evaluation_runs', 'evaluation_case_attempts',
    'evaluation_sample_attempts', 'evaluation_run_events',
    'evolution_evidence', 'evolution_proposals', 'evolution_candidates',
    'evolution_probes'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN workspace_id text NULL DEFAULT %L REFERENCES workspaces(id)',
      table_name,
      'ws_00000000000000000000000000000000'
    );
    EXECUTE format('ALTER TABLE %I ALTER COLUMN workspace_id DROP DEFAULT', table_name);
  END LOOP;
END;
$$;

-- Query-supporting indexes are additive; existing global uniqueness remains in
-- place during expand and is replaced only after every repository scopes writes.
CREATE INDEX projects_workspace_created_idx ON projects (workspace_id, created_at DESC, id DESC);
CREATE INDEX script_versions_workspace_project_idx ON script_versions (workspace_id, project_id, version DESC);
CREATE INDEX breakdown_runs_workspace_project_idx ON breakdown_runs (workspace_id, project_id, created_at DESC);
CREATE INDEX novel_sources_workspace_created_idx ON novel_sources (workspace_id, created_at DESC, id DESC);
CREATE INDEX asset_catalog_workspace_created_idx ON asset_catalog (workspace_id, created_at DESC, id DESC);
CREATE INDEX desktop_asset_jobs_workspace_status_idx ON desktop_asset_jobs (workspace_id, status, created_at DESC);
CREATE INDEX video_automation_runs_workspace_status_idx ON video_automation_runs (workspace_id, status, created_at DESC);
CREATE INDEX production_runs_workspace_updated_idx ON production_runs (workspace_id, updated_at DESC, id DESC);
CREATE INDEX assistant_sessions_workspace_context_idx ON assistant_sessions (workspace_id, context_key, updated_at DESC);
CREATE INDEX assistant_messages_workspace_session_idx ON assistant_messages (workspace_id, session_id, seq);
CREATE INDEX prompt_pack_imports_workspace_created_idx ON prompt_pack_imports (workspace_id, created_at DESC, id);
CREATE INDEX evaluation_datasets_workspace_created_idx ON evaluation_datasets (workspace_id, created_at DESC, id);
CREATE INDEX evaluation_rubrics_workspace_created_idx ON evaluation_rubrics (workspace_id, created_at DESC, id);
CREATE INDEX evaluation_runs_workspace_status_idx ON evaluation_runs (workspace_id, status, created_at, run_id);
CREATE INDEX evolution_evidence_workspace_created_idx ON evolution_evidence (workspace_id, created_at DESC, id);

COMMIT;
