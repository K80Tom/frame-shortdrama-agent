import type { QueryResultRow } from 'pg';
import {
  AssetRetrievalGovernanceError,
  type AssetRetrievalDatasetRevision,
  type AssetRetrievalDecision,
  type AssetRetrievalGovernanceRefs,
  type AssetRetrievalObservation,
  type AssetRetrievalPolicyCandidatePayload,
} from '@lyra/shared';
import type { PostgresDatabase } from '../db/client';

const clone = <T>(value: T): T => structuredClone(value);

function conflict(code: string, message: string): never {
  throw new AssetRetrievalGovernanceError(409, code, message);
}
function notFound(code: string, message: string): never {
  throw new AssetRetrievalGovernanceError(404, code, message);
}

export interface AssetRetrievalGovernanceRepository {
  getObservation(workspaceId: string, observationId: string): Promise<AssetRetrievalObservation | null>;
  findObservationByClientRequest(workspaceId: string, clientRequestId: string): Promise<AssetRetrievalObservation | null>;
  listObservations(workspaceId: string): Promise<AssetRetrievalObservation[]>;
  insertObservation(observation: AssetRetrievalObservation): Promise<void>;

  getDecision(workspaceId: string, decisionId: string): Promise<AssetRetrievalDecision | null>;
  findDecisionByClientRequest(workspaceId: string, clientRequestId: string): Promise<AssetRetrievalDecision | null>;
  getDecisionForObservation(workspaceId: string, observationId: string): Promise<AssetRetrievalDecision | null>;
  listDecisions(workspaceId: string): Promise<AssetRetrievalDecision[]>;
  insertDecision(decision: AssetRetrievalDecision): Promise<void>;

  getDatasetRevision(workspaceId: string, datasetRevisionId: string): Promise<AssetRetrievalDatasetRevision | null>;
  listDatasetRevisions(workspaceId: string): Promise<AssetRetrievalDatasetRevision[]>;
  insertDatasetRevision(revision: AssetRetrievalDatasetRevision): Promise<void>;

  getPolicyPayload(workspaceId: string, payloadId: string): Promise<AssetRetrievalPolicyCandidatePayload | null>;
  listPolicyPayloads(workspaceId: string): Promise<AssetRetrievalPolicyCandidatePayload[]>;
  insertPolicyPayload(payload: AssetRetrievalPolicyCandidatePayload): Promise<void>;

  getGovernanceRefs(workspaceId: string, payloadId: string): Promise<AssetRetrievalGovernanceRefs | null>;
  putGovernanceRefs(refs: AssetRetrievalGovernanceRefs): Promise<void>;

  countObservations(workspaceId: string): Promise<number>;
  countDecisions(workspaceId: string): Promise<number>;
  countDatasetRevisions(workspaceId: string): Promise<number>;
  countPolicyPayloads(workspaceId: string): Promise<number>;
}

function key(workspaceId: string, id: string): string {
  return `${workspaceId}\u0000${id}`;
}

/** 单测与本地演示使用；与 PostgreSQL 保持同一套 workspace/immutability 语义。 */
export class InMemoryAssetRetrievalGovernanceRepository implements AssetRetrievalGovernanceRepository {
  private readonly observations = new Map<string, AssetRetrievalObservation>();
  private readonly decisions = new Map<string, AssetRetrievalDecision>();
  private readonly datasets = new Map<string, AssetRetrievalDatasetRevision>();
  private readonly payloads = new Map<string, AssetRetrievalPolicyCandidatePayload>();
  private readonly refs = new Map<string, AssetRetrievalGovernanceRefs>();

