import type { BreakdownServicePort } from '../breakdown/service';
import type { ExtractFactsStageRunner } from '../breakdown/execution';
import { BreakdownError, PaidModelExecutionError } from '../breakdown/errors';
import type { PlanCheckRecord } from '../breakdown/quality';
import type { PlanRevisionRecord } from '../breakdown/plan';
import type { StoryboardRevision, StoryboardService } from '../breakdown/storyboard';
import { ProductionMediaError, type LocalVideoObject } from '../production-media/contracts';
import type { ProductionMediaIngestor } from '../production-media/ingestor';
import type { VideoAutomationService } from '../video-automation/service';
import { VideoAutomationError } from '../video-automation/contracts';
import { canonicalDigest, type ProductionReviewInput, type ProductionTask, type StoredProductionRun } from './contracts';
import type {
  PreparedProductionExecution, ProductionExecutionContext, ProductionExecutor, ProductionExecutorOutcome, SpawnTaskDraft,
} from './executor';

export interface RuntimeOptions { estimateCostMicros: number }
export interface VideoRuntimeOptions extends RuntimeOptions {
  mediaIngestor: Pick<ProductionMediaIngestor, 'ingestProviderUrl'>;
}
interface VideoReferenceAssets { state: 'ready'; assetIds: string[]; promptLines: string[] }
interface VideoDirectorConstraint { state: 'ready'; artifactId: string | null; promptLines: string[] }
interface VideoRepairRequirements { artifactId: string | null; repairRound: number | null; promptLines: string[] }
function validEstimate(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Production estimate must be a non-negative safe integer.');
  return value;
}
function prepared(stage: string, input: unknown, estimateCostMicros: number, requiresPaid: boolean, provider: string): PreparedProductionExecution {
  return { executor: `ohao-${stage}-adapter/1`, inputDigest: canonicalDigest(input),
    estimateCostMicros: requiresPaid ? validEstimate(estimateCostMicros) : 0, requiresPaid, provider: requiresPaid ? provider : null };
}
function metadataArtifact(run: StoredProductionRun, task: ProductionTask, key: string) {
  return run.artifacts.find(item => item.taskId === task.id && item.status === 'current' && item.metadata.key === key) ?? null;
}
function safeFailure(error: unknown, fallbackCode: string, fallbackMessage: string) {
  if ((error instanceof BreakdownError || error instanceof VideoAutomationError || error instanceof ProductionMediaError)
    && typeof error.code === 'string' && typeof error.message === 'string') {
    return { state: 'failed' as const, code: error.code, message: error.message, retryable: false };
  }
  return { state: 'failed' as const, code: fallbackCode, message: fallbackMessage, retryable: false };
}
function paidModelFailure(error: unknown, fallbackCode: string, fallbackMessage: string,
  estimateCostMicros: number, operationKey: string | null): ProductionExecutorOutcome {
  const safe = safeFailure(error, fallbackCode, fallbackMessage);
  if (error instanceof PaidModelExecutionError && error.paidModelCallState === 'unknown' && operationKey) {
    return { state: 'waitingHuman', operationUnknown: true,
      issue: { code: 'MODEL_EXECUTION_UNKNOWN', title: '模型调用结果不明',
        message: `${safe.message}原付费请求可能已发生，已保留预算预留并禁止自动重发。`, severity: 'error',
        recommendedActions: ['核对原模型请求和账单', '不要重复提交', '人工确认结果后再处理'] } };
  }
  if (error instanceof PaidModelExecutionError && error.paidModelCallState === 'none') {
    return { state: 'failed', code: safe.code, message: safe.message, retryable: true, actualCostMicros: 0 };
  }
  return { ...safe, actualCostMicros: error instanceof PaidModelExecutionError
    && error.paidModelCallState === 'confirmed' && operationKey ? estimateCostMicros : 0 };
}

export class BreakdownProductionExecutor implements ProductionExecutor {
  readonly stage = 'breakdown' as const;
  constructor(private readonly breakdown: BreakdownServicePort, private readonly runner: Pick<ExtractFactsStageRunner, 'run'>,
    private readonly options: RuntimeOptions) { validEstimate(options.estimateCostMicros); }

  async prepare({ run }: { run: Readonly<StoredProductionRun>; task: Readonly<ProductionTask> }) {
    const project = await this.breakdown.getProject(run.projectId);
    const active = project.activePlanRevisionId ? await this.breakdown.getPlanRevision(project.activePlanRevisionId) : null;
    const alreadyAdopted = Boolean(active && active.scriptVersionId === run.scriptVersionId);
    return prepared('breakdown', { projectId: run.projectId, scriptVersionId: run.scriptVersionId,
      visualStyle: run.visualStyle, ratio: run.ratio, targetDurationSec: run.targetDurationSec },
    this.options.estimateCostMicros, !alreadyAdopted, 'configured-text-model');
  }

  async execute(context: ProductionExecutionContext): Promise<ProductionExecutorOutcome> {
    const { run } = context; const project = await this.breakdown.getProject(run.projectId);
    if (project.activePlanRevisionId) {
      const active = await this.breakdown.getPlanRevision(project.activePlanRevisionId);
      if (active.scriptVersionId === run.scriptVersionId) return this.adopted(active);
    }
    // Draft creation is local and non-paid. Persist its ID through the production
    // external-operation boundary before runner.run can make a model request.
    const draft = await this.breakdown.createDraftRun(run.projectId, {
      scriptVersionId: run.scriptVersionId,
      requirements: { language: 'zh-CN', visualStyle: run.visualStyle, aspectRatio: run.ratio,
        targetDurationSeconds: { min: Math.max(1, run.targetDurationSec - 10), max: run.targetDurationSec + 10 } },
      maxModelCalls: run.qualityPreset === 'quality' ? 3 : run.qualityPreset === 'balanced' ? 2 : 1,
      // Structured facts with per-field provenance run 15k+ tokens for a 60s
      // script; the connection profile still applies its own hard ceiling.
      maxOutputTokens: run.qualityPreset === 'fast' ? 16_384 : 32_768, mode: 'checkpoints', humanCheckpoints: ['candidatePlanReview'],
    });
    return { state: 'waitingExternal', providerTaskId: draft.id };
  }

