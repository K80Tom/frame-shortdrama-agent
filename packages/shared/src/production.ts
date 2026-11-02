import { createHash, randomUUID } from 'node:crypto';
import type { FrozenAssetRetrievalPolicy } from './asset-retrieval';
import type { FrozenMethodPack } from './prompt-packs';

export const PRODUCTION_WORKFLOW_VERSION = 'ohao-production/1';
export const productionStageOrder = [
  'prepare', 'breakdown', 'assets', 'storyboard', 'director',
  'video', 'candidates', 'review', 'compose', 'deliver',
] as const;

export type ProductionStage = typeof productionStageOrder[number];
export type ProductionRunStatus = 'queued' | 'running' | 'waitingHuman' | 'paused' | 'pausedBudget'
  | 'reconciling' | 'completed' | 'partial' | 'failed' | 'cancelled';
export type ProductionTaskStatus = 'pending' | 'ready' | 'running' | 'waitingExternal' | 'validating'
  | 'retryWait' | 'reconciling' | 'waitingHuman' | 'succeeded' | 'failed' | 'cancelled'
  | 'invalidated' | 'superseded' | 'skipped';
export type AutomationMode = 'auto' | 'checkpoints' | 'coDirector';
export type QualityPreset = 'fast' | 'balanced' | 'quality';
export type DirectorPolicy = 'auto' | 'always' | 'never';
export type CandidatePolicy = 'direct' | 'gacha';
export type TaskScope = { kind: 'episode'; id: null } | { kind: 'scene' | 'shot' | 'asset'; id: string };

export class ProductionError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message); this.name = 'ProductionError';
  }
}

export interface CreateProductionRun {
  projectId: string;
  scriptVersionId: string;
  ratio: '9:16' | '16:9';
  targetDurationSec: number;
  visualStyle: string;
  qualityPreset: QualityPreset;
  automationMode: AutomationMode;
  candidatePolicy: CandidatePolicy;
  candidateLimit: number;
  directorPolicy: DirectorPolicy;
  budgetMicros: number;
  currency: string;
  allowPaid: true;
  clientRequestId: string;
}

