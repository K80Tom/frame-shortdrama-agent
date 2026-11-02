import type {
  ProductionArtifact, ProductionIssue, ProductionRunStatus, ProductionTask, QualityCheck, TaskAttempt,
} from './production';
import type { AssetRetrievalPolicy, FrozenAssetRetrievalPolicy } from './asset-retrieval';

export const ASSET_EVIDENCE_SCHEMA_VERSION = 'asset-run-evidence/1';
export const ASSET_PROPOSAL_RULE_VERSION = 'asset-deterministic-proposal/1';
export const ASSET_PROBE_FIXTURE_VERSION = 'asset-retrieval-probe/1';

export interface AssetEvidenceIssue {
  issue: ProductionIssue;
  failureSignature: string;
  family: 'asset_retrieval' | 'asset_metadata' | 'media_runtime' | 'budget' | 'story_contract' | 'other';
}

/** Immutable terminal-run snapshot. Resolved issues are deliberately excluded. */
export interface AssetRunEvidence {
  schemaVersion: typeof ASSET_EVIDENCE_SCHEMA_VERSION;
  id: string;
  runId: string;
  terminalStatus: ProductionRunStatus;
  runDigest: string;
  createdAt: string;
  input: Record<string, unknown>;
  assetRetrievalPolicy: FrozenAssetRetrievalPolicy;
  tasks: ProductionTask[];
  attempts: TaskAttempt[];
  openIssues: AssetEvidenceIssue[];
  qualityChecks: QualityCheck[];
  artifacts: Array<Pick<ProductionArtifact, 'id' | 'taskId' | 'kind' | 'uri' | 'sha256' | 'status' | 'createdAt'>>;
  ruleVersions: string[];
  modelRevisions: string[];
  actualCostMicros: number;
  currency: string;
  durationMs: number | null;
}

export interface AssetImprovementProposal {
  schemaVersion: typeof ASSET_PROPOSAL_RULE_VERSION;
  id: string;
  key: string;
  family: AssetEvidenceIssue['family'];
  failureSignature: string;
  scope: string;
  kind: 'asset_retrieval_policy' | 'asset_metadata' | 'media_runtime' | 'budget_operations' | 'story_contract' | 'manual_review';
  title: string;
  summary: string;
  evidenceIds: string[];
  sourceRunIds: string[];
  suggestedPolicyPatch: Partial<AssetRetrievalPolicy> | null;
  candidateEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AssetRetrievalCandidate {
  id: string;
  proposalId: string;
  basePolicy: AssetRetrievalPolicy;
  basePolicyDigest: string;
  policy: AssetRetrievalPolicy;
  policyDigest: string;
  status: 'draft' | 'probed' | 'failed' | 'adopted' | 'rolledBack';
  createdAt: string;
}

export interface AssetProbeSide {
  status: string;
  assetId: string | null;
  falseReuse: boolean;
  safetyBlock: boolean;
  correctReuse: boolean;
  embeddingCostMicros: number;
}

export interface AssetProbeCase {
  key: string;
  expected: 'unique' | 'ambiguous' | 'missing';
  expectedAssetId: string | null;
  baseline: AssetProbeSide;
  candidate: AssetProbeSide;
  pass: boolean;
}

export interface AssetProbeReport {
  id: string;
  candidateId: string;
  fixtureVersion: typeof ASSET_PROBE_FIXTURE_VERSION;
  baselinePolicyDigest: string;
  candidatePolicyDigest: string;
  verdict: 'pass' | 'fail';
  gate: {
    falseReuseDelta: number;
    safetyBlockDelta: number;
    correctReuseDelta: number;
    contractFailureDelta: number;
    embeddingCostDeltaMicros: number;
  };
  baselineMetrics: { falseReuses: number; safetyBlocks: number; correctReuses: number; contractFailures: number; embeddingCostMicros: number };
  candidateMetrics: { falseReuses: number; safetyBlocks: number; correctReuses: number; contractFailures: number; embeddingCostMicros: number };
  cases: AssetProbeCase[];
  modelCalls: 0;
  createdAt: string;
}

export interface AssetPolicyRegistry {
  domain: 'AssetRetrievalPolicy';
  revision: number;
  policy: FrozenAssetRetrievalPolicy;
  updatedAt: string;
  reason: string;
}

export interface AssetRegistryEvent {
  id: string;
  domain: 'AssetRetrievalPolicy';
  revision: number;
  action: 'adopt' | 'rollback';
  candidateId: string | null;
  fromPolicyDigest: string;
  toPolicyDigest: string;
  reason: string;
  createdAt: string;
}

export interface AssetEvolutionSummary {
  registry: AssetPolicyRegistry;
  evidence: AssetRunEvidence[];
  proposals: AssetImprovementProposal[];
  candidates: AssetRetrievalCandidate[];
  probes: AssetProbeReport[];
  registryEvents: AssetRegistryEvent[];
}
