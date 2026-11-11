import { PlatformPreflightService } from './platform/preflight';
import { PlatformController, PLATFORM_PREFLIGHT } from './platform/controller';
import 'reflect-metadata';
import { Body, Catch, Controller, Get, HttpCode, HttpException, Inject, Injectable, Module, Param, Post, Query,
  type ArgumentsHost, type ExceptionFilter, type PipeTransform } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AppConfig } from './config';
import { ModelClient } from './models/client';
import { MAX_REQUEST_BYTES, AgentContractError, ModelError, parseCall } from '@lyra/shared';
import { configuredModel } from './models/registry';
import { configForRole, ModelConnections, parseModelRole, type ModelRole } from './models/connections';
import { ModelPresetService } from './models/presets/service';
import {
  parseAdoptPlan,
  parseCreateBreakdownRun,
  parseCreateProject,
  parseCreateScriptVersion,
  parseOpaqueId,
} from './breakdown/contracts';
import { BreakdownError } from './breakdown/errors';
import { parseCreateEntityEdits, parseCreateExtractFactsCandidate } from './breakdown/plan';
import type { StoredScriptVersion } from './breakdown/repository';
import type { ExtractFactsStageRunner } from './breakdown/execution';
import type { StoryboardService } from './breakdown/storyboard';
import { type BreakdownServicePort, UnavailableBreakdownService } from './breakdown/service';
import { NovelController, NOVEL_SERVICE } from './novel/controller';
import { NovelError } from '@lyra/shared';
import type { NovelService } from './novel/service';
import { AssetController, ASSET_SERVICE } from './assets/controller';
import { AssetError } from '@lyra/shared';
import type { AssetService } from './assets/service';
import { DesktopAssetController, DESKTOP_ASSET_SERVICE } from './desktop-assets/controller';
import type { DesktopAssetService } from './desktop-assets/service';
import { VIDEO_AUTOMATION_SERVICE, VideoAutomationController } from './video-automation/controller';
import { VideoAutomationError } from './video-automation/contracts';
import type { VideoAutomationService } from './video-automation/service';
import { PRODUCTION_SERVICE, ProductionController } from './production/controller';
import { ProductionError, ObjectVersionContractError } from '@lyra/shared';
import { OBJECT_VERSIONS, ObjectVersionController, type ObjectVersionApi } from './production-media/object-version-controller';
import type { ProductionService } from './production/service';
import {
  PRODUCTION_MEDIA_OBJECT_SERVICE,
  PRODUCTION_MEDIA_STORE,
  ProductionMediaController,
} from './production-media/controller';
import { ProductionMediaError } from './production-media/contracts';
import type { ProductionMediaStore } from './production-media/store';
import type { ProductionMediaObjectService } from './production-media/object-worker';
import { ASSISTANT_SERVICE, AssistantController } from './assistant/controller';
import { AssistantError } from '@lyra/agent';
import type { AssistantService, AgentRuntime, ToolKernel } from '@lyra/agent';
import { CANVAS_SERVICE, CanvasController } from './canvas/controller';
import { MCP_MANAGEMENT, TOOL_REGISTRY_VIEW, ToolRegistryController } from './tool-registry/controller';
import type { McpManagementService } from './mcp-management/service';
import type { ToolRegistryViewService } from './tool-registry/service';
import { CanvasError } from '@lyra/shared';
import type { CanvasService } from './canvas/service';
import { ASSET_EVOLUTION_SERVICE, EvolutionController } from './evolution/controller';
import type { AssetEvolutionService } from './evolution/service';
import { EVOLUTION_GATE_SERVICE, EvolutionGateController } from './evolution/gate-controller';
import type { EvolutionGateService } from './evolution/gate-service';
import { EVALUATION_SERVICE, EvaluationController } from './evaluation/controller';
import { AssetRetrievalGovernanceError, EvaluationError, EvolutionGateError } from '@lyra/shared';
import type { EvaluationService } from './evaluation/service';
import {
  AssetRetrievalGovernanceController,
} from './asset-retrieval-governance/controller';
import {
  ASSET_RETRIEVAL_GOVERNANCE_SERVICE,
  type AssetRetrievalGovernanceService,
} from './asset-retrieval-governance/service';
import { PROMPT_PACK_SERVICE, PromptPacksController } from './prompt-packs/controller';
import { methodReference } from './prompt-packs/runtime';
import { PromptPackError, type PromptPackService } from './prompt-packs/service';
import { METHOD_PACK_SERVICE, MethodPacksController } from './method-packs/controller';
import type { MethodPackService } from './method-packs/service';
import { SYSTEM_STATUS, SystemController } from './system/controller';
import { SystemStatusService } from './system/status';
import { OutboxTaskController, OUTBOX_TASK_SERVICE } from './production/outbox/controller';
import { OutboxTaskError } from './production/outbox/contracts';
import type { OutboxTaskService } from './production/outbox/service';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { AuthController, AUTH_SERVICE, WorkspacesController } from './auth/controller';
import { AuthError, requestedWorkspace, type AuthenticatedRequest } from './auth/contracts';
import type { AuthService } from './auth/service';
import { LEGACY_WORKSPACE_ID } from './tenancy/context';
import { tenantExecutionScope } from './tenancy/scope';
import {
  RateLimiterUnavailableError,
  rateLimitIdentity,
  type RequestRateLimiter,
} from './infrastructure/rate-limit';