export interface ProductionTask {
  id: string;
  runId: string;
  stage: ProductionStage;
  label: string;
  scope: TaskScope;
  status: ProductionTaskStatus;
  dependencies: string[];
  attemptCount: number;
  maxAttempts: number;
  version: number;
  blockingReason: { code: string; message: string } | null;
  inputManifest: Array<{ kind: string; id: string; revisionId: string; digest: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface TaskAttempt {
  id: string;
  runId: string;
  taskId: string;
  number: number;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  executor: string;
  inputDigest: string;
  error: { code: string; message: string } | null;
  startedAt: string;
  endedAt: string | null;
}

export interface ExternalOperation {
  id: string;
  runId: string;
  taskId: string;
  attemptId: string;
  operationKey: string;
  provider: string;
  providerTaskId: string | null;
  status: 'prepared' | 'submitting' | 'submitted' | 'polling' | 'unknown' | 'succeeded' | 'failed' | 'abandoned';
  estimatedCostMicros: number;
  actualCostMicros: number | null;
  /** Optional for historical operations. A confirmed submission may consume an estimated ceiling. */
  billingBasis?: 'estimate';
  createdAt: string;
  updatedAt: string;
}

export type ArtifactKind = 'text' | 'image' | 'audio' | 'video' | 'directorScene' | 'timeline' | 'delivery' | 'report';
export interface ProductionArtifact {
  id: string;
  runId: string;
  taskId: string;
  kind: ArtifactKind;
  title: string;
  uri: string | null;
  sha256: string | null;
  metadata: Record<string, unknown>;
  status: 'current' | 'superseded';
  createdAt: string;
}

export type CandidateKind = 'asset' | 'storyboard' | 'director' | 'video' | 'audio';
export interface ProductionCandidate {
  id: string;
  artifactId: string | null;
  label: string;
  summary: string;
  score: number | null;
  status: 'available' | 'selected' | 'rejected' | 'superseded';
  createdAt: string;
}
export interface CandidateSet {
  id: string;
  runId: string;
  taskId: string;
  kind: CandidateKind;
  scope: TaskScope;
  status: 'open' | 'selected' | 'superseded';
  selectedCandidateId: string | null;
  candidates: ProductionCandidate[];
  createdAt: string;
}

export interface ProductionIssue {
  id: string;
  runId: string;
  taskId: string | null;
  stage: ProductionStage;
  scope: TaskScope;
  severity: 'info' | 'warning' | 'error';
  status: 'open' | 'resolved';
  code: string;
  title: string;
  message: string;
  impact: string[];
  recommendedActions: string[];
  estimatedAdditionalCostMicros: number | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface QualityCheck {
  id: string;
  runId: string;
  taskId: string;
  level: 'shot' | 'scene' | 'episode';
  result: 'pass' | 'fail' | 'uncertain';
  ruleVersion: string;
  summary: string;
  issues: string[];
  createdAt: string;
}

export interface ReviewDecision {
  id: string;
  runId: string;
  taskId: string;
  issueId: string | null;
  candidateId: string | null;
  decision: 'approve' | 'reject' | 'selectCandidate' | 'resolveIssue';
  feedback: string;
  createdAt: string;
}

export interface TimelineRevision {
  id: string;
  runId: string;
  taskId: string;
  version: number;
  tracks: Array<{ kind: 'video' | 'audio' | 'subtitle'; artifactIds: string[] }>;
  durationSec: number;
  status: 'candidate' | 'adopted' | 'superseded';
  createdAt: string;
}

export interface ProductionDelivery {
  id: string;
  runId: string;
  taskId: string;
  artifactId: string;
  status: 'validating' | 'ready' | 'failed';
  spec: { ratio: '9:16' | '16:9'; durationSec: number; container: 'mp4' };
  verifiedAt: string | null;
  createdAt: string;
}

export interface BudgetEntry {
  id: string;
  runId: string;
  taskId: string | null;
  attemptId: string | null;
  kind: 'estimate' | 'reserve' | 'charge' | 'release';
  /** Charges with this basis are a conservative budget debit; the supplier did not report an amount. */
  basis?: 'frameAssessmentCeiling';
  amountMicros: number;
  currency: string;
  note: string;
  createdAt: string;
}

export interface OutboxEvent {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface StoredProductionRun extends CreateProductionRun {
  /** Absent on legacy runs. Resume and retry use only the original snapshot. */
  methodPacks?: FrozenMethodPack[];
  id: string;
  workflowVersion: typeof PRODUCTION_WORKFLOW_VERSION;
  /** Missing only in runs persisted before policy Registry P2; they retain the built-in baseline. */
  assetRetrievalPolicy?: FrozenAssetRetrievalPolicy;
  status: ProductionRunStatus;
  version: number;
  pausedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tasks: ProductionTask[];
  attempts: TaskAttempt[];
  externalOperations: ExternalOperation[];
  artifacts: ProductionArtifact[];
  candidateSets: CandidateSet[];
  issues: ProductionIssue[];
  qualityChecks: QualityCheck[];
  reviews: ReviewDecision[];
  timeline: TimelineRevision[];
  delivery: ProductionDelivery | null;
  budgetLedger: BudgetEntry[];
  outbox: OutboxEvent[];
}

export const CREATE_KEYS: Array<keyof CreateProductionRun> = ['projectId', 'scriptVersionId', 'ratio', 'targetDurationSec',
  'visualStyle', 'qualityPreset', 'automationMode', 'candidatePolicy', 'candidateLimit', 'directorPolicy', 'budgetMicros', 'currency',
  'allowPaid', 'clientRequestId'];
const safeId = /^[A-Za-z][A-Za-z0-9_-]{2,127}$/u;

function invalid(message = '创建参数不完整或超出限制。'): never {
  throw new ProductionError(400, 'PRODUCTION_REQUEST_INVALID', message);
}
function safeText(value: unknown, max: number, required = true): string {
  if (typeof value !== 'string') return invalid();
  const text = value.trim();
  const malformed = Array.from(text).some(char => { const point = char.codePointAt(0)!; return point >= 0xd800 && point <= 0xdfff; });
  if ((required && !text) || Array.from(text).length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text) || malformed) invalid();
  return text;
}

export function parseCreateProductionRun(value: unknown): CreateProductionRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== CREATE_KEYS.length
    || Object.keys(value).some(key => !CREATE_KEYS.includes(key as keyof CreateProductionRun))) invalid();
  const input = value as Record<string, unknown>;
  const projectId = safeText(input.projectId, 128); const scriptVersionId = safeText(input.scriptVersionId, 128);
  const clientRequestId = safeText(input.clientRequestId, 100);
  if (!safeId.test(projectId) || !safeId.test(scriptVersionId) || !/^[A-Za-z0-9_-]{1,100}$/u.test(clientRequestId)
    || !['9:16', '16:9'].includes(input.ratio as string)
    || !Number.isInteger(input.targetDurationSec) || Number(input.targetDurationSec) < 15 || Number(input.targetDurationSec) > 900
    || !['fast', 'balanced', 'quality'].includes(input.qualityPreset as string)
    || !['auto', 'checkpoints', 'coDirector'].includes(input.automationMode as string)
    || !['direct', 'gacha'].includes(input.candidatePolicy as string)
    || !Number.isInteger(input.candidateLimit) || Number(input.candidateLimit) < 1 || Number(input.candidateLimit) > 4
    || (input.candidatePolicy === 'direct' && Number(input.candidateLimit) !== 1)
    || (input.candidatePolicy === 'gacha' && Number(input.candidateLimit) < 2)
    || !['auto', 'always', 'never'].includes(input.directorPolicy as string)
    || !Number.isSafeInteger(input.budgetMicros) || Number(input.budgetMicros) < 0 || Number(input.budgetMicros) > 1_000_000_000_000
    || typeof input.currency !== 'string' || !/^[A-Z]{3}$/u.test(input.currency)
    || input.allowPaid !== true) invalid();
  return {
    projectId, scriptVersionId, ratio: input.ratio as CreateProductionRun['ratio'],
    targetDurationSec: Number(input.targetDurationSec), visualStyle: safeText(input.visualStyle, 1000),
    qualityPreset: input.qualityPreset as QualityPreset, automationMode: input.automationMode as AutomationMode,
    candidatePolicy: input.candidatePolicy as CandidatePolicy,
    candidateLimit: Number(input.candidateLimit), directorPolicy: input.directorPolicy as DirectorPolicy,
    budgetMicros: Number(input.budgetMicros), currency: input.currency, allowPaid: true, clientRequestId,
  };
}

export type ProductionAction = { type: 'pause' } | { type: 'resume' }
  | { type: 'raiseBudget'; budgetMicros: number; reason: string }
  | { type: 'retryTask'; taskId: string; reason: string; force?: boolean }
  | { type: 'abandonOperation'; taskId: string; reason: string }
  | { type: 'reconcileOperation'; taskId: string; reason: string };
export function parseProductionAction(value: unknown): ProductionAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('操作请求不正确。');
  const input = value as Record<string, unknown>;
  if ((input.type === 'pause' || input.type === 'resume') && Object.keys(input).length === 1) return { type: input.type };
  if (input.type === 'raiseBudget' && Object.keys(input).every(key => ['type', 'budgetMicros', 'reason'].includes(key))
    && Object.keys(input).length >= 2) {
    const budgetMicros = Number(input.budgetMicros);
    if (!Number.isFinite(budgetMicros) || !Number.isInteger(budgetMicros) || budgetMicros <= 0) return invalid('操作请求不正确。');
    return { type: 'raiseBudget', budgetMicros, reason: safeText(input.reason ?? '', 1000, false) };
  }
  if (input.type === 'retryTask' && Object.keys(input).every(key => ['type', 'taskId', 'reason', 'force'].includes(key))
    && Object.keys(input).length >= 2) {
    return { type: 'retryTask', taskId: safeText(input.taskId, 128), reason: safeText(input.reason ?? '', 1000, false),
      force: input.force === true };
  }
  if (input.type === 'abandonOperation' && Object.keys(input).every(key => ['type', 'taskId', 'reason'].includes(key))
    && Object.keys(input).length >= 2) {
    return { type: 'abandonOperation', taskId: safeText(input.taskId, 128), reason: safeText(input.reason ?? '', 1000, false) };
  }
  if (input.type === 'reconcileOperation' && Object.keys(input).every(key => ['type', 'taskId', 'reason'].includes(key))
    && Object.keys(input).length >= 2) {
    return { type: 'reconcileOperation', taskId: safeText(input.taskId, 128), reason: safeText(input.reason ?? '', 1000, false) };
  }
  return invalid('操作请求不正确。');
}

