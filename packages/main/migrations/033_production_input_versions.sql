BEGIN;

-- Extend the existing project fact, rather than introducing a parallel project
-- state store. Legacy script/plan/storyboard adoption paths also increment it.
ALTER TABLE projects ADD COLUMN input_revision bigint NOT NULL DEFAULT 0 CHECK (input_revision >= 0);
ALTER TABLE projects ADD CONSTRAINT projects_workspace_identity UNIQUE (workspace_id, id);
CREATE FUNCTION lyra_project_input_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN NEW.input_revision := 0;
  ELSIF ROW(NEW.current_script_version_id, NEW.active_plan_revision_id, NEW.active_storyboard_revision_id)
    IS DISTINCT FROM ROW(OLD.current_script_version_id, OLD.active_plan_revision_id, OLD.active_storyboard_revision_id) THEN
    NEW.input_revision := OLD.input_revision + 1;
  ELSE NEW.input_revision := OLD.input_revision;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER lyra_project_input_revision_guard BEFORE INSERT OR UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION lyra_project_input_revision_guard();

CREATE TABLE production_episodes (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 128 AND id ~ '^[A-Za-z][A-Za-z0-9_.:-]*$' AND id !~ E'[\r\n]'),
  project_id text NOT NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  created_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE shot_spec_versions (
  workspace_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  episode_id text NOT NULL,
  shot_id text NOT NULL,
  content_digest char(64) NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  spec_json jsonb NOT NULL CHECK (jsonb_typeof(spec_json) = 'object'),
  created_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, project_id, episode_id, shot_id, id),
  FOREIGN KEY (workspace_id, project_id, episode_id) REFERENCES production_episodes(workspace_id, project_id, id) ON DELETE RESTRICT,
  CHECK (spec_json ?& ARRAY['schemaVersion','workspaceId','projectId','episodeId','shotId','revisionId','contentDigest']),
  CHECK ((spec_json->>'schemaVersion') IS NOT DISTINCT FROM 'lyra-shot-spec/2'),
  CHECK ((spec_json->>'workspaceId') IS NOT DISTINCT FROM workspace_id AND (spec_json->>'projectId') IS NOT DISTINCT FROM project_id
    AND (spec_json->>'episodeId') IS NOT DISTINCT FROM episode_id AND (spec_json->>'shotId') IS NOT DISTINCT FROM shot_id
    AND (spec_json->>'revisionId') IS NOT DISTINCT FROM id AND (spec_json->>'contentDigest') IS NOT DISTINCT FROM content_digest)
);
CREATE INDEX shot_spec_versions_history ON shot_spec_versions(workspace_id, project_id, episode_id, shot_id, created_at, id);

CREATE TABLE shot_spec_heads (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  episode_id text NOT NULL,
  shot_id text NOT NULL,
  current_version_id text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  adopted_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  adopted_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  PRIMARY KEY (workspace_id, project_id, episode_id, shot_id),
  FOREIGN KEY (workspace_id, project_id, episode_id, shot_id, current_version_id)
    REFERENCES shot_spec_versions(workspace_id, project_id, episode_id, shot_id, id) ON DELETE RESTRICT
);

CREATE FUNCTION lyra_reject_shot_spec_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='LYRA_SHOT_SPEC_VERSION_IMMUTABLE'; END;
$$;
CREATE TRIGGER shot_spec_versions_immutable BEFORE UPDATE OR DELETE ON shot_spec_versions
  FOR EACH ROW EXECUTE FUNCTION lyra_reject_shot_spec_version_mutation();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['production_episodes','shot_spec_versions','shot_spec_heads'] LOOP
    EXECUTE format('CREATE TRIGGER lyra_workspace_scope_guard BEFORE INSERT OR UPDATE OF workspace_id ON %I '
      'FOR EACH ROW EXECUTE FUNCTION lyra_enforce_workspace_scope()', table_name);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY lyra_workspace_isolation ON %I '
      'USING (lyra_system_bypass_enabled() OR workspace_id=lyra_current_workspace_id()) '
      'WITH CHECK (lyra_system_bypass_enabled() OR workspace_id=lyra_current_workspace_id())', table_name);
  END LOOP;
END;
$$;

COMMIT;
