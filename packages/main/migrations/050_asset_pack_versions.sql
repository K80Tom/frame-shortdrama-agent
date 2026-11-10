BEGIN;

-- 050 版本化多角度资产包（#126）：AssetIdentity 的逻辑资产对应不可变 AssetPackVersion。
-- 迁移只建立事实表与租户隔离；检索、索引和 ShotSpec/Snapshot 冻结由后续阶段消费本表。

CREATE TABLE IF NOT EXISTS asset_pack_versions (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  version_id text NOT NULL CHECK (version_id ~ '^apv_[a-f0-9]{32}$'),
  logical_asset_id text NOT NULL CHECK (logical_asset_id ~ '^[A-Za-z][A-Za-z0-9_.:-]{2,159}$'),
  kind text NOT NULL CHECK (kind IN ('character', 'location', 'prop')),
  version integer NOT NULL CHECK (version >= 1),
  parent_version_id text NULL CHECK (parent_version_id IS NULL OR parent_version_id ~ '^apv_[a-f0-9]{32}$'),
  status text NOT NULL CHECK (status IN ('draft', 'reviewing', 'adopted', 'superseded', 'revoked')),
  project_scope text NOT NULL CHECK (project_scope IN ('workspace', 'project')),
  project_id text NULL CHECK (project_id IS NULL OR project_id ~ '^[A-Za-z][A-Za-z0-9_.:-]{2,159}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200 AND display_name = btrim(display_name)),
  aliases jsonb NOT NULL CHECK (jsonb_typeof(aliases) = 'array'),
  description text NOT NULL CHECK (char_length(description) <= 4000 AND description = btrim(description)),
  tags jsonb NOT NULL CHECK (jsonb_typeof(tags) = 'array'),
  source_type text NOT NULL CHECK (source_type IN ('generated', 'imported', 'external')),
  source_refs jsonb NOT NULL CHECK (jsonb_typeof(source_refs) = 'array'),
  license text NULL CHECK (license IS NULL OR char_length(license) <= 200),
  authorization_status text NOT NULL CHECK (authorization_status IN (
    'unknown', 'allowed', 'expired', 'revoked', 'not_reviewed', 'usage_mismatch', 'project_mismatch'
  )),
  authorization_reason text NULL CHECK (authorization_reason IS NULL OR char_length(authorization_reason) <= 500),
  review_status text NOT NULL CHECK (review_status IN ('pending', 'approved', 'rejected')),
  reviewed_by text NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz NULL,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NULL,
  allowed_usages jsonb NOT NULL CHECK (jsonb_typeof(allowed_usages) = 'array'),
  restricted_projects jsonb NOT NULL CHECK (jsonb_typeof(restricted_projects) = 'array'),
  content_digest char(64) NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  schema_version text NOT NULL CHECK (schema_version = 'lyra.asset-pack/1'),
  created_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, version_id),
  UNIQUE (workspace_id, logical_asset_id, version),
  CONSTRAINT asset_pack_parent_ref FOREIGN KEY (workspace_id, parent_version_id)
    REFERENCES asset_pack_versions (workspace_id, version_id) ON DELETE RESTRICT,
  CONSTRAINT asset_pack_project_scope CHECK (
    (project_scope = 'workspace' AND project_id IS NULL)
    OR (project_scope = 'project' AND project_id IS NOT NULL)
  ),
  CONSTRAINT asset_pack_reviewed_fields CHECK (
    review_status <> 'approved' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  CONSTRAINT asset_pack_adopted_authorized CHECK (
    status <> 'adopted' OR (review_status = 'approved' AND authorization_status = 'allowed')
  ),
  CONSTRAINT asset_pack_validity CHECK (valid_until IS NULL OR valid_until > valid_from)
);

CREATE TABLE IF NOT EXISTS asset_pack_media (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  version_id text NOT NULL CHECK (version_id ~ '^apv_[a-f0-9]{32}$'),
  media_id text NOT NULL CHECK (media_id ~ '^apm_[a-f0-9]{32}$'),
  role text NOT NULL CHECK (role IN ('reference', 'view', 'expression', 'costume', 'state', 'scene_layer', 'prop_state')),
  view text NULL CHECK (view IS NULL OR view IN ('front', 'side_left', 'side_right', 'back', 'profile', 'full_body', 'medium', 'close_up')),
  state text NULL CHECK (state IS NULL OR char_length(state) BETWEEN 1 AND 120),
  object_id text NOT NULL CHECK (object_id ~ '^[A-Za-z][A-Za-z0-9_.:-]{2,159}$'),
  object_version_id text NOT NULL CHECK (object_version_id ~ '^objver_[a-f0-9]{32}$'),
  checksum char(64) NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 4294967296),
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  crop_json jsonb NULL CHECK (crop_json IS NULL OR jsonb_typeof(crop_json) = 'object'),
  quality_status text NOT NULL CHECK (quality_status IN ('pending', 'pass', 'fail', 'quarantined')),
  provenance_json jsonb NOT NULL CHECK (jsonb_typeof(provenance_json) = 'object'),
  PRIMARY KEY (workspace_id, version_id, media_id),
  FOREIGN KEY (workspace_id, version_id) REFERENCES asset_pack_versions (workspace_id, version_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS asset_pack_media_slot
  ON asset_pack_media (workspace_id, version_id, role, COALESCE(view, ''), COALESCE(state, ''));

CREATE TABLE IF NOT EXISTS asset_pack_adoptions (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  adoption_id text NOT NULL CHECK (adoption_id ~ '^apa_[a-f0-9]{32}$'),
  logical_asset_id text NOT NULL CHECK (logical_asset_id ~ '^[A-Za-z][A-Za-z0-9_.:-]{2,159}$'),
  version_id text NOT NULL CHECK (version_id ~ '^apv_[a-f0-9]{32}$'),
  adopted_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, adoption_id),
  UNIQUE (workspace_id, logical_asset_id, version_id),
  FOREIGN KEY (workspace_id, version_id) REFERENCES asset_pack_versions (workspace_id, version_id) ON DELETE RESTRICT
);

-- 版本/媒资/采用记录均不可原地修改；新版本必须新增行并通过 parent_version_id 串联。
CREATE OR REPLACE FUNCTION asset_pack_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'ASSET_PACK_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS asset_pack_versions_immutable ON asset_pack_versions;
CREATE TRIGGER asset_pack_versions_immutable BEFORE UPDATE OR DELETE ON asset_pack_versions
  FOR EACH ROW EXECUTE FUNCTION asset_pack_immutable();
DROP TRIGGER IF EXISTS asset_pack_media_immutable ON asset_pack_media;
CREATE TRIGGER asset_pack_media_immutable BEFORE UPDATE OR DELETE ON asset_pack_media
  FOR EACH ROW EXECUTE FUNCTION asset_pack_immutable();
DROP TRIGGER IF EXISTS asset_pack_adoptions_immutable ON asset_pack_adoptions;
CREATE TRIGGER asset_pack_adoptions_immutable BEFORE UPDATE OR DELETE ON asset_pack_adoptions
  FOR EACH ROW EXECUTE FUNCTION asset_pack_immutable();

-- 采用记录必须指向同一 workspace 的版本，并校验逻辑资产身份与版本状态。
CREATE OR REPLACE FUNCTION asset_pack_adoption_guard() RETURNS trigger AS $$
DECLARE source_logical text; source_status text;
BEGIN
  SELECT logical_asset_id, status INTO source_logical, source_status
    FROM asset_pack_versions
    WHERE workspace_id = NEW.workspace_id AND version_id = NEW.version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ASSET_PACK_VERSION_UNKNOWN';
  END IF;
  IF source_logical IS DISTINCT FROM NEW.logical_asset_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ASSET_PACK_LOGICAL_ID_MISMATCH';
  END IF;
  IF source_status NOT IN ('adopted', 'superseded') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ASSET_PACK_NOT_ADOPTABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS asset_pack_adoption_guard ON asset_pack_adoptions;
CREATE TRIGGER asset_pack_adoption_guard BEFORE INSERT ON asset_pack_adoptions
  FOR EACH ROW EXECUTE FUNCTION asset_pack_adoption_guard();

-- 租户四件套：写入作用域触发器、FORCE RLS 与统一隔离策略。
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['asset_pack_versions', 'asset_pack_media', 'asset_pack_adoptions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS lyra_workspace_scope_guard ON %I', table_name);
    EXECUTE format('CREATE TRIGGER lyra_workspace_scope_guard BEFORE INSERT OR UPDATE OF workspace_id ON %I '
      'FOR EACH ROW EXECUTE FUNCTION lyra_enforce_workspace_scope()', table_name);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS lyra_workspace_isolation ON %I', table_name);
    EXECUTE format('CREATE POLICY lyra_workspace_isolation ON %I '
      'USING (lyra_system_bypass_enabled() OR workspace_id=lyra_current_workspace_id()) '
      'WITH CHECK (lyra_system_bypass_enabled() OR workspace_id=lyra_current_workspace_id())', table_name);
  END LOOP;
END;
$$;

COMMIT;
