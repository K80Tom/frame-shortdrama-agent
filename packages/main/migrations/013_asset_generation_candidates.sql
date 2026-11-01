-- Generated images are immutable catalogue entries first. They become novel
-- bindings only after an explicit, version-checked human acceptance decision.
ALTER TABLE desktop_asset_jobs DROP CONSTRAINT desktop_asset_jobs_status_check;
ALTER TABLE desktop_asset_jobs ADD CONSTRAINT desktop_asset_jobs_status_check CHECK (
  status IN ('queued','submitting','generating','importing','awaitingReview','accepted','rejected','completed','needsReview','failed','unknown')
);

CREATE TABLE asset_generation_candidates (
  id TEXT PRIMARY KEY CHECK (id ~ '^candidate_[a-f0-9]{32}$'),
  task_id TEXT NOT NULL UNIQUE REFERENCES desktop_asset_jobs(id),
  asset_id TEXT NOT NULL UNIQUE REFERENCES asset_catalog(id),
  chapter_id TEXT NOT NULL REFERENCES novel_chapters(id),
  item_id TEXT NOT NULL CHECK (char_length(item_id) BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK (status IN ('awaitingReview','accepted','rejected','needsReview')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  provenance_json JSONB NOT NULL CHECK (jsonb_typeof(provenance_json) = 'object'),
  review_note TEXT NOT NULL DEFAULT '' CHECK (char_length(review_note) <= 2000),
  accepted_revision_id TEXT REFERENCES novel_revisions(id),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK ((status = 'accepted' AND accepted_revision_id IS NOT NULL)
    OR (status <> 'accepted' AND accepted_revision_id IS NULL))
);
CREATE INDEX asset_generation_candidate_item_status_idx
  ON asset_generation_candidates(chapter_id, item_id, status, created_at DESC);
CREATE INDEX asset_generation_candidate_task_version_idx
  ON asset_generation_candidates(task_id, version);
