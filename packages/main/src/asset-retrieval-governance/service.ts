import {
  AssetRetrievalGovernanceError,
  DEFAULT_ASSET_RETRIEVAL_POLICY,
  DEFAULT_ASSET_RETRIEVAL_SEARCH_SPACE,
  ASSET_RETRIEVAL_EVALUATOR_ADAPTER_VERSION,
  ASSET_RETRIEVAL_GOVERNANCE_SCHEMA_VERSION,
  ASSET_RETRIEVAL_POLICY_PAYLOAD_SCHEMA_VERSION,
  ASSET_RETRIEVAL_SEARCH_ALGORITHM_VERSION,
  ASSET_RETRIEVAL_DATASET_SCHEMA_VERSION,
  assetRetrievalDatasetRevisionDigest,
  assetRetrievalGovernanceId,
  assetRetrievalPolicyDigest,
  assetRetrievalPolicyPayloadDigest,
  assertAssetRetrievalDatasetRevisionId,
  assertAssetRetrievalPolicyPayloadId,
  buildAssetRetrievalEvaluationCases,
  canonicalDigest,
  freezeAssetRetrievalDecision,
  freezeAssetRetrievalObservation,
  normalizeGovernanceText,
  parseAssetRetrievalPolicySearchSpace,
  parseCreateAssetRetrievalDatasetRevisionInput,
  parseRecordAssetRetrievalDecisionInput,
  parseRecordAssetRetrievalObservationInput,
  searchAssetRetrievalPolicy,
  type AssetRetrievalCatalogSnapshot,
  type AssetRetrievalDatasetFilters,
  type AssetRetrievalDatasetRevision,
  type AssetRetrievalDecision,
  type AssetRetrievalEvaluationDatasetRegistrar,
  type AssetRetrievalGovernanceRefs,
  type AssetRetrievalGovernanceSummary,
  type AssetRetrievalObservation,
  type AssetRetrievalPolicyCandidatePayload,
  type AssetRetrievalPolicySearchResult,
  type AssetRetrievalPolicySearchSample,
  type AssetRetrievalPolicySearchSpace,
  type AssetRetrievalPolicy,
  type CreateAssetRetrievalDatasetRevisionInput,
  type EvaluationAuthorization,
  type SensitivityLevel,
} from '@lyra/shared';
import type { EvolutionCandidate } from '@lyra/shared';
import type { EvolutionGateService } from '../evolution/gate-service';
import type { AssetRetrievalGovernanceRepository } from './repository';

const HEX64 = /^[0-9a-f]{64}$/u;
const OBSERVATION_ID = /^arobs_[a-f0-9]{32}$/u;
const DECISION_ID = /^ardec_[a-f0-9]{32}$/u;
const DATASET_REVISION_ID = /^ardsrev_[a-f0-9]{32}$/u;
const PAYLOAD_ID = /^arpayload_[a-f0-9]{32}$/u;
const EVOLUTION_CANDIDATE_ID = /^evocand_[a-f0-9]{32}$/u;
const EVALUATION_DATASET_REVISION_ID = /^evaldsrev_[a-f0-9]{32}$/u;

function bad(status: number, code: string, message: string): never {
  throw new AssetRetrievalGovernanceError(status, code, message);
}

function optional(value: unknown, field: string, max = 200): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    bad(400, 'ASSET_RETRIEVAL_REFERENCE_INVALID', `${field} 必须是 1..${max} 字符。`);
  }
  return normalizeGovernanceText(value);
}

function optionalHex(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !HEX64.test(value)) {
    bad(400, 'ASSET_RETRIEVAL_REFERENCE_INVALID', `${field} 必须是 sha256 hex。`);
  }
  return value;
}

function optionalRevision(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    bad(400, 'ASSET_RETRIEVAL_REFERENCE_INVALID', `${field} 必须是不小于 0 的整数。`);
  }
  return value as number;
}

function normalizeFilters(input: CreateAssetRetrievalDatasetRevisionInput): AssetRetrievalDatasetFilters {
  return {
    labeledOnly: input.filters?.labeledOnly ?? true,
    includeDegraded: input.filters?.includeDegraded ?? true,
    modes: [...(input.filters?.modes ?? [])].sort(),
    projectIds: [...(input.filters?.projectIds ?? [])].sort(),
    excludeAuthorizationQualities: [...(input.filters?.excludeAuthorizationQualities ?? [])].sort(),
  };
}

function snapshotOf(observation: AssetRetrievalObservation): string {
  return JSON.stringify(observation.strategy.catalog);
}

function pointWithinSpace(point: AssetRetrievalPolicy, space: AssetRetrievalPolicySearchSpace): boolean {
  return point.threshold >= space.threshold.min && point.threshold <= space.threshold.max
    && point.ambiguityMargin >= space.ambiguityMargin.min && point.ambiguityMargin <= space.ambiguityMargin.max
    && point.semanticWeight >= space.semanticWeight.min && point.semanticWeight <= space.semanticWeight.max;
}

function projectScope(observations: readonly AssetRetrievalObservation[]): { scope: 'workspace' | 'project';
  projectId: string | null } {
  const projectIds = new Set(observations.map(item => item.projectId));
  if (projectIds.size === 1) {
    const projectId = [...projectIds][0];
    if (projectId) return { scope: 'project', projectId };
  }
  return { scope: 'workspace', projectId: null };
}

