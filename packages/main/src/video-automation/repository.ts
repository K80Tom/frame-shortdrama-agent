import { isDeepStrictEqual } from 'node:util';
import type { PostgresDatabase } from '../db/client';
import { activeVideoStates, VideoAutomationError, type StoredVideoRun } from './contracts';

export interface VideoAutomationRepository {
  list(): Promise<StoredVideoRun[]>;
  get(id: string): Promise<StoredVideoRun | null>;
  getByClientRequestId(id: string): Promise<StoredVideoRun | null>;
  create(run: StoredVideoRun): Promise<StoredVideoRun>;
  replace(run: StoredVideoRun, expectedVersion: number): Promise<StoredVideoRun>;
}
const copy = <T>(value: T): T => structuredClone(value);
const mutable = ['status', 'providerTaskId', 'result', 'error', 'errorNode', 'reconciliationAttempts', 'version', 'updatedAt'];
function immutable(run: StoredVideoRun) { return Object.fromEntries(Object.entries(run).filter(([key]) => !mutable.includes(key))); }
function busy(): never { throw new VideoAutomationError(409, 'VIDEO_BUSY', '已有视频任务正在排队、提交或生成，请等待它完成。'); }
function conflict(): never { throw new VideoAutomationError(409, 'VIDEO_RUN_CONFLICT', '任务状态已变化，请重新读取；不会重复提交。'); }
function persistence(): never { throw new VideoAutomationError(503, 'VIDEO_PERSISTENCE_UNAVAILABLE', '视频任务存储未就绪，请检查本地数据库和 014 迁移。'); }
function failure(error: unknown): never {
  if (error instanceof VideoAutomationError) throw error;
  if (error && typeof error === 'object' && 'code' in error && error.code === '23505'
    && 'constraint' in error && error.constraint === 'video_automation_single_active') busy();
  return persistence();
}

export class MemoryVideoAutomationRepository implements VideoAutomationRepository {
  private readonly runs = new Map<string, StoredVideoRun>();
  async list() { return [...this.runs.values()].map(copy).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)); }
  async get(id: string) { return copy(this.runs.get(id) ?? null); }
  async getByClientRequestId(id: string) { return copy([...this.runs.values()].find(run => run.clientRequestId === id) ?? null); }
  async create(run: StoredVideoRun) {
    const same = [...this.runs.values()].find(item => item.clientRequestId === run.clientRequestId);
    if (same) return copy(same);
    if ([...this.runs.values()].some(item => activeVideoStates.includes(item.status))) busy();
    if (this.runs.has(run.id)) conflict();
    this.runs.set(run.id, copy(run)); return copy(run);
  }
  async replace(run: StoredVideoRun, expectedVersion: number) {
    const current = this.runs.get(run.id);
    if (!current || current.version !== expectedVersion || !isDeepStrictEqual(immutable(current), immutable(run))) conflict();
    if (activeVideoStates.includes(run.status) && [...this.runs.values()].some(item => item.id !== run.id && activeVideoStates.includes(item.status))) busy();
    const next = { ...copy(run), version: expectedVersion + 1 };
    this.runs.set(run.id, next); return copy(next);
  }
}

export class PostgresVideoAutomationRepository implements VideoAutomationRepository {
  constructor(private readonly db: PostgresDatabase) {}
  async list() {
    try { return (await this.db.query<{run_json: StoredVideoRun}>('SELECT run_json FROM video_automation_runs ORDER BY created_at DESC,id DESC')).rows.map(row => copy(row.run_json)); }
    catch (error) { return failure(error); }
  }
  async get(id: string) {
    try { return copy((await this.db.query<{run_json: StoredVideoRun}>('SELECT run_json FROM video_automation_runs WHERE id=$1', [id])).rows[0]?.run_json ?? null); }
    catch (error) { return failure(error); }
  }
  async getByClientRequestId(id: string) {
    try { return copy((await this.db.query<{run_json: StoredVideoRun}>('SELECT run_json FROM video_automation_runs WHERE client_request_id=$1', [id])).rows[0]?.run_json ?? null); }
    catch (error) { return failure(error); }
  }
  async create(run: StoredVideoRun) {
    try { return await this.db.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('shortdrama:video-automation-create'))");
      const same = await client.query<{run_json: StoredVideoRun}>('SELECT run_json FROM video_automation_runs WHERE client_request_id=$1', [run.clientRequestId]);
      if (same.rows[0]) return copy(same.rows[0].run_json);
      const active = await client.query('SELECT id FROM video_automation_runs WHERE status=ANY($1::text[])', [activeVideoStates]);
      if (active.rowCount) busy();
      await client.query(`INSERT INTO video_automation_runs
        (id,client_request_id,status,provider_task_id,version,run_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [run.id, run.clientRequestId, run.status, run.providerTaskId, run.version, run, run.createdAt, run.updatedAt]);
      return copy(run);
    }); } catch (error) { return failure(error); }
  }
  async replace(run: StoredVideoRun, expectedVersion: number) {
    const next = { ...copy(run), version: expectedVersion + 1 };
    try {
      const result = await this.db.query(`UPDATE video_automation_runs SET status=$2,provider_task_id=$3,
        version=$4,run_json=$5,updated_at=$6 WHERE id=$1 AND version=$7
        AND (run_json - $8::text[]) = ($5::jsonb - $8::text[])`,
      [next.id, next.status, next.providerTaskId, next.version, next, next.updatedAt, expectedVersion, mutable]);
      if (result.rowCount !== 1) conflict();
      return next;
    } catch (error) { return failure(error); }
  }
}