  async reconcile(context: ProductionExecutionContext, operation: { providerTaskId: string | null }): Promise<ProductionExecutorOutcome> {
    if (!operation.providerTaskId) return { state: 'waitingHuman', operationUnknown: true, issue: { code: 'BREAKDOWN_RUN_ID_MISSING',
      title: '拆解任务无法对账', message: '没有保存拆解 Run ID，不会重新调用模型。', severity: 'error',
      recommendedActions: ['核对原拆解执行记录', '不要重复提交'] } };
    try {
      let draft = await this.breakdown.getRun(operation.providerTaskId);
      let plan: PlanRevisionRecord;
      if (draft.status === 'draft' && draft.task.state === 'pending') {
        plan = (await this.runner.run(draft.id)).plan;
        draft = await this.breakdown.getRun(draft.id);
      } else if (draft.status === 'waiting' && draft.task.state === 'waitingHuman') {
        const plans = await this.breakdown.listPlanRevisions(draft.id);
        const found = plans.at(-1); if (!found) return { state: 'blocked', issue: { code: 'BREAKDOWN_RESULT_MISSING',
          title: '拆解结果缺失', message: '拆解 Run 已结束，但没有找到候选版本。', severity: 'error' } };
        plan = found;
      } else if (draft.status === 'running' || draft.task.state === 'running') {
        return { state: 'waitingHuman', operationUnknown: true, issue: { code: 'BREAKDOWN_SUBMISSION_UNKNOWN', title: '拆解执行结果不明',
          message: '已有拆解执行处于运行记录，不会重复提交付费请求。', severity: 'error',
          recommendedActions: ['核对原拆解执行记录', '不要重复提交'] } };
      } else return { state: 'failed', code: 'BREAKDOWN_RUN_FAILED', message: '剧本拆解任务未成功。', retryable: false };
      return await this.reviewablePlan(context.run as StoredProductionRun, plan,
        context.operationKey ? this.options.estimateCostMicros : 0);
    } catch (error) { return paidModelFailure(error, 'BREAKDOWN_EXECUTION_FAILED', '剧本拆解执行失败，不会自动重试。',
      this.options.estimateCostMicros, context.operationKey); }
  }

  async review({ run, task, input }: { run: Readonly<StoredProductionRun>; task: Readonly<ProductionTask>; input: Readonly<ProductionReviewInput> }) {
    if (input.decision !== 'approve') return;
    const artifact = metadataArtifact(run as StoredProductionRun, task as ProductionTask, 'breakdown-plan');
    const planRevisionId = artifact?.metadata.planRevisionId; const checkId = artifact?.metadata.checkId;
    const expected = artifact?.metadata.expectedActivePlanRevisionId;
    if (typeof planRevisionId !== 'string') return;
    const project = await this.breakdown.getProject(run.projectId);
    if (project.activePlanRevisionId === planRevisionId) return;
    if (typeof checkId !== 'string' || (expected !== null && typeof expected !== 'string')) throw new Error('Breakdown adoption metadata invalid.');
    await this.breakdown.adoptPlan(run.projectId, { planRevisionId, checkId,
      expectedActivePlanRevisionId: expected as string | null });
  }

  private adopted(plan: PlanRevisionRecord, check?: PlanCheckRecord, actualCostMicros = 0): ProductionExecutorOutcome {
    return { state: 'succeeded', artifacts: [{ key: 'breakdown-plan', kind: 'text', title: '已采用的剧本拆解',
      metadata: { planRevisionId: plan.id, scriptVersionId: plan.scriptVersionId, adopted: true,
        scenes: plan.content.scenes.length, characters: plan.content.characters.length,
        locations: plan.content.locations.length, props: plan.content.props.length } }],
      ...(check ? { qualityChecks: [{ level: 'episode' as const, result: 'pass' as const,
        ruleVersion: check.ruleVersion, summary: '拆解通过确定性完整性检查' }] } : {}), actualCostMicros };
  }
  private async reviewablePlan(run: StoredProductionRun, plan: PlanRevisionRecord,
    actualCostMicros: number): Promise<ProductionExecutorOutcome> {
    let checks = await this.breakdown.listPlanChecks(plan.id);
    let check: PlanCheckRecord | undefined = checks.find(item => item.result === 'passed') ?? checks.at(-1);
    if (!check) { check = (await this.breakdown.checkPlan(plan.id)).check; checks = [check]; }
    const project = await this.breakdown.getProject(plan.projectId);
    const artifact = { key: 'breakdown-plan', kind: 'text' as const, title: '剧本拆解候选', metadata: {
      planRevisionId: plan.id, checkId: check.id, expectedActivePlanRevisionId: project.activePlanRevisionId,
      scriptVersionId: plan.scriptVersionId, adopted: false, scenes: plan.content.scenes.length,
      characters: plan.content.characters.length, locations: plan.content.locations.length, props: plan.content.props.length,
    } };
    if (check.result !== 'passed') return { state: 'waitingHuman', artifacts: [artifact], actualCostMicros,
      qualityChecks: [{ level: 'episode', result: 'fail', ruleVersion: check.ruleVersion, summary: '拆解未通过确定性完整性检查', issues: check.issueIds }],
      issue: { code: 'PLAN_CHECK_FAILED', title: '剧本拆解需要修正', message: '候选版本存在阻断问题，不能采用。',
        severity: 'error', recommendedActions: ['打开拆解校对页修正候选', '重新检查后局部重试'] } };
    if (run.automationMode === 'auto') {
      if (project.activePlanRevisionId === plan.id) return this.adopted(plan, check, actualCostMicros);
      try {
        await this.breakdown.adoptPlan(run.projectId, { planRevisionId: plan.id, checkId: check.id,
          expectedActivePlanRevisionId: project.activePlanRevisionId, actor: 'agent' });
      } catch (error) {
        const current = await this.breakdown.getProject(run.projectId);
        if (current.activePlanRevisionId !== plan.id) throw error;
      }
      return this.adopted(plan, check, actualCostMicros);
    }
    return { state: 'waitingHuman', artifacts: [artifact], actualCostMicros,
      qualityChecks: [{ level: 'episode', result: 'pass', ruleVersion: check.ruleVersion, summary: '拆解通过确定性完整性检查' }],
      issue: { code: 'CHECKPOINT_REVIEW_REQUIRED', title: '请确认剧本拆解',
        message: '拆解候选已通过程序检查，需要你明确采用后才能生成分镜。', severity: 'info' } };
  }
}

