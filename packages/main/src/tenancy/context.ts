export const LEGACY_MIGRATION_USER_ID = 'usr_00000000000000000000000000000000';
export const LEGACY_WORKSPACE_ID = 'ws_00000000000000000000000000000000';

export const TENANT_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type TenantRole = typeof TENANT_ROLES[number];

/**
 * Authenticated tenant identity passed explicitly through API, repositories,
 * jobs, events and derived stores. It intentionally contains no credentials.
 */
export interface TenantContext {
  userId: string;
  workspaceId: string;
  role: TenantRole;
  requestId: string;
}
export class TenantContextError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TenantContextError';
  }
}
const USER_ID = /^usr_[a-f0-9]{32}$/u;
const WORKSPACE_ID = /^ws_[a-f0-9]{32}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/u;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TenantContextError(400, 'TENANT_CONTEXT_INVALID', '租户上下文格式无效。');
  }
  return value as Record<string, unknown>;
}
export function parseUserId(value: unknown): string {
  if (typeof value !== 'string' || !USER_ID.test(value)) {
    throw new TenantContextError(400, 'TENANT_CONTEXT_INVALID', '用户标识格式无效。');
  }
  return value;
}

export function parseWorkspaceId(value: unknown): string {
  if (typeof value !== 'string' || !WORKSPACE_ID.test(value)) {
    throw new TenantContextError(400, 'TENANT_CONTEXT_INVALID', '工作区标识格式无效。');
  }
  return value;
}

export function parseRequestId(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) {
    throw new TenantContextError(400, 'TENANT_CONTEXT_INVALID', '请求标识格式无效。');
  }
  return value;
}

export function parseTenantRole(value: unknown): TenantRole {
  if (typeof value !== 'string' || !TENANT_ROLES.includes(value as TenantRole)) {
    throw new TenantContextError(400, 'TENANT_CONTEXT_INVALID', '工作区角色无效。');
  }
  return value as TenantRole;
}

/** Runtime paths never accept the disabled principal used for schema backfill. */
export function parseTenantContext(value: unknown): TenantContext {
  const input = record(value);
  const allowed = new Set(['userId', 'workspaceId', 'role', 'requestId']);
  if (Object.keys(input).some(key => !allowed.has(key))) {
    throw new TenantContextError(400, 'TENANT_CONTEXT_INVALID', '租户上下文包含未知字段。');
  }
  const context: TenantContext = {
    userId: parseUserId(input.userId),
    workspaceId: parseWorkspaceId(input.workspaceId),
    role: parseTenantRole(input.role),
    requestId: parseRequestId(input.requestId),
  };
  // The disabled migration principal can never authenticate. The first-admin
  // bootstrap explicitly adopts the reserved workspace so immutable pre-Stage
  // 1 rows keep their original tenant identity and become visible without a
  // checksum-breaking rewrite.
  if (context.userId === LEGACY_MIGRATION_USER_ID) {
    throw new TenantContextError(403, 'TENANT_ACCESS_DENIED', '历史迁移账号不能用于运行时访问。');
  }
  return Object.freeze(context);
}

export function tenantAggregateKey(context: Pick<TenantContext, 'workspaceId'>,
  aggregateType: string, aggregateId: string): string {
  return `${context.workspaceId}:${aggregateType}:${aggregateId}`;
}
