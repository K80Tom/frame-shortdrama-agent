-- Human proofreading creates an immutable child candidate; existing snapshots
-- and checks stay intact. Run explicitly with db:migrate, never on app startup.
ALTER TABLE plan_revisions DROP CONSTRAINT plan_revisions_created_by_check;
ALTER TABLE plan_revisions DROP CONSTRAINT plan_revisions_reason_check;
ALTER TABLE plan_revisions DROP CONSTRAINT plan_revisions_parent_revision_id_check;

ALTER TABLE plan_revisions ADD CONSTRAINT plan_revisions_origin_check CHECK (
  (created_by = 'agent' AND reason = 'extract' AND parent_revision_id IS NULL)
  OR (created_by = 'user' AND reason = 'manualEdit' AND parent_revision_id IS NOT NULL AND attempt_id IS NULL)
);

-- Timestamps and random IDs cannot reliably order two saves in one millisecond.
-- Preserve the prior deterministic display order when backfilling old rows.
CREATE SEQUENCE plan_revisions_revision_order_seq;
ALTER TABLE plan_revisions ADD COLUMN revision_order BIGINT;
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS ordinal FROM plan_revisions
)
UPDATE plan_revisions p SET revision_order = ordered.ordinal FROM ordered WHERE ordered.id = p.id;
SELECT setval('plan_revisions_revision_order_seq',
  COALESCE((SELECT MAX(revision_order) FROM plan_revisions), 0) + 1, false);
ALTER TABLE plan_revisions ALTER COLUMN revision_order SET DEFAULT nextval('plan_revisions_revision_order_seq');
ALTER TABLE plan_revisions ALTER COLUMN revision_order SET NOT NULL;
ALTER SEQUENCE plan_revisions_revision_order_seq OWNED BY plan_revisions.revision_order;
CREATE UNIQUE INDEX plan_revisions_revision_order_idx ON plan_revisions (revision_order);
CREATE INDEX plan_revisions_project_script_order_idx ON plan_revisions (project_id, script_version_id, revision_order DESC);
CREATE UNIQUE INDEX plan_revisions_single_entity_edit_child_idx ON plan_revisions (parent_revision_id)
  WHERE reason = 'manualEdit';
