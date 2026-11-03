BEGIN;

-- 022 评测目录：稳定身份 + 不可变 Revision。
-- 内容不可变由 Trigger 兜底，Service 只负责业务顺序；任何直接 SQL 也不能
-- 修改冻结、被引用或已废弃的 revision 内容。

CREATE TABLE evaluation_datasets (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('novel_breakdown', 'asset_retrieval', 'shot_review')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (id, kind),
  CHECK (id ~ '^evalds_[a-f0-9]{32}$')
);

CREATE TABLE evaluation_dataset_revisions (
  id text PRIMARY KEY,
  dataset_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('novel_breakdown', 'asset_retrieval', 'shot_review')),
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('draft', 'frozen', 'deprecated')),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 2000),
  content_summary text NOT NULL DEFAULT '' CHECK (char_length(content_summary) <= 1000),
  slices text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  authorization_json jsonb NOT NULL CHECK (jsonb_typeof(authorization_json) = 'object'),
  sensitivity text NOT NULL CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
  provenance_json jsonb NOT NULL CHECK (jsonb_typeof(provenance_json) = 'object'),
  content_digest char(64) NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  digest char(64) NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  case_count integer NOT NULL DEFAULT 0 CHECK (case_count BETWEEN 0 AND 200),
  created_at timestamptz NOT NULL,
  frozen_at timestamptz NULL,
  deprecated_at timestamptz NULL,
  CONSTRAINT evaluation_dataset_revision_identity UNIQUE (dataset_id, revision),
  CONSTRAINT evaluation_dataset_revision_kind FOREIGN KEY (dataset_id, kind)
    REFERENCES evaluation_datasets (id, kind),
  CHECK (id ~ '^evaldsrev_[a-f0-9]{32}$'),
  CHECK (status <> 'draft' OR (frozen_at IS NULL AND deprecated_at IS NULL)),
  CHECK (status <> 'frozen' OR (frozen_at IS NOT NULL AND deprecated_at IS NULL)),
  CHECK (status <> 'deprecated' OR deprecated_at IS NOT NULL)
);
CREATE INDEX evaluation_dataset_revisions_dataset_idx
  ON evaluation_dataset_revisions (dataset_id, revision DESC);

CREATE TABLE evaluation_cases (
  revision_id text NOT NULL REFERENCES evaluation_dataset_revisions (id) ON DELETE RESTRICT,
  case_id text NOT NULL CHECK (case_id ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  kind text NOT NULL CHECK (kind IN ('novel_breakdown', 'asset_retrieval', 'shot_review')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  intent text NOT NULL CHECK (char_length(intent) <= 500),
  input_json jsonb NOT NULL CHECK (jsonb_typeof(input_json) = 'object'),
  expectation_json jsonb NOT NULL CHECK (jsonb_typeof(expectation_json) = 'object'),
  source_json jsonb NOT NULL CHECK (jsonb_typeof(source_json) = 'object'),
  version_refs_json jsonb NOT NULL CHECK (jsonb_typeof(version_refs_json) = 'array'),
  content_summary text NOT NULL CHECK (char_length(content_summary) <= 500),
  authorization_json jsonb NOT NULL CHECK (jsonb_typeof(authorization_json) = 'object'),
  sensitivity text NOT NULL CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
  tags text[] NOT NULL DEFAULT '{}',
  slices text[] NOT NULL DEFAULT '{}',
  input_digest char(64) NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  content_digest char(64) NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (revision_id, case_id),
  CONSTRAINT evaluation_case_input_unique UNIQUE (revision_id, input_digest),
  CONSTRAINT evaluation_case_content_unique UNIQUE (revision_id, content_digest)
);
CREATE INDEX evaluation_cases_revision_ordinal_idx ON evaluation_cases (revision_id, ordinal);

CREATE TABLE evaluation_rubrics (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('novel_breakdown', 'asset_retrieval', 'shot_review')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (id, kind),
  CHECK (id ~ '^evalrub_[a-f0-9]{32}$')
);

CREATE TABLE evaluation_rubric_revisions (
  id text PRIMARY KEY,
  rubric_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('novel_breakdown', 'asset_retrieval', 'shot_review')),
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('draft', 'frozen', 'deprecated')),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 2000),
  summary text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 1000),
  missing_result_policy jsonb NOT NULL CHECK (jsonb_typeof(missing_result_policy) = 'object'),
  content_digest char(64) NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  digest char(64) NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  dimension_count integer NOT NULL DEFAULT 0 CHECK (dimension_count BETWEEN 0 AND 8),
  created_at timestamptz NOT NULL,
  frozen_at timestamptz NULL,
  deprecated_at timestamptz NULL,
  CONSTRAINT evaluation_rubric_revision_identity UNIQUE (rubric_id, revision),
  CONSTRAINT evaluation_rubric_revision_kind FOREIGN KEY (rubric_id, kind)
    REFERENCES evaluation_rubrics (id, kind),
  CHECK (id ~ '^evalrubrev_[a-f0-9]{32}$'),
  CHECK (missing_result_policy ? 'uncertain' AND missing_result_policy ? 'skipped'
    AND missing_result_policy ? 'evaluator_error'),
  CHECK (status <> 'draft' OR (frozen_at IS NULL AND deprecated_at IS NULL)),
  CHECK (status <> 'frozen' OR (frozen_at IS NOT NULL AND deprecated_at IS NULL)),
  CHECK (status <> 'deprecated' OR deprecated_at IS NOT NULL)
);
CREATE INDEX evaluation_rubric_revisions_rubric_idx
  ON evaluation_rubric_revisions (rubric_id, revision DESC);

