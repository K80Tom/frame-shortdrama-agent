import { workspaceFetch, type WorkspaceDirectory } from './deployment';

export const authWorkspaceRoles = ['owner', 'admin', 'member', 'viewer'] as const;
export type AuthWorkspaceRole = typeof authWorkspaceRoles[number];
export type AuthWorkspace = { id: string; name: string; slug: string; role: AuthWorkspaceRole };
export type AuthSession = {
  authenticated: true;
  user: { id: string; displayName: string };
  workspaces: AuthWorkspace[];
  currentWorkspaceId: string;
};

export class AuthApiError extends Error {
  constructor(message: string, public readonly kind: 'unauthenticated' | 'not-configured' | 'unreachable' | 'invalid' | 'http',
    public readonly status = 0, public readonly code = '') {
    super(message);
    this.name = 'AuthApiError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value.trim() : '';
}

const identityPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

export function parseAuthSession(value: unknown): AuthSession {
  const source = record(value);
  const user = record(source?.user);
  if (!source || source.authenticated !== true || !user || !Array.isArray(source.workspaces)) {
    throw new AuthApiError('会话响应格式不完整。', 'invalid');
  }
  const userId = text(user.id, 128);
  const displayName = text(user.displayName, 160);
  const seen = new Set<string>();
  const workspaces = source.workspaces.flatMap(value => {
    const row = record(value);
    const id = text(row?.id, 128);
    const name = text(row?.name, 160);
    const slug = text(row?.slug, 128);
    const role = text(row?.role, 24) as AuthWorkspaceRole;
    if (!identityPattern.test(id) || !name || !slug || !authWorkspaceRoles.includes(role) || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name, slug, role }];
  });
  const currentWorkspaceId = text(source.currentWorkspaceId, 128);
  if (!identityPattern.test(userId) || !displayName || !workspaces.length
    || !workspaces.some(workspace => workspace.id === currentWorkspaceId)) {
    throw new AuthApiError('会话响应缺少有效的用户或 workspace。', 'invalid');
  }
  return { authenticated: true, user: { id: userId, displayName }, workspaces, currentWorkspaceId };
}

export function sessionWorkspaceDirectory(session: AuthSession): WorkspaceDirectory {
  return {
    items: session.workspaces.map(workspace => ({ ...workspace, legacy: false })),
    currentWorkspaceId: session.currentWorkspaceId,
    legacyMode: false,
  };
}

export function validateLoginInput(email: string, password: string): string | null {
  const normalized = email.trim();
  if (!normalized || normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) return '请输入有效的邮箱地址。';
  if (!password || password.length > 1024 || /[\u0000\r\n]/u.test(password)) return '请输入有效密码。';
  return null;
}

function errorFields(value: unknown): { code: string; message: string } {
  const source = record(value); const error = record(source?.error);
  return { code: text(error?.code, 80), message: text(error?.message, 300) };
}

async function authRequest(path: string, init: RequestInit, subject: string, signal?: AbortSignal,
  includeSelectedWorkspace = true): Promise<unknown> {
  let response: Response;
  try {
    const request = includeSelectedWorkspace ? workspaceFetch : fetch;
    response = await request(path, { credentials: 'same-origin', cache: 'no-store', ...init,
      signal: signal ?? init.signal });
  } catch (error) {
    if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new AuthApiError(`无法连接后端，${subject}尚未完成。`, 'unreachable');
  }
  const data: unknown = await response.json().catch(() => null);
  const fields = errorFields(data);
  if (fields.code === 'AUTH_NOT_CONFIGURED') {
    throw new AuthApiError('当前后端未启用登录，工作台以 Legacy 兼容模式运行。', 'not-configured', response.status, fields.code);
  }
  if (response.status === 401) {
    throw new AuthApiError(fields.message || '邮箱、密码或会话已失效。', 'unauthenticated', 401, fields.code);
  }
  if (!response.ok) {
    throw new AuthApiError(fields.message || `${subject}失败（${response.status}）。`, 'http', response.status, fields.code);
  }
  return data;
}

export async function fetchAuthSession(signal?: AbortSignal, includeSelectedWorkspace = true): Promise<AuthSession> {
  const value = await authRequest('/api/auth/session', { method: 'GET' }, '读取会话', signal,
    includeSelectedWorkspace);
  return parseAuthSession(value);
}

export async function loginWithPassword(email: string, password: string, signal?: AbortSignal): Promise<AuthSession> {
  const validation = validateLoginInput(email, password);
  if (validation) throw new AuthApiError(validation, 'invalid');
  const value = await authRequest('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shortdrama-Call': '1' },
    body: JSON.stringify({ email: email.trim(), password }),
  }, '登录', signal, false);
  return parseAuthSession(value);
}

export async function logoutAuthSession(signal?: AbortSignal): Promise<void> {
  await authRequest('/api/auth/logout', {
    method: 'POST', headers: { 'X-Shortdrama-Call': '1' },
  }, '退出', signal);
}
