-- Character voices are project-scoped associations, not fields on the global image asset.
-- Replacing a voice affects future automatic fill only; existing storyboard snapshots stay immutable.
CREATE TABLE IF NOT EXISTS character_voice_references (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  speaker_entity_id TEXT NOT NULL,
  binding_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, project_id, asset_id)
);
CREATE INDEX IF NOT EXISTS character_voice_references_project_idx
  ON character_voice_references (project_id, workspace_id, updated_at DESC);
