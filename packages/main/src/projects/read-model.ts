import {
  DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY,
  PROJECT_ASSET_MATCH_RULE_VERSION,
  type AssetRecord,
  type ProjectAssetRequirementsResponse,
  type ProjectFlowSection,
  type ProjectTodo,
  type ProjectWorkspaceOverview,
} from '@lyra/shared';
import { FACT_CHECK_RULE_VERSION, type PlanCheckRecord } from '../breakdown/quality';
import type { PlanRevisionRecord } from '../breakdown/plan';
import type { BreakdownServicePort } from '../breakdown/service';
import type { BreakdownRunRecord } from '../breakdown/repository';
import type { ScriptVersionSummary } from '../breakdown/repository';
import type { StoryboardRevision } from '../breakdown/storyboard';
import type { AssetRetriever } from '../assets/retrieval';
import { retrieveAssetForGeneration } from '../assets/retrieval';
import {
  matchEntities,
  MATCH_RULE_VERSION,
  type AssetMatch,
  type EntityRef,
} from '../production/executors/assets';

export interface ProjectStoryboardReader {
  list(projectId: string): Promise<StoryboardRevision[]>;
}
export interface ProjectAssetLibrary {
  list(): Promise<AssetRecord[]>;
}

export interface ProjectWorkspaceReadModelOptions {
  breakdown: BreakdownServicePort;
  /** 阶段 1 无分镜服务时按零值处理；不得 runAsSystem。 */
  storyboards?: ProjectStoryboardReader | null;
  assets?: ProjectAssetLibrary | null;
  /** 默认纯词法检索，不触发模型/付费；workspaceId 只能由服务端上下文派生。 */
  retriever?: AssetRetriever;
  /** 服务端派生的租户 workspace；禁止读取请求体传入的 workspace。 */
  workspaceId?: () => string | undefined;
}

type NextAction = NonNullable<ProjectWorkspaceOverview['nextAction']>;

/**
 * 阶段优先级（冻结契约 §5.1，严格按序）：
 * 无剧本 → 有剧本无 Run → 候选未采用/检查未过 → 资产缺口 → 分镜未采用 →
 * 已采用分镜无制作运行 → 有待办 → 有交付 → 否则 null。
 */
export interface WorkflowState {
  hasScript: boolean;
  hasRuns: boolean;
  adoptedPlan: PlanRevisionRecord | null;
  freshAdoptedPlan: boolean;
  /** 当前剧本版本上「未采用」的最新候选（已是 activePlan 时为 null）。 */
  latestCandidate: PlanRevisionRecord | null;
  latestCheck: PlanCheckRecord | null;
  openIssueCount: number;
  assets: { missing: number; ambiguous: number };
  boards: { adopted: StoryboardRevision | null; freshAdopted: boolean; unadoptedCandidates: number; candidateCount: number };
  hasProductionRun: boolean;
  todos: ProjectTodo[];
  deliveryAvailable: boolean;
}

