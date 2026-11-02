import { createHash } from 'node:crypto';
import { methodReference, MethodReferenceSpaceError } from '../../prompt-packs/runtime';
import type { AssetKind, AssetRecord } from '@lyra/shared';
import {
  retrieveAssetForGeneration,
  type AssetRetrievalResult,
  type AssetRetriever,
} from '../../assets/retrieval';
import type { AssetService } from '../../assets/service';
import type { AppConfig } from '../../config';
import type { PlanEntity, PlanRevisionRecord } from '../../breakdown/plan';
import type { BreakdownServicePort } from '../../breakdown/service';
import type { StoryboardRevision, StoryboardService } from '../../breakdown/storyboard';
import { configForRole } from '../../models/connections';
import {
  DoubaoImageClient,
  type GeneratedImage,
  type MediaClientConfig,
} from '../../models/media-client';
import { canonicalDigest, DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY, type AssetRetrievalPolicy, type StoredProductionRun } from '@lyra/shared';
import type {
  PreparedProductionExecution,
  ProductionExecutionContext,
  ProductionExecutor,
  ProductionExecutorOutcome,
} from '../executor';

const EXECUTOR_VERSION = 'production-assets/4';
const MATCH_RULE_VERSION = 'production-asset-match/5';
const PROMPT_VERSION = 'production-asset-image/1';
const DEFAULT_IMAGE_COST_MICROS = 2_000_000;
const STRUCTURED_RETRIEVER: AssetRetriever = {
  async retrieve(query, assets, policy) { return retrieveAssetForGeneration(query, assets, policy); },
};

type BreakdownReader = Pick<BreakdownServicePort, 'getProject' | 'getPlanRevision'>;
type AssetLibrary = Pick<AssetService, 'list' | 'importImage'>;
type StoryboardReader = Pick<StoryboardService, 'get'>;

export interface ProductionImageGenerator {
  generateImage(input: { prompt: string; size?: string; watermark?: boolean;
    responseFormat?: 'url' | 'b64_json' }): Promise<GeneratedImage>;
}
export type ProductionImageConnection = {
  state: 'configured';
  revision: string;
  model: string;
  clientConfig: MediaClientConfig;
} | {
  state: 'missing';
  revision: string;
  model: string;
  reason: string;
};

export interface AssetsProductionExecutorOptions {
  breakdown: BreakdownReader;
  assets: AssetLibrary;
  storyboards: StoryboardReader;
  /** Resolve at task execution time so a settings change is never silently hidden. */
  config: AppConfig | (() => AppConfig);
  imageClientFactory?: (config: MediaClientConfig) => ProductionImageGenerator;
  /** Optional Milvus + embedding enhancement; exact identity matching still runs first. */
  retrieval?: AssetRetriever;
  /** Upper-bound accounting estimate for one generated image in the run currency. */
  imageCostMicros?: number;
}

interface EntityRef {
  kind: AssetKind;
  entity: PlanEntity;
}

interface LoadedPlan {
  state: 'ready';
  plan: PlanRevisionRecord;
}

interface PlanBlocked {
  state: 'blocked';
  code: string;
  message: string;
}

interface AssetMatch {
  entityId: string;
  kind: AssetKind;
  entityName: string;
  asset: AssetRecord | null;
  matchedBy: 'name' | 'alias' | 'retrieval' | null;
  matchedTerm: string | null;
  ambiguous: boolean;
  alternatives: string[];
  retrieval: AssetRetrievalResult | null;
  ambiguousCandidates: Array<{
    assetId: string;
    name: string;
    resourceUrl: string;
    matchedBy: 'name' | 'alias' | 'retrieval';
    matchedTerm: string;
    score?: number;
  }>;
}

/** Convert the independently selected image connection into the media adapter contract. */
export function resolveProductionImageConnection(config: AppConfig): ProductionImageConnection {
  const selected = configForRole(config, 'image');
  const revision = selected.connectionRevision ?? 'unversioned';
  const model = selected.defaultModel.trim();
  const endpoint = selected.endpointUrl?.trim() ?? '';
  const apiKey = selected.apiKey.trim();
  const authType = selected.authType ?? (selected.provider === 'maas' ? 'api-key' : 'bearer');
  const missing: string[] = [];
  if (!endpoint) missing.push('完整生图接口');
  if (!model) missing.push('生图模型');
  if (!apiKey) missing.push('生图密钥');
  if (authType !== 'api-key' && authType !== 'bearer') missing.push('鉴权方式');
  if (missing.length) return { state: 'missing', revision, model,
    reason: `请先在模型设置中补齐${missing.join('、')}。` };
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.pathname === '/') throw new Error('invalid endpoint');
  } catch {
    return { state: 'missing', revision, model, reason: '生图连接必须使用完整、不含凭据或查询参数的 HTTPS 操作接口。' };
  }
  if (!Number.isInteger(selected.timeoutMs) || selected.timeoutMs < 1_000 || selected.timeoutMs > 600_000) {
    return { state: 'missing', revision, model, reason: '生图连接的超时时间不正确。' };
  }
  return { state: 'configured', revision, model,
    clientConfig: { endpoint, model, apiKey, authType, timeoutMs: selected.timeoutMs,
      allowIntranetMediaSources: config.mediaAllowIntranetSources ?? false } };
}

