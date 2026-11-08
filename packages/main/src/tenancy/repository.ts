import type { QueryResultRow } from 'pg';
import type { PostgresDatabase } from '../db/client';
import {
  TenantContextError,
  parseRequestId,
  parseTenantContext,
  parseUserId,
  parseWorkspaceId,
  type TenantContext,
  type TenantRole,
} from './context';

export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  role: TenantRole;
}

interface MembershipRow extends QueryResultRow {
  workspace_id: string;
  slug: string;
  name: string;
  workspace_status: WorkspaceSummary['status'];
  role: TenantRole;
}

export interface WorkspaceRepository {
  listForUser(userId: string): Promise<WorkspaceSummary[]>;
  resolveContext(userId: string, workspaceId: string, requestId: string): Promise<TenantContext>;
}

/**
 * PostgreSQL is the final membership authority. A missing workspace and a
 * workspace owned by another user deliberately produce the same error.
 */
export class PostgresWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly database: PostgresDatabase) {}

  private async memberships(userId: string, workspaceId?: string): Promise<MembershipRow[]> {
    const parsedUserId = parseUserId(userId);
    const values: unknown[] = [parsedUserId];
    const workspacePredicate = workspaceId === undefined ? '' : ' AND workspace.id = $2';
    if (workspaceId !== undefined) values.push(parseWorkspaceId(workspaceId));
    const result = await this.database.query<MembershipRow>(`
      SELECT workspace.id AS workspace_id, workspace.slug, workspace.name,
             workspace.status AS workspace_status, member.role
      FROM users user_account
      JOIN workspace_members member ON member.user_id = user_account.id
      JOIN workspaces workspace ON workspace.id = member.workspace_id
      WHERE user_account.id = $1
        AND user_account.kind <> 'migration'
        AND user_account.status = 'active'
        AND member.status = 'active'
        AND workspace.status = 'active'
        ${workspacePredicate}
      ORDER BY workspace.name, workspace.id
    `, values);
    return result.rows;
  }

  async listForUser(userId: string): Promise<WorkspaceSummary[]> {
    const rows = await this.memberships(userId);
    return rows.map(row => ({
      id: row.workspace_id,
      slug: row.slug,
      name: row.name,
      status: row.workspace_status,
      role: row.role,
    }));
  }

  async resolveContext(userId: string, workspaceId: string, requestId: string): Promise<TenantContext> {
    const parsedRequestId = parseRequestId(requestId);
    const rows = await this.memberships(userId, workspaceId);
    const row = rows[0];
    if (!row) {
      throw new TenantContextError(403, 'TENANT_ACCESS_DENIED', '工作区不存在或当前用户无权访问。');
    }
    return parseTenantContext({
      userId,
      workspaceId: row.workspace_id,
      role: row.role,
      requestId: parsedRequestId,
    });
  }
}
