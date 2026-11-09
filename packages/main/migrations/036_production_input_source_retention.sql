BEGIN;
-- Snapshot JSON is not a foreign key. Retain the exact historical source chain
-- once validation succeeds, even after project active pointers move elsewhere.
ALTER TABLE script_versions ADD CONSTRAINT script_versions_input_source_identity UNIQUE(workspace_id,project_id,id);
ALTER TABLE plan_revisions ADD CONSTRAINT plan_revisions_input_source_identity UNIQUE(workspace_id,project_id,script_version_id,id);
ALTER TABLE storyboard_revisions ADD CONSTRAINT storyboard_revisions_input_source_identity UNIQUE(workspace_id,project_id,script_version_id,source_plan_revision_id,id);
CREATE TABLE production_input_source_refs (
  workspace_id text NOT NULL,
  snapshot_id text NOT NULL,
  project_id text NOT NULL,
  episode_id text NOT NULL,
  script_version_id text NOT NULL,
  plan_revision_id text NOT NULL,
  storyboard_revision_id text NOT NULL,
  PRIMARY KEY(workspace_id,snapshot_id),
  FOREIGN KEY(workspace_id,project_id,episode_id,snapshot_id)
    REFERENCES production_input_snapshots(workspace_id,project_id,episode_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,project_id,script_version_id)
    REFERENCES script_versions(workspace_id,project_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,project_id,script_version_id,plan_revision_id)
    REFERENCES plan_revisions(workspace_id,project_id,script_version_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,project_id,script_version_id,plan_revision_id,storyboard_revision_id)
    REFERENCES storyboard_revisions(workspace_id,project_id,script_version_id,source_plan_revision_id,id) ON DELETE RESTRICT
);
CREATE FUNCTION lyra_production_input_source_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE manifest jsonb;
BEGIN
  SELECT snapshot_json INTO manifest FROM production_input_snapshots
    WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND episode_id=NEW.episode_id AND id=NEW.snapshot_id;
  IF manifest IS NULL OR NEW.script_version_id IS DISTINCT FROM manifest->'script'->>'versionId'
    OR NEW.plan_revision_id IS DISTINCT FROM manifest->'plan'->>'versionId'
    OR NEW.storyboard_revision_id IS DISTINCT FROM manifest->'storyboard'->>'versionId' THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='LYRA_PRODUCTION_INPUT_SOURCE_BINDING_INVALID';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER lyra_workspace_scope_guard BEFORE INSERT OR UPDATE OF workspace_id ON production_input_source_refs
  FOR EACH ROW EXECUTE FUNCTION lyra_enforce_workspace_scope();
CREATE TRIGGER production_input_source_binding BEFORE INSERT ON production_input_source_refs
  FOR EACH ROW EXECUTE FUNCTION lyra_production_input_source_binding();
CREATE TRIGGER production_input_source_refs_immutable BEFORE UPDATE OR DELETE ON production_input_source_refs
  FOR EACH ROW EXECUTE FUNCTION lyra_production_input_immutable();
ALTER TABLE production_input_source_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_input_source_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY lyra_workspace_isolation ON production_input_source_refs
  USING(lyra_system_bypass_enabled() OR workspace_id=lyra_current_workspace_id())
  WITH CHECK(lyra_system_bypass_enabled() OR workspace_id=lyra_current_workspace_id());

CREATE FUNCTION lyra_retain_production_input_sources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('ready','frozen') THEN
    INSERT INTO production_input_source_refs(workspace_id,snapshot_id,project_id,episode_id,script_version_id,plan_revision_id,storyboard_revision_id)
    SELECT workspace_id,id,project_id,episode_id,snapshot_json->'script'->>'versionId',snapshot_json->'plan'->>'versionId',snapshot_json->'storyboard'->>'versionId'
      FROM production_input_snapshots WHERE workspace_id=NEW.workspace_id AND id=NEW.snapshot_id
    ON CONFLICT(workspace_id,snapshot_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER production_input_retain_sources AFTER INSERT OR UPDATE ON production_input_states
  FOR EACH ROW EXECUTE FUNCTION lyra_retain_production_input_sources();

-- Existing validated inputs must have a valid source chain too. Fail the whole
-- migration on an orphan; never silently skip it or guess a replacement source.
INSERT INTO production_input_source_refs(workspace_id,snapshot_id,project_id,episode_id,script_version_id,plan_revision_id,storyboard_revision_id)
SELECT r.workspace_id,r.id,r.project_id,r.episode_id,r.snapshot_json->'script'->>'versionId',r.snapshot_json->'plan'->>'versionId',r.snapshot_json->'storyboard'->>'versionId'
  FROM production_input_snapshots r JOIN production_input_states s ON s.workspace_id=r.workspace_id AND s.snapshot_id=r.id
  WHERE s.state IN ('ready','frozen');
COMMIT;
