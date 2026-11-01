import type { PoolClient } from 'pg';
import type { PostgresDatabase } from '../db/client';
import {
  DEFAULT_ASSET_RETRIEVAL_POLICY, ProductionError,
  assetRetrievalPolicyDigest, freezeAssetRetrievalPolicy, productionId,
  type AssetImprovementProposal, type AssetPolicyRegistry, type AssetProbeReport,
  type AssetRegistryEvent, type AssetRetrievalCandidate, type AssetRunEvidence,
} from '@lyra/shared';
import { baselineRegistry, type EvolutionRepository } from './repository';

const clone = <T>(value: T): T => structuredClone(value);
function failure(error: unknown): never {
  if (error instanceof ProductionError) throw error;
  throw new ProductionError(503, 'EVOLUTION_PERSISTENCE_UNAVAILABLE', '自进化数据暂时不可用，请稍后重试。');
}
function conflict(code: string, message: string): never { throw new ProductionError(409, code, message); }
function notFound(code: string, message: string): never { throw new ProductionError(404, code, message); }
const DEFAULT_DIGEST = assetRetrievalPolicyDigest(DEFAULT_ASSET_RETRIEVAL_POLICY);

/** PostgreSQL implementation; adoption and rollback serialize on one advisory lock. */
export class PostgresEvolutionRepository implements EvolutionRepository {
  constructor(private readonly database: PostgresDatabase) {}
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    try { return await this.database.transaction(work); } catch (error) { return failure(error); }
  }
  private async one<T>(client: PoolClient, text: string, values: unknown[] = []): Promise<T | null> {
    const result = await client.query(text, values); return result.rows[0] ? clone(result.rows[0] as T) : null;
  }
  private async registry(client: PoolClient, lock = false): Promise<AssetPolicyRegistry | null> {
    const row = await this.one<{ policy_json: AssetPolicyRegistry['policy']; updated_at: string; reason: string }>(client,
      `SELECT policy_json, updated_at::text, reason FROM evolution_registry WHERE domain = 'AssetRetrievalPolicy'${lock ? ' FOR UPDATE' : ''}`);
    return row ? { domain: 'AssetRetrievalPolicy', revision: row.policy_json.registryRevision,
      policy: row.policy_json, updatedAt: new Date(row.updated_at).toISOString(), reason: row.reason } : null;
  }
  private async lockRegistry(client: PoolClient) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('lyra:evolution:AssetRetrievalPolicy'))");
  }

  async getEvidenceByRun(runId: string): Promise<AssetRunEvidence | null> {
    try { const result = await this.database.query('SELECT evidence_json FROM evolution_evidence WHERE run_id = $1', [runId]);
      return result.rows[0]?.evidence_json ? clone(result.rows[0].evidence_json) : null; } catch (error) { return failure(error); }
  }
  async listEvidence(): Promise<AssetRunEvidence[]> {
    try { const result = await this.database.query('SELECT evidence_json FROM evolution_evidence ORDER BY created_at DESC, id DESC');
      return result.rows.map(row => clone(row.evidence_json)); } catch (error) { return failure(error); }
  }
  async recordEvidence(evidence: AssetRunEvidence, proposals: AssetImprovementProposal[]): Promise<void> {
    await this.transaction(async client => {
      await client.query(`INSERT INTO evolution_evidence (id, run_id, evidence_json, created_at)
        VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING`, [evidence.id, evidence.runId, evidence, evidence.createdAt]);
      for (const proposal of proposals) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lyra:proposal:${proposal.key}`]);
        const current = await this.one<{ proposal_json: AssetImprovementProposal }>(client,
          'SELECT proposal_json FROM evolution_proposals WHERE key = $1 FOR UPDATE', [proposal.key]);
        if (!current) await client.query(`INSERT INTO evolution_proposals (id,key,proposal_json,updated_at)
          VALUES ($1,$2,$3::jsonb,$4)`, [proposal.id, proposal.key, proposal, proposal.updatedAt]);
        else {
          const merged = { ...current.proposal_json,
            evidenceIds: [...new Set([...current.proposal_json.evidenceIds, ...proposal.evidenceIds])].sort(),
            sourceRunIds: [...new Set([...current.proposal_json.sourceRunIds, ...proposal.sourceRunIds])].sort(),
            updatedAt: proposal.updatedAt };
          await client.query('UPDATE evolution_proposals SET proposal_json=$2::jsonb,updated_at=$3 WHERE key=$1',
            [proposal.key, merged, proposal.updatedAt]);
        }
      }
    });
  }
  async getProposal(id: string): Promise<AssetImprovementProposal | null> {
    try { const result = await this.database.query('SELECT proposal_json FROM evolution_proposals WHERE id=$1', [id]);
      return result.rows[0]?.proposal_json ? clone(result.rows[0].proposal_json) : null; } catch (error) { return failure(error); }
  }
  async listProposals(): Promise<AssetImprovementProposal[]> {
    try { const result = await this.database.query('SELECT proposal_json FROM evolution_proposals ORDER BY updated_at DESC,id DESC');
      return result.rows.map(row => clone(row.proposal_json)); } catch (error) { return failure(error); }
  }
  async getCandidate(id: string): Promise<AssetRetrievalCandidate | null> {
    try { const result = await this.database.query('SELECT candidate_json FROM evolution_candidates WHERE id=$1', [id]);
      return result.rows[0]?.candidate_json ? clone(result.rows[0].candidate_json) : null; } catch (error) { return failure(error); }
  }
  async listCandidates(): Promise<AssetRetrievalCandidate[]> {
    try { const result = await this.database.query('SELECT candidate_json FROM evolution_candidates ORDER BY created_at DESC,id DESC');
      return result.rows.map(row => clone(row.candidate_json)); } catch (error) { return failure(error); }
  }
  async createCandidate(candidate: AssetRetrievalCandidate): Promise<AssetRetrievalCandidate> {
    return this.transaction(async client => {
      await client.query(`INSERT INTO evolution_candidates
        (id,proposal_id,base_policy_digest,policy_digest,status,candidate_json,created_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
        ON CONFLICT (proposal_id,base_policy_digest,policy_digest) DO NOTHING`, [candidate.id, candidate.proposalId,
        candidate.basePolicyDigest, candidate.policyDigest, candidate.status, candidate, candidate.createdAt]);
      const stored = await this.one<{ candidate_json: AssetRetrievalCandidate }>(client,
        `SELECT candidate_json FROM evolution_candidates WHERE proposal_id=$1 AND base_policy_digest=$2 AND policy_digest=$3`,
        [candidate.proposalId, candidate.basePolicyDigest, candidate.policyDigest]);
      if (!stored) return notFound('EVOLUTION_CANDIDATE_NOT_FOUND', '检索策略候选未能持久化。');
      return stored.candidate_json;
    });
  }
  async listProbes(): Promise<AssetProbeReport[]> {
    try { const result = await this.database.query('SELECT probe_json FROM evolution_probes ORDER BY created_at DESC,id DESC');
      return result.rows.map(row => clone(row.probe_json)); } catch (error) { return failure(error); }
  }
  async recordProbe(probe: AssetProbeReport): Promise<AssetProbeReport> {
    return this.transaction(async client => {
      const existing = await this.one<{ probe_json: AssetProbeReport }>(client, 'SELECT probe_json FROM evolution_probes WHERE id=$1', [probe.id]);
      if (existing) return existing.probe_json;
      const candidate = await this.one<{ candidate_json: AssetRetrievalCandidate }>(client,
        'SELECT candidate_json FROM evolution_candidates WHERE id=$1 FOR UPDATE', [probe.candidateId]);
      if (!candidate) return notFound('EVOLUTION_CANDIDATE_NOT_FOUND', '检索策略候选不存在。');
      await client.query(`INSERT INTO evolution_probes (id,candidate_id,probe_json,created_at)
        VALUES ($1,$2,$3::jsonb,$4)`, [probe.id, probe.candidateId, probe, probe.createdAt]);
      if (candidate.candidate_json.status !== 'adopted') {
        const status = probe.verdict === 'pass' ? 'probed' : 'failed';
        candidate.candidate_json.status = status;
        await client.query('UPDATE evolution_candidates SET status=$2,candidate_json=$3::jsonb WHERE id=$1',
          [probe.candidateId, status, candidate.candidate_json]);
      }
      return probe;
    });
  }
  async getRegistry(): Promise<AssetPolicyRegistry | null> {
    return this.transaction(client => this.registry(client));
  }
  async listRegistryEvents(): Promise<AssetRegistryEvent[]> {
    try { const result = await this.database.query("SELECT event_json FROM evolution_registry_events WHERE domain='AssetRetrievalPolicy' ORDER BY revision,id");
      return result.rows.map(row => clone(row.event_json)); } catch (error) { return failure(error); }
  }
  async adopt(candidateId: string, expectedPolicyDigest: string, reason: string, at: string): Promise<AssetPolicyRegistry> {
    return this.transaction(async client => {
      await this.lockRegistry(client);
      const candidate = await this.one<{ candidate_json: AssetRetrievalCandidate }>(client,
        'SELECT candidate_json FROM evolution_candidates WHERE id=$1 FOR UPDATE', [candidateId]);
      if (!candidate) return notFound('EVOLUTION_CANDIDATE_NOT_FOUND', '检索策略候选不存在。');
      const current = await this.registry(client, true) ?? baselineRegistry();
      if (current.policy.policyDigest !== expectedPolicyDigest
        || candidate.candidate_json.basePolicyDigest !== current.policy.policyDigest) {
        return conflict('EVOLUTION_REGISTRY_STALE', '候选不是从当前基线创建，或基线已变化；请重新创建并回放。');
      }
      const probe = await this.one<{ probe_json: AssetProbeReport }>(client,
        'SELECT probe_json FROM evolution_probes WHERE candidate_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [candidateId]);
      if (!probe || probe.probe_json.verdict !== 'pass'
        || probe.probe_json.baselinePolicyDigest !== candidate.candidate_json.basePolicyDigest
        || probe.probe_json.candidatePolicyDigest !== candidate.candidate_json.policyDigest) {
        return conflict('EVOLUTION_PROBE_REQUIRED', '采用前必须有当前候选与基线的通过回放。');
      }
      await client.query("UPDATE evolution_candidates SET status='rolledBack',candidate_json=jsonb_set(candidate_json,'{status}','\"rolledBack\"') WHERE status='adopted'");
      const revision = current.revision + 1;
      const registry: AssetPolicyRegistry = { domain: 'AssetRetrievalPolicy', revision,
        policy: freezeAssetRetrievalPolicy(candidate.candidate_json.policy, revision, candidateId), updatedAt: at, reason };
      candidate.candidate_json.status = 'adopted';
      await client.query("UPDATE evolution_candidates SET status='adopted',candidate_json=$2::jsonb WHERE id=$1", [candidateId, candidate.candidate_json]);
      await this.saveRegistry(client, registry);
      const event: AssetRegistryEvent = { id: productionId('eveevent'), domain: 'AssetRetrievalPolicy', revision,
        action: 'adopt', candidateId, fromPolicyDigest: current.policy.policyDigest,
        toPolicyDigest: registry.policy.policyDigest, reason, createdAt: at };
      await client.query(`INSERT INTO evolution_registry_events (id,domain,revision,event_json,created_at)
        VALUES ($1,$2,$3,$4::jsonb,$5)`, [event.id, event.domain, event.revision, event, at]);
      return registry;
    });
  }
  async rollback(expectedPolicyDigest: string, reason: string, at: string): Promise<AssetPolicyRegistry> {
    return this.transaction(async client => {
      await this.lockRegistry(client);
      const current = await this.registry(client, true) ?? baselineRegistry();
      if (current.policy.policyDigest !== expectedPolicyDigest) return conflict('EVOLUTION_REGISTRY_STALE', '当前 Registry 已变化，请刷新后再回滚。');
      const latest = await this.one<{ event_json: AssetRegistryEvent }>(client,
        "SELECT event_json FROM evolution_registry_events WHERE domain='AssetRetrievalPolicy' ORDER BY revision DESC LIMIT 1");
      if (!latest || latest.event_json.action !== 'adopt' || latest.event_json.toPolicyDigest !== current.policy.policyDigest) {
        return conflict('EVOLUTION_ROLLBACK_UNAVAILABLE', '当前版本没有可回滚的上一次采用记录。');
      }
      let target: typeof DEFAULT_ASSET_RETRIEVAL_POLICY | AssetRetrievalCandidate['policy'] = DEFAULT_ASSET_RETRIEVAL_POLICY;
      let sourceCandidateId: string | null = null;
      if (latest.event_json.fromPolicyDigest !== DEFAULT_DIGEST) {
        const previousAdopt = await this.one<{ event_json: AssetRegistryEvent }>(client,
          `SELECT event_json FROM evolution_registry_events
           WHERE domain='AssetRetrievalPolicy' AND revision<$1 AND event_json->>'action'='adopt'
             AND event_json->>'toPolicyDigest'=$2 ORDER BY revision DESC LIMIT 1`,
          [latest.event_json.revision, latest.event_json.fromPolicyDigest]);
        const previous = previousAdopt?.event_json.candidateId
          ? await this.one<{ candidate_json: AssetRetrievalCandidate }>(client,
            'SELECT candidate_json FROM evolution_candidates WHERE id=$1', [previousAdopt.event_json.candidateId]) : null;
        if (!previous || previous.candidate_json.policyDigest !== latest.event_json.fromPolicyDigest) {
          return conflict('EVOLUTION_ROLLBACK_TARGET_MISSING', '上一版本策略内容不可用，不能安全回滚。');
        }
        target = previous.candidate_json.policy; sourceCandidateId = previous.candidate_json.id;
      }
      await client.query("UPDATE evolution_candidates SET status='rolledBack',candidate_json=jsonb_set(candidate_json,'{status}','\"rolledBack\"') WHERE status='adopted'");
      if (sourceCandidateId) await client.query("UPDATE evolution_candidates SET status='adopted',candidate_json=jsonb_set(candidate_json,'{status}','\"adopted\"') WHERE id=$1", [sourceCandidateId]);
      const revision = current.revision + 1;
      const registry: AssetPolicyRegistry = { domain: 'AssetRetrievalPolicy', revision,
        policy: freezeAssetRetrievalPolicy(target, revision, sourceCandidateId), updatedAt: at, reason };
      await this.saveRegistry(client, registry);
      const event: AssetRegistryEvent = { id: productionId('eveevent'), domain: 'AssetRetrievalPolicy', revision,
        action: 'rollback', candidateId: sourceCandidateId, fromPolicyDigest: current.policy.policyDigest,
        toPolicyDigest: registry.policy.policyDigest, reason, createdAt: at };
      await client.query(`INSERT INTO evolution_registry_events (id,domain,revision,event_json,created_at)
        VALUES ($1,$2,$3,$4::jsonb,$5)`, [event.id, event.domain, event.revision, event, at]);
      return registry;
    });
  }
  private async saveRegistry(client: PoolClient, registry: AssetPolicyRegistry) {
    await client.query(`INSERT INTO evolution_registry (domain,policy_json,updated_at,reason)
      VALUES ($1,$2::jsonb,$3,$4) ON CONFLICT(domain) DO UPDATE
      SET policy_json=EXCLUDED.policy_json,updated_at=EXCLUDED.updated_at,reason=EXCLUDED.reason`,
    [registry.domain, registry.policy, registry.updatedAt, registry.reason]);
  }
}

