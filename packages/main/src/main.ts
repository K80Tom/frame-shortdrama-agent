import { createApp } from './app';
import { readConfig } from './config';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { configForRole, ModelConnections } from './models/connections';
import { PostgresDatabase } from './db/client';
import { readDatabaseConfig } from './db/config';
import { BREAKDOWN_PERSISTENCE_MIGRATIONS, DATA_OUTBOX_MIGRATIONS, EVALUATION_CATALOG_MIGRATIONS, EXTRACT_FACTS_LEDGER_MIGRATIONS } from './db/readiness';
import { PostgresBreakdownRepository } from './breakdown/repository';
import { BreakdownService, UnavailableBreakdownService } from './breakdown/service';
import { ExtractFactsStageRunner } from './breakdown/execution';
import { PiExtractFactsStageExecutor } from './breakdown/pi-executor';
import { MaasStageModelAdapter } from './breakdown/model-adapter';
import { StoryboardService } from './breakdown/storyboard';
import { NovelService } from './novel/service';
import { PostgresNovelRepository } from './novel/repository';
import { AssetService } from './assets/service';
import { PostgresAssetRepository } from './assets/repository';
import { readAssetVectorConfig } from './assets/vector/config';
import { DesktopAssetService } from './desktop-assets/service';
import { DesktopCandidateAssetPolicy, PostgresDesktopTaskRepository } from './desktop-assets/repository';
import { DoubaoImageApiAdapter } from './desktop-assets/api-adapter';
import { VideoAutomationService } from './video-automation/service';
import { PostgresVideoAutomationRepository } from './video-automation/repository';
import { SeedanceVideoAutomationAdapter } from './video-automation/adapter';
import { PostgresProductionRepository } from './production/repository';
import { ProductionService } from './production/service';
import { BreakdownProductionExecutor, StoryboardProductionExecutor, VideoProductionExecutor } from './production/runtime';
import { AssetsProductionExecutor, DirectorProductionExecutor } from './production/executors';
import {
  CandidateProductionExecutor, ComposeProductionExecutor, DeliveryProductionExecutor, ReviewProductionExecutor,
} from './production/finalization';
import {
  BoundedProcessRunner, FfprobeVideoProber, FrameAssessor,
  PostgresProductionMediaObjectRepository, ProductionMediaError, ProductionMediaIngestor,
  ProductionMediaObjectService, ProductionMediaObjectWorker, ProductionMediaStore, TimelineComposer,
} from './production-media';
import { ModelClient } from './models/client';
import { PostgresAssistantRepository } from './assistant/postgres-repository';
import { AssistantOrchestrator, type AssistantMessage } from '@lyra/agent';
import { AssistantService } from '@lyra/agent';
import { ProductionError } from '@lyra/shared';
import { PostgresEvolutionRepository } from './evolution/postgres-repository';
import { AssetEvolutionService } from './evolution/service';
import { PostgresEvaluationRepository } from './evaluation/postgres-repository';
import { EvaluationService } from './evaluation/service';
import { PostgresPromptPackImportRepository, PostgresPromptPackStateRepository } from './prompt-packs/repository';
import { PromptPackService } from './prompt-packs/service';
import { SystemStatusService, staticProbe, type ServiceProbe } from './system/status';
import { AuthService } from './auth/service';
import { PostgresAuthRepository } from './auth/repository';
import { createObjectStorageFromEnv } from './infrastructure/object-storage';
import { CachedAssistantRepository, createConversationContextRuntime } from './infrastructure/conversation-context';
import { createAssetVectorV2Runtime, createTenantAwareAssetRetriever } from './assets/vector/runtime-v2';
import { DoubaoAssetEmbeddingClient } from './assets/vector/embedding';
import {
  AssetVectorJobReconciler, AssetVectorProjectionJobHandler,
} from './assets/vector/job-projector';
import { startWorkerProcessLifetime } from './system/worker-lifetime';
import { PostgresJobQueueRepository } from './jobs/repository';
import { PostgresJobTenantResolver } from './jobs/tenant';
import { PersistentJobWorker, type JobHandler } from './jobs/worker';
import { PostgresDataOutboxRepository } from './data/repository';
import { PostgresProjectionStore } from './data/checkpoint';
import { DataProjector } from './data/projector';
import { DataDispatchJobPump, DataOutboxJobHandler } from './data/job-dispatcher';
import { tenantExecutionScope } from './tenancy/scope';

