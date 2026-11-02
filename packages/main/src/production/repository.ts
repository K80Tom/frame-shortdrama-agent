import type { PostgresDatabase } from '../db/client';
import { isDeepStrictEqual } from 'node:util';
import { CREATE_KEYS, ProductionError, type StoredProductionRun } from '@lyra/shared';

export interface ProductionRepository {
  list(): Promise<StoredProductionRun[]>;
  get(id: string): Promise<StoredProductionRun | null>;
  getByClientRequestId(clientRequestId: string): Promise<StoredProductionRun | null>;
  create(run: StoredProductionRun): Promise<StoredProductionRun>;
  replace(run: StoredProductionRun, expectedVersion: number): Promise<StoredProductionRun>;
}

const clone = <T>(value: T): T => structuredClone(value);
function conflict(): never {
  throw new ProductionError(409, 'PRODUCTION_RUN_CONFLICT', '生产运行已被其他操作更新，请重新读取。');
}
function unavailable(): never {
  throw new ProductionError(503, 'PRODUCTION_PERSISTENCE_UNAVAILABLE', '生产总控存储未就绪，请检查本地数据库和 015 迁移。');
}
function validateStored(value: unknown): StoredProductionRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
  const run = value as StoredProductionRun;
  if (!/^production_[a-f0-9]{32}$/u.test(run.id) || !Number.isInteger(run.version) || run.version < 0
    || !Array.isArray(run.tasks) || !Array.isArray(run.outbox) || !Array.isArray(run.issues)
    || !Array.isArray(run.attempts) || !Array.isArray(run.artifacts) || !Array.isArray(run.candidateSets)
    || !Array.isArray(run.qualityChecks) || !Array.isArray(run.reviews) || !Array.isArray(run.timeline)
    || !Array.isArray(run.budgetLedger) || !Array.isArray(run.externalOperations)) return unavailable();
  return clone(run);
}
function immutableEqual(a: StoredProductionRun, b: StoredProductionRun): boolean {
  // budgetMicros is deliberately excluded here: the only sanctioned in-place
  // mutation is the audited 'raiseBudget' action (outbox: production.run.budget_raised).
  // Create-time request matching still compares it, so reusing a clientRequestId
  // with a different budget keeps failing with PRODUCTION_REQUEST_REUSED.
  const frozen = CREATE_KEYS.filter(key => key !== 'budgetMicros');
  return a.id === b.id && a.createdAt === b.createdAt && a.workflowVersion === b.workflowVersion
    && isDeepStrictEqual(a.methodPacks, b.methodPacks)
    && a.assetRetrievalPolicy?.policyDigest === b.assetRetrievalPolicy?.policyDigest
    && a.assetRetrievalPolicy?.registryRevision === b.assetRetrievalPolicy?.registryRevision
    && a.assetRetrievalPolicy?.sourceCandidateId === b.assetRetrievalPolicy?.sourceCandidateId
    && frozen.every(key => a[key] === b[key]);
}

export class MemoryProductionRepository implements ProductionRepository {
  private readonly runs = new Map<string, StoredProductionRun>();
  async list() { return [...this.runs.values()].map(validateStored).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)); }
  async get(id: string) { const run = this.runs.get(id); return run ? validateStored(run) : null; }
  async getByClientRequestId(clientRequestId: string) {
    const run = [...this.runs.values()].find(item => item.clientRequestId === clientRequestId);
    return run ? validateStored(run) : null;
  }
  async create(input: StoredProductionRun) {
    const run = validateStored(input);
    const existing = [...this.runs.values()].find(item => item.clientRequestId === run.clientRequestId);
    if (existing) return validateStored(existing);
    if (this.runs.has(run.id)) conflict();
    this.runs.set(run.id, clone(run)); return clone(run);
  }
  async replace(input: StoredProductionRun, expectedVersion: number) {
    const run = validateStored(input); const current = this.runs.get(run.id);
    if (!current || current.version !== expectedVersion || run.version !== expectedVersion || !immutableEqual(current, run)) conflict();
    const next = { ...clone(run), version: expectedVersion + 1 };
    this.runs.set(next.id, next); return clone(next);
  }
}