export class AssetsProductionExecutor implements ProductionExecutor {
  readonly stage = 'assets' as const;
  private readonly clientFactory: (config: MediaClientConfig) => ProductionImageGenerator;
  private readonly imageCostMicros: number;
  private readonly retrieval: AssetRetriever;

  constructor(private readonly options: AssetsProductionExecutorOptions) {
    this.clientFactory = options.imageClientFactory ?? (config => new DoubaoImageClient(config));
    this.retrieval = options.retrieval ?? STRUCTURED_RETRIEVER;
    this.imageCostMicros = options.imageCostMicros ?? DEFAULT_IMAGE_COST_MICROS;
    if (!Number.isSafeInteger(this.imageCostMicros) || this.imageCostMicros < 0) {
      throw new Error('imageCostMicros must be a non-negative safe integer');
    }
  }

  async prepare(context: Omit<ProductionExecutionContext, 'attemptId' | 'inputDigest' | 'operationKey'>): Promise<PreparedProductionExecution> {
    const loaded = await this.loadPlan(context.run);
    const assets = loaded.state === 'ready' ? await this.options.assets.list() : [];
    const semantic = this.retrieval.semanticProvider;
    const retrievalManifest = semantic ? { model: semantic.model, revision: semantic.revision } : null;
    if (context.task.scope.kind === 'episode') {
      const refs = loaded.state === 'ready' ? allEntities(loaded.plan) : [];
      const queryCount = this.semanticQueryCount(refs, assets);
      return { executor: EXECUTOR_VERSION, inputDigest: canonicalDigest({ rule: MATCH_RULE_VERSION,
        run: frozenRunInput(context.run), plan: loaded.state === 'ready' ? loaded.plan : loaded,
        assets: assetManifest(assets), retrieval: retrievalManifest }),
        estimateCostMicros: this.embeddingEstimate(queryCount), requiresPaid: false, provider: null };
    }
    if (context.task.scope.kind === 'shot') {
      const storyboard = loaded.state === 'ready' ? await this.loadStoryboard(context.run) : null;
      const refs = loaded.state === 'ready' && storyboard?.state === 'ready'
        ? shotEntities(loaded.plan, storyboard.storyboard, context.task.scope.id) : [];
      const queryCount = this.semanticQueryCount(refs, assets);
      return { executor: EXECUTOR_VERSION, inputDigest: canonicalDigest({ rule: MATCH_RULE_VERSION,
        run: frozenRunInput(context.run), planId: loaded.state === 'ready' ? loaded.plan.id : null,
        storyboard: storyboard?.state === 'ready' ? storyboard.storyboard : storyboard,
        shotId: context.task.scope.id, assets: assetManifest(assets), retrieval: retrievalManifest }),
        estimateCostMicros: this.embeddingEstimate(queryCount), requiresPaid: false, provider: null };
    }
    const ref = loaded.state === 'ready' && context.task.scope.kind === 'asset'
      ? findEntity(loaded.plan, context.task.scope.id) : null;
    // Vector preparation never calls a paid embedding provider. Structured
    // lexical retrieval remains local; hybrid mode reserves an upper bound
    // from exact identity and queries only after the durable budget claim.
    const match = ref
      ? semantic ? exactAssetMatch(ref, assets) : await matchOne(ref, assets, this.retrieval, retrievalPolicy(context.run))
      : null;
    const connection = resolveProductionImageConnection(this.currentConfig());
    const canGenerate = Boolean(ref && !match?.asset && !match?.ambiguous && connection.state === 'configured');
    const queryCount = this.semanticQueryCount(ref ? [ref] : [], assets);
    return {
      executor: EXECUTOR_VERSION,
      inputDigest: canonicalDigest({ rule: PROMPT_VERSION, run: frozenRunInput(context.run),
        planId: loaded.state === 'ready' ? loaded.plan.id : null, entity: ref,
        methodReference: ref?.kind === 'character' ? methodReference(context.run.methodPacks, 'character-image') || undefined : undefined,
        match: match ? { assetId: match.asset?.id ?? null, matchedBy: match.matchedBy,
          ambiguous: match.ambiguous, alternatives: match.alternatives } : null,
        retrieval: retrievalManifest, imageConnection: connectionManifest(connection) }),
      estimateCostMicros: this.embeddingEstimate(queryCount) + (canGenerate ? this.imageCostMicros : 0),
      requiresPaid: canGenerate,
      provider: canGenerate && connection.state === 'configured' ? `image:${connection.model}` : null,
    };
  }