  async getObservation(workspaceId: string, observationId: string) {
    const value = this.observations.get(key(workspaceId, observationId));
    return value ? clone(value) : null;
  }
  async findObservationByClientRequest(workspaceId: string, clientRequestId: string) {
    const found = [...this.observations.values()].find(item =>
      item.workspaceId === workspaceId && item.clientRequestId === clientRequestId);
    return found ? clone(found) : null;
  }
  async listObservations(workspaceId: string) {
    return [...this.observations.values()].filter(item => item.workspaceId === workspaceId)
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.observationId.localeCompare(b.observationId))
      .map(clone);
  }
  async insertObservation(observation: AssetRetrievalObservation) {
    if (this.observations.has(key(observation.workspaceId, observation.observationId))) {
      conflict('ASSET_RETRIEVAL_OBSERVATION_CONFLICT', '检索观测已存在。');
    }
    const sameRequest = await this.findObservationByClientRequest(observation.workspaceId, observation.clientRequestId);
    if (sameRequest) conflict('ASSET_RETRIEVAL_OBSERVATION_CONFLICT', '同一 clientRequestId 已记录了不同观测。');
    this.observations.set(key(observation.workspaceId, observation.observationId), clone(observation));
  }

  async getDecision(workspaceId: string, decisionId: string) {
    const value = this.decisions.get(key(workspaceId, decisionId));
    return value ? clone(value) : null;
  }
  async findDecisionByClientRequest(workspaceId: string, clientRequestId: string) {
    const found = [...this.decisions.values()].find(item =>
      item.workspaceId === workspaceId && item.clientRequestId === clientRequestId);
    return found ? clone(found) : null;
  }
  async getDecisionForObservation(workspaceId: string, observationId: string) {
    const found = [...this.decisions.values()].find(item =>
      item.workspaceId === workspaceId && item.observationId === observationId);
    return found ? clone(found) : null;
  }
  async listDecisions(workspaceId: string) {
    return [...this.decisions.values()].filter(item => item.workspaceId === workspaceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.decisionId.localeCompare(b.decisionId))
      .map(clone);
  }
  async insertDecision(decision: AssetRetrievalDecision) {
    if (this.decisions.has(key(decision.workspaceId, decision.decisionId))) {
      conflict('ASSET_RETRIEVAL_DECISION_CONFLICT', '检索决策已存在。');
    }
    if (await this.getDecisionForObservation(decision.workspaceId, decision.observationId)) {
      conflict('ASSET_RETRIEVAL_DECISION_CONFLICT', '同一观测只能记录一条不可变决策。');
    }
    const sameRequest = await this.findDecisionByClientRequest(decision.workspaceId, decision.clientRequestId);
    if (sameRequest) conflict('ASSET_RETRIEVAL_DECISION_CONFLICT', '同一 clientRequestId 已记录了不同决策。');
    this.decisions.set(key(decision.workspaceId, decision.decisionId), clone(decision));
  }

  async getDatasetRevision(workspaceId: string, datasetRevisionId: string) {
    const value = this.datasets.get(key(workspaceId, datasetRevisionId));
    return value ? clone(value) : null;
  }
  async listDatasetRevisions(workspaceId: string) {
    return [...this.datasets.values()].filter(item => item.workspaceId === workspaceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.datasetRevisionId.localeCompare(b.datasetRevisionId))
      .map(clone);
  }
  async insertDatasetRevision(revision: AssetRetrievalDatasetRevision) {
    if (this.datasets.has(key(revision.workspaceId, revision.datasetRevisionId))) {
      conflict('ASSET_RETRIEVAL_DATASET_CONFLICT', '数据集 revision 已存在。');
    }
    this.datasets.set(key(revision.workspaceId, revision.datasetRevisionId), clone(revision));
  }

  async getPolicyPayload(workspaceId: string, payloadId: string) {
    const value = this.payloads.get(key(workspaceId, payloadId));
    return value ? clone(value) : null;
  }
  async listPolicyPayloads(workspaceId: string) {
    return [...this.payloads.values()].filter(item => item.workspaceId === workspaceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.payloadId.localeCompare(b.payloadId))
      .map(clone);
  }
  async insertPolicyPayload(payload: AssetRetrievalPolicyCandidatePayload) {
    if (this.payloads.has(key(payload.workspaceId, payload.payloadId))) {
      conflict('ASSET_RETRIEVAL_POLICY_PAYLOAD_CONFLICT', '策略候选载荷已存在。');
    }
    this.payloads.set(key(payload.workspaceId, payload.payloadId), clone(payload));
  }

  async getGovernanceRefs(workspaceId: string, payloadId: string) {
    const value = this.refs.get(key(workspaceId, payloadId));
    return value ? clone(value) : null;
  }
  async putGovernanceRefs(value: AssetRetrievalGovernanceRefs) {
    const existing = await this.getGovernanceRefs(value.workspaceId, value.payloadId);
    this.refs.set(key(value.workspaceId, value.payloadId), clone(existing ? { ...existing, ...value } : value));
  }

  async countObservations(workspaceId: string) { return (await this.listObservations(workspaceId)).length; }
  async countDecisions(workspaceId: string) { return (await this.listDecisions(workspaceId)).length; }
  async countDatasetRevisions(workspaceId: string) { return (await this.listDatasetRevisions(workspaceId)).length; }
  async countPolicyPayloads(workspaceId: string) { return (await this.listPolicyPayloads(workspaceId)).length; }
}

