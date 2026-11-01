import {
  DEFAULT_ASSET_RETRIEVAL_POLICY, DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY, ProductionError,
  assetRetrievalPolicyDigest, freezeAssetRetrievalPolicy, productionId,
  type AssetEvolutionSummary, type AssetImprovementProposal, type AssetPolicyRegistry,
  type AssetProbeReport, type AssetRegistryEvent, type AssetRetrievalCandidate, type AssetRunEvidence,
} from '@lyra/shared';

const clone = <T>(value: T): T => structuredClone(value);
export function baselineRegistry(): AssetPolicyRegistry {
  return { domain: 'AssetRetrievalPolicy', revision: 0,
    policy: clone(DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY), updatedAt: '', reason: '内置基线，尚未采用候选。' };
}
function conflict(code: string, message: string): never { throw new ProductionError(409, code, message); }
function notFound(code: string, message: string): never { throw new ProductionError(404, code, message); }

export interface EvolutionRepository {
  getEvidenceByRun(runId: string): Promise<AssetRunEvidence | null>;
  listEvidence(): Promise<AssetRunEvidence[]>;
  recordEvidence(evidence: AssetRunEvidence, proposals: AssetImprovementProposal[]): Promise<void>;
  getProposal(id: string): Promise<AssetImprovementProposal | null>;
  listProposals(): Promise<AssetImprovementProposal[]>;
  getCandidate(id: string): Promise<AssetRetrievalCandidate | null>;
  listCandidates(): Promise<AssetRetrievalCandidate[]>;
  createCandidate(candidate: AssetRetrievalCandidate): Promise<AssetRetrievalCandidate>;
  listProbes(): Promise<AssetProbeReport[]>;
  recordProbe(probe: AssetProbeReport): Promise<AssetProbeReport>;
  getRegistry(): Promise<AssetPolicyRegistry | null>;
  listRegistryEvents(): Promise<AssetRegistryEvent[]>;
  adopt(candidateId: string, expectedPolicyDigest: string, reason: string, at: string): Promise<AssetPolicyRegistry>;
  rollback(expectedPolicyDigest: string, reason: string, at: string): Promise<AssetPolicyRegistry>;
}

export class MemoryEvolutionRepository implements EvolutionRepository {
  private readonly evidence = new Map<string, AssetRunEvidence>();
  private readonly proposals = new Map<string, AssetImprovementProposal>();
  private readonly candidates = new Map<string, AssetRetrievalCandidate>();
  private readonly probes = new Map<string, AssetProbeReport>();
  private readonly events: AssetRegistryEvent[] = [];
  private registry: AssetPolicyRegistry | null = null;

