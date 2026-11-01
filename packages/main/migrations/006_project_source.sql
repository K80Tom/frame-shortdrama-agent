ALTER TABLE projects ADD COLUMN source_json JSONB NULL
  CHECK (source_json IS NULL OR jsonb_typeof(source_json) = 'object');
