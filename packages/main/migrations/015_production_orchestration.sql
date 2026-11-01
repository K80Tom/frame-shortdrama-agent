-- Project-level production orchestration. The aggregate is versioned with CAS;
-- outbox rows are inserted in the same transaction as every state transition.
CREATE TABLE production_runs (
  id TEXT PRIMARY KEY CHECK (id ~ '^production_[a-f0-9]{32}$'),
  client_request_id TEXT NOT NULL UNIQUE CHECK (client_request_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN (
    'queued','running','waitingHuman','paused','pausedBudget','reconciling',
    'completed','partial','failed','cancelled'
  )),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  run_json JSONB NOT NULL CHECK (jsonb_typeof(run_json) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (run_json->>'id' = id),
  CHECK (run_json->>'clientRequestId' = client_request_id),
  CHECK (run_json->>'projectId' = project_id),
  CHECK (run_json->>'scriptVersionId' = script_version_id),
  CHECK (run_json->>'status' = status),
  CHECK ((run_json->>'version')::integer = version)
);

CREATE INDEX production_runs_project_updated_idx ON production_runs(project_id, updated_at DESC);
CREATE INDEX production_runs_active_idx ON production_runs(updated_at)
  WHERE status IN ('queued','running','waitingHuman','paused','pausedBudget','reconciling');

CREATE TABLE production_outbox_events (
  id TEXT PRIMARY KEY CHECK (id ~ '^pevent_[a-f0-9]{32}$'),
  run_id TEXT NOT NULL REFERENCES production_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 160),
  payload_json JSONB NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ NULL,
  UNIQUE(run_id, sequence)
);

CREATE INDEX production_outbox_pending_idx ON production_outbox_events(created_at, id)
  WHERE delivered_at IS NULL;
