BEGIN;
ALTER TABLE production_input_snapshots ADD CONSTRAINT production_input_run_identity
  UNIQUE(workspace_id,project_id,id,snapshot_digest);
ALTER TABLE production_runs ADD COLUMN input_snapshot_id text
  GENERATED ALWAYS AS (run_json->'inputSnapshot'->>'snapshotId') STORED;
ALTER TABLE production_runs ADD COLUMN input_snapshot_digest char(64)
  GENERATED ALWAYS AS ((run_json->'inputSnapshot'->>'snapshotDigest')::char(64)) STORED;
ALTER TABLE production_runs ADD CONSTRAINT production_run_input_snapshot_fk
  FOREIGN KEY(workspace_id,project_id,input_snapshot_id,input_snapshot_digest)
  REFERENCES production_input_snapshots(workspace_id,project_id,id,snapshot_digest) ON DELETE RESTRICT;

CREATE FUNCTION lyra_production_run_input_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding jsonb; manifest jsonb; frozen_state text; key text;
BEGIN
  binding:=NEW.run_json->'inputSnapshot';
  IF TG_OP='UPDATE' THEN
    IF binding IS DISTINCT FROM OLD.run_json->'inputSnapshot' THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='LYRA_PRODUCTION_RUN_INPUT_IMMUTABLE';
    END IF;
    IF OLD.run_json ? 'inputSnapshot' THEN
      FOREACH key IN ARRAY ARRAY['projectId','scriptVersionId','ratio','targetDurationSec','visualStyle','qualityPreset',
        'automationMode','candidatePolicy','candidateLimit','directorPolicy','budgetMicros','currency','allowPaid',
        'clientRequestId','methodPacks','assetRetrievalPolicy','createdAt','workflowVersion'] LOOP
        IF NEW.run_json->key IS DISTINCT FROM OLD.run_json->key THEN
          RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='LYRA_PRODUCTION_RUN_INPUT_IMMUTABLE';
        END IF;
      END LOOP;
    END IF;
    RETURN NEW;
  END IF;
  IF NOT NEW.run_json ? 'inputSnapshot' THEN RETURN NEW; END IF;
  IF jsonb_typeof(binding) IS DISTINCT FROM 'object'
    OR binding->>'schemaVersion' IS DISTINCT FROM 'lyra-production-binding/1'
    OR binding->>'workspaceId' IS DISTINCT FROM NEW.workspace_id
    OR binding->>'snapshotDigest' IS NULL OR length(binding->>'snapshotDigest')<>64
    OR (binding->>'snapshotDigest') !~ '^[a-f0-9]{64}$'
    OR (SELECT count(*) FROM jsonb_object_keys(binding))<>5 THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LYRA_PRODUCTION_RUN_INPUT_INVALID';
  END IF;
  SELECT r.snapshot_json,s.state INTO manifest,frozen_state FROM production_input_snapshots r
    JOIN production_input_states s ON s.workspace_id=r.workspace_id AND s.snapshot_id=r.id
    WHERE r.workspace_id=NEW.workspace_id AND r.project_id=NEW.project_id AND r.id=binding->>'snapshotId'
      AND r.snapshot_digest=binding->>'snapshotDigest'
    FOR SHARE OF r,s;
  IF manifest IS NULL OR frozen_state IS DISTINCT FROM 'frozen'
    OR binding->>'episodeId' IS DISTINCT FROM manifest->>'episodeId'
    OR NEW.script_version_id IS DISTINCT FROM manifest->'script'->>'versionId'
    OR manifest->'budgetPolicy'->'allowPaid' IS DISTINCT FROM 'true'::jsonb
    OR NEW.run_json->'allowPaid' IS DISTINCT FROM 'true'::jsonb
    OR NEW.run_json->'budgetMicros' IS DISTINCT FROM manifest->'budgetPolicy'->'limitMicros'
    OR NEW.run_json->'currency' IS DISTINCT FROM manifest->'budgetPolicy'->'currency'
    OR NEW.run_json->'candidatePolicy' IS DISTINCT FROM manifest->'candidatePolicy'->'mode'
    OR NEW.run_json->'candidateLimit' IS DISTINCT FROM manifest->'candidatePolicy'->'limit'
    OR NEW.run_json->'automationMode' IS DISTINCT FROM manifest->'automationMode'
    OR NEW.run_json->'assetRetrievalPolicy'->>'policyDigest' IS DISTINCT FROM manifest->'retrievalPolicy'->>'digest'
    OR jsonb_typeof(manifest->'executionPolicy') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LYRA_PRODUCTION_RUN_SNAPSHOT_NOT_READY';
  END IF;
  FOREACH key IN ARRAY ARRAY['ratio','targetDurationSec','visualStyle','qualityPreset','directorPolicy'] LOOP
    IF NEW.run_json->key IS NULL OR NEW.run_json->key IS DISTINCT FROM manifest->'executionPolicy'->key THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LYRA_PRODUCTION_RUN_INPUT_INVALID';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER production_run_input_binding_guard BEFORE INSERT OR UPDATE ON production_runs
  FOR EACH ROW EXECUTE FUNCTION lyra_production_run_input_binding_guard();
COMMIT;