const CONFIG = Symbol('APP_CONFIG');
const TRANSPORT = Symbol('MODEL_TRANSPORT');
const BREAKDOWN_SERVICE = Symbol('BREAKDOWN_SERVICE');
const STAGE_RUNNER = Symbol('STAGE_RUNNER');
const STORYBOARD_SERVICE = Symbol('STORYBOARD_SERVICE');
const AGENT_RUNTIME = Symbol('AGENT_RUNTIME');
const AGENT_TOOL_KERNEL = Symbol('AGENT_TOOL_KERNEL');

function requestPath(url: string): string {
  return url.split('?', 1)[0] ?? url;
}

function isModelConfigurationMutation(path: string): boolean {
  return path === '/api/model-profiles'
    || path === '/api/model-profiles/import-environment'
    || path.startsWith('/api/model-profiles/')
    || path.startsWith('/api/model-assignments/')
    || path.startsWith('/api/model-connections/');
}

function clientAddress(request: { headers: Record<string, unknown>; ip: string }): string {
  const forwarded = request.headers['x-forwarded-for'];
  // The edge overwrites X-Forwarded-For. Taking the last valid address also
  // resists a legacy proxy that appends to an untrusted client header.
  const candidate = typeof forwarded === 'string' ? forwarded.split(',').at(-1)?.trim() : undefined;
  if (candidate && isIP(candidate)) return candidate;
  return isIP(request.ip) ? request.ip : 'unknown';
}

export interface AppDependencies {
  platformPreflight?: PlatformPreflightService;
  /** Omit this in model-only tests or before PostgreSQL has been migrated. */
  breakdownService?: BreakdownServicePort;
  stageRunner?: ExtractFactsStageRunner;
  storyboardService?: StoryboardService;
  novelService?: NovelService;
  assetService?: AssetService;
  desktopAssetService?: DesktopAssetService;
  videoAutomationService?: VideoAutomationService;
  productionService?: ProductionService;
  productionMediaStore?: ProductionMediaStore;
  productionMediaObjectService?: ProductionMediaObjectService;
  objectVersions?: ObjectVersionApi;
  assistantService?: AssistantService;
  canvasService?: CanvasService;
  /** 041 迁移就绪后由 main 注入的持久化 Agent Runtime（纯逻辑实现留在 agent）。 */
  agentRuntime?: AgentRuntime;
  /** 版本化 Tool 的执行内核；真实 SQL/引用注入由 main 完成。 */
  agentToolKernel?: ToolKernel;
  /** `/api/tools` 只读视图：公开版本、权限、副作用与 Schema。 */
  toolRegistryView?: ToolRegistryViewService;
  /** `/api/mcp` 配置管理；只保存 Secret 引用，不保存明文密钥。 */
  mcpManagement?: McpManagementService;
  evolutionService?: AssetEvolutionService;
  /** 052 迁移就绪后注入的候选门禁闭环服务（#135）。 */
  evolutionGateService?: EvolutionGateService;
  evaluationService?: EvaluationService;
  /** 054 迁移就绪后的资产检索观测、数据集与策略载荷 Facade（#128）。 */
  assetRetrievalGovernanceService?: AssetRetrievalGovernanceService;
  promptPacksService?: PromptPackService;
  /** 050 迁移就绪后的方法包目录、准入、项目配置与运行冻结服务。 */
  methodPacksService?: MethodPackService;
  /** 基础设施异步 Outbox 服务；未迁移 037/038 或纯模型测试时省略。 */
  outboxTaskService?: OutboxTaskService;
  authService?: AuthService;
  systemStatus?: SystemStatusService;
  rateLimiter?: RequestRateLimiter;
  /** Registration must use the distributed Redis limiter, never the local/noop fallback. */
  registrationRateLimiter?: RequestRateLimiter;
  /** Lets main close the pg Pool when Nest/Fastify shuts down. */
  close?: () => Promise<void>;
}

@Injectable()
class ModelCallPipe implements PipeTransform {
  transform(value: unknown) { return parseCall(value); }
}

@Injectable()
class CreateProjectPipe implements PipeTransform {
  transform(value: unknown) { return parseCreateProject(value); }
}