function sameSnapshot(observations: readonly AssetRetrievalObservation[]): AssetRetrievalCatalogSnapshot {
  const snapshots = new Map<string, AssetRetrievalCatalogSnapshot>();
  for (const observation of observations) snapshots.set(snapshotOf(observation), observation.strategy.catalog);
  if (snapshots.size !== 1) {
    bad(422, 'ASSET_RETRIEVAL_DATASET_SNAPSHOT_MISMATCH',
      '同一数据集 revision 只能冻结同一 AssetCatalog / Milvus alias / Embedding / 授权快照。');
  }
  return structuredClone([...snapshots.values()][0] as AssetRetrievalCatalogSnapshot);
}

function splitIds(ids: readonly string[], seed: string, trainRatio: number): {
  trainObservationIds: string[];
  validationObservationIds: string[];
} {
  const train: string[] = [];
  const validation: string[] = [];
  for (const id of ids) {
    const digest = canonicalDigest(`${seed}:${id}`);
    const bucket = Number.parseInt(digest.slice(0, 8), 16) / 0x1_0000_0000;
    (bucket < trainRatio ? train : validation).push(id);
  }
  if (train.length === 0 && validation.length > 0 && ids.length > 1) train.push(validation.pop() as string);
  return { trainObservationIds: train.sort(), validationObservationIds: validation.sort() };
}

export interface CreateAssetRetrievalPolicyPayloadInput {
  payloadId?: string;
  basePolicyVersion: string;
  basePolicy: AssetRetrievalPolicy;
  assetRetrievalDatasetRevisionId: string;
  expectedDatasetRevisionDigest?: string;
  policy: AssetRetrievalPolicy;
  searchSpace?: AssetRetrievalPolicySearchSpace;
  searchAlgorithmVersion?: string;
  evaluatorAdapterVersion?: string;
  createdBy: string;
}

export interface AssetRetrievalGovernanceServiceOptions {
  now?: () => Date;
  /** Main-owned authority; absent or failing proof must never produce clean positive labels. */
  verifyAuthorization?: (workspaceId: string, observation: AssetRetrievalObservation,
    decision: { selectedAssetId: string | null; selectedAssetVersionId: string | null }) => Promise<boolean>;
  gate?: EvolutionGateService;
  evaluationRegistrar?: AssetRetrievalEvaluationDatasetRegistrar;
  tokenLimit?: number;
  costLimitMinor?: number;
}

export interface RegisterAssetRetrievalPolicyCandidateResult {
  payload: AssetRetrievalPolicyCandidatePayload;
  refs: AssetRetrievalGovernanceRefs;
  candidate: EvolutionCandidate;
}

export const ASSET_RETRIEVAL_GOVERNANCE_SERVICE = Symbol('ASSET_RETRIEVAL_GOVERNANCE_SERVICE');

/**
 * #128 领域服务：观测/决策收集、数据集冻结、参数搜索、候选载荷与 Facade。
 * 不持有自己的 Candidate/Canary/Adopt/Rollback 状态机；这些动作在 #135 执行。
 */
