BEGIN;

-- Stage 1 tenant contract migration.
--
-- Migration 025 deliberately used an expand-only nullable column so the old
-- application could continue running while repositories were moved behind a
-- request/worker tenant scope.  The runtime now sets transaction-local
-- lyra.workspace_id / lyra.system_bypass values, so the database can close the
-- contract and reject an unscoped or cross-workspace query even when a
-- repository accidentally looks up a row by its global id.

CREATE OR REPLACE FUNCTION lyra_current_workspace_id() RETURNS text AS $$
  SELECT NULLIF(current_setting('lyra.workspace_id', true), '')
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION lyra_system_bypass_enabled() RETURNS boolean AS $$
  SELECT COALESCE(current_setting('lyra.system_bypass', true), 'off') = 'on'
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION lyra_enforce_workspace_scope() RETURNS trigger AS $$
DECLARE
  scoped_workspace_id text;
BEGIN
  IF lyra_system_bypass_enabled() THEN
    -- Stage 1 keeps pre-tenant maintenance utilities and the historical DB
    -- matrix deterministic.  A system write that omits ownership is contained
    -- in the reserved workspace (adopted by the first trusted workspace)
    -- instead of failing NOT NULL or inventing another tenant.  Tenant-scoped
    -- runtime writes never take this branch.
    IF NEW.workspace_id IS NULL THEN
      NEW.workspace_id := 'ws_00000000000000000000000000000000';
    END IF;
    RETURN NEW;
  END IF;

  scoped_workspace_id := lyra_current_workspace_id();
  IF scoped_workspace_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'LYRA_TENANT_SCOPE_REQUIRED';
  END IF;

  IF NEW.workspace_id IS NULL THEN
    NEW.workspace_id := scoped_workspace_id;
  ELSIF NEW.workspace_id IS DISTINCT FROM scoped_workspace_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'LYRA_CROSS_TENANT_WRITE_DENIED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Rows written during the expand window did not yet have a runtime tenant
-- trigger. Keep them in the reserved workspace rather than guessing a customer
-- owner. The explicit first-admin bootstrap atomically activates and adopts
-- that workspace; immutable event/check records therefore need no rewrite.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'projects', 'script_versions', 'breakdown_runs', 'breakdown_tasks',
    'breakdown_attempts', 'model_calls', 'plan_revisions', 'plan_checks',
    'plan_issues', 'plan_adoptions', 'storyboard_attempts',
    'storyboard_revisions', 'storyboard_adoptions', 'novel_sources',
    'novel_chapters', 'novel_revisions', 'novel_attempts', 'asset_catalog',
    'asset_media', 'desktop_asset_jobs', 'asset_generation_candidates',
    'video_automation_runs', 'production_runs', 'production_outbox_events',
    'assistant_sessions', 'assistant_messages', 'assistant_quotes',
    'prompt_pack_states', 'prompt_pack_imports', 'evaluation_datasets',
    'evaluation_dataset_revisions', 'evaluation_cases', 'evaluation_rubrics',
    'evaluation_rubric_revisions', 'evaluation_rubric_dimensions',
    'evaluation_revision_usage', 'evaluation_lifecycle_events',
    'evaluation_runs', 'evaluation_case_attempts',
    'evaluation_sample_attempts', 'evaluation_run_events',
    'evolution_evidence', 'evolution_proposals', 'evolution_candidates',
    'evolution_probes', 'data_outbox_events', 'data_consumer_records',
    'data_projection_records', 'data_consumer_checkpoints',
    'data_dead_letters', 'data_quarantine_records', 'jobs', 'job_attempts',
    'job_steps', 'object_records', 'vector_projection_states'
  ]
  LOOP
    EXECUTE format(
      'UPDATE %I SET workspace_id = %L WHERE workspace_id IS NULL',
      table_name,
      'ws_00000000000000000000000000000000'
    );
    EXECUTE format('ALTER TABLE %I ALTER COLUMN workspace_id SET NOT NULL', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS lyra_workspace_scope_guard ON %I', table_name);
    EXECUTE format(
      'CREATE TRIGGER lyra_workspace_scope_guard '
      'BEFORE INSERT OR UPDATE OF workspace_id ON %I '
      'FOR EACH ROW EXECUTE FUNCTION lyra_enforce_workspace_scope()',
      table_name
    );
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS lyra_workspace_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY lyra_workspace_isolation ON %I '
      'USING (lyra_system_bypass_enabled() OR workspace_id = lyra_current_workspace_id()) '
      'WITH CHECK (lyra_system_bypass_enabled() OR workspace_id = lyra_current_workspace_id())',
      table_name
    );
  END LOOP;
END;
$$;

COMMIT;
