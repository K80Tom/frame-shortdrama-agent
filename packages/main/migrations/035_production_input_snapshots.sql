BEGIN;
CREATE TABLE production_input_snapshots (
  workspace_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  episode_id text NOT NULL,
  base_project_revision bigint NOT NULL CHECK(base_project_revision>=0),
  snapshot_digest char(64) NOT NULL CHECK(snapshot_digest ~ '^[a-f0-9]{64}$'),
  snapshot_json jsonb NOT NULL CHECK(jsonb_typeof(snapshot_json)='object'),
  created_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,project_id,episode_id,id),
  FOREIGN KEY(workspace_id,project_id,episode_id) REFERENCES production_episodes(workspace_id,project_id,id) ON DELETE RESTRICT,
  CHECK(snapshot_json ?& ARRAY['schemaVersion','id','workspaceId','projectId','episodeId','baseProjectRevision','snapshotDigest','state','findings']),
  CHECK((snapshot_json->>'schemaVersion') IS NOT DISTINCT FROM 'lyra-production-input/1'
    AND (snapshot_json->>'id') IS NOT DISTINCT FROM id
    AND (snapshot_json->>'workspaceId') IS NOT DISTINCT FROM workspace_id
    AND (snapshot_json->>'projectId') IS NOT DISTINCT FROM project_id
    AND (snapshot_json->>'episodeId') IS NOT DISTINCT FROM episode_id
    AND (snapshot_json->>'baseProjectRevision') IS NOT DISTINCT FROM base_project_revision::text
    AND (snapshot_json->>'snapshotDigest') IS NOT DISTINCT FROM snapshot_digest
    AND (snapshot_json->>'state') IS NOT DISTINCT FROM 'draft'
    AND (snapshot_json->'findings') IS NOT DISTINCT FROM '[]'::jsonb)
);
CREATE TABLE production_input_shots (
  workspace_id text NOT NULL,
  snapshot_id text NOT NULL,
  project_id text NOT NULL,
  episode_id text NOT NULL,
  shot_id text NOT NULL,
  shot_version_id text NOT NULL,
  position integer NOT NULL CHECK(position>=0 AND position<2000),
  PRIMARY KEY(workspace_id,snapshot_id,position),
  UNIQUE(workspace_id,snapshot_id,shot_id),
  FOREIGN KEY(workspace_id,project_id,episode_id,snapshot_id)
    REFERENCES production_input_snapshots(workspace_id,project_id,episode_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,project_id,episode_id,shot_id,shot_version_id)
    REFERENCES shot_spec_versions(workspace_id,project_id,episode_id,shot_id,id) ON DELETE RESTRICT
);
CREATE TABLE production_input_states (
  workspace_id text NOT NULL,
  snapshot_id text NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','validating','ready','blocked','frozen')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  findings_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(findings_json)='array'),
  validated_project_revision bigint NULL CHECK(validated_project_revision>=0),
  updated_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,snapshot_id),
  FOREIGN KEY(workspace_id,snapshot_id) REFERENCES production_input_snapshots(workspace_id,id) ON DELETE RESTRICT,
  CHECK(state NOT IN ('ready','frozen') OR (findings_json='[]'::jsonb AND validated_project_revision IS NOT NULL)),
  CHECK(state<>'blocked' OR jsonb_array_length(findings_json)>0)
);
CREATE FUNCTION lyra_production_input_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='LYRA_PRODUCTION_INPUT_IMMUTABLE'; END;
$$;
CREATE TRIGGER production_input_snapshot_immutable BEFORE UPDATE OR DELETE ON production_input_snapshots
  FOR EACH ROW EXECUTE FUNCTION lyra_production_input_immutable();
CREATE TRIGGER production_input_shots_immutable BEFORE UPDATE OR DELETE ON production_input_shots
  FOR EACH ROW EXECUTE FUNCTION lyra_production_input_immutable();
CREATE FUNCTION lyra_production_input_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE base_revision bigint;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='LYRA_PRODUCTION_INPUT_STATE_IMMUTABLE';
  ELSIF TG_OP='INSERT' THEN
    IF NEW.state<>'draft' OR NEW.version<>1 OR NEW.findings_json<>'[]'::jsonb OR NEW.validated_project_revision IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='LYRA_PRODUCTION_INPUT_INITIAL_STATE_INVALID';
    END IF;
  ELSE
    IF OLD.state='frozen' OR NEW.version<>OLD.version+1 OR NOT (
      (OLD.state IN ('draft','blocked','ready') AND NEW.state='validating')
      OR (OLD.state='validating' AND NEW.state IN ('ready','blocked'))
      OR (OLD.state='ready' AND NEW.state='frozen')) THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='LYRA_PRODUCTION_INPUT_TRANSITION_INVALID';
    END IF;
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='LYRA_PRODUCTION_INPUT_IDENTITY_IMMUTABLE';
    END IF;
  END IF;
  IF NEW.state IN ('ready','frozen') THEN
    SELECT base_project_revision INTO base_revision FROM production_input_snapshots
      WHERE workspace_id=NEW.workspace_id AND id=NEW.snapshot_id;
    IF NEW.validated_project_revision IS DISTINCT FROM base_revision THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='LYRA_PRODUCTION_INPUT_VALIDATION_REVISION_INVALID';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER production_input_state_guard BEFORE INSERT OR UPDATE OR DELETE ON production_input_states
  FOR EACH ROW EXECUTE FUNCTION lyra_production_input_state_guard();
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['production_input_snapshots','production_input_shots','production_input_states'] LOOP
    EXECUTE format('CREATE TRIGGER lyra_workspace_scope_guard BEFORE INSERT OR UPDATE OF workspace_id ON %I '
      'FOR EACH ROW EXECUTE FUNCTION lyra_enforce_workspace_scope()',table_name);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY lyra_workspace_isolation ON %I '
      'USING(lyra_system_bypass_enabled() OR workspace_id=lyra_current_workspace_id()) '
      'WITH CHECK(lyra_system_bypass_enabled() OR workspace_id=lyra_current_workspace_id())',table_name);
  END LOOP;
END;
$$;
ALTER TABLE data_outbox_events DROP CONSTRAINT data_outbox_events_aggregate_type_check;
ALTER TABLE data_outbox_events ADD CONSTRAINT data_outbox_events_aggregate_type_check CHECK(aggregate_type IN (
  'novel_chapter','script','asset','production_run','production_attempt','external_operation','quality_check',
  'delivery_artifact','evaluation_run','shot_spec','production_input'
));
COMMIT;