CREATE TABLE evaluation_rubric_dimensions (
  revision_id text NOT NULL REFERENCES evaluation_rubric_revisions (id) ON DELETE RESTRICT,
  dimension_key text NOT NULL CHECK (dimension_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  description text NOT NULL CHECK (char_length(description) <= 800),
  scale_json jsonb NOT NULL CHECK (jsonb_typeof(scale_json) = 'object'),
  thresholds_json jsonb NOT NULL CHECK (jsonb_typeof(thresholds_json) = 'object'),
  evidence_json jsonb NOT NULL CHECK (jsonb_typeof(evidence_json) = 'object'),
  PRIMARY KEY (revision_id, dimension_key)
);

CREATE TABLE evaluation_revision_usage (
  id text PRIMARY KEY,
  dataset_revision_id text NULL REFERENCES evaluation_dataset_revisions (id),
  rubric_revision_id text NULL REFERENCES evaluation_rubric_revisions (id),
  usage_kind text NOT NULL CHECK (usage_kind ~ '^[a-z][a-z0-9_]{1,31}$'),
  usage_ref text NOT NULL CHECK (char_length(usage_ref) BETWEEN 1 AND 200),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  created_at timestamptz NOT NULL,
  CHECK (id ~ '^evalusage_[a-f0-9]{32}$'),
  CHECK ((dataset_revision_id IS NULL) <> (rubric_revision_id IS NULL))
);
CREATE UNIQUE INDEX evaluation_usage_dataset_key
  ON evaluation_revision_usage (dataset_revision_id, usage_kind, usage_ref)
  WHERE dataset_revision_id IS NOT NULL;
CREATE UNIQUE INDEX evaluation_usage_rubric_key
  ON evaluation_revision_usage (rubric_revision_id, usage_kind, usage_ref)
  WHERE rubric_revision_id IS NOT NULL;

CREATE TABLE evaluation_lifecycle_events (
  id text PRIMARY KEY,
  target_kind text NOT NULL CHECK (target_kind IN ('dataset', 'rubric')),
  dataset_revision_id text NULL REFERENCES evaluation_dataset_revisions (id),
  rubric_revision_id text NULL REFERENCES evaluation_rubric_revisions (id),
  action text NOT NULL CHECK (action IN ('created', 'derived', 'frozen', 'deprecated')),
  actor text NOT NULL CHECK (actor IN ('user', 'import', 'system')),
  reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
  created_at timestamptz NOT NULL,
  CHECK (id ~ '^evallevent_[a-f0-9]{32}$'),
  CHECK ((dataset_revision_id IS NULL) <> (rubric_revision_id IS NULL)),
  CHECK (target_kind = 'dataset' AND dataset_revision_id IS NOT NULL
    OR target_kind = 'rubric' AND rubric_revision_id IS NOT NULL)
);
CREATE INDEX evaluation_lifecycle_events_target_idx
  ON evaluation_lifecycle_events (target_kind, created_at DESC);

/* ------------------------------------------------------------------------- */
/* 不可变守卫                                                                  */
/* ------------------------------------------------------------------------- */

CREATE FUNCTION evaluation_dataset_revision_guard() RETURNS trigger AS $$
DECLARE
  in_use boolean;
  content_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM evaluation_revision_usage WHERE dataset_revision_id = OLD.id
  ) INTO in_use;

  IF TG_OP = 'DELETE' THEN
    IF in_use THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_REFERENCED';
    END IF;
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_IMMUTABLE';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.id <> OLD.id OR NEW.dataset_id <> OLD.dataset_id OR NEW.kind <> OLD.kind
    OR NEW.revision <> OLD.revision THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_IMMUTABLE';
  END IF;

  content_changed := NEW.digest IS DISTINCT FROM OLD.digest
    OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
    OR NEW.note IS DISTINCT FROM OLD.note
    OR NEW.content_summary IS DISTINCT FROM OLD.content_summary
    OR NEW.slices IS DISTINCT FROM OLD.slices
    OR NEW.tags IS DISTINCT FROM OLD.tags
    OR NEW.authorization_json IS DISTINCT FROM OLD.authorization_json
    OR NEW.sensitivity IS DISTINCT FROM OLD.sensitivity
    OR NEW.provenance_json IS DISTINCT FROM OLD.provenance_json
    OR NEW.case_count IS DISTINCT FROM OLD.case_count;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'draft' AND NEW.status IN ('frozen', 'deprecated'))
      OR (OLD.status = 'frozen' AND NEW.status = 'deprecated')) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_STATUS_INVALID';
    END IF;
    IF content_changed THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_IMMUTABLE';
    END IF;
  ELSIF content_changed THEN
    IF in_use THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_REFERENCED';
    END IF;
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_IMMUTABLE';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evaluation_dataset_revision_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON evaluation_dataset_revisions
  FOR EACH ROW EXECUTE FUNCTION evaluation_dataset_revision_guard();

