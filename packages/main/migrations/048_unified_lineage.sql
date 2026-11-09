BEGIN;

-- 046 统一血缘（#133/#50）：跨小说/剧本/镜头/资产/生产/交付的只读派生投影。
-- 顺延自半成品 026，避开 dev 已占用的 026_tenant_data_outbox。
-- 血缘只存权威 SourceRef、业务 ID/revision/digest、时间、保留期、可见性与所需授权；
-- 不复制正文、提示词或媒体字节。节点/边一旦投影即不可变，投影结果不回写业务表。
-- 本迁移不修改 024 Outbox/投影表，也不触碰 evaluator result 域。

CREATE TABLE lineage_nodes (
  node_id text PRIMARY KEY CHECK (node_id ~ '^ln_[a-f0-9]{32}$'),
  kind text NOT NULL CHECK (kind IN (
    'novel_source', 'novel_revision',
    'script_version', 'plan_revision', 'storyboard_revision', 'shot_spec',
    'asset',
    'production_run', 'production_task', 'production_attempt',
    'external_operation', 'production_input',
    'quality_check', 'review_decision',
    'artifact', 'timeline_revision', 'delivery', 'evaluation_run'
  )),
  business_id text NOT NULL CHECK (business_id ~ '^[A-Za-z][A-Za-z0-9_.:-]{2,159}$'),
  revision_id text NULL CHECK (revision_id IS NULL OR revision_id ~ '^[A-Za-z][A-Za-z0-9_.:-]{2,159}$'),
  ref_json jsonb NOT NULL CHECK (jsonb_typeof(ref_json) = 'object'),
  digest char(64) NULL CHECK (digest IS NULL OR digest ~ '^[0-9a-f]{64}$'),
  schema_version text NOT NULL CHECK (schema_version ~ '^lyra\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*/v[1-9][0-9]*$'),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  retention text NOT NULL CHECK (retention IN ('project_lifetime', 'run_lifetime', 'replay_lifetime')),
  visibility text NOT NULL CHECK (visibility IN ('public', 'internal', 'confidential')),
  "authorization" text NOT NULL CHECK ("authorization" ~ '^[a-z]+:[a-z]+$'),
  gap_json jsonb NULL CHECK (gap_json IS NULL OR jsonb_typeof(gap_json) = 'object'),
  gap_type text NULL CHECK (gap_type IS NULL OR gap_type IN ('unknown', 'orphan', 'digest', 'permission')),
  CONSTRAINT lineage_node_occurred_before_recorded CHECK (occurred_at <= recorded_at),
  -- unknown gap 节点允许 digest 为空；其余节点必须有权威摘要。
  CONSTRAINT lineage_node_digest_present CHECK (
    gap_type = 'unknown' OR gap_type = 'digest' OR digest IS NOT NULL
  )
);