interface RunRow { run_json: unknown }
function databaseFailure(error: unknown): never {
  if (error instanceof ProductionError) throw error;
  return unavailable();
}

export class PostgresProductionRepository implements ProductionRepository {
  constructor(private readonly database: PostgresDatabase) {}
  async list() {
    try {
      const rows = await this.database.query<RunRow>('SELECT run_json FROM production_runs ORDER BY created_at DESC, id COLLATE "C" DESC');
      return rows.rows.map(row => validateStored(row.run_json));
    } catch (error) { return databaseFailure(error); }
  }
  async get(id: string) {
    try {
      const row = (await this.database.query<RunRow>('SELECT run_json FROM production_runs WHERE id=$1', [id])).rows[0];
      return row ? validateStored(row.run_json) : null;
    } catch (error) { return databaseFailure(error); }
  }
  async getByClientRequestId(clientRequestId: string) {
    try {
      const row = (await this.database.query<RunRow>('SELECT run_json FROM production_runs WHERE client_request_id=$1', [clientRequestId])).rows[0];
      return row ? validateStored(row.run_json) : null;
    } catch (error) { return databaseFailure(error); }
  }
  async create(input: StoredProductionRun) {
    const run = validateStored(input);
    try {
      return await this.database.transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('shortdrama:production:' || $1::text))", [run.clientRequestId]);
        const existing = await client.query<RunRow>('SELECT run_json FROM production_runs WHERE client_request_id=$1', [run.clientRequestId]);
        if (existing.rows[0]) return validateStored(existing.rows[0].run_json);
        await client.query(`INSERT INTO production_runs
          (id,client_request_id,project_id,script_version_id,status,version,run_json,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [run.id, run.clientRequestId, run.projectId, run.scriptVersionId, run.status, run.version, run, run.createdAt, run.updatedAt]);
        for (const event of run.outbox) {
          await client.query(`INSERT INTO production_outbox_events
            (id,run_id,sequence,event_type,payload_json,created_at) VALUES($1,$2,$3,$4,$5,$6)`,
          [event.id, event.runId, event.sequence, event.type, event.payload, event.createdAt]);
        }
        return clone(run);
      });
    } catch (error) { return databaseFailure(error); }
  }
  async replace(input: StoredProductionRun, expectedVersion: number) {
    const run = validateStored(input);
    try {
      return await this.database.transaction(async client => {
        const selected = await client.query<RunRow>('SELECT run_json FROM production_runs WHERE id=$1 FOR UPDATE', [run.id]);
        const current = selected.rows[0] ? validateStored(selected.rows[0].run_json) : null;
        if (!current || current.version !== expectedVersion || run.version !== expectedVersion || !immutableEqual(current, run)) conflict();
        const next = { ...clone(run), version: expectedVersion + 1 };
        const updated = await client.query(`UPDATE production_runs SET status=$2,version=$3,run_json=$4,updated_at=$5
          WHERE id=$1 AND version=$6`, [next.id, next.status, next.version, next, next.updatedAt, expectedVersion]);
        if (updated.rowCount !== 1) conflict();
        const currentEvents = new Set(current.outbox.map(event => event.id));
        for (const event of next.outbox.filter(event => !currentEvents.has(event.id))) {
          await client.query(`INSERT INTO production_outbox_events
            (id,run_id,sequence,event_type,payload_json,created_at) VALUES($1,$2,$3,$4,$5,$6)`,
          [event.id, event.runId, event.sequence, event.type, event.payload, event.createdAt]);
        }
        return next;
      });
    } catch (error) { return databaseFailure(error); }
  }
}
