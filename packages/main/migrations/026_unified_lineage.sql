BEGIN;

-- 026 统一血缘（#50）：跨小说/剧本/资产/生产/交付的只读派生投影。
-- 血缘只存权威 SourceRef、业务 ID/revision/digest、时间、保留期、可见性与所需授权；
-- 不复制正文、提示词或媒体字节。节点/边一旦投影即不可变，投影结果不回写业务表。
-- 本迁移不修改 024 Outbox/投影表，也不触碰 evaluator result 域。

CREATE TABLE lineage_nodes (
  node_id text PRIMARY KEY CHECK (node_id ~ '^ln_[a-f0-9]{32}$'),
  kind text NOT NULL CHECK (kind IN (
    'novel_source', 'novel_revision',
    'script_version', 'plan_revision', 'storyboard_revision',
    'asset',
    'production_run', 'production_task', 'production_attempt',
    'external_operation',
    'quality_check', 'review_decision',
    'artifact', 'timeline_revision', 'delivery'
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
  authorization text NOT NULL CHECK (authorization ~ '^[a-z]+:[a-z]+$'),
  gap_json jsonb NULL CHECK (gap_json IS NULL OR jsonb_typeof(gap_json) = 'object'),
  gap_type text NULL CHECK (gap_type IS NULL OR gap_type IN ('unknown', 'orphan', 'digest', 'permission')),
  CONSTRAINT lineage_node_occurred_before_recorded CHECK (occurred_at <= recorded_at),
  -- unknown gap 节点允许 digest 为空；其余节点必须有权威摘要。
  CONSTRAINT lineage_node_digest_present CHECK (
    gap_type = 'unknown' OR gap_type = 'digest' OR digest IS NOT NULL
  )
);

-- 权威业务身份唯一：同一 (kind, business_id, revision) 只能有一个节点。
-- revision_id 可空，用 COALESCE 把 NULL 归并为空串，避免 NULL 被当作互异值。
CREATE UNIQUE INDEX lineage_node_identity
  ON lineage_nodes (kind, business_id, COALESCE(revision_id, ''));
CREATE INDEX lineage_node_kind_idx ON lineage_nodes (kind);
CREATE INDEX lineage_node_gap_idx ON lineage_nodes (gap_type) WHERE gap_type IS NOT NULL;

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
  CONSTRAINT lineage_edge_no_self_loop CHECK (from_node_id <> to_node_id),
  -- 同一语义关系只允许一条边，防止重复投影产生平行边。
  CONSTRAINT lineage_edge_unique UNIQUE (edge_type, from_node_id, to_node_id)
);
-- 双向索引：正向沿 from→to 向下游追踪，反向沿 to→from 向上游溯源。
CREATE INDEX lineage_edge_forward_idx ON lineage_edges (from_node_id, edge_type);
CREATE INDEX lineage_edge_reverse_idx ON lineage_edges (to_node_id, edge_type);
CREATE INDEX lineage_edge_event_idx ON lineage_edges (source_event_id) WHERE source_event_id IS NOT NULL;

-- 来源事件处理台账：同一消费者重复投影同一事件为幂等 no-op。
CREATE TABLE lineage_events (
  consumer_name text NOT NULL CHECK (consumer_name ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$'),
  event_id text NOT NULL CHECK (event_id ~ '^evt_[a-f0-9]{32}$'),
  node_count integer NOT NULL CHECK (node_count >= 0),
  edge_count integer NOT NULL CHECK (edge_count >= 0),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (consumer_name, event_id)
);

-- 节点不可变：已解析节点（digest 非空）禁止任何业务字段变更；仅允许把
-- 未知/空位（digest 为空）一次性闭合为已解析节点，不得反向降级或覆盖已解析摘要。
CREATE FUNCTION lineage_node_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'LINEAGE_NODE_IMMUTABLE';
  END IF;
  IF OLD.digest IS NOT NULL THEN
    IF NEW.digest IS DISTINCT FROM OLD.digest
      OR NEW.kind IS DISTINCT FROM OLD.kind
      OR NEW.business_id IS DISTINCT FROM OLD.business_id
      OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
      OR NEW.ref_json IS DISTINCT FROM OLD.ref_json
      OR NEW.authorization IS DISTINCT FROM OLD.authorization
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

COMMIT;
