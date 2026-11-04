import {
  EvaluationError, datasetContentDigest, datasetRevisionDigest, evaluationCaseDigest, evaluationId,
  evaluationRubricContentDigest, normalizeEvaluationText, parseCreateEvaluationDataset, parseCreateEvaluationRubric,
  parseEvaluationCaseList, parseEvaluationDatasetId, parseEvaluationDatasetRevisionId, parseEvaluationRubricRevisionId,
  parseEvaluationRubricId, parseExpectedDigestBody, parseRubricDimensionList, rubricRevisionDigest,
  type EvaluationCase, type EvaluationDataset, type EvaluationDatasetBundle, type EvaluationDatasetRevision,
  type EvaluationDatasetRevisionDraft, type EvaluationFieldIssue, type EvaluationLifecycleEvent,
  type EvaluationRevisionUsage, type EvaluationRubric, type EvaluationRubricBundle, type EvaluationRubricRevision,
  type EvaluationRubricRevisionDraft, type EvaluationTargetKind, type RubricDimension,
} from '@lyra/shared';
import type { EvaluationRepository } from './repository';
import { parseDatasetJsonl, parseRubricJsonl, serializeDatasetBundle, serializeRubricBundle } from './jsonl';

export interface EvaluationServiceOptions { now?: () => Date; }

function badRequest(code: string, message: string): never {
  throw new EvaluationError(400, code, message, [{ path: 'body', code, message }]);
}
function conflict(code: string, message: string): never {
  throw new EvaluationError(409, code, message, [{ path: 'body', code, message }]);
}
function notFound(message: string): never {
  throw new EvaluationError(404, 'EVALUATION_NOT_FOUND', message, [{ path: 'body', code: 'EVALUATION_NOT_FOUND', message }]);
}