@Injectable()
class CreateScriptVersionPipe implements PipeTransform {
  transform(value: unknown) { return parseCreateScriptVersion(value); }
}

@Injectable()
class CreateBreakdownRunPipe implements PipeTransform {
  transform(value: unknown) { return parseCreateBreakdownRun(value); }
}

@Injectable()
class CreateExtractFactsCandidatePipe implements PipeTransform {
  transform(value: unknown) { return parseCreateExtractFactsCandidate(value); }
}

@Injectable()
class CreateEntityEditsPipe implements PipeTransform {
  transform(value: unknown) { return parseCreateEntityEdits(value); }
}

@Injectable()
class AdoptPlanPipe implements PipeTransform {
  transform(value: unknown) { return parseAdoptPlan(value); }
}

@Injectable()
class ModelsService {
  private readonly clients = new WeakMap<AppConfig, ModelClient>();
  private readonly presets = new ModelPresetService();
  constructor(@Inject(CONFIG) private readonly config: AppConfig, @Inject(TRANSPORT) private readonly transport: typeof fetch) {}
  list(role: ModelRole = 'general') {
    if (role !== 'general' && role !== 'breakdown') throw new ModelError(400, 'MODEL_ROLE_NOT_TEXT', '媒体配置不进入文本调用通道。');
    const config = configForRole(this.config, role);
    const model = configuredModel(config.defaultModel, config.defaultModel);
    return { role, provider: config.provider, configured: Boolean((config.endpointUrl || config.baseUrl) && config.apiKey && config.defaultModel),
      defaultModel: config.defaultModel, connectionRevision: config.connectionRevision, streaming: false, automaticFallback: false,
      capabilitySource: 'user-configured-text-model', verificationNote: '配置完整不等于上游可用，模型能力和质量仍需单独验证。',
      models: model ? [{ ...model, textInput: true, imageGeneration: false, videoGeneration: false,
        effectiveDefaultReasoningEffort: config.reasoningEffort }] : [] };
  }
  connections() { return this.config.modelConnections!.list(); }
  presetCatalog(query: { kind?: string; modality?: string; providerId?: string }) { return this.presets.listPresets(query); }
  providerCatalog() { return this.presets.listProviders(); }
  update(role: ModelRole, input: unknown) { return this.config.modelConnections!.update(role, input); }
  async createProfile(input: unknown) {
    const profile = await this.config.modelConnections!.createProfile(input);
    return { ...this.connections(), profile };
  }
  async updateProfile(id: string, input: unknown) {
    const profile = await this.config.modelConnections!.updateProfile(id, input);
    return { ...this.connections(), profile };
  }
  async assign(role: ModelRole, input: unknown) {
    await this.config.modelConnections!.assign(role, input);
    return this.connections();
  }
  async importEnvironment(input: unknown) {
    const profile = await this.config.modelConnections!.importEnvironment(input);
    return { ...this.connections(), profile };
  }
  call(input: unknown) {
    const config = configForRole(this.config, 'general');
    let client = this.clients.get(config);
    if (!client) { client = new ModelClient(config, this.transport); this.clients.set(config, client); }
    return client.call(input);
  }
}

@Controller()
class ModelsController {
  constructor(private readonly models: ModelsService) {}
  @Get('healthz') health() { return { status: 'ok', scope: 'local-backend-only', modelAvailabilityChecked: false }; }
  @Get('api/models') list(@Query('role') role?: string) { return this.models.list(role === undefined ? 'general' : parseModelRole(role)); }
  @Get('api/model-connections') connections() { return this.models.connections(); }
  @Get('api/model-profiles') profiles() { return this.models.connections(); }
  @Get('api/provider-catalog') providerCatalog() { return this.models.providerCatalog(); }
  @Get('api/model-presets') presetCatalog(@Query('kind') kind?: string, @Query('modality') modality?: string,
    @Query('providerId') providerId?: string) {
    return this.models.presetCatalog({ kind, modality, providerId });
  }
  @Post('api/model-profiles') @HttpCode(200)
  createProfile(@Body() body: unknown) { return this.models.createProfile(body); }
  @Post('api/model-profiles/import-environment') @HttpCode(200)
  importEnvironment(@Body() body: unknown) { return this.models.importEnvironment(body); }
  @Post('api/model-profiles/:profileId') @HttpCode(200)
  updateProfile(@Param('profileId') id: string, @Body() body: unknown) { return this.models.updateProfile(id, body); }
  @Post('api/model-assignments/:role') @HttpCode(200)
  assign(@Param('role') role: string, @Body() body: unknown) { return this.models.assign(parseModelRole(role), body); }
  @Post('api/model-connections/:role') @HttpCode(200)
  update(@Param('role') role: string, @Body() body: unknown) { return this.models.update(parseModelRole(role), body); }
  @Post('api/model-calls') @HttpCode(200)
  call(@Body(new ModelCallPipe()) input: unknown) { return this.models.call(input); }
}