CREATE FUNCTION evaluation_case_guard() RETURNS trigger AS $$
DECLARE
  revision_status text;
  revision_id_value text;
  in_use boolean;
BEGIN
  revision_id_value := COALESCE(NEW.revision_id, OLD.revision_id);
  SELECT status INTO revision_status FROM evaluation_dataset_revisions WHERE id = revision_id_value;
  SELECT EXISTS (
    SELECT 1 FROM evaluation_revision_usage WHERE dataset_revision_id = revision_id_value
  ) INTO in_use;
  IF in_use THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_REFERENCED';
  END IF;
  IF revision_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_IMMUTABLE';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.revision_id <> OLD.revision_id OR NEW.case_id <> OLD.case_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_IMMUTABLE';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evaluation_case_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON evaluation_cases
  FOR EACH ROW EXECUTE FUNCTION evaluation_case_guard();

CREATE FUNCTION evaluation_rubric_revision_guard() RETURNS trigger AS $$
DECLARE
  in_use boolean;
  content_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM evaluation_revision_usage WHERE rubric_revision_id = OLD.id
  ) INTO in_use;

  IF TG_OP = 'DELETE' THEN
    IF in_use THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_REFERENCED';
    END IF;
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_IMMUTABLE';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.id <> OLD.id OR NEW.rubric_id <> OLD.rubric_id OR NEW.kind <> OLD.kind
    OR NEW.revision <> OLD.revision THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_IMMUTABLE';
  END IF;

  content_changed := NEW.digest IS DISTINCT FROM OLD.digest
    OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
    OR NEW.note IS DISTINCT FROM OLD.note
    OR NEW.summary IS DISTINCT FROM OLD.summary
    OR NEW.missing_result_policy IS DISTINCT FROM OLD.missing_result_policy
    OR NEW.dimension_count IS DISTINCT FROM OLD.dimension_count;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'draft' AND NEW.status IN ('frozen', 'deprecated'))
      OR (OLD.status = 'frozen' AND NEW.status = 'deprecated')) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_STATUS_INVALID';
    END IF;
    IF content_changed THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_IMMUTABLE';
    END IF;
  ELSIF content_changed THEN
    IF in_use THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_REFERENCED';
    END IF;
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_IMMUTABLE';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evaluation_rubric_revision_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON evaluation_rubric_revisions
  FOR EACH ROW EXECUTE FUNCTION evaluation_rubric_revision_guard();

CREATE FUNCTION evaluation_rubric_dimension_guard() RETURNS trigger AS $$
DECLARE
  revision_status text;
  revision_id_value text;
  in_use boolean;
BEGIN
  revision_id_value := COALESCE(NEW.revision_id, OLD.revision_id);
  SELECT status INTO revision_status FROM evaluation_rubric_revisions WHERE id = revision_id_value;
  SELECT EXISTS (
    SELECT 1 FROM evaluation_revision_usage WHERE rubric_revision_id = revision_id_value
  ) INTO in_use;
  IF in_use THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_REFERENCED';
  END IF;
  IF revision_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_IMMUTABLE';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.revision_id <> OLD.revision_id OR NEW.dimension_key <> OLD.dimension_key) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_IMMUTABLE';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evaluation_rubric_dimension_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON evaluation_rubric_dimensions
  FOR EACH ROW EXECUTE FUNCTION evaluation_rubric_dimension_guard();

CREATE FUNCTION evaluation_usage_guard() RETURNS trigger AS $$
DECLARE
  revision_status text;
BEGIN
  IF NEW.dataset_revision_id IS NOT NULL THEN
    SELECT status INTO revision_status FROM evaluation_dataset_revisions WHERE id = NEW.dataset_revision_id;
  ELSE
    SELECT status INTO revision_status FROM evaluation_rubric_revisions WHERE id = NEW.rubric_revision_id;
  END IF;
  IF revision_status IS DISTINCT FROM 'frozen' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_REVISION_NOT_BINDABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evaluation_usage_guard_trigger
  BEFORE INSERT ON evaluation_revision_usage
  FOR EACH ROW EXECUTE FUNCTION evaluation_usage_guard();

CREATE FUNCTION evaluation_append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'EVALUATION_HISTORY_APPEND_ONLY';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evaluation_usage_append_only
  BEFORE UPDATE OR DELETE ON evaluation_revision_usage
  FOR EACH ROW EXECUTE FUNCTION evaluation_append_only_guard();

CREATE TRIGGER evaluation_lifecycle_append_only
  BEFORE UPDATE OR DELETE ON evaluation_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION evaluation_append_only_guard();

COMMIT;
