import {
  EvaluationError, datasetContentDigest, datasetRevisionDigest, evaluationCaseDigest, evaluationCaseInputDigest,
  evaluationRubricContentDigest, rubricRevisionDigest,
  type EvaluationCase, type EvaluationDataset, type EvaluationDatasetBundle,
  type EvaluationDatasetRevision, type EvaluationDatasetRevisionDraft, type EvaluationLifecycleEvent,
  type EvaluationRubric, type EvaluationRubricBundle, type EvaluationRevisionUsage, type EvaluationRubricRevision,
  type EvaluationRubricRevisionDraft, type EvaluationTargetKind, type RubricDimension,
} from '@lyra/shared';

const clone = <T>(value: T): T => structuredClone(value);

function conflict(code: string, message: string): never {
  throw new EvaluationError(409, code, message);
}
function notFound(code: string, message: string): never {
  throw new EvaluationError(404, code, message);
}
function immutable(): never {
  conflict('EVALUATION_REVISION_IMMUTABLE', '冻结或废弃的 revision 不允许修改内容；请派生新 revision。');
}
function referenced(): never {
  conflict('EVALUATION_REVISION_REFERENCED', '该 revision 已被评测引用，内容只读；请派生新 revision。');
}
function stale(): never {
  conflict('EVALUATION_REVISION_STALE', 'expectedDigest 与当前 revision 不一致，请刷新后重试。');
}

export interface EvaluationRepository {
  listDatasets(): Promise<EvaluationDataset[]>;
  getDataset(datasetId: string): Promise<EvaluationDataset | null>;
  createDataset(dataset: EvaluationDataset, draft: EvaluationDatasetRevisionDraft,
    event: EvaluationLifecycleEvent): Promise<EvaluationDatasetBundle>;
  listDatasetRevisions(datasetId: string): Promise<EvaluationDatasetRevision[]>;
  latestDatasetRevision(datasetId: string): Promise<EvaluationDatasetRevision | null>;
  getDatasetRevision(datasetId: string, revisionId: string): Promise<EvaluationDatasetBundle | null>;
  appendDatasetRevision(datasetId: string, draft: EvaluationDatasetRevisionDraft,
    event: EvaluationLifecycleEvent, expectedLatestDigest?: string | null): Promise<EvaluationDatasetBundle>;
  appendDatasetCases(datasetId: string, revisionId: string, cases: EvaluationCase[], expectedDigest: string,
    at: string): Promise<EvaluationDatasetBundle>;
  freezeDatasetRevision(datasetId: string, revisionId: string, expectedDigest: string, at: string,
    event: EvaluationLifecycleEvent): Promise<EvaluationDatasetBundle>;
  deprecateDatasetRevision(datasetId: string, revisionId: string, expectedDigest: string, at: string,
    event: EvaluationLifecycleEvent): Promise<EvaluationDatasetRevision>;

  listRubrics(): Promise<EvaluationRubric[]>;
  getRubric(rubricId: string): Promise<EvaluationRubric | null>;
  createRubric(rubric: EvaluationRubric, draft: EvaluationRubricRevisionDraft,
    event: EvaluationLifecycleEvent): Promise<EvaluationRubricBundle>;
  listRubricRevisions(rubricId: string): Promise<EvaluationRubricRevision[]>;
  latestRubricRevision(rubricId: string): Promise<EvaluationRubricRevision | null>;
  getRubricRevision(rubricId: string, revisionId: string): Promise<EvaluationRubricBundle | null>;
  appendRubricRevision(rubricId: string, draft: EvaluationRubricRevisionDraft,
    event: EvaluationLifecycleEvent, expectedLatestDigest?: string | null): Promise<EvaluationRubricBundle>;
  appendRubricDimensions(rubricId: string, revisionId: string, dimensions: RubricDimension[],
    expectedDigest: string, at: string): Promise<EvaluationRubricBundle>;
  freezeRubricRevision(rubricId: string, revisionId: string, expectedDigest: string, at: string,
    event: EvaluationLifecycleEvent): Promise<EvaluationRubricBundle>;
  deprecateRubricRevision(rubricId: string, revisionId: string, expectedDigest: string, at: string,
    event: EvaluationLifecycleEvent): Promise<EvaluationRubricRevision>;