/** 评测目录只做题库、量表与版本治理；不创建运行、不评分、不接外部框架。 */
export class EvaluationService {
  private readonly now: () => Date;
  constructor(private readonly repository: EvaluationRepository, options: EvaluationServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  private timestamp(): string { return this.now().toISOString(); }

  private event(targetKind: EvaluationTargetKind, revisionId: string,
    action: EvaluationLifecycleEvent['action'], actor: EvaluationLifecycleEvent['actor'], reason = '',
  ): EvaluationLifecycleEvent {
    return { id: evaluationId('evallevent'), targetKind, revisionId, action, actor,
      reason: normalizeEvaluationText(reason), createdAt: this.timestamp() };
  }

  async listDatasets() {
    return { items: await this.repository.listDatasets() };
  }

  async getDataset(datasetId: string) {
    const dataset = await this.repository.getDataset(parseEvaluationDatasetId(datasetId));
    if (!dataset) return notFound('数据集不存在。');
    return { dataset, revisions: await this.repository.listDatasetRevisions(dataset.id) };
  }

  async createDataset(body: unknown) {
    const input = parseCreateEvaluationDataset(body);
    const at = this.timestamp();
    const dataset: EvaluationDataset = {
      id: evaluationId('evalds'), kind: input.kind, title: input.title, description: input.description,
      createdAt: at, updatedAt: at,
    };
    const draft: EvaluationDatasetRevisionDraft = {
      id: evaluationId('evaldsrev'), datasetId: dataset.id, kind: input.kind, note: input.note,
      contentSummary: input.contentSummary, slices: input.slices, tags: input.tags,
      authorization: input.authorization, sensitivity: input.sensitivity, provenance: input.provenance,
      cases: input.cases,
    };
    await this.assertShotRubricRefs(draft.cases);
    return this.repository.createDataset(dataset, draft, this.event('dataset', draft.id, 'created', 'user'));
  }

  async getDatasetRevision(datasetId: string, revisionId: string): Promise<EvaluationDatasetBundle> {
    const bundle = await this.repository.getDatasetRevision(parseEvaluationDatasetId(datasetId),
      parseEvaluationDatasetRevisionId(revisionId));
    if (!bundle) return notFound('数据集 revision 不存在。');
    return bundle;
  }

  async appendDatasetCases(datasetId: string, revisionId: string, body: unknown) {
    const bundle = await this.getDatasetRevision(datasetId, revisionId);
    const input = this.expectedBody(body, ['cases']);
    if (!('cases' in (body as Record<string, unknown>))) {
      throw new EvaluationError(400, 'EVALUATION_INPUT_INVALID', '必须提供 cases。',
        [{ path: 'body.cases', code: 'EVALUATION_INPUT_INVALID', message: '缺失字段 cases。' }]);
    }
    const cases = parseEvaluationCaseList((body as Record<string, unknown>).cases, 'cases', bundle.revision.kind);
    await this.assertShotRubricRefs(cases);
    return this.repository.appendDatasetCases(bundle.revision.datasetId, bundle.revision.id, cases,
      input.expectedDigest, this.timestamp());
  }

  async deriveDatasetRevision(datasetId: string, baseRevisionId: string, body: unknown) {
    const base = await this.getDatasetRevision(datasetId, baseRevisionId);
    if (base.revision.status !== 'frozen') {
      conflict('EVALUATION_DERIVE_REQUIRES_FROZEN', '只有已冻结的 revision 可以派生新草稿。');
    }
    const input = parseExpectedDigestBody(body);
    if (base.revision.digest !== input.expectedDigest) {
      conflict('EVALUATION_REVISION_STALE', 'expectedDigest 与基线 revision 不一致。');
    }
    const draft: EvaluationDatasetRevisionDraft = {
      id: evaluationId('evaldsrev'), datasetId: base.revision.datasetId, kind: base.revision.kind,
      note: input.reason || `派生自 ${base.revision.id}`,
      contentSummary: base.revision.contentSummary, slices: [...base.revision.slices], tags: [...base.revision.tags],
      authorization: base.revision.authorization, sensitivity: base.revision.sensitivity,
      provenance: base.revision.provenance, cases: base.cases,
    };
    return this.repository.appendDatasetRevision(base.revision.datasetId, draft,
      this.event('dataset', draft.id, 'derived', 'user', input.reason));
  }

  async createNextDatasetRevision(datasetId: string, body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as Record<string, unknown>).baseRevisionId !== 'string') {
      badRequest('EVALUATION_INPUT_INVALID', '必须提供 baseRevisionId。');
    }
    const { baseRevisionId, ...rest } = body as Record<string, unknown>;
    return this.deriveDatasetRevision(datasetId, parseEvaluationDatasetRevisionId(baseRevisionId as string), rest);
  }

  async freezeDatasetRevision(datasetId: string, revisionId: string, body: unknown) {
    const bundle = await this.getDatasetRevision(datasetId, revisionId);
    const input = parseExpectedDigestBody(body);
    this.assertDatasetIntegrity(bundle);
    return this.repository.freezeDatasetRevision(bundle.revision.datasetId, bundle.revision.id,
      input.expectedDigest, this.timestamp(), this.event('dataset', bundle.revision.id, 'frozen', 'user', input.reason));
  }

  async deprecateDatasetRevision(datasetId: string, revisionId: string, body: unknown) {
    const bundle = await this.getDatasetRevision(datasetId, revisionId);
    const input = parseExpectedDigestBody(body);
    if (!input.reason) badRequest('EVALUATION_REASON_REQUIRED', '废弃 revision 必须写明原因。');
    return this.repository.deprecateDatasetRevision(bundle.revision.datasetId, bundle.revision.id,
      input.expectedDigest, this.timestamp(),
      this.event('dataset', bundle.revision.id, 'deprecated', 'user', input.reason));
  }

  async listRubrics() {
    return { items: await this.repository.listRubrics() };
  }

  async getRubric(rubricId: string) {
    const rubric = await this.repository.getRubric(parseEvaluationRubricId(rubricId));
    if (!rubric) return notFound('量表不存在。');
    return { rubric, revisions: await this.repository.listRubricRevisions(rubric.id) };
  }

  async createRubric(body: unknown) {
    const input = parseCreateEvaluationRubric(body);
    const at = this.timestamp();
    const rubric: EvaluationRubric = {
      id: evaluationId('evalrub'), kind: input.kind, title: input.title, description: input.description,
      createdAt: at, updatedAt: at,
    };
    const draft: EvaluationRubricRevisionDraft = {
      id: evaluationId('evalrubrev'), rubricId: rubric.id, kind: input.kind, note: input.note,
      summary: input.summary, missingResultPolicy: input.missingResultPolicy, dimensions: input.dimensions,
    };
    return this.repository.createRubric(rubric, draft, this.event('rubric', draft.id, 'created', 'user'));
  }

  async getRubricRevision(rubricId: string, revisionId: string): Promise<EvaluationRubricBundle> {
    const bundle = await this.repository.getRubricRevision(parseEvaluationRubricId(rubricId),
      parseEvaluationRubricRevisionId(revisionId));
    if (!bundle) return notFound('量表 revision 不存在。');
    return bundle;
  }

  async appendRubricDimensions(rubricId: string, revisionId: string, body: unknown) {
    const bundle = await this.getRubricRevision(rubricId, revisionId);
    const input = this.expectedBody(body, ['dimensions']);
    if (!('dimensions' in (body as Record<string, unknown>))) {
      throw new EvaluationError(400, 'EVALUATION_INPUT_INVALID', '必须提供 dimensions。',
        [{ path: 'body.dimensions', code: 'EVALUATION_INPUT_INVALID', message: '缺失字段 dimensions。' }]);
    }
    const dimensions = parseRubricDimensionList((body as Record<string, unknown>).dimensions, 'dimensions',
      bundle.revision.kind);
    return this.repository.appendRubricDimensions(bundle.revision.rubricId, bundle.revision.id, dimensions,
      input.expectedDigest, this.timestamp());
  }

  async deriveRubricRevision(rubricId: string, baseRevisionId: string, body: unknown) {
    const base = await this.getRubricRevision(rubricId, baseRevisionId);
    if (base.revision.status !== 'frozen') {
      conflict('EVALUATION_DERIVE_REQUIRES_FROZEN', '只有已冻结的 revision 可以派生新草稿。');
    }
    const input = parseExpectedDigestBody(body);
    if (base.revision.digest !== input.expectedDigest) {
      conflict('EVALUATION_REVISION_STALE', 'expectedDigest 与基线 revision 不一致。');
    }
    const draft: EvaluationRubricRevisionDraft = {
      id: evaluationId('evalrubrev'), rubricId: base.revision.rubricId, kind: base.revision.kind,
      note: input.reason || `派生自 ${base.revision.id}`, summary: base.revision.summary,
      missingResultPolicy: base.revision.missingResultPolicy, dimensions: base.dimensions,
    };
    return this.repository.appendRubricRevision(base.revision.rubricId, draft,
      this.event('rubric', draft.id, 'derived', 'user', input.reason));
  }

  async createNextRubricRevision(rubricId: string, body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as Record<string, unknown>).baseRevisionId !== 'string') {
      badRequest('EVALUATION_INPUT_INVALID', '必须提供 baseRevisionId。');
    }
    const { baseRevisionId, ...rest } = body as Record<string, unknown>;
    return this.deriveRubricRevision(rubricId, parseEvaluationRubricRevisionId(baseRevisionId as string), rest);
  }

  async freezeRubricRevision(rubricId: string, revisionId: string, body: unknown) {
    const bundle = await this.getRubricRevision(rubricId, revisionId);
    const input = parseExpectedDigestBody(body);
    this.assertRubricIntegrity(bundle);
    return this.repository.freezeRubricRevision(bundle.revision.rubricId, bundle.revision.id,
      input.expectedDigest, this.timestamp(), this.event('rubric', bundle.revision.id, 'frozen', 'user', input.reason));
  }

  async deprecateRubricRevision(rubricId: string, revisionId: string, body: unknown) {
    const bundle = await this.getRubricRevision(rubricId, revisionId);
    const input = parseExpectedDigestBody(body);
    if (!input.reason) badRequest('EVALUATION_REASON_REQUIRED', '废弃 revision 必须写明原因。');
    return this.repository.deprecateRubricRevision(bundle.revision.rubricId, bundle.revision.id,
      input.expectedDigest, this.timestamp(),
      this.event('rubric', bundle.revision.id, 'deprecated', 'user', input.reason));
  }

  async recordUsage(body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      badRequest('EVALUATION_INPUT_INVALID', '引用登记参数不正确。');
    }
    const input = body as Record<string, unknown>;
    const keys = Object.keys(input).sort().join(',');
    if (!['note,revisionId,revisionKind,usageKind,usageRef', 'revisionId,revisionKind,usageKind,usageRef'].includes(keys)) {
      badRequest('EVALUATION_INPUT_INVALID', '引用登记必须且只能包含 revisionKind/revisionId/usageKind/usageRef/note。');
    }
    const revisionKind = input.revisionKind === 'dataset' || input.revisionKind === 'rubric'
      ? input.revisionKind : badRequest('EVALUATION_INPUT_INVALID', 'revisionKind 必须是 dataset 或 rubric。');
    const revisionId = revisionKind === 'dataset'
      ? parseEvaluationDatasetRevisionId(String(input.revisionId ?? ''))
      : parseEvaluationRubricRevisionId(String(input.revisionId ?? ''));
    if (typeof input.usageKind !== 'string' || !/^[a-z][a-z0-9_]{1,31}$/u.test(input.usageKind)) {
      badRequest('EVALUATION_INPUT_INVALID', 'usageKind 格式不正确。');
    }
    if (typeof input.usageRef !== 'string' || !input.usageRef.trim() || input.usageRef.length > 200
      || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(input.usageRef)) {
      badRequest('EVALUATION_INPUT_INVALID', 'usageRef 必须是 1..200 字的可追溯标识。');
    }
    const usage: EvaluationRevisionUsage = {
      id: evaluationId('evalusage'), targetKind: revisionKind, revisionId, usageKind: input.usageKind,
      usageRef: normalizeEvaluationText(input.usageRef), note: typeof input.note === 'string'
        ? normalizeEvaluationText(input.note).slice(0, 500) : '', createdAt: this.timestamp(),
    };
    return this.repository.recordUsage(usage);
  }

  /* ---------------------------------------------------------------------- */
  /* 导出                                                                     */
  /* ---------------------------------------------------------------------- */

  async exportDatasetRevision(datasetId: string, revisionId: string) {
    const bundle = await this.getDatasetRevision(datasetId, revisionId);
    this.assertDatasetIntegrity(bundle);
    const dataset = await this.repository.getDataset(bundle.revision.datasetId);
    if (!dataset) return notFound('数据集不存在。');
    return { ...serializeDatasetBundle(bundle, dataset), contentDigest: bundle.revision.contentDigest,
      digest: bundle.revision.digest, caseCount: bundle.cases.length };
  }

  async exportRubricRevision(rubricId: string, revisionId: string) {
    const bundle = await this.getRubricRevision(rubricId, revisionId);
    this.assertRubricIntegrity(bundle);
    const rubric = await this.repository.getRubric(bundle.revision.rubricId);
    if (!rubric) return notFound('量表不存在。');
    return { ...serializeRubricBundle(bundle, rubric), contentDigest: bundle.revision.contentDigest,
      digest: bundle.revision.digest, dimensionCount: bundle.dimensions.length };
  }

  /* ---------------------------------------------------------------------- */
  /* 导入：先完整校验，再一次性写入；失败不留半份数据。                        */
  /* ---------------------------------------------------------------------- */

  async importDatasetJsonl(body: unknown) {
    const input = importBody(body);
    const document = parseDatasetJsonl(input.jsonl);
    const issues: EvaluationFieldIssue[] = [];
    for (const item of document.cases) {
      try {
        await this.assertShotRubricCase(item, document.caseLines[item.caseId] ?? 1);
      } catch (error) {
        if (error instanceof EvaluationError) issues.push(...error.details);
        else throw error;
      }
    }
    if (issues.length > 0) throw new EvaluationError(400, 'EVALUATION_JSONL_INVALID', 'JSONL 导入校验失败，未写入任何数据。', issues);
    const at = this.timestamp();
    const existing = await this.repository.getDataset(document.manifest.datasetId);
    if (existing) {
      if (existing.kind !== document.manifest.kind) {
        conflict('EVALUATION_KIND_MISMATCH', '导入文件的数据集类型与现有数据集不一致。');
      }
      if (!input.expectedDigest) {
        conflict('EVALUATION_EXPECTED_DIGEST_REQUIRED', '导入到已有数据集必须提供当前最新 revision 的 expectedDigest。');
      }
      const latest = await this.repository.latestDatasetRevision(existing.id);
      if (!latest || latest.digest !== input.expectedDigest) {
        conflict('EVALUATION_REVISION_STALE', 'expectedDigest 与数据集最新 revision 不一致。');
      }
      const draft: EvaluationDatasetRevisionDraft = {
        id: evaluationId('evaldsrev'), datasetId: existing.id, kind: document.manifest.kind,
        note: document.manifest.note, contentSummary: document.manifest.contentSummary,
        slices: document.manifest.slices, tags: document.manifest.tags,
        authorization: document.manifest.authorization, sensitivity: document.manifest.sensitivity,
        provenance: document.manifest.provenance, cases: document.cases,
      };
      return this.repository.appendDatasetRevision(existing.id, draft,
        this.event('dataset', draft.id, 'derived', 'import', 'JSONL 导入'), input.expectedDigest);
    }
    if (input.expectedDigest) {
      conflict('EVALUATION_REVISION_STALE', '新数据集导入不得携带 expectedDigest。');
    }
    const dataset: EvaluationDataset = {
      id: document.manifest.datasetId, kind: document.manifest.kind, title: document.manifest.title,
      description: document.manifest.description, createdAt: at, updatedAt: at,
    };
    const draft: EvaluationDatasetRevisionDraft = {
      id: evaluationId('evaldsrev'), datasetId: dataset.id, kind: dataset.kind,
      note: document.manifest.note, contentSummary: document.manifest.contentSummary,
      slices: document.manifest.slices, tags: document.manifest.tags,
      authorization: document.manifest.authorization, sensitivity: document.manifest.sensitivity,
      provenance: document.manifest.provenance, cases: document.cases,
    };
    return this.repository.createDataset(dataset, draft, this.event('dataset', draft.id, 'created', 'import', 'JSONL 导入'));
  }

  async importRubricJsonl(body: unknown) {
    const input = importBody(body);
    const document = parseRubricJsonl(input.jsonl);
    const at = this.timestamp();
    const existing = await this.repository.getRubric(document.manifest.rubricId);
    if (existing) {
      if (existing.kind !== document.manifest.kind) {
        conflict('EVALUATION_KIND_MISMATCH', '导入文件的量表类型与现有量表不一致。');
      }
      if (!input.expectedDigest) {
        conflict('EVALUATION_EXPECTED_DIGEST_REQUIRED', '导入到已有量表必须提供当前最新 revision 的 expectedDigest。');
      }
      const latest = await this.repository.latestRubricRevision(existing.id);
      if (!latest || latest.digest !== input.expectedDigest) {
        conflict('EVALUATION_REVISION_STALE', 'expectedDigest 与量表最新 revision 不一致。');
      }
      const draft: EvaluationRubricRevisionDraft = {
        id: evaluationId('evalrubrev'), rubricId: existing.id, kind: document.manifest.kind,
        note: document.manifest.note, summary: document.manifest.summary,
        missingResultPolicy: document.manifest.missingResultPolicy, dimensions: document.dimensions,
      };
      return this.repository.appendRubricRevision(existing.id, draft,
        this.event('rubric', draft.id, 'derived', 'import', 'JSONL 导入'), input.expectedDigest);
    }
    if (input.expectedDigest) {
      conflict('EVALUATION_REVISION_STALE', '新量表导入不得携带 expectedDigest。');
    }
    const rubric: EvaluationRubric = {
      id: document.manifest.rubricId, kind: document.manifest.kind, title: document.manifest.title,
      description: document.manifest.description, createdAt: at, updatedAt: at,
    };
    const draft: EvaluationRubricRevisionDraft = {
      id: document.manifest.revisionId ?? evaluationId('evalrubrev'), rubricId: rubric.id, kind: rubric.kind,
      note: document.manifest.note, summary: document.manifest.summary,
      missingResultPolicy: document.manifest.missingResultPolicy, dimensions: document.dimensions,
    };
    return this.repository.createRubric(rubric, draft, this.event('rubric', draft.id, 'created', 'import', 'JSONL 导入'));
  }

  /* ---------------------------------------------------------------------- */
  /* 内部校验                                                                 */
  /* ---------------------------------------------------------------------- */

  private expectedBody(body: unknown, extraKeys: readonly string[]) {
    return parseExpectedDigestBody(body, 'body', extraKeys);
  }

  private assertDatasetIntegrity(bundle: EvaluationDatasetBundle): void {
    const draft: EvaluationDatasetRevisionDraft = {
      id: bundle.revision.id, datasetId: bundle.revision.datasetId, kind: bundle.revision.kind,
      note: bundle.revision.note, contentSummary: bundle.revision.contentSummary,
      slices: bundle.revision.slices, tags: bundle.revision.tags, authorization: bundle.revision.authorization,
      sensitivity: bundle.revision.sensitivity, provenance: bundle.revision.provenance, cases: bundle.cases,
    };
    if (datasetRevisionDigest(draft, bundle.revision.revision) !== bundle.revision.digest
      || datasetContentDigest(bundle.revision.kind, bundle.cases) !== bundle.revision.contentDigest) {
      conflict('EVALUATION_REVISION_CORRUPTED', 'revision 内容与摘要不一致，拒绝继续写入。');
    }
  }

  private assertRubricIntegrity(bundle: EvaluationRubricBundle): void {
    const draft: EvaluationRubricRevisionDraft = {
      id: bundle.revision.id, rubricId: bundle.revision.rubricId, kind: bundle.revision.kind,
      note: bundle.revision.note, summary: bundle.revision.summary,
      missingResultPolicy: bundle.revision.missingResultPolicy, dimensions: bundle.dimensions,
    };
    if (rubricRevisionDigest(draft, bundle.revision.revision) !== bundle.revision.digest
      || evaluationRubricContentDigest(bundle.revision.kind, bundle.revision.missingResultPolicy, bundle.dimensions)
        !== bundle.revision.contentDigest) {
      conflict('EVALUATION_REVISION_CORRUPTED', '量表 revision 内容与摘要不一致，拒绝继续写入。');
    }
  }

  private async assertShotRubricRefs(cases: readonly EvaluationCase[], caseLines?: Record<string, number>): Promise<void> {
    for (const item of cases) {
      await this.assertShotRubricCase(item, caseLines?.[item.caseId]);
    }
  }

  private async assertShotRubricCase(item: EvaluationCase, line?: number): Promise<void> {
    if (item.input.kind !== 'shot_review') return;
    const issuePath = `case.${item.caseId}.input.rubric`;
    const rubric = await this.repository.getRubricRevision(item.input.rubric.rubricId, item.input.rubric.revisionId)
      .catch(error => {
        if (error instanceof EvaluationError && error.status === 404) return null;
        throw error;
      });
    if (!rubric) {
      throw new EvaluationError(400, 'EVALUATION_VERSION_REF_INVALID', '镜头审核引用的四维量表 revision 不存在。',
        [{ path: issuePath, code: 'EVALUATION_VERSION_REF_INVALID', message: '量表 revision 不存在。',
          caseId: item.caseId, ...(line === undefined ? {} : { line }) }]);
    }
    if (rubric.revision.status !== 'frozen') {
      throw new EvaluationError(400, 'EVALUATION_VERSION_REF_INVALID', '镜头审核只能引用已冻结的量表 revision。',
        [{ path: issuePath, code: 'EVALUATION_VERSION_REF_INVALID', message: '量表 revision 未冻结。',
          caseId: item.caseId, ...(line === undefined ? {} : { line }) }]);
    }
    if (rubric.revision.kind !== 'shot_review' || rubric.revision.digest !== item.input.rubric.digest) {
      throw new EvaluationError(400, 'EVALUATION_VERSION_REF_INVALID', '量表类型或摘要与引用不一致。',
        [{ path: issuePath, code: 'EVALUATION_VERSION_REF_INVALID', message: '量表类型或摘要不一致。',
          caseId: item.caseId, ...(line === undefined ? {} : { line }) }]);
    }
  }
}

/* JSONL 解析/序列化单独成文件，service 只负责目录级校验与写入。 */

function importBody(body: unknown): { jsonl: string; expectedDigest: string | null } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    badRequest('EVALUATION_INPUT_INVALID', '导入参数必须是对象。');
  }
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!['jsonl', 'expectedDigest'].includes(key)) badRequest('EVALUATION_INPUT_INVALID', `不支持的字段 ${key}。`);
  }
  if (typeof input.jsonl !== 'string' || !input.jsonl.trim()) badRequest('EVALUATION_INPUT_INVALID', 'jsonl 必须是非空文本。');
  if (input.jsonl.length > 4 * 1024 * 1024) badRequest('EVALUATION_INPUT_INVALID', 'JSONL 超过 4MB 上限。');
  const expectedDigest = input.expectedDigest === null || input.expectedDigest === undefined
    ? null : input.expectedDigest;
  if (expectedDigest !== null && (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedDigest))) {
    badRequest('EVALUATION_INPUT_INVALID', 'expectedDigest 必须是 64 位小写十六进制摘要或 null。');
  }
  return { jsonl: input.jsonl, expectedDigest };
}
