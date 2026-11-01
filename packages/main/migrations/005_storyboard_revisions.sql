ALTER TABLE projects ADD COLUMN active_storyboard_revision_id TEXT NULL;

CREATE TABLE storyboard_attempts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_plan_revision_id TEXT NOT NULL REFERENCES plan_revisions(id),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_digest CHAR(64) NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  error_code TEXT NULL,
  provider_request_id TEXT NULL,
  usage_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NULL
);
CREATE INDEX storyboard_attempts_project_created_idx ON storyboard_attempts (project_id, created_at DESC, id DESC);

CREATE TABLE storyboard_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  script_version_id TEXT NOT NULL REFERENCES script_versions(id),
  source_plan_revision_id TEXT NOT NULL REFERENCES plan_revisions(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES storyboard_attempts(id),
  content_json JSONB NOT NULL CHECK (jsonb_typeof(content_json) = 'object'),
  input_digest CHAR(64) NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_request_id TEXT NULL,
  usage_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX storyboard_revisions_project_created_idx ON storyboard_revisions (project_id, created_at DESC, id DESC);
ALTER TABLE projects ADD CONSTRAINT projects_active_storyboard_revision_fk
  FOREIGN KEY (active_storyboard_revision_id) REFERENCES storyboard_revisions(id);

CREATE TABLE storyboard_adoptions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_revision_id TEXT NULL REFERENCES storyboard_revisions(id),
  to_revision_id TEXT NOT NULL REFERENCES storyboard_revisions(id),
  source_plan_revision_id TEXT NOT NULL REFERENCES plan_revisions(id),
  actor TEXT NOT NULL CHECK (actor = 'user'),
  created_at TIMESTAMPTZ NOT NULL
);
