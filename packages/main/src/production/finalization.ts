import { canonicalDigest, type ProductionArtifact, type ProductionTask, type StoredProductionRun } from '@lyra/shared';
import type { PreparedProductionExecution, ProductionExecutionContext, ProductionExecutor,
  ProductionExecutorOutcome, SpawnTaskDraft } from './executor';
import { ProductionMediaError, summarizeAssessments, type FrameAssessmentInput, type FrameAssessmentResult,
  type FrameShotAssessment, type TimelineClipDirective,
  type TimelineComposer } from '../production-media';
import type { ProductionMediaStore } from '../production-media';

const LOCAL_MEDIA_URI = /^\/api\/production-media\/(media_[a-f0-9]{64})$/u;

/** 抽帧评估器的结构化契约：编排层只依赖这一小块能力，避免与模型实现耦合。 */
export interface FrameAssessorLike {
  assessOne(input: FrameAssessmentInput): Promise<FrameAssessmentResult>;
}

function prepared(name: string, value: unknown): PreparedProductionExecution {
  return { executor: `ohao-${name}/1`, inputDigest: canonicalDigest(value), estimateCostMicros: 0,
    requiresPaid: false, provider: null };
}

function mediaId(artifact: ProductionArtifact): string | null {
  const matched = artifact.uri ? LOCAL_MEDIA_URI.exec(artifact.uri) : null;
  return matched?.[1] ?? null;
}

function taskArtifacts(run: Readonly<StoredProductionRun>, taskIds: readonly string[], kind?: ProductionArtifact['kind']) {
  const ids = new Set(taskIds);
  return run.artifacts.filter(artifact => ids.has(artifact.taskId) && artifact.status === 'current'
    && (!kind || artifact.kind === kind));
}

function safeMediaFailure(error: unknown, code: string, message: string): ProductionExecutorOutcome {
  if (error instanceof ProductionMediaError) {
    return { state: 'blocked', issue: { code: error.code, title: '本地媒体未能通过校验', message: error.message,
      severity: 'error', recommendedActions: ['检查原视频后局部重试', '不要把临时远程链接当作交付'] } };
  }
  return { state: 'failed', code, message, retryable: false };
}

export class CandidateProductionExecutor implements ProductionExecutor {
  readonly stage = 'candidates' as const;
  constructor(private readonly store: ProductionMediaStore) {}

  async prepare({ run, task }: { run: Readonly<StoredProductionRun>; task: Readonly<ProductionTask> }) {
    return prepared(task.scope.kind === 'episode' ? 'candidate-coordinator' : 'candidate-selector', {
      runId: run.id, taskId: task.id, dependencies: task.dependencies,
    });
  }

  async execute({ run, task }: ProductionExecutionContext): Promise<ProductionExecutorOutcome> {
    if (task.scope.kind === 'episode') {
      const shotTasks = run.tasks.filter(item => item.stage === 'candidates' && item.scope.kind === 'shot');
      return { state: 'succeeded', artifacts: [{ key: 'candidate-coordinator', kind: 'report', title: '镜头候选抽卡已展开',
        metadata: { shotTasks: shotTasks.length, candidateLimit: run.candidateLimit } }] };
    }
    if (task.scope.kind !== 'shot') return { state: 'blocked', issue: { code: 'CANDIDATE_SCOPE_INVALID',
      title: '候选任务范围错误', message: '抽卡只能处理真实镜头视频。', severity: 'error' } };
    try {
      const inputs = taskArtifacts(run, task.dependencies, 'video').filter(artifact => mediaId(artifact));
      if (!inputs.length) return { state: 'blocked', issue: { code: 'LOCAL_VIDEO_CANDIDATES_MISSING',
        title: '没有可复核的本地候选', message: '镜头视频尚未下载、校验并入库，不会将临时 URL 当作抽卡结果。',
        severity: 'error', recommendedActions: ['对账原视频任务', '重新入库后局部重试'] } };
      const inspected = [] as Array<{ artifact: ProductionArtifact; score: number; summary: string }>;
      for (const artifact of inputs.slice(0, run.candidateLimit)) {
        const local = await this.store.getVideo(mediaId(artifact)!);
        const probe = local.object.probe;
        const ratio = probe.width / probe.height;
        const expected = run.ratio === '9:16' ? 9 / 16 : 16 / 9;
        const ratioPenalty = Math.min(0.3, Math.abs(ratio - expected));
        const score = Math.max(0, Math.min(1, 0.7 + (probe.hasAudio ? 0.15 : 0) +
          (probe.width * probe.height >= 1280 * 720 ? 0.15 : 0) - ratioPenalty));
        inspected.push({ artifact, score, summary: `${probe.width}×${probe.height} · ${probe.durationSeconds.toFixed(1)}s · ${probe.hasAudio ? '含音轨' : '无音轨'}` });
      }
      const best = inspected.reduce((current, item, index) => item.score > inspected[current]!.score ? index : current, 0);
      const artifacts = inspected.map((item, index) => ({ key: `take-${index + 1}`, kind: 'video' as const,
        title: `${task.label} · 候选 ${index + 1}`, uri: item.artifact.uri, sha256: item.artifact.sha256,
        metadata: { ...item.artifact.metadata, sourceArtifactId: item.artifact.id, shotId: task.scope.id,
          technicalScore: item.score } }));
      return { state: 'succeeded', artifacts, candidateSets: [{ kind: 'video', scope: task.scope,
        recommendedIndex: best, candidates: inspected.map((item, index) => ({ label: `候选 ${index + 1}`,
          summary: item.summary, artifactKey: `take-${index + 1}`, score: item.score })) }] };
    } catch (error) { return safeMediaFailure(error, 'CANDIDATE_INSPECTION_FAILED', '候选视频技术检查失败。'); }
  }
}