  recordUsage(usage: EvaluationRevisionUsage): Promise<EvaluationRevisionUsage>;
  listUsages(targetKind: EvaluationTargetKind, revisionId: string): Promise<EvaluationRevisionUsage[]>;
  listLifecycleEvents(targetKind: EvaluationTargetKind, revisionId: string): Promise<EvaluationLifecycleEvent[]>;
}

function assertCaseSet(existing: readonly EvaluationCase[], incoming: readonly EvaluationCase[]): void {
  const byId = new Map(existing.map(item => [item.caseId, item]));
  const incomingIds = new Set<string>();
  for (const item of incoming) {
    if (incomingIds.has(item.caseId)) conflict('EVALUATION_DUPLICATE_CASE_ID', `样例 ID ${item.caseId} 在本次追加中重复。`);
    incomingIds.add(item.caseId);
  }
}

/** 同一 revision 内：caseId 唯一、输入摘要唯一；输入相同但期望不同是冲突而不是覆盖。 */
function assertCaseContentUnique(cases: readonly EvaluationCase[]): void {
  const ids = new Set<string>();
  const inputs = new Map<string, EvaluationCase>();
  for (const item of cases) {
    if (ids.has(item.caseId)) conflict('EVALUATION_DUPLICATE_CASE_ID', `样例 ID ${item.caseId} 重复。`);
    ids.add(item.caseId);
    const inputDigest = evaluationCaseInputDigest(item);
    const previous = inputs.get(inputDigest);
    if (previous) {
      if (evaluationCaseDigest(previous) === evaluationCaseDigest(item)) {
        conflict('EVALUATION_DUPLICATE_CONTENT', `样例 ${item.caseId} 与 ${previous.caseId} 内容完全重复。`);
      }
      conflict('EVALUATION_CASE_CONFLICT', `样例 ${item.caseId} 与 ${previous.caseId} 输入相同但期望不同。`);
    }
    inputs.set(inputDigest, item);
  }
}

/** 内存实现与 PostgreSQL 保持同一套生命周期规则，便于离线测试。 */
export class MemoryEvaluationRepository implements EvaluationRepository {
  private readonly datasets = new Map<string, EvaluationDataset>();
  private readonly datasetRevisions = new Map<string, EvaluationDatasetRevision>();
  private readonly datasetCases = new Map<string, EvaluationCase[]>();
  private readonly rubrics = new Map<string, EvaluationRubric>();
  private readonly rubricRevisions = new Map<string, EvaluationRubricRevision>();
  private readonly rubricDimensions = new Map<string, RubricDimension[]>();
  private readonly usages: EvaluationRevisionUsage[] = [];
  private readonly events: EvaluationLifecycleEvent[] = [];

  private revisionsOf(datasetId: string): EvaluationDatasetRevision[] {
    return [...this.datasetRevisions.values()].filter(item => item.datasetId === datasetId)
      .sort((a, b) => a.revision - b.revision);
  }
  private rubricRevisionsOf(rubricId: string): EvaluationRubricRevision[] {
    return [...this.rubricRevisions.values()].filter(item => item.rubricId === rubricId)
      .sort((a, b) => a.revision - b.revision);
  }
  private hasUsage(targetKind: EvaluationTargetKind, revisionId: string): boolean {
    return this.usages.some(item => item.targetKind === targetKind && item.revisionId === revisionId);
  }
  private datasetBundle(revision: EvaluationDatasetRevision): EvaluationDatasetBundle {
    return { revision: clone(revision), cases: clone(this.datasetCases.get(revision.id) ?? []) };
  }
  private rubricBundle(revision: EvaluationRubricRevision): EvaluationRubricBundle {
    return { revision: clone(revision), dimensions: clone(this.rubricDimensions.get(revision.id) ?? []) };
  }

  private requireDataset(datasetId: string): EvaluationDataset {
    const dataset = this.datasets.get(datasetId);
    if (!dataset) return notFound('EVALUATION_DATASET_NOT_FOUND', '数据集不存在。');
    return dataset;
  }
  private requireDatasetRevision(datasetId: string, revisionId: string): EvaluationDatasetRevision {
    this.requireDataset(datasetId);
    const revision = this.datasetRevisions.get(revisionId);
    if (!revision || revision.datasetId !== datasetId) return notFound('EVALUATION_REVISION_NOT_FOUND', '数据集 revision 不存在。');
    return revision;
  }
  private requireRubric(rubricId: string): EvaluationRubric {
    const rubric = this.rubrics.get(rubricId);
    if (!rubric) return notFound('EVALUATION_RUBRIC_NOT_FOUND', '量表不存在。');
    return rubric;
  }
  private requireRubricRevision(rubricId: string, revisionId: string): EvaluationRubricRevision {
    this.requireRubric(rubricId);
    const revision = this.rubricRevisions.get(revisionId);
    if (!revision || revision.rubricId !== rubricId) return notFound('EVALUATION_REVISION_NOT_FOUND', '量表 revision 不存在。');
    return revision;
  }

