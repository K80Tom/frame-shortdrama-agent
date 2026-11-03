BEGIN;

-- 023 离线优先 EvaluationRun：冻结快照、幂等创建、CAS、attempt/sample 与 append-only 事件。
-- 运行与生产任务没有外键或写入关系；快照中的生产引用只是不可变 ID。

CREATE TABLE evaluation_runs (
  run_id text PRIMARY KEY CHECK (run_id ~ '^evalrun_[a-f0-9]{32}$'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  snapshot_digest char(64) NOT NULL CHECK (snapshot_digest ~ '^[0-9a-f]{64}$'),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  status text NOT NULL CHECK (status IN (
    'prepared', 'running', 'waiting_external', 'waiting_human', 'completed', 'failed', 'cancelled'
  )),
  run_version integer NOT NULL CHECK (run_version > 0),
  replayed_from_run_id text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  started_at timestamptz NULL,
  ended_at timestamptz NULL,
  CONSTRAINT evaluation_run_idempotency UNIQUE (idempotency_key),
  CONSTRAINT evaluation_run_replay_self CHECK (replayed_from_run_id IS NULL OR replayed_from_run_id <> run_id),
  CONSTRAINT evaluation_run_replay_source FOREIGN KEY (replayed_from_run_id)
    REFERENCES evaluation_runs (run_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT evaluation_run_terminal_end CHECK (
    (status IN ('completed', 'failed', 'cancelled')) = (ended_at IS NOT NULL)
  ),
  CONSTRAINT evaluation_run_prepared_start CHECK (
    status <> 'prepared' OR (started_at IS NULL AND ended_at IS NULL)
  )
);
CREATE INDEX evaluation_run_status_idx ON evaluation_runs (status, created_at);

CREATE TABLE evaluation_case_attempts (
  case_attempt_id text PRIMARY KEY CHECK (case_attempt_id ~ '^evalattempt_[a-f0-9]{32}$'),
  run_id text NOT NULL REFERENCES evaluation_runs (run_id) ON DELETE RESTRICT,
  case_id text NOT NULL CHECK (case_id ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
  shard_index integer NOT NULL CHECK (shard_index BETWEEN 0 AND 255),
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 100),
  status text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'interrupted', 'cancelled')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NULL,
  error_json jsonb NULL CHECK (error_json IS NULL OR jsonb_typeof(error_json) = 'object'),
  CONSTRAINT evaluation_case_attempt_identity UNIQUE (run_id, case_id, attempt_number),
  CONSTRAINT evaluation_case_attempt_terminal_end CHECK (
    (status IN ('completed', 'failed', 'interrupted', 'cancelled')) = (ended_at IS NOT NULL)
  )
);
CREATE INDEX evaluation_case_attempt_run_idx ON evaluation_case_attempts (run_id, case_id, attempt_number);

CREATE TABLE evaluation_sample_attempts (
  sample_attempt_id text PRIMARY KEY CHECK (sample_attempt_id ~ '^evalsample_[a-f0-9]{32}$'),
  case_attempt_id text NOT NULL REFERENCES evaluation_case_attempts (case_attempt_id) ON DELETE RESTRICT,
  sample_index integer NOT NULL CHECK (sample_index BETWEEN 0 AND 19),
  status text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'interrupted', 'cancelled')),
  output_digest char(64) NULL CHECK (output_digest IS NULL OR output_digest ~ '^[0-9a-f]{64}$'),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  cost_micros bigint NOT NULL CHECK (cost_micros >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  error_json jsonb NULL CHECK (error_json IS NULL OR jsonb_typeof(error_json) = 'object'),
  CONSTRAINT evaluation_sample_attempt_identity UNIQUE (case_attempt_id, sample_index),
  CONSTRAINT evaluation_sample_output CHECK (
    (status = 'completed' AND output_digest IS NOT NULL)
    OR (status <> 'completed' AND output_digest IS NULL)
  )
);

CREATE TABLE evaluation_run_events (
  event_id text PRIMARY KEY CHECK (event_id ~ '^evalrunevt_[a-f0-9]{32}$'),
  run_id text NOT NULL REFERENCES evaluation_runs (run_id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 64),
  occurred_at timestamptz NOT NULL,
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  event_digest char(64) NOT NULL CHECK (event_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT evaluation_run_event_identity UNIQUE (run_id, sequence)
);

CREATE FUNCTION evaluation_run_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_RUN_TERMINAL_IMMUTABLE';
  END IF;
  IF OLD.status IN ('completed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_RUN_TERMINAL_IMMUTABLE';
  END IF;
  IF NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
    OR NEW.snapshot_digest IS DISTINCT FROM OLD.snapshot_digest
    OR NEW.snapshot_json IS DISTINCT FROM OLD.snapshot_json
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.replayed_from_run_id IS DISTINCT FROM OLD.replayed_from_run_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_RUN_TERMINAL_IMMUTABLE';
  END IF;
  IF NEW.run_version <> OLD.run_version + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_RUN_VERSION_CONFLICT';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'prepared' AND NEW.status IN ('running', 'cancelled'))
    OR (OLD.status = 'running' AND NEW.status IN ('waiting_external', 'waiting_human', 'completed', 'failed', 'cancelled'))
    OR (OLD.status IN ('waiting_external', 'waiting_human') AND NEW.status IN ('running', 'failed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_RUN_TRANSITION_INVALID';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evaluation_run_guard_trigger
  BEFORE UPDATE OR DELETE ON evaluation_runs
  FOR EACH ROW EXECUTE FUNCTION evaluation_run_guard();

CREATE FUNCTION evaluation_case_attempt_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_RUN_CASE_ATTEMPT_IMMUTABLE';
  END IF;
  IF OLD.status IN ('completed', 'failed', 'interrupted', 'cancelled') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_RUN_CASE_ATTEMPT_IMMUTABLE';
  END IF;
  IF NEW.case_attempt_id IS DISTINCT FROM OLD.case_attempt_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.case_id IS DISTINCT FROM OLD.case_id
    OR NEW.shard_index IS DISTINCT FROM OLD.shard_index
    OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
    OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_RUN_CASE_ATTEMPT_IMMUTABLE';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('running', 'completed', 'failed', 'interrupted', 'cancelled'))
    OR (OLD.status = 'running' AND NEW.status IN ('completed', 'failed', 'interrupted', 'cancelled'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_RUN_TRANSITION_INVALID';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evaluation_case_attempt_guard_trigger
  BEFORE UPDATE OR DELETE ON evaluation_case_attempts
  FOR EACH ROW EXECUTE FUNCTION evaluation_case_attempt_guard();

CREATE FUNCTION evaluation_sample_attempt_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_RUN_SAMPLE_ATTEMPT_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evaluation_sample_attempt_guard_trigger
  BEFORE UPDATE OR DELETE ON evaluation_sample_attempts
  FOR EACH ROW EXECUTE FUNCTION evaluation_sample_attempt_guard();

CREATE FUNCTION evaluation_run_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_HISTORY_APPEND_ONLY';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evaluation_run_event_append_only_trigger
  BEFORE UPDATE OR DELETE ON evaluation_run_events
  FOR EACH ROW EXECUTE FUNCTION evaluation_run_event_append_only();

COMMIT;
