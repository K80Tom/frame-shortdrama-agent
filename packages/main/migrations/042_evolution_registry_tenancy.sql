BEGIN;

-- 025/030 isolated evidence/candidates/probes, but left the mutable policy
-- registry and its audit stream global. Keep existing rows in the reserved
-- legacy workspace; never copy a policy/audit history to unrelated tenants.
-- ADD COLUMN constant defaults preserve immutable audit rows without UPDATE.
ALTER TABLE evolution_registry ADD COLUMN workspace_id text NOT NULL
  DEFAULT 'ws_00000000000000000000000000000000'
  REFERENCES workspaces(id) ON DELETE RESTRICT;
ALTER TABLE evolution_registry_events ADD COLUMN workspace_id text NOT NULL
  DEFAULT 'ws_00000000000000000000000000000000'
  REFERENCES workspaces(id) ON DELETE RESTRICT;
ALTER TABLE evolution_registry ALTER COLUMN workspace_id DROP DEFAULT;
ALTER TABLE evolution_registry_events ALTER COLUMN workspace_id DROP DEFAULT;

ALTER TABLE evolution_registry DROP CONSTRAINT evolution_registry_pkey;
ALTER TABLE evolution_registry ADD PRIMARY KEY (workspace_id, domain);
ALTER TABLE evolution_registry_events DROP CONSTRAINT evolution_registry_events_domain_revision_key;
ALTER TABLE evolution_registry_events ADD UNIQUE (workspace_id, domain, revision);
CREATE INDEX evolution_registry_events_workspace_created_idx
  ON evolution_registry_events(workspace_id, created_at, id);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['evolution_registry', 'evolution_registry_events']
  LOOP
    EXECUTE format('CREATE TRIGGER lyra_workspace_scope_guard '
      'BEFORE INSERT OR UPDATE OF workspace_id ON %I '
      'FOR EACH ROW EXECUTE FUNCTION lyra_enforce_workspace_scope()', table_name);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY lyra_workspace_isolation ON %I '
      'USING (lyra_system_bypass_enabled() OR workspace_id = lyra_current_workspace_id()) '
      'WITH CHECK (lyra_system_bypass_enabled() OR workspace_id = lyra_current_workspace_id())', table_name);
  END LOOP;
END;
$$;

COMMIT;