/** 助手工具只输出标量白名单字段，避免把提示词、原文或供应商负载带回对话。 */
function pickScalars(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const item = source[field];
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) output[field] = item;
  }
  return output;
}

function summarizeRun(run: unknown): Record<string, unknown> {
  const summary = pickScalars(run, ['id', 'projectId', 'status', 'currentStage', 'ratio', 'targetDurationSec',
    'budgetMicros', 'currency', 'createdAt', 'updatedAt']);
  const source = run && typeof run === 'object' ? run as Record<string, unknown> : {};
  if (Array.isArray(source.tasks)) {
    summary.tasks = source.tasks.slice(0, 40).map(task => {
      const item = pickScalars(task, ['id', 'stage', 'label', 'status', 'attemptCount']);
      const reason = task && typeof task === 'object' ? (task as Record<string, unknown>).blockingReason : undefined;
      if (reason && typeof reason === 'object') item.blockingReason = pickScalars(reason, ['code', 'message']);
      return item;
    });
  }
  return summary;
}

// The upstream APIs do not return a settled monetary charge. These values are
// deliberately conservative run-budget accounting ceilings, denominated in
// CNY micros, so one authorized run cannot silently exceed its frozen budget.
const PRODUCTION_COST_CEILINGS = Object.freeze({
  breakdown: 2_000_000,
  storyboard: 2_000_000,
  frameAssessment: 2_000_000,
  image: 2_000_000,
  video: 5_000_000,
});

export function assertRuntimeTopology(config: Pick<ReturnType<typeof readConfig>, 'runtimeRole' | 'authMode'>): void {
  if (config.runtimeRole === 'api' && config.authMode !== 'session') {
    throw new Error('LYRA_RUNTIME_ROLE=api requires LYRA_AUTH_MODE=session');
  }
}

async function startRuntimeHeartbeat(database: PostgresDatabase, role: 'api' | 'worker' | 'all'):
Promise<() => Promise<void>> {
  const instanceId = `runtime_${randomBytes(16).toString('hex')}`;
  let updating = false;
  const update = async () => {
    if (updating) return;
    updating = true;
    try {
      await database.query(`
        INSERT INTO runtime_heartbeats
          (instance_id, role, started_at, last_seen_at, expires_at)
        VALUES ($1, $2, now(), now(), now() + interval '30 seconds')
        ON CONFLICT (instance_id) DO UPDATE
        SET last_seen_at = now(), expires_at = now() + interval '30 seconds'
      `, [instanceId, role]);
      await database.query(`DELETE FROM runtime_heartbeats WHERE expires_at < now() - interval '1 day'`);
    } finally { updating = false; }
  };
  await update();
  const timer = setInterval(() => { void update().catch(() => undefined); }, 10_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await database.query('DELETE FROM runtime_heartbeats WHERE instance_id = $1', [instanceId]).catch(() => undefined);
  };
}

