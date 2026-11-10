import { randomUUID } from 'node:crypto';
import {
  assetRetrievalPolicyDigest,
  assertAssetRetrievalPolicy,
  DEFAULT_ASSET_RETRIEVAL_POLICY,
  type AssetRetrievalPolicy,
} from './asset-retrieval';
import {
  EVALUATION_DATASET_SCHEMA_VERSION,
  type EvaluationAuthorization,
  type EvaluationCase,
  type EvaluationProvenance,
  type SensitivityLevel,
} from './evaluation';
import { canonicalDigest } from './production';

/**
 * 资产检索策略治理领域契约（#128）。
 *
 * 本文件只定义不可变观测/决策、数据集 revision、候选载荷与确定性参数搜索；
 * 正式 Dataset/Evaluation/Scorecard 由 #134 持有，Candidate/Canary/Adopt/Rollback
 * 由 #135 持有。这里不复制任何治理状态机，只保存 typed refs。
 */

export const ASSET_RETRIEVAL_GOVERNANCE_SCHEMA_VERSION = 'asset-retrieval-governance/1';
export const ASSET_RETRIEVAL_DATASET_SCHEMA_VERSION = 'asset-retrieval-dataset/1';
export const ASSET_RETRIEVAL_POLICY_PAYLOAD_SCHEMA_VERSION = 'asset-retrieval-policy-payload/1';
export const ASSET_RETRIEVAL_SEARCH_ALGORITHM_VERSION = 'bounded-grid-v1';
export const ASSET_RETRIEVAL_EVALUATOR_ADAPTER_VERSION = 'asset-retrieval-observation-adapter/1';

export const ASSET_RETRIEVAL_OBSERVATION_ID_PREFIX = 'arobs';
export const ASSET_RETRIEVAL_DECISION_ID_PREFIX = 'ardec';
export const ASSET_RETRIEVAL_DATASET_REVISION_ID_PREFIX = 'ardsrev';
export const ASSET_RETRIEVAL_POLICY_PAYLOAD_ID_PREFIX = 'arpayload';

export type AssetRetrievalObservationMode = 'lexical' | 'hybrid' | 'degraded-lexical' | 'blocked';
export const ASSET_RETRIEVAL_OBSERVATION_MODES: readonly AssetRetrievalObservationMode[] = Object.freeze([
  'lexical', 'hybrid', 'degraded-lexical', 'blocked',
]);

export type AssetRetrievalDecisionKind = 'accept' | 'reject' | 'override' | 'regenerate' | 'abstain';
export const ASSET_RETRIEVAL_DECISION_KINDS: readonly AssetRetrievalDecisionKind[] = Object.freeze([
  'accept', 'reject', 'override', 'regenerate', 'abstain',
]);

export type AssetRetrievalAuthorizationQuality = 'clean' | 'unknown' | 'revoked' | 'cross_tenant' | 'unverified';
export const ASSET_RETRIEVAL_AUTHORIZATION_QUALITIES: readonly AssetRetrievalAuthorizationQuality[] = Object.freeze([
  'clean', 'unknown', 'revoked', 'cross_tenant', 'unverified',
]);

export type AssetRetrievalDecisionOutcome = 'pending' | 'success' | 'failure';
export const ASSET_RETRIEVAL_DECISION_OUTCOMES: readonly AssetRetrievalDecisionOutcome[] = Object.freeze([
  'pending', 'success', 'failure',
]);

export type AssetRetrievalDatasetPurpose = 'policy_search' | 'regression' | 'shadow' | 'evaluation';
export const ASSET_RETRIEVAL_DATASET_PURPOSES: readonly AssetRetrievalDatasetPurpose[] = Object.freeze([
  'policy_search', 'regression', 'shadow', 'evaluation',
]);

export type AssetRetrievalGovernanceErrorSource = 'asset' | 'eval' | 'governance';

export class AssetRetrievalGovernanceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly source: AssetRetrievalGovernanceErrorSource = 'governance',
  ) {
    super(message);
    this.name = 'AssetRetrievalGovernanceError';
  }
}

function fail(status: number, code: string, message: string,
  source: AssetRetrievalGovernanceErrorSource = 'governance'): never {
  throw new AssetRetrievalGovernanceError(status, code, message, source);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'ASSET_RETRIEVAL_INPUT_INVALID',
    `${path} 必须是对象。`, 'asset');
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    fail(400, 'ASSET_RETRIEVAL_INPUT_INVALID', `${path} 必须是 1..${max} 字符。`, 'asset');
  }
  return normalizeGovernanceText(value);
}

function optionalText(value: unknown, path: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  return text(value, path, max);
}

function finite(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(400, 'ASSET_RETRIEVAL_INPUT_INVALID', `${path} 必须在 ${min}..${max} 之间。`, 'asset');
  }
  return value;
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(400, 'ASSET_RETRIEVAL_INPUT_INVALID', `${path} 必须是 ${min}..${max} 的整数。`, 'asset');
  }
  return value as number;
}

function hex64(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    fail(400, 'ASSET_RETRIEVAL_INPUT_INVALID', `${path} 必须是 sha256 hex。`, 'asset');
  }
  return value;
}

function stringArray(value: unknown, path: string, maxItems = 64): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    fail(400, 'ASSET_RETRIEVAL_INPUT_INVALID', `${path} 必须是不超过 ${maxItems} 项的数组。`, 'asset');
  }
  return value.map((item, index) => text(item, `${path}[${index}]`, 160));
}

export function normalizeGovernanceText(value: string): string {
  return value.trim().replaceAll(/\s+/gu, ' ');
}

export function assetRetrievalGovernanceId(
  prefix: 'arobs' | 'ardec' | 'ardsrev' | 'arpayload',
): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

export function assertAssetRetrievalObservationId(value: string): string {
  if (!/^arobs_[a-f0-9]{32}$/u.test(value)) fail(400, 'ASSET_RETRIEVAL_ID_INVALID', '检索观测标识无效。', 'asset');
  return value;
}
export function assertAssetRetrievalDecisionId(value: string): string {
  if (!/^ardec_[a-f0-9]{32}$/u.test(value)) fail(400, 'ASSET_RETRIEVAL_ID_INVALID', '检索决策标识无效。', 'asset');
  return value;
}
export function assertAssetRetrievalDatasetRevisionId(value: string): string {
  if (!/^ardsrev_[a-f0-9]{32}$/u.test(value)) fail(400, 'ASSET_RETRIEVAL_ID_INVALID', '数据集 revision 标识无效。', 'asset');
  return value;
}
export function assertAssetRetrievalPolicyPayloadId(value: string): string {
  if (!/^arpayload_[a-f0-9]{32}$/u.test(value)) fail(400, 'ASSET_RETRIEVAL_ID_INVALID', '策略候选载荷标识无效。', 'asset');
  return value;
}