function selectedShotArtifact(run: Readonly<StoredProductionRun>, shotId: string): ProductionArtifact | null {
  const sets = run.candidateSets.filter(set => set.scope.kind === 'shot' && set.scope.id === shotId
    && set.status === 'selected' && set.selectedCandidateId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const set = sets.at(-1); const selected = set?.candidates.find(candidate => candidate.id === set.selectedCandidateId);
  const chosen = selected?.artifactId ? run.artifacts.find(artifact => artifact.id === selected.artifactId && artifact.status === 'current') ?? null : null;
  if (chosen) return chosen;
  // 直出版没有候选组：镜头视频任务产出的本地视频就是采用项。
  const videoTasks = new Set(run.tasks.filter(task => task.stage === 'video' && task.scope.kind === 'shot'
    && task.scope.id === shotId).map(task => task.id));
  return run.artifacts.filter(artifact => videoTasks.has(artifact.taskId) && artifact.status === 'current'
    && artifact.kind === 'video').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) ?? null;
}

function storyboardShot(run: Readonly<StoredProductionRun>, shotId: string): Record<string, unknown> | null {
  const board = run.artifacts.filter(artifact => artifact.status === 'current' && artifact.metadata.storyboardRevisionId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const shots = Array.isArray(board?.metadata.shots) ? board.metadata.shots : [];
  const value = shots.find(item => item && typeof item === 'object' && (item as Record<string, unknown>).id === shotId);
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

export class ReviewProductionExecutor implements ProductionExecutor {
  readonly stage = 'review' as const;
  constructor(private readonly store: ProductionMediaStore) {}

  async prepare({ run, task }: { run: Readonly<StoredProductionRun>; task: Readonly<ProductionTask> }) {
    return prepared(task.scope.kind === 'episode' ? 'review-coordinator' : 'technical-shot-review', {
      runId: run.id, taskId: task.id, scope: task.scope,
    });
  }

  async execute({ run, task }: ProductionExecutionContext): Promise<ProductionExecutorOutcome> {
    if (task.scope.kind === 'episode') {
      const reviews = run.tasks.filter(item => item.stage === 'review' && item.scope.kind === 'shot');
      return { state: 'succeeded', artifacts: [{ key: 'review-coordinator', kind: 'report', title: '镜头复核门已建立',
        metadata: { shotReviewTasks: reviews.length, method: 'programmatic-media-checks' } }] };
    }
    if (task.scope.kind !== 'shot') return { state: 'blocked', issue: { code: 'REVIEW_SCOPE_INVALID',
      title: '复核任务范围错误', message: '镜头复核需要真实镜头 ID。', severity: 'error' } };
    const artifact = selectedShotArtifact(run, task.scope.id);
    if (!artifact || !mediaId(artifact)) return { state: 'blocked', issue: { code: 'SELECTED_LOCAL_VIDEO_MISSING',
      title: '已选候选不可用', message: '没有找到已选且入库的本地镜头视频。', severity: 'error' } };
    try {
      const local = await this.store.getVideo(mediaId(artifact)!); const probe = local.object.probe;
      const expectedRatio = run.ratio === '9:16' ? 9 / 16 : 16 / 9;
      const actualRatio = probe.width / probe.height;
      const shot = storyboardShot(run, task.scope.id);
      const expectedSeconds = typeof shot?.durationMs === 'number' ? shot.durationMs / 1000 : null;
      const issues: string[] = [];
      if (Math.abs(actualRatio - expectedRatio) / expectedRatio > 0.035) issues.push(`画幅 ${probe.width}×${probe.height} 与 ${run.ratio} 不匹配`);
      if (!probe.hasAudio) issues.push('未检测到音轨');
      if (expectedSeconds && Math.abs(probe.durationSeconds - expectedSeconds) > Math.max(2, expectedSeconds * 0.55)) {
        issues.push(`时长 ${probe.durationSeconds.toFixed(1)}s 与分镜 ${expectedSeconds.toFixed(1)}s 偏差过大`);
      }
      if (!issues.length) return { state: 'succeeded', artifacts: [{ key: 'shot-review', kind: 'report', title: `${task.label} 通过`,
        metadata: { mediaId: local.object.id, shotId: task.scope.id, checks: ['container', 'hash', 'ratio', 'duration', 'audio'],
          semanticVideoReview: false } }], qualityChecks: [{ level: 'shot', result: 'pass', ruleVersion: 'local-shot-media/1',
        summary: '本地容器、哈希、画幅、时长与音轨检查通过' }] };

      const priorReviews = run.tasks.filter(item => item.stage === 'review' && item.scope.kind === 'shot'
        && item.scope.id === task.scope.id && item.id !== task.id).length;
      const repairLimit = run.qualityPreset === 'quality' ? 2 : run.qualityPreset === 'balanced' ? 1 : 0;
      if (run.automationMode === 'auto' && priorReviews < repairLimit) {
        const round = priorReviews + 1; const prefix = `repair-${task.scope.id}-${round}`;
        const spawnTasks: SpawnTaskDraft[] = [
          { key: `${prefix}-video`, stage: 'video', label: `${task.label} · 返修 ${round}`, scope: task.scope, dependsOn: [task.id] },
          { key: `${prefix}-candidates`, stage: 'candidates', label: `${task.label} · 返修候选`, scope: task.scope, dependsOn: [`${prefix}-video`] },
          { key: `${prefix}-review`, stage: 'review', label: `${task.label} · 返修复核`, scope: task.scope, dependsOn: [`${prefix}-candidates`] },
        ];
        return { state: 'succeeded', continueOnFailedQuality: true, spawnTasks,
          artifacts: [{ key: 'repair-report', kind: 'report', title: `${task.label} 返修报告`,
            metadata: { shotId: task.scope.id, issues, repairRound: round, semanticVideoReview: false } }],
          qualityChecks: [{ level: 'shot', result: 'fail', ruleVersion: 'local-shot-media/1',
            summary: '技术检查未通过，已进入局部返修', issues }] };
      }
      return { state: 'waitingHuman', artifacts: [{ key: 'review-report', kind: 'report', title: `${task.label} 需要处理`,
        metadata: { shotId: task.scope.id, issues, semanticVideoReview: false } }],
      qualityChecks: [{ level: 'shot', result: 'fail', ruleVersion: 'local-shot-media/1', summary: '镜头技术检查未通过', issues }],
      issue: { code: 'SHOT_MEDIA_CHECK_FAILED', title: '镜头需要返修', message: issues.join('；'), severity: 'error',
        recommendedActions: ['核对候选视频', '明确发起局部重试'] } };
    } catch (error) { return safeMediaFailure(error, 'SHOT_REVIEW_FAILED', '镜头技术复核失败。'); }
  }
}

export interface ComposeProductionExecutorOptions {
  /** 解析项目标题用于片头卡；缺省时回退到通用标题。 */
  resolveProjectTitle?: (projectId: string) => Promise<string>;
  frameAssessment?: { assessor: FrameAssessorLike; ceilingMicrosPerShot: number };
}

function composeInputs(run: Readonly<StoredProductionRun>): FrameAssessmentInput[] {
  const board = run.artifacts.filter(a => a.status === 'current' && a.metadata.storyboardRevisionId && Array.isArray(a.metadata.shots))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const shots = Array.isArray(board?.metadata.shots) ? board.metadata.shots : [];
  return shots.flatMap((shot, index) => {
    if (!shot || typeof shot.id !== 'string') return [];
    const selected = selectedShotArtifact(run, shot.id);
    const design = shot.design ?? shot;
    return [{ shotId: shot.id, mediaId: selected ? mediaId(selected) ?? '' : '', label: `镜 ${index + 1}`,
      hint: [design.visualDescription, design.shotSize].filter(value => typeof value === 'string').join('｜').slice(0, 400) }];
  });
}

function assessmentKey(input: FrameAssessmentInput) { return `frame-${canonicalDigest(input)}`; }
function isAssessmentTask(task: Readonly<ProductionTask>, input: FrameAssessmentInput) {
  return task.stage === 'compose' && task.scope.kind === 'shot' && task.scope.id === input.shotId
    && task.inputManifest.some(ref => ref.kind === 'dynamicScope' && ref.revisionId === assessmentKey(input));
}

export class ComposeProductionExecutor implements ProductionExecutor {
  readonly stage = 'compose' as const;
  constructor(private readonly composer: TimelineComposer,
    private readonly options: ComposeProductionExecutorOptions = {}) {
    if (options.frameAssessment) {
      const cost = options.frameAssessment.ceilingMicrosPerShot;
      if (!Number.isSafeInteger(cost) || cost <= 0) throw new Error('Invalid frame assessment ceiling');
    }
  }

  async prepare({ run, task }: { run: Readonly<StoredProductionRun>; task: Readonly<ProductionTask> }): Promise<PreparedProductionExecution> {
    const inputs = composeInputs(run);
    const plan = prepared('timeline-composer', { taskId: task.id, inputs });
    const policy = this.options.frameAssessment;
    if (!policy) return plan;
    if (task.scope.kind === 'shot') {
      const input = inputs.find(item => isAssessmentTask(task, item));
      return input?.mediaId && run.currency === 'CNY' ? { executor: 'frame-assessment/1', inputDigest: canonicalDigest(input),
        requiresPaid: true, provider: 'general-frame-assessment', billingBasis: 'estimate',
        estimateCostMicros: policy.ceilingMicrosPerShot } : plan;
    }
    // Insert the already configured model work at the final gate. Older saved runs can
    // reach this gate even if their storyboard and shot reviews predate assessment tasks.
    if (inputs.some(input => !input.mediaId)) return plan;
    const missing = inputs.filter(input => !run.tasks.some(t => t.status !== 'superseded' && isAssessmentTask(t, input)));
    plan.prerequisites = missing.slice(0, 500).map(input => ({
      key: assessmentKey(input), stage: 'compose', scope: { kind: 'shot', id: input.shotId },
      label: `${input.label} · 抽帧评估`,
      dependsOn: run.tasks.filter(t => task.dependencies.includes(t.id) && t.status !== 'superseded' && t.stage !== 'compose'
        && (t.scope.kind !== 'shot' || t.scope.id === input.shotId)).map(t => t.id),
    }));
    return plan;
  }

  async execute({ run, task, operationKey }: ProductionExecutionContext): Promise<ProductionExecutorOutcome> {
    const inputs = composeInputs(run);
    if (task.scope.kind === 'shot') {
      const input = inputs.find(item => isAssessmentTask(task, item));
      if (!input || !this.options.frameAssessment) return { state: 'succeeded' };
      if (run.currency !== 'CNY') return { state: 'succeeded', artifacts: [{ key: 'frame-shot-review',
        kind: 'report', title: `${input.label} · 评估币种不匹配`, metadata: { inputKey: assessmentKey(input),
          assessment: null, submission: 'notSubmitted', reason: 'FRAME_CEILING_CURRENCY_MISMATCH' } }] };
      if (!operationKey || !run.externalOperations.some(op => op.operationKey === operationKey && op.taskId === task.id
        && op.status === 'prepared' && op.billingBasis === 'estimate')) {
        return { state: 'blocked', issue: { code: 'ASSESSMENT_RESERVATION_MISSING', title: '抽帧评估缺少预算预留',
          message: '请核对镜头评估准备情况。', severity: 'error' } };
      }
      const result = await this.options.frameAssessment.assessor.assessOne(input);
      if (result.submission === 'unknown') return { state: 'waitingHuman', operationUnknown: true,
        issue: { code: 'FRAME_ASSESSMENT_SUBMISSION_UNKNOWN', title: '抽帧评估需要对账',
          message: '镜头评估可能已经计费，已保留预算。请核对供应商记录后处理。', severity: 'error' } };
      const shot = result.submission === 'answered' ? result.assessment : null;
      return { state: 'succeeded', ...(result.submission === 'answered' ? { settleAtEstimate: true } : {}),
        artifacts: [{ key: 'frame-shot-review', kind: 'report', title: `${input.label} · ${shot ? '抽帧评估' : '无剪辑建议'}`,
          metadata: { inputKey: assessmentKey(input), assessment: shot, submission: result.submission } }] };
    }
    if (task.scope.kind !== 'episode') return { state: 'blocked', issue: { code: 'COMPOSE_SCOPE_INVALID',
      title: '时间线范围错误', message: '成片时间线只能在整集范围组装。', severity: 'error' } };
    try {
      if (!inputs.length) return { state: 'blocked', issue: { code: 'STORYBOARD_SHOTS_MISSING', title: '分镜不可用',
        message: '没有已采用分镜的镜头清单，不会空编成片。', severity: 'error' } };
      const missing = inputs.find(input => !input.mediaId);
      if (missing) return { state: 'blocked', issue: { code: 'SHOT_SELECTION_INCOMPLETE', title: '镜头选片未完成',
        message: `镜头 ${missing.shotId} 没有已选且通过入库的本地视频。`, severity: 'error' } };
      const ids = inputs.map(input => input.mediaId);
      const title = await this.resolveTitle(run.projectId);
      const assessment = this.readAssessments(run, inputs);
      const manifest = await this.composer.compose({ videoIds: ids, title, edit: {
        titleCardText: title, titleCardSubtitle: 'AI 自动制作短片',
        endCardText: '本片由 AI 流水线自动生成', transitionSeconds: 0.4,
        targetSeconds: run.targetDurationSec,
        ...(assessment ? { clipDirectives: assessment.directives } : {}) } });
      const edited = manifest.composition.strategy === 'ffmpeg-auto-edit';
      return { state: 'succeeded', artifacts: [{ key: 'timeline-video', kind: 'video',
        title: edited ? '整集自动剪辑成片' : '整集时间线 MP4',
        uri: `/api/production-media/${manifest.output.id}`, sha256: manifest.output.sha256,
        metadata: { mediaId: manifest.output.id, timelineId: manifest.id, inputMediaIds: ids,
          durationSeconds: manifest.output.probe.durationSeconds, width: manifest.output.probe.width,
          height: manifest.output.probe.height, hasAudio: manifest.output.probe.hasAudio,
          autoEdit: edited, frameAssessment: assessment ? 'applied' : 'skipped',
          ...(edited ? {
            titleCardText: manifest.composition.edit?.titleCardText ?? null,
            endCardText: manifest.composition.edit?.endCardText ?? null,
            transitionSeconds: manifest.composition.edit?.transitionSeconds ?? null } : {}) } },
        ...(assessment ? [assessment.artifact] : [])],
      timeline: { tracks: [{ kind: 'video', artifactKeys: ['timeline-video'] }], durationSec: manifest.output.probe.durationSeconds },
      qualityChecks: [{ level: 'episode', result: 'pass', ruleVersion: edited ? 'local-auto-edit/1' : 'local-timeline-compose/1',
        summary: edited ? '镜头按分镜顺序叠化剪辑，附加片头片尾卡，输出本地 MP4'
          : '所有已选镜头已按分镜顺序合成为本地 MP4' }] };
    } catch (error) { return safeMediaFailure(error, 'TIMELINE_COMPOSE_FAILED', '整集时间线合成失败。'); }
  }

  private async resolveTitle(projectId: string): Promise<string> {
    try { return await this.options.resolveProjectTitle?.(projectId) ?? '整集自动制作成片'; }
    catch { return '整集自动制作成片'; }
  }

  /** 把抽帧评估结论转换成剪辑指令，并留下可追溯的评估报告产物。 */
  private readAssessments(run: Readonly<StoredProductionRun>, inputs: FrameAssessmentInput[]) {
    const shots = inputs.flatMap(input => {
      const key = assessmentKey(input);
      const report = run.artifacts.filter(a => a.status === 'current' && a.metadata.key === 'frame-shot-review'
        && a.metadata.inputKey === key).at(-1);
      const item = report?.metadata.assessment as FrameShotAssessment | null | undefined;
      return item?.shotId === input.shotId && item.advice ? [item] : [];
    });
    if (!shots.length) return null;
    const directives: TimelineClipDirective[] = [];
    for (const item of shots) {
      const media = inputs.find(input => input.shotId === item.shotId)?.mediaId;
      if (!media) continue;
      if (item.advice.action === 'drop') directives.push({ videoId: media, action: 'drop' });
      else if (item.advice.action === 'trim' && item.advice.trimSeconds) {
        directives.push({ videoId: media, action: 'trim', trimSeconds: item.advice.trimSeconds });
      } else if (item.advice.action === 'speedup' && item.advice.speedFactor > 1) {
        directives.push({ videoId: media, action: 'speedup', speedFactor: item.advice.speedFactor });
      }
    }
    return { directives, artifact: { key: 'frame-review', kind: 'report' as const, title: '镜头抽帧评估',
      metadata: { shots, summary: summarizeAssessments(shots), directiveCount: directives.length } } };
  }
}

export class DeliveryProductionExecutor implements ProductionExecutor {
  readonly stage = 'deliver' as const;
  constructor(private readonly store: ProductionMediaStore) {}

  async prepare({ run, task }: { run: Readonly<StoredProductionRun>; task: Readonly<ProductionTask> }) {
    const timeline = run.artifacts.filter(artifact => artifact.status === 'current' && artifact.metadata.timelineId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    return prepared('delivery-verifier', { runId: run.id, taskId: task.id, artifactId: timeline?.id ?? null,
      sha256: timeline?.sha256 ?? null });
  }

  async execute({ run, task }: ProductionExecutionContext): Promise<ProductionExecutorOutcome> {
    if (task.scope.kind !== 'episode') return { state: 'blocked', issue: { code: 'DELIVERY_SCOPE_INVALID',
      title: '交付范围错误', message: '最终交付只能校验整集成片。', severity: 'error' } };
    const source = run.artifacts.filter(artifact => artifact.status === 'current' && artifact.kind === 'video'
      && artifact.metadata.timelineId && mediaId(artifact)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    if (!source) return { state: 'blocked', issue: { code: 'LOCAL_TIMELINE_MISSING', title: '本地成片缺失',
      message: '时间线尚未形成本地可校验 MP4，不会标记为交付。', severity: 'error' } };
    try {
      const local = await this.store.getVideo(mediaId(source)!); const probe = local.object.probe;
      const expectedRatio = run.ratio === '9:16' ? 9 / 16 : 16 / 9;
      const issues: string[] = [];
      if (Math.abs(probe.width / probe.height - expectedRatio) / expectedRatio > 0.035) issues.push('最终画幅与已冻结画幅不一致');
      if (!probe.hasAudio) issues.push('最终成片没有音轨');
      if (probe.durationSeconds <= 0 || probe.durationSeconds > 900) issues.push('最终时长超出交付范围');
      const durationRatio = run.qualityPreset === 'quality' ? 0.12 : run.qualityPreset === 'balanced' ? 0.2 : 0.3;
      const durationTolerance = Math.max(3, run.targetDurationSec * durationRatio);
      if (Math.abs(probe.durationSeconds - run.targetDurationSec) > durationTolerance) {
        issues.push(`最终时长 ${probe.durationSeconds.toFixed(1)}s 与冻结目标 ${run.targetDurationSec}s 偏差过大`);
      }
      if (issues.length) return { state: 'waitingHuman', artifacts: [{ key: 'delivery-report', kind: 'report', title: '成片校验报告',
        metadata: { mediaId: local.object.id, issues, targetDurationSec: run.targetDurationSec, durationTolerance } }], qualityChecks: [{ level: 'episode', result: 'fail',
          ruleVersion: 'local-delivery/2', summary: '最终成片技术校验未通过', issues }],
        issue: { code: 'DELIVERY_CHECK_FAILED', title: '成片校验未通过', message: issues.join('；'), severity: 'error' } };
      return { state: 'succeeded', artifacts: [{ key: 'master', kind: 'delivery', title: '最终成片 MP4',
        uri: `/api/production-media/${local.object.id}`, sha256: local.object.sha256,
        metadata: { mediaId: local.object.id, sourceArtifactId: source.id, durationSeconds: probe.durationSeconds,
          width: probe.width, height: probe.height, hasAudio: probe.hasAudio, verifiedLocal: true,
          targetDurationSec: run.targetDurationSec, durationTolerance } }],
      qualityChecks: [{ level: 'episode', result: 'pass', ruleVersion: 'local-delivery/2',
        summary: '最终成片通过本地哈希、容器、画幅、目标时长与音轨技术校验' }],
      delivery: { artifactKey: 'master', durationSec: probe.durationSeconds, container: 'mp4', verified: true } };
    } catch (error) { return safeMediaFailure(error, 'DELIVERY_VERIFY_FAILED', '最终成片校验失败。'); }
  }
}
