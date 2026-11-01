-- P0.5: immutable program checks, actionable issues, and compare-and-swap adoption.
CREATE TABLE plan_checks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_revision_id TEXT NOT NULL REFERENCES plan_revisions(id) ON DELETE CASCADE,
  rule_version TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method = 'program'),
  result TEXT NOT NULL CHECK (result IN ('passed', 'failed')),
  content_digest CHAR(64) NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX plan_checks_revision_created_idx ON plan_checks (plan_revision_id, created_at DESC, id DESC);

CREATE TABLE plan_issues (
  id TEXT PRIMARY KEY,
  check_id TEXT NOT NULL REFERENCES plan_checks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_revision_id TEXT NOT NULL REFERENCES plan_revisions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('validation', 'storyAmbiguity')),
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  scope_json JSONB NOT NULL CHECK (jsonb_typeof(scope_json) = 'object'),
  source_refs_json JSONB NOT NULL CHECK (jsonb_typeof(source_refs_json) = 'array'),
  blocking BOOLEAN NOT NULL,
  status TEXT NOT NULL CHECK (status = 'open'),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX plan_issues_check_idx ON plan_issues (check_id, id);

CREATE TABLE plan_adoptions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_revision_id TEXT NULL REFERENCES plan_revisions(id),
  to_revision_id TEXT NOT NULL REFERENCES plan_revisions(id),
  check_id TEXT NOT NULL REFERENCES plan_checks(id),
  actor TEXT NOT NULL CHECK (actor = 'user'),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX plan_adoptions_project_created_idx ON plan_adoptions (project_id, created_at DESC, id DESC);
