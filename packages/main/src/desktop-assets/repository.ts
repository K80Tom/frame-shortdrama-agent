import { isDeepStrictEqual } from 'node:util';
import type { PostgresDatabase } from '../db/client';
import { NovelError } from '@ohao/shared';
import type { NovelAssetLinkAuthorization, NovelAssetLinkPolicy } from '../novel/service';
import type { AssetService } from '../assets/service';
import { activeStates, desktopError, generatedAssetTaskId, type StoredAssetGenerationCandidate, type StoredDesktopTask } from './contracts';

export interface DesktopTaskRepository {
  list(chapterId?: string): Promise<StoredDesktopTask[]>;
  get(id: string): Promise<StoredDesktopTask | null>;
  getTaskByAsset(assetId: string): Promise<StoredDesktopTask | null>;
  create(task: StoredDesktopTask): Promise<StoredDesktopTask>;
  replace(task: StoredDesktopTask, expectedVersion: number): Promise<StoredDesktopTask>;
  listCandidates(chapterId?: string): Promise<StoredAssetGenerationCandidate[]>;
  getCandidateByTask(taskId: string): Promise<StoredAssetGenerationCandidate | null>;
  getCandidateByAsset(assetId: string): Promise<StoredAssetGenerationCandidate | null>;
  appendCandidate(candidate: StoredAssetGenerationCandidate): Promise<StoredAssetGenerationCandidate>;
  replaceCandidate(candidate: StoredAssetGenerationCandidate, expectedVersion: number): Promise<StoredAssetGenerationCandidate>;
}
const copy = <T>(value: T): T => structuredClone(value);
function busy(): never { return desktopError(409, 'DESKTOP_BUSY', '已有生图任务正在排队、提交、生成或导入，请等待完成；不会并行处理或重复生图。'); }
function conflict(): never { return desktopError(409, 'DESKTOP_TASK_CONFLICT', '任务状态已经变化，请重新读取；不会重复提交。'); }
function candidateConflict(): never { return desktopError(409, 'ASSET_CANDIDATE_CONFLICT', '候选审核状态已经变化，请重新读取；未覆盖现有决定。'); }
function persistence(): never { return desktopError(503, 'DESKTOP_PERSISTENCE_UNAVAILABLE', '资产生成记录暂时无法读取或保存，请检查本地数据库及 013 迁移。'); }
function activeConstraint(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505'
    && 'constraint' in error && error.constraint === 'desktop_asset_single_active');
}
export class MemoryDesktopTaskRepository implements DesktopTaskRepository {
  private readonly tasks = new Map<string, StoredDesktopTask>();
  private readonly candidates = new Map<string, StoredAssetGenerationCandidate>();
  async list(chapterId?: string) { return [...this.tasks.values()].filter(t => !chapterId || t.chapterId === chapterId).map(copy).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)); }
  async get(id: string) { return copy(this.tasks.get(id) ?? null); }
  async getTaskByAsset(assetId: string) {
    return copy([...this.tasks.values()].find(task => task.assetId === assetId) ?? null);
  }
  async create(task: StoredDesktopTask) {
    const same = [...this.tasks.values()].find(t => t.jobKey === task.jobKey);
    if (same) return copy(same);
    if ([...this.tasks.values()].some(t => activeStates.includes(t.status))) busy();
    this.tasks.set(task.id, copy(task)); return copy(task);
  }
  async replace(task: StoredDesktopTask, expectedVersion: number) {
    if (this.tasks.get(task.id)?.version !== expectedVersion) conflict();
    if (activeStates.includes(task.status) && [...this.tasks.values()].some(t => t.id !== task.id && activeStates.includes(t.status))) busy();
    const next = {...copy(task), version: expectedVersion + 1}; this.tasks.set(task.id, next); return copy(next);
  }
  async listCandidates(chapterId?: string) {
    return [...this.candidates.values()].filter(c => !chapterId || c.chapterId === chapterId).map(copy)
      .sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  async getCandidateByTask(taskId: string) {
    return copy([...this.candidates.values()].find(candidate => candidate.taskId === taskId) ?? null);
  }
  async getCandidateByAsset(assetId: string) {
    return copy([...this.candidates.values()].find(candidate => candidate.assetId === assetId) ?? null);
  }
  async appendCandidate(candidate: StoredAssetGenerationCandidate) {
    const existing = [...this.candidates.values()].find(value => value.taskId === candidate.taskId);
    if (existing) {
      if (existing.assetId !== candidate.assetId || existing.chapterId !== candidate.chapterId
        || existing.itemId !== candidate.itemId || !isDeepStrictEqual(existing.provenance, candidate.provenance)) candidateConflict();
      return copy(existing);
    }
    if (this.candidates.has(candidate.id)) candidateConflict();
    this.candidates.set(candidate.id, copy(candidate)); return copy(candidate);
  }
  async replaceCandidate(candidate: StoredAssetGenerationCandidate, expectedVersion: number) {
    const current = this.candidates.get(candidate.id);
    if (current?.version !== expectedVersion) candidateConflict();
    const immutable = (value: StoredAssetGenerationCandidate) => ({id: value.id, taskId: value.taskId,
      assetId: value.assetId, chapterId: value.chapterId, itemId: value.itemId,
      provenance: value.provenance, createdAt: value.createdAt});
    if (!isDeepStrictEqual(immutable(current), immutable(candidate))) candidateConflict();
    const next = {...copy(current), status: candidate.status, reviewNote: candidate.reviewNote,
      acceptedRevisionId: candidate.acceptedRevisionId, updatedAt: candidate.updatedAt, version: expectedVersion + 1};
    this.candidates.set(candidate.id, next); return copy(next);
  }
}

