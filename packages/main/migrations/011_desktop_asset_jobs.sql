CREATE TABLE desktop_asset_jobs (
  id TEXT PRIMARY KEY CHECK (id ~ '^desktop_[a-f0-9]{32}$'),
  job_key CHAR(64) NOT NULL UNIQUE,
  chapter_id TEXT NOT NULL REFERENCES novel_chapters(id),
  status TEXT NOT NULL CHECK (status IN ('queued','submitting','generating','importing','completed','needsReview','failed','unknown')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  task_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
-- One desktop is shared by every chapter and browser tab. Unknown submissions
-- keep this slot until a result is reconciled; they must never be resubmitted.
CREATE UNIQUE INDEX desktop_asset_single_active ON desktop_asset_jobs ((true))
  WHERE status IN ('queued','submitting','generating','importing','unknown');
CREATE INDEX desktop_asset_chapter ON desktop_asset_jobs (chapter_id, created_at DESC);
