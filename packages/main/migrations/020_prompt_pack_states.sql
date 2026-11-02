BEGIN;

-- 方法包启用状态：默认不写行 = 未启用（渐进式披露，全关起步）。
CREATE TABLE prompt_pack_states (
  pack_id text PRIMARY KEY,
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (length(pack_id) BETWEEN 1 AND 128)
);

COMMIT;
