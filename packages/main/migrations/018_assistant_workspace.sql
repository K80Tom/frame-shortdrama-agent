-- AI 工作区：会话、消息与付费估价确认卡。
-- 设计来源：旧平台「全局 AI 工作区」侧栏的本地等价实现。
-- 铁律：模型只能提议付费操作，真正的提交必须走 submitQuote 的服务端状态机。

CREATE TABLE IF NOT EXISTS assistant_sessions (
  id TEXT PRIMARY KEY,
  context_key TEXT NOT NULL,
  context_json JSONB NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistant_sessions_context_idx
  ON assistant_sessions (context_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  thinking TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'complete',
  tool_name TEXT,
  payload_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS assistant_messages_session_idx
  ON assistant_messages (session_id, seq);

CREATE TABLE IF NOT EXISTS assistant_quotes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  request_json JSONB NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  estimate_cost_micros BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_run_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistant_quotes_session_idx
  ON assistant_quotes (session_id, created_at);
