BEGIN;

-- Add tenant identity to the existing unified Outbox and its consumer state.
-- Historical DataEventV1 rows are mapped to the reserved legacy workspace; the
-- event payload and event_digest are deliberately left byte-for-byte unchanged.

ALTER TABLE data_outbox_events
  ADD COLUMN workspace_id text NULL REFERENCES workspaces(id) ON DELETE RESTRICT;
UPDATE data_outbox_events
SET workspace_id = 'ws_00000000000000000000000000000000'
WHERE workspace_id IS NULL;
ALTER TABLE data_outbox_events
  ALTER COLUMN workspace_id SET DEFAULT 'ws_00000000000000000000000000000000',
  ALTER COLUMN workspace_id SET NOT NULL;

-- Aggregate versions are ordered inside one tenant. Keeping event_id globally
-- unique still makes consumer idempotency independent of tenant lookup.
ALTER TABLE data_outbox_events DROP CONSTRAINT data_outbox_aggregate_version_unique;
ALTER TABLE data_outbox_events
  ADD CONSTRAINT data_outbox_aggregate_version_unique
  UNIQUE (workspace_id, aggregate_type, aggregate_id, aggregate_version);
CREATE INDEX data_outbox_workspace_pending_idx
  ON data_outbox_events (workspace_id, available_at, occurred_at)
  WHERE status IN ('pending', 'failed');

CREATE OR REPLACE FUNCTION data_outbox_event_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DATA_OUTBOX_TRANSACTION_REQUIRED';
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.event_type IS DISTINCT FROM OLD.event_type
    OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
    OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
    OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
    OR NEW.aggregate_version IS DISTINCT FROM OLD.aggregate_version
    OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
    OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
    OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.authoritative_ref_json IS DISTINCT FROM OLD.authoritative_ref_json
    OR NEW.payload_json IS DISTINCT FROM OLD.payload_json
    OR NEW.event_digest IS DISTINCT FROM OLD.event_digest THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DATA_OUTBOX_TRANSACTION_REQUIRED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE data_consumer_records
  ADD COLUMN workspace_id text NULL REFERENCES workspaces(id) ON DELETE RESTRICT;
UPDATE data_consumer_records record
SET workspace_id = event.workspace_id
FROM data_outbox_events event
WHERE record.event_id = event.event_id AND record.workspace_id IS NULL;
UPDATE data_consumer_records
SET workspace_id = 'ws_00000000000000000000000000000000'
WHERE workspace_id IS NULL;
ALTER TABLE data_consumer_records
  ALTER COLUMN workspace_id SET DEFAULT 'ws_00000000000000000000000000000000',
  ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE data_projection_records
  ADD COLUMN workspace_id text NULL REFERENCES workspaces(id) ON DELETE RESTRICT;
UPDATE data_projection_records record
SET workspace_id = event.workspace_id
FROM data_outbox_events event
WHERE record.event_id = event.event_id AND record.workspace_id IS NULL;
UPDATE data_projection_records
SET workspace_id = 'ws_00000000000000000000000000000000'
WHERE workspace_id IS NULL;
ALTER TABLE data_projection_records
  ALTER COLUMN workspace_id SET DEFAULT 'ws_00000000000000000000000000000000',
  ALTER COLUMN workspace_id SET NOT NULL;
DROP INDEX data_projection_aggregate_idx;
CREATE INDEX data_projection_aggregate_idx
  ON data_projection_records
  (consumer_name, workspace_id, aggregate_type, aggregate_id, aggregate_version);

ALTER TABLE data_consumer_checkpoints
  ADD COLUMN workspace_id text NULL REFERENCES workspaces(id) ON DELETE RESTRICT;
UPDATE data_consumer_checkpoints checkpoint
SET workspace_id = event.workspace_id
FROM data_outbox_events event
WHERE checkpoint.event_id = event.event_id AND checkpoint.workspace_id IS NULL;
UPDATE data_consumer_checkpoints
SET workspace_id = 'ws_00000000000000000000000000000000'
WHERE workspace_id IS NULL;
ALTER TABLE data_consumer_checkpoints
  ALTER COLUMN workspace_id SET DEFAULT 'ws_00000000000000000000000000000000',
  ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE data_dead_letters
  ADD COLUMN workspace_id text NULL REFERENCES workspaces(id) ON DELETE RESTRICT;
UPDATE data_dead_letters record
SET workspace_id = event.workspace_id
FROM data_outbox_events event
WHERE record.event_id = event.event_id AND record.workspace_id IS NULL;
UPDATE data_dead_letters
SET workspace_id = 'ws_00000000000000000000000000000000'
WHERE workspace_id IS NULL;
ALTER TABLE data_dead_letters
  ALTER COLUMN workspace_id SET DEFAULT 'ws_00000000000000000000000000000000',
  ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE data_quarantine_records
  ADD COLUMN workspace_id text NULL REFERENCES workspaces(id) ON DELETE RESTRICT;
UPDATE data_quarantine_records record
SET workspace_id = event.workspace_id
FROM data_outbox_events event
WHERE record.event_id = event.event_id AND record.workspace_id IS NULL;
UPDATE data_quarantine_records
SET workspace_id = 'ws_00000000000000000000000000000000'
WHERE workspace_id IS NULL;
ALTER TABLE data_quarantine_records
  ALTER COLUMN workspace_id SET DEFAULT 'ws_00000000000000000000000000000000',
  ALTER COLUMN workspace_id SET NOT NULL;

COMMIT;
