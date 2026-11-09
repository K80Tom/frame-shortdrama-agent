BEGIN;

-- Stage 1 password/session authentication. Password material is produced by
-- the explicit bootstrap command; migrations never create a known account.
CREATE TABLE user_credentials (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE CHECK (
    email = lower(email)
    AND char_length(email) BETWEEN 3 AND 254
    AND email ~ '^[^[:space:]@]+@[^[:space:]@]+$'
  ),
  password_salt char(32) NOT NULL CHECK (password_salt ~ '^[a-f0-9]{32}$'),
  password_hash char(128) NOT NULL CHECK (password_hash ~ '^[a-f0-9]{128}$'),
  password_algorithm text NOT NULL CHECK (password_algorithm = 'scrypt-v1'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE auth_sessions (
  id text PRIMARY KEY CHECK (id ~ '^ses_[a-f0-9]{32}$'),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  csrf_hash char(64) NOT NULL CHECK (csrf_hash ~ '^[a-f0-9]{64}$'),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  CONSTRAINT auth_session_membership
    FOREIGN KEY (current_workspace_id, user_id)
    REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at),
  CHECK (last_seen_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX auth_sessions_active_user_idx
  ON auth_sessions (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_expiry_idx
  ON auth_sessions (expires_at)
  WHERE revoked_at IS NULL;

COMMIT;