export class StoryboardProductionExecutor implements ProductionExecutor {
  readonly stage = 'storyboard' as const;
  constructor(private readonly breakdown: BreakdownServicePort, private readonly storyboards: Pick<StoryboardService, 'generate' | 'get' | 'adopt'>,
    private readonly options: RuntimeOptions) { validEstimate(options.estimateCostMicros); }

  async prepare({ run }: { run: Readonly<StoredProductionRun>; task: Readonly<ProductionTask> }) {
    const project = await this.breakdown.getProject(run.projectId);
    if (!project.activePlanRevisionId || project.currentScriptVersionId !== run.scriptVersionId) throw new Error('Current adopted plan is required.');
    let alreadyAdopted = false;
    if (project.activeStoryboardRevisionId) {
      const board = await this.storyboards.get(project.activeStoryboardRevisionId);
      alreadyAdopted = board.scriptVersionId === run.scriptVersionId && board.sourcePlanRevisionId === project.activePlanRevisionId;
    }
    return prepared('storyboard', { projectId: run.projectId, scriptVersionId: run.scriptVersionId,
      activePlanRevisionId: project.activePlanRevisionId }, this.options.estimateCostMicros, !alreadyAdopted, 'configured-general-model');
  }
  async execute(context: ProductionExecutionContext): Promise<ProductionExecutorOutcome> {
    const { run } = context;
    try {
      const project = await this.breakdown.getProject(run.projectId);
      if (project.activeStoryboardRevisionId) {
        const active = await this.storyboards.get(project.activeStoryboardRevisionId);
        if (active.scriptVersionId === run.scriptVersionId && active.sourcePlanRevisionId === project.activePlanRevisionId) {
          return this.adopted(run, active, 0);
        }
      }
      const candidate = await this.storyboards.generate(run.projectId);
      const actualCostMicros = context.operationKey ? this.options.estimateCostMicros : 0;
      if (run.automationMode === 'auto') {
        try { await this.storyboards.adopt(run.projectId, candidate.id, project.activeStoryboardRevisionId, 'agent'); }
        catch (error) {
          const current = await this.breakdown.getProject(run.projectId);
          if (current.activeStoryboardRevisionId !== candidate.id) throw error;
        }
        return this.adopted(run, candidate, actualCostMicros);
      }
      return this.reviewable(run, candidate, project.activeStoryboardRevisionId, actualCostMicros);
    } catch (error) { return paidModelFailure(error, 'STORYBOARD_EXECUTION_FAILED', '分镜生成失败，不会自动重试。',
      this.options.estimateCostMicros, context.operationKey); }
  }
  async review({ run, task, input }: { run: Readonly<StoredProductionRun>; task: Readonly<ProductionTask>; input: Readonly<ProductionReviewInput> }) {
    if (input.decision !== 'approve') return;
    const artifact = metadataArtifact(run as StoredProductionRun, task as ProductionTask, 'storyboard');
    const revisionId = artifact?.metadata.storyboardRevisionId; const expected = artifact?.metadata.expectedActiveStoryboardRevisionId;
    if (typeof revisionId !== 'string') return;
    const project = await this.breakdown.getProject(run.projectId);
    if (project.activeStoryboardRevisionId === revisionId) return;
    if (expected !== null && typeof expected !== 'string') throw new Error('Storyboard adoption metadata invalid.');
    await this.storyboards.adopt(run.projectId, revisionId, expected as string | null);
  }
  private adopted(run: StoredProductionRun, board: StoryboardRevision, actualCostMicros = 0): ProductionExecutorOutcome {
    return { state: 'succeeded', artifacts: [this.artifact(board, true)], spawnTasks: this.shotTasks(run, board),
      qualityChecks: [{ level: 'episode', result: 'pass', ruleVersion: 'storyboard-validator/2',
        summary: '镜号、引用、对白覆盖和顺序检查已通过' }], actualCostMicros };
  }
  private reviewable(run: StoredProductionRun, board: StoryboardRevision, expected: string | null,
    actualCostMicros: number): ProductionExecutorOutcome {
    return { state: 'waitingHuman', artifacts: [{ ...this.artifact(board, false),
      metadata: { ...this.artifact(board, false).metadata, expectedActiveStoryboardRevisionId: expected } }],
    actualCostMicros,
    qualityChecks: [{ level: 'episode', result: 'pass', ruleVersion: 'storyboard-validator/2',
      summary: '镜号、引用、对白覆盖和顺序检查已通过' }], spawnTasks: this.shotTasks(run, board),
    issue: { code: 'CHECKPOINT_REVIEW_REQUIRED', title: '请确认分镜方案',
      message: `${board.shots.length} 个镜头已形成候选，采用后才会推进各镜头生产。`, severity: 'info' } };
  }
  private artifact(board: StoryboardRevision, adopted: boolean) {
    return { key: 'storyboard', kind: 'text' as const, title: adopted ? '已采用的分镜' : '分镜候选', metadata: {
      storyboardRevisionId: board.id, scriptVersionId: board.scriptVersionId, sourcePlanRevisionId: board.sourcePlanRevisionId,
      adopted, shotCount: board.shots.length, shots: board.shots.map(shot => ({ id: shot.id, sceneId: shot.sceneId,
        order: shot.order, durationMs: shot.design.durationMs, shotSize: shot.design.shotSize,
        cameraMovement: shot.design.cameraMovement, visualDescription: shot.design.visualDescription })) } };
  }
  private shotTasks(run: StoredProductionRun, board: StoryboardRevision): SpawnTaskDraft[] {
    // 直出版：每镜只生成 1 条视频，不建候选组，也不产生抽卡任务；复核直接依赖这条视频。
    const direct = run.candidatePolicy === 'direct';
    return board.shots.flatMap((shot, index) => {
      const prefix = `shot-${index + 1}-${shot.id}`;
      const label = `场 ${shot.sceneId} · 镜 ${shot.order}`;
      const assetKey = `${prefix}-assets`;
      const directorKey = `${prefix}-director`;
      const videoDependency = run.directorPolicy === 'never' ? assetKey : directorKey;
      const videoKeys = direct ? [`${prefix}-video`]
        : Array.from({ length: run.candidateLimit }, (_, candidateIndex) => `${prefix}-video-candidate-${candidateIndex}`);
      const tasks: SpawnTaskDraft[] = [
        { key: assetKey, stage: 'assets', label: `${label} 资产引用`, scope: { kind: 'shot', id: shot.id } },
      ];
      if (run.directorPolicy !== 'never') tasks.push({ key: directorKey, stage: 'director', label: `${label} 3D 预演`,
        scope: { kind: 'shot', id: shot.id }, dependsOn: [assetKey] });
      videoKeys.forEach((key, candidateIndex) => tasks.push({ key, stage: 'video',
        label: direct ? `${label} 视频` : `${label} 视频候选 ${candidateIndex + 1}`,
        scope: { kind: 'shot', id: shot.id }, dependsOn: [videoDependency] }));
      if (!direct) tasks.push({ key: `${prefix}-candidates`, stage: 'candidates', label: `${label} 抽卡`,
        scope: { kind: 'shot', id: shot.id }, dependsOn: videoKeys });
      tasks.push({ key: `${prefix}-review`, stage: 'review', label: `${label} 复核`,
        scope: { kind: 'shot', id: shot.id }, dependsOn: [direct ? videoKeys[0]! : `${prefix}-candidates`] });
      return tasks;
    });
  }
}