@Controller('api')
class ProjectsController {
  constructor(@Inject(BREAKDOWN_SERVICE) private readonly breakdown: BreakdownServicePort) {}

  @Get('projects')
  async listProjects() { return { items: await this.breakdown.listProjects() }; }

  @Get('projects/:projectId')
  getProject(@Param('projectId') projectId: string) {
    return this.breakdown.getProject(parseOpaqueId(projectId, 'projectId'));
  }

  @Post('projects')
  createProject(@Body(new CreateProjectPipe()) input: unknown) {
    return this.breakdown.createProject(input as ReturnType<typeof parseCreateProject>);
  }

  @Post('projects/:projectId/script-versions')
  async createScriptVersion(
    @Param('projectId') projectId: string,
    @Body(new CreateScriptVersionPipe()) input: unknown,
  ) {
    const script = await this.breakdown.createScriptVersion(
      parseOpaqueId(projectId, 'projectId'),
      input as ReturnType<typeof parseCreateScriptVersion>,
    );
    return scriptVersionResponse(script);
  }

  @Get('projects/:projectId/script-versions')
  async listScriptVersions(@Param('projectId') projectId: string) {
    const items = await this.breakdown.listScriptVersions(parseOpaqueId(projectId, 'projectId'));
    return { items };
  }

  @Get('projects/:projectId/script-versions/:scriptVersionId')
  getScriptVersion(@Param('projectId') projectId: string, @Param('scriptVersionId') scriptVersionId: string) {
    return this.breakdown.getScriptVersion(
      parseOpaqueId(projectId, 'projectId'), parseOpaqueId(scriptVersionId, 'scriptVersionId'));
  }

  @Post('projects/:projectId/adoptions')
  adoptPlan(@Param('projectId') projectId: string, @Body(new AdoptPlanPipe()) input: unknown) {
    return this.breakdown.adoptPlan(parseOpaqueId(projectId, 'projectId'),
      input as ReturnType<typeof parseAdoptPlan>);
  }

  @Get('projects/:projectId/plan-revisions')
  async listPlanRevisions(@Param('projectId') projectId: string) {
    return { items: await this.breakdown.listProjectPlanRevisions(parseOpaqueId(projectId, 'projectId')) };
  }

  @Post('projects/:projectId/breakdown-runs')
  createDraftRun(
    @Param('projectId') projectId: string,
    @Body(new CreateBreakdownRunPipe()) input: unknown,
  ) {
    return this.breakdown.createDraftRun(
      parseOpaqueId(projectId, 'projectId'),
      input as ReturnType<typeof parseCreateBreakdownRun>,
    );
  }

  @Get('projects/:projectId/breakdown-runs')
  async listRuns(@Param('projectId') projectId: string) {
    return { items: await this.breakdown.listRuns(parseOpaqueId(projectId, 'projectId')) };
  }
}

@Controller('api/breakdown-runs')
class BreakdownRunsController {
  constructor(@Inject(BREAKDOWN_SERVICE) private readonly breakdown: BreakdownServicePort,
    @Inject(STAGE_RUNNER) private readonly runner: ExtractFactsStageRunner | null,
    @Inject(PROMPT_PACK_SERVICE) private readonly packs: PromptPackService | null) {}

  @Get(':runId')
  getRun(@Param('runId') runId: string) {
    return this.breakdown.getRun(parseOpaqueId(runId, 'runId'));
  }

  @Post(':runId/execute')
  async execute(@Param('runId') runId: string, @Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || (body as Record<string, unknown>).allowPaid !== true) {
      throw new BreakdownError(400, 'PAID_CALL_NOT_AUTHORIZED', '执行前须明确传入 allowPaid: true。');
    }
    if (!this.runner) throw new BreakdownError(503, 'STAGE_RUNNER_UNAVAILABLE', '事实提取执行器尚未就绪。请先执行 npm run db:migrate（需要迁移 017）；未就绪时不会发起付费调用。');
    const id = parseOpaqueId(runId, 'runId');
    if (!this.packs) return this.runner.run(id);
    const draft = await this.breakdown.getRun(id);
    const project = await this.breakdown.getProject(draft.projectId);
    return this.runner.run(id, methodReference(await this.packs.freeze(project, 'breakdown'), 'breakdown'));
  }

  @Post(':runId/candidate-plan-revisions')
  createCandidate(
    @Param('runId') runId: string,
    @Body(new CreateExtractFactsCandidatePipe()) input: unknown,
  ) {
    return this.breakdown.createExtractFactsCandidate(
      parseOpaqueId(runId, 'runId'),
      input as ReturnType<typeof parseCreateExtractFactsCandidate>,
    );
  }

  @Get(':runId/candidate-plan-revisions')
  async listCandidates(@Param('runId') runId: string) {
    const items = await this.breakdown.listPlanRevisions(parseOpaqueId(runId, 'runId'));
    return { items };
  }
}

