BEGIN;

-- A Milvus upsert is external to PostgreSQL. Persist the job fencing token so
-- an expired attempt cannot mark a projection indexed after a newer attempt
-- has taken ownership. Stale vectors are harmless because reads hydrate and
-- verify source_version against PostgreSQL, but projection metadata must still
-- have one authoritative writer.
ALTER TABLE vector_projection_states
  ADD COLUMN fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0);

-- Migration 026 added workspace_id to checkpoints but retained the legacy
-- global primary key. One consumer must be able to advance independently in
-- every workspace; otherwise the second tenant conflicts with an RLS-hidden
-- row owned by the first tenant.
ALTER TABLE data_consumer_checkpoints
  DROP CONSTRAINT data_consumer_checkpoints_pkey,
  ADD PRIMARY KEY (consumer_name, workspace_id);

COMMIT;