type PublicVideoRun = Awaited<ReturnType<VideoAutomationService['get']>>;
export class VideoProductionExecutor implements ProductionExecutor {
  readonly stage = 'video' as const;
  constructor(private readonly breakdown: BreakdownServicePort, private readonly storyboards: Pick<StoryboardService, 'get'>,
    private readonly videos: Pick<VideoAutomationService, 'status' | 'create' | 'get' | 'reconcile'>,
    private readonly options: VideoRuntimeOptions) {
    validEstimate(options.estimateCostMicros);
    if (!options.mediaIngestor || typeof options.mediaIngestor.ingestProviderUrl !== 'function') {
      throw new Error('Video production requires verified local media ingestion.');
    }
  }

  async prepare({ run, task }: { run: Readonly<StoredProductionRun>; task: Readonly<ProductionTask> }) {
    if (task.scope.kind === 'episode') return prepared('video-coordinator', { runId: run.id, taskId: task.id }, 0, false, 'local');
    if (task.scope.kind !== 'shot') throw new Error('Video tasks require shot scope.');
    const providerRunId = this.providerRunId(run as StoredProductionRun, task as ProductionTask);
    if (providerRunId) return prepared('video-localize', { runId: run.id, taskId: task.id, providerRunId }, 0, false, 'local-media');
    const references = this.referenceAssets(run as StoredProductionRun, task as ProductionTask);
    if (references.state === 'blocked') return prepared('video-reference-blocked', { runId: run.id, taskId: task.id,
      code: references.code }, 0, false, 'local');
    const director = this.directorConstraint(run as StoredProductionRun, task as ProductionTask);
    if (director.state === 'blocked') return prepared('video-director-blocked', { runId: run.id, taskId: task.id,
      code: director.code }, 0, false, 'local');
    const repair = this.repairRequirements(run as StoredProductionRun, task as ProductionTask);
    const { board, shot } = await this.shotContext({ run, task });
    const status = await this.videos.status();
    if (!status.available || !status.connectionRevision) throw new Error('Video capability is unavailable.');
    if (status.busy) return { ...prepared('video-deferred', this.videoPreparation(run, task, board.id, shot, references,
      director, repair, status.connectionRevision), 0, false, 'local'),
    defer: { code: 'VIDEO_AUTOMATION_BUSY', message: '本机视频生成通道正在处理另一个镜头，将保留任务并稍后再试。' } };
    return prepared('video', this.videoPreparation(run, task, board.id, shot, references, director, repair,
      status.connectionRevision),
      this.options.estimateCostMicros, true, 'configured-video-model');
  }
  async execute(context: ProductionExecutionContext): Promise<ProductionExecutorOutcome> {
    if (context.task.scope.kind === 'episode') {
      const shots = context.run.tasks.filter(task => task.stage === 'video' && task.scope.kind === 'shot');
      return shots.length ? { state: 'succeeded', artifacts: [{ key: 'video-coordinator', kind: 'report',
        title: '镜头视频任务已展开', metadata: { shotTasks: shots.length } }] }
        : { state: 'blocked', issue: { code: 'SHOT_TASKS_MISSING', title: '没有可生成的镜头',
          message: '分镜尚未展开为真实镜头任务，不会伪造视频成果。', severity: 'error' } };
    }
    try {
      const providerRunId = this.providerRunId(context.run as StoredProductionRun, context.task as ProductionTask);
      if (providerRunId) return await this.videoOutcome(await this.videos.get(providerRunId), context);
      const references = this.referenceAssets(context.run as StoredProductionRun, context.task as ProductionTask);
      if (references.state === 'blocked') return { state: 'blocked', issue: { code: references.code,
        title: '镜头资产引用不完整', message: references.message, severity: 'error',
        recommendedActions: ['完成该镜头的资产绑定后局部重试'] } };
      const director = this.directorConstraint(context.run as StoredProductionRun, context.task as ProductionTask);
      if (director.state === 'blocked') return { state: 'blocked', issue: { code: director.code,
        title: '3D 白模约束无法读取', message: director.message, severity: 'error',
        recommendedActions: ['重建该镜头的 3D 白模后局部重试'] } };
      if (!context.operationKey) return { state: 'blocked', issue: { code: 'VIDEO_PAID_CLAIM_MISSING',
        title: '视频付费执行未授权', message: '没有找到持久化的付费操作标识，未创建视频任务。', severity: 'error' } };
      const repair = this.repairRequirements(context.run as StoredProductionRun, context.task as ProductionTask);
      const request = await this.videoRequest(context, references, director, repair);
      const run = await this.videos.create(request);
      return await this.videoOutcome(run, context);
    } catch (error) { return safeFailure(error, 'VIDEO_TASK_CREATE_FAILED', '镜头视频任务创建失败，未自动重试。'); }
  }
  async reconcile(context: ProductionExecutionContext, operation: { providerTaskId: string | null }): Promise<ProductionExecutorOutcome> {
    if (!operation.providerTaskId) return { state: 'waitingHuman', operationUnknown: true, issue: { code: 'VIDEO_RUN_ID_MISSING', title: '视频任务无法对账',
      message: '没有本地视频 Run ID，不会重新提交。', severity: 'error',
      recommendedActions: ['核对原视频任务', '不要重复提交'] } };
    try {
      let run = await this.videos.get(operation.providerTaskId);
      if (run.status === 'unknown') run = await this.videos.reconcile(operation.providerTaskId, {});
      return await this.videoOutcome(run, context);
    } catch (error) { return safeFailure(error, 'VIDEO_RECONCILIATION_FAILED', '无法确认原视频任务状态，未重新提交。'); }
  }
  private async videoRequest(context: ProductionExecutionContext,
    references: VideoReferenceAssets, director: VideoDirectorConstraint, repair: VideoRepairRequirements) {
    const { run, task } = context; if (task.scope.kind !== 'shot') throw new Error('Shot scope required.');
    const { board, shot } = await this.shotContext(context);
    const status = await this.videos.status();
    if (!status.available || !status.connectionRevision) throw new Error('Video model unavailable.');
    if (canonicalDigest(this.videoPreparation(run, task, board.id, shot, references, director, repair,
      status.connectionRevision)) !== context.inputDigest) {
      throw new Error('Video inputs changed after durable preparation.');
    }
    const coordinates = this.candidateCoordinates(task);
    const candidateDirections = ['保持表演克制、人物一致和镜头稳定', '在不改变构图关系的前提下增强运镜节奏',
      '在不改变实体设定的前提下增强光影层次', '保持连续性并强化叙事节奏'];
    const prompt = [run.visualStyle, shot.design.visualDescription, `景别：${shot.design.shotSize}`,
      `运镜：${shot.design.cameraMovement}`, '参考图片对应关系（按传入顺序）：', ...references.promptLines,
      '严格按照图片序号对应的已确认实体，保持人物、场景、服装和道具一致，不得互换身份。',
      `候选创作方向 ${coordinates.candidateIndex + 1}：${candidateDirections[coordinates.candidateIndex % candidateDirections.length]}`,
      ...director.promptLines, ...repair.promptLines].join('\n');
    return { prompt, ratio: run.ratio, duration: Math.max(4, Math.min(30, Math.ceil(shot.design.durationMs / 1000))),
      resolution: run.qualityPreset === 'fast' ? '720p' as const : '1080p' as const, generateAudio: true,
      referenceAssetIds: references.assetIds,
      clientRequestId: `prod_${context.operationKey ?? canonicalDigest({ runId: run.id, taskId: task.id })}`.slice(0, 100),
      expectedModelConnectionRevision: status.connectionRevision, allowPaid: true as const };
  }
  private async videoOutcome(video: PublicVideoRun, context: ProductionExecutionContext): Promise<ProductionExecutorOutcome> {
    if (video.status === 'completed' && video.result?.videoUrl) {
      const { board, shot } = await this.shotContext(context);
      const coordinates = this.candidateCoordinates(context.task);
      let local: LocalVideoObject;
      try { local = await this.options.mediaIngestor.ingestProviderUrl(video.result.videoUrl); }
      catch (error) {
        const code = error instanceof ProductionMediaError ? error.code : 'PROVIDER_VIDEO_LOCALIZATION_FAILED';
        return { state: 'waitingHuman', artifacts: [{ key: 'provider-video-result', kind: 'report',
          title: `${context.task.label}远程结果待入库`, metadata: { videoRunId: video.id, shotId: shot.id,
            candidateIndex: coordinates.candidateIndex, ...(coordinates.repairIndex === null ? {} : { repairIndex: coordinates.repairIndex }),
            storyboardRevisionId: board.id, localizationErrorCode: code } }],
        issue: { code: 'PROVIDER_VIDEO_LOCALIZATION_FAILED', title: '视频已生成，本地入库未完成',
          message: '供应商任务已返回，但视频尚未下载、校验并写入本地媒体库，不会把临时链接当作产物。', severity: 'error',
          recommendedActions: ['恢复本地媒体入库后重试该任务；重试会复用原视频任务'] },
        actualCostMicros: context.operationKey ? this.options.estimateCostMicros : 0 };
      }
      const director = this.directorConstraint(context.run as StoredProductionRun, context.task as ProductionTask);
      const repair = this.repairRequirements(context.run as StoredProductionRun, context.task as ProductionTask);
      return { state: 'succeeded', artifacts: [{ key: 'shot-video', kind: 'video', title: `${context.task.label}结果`,
        uri: `/api/production-media/${local.id}`, sha256: local.sha256, metadata: { mediaId: local.id, videoRunId: video.id,
          shotId: shot.id, candidateIndex: coordinates.candidateIndex,
          ...(coordinates.repairIndex === null ? {} : { repairIndex: coordinates.repairIndex }),
          storyboardRevisionId: board.id, durationSeconds: local.probe.durationSeconds,
          width: local.probe.width, height: local.probe.height, hasAudio: local.probe.hasAudio,
          model: video.model, modelConnectionRevision: video.modelConnectionRevision,
          directorConstraintMode: director.state === 'ready' && director.artifactId ? 'prompt-only' : 'none',
          directorSceneArtifactId: director.state === 'ready' ? director.artifactId : null,
          repairReportArtifactId: repair.artifactId } }],
      actualCostMicros: context.operationKey ? this.options.estimateCostMicros : 0 };
    }
    if (video.status === 'unknown' && !video.providerTaskId) {
      const { board, shot } = await this.shotContext(context);
      const coordinates = this.candidateCoordinates(context.task);
      return { state: 'waitingHuman', artifacts: [{ key: 'provider-video-result', kind: 'report',
        title: `${context.task.label}提交结果待对账`, metadata: { videoRunId: video.id, shotId: shot.id,
          candidateIndex: coordinates.candidateIndex,
          ...(coordinates.repairIndex === null ? {} : { repairIndex: coordinates.repairIndex }),
          storyboardRevisionId: board.id, providerTaskIdPresent: false,
          uncertaintyCode: video.error?.code ?? 'VIDEO_SUBMISSION_UNKNOWN' } }],
      issue: { code: 'VIDEO_SUBMISSION_UNKNOWN', title: '视频提交结果不明',
        message: '本地视频 Run 已保留，但没有可查询的供应商任务号。不会自动重发，需要先核对供应商账单和任务记录。',
        severity: 'error', recommendedActions: ['核对供应商账单和原始请求', '不要重复提交', '确认状态后对原本地 Run 执行对账'] },
      operationUnknown: true };
    }
    if (video.status === 'unknown' && video.providerTaskId
      && video.error?.code === 'VIDEO_RECONCILIATION_LIMIT_REACHED') {
      const { board, shot } = await this.shotContext(context);
      const coordinates = this.candidateCoordinates(context.task);
      return { state: 'waitingHuman', artifacts: [{ key: 'provider-video-result', kind: 'report',
        title: `${context.task.label}供应商任务待人工对账`, metadata: { videoRunId: video.id, shotId: shot.id,
          candidateIndex: coordinates.candidateIndex,
          ...(coordinates.repairIndex === null ? {} : { repairIndex: coordinates.repairIndex }),
          storyboardRevisionId: board.id, providerTaskIdPresent: true,
          reconciliationAttempts: video.reconciliationAttempts ?? null,
          uncertaintyCode: video.error.code } }],
      issue: { code: 'VIDEO_RECONCILIATION_LIMIT_REACHED', title: '视频任务已停止自动查询',
        message: '已多次查询同一个供应商任务但仍无法确认结果。原任务号和预算预留已保留，不会重新提交，需要人工对账。',
        severity: 'error', recommendedActions: ['核对原供应商任务和账单', '不要重复提交', '确认结果后人工接管'] },
      operationUnknown: true };
    }
    if (video.status === 'failed') return { state: 'failed', code: video.error?.code ?? 'VIDEO_GENERATION_FAILED',
      message: video.error?.message ?? '视频供应商任务失败。', retryable: true,
      // A definitive failure without a provider task ID happened before a paid
      // submission. Never charge the estimate for local validation/model blocks.
      actualCostMicros: context.operationKey && video.providerTaskId ? this.options.estimateCostMicros : 0 };
    return { state: 'waitingExternal', providerTaskId: video.id };
  }

