import type { PoolClient } from 'pg';
import { canonicalDigest, ProductionError } from '@lyra/shared';
import type { ShotSpecV2 } from '@lyra/shared/dist/shot-spec';
import type { PostgresDatabase } from '../db/client';
import { DataOutbox, type OutboxTransaction } from '../data/outbox';
import { createDataEventV2 } from '../data/tenant-event';
import { parseTenantContext, type TenantContext } from '../tenancy/context';
import { verifyShotSpecV2 } from './shot-spec';
function hidden(): never { throw new ProductionError(404, 'REFERENCE_NOT_FOUND', '镜头版本或项目不存在。'); }
function conflict(): never { throw new ProductionError(409, 'REVISION_CONFLICT', '正式版本已变化，请重新读取后比较。'); }
function writable(tenant: TenantContext) {
  if (tenant.role === 'viewer') throw new ProductionError(403, 'REFERENCE_FORBIDDEN', '当前角色不能修改正式输入。');
}
function identifier(value: string) {
  if (typeof value !== 'string' || value.length > 128 || /[\r\n]/u.test(value) || !/^[A-Za-z][A-Za-z0-9_.:-]*$/u.test(value)) {
    throw new ProductionError(400, 'PRODUCTION_INPUT_INVALID', '输入标识无效。');
  }
}
/** PostgreSQL facts + the existing transaction Outbox. No parallel event queue or provider execution. */
export class PostgresShotSpecRepository {
  private readonly outbox: DataOutbox;
  constructor(private readonly database: PostgresDatabase) { this.outbox = new DataOutbox(database); }
  async createEpisode(tenantValue: unknown, input: { id: string; projectId: string; title: string; createdAt: string }) {
    const tenant = parseTenantContext(tenantValue); writable(tenant); identifier(input.id); identifier(input.projectId);
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 160) throw new ProductionError(400, 'PRODUCTION_INPUT_INVALID', '分集标题无效。');
    return this.database.runWithTenant(tenant, () => this.database.transaction(async client => {
      const project = await client.query('SELECT id FROM projects WHERE workspace_id=$1 AND id=$2 FOR KEY SHARE', [tenant.workspaceId, input.projectId]);
      if (!project.rowCount) hidden();
      await client.query(`INSERT INTO production_episodes(workspace_id,id,project_id,title,created_by,created_at)
        VALUES($1,$2,$3,$4,$5,$6)`, [tenant.workspaceId, input.id, input.projectId, input.title, tenant.userId, input.createdAt]);
      return { id: input.id, projectId: input.projectId };
    }));
  }
  async get(tenantValue: unknown, revisionId: string): Promise<ShotSpecV2 | null> {
    const tenant = parseTenantContext(tenantValue); identifier(revisionId);
    return this.database.runWithTenant(tenant, async () => {
      const row = (await this.database.query('SELECT spec_json FROM shot_spec_versions WHERE workspace_id=$1 AND id=$2', [tenant.workspaceId, revisionId])).rows[0];
      return row ? verifyShotSpecV2(row.spec_json) : null;
    });
  }
  async create(tenantValue: unknown, value: unknown) {
    const tenant = parseTenantContext(tenantValue); writable(tenant); const spec = verifyShotSpecV2(value);
    if (spec.workspaceId !== tenant.workspaceId) hidden();
    return this.database.runWithTenant(tenant, () => this.outbox.transaction(async tx => {
      await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['shot-version:' + tenant.workspaceId + ':' + spec.revisionId]);
      const existing = (await tx.client.query('SELECT spec_json FROM shot_spec_versions WHERE workspace_id=$1 AND id=$2', [tenant.workspaceId, spec.revisionId])).rows[0];
      if (existing) {
        if (canonicalDigest(existing.spec_json) !== canonicalDigest(spec)) conflict();
        return verifyShotSpecV2(existing.spec_json);
      }
      const episode = await tx.client.query('SELECT id FROM production_episodes WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR KEY SHARE', [tenant.workspaceId, spec.projectId, spec.episodeId]);
      if (!episode.rowCount) hidden();
      await tx.client.query(`INSERT INTO shot_spec_versions(workspace_id,id,project_id,episode_id,shot_id,content_digest,spec_json,created_by,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [tenant.workspaceId, spec.revisionId, spec.projectId, spec.episodeId, spec.shotId, spec.contentDigest, spec, tenant.userId, spec.createdAt]);
      await this.event(tx, tenant, spec, 'shot_spec.created.v2', spec.revisionId, 1, spec.createdAt);
      return spec;
    }));
  }
  /** Caller supplies a MAIN-owned, read-only reference validator using this same transaction. */
  async adopt(tenantValue: unknown, input: { revisionId: string; expectedCurrentVersion: string | null; expectedProjectRevision: string; reason: string; at: string },
    validate: (client: PoolClient, spec: ShotSpecV2) => Promise<void>) {
    const tenant = parseTenantContext(tenantValue); writable(tenant); identifier(input.revisionId);
    if (input.expectedCurrentVersion !== null) identifier(input.expectedCurrentVersion);
    if (!/^(0|[1-9][0-9]{0,18})$/u.test(input.expectedProjectRevision) || /[\r\n]/u.test(input.expectedProjectRevision)
      || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000 || typeof validate !== 'function') {
      throw new ProductionError(400, 'PRODUCTION_INPUT_INVALID', '采用参数无效。');
    }
    return this.database.runWithTenant(tenant, () => this.outbox.transaction(async tx => {
      const stored = (await tx.client.query('SELECT spec_json FROM shot_spec_versions WHERE workspace_id=$1 AND id=$2', [tenant.workspaceId, input.revisionId])).rows[0];
      if (!stored) hidden(); const spec = verifyShotSpecV2(stored.spec_json);
      const project = (await tx.client.query('SELECT input_revision::text FROM projects WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [tenant.workspaceId, spec.projectId])).rows[0];
      if (!project) hidden();
      const head = (await tx.client.query(`SELECT current_version_id,revision::text FROM shot_spec_heads
        WHERE workspace_id=$1 AND project_id=$2 AND episode_id=$3 AND shot_id=$4 FOR UPDATE`, [tenant.workspaceId, spec.projectId, spec.episodeId, spec.shotId])).rows[0];
      if ((head?.current_version_id ?? null) !== input.expectedCurrentVersion || project.input_revision !== input.expectedProjectRevision) conflict();
      await validate(tx.client, spec); // throws => head, project revision and Outbox all roll back
      if (head?.current_version_id === spec.revisionId) return { revisionId: spec.revisionId, projectRevision: project.input_revision as string };
      const revision = head ? BigInt(head.revision) + 1n : 1n;
      await tx.client.query(`INSERT INTO shot_spec_heads(workspace_id,project_id,episode_id,shot_id,current_version_id,revision,adopted_by,adopted_at,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workspace_id,project_id,episode_id,shot_id) DO UPDATE
        SET current_version_id=EXCLUDED.current_version_id,revision=EXCLUDED.revision,adopted_by=EXCLUDED.adopted_by,adopted_at=EXCLUDED.adopted_at,reason=EXCLUDED.reason`,
      [tenant.workspaceId, spec.projectId, spec.episodeId, spec.shotId, spec.revisionId, revision.toString(), tenant.userId, input.at, input.reason]);
      const aggregateId = 'shothead_' + canonicalDigest([spec.projectId, spec.episodeId, spec.shotId]).slice(0, 32);
      await this.event(tx, tenant, spec, 'shot_spec.adopted.v2', aggregateId, Number(revision), input.at);
      const changed = (await tx.client.query('SELECT input_revision::text FROM projects WHERE workspace_id=$1 AND id=$2', [tenant.workspaceId, spec.projectId])).rows[0];
      return { revisionId: spec.revisionId, projectRevision: changed!.input_revision as string };
    }));
  }
  private async event(tx: OutboxTransaction, tenant: TenantContext, spec: ShotSpecV2, eventType: string, aggregateId: string, aggregateVersion: number, at: string) {
    await tx.append(createDataEventV2({ workspaceId: tenant.workspaceId, eventType, aggregateType: 'shot_spec', aggregateId, aggregateVersion,
      occurredAt: at, correlationId: tenant.requestId, authoritativeRef: { kind: 'shot_spec', id: spec.revisionId, revisionId: spec.revisionId, digest: spec.contentDigest },
      payload: { projectId: spec.projectId, episodeId: spec.episodeId, shotId: spec.shotId, revisionId: spec.revisionId, digest: spec.contentDigest, actorId: tenant.userId } }));
  }
}