export class AssetRetrievalGovernanceService {
  private readonly now: () => Date;
  constructor(
    private readonly repository: AssetRetrievalGovernanceRepository,
    private readonly options: AssetRetrievalGovernanceServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private timestamp(): string { return this.now().toISOString(); }

  evolutionGateService(): EvolutionGateService | undefined {
    return this.options.gate;
  }

  async recordObservation(workspaceId: string, body: unknown): Promise<AssetRetrievalObservation> {
    const input = parseRecordAssetRetrievalObservationInput(body);
    const existing = input.observationId
      ? await this.repository.getObservation(workspaceId, input.observationId)
      : await this.repository.findObservationByClientRequest(workspaceId, input.clientRequestId);
    if (existing) return this.replayObservation(existing, input);
    const observation = freezeAssetRetrievalObservation(workspaceId, input, this.timestamp());
    await this.repository.insertObservation(observation);
    return observation;
  }

  private replayObservation(existing: AssetRetrievalObservation,
    input: ReturnType<typeof parseRecordAssetRetrievalObservationInput>): AssetRetrievalObservation {
    const expected = freezeAssetRetrievalObservation(existing.workspaceId,
      { ...input, observationId: existing.observationId }, existing.observedAt);
    if (expected.contentDigest !== existing.contentDigest) {
      bad(409, 'ASSET_RETRIEVAL_OBSERVATION_CONFLICT', '同一 observationId/clientRequestId 的观测内容不一致。');
    }
    return existing;
  }

  async getObservation(workspaceId: string, observationId: string): Promise<AssetRetrievalObservation> {
    assertObservationId(observationId);
    const observation = await this.repository.getObservation(workspaceId, observationId);
    if (!observation) bad(404, 'ASSET_RETRIEVAL_OBSERVATION_NOT_FOUND', '检索观测不存在。');
    return observation;
  }

  async listObservations(workspaceId: string): Promise<{ items: AssetRetrievalObservation[] }> {
    return { items: await this.repository.listObservations(workspaceId) };
  }

  private async authorized(workspaceId: string, observation: AssetRetrievalObservation,
    decision: { selectedAssetId: string | null; selectedAssetVersionId: string | null }): Promise<boolean> {
    try { return await this.options.verifyAuthorization?.(workspaceId, observation, decision) === true; }
    catch { return false; }
  }

  async recordDecision(workspaceId: string, body: unknown): Promise<AssetRetrievalDecision> {
    const input = parseRecordAssetRetrievalDecisionInput(body);
    const observation = await this.repository.getObservation(workspaceId, input.observationId);
    if (!observation) bad(404, 'ASSET_RETRIEVAL_OBSERVATION_NOT_FOUND', '检索观测不存在，不能记录决策。');
    if (input.selectedAssetId) {
      const candidate = observation.candidates.find(item => item.assetId === input.selectedAssetId);
      if (!candidate) bad(422, 'ASSET_RETRIEVAL_DECISION_TARGET_UNKNOWN',
        '所选资产必须出现在该次检索观测的候选列表中。');
      if (input.selectedAssetVersionId && candidate.assetVersionId
        && input.selectedAssetVersionId !== candidate.assetVersionId) {
        bad(422, 'ASSET_RETRIEVAL_DECISION_TARGET_UNKNOWN', '所选资产版本与观测候选不一致。');
      }
    }
    if (input.authorization.quality === 'clean' && !await this.authorized(workspaceId, observation, input)) {
      input.authorization = { ...input.authorization, quality: 'unverified', verifiedAt: null };
    }
    const existing = input.decisionId
      ? await this.repository.getDecision(workspaceId, input.decisionId)
      : await this.repository.findDecisionByClientRequest(workspaceId, input.clientRequestId);
    if (existing) {
      const current = {
        observationId: existing.observationId, clientRequestId: existing.clientRequestId,
        decision: existing.decision, selectedAssetId: existing.selectedAssetId,
        selectedAssetVersionId: existing.selectedAssetVersionId, reason: existing.reason,
        actorId: existing.actorId, authorization: existing.authorization, outcome: existing.outcome,
      };
      const requested = {
        observationId: input.observationId, clientRequestId: input.clientRequestId, decision: input.decision,
        selectedAssetId: input.selectedAssetId, selectedAssetVersionId: input.selectedAssetVersionId,
        reason: input.reason, actorId: input.actorId, authorization: input.authorization, outcome: input.outcome,
      };
      if (JSON.stringify(current) !== JSON.stringify(requested)) {
        bad(409, 'ASSET_RETRIEVAL_DECISION_CONFLICT', '同一 clientRequestId 已记录了不同决策。');
      }
      return existing;
    }
    const decision = freezeAssetRetrievalDecision(workspaceId, input, this.timestamp());
    await this.repository.insertDecision(decision);
    return decision;
  }

  async getDecision(workspaceId: string, decisionId: string): Promise<AssetRetrievalDecision> {
    if (!DECISION_ID.test(decisionId)) bad(400, 'ASSET_RETRIEVAL_ID_INVALID', '检索决策标识无效。');
    const decision = await this.repository.getDecision(workspaceId, decisionId);
    if (!decision) bad(404, 'ASSET_RETRIEVAL_DECISION_NOT_FOUND', '检索决策不存在。');
    return decision;
  }

  async listDecisions(workspaceId: string): Promise<{ items: AssetRetrievalDecision[] }> {
    return { items: await this.repository.listDecisions(workspaceId) };
  }

  async createDatasetRevision(workspaceId: string,
    body: unknown): Promise<AssetRetrievalDatasetRevision> {
    const input = parseCreateAssetRetrievalDatasetRevisionInput(body);
    const ids = [...new Set(input.observationIds)].sort();
    const observations: AssetRetrievalObservation[] = [];
    for (const id of ids) {
      const observation = await this.repository.getObservation(workspaceId, id);
      if (!observation) bad(404, 'ASSET_RETRIEVAL_OBSERVATION_NOT_FOUND', `检索观测 ${id} 不存在。`);
      observations.push(observation);
    }
    const filters = normalizeFilters(input);
    const selected: Array<{ observation: AssetRetrievalObservation; decision: AssetRetrievalDecision | null }> = [];
    let deduplicatedCount = 0;
    const dedupe = new Map<string, true>();
    for (const observation of observations) {
      if (filters.modes.length > 0 && !filters.modes.includes(observation.strategy.mode)) continue;
      if (!filters.includeDegraded
        && (observation.strategy.mode === 'degraded-lexical' || observation.strategy.mode === 'blocked')) continue;
      if (filters.projectIds.length > 0 && (!observation.projectId
        || !filters.projectIds.includes(observation.projectId))) continue;
      const decision = await this.repository.getDecisionForObservation(workspaceId, observation.observationId);
      if (filters.labeledOnly && !decision) continue;
      if (decision && (decision.decision === 'accept' || decision.decision === 'override')) {
        const quality = decision.authorization.quality;
        if (quality !== 'clean' || filters.excludeAuthorizationQualities.includes(quality)
          || !await this.authorized(workspaceId, observation, decision)) {
          // 未回库核验/跨租户/授权失效的资产绝不能成为正样本；整条观测不进冻结集。
          deduplicatedCount += 1;
          continue;
        }
        const candidate = observation.candidates.find(item => item.assetId === decision.selectedAssetId);
        if (!candidate || candidate.authorizationQuality !== 'clean') {
          deduplicatedCount += 1;
          continue;
        }
      }
      const decisionKey = decision ? `${decision.decision}:${decision.selectedAssetId ?? ''}` : 'none';
      const candidateKey = observation.candidates.map(item => item.assetId).sort().join(',');
      const dedupeKey = `${observation.query.queryDigest}|${decisionKey}|${candidateKey}|${observation.strategy.policyDigest}`;
      if (dedupe.has(dedupeKey)) { deduplicatedCount += 1; continue; }
      dedupe.set(dedupeKey, true);
      selected.push({ observation, decision });
    }
    if (selected.length === 0) bad(422, 'ASSET_RETRIEVAL_DATASET_EMPTY', '筛选后没有可冻结的观测样本。');
    const snapshot = input.snapshot === undefined ? sameSnapshot(selected.map(item => item.observation))
      : input.snapshot;
    if (input.snapshot !== undefined) {
      const actual = sameSnapshot(selected.map(item => item.observation));
      if (JSON.stringify(actual) !== JSON.stringify(input.snapshot)) {
        bad(422, 'ASSET_RETRIEVAL_DATASET_SNAPSHOT_MISMATCH', '请求快照与观测记录不一致。');
      }
    }
    const split = {
      seed: input.splitSeed ?? 'asset-retrieval-governance-v1',
      trainRatio: input.trainRatio ?? 0.8,
      ...splitIds(selected.map(item => item.observation.observationId), input.splitSeed ?? 'asset-retrieval-governance-v1',
        input.trainRatio ?? 0.8),
    };
    const source = {
      observationIds: selected.map(item => item.observation.observationId).sort(),
      decisionIds: selected.filter(item => item.decision !== null).map(item => item.decision!.decisionId).sort(),
    };
    const base = {
      schemaVersion: ASSET_RETRIEVAL_DATASET_SCHEMA_VERSION as typeof ASSET_RETRIEVAL_DATASET_SCHEMA_VERSION,
      datasetRevisionId: input.datasetRevisionId
        ?? assetRetrievalGovernanceId('ardsrev'),
      workspaceId,
      purpose: input.purpose,
      source,
      filters,
      split,
      snapshot: structuredClone(snapshot),
      sampleCount: selected.length,
      labeledSampleCount: selected.filter(item => item.decision !== null).length,
      deduplicatedCount,
      payloadDigest: '',
      createdBy: input.createdBy,
      reviewedBy: input.reviewedBy ?? null,
      contentSummary: input.contentSummary ?? '',
      createdAt: this.timestamp(),
      evaluationDatasetVersionId: null,
    } satisfies AssetRetrievalDatasetRevision;
    const payloadDigest = assetRetrievalDatasetRevisionDigest(base);
    const revision: AssetRetrievalDatasetRevision = { ...base, payloadDigest };
    await this.repository.insertDatasetRevision(revision);
    return revision;
  }

  async getDatasetRevision(workspaceId: string, datasetRevisionId: string): Promise<AssetRetrievalDatasetRevision> {
    assertAssetRetrievalDatasetRevisionId(datasetRevisionId);
    const revision = await this.repository.getDatasetRevision(workspaceId, datasetRevisionId);
    if (!revision) bad(404, 'ASSET_RETRIEVAL_DATASET_NOT_FOUND', '资产检索数据集 revision 不存在。');
    this.assertDatasetDigest(revision);
    return revision;
  }

  async listDatasetRevisions(workspaceId: string): Promise<{ items: AssetRetrievalDatasetRevision[] }> {
    return { items: await this.repository.listDatasetRevisions(workspaceId) };
  }

  private assertDatasetDigest(revision: AssetRetrievalDatasetRevision): void {
    const expected = assetRetrievalDatasetRevisionDigest(revision);
    if (expected !== revision.payloadDigest) {
      bad(409, 'ASSET_RETRIEVAL_DATASET_INTEGRITY_FAILED', '数据集 revision 载荷摘要不一致。');
    }
  }

  async datasetSamples(workspaceId: string, datasetRevisionId: string): Promise<AssetRetrievalPolicySearchSample[]> {
    const revision = await this.getDatasetRevision(workspaceId, datasetRevisionId);
    const samples: AssetRetrievalPolicySearchSample[] = [];
    for (const observationId of revision.source.observationIds) {
      const observation = await this.repository.getObservation(workspaceId, observationId);
      if (!observation) bad(409, 'ASSET_RETRIEVAL_DATASET_INTEGRITY_FAILED', '数据集引用的观测已不可用。');
      const decision = await this.repository.getDecisionForObservation(workspaceId, observationId);
      if (decision && revision.source.decisionIds.includes(decision.decisionId)) {
        if ((decision.decision === 'accept' || decision.decision === 'override')
          && (decision.authorization.quality !== 'clean' || !await this.authorized(workspaceId, observation, decision))) {
          bad(422, 'ASSET_RETRIEVAL_AUTHORIZATION_UNVERIFIED', '正样本授权无法重新核验，禁止使用该数据集。');
        }
        samples.push({ observation, decision });
      }
    }
    return samples;
  }

  async searchPolicy(workspaceId: string, datasetRevisionId: string,
    body: unknown = {}): Promise<AssetRetrievalPolicySearchResult> {
    const revision = await this.getDatasetRevision(workspaceId, datasetRevisionId);
    const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const basePolicy = raw.basePolicy === undefined ? structuredClone(DEFAULT_ASSET_RETRIEVAL_POLICY)
      : this.parsePolicy(raw.basePolicy, 'basePolicy');
    const searchSpace = parseAssetRetrievalPolicySearchSpace(raw.searchSpace);
    const samples = await this.datasetSamples(workspaceId, revision.datasetRevisionId);
    if (samples.length === 0) bad(422, 'ASSET_RETRIEVAL_DATASET_UNLABELED',
      '数据集没有可用于策略搜索的人工决策样本。#128 不会用未标注样本伪造门槛。');
    return searchAssetRetrievalPolicy({
      datasetRevisionId: revision.datasetRevisionId,
      basePolicy,
      samples,
      searchSpace,
    });
  }

  async createPolicyPayload(workspaceId: string, body: unknown): Promise<AssetRetrievalPolicyCandidatePayload> {
    const raw = this.bodyObject(body);
    const input: CreateAssetRetrievalPolicyPayloadInput = {
      payloadId: raw.payloadId === undefined ? undefined : assertAssetRetrievalPolicyPayloadId(String(raw.payloadId)),
      basePolicyVersion: this.requiredText(raw.basePolicyVersion, 'basePolicyVersion', 160),
      basePolicy: this.parsePolicy(raw.basePolicy, 'basePolicy'),
      assetRetrievalDatasetRevisionId: assertAssetRetrievalDatasetRevisionId(
        this.requiredText(raw.assetRetrievalDatasetRevisionId, 'assetRetrievalDatasetRevisionId', 160)),
      expectedDatasetRevisionDigest: raw.expectedDatasetRevisionDigest === undefined ? undefined
        : this.hex(raw.expectedDatasetRevisionDigest, 'expectedDatasetRevisionDigest'),
      policy: this.parsePolicy(raw.policy, 'policy'),
      searchSpace: parseAssetRetrievalPolicySearchSpace(raw.searchSpace),
      searchAlgorithmVersion: raw.searchAlgorithmVersion === undefined ? ASSET_RETRIEVAL_SEARCH_ALGORITHM_VERSION
        : this.requiredText(raw.searchAlgorithmVersion, 'searchAlgorithmVersion', 80),
      evaluatorAdapterVersion: raw.evaluatorAdapterVersion === undefined ? ASSET_RETRIEVAL_EVALUATOR_ADAPTER_VERSION
        : this.requiredText(raw.evaluatorAdapterVersion, 'evaluatorAdapterVersion', 80),
      createdBy: this.requiredText(raw.createdBy, 'createdBy', 200),
    };
    const dataset = await this.getDatasetRevision(workspaceId, input.assetRetrievalDatasetRevisionId);
    if (input.expectedDatasetRevisionDigest && input.expectedDatasetRevisionDigest !== dataset.payloadDigest) {
      bad(409, 'ASSET_RETRIEVAL_DATASET_STALE', 'expectedDatasetRevisionDigest 与数据集当前摘要不一致。');
    }
    const searchSpace = input.searchSpace ?? parseAssetRetrievalPolicySearchSpace(undefined);
    if (!pointWithinSpace(input.policy, searchSpace)) {
      bad(422, 'ASSET_RETRIEVAL_POLICY_OUT_OF_BOUNDS', '候选策略超出声明的有界参数空间。');
    }
    const baseDigest = assetRetrievalPolicyDigest(input.basePolicy);
    const policyDigest = assetRetrievalPolicyDigest(input.policy);
    const changedParameters = (['threshold', 'ambiguityMargin', 'semanticWeight'] as const)
      .filter(key => input.policy[key] !== input.basePolicy[key]);
    if (changedParameters.length === 0) {
      bad(422, 'ASSET_RETRIEVAL_PAYLOAD_NO_CHANGE', '候选策略与基线完全相同，不能创建无变化载荷。');
    }
    const observations: AssetRetrievalObservation[] = [];
    for (const id of dataset.source.observationIds) {
      const observation = await this.repository.getObservation(workspaceId, id);
      if (observation) observations.push(observation);
    }
    const scope = projectScope(observations);
    const payloadId = input.payloadId ?? assetRetrievalGovernanceId('arpayload');
    if (!PAYLOAD_ID.test(payloadId)) bad(400, 'ASSET_RETRIEVAL_ID_INVALID', '策略候选载荷标识无效。');
    const base = {
      schemaVersion: ASSET_RETRIEVAL_POLICY_PAYLOAD_SCHEMA_VERSION as typeof ASSET_RETRIEVAL_POLICY_PAYLOAD_SCHEMA_VERSION,
      payloadId,
      workspaceId,
      basePolicyVersion: input.basePolicyVersion,
      basePolicyDigest: baseDigest,
      basePolicy: { ...input.basePolicy },
      threshold: input.policy.threshold,
      ambiguityMargin: input.policy.ambiguityMargin,
      semanticWeight: input.policy.semanticWeight,
      policyDigest,
      searchSpace,
      searchAlgorithmVersion: input.searchAlgorithmVersion ?? ASSET_RETRIEVAL_SEARCH_ALGORITHM_VERSION,
      assetRetrievalDatasetRevisionId: dataset.datasetRevisionId,
      assetRetrievalDatasetRevisionDigest: dataset.payloadDigest,
      evaluatorAdapterVersion: input.evaluatorAdapterVersion ?? ASSET_RETRIEVAL_EVALUATOR_ADAPTER_VERSION,
      boundsProof: {
        onlyRankingParametersChanged: true,
        changedParameters: [...changedParameters],
        authorizationFilterChanged: false,
        catalogFilterChanged: false,
        scope: scope.scope,
        projectId: scope.projectId,
      },
      payloadDigest: '',
      createdAt: this.timestamp(),
    } satisfies AssetRetrievalPolicyCandidatePayload;
    const payload: AssetRetrievalPolicyCandidatePayload = {
      ...base,
      payloadDigest: assetRetrievalPolicyPayloadDigest(base),
    };
    await this.repository.insertPolicyPayload(payload);
    return payload;
  }

  async searchAndCreatePolicyPayload(workspaceId: string, body: unknown): Promise<{
    search: AssetRetrievalPolicySearchResult;
    payload: AssetRetrievalPolicyCandidatePayload;
  }> {
    const raw = this.bodyObject(body);
    const datasetRevisionId = assertAssetRetrievalDatasetRevisionId(
      this.requiredText(raw.assetRetrievalDatasetRevisionId, 'assetRetrievalDatasetRevisionId', 160));
    const basePolicyVersion = raw.basePolicyVersion === undefined ? 'asset-retrieval-policy/1'
      : this.requiredText(raw.basePolicyVersion, 'basePolicyVersion', 160);
    const search = await this.searchPolicy(workspaceId, datasetRevisionId, raw);
    const payload = await this.createPolicyPayload(workspaceId, {
      basePolicyVersion,
      basePolicy: raw.basePolicy ?? search.basePolicy,
      assetRetrievalDatasetRevisionId: datasetRevisionId,
      expectedDatasetRevisionDigest: raw.expectedDatasetRevisionDigest,
      policy: search.bestPolicy,
      searchSpace: search.searchSpace,
      searchAlgorithmVersion: search.searchAlgorithmVersion,
      evaluatorAdapterVersion: search.evaluatorAdapterVersion,
      createdBy: raw.createdBy,
    });
    return { search, payload };
  }

  async getPolicyPayload(workspaceId: string, payloadId: string): Promise<AssetRetrievalPolicyCandidatePayload> {
    assertAssetRetrievalPolicyPayloadId(payloadId);
    const payload = await this.repository.getPolicyPayload(workspaceId, payloadId);
    if (!payload) bad(404, 'ASSET_RETRIEVAL_POLICY_PAYLOAD_NOT_FOUND', '策略候选载荷不存在。');
    if (assetRetrievalPolicyPayloadDigest(payload) !== payload.payloadDigest) {
      bad(409, 'ASSET_RETRIEVAL_PAYLOAD_INTEGRITY_FAILED', '策略候选载荷摘要不一致。');
    }
    return payload;
  }

  async listPolicyPayloads(workspaceId: string): Promise<{ items: AssetRetrievalPolicyCandidatePayload[] }> {
    return { items: await this.repository.listPolicyPayloads(workspaceId) };
  }

  async registerPolicyCandidate(workspaceId: string, payloadId: string,
    body: unknown = {}): Promise<RegisterAssetRetrievalPolicyCandidateResult> {
    const payload = await this.getPolicyPayload(workspaceId, payloadId);
    const raw = this.bodyObject(body);
    const actorId = this.requiredText(raw.actorId, 'actorId', 200);
    if (!this.options.gate) bad(503, 'ASSET_RETRIEVAL_GATE_UNAVAILABLE',
      '#135 EvolutionGateService 未注入，不能创建候选。');
    const dataset = await this.getDatasetRevision(workspaceId, payload.assetRetrievalDatasetRevisionId);
    const observations: AssetRetrievalObservation[] = [];
    for (const id of dataset.source.observationIds) {
      const observation = await this.repository.getObservation(workspaceId, id);
      if (observation) observations.push(observation);
    }
    const scope = projectScope(observations);
    const diff: Record<string, { from: unknown; to: unknown }> = {};
    if (payload.basePolicyDigest !== payload.policyDigest) {
      for (const key of payload.boundsProof.changedParameters) {
        diff[key] = { from: payload.basePolicy[key], to: payload[key] };
      }
    }
    if (Object.keys(diff).length === 0) {
      bad(422, 'ASSET_RETRIEVAL_PAYLOAD_NO_CHANGE', '候选载荷没有可提交的参数变化。');
    }
    try {
      const candidate = await this.options.gate.createCandidate(workspaceId, {
        domain: 'AssetRetrievalPolicy',
        scope: scope.scope,
        projectId: scope.projectId,
        baselineRevision: payload.basePolicyVersion,
        baselineDigest: payload.basePolicyDigest,
        candidateRevision: payload.payloadId,
        diff,
        summary: `资产检索策略 ${payload.boundsProof.changedParameters.join('/')} 有界参数候选`,
        generatedBy: 'rule',
        generatorVersion: payload.searchAlgorithmVersion,
        tokenLimit: this.options.tokenLimit ?? 1000,
        costLimitMinor: this.options.costLimitMinor ?? 0,
        currency: 'CNY',
        proposalKey: `asset-retrieval|${workspaceId}|${payload.assetRetrievalDatasetRevisionId}`
          + `|${payload.basePolicyDigest}|${payload.searchAlgorithmVersion}`,
        maxCandidatesPerProposal: 2,
        createdBy: actorId,
      });
      const refs = await this.mergeRefs(workspaceId, payload.payloadId, {
        candidateVersionId: candidate.candidateId,
        policyDigest: payload.policyDigest,
      });
      return { payload, refs, candidate };
    } catch (error) {
      if (error instanceof AssetRetrievalGovernanceError) throw error;
      const status = (error as { status?: unknown }).status;
      const code = (error as { code?: unknown }).code;
      if (typeof status === 'number' && typeof code === 'string') {
        throw new AssetRetrievalGovernanceError(status, code, (error as Error).message, 'governance');
      }
      throw error;
    }
  }

  async registerEvaluationDataset(workspaceId: string, datasetRevisionId: string, body: unknown): Promise<{
    datasetRevision: AssetRetrievalDatasetRevision;
    evaluation: Awaited<ReturnType<AssetRetrievalEvaluationDatasetRegistrar['register']>>;
    refs: AssetRetrievalGovernanceRefs | null;
  }> {
    if (!this.options.evaluationRegistrar) {
      bad(503, 'ASSET_RETRIEVAL_EVALUATION_UNAVAILABLE', '#134 EvaluationService 未注入，不能注册评测数据集。');
    }
    const revision = await this.getDatasetRevision(workspaceId, datasetRevisionId);
    const raw = this.bodyObject(body);
    const authorization = raw.authorization as EvaluationAuthorization | undefined;
    if (!authorization || typeof authorization !== 'object') {
      bad(400, 'ASSET_RETRIEVAL_EVALUATION_AUTHORIZATION_REQUIRED', '必须提供已授予的评测授权。');
    }
    const samples = await this.datasetSamples(workspaceId, revision.datasetRevisionId);
    if (samples.length === 0) bad(422, 'ASSET_RETRIEVAL_DATASET_UNLABELED', '数据集没有标注样本。');
    const cases = buildAssetRetrievalEvaluationCases({
      datasetRevision: revision,
      samples,
      authorization,
      sensitivity: raw.sensitivity as SensitivityLevel | undefined,
      title: raw.title === undefined ? undefined : this.requiredText(raw.title, 'title', 120),
      intent: raw.intent === undefined ? undefined : this.requiredText(raw.intent, 'intent', 300),
    });
    let registered: Awaited<ReturnType<AssetRetrievalEvaluationDatasetRegistrar['register']>>;
    try {
      registered = await this.options.evaluationRegistrar.register({
        workspaceId,
        title: raw.title === undefined ? `资产检索策略数据集 ${revision.datasetRevisionId}`
          : this.requiredText(raw.title, 'title', 120),
        description: `由 #128 冻结数据集 ${revision.datasetRevisionId} 生成`,
        cases,
        authorization,
        sensitivity: (raw.sensitivity as SensitivityLevel | undefined) ?? 'internal',
        contentSummary: revision.contentSummary,
      });
    } catch (error) {
      throw new AssetRetrievalGovernanceError(422, 'ASSET_RETRIEVAL_EVALUATION_REGISTRATION_FAILED',
        `#134 注册评测数据集失败：${(error as Error).message}`, 'eval');
    }
    if (!EVALUATION_DATASET_REVISION_ID.test(registered.revisionId)
      || !/^evalds_[a-f0-9]{32}$/u.test(registered.datasetId)
      || !HEX64.test(registered.digest) || registered.caseCount !== cases.length) {
      throw new AssetRetrievalGovernanceError(422, 'ASSET_RETRIEVAL_EVALUATION_REGISTRATION_FAILED',
        '#134 返回的数据集身份不完整或与冻结样例数不一致。', 'eval');
    }
    // #135/#134 资源只能通过 typed refs 挂到已存在的策略载荷；不复制 dataset/scorecard。
    const payloads = (await this.repository.listPolicyPayloads(workspaceId))
      .filter(item => item.assetRetrievalDatasetRevisionId === revision.datasetRevisionId);
    let refs: AssetRetrievalGovernanceRefs | null = null;
    for (const payload of payloads) {
      refs = await this.mergeRefs(workspaceId, payload.payloadId, {
        evaluationDatasetVersionId: registered.revisionId,
        evaluationDatasetRevisionDigest: registered.digest,
      });
    }
    return { datasetRevision: revision, evaluation: registered, refs };
  }

  async attachGovernanceRefs(workspaceId: string, payloadId: string, body: unknown): Promise<AssetRetrievalGovernanceRefs> {
    const payload = await this.getPolicyPayload(workspaceId, payloadId);
    const raw = this.bodyObject(body);
    const patch: Partial<AssetRetrievalGovernanceRefs> = {};
    if (raw.candidateVersionId !== undefined) {
      const candidate = optional(raw.candidateVersionId, 'candidateVersionId', 160);
      if (candidate && !EVOLUTION_CANDIDATE_ID.test(candidate)) {
        bad(400, 'ASSET_RETRIEVAL_REFERENCE_INVALID', 'candidateVersionId 必须是 #135 Candidate 标识。');
      }
      patch.candidateVersionId = candidate;
    }
    if (raw.evaluationDatasetVersionId !== undefined) {
      const revision = optional(raw.evaluationDatasetVersionId, 'evaluationDatasetVersionId', 160);
      if (revision && !EVALUATION_DATASET_REVISION_ID.test(revision)) {
        bad(400, 'ASSET_RETRIEVAL_REFERENCE_INVALID', 'evaluationDatasetVersionId 必须是 #134 revision 标识。');
      }
      patch.evaluationDatasetVersionId = revision;
    }
    if (raw.evaluationDatasetRevisionDigest !== undefined) {
      patch.evaluationDatasetRevisionDigest = optionalHex(raw.evaluationDatasetRevisionDigest,
        'evaluationDatasetRevisionDigest');
    }
    if (raw.evaluationRunId !== undefined) patch.evaluationRunId = optional(raw.evaluationRunId, 'evaluationRunId');
    if (raw.scorecardId !== undefined) patch.scorecardId = optional(raw.scorecardId, 'scorecardId');
    if (raw.gateDecisionId !== undefined) patch.gateDecisionId = optional(raw.gateDecisionId, 'gateDecisionId');
    if (raw.rolloutId !== undefined) patch.rolloutId = optional(raw.rolloutId, 'rolloutId');
    if (raw.registryEntryId !== undefined) patch.registryEntryId = optional(raw.registryEntryId, 'registryEntryId');
    if (raw.registryRevision !== undefined) patch.registryRevision = optionalRevision(raw.registryRevision, 'registryRevision');
    if (raw.policyVersionId !== undefined) patch.policyVersionId = optional(raw.policyVersionId, 'policyVersionId');
    if (raw.policyDigest !== undefined) patch.policyDigest = optionalHex(raw.policyDigest, 'policyDigest');
    if (Object.keys(patch).length === 0) {
      bad(400, 'ASSET_RETRIEVAL_REFERENCE_INVALID', '没有可附加的 typed refs。');
    }
    return this.mergeRefs(workspaceId, payload.payloadId, patch);
  }

  async summary(workspaceId: string): Promise<AssetRetrievalGovernanceSummary> {
    const [observationCount, decisionCount, datasetRevisionCount, policyPayloadCount,
      datasets, payloads] = await Promise.all([
      this.repository.countObservations(workspaceId),
      this.repository.countDecisions(workspaceId),
      this.repository.countDatasetRevisions(workspaceId),
      this.repository.countPolicyPayloads(workspaceId),
      this.repository.listDatasetRevisions(workspaceId),
      this.repository.listPolicyPayloads(workspaceId),
    ]);
    const latestDatasetRevision = datasets.at(-1) ?? null;
    const latestPolicyPayload = payloads.at(-1) ?? null;
    const latestRefs = latestPolicyPayload
      ? await this.repository.getGovernanceRefs(workspaceId, latestPolicyPayload.payloadId) : null;
    return {
      workspaceId,
      observationCount,
      decisionCount,
      datasetRevisionCount,
      policyPayloadCount,
      latestDatasetRevision,
      latestPolicyPayload,
      latestRefs,
    };
  }

  private async mergeRefs(workspaceId: string,
    payloadId: string, patch: Partial<AssetRetrievalGovernanceRefs>): Promise<AssetRetrievalGovernanceRefs> {
    const existing = await this.repository.getGovernanceRefs(workspaceId, payloadId);
    const refs: AssetRetrievalGovernanceRefs = {
      ...{
        payloadId,
        workspaceId,
        candidateVersionId: null,
        evaluationDatasetVersionId: null,
        evaluationDatasetRevisionDigest: null,
        evaluationRunId: null,
        scorecardId: null,
        gateDecisionId: null,
        rolloutId: null,
        registryEntryId: null,
        registryRevision: null,
        policyVersionId: null,
        policyDigest: null,
        updatedAt: this.timestamp(),
      },
      ...existing,
      ...patch,
      payloadId,
      workspaceId,
      updatedAt: this.timestamp(),
    };
    await this.repository.putGovernanceRefs(refs);
    return refs;
  }

  private bodyObject(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      bad(400, 'ASSET_RETRIEVAL_INPUT_INVALID', '请求体必须是 JSON 对象。');
    }
    return body as Record<string, unknown>;
  }

