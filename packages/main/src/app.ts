import 'reflect-metadata';
import { Body, Catch, Controller, Get, HttpCode, HttpException, Inject, Injectable, Module, Param, Post, Query,
  type ArgumentsHost, type ExceptionFilter, type PipeTransform } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AppConfig } from './config';
import { ModelClient } from './models/client';
import { MAX_REQUEST_BYTES, ModelError, parseCall } from '@lyra/shared';
import { configuredModel } from './models/registry';
import { configForRole, ModelConnections, parseModelRole, type ModelRole } from './models/connections';
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
import { ProductionError } from '@lyra/shared';
import type { ProductionService } from './production/service';
import { PRODUCTION_MEDIA_STORE, ProductionMediaController } from './production-media/controller';
import { ProductionMediaError } from './production-media/contracts';
import type { ProductionMediaStore } from './production-media/store';
import { ASSISTANT_SERVICE, AssistantController } from './assistant/controller';
import { AssistantError } from '@lyra/agent';
import type { AssistantService } from '@lyra/agent';
import { ASSET_EVOLUTION_SERVICE, EvolutionController } from './evolution/controller';
import type { AssetEvolutionService } from './evolution/service';
import { PROMPT_PACK_SERVICE, PromptPacksController } from './prompt-packs/controller';
import { methodReference } from './prompt-packs/runtime';
import { PromptPackError, type PromptPackService } from './prompt-packs/service';

const CONFIG = Symbol('APP_CONFIG');
const TRANSPORT = Symbol('MODEL_TRANSPORT');
const BREAKDOWN_SERVICE = Symbol('BREAKDOWN_SERVICE');
const STAGE_RUNNER = Symbol('STAGE_RUNNER');
const STORYBOARD_SERVICE = Symbol('STORYBOARD_SERVICE');

export interface AppDependencies {
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
  assistantService?: AssistantService;
  evolutionService?: AssetEvolutionService;
  promptPacksService?: PromptPackService;
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
    if (error instanceof BreakdownError || error instanceof NovelError || error instanceof AssetError
      || error instanceof VideoAutomationError || error instanceof ProductionError || error instanceof ProductionMediaError
      || error instanceof AssistantError || error instanceof PromptPackError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
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
  @Module({ controllers: [ModelsController, ProjectsController, BreakdownRunsController, PlanRevisionsController,
    StoryboardController, NovelController, AssetController, DesktopAssetController, VideoAutomationController,
    ProductionController, ProductionMediaController, AssistantController,
    ...(dependencies.evolutionService ? [EvolutionController] : []),
    ...(dependencies.promptPacksService ? [PromptPacksController] : [])], providers: [ModelsService,
    { provide: CONFIG, useValue: config }, { provide: TRANSPORT, useValue: transport },
    { provide: BREAKDOWN_SERVICE, useValue: breakdownService },
    { provide: STAGE_RUNNER, useValue: dependencies.stageRunner ?? null },
    { provide: NOVEL_SERVICE, useValue: dependencies.novelService ?? null },
    { provide: ASSET_SERVICE, useValue: dependencies.assetService ?? null },
    { provide: DESKTOP_ASSET_SERVICE, useValue: dependencies.desktopAssetService ?? null },
    { provide: VIDEO_AUTOMATION_SERVICE, useValue: dependencies.videoAutomationService ?? null },
    { provide: PRODUCTION_SERVICE, useValue: dependencies.productionService ?? null },
    { provide: PRODUCTION_MEDIA_STORE, useValue: dependencies.productionMediaStore ?? null },
    { provide: ASSISTANT_SERVICE, useValue: dependencies.assistantService ?? null },
    { provide: ASSET_EVOLUTION_SERVICE, useValue: dependencies.evolutionService ?? null },
    { provide: PROMPT_PACK_SERVICE, useValue: dependencies.promptPacksService ?? null },
    { provide: STORYBOARD_SERVICE, useValue: dependencies.storyboardService ?? null }] })
  class ModelsModule {}
  const adapter = new FastifyAdapter({ bodyLimit: MAX_REQUEST_BYTES, logger: false });
  adapter.getInstance().addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/model') || request.url.startsWith('/api/desktop-assets') || request.url.startsWith('/api/video-automation')
      || request.url.startsWith('/api/asset-generation') || request.url.startsWith('/api/production-runs')
      || request.url.startsWith('/api/production-media')
      || request.url.startsWith('/api/evolution')
      || request.url.startsWith('/api/assistant')
      || request.url.startsWith('/api/prompt-packs')
      || request.url.includes('/desktop-asset')
      || request.url.includes('/asset-generation')) reply.header('Cache-Control', 'no-store');
    const origin = request.headers.origin;
    const allowedBrowser = origin === 'http://127.0.0.1:5173' || origin === 'http://localhost:5173';
    if (allowedBrowser) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Shortdrama-Call');
    }
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(request.headers.host ?? '') || (origin && !allowedBrowser) ||
        (request.method === 'POST' && request.headers['x-shortdrama-call'] !== '1')) {
      return reply.code(403).send({ error: { code: 'LOCAL_CLIENT_ONLY', message: '仅允许本机客户端访问；POST 需 X-Shortdrama-Call: 1。' } });
    }
    if (request.method === 'OPTIONS') return reply.code(204).send();
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
