BEGIN;

-- 047 统一评估协议（#134）：追加式、不可覆盖的评估器结果、证据与分层指标。
-- 顺延自半成品 025，避开 dev 已占用的 025_workspace_tenancy_expand。
-- 复用 023 的 evaluation_runs / case_attempts / sample_attempts；本表只新增结果事实，
-- 不重建运行状态机、不新建第二套运行。结果独立于 run 存在（run_id 可空）。
-- 租户化：结果必须归属 workspace；run 外键使用复合键，跨 workspace 直接拒绝。

CREATE TABLE evaluation_results (
  result_id text PRIMARY KEY CHECK (result_id ~ '^evalres_[a-f0-9]{32}$'),
  -- 确定性幂等身份：同一内容重放得到同一摘要；租户内 UNIQUE 保证不产生第二份。
  result_digest char(64) NOT NULL CHECK (result_digest ~ '^[0-9a-f]{64}$'),
  -- 运行定位（可空）：run 空则 case/sample 必须空；case 空则 sample 必须空。
  run_id text NULL,
  case_id text NULL,
  sample_index integer NULL CHECK (sample_index IS NULL OR sample_index BETWEEN 0 AND 19),
  -- 被评估对象定位。
  subject_kind text NOT NULL CHECK (char_length(subject_kind) BETWEEN 1 AND 80),
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 160),
  subject_revision_id text NULL CHECK (char_length(subject_revision_id) <= 160),
  subject_digest char(64) NOT NULL CHECK (subject_digest ~ '^[0-9a-f]{64}$'),
  -- 评估器版本身份。
  evaluator_id text NOT NULL CHECK (char_length(evaluator_id) BETWEEN 1 AND 96),
  evaluator_version text NOT NULL CHECK (char_length(evaluator_version) BETWEEN 1 AND 80),
  evaluator_digest char(64) NOT NULL CHECK (evaluator_digest ~ '^[0-9a-f]{64}$'),
  -- 严格五态；evaluator_error 是评估器自身异常，不是对象 fail。
  status text NOT NULL CHECK (status IN ('pass', 'fail', 'uncertain', 'skipped', 'evaluator_error')),
  confidence real NULL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  -- 评估器自身错误（仅 evaluator_error 时非空）与旧结果类型约束扩展。
  error_json jsonb NULL CHECK (error_json IS NULL OR jsonb_typeof(error_json) = 'object'),
  legacy_json jsonb NULL CHECK (legacy_json IS NULL OR jsonb_typeof(legacy_json) = 'object'),
  -- 证据与指标（闭合契约的一部分），以及完整结果对象用于往返解析。
  evidence_json jsonb NOT NULL CHECK (jsonb_typeof(evidence_json) = 'array'),
  metrics_json jsonb NOT NULL CHECK (jsonb_typeof(metrics_json) = 'array'),
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT evaluation_result_locator_nesting CHECK (
    (run_id IS NULL AND case_id IS NULL AND sample_index IS NULL)
    OR (run_id IS NOT NULL AND case_id IS NULL AND sample_index IS NULL)
    OR (run_id IS NOT NULL AND case_id IS NOT NULL AND sample_index IS NULL)
    OR (run_id IS NOT NULL AND case_id IS NOT NULL AND sample_index IS NOT NULL)
  ),
  CONSTRAINT evaluation_result_error_state CHECK (
    (status = 'evaluator_error') = (error_json IS NOT NULL)
  )
);

-- 先物化租户列；本迁移前不存在结果行，默认值仍保留给历史导入工具，
-- 但触发器/RLS 会保证租户作用域。
ALTER TABLE evaluation_results
  ADD COLUMN workspace_id text NOT NULL DEFAULT 'ws_00000000000000000000000000000000'
    REFERENCES workspaces(id) ON DELETE RESTRICT;
ALTER TABLE evaluation_results ALTER COLUMN workspace_id DROP DEFAULT;

-- 幂等摘要只在租户内唯一；不同 workspace 的相同评估内容不互相吞掉。
ALTER TABLE evaluation_results
  ADD CONSTRAINT evaluation_result_digest_workspace UNIQUE (workspace_id, result_digest);

-- 复合 run 外键：run 必须与结果属于同一 workspace。
CREATE UNIQUE INDEX evaluation_runs_workspace_run_uid ON evaluation_runs (workspace_id, run_id);
ALTER TABLE evaluation_results
  ADD CONSTRAINT evaluation_result_run_ref FOREIGN KEY (workspace_id, run_id)
    REFERENCES evaluation_runs (workspace_id, run_id) ON DELETE RESTRICT;

CREATE INDEX evaluation_results_run_idx ON evaluation_results (workspace_id, run_id, recorded_at);
CREATE INDEX evaluation_results_subject_idx ON evaluation_results (workspace_id, subject_kind, subject_id);
CREATE INDEX evaluation_results_evaluator_idx ON evaluation_results (workspace_id, evaluator_id, evaluator_version);
CREATE INDEX evaluation_results_status_idx ON evaluation_results (workspace_id, status, recorded_at);

-- 结果只允许 INSERT：UPDATE/DELETE 一律拒绝。幂等重放由 (workspace_id, result_digest) UNIQUE 处理。
CREATE FUNCTION evaluation_results_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_RESULTS_APPEND_ONLY';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evaluation_results_append_only_trigger
  BEFORE UPDATE OR DELETE ON evaluation_results
  FOR EACH ROW EXECUTE FUNCTION evaluation_results_append_only();

-- 租户四件套：写入作用域触发器、FORCE RLS 与统一隔离策略。
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['evaluation_results'] LOOP
    EXECUTE format('CREATE TRIGGER lyra_workspace_scope_guard BEFORE INSERT OR UPDATE OF workspace_id ON %I '
      'FOR EACH ROW EXECUTE FUNCTION lyra_enforce_workspace_scope()', table_name);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY lyra_workspace_isolation ON %I '
      'USING (lyra_system_bypass_enabled() OR workspace_id=lyra_current_workspace_id()) '
      'WITH CHECK (lyra_system_bypass_enabled() OR workspace_id=lyra_current_workspace_id())', table_name);
  END LOOP;
END;
$$;

COMMIT;