CREATE TABLE lineage_edges (
  edge_id text PRIMARY KEY CHECK (edge_id ~ '^le_[a-f0-9]{32}$'),
  edge_type text NOT NULL CHECK (edge_type IN (
    'derived-from', 'used-by', 'generated-by', 'validated-by', 'supersedes', 'delivered-as'
  )),
  from_node_id text NOT NULL REFERENCES lineage_nodes(node_id) ON DELETE RESTRICT,
  to_node_id text NOT NULL REFERENCES lineage_nodes(node_id) ON DELETE RESTRICT,
  source_event_id text NULL CHECK (source_event_id IS NULL OR source_event_id ~ '^evt_[a-f0-9]{32}$'),
  edge_digest char(64) NOT NULL CHECK (edge_digest ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT lineage_edge_no_self_loop CHECK (from_node_id <> to_node_id)
);

-- 来源事件处理台账：同一消费者重复投影同一事件为幂等 no-op。
CREATE TABLE lineage_events (
  consumer_name text NOT NULL CHECK (consumer_name ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$'),
  event_id text NOT NULL CHECK (event_id ~ '^evt_[a-f0-9]{32}$'),
  node_count integer NOT NULL CHECK (node_count >= 0),
  edge_count integer NOT NULL CHECK (edge_count >= 0),
  recorded_at timestamptz NOT NULL
);

-- 在挂 RLS 触发器之前先物化租户列；历史行按迁移期的保留工作区回填后立即去掉默认值。
ALTER TABLE lineage_nodes
  ADD COLUMN workspace_id text NOT NULL DEFAULT 'ws_00000000000000000000000000000000'
    REFERENCES workspaces(id) ON DELETE RESTRICT;
ALTER TABLE lineage_nodes ALTER COLUMN workspace_id DROP DEFAULT;
ALTER TABLE lineage_edges
  ADD COLUMN workspace_id text NOT NULL DEFAULT 'ws_00000000000000000000000000000000'
    REFERENCES workspaces(id) ON DELETE RESTRICT;
ALTER TABLE lineage_edges ALTER COLUMN workspace_id DROP DEFAULT;
ALTER TABLE lineage_events
  ADD COLUMN workspace_id text NOT NULL DEFAULT 'ws_00000000000000000000000000000000'
    REFERENCES workspaces(id) ON DELETE RESTRICT;
ALTER TABLE lineage_events ALTER COLUMN workspace_id DROP DEFAULT;

-- 权威业务身份唯一：同一 (workspace, kind, business_id, revision) 只能有一个节点。
-- revision_id 可空，用 COALESCE 把 NULL 归并为空串，避免 NULL 被当作互异值。
CREATE UNIQUE INDEX lineage_node_identity
  ON lineage_nodes (workspace_id, kind, business_id, COALESCE(revision_id, ''));
CREATE INDEX lineage_node_kind_idx ON lineage_nodes (workspace_id, kind);
CREATE INDEX lineage_node_gap_idx ON lineage_nodes (workspace_id, gap_type) WHERE gap_type IS NOT NULL;

-- 同一语义关系只允许一条边，防止重复投影产生平行边。
ALTER TABLE lineage_edges
  ADD CONSTRAINT lineage_edge_unique UNIQUE (workspace_id, edge_type, from_node_id, to_node_id);
-- 双向索引：正向沿 from→to 向下游追踪，反向沿 to→from 向上游溯源。
CREATE INDEX lineage_edge_forward_idx ON lineage_edges (workspace_id, from_node_id, edge_type);
CREATE INDEX lineage_edge_reverse_idx ON lineage_edges (workspace_id, to_node_id, edge_type);
CREATE INDEX lineage_edge_event_idx ON lineage_edges (workspace_id, source_event_id) WHERE source_event_id IS NOT NULL;

-- 事件台账的幂等键必须带租户；否则两个租户的同一 event_id 会互相吞掉。
ALTER TABLE lineage_events
  ADD CONSTRAINT lineage_events_workspace_identity PRIMARY KEY (workspace_id, consumer_name, event_id);

-- 跨租户边在数据库层直接拒绝：节点复合身份 + 复合外键，而不是只依赖应用层过滤。
ALTER TABLE lineage_nodes
  ADD CONSTRAINT lineage_nodes_workspace_node_identity UNIQUE (workspace_id, node_id);
ALTER TABLE lineage_edges
  ADD CONSTRAINT lineage_edge_from_workspace FOREIGN KEY (workspace_id, from_node_id)
    REFERENCES lineage_nodes (workspace_id, node_id) ON DELETE RESTRICT;
ALTER TABLE lineage_edges
  ADD CONSTRAINT lineage_edge_to_workspace FOREIGN KEY (workspace_id, to_node_id)
    REFERENCES lineage_nodes (workspace_id, node_id) ON DELETE RESTRICT;

-- 节点不可变：已解析节点（digest 非空）禁止任何业务字段变更；仅允许把
-- 未知/空位（digest 为空）一次性闭合为已解析节点，不得反向降级或覆盖已解析摘要。
CREATE FUNCTION lineage_node_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'LINEAGE_NODE_IMMUTABLE';
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'LINEAGE_NODE_IMMUTABLE';
  END IF;
  IF OLD.digest IS NOT NULL THEN
    IF NEW.digest IS DISTINCT FROM OLD.digest
      OR NEW.kind IS DISTINCT FROM OLD.kind
      OR NEW.business_id IS DISTINCT FROM OLD.business_id
      OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
      OR NEW.ref_json IS DISTINCT FROM OLD.ref_json
      OR NEW."authorization" IS DISTINCT FROM OLD."authorization"
      OR NEW.retention IS DISTINCT FROM OLD.retention
      OR NEW.visibility IS DISTINCT FROM OLD.visibility THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'LINEAGE_NODE_IMMUTABLE';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lineage_node_immutable_trigger
  BEFORE UPDATE OR DELETE ON lineage_nodes
  FOR EACH ROW EXECUTE FUNCTION lineage_node_immutable();

-- 边完全不可变：不允许更新或删除。
CREATE FUNCTION lineage_edge_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'LINEAGE_EDGE_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lineage_edge_immutable_trigger
  BEFORE UPDATE OR DELETE ON lineage_edges
  FOR EACH ROW EXECUTE FUNCTION lineage_edge_immutable();

-- 租户四件套：写入作用域触发器、FORCE RLS 与统一隔离策略。
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['lineage_nodes', 'lineage_edges', 'lineage_events'] LOOP
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
