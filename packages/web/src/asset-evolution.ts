import type {
  AssetEvolutionSummary, AssetImprovementProposal, AssetPolicyRegistry, AssetProbeReport,
  AssetRetrievalCandidate, AssetRetrievalPolicy, AssetRunEvidence,
} from '@lyra/shared';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown) { return typeof value === 'string' ? value : ''; }
function list(value: unknown) { return Array.isArray(value) ? value : []; }
function finite(value: unknown, fallback = 0) { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function policy(value: unknown): AssetRetrievalPolicy | null {
  const row = record(value); if (!row) return null;
  const threshold = finite(row.threshold, -1); const ambiguityMargin = finite(row.ambiguityMargin, -1); const semanticWeight = finite(row.semanticWeight, -1);
  return threshold >= 0 && threshold <= 1 && ambiguityMargin >= 0 && ambiguityMargin <= 0.5 && semanticWeight >= 0 && semanticWeight <= 1
    ? { threshold, ambiguityMargin, semanticWeight } : null;
}
function registry(value: unknown): AssetPolicyRegistry | null {
  const row = record(value); const frozen = record(row?.policy); const parsed = frozen ? policy(frozen) : null;
  if (!row || !frozen || !parsed || !text(frozen.policyDigest)) return null;
  return { domain: 'AssetRetrievalPolicy', revision: Math.max(0, Math.floor(finite(row.revision))),
    policy: { ...parsed, schemaVersion: 'asset-retrieval-policy/1', registryRevision: Math.max(0, Math.floor(finite(frozen.registryRevision))),
      policyDigest: text(frozen.policyDigest), sourceCandidateId: typeof frozen.sourceCandidateId === 'string' ? frozen.sourceCandidateId : null },
    updatedAt: text(row.updatedAt), reason: text(row.reason) };
}
function evidence(value: unknown): AssetRunEvidence | null {
  const row = record(value); if (!row || !text(row.id) || !text(row.runId) || !Array.isArray(row.openIssues)) return null;
  return row as unknown as AssetRunEvidence;
}
function proposal(value: unknown): AssetImprovementProposal | null {
  const row = record(value); if (!row || !text(row.id) || !text(row.key) || !text(row.title)) return null;
  return { ...row, candidateEnabled: row.candidateEnabled === true,
    evidenceIds: list(row.evidenceIds).filter(item => typeof item === 'string'),
    sourceRunIds: list(row.sourceRunIds).filter(item => typeof item === 'string') } as unknown as AssetImprovementProposal;
}
function candidate(value: unknown): AssetRetrievalCandidate | null {
  const row = record(value); const basePolicy = policy(row?.basePolicy); const parsed = policy(row?.policy);
  if (!row || !text(row.id) || !text(row.proposalId) || !basePolicy || !parsed || !text(row.policyDigest) || !text(row.basePolicyDigest)) return null;
  return { id: text(row.id), proposalId: text(row.proposalId), basePolicy, basePolicyDigest: text(row.basePolicyDigest),
    policy: parsed, policyDigest: text(row.policyDigest), status: ['draft', 'probed', 'failed', 'adopted', 'rolledBack'].includes(text(row.status))
      ? row.status as AssetRetrievalCandidate['status'] : 'draft', createdAt: text(row.createdAt) };
}
function probe(value: unknown): AssetProbeReport | null {
  const row = record(value); const gate = record(row?.gate); if (!row || !text(row.id) || !text(row.candidateId) || !gate) return null;
  return { ...row, verdict: row.verdict === 'pass' ? 'pass' : 'fail', modelCalls: 0,
    gate: { falseReuseDelta: finite(gate.falseReuseDelta), safetyBlockDelta: finite(gate.safetyBlockDelta),
      correctReuseDelta: finite(gate.correctReuseDelta), contractFailureDelta: finite(gate.contractFailureDelta),
      embeddingCostDeltaMicros: finite(gate.embeddingCostDeltaMicros) } } as unknown as AssetProbeReport;
}

export function parseAssetEvolutionSummary(value: unknown): AssetEvolutionSummary {
  const row = record(value); const current = registry(row?.registry);
  if (!row || !current) throw new Error('资产自进化 Registry 格式不正确。');
  return { registry: current, evidence: list(row.evidence).map(evidence).filter(Boolean) as AssetRunEvidence[],
    proposals: list(row.proposals).map(proposal).filter(Boolean) as AssetImprovementProposal[],
    candidates: list(row.candidates).map(candidate).filter(Boolean) as AssetRetrievalCandidate[],
    probes: list(row.probes).map(probe).filter(Boolean) as AssetProbeReport[],
    registryEvents: list(row.registryEvents).filter(item => record(item) && text(record(item)?.id)) as AssetEvolutionSummary['registryEvents'] };
}
export function latestAssetProbe(summary: AssetEvolutionSummary, candidateId: string) {
  return summary.probes.filter(item => item.candidateId === candidateId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0] ?? null;
}
export function canRollbackAssetRegistry(summary: AssetEvolutionSummary) {
  const latest = summary.registryEvents.at(-1);
  return Boolean(latest && latest.action === 'adopt' && latest.toPolicyDigest === summary.registry.policy.policyDigest);
}
export function shortDigest(value: string) {
  if (value.startsWith('sha256:')) return `${value.slice(7, 15)}…`;
  return /^[a-f0-9]{64}$/u.test(value) ? `${value.slice(0, 8)}…` : value;
}