  async execute(context: ProductionExecutionContext): Promise<ProductionExecutorOutcome> {
    const loaded = await this.loadPlan(context.run);
    if (loaded.state === 'blocked') return blocked(loaded.code, loaded.message);
    if (context.task.scope.kind === 'episode') return this.matchEpisode(context, loaded.plan);
    if (context.task.scope.kind === 'shot') return this.bindShot(context, loaded.plan, context.task.scope.id);
    if (context.task.scope.kind !== 'asset') {
      return blocked('ASSET_SCOPE_UNSUPPORTED', '资产执行器只接受整集或资产范围任务。');
    }
    return this.fillAsset(context, loaded.plan, context.task.scope.id);
  }

  private async bindShot(context: ProductionExecutionContext, plan: PlanRevisionRecord, shotId: string): Promise<ProductionExecutorOutcome> {
    const board = await this.loadStoryboard(context.run);
    if (board.state === 'blocked') return blocked(board.code, board.message);
    const shot = board.storyboard.shots.find(item => item.id === shotId);
    if (!shot) return blocked('ASSET_SHOT_STALE', '该镜头已不存在于当前采用的分镜版本中。');
    const scene = plan.content.scenes.find(item => item.id === shot.sceneId);
    if (!scene) return blocked('ASSET_SCENE_STALE', '分镜引用的场次已不存在于当前事实计划中。');
    const relevant = shotEntities(plan, board.storyboard, shotId);
    const assets = await this.options.assets.list();
    const matches = await matchEntities(relevant, assets, this.retrieval, retrievalPolicy(context.run));
    const embeddingCost = this.embeddingActualCost(matches);
    const ambiguous = matches.filter(item => item.ambiguous);
    const missing = matches.filter(item => !item.asset && !item.ambiguous);
    const report = { schemaVersion: MATCH_RULE_VERSION, planRevisionId: plan.id,
      storyboardRevisionId: board.storyboard.id, shotId, sceneId: scene.id,
      bindings: matches.map(publicMatch), missingEntityIds: missing.map(item => item.entityId),
      ambiguousEntityIds: ambiguous.map(item => item.entityId) };
    if (ambiguous.length) return { state: 'blocked', actualCostMicros: embeddingCost,
      artifacts: [{ key: 'shot-asset-bindings', kind: 'report',
      title: `镜头资产绑定·${scene.order}-${shot.order}`, metadata: report }], qualityChecks: [{ level: 'shot',
        result: 'fail', ruleVersion: MATCH_RULE_VERSION, summary: `镜头有 ${ambiguous.length} 项资产存在同优先级候选，未自动选择。`,
        issues: ambiguous.map(item => `${kindLabel(item.kind)}「${item.entityName}」匹配到 ${item.ambiguousCandidates.length} 个同优先级资产`) }], issue: {
        code: 'SHOT_ASSET_BINDINGS_AMBIGUOUS', title: '镜头资产存在同名歧义', severity: 'error',
        message: ambiguousMessage(ambiguous, '镜头'), impact: [context.task.label, '后续 3D 预演和视频'],
        recommendedActions: ['为候选资产使用可区分的名称，并在事实计划中保留一个唯一名称或别名匹配', '完成后局部重试本镜头资产任务'],
      } };
    if (missing.length) return { state: 'blocked', actualCostMicros: embeddingCost,
      artifacts: [{ key: 'shot-asset-bindings', kind: 'report',
      title: `镜头资产绑定·${scene.order}-${shot.order}`, metadata: report }], issue: {
        code: 'SHOT_ASSET_BINDINGS_MISSING', title: '镜头资产不完整', severity: 'error',
        message: `镜头仍缺少 ${missing.length} 项已确认实体的资产，不会在生视频时猜测。`,
        impact: [context.task.label, '后续 3D 预演和视频'], recommendedActions: ['局部重试对应的实体资产子任务'],
      } };
    return { state: 'succeeded', actualCostMicros: embeddingCost,
      artifacts: [{ key: 'shot-asset-bindings', kind: 'report',
      title: `镜头资产绑定·${scene.order}-${shot.order}`, metadata: report }],
      qualityChecks: [{ level: 'shot', result: 'pass', ruleVersion: MATCH_RULE_VERSION,
        summary: `镜头已确定性引用 ${matches.length} 项资产，无缺失或模糊匹配。` }] };
  }

