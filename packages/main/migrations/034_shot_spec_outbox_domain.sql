BEGIN;
-- Additive domain registration in the EXISTING unified Outbox. No event rows
-- are rewritten and historical V1 digests/idempotency semantics stay intact.
ALTER TABLE data_outbox_events DROP CONSTRAINT data_outbox_events_aggregate_type_check;
ALTER TABLE data_outbox_events ADD CONSTRAINT data_outbox_events_aggregate_type_check CHECK (aggregate_type IN (
  'novel_chapter', 'script', 'asset', 'production_run', 'production_attempt',
  'external_operation', 'quality_check', 'delivery_artifact', 'evaluation_run', 'shot_spec'
));
COMMIT;
