-- Independent novel reading/proofreading records. No screenplay conversion and
-- no changes to existing projects. Applied only by the explicit migration CLI.
CREATE TABLE novel_sources (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  content_sha256 CHAR(64) NOT NULL,
  source_url TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE novel_chapters (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES novel_sources(id) ON DELETE CASCADE,
  chapter_order INTEGER NOT NULL CHECK (chapter_order > 0),
  title TEXT NOT NULL,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
  latest_revision_id TEXT,
  UNIQUE (document_id, chapter_order)
);

CREATE TABLE novel_revisions (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES novel_chapters(id) ON DELETE CASCADE,
  parent_revision_id TEXT,
  created_by TEXT NOT NULL CHECK (created_by IN ('model', 'user', 'program')),
  created_at TIMESTAMPTZ NOT NULL,
  content_json JSONB NOT NULL CHECK (jsonb_typeof(content_json) = 'object'),
  revision_order BIGSERIAL NOT NULL UNIQUE,
  UNIQUE (id, chapter_id),
  FOREIGN KEY (parent_revision_id, chapter_id) REFERENCES novel_revisions(id, chapter_id)
    DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE novel_chapters ADD CONSTRAINT novel_chapters_latest_revision_fk
  FOREIGN KEY (latest_revision_id, id) REFERENCES novel_revisions(id, chapter_id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX novel_revisions_chapter_order_idx ON novel_revisions(chapter_id, revision_order);

CREATE TABLE novel_attempts (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES novel_chapters(id) ON DELETE CASCADE,
  expected_revision_id TEXT,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitted', 'succeeded', 'failed', 'unknown')),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  error_code TEXT,
  usage_json JSONB,
  revision_id TEXT,
  attempt_order BIGSERIAL NOT NULL UNIQUE,
  FOREIGN KEY (expected_revision_id, chapter_id) REFERENCES novel_revisions(id, chapter_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (revision_id, chapter_id) REFERENCES novel_revisions(id, chapter_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK ((status = 'submitted' AND ended_at IS NULL AND error_code IS NULL AND revision_id IS NULL)
    OR (status <> 'submitted' AND ended_at IS NOT NULL)),
  CHECK (status <> 'succeeded' OR (revision_id IS NOT NULL AND error_code IS NULL))
);
-- Unknown means that the previous request may still have incurred a charge.
-- Neither restart nor another browser tab may silently issue a duplicate call.
CREATE UNIQUE INDEX novel_attempts_one_pending_idx ON novel_attempts(chapter_id)
  WHERE status IN ('submitted', 'unknown');
CREATE INDEX novel_attempts_chapter_order_idx ON novel_attempts(chapter_id, attempt_order);