  private async matchEpisode(context: ProductionExecutionContext, plan: PlanRevisionRecord): Promise<ProductionExecutorOutcome> {
    const assets = await this.options.assets.list();
    const matches = await matchEntities(allEntities(plan), assets, this.retrieval, retrievalPolicy(context.run));
    const embeddingCost = this.embeddingActualCost(matches);
    const ambiguous = matches.filter(item => item.ambiguous);
    const missing = matches.filter(item => !item.asset && !item.ambiguous);
    const report = { key: 'asset-binding-report', kind: 'report' as const, title: '资产匹配与补齐清单', metadata: {
      schemaVersion: MATCH_RULE_VERSION, planRevisionId: plan.id,
      matchedCount: matches.filter(item => Boolean(item.asset)).length, missingCount: missing.length,
      ambiguousCount: ambiguous.length, bindings: matches.map(publicMatch),
    } };
    if (ambiguous.length) return {
      state: 'blocked', actualCostMicros: embeddingCost, artifacts: [report], qualityChecks: [{ level: 'episode', result: 'fail',
        ruleVersion: MATCH_RULE_VERSION, summary: `${ambiguous.length} 项实体存在同优先级资产候选，未自动选择，也未当作缺失生成。`,
        issues: ambiguous.map(item => `${kindLabel(item.kind)}「${item.entityName}」匹配到 ${item.ambiguousCandidates.length} 个同优先级资产`) }],
      issue: { code: 'ASSET_MATCH_AMBIGUOUS', title: '资产匹配存在同名歧义', severity: 'error',
        message: ambiguousMessage(ambiguous, '整集'), impact: [context.task.label, '分镜资产绑定和后续视频生成'],
        recommendedActions: ['为候选资产使用可区分的名称，并在事实计划中保留一个唯一名称或别名匹配', '完成后局部重试资产准备任务'] },
    };
    return {
      state: 'succeeded', actualCostMicros: embeddingCost,
      artifacts: [report],
      qualityChecks: [{ level: 'episode', result: 'pass', ruleVersion: MATCH_RULE_VERSION,
        summary: missing.length ? `已确定匹配 ${matches.length - missing.length} 项，${missing.length} 项已展开为待补齐子任务。`
          : `剧本中 ${matches.length} 项实体均已确定性绑定现有资产。` }],
      spawnTasks: missing.map(item => ({ key: `asset-${item.kind}-${item.entityId}`, stage: 'assets' as const,
        label: `补齐${kindLabel(item.kind)}·${item.entityName}`, scope: { kind: 'asset' as const, id: item.entityId } })),
    };
  }

