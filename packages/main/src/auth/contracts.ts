import { parseWorkspaceId, type TenantContext, type TenantRole } from '../tenancy/context';

export const SESSION_COOKIE_NAME = 'lyra_session';
export const CSRF_COOKIE_NAME = 'lyra_csrf';

export interface AuthWorkspace {
  id: string;
  slug: string;
  name: string;
  role: TenantRole;
}
export interface AuthSessionView {
  authenticated: true;
  user: { id: string; displayName: string };
  workspaces: AuthWorkspace[];
  currentWorkspaceId: string;
}
export interface AuthenticatedRequest {
  sessionId: string;
  csrfToken: string;
  tenant: TenantContext;
  view: AuthSessionView;
}
export interface LoginInput {
  email: string;
  password: string;
}
export interface WorkspaceRegistrationInput {
  displayName: string;
  email: string;
  password: string;
  workspaceName: string;
}

export class AuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

function object(value: unknown, subject = '登录'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthError(400, 'AUTH_INPUT_INVALID', `${subject}请求格式无效。`);
  }
  return value as Record<string, unknown>;
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') throw new AuthError(400, 'AUTH_INPUT_INVALID', '邮箱格式无效。');
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+$/u.test(email)
    || /[\u0000-\u001f\u007f]/u.test(email)) {
    throw new AuthError(400, 'AUTH_INPUT_INVALID', '邮箱格式无效。');
  }
  return email;
}

export function validatePassword(value: unknown, minimumLength = 1): string {
  if (typeof value !== 'string' || value.length < minimumLength || value.length > 1024
    || /[\u0000\r\n]/u.test(value)) {
    throw new AuthError(400, 'AUTH_INPUT_INVALID', '密码格式无效。');
  }
  return value;
}

export function parseLoginInput(value: unknown): LoginInput {
  const input = object(value);
  if (Object.keys(input).some(key => !['email', 'password'].includes(key))) {
    throw new AuthError(400, 'AUTH_INPUT_INVALID', '登录请求包含未知字段。');
  }
  return { email: normalizeEmail(input.email), password: validatePassword(input.password) };
}

function boundedName(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new AuthError(400, 'AUTH_INPUT_INVALID', `${label}格式无效。`);
  }
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 120 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new AuthError(400, 'AUTH_INPUT_INVALID', `${label}必须为 1–120 个有效字符。`);
  }
  return normalized;
}

export function parseWorkspaceRegistrationInput(value: unknown): WorkspaceRegistrationInput {
  const input = object(value, '注册');
  const allowed = new Set(['displayName', 'email', 'password', 'workspaceName']);
  if (Object.keys(input).some(key => !allowed.has(key))) {
    throw new AuthError(400, 'AUTH_INPUT_INVALID', '注册请求包含未知字段。');
  }
  return {
    displayName: boundedName(input.displayName, '昵称'),
    email: normalizeEmail(input.email),
    password: validatePassword(input.password, 12),
    workspaceName: boundedName(input.workspaceName, 'Workspace 名称'),
  };
}

export function requestedWorkspace(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) throw new AuthError(400, 'AUTH_WORKSPACE_INVALID', 'Workspace 标识格式无效。');
  try { return parseWorkspaceId(value); }
  catch { throw new AuthError(400, 'AUTH_WORKSPACE_INVALID', 'Workspace 标识格式无效。'); }
}
