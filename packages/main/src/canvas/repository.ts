import type { PoolClient } from 'pg';
import {
  canvasError, type CanvasBaseline, type CanvasCommandBatch, type CanvasCommandReceipt,
  type CanvasDocument, type CanvasGraph, type CanvasRevision, type CanvasRevisionStatus,
} from '@lyra/shared';
import type { PostgresDatabase } from '../db/client';
import { cloneGraph, parseGraph, sha256Digest } from './graph';

interface DocumentRow {
  id: string;
  workspace_id: string;
  project_id: string;
  title: string;
  adopted_revision_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
  latest_revision?: number | string;
}

interface RevisionRow {
  id: string;
  document_id: string;
  revision: number | string;
  base_revision_id: string | null;
  workspace_id: string;
  project_id: string;
  schema_version: number | string;
  status: CanvasRevisionStatus;
  semantic_digest: string;
  layout_digest: string;
  content_digest: string;
  baseline_json: unknown;
  graph_json: unknown;
  reader_version: number | string;
  created_by: string;
  created_at: Date | string;
  adopted_by: string | null;
  adopted_at: Date | string | null;
}

interface CommandRow { receipt_json: unknown }

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toDocument(row: DocumentRow): CanvasDocument {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    title: row.title,
    adoptedRevisionId: row.adopted_revision_id ?? null,
    latestRevision: Number(row.latest_revision ?? 0),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    archivedAt: iso(row.archived_at),
  };
}

function parseBaseline(value: unknown): CanvasBaseline {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const text = (key: string) => (typeof record[key] === 'string' ? record[key] as string : null);
  return {
    scriptVersionId: text('scriptVersionId'),
    planRevisionId: text('planRevisionId'),
    storyboardRevisionId: text('storyboardRevisionId'),
    productionInputSnapshotId: text('productionInputSnapshotId'),
    productionInputDigest: text('productionInputDigest'),
  };
}

function toRevision(row: RevisionRow): CanvasRevision {
  return {
    id: row.id,
    documentId: row.document_id,
    revision: Number(row.revision),
    baseRevisionId: row.base_revision_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    schemaVersion: Number(row.schema_version),
    status: row.status,
    semanticGraphDigest: row.semantic_digest,
    layoutDigest: row.layout_digest,
    contentDigest: row.content_digest,
    baseline: parseBaseline(row.baseline_json),
    createdBy: row.created_by,
    createdAt: iso(row.created_at)!,
    adoptedBy: row.adopted_by,
    adoptedAt: iso(row.adopted_at),
    readerVersion: Number(row.reader_version),
    graph: parseGraph(row.graph_json, row.workspace_id, row.project_id),
  };
}

function databaseFailure(error: unknown): never {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: string }).code);
    if (code === '23505') throw canvasError('canvas_revision_conflict', '画布版本已变化，请读取最新版本后重试。');
    if (code === '42501') throw canvasError('canvas_foreign_reference', '画布操作超出当前 workspace 的权限范围。');
    if (code === '42P01') {
      throw canvasError('canvas_persistence_unavailable', '生产画布尚未就绪：请应用 032 迁移并重启后端。');
    }
  }
  throw error;
}

export interface CreateDocumentInput {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  createdBy: string;
  graph: CanvasGraph;
  baseline: CanvasBaseline;
  digests: { semanticGraphDigest: string; layoutDigest: string; contentDigest: string };
}

export interface CreateRevisionInput {
  id: string;
  documentId: string;
  expectedRevision: number;
  baseRevisionId: string | null;
  createdBy: string;
  graph: CanvasGraph;
  baseline: CanvasBaseline;
  digests: { semanticGraphDigest: string; layoutDigest: string; contentDigest: string };
}