  private providerRunId(run: StoredProductionRun, task: ProductionTask): string | null {
    let providerIndex = -1; let completedIndex = -1;
    run.artifacts.forEach((item, index) => {
      if (item.taskId !== task.id) return;
      if (item.metadata.key === 'provider-video-result' && typeof item.metadata.videoRunId === 'string') providerIndex = index;
      if (item.metadata.key === 'shot-video') completedIndex = index;
    });
    if (providerIndex < 0 || completedIndex > providerIndex) return null;
    return run.artifacts[providerIndex]!.metadata.videoRunId as string;
  }

  private async shotContext(context: Pick<ProductionExecutionContext, 'run' | 'task'>) {
    const { run, task } = context;
    if (task.scope.kind !== 'shot') throw new Error('Shot scope required.');
    const storyboardArtifact = [...run.artifacts].reverse().find(item => item.status === 'current'
      && item.metadata.key === 'storyboard' && typeof item.metadata.storyboardRevisionId === 'string');
    if (!storyboardArtifact) throw new Error('Frozen storyboard artifact required.');
    const storyboardRevisionId = storyboardArtifact.metadata.storyboardRevisionId as string;
    const project = await this.breakdown.getProject(run.projectId);
    if (project.activeStoryboardRevisionId !== storyboardRevisionId) throw new Error('Adopted storyboard changed after the production run was frozen.');
    const board = await this.storyboards.get(storyboardRevisionId);
    if (board.scriptVersionId !== run.scriptVersionId) throw new Error('Storyboard does not match frozen script.');
    const shot = board.shots.find(item => item.id === task.scope.id);
    if (!shot) throw new Error('Storyboard shot missing.');
    return { board, shot };
  }

