BEGIN;

-- #182 结构化剧本：分集/场次/五类元素成为正式数据，rawText 改为由结构派生。
-- 保持 script_versions 不可变语义：每次保存仍产生新版本，structure_json 随版本快照。
ALTER TABLE script_versions
  ADD COLUMN IF NOT EXISTS structure_json jsonb NULL;

ALTER TABLE script_versions
  DROP CONSTRAINT IF EXISTS script_versions_structure_object_check;

ALTER TABLE script_versions
  ADD CONSTRAINT script_versions_structure_object_check
  CHECK (structure_json IS NULL OR jsonb_typeof(structure_json) = 'object');

COMMENT ON COLUMN script_versions.structure_json IS
  '结构化剧本 snapshot（script-structure/1）：episodes → scenes → dialogues(1..5)；NULL 表示旧版本尚未迁移。';

COMMIT;