/* -------------------------------------------------------------------------- */
/* Observation                                                                */
/* -------------------------------------------------------------------------- */

export interface AssetRetrievalQuerySnapshot {
  text: string;
  normalizedText: string;
  queryDigest: string;
  filters: { kinds: string[]; statuses: string[] };
  limit: number;
}

export interface AssetRetrievalCandidateObservation {
  assetId: string;
  assetVersionId: string | null;
  assetVersionDigest: string | null;
  assetName: string;
  assetKind: string;
  assetStatus: string;
  rank: number;
  lexicalScore: number | null;
  semanticScore: number | null;
  finalScore: number;
  combinedScore: number | null;
  matchedFields: string[];
  matchedTerms: string[];
  filterReasons: string[];
  explanation: string;
  authorizationQuality: AssetRetrievalAuthorizationQuality;
}

export interface AssetRetrievalCatalogSnapshot {
  assetCatalogVersion: string;
  indexAlias: string;
  indexCollection: string;
  embeddingModel: string;
  embeddingRevision: string;
  authorizationPolicyVersion: string;
  authorizationSnapshotDigest: string;
}

export interface AssetRetrievalObservationStrategy {
  mode: AssetRetrievalObservationMode;
  ruleVersion: string;
  policyVersion: string;
  policy: AssetRetrievalPolicy;
  policyDigest: string;
  catalog: AssetRetrievalCatalogSnapshot;
  retrievalLimit: number;
}

export interface AssetRetrievalObservation {
  schemaVersion: typeof ASSET_RETRIEVAL_GOVERNANCE_SCHEMA_VERSION;
  observationId: string;
  workspaceId: string;
  projectId: string | null;
  shotId: string | null;
  requestId: string;
  clientRequestId: string;
  query: AssetRetrievalQuerySnapshot;
  strategy: AssetRetrievalObservationStrategy;
  candidates: AssetRetrievalCandidateObservation[];
  degradedReason: string | null;
  latencyMs: number;
  costMicros: number;
  observedAt: string;
  contentDigest: string;
}

export interface RecordAssetRetrievalObservationInput {
  observationId?: string;
  projectId: string | null;
  shotId: string | null;
  requestId: string;
  clientRequestId: string;
  query: { text: string; filters?: { kinds?: string[]; statuses?: string[] }; limit?: number };
  strategy: { mode: AssetRetrievalObservationMode; ruleVersion: string; policyVersion: string;
    policy: AssetRetrievalPolicy; catalog: AssetRetrievalCatalogSnapshot; retrievalLimit: number };
  candidates: AssetRetrievalCandidateObservation[];
  degradedReason: string | null;
  latencyMs: number;
  costMicros: number;
  observedAt: string;
}

export interface ParsedAssetRetrievalObservationInput {
  observationId?: string;
  projectId: string | null;
  shotId: string | null;
  requestId: string;
  clientRequestId: string;
  query: AssetRetrievalQuerySnapshot;
  strategy: AssetRetrievalObservationStrategy;
  candidates: AssetRetrievalCandidateObservation[];
  degradedReason: string | null;
  latencyMs: number;
  costMicros: number;
  observedAt: string;
}

function querySnapshot(input: unknown): AssetRetrievalQuerySnapshot {
  const raw = object(input, 'query');
  const textValue = text(raw.text, 'query.text', 500);
  const filters = raw.filters === undefined ? {} : object(raw.filters, 'query.filters');
  const kinds = filters.kinds === undefined ? [] : stringArray(filters.kinds, 'query.filters.kinds');
  const statuses = filters.statuses === undefined ? [] : stringArray(filters.statuses, 'query.filters.statuses');
  const limit = raw.limit === undefined ? 12 : integer(raw.limit, 'query.limit', 1, 50);
  const normalized = normalizeGovernanceText(textValue).toLocaleLowerCase('zh-CN');
  return {
    text: textValue,
    normalizedText: normalized,
    queryDigest: canonicalDigest({ text: normalized, kinds: [...kinds].sort(), statuses: [...statuses].sort(), limit }),
    filters: { kinds: [...kinds].sort(), statuses: [...statuses].sort() },
    limit,
  };
}

function catalogSnapshot(input: unknown): AssetRetrievalCatalogSnapshot {
  const raw = object(input, 'strategy.catalog');
  return {
    assetCatalogVersion: text(raw.assetCatalogVersion, 'strategy.catalog.assetCatalogVersion', 160),
    indexAlias: text(raw.indexAlias, 'strategy.catalog.indexAlias', 160),
    indexCollection: text(raw.indexCollection, 'strategy.catalog.indexCollection', 160),
    embeddingModel: text(raw.embeddingModel, 'strategy.catalog.embeddingModel', 160),
    embeddingRevision: text(raw.embeddingRevision, 'strategy.catalog.embeddingRevision', 160),
    authorizationPolicyVersion: text(raw.authorizationPolicyVersion, 'strategy.catalog.authorizationPolicyVersion', 160),
    authorizationSnapshotDigest: hex64(raw.authorizationSnapshotDigest, 'strategy.catalog.authorizationSnapshotDigest'),
  };
}

function candidateObservation(input: unknown, index: number): AssetRetrievalCandidateObservation {
  const raw = object(input, `candidates[${index}]`);
  return {
    assetId: text(raw.assetId, `candidates[${index}].assetId`, 160),
    assetVersionId: optionalText(raw.assetVersionId, `candidates[${index}].assetVersionId`, 160),
    assetVersionDigest: raw.assetVersionDigest === undefined || raw.assetVersionDigest === null
      ? null : hex64(raw.assetVersionDigest, `candidates[${index}].assetVersionDigest`),
    assetName: text(raw.assetName, `candidates[${index}].assetName`, 200),
    assetKind: text(raw.assetKind, `candidates[${index}].assetKind`, 80),
    assetStatus: text(raw.assetStatus, `candidates[${index}].assetStatus`, 80),
    rank: integer(raw.rank, `candidates[${index}].rank`, 1, 50),
    lexicalScore: raw.lexicalScore === undefined || raw.lexicalScore === null ? null
      : finite(raw.lexicalScore, `candidates[${index}].lexicalScore`, 0, 1),
    semanticScore: raw.semanticScore === undefined || raw.semanticScore === null ? null
      : finite(raw.semanticScore, `candidates[${index}].semanticScore`, 0, 1),
    finalScore: finite(raw.finalScore, `candidates[${index}].finalScore`, 0, 1),
    combinedScore: raw.combinedScore === undefined || raw.combinedScore === null ? null
      : finite(raw.combinedScore, `candidates[${index}].combinedScore`, 0, 1),
    matchedFields: raw.matchedFields === undefined ? [] : stringArray(raw.matchedFields, `candidates[${index}].matchedFields`, 20),
    matchedTerms: raw.matchedTerms === undefined ? [] : stringArray(raw.matchedTerms, `candidates[${index}].matchedTerms`, 20),
    filterReasons: raw.filterReasons === undefined ? [] : stringArray(raw.filterReasons, `candidates[${index}].filterReasons`, 20),
    explanation: text(raw.explanation, `candidates[${index}].explanation`, 500),
    authorizationQuality: ASSET_RETRIEVAL_AUTHORIZATION_QUALITIES.includes(
      raw.authorizationQuality as AssetRetrievalAuthorizationQuality)
      ? raw.authorizationQuality as AssetRetrievalAuthorizationQuality
      : fail(400, 'ASSET_RETRIEVAL_INPUT_INVALID', `candidates[${index}].authorizationQuality 无效。`, 'asset'),
  };
}