  private async fillAsset(context: ProductionExecutionContext, plan: PlanRevisionRecord, entityId: string): Promise<ProductionExecutorOutcome> {
    const ref = findEntity(plan, entityId);
    if (!ref) return blocked('ASSET_ENTITY_STALE', '待补齐实体已不存在于当前采用的剧本拆解中。');
    // Re-read immediately before the paid call. Another task or the user may have filled it meanwhile.
    const existing = await matchOne(ref, await this.options.assets.list(), this.retrieval, retrievalPolicy(context.run));
    const embeddingCost = this.embeddingActualCost([existing]);
    if (existing.ambiguous) return { state: 'blocked', actualCostMicros: embeddingCost,
      artifacts: [{ key: `asset-match-${ref.entity.id}`,
      kind: 'report', title: `${kindLabel(ref.kind)}·${ref.entity.name.value} 匹配歧义`, metadata: publicMatch(existing) }],
      qualityChecks: [{ level: 'episode', result: 'fail', ruleVersion: MATCH_RULE_VERSION,
        summary: `${kindLabel(ref.kind)}「${ref.entity.name.value}」存在同优先级候选，未发起生图。`,
        issues: existing.ambiguousCandidates.map(item => `${item.assetId} · ${item.name}`) }], issue: {
        code: 'ASSET_MATCH_AMBIGUOUS', title: '资产匹配存在同名歧义', severity: 'error',
        message: ambiguousMessage([existing], '资产补齐'), impact: [context.task.label, '后续镜头资产绑定'],
        recommendedActions: ['为候选资产使用可区分的名称，并在事实计划中保留一个唯一名称或别名匹配', '完成后局部重试本资产任务'],
      } };
    if (existing.asset) return reuseOutcome(plan, existing, embeddingCost);

    const connection = resolveProductionImageConnection(this.currentConfig());
    if (connection.state === 'missing') {
      return blocked('IMAGE_MODEL_NOT_CONFIGURED', connection.reason, ['在模型设置中选择生图连接', '配置后对本资产任务局部重试'], embeddingCost);
    }
    // The service reserves budget and creates the no-replay external operation
    // from prepare(). A newly configured/different connection must therefore
    // stop here and be retried instead of spending outside that durable claim.
    const currentPreparation = await this.prepare({ run: context.run, task: context.task });
    if (!context.operationKey || !currentPreparation.requiresPaid || currentPreparation.inputDigest !== context.inputDigest) {
      return blocked('IMAGE_MODEL_SELECTION_CHANGED', '生图连接或任务输入在执行准备后发生了变化，未发起付费请求。',
        ['对本资产任务局部重试，以新配置重新冻结输入与预算'], embeddingCost);
    }
    const basePrompt = assetPrompt(ref, context.run.visualStyle);
    let prompt = basePrompt;
    if (ref.kind === 'character') {
      try { prompt += methodReference(context.run.methodPacks, 'character-image', Math.min(8000, 32_000 - basePrompt.length)); }
      catch (error) {
        if (error instanceof MethodReferenceSpaceError) return blocked('PROMPT_PACK_INPUT_LIMIT', error.message,
          ['缩短资产描述或减少方法包后创建新运行'], embeddingCost);
        throw error;
      }
    }
    const generated = await this.clientFactory(connection.clientConfig).generateImage({
      prompt, size: '2K', responseFormat: 'b64_json', watermark: false,
    });
    const description = importDescription(ref, plan, context.run.visualStyle, connection.model);
    const saved = await this.options.assets.importImage({ kind: ref.kind, name: ref.entity.name.value,
      description, contentBase64: generated.bytes.toString('base64') });
    const sha256 = createHash('sha256').update(generated.bytes).digest('hex');
    return {
      state: 'succeeded', actualCostMicros: embeddingCost + this.imageCostMicros,
      artifacts: [{ key: `asset-${ref.entity.id}`, kind: 'image', title: `${kindLabel(ref.kind)}·${ref.entity.name.value}`,
        uri: saved.resourceUrl, sha256, metadata: { assetId: saved.id, entityId: ref.entity.id, entityKind: ref.kind,
          planRevisionId: plan.id, promptVersion: PROMPT_VERSION, model: connection.model,
          modelConnectionRevision: connection.revision, providerSource: generated.source, generated: true } }],
      qualityChecks: [{ level: 'episode', result: 'pass', ruleVersion: 'asset-image-container/1',
        summary: '生成图片已通过服务端容器、尺寸与哈希校验，并导入独立资产库。' }],
    };
  }

  private semanticQueryCount(refs: EntityRef[], assets: AssetRecord[]): number {
    if (!this.retrieval.semanticProvider) return 0;
    return refs.filter(ref => !exactAssetMatch(ref, assets)).length;
  }

  private embeddingEstimate(queryCount: number): number {
    return queryCount * (this.retrieval.semanticProvider?.queryCostMicros ?? 0);
  }

  private embeddingActualCost(matches: AssetMatch[]): number {
    const attempted = matches.filter(match => match.retrieval?.semantic.attempted).length;
    return this.embeddingEstimate(attempted);
  }

  private currentConfig(): AppConfig { return typeof this.options.config === 'function' ? this.options.config() : this.options.config; }

  private async loadPlan(run: Readonly<StoredProductionRun>): Promise<LoadedPlan | PlanBlocked> {
    try {
      const project = await this.options.breakdown.getProject(run.projectId);
      if (project.currentScriptVersionId !== run.scriptVersionId) return { state: 'blocked', code: 'PRODUCTION_SCRIPT_STALE',
        message: '项目当前剧本已变更，本次生产固定的剧本版本已过期。' };
      if (!project.activePlanRevisionId) return { state: 'blocked', code: 'ADOPTED_FACTS_REQUIRED',
        message: '当前剧本还没有已采用的事实拆解，无法匹配资产。' };
      const plan = await this.options.breakdown.getPlanRevision(project.activePlanRevisionId);
      if (plan.projectId !== run.projectId || plan.scriptVersionId !== run.scriptVersionId) {
        return { state: 'blocked', code: 'ADOPTED_FACTS_STALE', message: '已采用的事实拆解与本次生产的剧本版本不匹配。' };
      }
      return { state: 'ready', plan };
    } catch {
      return { state: 'blocked', code: 'ADOPTED_FACTS_UNAVAILABLE', message: '无法读取已采用的事实拆解，未发起资产生成。' };
    }
  }