interface CandidateRow {
  id: string; task_id: string; asset_id: string; chapter_id: string; item_id: string;
  status: StoredAssetGenerationCandidate['status']; version: number;
  provenance_json: StoredAssetGenerationCandidate['provenance']; review_note: string;
  accepted_revision_id: string | null; created_at: Date | string; updated_at: Date | string;
}
function time(value: Date | string): string {
  const result = value instanceof Date ? value.toISOString() : value;
  if (typeof result !== 'string' || !Number.isFinite(Date.parse(result))) persistence();
  return result;
}
function fromCandidateRow(row: CandidateRow): StoredAssetGenerationCandidate {
  return copy({id: row.id, taskId: row.task_id, assetId: row.asset_id, chapterId: row.chapter_id,
    itemId: row.item_id, status: row.status, version: row.version, provenance: row.provenance_json,
    reviewNote: row.review_note, acceptedRevisionId: row.accepted_revision_id,
    createdAt: time(row.created_at), updatedAt: time(row.updated_at)});
}

export class PostgresDesktopTaskRepository implements DesktopTaskRepository {
  constructor(private readonly db: PostgresDatabase) {}
  async list(chapterId?: string) {
    try {
      const result = await this.db.query<{task_json: StoredDesktopTask}>(
        `SELECT task_json FROM desktop_asset_jobs ${chapterId ? 'WHERE chapter_id=$1' : ''} ORDER BY created_at DESC`, chapterId ? [chapterId] : []);
      return result.rows.map(row => copy(row.task_json));
    } catch { return persistence(); }
  }
  async get(id: string) {
    try {
      const result = await this.db.query<{task_json: StoredDesktopTask}>('SELECT task_json FROM desktop_asset_jobs WHERE id=$1', [id]);
      return result.rows[0] ? copy(result.rows[0].task_json) : null;
    } catch { return persistence(); }
  }
  async getTaskByAsset(assetId: string) {
    try {
      const result = await this.db.query<{task_json: StoredDesktopTask}>(
        "SELECT task_json FROM desktop_asset_jobs WHERE task_json->>'assetId'=$1 LIMIT 1", [assetId]);
      return result.rows[0] ? copy(result.rows[0].task_json) : null;
    } catch { return persistence(); }
  }
  async create(task: StoredDesktopTask) {
    try { return await this.db.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('shortdrama:desktop-asset-create'))");
      const same = await client.query<{task_json: StoredDesktopTask}>('SELECT task_json FROM desktop_asset_jobs WHERE job_key=$1', [task.jobKey]);
      if (same.rows[0]) return copy(same.rows[0].task_json);
      const active = await client.query('SELECT id FROM desktop_asset_jobs WHERE status=ANY($1::text[])', [activeStates]);
      if (active.rowCount) busy();
      await client.query('INSERT INTO desktop_asset_jobs(id,job_key,chapter_id,status,version,task_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [task.id, task.jobKey, task.chapterId, task.status, task.version, task, task.createdAt, task.updatedAt]);
      return copy(task);
    }); } catch (error) {
      if (activeConstraint(error)) busy();
      if (error instanceof NovelError) throw error;
      return persistence();
    }
  }
  async replace(task: StoredDesktopTask, expectedVersion: number) {
    const next = {...copy(task), version: expectedVersion + 1};
    try {
      const result = await this.db.query('UPDATE desktop_asset_jobs SET status=$2,version=$3,task_json=$4,updated_at=$5 WHERE id=$1 AND version=$6',
        [next.id, next.status, next.version, next, next.updatedAt, expectedVersion]);
      if (result.rowCount !== 1) conflict();
      return next;
    } catch (error) {
      if (activeConstraint(error)) busy();
      if (error instanceof NovelError) throw error;
      return persistence();
    }
  }
  async listCandidates(chapterId?: string) {
    try {
      const result = await this.db.query<CandidateRow>(
        `SELECT * FROM asset_generation_candidates ${chapterId ? 'WHERE chapter_id=$1' : ''} ORDER BY created_at DESC`, chapterId ? [chapterId] : []);
      return result.rows.map(fromCandidateRow);
    } catch { return persistence(); }
  }
  async getCandidateByTask(taskId: string) {
    try {
      const result = await this.db.query<CandidateRow>('SELECT * FROM asset_generation_candidates WHERE task_id=$1', [taskId]);
      return result.rows[0] ? fromCandidateRow(result.rows[0]) : null;
    } catch { return persistence(); }
  }
  async getCandidateByAsset(assetId: string) {
    try {
      const result = await this.db.query<CandidateRow>('SELECT * FROM asset_generation_candidates WHERE asset_id=$1', [assetId]);
      return result.rows[0] ? fromCandidateRow(result.rows[0]) : null;
    } catch { return persistence(); }
  }
  async appendCandidate(candidate: StoredAssetGenerationCandidate) {
    try {
      const inserted = await this.db.query<CandidateRow>(`INSERT INTO asset_generation_candidates
        (id,task_id,asset_id,chapter_id,item_id,status,version,provenance_json,review_note,accepted_revision_id,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(task_id) DO NOTHING RETURNING *`,
      [candidate.id, candidate.taskId, candidate.assetId, candidate.chapterId, candidate.itemId, candidate.status,
        candidate.version, candidate.provenance, candidate.reviewNote, candidate.acceptedRevisionId,
        candidate.createdAt, candidate.updatedAt]);
      if (inserted.rows[0]) return fromCandidateRow(inserted.rows[0]);
      const existing = await this.getCandidateByTask(candidate.taskId);
      if (!existing || existing.assetId !== candidate.assetId || existing.chapterId !== candidate.chapterId
        || existing.itemId !== candidate.itemId || !isDeepStrictEqual(existing.provenance, candidate.provenance)) candidateConflict();
      return existing;
    } catch (error) {
      if (error instanceof NovelError) throw error;
      return persistence();
    }
  }
  async replaceCandidate(candidate: StoredAssetGenerationCandidate, expectedVersion: number) {
    const next = {...copy(candidate), version: expectedVersion + 1};
    try {
      const result = await this.db.query<CandidateRow>(`UPDATE asset_generation_candidates
        SET status=$2,version=$3,review_note=$4,accepted_revision_id=$5,updated_at=$6
        WHERE id=$1 AND version=$7 RETURNING *`,
      [next.id, next.status, next.version, next.reviewNote, next.acceptedRevisionId, next.updatedAt, expectedVersion]);
      if (!result.rows[0]) candidateConflict();
      return fromCandidateRow(result.rows[0]);
    } catch (error) {
      if (error instanceof NovelError) throw error;
      return persistence();
    }
  }
}

