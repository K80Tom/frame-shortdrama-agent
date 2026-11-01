import {
  PRODUCTION_WORKFLOW_VERSION, DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY, canonicalDigest, productionId, productionStageOrder,
  type CreateProductionRun, type FrozenAssetRetrievalPolicy, type OutboxEvent, type ProductionStage, type ProductionTask,
  type StoredProductionRun,
} from '@lyra/shared';

export const productionStageLabels: Record<ProductionStage, string> = {
  prepare: '输入与生产预检',
  breakdown: '剧本拆解',
  assets: '资产匹配与补齐',
  storyboard: '分镜设计',
  director: '3D 导演预演',
  video: '镜头视频生成',
  candidates: '候选抽卡与选优',
  review: '镜头技术复核',
  compose: '自动剪辑合成',
  deliver: '成片技术校验与交付',
};

function maxAttempts(input: CreateProductionRun): number {
  return input.qualityPreset === 'fast' ? 1 : input.qualityPreset === 'balanced' ? 2 : 3;
}

function initialEvent(runId: string, at: string): OutboxEvent {
  return { id: productionId('pevent'), runId, sequence: 1, type: 'production.run.created',
    payload: { workflowVersion: PRODUCTION_WORKFLOW_VERSION }, createdAt: at };
}

export function compileProductionRun(input: CreateProductionRun, now: string, id = productionId('production'),
  assetRetrievalPolicy: FrozenAssetRetrievalPolicy = DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY): StoredProductionRun {
  const requestDigest = canonicalDigest(input);
  const taskIds = Object.fromEntries(productionStageOrder.map(stage => [stage, productionId('ptask')])) as Record<ProductionStage, string>;
  const tasks: ProductionTask[] = productionStageOrder.map((stage, index) => {
    const skippedDirector = stage === 'director' && input.directorPolicy === 'never';
    const skippedCandidates = stage === 'candidates' && input.candidatePolicy === 'direct';
    return {
      id: taskIds[stage], runId: id, stage, label: productionStageLabels[stage], scope: { kind: 'episode', id: null },
      status: skippedDirector || skippedCandidates ? 'skipped' : index === 0 ? 'ready' : 'pending',
      dependencies: index === 0 ? []
        : stage === 'video' && input.directorPolicy === 'never' ? [taskIds.storyboard, taskIds.director]
        : stage === 'review' && input.candidatePolicy === 'direct' ? [taskIds.video]
        : [taskIds[productionStageOrder[index - 1]!]],
      attemptCount: 0, maxAttempts: stage === 'prepare' ? 1 : maxAttempts(input), version: 0,
      blockingReason: skippedDirector ? { code: 'DIRECTOR_POLICY_DISABLED', message: '本次运行已选择不使用 3D 预演。' }
        : skippedCandidates ? { code: 'CANDIDATE_POLICY_DISABLED', message: '本次运行选择了直出版：每镜直接生成 1 条视频，跳过候选抽卡与选优。' } : null,
      inputManifest: [
        { kind: 'script', id: input.scriptVersionId, revisionId: input.scriptVersionId, digest: requestDigest },
        { kind: 'productionPolicy', id, revisionId: PRODUCTION_WORKFLOW_VERSION, digest: requestDigest },
        { kind: 'assetRetrievalPolicy', id: assetRetrievalPolicy.sourceCandidateId ?? 'builtin', revisionId: String(assetRetrievalPolicy.registryRevision), digest: assetRetrievalPolicy.policyDigest },
      ],
      createdAt: now, updatedAt: now,
    };
  });
  // Skipping an optional stage (3D 导演预演 / 候选抽卡) must not make the next
  // stage ready before its real upstream work has completed: the dependency is
  // re-routed to the nearest stage that actually produces the required input.
  // Readiness is promoted by the scheduler after every durable transition.
  return {
    ...structuredClone(input), id, workflowVersion: PRODUCTION_WORKFLOW_VERSION, assetRetrievalPolicy,
    status: 'queued', version: 0, pausedAt: null, createdAt: now, updatedAt: now,
    tasks, attempts: [], externalOperations: [], artifacts: [], candidateSets: [], issues: [],
    qualityChecks: [], reviews: [], timeline: [], delivery: null, budgetLedger: [], outbox: [initialEvent(id, now)],
  };
}
