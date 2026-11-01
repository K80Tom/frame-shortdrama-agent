-- Persist local raster imports atomically with their immutable catalogue entry.
-- Existing external HTTPS registrations remain unchanged.
ALTER TABLE asset_catalog DROP CONSTRAINT asset_catalog_resource_url_check;
ALTER TABLE asset_catalog ADD CONSTRAINT asset_catalog_resource_url_check CHECK (
  (char_length(resource_url) BETWEEN 9 AND 2000 AND left(lower(resource_url), 8) = 'https://')
  OR resource_url = '/api/assets/' || id || '/content'
);
CREATE TABLE asset_media (
  asset_id TEXT PRIMARY KEY REFERENCES asset_catalog(id) ON DELETE CASCADE,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  content BYTEA NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 6291456)
);