/* -------------------------------------------------------------------------- */
/* PostgreSQL                                                                 */
/* -------------------------------------------------------------------------- */

interface ObservationRow extends QueryResultRow { observation_json: AssetRetrievalObservation; }
interface DecisionRow extends QueryResultRow { decision_json: AssetRetrievalDecision; }
interface DatasetRow extends QueryResultRow { revision_json: AssetRetrievalDatasetRevision; }
interface PayloadRow extends QueryResultRow { payload_json: AssetRetrievalPolicyCandidatePayload; }
interface RefsRow extends QueryResultRow {
  payload_id: string; workspace_id: string; candidate_version_id: string | null;
  evaluation_dataset_version_id: string | null; evaluation_dataset_revision_digest: string | null;
  evaluation_run_id: string | null; scorecard_id: string | null; gate_decision_id: string | null;
  rollout_id: string | null; registry_entry_id: string | null; registry_revision: number | null;
  policy_version_id: string | null; policy_digest: string | null; updated_at: unknown;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function failure(error: unknown): never {
  if (error instanceof AssetRetrievalGovernanceError) throw error;
  const record = error && typeof error === 'object' ? error as { code?: string; constraint?: string } : {};
  if (record.code === '23505') {
    if (record.constraint?.includes('observation')) {
      conflict('ASSET_RETRIEVAL_OBSERVATION_CONFLICT', '同一 workspace 已存在该检索观测或 clientRequestId。');
    }
    if (record.constraint?.includes('decision')) {
      conflict('ASSET_RETRIEVAL_DECISION_CONFLICT', '同一 workspace 已存在该检索决策或 clientRequestId。');
    }
    if (record.constraint?.includes('dataset')) {
      conflict('ASSET_RETRIEVAL_DATASET_CONFLICT', '数据集 revision 已存在。');
    }
    conflict('ASSET_RETRIEVAL_POLICY_PAYLOAD_CONFLICT', '策略候选载荷已存在。');
  }
  if (record.code === '23503') {
    conflict('ASSET_RETRIEVAL_REFERENCE_CONFLICT', '数据集或观测引用的 workspace 外记录不可用。');
  }
  if (record.code === '23514') {
    conflict('ASSET_RETRIEVAL_CONSTRAINT_VIOLATION', '数据库不可变/范围约束拒绝了该写入。');
  }
  throw new AssetRetrievalGovernanceError(503, 'ASSET_RETRIEVAL_PERSISTENCE_UNAVAILABLE',
    '资产检索治理持久化暂时不可用，请稍后重试。');
}

function refsFromRow(row: RefsRow): AssetRetrievalGovernanceRefs {
  return {
    payloadId: row.payload_id,
    workspaceId: row.workspace_id,
    candidateVersionId: row.candidate_version_id,
    evaluationDatasetVersionId: row.evaluation_dataset_version_id,
    evaluationDatasetRevisionDigest: row.evaluation_dataset_revision_digest,
    evaluationRunId: row.evaluation_run_id,
    scorecardId: row.scorecard_id,
    gateDecisionId: row.gate_decision_id,
    rolloutId: row.rollout_id,
    registryEntryId: row.registry_entry_id,
    registryRevision: row.registry_revision,
    policyVersionId: row.policy_version_id,
    policyDigest: row.policy_digest,
    updatedAt: iso(row.updated_at),
  };
}

export class PostgresAssetRetrievalGovernanceRepository implements AssetRetrievalGovernanceRepository {
  constructor(private readonly database: Pick<PostgresDatabase, 'query'>) {}