  private candidateCoordinates(task: Readonly<ProductionTask>) {
    const revision = [...task.inputManifest].reverse().find(item => item.kind === 'dynamicScope')?.revisionId ?? '';
    const candidate = /-video-candidate-(\d+)/u.exec(revision);
    const repair = /^repair-.+-(\d+)-video$/u.exec(revision) ?? /(?:^|-)repair-(\d+)(?:-|$)/u.exec(revision);
    return { candidateIndex: candidate ? Number(candidate[1]) : 0, repairIndex: repair ? Number(repair[1]) : null };
  }

  private videoPreparation(run: Readonly<StoredProductionRun>, task: Readonly<ProductionTask>, storyboardRevisionId: string,
    shot: StoryboardRevision['shots'][number], references: VideoReferenceAssets, director: VideoDirectorConstraint,
    repair: VideoRepairRequirements, connectionRevision: string) {
    return { runId: run.id, taskId: task.id, shotId: task.scope.id, scriptVersionId: run.scriptVersionId,
      storyboardRevisionId, shotDesign: { visualDescription: shot.design.visualDescription, shotSize: shot.design.shotSize,
        cameraMovement: shot.design.cameraMovement, durationMs: shot.design.durationMs },
      referenceAssetIds: [...references.assetIds], referencePromptLines: [...references.promptLines],
      directorSceneArtifactId: director.artifactId, directorPromptLines: [...director.promptLines],
      repairReportArtifactId: repair.artifactId, repairRound: repair.repairRound, repairPromptLines: [...repair.promptLines],
      candidate: this.candidateCoordinates(task), connectionRevision };
  }