  private async loadStoryboard(run: Readonly<StoredProductionRun>): Promise<{ state: 'ready'; storyboard: StoryboardRevision } | PlanBlocked> {
    try {
      const project = await this.options.breakdown.getProject(run.projectId);
      if (!project.activeStoryboardRevisionId) return { state: 'blocked', code: 'ADOPTED_STORYBOARD_REQUIRED',
        message: '请先采用与当前剧本匹配的分镜。' };
      const storyboard = await this.options.storyboards.get(project.activeStoryboardRevisionId);
      if (storyboard.projectId !== run.projectId || storyboard.scriptVersionId !== run.scriptVersionId
        || storyboard.sourcePlanRevisionId !== project.activePlanRevisionId) {
        return { state: 'blocked', code: 'ADOPTED_STORYBOARD_STALE',
          message: '已采用的分镜与本次生产的剧本或事实计划不匹配。' };
      }
      return { state: 'ready', storyboard };
    } catch {
      return { state: 'blocked', code: 'ADOPTED_STORYBOARD_UNAVAILABLE',
        message: '无法读取已采用分镜，未绑定镜头资产。' };
    }
  }
}

function retrievalPolicy(run: Readonly<StoredProductionRun>): AssetRetrievalPolicy {
  return run.assetRetrievalPolicy ?? DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY;
}

function frozenRunInput(run: Readonly<StoredProductionRun>) {
  return { projectId: run.projectId, scriptVersionId: run.scriptVersionId, visualStyle: run.visualStyle,
    ratio: run.ratio, qualityPreset: run.qualityPreset, workflowVersion: run.workflowVersion,
    assetRetrievalPolicy: run.assetRetrievalPolicy ?? DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY };
}

function allEntities(plan: PlanRevisionRecord): EntityRef[] {
  return [
    ...plan.content.characters.map(entity => ({ kind: 'character' as const, entity })),
    ...plan.content.locations.map(entity => ({ kind: 'location' as const, entity })),
    ...plan.content.props.map(entity => ({ kind: 'prop' as const, entity })),
  ];
}

function findEntity(plan: PlanRevisionRecord, id: string): EntityRef | null {
  return allEntities(plan).find(item => item.entity.id === id) ?? null;
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s·•・　]+/gu, '');
}

function exactAssetMatch(ref: EntityRef, assets: AssetRecord[]): AssetMatch | null {
  const primary = normalized(ref.entity.name.value);
  const aliasEntries: Array<[string, string]> = ref.entity.aliases.map(item => [normalized(item.value), item.value]);
  const aliases = new Map(aliasEntries.filter(([key]) => Boolean(key)));
  const ranked: Array<{ asset: AssetRecord; rank: number; matchedBy: 'name' | 'alias'; matchedTerm: string }> = [];
  for (const asset of assets.filter(asset => asset.kind === ref.kind)) {
    const value = normalized(asset.name);
    if (primary && value === primary) ranked.push({ asset, rank: 2, matchedBy: 'name', matchedTerm: ref.entity.name.value });
    else {
      const alias = aliases.get(value);
      if (alias) ranked.push({ asset, rank: 1, matchedBy: 'alias', matchedTerm: alias });
    }
  }
  ranked.sort((left, right) => right.rank - left.rank
    || right.asset.createdAt.localeCompare(left.asset.createdAt) || left.asset.id.localeCompare(right.asset.id));
  const winner = ranked[0];
  const topRank = winner?.rank ?? null;
  const top = topRank === null ? [] : ranked.filter(item => item.rank === topRank);
  if (!winner) return null;
  const ambiguous = top.length > 1;
  return { entityId: ref.entity.id, kind: ref.kind, entityName: ref.entity.name.value,
    asset: ambiguous ? null : winner.asset,
    matchedBy: winner.matchedBy, matchedTerm: winner.matchedTerm, ambiguous, retrieval: null,
    alternatives: (ambiguous ? top : ranked.slice(1)).map(item => item.asset.id),
    ambiguousCandidates: ambiguous ? top.map(item => ({ assetId: item.asset.id, name: item.asset.name,
      resourceUrl: item.asset.resourceUrl, matchedBy: item.matchedBy, matchedTerm: item.matchedTerm })) : [] };
}

