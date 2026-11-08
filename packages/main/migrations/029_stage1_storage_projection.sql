BEGIN;

-- Stage 1 durable metadata for private object bytes. The object store owns the
-- bytes; PostgreSQL owns authorization, lifecycle state and checksum truth.
CREATE TABLE object_records (
  id text PRIMARY KEY CHECK (id ~ '^obj_[a-f0-9]{32}$'),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('local', 'minio', 's3', 'oss', 'cos')),
  bucket text NOT NULL CHECK (char_length(bucket) BETWEEN 2 AND 128),
  object_key text NOT NULL CHECK (
    char_length(object_key) BETWEEN 1 AND 1024
    AND object_key !~ '(^/|/$|(^|/)\.\.?(/|$)|\\)'
  ),
  version_id text NULL CHECK (version_id IS NULL OR char_length(version_id) <= 512),
  etag text NULL CHECK (etag IS NULL OR char_length(etag) <= 512),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  content_type text NOT NULL CHECK (content_type ~ '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$'),
  purpose text NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  owner_type text NOT NULL CHECK (owner_type ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  owner_id text NOT NULL CHECK (owner_id ~ '^[A-Za-z][A-Za-z0-9_.:-]{2,159}$'),
  job_id text NULL,
  status text NOT NULL CHECK (status IN ('uploading', 'ready', 'failed', 'deleting', 'deleted')),
  last_error text NULL CHECK (last_error IS NULL OR char_length(last_error) <= 2000),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  verified_at timestamptz NULL,
  deleted_at timestamptz NULL,
  CONSTRAINT object_records_workspace_identity UNIQUE (workspace_id, id),
  CONSTRAINT object_records_job_fk FOREIGN KEY (workspace_id, job_id)
    REFERENCES jobs (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT object_records_physical_identity UNIQUE
    (workspace_id, provider, bucket, object_key, sha256),
  CONSTRAINT object_records_ready_verified CHECK (
    (status = 'ready' AND verified_at IS NOT NULL AND deleted_at IS NULL)
    OR (status <> 'ready')
  ),
  CONSTRAINT object_records_deleted_time CHECK (
    (status = 'deleted') = (deleted_at IS NOT NULL)
  )
);
CREATE INDEX object_records_owner_idx
  ON object_records (workspace_id, owner_type, owner_id, created_at DESC, id DESC);
CREATE INDEX object_records_gc_idx
  ON object_records (updated_at, id)
  WHERE status IN ('uploading', 'failed', 'deleting');

-- Redis snapshots use this monotonic fact-source version. Existing sessions
-- recover both cursors from MAX(message.seq); Redis never becomes authoritative.
ALTER TABLE assistant_sessions
  ADD COLUMN conversation_version bigint NOT NULL DEFAULT 0 CHECK (conversation_version >= 0),
  ADD COLUMN last_message_seq bigint NOT NULL DEFAULT 0 CHECK (last_message_seq >= 0);
UPDATE assistant_sessions session
SET conversation_version = history.last_message_seq,
    last_message_seq = history.last_message_seq
FROM (
  SELECT session_id, COALESCE(MAX(seq), 0)::bigint AS last_message_seq
  FROM assistant_messages
  GROUP BY session_id
) history
WHERE history.session_id = session.id;

-- PostgreSQL cursor/status for rebuildable Milvus v2 projections. Ordinary
-- asset changes mark a row stale; only an explicitly authorized job may move it
-- to indexing and perform paid embedding work.
CREATE TABLE vector_projection_states (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  collection_name text NOT NULL CHECK (collection_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  source_type text NOT NULL CHECK (source_type IN ('asset', 'script', 'novel_chunk')),
  source_id text NOT NULL CHECK (source_id ~ '^[A-Za-z][A-Za-z0-9_.:-]{2,159}$'),
  source_version text NOT NULL CHECK (char_length(source_version) BETWEEN 1 AND 160),
  status text NOT NULL CHECK (status IN ('stale', 'queued', 'indexing', 'indexed', 'failed', 'deleted')),
  embedding_model text NULL CHECK (embedding_model IS NULL OR char_length(embedding_model) <= 255),
  embedding_dimension integer NULL CHECK (embedding_dimension IS NULL OR embedding_dimension BETWEEN 1 AND 16384),
  text_hash char(64) NULL CHECK (text_hash IS NULL OR text_hash ~ '^[a-f0-9]{64}$'),
  indexed_version text NULL CHECK (indexed_version IS NULL OR char_length(indexed_version) <= 160),
  job_id text NULL,
  last_error text NULL CHECK (last_error IS NULL OR char_length(last_error) <= 2000),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  indexed_at timestamptz NULL,
  PRIMARY KEY (workspace_id, collection_name, source_type, source_id),
  CONSTRAINT vector_projection_job_fk FOREIGN KEY (workspace_id, job_id)
    REFERENCES jobs (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT vector_projection_indexed_state CHECK (
    (status = 'indexed' AND indexed_version IS NOT NULL AND indexed_at IS NOT NULL
      AND embedding_model IS NOT NULL AND embedding_dimension IS NOT NULL AND text_hash IS NOT NULL)
    OR status <> 'indexed'
  )
);
CREATE INDEX vector_projection_rebuild_idx
  ON vector_projection_states (workspace_id, collection_name, status, updated_at, source_id)
  WHERE status IN ('stale', 'queued', 'failed');

-- Cross-process liveness is persisted separately from business jobs. API
-- readiness can therefore report the independent Worker truthfully instead of
-- assuming that another container exists.
CREATE TABLE runtime_heartbeats (
  instance_id text PRIMARY KEY CHECK (instance_id ~ '^runtime_[a-f0-9]{32}$'),
  role text NOT NULL CHECK (role IN ('api', 'worker', 'all')),
  started_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (last_seen_at >= started_at),
  CHECK (expires_at > last_seen_at)
);
CREATE INDEX runtime_heartbeats_role_expiry_idx
  ON runtime_heartbeats (role, expires_at DESC);

COMMIT;