  async getObservation(workspaceId: string, observationId: string) {
    const result = await this.database.query<ObservationRow>(
      `SELECT observation_json FROM asset_retrieval_observations
       WHERE workspace_id=$1 AND observation_id=$2`, [workspaceId, observationId]);
    return result.rows[0] ? clone(result.rows[0].observation_json) : null;
  }
  async findObservationByClientRequest(workspaceId: string, clientRequestId: string) {
    const result = await this.database.query<ObservationRow>(
      `SELECT observation_json FROM asset_retrieval_observations
       WHERE workspace_id=$1 AND client_request_id=$2`, [workspaceId, clientRequestId]);
    return result.rows[0] ? clone(result.rows[0].observation_json) : null;
  }
  async listObservations(workspaceId: string) {
    const result = await this.database.query<ObservationRow>(
      `SELECT observation_json FROM asset_retrieval_observations
       WHERE workspace_id=$1 ORDER BY observed_at ASC, observation_id ASC`, [workspaceId]);
    return result.rows.map(row => clone(row.observation_json));
  }
  async insertObservation(value: AssetRetrievalObservation) {
    try {
      await this.database.query(
        `INSERT INTO asset_retrieval_observations(
           observation_id, workspace_id, project_id, shot_id, request_id, client_request_id,
           query_digest, observed_at, content_digest, observation_json)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [value.observationId, value.workspaceId, value.projectId, value.shotId, value.requestId,
          value.clientRequestId, value.query.queryDigest, value.observedAt, value.contentDigest,
          JSON.stringify(value)]);
    } catch (error) { failure(error); }
  }

  async getDecision(workspaceId: string, decisionId: string) {
    const result = await this.database.query<DecisionRow>(
      `SELECT decision_json FROM asset_retrieval_decisions
       WHERE workspace_id=$1 AND decision_id=$2`, [workspaceId, decisionId]);
    return result.rows[0] ? clone(result.rows[0].decision_json) : null;
  }
  async findDecisionByClientRequest(workspaceId: string, clientRequestId: string) {
    const result = await this.database.query<DecisionRow>(
      `SELECT decision_json FROM asset_retrieval_decisions
       WHERE workspace_id=$1 AND client_request_id=$2`, [workspaceId, clientRequestId]);
    return result.rows[0] ? clone(result.rows[0].decision_json) : null;
  }
  async getDecisionForObservation(workspaceId: string, observationId: string) {
    const result = await this.database.query<DecisionRow>(
      `SELECT decision_json FROM asset_retrieval_decisions
       WHERE workspace_id=$1 AND observation_id=$2`, [workspaceId, observationId]);
    return result.rows[0] ? clone(result.rows[0].decision_json) : null;
  }
  async listDecisions(workspaceId: string) {
    const result = await this.database.query<DecisionRow>(
      `SELECT decision_json FROM asset_retrieval_decisions
       WHERE workspace_id=$1 ORDER BY created_at ASC, decision_id ASC`, [workspaceId]);
    return result.rows.map(row => clone(row.decision_json));
  }
  async insertDecision(value: AssetRetrievalDecision) {
    try {
      await this.database.query(
        `INSERT INTO asset_retrieval_decisions(
           decision_id, workspace_id, observation_id, client_request_id, decision,
           selected_asset_id, selected_asset_version_id, actor_id, created_at, content_digest, decision_json)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
        [value.decisionId, value.workspaceId, value.observationId, value.clientRequestId, value.decision,
          value.selectedAssetId, value.selectedAssetVersionId, value.actorId, value.createdAt,
          value.contentDigest, JSON.stringify(value)]);
    } catch (error) { failure(error); }
  }

  async getDatasetRevision(workspaceId: string, datasetRevisionId: string) {
    const result = await this.database.query<DatasetRow>(
      `SELECT revision_json FROM asset_retrieval_dataset_revisions
       WHERE workspace_id=$1 AND dataset_revision_id=$2`, [workspaceId, datasetRevisionId]);
    return result.rows[0] ? clone(result.rows[0].revision_json) : null;
  }
  async listDatasetRevisions(workspaceId: string) {
    const result = await this.database.query<DatasetRow>(
      `SELECT revision_json FROM asset_retrieval_dataset_revisions
       WHERE workspace_id=$1 ORDER BY created_at ASC, dataset_revision_id ASC`, [workspaceId]);
    return result.rows.map(row => clone(row.revision_json));
  }
  async insertDatasetRevision(value: AssetRetrievalDatasetRevision) {
    try {
      await this.database.query(
        `INSERT INTO asset_retrieval_dataset_revisions(
           dataset_revision_id, workspace_id, purpose, sample_count, labeled_sample_count,
           payload_digest, created_at, revision_json)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [value.datasetRevisionId, value.workspaceId, value.purpose, value.sampleCount,
          value.labeledSampleCount, value.payloadDigest, value.createdAt, JSON.stringify(value)]);
    } catch (error) { failure(error); }
  }

  async getPolicyPayload(workspaceId: string, payloadId: string) {
    const result = await this.database.query<PayloadRow>(
      `SELECT payload_json FROM asset_retrieval_policy_payloads
       WHERE workspace_id=$1 AND payload_id=$2`, [workspaceId, payloadId]);
    return result.rows[0] ? clone(result.rows[0].payload_json) : null;
  }
  async listPolicyPayloads(workspaceId: string) {
    const result = await this.database.query<PayloadRow>(
      `SELECT payload_json FROM asset_retrieval_policy_payloads
       WHERE workspace_id=$1 ORDER BY created_at ASC, payload_id ASC`, [workspaceId]);
    return result.rows.map(row => clone(row.payload_json));
  }
  async insertPolicyPayload(value: AssetRetrievalPolicyCandidatePayload) {
    try {
      await this.database.query(
        `INSERT INTO asset_retrieval_policy_payloads(
           payload_id, workspace_id, dataset_revision_id, base_policy_digest, payload_digest, created_at, payload_json)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [value.payloadId, value.workspaceId, value.assetRetrievalDatasetRevisionId, value.basePolicyDigest,
          value.payloadDigest, value.createdAt, JSON.stringify(value)]);
    } catch (error) { failure(error); }
  }