async function matchOne(ref: EntityRef, assets: AssetRecord[], retriever: AssetRetriever, policy: AssetRetrievalPolicy): Promise<AssetMatch> {
  const exact = exactAssetMatch(ref, assets);
  if (exact) return exact;
  const retrieval = await retriever.retrieve({
    kind: ref.kind, name: ref.entity.name.value, aliases: ref.entity.aliases.map(item => item.value),
    description: ref.entity.description?.value ?? '', sourceQuotes: sourceQuotes(ref.entity),
  }, assets, policy);
  const best = retrieval.candidates[0];
  const ambiguous = retrieval.status === 'ambiguous';
  const matched = retrieval.status === 'unique' || ambiguous;
  return { entityId: ref.entity.id, kind: ref.kind, entityName: ref.entity.name.value,
    asset: retrieval.asset, matchedBy: matched ? 'retrieval' : null,
    matchedTerm: matched ? best?.matchedTerms[0] ?? ref.entity.description?.value ?? ref.entity.name.value : null,
    ambiguous, retrieval,
    alternatives: ambiguous ? retrieval.ambiguousCandidates.map(item => item.asset.id)
      : retrieval.asset ? retrieval.candidates.slice(1).map(item => item.asset.id) : [],
    ambiguousCandidates: retrieval.ambiguousCandidates.map(item => ({ assetId: item.asset.id, name: item.asset.name,
      resourceUrl: item.asset.resourceUrl, matchedBy: 'retrieval' as const,
      matchedTerm: item.matchedTerms[0] ?? ref.entity.name.value, score: item.score })) };
}

async function matchEntities(refs: EntityRef[], assets: AssetRecord[], retriever: AssetRetriever, policy: AssetRetrievalPolicy): Promise<AssetMatch[]> {
  const matches: AssetMatch[] = [];
  // Sequential query embeddings avoid an unbounded provider burst per episode.
  for (const ref of refs) matches.push(await matchOne(ref, assets, retriever, policy));
  return matches;
}

function shotEntities(plan: PlanRevisionRecord, storyboard: StoryboardRevision, shotId: string): EntityRef[] {
  const shot = storyboard.shots.find(item => item.id === shotId);
  if (!shot) return [];
  const scene = plan.content.scenes.find(item => item.id === shot.sceneId);
  if (!scene) return [];
  const relevant: EntityRef[] = [];
  if (scene.locationId) {
    const location = plan.content.locations.find(item => item.id === scene.locationId);
    if (location) relevant.push({ kind: 'location', entity: location });
  }
  for (const id of scene.characterIds) {
    const character = plan.content.characters.find(item => item.id === id);
    if (character) relevant.push({ kind: 'character', entity: character });
  }
  // The v0.1 fact plan has no explicit scene.propIds yet. Source overlap is
  // therefore the only conservative, explainable way to bind props to a shot.
  for (const prop of plan.content.props) {
    if (prop.sourceRefs.some(ref => shot.sourceRefs.some(shotRef => ref.scriptVersionId === shotRef.scriptVersionId
      && ref.start < shotRef.end && shotRef.start < ref.end))) relevant.push({ kind: 'prop', entity: prop });
  }
  return relevant;
}

