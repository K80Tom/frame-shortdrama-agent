-- Immutable existing-media registrations only. No generated/demo media, no
-- source downloads, and no change to novel or screenplay records.
CREATE TABLE asset_catalog (
  id TEXT PRIMARY KEY CHECK (id ~ '^asset_[a-f0-9]{32}$'),
  kind TEXT NOT NULL CHECK (kind IN ('character', 'location', 'prop')),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200 AND name = btrim(name)),
  description TEXT NOT NULL CHECK (char_length(description) <= 2000 AND description = btrim(description)),
  resource_url TEXT NOT NULL CHECK (char_length(resource_url) BETWEEN 9 AND 2000 AND left(lower(resource_url), 8) = 'https://'),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX asset_catalog_created_idx ON asset_catalog(created_at DESC, id COLLATE "C" ASC);
