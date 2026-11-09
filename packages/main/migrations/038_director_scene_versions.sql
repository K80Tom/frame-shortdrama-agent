BEGIN;
CREATE TABLE director_scene_versions (
  workspace_id text NOT NULL,id text NOT NULL,scene_id text NOT NULL,project_id text NOT NULL,episode_id text NOT NULL,shot_id text NOT NULL,
  script_version_id text NOT NULL,plan_revision_id text NOT NULL,storyboard_revision_id text NOT NULL,
  content_digest char(64) NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),scene_json jsonb NOT NULL,
  created_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,created_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,project_id,episode_id,scene_id,id,content_digest),
  FOREIGN KEY(workspace_id,project_id,episode_id) REFERENCES production_episodes(workspace_id,project_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,project_id,script_version_id,plan_revision_id,storyboard_revision_id)
    REFERENCES storyboard_revisions(workspace_id,project_id,script_version_id,source_plan_revision_id,id) ON DELETE RESTRICT,
  CHECK(jsonb_typeof(scene_json)='object' AND scene_json ?& ARRAY['schemaVersion','workspaceId','revisionId','sceneId','projectId','episodeId','shotId',
    'scriptVersionId','planRevisionId','storyboardRevisionId','contentDigest','createdBy','createdAt','scene']),
  CHECK((scene_json->>'schemaVersion') IS NOT DISTINCT FROM 'lyra-director-scene/1'
    AND (scene_json->>'workspaceId') IS NOT DISTINCT FROM workspace_id AND (scene_json->>'revisionId') IS NOT DISTINCT FROM id
    AND (scene_json->>'sceneId') IS NOT DISTINCT FROM scene_id AND (scene_json->>'projectId') IS NOT DISTINCT FROM project_id
    AND (scene_json->>'episodeId') IS NOT DISTINCT FROM episode_id AND (scene_json->>'shotId') IS NOT DISTINCT FROM shot_id
    AND (scene_json->>'scriptVersionId') IS NOT DISTINCT FROM script_version_id AND (scene_json->>'planRevisionId') IS NOT DISTINCT FROM plan_revision_id
    AND (scene_json->>'storyboardRevisionId') IS NOT DISTINCT FROM storyboard_revision_id AND (scene_json->>'contentDigest') IS NOT DISTINCT FROM content_digest
    AND (scene_json->>'createdBy') IS NOT DISTINCT FROM created_by
    AND (scene_json->>'createdAt')::timestamptz IS NOT DISTINCT FROM created_at)
);
CREATE TABLE production_input_director_scene_refs (
  workspace_id text NOT NULL,snapshot_id text NOT NULL,project_id text NOT NULL,episode_id text NOT NULL,
  scene_id text NOT NULL,scene_version_id text NOT NULL,content_digest char(64) NOT NULL,
  PRIMARY KEY(workspace_id,snapshot_id,scene_id),
  FOREIGN KEY(workspace_id,project_id,episode_id,snapshot_id) REFERENCES production_input_snapshots(workspace_id,project_id,episode_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,project_id,episode_id,scene_id,scene_version_id,content_digest)
    REFERENCES director_scene_versions(workspace_id,project_id,episode_id,scene_id,id,content_digest) ON DELETE RESTRICT
);
CREATE FUNCTION lyra_director_scene_ref_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM production_input_snapshots r CROSS JOIN LATERAL jsonb_array_elements(r.snapshot_json->'directorScenes') item
    WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.snapshot_id AND r.project_id=NEW.project_id AND r.episode_id=NEW.episode_id
      AND item->>'id'=NEW.scene_id AND item->>'versionId'=NEW.scene_version_id AND item->>'digest'=NEW.content_digest) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='LYRA_DIRECTOR_SCENE_REF_INVALID';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER director_scene_ref_binding BEFORE INSERT ON production_input_director_scene_refs
  FOR EACH ROW EXECUTE FUNCTION lyra_director_scene_ref_binding();
CREATE FUNCTION lyra_retain_input_director_scenes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('ready','frozen') THEN
    INSERT INTO production_input_director_scene_refs(workspace_id,snapshot_id,project_id,episode_id,scene_id,scene_version_id,content_digest)
      SELECT r.workspace_id,r.id,r.project_id,r.episode_id,item->>'id',item->>'versionId',item->>'digest'
      FROM production_input_snapshots r CROSS JOIN LATERAL jsonb_array_elements(r.snapshot_json->'directorScenes') item
      WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.snapshot_id
    ON CONFLICT(workspace_id,snapshot_id,scene_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER production_input_retain_director_scenes AFTER INSERT OR UPDATE ON production_input_states
  FOR EACH ROW EXECUTE FUNCTION lyra_retain_input_director_scenes();
-- Fail the entire migration on historical orphaned validated scene refs, not a silent skip/guessed replacement.
INSERT INTO production_input_director_scene_refs(workspace_id,snapshot_id,project_id,episode_id,scene_id,scene_version_id,content_digest)
  SELECT r.workspace_id,r.id,r.project_id,r.episode_id,item->>'id',item->>'versionId',item->>'digest'
  FROM production_input_snapshots r JOIN production_input_states s ON s.workspace_id=r.workspace_id AND s.snapshot_id=r.id
  CROSS JOIN LATERAL jsonb_array_elements(r.snapshot_json->'directorScenes') item WHERE s.state IN ('ready','frozen');
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['director_scene_versions','production_input_director_scene_refs'] LOOP
    EXECUTE format('CREATE TRIGGER lyra_workspace_scope_guard BEFORE INSERT OR UPDATE OF workspace_id ON %I FOR EACH ROW EXECUTE FUNCTION lyra_enforce_workspace_scope()',table_name);
    EXECUTE format('CREATE TRIGGER director_scene_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION lyra_production_input_immutable()',table_name);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY lyra_workspace_isolation ON %I USING(lyra_system_bypass_enabled() OR workspace_id=lyra_current_workspace_id()) WITH CHECK(lyra_system_bypass_enabled() OR workspace_id=lyra_current_workspace_id())',table_name);
  END LOOP;
END; $$;
ALTER TABLE data_outbox_events DROP CONSTRAINT data_outbox_events_aggregate_type_check;
ALTER TABLE data_outbox_events ADD CONSTRAINT data_outbox_events_aggregate_type_check CHECK(aggregate_type IN (
  'novel_chapter','script','asset','production_run','production_attempt','external_operation','quality_check',
  'delivery_artifact','evaluation_run','shot_spec','production_input','director_scene'));
COMMIT;