export class PostgresCanvasStore {
  constructor(private readonly database: PostgresDatabase) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(work);
    } catch (error) {
      return databaseFailure(error);
    }
  }

  async listDocuments(projectId: string): Promise<CanvasDocument[]> {
    try {
      const rows = await this.database.query<DocumentRow>(`
        SELECT d.*, COALESCE((SELECT max(revision) FROM canvas_revisions r WHERE r.document_id = d.id), 0) AS latest_revision
        FROM canvas_documents d
        WHERE d.project_id = $1 AND d.archived_at IS NULL
        ORDER BY d.updated_at DESC, d.id COLLATE "C" DESC`, [projectId]);
      return rows.rows.map(toDocument);
    } catch (error) { return databaseFailure(error); }
  }

  async getDocument(documentId: string): Promise<CanvasDocument | null> {
    try {
      const rows = await this.database.query<DocumentRow>(`
        SELECT d.*, COALESCE((SELECT max(revision) FROM canvas_revisions r WHERE r.document_id = d.id), 0) AS latest_revision
        FROM canvas_documents d WHERE d.id = $1`, [documentId]);
      return rows.rows[0] ? toDocument(rows.rows[0]) : null;
    } catch (error) { return databaseFailure(error); }
  }

  async createDocument(input: CreateDocumentInput): Promise<CanvasDocument> {
    return this.transaction(async client => {
      const existing = await client.query<DocumentRow>(`
        SELECT d.*, COALESCE((SELECT max(revision) FROM canvas_revisions r WHERE r.document_id = d.id), 0) AS latest_revision
        FROM canvas_documents d
        WHERE d.workspace_id = $1 AND d.project_id = $2 AND d.title = $3`,
      [input.workspaceId, input.projectId, input.title]);
      if (existing.rows[0]) return toDocument(existing.rows[0]);

      await client.query(`
        INSERT INTO canvas_documents (id, workspace_id, project_id, title, created_by)
        VALUES ($1, $2, $3, $4, $5)`,
      [input.id, input.workspaceId, input.projectId, input.title, input.createdBy]);
      await this.insertRevision(client, {
        id: `${input.id}_r1`, documentId: input.id, revision: 1, baseRevisionId: null,
        workspaceId: input.workspaceId, projectId: input.projectId, status: 'draft',
        graph: input.graph, baseline: input.baseline, digests: input.digests, createdBy: input.createdBy,
      });
      await this.appendEvent(client, {
        workspaceId: input.workspaceId, projectId: input.projectId, documentId: input.id,
        revisionId: `${input.id}_r1`, type: 'canvas.document.created',
        payload: { title: input.title, shotCount: input.graph.nodes.length },
      });
      const created = await client.query<DocumentRow>(`
        SELECT d.*, 1 AS latest_revision FROM canvas_documents d WHERE d.id = $1`, [input.id]);
      return toDocument(created.rows[0]!);
    });
  }

  private async insertRevision(client: PoolClient, input: {
    id: string; documentId: string; revision: number; baseRevisionId: string | null;
    workspaceId: string; projectId: string; status: CanvasRevisionStatus;
    graph: CanvasGraph; baseline: CanvasBaseline;
    digests: { semanticGraphDigest: string; layoutDigest: string; contentDigest: string };
    createdBy: string; adoptedBy?: string | null;
  }): Promise<void> {
    await client.query(`
      INSERT INTO canvas_revisions
        (id, document_id, revision, base_revision_id, workspace_id, project_id, schema_version, status,
         semantic_digest, layout_digest, content_digest, baseline_json, graph_json, reader_version,
         created_by, adopted_by, adopted_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      input.id, input.documentId, input.revision, input.baseRevisionId, input.workspaceId, input.projectId,
      input.graph.schemaVersion, input.status, input.digests.semanticGraphDigest, input.digests.layoutDigest,
      input.digests.contentDigest, input.baseline, input.graph, 1, input.createdBy,
      input.adoptedBy ?? null, input.adoptedBy ? new Date().toISOString() : null,
    ]);
  }

  async createRevision(input: CreateRevisionInput): Promise<CanvasRevision> {
    return this.transaction(async client => {
      const document = await client.query<DocumentRow>(
        'SELECT * FROM canvas_documents WHERE id = $1 FOR UPDATE', [input.documentId]);
      if (!document.rows[0]) throw canvasError('canvas_not_found', '画布不存在。');
      const latest = await client.query<{ revision: number | string }>(
        'SELECT max(revision) AS revision FROM canvas_revisions WHERE document_id = $1', [input.documentId]);
      const currentRevision = Number(latest.rows[0]?.revision ?? 0);
      if (currentRevision !== input.expectedRevision) {
        throw canvasError('canvas_revision_conflict', '画布已被其他操作更新，请重新读取后再保存。', {
          expectedRevision: input.expectedRevision, currentRevision,
        });
      }
      const nextRevision = currentRevision + 1;
      const base = await client.query<RevisionRow>(
        'SELECT * FROM canvas_revisions WHERE document_id = $1 AND revision = $2',
        [input.documentId, input.expectedRevision]);
      const baseRow = base.rows[0];
      await this.insertRevision(client, {
        id: input.id, documentId: input.documentId, revision: nextRevision,
        baseRevisionId: input.baseRevisionId ?? baseRow?.id ?? null,
        workspaceId: document.rows[0].workspace_id, projectId: document.rows[0].project_id,
        status: 'draft', graph: input.graph, baseline: input.baseline, digests: input.digests,
        createdBy: input.createdBy,
      });
      await client.query('UPDATE canvas_documents SET updated_at = clock_timestamp() WHERE id = $1', [input.documentId]);
      await this.appendEvent(client, {
        workspaceId: document.rows[0].workspace_id, projectId: document.rows[0].project_id,
        documentId: input.documentId, revisionId: input.id, type: 'canvas.revision.created',
        payload: { revision: nextRevision, baseRevision: input.expectedRevision },
      });
      const created = await client.query<RevisionRow>('SELECT * FROM canvas_revisions WHERE id = $1', [input.id]);
      return toRevision(created.rows[0]!);
    });
  }

  async getRevision(documentId: string, revision: number): Promise<CanvasRevision | null> {
    try {
      const rows = await this.database.query<RevisionRow>(
        'SELECT * FROM canvas_revisions WHERE document_id = $1 AND revision = $2', [documentId, revision]);
      return rows.rows[0] ? toRevision(rows.rows[0]) : null;
    } catch (error) { return databaseFailure(error); }
  }

  async getRevisionById(documentId: string, revisionId: string): Promise<CanvasRevision | null> {
    try {
      const rows = await this.database.query<RevisionRow>(
        'SELECT * FROM canvas_revisions WHERE document_id = $1 AND id = $2', [documentId, revisionId]);
      return rows.rows[0] ? toRevision(rows.rows[0]) : null;
    } catch (error) { return databaseFailure(error); }
  }

  async latestRevision(documentId: string): Promise<CanvasRevision | null> {
    try {
      const rows = await this.database.query<RevisionRow>(
        'SELECT * FROM canvas_revisions WHERE document_id = $1 ORDER BY revision DESC LIMIT 1', [documentId]);
      return rows.rows[0] ? toRevision(rows.rows[0]) : null;
    } catch (error) { return databaseFailure(error); }
  }

  async listRevisions(documentId: string, limit: number): Promise<CanvasRevision[]> {
    try {
      const rows = await this.database.query<RevisionRow>(
        'SELECT * FROM canvas_revisions WHERE document_id = $1 ORDER BY revision DESC LIMIT $2',
        [documentId, limit]);
      return rows.rows.map(toRevision);
    } catch (error) { return databaseFailure(error); }
  }

  async findCommand(documentId: string, clientRequestId: string): Promise<CanvasCommandReceipt | null> {
    try {
      const rows = await this.database.query<CommandRow>(
        'SELECT receipt_json FROM canvas_commands WHERE document_id = $1 AND client_request_id = $2',
        [documentId, clientRequestId]);
      return rows.rows[0] ? rows.rows[0].receipt_json as CanvasCommandReceipt : null;
    } catch (error) { return databaseFailure(error); }
  }

  async recordCommand(input: {
    id: string; documentId: string; revisionId: string; clientRequestId: string; actor: string;
    expectedRevision: number; batch: CanvasCommandBatch; receipt: CanvasCommandReceipt;
  }): Promise<{ receipt: CanvasCommandReceipt; replay: boolean }> {
    return this.transaction(async client => {
      const existing = await client.query<CommandRow>(
        'SELECT receipt_json FROM canvas_commands WHERE document_id = $1 AND client_request_id = $2',
        [input.documentId, input.clientRequestId]);
      if (existing.rows[0]) {
        return { receipt: existing.rows[0].receipt_json as CanvasCommandReceipt, replay: true };
      }
      const document = await client.query<DocumentRow>('SELECT workspace_id, project_id FROM canvas_documents WHERE id = $1', [input.documentId]);
      if (!document.rows[0]) throw canvasError('canvas_not_found', '画布不存在。');
      await client.query(`
        INSERT INTO canvas_commands
          (id, document_id, revision_id, workspace_id, project_id, client_request_id, actor, expected_revision, batch_json, receipt_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [input.id, input.documentId, input.revisionId, document.rows[0].workspace_id, document.rows[0].project_id,
        input.clientRequestId, input.actor, input.expectedRevision, input.batch, input.receipt]);
      await this.appendEvent(client, {
        workspaceId: document.rows[0]!.workspace_id, projectId: document.rows[0]!.project_id,
        documentId: input.documentId, revisionId: input.revisionId, type: 'canvas.commands.applied',
        payload: { clientRequestId: input.clientRequestId, revision: input.receipt.revision,
          commands: input.batch.commands.map(command => command.commandId) },
      });
      return { receipt: input.receipt, replay: false };
    });
  }

  async adopt(input: {
    documentId: string; revisionId: string; actor: string; expectedRevision: number;
  }): Promise<CanvasRevision> {
    return this.transaction(async client => {
      const document = await client.query<DocumentRow>(
        'SELECT * FROM canvas_documents WHERE id = $1 FOR UPDATE', [input.documentId]);
      const row = document.rows[0];
      if (!row) throw canvasError('canvas_not_found', '画布不存在。');
      const target = await client.query<RevisionRow>(
        'SELECT * FROM canvas_revisions WHERE document_id = $1 AND id = $2', [input.documentId, input.revisionId]);
      const targetRow = target.rows[0];
      if (!targetRow) throw canvasError('canvas_revision_not_found', '画布版本不存在。');
      if (Number(targetRow.revision) !== input.expectedRevision) {
        throw canvasError('canvas_revision_conflict', '要采用的版本已经不是最新版本，请重新校验。', {
          expectedRevision: input.expectedRevision, currentRevision: Number(targetRow.revision),
        });
      }
      const previousAdopted = row.adopted_revision_id;
      if (previousAdopted === input.revisionId) return toRevision(targetRow);

      await client.query(
        "UPDATE canvas_revisions SET status = 'archived' WHERE document_id = $1 AND status = 'adopted'",
        [input.documentId]);
      await client.query(
        "UPDATE canvas_revisions SET status = 'adopted', adopted_by = $3, adopted_at = clock_timestamp() WHERE document_id = $1 AND id = $2",
        [input.documentId, input.revisionId, input.actor]);
      await client.query(
        "UPDATE canvas_documents SET adopted_revision_id = $2, updated_at = clock_timestamp() WHERE id = $1",
        [input.documentId, input.revisionId]);
      await this.appendEvent(client, {
        workspaceId: row.workspace_id, projectId: row.project_id, documentId: input.documentId,
        revisionId: input.revisionId, type: 'canvas.revision.adopted',
        payload: { revision: input.expectedRevision, previousAdoptedRevisionId: previousAdopted, actor: input.actor },
      });
      const adopted = await client.query<RevisionRow>(
        'SELECT * FROM canvas_revisions WHERE id = $1', [input.revisionId]);
      return toRevision(adopted.rows[0]!);
    });
  }

  private async appendEvent(client: PoolClient, input: {
    workspaceId: string; projectId: string; documentId: string; revisionId: string | null;
    type: string; payload: Record<string, unknown>;
  }): Promise<void> {
    const id = `canvasevent_${sha256Digest(`${input.documentId}:${input.type}:${input.revisionId ?? ''}:${Date.now()}:${Math.random()}`).slice(7, 39)}`;
    await client.query(`
      INSERT INTO canvas_events (id, workspace_id, project_id, document_id, revision_id, type, payload_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, input.workspaceId, input.projectId, input.documentId, input.revisionId, input.type, input.payload]);
  }

  /** 运行创建等跨表事实与画布事件同事务追加。 */
  async recordEvent(input: {
    workspaceId: string; projectId: string; documentId: string; revisionId: string | null;
    type: string; payload: Record<string, unknown>;
  }): Promise<void> {
    return this.transaction(client => this.appendEvent(client, input));
  }

  async listEvents(documentId: string, limit: number): Promise<Array<{ id: string; type: string; revisionId: string | null; createdAt: string }>> {
    try {
      const rows = await this.database.query<{ id: string; type: string; revision_id: string | null; created_at: Date | string }>(`
        SELECT id, type, revision_id, created_at FROM canvas_events
        WHERE document_id = $1 ORDER BY created_at DESC, id COLLATE "C" DESC LIMIT $2`, [documentId, limit]);
      return rows.rows.map(row => ({
        id: row.id, type: row.type, revisionId: row.revision_id, createdAt: iso(row.created_at)!,
      }));
    } catch (error) { return databaseFailure(error); }
  }

  /** 供服务层在克隆草稿时复用同一份图。 */
  clone(graph: CanvasGraph): CanvasGraph {
    return cloneGraph(graph);
  }
}

interface QuoteRow {
  id: string;
  document_id: string;
  revision_id: string;
  semantic_digest: string;
  currency: string;
  budget_micros: number | string;
  estimate_micros: number | string;
  estimate_low_micros: number | string;
  estimate_high_micros: number | string;
  price_revision: string;
  assumptions_json: unknown;
  shot_count: number | string;
  model: string;
  candidate_policy: string;
  status: 'pending' | 'confirmed' | 'expired';
  expires_at: Date | string;
  created_at: Date | string;
}

export interface StoredCanvasQuote {
  id: string;
  documentId: string;
  revisionId: string;
  semanticGraphDigest: string;
  currency: string;
  budgetMicros: number;
  estimateCostMicros: number;
  estimateRange: { lowMicros: number; highMicros: number };
  priceRevision: string;
  assumptions: string[];
  shotCount: number;
  model: string;
  candidatePolicy: string;
  expiresAt: string;
  status: 'pending' | 'confirmed' | 'expired';
  createdAt: string;
}

function toQuote(row: QuoteRow): StoredCanvasQuote {
  const assumptions = Array.isArray(row.assumptions_json)
    ? row.assumptions_json.filter(item => typeof item === 'string') as string[]
    : [];
  return {
    id: row.id,
    documentId: row.document_id,
    revisionId: row.revision_id,
    semanticGraphDigest: row.semantic_digest,
    currency: row.currency,
    budgetMicros: Number(row.budget_micros),
    estimateCostMicros: Number(row.estimate_micros),
    estimateRange: { lowMicros: Number(row.estimate_low_micros), highMicros: Number(row.estimate_high_micros) },
    priceRevision: row.price_revision,
    assumptions,
    shotCount: Number(row.shot_count),
    model: row.model,
    candidatePolicy: row.candidate_policy,
    expiresAt: iso(row.expires_at)!,
    status: row.status,
    createdAt: iso(row.created_at)!,
  };
}

interface CanvasRunRow {
  id: string;
  document_id: string;
  revision_id: string;
  semantic_digest: string;
  quote_id: string;
  run_id: string;
  created_at: Date | string;
}

export interface StoredCanvasRun {
  id: string;
  documentId: string;
  revisionId: string;
  semanticGraphDigest: string;
  quoteId: string;
  runId: string;
  createdAt: string;
}

export class PostgresCanvasQuoteStore {
  constructor(private readonly database: PostgresDatabase) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(work);
    } catch (error) {
      return databaseFailure(error);
    }
  }

  async create(input: StoredCanvasQuote, scope: { workspaceId: string; projectId: string; createdBy: string }): Promise<StoredCanvasQuote> {
    return this.transaction(async client => {
      await client.query(`
        INSERT INTO canvas_quotes
          (id, document_id, revision_id, workspace_id, project_id, semantic_digest, currency,
           budget_micros, estimate_micros, estimate_low_micros, estimate_high_micros,
           price_revision, assumptions_json, shot_count, model, candidate_policy,
           status, expires_at, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [input.id, input.documentId, input.revisionId, scope.workspaceId, scope.projectId,
        input.semanticGraphDigest, input.currency, input.budgetMicros, input.estimateCostMicros,
        input.estimateRange.lowMicros, input.estimateRange.highMicros, input.priceRevision,
        input.assumptions, input.shotCount, input.model, input.candidatePolicy,
        input.status, input.expiresAt, scope.createdBy]);
      const row = await client.query<QuoteRow>('SELECT * FROM canvas_quotes WHERE id = $1', [input.id]);
      return toQuote(row.rows[0]!);
    });
  }

  async get(documentId: string, quoteId: string): Promise<StoredCanvasQuote | null> {
    try {
      const rows = await this.database.query<QuoteRow>(
        'SELECT * FROM canvas_quotes WHERE document_id = $1 AND id = $2', [documentId, quoteId]);
      return rows.rows[0] ? toQuote(rows.rows[0]) : null;
    } catch (error) { return databaseFailure(error); }
  }

  async confirm(documentId: string, quoteId: string): Promise<StoredCanvasQuote> {
    try {
      await this.database.query(
        "UPDATE canvas_quotes SET status = 'confirmed' WHERE document_id = $1 AND id = $2 AND status = 'pending'",
        [documentId, quoteId]);
      const rows = await this.database.query<QuoteRow>(
        'SELECT * FROM canvas_quotes WHERE document_id = $1 AND id = $2', [documentId, quoteId]);
      if (!rows.rows[0]) throw canvasError('canvas_not_found', '估价卡不存在。');
      return toQuote(rows.rows[0]);
    } catch (error) { return databaseFailure(error); }
  }
}

