import type { QueryResultRow } from 'pg';
import type { PostgresDatabase } from '../db/client';
import {
  parseTenantContext,
  type TenantContext,
  type TenantRole,
} from '../tenancy/context';

interface WorkerMemberRow extends QueryResultRow {
  user_id: string;
  role: TenantRole;
}

export class JobTenantResolutionError extends Error {
  readonly code = 'JOB_TENANT_UNAVAILABLE';

  constructor() {
    super('任务所属工作区没有可用的活跃成员。');
    this.name = 'JobTenantResolutionError';
  }
}

export interface JobTenantResolver {
  resolve(workspaceId: string, operationId: string): Promise<TenantContext>;
}

/**
 * Background work must enter the same tenant boundary as an HTTP request.
 * The resolver chooses a real, active workspace member instead of inventing a
 * service principal that would bypass membership checks or weaken RLS audit
 * context. Jobs remain platform initiated; the selected member only supplies
 * the workspace authority required by repository/RLS access.
 */
export class PostgresJobTenantResolver implements JobTenantResolver {
  constructor(private readonly database: PostgresDatabase) {}

  async resolve(workspaceId: string, operationId: string): Promise<TenantContext> {
    const result = await this.database.runAsSystem('jobs.tenant.resolve', () =>
      this.database.query<WorkerMemberRow>(`
        SELECT member.user_id, member.role
        FROM workspace_members member
        JOIN users account ON account.id = member.user_id
        JOIN workspaces workspace ON workspace.id = member.workspace_id
        WHERE member.workspace_id = $1
          AND member.status = 'active'
          AND account.status = 'active'
          AND workspace.status = 'active'
        ORDER BY CASE member.role
          WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'member' THEN 3 ELSE 4
        END, member.created_at, member.user_id
        LIMIT 1
      `, [workspaceId]));
    const row = result.rows[0];
    if (!row) throw new JobTenantResolutionError();
    return parseTenantContext({
      userId: row.user_id,
      workspaceId,
      role: row.role,
      requestId: `worker:${operationId}`,
    });
  }
}
