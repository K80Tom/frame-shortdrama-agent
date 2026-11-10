BEGIN;

-- 050 方法包治理（Issue #131）。
--
-- 设计边界：
-- * 版本内容是事实，发布后不可原地覆盖；正文变化必须新增版本。
-- * 内置公共目录 workspace_id 为 NULL，任何 Workspace 都必须显式准入后才可绑定。
-- * 私有导入、准入、项目配置、绑定和评测引用全部按 workspace_id 做 RLS。
-- * 历史 prompt_pack_states / prompt_pack_imports 与 ProductionRun.methodPacks 继续可读，
--   本迁移不删除旧表，也不改写已存在 run_json。

CREATE TABLE method_packs (
  id text PRIMARY KEY CHECK (id ~ '^mpk_[a-z0-9][a-z0-9-]{1,79}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  summary text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 500),
  origin text NOT NULL CHECK (origin IN ('builtin', 'workspace_import', 'external_registry')),
  workspace_id text NULL REFERENCES workspaces(id),
  source_uri text NULL CHECK (source_uri IS NULL OR char_length(source_uri) <= 500),
  source_revision text NULL CHECK (source_revision IS NULL OR char_length(source_revision) <= 160),
  created_by text NOT NULL CHECK (char_length(created_by) BETWEEN 3 AND 160),
  created_at timestamptz NOT NULL,
  archived_at timestamptz NULL,
  client_request_id text NULL CHECK (client_request_id IS NULL
    OR client_request_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$'),
  CONSTRAINT method_packs_public_or_workspace CHECK (
    (origin = 'builtin' AND workspace_id IS NULL)
    OR (origin <> 'builtin' AND workspace_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX method_packs_workspace_request_unique
  ON method_packs (workspace_id, client_request_id)
  WHERE client_request_id IS NOT NULL AND workspace_id IS NOT NULL;
CREATE INDEX method_packs_catalog_idx ON method_packs (workspace_id, archived_at, created_at);

CREATE TABLE method_pack_versions (
  id text PRIMARY KEY CHECK (id ~ '^mpv_[a-f0-9]{32}$'),
  pack_id text NOT NULL REFERENCES method_packs(id),
  workspace_id text NULL REFERENCES workspaces(id),
  version text NOT NULL CHECK (version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'),
  content text NULL CHECK (content IS NULL OR octet_length(content) <= 524288),
  content_ref text NULL CHECK (content_ref IS NULL OR char_length(content_ref) <= 500),
  content_digest char(64) NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  manifest_json jsonb NOT NULL CHECK (jsonb_typeof(manifest_json) = 'object'),
  manifest_digest char(64) NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  license_code text NOT NULL CHECK (char_length(license_code) BETWEEN 1 AND 64),
  commercial_use_allowed boolean NOT NULL,
  quality_status text NOT NULL CHECK (quality_status IN ('reference-only', 'unevaluated', 'evaluated')),
  approval_status text NOT NULL CHECK (approval_status IN ('published', 'deprecated')),
  compatibility_json jsonb NOT NULL CHECK (jsonb_typeof(compatibility_json) = 'object'),
  nodes_json jsonb NOT NULL CHECK (jsonb_typeof(nodes_json) = 'array'),
  created_by text NOT NULL CHECK (char_length(created_by) BETWEEN 3 AND 160),
  created_at timestamptz NOT NULL,
  archived_at timestamptz NULL,
  CONSTRAINT method_pack_versions_content_once CHECK (content IS NOT NULL OR content_ref IS NOT NULL),
  CONSTRAINT method_pack_versions_pack_version_unique UNIQUE (pack_id, version)
);
CREATE INDEX method_pack_versions_catalog_idx ON method_pack_versions (pack_id, created_at);

CREATE TABLE workspace_method_pack_access (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  pack_version_id text NOT NULL REFERENCES method_pack_versions(id),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
  approved_by text NULL CHECK (approved_by IS NULL OR char_length(approved_by) BETWEEN 3 AND 160),
  approved_at timestamptz NULL,
  rejection_reason text NULL CHECK (rejection_reason IS NULL OR char_length(rejection_reason) <= 500),
  quality_evidence_version text NULL CHECK (quality_evidence_version IS NULL
    OR char_length(quality_evidence_version) <= 160),
  updated_at timestamptz NOT NULL,
  client_request_id text NULL CHECK (client_request_id IS NULL
    OR client_request_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$'),
  PRIMARY KEY (workspace_id, pack_version_id),
  CONSTRAINT workspace_method_pack_access_approval CHECK (
    (status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR (status <> 'approved')
  )
);
CREATE INDEX workspace_method_pack_access_status_idx
  ON workspace_method_pack_access (workspace_id, status, updated_at);

CREATE TABLE project_method_profile_revisions (
  id text PRIMARY KEY CHECK (id ~ '^mpr_[a-f0-9]{32}$'),
  workspace_id text NOT NULL REFERENCES workspaces(id),
  project_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('draft', 'adopted', 'archived')),
  base_revision_id text NULL REFERENCES project_method_profile_revisions(id),
  digest char(64) NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  version integer NOT NULL CHECK (version > 0),
  token_budget integer NOT NULL DEFAULT 32000 CHECK (token_budget BETWEEN 1 AND 200000),
  created_by text NOT NULL CHECK (char_length(created_by) BETWEEN 3 AND 160),
  created_at timestamptz NOT NULL,
  adopted_by text NULL CHECK (adopted_by IS NULL OR char_length(adopted_by) BETWEEN 3 AND 160),
  adopted_at timestamptz NULL,
  archived_at timestamptz NULL,
  validated_at timestamptz NULL,
  validation_digest char(64) NULL CHECK (validation_digest IS NULL OR validation_digest ~ '^[0-9a-f]{64}$'),
  client_request_id text NULL CHECK (client_request_id IS NULL
    OR client_request_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$'),
  CONSTRAINT project_method_profile_revision_unique UNIQUE (workspace_id, project_id, revision),
  CONSTRAINT project_method_profile_project_fk FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id),
  CONSTRAINT project_method_profile_adopted_fields CHECK (
    (status = 'adopted' AND adopted_by IS NOT NULL AND adopted_at IS NOT NULL)
    OR (status <> 'adopted')
  )
);
CREATE UNIQUE INDEX project_method_profile_single_adopted
  ON project_method_profile_revisions (workspace_id, project_id)
  WHERE status = 'adopted';
CREATE INDEX project_method_profile_project_idx
  ON project_method_profile_revisions (workspace_id, project_id, revision DESC);

CREATE TABLE project_method_bindings (
  profile_revision_id text NOT NULL REFERENCES project_method_profile_revisions(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  node text NOT NULL CHECK (node IN ('script-adaptation', 'character-image', 'storyboard', 'video-prompt')),
  role text NOT NULL CHECK (role IN ('primary', 'reviewer', 'constraint')),
  pack_version_id text NOT NULL REFERENCES method_pack_versions(id),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 10000),
  token_budget integer NOT NULL DEFAULT 4000 CHECK (token_budget BETWEEN 0 AND 200000),
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config_json) = 'object'),
  PRIMARY KEY (profile_revision_id, node, role, pack_version_id),
  CONSTRAINT project_method_binding_primary_budget CHECK (
    role <> 'primary' OR token_budget > 0
  )
);
CREATE UNIQUE INDEX project_method_binding_single_primary
  ON project_method_bindings (profile_revision_id, node)
  WHERE role = 'primary';
CREATE INDEX project_method_binding_version_idx
  ON project_method_bindings (workspace_id, pack_version_id);

CREATE FUNCTION lyra_method_binding_limit() RETURNS trigger AS $$
DECLARE
  primary_count integer;
  auxiliary_count integer;
BEGIN
  SELECT count(*) FILTER (WHERE role = 'primary'),
         count(*) FILTER (WHERE role <> 'primary')
    INTO primary_count, auxiliary_count
    FROM project_method_bindings
   WHERE profile_revision_id = COALESCE(NEW.profile_revision_id, OLD.profile_revision_id)
     AND node = COALESCE(NEW.node, OLD.node);
  IF primary_count > 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'METHOD_BINDING_PRIMARY_CONFLICT';
  END IF;
  IF auxiliary_count > 2 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'METHOD_BINDING_AUXILIARY_LIMIT';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_method_binding_limit_trigger
  BEFORE INSERT OR UPDATE OF role, node, profile_revision_id ON project_method_bindings
  FOR EACH ROW EXECUTE FUNCTION lyra_method_binding_limit();

-- 绑定必须同时属于同一 Workspace 的 Profile 和方法版本。FK 只校验 id，
-- RLS 不会替我们阻止跨租户组合，因此这里显式做组合归属校验。
CREATE FUNCTION lyra_method_binding_scope_guard() RETURNS trigger AS $$
DECLARE
  scoped text := lyra_current_workspace_id();
  version_workspace text;
  pack_workspace text;
  profile_workspace text;
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM scoped THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'LYRA_CROSS_TENANT_WRITE_DENIED';
  END IF;
  SELECT v.workspace_id, p.workspace_id INTO version_workspace, pack_workspace
    FROM method_pack_versions v JOIN method_packs p ON p.id = v.pack_id
   WHERE v.id = NEW.pack_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'METHOD_PACK_NOT_FOUND';
  END IF;
  IF (version_workspace IS NOT NULL AND version_workspace IS DISTINCT FROM NEW.workspace_id)
     OR (pack_workspace IS NOT NULL AND pack_workspace IS DISTINCT FROM NEW.workspace_id) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'LYRA_CROSS_TENANT_WRITE_DENIED';
  END IF;
  SELECT workspace_id INTO profile_workspace FROM project_method_profile_revisions
   WHERE id = NEW.profile_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'METHOD_PROFILE_NOT_FOUND';
  END IF;
  IF profile_workspace IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'LYRA_CROSS_TENANT_WRITE_DENIED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_method_binding_scope_trigger
  BEFORE INSERT OR UPDATE OF workspace_id, pack_version_id, profile_revision_id ON project_method_bindings
  FOR EACH ROW EXECUTE FUNCTION lyra_method_binding_scope_guard();

CREATE TABLE method_pack_evaluation_refs (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  method_pack_version_id text NOT NULL REFERENCES method_pack_versions(id),
  evaluation_run_id text NOT NULL CHECK (char_length(evaluation_run_id) BETWEEN 3 AND 160),
  scorecard_id text NOT NULL CHECK (char_length(scorecard_id) BETWEEN 3 AND 160),
  gate_decision_id text NOT NULL CHECK (char_length(gate_decision_id) BETWEEN 3 AND 160),
  PRIMARY KEY (method_pack_version_id, evaluation_run_id, scorecard_id, gate_decision_id)
);
CREATE INDEX method_pack_evaluation_refs_workspace_idx
  ON method_pack_evaluation_refs (workspace_id, method_pack_version_id);

-- 版本正文/Manifest 不可原地覆盖；允许归档状态与发布状态变化，但内容事实不能改写。
CREATE FUNCTION lyra_method_pack_version_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'METHOD_PACK_VERSION_IMMUTABLE';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.pack_id IS DISTINCT FROM OLD.pack_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.content IS DISTINCT FROM OLD.content
    OR NEW.content_ref IS DISTINCT FROM OLD.content_ref
    OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
    OR NEW.manifest_json IS DISTINCT FROM OLD.manifest_json
    OR NEW.manifest_digest IS DISTINCT FROM OLD.manifest_digest
    OR NEW.license_code IS DISTINCT FROM OLD.license_code
    OR NEW.commercial_use_allowed IS DISTINCT FROM OLD.commercial_use_allowed
    OR NEW.quality_status IS DISTINCT FROM OLD.quality_status
    OR NEW.compatibility_json IS DISTINCT FROM OLD.compatibility_json
    OR NEW.nodes_json IS DISTINCT FROM OLD.nodes_json
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'METHOD_PACK_VERSION_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER method_pack_version_immutable_trigger
  BEFORE UPDATE OR DELETE ON method_pack_versions
  FOR EACH ROW EXECUTE FUNCTION lyra_method_pack_version_immutable();

-- 公共目录 workspace_id 必须为 NULL，私有目录必须等于本事务 workspace。
CREATE FUNCTION lyra_method_pack_scope_guard() RETURNS trigger AS $$
DECLARE
  scoped text;
BEGIN
  scoped := lyra_current_workspace_id();
  IF NEW.origin = 'builtin' THEN
    IF NEW.workspace_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'METHOD_PACK_PUBLIC_MUST_BE_UNSCOPED';
    END IF;
    IF NOT lyra_system_bypass_enabled() THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'METHOD_PACK_PUBLIC_WRITE_DENIED';
    END IF;
    RETURN NEW;
  END IF;
  IF scoped IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'LYRA_TENANT_SCOPE_REQUIRED';
  END IF;
  IF NEW.workspace_id IS NULL OR NEW.workspace_id IS DISTINCT FROM scoped THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'LYRA_CROSS_TENANT_WRITE_DENIED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER method_pack_scope_guard_trigger
  BEFORE INSERT OR UPDATE OF workspace_id, origin ON method_packs
  FOR EACH ROW EXECUTE FUNCTION lyra_method_pack_scope_guard();

CREATE FUNCTION lyra_method_pack_version_scope_guard() RETURNS trigger AS $$
DECLARE
  scoped text;
  pack_origin text;
  pack_workspace text;
BEGIN
  SELECT origin, workspace_id INTO pack_origin, pack_workspace
    FROM method_packs WHERE id = NEW.pack_id;
  IF pack_origin IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'METHOD_PACK_NOT_FOUND';
  END IF;
  scoped := lyra_current_workspace_id();
  IF pack_origin = 'builtin' THEN
    IF NEW.workspace_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'METHOD_PACK_PUBLIC_VERSION_MUST_BE_UNSCOPED';
    END IF;
    IF NOT lyra_system_bypass_enabled() THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'METHOD_PACK_PUBLIC_VERSION_WRITE_DENIED';
    END IF;
    RETURN NEW;
  END IF;
  IF scoped IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'LYRA_TENANT_SCOPE_REQUIRED';
  END IF;
  -- 版本必须写入它所属的私有包；只校验 NEW.workspace_id 会让 B 工作区
  -- 通过把版本 workspace_id 写成 B 来污染 A 工作区的 pack。
  IF pack_workspace IS NULL OR pack_workspace IS DISTINCT FROM scoped
    OR NEW.workspace_id IS DISTINCT FROM pack_workspace THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'LYRA_CROSS_TENANT_WRITE_DENIED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER method_pack_version_scope_guard_trigger
  BEFORE INSERT OR UPDATE OF workspace_id ON method_pack_versions
  FOR EACH ROW EXECUTE FUNCTION lyra_method_pack_version_scope_guard();

-- 私有表沿用 Stage 1 的统一租户写触发器。
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_method_pack_access',
    'project_method_profile_revisions',
    'project_method_bindings',
    'method_pack_evaluation_refs'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS lyra_workspace_scope_guard ON %I', table_name);
    EXECUTE format(
      'CREATE TRIGGER lyra_workspace_scope_guard BEFORE INSERT OR UPDATE OF workspace_id ON %I '
      'FOR EACH ROW EXECUTE FUNCTION lyra_enforce_workspace_scope()',
      table_name
    );
  END LOOP;
END;
$$;

-- RLS 使用同一命名，便于审计；公共目录可跨 Workspace 只读，但写入仍受触发器约束。
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'method_packs', 'method_pack_versions', 'workspace_method_pack_access',
    'project_method_profile_revisions', 'project_method_bindings', 'method_pack_evaluation_refs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS lyra_workspace_isolation ON %I', table_name);
    IF table_name IN ('method_packs', 'method_pack_versions') THEN
      EXECUTE format(
        'CREATE POLICY lyra_workspace_isolation ON %I '
        'USING (lyra_system_bypass_enabled() OR workspace_id IS NULL OR workspace_id = lyra_current_workspace_id()) '
        'WITH CHECK (lyra_system_bypass_enabled() OR workspace_id IS NULL OR workspace_id = lyra_current_workspace_id())',
        table_name
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY lyra_workspace_isolation ON %I '
        'USING (lyra_system_bypass_enabled() OR workspace_id = lyra_current_workspace_id()) '
        'WITH CHECK (lyra_system_bypass_enabled() OR workspace_id = lyra_current_workspace_id())',
        table_name
      );
    END IF;
  END LOOP;
END;
$$;

-- 统一 Outbox 的 aggregate_type 需要承载方法包/项目配置事件。
ALTER TABLE data_outbox_events
  DROP CONSTRAINT IF EXISTS data_outbox_events_aggregate_type_check;
ALTER TABLE data_outbox_events
  ADD CONSTRAINT data_outbox_events_aggregate_type_check CHECK (aggregate_type IN (
    'novel_chapter', 'script', 'asset', 'production_run', 'production_attempt',
    'external_operation', 'quality_check', 'delivery_artifact', 'evaluation_run',
    'shot_spec', 'production_input', 'director_scene', 'object_version',
    'method_pack', 'method_profile'
  ));

COMMIT;