  async listDatasets(): Promise<EvaluationDataset[]> {
    return [...this.datasets.values()].map(clone).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getDataset(datasetId: string): Promise<EvaluationDataset | null> {
    const dataset = this.datasets.get(datasetId);
    return dataset ? clone(dataset) : null;
  }

  async createDataset(dataset: EvaluationDataset, draft: EvaluationDatasetRevisionDraft,
    event: EvaluationLifecycleEvent): Promise<EvaluationDatasetBundle> {
    if (this.datasets.has(dataset.id)) conflict('EVALUATION_DATASET_EXISTS', '数据集 ID 已存在。');
    if (draft.datasetId !== dataset.id || draft.kind !== dataset.kind) conflict('EVALUATION_KIND_MISMATCH', '数据集与 revision 类型不一致。');
    assertCaseContentUnique(draft.cases);
    const digest = datasetRevisionDigest(draft, 1);
    const revision: EvaluationDatasetRevision = {
      id: draft.id, datasetId: dataset.id, kind: draft.kind, revision: 1, status: 'draft',
      note: draft.note, contentSummary: draft.contentSummary, slices: [...draft.slices].sort(), tags: [...draft.tags].sort(),
      authorization: clone(draft.authorization), sensitivity: draft.sensitivity, provenance: clone(draft.provenance),
      digest, contentDigest: datasetContentDigest(draft.kind, draft.cases), caseCount: draft.cases.length,
      createdAt: event.createdAt, frozenAt: null, deprecatedAt: null,
    };
    this.datasets.set(dataset.id, clone(dataset));
    this.datasetRevisions.set(revision.id, clone(revision));
    this.datasetCases.set(revision.id, clone(draft.cases));
    this.events.push(clone(event));
    return this.datasetBundle(revision);
  }

  async listDatasetRevisions(datasetId: string): Promise<EvaluationDatasetRevision[]> {
    this.requireDataset(datasetId);
    return this.revisionsOf(datasetId).map(clone);
  }
  async latestDatasetRevision(datasetId: string): Promise<EvaluationDatasetRevision | null> {
    const latest = this.revisionsOf(datasetId).at(-1);
    return latest ? clone(latest) : null;
  }
  async getDatasetRevision(datasetId: string, revisionId: string): Promise<EvaluationDatasetBundle | null> {
    this.requireDataset(datasetId);
    const revision = this.datasetRevisions.get(revisionId);
    if (!revision || revision.datasetId !== datasetId) return null;
    return this.datasetBundle(revision);
  }

  async appendDatasetRevision(datasetId: string, draft: EvaluationDatasetRevisionDraft,
    event: EvaluationLifecycleEvent, expectedLatestDigest: string | null = null): Promise<EvaluationDatasetBundle> {
    const dataset = this.requireDataset(datasetId);
    if (expectedLatestDigest !== null && (this.revisionsOf(datasetId).at(-1)?.digest ?? null) !== expectedLatestDigest) {
      stale();
    }
    if (draft.datasetId !== datasetId || draft.kind !== dataset.kind) conflict('EVALUATION_KIND_MISMATCH', 'revision 类型与数据集不一致。');
    assertCaseSet([], draft.cases);
    assertCaseContentUnique(draft.cases);
    const revisionNumber = (this.revisionsOf(datasetId).at(-1)?.revision ?? 0) + 1;
    const digest = datasetRevisionDigest(draft, revisionNumber);
    const revision: EvaluationDatasetRevision = {
      id: draft.id, datasetId, kind: draft.kind, revision: revisionNumber, status: 'draft',
      note: draft.note, contentSummary: draft.contentSummary, slices: [...draft.slices].sort(), tags: [...draft.tags].sort(),
      authorization: clone(draft.authorization), sensitivity: draft.sensitivity, provenance: clone(draft.provenance),
      digest, contentDigest: datasetContentDigest(draft.kind, draft.cases), caseCount: draft.cases.length,
      createdAt: event.createdAt, frozenAt: null, deprecatedAt: null,
    };
    this.datasetRevisions.set(revision.id, clone(revision));
    this.datasetCases.set(revision.id, clone(draft.cases));
    this.events.push(clone(event));
    dataset.updatedAt = event.createdAt;
    return this.datasetBundle(revision);
  }

  async appendDatasetCases(datasetId: string, revisionId: string, cases: EvaluationCase[], expectedDigest: string,
    at: string): Promise<EvaluationDatasetBundle> {
    const revision = this.requireDatasetRevision(datasetId, revisionId);
    if (this.hasUsage('dataset', revisionId)) referenced();
    if (revision.status !== 'draft') immutable();
    if (revision.digest !== expectedDigest) stale();
    const existing = this.datasetCases.get(revisionId) ?? [];
    assertCaseSet(existing, cases);
    const incomingInputs = new Map<string, EvaluationCase>();
    for (const item of cases) {
      const inputDigest = evaluationCaseInputDigest(item);
      const duplicateInput = incomingInputs.get(inputDigest)
        ?? existing.find(candidate => evaluationCaseInputDigest(candidate) === inputDigest);
      if (duplicateInput) {
        if (evaluationCaseDigest(duplicateInput) === evaluationCaseDigest(item)) {
          conflict('EVALUATION_DUPLICATE_CONTENT', `样例 ${item.caseId} 与已有样例内容完全重复。`);
        }
        conflict('EVALUATION_CASE_CONFLICT', `样例 ${item.caseId} 与已有样例输入相同但期望不同。`);
      }
      incomingInputs.set(inputDigest, item);
      if (existing.some(candidate => candidate.caseId === item.caseId)) {
        conflict('EVALUATION_DUPLICATE_CASE_ID', `样例 ID ${item.caseId} 已存在。`);
      }
    }
    const nextCases = [...existing, ...cases];
    const nextDigest = datasetRevisionDigest({
      id: revision.id, datasetId: revision.datasetId, kind: revision.kind, note: revision.note,
      contentSummary: revision.contentSummary, slices: revision.slices, tags: revision.tags,
      authorization: revision.authorization, sensitivity: revision.sensitivity, provenance: revision.provenance,
      cases: nextCases,
    }, revision.revision);
    const updated: EvaluationDatasetRevision = {
      ...revision, digest: nextDigest, contentDigest: datasetContentDigest(revision.kind, nextCases),
      caseCount: nextCases.length,
    };
    this.datasetCases.set(revision.id, clone(nextCases));
    this.datasetRevisions.set(revision.id, clone(updated));
    const dataset = this.requireDataset(datasetId);
    dataset.updatedAt = at;
    return this.datasetBundle(updated);
  }

  async freezeDatasetRevision(datasetId: string, revisionId: string, expectedDigest: string, at: string,
    event: EvaluationLifecycleEvent): Promise<EvaluationDatasetBundle> {
    const revision = this.requireDatasetRevision(datasetId, revisionId);
    if (this.hasUsage('dataset', revisionId)) referenced();
    if (revision.status !== 'draft') immutable();
    if (revision.digest !== expectedDigest) stale();
    if ((this.datasetCases.get(revisionId) ?? []).length === 0) {
      conflict('EVALUATION_REVISION_EMPTY', '空数据集 revision 不能冻结。');
    }
    const updated: EvaluationDatasetRevision = { ...revision, status: 'frozen', frozenAt: at };
    this.datasetRevisions.set(revision.id, clone(updated));
    this.events.push(clone(event));
    this.requireDataset(datasetId).updatedAt = at;
    return this.datasetBundle(updated);
  }

  async deprecateDatasetRevision(datasetId: string, revisionId: string, expectedDigest: string, at: string,
    event: EvaluationLifecycleEvent): Promise<EvaluationDatasetRevision> {
    const revision = this.requireDatasetRevision(datasetId, revisionId);
    if (revision.status === 'deprecated') conflict('EVALUATION_REVISION_DEPRECATED', 'revision 已废弃。');
    if (revision.digest !== expectedDigest) stale();
    const updated: EvaluationDatasetRevision = { ...revision, status: 'deprecated', deprecatedAt: at };
    this.datasetRevisions.set(revision.id, clone(updated));
    this.events.push(clone(event));
    this.requireDataset(datasetId).updatedAt = at;
    return clone(updated);
  }

  async listRubrics(): Promise<EvaluationRubric[]> {
    return [...this.rubrics.values()].map(clone).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getRubric(rubricId: string): Promise<EvaluationRubric | null> {
    const rubric = this.rubrics.get(rubricId);
    return rubric ? clone(rubric) : null;
  }

  async createRubric(rubric: EvaluationRubric, draft: EvaluationRubricRevisionDraft,
    event: EvaluationLifecycleEvent): Promise<EvaluationRubricBundle> {
    if (this.rubrics.has(rubric.id)) conflict('EVALUATION_RUBRIC_EXISTS', '量表 ID 已存在。');
    if (draft.rubricId !== rubric.id || draft.kind !== rubric.kind) conflict('EVALUATION_KIND_MISMATCH', '量表与 revision 类型不一致。');
    const revision: EvaluationRubricRevision = {
      id: draft.id, rubricId: rubric.id, kind: draft.kind, revision: 1, status: 'draft',
      note: draft.note, summary: draft.summary, missingResultPolicy: clone(draft.missingResultPolicy),
      digest: rubricRevisionDigest(draft, 1), contentDigest: evaluationRubricContentDigest(draft.kind,
        draft.missingResultPolicy, draft.dimensions), dimensionCount: draft.dimensions.length,
      createdAt: event.createdAt, frozenAt: null, deprecatedAt: null,
    };
    this.rubrics.set(rubric.id, clone(rubric));
    this.rubricRevisions.set(revision.id, clone(revision));
    this.rubricDimensions.set(revision.id, clone(draft.dimensions));
    this.events.push(clone(event));
    return this.rubricBundle(revision);
  }

  async listRubricRevisions(rubricId: string): Promise<EvaluationRubricRevision[]> {
    this.requireRubric(rubricId);
    return this.rubricRevisionsOf(rubricId).map(clone);
  }
  async latestRubricRevision(rubricId: string): Promise<EvaluationRubricRevision | null> {
    const latest = this.rubricRevisionsOf(rubricId).at(-1);
    return latest ? clone(latest) : null;
  }
  async getRubricRevision(rubricId: string, revisionId: string): Promise<EvaluationRubricBundle | null> {
    this.requireRubric(rubricId);
    const revision = this.rubricRevisions.get(revisionId);
    if (!revision || revision.rubricId !== rubricId) return null;
    return this.rubricBundle(revision);
  }

  async appendRubricRevision(rubricId: string, draft: EvaluationRubricRevisionDraft,
    event: EvaluationLifecycleEvent, expectedLatestDigest: string | null = null): Promise<EvaluationRubricBundle> {
    const rubric = this.requireRubric(rubricId);
    if (expectedLatestDigest !== null && (this.rubricRevisionsOf(rubricId).at(-1)?.digest ?? null) !== expectedLatestDigest) {
      stale();
    }
    if (draft.rubricId !== rubricId || draft.kind !== rubric.kind) conflict('EVALUATION_KIND_MISMATCH', 'revision 类型与量表不一致。');
    const revisionNumber = (this.rubricRevisionsOf(rubricId).at(-1)?.revision ?? 0) + 1;
    const revision: EvaluationRubricRevision = {
      id: draft.id, rubricId, kind: draft.kind, revision: revisionNumber, status: 'draft',
      note: draft.note, summary: draft.summary, missingResultPolicy: clone(draft.missingResultPolicy),
      digest: rubricRevisionDigest(draft, revisionNumber),
      contentDigest: evaluationRubricContentDigest(draft.kind, draft.missingResultPolicy, draft.dimensions),
      dimensionCount: draft.dimensions.length,
      createdAt: event.createdAt, frozenAt: null, deprecatedAt: null,
    };
    this.rubricRevisions.set(revision.id, clone(revision));
    this.rubricDimensions.set(revision.id, clone(draft.dimensions));
    this.events.push(clone(event));
    rubric.updatedAt = event.createdAt;
    return this.rubricBundle(revision);
  }

  async appendRubricDimensions(rubricId: string, revisionId: string, dimensions: RubricDimension[],
    expectedDigest: string, at: string): Promise<EvaluationRubricBundle> {
    const revision = this.requireRubricRevision(rubricId, revisionId);
    if (this.hasUsage('rubric', revisionId)) referenced();
    if (revision.status !== 'draft') immutable();
    if (revision.digest !== expectedDigest) stale();
    const existing = this.rubricDimensions.get(revisionId) ?? [];
    const keys = new Set(existing.map(item => item.key));
    for (const dimension of dimensions) {
      if (keys.has(dimension.key)) conflict('EVALUATION_DUPLICATE_DIMENSION', `维度 ${dimension.key} 已存在。`);
      keys.add(dimension.key);
    }
    if (existing.length + dimensions.length > 8) conflict('EVALUATION_DIMENSION_LIMIT', '单个量表最多 8 个维度。');
    if (revision.kind === 'shot_review' && existing.length + dimensions.length !== 4) {
      conflict('EVALUATION_SHOT_RUBRIC_DIMENSIONS', '镜头审核量表必须恰好四个维度。');
    }
    const nextDimensions = [...existing, ...dimensions].sort((a, b) => a.key.localeCompare(b.key));
    const nextDigest = rubricRevisionDigest({
      id: revision.id, rubricId: revision.rubricId, kind: revision.kind, note: revision.note, summary: revision.summary,
      missingResultPolicy: revision.missingResultPolicy, dimensions: nextDimensions,
    }, revision.revision);
    const updated: EvaluationRubricRevision = {
      ...revision, digest: nextDigest,
      contentDigest: evaluationRubricContentDigest(revision.kind, revision.missingResultPolicy, nextDimensions),
      dimensionCount: nextDimensions.length,
    };
    this.rubricDimensions.set(revision.id, clone(nextDimensions));
    this.rubricRevisions.set(revision.id, clone(updated));
    this.requireRubric(rubricId).updatedAt = at;
    return this.rubricBundle(updated);
  }

  async freezeRubricRevision(rubricId: string, revisionId: string, expectedDigest: string, at: string,
    event: EvaluationLifecycleEvent): Promise<EvaluationRubricBundle> {
    const revision = this.requireRubricRevision(rubricId, revisionId);
    if (this.hasUsage('rubric', revisionId)) referenced();
    if (revision.status !== 'draft') immutable();
    if (revision.digest !== expectedDigest) stale();
    const dimensions = this.rubricDimensions.get(revisionId) ?? [];
    if (dimensions.length === 0) conflict('EVALUATION_REVISION_EMPTY', '空量表 revision 不能冻结。');
    const updated: EvaluationRubricRevision = { ...revision, status: 'frozen', frozenAt: at };
    this.rubricRevisions.set(revision.id, clone(updated));
    this.events.push(clone(event));
    this.requireRubric(rubricId).updatedAt = at;
    return this.rubricBundle(updated);
  }

  async deprecateRubricRevision(rubricId: string, revisionId: string, expectedDigest: string, at: string,
    event: EvaluationLifecycleEvent): Promise<EvaluationRubricRevision> {
    const revision = this.requireRubricRevision(rubricId, revisionId);
    if (revision.status === 'deprecated') conflict('EVALUATION_REVISION_DEPRECATED', 'revision 已废弃。');
    if (revision.digest !== expectedDigest) stale();
    const updated: EvaluationRubricRevision = { ...revision, status: 'deprecated', deprecatedAt: at };
    this.rubricRevisions.set(revision.id, clone(updated));
    this.events.push(clone(event));
    this.requireRubric(rubricId).updatedAt = at;
    return clone(updated);
  }

  async recordUsage(usage: EvaluationRevisionUsage): Promise<EvaluationRevisionUsage> {
    const target = usage.targetKind === 'dataset'
      ? this.datasetRevisions.get(usage.revisionId) : this.rubricRevisions.get(usage.revisionId);
    if (!target) return notFound('EVALUATION_REVISION_NOT_FOUND', '被引用的 revision 不存在。');
    if (target.status !== 'frozen') {
      conflict('EVALUATION_REVISION_NOT_BINDABLE', '新评测只能绑定已冻结、未废弃的 revision。');
    }
    const existing = this.usages.find(item => item.targetKind === usage.targetKind
      && item.revisionId === usage.revisionId && item.usageKind === usage.usageKind && item.usageRef === usage.usageRef);
    if (existing) return clone(existing);
    this.usages.push(clone(usage));
    return clone(usage);
  }

  async listUsages(targetKind: EvaluationTargetKind, revisionId: string): Promise<EvaluationRevisionUsage[]> {
    return this.usages.filter(item => item.targetKind === targetKind && item.revisionId === revisionId)
      .map(clone).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listLifecycleEvents(targetKind: EvaluationTargetKind, revisionId: string): Promise<EvaluationLifecycleEvent[]> {
    return this.events.filter(item => item.targetKind === targetKind && item.revisionId === revisionId)
      .map(clone).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