async function main() {
  const initial = readConfig();
  assertRuntimeTopology(initial);
  const stage1Process = initial.runtimeRole !== 'all' || initial.authMode === 'session';
  const modelConnections = new ModelConnections(initial, resolve('outputs/private/model-connections.json'));
  await modelConnections.initialize({ readOnly: initial.runtimeRole === 'worker' });
  const config = Object.freeze({ ...initial, modelConnections });
  const assetVectorConfig = readAssetVectorConfig(process.env);
  const assetVectorV2 = createAssetVectorV2Runtime(process.env);
  const assetRetrieval = assetVectorConfig
    ? createTenantAwareAssetRetriever(assetVectorConfig, assetVectorV2) : undefined;
  const objectStorage = createObjectStorageFromEnv(process.env);
  const conversationContext = await createConversationContextRuntime<AssistantMessage>(process.env);
  const databaseConfig = readDatabaseConfig();
  let database: PostgresDatabase | undefined;
  let breakdownService: BreakdownService | UnavailableBreakdownService | undefined;
  let stageRunner: ExtractFactsStageRunner | undefined;
  let storyboardService: StoryboardService | undefined;
  let novelService: NovelService | undefined;
  let assetService: AssetService | undefined;
  let desktopAssetService: DesktopAssetService | undefined;
  let videoAutomationService: VideoAutomationService | undefined;
  let productionService: ProductionService | undefined;
  let assistantService: AssistantService | undefined;
  let evolutionService: AssetEvolutionService | undefined;
  let evaluationService: EvaluationService | undefined;
  let promptPacksService: PromptPackService | undefined;
  let authService: AuthService | undefined;
  let stopRuntimeHeartbeat: (() => Promise<void>) | undefined;
  let persistentJobWorker: PersistentJobWorker | undefined;
  let productionMediaObjectService: ProductionMediaObjectService | undefined;
  let productionMediaObjectWorker: ProductionMediaObjectWorker | undefined;
  let dataDispatchPump: DataDispatchJobPump | undefined;
  let assetVectorReconciler: AssetVectorJobReconciler | undefined;
  let stage1Jobs: PostgresJobQueueRepository | undefined;
  let tenantResolver: PostgresJobTenantResolver | undefined;
  let stage1RuntimeMigrated = false;
  const mediaRunner = new BoundedProcessRunner();
  const productionMediaStore = new ProductionMediaStore(
    resolve('outputs/private/production-media'),
    new FfprobeVideoProber(mediaRunner),
  );
  const productionMediaIngestor = new ProductionMediaIngestor(productionMediaStore,
    undefined, undefined, { allowIntranetMediaSources: config.mediaAllowIntranetSources ?? false });
  const timelineComposer = new TimelineComposer(productionMediaStore, mediaRunner);
  await productionMediaStore.initialize();
  if (databaseConfig) {
    database = new PostgresDatabase(databaseConfig, {
      unscopedAccess: stage1Process ? 'deny' : 'legacy-system',
    });
    try {
      await database.verifyConnection();
      stage1RuntimeMigrated = await database.hasMigrations(['031']);
      if (stage1Process && !stage1RuntimeMigrated) {
        throw new Error('Stage 1 API/Worker/session runtime requires migration 031');
      }
      if (config.authMode === 'session') {
        if (conversationContext.mode !== 'redis') {
          throw new Error('Session authentication requires Redis for shared snapshots and rate limits');
        }
        if (!await database.hasMigrations(['025', '028', '030', '031'])) {
          throw new Error('Session authentication requires migrations 025, 028, 030 and 031');
        }
        await database.verifyTenantRole();
        authService = new AuthService(new PostgresAuthRepository(database), {
          sessionTtlSeconds: config.sessionTtlSeconds,
        });
      }
      if (stage1RuntimeMigrated) {
        stage1Jobs = new PostgresJobQueueRepository(database);
        tenantResolver = new PostgresJobTenantResolver(database);
        const objectRecords = new PostgresProductionMediaObjectRepository(database, stage1Jobs);
        productionMediaObjectService = new ProductionMediaObjectService(
          productionMediaStore, objectStorage, objectRecords,
        );
        productionMediaObjectWorker = new ProductionMediaObjectWorker(
          productionMediaStore, objectStorage, stage1Jobs, objectRecords, {
            workerId: `object-worker-${process.pid}-${randomBytes(8).toString('hex')}`,
            tenantResolver,
          },
        );
        if (stage1Process) {
          productionMediaStore.setStoredHook(async object => {
            const scope = tenantExecutionScope.current();
            if (scope?.kind !== 'tenant') {
              throw new ProductionMediaError(500, 'MEDIA_TENANT_SCOPE_REQUIRED',
                '生产媒体必须在已验证的 workspace 上下文中持久化。');
            }
            await productionMediaObjectService!.enqueue({ workspaceId: scope.tenant.workspaceId }, object.id);
          });
        }
      }
      if (await database.hasMigrations(EVALUATION_CATALOG_MIGRATIONS)) {
        evaluationService = new EvaluationService(new PostgresEvaluationRepository(database));
      }
      if (await database.hasMigrations(['020', '021'])) {
        promptPacksService = new PromptPackService(
          new PostgresPromptPackStateRepository(database), new PostgresPromptPackImportRepository(database),
        );
      }
      if (await database.hasMigrations(['009'])) {
        assetService = new AssetService(new PostgresAssetRepository(database), await database.hasMigrations(['010']));
      }
      if (await database.hasMigrations(['014'])) {
        videoAutomationService = new VideoAutomationService(new PostgresVideoAutomationRepository(database),
          new SeedanceVideoAutomationAdapter(() => configForRole(config, 'video'), fetch, assetService));
      }
      const desktopJobs = await database.hasMigrations(['011', '012', '013'])
        ? new PostgresDesktopTaskRepository(database) : undefined;
      if (await database.hasMigrations(['008'])) {
        novelService = new NovelService(new PostgresNovelRepository(database), config, fetch, assetService,
          desktopJobs && assetService ? new DesktopCandidateAssetPolicy(desktopJobs, assetService) : undefined,
          await database.hasMigrations(BREAKDOWN_PERSISTENCE_MIGRATIONS) ? new PostgresBreakdownRepository(database) : undefined);
      }
      if (novelService && assetService && desktopJobs && await database.hasMigrations(['010'])) {
        desktopAssetService = new DesktopAssetService(desktopJobs,
          new PostgresNovelRepository(database), novelService, assetService,
          new DoubaoImageApiAdapter(() => configForRole(config, 'image')), process.cwd(), {
            tenantResolver,
            requireTenantWorkspace: stage1Process,
          });
      }
      if (await database.hasMigrations(BREAKDOWN_PERSISTENCE_MIGRATIONS)) {
        const repository = new PostgresBreakdownRepository(database);
        breakdownService = new BreakdownService(repository, config);
        // 017 adds model_calls.response_json. Without it, a successful paid
        // extract cannot be recorded and must not be started.
        if (await database.hasMigrations(EXTRACT_FACTS_LEDGER_MIGRATIONS)) {
          stageRunner = new ExtractFactsStageRunner(repository, breakdownService,
            new PiExtractFactsStageExecutor(), new MaasStageModelAdapter(config));
        }
        storyboardService = new StoryboardService(database, breakdownService, config);
      } else {
        breakdownService = new UnavailableBreakdownService(
          'PERSISTENCE_MIGRATION_REQUIRED',
          '拆解持久化尚未迁移；请先执行 npm run db:migrate。',
        );
      }
      if (await database.hasMigrations(['015', '016'])
        && await database.hasMigrations(DATA_OUTBOX_MIGRATIONS)
        && breakdownService instanceof BreakdownService && stageRunner && storyboardService
        && assetService && videoAutomationService) {
        const breakdown = breakdownService;
        const productionRepository = new PostgresProductionRepository(database);
        if (await database.hasMigrations(['019'])) {
          evolutionService = new AssetEvolutionService(productionRepository, new PostgresEvolutionRepository(database));
        }
        productionService = new ProductionService(productionRepository, {
          methodPacks: promptPacksService && ((project) => promptPacksService!.freeze(project)),
          assetRetrievalPolicy: evolutionService ? () => evolutionService!.currentAssetRetrievalPolicy() : undefined,
          sourceCatalog: breakdownService,
          runInTenantScope: tenantResolver ? async (runId, work) => {
            const workspaceId = await database!.runAsSystem('production.tenant.lookup', () =>
              productionRepository.workspaceId(runId));
            if (!workspaceId) throw new ProductionError(404, 'PRODUCTION_RUN_NOT_FOUND', '生产运行不存在。');
            const tenant = await tenantResolver!.resolve(workspaceId, runId);
            return database!.runWithTenant(tenant, work);
          } : undefined,
          executors: [
            new BreakdownProductionExecutor(breakdownService, stageRunner,
              { estimateCostMicros: PRODUCTION_COST_CEILINGS.breakdown }),
            new AssetsProductionExecutor({ breakdown: breakdownService, assets: assetService,
              storyboards: storyboardService, config: () => config, retrieval: assetRetrieval,
              imageCostMicros: PRODUCTION_COST_CEILINGS.image }),
            new StoryboardProductionExecutor(breakdownService, storyboardService,
              { estimateCostMicros: PRODUCTION_COST_CEILINGS.storyboard }),
            new DirectorProductionExecutor({ breakdown: breakdownService, storyboards: storyboardService }),
            new VideoProductionExecutor(breakdownService, storyboardService, videoAutomationService,
              { estimateCostMicros: PRODUCTION_COST_CEILINGS.video, mediaIngestor: productionMediaIngestor }),
            new CandidateProductionExecutor(productionMediaStore),
            new ReviewProductionExecutor(productionMediaStore),
            new ComposeProductionExecutor(timelineComposer, {
              resolveProjectTitle: projectId => breakdown.getProject(projectId).then(project => project.title),
              ...((process.env.Lyra_FRAME_ASSESSMENT ?? process.env.OHAO_FRAME_ASSESSMENT) === '0' ? {} : {
                frameAssessment: { ceilingMicrosPerShot: PRODUCTION_COST_CEILINGS.frameAssessment,
                  assessor: new FrameAssessor(productionMediaStore, mediaRunner,
                    { call: input => new ModelClient(configForRole(config, 'general'), fetch).call(input) },
                    'ffmpeg', { framesPerShot: 2 }) },
              }),
            }),
            new DeliveryProductionExecutor(productionMediaStore),
          ],
        });
      }
      // AI 工作区：旧平台「全局 AI 工作区」的本地等价实现。
      // 模型只负责决策与解释；真实数据来自白名单工具，付费只走估价卡确认。
      if (await database.hasMigrations(['018', '029'])) {
        const assistantRepository = new CachedAssistantRepository(
          new PostgresAssistantRepository(database), conversationContext.cache,
        );
        const breakdown = breakdownService;
        const production = productionService;
        const assets = assetService;
        const orchestrator = new AssistantOrchestrator(
          { call: input => new ModelClient(configForRole(config, 'general'), fetch).call(input) },
          {
            listProjects: breakdown
              ? async () => (await breakdown.listProjects()).map(project => pickScalars(project, ['id', 'title', 'createdAt', 'updatedAt']))
              : undefined,
            listProductionRuns: production
              ? async () => (await production.list()).runs.map(run => summarizeRun(run))
              : undefined,
            getProductionRun: production
              ? async runId => summarizeRun(await production.get(runId))
              : undefined,
            listAssets: assets
              ? async () => (await assets.list()).map(asset => pickScalars(asset, ['id', 'name', 'kind', 'type', 'status', 'createdAt']))
              : undefined,
          },
          { createQuote: (_sessionId, quote) => assistantRepository.createQuote(quote) },
        );
        assistantService = new AssistantService(assistantRepository, orchestrator, productionService);
      }
      if (stage1RuntimeMigrated) {
        const jobs = stage1Jobs!;
        const outbox = new PostgresDataOutboxRepository(database);
        const handlers: JobHandler[] = [
          new DataOutboxJobHandler(outbox,
            new DataProjector('stage1-data-projection-v2', new PostgresProjectionStore(database))),
        ];
        dataDispatchPump = new DataDispatchJobPump(outbox, jobs);
        if (assetVectorConfig && assetVectorV2.enabled) {
          const embedding = new DoubaoAssetEmbeddingClient({
            endpoint: assetVectorConfig.embeddingEndpoint,
            model: assetVectorConfig.embeddingModel,
            apiKey: assetVectorConfig.embeddingApiKey,
            timeoutMs: assetVectorConfig.embeddingTimeoutMs,
          });
          handlers.push(new AssetVectorProjectionJobHandler(database, {
            collection: assetVectorV2.collection,
            embeddingModel: assetVectorConfig.embeddingModel,
            embedding,
            store: assetVectorV2.store,
          }));
          assetVectorReconciler = new AssetVectorJobReconciler(database, jobs, {
            collection: assetVectorV2.collection,
            embeddingModel: assetVectorConfig.embeddingModel,
          });
        }
        persistentJobWorker = new PersistentJobWorker(jobs,
          tenantResolver!, handlers);
      }
    } catch (error) {
      await stopRuntimeHeartbeat?.();
      await database.close().catch(() => undefined);
      await conversationContext.close().catch(() => undefined);
      throw error;
    }
  }
  const postgresProbe: ServiceProbe = database
    ? { required: true, check: async () => {
      if (stage1RuntimeMigrated) await database!.verifyWritable();
      else await database!.verifyConnection();
      return { status: 'healthy', detail: stage1RuntimeMigrated
        ? '数据库已通过可回滚 DML 写入探针，结构化事实源可用。'
        : '数据库连接可用；当前尚未进入 Stage 1 可写运行时。', provider: 'postgresql' };
    } }
    : staticProbe(true, { status: 'unconfigured', detail: '未配置 DATABASE_URL。' });
  const systemStatus = new SystemStatusService(config.runtimeRole, {
    worker: config.runtimeRole === 'api' && database && stage1RuntimeMigrated
      ? { required: true, check: async () => {
        const result = await database!.query<{ available: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM runtime_heartbeats
            WHERE role IN ('worker', 'all') AND expires_at > now()
          ) AS available
        `);
        return result.rows[0]?.available
          ? { status: 'healthy', detail: '独立 Worker 心跳正常。' }
          : { status: 'unavailable', detail: '未检测到未过期的 Worker 心跳。' };
      } }
      : undefined,
    postgres: postgresProbe,
    redis: conversationContext.mode === 'redis'
      ? { required: config.authMode === 'session', check: async () => (await conversationContext.probe())
        ? { status: 'healthy', detail: 'Redis 对话快照连接可用。', provider: 'redis' }
        : { status: 'degraded', detail: config.authMode === 'session'
          ? 'Redis 未响应 PING；快照可从 PostgreSQL 重建，但会话请求保护失败关闭。'
          : 'Redis 未响应 PING，对话回源 PostgreSQL。', provider: 'redis' } }
      : staticProbe(false, { status: 'unconfigured', detail: '未配置 Redis，对话直接回源 PostgreSQL。' }),
    objectStorage: { required: true, check: async () => {
      await objectStorage.probe();
      return { status: 'healthy', detail: '对象存储边界可用，私有对象按 workspace 隔离。', provider: objectStorage.provider };
    } },
    milvus: assetVectorV2.enabled
      ? { required: true, check: async () => (await assetVectorV2.probe())
        ? { status: 'healthy', detail: 'Milvus v2 连接可用，资产由持久化投影任务索引。', provider: 'milvus' }
        : { status: 'degraded', detail: 'Milvus v2 未通过健康检查，资产检索降级为词法模式。', provider: 'milvus' } }
      : staticProbe(false, { status: 'unconfigured', detail: 'Milvus 未配置；资产检索降级为词法模式。' }),
  });
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    await Promise.all([desktopAssetService?.stop(), videoAutomationService?.stop(), productionService?.stop()]);
    await Promise.all([dataDispatchPump?.stop(), assetVectorReconciler?.stop()]);
    await Promise.all([productionMediaObjectWorker?.stop(), persistentJobWorker?.stop()]);
    await conversationContext.close().catch(() => undefined);
    await stopRuntimeHeartbeat?.();
    await database?.close();
  };
  const dependencies = {
    breakdownService,
    stageRunner,
    storyboardService,
    novelService,
    assetService,
    desktopAssetService,
    videoAutomationService,
    productionService,
    productionMediaStore,
    productionMediaObjectService,
    assistantService,
    evolutionService,
    evaluationService,
    promptPacksService,
    authService,
    rateLimiter: conversationContext.rateLimiter,
    systemStatus,
    close: shutdown,
  };
  const runWorker = config.runtimeRole !== 'api';
  const runApi = config.runtimeRole !== 'worker';
  let closeApi: (() => Promise<void>) | undefined;
  try {
    if (runWorker) {
      if (!database) throw new Error('Worker requires PostgreSQL');
      if (!runApi && !desktopAssetService && !videoAutomationService && !productionService
        && !persistentJobWorker && !productionMediaObjectWorker) {
        throw new Error('Worker has no migrated task service to run');
      }
      productionMediaObjectWorker?.start();
      persistentJobWorker?.start();
      dataDispatchPump?.start();
      assetVectorReconciler?.start();
      // Legacy schedulers predate tenant-aware jobs. Their timers inherit this
      // explicit audited system scope. ProductionService immediately narrows
      // each run to its real workspace before invoking any executor.
      await database.runAsSystem('legacy.scheduler.start', async () => {
        await desktopAssetService?.start();
        await videoAutomationService?.start();
        await productionService?.start();
      });
    }
    if (runApi) {
      const app = await createApp(config, fetch, dependencies);
      closeApi = () => app.close();
      app.enableShutdownHooks();
      await app.listen(config.port, config.host ?? '127.0.0.1');
    }
    // A heartbeat means the role is actually serving: all task services and the
    // HTTP listener (when present) have completed startup successfully.
    if (database && stage1RuntimeMigrated) {
      stopRuntimeHeartbeat = await startRuntimeHeartbeat(database, config.runtimeRole);
    }
    const persistence = breakdownService instanceof BreakdownService ? 'PostgreSQL ready' : 'breakdown persistence unavailable';
    const extractFacts = stageRunner ? 'extract-facts ledger ready' : 'extract-facts ledger unavailable';
    const production = productionService ? 'production orchestration ready' : 'production orchestration unavailable';
    const listenHost = config.host ?? '127.0.0.1';
    const endpoint = runApi ? `http://${listenHost}:${config.port}` : 'no HTTP listener';
    console.log(`Lyra ${config.runtimeRole} ready: ${endpoint} (${persistence}, ${extractFacts}, ${production})`);
    if (!runApi) {
      const lifetime = startWorkerProcessLifetime(shutdown);
      await lifetime.done;
    }
  } catch (error) {
    await closeApi?.().catch(() => undefined);
    await shutdown().catch(() => undefined);
    throw error;
  }
}
main().catch(() => {
  console.error('本机后端启动失败：请检查 .env、本机 PostgreSQL 和端口占用。未输出凭据或原始错误。');
  process.exitCode = 1;
});