function strategySnapshot(input: unknown): AssetRetrievalObservationStrategy {
  const raw = object(input, 'strategy');
  const policy = object(raw.policy, 'strategy.policy');
  const parsedPolicy: AssetRetrievalPolicy = {
    threshold: finite(policy.threshold, 'strategy.policy.threshold', 0, 1),
    ambiguityMargin: finite(policy.ambiguityMargin, 'strategy.policy.ambiguityMargin', 0, 0.5),
    semanticWeight: finite(policy.semanticWeight, 'strategy.policy.semanticWeight', 0, 1),
  };
  assertAssetRetrievalPolicy(parsedPolicy);
  const mode = raw.mode;
  if (!ASSET_RETRIEVAL_OBSERVATION_MODES.includes(mode as AssetRetrievalObservationMode)) {
    fail(400, 'ASSET_RETRIEVAL_INPUT_INVALID', 'strategy.mode 无效。', 'asset');
  }
  return {
    mode: mode as AssetRetrievalObservationMode,
    ruleVersion: text(raw.ruleVersion, 'strategy.ruleVersion', 80),
    policyVersion: text(raw.policyVersion, 'strategy.policyVersion', 160),
    policy: parsedPolicy,
    policyDigest: assetRetrievalPolicyDigest(parsedPolicy),
    catalog: catalogSnapshot(raw.catalog),
    retrievalLimit: integer(raw.retrievalLimit, 'strategy.retrievalLimit', 1, 50),
  };
}

export function parseRecordAssetRetrievalObservationInput(value: unknown): ParsedAssetRetrievalObservationInput {
  const raw = object(value, 'observation');
  const candidatesRaw = raw.candidates;
  if (!Array.isArray(candidatesRaw) || candidatesRaw.length > 50) {
    fail(400, 'ASSET_RETRIEVAL_INPUT_INVALID', 'candidates 必须是不超过 50 项的数组。', 'asset');
  }
  const candidates = candidatesRaw.map(candidateObservation);
  if (new Set(candidates.map(item => item.assetId)).size !== candidates.length) {
    fail(400, 'ASSET_RETRIEVAL_INPUT_INVALID', 'candidates.assetId 不能重复。', 'asset');
  }
  if (new Set(candidates.map(item => item.rank)).size !== candidates.length) {
    fail(400, 'ASSET_RETRIEVAL_INPUT_INVALID', 'candidates.rank 不能重复。', 'asset');
  }
  const input: ParsedAssetRetrievalObservationInput = {
    observationId: raw.observationId === undefined ? undefined
      : assertAssetRetrievalObservationId(text(raw.observationId, 'observation.observationId', 160)),
    projectId: optionalText(raw.projectId, 'projectId', 160),
    shotId: optionalText(raw.shotId, 'shotId', 160),
    requestId: text(raw.requestId, 'requestId', 200),
    clientRequestId: text(raw.clientRequestId, 'clientRequestId', 200),
    query: querySnapshot(raw.query),
    strategy: strategySnapshot(raw.strategy),
    candidates,
    degradedReason: optionalText(raw.degradedReason, 'degradedReason', 500),
    latencyMs: integer(raw.latencyMs, 'latencyMs', 0, 3_600_000),
    costMicros: integer(raw.costMicros, 'costMicros', 0, 1_000_000_000),
    observedAt: raw.observedAt === undefined ? '' : text(raw.observedAt, 'observedAt', 64),
  };
  return input;
}

export function assetRetrievalObservationDigest(value: Omit<AssetRetrievalObservation, 'contentDigest'>): string {
  return canonicalDigest({
    schemaVersion: value.schemaVersion,
    observationId: value.observationId,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    shotId: value.shotId,
    requestId: value.requestId,
    clientRequestId: value.clientRequestId,
    query: value.query,
    strategy: value.strategy,
    candidates: value.candidates,
    degradedReason: value.degradedReason,
    latencyMs: value.latencyMs,
    costMicros: value.costMicros,
    observedAt: value.observedAt,
  });
}

export function freezeAssetRetrievalObservation(
  workspaceId: string, input: RecordAssetRetrievalObservationInput, at: string,
): AssetRetrievalObservation {
  if (!workspaceId.trim()) fail(403, 'ASSET_RETRIEVAL_WORKSPACE_REQUIRED', '缺少有效的工作区。', 'asset');
  const observationId = input.observationId ?? assetRetrievalGovernanceId(ASSET_RETRIEVAL_OBSERVATION_ID_PREFIX);
  const parsed = parseRecordAssetRetrievalObservationInput({ ...input, observationId, observedAt: input.observedAt || at });
  const base = {
    schemaVersion: ASSET_RETRIEVAL_GOVERNANCE_SCHEMA_VERSION,
    observationId,
    workspaceId,
    projectId: parsed.projectId,
    shotId: parsed.shotId,
    requestId: parsed.requestId,
    clientRequestId: parsed.clientRequestId,
    query: parsed.query,
    strategy: parsed.strategy,
    candidates: parsed.candidates,
    degradedReason: parsed.degradedReason,
    latencyMs: parsed.latencyMs,
    costMicros: parsed.costMicros,
    observedAt: parsed.observedAt,
  } satisfies Omit<AssetRetrievalObservation, 'contentDigest'>;
  return { ...base, contentDigest: assetRetrievalObservationDigest(base) };
}

/* -------------------------------------------------------------------------- */
/* Decision                                                                   */
/* -------------------------------------------------------------------------- */

export interface AssetRetrievalDecisionAuthorization {
  quality: AssetRetrievalAuthorizationQuality;
  verifiedAt: string | null;
  note: string;
}

export interface AssetRetrievalDecisionOutcomeSnapshot {
  status: AssetRetrievalDecisionOutcome;
  runId: string | null;
}

