-- Independent single-video jobs. Applying migrations remains an explicit CLI action.
CREATE TABLE video_automation_runs (
  id TEXT PRIMARY KEY CHECK (id ~ '^video_[a-f0-9]{32}$'),
  client_request_id TEXT NOT NULL UNIQUE CHECK (client_request_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  status TEXT NOT NULL CHECK (status IN ('queued','submitting','generating','completed','failed','unknown')),
  provider_task_id TEXT NULL,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  run_json JSONB NOT NULL CHECK (jsonb_typeof(run_json) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (run_json->>'id' = id AND run_json->>'clientRequestId' = client_request_id
    AND run_json->>'status' = status AND (run_json->>'version')::integer = version),
  CHECK ((run_json->>'providerTaskId') IS NOT DISTINCT FROM provider_task_id)
);
-- Unknown submissions keep their request ID forever but do not block unrelated work.
CREATE UNIQUE INDEX video_automation_single_active ON video_automation_runs ((true))
  WHERE status IN ('queued','submitting','generating');
CREATE INDEX video_automation_created_idx ON video_automation_runs (created_at DESC, id DESC);
