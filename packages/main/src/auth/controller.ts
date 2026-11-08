import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AuthError,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  parseLoginInput,
  type AuthenticatedRequest,
} from './contracts';
import type { AuthService, IssuedSession } from './service';

export const AUTH_SERVICE = Symbol('AUTH_SERVICE');

export interface AuthCookieOptions {
  secure: boolean;
  domain?: string;
  sessionTtlSeconds: number;
}
type RequestWithAuth = FastifyRequest & { auth?: AuthenticatedRequest };

function requireService(service: AuthService | null): AuthService {
  if (!service) throw new AuthError(503, 'AUTH_NOT_CONFIGURED', '当前后端未启用登录。');
  return service;
}
export function requireRequestAuth(request: FastifyRequest): AuthenticatedRequest {
  const auth = (request as RequestWithAuth).auth;
  if (!auth) throw new AuthError(401, 'AUTH_REQUIRED', '请先登录。');
  return auth;
}
function cookie(name: string, value: string, options: AuthCookieOptions & { httpOnly: boolean; maxAge: number }): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${options.maxAge}`,
    'SameSite=Strict',
  ];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.domain) parts.push(`Domain=${options.domain}`);
  return parts.join('; ');
}

export function setSessionCookies(reply: FastifyReply, issued: IssuedSession, options: AuthCookieOptions): void {
  reply.header('Set-Cookie', [
    cookie(SESSION_COOKIE_NAME, issued.sessionToken,
      { ...options, httpOnly: true, maxAge: options.sessionTtlSeconds }),
    cookie(CSRF_COOKIE_NAME, issued.csrfToken,
      { ...options, httpOnly: false, maxAge: options.sessionTtlSeconds }),
  ]);
  reply.header('Cache-Control', 'no-store');
}

export function clearSessionCookies(reply: FastifyReply, options: AuthCookieOptions): void {
  reply.header('Set-Cookie', [
    cookie(SESSION_COOKIE_NAME, '', { ...options, httpOnly: true, maxAge: 0 }),
    cookie(CSRF_COOKIE_NAME, '', { ...options, httpOnly: false, maxAge: 0 }),
  ]);
  reply.header('Cache-Control', 'no-store');
}

@Controller('api/auth')
export class AuthController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly auth: AuthService | null,
    @Inject('AUTH_COOKIE_OPTIONS') private readonly cookies: AuthCookieOptions,
  ) {}

  @Get('session')
  session(@Req() request: FastifyRequest) {
    requireService(this.auth);
    return requireRequestAuth(request).view;
  }

  @Post('login') @HttpCode(200)
  async login(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const issued = await requireService(this.auth).login(parseLoginInput(body));
    setSessionCookies(reply, issued, this.cookies);
    return issued.view;
  }

  @Post('logout') @HttpCode(200)
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const service = requireService(this.auth);
    await service.revoke(requireRequestAuth(request));
    clearSessionCookies(reply, this.cookies);
    return { authenticated: false };
  }
}

@Controller('api')
export class WorkspacesController {
  constructor(@Inject(AUTH_SERVICE) private readonly auth: AuthService | null) {}

  @Get('workspaces')
  list(@Req() request: FastifyRequest) {
    if (!this.auth) {
      return {
        items: [{ id: 'legacy', name: 'Legacy workspace', legacy: true }],
        currentWorkspaceId: 'legacy',
        legacyMode: true,
      };
    }
    const session = requireRequestAuth(request).view;
    return {
      items: session.workspaces.map(workspace => ({ ...workspace, legacy: false })),
      currentWorkspaceId: session.currentWorkspaceId,
      legacyMode: false,
    };
  }
}