@Controller('api/plan-revisions')
class PlanRevisionsController {
  constructor(@Inject(BREAKDOWN_SERVICE) private readonly breakdown: BreakdownServicePort) {}

  @Get(':planRevisionId')
  getPlanRevision(@Param('planRevisionId') planRevisionId: string) {
    return this.breakdown.getPlanRevision(parseOpaqueId(planRevisionId, 'planRevisionId'));
  }

  @Post(':planRevisionId/checks')
  checkPlan(@Param('planRevisionId') planRevisionId: string) {
    return this.breakdown.checkPlan(parseOpaqueId(planRevisionId, 'planRevisionId'));
  }

  @Post(':planRevisionId/entity-edits')
  createEntityEditCandidate(
    @Param('planRevisionId') planRevisionId: string,
    @Body(new CreateEntityEditsPipe()) input: unknown,
  ) {
    return this.breakdown.createEntityEditCandidate(parseOpaqueId(planRevisionId, 'planRevisionId'),
      input as ReturnType<typeof parseCreateEntityEdits>);
  }

  @Get(':planRevisionId/checks')
  async listPlanChecks(@Param('planRevisionId') planRevisionId: string) {
    return { items: await this.breakdown.listPlanChecks(parseOpaqueId(planRevisionId, 'planRevisionId')) };
  }

  @Get(':planRevisionId/checks/:checkId/issues')
  async listPlanIssues(@Param('planRevisionId') planRevisionId: string, @Param('checkId') checkId: string) {
    const planId = parseOpaqueId(planRevisionId, 'planRevisionId');
    const check = (await this.breakdown.listPlanChecks(planId)).find(item => item.id === parseOpaqueId(checkId, 'checkId'));
    if (!check) throw new BreakdownError(404, 'PLAN_CHECK_NOT_FOUND', '校验记录不存在。');
    return { items: await this.breakdown.listPlanIssues(check.id) };
  }
}

@Controller('api')
class StoryboardController {
  constructor(@Inject(STORYBOARD_SERVICE) private readonly storyboards: StoryboardService | null,
    @Inject(PROMPT_PACK_SERVICE) private readonly packs: PromptPackService | null) {}
  private service() {
    if (!this.storyboards) throw new BreakdownError(503, 'STORYBOARD_UNAVAILABLE', '分镜服务尚未就绪。');
    return this.storyboards;
  }
  @Post('projects/:projectId/storyboards')
  async generate(@Param('projectId') projectId: string, @Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['allowPaid', 'expectedModelConnectionRevision'].includes(key)) || (body as Record<string, unknown>).allowPaid !== true) {
      throw new BreakdownError(400, 'PAID_CALL_NOT_AUTHORIZED', '生成分镜前须明确传入 allowPaid: true。');
    }
    const expected = (body as Record<string, unknown>).expectedModelConnectionRevision;
    if (expected !== undefined && typeof expected !== 'string') throw new ModelError(400, 'MODEL_SELECTION_INVALID', '模型选择版本格式不正确。');
    return this.service().generate(parseOpaqueId(projectId, 'projectId'), expected,
      methodReference(await this.packs?.freeze(undefined, 'storyboard'), 'storyboard'));
  }
  @Get('projects/:projectId/storyboards')
  async list(@Param('projectId') projectId: string) {
    return { items: await this.service().list(parseOpaqueId(projectId, 'projectId')) };
  }
  @Get('storyboards/:revisionId')
  get(@Param('revisionId') revisionId: string) {
    return this.service().get(parseOpaqueId(revisionId, 'revisionId'));
  }
  @Post('projects/:projectId/storyboards/:revisionId/adoptions')
  adopt(@Param('projectId') projectId: string, @Param('revisionId') revisionId: string, @Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || !('expectedActiveStoryboardRevisionId' in body)) {
      throw new BreakdownError(400, 'INVALID_STORYBOARD_ADOPTION', '分镜采用请求不完整。');
    }
    const expected = (body as Record<string, unknown>).expectedActiveStoryboardRevisionId;
    if (expected !== null && (typeof expected !== 'string' || !/^[a-z][a-z0-9_-]{2,127}$/.test(expected))) {
      throw new BreakdownError(400, 'INVALID_STORYBOARD_ADOPTION', '已采用分镜版本 ID 不合法。');
    }
    return this.service().adopt(parseOpaqueId(projectId, 'projectId'), parseOpaqueId(revisionId, 'revisionId'), expected);
  }
}