export interface AssetRetrievalDecision {
  schemaVersion: typeof ASSET_RETRIEVAL_GOVERNANCE_SCHEMA_VERSION;
  decisionId: string;
  workspaceId: string;
  observationId: string;
  clientRequestId: string;
  decision: AssetRetrievalDecisionKind;
  selectedAssetId: string | null;
  selectedAssetVersionId: string | null;
  reason: string;
  actorId: string;
  authorization: AssetRetrievalDecisionAuthorization;
  outcome: AssetRetrievalDecisionOutcomeSnapshot;
  createdAt: string;
  contentDigest: string;
}

export interface RecordAssetRetrievalDecisionInput {
  decisionId?: string;
  observationId: string;
  clientRequestId: string;
  decision: AssetRetrievalDecisionKind;
  selectedAssetId: string | null;
  selectedAssetVersionId: string | null;
  reason: string;
  actorId: string;
  authorization?: Partial<AssetRetrievalDecisionAuthorization>;
  outcome?: Partial<AssetRetrievalDecisionOutcomeSnapshot>;
  createdAt: string;
}

export interface ParsedAssetRetrievalDecisionInput {
  decisionId?: string;
  observationId: string;
  clientRequestId: string;
  decision: AssetRetrievalDecisionKind;
  selectedAssetId: string | null;
  selectedAssetVersionId: string | null;
  reason: string;
  actorId: string;
  authorization: AssetRetrievalDecisionAuthorization;
  outcome: AssetRetrievalDecisionOutcomeSnapshot;
  createdAt: string;
}

export function parseRecordAssetRetrievalDecisionInput(value: unknown): ParsedAssetRetrievalDecisionInput {
  const raw = object(value, 'decision');
  if (!ASSET_RETRIEVAL_DECISION_KINDS.includes(raw.decision as AssetRetrievalDecisionKind)) {
    fail(400, 'ASSET_RETRIEVAL_DECISION_INVALID', 'decision 必须是 accept/reject/override/regenerate/abstain。', 'asset');
  }
  const kind = raw.decision as AssetRetrievalDecisionKind;
  const selectedAssetId = optionalText(raw.selectedAssetId, 'selectedAssetId', 160);
  if ((kind === 'accept' || kind === 'override') && !selectedAssetId) {
    fail(400, 'ASSET_RETRIEVAL_DECISION_INVALID', 'accept/override 必须给出 selectedAssetId。', 'asset');
  }
  if ((kind === 'reject' || kind === 'regenerate' || kind === 'abstain') && selectedAssetId !== null) {
    fail(400, 'ASSET_RETRIEVAL_DECISION_INVALID', `${kind} 不能把选中资产写成复用结果。`, 'asset');
  }
  const authorizationRaw = raw.authorization === undefined ? {} : object(raw.authorization, 'authorization');
  const quality = authorizationRaw.quality === undefined ? 'clean'
    : authorizationRaw.quality;
  if (!ASSET_RETRIEVAL_AUTHORIZATION_QUALITIES.includes(quality as AssetRetrievalAuthorizationQuality)) {
    fail(400, 'ASSET_RETRIEVAL_DECISION_INVALID', 'authorization.quality 无效。', 'asset');
  }
  const outcomeRaw = raw.outcome === undefined ? {} : object(raw.outcome, 'outcome');
  const outcome = outcomeRaw.status === undefined ? 'pending' : outcomeRaw.status;
  if (!ASSET_RETRIEVAL_DECISION_OUTCOMES.includes(outcome as AssetRetrievalDecisionOutcome)) {
    fail(400, 'ASSET_RETRIEVAL_DECISION_INVALID', 'outcome.status 无效。', 'asset');
  }
  return {
    decisionId: raw.decisionId === undefined ? undefined
      : assertAssetRetrievalDecisionId(text(raw.decisionId, 'decision.decisionId', 160)),
    observationId: assertAssetRetrievalObservationId(text(raw.observationId, 'observationId', 160)),
    clientRequestId: text(raw.clientRequestId, 'clientRequestId', 200),
    decision: kind,
    selectedAssetId,
    selectedAssetVersionId: optionalText(raw.selectedAssetVersionId, 'selectedAssetVersionId', 160),
    reason: text(raw.reason, 'reason', 500),
    actorId: text(raw.actorId, 'actorId', 200),
    authorization: {
      quality: quality as AssetRetrievalAuthorizationQuality,
      verifiedAt: authorizationRaw.verifiedAt === undefined || authorizationRaw.verifiedAt === null
        ? null : text(authorizationRaw.verifiedAt, 'authorization.verifiedAt', 64),
      note: authorizationRaw.note === undefined || authorizationRaw.note === ''
        ? '' : text(authorizationRaw.note, 'authorization.note', 500),
    },
    outcome: {
      status: outcome as AssetRetrievalDecisionOutcome,
      runId: outcomeRaw.runId === undefined || outcomeRaw.runId === null
        ? null : text(outcomeRaw.runId, 'outcome.runId', 200),
    },
    createdAt: raw.createdAt === undefined ? '' : text(raw.createdAt, 'createdAt', 64),
  };
}

export function assetRetrievalDecisionDigest(value: Omit<AssetRetrievalDecision, 'contentDigest'>): string {
  return canonicalDigest({
    schemaVersion: value.schemaVersion,
    decisionId: value.decisionId,
    workspaceId: value.workspaceId,
    observationId: value.observationId,
    clientRequestId: value.clientRequestId,
    decision: value.decision,
    selectedAssetId: value.selectedAssetId,
    selectedAssetVersionId: value.selectedAssetVersionId,
    reason: value.reason,
    actorId: value.actorId,
    authorization: value.authorization,
    outcome: value.outcome,
    createdAt: value.createdAt,
  });
}

export function freezeAssetRetrievalDecision(
  workspaceId: string, input: RecordAssetRetrievalDecisionInput, at: string,
): AssetRetrievalDecision {
  if (!workspaceId.trim()) fail(403, 'ASSET_RETRIEVAL_WORKSPACE_REQUIRED', '缺少有效的工作区。', 'asset');
  const decisionId = input.decisionId ?? assetRetrievalGovernanceId(ASSET_RETRIEVAL_DECISION_ID_PREFIX);
  const parsed = parseRecordAssetRetrievalDecisionInput({ ...input, decisionId, createdAt: input.createdAt || at });
  const base = {
    schemaVersion: ASSET_RETRIEVAL_GOVERNANCE_SCHEMA_VERSION,
    decisionId,
    workspaceId,
    observationId: parsed.observationId,
    clientRequestId: parsed.clientRequestId,
    decision: parsed.decision,
    selectedAssetId: parsed.selectedAssetId,
    selectedAssetVersionId: parsed.selectedAssetVersionId,
    reason: parsed.reason,
    actorId: parsed.actorId,
    authorization: parsed.authorization,
    outcome: parsed.outcome,
    createdAt: parsed.createdAt,
  } satisfies Omit<AssetRetrievalDecision, 'contentDigest'>;
  return { ...base, contentDigest: assetRetrievalDecisionDigest(base) };
}