/** Prevents the ordinary novel-binding endpoint from turning an unreviewed
 * generated catalogue entry into an active reference. Manual/imported assets
 * have no candidate row and remain unaffected. */
export class DesktopCandidateAssetPolicy implements NovelAssetLinkPolicy {
  constructor(private readonly repository: DesktopTaskRepository, private readonly assets: AssetService) {}
  async assertCanLink(assetIds: readonly string[], authorization?: NovelAssetLinkAuthorization): Promise<void> {
    for (const assetId of new Set(assetIds)) {
      const candidate = await this.repository.getCandidateByAsset(assetId);
      if (candidate) {
        if (candidate.status === 'accepted') continue;
        const internalDecision = authorization?.candidateId === candidate.id
          && (candidate.status === 'awaitingReview' || candidate.status === 'needsReview');
        if (internalDecision) continue;
        this.reviewRequired();
      }
      // The task pointer covers normal generated records. The immutable
      // catalogue marker is committed with the media first, so it also closes
      // the asset-created/candidate-or-task-pointer-not-yet-created window.
      if (await this.repository.getTaskByAsset(assetId)) this.reviewRequired();
      const asset = await this.assets.get(assetId);
      if (generatedAssetTaskId(asset)) this.reviewRequired();
    }
  }
  private reviewRequired(): never {
    throw new NovelError(409, 'GENERATED_ASSET_REVIEW_REQUIRED',
      '生成候选必须先在候选审核中明确接受，不能通过普通资产关联绕过审核。');
  }
}