function assetManifest(assets: AssetRecord[]) {
  return assets.map(asset => ({ id: asset.id, kind: asset.kind, name: asset.name,
    description: asset.description, createdAt: asset.createdAt }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function connectionManifest(connection: ProductionImageConnection) {
  return connection.state === 'missing'
    ? { state: connection.state, revision: connection.revision, model: connection.model, reason: connection.reason }
    : { state: connection.state, revision: connection.revision, model: connection.model,
      endpoint: connection.clientConfig.endpoint, authType: connection.clientConfig.authType,
      timeoutMs: connection.clientConfig.timeoutMs,
      credentialDigest: createHash('sha256').update(connection.clientConfig.apiKey).digest('hex') };
}

function publicMatch(match: AssetMatch) {
  return { entityId: match.entityId, kind: match.kind, entityName: match.entityName,
    assetId: match.asset?.id ?? null, resourceUrl: match.asset?.resourceUrl ?? null,
    matchedBy: match.matchedBy, matchedTerm: match.matchedTerm, ambiguous: match.ambiguous,
    alternatives: match.alternatives, ambiguousCandidates: match.ambiguousCandidates,
    retrieval: match.retrieval ? publicRetrieval(match.retrieval) : null };
}

function publicRetrieval(result: AssetRetrievalResult) {
  return { ruleVersion: result.ruleVersion, mode: result.mode, status: result.status,
    score: result.score, threshold: result.threshold, ambiguityMargin: result.ambiguityMargin,
    semantic: result.semantic,
    candidates: result.candidates.map(candidate => ({ assetId: candidate.asset.id, name: candidate.asset.name,
      score: candidate.score, lexicalScore: candidate.lexicalScore ?? null, semanticScore: candidate.semanticScore ?? null,
      matchedFields: candidate.matchedFields, matchedTerms: candidate.matchedTerms })) };
}

function ambiguousMessage(matches: AssetMatch[], scope: string): string {
  const details = matches.map(match => `${kindLabel(match.kind)}「${match.entityName}」有 ${match.ambiguousCandidates.length} 个同优先级候选`).join('；');
  return `${scope}资产匹配无法唯一确定：${details}。系统没有按创建时间猜选，也不会把歧义当作缺失再生成。`;
}

function blocked(code: string, message: string, recommendedActions: string[] = ['检查上游版本后局部重试'],
  actualCostMicros = 0): ProductionExecutorOutcome {
  return { state: 'blocked', actualCostMicros,
    issue: { code, title: '资产阶段已停止', message, severity: 'error', recommendedActions } };
}

function reuseOutcome(plan: PlanRevisionRecord, match: AssetMatch, actualCostMicros = 0): ProductionExecutorOutcome {
  const asset = match.asset!;
  const retrieved = match.matchedBy === 'retrieval' && match.retrieval;
  return { state: 'succeeded', actualCostMicros, artifacts: [{ key: `asset-${match.entityId}`, kind: 'image',
    title: `${kindLabel(match.kind)}·${match.entityName}`, uri: asset.resourceUrl, metadata: {
      assetId: asset.id, entityId: match.entityId, entityKind: match.kind, planRevisionId: plan.id,
      generated: false, matchedBy: match.matchedBy, matchedTerm: match.matchedTerm,
      retrieval: match.retrieval ? publicRetrieval(match.retrieval) : null,
    } }], qualityChecks: [{ level: 'episode', result: 'pass', ruleVersion: MATCH_RULE_VERSION,
      summary: retrieved ? `RAG 检索命中并复用「${asset.name}」（相关性 ${match.retrieval!.score}），未发起生图。`
        : `已复用资产库中的「${asset.name}」。` }] };
}

function kindLabel(kind: AssetKind): string {
  return kind === 'character' ? '角色' : kind === 'location' ? '场景' : '道具';
}

function limited(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : `${points.slice(0, max - 1).join('')}…`;
}

function sourceQuotes(entity: PlanEntity): string[] {
  const seen = new Set<string>(); const result: string[] = [];
  for (const ref of entity.sourceRefs) {
    const quote = limited(ref.quote.trim(), 1200);
    if (quote && !seen.has(quote)) { seen.add(quote); result.push(quote); }
    if (result.length === 6) break;
  }
  return result;
}

function assetPrompt(ref: EntityRef, visualStyle: string): string {
  const facts = { kind: kindLabel(ref.kind), name: ref.entity.name.value,
    aliases: ref.entity.aliases.map(item => item.value), description: ref.entity.description?.value ?? null,
    sourceQuotes: sourceQuotes(ref.entity) };
  const composition = ref.kind === 'character' ? '单人全身角色设定图，站姿自然，无文字，背景简洁，不添加其他人物'
    : ref.kind === 'location' ? '无人场景设定图，完整展示空间结构和光线，无文字'
      : '单一道具设定图，物体完整、比例清晰，中性背景，无文字';
  return limited(`为短剧制作一张${kindLabel(ref.kind)}资产图。\n构图要求：${composition}。\n统一视觉风格：${visualStyle}。\n下列 JSON 是已核对的剧本事实，必须忠实使用，不得增加新身份、剧情或文字：\n${JSON.stringify(facts)}`, 30_000);
}

function importDescription(ref: EntityRef, plan: PlanRevisionRecord, visualStyle: string, model: string): string {
  const source = ref.entity.description?.value ?? sourceQuotes(ref.entity)[0] ?? '剧本中已确认的实体';
  return limited(`全流程自动制片生成；事实来自计划 ${plan.id}：${source}。视觉风格：${visualStyle}。生图模型：${model}。`, 1_900);
}