export function decideNextAction(state: WorkflowState): NextAction | null {
  if (!state.hasScript) {
    return { id: 'add-script', label: '添加剧本', detail: '先保存一版原文，再开始拆解事实。', section: 'script' };
  }
  if (!state.hasRuns) {
    return { id: 'start-breakdown', label: '开始拆解', detail: '为当前剧本创建并运行事实拆解。', section: 'script' };
  }
  // 优先级解耦：无论是否已采用过旧/新鲜事实，只要当前剧本存在未采用的新候选，
  // 都先回到「核对/采用事实」，不被 freshAdoptedPlan 挡住。
  if (state.latestCandidate) {
    const checkPassed = Boolean(state.latestCheck && state.latestCheck.result === 'passed'
      && state.latestCheck.ruleVersion === FACT_CHECK_RULE_VERSION);
    if (!checkPassed) {
      return { id: 'review-facts', label: '核对事实候选', detail: state.latestCheck
        ? `候选事实存在 ${state.openIssueCount} 项待处理问题，请核对后重新校验。`
        : '候选事实尚未运行程序校验，请核对原文证据后校验。', section: 'script' };
    }
    return { id: 'adopt-facts', label: '采用事实版本', detail: '校验已通过，人工核对语义后采用这版事实。', section: 'script' };
  }
  if (!state.freshAdoptedPlan) {
    return { id: 'review-facts', label: '查看拆解运行', detail: '拆解运行尚未产出候选，请查看运行记录。', section: 'script' };
  }
  if (state.assets.missing > 0 || state.assets.ambiguous > 0) {
    return { id: 'resolve-assets', label: '处理资产缺口', detail: `缺 ${state.assets.missing} 项、歧义 ${state.assets.ambiguous} 项；同优先级候选不会自动选中。`, section: 'assets' };
  }
  // 只有「存在候选且未采用」才引导采用；没有任何候选时落到生成/制作动作，文案不误导。
  if (state.boards.candidateCount > 0 && !state.boards.freshAdopted) {
    return { id: 'adopt-storyboard', label: '采用分镜版本', detail: '核对镜头、景别与原文证据后采用；旧事实产生的候选不能直接采用。', section: 'storyboard' };
  }
  if (!state.hasProductionRun) {
    return { id: 'create-production', label: '进入制作', detail: '事实与分镜已就绪，可以开始自动制作。', section: 'production' };
  }
  if (state.todos.length > 0) {
    return { id: 'handle-todos', label: '处理待办', detail: `还有 ${state.todos.length} 项待办需要处理。`, section: 'production' };
  }
  if (state.deliveryAvailable) {
    return { id: 'view-delivery', label: '查看交付', detail: '项目已有交付物可查看。', section: 'production' };
  }
  return null;
}

function allEntities(plan: PlanRevisionRecord): EntityRef[] {
  return [
    ...plan.content.characters.map(entity => ({ kind: 'character' as const, entity })),
    ...plan.content.locations.map(entity => ({ kind: 'location' as const, entity })),
    ...plan.content.props.map(entity => ({ kind: 'prop' as const, entity })),
  ];
}

/** 与生产执行器一致的保守归属规则：人物/地点按场次声明，道具按原文引用重叠。 */
function sceneIdsOf(plan: PlanRevisionRecord, entityId: string, kind: EntityRef['kind']): string[] {
  const sceneIds: string[] = [];
  for (const scene of plan.content.scenes) {
    if (kind === 'character' && scene.characterIds.includes(entityId)) sceneIds.push(scene.id);
    else if (kind === 'location' && scene.locationId === entityId) sceneIds.push(scene.id);
  }
  if (kind === 'prop') {
    const prop = plan.content.props.find(item => item.id === entityId);
    if (prop) {
      for (const scene of plan.content.scenes) {
        const overlap = prop.sourceRefs.some(ref => scene.sourceRefs.some(sceneRef =>
          ref.scriptVersionId === sceneRef.scriptVersionId && ref.start < sceneRef.end && sceneRef.start < ref.end));
        if (overlap) sceneIds.push(scene.id);
      }
    }
  }
  return sceneIds;
}

