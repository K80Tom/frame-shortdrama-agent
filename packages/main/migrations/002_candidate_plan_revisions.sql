-- P0.3: immutable, program-validated extractFacts candidates.
-- Adoption, checks, attempts and model calls remain separate future migrations.

CREATE TABLE plan_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES breakdown_runs(id) ON DELETE CASCADE,
  source_task_id TEXT NOT NULL REFERENCES breakdown_tasks(id) ON DELETE CASCADE,
  parent_revision_id TEXT NULL REFERENCES plan_revisions(id),
  rebased_from_revision_id TEXT NULL REFERENCES plan_revisions(id),
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL CHECK (created_by = 'agent'),
  reason TEXT NOT NULL CHECK (reason = 'extract'),
  scope_json JSONB NOT NULL CHECK (jsonb_typeof(scope_json) = 'object'),
  requirements_json JSONB NOT NULL CHECK (jsonb_typeof(requirements_json) = 'object'),
  content_json JSONB NOT NULL CHECK (jsonb_typeof(content_json) = 'object'),
  status TEXT NOT NULL CHECK (status = 'candidate'),
  validator_version TEXT NOT NULL,
  CHECK (parent_revision_id IS NULL),
  CHECK (rebased_from_revision_id IS NULL)
);

CREATE INDEX plan_revisions_run_created_idx ON plan_revisions (run_id, created_at, id);

ALTER TABLE projects ADD COLUMN active_plan_revision_id TEXT NULL;
ALTER TABLE projects
  ADD CONSTRAINT projects_active_plan_revision_fk
  FOREIGN KEY (active_plan_revision_id) REFERENCES plan_revisions(id)
  ON DELETE SET NULL;
