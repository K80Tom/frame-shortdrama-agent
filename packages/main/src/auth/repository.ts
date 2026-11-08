import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { PostgresDatabase } from '../db/client';
import type { AuthWorkspace } from './contracts';
import { LEGACY_WORKSPACE_ID } from '../tenancy/context';

export interface CredentialRecord {
  userId: string;
  displayName: string;
  passwordSalt: string;
  passwordHash: string;
  passwordAlgorithm: 'scrypt-v1';
}
export interface SessionRecord {
  id: string;
  userId: string;
  displayName: string;
  currentWorkspaceId: string;
  csrfHash: string;
  expiresAt: string;
  revokedAt: string | null;
}
export interface CreateSessionRecord {
  id: string;
  tokenHash: string;
  csrfHash: string;
  userId: string;
  currentWorkspaceId: string;
  createdAt: string;
  expiresAt: string;
}
interface CredentialRow extends QueryResultRow {
  user_id: string;
  display_name: string;
  password_salt: string;
  password_hash: string;
  password_algorithm: 'scrypt-v1';
}

interface SessionRow extends QueryResultRow {
  id: string;
  user_id: string;
  display_name: string;
  current_workspace_id: string;
  csrf_hash: string;
  expires_at: unknown;
  revoked_at: unknown;
}

interface WorkspaceRow extends QueryResultRow {
  id: string;
  slug: string;
  name: string;
  role: AuthWorkspace['role'];
}

function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }

export interface AuthRepository {
  findCredential(email: string): Promise<CredentialRecord | null>;
  listWorkspaces(userId: string): Promise<AuthWorkspace[]>;
  createSession(input: CreateSessionRecord): Promise<void>;
  findSession(tokenHash: string, now: string): Promise<SessionRecord | null>;
  touchSession(sessionId: string, currentWorkspaceId: string, now: string): Promise<void>;
  revokeSession(sessionId: string, now: string): Promise<void>;
}

/** Authentication tables are read before a tenant context exists; membership is the authority for entering one. */
export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async findCredential(email: string): Promise<CredentialRecord | null> {
    const result = await this.database.query<CredentialRow>(`
      SELECT credential.user_id, account.display_name, credential.password_salt,
             credential.password_hash, credential.password_algorithm
      FROM user_credentials credential
      JOIN users account ON account.id = credential.user_id
      WHERE credential.email = $1
        AND account.kind = 'human'
        AND account.status = 'active'
      LIMIT 1
    `, [email]);
    const row = result.rows[0];
    return row ? {
      userId: row.user_id,
      displayName: row.display_name,
      passwordSalt: row.password_salt,
      passwordHash: row.password_hash,
      passwordAlgorithm: row.password_algorithm,
    } : null;
  }

  async listWorkspaces(userId: string): Promise<AuthWorkspace[]> {
    const result = await this.database.query<WorkspaceRow>(`
      SELECT workspace.id, workspace.slug, workspace.name, member.role
      FROM workspace_members member
      JOIN workspaces workspace ON workspace.id = member.workspace_id
      WHERE member.user_id = $1
        AND member.status = 'active'
        AND workspace.status = 'active'
      ORDER BY workspace.name, workspace.id
    `, [userId]);
    return result.rows.map(row => ({ id: row.id, slug: row.slug, name: row.name, role: row.role }));
  }

  async createSession(input: CreateSessionRecord): Promise<void> {
    await this.database.transaction(async client => {
      await client.query('DELETE FROM auth_sessions WHERE expires_at <= $1::timestamptz OR revoked_at IS NOT NULL',
        [input.createdAt]);
      await client.query(`
        INSERT INTO auth_sessions
          (id, token_hash, csrf_hash, user_id, current_workspace_id,
           created_at, expires_at, last_seen_at, revoked_at)
        VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $6::timestamptz, NULL)
      `, [input.id, input.tokenHash, input.csrfHash, input.userId, input.currentWorkspaceId,
        input.createdAt, input.expiresAt]);
    });
  }

  async findSession(tokenHash: string, now: string): Promise<SessionRecord | null> {
    const result = await this.database.query<SessionRow>(`
      SELECT session.id, session.user_id, account.display_name,
             session.current_workspace_id, session.csrf_hash,
             session.expires_at, session.revoked_at
      FROM auth_sessions session
      JOIN users account ON account.id = session.user_id
      WHERE session.token_hash = $1
        AND session.revoked_at IS NULL
        AND session.expires_at > $2::timestamptz
        AND account.kind = 'human'
        AND account.status = 'active'
      LIMIT 1
    `, [tokenHash, now]);
    const row = result.rows[0];
    return row ? {
      id: row.id,
      userId: row.user_id,
      displayName: row.display_name,
      currentWorkspaceId: row.current_workspace_id,
      csrfHash: row.csrf_hash,
      expiresAt: iso(row.expires_at),
      revokedAt: row.revoked_at === null ? null : iso(row.revoked_at),
    } : null;
  }

  async touchSession(sessionId: string, currentWorkspaceId: string, now: string): Promise<void> {
    await this.database.query(`
      UPDATE auth_sessions
      SET current_workspace_id = $2, last_seen_at = $3::timestamptz
      WHERE id = $1 AND revoked_at IS NULL AND expires_at > $3::timestamptz
    `, [sessionId, currentWorkspaceId, now]);
  }

  async revokeSession(sessionId: string, now: string): Promise<void> {
    await this.database.query(`
      UPDATE auth_sessions
      SET revoked_at = COALESCE(revoked_at, $2::timestamptz), last_seen_at = $2::timestamptz
      WHERE id = $1
    `, [sessionId, now]);
  }
}

