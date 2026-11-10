import {
  Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Put, Query,
} from '@nestjs/common';
import { MethodPackError } from '@lyra/shared';
import {
  LEGACY_WORKSPACE_ID,
  type TenantContext,
} from '../tenancy/context';
import { tenantExecutionScope } from '../tenancy/scope';
import { actorFromTenant, type MethodActor, type MethodPackService } from './service';

export const METHOD_PACK_SERVICE = Symbol('METHOD_PACK_SERVICE');

function localActor(): MethodActor {
  return {
    workspaceId: LEGACY_WORKSPACE_ID,
    userId: 'usr_local_method_admin',
    role: 'owner',
    requestId: 'method-local-request',
  };
}

/**
 * 只从认证 scope 取 workspace，绝不信任 URL 以外的请求体自报身份。
 * authMode=disabled 是显式的本地单工作区模式，映射到保留的 legacy workspace。
 */
function actorOf(workspaceId?: string): MethodActor {
  const scope = tenantExecutionScope.current();
  if (scope?.kind === 'tenant') {
    if (workspaceId && scope.tenant.workspaceId !== workspaceId) {
      throw new MethodPackError(403, 'workspace_forbidden', '不能操作其他工作区的方法包。');
    }
    return actorFromTenant(scope.tenant as TenantContext);
  }
  if (scope?.kind === 'system') {
    throw new MethodPackError(403, 'workspace_forbidden', '系统作用域不能调用方法包写接口。');
  }
  if (workspaceId && workspaceId !== LEGACY_WORKSPACE_ID) {
    throw new MethodPackError(401, 'workspace_forbidden', '当前请求没有工作区认证。');
  }
  return localActor();
}

function parseQuery(value: Record<string, unknown>) {
  const query: import('@lyra/shared').MethodPackListQuery = {};
  if (typeof value.q === 'string' && value.q.trim()) query.q = value.q.trim().slice(0, 120);
  if (typeof value.node === 'string' && value.node) {
    query.node = value.node as import('@lyra/shared').MethodPackNode;
  }
  if (typeof value.admissionStatus === 'string'
    && ['pending', 'approved', 'rejected', 'revoked'].includes(value.admissionStatus)) {
    query.admissionStatus = value.admissionStatus as import('@lyra/shared').MethodAdmissionStatus;
  }
  if (typeof value.license === 'string' && value.license.trim()) query.license = value.license.trim().slice(0, 64);
  if (typeof value.qualityStatus === 'string'
    && ['reference-only', 'unevaluated', 'evaluated'].includes(value.qualityStatus)) {
    query.qualityStatus = value.qualityStatus as import('@lyra/shared').MethodQualityStatus;
  }
  if (typeof value.adoptedByProjectId === 'string' && value.adoptedByProjectId.trim()) {
    query.adoptedByProjectId = value.adoptedByProjectId.trim().slice(0, 128);
  }
  return query;
}

@Controller('api')
export class MethodPacksController {
  constructor(@Inject(METHOD_PACK_SERVICE) private readonly methods: MethodPackService | null) {}

  private ready(): MethodPackService {
    if (!this.methods) {
      throw new MethodPackError(503, 'method_pack_service_unavailable', '方法包治理服务未就绪：请应用 050 迁移后重启后端。');
    }
    return this.methods;
  }

  @Get('workspaces/:workspaceId/method-packs')
  list(@Param('workspaceId') workspaceId: string, @Query() query: Record<string, unknown>) {
    const actor = actorOf(workspaceId);
    return this.ready().list(actor, workspaceId, parseQuery(query));
  }

  @Post('workspaces/:workspaceId/method-packs/import') @HttpCode(201)
  importPack(@Param('workspaceId') workspaceId: string, @Body() body: unknown,
    @Headers('x-shortdrama-call') clientRequestId?: string) {
    const actor = actorOf(workspaceId);
    return this.ready().import(actor, workspaceId, body, clientRequestId);
  }

  @Get('workspaces/:workspaceId/method-packs/:packId')
  get(@Param('workspaceId') workspaceId: string, @Param('packId') packId: string) {
    const actor = actorOf(workspaceId);
    return this.ready().get(actor, workspaceId, packId);
  }

  @Get('workspaces/:workspaceId/method-pack-versions/:versionId')
  version(@Param('workspaceId') workspaceId: string, @Param('versionId') versionId: string) {
    const actor = actorOf(workspaceId);
    return this.ready().versionForPreview(actor, workspaceId, versionId);
  }

  @Post('workspaces/:workspaceId/method-pack-versions/:versionId/admission') @HttpCode(200)
  admission(@Param('workspaceId') workspaceId: string, @Param('versionId') versionId: string,
    @Body() body: unknown, @Headers('x-shortdrama-call') clientRequestId?: string) {
    const actor = actorOf(workspaceId);
    return this.ready().decideAdmission(actor, workspaceId, versionId, body, clientRequestId);
  }

  @Get('projects/:projectId/method-profiles')
  listProfiles(@Param('projectId') projectId: string) {
    const actor = actorOf();
    return this.ready().listProfiles(actor, actor.workspaceId, projectId);
  }

  @Post('projects/:projectId/method-profiles') @HttpCode(201)
  createProfile(@Param('projectId') projectId: string, @Body() body: unknown,
    @Headers('x-shortdrama-call') clientRequestId?: string) {
    const actor = actorOf();
    return this.ready().createProfile(actor, actor.workspaceId, projectId, body, clientRequestId);
  }

  @Get('projects/:projectId/method-profiles/:revisionId')
  getProfile(@Param('projectId') projectId: string, @Param('revisionId') revisionId: string) {
    const actor = actorOf();
    return this.ready().getProfile(actor, actor.workspaceId, projectId, revisionId);
  }

  @Put('projects/:projectId/method-profiles/:revisionId/bindings') @HttpCode(200)
  updateBindings(@Param('projectId') projectId: string, @Param('revisionId') revisionId: string,
    @Body() body: unknown) {
    const actor = actorOf();
    return this.ready().updateBindings(actor, actor.workspaceId, projectId, revisionId, body);
  }

  @Post('projects/:projectId/method-profiles/:revisionId/validate') @HttpCode(200)
  validate(@Param('projectId') projectId: string, @Param('revisionId') revisionId: string) {
    const actor = actorOf();
    return this.ready().validate(actor, actor.workspaceId, projectId, revisionId);
  }

  @Get('projects/:projectId/method-profiles/:revisionId/preview')
  preview(@Param('projectId') projectId: string, @Param('revisionId') revisionId: string) {
    const actor = actorOf();
    return this.ready().preview(actor, actor.workspaceId, projectId, revisionId);
  }

  @Post('projects/:projectId/method-profiles/:revisionId/adopt') @HttpCode(200)
  adopt(@Param('projectId') projectId: string, @Param('revisionId') revisionId: string,
    @Body() body: unknown) {
    const actor = actorOf();
    return this.ready().adopt(actor, actor.workspaceId, projectId, revisionId, body);
  }

  @Post('projects/:projectId/method-profiles/:revisionId/archive') @HttpCode(200)
  archive(@Param('projectId') projectId: string, @Param('revisionId') revisionId: string) {
    const actor = actorOf();
    return this.ready().archive(actor, actor.workspaceId, projectId, revisionId);
  }
}