export class PostgresCanvasRunStore {
  constructor(private readonly database: PostgresDatabase) {}

  async getByRequest(documentId: string, clientRequestId: string): Promise<StoredCanvasRun | null> {
    try {
      const rows = await this.database.query<CanvasRunRow>(
        'SELECT * FROM canvas_runs WHERE document_id = $1 AND client_request_id = $2',
        [documentId, clientRequestId]);
      const row = rows.rows[0];
      return row ? {
        id: row.id, documentId: row.document_id, revisionId: row.revision_id,
        semanticGraphDigest: row.semantic_digest, quoteId: row.quote_id, runId: row.run_id,
        createdAt: iso(row.created_at)!,
      } : null;
    } catch (error) { return databaseFailure(error); }
  }

  async create(input: StoredCanvasRun & { clientRequestId: string; workspaceId: string; projectId: string }): Promise<StoredCanvasRun> {
    try {
      const rows = await this.database.query<CanvasRunRow>(`
        INSERT INTO canvas_runs
          (id, document_id, revision_id, workspace_id, project_id, semantic_digest, quote_id, run_id, client_request_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (document_id, client_request_id) DO UPDATE SET run_id = canvas_runs.run_id
        RETURNING *`,
      [input.id, input.documentId, input.revisionId, input.workspaceId, input.projectId,
        input.semanticGraphDigest, input.quoteId, input.runId, input.clientRequestId]);
      const row = rows.rows[0]!;
      return {
        id: row.id, documentId: row.document_id, revisionId: row.revision_id,
        semanticGraphDigest: row.semantic_digest, quoteId: row.quote_id, runId: row.run_id,
        createdAt: iso(row.created_at)!,
      };
    } catch (error) { return databaseFailure(error); }
  }

  async latestForRevision(documentId: string, revisionId: string): Promise<StoredCanvasRun | null> {
    try {
      const rows = await this.database.query<CanvasRunRow>(`
        SELECT * FROM canvas_runs WHERE document_id = $1 AND revision_id = $2
        ORDER BY created_at DESC, id COLLATE "C" DESC LIMIT 1`, [documentId, revisionId]);
      const row = rows.rows[0];
      return row ? {
        id: row.id, documentId: row.document_id, revisionId: row.revision_id,
        semanticGraphDigest: row.semantic_digest, quoteId: row.quote_id, runId: row.run_id,
        createdAt: iso(row.created_at)!,
      } : null;
    } catch (error) { return databaseFailure(error); }
  }
}
