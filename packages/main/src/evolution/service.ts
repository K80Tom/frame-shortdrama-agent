import {
  ProductionError, assetRetrievalPolicyDigest, canonicalDigest,
  parseProductionRunId,
  type AssetImprovementProposal, type AssetRetrievalPolicy, type FrozenAssetRetrievalPolicy,
} from '@lyra/shared';
import type { ProductionRepository } from '../production/repository';
import { buildAssetRunEvidence, buildDeterministicProposals, isTerminalEvidenceRun } from './evidence';
import { runAssetRetrievalProbe } from './probe';
import { baselineRegistry, evolutionSummary, type EvolutionRepository } from './repository';
import { tenantExecutionScope } from '../tenancy/scope';

export interface AssetEvolutionServiceOptions { now?: () => Date; }

/** P1+P2 only: deterministic evidence/proposals and offline retrieval-policy governance. */
export class AssetEvolutionService {
  private readonly now: () => Date;
  constructor(
    private readonly production: Pick<ProductionRepository, 'get'>,
    private readonly repository: EvolutionRepository,
    options: AssetEvolutionServiceOptions = {},
  ) { this.now = options.now ?? (() => new Date()); }

  private timestamp() { return this.now().toISOString(); }
  summary() { return evolutionSummary(this.repository); }

  async currentAssetRetrievalPolicy(): Promise<FrozenAssetRetrievalPolicy> {
    return (await this.repository.getRegistry() ?? baselineRegistry()).policy;
  }

  async captureEvidence(runId: string) {
    const run = await this.production.get(parseProductionRunId(runId));
    if (!run) throw new ProductionError(404, 'PRODUCTION_RUN_NOT_FOUND', '生产运行不存在。');
    if (!isTerminalEvidenceRun(run)) throw new ProductionError(409, 'EVOLUTION_RUN_NOT_TERMINAL', '只有终态运行才能形成不可变证据。');
    const existing = await this.repository.getEvidenceByRun(run.id);
    if (existing) {
      const proposals = (await this.repository.listProposals()).filter(item => item.evidenceIds.includes(existing.id));
      return { evidence: existing, proposals };
    }
    const evidence = buildAssetRunEvidence(run, this.timestamp());
    const scope = tenantExecutionScope.current();
    const proposals = buildDeterministicProposals(evidence, scope?.kind === 'tenant' ? scope.tenant.workspaceId : undefined);
    await this.repository.recordEvidence(evidence, proposals);
    return { evidence, proposals };
  }

  async createCandidate(proposalId: string) {
    const proposal = await this.requireProposal(proposalId);
    if (!proposal.candidateEnabled || proposal.kind !== 'asset_retrieval_policy' || !proposal.suggestedPolicyPatch) {
      throw new ProductionError(409, 'EVOLUTION_PROPOSAL_NOT_CANDIDATE', '该提案不属于可生成检索策略候选的范围。');
    }
    const current = await this.repository.getRegistry() ?? baselineRegistry();
    const basePolicy: AssetRetrievalPolicy = {
      threshold: current.policy.threshold, ambiguityMargin: current.policy.ambiguityMargin, semanticWeight: current.policy.semanticWeight,
    };
    const policy: AssetRetrievalPolicy = { ...basePolicy, ...proposal.suggestedPolicyPatch };
    const basePolicyDigest = assetRetrievalPolicyDigest(basePolicy);
    const policyDigest = assetRetrievalPolicyDigest(policy);
    if (policyDigest === basePolicyDigest) {
      throw new ProductionError(409, 'EVOLUTION_CANDIDATE_NO_CHANGE', '当前基线已经包含该建议，未创建无变化候选。');
    }
    const identity = { proposalId: proposal.id, basePolicyDigest, policyDigest };
    return this.repository.createCandidate({
      id: `evocand_${canonicalDigest(identity).slice(0, 32)}`, proposalId: proposal.id,
      basePolicy, basePolicyDigest, policy, policyDigest, status: 'draft', createdAt: this.timestamp(),
    });
  }

  async runProbe(candidateId: string) {
    const candidate = await this.repository.getCandidate(candidateId);
    if (!candidate) throw new ProductionError(404, 'EVOLUTION_CANDIDATE_NOT_FOUND', '检索策略候选不存在。');
    const report = await runAssetRetrievalProbe(candidate, this.timestamp());
    return this.repository.recordProbe(report);
  }

  adopt(candidateId: string, expectedPolicyDigest: string, reason: string) {
    return this.repository.adopt(candidateId, expectedPolicyDigest, reason, this.timestamp());
  }
  rollback(expectedPolicyDigest: string, reason: string) {
    return this.repository.rollback(expectedPolicyDigest, reason, this.timestamp());
  }

  private async requireProposal(id: string): Promise<AssetImprovementProposal> {
    const proposal = await this.repository.getProposal(id);
    if (!proposal) throw new ProductionError(404, 'EVOLUTION_PROPOSAL_NOT_FOUND', '改进提案不存在。');
    return proposal;
  }
}