/* -------------------------------------------------------------------------- */
/* Dataset revision                                                           */
/* -------------------------------------------------------------------------- */

export interface AssetRetrievalDatasetFilters {
  labeledOnly: boolean;
  includeDegraded: boolean;
  modes: AssetRetrievalObservationMode[];
  projectIds: string[];
  excludeAuthorizationQualities: AssetRetrievalAuthorizationQuality[];
}

export interface AssetRetrievalDatasetSplit {
  seed: string;
  trainRatio: number;
  trainObservationIds: string[];
  validationObservationIds: string[];
}

export interface AssetRetrievalDatasetRevision {
  schemaVersion: typeof ASSET_RETRIEVAL_DATASET_SCHEMA_VERSION;
  datasetRevisionId: string;
  workspaceId: string;
  purpose: AssetRetrievalDatasetPurpose;
  source: { observationIds: string[]; decisionIds: string[] };
  filters: AssetRetrievalDatasetFilters;
  split: AssetRetrievalDatasetSplit;
  snapshot: AssetRetrievalCatalogSnapshot;
  sampleCount: number;
  labeledSampleCount: number;
  deduplicatedCount: number;
  payloadDigest: string;
  createdBy: string;
  reviewedBy: string | null;
  contentSummary: string;
  createdAt: string;
  evaluationDatasetVersionId: string | null;
}

export interface CreateAssetRetrievalDatasetRevisionInput {
  datasetRevisionId?: string;
  purpose: AssetRetrievalDatasetPurpose;
  observationIds: string[];
  filters?: Partial<AssetRetrievalDatasetFilters>;
  splitSeed?: string;
  trainRatio?: number;
  createdBy: string;
  reviewedBy?: string | null;
  contentSummary?: string;
  snapshot?: AssetRetrievalCatalogSnapshot;
}

export function parseCreateAssetRetrievalDatasetRevisionInput(
  value: unknown,
): CreateAssetRetrievalDatasetRevisionInput {
  const raw = object(value, 'datasetRevision');
  if (!Array.isArray(raw.observationIds) || raw.observationIds.length === 0 || raw.observationIds.length > 2000) {
    fail(400, 'ASSET_RETRIEVAL_DATASET_INVALID', 'observationIds 必须是 1..2000 项数组。', 'asset');
  }
  const purpose = raw.purpose;
  if (!ASSET_RETRIEVAL_DATASET_PURPOSES.includes(purpose as AssetRetrievalDatasetPurpose)) {
    fail(400, 'ASSET_RETRIEVAL_DATASET_INVALID', 'purpose 无效。', 'asset');
  }
  const filtersRaw = raw.filters === undefined ? {} : object(raw.filters, 'filters');
  const modesRaw = filtersRaw.modes === undefined ? [] : filtersRaw.modes;
  if (!Array.isArray(modesRaw)) fail(400, 'ASSET_RETRIEVAL_DATASET_INVALID', 'filters.modes 必须是数组。', 'asset');
  const modes: AssetRetrievalObservationMode[] = [];
  for (const mode of modesRaw) {
    if (!ASSET_RETRIEVAL_OBSERVATION_MODES.includes(mode as AssetRetrievalObservationMode)) {
      fail(400, 'ASSET_RETRIEVAL_DATASET_INVALID', 'filters.modes 含未知模式。', 'asset');
    }
    modes.push(mode as AssetRetrievalObservationMode);
  }
  const projectIds = filtersRaw.projectIds === undefined ? [] : stringArray(filtersRaw.projectIds, 'filters.projectIds');
  const excluded = filtersRaw.excludeAuthorizationQualities === undefined ? []
    : filtersRaw.excludeAuthorizationQualities;
  if (!Array.isArray(excluded)) {
    fail(400, 'ASSET_RETRIEVAL_DATASET_INVALID', 'filters.excludeAuthorizationQualities 必须是数组。', 'asset');
  }
  const excludeAuthorizationQualities: AssetRetrievalAuthorizationQuality[] = [];
  for (const quality of excluded) {
    if (!ASSET_RETRIEVAL_AUTHORIZATION_QUALITIES.includes(quality as AssetRetrievalAuthorizationQuality)) {
      fail(400, 'ASSET_RETRIEVAL_DATASET_INVALID', 'filters.excludeAuthorizationQualities 含未知值。', 'asset');
    }
    excludeAuthorizationQualities.push(quality as AssetRetrievalAuthorizationQuality);
  }
  return {
    datasetRevisionId: raw.datasetRevisionId === undefined ? undefined
      : assertAssetRetrievalDatasetRevisionId(text(raw.datasetRevisionId, 'datasetRevisionId', 160)),
    purpose: purpose as AssetRetrievalDatasetPurpose,
    observationIds: raw.observationIds.map((id, index) =>
      assertAssetRetrievalObservationId(text(id, `observationIds[${index}]`, 160))),
    filters: {
      labeledOnly: filtersRaw.labeledOnly !== false,
      includeDegraded: filtersRaw.includeDegraded !== false,
      modes,
      projectIds: [...new Set(projectIds)].sort(),
      excludeAuthorizationQualities: [...new Set(excludeAuthorizationQualities)].sort(),
    },
    splitSeed: raw.splitSeed === undefined ? 'asset-retrieval-governance-v1' : text(raw.splitSeed, 'splitSeed', 160),
    trainRatio: raw.trainRatio === undefined ? 0.8 : finite(raw.trainRatio, 'trainRatio', 0.1, 0.95),
    createdBy: text(raw.createdBy, 'createdBy', 200),
    reviewedBy: optionalText(raw.reviewedBy, 'reviewedBy', 200),
    contentSummary: raw.contentSummary === undefined ? '' : text(raw.contentSummary, 'contentSummary', 240),
    snapshot: raw.snapshot === undefined ? undefined : catalogSnapshot(raw.snapshot),
  };
}

export function assetRetrievalDatasetRevisionDigest(
  value: Pick<AssetRetrievalDatasetRevision, 'purpose' | 'source' | 'filters' | 'split' | 'snapshot'
    | 'sampleCount' | 'labeledSampleCount' | 'deduplicatedCount' | 'workspaceId'>,
): string {
  return canonicalDigest({
    schemaVersion: ASSET_RETRIEVAL_DATASET_SCHEMA_VERSION,
    workspaceId: value.workspaceId,
    purpose: value.purpose,
    source: value.source,
    filters: value.filters,
    split: value.split,
    snapshot: value.snapshot,
    sampleCount: value.sampleCount,
    labeledSampleCount: value.labeledSampleCount,
    deduplicatedCount: value.deduplicatedCount,
  });
}

