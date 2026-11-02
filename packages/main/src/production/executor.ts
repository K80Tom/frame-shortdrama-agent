import type {
  ArtifactKind, CandidateKind, ExternalOperation, ProductionStage, ProductionTask, QualityCheck,
  ProductionReviewInput, StoredProductionRun, TaskScope,
} from '@lyra/shared';

export interface ProductionExecutionContext {
  run: Readonly<StoredProductionRun>;
  task: Readonly<ProductionTask>;
  attemptId: string;
  inputDigest: string;
  operationKey: string | null;
}

export interface PreparedProductionExecution {
  executor: string;
  inputDigest: string;
  estimateCostMicros: number;
  requiresPaid: boolean;
  provider: string | null;
  /** The provider gives no invoice amount. Account confirmed submissions at the reserved ceiling. */
  billingBasis?: 'estimate';
  /** Prerequisites inserted before this task can be claimed, including on older run snapshots. */
  prerequisites?: SpawnTaskDraft[];
  /** Temporary local back-pressure. The scheduler leaves the task ready, does
   * not consume an attempt/budget, and may advance another independent task. */
  defer?: { code: string; message: string };
}

export interface ArtifactDraft {
  key: string;
  kind: ArtifactKind;
  title: string;
  uri?: string | null;
  sha256?: string | null;
  metadata?: Record<string, unknown>;
}
export interface CandidateSetDraft {
  kind: CandidateKind;
  scope?: TaskScope;
  candidates: Array<{ label: string; summary: string; artifactKey?: string | null; score?: number | null }>;
  recommendedIndex?: number | null;
}
export interface QualityCheckDraft {
  level: QualityCheck['level'];
  result: QualityCheck['result'];
  ruleVersion: string;
  summary: string;
  issues?: string[];
}
export interface IssueDraft {
  code: string;
  title: string;
  message: string;
  severity?: 'info' | 'warning' | 'error';
  impact?: string[];
  recommendedActions?: string[];
  estimatedAdditionalCostMicros?: number | null;
}
export interface TimelineDraft {
  tracks: Array<{ kind: 'video' | 'audio' | 'subtitle'; artifactKeys: string[] }>;
  durationSec: number;
}
export interface DeliveryDraft {
  artifactKey: string;
  durationSec: number;
  container: 'mp4';
  verified: boolean;
}
export interface SpawnTaskDraft {
  /** Stable within the parent task. Replaying the same outcome produces the same task ID. */
  key: string;
  stage: ProductionStage;
  label: string;
  scope: Exclude<TaskScope, { kind: 'episode'; id: null }>;
  /** Existing task IDs or keys from this same spawn batch. Defaults to the parent task. */
  dependsOn?: string[];
  maxAttempts?: number;
}

export type ProductionExecutorOutcome = {
  state: 'succeeded';
  artifacts?: ArtifactDraft[];
  candidateSets?: CandidateSetDraft[];
  qualityChecks?: QualityCheckDraft[];
  timeline?: TimelineDraft;
  delivery?: DeliveryDraft;
  spawnTasks?: SpawnTaskDraft[];
  /** Continue into an explicit repair subgraph after a failed/uncertain check. */
  continueOnFailedQuality?: boolean;
  /** Consume the persisted reservation; keep the provider's actual charge unknown. */
  settleAtEstimate?: true;
  actualCostMicros?: number;
} | {
  state: 'waitingHuman';
  issue: IssueDraft;
  artifacts?: ArtifactDraft[];
  candidateSets?: CandidateSetDraft[];
  qualityChecks?: QualityCheckDraft[];
  spawnTasks?: SpawnTaskDraft[];
  actualCostMicros?: number;
  /** The paid call may have happened but cannot be reconciled automatically.
   * Keep the external operation unknown and retain its budget reservation so a
   * retry cannot create a second charge. */
  operationUnknown?: true;
} | {
  state: 'blocked';
  issue: IssueDraft;
  artifacts?: ArtifactDraft[];
  candidateSets?: CandidateSetDraft[];
  qualityChecks?: QualityCheckDraft[];
  spawnTasks?: SpawnTaskDraft[];
  actualCostMicros?: number;
} | {
  state: 'waitingExternal';
  providerTaskId: string;
  actualCostMicros?: number;
} | {
  state: 'failed';
  code: string;
  message: string;
  retryable: boolean;
  actualCostMicros?: number;
};

export interface ProductionExecutor {
  readonly stage: ProductionStage;
  prepare(context: Omit<ProductionExecutionContext, 'attemptId' | 'inputDigest' | 'operationKey'>): Promise<PreparedProductionExecution>;
  execute(context: ProductionExecutionContext): Promise<ProductionExecutorOutcome>;
  reconcile?(context: ProductionExecutionContext, operation: Readonly<ExternalOperation>): Promise<ProductionExecutorOutcome>;
  /** Hooks must be idempotent: an external adoption can win before the production aggregate CAS. */
  review?(context: { run: Readonly<StoredProductionRun>; task: Readonly<ProductionTask>;
    input: Readonly<ProductionReviewInput> }): Promise<void>;
}

/** This is the only built-in executor. It performs a real deterministic check
 * of the frozen run input and never calls a model or fabricates media output. */
export class ProductionPreflightExecutor implements ProductionExecutor {
  readonly stage = 'prepare' as const;
  async prepare(context: Omit<ProductionExecutionContext, 'attemptId' | 'inputDigest' | 'operationKey'>): Promise<PreparedProductionExecution> {
    return { executor: 'builtin-preflight/1', inputDigest: context.task.inputManifest[0]!.digest,
      estimateCostMicros: 0, requiresPaid: false, provider: null };
  }
  async execute(context: ProductionExecutionContext): Promise<ProductionExecutorOutcome> {
    const run = context.run;
    return { state: 'succeeded', artifacts: [{ key: 'preflight', kind: 'report', title: '生产预检报告',
      metadata: { projectId: run.projectId, scriptVersionId: run.scriptVersionId, ratio: run.ratio,
        targetDurationSec: run.targetDurationSec, workflowVersion: run.workflowVersion,
        budgetMicros: run.budgetMicros, currency: run.currency, paidAuthorizationFrozen: run.allowPaid } }] };
  }
}
