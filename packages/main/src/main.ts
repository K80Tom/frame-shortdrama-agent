import { createApp } from './app';
import { readConfig } from './config';
import { resolve } from 'node:path';
import { configForRole, ModelConnections } from './models/connections';
import { PostgresDatabase } from './db/client';
import { readDatabaseConfig } from './db/config';
import { BREAKDOWN_PERSISTENCE_MIGRATIONS, EXTRACT_FACTS_LEDGER_MIGRATIONS } from './db/readiness';
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
import { createConfiguredAssetRetriever } from './assets/vector/runtime';
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
  CandidateProductionExecutor, ComposeProductionExecutor, DEFAULT_FRAME_ASSESSMENT_COST_MICROS,
  DeliveryProductionExecutor, ReviewProductionExecutor,
} from './production/finalization';
import {
  BoundedProcessRunner, FfprobeVideoProber, FrameAssessor, ProductionMediaIngestor, ProductionMediaStore, TimelineComposer,
} from './production-media';
import { ModelClient } from './models/client';
import { PostgresAssistantRepository } from './assistant/postgres-repository';
import { AssistantOrchestrator } from '@lyra/agent';
import { AssistantService } from '@lyra/agent';
import { PostgresEvolutionRepository } from './evolution/postgres-repository';
import { AssetEvolutionService } from './evolution/service';
import { PostgresPromptPackImportRepository, PostgresPromptPackStateRepository } from './prompt-packs/repository';
import { PromptPackService } from './prompt-packs/service';

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
  image: 2_000_000,
  video: 5_000_000,
  frameAssessment: DEFAULT_FRAME_ASSESSMENT_COST_MICROS,
});

async function main() {
  const initial = readConfig();
  const modelConnections = new ModelConnections(initial, resolve('outputs/private/model-connections.json'));
  await modelConnections.initialize();
  const config = Object.freeze({ ...initial, modelConnections });
  const assetVectorConfig = readAssetVectorConfig(process.env);
  const assetRetrieval = assetVectorConfig ? createConfiguredAssetRetriever(assetVectorConfig) : undefined;
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
  let promptPacksService: PromptPackService | undefined;
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
    database = new PostgresDatabase(databaseConfig);
    try {
      await database.verifyConnection();
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
          desktopJobs && assetService ? new DesktopCandidateAssetPolicy(desktopJobs, assetService) : undefined);
      }
      if (novelService && assetService && desktopJobs && await database.hasMigrations(['010'])) {
        desktopAssetService = new DesktopAssetService(desktopJobs,
          new PostgresNovelRepository(database), novelService, assetService,
          new DoubaoImageApiAdapter(() => configForRole(config, 'image')));
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
        && breakdownService instanceof BreakdownService && stageRunner && storyboardService
        && assetService && videoAutomationService) {
        const breakdown = breakdownService;
        const productionRepository = new PostgresProductionRepository(database);
        if (await database.hasMigrations(['019'])) {
          evolutionService = new AssetEvolutionService(productionRepository, new PostgresEvolutionRepository(database));
        }
        if (await database.hasMigrations(['020', '021'])) {
          promptPacksService = new PromptPackService(
            new PostgresPromptPackStateRepository(database),
            new PostgresPromptPackImportRepository(database),
          );
        }
        productionService = new ProductionService(productionRepository, {
          assetRetrievalPolicy: evolutionService ? () => evolutionService!.currentAssetRetrievalPolicy() : undefined,
          sourceCatalog: breakdownService,
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
              frameAssessmentCostMicros: PRODUCTION_COST_CEILINGS.frameAssessment,
              // 合成前的镜头抽帧评估：默认开启，可用 Lyra_FRAME_ASSESSMENT=0 关闭。
              // 开启时按镜头预留费用上限；剩余预算不够则跳过评估并继续合片。
              // 评估器内部失败仍降级为无剪辑指令，但已发起的调用按上限入账。
              ...(process.env.Lyra_FRAME_ASSESSMENT === '0' ? {} : {
                assessFrames: new FrameAssessor(productionMediaStore, mediaRunner,
                  { call: input => new ModelClient(configForRole(config, 'general'), fetch).call(input) },
                  'ffmpeg', { framesPerShot: 2 }),
              }),
            }),
            new DeliveryProductionExecutor(productionMediaStore),
          ],
        });
      }
      // AI 工作区：旧平台「全局 AI 工作区」的本地等价实现。
      // 模型只负责决策与解释；真实数据来自白名单工具，付费只走估价卡确认。
      if (await database.hasMigrations(['018'])) {
        const assistantRepository = new PostgresAssistantRepository(database);
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
    } catch (error) {
      await database.close().catch(() => undefined);
      throw error;
    }
  }
  const app = await createApp(config, fetch, {
    breakdownService,
    stageRunner,
    storyboardService,
    novelService,
    assetService,
    desktopAssetService,
    videoAutomationService,
    productionService,
    productionMediaStore,
    assistantService,
    evolutionService,
    promptPacksService,
    close: async () => {
      await Promise.all([desktopAssetService?.stop(), videoAutomationService?.stop(), productionService?.stop()]);
      await database?.close();
    },
  });
  app.enableShutdownHooks();
  await desktopAssetService?.start();
  await videoAutomationService?.start();
  await productionService?.start();
  await app.listen(config.port, '127.0.0.1');
  const persistence = breakdownService instanceof BreakdownService ? 'PostgreSQL ready' : 'breakdown persistence unavailable';
  const extractFacts = stageRunner ? 'extract-facts ledger ready' : 'extract-facts ledger unavailable';
  const production = productionService ? 'production orchestration ready' : 'production orchestration unavailable';
  console.log(`Local backend ready: http://127.0.0.1:${config.port} (${persistence}, ${extractFacts}, ${production}, local only)`);
}
main().catch(() => {
  console.error('本机后端启动失败：请检查 .env、本机 PostgreSQL 和端口占用。未输出凭据或原始错误。');
  process.exitCode = 1;
});