/* -------------------------------------------------------------------------- */
/* Policy payload                                                             */
/* -------------------------------------------------------------------------- */

export interface AssetRetrievalPolicySearchSpace {
  threshold: { min: number; max: number; step: number };
  ambiguityMargin: { min: number; max: number; step: number };
  semanticWeight: { min: number; max: number; step: number };
}

export const DEFAULT_ASSET_RETRIEVAL_SEARCH_SPACE: Readonly<AssetRetrievalPolicySearchSpace> = Object.freeze({
  threshold: Object.freeze({ min: 0.45, max: 0.85, step: 0.05 }),
  ambiguityMargin: Object.freeze({ min: 0, max: 0.16, step: 0.04 }),
  semanticWeight: Object.freeze({ min: 0.6, max: 1, step: 0.1 }),
});

function range(value: unknown, path: string, min: number, max: number, stepMin: number): { min: number; max: number; step: number } {
  const raw = object(value, path);
  const lower = finite(raw.min, `${path}.min`, min, max);
  const upper = finite(raw.max, `${path}.max`, min, max);
  const step = finite(raw.step, `${path}.step`, stepMin, max);
  if (upper < lower) fail(400, 'ASSET_RETRIEVAL_SEARCH_SPACE_INVALID', `${path}.max 不能小于 min。`, 'asset');
  return { min: lower, max: upper, step };
}

export function parseAssetRetrievalPolicySearchSpace(value: unknown): AssetRetrievalPolicySearchSpace {
  if (value === undefined || value === null) return structuredClone(DEFAULT_ASSET_RETRIEVAL_SEARCH_SPACE);
  const raw = object(value, 'searchSpace');
  return {
    threshold: range(raw.threshold, 'searchSpace.threshold', 0, 1, 0.01),
    ambiguityMargin: range(raw.ambiguityMargin, 'searchSpace.ambiguityMargin', 0, 0.5, 0.01),
    semanticWeight: range(raw.semanticWeight, 'searchSpace.semanticWeight', 0, 1, 0.01),
  };
}

export interface AssetRetrievalPolicySearchSample {
  observation: AssetRetrievalObservation;
  decision: AssetRetrievalDecision;
}

export interface AssetRetrievalPolicySearchMetrics {
  labeled: number;
  correct: number;
  falseReuse: number;
  misses: number;
  expectedAbstain: number;
  correctlyAbstained: number;
  utility: number;
  /** 数据集的候选召回：人工接受/推翻的目标资产出现在候选列表中的比例（0..1）。 */
  recallAtK?: number;
  /** 人工目标资产在候选列表中的最佳（最小）名次；没有可评估样本时为 null。 */
  firstCorrectRank?: number | null;
  /** 人工 override 决策数。 */
  manualOverrides?: number;
  /** 人工 abstain 决策数。 */
  abstains?: number;
  /** 候选/观测中授权质量非 clean 的条数，用于观察授权拦截压力。 */
  authorizationBlocked?: number;
  /** 观测时延 P50（毫秒）。 */
  latencyP50?: number;
  /** 观测时延 P95（毫秒）。 */
  latencyP95?: number;
  /** 观测记录的 Embedding/检索费用合计（micros）。 */
  embeddingCostMicros?: number;
}

export interface AssetRetrievalPolicySearchResult {
  datasetRevisionId: string;
  basePolicy: AssetRetrievalPolicy;
  basePolicyDigest: string;
  bestPolicy: AssetRetrievalPolicy;
  bestPolicyDigest: string;
  bestMetrics: AssetRetrievalPolicySearchMetrics;
  evaluatedPoints: number;
  searchSpace: AssetRetrievalPolicySearchSpace;
  searchAlgorithmVersion: string;
  evaluatorAdapterVersion: string;
  sampleCount: number;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function rangeValues(rangeValue: { min: number; max: number; step: number }): number[] {
  const values: number[] = [];
  for (let value = rangeValue.min; value <= rangeValue.max + rangeValue.step / 1_000; value += rangeValue.step) {
    values.push(round(value));
  }
  return values;
}

function candidateBlendedScore(candidate: AssetRetrievalCandidateObservation, semanticWeight: number,
  mode: AssetRetrievalObservationMode): number {
  if (mode === 'degraded-lexical' || candidate.semanticScore === null) return candidate.finalScore;
  const lexical = candidate.lexicalScore ?? candidate.finalScore;
  return lexical * (1 - semanticWeight) + candidate.semanticScore * semanticWeight;
}

function predictedAsset(observation: AssetRetrievalObservation, point: AssetRetrievalPolicy): string | null {
  if (observation.strategy.mode === 'blocked' || observation.candidates.length === 0) return null;
  const ranked = [...observation.candidates]
    .map(candidate => ({
      candidate,
      score: candidateBlendedScore(candidate, point.semanticWeight, observation.strategy.mode),
    }))
    .sort((left, right) => right.score - left.score || left.candidate.rank - right.candidate.rank);
  const top = ranked[0];
  if (!top || top.score < point.threshold) return null;
  const second = ranked[1];
  if (second && top.score - second.score <= point.ambiguityMargin) return null;
  return top.candidate.assetId;
}

function expectedAsset(decision: AssetRetrievalDecision): string | null {
  return decision.decision === 'accept' || decision.decision === 'override'
    ? decision.selectedAssetId : null;
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * ratio)] as number;
}

function sampleMetrics(samples: readonly AssetRetrievalPolicySearchSample[]): {
  recallAtK: number;
  firstCorrectRank: number | null;
  manualOverrides: number;
  abstains: number;
  authorizationBlocked: number;
  latencyP50: number;
  latencyP95: number;
  embeddingCostMicros: number;
} {
  let expected = 0;
  let recalled = 0;
  let firstCorrectRank: number | null = null;
  let manualOverrides = 0;
  let abstains = 0;
  let authorizationBlocked = 0;
  const latencies: number[] = [];
  let embeddingCostMicros = 0;
  for (const sample of samples) {
    latencies.push(sample.observation.latencyMs);
    embeddingCostMicros += sample.observation.costMicros;
    if (sample.decision.decision === 'override') manualOverrides += 1;
    if (sample.decision.decision === 'abstain') abstains += 1;
    authorizationBlocked += sample.observation.candidates
      .filter(candidate => candidate.authorizationQuality !== 'clean').length;
    if (sample.decision.authorization.quality !== 'clean') authorizationBlocked += 1;
    const target = expectedAsset(sample.decision);
    if (!target) continue;
    expected += 1;
    const candidate = sample.observation.candidates.find(item => item.assetId === target);
    if (candidate) {
      recalled += 1;
      firstCorrectRank = firstCorrectRank === null
        ? candidate.rank : Math.min(firstCorrectRank, candidate.rank);
    }
  }
  return {
    recallAtK: expected === 0 ? 0 : round(recalled / expected),
    firstCorrectRank,
    manualOverrides,
    abstains,
    authorizationBlocked,
    latencyP50: percentile(latencies, 0.5),
    latencyP95: percentile(latencies, 0.95),
    embeddingCostMicros,
  };
}

