import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { parseTenantContext } from '../tenancy/context';
import {
  AuthError,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  type AuthSessionView,
  type AuthenticatedRequest,
  type LoginInput,
} from './contracts';
import type { AuthRepository, CredentialRecord } from './repository';

const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const DUMMY_SALT = '00000000000000000000000000000000';
const DUMMY_HASH = '0'.repeat(128);

export interface IssuedSession {
  sessionToken: string;
  csrfToken: string;
  expiresAt: string;
  view: AuthSessionView;
}
export interface AuthServiceOptions {
  sessionTtlSeconds: number;
  now?: () => Date;
}
function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function equalHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/u.test(left) || !/^[a-f0-9]+$/u.test(right) || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
export async function passwordHash(password: string, salt: string): Promise<string> {
  const output = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
  return output.toString('hex');
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header || header.length > 16_384) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const raw = part.slice(separator + 1).trim();
    try { return decodeURIComponent(raw); } catch { return null; }
  }
  return null;
}

function sessionView(userId: string, displayName: string, workspaces: Awaited<ReturnType<AuthRepository['listWorkspaces']>>,
  currentWorkspaceId: string): AuthSessionView {
  return { authenticated: true, user: { id: userId, displayName }, workspaces, currentWorkspaceId };
}

export class AuthService {
  private readonly now: () => Date;
  constructor(private readonly repository: AuthRepository, private readonly options: AuthServiceOptions) {
    if (!Number.isInteger(options.sessionTtlSeconds) || options.sessionTtlSeconds < 300
      || options.sessionTtlSeconds > 31 * 24 * 60 * 60) {
      throw new Error('Invalid sessionTtlSeconds');
    }
    this.now = options.now ?? (() => new Date());
  }

  private async verifyCredential(input: LoginInput): Promise<CredentialRecord | null> {
    const credential = await this.repository.findCredential(input.email);
    const actual = await passwordHash(input.password, credential?.passwordSalt ?? DUMMY_SALT);
    if (!credential || credential.passwordAlgorithm !== 'scrypt-v1'
      || !equalHex(actual, credential.passwordHash || DUMMY_HASH)) return null;
    return credential;
  }

  async login(input: LoginInput): Promise<IssuedSession> {
    const credential = await this.verifyCredential(input);
    if (!credential) throw new AuthError(401, 'AUTH_INVALID_CREDENTIALS', '邮箱或密码不正确。');
    const workspaces = await this.repository.listWorkspaces(credential.userId);
    if (!workspaces[0]) throw new AuthError(403, 'AUTH_NO_WORKSPACE', '账号尚未加入可用的 workspace。');
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.options.sessionTtlSeconds * 1_000).toISOString();
    const sessionToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const sessionId = `ses_${randomBytes(16).toString('hex')}`;
    await this.repository.createSession({
      id: sessionId,
      tokenHash: digest(sessionToken),
      csrfHash: digest(csrfToken),
      userId: credential.userId,
      currentWorkspaceId: workspaces[0].id,
      createdAt: now.toISOString(),
      expiresAt,
    });
    return {
      sessionToken,
      csrfToken,
      expiresAt,
      view: sessionView(credential.userId, credential.displayName, workspaces, workspaces[0].id),
    };
  }

  async authenticate(cookieHeader: string | undefined, requestedWorkspaceId: string | undefined,
    requestId: string): Promise<AuthenticatedRequest> {
    const sessionToken = readCookie(cookieHeader, SESSION_COOKIE_NAME);
    const csrfToken = readCookie(cookieHeader, CSRF_COOKIE_NAME);
    if (!sessionToken || !csrfToken || !TOKEN.test(sessionToken) || !TOKEN.test(csrfToken)) {
      throw new AuthError(401, 'AUTH_REQUIRED', '请先登录。');
    }
    const now = this.now().toISOString();
    const session = await this.repository.findSession(digest(sessionToken), now);
    if (!session || !equalHex(digest(csrfToken), session.csrfHash)) {
      throw new AuthError(401, 'AUTH_SESSION_INVALID', '会话已失效，请重新登录。');
    }
    const workspaces = await this.repository.listWorkspaces(session.userId);
    const currentStillAllowed = workspaces.some(item => item.id === session.currentWorkspaceId);
    const selected = requestedWorkspaceId
      ?? (currentStillAllowed ? session.currentWorkspaceId : workspaces[0]?.id);
    const workspace = workspaces.find(item => item.id === selected);
    // Do not reveal whether a workspace exists when the caller lacks membership.
    if (!workspace) {
      if (requestedWorkspaceId === undefined && workspaces.length === 0) {
        throw new AuthError(403, 'AUTH_NO_WORKSPACE', '账号尚未加入可用的 workspace。');
      }
      throw new AuthError(404, 'RESOURCE_NOT_FOUND', '资源不存在。');
    }
    await this.repository.touchSession(session.id, workspace.id, now);
    return {
      sessionId: session.id,
      csrfToken,
      tenant: parseTenantContext({ userId: session.userId, workspaceId: workspace.id, role: workspace.role, requestId }),
      view: sessionView(session.userId, session.displayName, workspaces, workspace.id),
    };
  }

  verifyCsrf(auth: AuthenticatedRequest, header: unknown): void {
    if (typeof header !== 'string' || !TOKEN.test(header)
      || !timingSafeEqual(Buffer.from(header, 'utf8'), Buffer.from(auth.csrfToken, 'utf8'))) {
      throw new AuthError(403, 'CSRF_TOKEN_INVALID', 'CSRF 校验失败，请刷新页面后重试。');
    }
  }

  revoke(auth: AuthenticatedRequest): Promise<void> {
    return this.repository.revokeSession(auth.sessionId, this.now().toISOString());
  }
}
