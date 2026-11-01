BEGIN;

-- 用户自己导入的方法包：元数据与正文一起存库，不写仓库目录、不污染 git。
-- 启用状态仍由 prompt_pack_states 单独承载（无行 = 未启用）。
CREATE TABLE prompt_pack_imports (
  id text PRIMARY KEY,
  name text NOT NULL,
  summary text NOT NULL DEFAULT '',
  stages text[] NOT NULL,
  license text NOT NULL DEFAULT '自建（未声明许可）',
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(id) BETWEEN 1 AND 80),
  CHECK (char_length(name) BETWEEN 1 AND 80),
  CHECK (cardinality(stages) > 0),
  CHECK (octet_length(content) <= 524288)
);

COMMIT;
