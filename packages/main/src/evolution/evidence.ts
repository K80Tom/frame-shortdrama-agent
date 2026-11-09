import {
  ASSET_EVIDENCE_SCHEMA_VERSION, ASSET_PROPOSAL_RULE_VERSION, CREATE_KEYS,
  DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY, canonicalDigest,
  type AssetEvidenceIssue, type AssetImprovementProposal, type AssetRunEvidence, type ProductionIssue,
  type StoredProductionRun,
} from '@lyra/shared';

const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled']);

export function isTerminalEvidenceRun(run: StoredProductionRun): boolean {
  return TERMINAL.has(run.status);
}

export function classifyIssue(issue: ProductionIssue): AssetEvidenceIssue['family'] {
  const code = issue.code.toUpperCase();
  if (/AMBIGU/u.test(code) && /ASSET/u.test(code)) return 'asset_retrieval';
  if (/BUDGET|COST|QUOTA/u.test(code)) return 'budget';
  if (/STORYBOARD|SCRIPT|ADOPTED|FACT|PLAN|SCHEMA|SOURCE/u.test(code)) return 'story_contract';
  if (/VIDEO|MEDIA|FFMPEG|EXTERNAL|SEEDANCE|COMPOSE|DELIVERY|RECONCIL/u.test(code)) return 'media_runtime';
  if (/ASSET|IMAGE/u.test(code)) return 'asset_metadata';
  return 'other';
}

/** No run id, timestamps, attempt count or free-form message enters this signature. */
export function failureSignature(issue: ProductionIssue): string {
  const family = classifyIssue(issue);
  return canonicalDigest({ family, code: issue.code, stage: issue.stage, scopeKind: issue.scope.kind });
}

export function buildAssetRunEvidence(run: StoredProductionRun, createdAt: string): AssetRunEvidence {
  if (!isTerminalEvidenceRun(run)) throw new Error('Evidence requires a terminal production run.');
  const openIssues = run.issues.filter(issue => issue.status === 'open').map(issue => ({
    issue: structuredClone(issue), failureSignature: failureSignature(issue), family: classifyIssue(issue),
  }));
  const rules = new Set<string>(run.qualityChecks.map(check => check.ruleVersion));
  const models = new Set<string>(run.attempts.map(attempt => `executor:${attempt.executor}`));
  for (const artifact of run.artifacts) {
    for (const key of ['schemaVersion', 'ruleVersion', 'promptVersion']) {
      const value = artifact.metadata[key];
      if (typeof value === 'string' && value) rules.add(value);
    }
    for (const key of ['model', 'modelConnectionRevision', 'providerSource']) {
      const value = artifact.metadata[key];
      if (typeof value === 'string' && value) models.add(`${key}:${value}`);
    }
  }
  const start = Date.parse(run.createdAt); const end = Date.parse(run.updatedAt);
  return {
    schemaVersion: ASSET_EVIDENCE_SCHEMA_VERSION,
    id: `evidence_${canonicalDigest({ runId: run.id }).slice(0, 32)}`,
    runId: run.id,
    terminalStatus: run.status,
    runDigest: canonicalDigest(run),
    createdAt,
    input: Object.fromEntries(CREATE_KEYS.map(key => [key, run[key]])),
    assetRetrievalPolicy: structuredClone(run.assetRetrievalPolicy ?? DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY),
    tasks: structuredClone(run.tasks),
    attempts: structuredClone(run.attempts),
    openIssues,
    qualityChecks: structuredClone(run.qualityChecks),
    artifacts: run.artifacts.map(artifact => ({ id: artifact.id, taskId: artifact.taskId, kind: artifact.kind,
      uri: artifact.uri, sha256: artifact.sha256, status: artifact.status, createdAt: artifact.createdAt })),
    ruleVersions: [...rules].sort(),
    modelRevisions: [...models].sort(),
    actualCostMicros: run.budgetLedger.filter(entry => entry.kind === 'charge')
      .reduce((sum, entry) => sum + entry.amountMicros, 0),
    currency: run.currency,
    durationMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null,
  };
}

export function buildDeterministicProposals(evidence: AssetRunEvidence, workspaceId?: string): AssetImprovementProposal[] {
  return evidence.openIssues.map(({ issue, failureSignature: signature }) => {
    const family = classifyIssue(issue);
    const scope = `${issue.stage}:${issue.scope.kind}`;
    // Signatures remain comparable, but persistent IDs must not collide across
    // tenants with identical failures. Omitted workspace preserves legacy IDs.
    const key = canonicalDigest({ family, failureSignature: signature, scope, ...(workspaceId ? { workspaceId } : {}) });
    const common = {
      schemaVersion: ASSET_PROPOSAL_RULE_VERSION,
      id: `eproposal_${key.slice(0, 32)}`, key, family, failureSignature: signature, scope,
      evidenceIds: [evidence.id] as string[], sourceRunIds: [evidence.runId] as string[],
      createdAt: evidence.createdAt, updatedAt: evidence.createdAt,
    } as const;
    if (family === 'asset_retrieval') return {
      ...common, kind: 'asset_retrieval_policy', title: '收紧资产歧义阻断策略',
      summary: '从当前基线派生候选，将歧义 margin 提高到 0.12；先离线回放，不会自动改资产或生效。',
      suggestedPolicyPatch: { ambiguityMargin: 0.12 }, candidateEnabled: true,
    };
    if (family === 'asset_metadata') return {
      ...common, kind: 'asset_metadata', title: '补齐或消歧资产元数据',
      summary: '需要显式修改资产名称、别名或描述并重建向量投影；本期不自动写资产目录。',
      suggestedPolicyPatch: null, candidateEnabled: false,
    };
    if (family === 'media_runtime') return {
      ...common, kind: 'media_runtime', title: '检查媒体与运行时失败',
      summary: '归入媒体连接、外部任务或本地运行时，不把它记成创作质量提升。',
      suggestedPolicyPatch: null, candidateEnabled: false,
    };
    if (family === 'budget') return {
      ...common, kind: 'budget_operations', title: '处理预算与运营挡停',
      summary: '预算挡停单独归因，不进入创作质量通过率，也不生成检索候选。',
      suggestedPolicyPatch: null, candidateEnabled: false,
    };
    if (family === 'story_contract') return {
      ...common, kind: 'story_contract', title: '修复剧本事实或结构契约',
      summary: '先修复事实、版本和 schema；不会用检索策略绕过上游校验。',
      suggestedPolicyPatch: null, candidateEnabled: false,
    };
    return {
      ...common, kind: 'manual_review', title: '人工复核未分类问题',
      summary: '当前确定性规则没有足够依据自动提出策略变更。',
      suggestedPolicyPatch: null, candidateEnabled: false,
    };
  });
}