/** 固定网格、确定性排序与固定 tie-break；不存在随机或模型调用。 */
export function searchAssetRetrievalPolicy(input: {
  datasetRevisionId: string;
  basePolicy?: AssetRetrievalPolicy;
  samples: readonly AssetRetrievalPolicySearchSample[];
  searchSpace?: AssetRetrievalPolicySearchSpace;
}): AssetRetrievalPolicySearchResult {
  const basePolicy = input.basePolicy === undefined ? structuredClone(DEFAULT_ASSET_RETRIEVAL_POLICY) : input.basePolicy;
  assertAssetRetrievalPolicy(basePolicy);
  const searchSpace = parseAssetRetrievalPolicySearchSpace(input.searchSpace);
  if (input.samples.length === 0) {
    fail(422, 'ASSET_RETRIEVAL_DATASET_UNLABELED', '数据集没有可用于策略搜索的人工决策样本。', 'eval');
  }
  for (const sample of input.samples) {
    if (sample.observation.workspaceId !== sample.decision.workspaceId
      || sample.observation.observationId !== sample.decision.observationId) {
      fail(403, 'ASSET_RETRIEVAL_WORKSPACE_MISMATCH', '观测与决策必须属于同一 workspace 与观测。', 'governance');
    }
  }
  const thresholdValues = rangeValues(searchSpace.threshold);
  const marginValues = rangeValues(searchSpace.ambiguityMargin);
  const weightValues = rangeValues(searchSpace.semanticWeight);
  const stats = sampleMetrics(input.samples);
  let best: { point: AssetRetrievalPolicy; metrics: AssetRetrievalPolicySearchMetrics } | null = null;
  let evaluatedPoints = 0;
  const defaultPoint = DEFAULT_ASSET_RETRIEVAL_POLICY;
  const distance = (point: AssetRetrievalPolicy): number =>
    Math.abs(point.threshold - defaultPoint.threshold)
    + Math.abs(point.ambiguityMargin - defaultPoint.ambiguityMargin)
    + Math.abs(point.semanticWeight - defaultPoint.semanticWeight);
  for (const threshold of thresholdValues) {
    for (const ambiguityMargin of marginValues) {
      for (const semanticWeight of weightValues) {
        const point: AssetRetrievalPolicy = { threshold, ambiguityMargin, semanticWeight };
        let correct = 0;
        let falseReuse = 0;
        let misses = 0;
        let expectedAbstain = 0;
        let correctlyAbstained = 0;
        for (const sample of input.samples) {
          const expected = expectedAsset(sample.decision);
          const predicted = predictedAsset(sample.observation, point);
          if (expected === null) expectedAbstain += 1;
          if (expected === predicted) {
            correct += 1;
            if (expected === null) correctlyAbstained += 1;
          } else if (expected === null) {
            falseReuse += 1;
          } else {
            misses += 1;
          }
        }
        const metrics: AssetRetrievalPolicySearchMetrics = {
          labeled: input.samples.length,
          correct,
          falseReuse,
          misses,
          expectedAbstain,
          correctlyAbstained,
          utility: round(correct - 1.5 * falseReuse - 0.5 * misses),
          ...stats,
        };
        evaluatedPoints += 1;
        if (!best || better(metrics, distance(point), best.metrics, distance(best.point))) {
          best = { point, metrics };
        }
      }
    }
  }
  if (!best) fail(422, 'ASSET_RETRIEVAL_SEARCH_SPACE_EMPTY', '参数搜索空间为空。', 'eval');
  return {
    datasetRevisionId: input.datasetRevisionId,
    basePolicy: { ...basePolicy },
    basePolicyDigest: assetRetrievalPolicyDigest(basePolicy),
    bestPolicy: best.point,
    bestPolicyDigest: assetRetrievalPolicyDigest(best.point),
    bestMetrics: best.metrics,
    evaluatedPoints,
    searchSpace,
    searchAlgorithmVersion: ASSET_RETRIEVAL_SEARCH_ALGORITHM_VERSION,
    evaluatorAdapterVersion: ASSET_RETRIEVAL_EVALUATOR_ADAPTER_VERSION,
    sampleCount: input.samples.length,
  };
}

function better(candidate: AssetRetrievalPolicySearchMetrics, candidateDistance: number,
  current: AssetRetrievalPolicySearchMetrics, currentDistance: number): boolean {
  if (candidate.utility !== current.utility) return candidate.utility > current.utility;
  if (candidate.falseReuse !== current.falseReuse) return candidate.falseReuse < current.falseReuse;
  if (candidate.misses !== current.misses) return candidate.misses < current.misses;
  if (candidate.correct !== current.correct) return candidate.correct > current.correct;
  return candidateDistance < currentDistance;
}

export interface AssetRetrievalPolicyBoundsProof {
  onlyRankingParametersChanged: true;
  changedParameters: Array<'threshold' | 'ambiguityMargin' | 'semanticWeight'>;
  authorizationFilterChanged: false;
  catalogFilterChanged: false;
  scope: 'workspace' | 'project';
  projectId: string | null;
}

export interface AssetRetrievalPolicyCandidatePayload {
  schemaVersion: typeof ASSET_RETRIEVAL_POLICY_PAYLOAD_SCHEMA_VERSION;
  payloadId: string;
  workspaceId: string;
  basePolicyVersion: string;
  basePolicyDigest: string;
  basePolicy: AssetRetrievalPolicy;
  threshold: number;
  ambiguityMargin: number;
  semanticWeight: number;
  policyDigest: string;
  searchSpace: AssetRetrievalPolicySearchSpace;
  searchAlgorithmVersion: string;
  assetRetrievalDatasetRevisionId: string;
  assetRetrievalDatasetRevisionDigest: string;
  evaluatorAdapterVersion: string;
  boundsProof: AssetRetrievalPolicyBoundsProof;
  payloadDigest: string;
  createdAt: string;
}

