import type { PoolClient, QueryResultRow } from 'pg';
import {
  EvaluationError, datasetContentDigest, datasetRevisionDigest, evaluationCaseDigest, evaluationCaseInputDigest,
  evaluationRubricContentDigest, rubricRevisionDigest,
  type EvaluationCase, type EvaluationDataset, type EvaluationDatasetBundle, type EvaluationDatasetRevision,
  type EvaluationDatasetRevisionDraft, type EvaluationLifecycleEvent, type EvaluationRevisionUsage,
  type EvaluationRubric, type EvaluationRubricBundle, type EvaluationRubricRevision,
  type EvaluationRubricRevisionDraft, type EvaluationTargetKind, type RubricDimension,
} from '@lyra/shared';
import type { PostgresDatabase } from '../db/client';
import type { EvaluationRepository } from './repository';

const clone = <T>(value: T): T => structuredClone(value);
const json = (value: unknown): string => JSON.stringify(value);

function conflict(code: string, message: string): never {
  throw new EvaluationError(409, code, message);
}
function notFound(code: string, message: string): never {
  throw new EvaluationError(404, code, message);
}
function failure(error: unknown): never {
  if (error instanceof EvaluationError) throw error;
  const record = error && typeof error === 'object' ? error as { code?: string; message?: string; constraint?: string } : {};
  const message = record.message ?? '';
  if (message.includes('EVALUATION_REVISION_REFERENCED')) {
    conflict('EVALUATION_REVISION_REFERENCED', '该 revision 已被评测引用，内容只读；请派生新 revision。');
  }
  if (message.includes('EVALUATION_REVISION_IMMUTABLE')) {
    conflict('EVALUATION_REVISION_IMMUTABLE', '冻结或废弃的 revision 不允许修改内容；请派生新 revision。');
  }
  if (message.includes('EVALUATION_REVISION_NOT_BINDABLE')) {
    conflict('EVALUATION_REVISION_NOT_BINDABLE', '新评测只能绑定已冻结、未废弃的 revision。');
  }
  if (message.includes('EVALUATION_REVISION_STATUS_INVALID')) {
    conflict('EVALUATION_REVISION_STATUS_INVALID', 'revision 状态只能按草稿→冻结→废弃推进。');
  }
  if (message.includes('EVALUATION_HISTORY_APPEND_ONLY')) {
    conflict('EVALUATION_HISTORY_APPEND_ONLY', '生命周期事件与引用记录只允许追加。');
  }
  if (record.code === '23505') {
    if (record.constraint === 'evaluation_case_input_unique' || record.constraint === 'evaluation_case_content_unique') {
      conflict('EVALUATION_CASE_CONFLICT', '并发写入出现重复或输入相同但期望不同的样例。');
    }
    if (record.constraint === 'evaluation_dataset_revision_identity'
      || record.constraint === 'evaluation_rubric_revision_identity') {
      conflict('EVALUATION_REVISION_CONFLICT', 'revision 号并发冲突，请重试。');
    }
    conflict('EVALUATION_DUPLICATE_RECORD', '唯一约束冲突。');
  }
  if (record.code === '23514') {
    conflict('EVALUATION_CONSTRAINT_VIOLATION', '数据库约束拒绝了该写入。');
  }
  throw new EvaluationError(503, 'EVALUATION_PERSISTENCE_UNAVAILABLE', '评测目录暂时不可用，请稍后重试。');
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  return new Date(String(value)).toISOString();
}

const DATASET_REVISION_COLUMNS = `id, dataset_id, kind, revision, status, note, content_summary, slices, tags,
  authorization_json, sensitivity, provenance_json, content_digest, digest, case_count,
  created_at, frozen_at, deprecated_at`;

const RUBRIC_REVISION_COLUMNS = `id, rubric_id, kind, revision, status, note, summary, missing_result_policy,
  content_digest, digest, dimension_count, created_at, frozen_at, deprecated_at`;

interface DatasetRevisionRow {
  id: string; dataset_id: string; kind: EvaluationDatasetRevision['kind']; revision: number;
  status: EvaluationDatasetRevision['status']; note: string; content_summary: string;
  slices: string[]; tags: string[]; authorization_json: EvaluationDatasetRevision['authorization'];
  sensitivity: EvaluationDatasetRevision['sensitivity']; provenance_json: EvaluationDatasetRevision['provenance'];
  content_digest: string; digest: string; case_count: number;
  created_at: unknown; frozen_at: unknown; deprecated_at: unknown;
}

interface CaseRow {
  case_id: string; kind: EvaluationCase['kind']; title: string; intent: string;
  input_json: EvaluationCase['input']; expectation_json: EvaluationCase['expectation'];
  source_json: EvaluationCase['source']; version_refs_json: EvaluationCase['versionRefs'];
  content_summary: string; authorization_json: EvaluationCase['authorization'];
  sensitivity: EvaluationCase['sensitivity']; tags: string[]; slices: string[];
}

interface RubricRevisionRow {
  id: string; rubric_id: string; kind: EvaluationRubricRevision['kind']; revision: number;
  status: EvaluationRubricRevision['status']; note: string; summary: string;
  missing_result_policy: EvaluationRubricRevision['missingResultPolicy'];
  content_digest: string; digest: string; dimension_count: number;
  created_at: unknown; frozen_at: unknown; deprecated_at: unknown;
}

interface DimensionRow {
  dimension_key: string; label: string; description: string;
  scale_json: RubricDimension['scale']; thresholds_json: RubricDimension['thresholds'];
  evidence_json: RubricDimension['evidence'];
}

function revisionOf(row: DatasetRevisionRow): EvaluationDatasetRevision {
  return {
    id: row.id, datasetId: row.dataset_id, kind: row.kind, revision: row.revision, status: row.status,
    note: row.note, contentSummary: row.content_summary, slices: row.slices, tags: row.tags,
    authorization: row.authorization_json, sensitivity: row.sensitivity, provenance: row.provenance_json,
    digest: row.digest, contentDigest: row.content_digest, caseCount: row.case_count,
    createdAt: iso(row.created_at), frozenAt: row.frozen_at === null ? null : iso(row.frozen_at),
    deprecatedAt: row.deprecated_at === null ? null : iso(row.deprecated_at),
  };
}