export interface BootstrapAdminInput {
  userId: string;
  workspaceId: string;
  email: string;
  displayName: string;
  workspaceName: string;
  workspaceSlug: string;
  passwordSalt: string;
  passwordHash: string;
  now: string;
}

export async function insertBootstrapAdmin(database: PostgresDatabase, input: BootstrapAdminInput): Promise<void> {
  await database.transaction(async (client: PoolClient) => {
    const existing = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM workspaces
      WHERE id <> $1 AND status = 'active'
    `, [LEGACY_WORKSPACE_ID]);
    if (existing.rows[0]?.count !== '0') {
      throw new Error('The first administrator has already been bootstrapped');
    }
    await client.query(`
      INSERT INTO users (id, subject, display_name, kind, status, created_at, updated_at)
      VALUES ($1, $2, $3, 'human', 'active', $4::timestamptz, $4::timestamptz)
    `, [input.userId, `email-sha256:${createHash('sha256').update(input.email).digest('hex')}`,
      input.displayName, input.now]);
    const adopted = await client.query<{ id: string }>(`
      UPDATE workspaces
      SET slug = $2, name = $3, status = 'active', created_by_user_id = $4,
          updated_at = $5::timestamptz
      WHERE id = $1 AND status = 'suspended'
      RETURNING id
    `, [input.workspaceId, input.workspaceSlug, input.workspaceName, input.userId, input.now]);
    if (adopted.rowCount !== 1) throw new Error('Reserved workspace is not available for bootstrap');
    await client.query(`
      INSERT INTO workspace_members
        (workspace_id, user_id, role, status, created_at, updated_at)
      VALUES ($1, $2, 'owner', 'active', $3::timestamptz, $3::timestamptz)
    `, [input.workspaceId, input.userId, input.now]);
    await client.query(`
      INSERT INTO user_credentials
        (user_id, email, password_salt, password_hash, password_algorithm, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'scrypt-v1', $5::timestamptz, $5::timestamptz)
    `, [input.userId, input.email, input.passwordSalt, input.passwordHash, input.now]);
  });
}
