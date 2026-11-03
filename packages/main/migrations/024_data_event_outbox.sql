BEGIN;

-- 024 统一事务 Outbox：业务事实与事件必须由同一个 PoolClient 提交。
-- 旧 production_outbox_events 保留原表和历史顺序，由 data/legacy.ts 做一次性、可重入映射。

CREATE TABLE data_outbox_events (
  outbox_id text PRIMARY KEY CHECK (outbox_id ~ '^obox_[a-f0-9]{32}$'),
  event_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2}$'),
  schema_version text NOT NULL CHECK (schema_version ~ '^lyra\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*/v[1-9][0-9]*$'),
  aggregate_type text NOT NULL CHECK (aggregate_type IN (
    'novel_chapter', 'script', 'asset', 'production_run', 'production_attempt',
    'external_operation', 'quality_check', 'delivery_artifact', 'evaluation_run'
  )),
  aggregate_id text NOT NULL CHECK (aggregate_id ~ '^[A-Za-z][A-Za-z0-9_.:-]{2,159}$'),
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  correlation_id text NOT NULL CHECK (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$'),
  causation_id text NULL CHECK (causation_id IS NULL OR causation_id ~ '^evt_[a-f0-9]{32}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{7,159}$'),
  authoritative_ref_json jsonb NOT NULL CHECK (jsonb_typeof(authoritative_ref_json) = 'object'),
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  event_digest char(64) NOT NULL CHECK (event_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'published', 'failed', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL,
  published_at timestamptz NULL,
  last_error text NULL CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
  legacy_source text NULL CHECK (legacy_source IS NULL OR char_length(legacy_source) <= 64),
  legacy_event_id text NULL CHECK (legacy_event_id IS NULL OR char_length(legacy_event_id) <= 160),
  created_at timestamptz NOT NULL,
  CONSTRAINT data_outbox_event_id_unique UNIQUE (event_id),
  CONSTRAINT data_outbox_aggregate_version_unique UNIQUE (aggregate_type, aggregate_id, aggregate_version),
  CONSTRAINT data_outbox_legacy_identity UNIQUE (legacy_source, legacy_event_id),
  CONSTRAINT data_outbox_occurred_before_recorded CHECK (occurred_at <= recorded_at),
  CONSTRAINT data_outbox_published_state CHECK (
    (status = 'published' AND published_at IS NOT NULL)
    OR (status <> 'published' AND published_at IS NULL)
  )
);
CREATE INDEX data_outbox_pending_idx ON data_outbox_events (available_at, occurred_at)
  WHERE status IN ('pending', 'failed');

CREATE FUNCTION data_outbox_event_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DATA_OUTBOX_TRANSACTION_REQUIRED';
  END IF;
  IF NEW.event_id IS DISTINCT FROM OLD.event_id
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

CREATE TRIGGER data_outbox_event_immutable_trigger
  BEFORE UPDATE OR DELETE ON data_outbox_events
  FOR EACH ROW EXECUTE FUNCTION data_outbox_event_immutable();

-- 消费者侧投影状态：投影、已处理记录与 checkpoint 由同一个数据库事务提交。
CREATE TABLE data_consumer_records (
  consumer_name text NOT NULL CHECK (consumer_name ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$'),
  event_id text NOT NULL CHECK (event_id ~ '^evt_[a-f0-9]{32}$'),
  processed_at timestamptz NOT NULL,
  PRIMARY KEY (consumer_name, event_id)
);

CREATE TABLE data_projection_records (
  projection_id text PRIMARY KEY CHECK (projection_id ~ '^projection_[a-f0-9]{32}$'),
  consumer_name text NOT NULL CHECK (consumer_name ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$'),
  event_id text NOT NULL CHECK (event_id ~ '^evt_[a-f0-9]{32}$'),
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  projection_json jsonb NOT NULL CHECK (jsonb_typeof(projection_json) = 'object'),
  created_at timestamptz NOT NULL,
  UNIQUE (consumer_name, event_id)
);
CREATE INDEX data_projection_aggregate_idx
  ON data_projection_records (consumer_name, aggregate_type, aggregate_id, aggregate_version);

CREATE TABLE data_consumer_checkpoints (
  consumer_name text PRIMARY KEY CHECK (consumer_name ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$'),
  event_id text NOT NULL CHECK (event_id ~ '^evt_[a-f0-9]{32}$'),
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  updated_at timestamptz NOT NULL
);

CREATE TABLE data_dead_letters (
  dead_letter_id bigserial PRIMARY KEY,
  consumer_name text NOT NULL CHECK (consumer_name ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$'),
  event_id text NOT NULL CHECK (event_id ~ '^evt_[a-f0-9]{32}$'),
  reason text NOT NULL CHECK (char_length(reason) <= 1000),
  attempts integer NOT NULL CHECK (attempts > 0),
  created_at timestamptz NOT NULL,
  UNIQUE (consumer_name, event_id)
);

CREATE TABLE data_quarantine_records (
  quarantine_id bigserial PRIMARY KEY,
  consumer_name text NOT NULL CHECK (consumer_name ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$'),
  event_id text NOT NULL CHECK (event_id ~ '^evt_[a-f0-9]{32}$'),
  reason text NOT NULL CHECK (char_length(reason) <= 1000),
  schema_version text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (consumer_name, event_id)
);

COMMIT;