function rubricRevisionOf(row: RubricRevisionRow): EvaluationRubricRevision {
  return {
    id: row.id, rubricId: row.rubric_id, kind: row.kind, revision: row.revision, status: row.status,
    note: row.note, summary: row.summary, missingResultPolicy: row.missing_result_policy,
    digest: row.digest, contentDigest: row.content_digest, dimensionCount: row.dimension_count,
    createdAt: iso(row.created_at), frozenAt: row.frozen_at === null ? null : iso(row.frozen_at),
    deprecatedAt: row.deprecated_at === null ? null : iso(row.deprecated_at),
  };
}

function caseOf(row: CaseRow): EvaluationCase {
  return {
    caseId: row.case_id, kind: row.kind, title: row.title, intent: row.intent, input: row.input_json,
    expectation: row.expectation_json, source: row.source_json, versionRefs: row.version_refs_json,
    contentSummary: row.content_summary, authorization: row.authorization_json,
    sensitivity: row.sensitivity, tags: row.tags, slices: row.slices,
  };
}

function dimensionOf(row: DimensionRow): RubricDimension {
  return {
    key: row.dimension_key, label: row.label, description: row.description, scale: row.scale_json,
    thresholds: row.thresholds_json, evidence: row.evidence_json,
  };
}

function locked(code: string, message: string): never {
  return conflict(code, message);
}