  private requiredText(value: unknown, field: string, max: number): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max) {
      bad(400, 'ASSET_RETRIEVAL_INPUT_INVALID', `${field} 必须是 1..${max} 字符。`);
    }
    return normalizeGovernanceText(value);
  }

  private hex(value: unknown, field: string): string {
    if (typeof value !== 'string' || !HEX64.test(value)) {
      bad(400, 'ASSET_RETRIEVAL_INPUT_INVALID', `${field} 必须是 sha256 hex。`);
    }
    return value;
  }

  private parsePolicy(value: unknown, field: string): AssetRetrievalPolicy {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      bad(400, 'ASSET_RETRIEVAL_INPUT_INVALID', `${field} 必须是对象。`);
    }
    const raw = value as Record<string, unknown>;
    const policy: AssetRetrievalPolicy = {
      threshold: raw.threshold as number,
      ambiguityMargin: raw.ambiguityMargin as number,
      semanticWeight: raw.semanticWeight as number,
    };
    try {
      assetRetrievalPolicyDigest(policy);
    } catch {
      bad(400, 'ASSET_RETRIEVAL_POLICY_INVALID', `${field} 参数超出支持范围。`);
    }
    return policy;
  }
}

function assertObservationId(value: string): string {
  if (!OBSERVATION_ID.test(value)) bad(400, 'ASSET_RETRIEVAL_ID_INVALID', '检索观测标识无效。');
  return value;
}

export const ASSET_RETRIEVAL_GOVERNANCE_MIGRATIONS = ['054'] as const;
export const ASSET_RETRIEVAL_GOVERNANCE_SCHEMA = ASSET_RETRIEVAL_GOVERNANCE_SCHEMA_VERSION;
export const ASSET_RETRIEVAL_GOVERNANCE_DEFAULT_SEARCH_SPACE = DEFAULT_ASSET_RETRIEVAL_SEARCH_SPACE;
