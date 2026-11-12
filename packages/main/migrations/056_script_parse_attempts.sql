-- AI 剧本解析：记录每次“整段原文 -> 分集/场次/元素/人物”的模型调用。
-- 解析结果在用户确认保存前只是 preview，不改写 script_versions；attempt 仅用于审计与费用核对。
CREATE TABLE script_parse_attempts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  output_json JSONB NULL CHECK (output_json IS NULL OR jsonb_typeof(output_json) = 'object'),
  provider_request_id TEXT NULL,
  usage_json JSONB NULL CHECK (usage_json IS NULL OR jsonb_typeof(usage_json) = 'object'),
  error_code TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NULL
);

CREATE INDEX script_parse_attempts_project_created_idx
  ON script_parse_attempts (project_id, created_at DESC);

COMMENT ON TABLE script_parse_attempts IS 'AI script structure parse attempts; preview output is not a script version until user saves it.';
