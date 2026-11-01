-- P0.4: one controlled extractFacts execution attempt and its model-call ledger.
-- The first implementation is exercised with a fake adapter; these tables are
-- provider-neutral so a Pi Agent Core executor can be connected later.

ALTER TABLE breakdown_runs DROP CONSTRAINT breakdown_runs_status_check;
ALTER TABLE breakdown_runs ADD CONSTRAINT breakdown_runs_status_check
  CHECK (status IN ('draft', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'));

ALTER TABLE breakdown_tasks DROP CONSTRAINT breakdown_tasks_state_check;
ALTER TABLE breakdown_tasks ADD CONSTRAINT breakdown_tasks_state_check
  CHECK (state IN (
    'pending', 'ready', 'running', 'waitingExternal', 'waitingHuman',
    'retryWait', 'reconciling', 'succeeded', 'failed', 'cancelled'
  ));

CREATE TABLE breakdown_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES breakdown_tasks(id) ON DELETE CASCADE,
  number INTEGER NOT NULL CHECK (number > 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'unknown', 'cancelled')),
  prompt_version TEXT NOT NULL,
  executor_version TEXT NOT NULL,
  input_digest CHAR(64) NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  output_plan_revision_id TEXT NULL REFERENCES plan_revisions(id) ON DELETE SET NULL,
  error_json JSONB NULL CHECK (error_json IS NULL OR jsonb_typeof(error_json) = 'object'),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NULL,
  UNIQUE (task_id, number)
);

CREATE INDEX breakdown_attempts_task_number_idx ON breakdown_attempts (task_id, number DESC);

ALTER TABLE breakdown_tasks ADD COLUMN active_attempt_id TEXT NULL;
ALTER TABLE breakdown_tasks
  ADD CONSTRAINT breakdown_tasks_active_attempt_fk
  FOREIGN KEY (active_attempt_id) REFERENCES breakdown_attempts(id) ON DELETE SET NULL;

CREATE TABLE model_calls (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES breakdown_attempts(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  request_digest CHAR(64) NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  provider_request_id TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'submitted', 'succeeded', 'failed', 'unknown')),
  usage_json JSONB NULL CHECK (usage_json IS NULL OR jsonb_typeof(usage_json) = 'object'),
  error_json JSONB NULL CHECK (error_json IS NULL OR jsonb_typeof(error_json) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NULL
);

CREATE INDEX model_calls_attempt_created_idx ON model_calls (attempt_id, created_at, id);

ALTER TABLE plan_revisions ADD COLUMN attempt_id TEXT NULL;
ALTER TABLE plan_revisions
  ADD CONSTRAINT plan_revisions_attempt_fk
  FOREIGN KEY (attempt_id) REFERENCES breakdown_attempts(id) ON DELETE SET NULL;