  private referenceAssets(run: StoredProductionRun, task: ProductionTask): VideoReferenceAssets
    | { state: 'blocked'; code: string; message: string } {
    if (task.scope.kind !== 'shot') return { state: 'blocked', code: 'SHOT_SCOPE_REQUIRED',
      message: '只有真实镜头任务可以引用资产生成视频。' };
    const artifact = [...run.artifacts].reverse().find(item => item.status === 'current'
      && item.metadata.key === 'shot-asset-bindings' && item.metadata.shotId === task.scope.id);
    if (!artifact || !Array.isArray(artifact.metadata.bindings)) return { state: 'blocked', code: 'SHOT_ASSET_BINDINGS_MISSING',
      message: '该镜头还没有可验证的资产绑定报告，未发起生视频。' };
    if (Array.isArray(artifact.metadata.missingEntityIds) && artifact.metadata.missingEntityIds.length) {
      return { state: 'blocked', code: 'SHOT_ASSET_BINDINGS_INCOMPLETE',
        message: '该镜头仍有未匹配的角色、场景或道具，未发起生视频。' };
    }
    const grouped = new Map<string, string[]>();
    for (const raw of artifact.metadata.bindings) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: 'blocked', code: 'SHOT_ASSET_BINDINGS_INVALID',
        message: '镜头资产绑定报告格式无效，未发起生视频。' };
      const binding = raw as Record<string, unknown>; const assetId = binding.assetId;
      const entityName = this.boundedText(binding.entityName, 120); const kind = binding.kind;
      if (typeof assetId !== 'string' || !/^asset_[a-f0-9]{32}$/u.test(assetId)
        || !entityName || !['character', 'location', 'prop'].includes(kind as string)) {
        return { state: 'blocked', code: 'SHOT_ASSET_BINDINGS_INCOMPLETE',
          message: '镜头资产绑定中存在缺失或无效项，未发起生视频。' };
      }
      const label = `${kind === 'character' ? '角色' : kind === 'location' ? '场景' : '道具'}「${entityName}」`;
      const entities = grouped.get(assetId) ?? []; entities.push(label); grouped.set(assetId, entities);
    }
    if (!grouped.size) return { state: 'blocked', code: 'SHOT_ASSET_BINDINGS_EMPTY',
      message: '该镜头没有任何可用的参考资产，未发起生视频。' };
    if (grouped.size > 30) return { state: 'blocked', code: 'SHOT_ASSET_BINDINGS_LIMIT',
      message: '该镜头引用超过 30 张参考图片，请先缩小资产范围。' };
    const assetIds = [...grouped.keys()];
    return { state: 'ready', assetIds,
      promptLines: assetIds.map((id, index) => `图片${index + 1}：${grouped.get(id)!.join('、')}`) };
  }

  private directorConstraint(run: StoredProductionRun, task: ProductionTask): VideoDirectorConstraint
    | { state: 'blocked'; code: string; message: string } {
    const artifact = [...run.artifacts].reverse().find(item => {
      if (item.status !== 'current' || item.kind !== 'directorScene') return false;
      const owner = run.tasks.find(ownerTask => ownerTask.id === item.taskId);
      const snapshot = this.record(item.metadata.snapshot); const provenance = this.record(snapshot.provenance);
      return provenance.shotId === task.scope.id || (owner?.scope.kind === 'shot' && owner.scope.id === task.scope.id);
    });
    if (!artifact) return { state: 'ready', artifactId: null, promptLines: [] };
    const snapshot = this.record(artifact.metadata.snapshot); const snapshotProvenance = this.record(snapshot.provenance);
    if (snapshotProvenance.shotId !== task.scope.id) return { state: 'blocked', code: 'DIRECTOR_SCENE_INVALID',
      message: '该镜头的 3D 白模与当前分镜不匹配，未发起生视频。' };
    const cameras = Array.isArray(snapshot.cameras) ? snapshot.cameras : [];
    const objects = Array.isArray(snapshot.objects) ? snapshot.objects : [];
    const activeCameraId = this.boundedText(snapshot.activeCameraId, 100);
    const camera = cameras.find(item => item && typeof item === 'object'
      && this.boundedText((item as Record<string, unknown>).id, 100) === activeCameraId) as Record<string, unknown> | undefined;
    if (!activeCameraId || !camera) return { state: 'blocked', code: 'DIRECTOR_SCENE_INVALID',
      message: '该镜头的 3D 白模没有可验证的活动机位，未发起生视频。' };
    const cameraTransform = this.record(camera.transform); const cameraPosition = this.record(cameraTransform.position);
    const target = this.record(camera.target); const provenance = this.record(camera.provenance);
    if (!this.validVector(cameraPosition) || !this.validVector(target)) return { state: 'blocked', code: 'DIRECTOR_SCENE_INVALID',
      message: '该镜头的 3D 白模缺少可验证的机位位置或朝向目标，未发起生视频。' };
    const cameraLine = `活动机位「${this.boundedText(camera.name, 80) || activeCameraId}」：位置 ${this.vector(cameraPosition)}，`
      + `朝向目标 ${this.vector(target)}，焦距 ${this.number(camera.focalLength) ?? '未标注'}mm，`
      + `运镜 ${this.boundedText(provenance.cameraMovement, 80) || '按分镜设定'}`;
    const actors = objects.filter(item => item && typeof item === 'object'
      && (item as Record<string, unknown>).type === 'mannequin').slice(0, 20).map(item => {
      const actor = item as Record<string, unknown>; const transform = this.record(actor.transform);
      const pose = this.record(actor.pose); return `${this.boundedText(actor.name, 60) || '人物'}：站位 ${this.vector(this.record(transform.position))}，`
        + `朝向 ${this.vector(this.record(transform.rotation))}，动作 ${this.boundedText(pose.preset, 40) || '站立'}`;
    });
    const aspect = snapshot.aspectRatio === '9:16' || snapshot.aspectRatio === '16:9' ? snapshot.aspectRatio : run.ratio;
    const lines = ['3D 白模构图约束（仅转换为生成提示词，不是 3D 渲染或供应商原生控制）：',
      `画幅 ${aspect}；${cameraLine}`, ...actors.map(value => `人物站位：${value}`)];
    return { state: 'ready', artifactId: artifact.id, promptLines: this.limitLines(lines, 1_800) };
  }

  private repairRequirements(run: StoredProductionRun, task: ProductionTask): VideoRepairRequirements {
    const parents = new Set(task.dependencies);
    const artifact = [...run.artifacts].reverse().find(item => item.status === 'current' && parents.has(item.taskId)
      && item.metadata.key === 'repair-report' && item.metadata.shotId === task.scope.id);
    const checks = run.qualityChecks.filter(item => parents.has(item.taskId) && item.level === 'shot' && item.result !== 'pass');
    const rawIssues = [
      ...(Array.isArray(artifact?.metadata.issues) ? artifact.metadata.issues : []),
      ...checks.flatMap(check => check.issues),
    ];
    const issues = [...new Set(rawIssues.map(value => this.boundedText(value, 220)).filter(Boolean))].slice(0, 12);
    const round = typeof artifact?.metadata.repairRound === 'number' && Number.isSafeInteger(artifact.metadata.repairRound)
      && artifact.metadata.repairRound > 0 ? artifact.metadata.repairRound : null;
    if (!artifact && !issues.length) return { artifactId: null, repairRound: null, promptLines: [] };
    const lines = [`返修要求${round ? `（第 ${round} 轮）` : ''}：`,
      ...issues.map(value => `- 必须修复：${value}`), '- 保留已确认的人物、场景、道具和构图连续性。'];
    return { artifactId: artifact?.id ?? null, repairRound: round, promptLines: this.limitLines(lines, 1_800) };
  }

  private record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
  private boundedText(value: unknown, max: number): string {
    return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max) : '';
  }
  private number(value: unknown): string | null {
    return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : null;
  }
  private vector(value: Record<string, unknown>): string {
    return `(${this.number(value.x) ?? '?'}, ${this.number(value.y) ?? '?'}, ${this.number(value.z) ?? '?'})`;
  }
  private validVector(value: Record<string, unknown>) {
    return ['x', 'y', 'z'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]));
  }
  private limitLines(lines: string[], max: number): string[] {
    const result: string[] = []; let used = 0;
    for (const line of lines) { const clean = this.boundedText(line, Math.min(500, max - used)); if (!clean) continue;
      result.push(clean); used += clean.length; if (used >= max) break; }
    return result;
  }
}