/** PostgreSQL 实现；用事务 + advisory lock 分配 revision 号，用 Trigger 兜底不可变。 */export class PostgresEvaluationRepository implements EvaluationRepository {
  constructor(private readonly database: Pick<PostgresDatabase, 'query' | 'transaction'>) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(work);
    } catch (error) {
      return failure(error);
    }
  }

  private async query<T extends QueryResultRow>(client: PoolClient, text: string, values: unknown[] = []) {
    return client.query<T>(text, [...values]);
  }

  private lock(client: PoolClient, scope: 'dataset' | 'rubric', id: string) {
    return client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lyra:evaluation:${scope}:${id}`]);
  }

  private async requireDataset(client: PoolClient, datasetId: string): Promise<EvaluationDataset> {
    const result = await this.query<{ id: string; kind: EvaluationDataset['kind']; title: string; description: string;
      created_at: unknown; updated_at: unknown }>(client,
    'SELECT id, kind, title, description, created_at, updated_at FROM evaluation_datasets WHERE id = $1', [datasetId]);
    const row = result.rows[0];
    if (!row) return notFound('EVALUATION_DATASET_NOT_FOUND', '数据集不存在。');
    return { id: row.id, kind: row.kind, title: row.title, description: row.description,
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
  }

  private async requireRubric(client: PoolClient, rubricId: string): Promise<EvaluationRubric> {
    const result = await this.query<{ id: string; kind: EvaluationRubric['kind']; title: string; description: string;
      created_at: unknown; updated_at: unknown }>(client,
    'SELECT id, kind, title, description, created_at, updated_at FROM evaluation_rubrics WHERE id = $1', [rubricId]);
    const row = result.rows[0];
    if (!row) return notFound('EVALUATION_RUBRIC_NOT_FOUND', '量表不存在。');
    return { id: row.id, kind: row.kind, title: row.title, description: row.description,
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
  }

  private async datasetRevisionRow(client: PoolClient, datasetId: string, revisionId: string,
    lock = false): Promise<DatasetRevisionRow | null> {
    const result = await this.query<DatasetRevisionRow>(client,
      `SELECT ${DATASET_REVISION_COLUMNS} FROM evaluation_dataset_revisions
       WHERE id = $1 AND dataset_id = $2${lock ? ' FOR UPDATE' : ''}`, [revisionId, datasetId]);
    return result.rows[0] ?? null;
  }

  private async datasetCases(client: PoolClient, revisionId: string): Promise<EvaluationCase[]> {
    const result = await this.query<CaseRow>(client,
      `SELECT case_id, kind, title, intent, input_json, expectation_json, source_json, version_refs_json,
        content_summary, authorization_json, sensitivity, tags, slices
       FROM evaluation_cases WHERE revision_id = $1 ORDER BY ordinal, case_id`, [revisionId]);
    return result.rows.map(caseOf);
  }

  private async datasetBundle(client: PoolClient, revisionId: string): Promise<EvaluationDatasetBundle | null> {
    const row = await this.query<DatasetRevisionRow>(client,
      `SELECT ${DATASET_REVISION_COLUMNS} FROM evaluation_dataset_revisions WHERE id = $1`, [revisionId]);
    if (!row.rows[0]) return null;
    return { revision: revisionOf(row.rows[0]), cases: await this.datasetCases(client, revisionId) };
  }

  private async insertDatasetCases(client: PoolClient, revisionId: string, cases: readonly EvaluationCase[],
    startOrdinal: number, at: string): Promise<void> {
    let ordinal = startOrdinal;
    for (const item of [...cases].sort((a, b) => a.caseId.localeCompare(b.caseId))) {
      ordinal += 1;
      await client.query(`INSERT INTO evaluation_cases
        (revision_id, case_id, ordinal, kind, title, intent, input_json, expectation_json, source_json,
         version_refs_json, content_summary, authorization_json, sensitivity, tags, slices,
         input_digest, content_digest, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13,$14,$15,$16,$17,$18)`,
      [revisionId, item.caseId, ordinal, item.kind, item.title, item.intent, json(item.input), json(item.expectation),
        json(item.source), json(item.versionRefs), item.contentSummary, json(item.authorization), item.sensitivity,
        item.tags, item.slices, evaluationCaseInputDigest(item), evaluationCaseDigest(item), at]);
    }
  }

  private async usageExists(client: PoolClient, targetKind: EvaluationTargetKind, revisionId: string): Promise<boolean> {
    const query = targetKind === 'dataset'
      ? 'SELECT 1 FROM evaluation_revision_usage WHERE dataset_revision_id = $1 LIMIT 1'
      : 'SELECT 1 FROM evaluation_revision_usage WHERE rubric_revision_id = $1 LIMIT 1';
    const result = await this.query(client, query, [revisionId]);
    return (result.rowCount ?? 0) > 0;
  }

  private async assertDatasetMutable(client: PoolClient, row: DatasetRevisionRow, expectedDigest: string): Promise<void> {
    if (await this.usageExists(client, 'dataset', row.id)) {
      conflict('EVALUATION_REVISION_REFERENCED', '该 revision 已被评测引用，内容只读；请派生新 revision。');
    }
    if (row.status !== 'draft') conflict('EVALUATION_REVISION_IMMUTABLE', '冻结或废弃的 revision 不允许修改内容。');
    if (row.digest !== expectedDigest) conflict('EVALUATION_REVISION_STALE', 'expectedDigest 与当前 revision 不一致。');
  }

  private async assertRubricMutable(client: PoolClient, row: RubricRevisionRow, expectedDigest: string): Promise<void> {
    if (await this.usageExists(client, 'rubric', row.id)) {
      conflict('EVALUATION_REVISION_REFERENCED', '该 revision 已被评测引用，内容只读；请派生新 revision。');
    }
    if (row.status !== 'draft') conflict('EVALUATION_REVISION_IMMUTABLE', '冻结或废弃的 revision 不允许修改内容。');
    if (row.digest !== expectedDigest) conflict('EVALUATION_REVISION_STALE', 'expectedDigest 与当前 revision 不一致。');
  }

  async listDatasets(): Promise<EvaluationDataset[]> {
    try {
      const result = await this.database.query<{ id: string; kind: EvaluationDataset['kind']; title: string;
        description: string; created_at: unknown; updated_at: unknown }>(
        'SELECT id, kind, title, description, created_at, updated_at FROM evaluation_datasets ORDER BY created_at DESC, id DESC');
      return result.rows.map(row => ({ id: row.id, kind: row.kind, title: row.title, description: row.description,
        createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }));
    } catch (error) {
      return failure(error);
    }
  }

  async getDataset(datasetId: string): Promise<EvaluationDataset | null> {
    try {
      const result = await this.database.query<{ id: string; kind: EvaluationDataset['kind']; title: string;
        description: string; created_at: unknown; updated_at: unknown }>(
        'SELECT id, kind, title, description, created_at, updated_at FROM evaluation_datasets WHERE id = $1', [datasetId]);
      const row = result.rows[0];
      return row ? { id: row.id, kind: row.kind, title: row.title, description: row.description,
        createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) } : null;
    } catch (error) {
      return failure(error);
    }
  }

  async createDataset(dataset: EvaluationDataset, draft: EvaluationDatasetRevisionDraft,
    event: EvaluationLifecycleEvent): Promise<EvaluationDatasetBundle> {
    return this.transaction(async client => {
      await this.lock(client, 'dataset', dataset.id);
      await client.query(`INSERT INTO evaluation_datasets (id, kind, title, description, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6)`, [dataset.id, dataset.kind, dataset.title, dataset.description,
        dataset.createdAt, dataset.updatedAt]);
      const digest = datasetRevisionDigest(draft, 1);
      const contentDigest = datasetContentDigest(draft.kind, draft.cases);
      await client.query(`INSERT INTO evaluation_dataset_revisions
        (id, dataset_id, kind, revision, status, note, content_summary, slices, tags, authorization_json,
         sensitivity, provenance_json, content_digest, digest, case_count, created_at, frozen_at, deprecated_at)
        VALUES ($1,$2,$3,1,'draft',$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13,$14,NULL,NULL)`,
      [draft.id, dataset.id, dataset.kind, draft.note, draft.contentSummary, draft.slices, draft.tags,
        json(draft.authorization), draft.sensitivity, json(draft.provenance), contentDigest, digest,
        draft.cases.length, event.createdAt]);
      await this.insertDatasetCases(client, draft.id, draft.cases, 0, event.createdAt);
      await this.insertEvent(client, event);
      const revision: EvaluationDatasetRevision = {
        id: draft.id, datasetId: dataset.id, kind: dataset.kind, revision: 1, status: 'draft',
        note: draft.note, contentSummary: draft.contentSummary, slices: [...draft.slices].sort(),
        tags: [...draft.tags].sort(), authorization: clone(draft.authorization), sensitivity: draft.sensitivity,
        provenance: clone(draft.provenance), digest, contentDigest, caseCount: draft.cases.length,
        createdAt: event.createdAt, frozenAt: null, deprecatedAt: null,
      };
      return { revision, cases: clone(draft.cases) };
    });
  }

  async listDatasetRevisions(datasetId: string): Promise<EvaluationDatasetRevision[]> {
    return this.transaction(async client => {
      await this.requireDataset(client, datasetId);
      const result = await this.query<DatasetRevisionRow>(client,
        `SELECT ${DATASET_REVISION_COLUMNS} FROM evaluation_dataset_revisions
         WHERE dataset_id = $1 ORDER BY revision`, [datasetId]);
      return result.rows.map(revisionOf);
    });
  }

  async latestDatasetRevision(datasetId: string): Promise<EvaluationDatasetRevision | null> {
    try {
      const result = await this.database.query<DatasetRevisionRow>(
        `SELECT ${DATASET_REVISION_COLUMNS} FROM evaluation_dataset_revisions
         WHERE dataset_id = $1 ORDER BY revision DESC LIMIT 1`, [datasetId]);
      return result.rows[0] ? revisionOf(result.rows[0]) : null;
    } catch (error) {
      return failure(error);
    }
  }

  async getDatasetRevision(datasetId: string, revisionId: string): Promise<EvaluationDatasetBundle | null> {
    return this.transaction(async client => {
      await this.requireDataset(client, datasetId);
      const row = await this.datasetRevisionRow(client, datasetId, revisionId);
      if (!row) return null;
      return { revision: revisionOf(row), cases: await this.datasetCases(client, revisionId) };
    });
  }

  async appendDatasetRevision(datasetId: string, draft: EvaluationDatasetRevisionDraft,
    event: EvaluationLifecycleEvent, expectedLatestDigest: string | null = null): Promise<EvaluationDatasetBundle> {
    return this.transaction(async client => {
      await this.lock(client, 'dataset', datasetId);
      const dataset = await this.requireDataset(client, datasetId);
      if (draft.datasetId !== datasetId || draft.kind !== dataset.kind) {
        conflict('EVALUATION_KIND_MISMATCH', 'revision 类型与数据集不一致。');
      }
      if (expectedLatestDigest !== null) {
        const latest = await this.query<{ digest: string }>(client,
          'SELECT digest FROM evaluation_dataset_revisions WHERE dataset_id = $1 ORDER BY revision DESC LIMIT 1',
          [datasetId]);
        if (!latest.rows[0] || latest.rows[0].digest !== expectedLatestDigest) {
          conflict('EVALUATION_REVISION_STALE', 'expectedDigest 与数据集最新 revision 不一致。');
        }
      }
      const last = await this.query<{ revision: number }>(client,
        'SELECT COALESCE(MAX(revision), 0)::int AS revision FROM evaluation_dataset_revisions WHERE dataset_id = $1',
        [datasetId]);
      const revisionNumber = Number(last.rows[0]?.revision ?? 0) + 1;
      const digest = datasetRevisionDigest(draft, revisionNumber);
      const contentDigest = datasetContentDigest(draft.kind, draft.cases);
      await client.query(`INSERT INTO evaluation_dataset_revisions
        (id, dataset_id, kind, revision, status, note, content_summary, slices, tags, authorization_json,
         sensitivity, provenance_json, content_digest, digest, case_count, created_at, frozen_at, deprecated_at)
        VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15,NULL,NULL)`,
      [draft.id, datasetId, draft.kind, revisionNumber, draft.note, draft.contentSummary, draft.slices,
        draft.tags, json(draft.authorization), draft.sensitivity, json(draft.provenance), contentDigest, digest,
        draft.cases.length, event.createdAt]);
      await this.insertDatasetCases(client, draft.id, draft.cases, 0, event.createdAt);
      await this.insertEvent(client, event);
      await client.query('UPDATE evaluation_datasets SET updated_at = $2 WHERE id = $1', [datasetId, event.createdAt]);
      const revision: EvaluationDatasetRevision = {
        id: draft.id, datasetId, kind: draft.kind, revision: revisionNumber, status: 'draft',
        note: draft.note, contentSummary: draft.contentSummary, slices: [...draft.slices].sort(),
        tags: [...draft.tags].sort(), authorization: clone(draft.authorization), sensitivity: draft.sensitivity,
        provenance: clone(draft.provenance), digest, contentDigest, caseCount: draft.cases.length,
        createdAt: event.createdAt, frozenAt: null, deprecatedAt: null,
      };
      return { revision, cases: clone(draft.cases) };
    });
  }

  async appendDatasetCases(datasetId: string, revisionId: string, cases: EvaluationCase[], expectedDigest: string,
    at: string): Promise<EvaluationDatasetBundle> {
    return this.transaction(async client => {
      await this.lock(client, 'dataset', datasetId);
      const row = await this.datasetRevisionRow(client, datasetId, revisionId, true);
      if (!row) return notFound('EVALUATION_REVISION_NOT_FOUND', '数据集 revision 不存在。');
      await this.assertDatasetMutable(client, row, expectedDigest);
      const existing = await this.datasetCases(client, revisionId);
      const next = [...existing, ...cases];
      const ids = new Map<string, EvaluationCase>();
      const inputs = new Map<string, EvaluationCase>();
      for (const item of existing) {
        ids.set(item.caseId, item);
        inputs.set(evaluationCaseInputDigest(item), item);
      }
      for (const item of cases) {
        if (ids.has(item.caseId)) conflict('EVALUATION_DUPLICATE_CASE_ID', `样例 ID ${item.caseId} 已存在。`);
        ids.set(item.caseId, item);
        const inputDigest = evaluationCaseInputDigest(item);
        const previous = inputs.get(inputDigest);
        if (previous) {
          if (evaluationCaseDigest(previous) === evaluationCaseDigest(item)) {
            conflict('EVALUATION_DUPLICATE_CONTENT', `样例 ${item.caseId} 与已有样例内容完全重复。`);
          }
          conflict('EVALUATION_CASE_CONFLICT', `样例 ${item.caseId} 与已有样例输入相同但期望不同。`);
        }
        inputs.set(inputDigest, item);
      }
      await this.insertDatasetCases(client, revisionId, cases, existing.length, at);
      const revision = revisionOf(row);
      const nextDraft: EvaluationDatasetRevisionDraft = {
        id: revision.id, datasetId: revision.datasetId, kind: revision.kind, note: revision.note,
        contentSummary: revision.contentSummary, slices: revision.slices, tags: revision.tags,
        authorization: revision.authorization, sensitivity: revision.sensitivity,
        provenance: revision.provenance, cases: next,
      };
      const digest = datasetRevisionDigest(nextDraft, revision.revision);
      const contentDigest = datasetContentDigest(revision.kind, next);
      await client.query(`UPDATE evaluation_dataset_revisions
        SET digest = $2, content_digest = $3, case_count = $4 WHERE id = $1`,
      [revisionId, digest, contentDigest, next.length]);
      await client.query('UPDATE evaluation_datasets SET updated_at = $2 WHERE id = $1', [datasetId, at]);
      return {
        revision: { ...revision, digest, contentDigest, caseCount: next.length },
        cases: clone(next),
      };
    });
  }

  async freezeDatasetRevision(datasetId: string, revisionId: string, expectedDigest: string, at: string,
    event: EvaluationLifecycleEvent): Promise<EvaluationDatasetBundle> {
    return this.transaction(async client => {
      await this.lock(client, 'dataset', datasetId);
      const row = await this.datasetRevisionRow(client, datasetId, revisionId, true);
      if (!row) return notFound('EVALUATION_REVISION_NOT_FOUND', '数据集 revision 不存在。');
      if (await this.usageExists(client, 'dataset', revisionId)) {
        conflict('EVALUATION_REVISION_REFERENCED', '该 revision 已被评测引用。');
      }
      if (row.status !== 'draft') conflict('EVALUATION_REVISION_IMMUTABLE', '只有草稿 revision 可以冻结。');
      if (row.digest !== expectedDigest) conflict('EVALUATION_REVISION_STALE', 'expectedDigest 与当前 revision 不一致。');
      const bundle = await this.datasetBundle(client, revisionId);
      if (!bundle || bundle.cases.length === 0) conflict('EVALUATION_REVISION_EMPTY', '空数据集 revision 不能冻结。');
      const draft: EvaluationDatasetRevisionDraft = {
        id: row.id, datasetId: row.dataset_id, kind: row.kind, note: row.note,
        contentSummary: row.content_summary, slices: row.slices, tags: row.tags,
        authorization: row.authorization_json, sensitivity: row.sensitivity,
        provenance: row.provenance_json, cases: bundle!.cases,
      };
      if (datasetRevisionDigest(draft, row.revision) !== row.digest
        || datasetContentDigest(row.kind, bundle!.cases) !== row.content_digest) {
        conflict('EVALUATION_REVISION_CORRUPTED', 'revision 内容与摘要不一致，拒绝冻结。');
      }
      await client.query("UPDATE evaluation_dataset_revisions SET status = 'frozen', frozen_at = $2 WHERE id = $1",
        [revisionId, at]);
      await this.insertEvent(client, event);
      await client.query('UPDATE evaluation_datasets SET updated_at = $2 WHERE id = $1', [datasetId, at]);
      return { revision: { ...revisionOf(row), status: 'frozen', frozenAt: at }, cases: clone(bundle!.cases) };
    });
  }

  async deprecateDatasetRevision(datasetId: string, revisionId: string, expectedDigest: string, at: string,
    event: EvaluationLifecycleEvent): Promise<EvaluationDatasetRevision> {
    return this.transaction(async client => {
      await this.lock(client, 'dataset', datasetId);
      const row = await this.datasetRevisionRow(client, datasetId, revisionId, true);
      if (!row) return notFound('EVALUATION_REVISION_NOT_FOUND', '数据集 revision 不存在。');
      if (row.status === 'deprecated') conflict('EVALUATION_REVISION_DEPRECATED', 'revision 已废弃。');
      if (row.digest !== expectedDigest) conflict('EVALUATION_REVISION_STALE', 'expectedDigest 与当前 revision 不一致。');
      await client.query("UPDATE evaluation_dataset_revisions SET status = 'deprecated', deprecated_at = $2 WHERE id = $1",
        [revisionId, at]);
      await this.insertEvent(client, event);
      await client.query('UPDATE evaluation_datasets SET updated_at = $2 WHERE id = $1', [datasetId, at]);
      return { ...revisionOf(row), status: 'deprecated', deprecatedAt: at };
    });
  }

  /* ---------------------------- 量表 ----------------------------------- */

  async listRubrics(): Promise<EvaluationRubric[]> {
    try {
      const result = await this.database.query<{ id: string; kind: EvaluationRubric['kind']; title: string;
        description: string; created_at: unknown; updated_at: unknown }>(
        'SELECT id, kind, title, description, created_at, updated_at FROM evaluation_rubrics ORDER BY created_at DESC, id DESC');
      return result.rows.map(row => ({ id: row.id, kind: row.kind, title: row.title, description: row.description,
        createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }));
    } catch (error) {
      return failure(error);
    }
  }

  async getRubric(rubricId: string): Promise<EvaluationRubric | null> {
    return this.transaction(async client => {
      const result = await this.query<{ id: string; kind: EvaluationRubric['kind']; title: string; description: string;
        created_at: unknown; updated_at: unknown }>(client,
      'SELECT id, kind, title, description, created_at, updated_at FROM evaluation_rubrics WHERE id = $1', [rubricId]);
      const row = result.rows[0];
      return row ? { id: row.id, kind: row.kind, title: row.title, description: row.description,
        createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) } : null;
    });
  }

  private async rubricRevisionRow(client: PoolClient, rubricId: string, revisionId: string,
    lock = false): Promise<RubricRevisionRow | null> {
    const result = await this.query<RubricRevisionRow>(client,
      `SELECT ${RUBRIC_REVISION_COLUMNS} FROM evaluation_rubric_revisions
       WHERE id = $1 AND rubric_id = $2${lock ? ' FOR UPDATE' : ''}`, [revisionId, rubricId]);
    return result.rows[0] ?? null;
  }

  private async rubricDimensions(client: PoolClient, revisionId: string): Promise<RubricDimension[]> {
    const result = await this.query<DimensionRow>(client,
      `SELECT dimension_key, label, description, scale_json, thresholds_json, evidence_json
       FROM evaluation_rubric_dimensions WHERE revision_id = $1 ORDER BY ordinal, dimension_key`, [revisionId]);
    return result.rows.map(dimensionOf);
  }

  private async insertDimensions(client: PoolClient, revisionId: string, dimensions: readonly RubricDimension[],
    startOrdinal: number): Promise<void> {
    let ordinal = startOrdinal;
    for (const dimension of [...dimensions].sort((a, b) => a.key.localeCompare(b.key))) {
      ordinal += 1;
      await client.query(`INSERT INTO evaluation_rubric_dimensions
        (revision_id, dimension_key, ordinal, label, description, scale_json, thresholds_json, evidence_json)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)`,
      [revisionId, dimension.key, ordinal, dimension.label, dimension.description, json(dimension.scale),
        json(dimension.thresholds), json(dimension.evidence)]);
    }
  }

  async createRubric(rubric: EvaluationRubric, draft: EvaluationRubricRevisionDraft,
    event: EvaluationLifecycleEvent): Promise<EvaluationRubricBundle> {
    return this.transaction(async client => {
      await this.lock(client, 'rubric', rubric.id);
      await client.query(`INSERT INTO evaluation_rubrics (id, kind, title, description, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6)`, [rubric.id, rubric.kind, rubric.title, rubric.description,
        rubric.createdAt, rubric.updatedAt]);
      const digest = rubricRevisionDigest(draft, 1);
      const contentDigest = evaluationRubricContentDigest(draft.kind, draft.missingResultPolicy, draft.dimensions);
      await client.query(`INSERT INTO evaluation_rubric_revisions
        (id, rubric_id, kind, revision, status, note, summary, missing_result_policy, content_digest, digest,
         dimension_count, created_at, frozen_at, deprecated_at)
        VALUES ($1,$2,$3,1,'draft',$4,$5,$6::jsonb,$7,$8,$9,$10,NULL,NULL)`,
      [draft.id, rubric.id, rubric.kind, draft.note, draft.summary, json(draft.missingResultPolicy),
        contentDigest, digest, draft.dimensions.length, event.createdAt]);
      await this.insertDimensions(client, draft.id, draft.dimensions, 0);
      await this.insertEvent(client, event);
      const revision: EvaluationRubricRevision = {
        id: draft.id, rubricId: rubric.id, kind: rubric.kind, revision: 1, status: 'draft',
        note: draft.note, summary: draft.summary, missingResultPolicy: clone(draft.missingResultPolicy),
        digest, contentDigest, dimensionCount: draft.dimensions.length,
        createdAt: event.createdAt, frozenAt: null, deprecatedAt: null,
      };
      return { revision, dimensions: clone(draft.dimensions) };
    });
  }

  async listRubricRevisions(rubricId: string): Promise<EvaluationRubricRevision[]> {
    return this.transaction(async client => {
      await this.requireRubric(client, rubricId);
      const result = await this.query<RubricRevisionRow>(client,
        `SELECT ${RUBRIC_REVISION_COLUMNS} FROM evaluation_rubric_revisions
         WHERE rubric_id = $1 ORDER BY revision`, [rubricId]);
      return result.rows.map(rubricRevisionOf);
    });
  }

  async latestRubricRevision(rubricId: string): Promise<EvaluationRubricRevision | null> {
    try {
      const result = await this.database.query<RubricRevisionRow>(
        `SELECT ${RUBRIC_REVISION_COLUMNS} FROM evaluation_rubric_revisions
         WHERE rubric_id = $1 ORDER BY revision DESC LIMIT 1`, [rubricId]);
      return result.rows[0] ? rubricRevisionOf(result.rows[0]) : null;
    } catch (error) {
      return failure(error);
    }
  }

  async getRubricRevision(rubricId: string, revisionId: string): Promise<EvaluationRubricBundle | null> {
    return this.transaction(async client => {
      await this.requireRubric(client, rubricId);
      const row = await this.rubricRevisionRow(client, rubricId, revisionId);
      if (!row) return null;
      return { revision: rubricRevisionOf(row), dimensions: await this.rubricDimensions(client, revisionId) };
    });
  }

  async appendRubricRevision(rubricId: string, draft: EvaluationRubricRevisionDraft,
    event: EvaluationLifecycleEvent, expectedLatestDigest: string | null = null): Promise<EvaluationRubricBundle> {
    return this.transaction(async client => {
      await this.lock(client, 'rubric', rubricId);
      const rubric = await this.requireRubric(client, rubricId);
      if (draft.rubricId !== rubricId || draft.kind !== rubric.kind) {
        conflict('EVALUATION_KIND_MISMATCH', 'revision 类型与量表不一致。');
      }
      if (expectedLatestDigest !== null) {
        const latest = await this.query<{ digest: string }>(client,
          'SELECT digest FROM evaluation_rubric_revisions WHERE rubric_id = $1 ORDER BY revision DESC LIMIT 1',
          [rubricId]);
        if (!latest.rows[0] || latest.rows[0].digest !== expectedLatestDigest) {
          conflict('EVALUATION_REVISION_STALE', 'expectedDigest 与量表最新 revision 不一致。');
        }
      }
      const last = await this.query<{ revision: number }>(client,
        'SELECT COALESCE(MAX(revision), 0)::int AS revision FROM evaluation_rubric_revisions WHERE rubric_id = $1',
        [rubricId]);
      const revisionNumber = Number(last.rows[0]?.revision ?? 0) + 1;
      const digest = rubricRevisionDigest(draft, revisionNumber);
      const contentDigest = evaluationRubricContentDigest(draft.kind, draft.missingResultPolicy, draft.dimensions);
      await client.query(`INSERT INTO evaluation_rubric_revisions
        (id, rubric_id, kind, revision, status, note, summary, missing_result_policy, content_digest, digest,
         dimension_count, created_at, frozen_at, deprecated_at)
        VALUES ($1,$2,$3,$4,'draft',$5,$6,$7::jsonb,$8,$9,$10,$11,NULL,NULL)`,
      [draft.id, rubricId, draft.kind, revisionNumber, draft.note, draft.summary, json(draft.missingResultPolicy),
        contentDigest, digest, draft.dimensions.length, event.createdAt]);
      await this.insertDimensions(client, draft.id, draft.dimensions, 0);
      await this.insertEvent(client, event);
      await client.query('UPDATE evaluation_rubrics SET updated_at = $2 WHERE id = $1', [rubricId, event.createdAt]);
      const revision: EvaluationRubricRevision = {
        id: draft.id, rubricId, kind: draft.kind, revision: revisionNumber, status: 'draft',
        note: draft.note, summary: draft.summary, missingResultPolicy: clone(draft.missingResultPolicy),
        digest, contentDigest, dimensionCount: draft.dimensions.length,
        createdAt: event.createdAt, frozenAt: null, deprecatedAt: null,
      };
      return { revision, dimensions: clone(draft.dimensions) };
    });
  }

  async appendRubricDimensions(rubricId: string, revisionId: string, dimensions: RubricDimension[],
    expectedDigest: string, at: string): Promise<EvaluationRubricBundle> {
    return this.transaction(async client => {
      await this.lock(client, 'rubric', rubricId);
      const row = await this.rubricRevisionRow(client, rubricId, revisionId, true);
      if (!row) return notFound('EVALUATION_REVISION_NOT_FOUND', '量表 revision 不存在。');
      await this.assertRubricMutable(client, row, expectedDigest);
      const existing = await this.rubricDimensions(client, revisionId);
      const keys = new Set(existing.map(item => item.key));
      for (const dimension of dimensions) {
        if (keys.has(dimension.key)) conflict('EVALUATION_DUPLICATE_DIMENSION', `维度 ${dimension.key} 已存在。`);
        keys.add(dimension.key);
      }
      if (existing.length + dimensions.length > 8) conflict('EVALUATION_DIMENSION_LIMIT', '单个量表最多 8 个维度。');
      if (row.kind === 'shot_review' && existing.length + dimensions.length !== 4) {
        conflict('EVALUATION_SHOT_RUBRIC_DIMENSIONS', '镜头审核量表必须恰好四个维度。');
      }
      const next = [...existing, ...dimensions].sort((a, b) => a.key.localeCompare(b.key));
      await this.insertDimensions(client, revisionId, dimensions, existing.length);
      const revision = rubricRevisionOf(row);
      const nextDraft: EvaluationRubricRevisionDraft = {
        id: revision.id, rubricId: revision.rubricId, kind: revision.kind, note: revision.note,
        summary: revision.summary, missingResultPolicy: revision.missingResultPolicy, dimensions: next,
      };
      const digest = rubricRevisionDigest(nextDraft, revision.revision);
      const contentDigest = evaluationRubricContentDigest(revision.kind, revision.missingResultPolicy, next);
      await client.query(`UPDATE evaluation_rubric_revisions
        SET digest = $2, content_digest = $3, dimension_count = $4 WHERE id = $1`,
      [revisionId, digest, contentDigest, next.length]);
      await client.query('UPDATE evaluation_rubrics SET updated_at = $2 WHERE id = $1', [rubricId, at]);
      return { revision: { ...revision, digest, contentDigest, dimensionCount: next.length }, dimensions: clone(next) };
    });
  }

  async freezeRubricRevision(rubricId: string, revisionId: string, expectedDigest: string, at: string,
    event: EvaluationLifecycleEvent): Promise<EvaluationRubricBundle> {
    return this.transaction(async client => {
      await this.lock(client, 'rubric', rubricId);
      const row = await this.rubricRevisionRow(client, rubricId, revisionId, true);
      if (!row) return notFound('EVALUATION_REVISION_NOT_FOUND', '量表 revision 不存在。');
      if (await this.usageExists(client, 'rubric', revisionId)) {
        conflict('EVALUATION_REVISION_REFERENCED', '该 revision 已被评测引用。');
      }
      if (row.status !== 'draft') conflict('EVALUATION_REVISION_IMMUTABLE', '只有草稿 revision 可以冻结。');
      if (row.digest !== expectedDigest) conflict('EVALUATION_REVISION_STALE', 'expectedDigest 与当前 revision 不一致。');
      const dimensions = await this.rubricDimensions(client, revisionId);
      if (dimensions.length === 0) conflict('EVALUATION_REVISION_EMPTY', '空量表 revision 不能冻结。');
      const draft: EvaluationRubricRevisionDraft = {
        id: row.id, rubricId: row.rubric_id, kind: row.kind, note: row.note, summary: row.summary,
        missingResultPolicy: row.missing_result_policy, dimensions,
      };
      if (rubricRevisionDigest(draft, row.revision) !== row.digest
        || evaluationRubricContentDigest(row.kind, row.missing_result_policy, dimensions) !== row.content_digest) {
        conflict('EVALUATION_REVISION_CORRUPTED', '量表 revision 内容与摘要不一致，拒绝冻结。');
      }
      await client.query("UPDATE evaluation_rubric_revisions SET status = 'frozen', frozen_at = $2 WHERE id = $1",
        [revisionId, at]);
      await this.insertEvent(client, event);
      await client.query('UPDATE evaluation_rubrics SET updated_at = $2 WHERE id = $1', [rubricId, at]);
      return { revision: { ...rubricRevisionOf(row), status: 'frozen', frozenAt: at }, dimensions: clone(dimensions) };
    });
  }

  async deprecateRubricRevision(rubricId: string, revisionId: string, expectedDigest: string, at: string,
    event: EvaluationLifecycleEvent): Promise<EvaluationRubricRevision> {
    return this.transaction(async client => {
      await this.lock(client, 'rubric', rubricId);
      const row = await this.rubricRevisionRow(client, rubricId, revisionId, true);
      if (!row) return notFound('EVALUATION_REVISION_NOT_FOUND', '量表 revision 不存在。');
      if (row.status === 'deprecated') conflict('EVALUATION_REVISION_DEPRECATED', 'revision 已废弃。');
      if (row.digest !== expectedDigest) conflict('EVALUATION_REVISION_STALE', 'expectedDigest 与当前 revision 不一致。');
      await client.query("UPDATE evaluation_rubric_revisions SET status = 'deprecated', deprecated_at = $2 WHERE id = $1",
        [revisionId, at]);
      await this.insertEvent(client, event);
      await client.query('UPDATE evaluation_rubrics SET updated_at = $2 WHERE id = $1', [rubricId, at]);
      return { ...rubricRevisionOf(row), status: 'deprecated', deprecatedAt: at };
    });
  }

  /* ---------------------------- 引用与事件 ------------------------------- */

  async recordUsage(usage: EvaluationRevisionUsage): Promise<EvaluationRevisionUsage> {
    return this.transaction(async client => {
      if (usage.targetKind === 'dataset') {
        const row = await this.query<{ status: string }>(client,
          'SELECT status FROM evaluation_dataset_revisions WHERE id = $1', [usage.revisionId]);
        if (!row.rows[0]) return notFound('EVALUATION_REVISION_NOT_FOUND', '被引用的 revision 不存在。');
        if (row.rows[0].status !== 'frozen') {
          conflict('EVALUATION_REVISION_NOT_BINDABLE', '新评测只能绑定已冻结、未废弃的 revision。');
        }
        const existing = await this.query<{ id: string; usage_kind: string; usage_ref: string; note: string;
          created_at: unknown }>(client, `SELECT id, usage_kind, usage_ref, note, created_at
          FROM evaluation_revision_usage WHERE dataset_revision_id = $1 AND usage_kind = $2 AND usage_ref = $3`,
        [usage.revisionId, usage.usageKind, usage.usageRef]);
        if (existing.rows[0]) {
          return { id: existing.rows[0].id, targetKind: 'dataset', revisionId: usage.revisionId,
            usageKind: existing.rows[0].usage_kind, usageRef: existing.rows[0].usage_ref,
            note: existing.rows[0].note, createdAt: iso(existing.rows[0].created_at) };
        }
        await client.query(`INSERT INTO evaluation_revision_usage
          (id, dataset_revision_id, rubric_revision_id, usage_kind, usage_ref, note, created_at)
          VALUES ($1,$2,NULL,$3,$4,$5,$6)`, [usage.id, usage.revisionId, usage.usageKind, usage.usageRef,
          usage.note, usage.createdAt]);
        return clone(usage);
      }
      const row = await this.query<{ status: string }>(client,
        'SELECT status FROM evaluation_rubric_revisions WHERE id = $1', [usage.revisionId]);
      if (!row.rows[0]) return notFound('EVALUATION_REVISION_NOT_FOUND', '被引用的 revision 不存在。');
      if (row.rows[0].status !== 'frozen') {
        conflict('EVALUATION_REVISION_NOT_BINDABLE', '新评测只能绑定已冻结、未废弃的 revision。');
      }
      const existing = await this.query<{ id: string; usage_kind: string; usage_ref: string; note: string;
        created_at: unknown }>(client, `SELECT id, usage_kind, usage_ref, note, created_at
        FROM evaluation_revision_usage WHERE rubric_revision_id = $1 AND usage_kind = $2 AND usage_ref = $3`,
      [usage.revisionId, usage.usageKind, usage.usageRef]);
      if (existing.rows[0]) {
        return { id: existing.rows[0].id, targetKind: 'rubric', revisionId: usage.revisionId,
          usageKind: existing.rows[0].usage_kind, usageRef: existing.rows[0].usage_ref,
          note: existing.rows[0].note, createdAt: iso(existing.rows[0].created_at) };
      }
      await client.query(`INSERT INTO evaluation_revision_usage
        (id, dataset_revision_id, rubric_revision_id, usage_kind, usage_ref, note, created_at)
        VALUES ($1,NULL,$2,$3,$4,$5,$6)`, [usage.id, usage.revisionId, usage.usageKind, usage.usageRef,
        usage.note, usage.createdAt]);
      return clone(usage);
    });
  }

  async listUsages(targetKind: EvaluationTargetKind, revisionId: string): Promise<EvaluationRevisionUsage[]> {
    try {
      const column = targetKind === 'dataset' ? 'dataset_revision_id' : 'rubric_revision_id';
      const result = await this.database.query<{ id: string; usage_kind: string; usage_ref: string; note: string;
        created_at: unknown }>(`SELECT id, usage_kind, usage_ref, note, created_at
        FROM evaluation_revision_usage WHERE ${column} = $1 ORDER BY created_at, id`, [revisionId]);
      return result.rows.map(row => ({ id: row.id, targetKind, revisionId, usageKind: row.usage_kind,
        usageRef: row.usage_ref, note: row.note, createdAt: iso(row.created_at) }));
    } catch (error) {
      return failure(error);
    }
  }

  async listLifecycleEvents(targetKind: EvaluationTargetKind, revisionId: string): Promise<EvaluationLifecycleEvent[]> {
    try {
      const column = targetKind === 'dataset' ? 'dataset_revision_id' : 'rubric_revision_id';
      const result = await this.database.query<{ id: string; target_kind: EvaluationTargetKind;
        dataset_revision_id: string | null; rubric_revision_id: string | null; action: EvaluationLifecycleEvent['action'];
        actor: EvaluationLifecycleEvent['actor']; reason: string; created_at: unknown }>(
        `SELECT id, target_kind, dataset_revision_id, rubric_revision_id, action, actor, reason, created_at
         FROM evaluation_lifecycle_events WHERE ${column} = $1 ORDER BY created_at, id`, [revisionId]);
      return result.rows.map(row => ({ id: row.id, targetKind: row.target_kind,
        revisionId: (targetKind === 'dataset' ? row.dataset_revision_id : row.rubric_revision_id)!,
        action: row.action, actor: row.actor, reason: row.reason, createdAt: iso(row.created_at) }));
    } catch (error) {
      return failure(error);
    }
  }

  private async insertEvent(client: PoolClient, event: EvaluationLifecycleEvent): Promise<void> {
    await client.query(`INSERT INTO evaluation_lifecycle_events
      (id, target_kind, dataset_revision_id, rubric_revision_id, action, actor, reason, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [event.id, event.targetKind, event.targetKind === 'dataset' ? event.revisionId : null,
      event.targetKind === 'rubric' ? event.revisionId : null, event.action, event.actor,
      event.reason, event.createdAt]);
  }
}
