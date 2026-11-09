BEGIN;

-- 生产画布：不可变 Revision + 显式命令 + 真实事件。
--
-- 设计约束：
-- 1. 业务事实仍由 ShotSpec/AssetPack/Candidate/Job/Run 各自持有；
--    Canvas 只保存稳定 ResourceRef、布局与版本链。
-- 2. 一个 Revision 一旦 adopted 不可修改；草稿通过追加命令生成新 Revision。
-- 3. 同一个 client_request_id 只产生一个命令回执，重复提交返回原结果。
--
-- 这里不建“当前状态”可变表，避免前端再存一份孤立事实。

CREATE TABLE canvas_documents (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  adopted_revision_id text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz,
  CONSTRAINT canvas_documents_title_unique UNIQUE (workspace_id, project_id, title)
);

CREATE INDEX canvas_documents_project_idx
  ON canvas_documents (workspace_id, project_id, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE TABLE canvas_revisions (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES canvas_documents(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  base_revision_id text,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  status text NOT NULL CHECK (status IN ('draft', 'adopted', 'archived')),
  semantic_digest text NOT NULL,
  layout_digest text NOT NULL,
  content_digest text NOT NULL,
  baseline_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  graph_json jsonb NOT NULL,
  validation_json jsonb,
  reader_version integer NOT NULL DEFAULT 1 CHECK (reader_version >= 1),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  adopted_by text,
  adopted_at timestamptz,
  CONSTRAINT canvas_revisions_document_revision_unique UNIQUE (document_id, revision)
);

-- 一个 Document 同时最多一个 adopted Revision。
CREATE UNIQUE INDEX canvas_revisions_one_adopted
  ON canvas_revisions (document_id)
  WHERE status = 'adopted';

CREATE INDEX canvas_revisions_document_idx
  ON canvas_revisions (document_id, revision DESC);

CREATE TABLE canvas_commands (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES canvas_documents(id) ON DELETE CASCADE,
  revision_id text NOT NULL REFERENCES canvas_revisions(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  client_request_id text NOT NULL,
  actor text NOT NULL,
  expected_revision integer NOT NULL CHECK (expected_revision >= 1),
  batch_json jsonb NOT NULL,
  receipt_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT canvas_commands_request_unique UNIQUE (document_id, client_request_id)
);

CREATE INDEX canvas_commands_document_idx
  ON canvas_commands (document_id, created_at DESC);

-- 画布领域事件。与 data_outbox_events 一样是“已发生事实”的追加记录，
-- 后续 Projector 可以按 document_id + created_at 重放，而不依赖前端状态。
CREATE TABLE canvas_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  document_id text NOT NULL REFERENCES canvas_documents(id) ON DELETE CASCADE,
  revision_id text,
  type text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX canvas_events_document_idx
  ON canvas_events (document_id, created_at DESC, id);

-- 报价与运行绑定：Quote 冻结 semantic digest，提交时若 Revision 或摘要变化则 quote_stale。
CREATE TABLE canvas_quotes (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES canvas_documents(id) ON DELETE CASCADE,
  revision_id text NOT NULL REFERENCES canvas_revisions(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  semantic_digest text NOT NULL,
  currency text NOT NULL DEFAULT 'CNY',
  budget_micros bigint NOT NULL CHECK (budget_micros >= 0),
  estimate_micros bigint NOT NULL CHECK (estimate_micros >= 0),
  estimate_low_micros bigint NOT NULL CHECK (estimate_low_micros >= 0),
  estimate_high_micros bigint NOT NULL CHECK (estimate_high_micros >= 0),
  price_revision text NOT NULL,
  assumptions_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  shot_count integer NOT NULL CHECK (shot_count >= 0),
  model text NOT NULL,
  candidate_policy text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'expired')),
  expires_at timestamptz NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX canvas_quotes_revision_idx
  ON canvas_quotes (document_id, revision_id, created_at DESC);

CREATE TABLE canvas_runs (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES canvas_documents(id) ON DELETE CASCADE,
  revision_id text NOT NULL REFERENCES canvas_revisions(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  semantic_digest text NOT NULL,
  quote_id text NOT NULL,
  run_id text NOT NULL,
  client_request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT canvas_runs_request_unique UNIQUE (document_id, client_request_id)
);

CREATE INDEX canvas_runs_document_idx
  ON canvas_runs (document_id, created_at DESC);

-- 与 030 的租户契约保持一致：租户写入由触发器校验，读取由 RLS 强制。
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'canvas_documents', 'canvas_revisions', 'canvas_commands', 'canvas_events',
    'canvas_quotes', 'canvas_runs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS lyra_workspace_scope_guard ON %I', table_name);
    EXECUTE format(
      'CREATE TRIGGER lyra_workspace_scope_guard '
      'BEFORE INSERT OR UPDATE OF workspace_id ON %I '
      'FOR EACH ROW EXECUTE FUNCTION lyra_enforce_workspace_scope()',
      table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS lyra_workspace_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY lyra_workspace_isolation ON %I '
      'USING (lyra_system_bypass_enabled() OR workspace_id = lyra_current_workspace_id()) '
      'WITH CHECK (lyra_system_bypass_enabled() OR workspace_id = lyra_current_workspace_id())',
      table_name
    );
  END LOOP;
END;
$$;

COMMIT;
