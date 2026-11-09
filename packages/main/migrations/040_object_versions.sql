BEGIN;
CREATE TABLE object_versions (
  workspace_id text NOT NULL,id text NOT NULL CHECK(id ~ '^objver_[a-f0-9]{32}$'),object_id text NOT NULL,
  source_facts_digest char(64) NOT NULL CHECK(source_facts_digest ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL CHECK(provider IN ('local','minio','s3','oss','cos')),bucket text NOT NULL,
  source_key text NOT NULL,source_provider_version_id text NULL,
  object_key text NOT NULL,provider_version_id text NULL,sha256 char(64) NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK(size_bytes>0),content_type text NOT NULL,purpose text NOT NULL,owner_type text NOT NULL,owner_id text NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','ready','failed')),version integer NOT NULL DEFAULT 1 CHECK(version>0),
  job_id text NOT NULL,created_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,created_at timestamptz NOT NULL,
  verified_at timestamptz NULL,last_error_code text NULL,
  PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,object_id,id,sha256),UNIQUE(workspace_id,object_id,source_facts_digest),
  FOREIGN KEY(workspace_id,object_id) REFERENCES object_records(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,job_id) REFERENCES jobs(workspace_id,id) ON DELETE RESTRICT,
  CHECK((status='ready')=(verified_at IS NOT NULL)),CHECK(status='ready' OR provider_version_id IS NULL),
  CHECK(object_key='production-media/objects/versions/'||id||'/'||sha256),
  CHECK(size_bytes<=4294967296),CHECK(char_length(bucket) BETWEEN 2 AND 128),
  CHECK(provider_version_id IS NULL OR (char_length(provider_version_id) BETWEEN 1 AND 512 AND provider_version_id !~ '[[:cntrl:]]')),
  CHECK(source_provider_version_id IS NULL OR (char_length(source_provider_version_id) BETWEEN 1 AND 512 AND source_provider_version_id !~ '[[:cntrl:]]'))
);
CREATE FUNCTION lyra_object_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'pending' OR NEW.version<>1 OR NEW.verified_at IS NOT NULL OR NEW.provider_version_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='LYRA_OBJECT_VERSION_INITIAL_STATE_INVALID';END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='LYRA_OBJECT_VERSION_IMMUTABLE';END IF;
  IF OLD.status IN ('ready','failed') OR NEW.version<>OLD.version+1
    OR (to_jsonb(NEW)-ARRAY['status','version','verified_at','provider_version_id','last_error_code'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version','verified_at','provider_version_id','last_error_code']) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='LYRA_OBJECT_VERSION_IMMUTABLE';
  END IF;
  IF NEW.status='ready' AND NOT EXISTS(SELECT 1 FROM jobs WHERE workspace_id=NEW.workspace_id AND id=NEW.job_id AND state='succeeded') THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='LYRA_OBJECT_VERSION_JOB_NOT_SETTLED';END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER object_version_guard BEFORE INSERT OR UPDATE OR DELETE ON object_versions FOR EACH ROW EXECUTE FUNCTION lyra_object_version_guard();
CREATE TRIGGER lyra_workspace_scope_guard BEFORE INSERT OR UPDATE OF workspace_id ON object_versions FOR EACH ROW EXECUTE FUNCTION lyra_enforce_workspace_scope();
ALTER TABLE object_versions ENABLE ROW LEVEL SECURITY;ALTER TABLE object_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY lyra_workspace_isolation ON object_versions USING(lyra_system_bypass_enabled() OR workspace_id=lyra_current_workspace_id())
  WITH CHECK(lyra_system_bypass_enabled() OR workspace_id=lyra_current_workspace_id());
CREATE TABLE production_input_object_version_refs (
  workspace_id text NOT NULL,snapshot_id text NOT NULL,object_id text NOT NULL,object_version_id text NOT NULL,checksum char(64) NOT NULL,
  PRIMARY KEY(workspace_id,snapshot_id,object_version_id),
  FOREIGN KEY(workspace_id,snapshot_id) REFERENCES production_input_snapshots(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,object_id,object_version_id,checksum) REFERENCES object_versions(workspace_id,object_id,id,sha256) ON DELETE RESTRICT
);
CREATE FUNCTION lyra_retain_input_object_versions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('ready','frozen') THEN
    INSERT INTO production_input_object_version_refs(workspace_id,snapshot_id,object_id,object_version_id,checksum)
      SELECT DISTINCT i.workspace_id,i.snapshot_id,media->>'objectId',media->>'objectVersionId',media->>'checksum'
      FROM production_input_shots i JOIN shot_spec_versions s ON s.workspace_id=i.workspace_id AND s.id=i.shot_version_id
      CROSS JOIN LATERAL jsonb_array_elements(s.spec_json->'assetPacks') pack CROSS JOIN LATERAL jsonb_array_elements(pack->'media') media
      WHERE i.workspace_id=NEW.workspace_id AND i.snapshot_id=NEW.snapshot_id ON CONFLICT DO NOTHING;
  END IF;RETURN NEW;
END; $$;
CREATE FUNCTION lyra_input_object_version_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM object_versions v JOIN object_records o ON o.workspace_id=v.workspace_id AND o.id=v.object_id
    WHERE v.workspace_id=NEW.workspace_id AND v.id=NEW.object_version_id AND v.object_id=NEW.object_id AND v.sha256=NEW.checksum
      AND v.status='ready' AND o.status='ready' AND o.deleted_at IS NULL)
    OR NOT EXISTS(SELECT 1 FROM production_input_shots i JOIN shot_spec_versions s ON s.workspace_id=i.workspace_id AND s.id=i.shot_version_id
      CROSS JOIN LATERAL jsonb_array_elements(s.spec_json->'assetPacks') pack CROSS JOIN LATERAL jsonb_array_elements(pack->'media') media
      WHERE i.workspace_id=NEW.workspace_id AND i.snapshot_id=NEW.snapshot_id AND media->>'objectId'=NEW.object_id
        AND media->>'objectVersionId'=NEW.object_version_id AND media->>'checksum'=NEW.checksum) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='LYRA_INPUT_OBJECT_VERSION_INVALID';END IF;RETURN NEW;
END; $$;
CREATE TRIGGER input_object_version_binding BEFORE INSERT ON production_input_object_version_refs FOR EACH ROW EXECUTE FUNCTION lyra_input_object_version_binding();
CREATE TRIGGER production_input_retain_object_versions AFTER INSERT OR UPDATE ON production_input_states FOR EACH ROW EXECUTE FUNCTION lyra_retain_input_object_versions();
-- Old unprovable provider IDs are NOT silently converted into internal versions.
INSERT INTO production_input_object_version_refs(workspace_id,snapshot_id,object_id,object_version_id,checksum)
  SELECT DISTINCT i.workspace_id,i.snapshot_id,media->>'objectId',media->>'objectVersionId',media->>'checksum'
  FROM production_input_shots i JOIN production_input_states t ON t.workspace_id=i.workspace_id AND t.snapshot_id=i.snapshot_id
  JOIN shot_spec_versions s ON s.workspace_id=i.workspace_id AND s.id=i.shot_version_id
  CROSS JOIN LATERAL jsonb_array_elements(s.spec_json->'assetPacks') pack CROSS JOIN LATERAL jsonb_array_elements(pack->'media') media WHERE t.state IN ('ready','frozen');
CREATE TRIGGER lyra_workspace_scope_guard BEFORE INSERT OR UPDATE OF workspace_id ON production_input_object_version_refs FOR EACH ROW EXECUTE FUNCTION lyra_enforce_workspace_scope();
CREATE TRIGGER input_object_version_refs_immutable BEFORE UPDATE OR DELETE ON production_input_object_version_refs FOR EACH ROW EXECUTE FUNCTION lyra_production_input_immutable();
ALTER TABLE production_input_object_version_refs ENABLE ROW LEVEL SECURITY;ALTER TABLE production_input_object_version_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY lyra_workspace_isolation ON production_input_object_version_refs USING(lyra_system_bypass_enabled() OR workspace_id=lyra_current_workspace_id())
  WITH CHECK(lyra_system_bypass_enabled() OR workspace_id=lyra_current_workspace_id());
ALTER TABLE data_outbox_events DROP CONSTRAINT data_outbox_events_aggregate_type_check;
ALTER TABLE data_outbox_events ADD CONSTRAINT data_outbox_events_aggregate_type_check CHECK(aggregate_type IN (
  'novel_chapter','script','asset','production_run','production_attempt','external_operation','quality_check','delivery_artifact','evaluation_run',
  'shot_spec','production_input','director_scene','object_version'));
COMMIT;