  async getEvidenceByRun(runId: string) {
    const found = [...this.evidence.values()].find(item => item.runId === runId); return found ? clone(found) : null;
  }
  async listEvidence() { return [...this.evidence.values()].map(clone).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async recordEvidence(evidence: AssetRunEvidence, proposals: AssetImprovementProposal[]) {
    if (!this.evidence.has(evidence.id)) this.evidence.set(evidence.id, clone(evidence));
    for (const incoming of proposals) {
      const current = this.proposals.get(incoming.id);
      if (!current) { this.proposals.set(incoming.id, clone(incoming)); continue; }
      current.evidenceIds = [...new Set([...current.evidenceIds, ...incoming.evidenceIds])].sort();
      current.sourceRunIds = [...new Set([...current.sourceRunIds, ...incoming.sourceRunIds])].sort();
      current.updatedAt = incoming.updatedAt;
    }
  }
  async getProposal(id: string) { const value = this.proposals.get(id); return value ? clone(value) : null; }
  async listProposals() { return [...this.proposals.values()].map(clone).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async getCandidate(id: string) { const value = this.candidates.get(id); return value ? clone(value) : null; }
  async listCandidates() { return [...this.candidates.values()].map(clone).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async createCandidate(candidate: AssetRetrievalCandidate) {
    const existing = [...this.candidates.values()].find(item => item.proposalId === candidate.proposalId
      && item.basePolicyDigest === candidate.basePolicyDigest && item.policyDigest === candidate.policyDigest);
    if (existing) return clone(existing);
    this.candidates.set(candidate.id, clone(candidate)); return clone(candidate);
  }
  async listProbes() { return [...this.probes.values()].map(clone).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async recordProbe(probe: AssetProbeReport) {
    const existing = this.probes.get(probe.id); if (existing) return clone(existing);
    const candidate = this.candidates.get(probe.candidateId);
    if (!candidate) return notFound('EVOLUTION_CANDIDATE_NOT_FOUND', '检索策略候选不存在。');
    this.probes.set(probe.id, clone(probe));
    if (candidate.status !== 'adopted') candidate.status = probe.verdict === 'pass' ? 'probed' : 'failed';
    return clone(probe);
  }
  async getRegistry() { return this.registry ? clone(this.registry) : null; }
  async listRegistryEvents() { return this.events.map(clone); }

  async adopt(candidateId: string, expectedPolicyDigest: string, reason: string, at: string) {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) return notFound('EVOLUTION_CANDIDATE_NOT_FOUND', '检索策略候选不存在。');
    const current = this.registry ?? baselineRegistry();
    if (current.policy.policyDigest !== expectedPolicyDigest || candidate.basePolicyDigest !== current.policy.policyDigest) {
      return conflict('EVOLUTION_REGISTRY_STALE', '候选不是从当前基线创建，或基线已变化；请重新创建并回放。');
    }
    const probe = [...this.probes.values()].filter(item => item.candidateId === candidateId).at(-1);
    if (!probe || probe.verdict !== 'pass' || probe.baselinePolicyDigest !== candidate.basePolicyDigest
      || probe.candidatePolicyDigest !== candidate.policyDigest) {
      return conflict('EVOLUTION_PROBE_REQUIRED', '采用前必须有当前候选与基线的通过回放。');
    }
    for (const item of this.candidates.values()) {
      if (item.status === 'adopted') item.status = 'rolledBack';
    }
    const registry: AssetPolicyRegistry = { domain: 'AssetRetrievalPolicy', revision: current.revision + 1,
      policy: freezeAssetRetrievalPolicy(candidate.policy, current.revision + 1, candidate.id), updatedAt: at, reason };
    candidate.status = 'adopted'; this.registry = clone(registry);
    this.events.push({ id: productionId('eveevent'), domain: 'AssetRetrievalPolicy', revision: registry.revision,
      action: 'adopt', candidateId, fromPolicyDigest: current.policy.policyDigest,
      toPolicyDigest: registry.policy.policyDigest, reason, createdAt: at });
    return clone(registry);
  }

  async rollback(expectedPolicyDigest: string, reason: string, at: string) {
    const current = this.registry ?? baselineRegistry();
    if (current.policy.policyDigest !== expectedPolicyDigest) {
      return conflict('EVOLUTION_REGISTRY_STALE', '当前 Registry 已变化，请刷新后再回滚。');
    }
    const latest = this.events.at(-1);
    if (!latest || latest.action !== 'adopt' || latest.toPolicyDigest !== current.policy.policyDigest) {
      return conflict('EVOLUTION_ROLLBACK_UNAVAILABLE', '当前版本没有可回滚的上一次采用记录。');
    }
    const defaultDigest = assetRetrievalPolicyDigest(DEFAULT_ASSET_RETRIEVAL_POLICY);
    let target: typeof DEFAULT_ASSET_RETRIEVAL_POLICY | AssetRetrievalCandidate['policy'] = DEFAULT_ASSET_RETRIEVAL_POLICY;
    let sourceCandidateId: string | null = null;
    if (latest.fromPolicyDigest !== defaultDigest) {
      const previousAdopt = [...this.events].reverse().find(event => event.revision < latest.revision
        && event.action === 'adopt' && event.toPolicyDigest === latest.fromPolicyDigest);
      const previous = previousAdopt?.candidateId ? this.candidates.get(previousAdopt.candidateId) : undefined;
      if (!previous || previous.policyDigest !== latest.fromPolicyDigest) {
        return conflict('EVOLUTION_ROLLBACK_TARGET_MISSING', '上一版本策略内容不可用，不能安全回滚。');
      }
      target = previous.policy; sourceCandidateId = previous.id;
    }
    for (const candidate of this.candidates.values()) {
      if (candidate.status === 'adopted') candidate.status = 'rolledBack';
      if (candidate.id === sourceCandidateId) candidate.status = 'adopted';
    }
    const registry: AssetPolicyRegistry = { domain: 'AssetRetrievalPolicy', revision: current.revision + 1,
      policy: freezeAssetRetrievalPolicy(target, current.revision + 1, sourceCandidateId), updatedAt: at, reason };
    this.registry = clone(registry);
    this.events.push({ id: productionId('eveevent'), domain: 'AssetRetrievalPolicy', revision: registry.revision,
      action: 'rollback', candidateId: sourceCandidateId, fromPolicyDigest: current.policy.policyDigest,
      toPolicyDigest: registry.policy.policyDigest, reason, createdAt: at });
    return clone(registry);
  }
}

export async function evolutionSummary(repository: EvolutionRepository): Promise<AssetEvolutionSummary> {
  const [registry, evidence, proposals, candidates, probes, registryEvents] = await Promise.all([
    repository.getRegistry(), repository.listEvidence(), repository.listProposals(), repository.listCandidates(),
    repository.listProbes(), repository.listRegistryEvents(),
  ]);
  return { registry: registry ?? baselineRegistry(), evidence, proposals, candidates, probes, registryEvents };
}
