BEGIN;

-- PostgreSQL-backed Stage 1 task queue. production_runs remains the business
-- aggregate; jobs only owns high-frequency scheduling, leases and checkpoints.

CREATE TABLE jobs (
  id text PRIMARY KEY CHECK (id ~ '^job_[a-f0-9]{32}$'),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  queue_name text NOT NULL CHECK (queue_name ~ '^[a-z][a-z0-9_-]{1,63}$'),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.-]{2,95}$'),
  aggregate_type text NULL CHECK (
    aggregate_type IS NULL OR aggregate_type ~ '^[a-z][a-z0-9_.-]{1,63}$'
  ),
  aggregate_id text NULL CHECK (
    aggregate_id IS NULL OR aggregate_id ~ '^[A-Za-z][A-Za-z0-9_.:-]{2,159}$'
  ),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  state text NOT NULL CHECK (state IN (
    'queued', 'running', 'succeeded', 'failed', 'cancelled', 'dead_letter'
  )),
  priority smallint NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  max_attempts smallint NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (
    attempt_count >= 0 AND attempt_count <= max_attempts
  ),
  available_at timestamptz NOT NULL,
  lease_owner text NULL CHECK (lease_owner IS NULL OR char_length(lease_owner) BETWEEN 3 AND 160),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_expires_at timestamptz NULL,
  heartbeat_at timestamptz NULL,
  last_error text NULL CHECK (last_error IS NULL OR char_length(last_error) <= 2000),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz NULL,
  CONSTRAINT jobs_workspace_id_identity UNIQUE (workspace_id, id),
  CONSTRAINT jobs_workspace_idempotency UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT jobs_aggregate_pair CHECK ((aggregate_type IS NULL) = (aggregate_id IS NULL)),
  CONSTRAINT jobs_running_lease CHECK (
    (state = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL)
    OR (state <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL AND heartbeat_at IS NULL)
  ),
  CONSTRAINT jobs_terminal_time CHECK (
    (state IN ('succeeded', 'failed', 'cancelled', 'dead_letter')) = (completed_at IS NOT NULL)
  )
);

CREATE INDEX jobs_claim_idx
  ON jobs (queue_name, priority DESC, available_at, created_at, id)
  WHERE state = 'queued';
CREATE INDEX jobs_expired_lease_idx
  ON jobs (queue_name, lease_expires_at, id)
  WHERE state = 'running';
CREATE INDEX jobs_workspace_state_idx
  ON jobs (workspace_id, state, updated_at DESC, id DESC);

CREATE TABLE job_attempts (
  id text PRIMARY KEY CHECK (id ~ '^jobatt_[a-f0-9]{32}$'),
  workspace_id text NOT NULL,
  job_id text NOT NULL,
  attempt_number smallint NOT NULL CHECK (attempt_number BETWEEN 1 AND 100),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  worker_id text NOT NULL CHECK (char_length(worker_id) BETWEEN 3 AND 160),
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'lost', 'cancelled')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NULL,
  error_json jsonb NULL CHECK (error_json IS NULL OR jsonb_typeof(error_json) = 'object'),
  CONSTRAINT job_attempts_job_fk FOREIGN KEY (workspace_id, job_id)
    REFERENCES jobs (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT job_attempts_number_unique UNIQUE (job_id, attempt_number),
  CONSTRAINT job_attempts_fence_unique UNIQUE (job_id, fencing_token),
  CONSTRAINT job_attempts_end_state CHECK (
    (status = 'running') = (ended_at IS NULL)
  )
);
CREATE INDEX job_attempts_workspace_job_idx
  ON job_attempts (workspace_id, job_id, attempt_number DESC);

CREATE TABLE job_steps (
  workspace_id text NOT NULL,
  job_id text NOT NULL,
  step_key text NOT NULL CHECK (step_key ~ '^[a-z][a-z0-9_.-]{1,95}$'),
  status text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  checkpoint_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checkpoint_json) = 'object'),
  output_ref_json jsonb NULL CHECK (output_ref_json IS NULL OR jsonb_typeof(output_ref_json) = 'object'),
  error_json jsonb NULL CHECK (error_json IS NULL OR jsonb_typeof(error_json) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz NULL,
  PRIMARY KEY (job_id, step_key),
  CONSTRAINT job_steps_job_fk FOREIGN KEY (workspace_id, job_id)
    REFERENCES jobs (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT job_steps_end_state CHECK (
    (status IN ('succeeded', 'failed', 'skipped')) = (completed_at IS NOT NULL)
  )
);
CREATE INDEX job_steps_workspace_job_idx
  ON job_steps (workspace_id, job_id, status, step_key);

COMMIT;
