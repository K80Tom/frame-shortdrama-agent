import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
import { parseTenantContext, type TenantContext } from './context';

export type DatabaseExecutionScope =
  | { kind: 'tenant'; tenant: TenantContext }
  | { kind: 'system'; reason: string };

const SYSTEM_REASON = /^[a-z][a-z0-9_.:-]{2,95}$/u;

/**
 * Carries database authority across one asynchronous operation. The scope is
 * intentionally separate from HTTP request objects so Workers can enter the
 * workspace from a claimed job before invoking existing repositories.
 */
export class TenantExecutionScope {
  private readonly storage = new AsyncLocalStorage<DatabaseExecutionScope>();

  current(): DatabaseExecutionScope | undefined { return this.storage.getStore(); }

  runWithTenant<T>(tenant: TenantContext, work: () => T): T {
    return this.storage.run({ kind: 'tenant', tenant: parseTenantContext(tenant) }, work);
  }

  runAsSystem<T>(reason: string, work: () => T): T {
    if (!SYSTEM_REASON.test(reason)) throw new Error('Invalid database system scope reason');
    const existing = this.current();
    if (existing?.kind === 'tenant') {
      throw new Error('Cannot elevate a tenant database scope to system authority');
    }
    return this.storage.run({ kind: 'system', reason }, work);
  }
}
export const tenantExecutionScope = new TenantExecutionScope();

/** Apply transaction-local PostgreSQL settings consumed by RLS policies. */
export async function applyDatabaseScope(client: Pick<PoolClient, 'query'>,
  scope: DatabaseExecutionScope | undefined): Promise<void> {
  if (scope?.kind === 'tenant') {
    await client.query(`
      SELECT set_config('lyra.workspace_id', $1, true),
             set_config('lyra.user_id', $2, true),
             set_config('lyra.request_id', $3, true),
             set_config('lyra.system_bypass', 'off', true)
    `, [scope.tenant.workspaceId, scope.tenant.userId, scope.tenant.requestId]);
    return;
  }
  await client.query(`
    SELECT set_config('lyra.workspace_id', '', true),
           set_config('lyra.user_id', '', true),
           set_config('lyra.request_id', '', true),
           set_config('lyra.system_bypass', $1, true)
  `, [scope?.kind === 'system' ? 'on' : 'off']);
}