export interface ProductionReviewInput {
  taskId: string;
  decision: ReviewDecision['decision'];
  candidateId: string | null;
  issueId: string | null;
  feedback: string;
}
export function parseProductionReview(value: unknown): ProductionReviewInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('复核请求不正确。');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['taskId', 'decision', 'candidateId', 'issueId', 'feedback'].includes(key))
    || typeof input.decision !== 'string' || !['approve', 'reject', 'selectCandidate', 'resolveIssue'].includes(input.decision)) {
    return invalid('复核请求不正确。');
  }
  const nullableId = (candidate: unknown): string | null => candidate === undefined || candidate === null ? null : safeText(candidate, 128);
  return { taskId: safeText(input.taskId, 128), decision: input.decision as ReviewDecision['decision'],
    candidateId: nullableId(input.candidateId), issueId: nullableId(input.issueId),
    feedback: safeText(input.feedback ?? '', 2000, false) };
}

export function parseProductionRunId(value: string): string {
  if (!/^production_[a-f0-9]{32}$/u.test(value)) throw new ProductionError(400, 'PRODUCTION_ID_INVALID', '生产运行 ID 不正确。');
  return value;
}
export function productionId(prefix: string): string { return `${prefix}_${randomUUID().replaceAll('-', '')}`; }
export function canonicalDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function sameProductionRequest(run: StoredProductionRun, input: CreateProductionRun): boolean {
  return CREATE_KEYS.every(key => run[key] === input[key]);
}