  async getGovernanceRefs(workspaceId: string, payloadId: string) {
    const result = await this.database.query<RefsRow>(
      `SELECT * FROM asset_retrieval_governance_refs WHERE workspace_id=$1 AND payload_id=$2`,
      [workspaceId, payloadId]);
    return result.rows[0] ? refsFromRow(result.rows[0]) : null;
  }
  async putGovernanceRefs(value: AssetRetrievalGovernanceRefs) {
    try {
      await this.database.query(
        `INSERT INTO asset_retrieval_governance_refs(
           payload_id, workspace_id, candidate_version_id, evaluation_dataset_version_id,
           evaluation_dataset_revision_digest, evaluation_run_id, scorecard_id, gate_decision_id,
           rollout_id, registry_entry_id, registry_revision, policy_version_id, policy_digest, updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT(payload_id) DO UPDATE SET
           candidate_version_id=EXCLUDED.candidate_version_id,
           evaluation_dataset_version_id=EXCLUDED.evaluation_dataset_version_id,
           evaluation_dataset_revision_digest=EXCLUDED.evaluation_dataset_revision_digest,
           evaluation_run_id=EXCLUDED.evaluation_run_id,
           scorecard_id=EXCLUDED.scorecard_id,
           gate_decision_id=EXCLUDED.gate_decision_id,
           rollout_id=EXCLUDED.rollout_id,
           registry_entry_id=EXCLUDED.registry_entry_id,
           registry_revision=EXCLUDED.registry_revision,
           policy_version_id=EXCLUDED.policy_version_id,
           policy_digest=EXCLUDED.policy_digest,
           updated_at=EXCLUDED.updated_at
         WHERE asset_retrieval_governance_refs.workspace_id=EXCLUDED.workspace_id`,
        [value.payloadId, value.workspaceId, value.candidateVersionId, value.evaluationDatasetVersionId,
          value.evaluationDatasetRevisionDigest, value.evaluationRunId, value.scorecardId, value.gateDecisionId,
          value.rolloutId, value.registryEntryId, value.registryRevision, value.policyVersionId,
          value.policyDigest, value.updatedAt]);
    } catch (error) { failure(error); }
  }

  async countObservations(workspaceId: string) {
    return this.count('asset_retrieval_observations', workspaceId);
  }
  async countDecisions(workspaceId: string) {
    return this.count('asset_retrieval_decisions', workspaceId);
  }
  async countDatasetRevisions(workspaceId: string) {
    return this.count('asset_retrieval_dataset_revisions', workspaceId);
  }
  async countPolicyPayloads(workspaceId: string) {
    return this.count('asset_retrieval_policy_payloads', workspaceId);
  }
  private async count(table: string, workspaceId: string): Promise<number> {
    const result = await this.database.query<{ count: string } & QueryResultRow>(
      `SELECT count(*)::text AS count FROM ${table} WHERE workspace_id=$1`, [workspaceId]);
    return Number(result.rows[0]?.count ?? 0);
  }
}

export function assertAssetRetrievalGovernanceTablesPresent(rows: readonly string[]): void {
  const required = ['asset_retrieval_observations', 'asset_retrieval_decisions',
    'asset_retrieval_dataset_revisions', 'asset_retrieval_policy_payloads',
    'asset_retrieval_governance_refs'];
  const missing = required.filter(name => !rows.includes(name));
  if (missing.length > 0) {
    notFound('ASSET_RETRIEVAL_GOVERNANCE_UNAVAILABLE', `054 迁移未应用，缺少：${missing.join(', ')}。`);
  }
}
