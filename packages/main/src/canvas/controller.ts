import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { canvasError } from '@lyra/shared';
import { LEGACY_MIGRATION_USER_ID, LEGACY_WORKSPACE_ID } from '../tenancy/context';
import type { TenantContext } from '../tenancy/context';
import type { CanvasActor, CanvasService } from './service';

export const CANVAS_SERVICE = Symbol('CANVAS_SERVICE');

type AuthedRequest = FastifyRequest & { auth?: { tenant: TenantContext } };

function actorOf(request: AuthedRequest): CanvasActor {
  const tenant = request.auth?.tenant;
  if (tenant) {
    return { workspaceId: tenant.workspaceId, userId: tenant.userId, role: tenant.role, requestId: tenant.requestId };
  }
  // legacy（单机、未启用会话认证）模式没有租户头。使用保留 workspace，
  // 生产模式必须由会话认证注入真实租户。
  return {
    workspaceId: LEGACY_WORKSPACE_ID,
    userId: LEGACY_MIGRATION_USER_ID,
    role: 'owner',
    requestId: 'req_canvas_legacy',
  };
}

@Controller()
export class CanvasController {
  constructor(@Inject(CANVAS_SERVICE) private readonly canvas: CanvasService | null) {}

  private ready(): CanvasService {
    if (!this.canvas) {
      throw canvasError('canvas_persistence_unavailable',
        '生产画布尚未就绪：请应用 032 迁移并重启后端。');
    }
    return this.canvas;
  }

  @Get('api/projects/:projectId/canvases')
  list(@Param('projectId') projectId: string, @Req() request: AuthedRequest) {
    return this.ready().list(projectId, actorOf(request));
  }

  @Post('api/projects/:projectId/canvases')
  @HttpCode(201)
  create(@Param('projectId') projectId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    return this.ready().create(projectId, body, actorOf(request));
  }

  @Get('api/canvases/:canvasId')
  get(@Param('canvasId') canvasId: string, @Req() request: AuthedRequest) {
    return this.ready().get(canvasId, actorOf(request));
  }

  @Get('api/canvases/:canvasId/revisions/:revisionId')
  revision(
    @Param('canvasId') canvasId: string, @Param('revisionId') revisionId: string,
    @Req() request: AuthedRequest,
  ) {
    return this.ready().revision(canvasId, revisionId, actorOf(request));
  }

  @Post('api/canvases/:canvasId/revisions')
  @HttpCode(201)
  fork(@Param('canvasId') canvasId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    return this.ready().forkRevision(canvasId, body, actorOf(request));
  }

  @Post('api/canvases/:canvasId/revisions/:revisionId/commands')
  @HttpCode(200)
  commands(
    @Param('canvasId') canvasId: string, @Param('revisionId') revisionId: string,
    @Body() body: unknown, @Req() request: AuthedRequest,
  ) {
    const payload = body && typeof body === 'object' && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>) } : (body as Record<string, unknown>);
    // 路径里的 revisionId 是调用方看到的“基础版本”；批量命令还必须携带 expectedRevision。
    if (payload && typeof payload === 'object' && payload.expectedRevision === undefined && /^\d+$/u.test(revisionId)) {
      payload.expectedRevision = Number(revisionId);
    }
    return this.ready().commands(canvasId, payload, actorOf(request));
  }

  @Post('api/canvases/:canvasId/revisions/:revisionId/validate')
  @HttpCode(200)
  validate(
    @Param('canvasId') canvasId: string, @Param('revisionId') revisionId: string,
    @Req() request: AuthedRequest,
  ) {
    return this.ready().validate(canvasId, revisionId, actorOf(request));
  }

  @Get('api/canvases/:canvasId/revisions/:revisionId/compare')
  compare(
    @Param('canvasId') canvasId: string, @Param('revisionId') revisionId: string,
    @Query('to') to: string | undefined, @Req() request: AuthedRequest,
  ) {
    if (!to || !/^\d+$/u.test(to)) {
      throw canvasError('canvas_command_invalid', '比较需要提供目标版本 ?to=。');
    }
    return this.ready().compare(canvasId, revisionId, to, actorOf(request));
  }

  @Post('api/canvases/:canvasId/revisions/:revisionId/adopt')
  @HttpCode(200)
  adopt(
    @Param('canvasId') canvasId: string, @Param('revisionId') revisionId: string,
    @Body() body: unknown, @Req() request: AuthedRequest,
  ) {
    return this.ready().adopt(canvasId, body, actorOf(request));
  }

  @Post('api/canvases/:canvasId/revisions/:revisionId/quote')
  @HttpCode(201)
  quote(
    @Param('canvasId') canvasId: string, @Param('revisionId') revisionId: string,
    @Body() body: unknown, @Req() request: AuthedRequest,
  ) {
    return this.ready().quote(canvasId, revisionId, body, actorOf(request));
  }

  /**
   * 正式付费入口（红线要求）：确认估价卡并创建运行。与 production-runs 等价，
   * 但 UI 必须走这条路径，确保“确认卡 → budget/confirm”在审计里可追踪。
   */
  @Post('api/canvases/:canvasId/revisions/:revisionId/budget/confirm')
  @HttpCode(202)
  confirmBudget(
    @Param('canvasId') canvasId: string, @Param('revisionId') revisionId: string,
    @Body() body: unknown, @Req() request: AuthedRequest,
  ) {
    return this.ready().createRun(canvasId, revisionId, body, actorOf(request));
  }

  @Post('api/canvases/:canvasId/revisions/:revisionId/production-runs')
  @HttpCode(202)
  createRun(
    @Param('canvasId') canvasId: string, @Param('revisionId') revisionId: string,
    @Body() body: unknown, @Req() request: AuthedRequest,
  ) {
    return this.ready().createRun(canvasId, revisionId, body, actorOf(request));
  }

  @Get('api/canvases/:canvasId/runtime-view')
  runtime(
    @Param('canvasId') canvasId: string,
    @Query('revision') revision: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Req() request: AuthedRequest,
  ) {
    if (!revision) throw canvasError('canvas_command_invalid', '运行覆盖需要提供 ?revision=。');
    return this.ready().runtimeView(canvasId, revision, cursor ?? null, actorOf(request));
  }

  @Get('api/canvases/:canvasId/events')
  events(@Param('canvasId') canvasId: string, @Req() request: AuthedRequest) {
    return this.ready().events(canvasId, actorOf(request));
  }
}