export function assetRetrievalPolicyPayloadDigest(
  value: Pick<AssetRetrievalPolicyCandidatePayload, 'schemaVersion' | 'workspaceId' | 'basePolicyVersion'
    | 'basePolicyDigest' | 'basePolicy' | 'threshold' | 'ambiguityMargin' | 'semanticWeight' | 'policyDigest' | 'searchSpace'
    | 'searchAlgorithmVersion' | 'assetRetrievalDatasetRevisionId' | 'assetRetrievalDatasetRevisionDigest'
    | 'evaluatorAdapterVersion' | 'boundsProof'>,
): string {
  return canonicalDigest({
    schemaVersion: value.schemaVersion,
    workspaceId: value.workspaceId,
    basePolicyVersion: value.basePolicyVersion,
    basePolicyDigest: value.basePolicyDigest,
    basePolicy: value.basePolicy,
    threshold: value.threshold,
    ambiguityMargin: value.ambiguityMargin,
    semanticWeight: value.semanticWeight,
    policyDigest: value.policyDigest,
    searchSpace: value.searchSpace,
    searchAlgorithmVersion: value.searchAlgorithmVersion,
    assetRetrievalDatasetRevisionId: value.assetRetrievalDatasetRevisionId,
    assetRetrievalDatasetRevisionDigest: value.assetRetrievalDatasetRevisionDigest,
    evaluatorAdapterVersion: value.evaluatorAdapterVersion,
    boundsProof: value.boundsProof,
  });
}

/* -------------------------------------------------------------------------- */
/* Typed refs                                                                 */
/* -------------------------------------------------------------------------- */

export interface AssetRetrievalGovernanceRefs {
  payloadId: string;
  workspaceId: string;
  candidateVersionId: string | null;
  evaluationDatasetVersionId: string | null;
  evaluationDatasetRevisionDigest: string | null;
  evaluationRunId: string | null;
  scorecardId: string | null;
  gateDecisionId: string | null;
  rolloutId: string | null;
  registryEntryId: string | null;
  registryRevision: number | null;
  policyVersionId: string | null;
  policyDigest: string | null;
  updatedAt: string;
}

export interface AssetRetrievalGovernanceSummary {
  workspaceId: string;
  observationCount: number;
  decisionCount: number;
  datasetRevisionCount: number;
  policyPayloadCount: number;
  latestDatasetRevision: AssetRetrievalDatasetRevision | null;
  latestPolicyPayload: AssetRetrievalPolicyCandidatePayload | null;
  latestRefs: AssetRetrievalGovernanceRefs | null;
}

/* -------------------------------------------------------------------------- */
/* #134 evaluation bridge                                                     */
/* -------------------------------------------------------------------------- */

export interface BuildAssetRetrievalEvaluationCasesInput {
  datasetRevision: AssetRetrievalDatasetRevision;
  samples: readonly AssetRetrievalPolicySearchSample[];
  authorization: EvaluationAuthorization;
  sensitivity?: SensitivityLevel;
  title?: string;
  intent?: string;
}

/**
 * 把领域数据集 revision 转换成 #134 的 asset_retrieval 样例。
 * 只复制冻结后的观测/决策，不读取运行时资产目录，也不伪造授权。
 */
export function buildAssetRetrievalEvaluationCases(
  input: BuildAssetRetrievalEvaluationCasesInput,
): EvaluationCase[] {
  const authority = input.authorization;
  if (authority.status !== 'granted') {
    fail(422, 'ASSET_RETRIEVAL_EVALUATION_AUTHORIZATION_REQUIRED',
      '注册 #134 数据集要求 granted 授权。', 'eval');
  }
  const cases = input.samples.map(({ observation, decision }): EvaluationCase => {
    const candidates = observation.candidates;
    const top = candidates[0] ?? null;
    const expected = expectedAsset(decision);
    const assets = candidates.map(candidate => ({
      assetId: candidate.assetId,
      name: candidate.assetName,
      kind: candidate.assetKind,
      status: candidate.assetStatus,
      summary: candidate.explanation,
      metadata: {
        rank: candidate.rank,
        finalScore: candidate.finalScore,
        authorizationQuality: candidate.authorizationQuality,
      },
    }));
    const fixedHits = candidates.map(candidate => ({
      assetId: candidate.assetId,
      score: candidate.finalScore,
      rank: candidate.rank,
    }));
    const versionRefs = candidates.map(candidate => ({
      kind: 'asset' as const,
      id: candidate.assetId,
      revisionId: candidate.assetVersionId,
      digest: candidate.assetVersionDigest
        ?? canonicalDigest({ assetId: candidate.assetId, assetVersionId: candidate.assetVersionId }),
    }));
    const provenance: EvaluationProvenance = {
      sourceKind: 'internal',
      sourceRefs: [{
        refId: input.datasetRevision.datasetRevisionId,
        locator: `asset-retrieval-dataset:${input.datasetRevision.datasetRevisionId}`,
        digest: input.datasetRevision.payloadDigest,
      }],
      generator: 'human',
      notes: `由资产检索策略数据集 ${input.datasetRevision.datasetRevisionId} 冻结生成`,
      createdAt: input.datasetRevision.createdAt,
    };
    return {
      caseId: observation.observationId,
      kind: 'asset_retrieval',
      title: input.title ?? `资产检索 ${observation.observationId}`,
      intent: input.intent ?? `复核资产检索策略在 ${observation.strategy.mode} 模式下的选择结果`,
      input: {
        kind: 'asset_retrieval',
        query: {
          text: observation.query.text,
          filters: {
            kinds: [...observation.query.filters.kinds],
            statuses: [...observation.query.filters.statuses],
          },
          limit: observation.query.limit,
        },
        assets,
        fixedHits,
      },
      expectation: {
        kind: 'asset_retrieval',
        result: expected === null ? 'missing' : 'unique',
        expectedAssetId: expected,
        minimumScore: expected === null ? null : (top?.finalScore ?? null),
      },
      source: provenance,
      versionRefs,
      contentSummary: `${observation.strategy.mode}; ${observation.candidates.length} 候选; `
        + `decision=${decision.decision}`,
      authorization: {
        status: authority.status,
        basis: authority.basis,
        scope: authority.scope,
        grantedBy: authority.grantedBy,
        grantedAt: authority.grantedAt,
        expiresAt: authority.expiresAt,
        restrictions: [...authority.restrictions],
      },
      sensitivity: input.sensitivity ?? 'internal',
      tags: ['asset_retrieval_governance', input.datasetRevision.purpose],
      slices: [input.datasetRevision.workspaceId],
    };
  });
  return cases.sort((left, right) => left.caseId.localeCompare(right.caseId));
}

/** #134 dataset bundle 的最小身份投影；不复制其 revision/feed/scorecard。 */
export interface RegisteredAssetRetrievalEvaluationDataset {
  datasetId: string;
  revisionId: string;
  digest: string;
  caseCount: number;
  schemaVersion: typeof EVALUATION_DATASET_SCHEMA_VERSION;
}

export interface AssetRetrievalEvaluationDatasetRegistrar {
  register(input: {
    workspaceId: string;
    title: string;
    description: string;
    cases: EvaluationCase[];
    authorization: EvaluationAuthorization;
    sensitivity: SensitivityLevel;
    contentSummary: string;
  }): Promise<RegisteredAssetRetrievalEvaluationDataset>;
}