function scriptVersionResponse(script: StoredScriptVersion) {
  // SourceIndex is persisted and verified internally.  This creation response
  // returns only counts so a large script is not immediately echoed back.
  return {
    id: script.id,
    projectId: script.projectId,
    version: script.version,
    contentSha256: script.contentSha256,
    createdAt: script.createdAt,
    sourceIndex: {
      schemaVersion: script.sourceIndex.schemaVersion,
      unitCount: script.sourceIndex.units.length,
      spanCount: script.sourceIndex.spans.length,
      blockCount: script.sourceIndex.blocks.length,
    },
  };
}

@Catch()
class SafeErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse();
    if (error instanceof ModelError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message, ...error.details } });
    }
    if (error instanceof EvaluationError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message,
        details: error.details } });
    }
    if (error instanceof AssetRetrievalGovernanceError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message,
        source: error.source } });
    }
    if (error instanceof EvolutionGateError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message,
        source: 'governance' } });
    }
    if (error instanceof CanvasError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message,
        details: error.details } });
    }
    if (error instanceof OutboxTaskError) {
      const status = { OUTBOX_TASK_INVALID: 400, OUTBOX_TASK_NOT_FOUND: 404,
        OUTBOX_TASK_CONFLICT: 409, OUTBOX_HANDLER_MISSING: 500 }[error.code] ?? 500;
      return reply.status(status).send({ error: { code: error.code, message: error.message } });
    }
    // agent 包经由 install-links 可能持有另一份 @lyra/shared，instanceof 会跨副本失效；
    // 这里同时按错误名与稳定 code 识别，避免契约错误被吞成 500。
    const contractLike = error instanceof AgentContractError
      || (error instanceof Error && error.name === 'AgentContractError'
        && 'status' in error && 'code' in error);
    if (error instanceof BreakdownError || error instanceof NovelError || error instanceof AssetError
      || error instanceof VideoAutomationError || error instanceof ProductionError || error instanceof ProductionMediaError
      || error instanceof AssistantError || error instanceof PromptPackError || error instanceof AuthError
      || error instanceof ObjectVersionContractError
      || contractLike) {
      const status = (error as { status: number }).status;
      const code = (error as { code: string }).code;
      return reply.status(status).send({ error: { code, message: (error as Error).message } });
    }
    const status = error instanceof HttpException ? error.getStatus() :
      error && typeof error === 'object' && 'statusCode' in error && [400, 413, 415].includes(Number(error.statusCode)) ? Number(error.statusCode) : 500;
    // Never reflect raw provider bodies, headers, prompts or stack traces.
    return reply.status(status).send({ error: { code: status < 500 ? 'HTTP_REQUEST_ERROR' : 'INTERNAL_ERROR',
      message: status < 500 ? '请求格式、大小或路径不受支持。' : '本机服务内部错误。' } });
  }
}