function latestCheckOf(checks: PlanCheckRecord[]): PlanCheckRecord | null {
  return checks
    .filter(check => check.ruleVersion === FACT_CHECK_RULE_VERSION)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

function maxTime(...values: Array<string | null>): string | null {
  const valid = values.filter((value): value is string => Boolean(value));
  return valid.length ? valid.sort().at(-1)! : null;
}

export class ProjectWorkspaceReadModel {
  private readonly retriever: AssetRetriever;
  constructor(private readonly options: ProjectWorkspaceReadModelOptions) {
    this.retriever = options.retriever ?? {
      retrieve: (query, assets, policy) => Promise.resolve(retrieveAssetForGeneration(query, assets, policy)),
    };
  }

  async overview(projectId: string): Promise<ProjectWorkspaceOverview> {
    // getProject 在仓储不存在/跨 workspace 时抛 404 PROJECT_NOT_FOUND，与不存在同形。
    const project = await this.options.breakdown.getProject(projectId);
    const [versions, runs, plans] = await Promise.all([
      this.options.breakdown.listScriptVersions(projectId),
      this.options.breakdown.listRuns(projectId),
      this.options.breakdown.listProjectPlanRevisions(projectId),
    ]);
    const currentScript = project.currentScriptVersionId
      ? versions.find(version => version.id === project.currentScriptVersionId) ?? null
      : null;

    const adoptedPlan = project.activePlanRevisionId
      ? await this.options.breakdown.getPlanRevision(project.activePlanRevisionId)
      : null;
    const freshAdoptedPlan = Boolean(adoptedPlan && project.currentScriptVersionId
      && adoptedPlan.scriptVersionId === project.currentScriptVersionId);
    const latestCandidate = plans
      .filter(plan => plan.scriptVersionId === project.currentScriptVersionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1) ?? null;

    let latestCheck: PlanCheckRecord | null = null;
    let openIssueCount = 0;
    if (latestCandidate) {
      const checks = await this.options.breakdown.listPlanChecks(latestCandidate.id);
      latestCheck = latestCheckOf(checks);
      if (latestCheck && latestCheck.result === 'failed') {
        openIssueCount = (await this.options.breakdown.listPlanIssues(latestCheck.id)).length;
      }
    }

    const storyboards = this.options.storyboards
      ? await this.options.storyboards.list(projectId)
      : [];
    const adoptedBoard = storyboards.find(board => board.id === project.activeStoryboardRevisionId) ?? null;
    const freshAdoptedBoard = Boolean(adoptedBoard && adoptedPlan
      && adoptedBoard.scriptVersionId === project.currentScriptVersionId
      && adoptedBoard.sourcePlanRevisionId === adoptedPlan.id);
    const unadoptedCandidates = storyboards.filter(board => board.id !== project.activeStoryboardRevisionId).length;

    // 概览与 asset-requirements 共用同一套 matchEntities（精确 + 纯词法检索，不触发付费 Embedding），
    // 保证 ready/missing/ambiguous 两端口径一致。
    const assetsLibrary = this.options.assets ? await this.options.assets.list() : [];
    const assetMatches = adoptedPlan
      ? await this.matchPlanEntities(adoptedPlan, assetsLibrary, project.id)
      : [];
    const missing = assetMatches.filter(match => !match.asset && !match.ambiguous).length;
    const ambiguous = assetMatches.filter(match => match.ambiguous).length;
    const ready = assetMatches.filter(match => match.asset).length;

    const todos: ProjectTodo[] = [];
    if (latestCandidate && latestCheck && latestCheck.result === 'failed') {
      todos.push({ id: `facts-check:${latestCandidate.id}`, label: `事实校验有 ${openIssueCount} 项待处理`, kind: 'facts-check' });
    }
    if (missing > 0) todos.push({ id: 'assets-missing', label: `补齐 ${missing} 项缺失资产`, kind: 'assets' });
    if (ambiguous > 0) todos.push({ id: 'assets-ambiguous', label: `澄清 ${ambiguous} 项歧义资产`, kind: 'assets' });

    const latestRun = runs
      .slice()
      .sort((left, right) => (left.sealedAt ?? left.createdAt).localeCompare(right.sealedAt ?? right.createdAt))
      .at(-1) ?? null;

    const state: WorkflowState = {
      hasScript: Boolean(currentScript),
      // 只有当前剧本版本的 Run 才算数：旧剧本的历史 Run 不代表主链已推进。
      hasRuns: runs.some(run => run.scriptVersionId === project.currentScriptVersionId),
      adoptedPlan,
      freshAdoptedPlan,
      latestCandidate: latestCandidate && latestCandidate.id === project.activePlanRevisionId ? null : latestCandidate,
      latestCheck,
      openIssueCount,
      assets: { missing, ambiguous },
      boards: { adopted: adoptedBoard, freshAdopted: freshAdoptedBoard, unadoptedCandidates, candidateCount: storyboards.length },
      hasProductionRun: false, // 阶段 1：制作运行由 #183 收敛，此处如实为 false。
      todos,
      deliveryAvailable: false, // 阶段 1：交付物尚未接入，如实为零值。
    };

    // 采用发生在独立 adoption 表，现有只读端口不暴露采用时间戳，如实置 null。
    // 契约规定该块描述已采用分镜：无已采用版本时为 null，候选计数由 nextAction 体现。
    const storyboardBlock: ProjectWorkspaceOverview['storyboard'] = adoptedBoard ? {
      revisionId: adoptedBoard.id,
      shotCount: adoptedBoard.shots.length,
      candidateCount: storyboards.length,
      adoptedAt: null,
      stale: !freshAdoptedBoard,
    } : null;

    return {
      projectId: project.id,
      title: project.title,
      updatedAt: maxTime(currentScript?.createdAt ?? null, adoptedBoard?.createdAt ?? null, latestRun ? (latestRun.sealedAt ?? latestRun.createdAt) : null),
      script: currentScript ? { versionId: currentScript.id, version: currentScript.version, updatedAt: currentScript.createdAt } : null,
      facts: adoptedPlan ? {
        planRevisionId: adoptedPlan.id,
        scriptVersionId: adoptedPlan.scriptVersionId,
        sceneCount: adoptedPlan.content.scenes.length,
        entityCount: adoptedPlan.content.characters.length + adoptedPlan.content.locations.length + adoptedPlan.content.props.length,
        adoptedAt: null,
        stale: !freshAdoptedPlan,
      } : null,      assets: { total: assetMatches.length, ready, missing, ambiguous },
      storyboard: storyboardBlock,
      latestRun: latestRun ? {
        runId: latestRun.id,
        kind: 'breakdown' as const,
        status: latestRun.status,
        stage: latestRun.task.state,
        updatedAt: latestRun.sealedAt ?? latestRun.createdAt,
      } : null,
      todos,
      delivery: { available: false, artifactCount: 0, lastDeliveredAt: null },
      nextAction: decideNextAction(state),
    };
  }

  /**
   * overview 与 asset-requirements 共用的匹配入口：同一套 matchEntities（精确 + 纯词法检索），
   * workspaceId 只从服务端作用域派生；不触发模型/付费。
   */
  private async matchPlanEntities(plan: PlanRevisionRecord, assetsLibrary: AssetRecord[], projectId: string): Promise<AssetMatch[]> {
    const workspaceId = this.options.workspaceId?.();
    return matchEntities(allEntities(plan), assetsLibrary, {
      retrieve: (query, assets, policy) => Promise.resolve(retrieveAssetForGeneration(
        { ...query, ...(workspaceId ? { workspaceId } : {}), projectId }, assets, policy ?? DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY)),
    }, DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY);
  }

  async assetRequirements(projectId: string): Promise<ProjectAssetRequirementsResponse> {
    const project = await this.options.breakdown.getProject(projectId);
    if (!project.activePlanRevisionId) {
      return { projectId: project.id, planRevisionId: null, ruleVersion: MATCH_RULE_VERSION as typeof PROJECT_ASSET_MATCH_RULE_VERSION, summary: { total: 0, matched: 0, missing: 0, ambiguous: 0 }, requirements: [] };
    }
    const plan = await this.options.breakdown.getPlanRevision(project.activePlanRevisionId);
    const assetsLibrary = this.options.assets ? await this.options.assets.list() : [];
    // 与 overview 共用同一套匹配；workspaceId 由服务端派生，绝不读取请求体。
    const matches = await this.matchPlanEntities(plan, assetsLibrary, project.id);

    const requirements = matches.map(match => ({
      requirementId: match.entityId,
      kind: match.kind,
      name: match.entityName,
      sceneIds: sceneIdsOf(plan, match.entityId, match.kind),
      match: {
        assetId: match.asset?.id ?? null,
        matchedBy: match.matchedBy,
        matchedTerm: match.matchedTerm,
        ambiguous: match.ambiguous,
        alternatives: match.ambiguousCandidates.map(candidate => ({
          assetId: candidate.assetId, name: candidate.name, score: 'score' in candidate ? candidate.score ?? null : null,
        })),
      },
      action: match.asset
        ? { kind: 'none' as const, label: '已绑定资产' }
        : match.ambiguous
          ? { kind: 'choose' as const, label: '在候选中选择' }
          : { kind: 'create' as const, label: '新建资产' },
    }));
    return {
      projectId: project.id,
      planRevisionId: plan.id,
      ruleVersion: MATCH_RULE_VERSION as typeof PROJECT_ASSET_MATCH_RULE_VERSION,
      summary: {
        total: requirements.length,
        matched: requirements.filter(item => item.match.assetId).length,
        missing: requirements.filter(item => !item.match.assetId && !item.match.ambiguous).length,
        ambiguous: requirements.filter(item => item.match.ambiguous).length,
      },
      requirements,
    };
  }
}
