BEGIN;

-- 阶段一单集解析：commandId 作为客户端幂等键。同一 project + commandId 只发起一次模型调用，
-- 重复请求回放历史成功记录；历史行 command_id 为 NULL，部分唯一索引排除空值以兼容旧数据。
ALTER TABLE script_parse_attempts
  ADD COLUMN IF NOT EXISTS command_id TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS script_parse_attempts_command_id_uniq
  ON script_parse_attempts (project_id, command_id)
  WHERE command_id IS NOT NULL;

COMMENT ON COLUMN script_parse_attempts.command_id IS
  '客户端生成的幂等命令键；重复 commandId 直接回放历史结果，不再次调用模型。';

COMMIT;