export async function createApp(config: AppConfig, transport: typeof fetch = fetch, dependencies: AppDependencies = {}) {
  // In-memory only in explicitly injected/test apps. main.ts supplies the private file-backed service.
  config = config.modelConnections ? config : { ...config, modelConnections: new ModelConnections(config) };
  const breakdownService = dependencies.breakdownService ?? new UnavailableBreakdownService();
  const systemStatus = dependencies.systemStatus ?? new SystemStatusService(config.runtimeRole);
  if (config.authMode === 'session' && !dependencies.authService) {
    throw new Error('Session authentication requires a migrated AuthService');
  }
  @Module({ controllers: [PlatformController, SystemController, AuthController, WorkspacesController,
    ModelsController, ProjectsController, BreakdownRunsController, PlanRevisionsController,
    StoryboardController, NovelController, AssetController, DesktopAssetController, VideoAutomationController,
    ProductionController, ProductionMediaController, ObjectVersionController, AssistantController, CanvasController, ToolRegistryController,
    ...(dependencies.evolutionService ? [EvolutionController] : []),
    ...(dependencies.evolutionGateService ? [EvolutionGateController] : []),
    ...(dependencies.evaluationService ? [EvaluationController] : []),
    ...(dependencies.assetRetrievalGovernanceService ? [AssetRetrievalGovernanceController] : []),
    ...(dependencies.promptPacksService ? [PromptPacksController] : []),
    ...(dependencies.methodPacksService ? [MethodPacksController] : []),
    ...(dependencies.outboxTaskService ? [OutboxTaskController] : [])], providers: [ModelsService,
    { provide: PLATFORM_PREFLIGHT, useValue: dependencies.platformPreflight ?? new PlatformPreflightService({}) },
    { provide: CONFIG, useValue: config }, { provide: TRANSPORT, useValue: transport },
    { provide: SYSTEM_STATUS, useValue: systemStatus },
    { provide: OUTBOX_TASK_SERVICE, useValue: dependencies.outboxTaskService ?? null },
    { provide: AUTH_SERVICE, useValue: dependencies.authService ?? null },
    { provide: 'AUTH_COOKIE_OPTIONS', useValue: {
      secure: config.sessionCookieSecure,
      ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
      sessionTtlSeconds: config.sessionTtlSeconds,
    } },
    { provide: BREAKDOWN_SERVICE, useValue: breakdownService },
    { provide: STAGE_RUNNER, useValue: dependencies.stageRunner ?? null },
    { provide: NOVEL_SERVICE, useValue: dependencies.novelService ?? null },
    { provide: ASSET_SERVICE, useValue: dependencies.assetService ?? null },
    { provide: DESKTOP_ASSET_SERVICE, useValue: dependencies.desktopAssetService ?? null },
    { provide: VIDEO_AUTOMATION_SERVICE, useValue: dependencies.videoAutomationService ?? null },
    { provide: PRODUCTION_SERVICE, useValue: dependencies.productionService ?? null },
    { provide: PRODUCTION_MEDIA_STORE, useValue: dependencies.productionMediaStore ?? null },
    { provide: PRODUCTION_MEDIA_OBJECT_SERVICE, useValue: dependencies.productionMediaObjectService ?? null },
    { provide: OBJECT_VERSIONS, useValue: dependencies.objectVersions ?? null },
    { provide: ASSISTANT_SERVICE, useValue: dependencies.assistantService ?? null },
    { provide: CANVAS_SERVICE, useValue: dependencies.canvasService ?? null },
    { provide: AGENT_RUNTIME, useValue: dependencies.agentRuntime ?? null },
    { provide: AGENT_TOOL_KERNEL, useValue: dependencies.agentToolKernel ?? null },
    { provide: TOOL_REGISTRY_VIEW, useValue: dependencies.toolRegistryView ?? null },
    { provide: MCP_MANAGEMENT, useValue: dependencies.mcpManagement ?? null },
    { provide: ASSET_EVOLUTION_SERVICE, useValue: dependencies.evolutionService ?? null },
    { provide: EVOLUTION_GATE_SERVICE, useValue: dependencies.evolutionGateService ?? null },
    { provide: EVALUATION_SERVICE, useValue: dependencies.evaluationService ?? null },
    { provide: ASSET_RETRIEVAL_GOVERNANCE_SERVICE,
      useValue: dependencies.assetRetrievalGovernanceService ?? null },
    { provide: PROMPT_PACK_SERVICE, useValue: dependencies.promptPacksService ?? null },
    { provide: METHOD_PACK_SERVICE, useValue: dependencies.methodPacksService ?? null },
    { provide: STORYBOARD_SERVICE, useValue: dependencies.storyboardService ?? null }] })
  class ModelsModule {}
  const adapter = new FastifyAdapter({ bodyLimit: MAX_REQUEST_BYTES, logger: false });
  adapter.getInstance().addHook('onRequest', async (request, reply) => {
    const path = requestPath(request.url);
    if (request.url.startsWith('/api/platform') || request.url.startsWith('/api/auth') || request.url.startsWith('/api/model') || request.url.startsWith('/api/provider-catalog') || request.url.startsWith('/api/desktop-assets') || request.url.startsWith('/api/video-automation')
      || request.url.startsWith('/api/asset-generation') || request.url.startsWith('/api/production-runs')
      || request.url.startsWith('/api/production-media')
      || request.url.startsWith('/api/evolution')
      || request.url.startsWith('/api/evaluation')
      || request.url.includes('/asset-retrieval-governance')
      || request.url.startsWith('/api/assistant')
      || request.url.startsWith('/api/prompt-packs')
      || request.url.includes('/method-packs') || request.url.includes('/method-profiles')
      || request.url.includes('/desktop-asset')
      || request.url.includes('/asset-generation')) reply.header('Cache-Control', 'no-store');
    const origin = request.headers.origin;
    const hostHeader = request.headers.host ?? '';
    const localHost = /^127\.0\.0\.1(?::\d+)?$/.test(hostHeader) || /^localhost(?::\d+)?$/.test(hostHeader);
    const publicOrigin = config.publicOrigin;
    const publicHost = publicOrigin ? new URL(publicOrigin).host : '';
    const allowedHost = localHost || Boolean(publicHost && hostHeader.toLowerCase() === publicHost.toLowerCase());
    const localSameOrigin = origin !== undefined && localHost
      && (origin === `http://${hostHeader}` || origin === `https://${hostHeader}`);
    const allowedBrowser = origin === 'http://127.0.0.1:5173' || origin === 'http://localhost:5173'
      || localSameOrigin || Boolean(origin && publicOrigin && origin === publicOrigin);
    if (allowedBrowser) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Shortdrama-Call, X-Workspace-Id, X-Request-Id, Authorization, X-CSRF-Token');
    }
    const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
    if (!allowedHost || (origin && !allowedBrowser)
      || (mutation && request.headers['x-shortdrama-call'] !== '1')) {
      return reply.code(403).send({ error: { code: 'LOCAL_CLIENT_ONLY',
        message: '请求 Host/Origin 不受信任，写请求需 X-Shortdrama-Call: 1。' } });
    }
    if (request.method === 'OPTIONS') return reply.code(204).send();
    if (config.authMode === 'session' && request.url.startsWith('/api/')) {
      const registrationPath = path === '/api/auth/register';
      const publicPath = path === '/api/auth/login' || path === '/api/auth/config'
        || registrationPath || path === '/api/system/status';
      if (registrationPath) {
        if (!dependencies.registrationRateLimiter) {
          return reply.code(503).send({ error: { code: 'RATE_LIMIT_UNAVAILABLE',
            message: '请求保护服务暂时不可用。' } });
        }
        try {
          const decision = await dependencies.registrationRateLimiter.consume(
            `register:${rateLimitIdentity(clientAddress(request))}`, 3, 3_600);
          if (!decision.allowed) {
            reply.header('Retry-After', String(decision.retryAfterSeconds));
            return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试。' } });
          }
        } catch {
          return reply.code(503).send({ error: { code: 'RATE_LIMIT_UNAVAILABLE',
            message: '请求保护服务暂时不可用。' } });
        }
      } else if (dependencies.rateLimiter && publicPath) {
        try {
          const purpose = path === '/api/auth/login' ? 'login' : 'public-status';
          const decision = await dependencies.rateLimiter.consume(
            `${purpose}:${rateLimitIdentity(clientAddress(request))}`,
            path === '/api/auth/login' ? 10 : 120,
            path === '/api/auth/login' ? 300 : 60,
          );
          if (!decision.allowed) {
            reply.header('Retry-After', String(decision.retryAfterSeconds));
            return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试。' } });
          }
        } catch {
          return reply.code(503).send({ error: { code: 'RATE_LIMIT_UNAVAILABLE',
            message: '请求保护服务暂时不可用。' } });
        }
      }
      if (!publicPath) {
        try {
          const rawRequestId = request.headers['x-request-id'];
          const requestId = typeof rawRequestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/u.test(rawRequestId)
            ? rawRequestId : `req_${randomBytes(16).toString('hex')}`;
          const auth = await dependencies.authService!.authenticate(request.headers.cookie,
            requestedWorkspace(request.headers['x-workspace-id']), requestId);
          (request as typeof request & { auth?: AuthenticatedRequest }).auth = auth;
          reply.header('X-Request-Id', requestId);
          if (dependencies.rateLimiter) {
            const decision = await dependencies.rateLimiter.consume(
              `session:${rateLimitIdentity(`${auth.tenant.workspaceId}:${auth.sessionId}`)}`, 180, 60,
            );
            if (!decision.allowed) {
              reply.header('Retry-After', String(decision.retryAfterSeconds));
              return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试。' } });
            }
          }
          if (mutation) {
            dependencies.authService!.verifyCsrf(auth, request.headers['x-csrf-token']);
            if (auth.tenant.role === 'viewer' && path !== '/api/auth/logout') {
              throw new AuthError(403, 'AUTH_FORBIDDEN', '当前 workspace 角色没有写权限。');
            }
            if (isModelConfigurationMutation(path)
              && (auth.tenant.workspaceId !== LEGACY_WORKSPACE_ID
                || !['owner', 'admin'].includes(auth.tenant.role))) {
              throw new AuthError(403, 'AUTH_FORBIDDEN',
                '只有控制 workspace 的 owner 或 admin 可以修改部署级模型连接。');
            }
          }
        } catch (error) {
          if (error instanceof AuthError) {
            return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
          }
          if (error instanceof RateLimiterUnavailableError) {
            return reply.code(503).send({ error: { code: 'RATE_LIMIT_UNAVAILABLE',
              message: '请求保护服务暂时不可用。' } });
          }
          return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '身份校验失败。' } });
        }
      }
    }
  });
  // Fastify continues the request pipeline from this callback, so every
  // repository call made by the Nest handler inherits the authenticated
  // workspace through AsyncLocalStorage. PostgreSQL RLS consumes the same
  // transaction-local values during the later contract migration.
  adapter.getInstance().addHook('preHandler', (request, _reply, done) => {
    const auth = (request as typeof request & { auth?: AuthenticatedRequest }).auth;
    if (auth) tenantExecutionScope.runWithTenant(auth.tenant, done);
    else done();
  });
  if (dependencies.close) {
    adapter.getInstance().addHook('onClose', async () => { await dependencies.close?.(); });
  }
  const app = await NestFactory.create<NestFastifyApplication>(ModelsModule, adapter, { logger: false });
  app.useGlobalFilters(new SafeErrors());
  await app.init();
  await adapter.getInstance().ready();
  return app;
}
