import { canonicalDigest, ProductionError } from '@lyra/shared';
import type { PostgresDatabase } from '../db/client';
import { DataOutbox } from '../data/outbox';
import { createDataEventV2 } from '../data/tenant-event';
import { parseTenantContext } from '../tenancy/context';
import { verifyProductionInputSnapshot } from './input-snapshot';
import { verifyShotSpecV2 } from './shot-spec';

function hidden(): never { throw new ProductionError(404, 'REFERENCE_NOT_FOUND', '快照或来源版本不存在。'); }
function conflict(): never { throw new ProductionError(409, 'REVISION_CONFLICT', '项目或不可变快照版本已变化。'); }
/** Persist candidates only; no client-supplied ready/frozen state can be created through this repository. */
export class PostgresProductionInputSnapshotRepository {
  private readonly outbox: DataOutbox;
  constructor(private readonly database: PostgresDatabase) { this.outbox = new DataOutbox(database); }
  async create(tenantValue: unknown, value: unknown) {
    const tenant = parseTenantContext(tenantValue), snapshot = verifyProductionInputSnapshot(value);
    if (tenant.role === 'viewer') throw new ProductionError(403, 'REFERENCE_FORBIDDEN', '当前角色不能创建快照。');
    if (snapshot.workspaceId !== tenant.workspaceId) hidden();
    if (snapshot.state !== 'draft' || snapshot.findings.length || snapshot.createdBy !== tenant.userId) {
      throw new ProductionError(400, 'SNAPSHOT_NOT_READY', '只能保存服务端编译的候选快照，不能提交已通过或已冻结状态。');
    }
    return this.database.runWithTenant(tenant, () => this.outbox.transaction(async tx => {
      await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['production-input:' + tenant.workspaceId + ':' + snapshot.id]);
      const existing = (await tx.client.query(`SELECT r.snapshot_json,s.state,s.findings_json FROM production_input_snapshots r
        JOIN production_input_states s ON s.workspace_id=r.workspace_id AND s.snapshot_id=r.id
        WHERE r.workspace_id=$1 AND r.id=$2`, [tenant.workspaceId, snapshot.id])).rows[0];
      if (existing) {
        if (canonicalDigest(existing.snapshot_json) !== canonicalDigest(snapshot)) conflict();
        return verifyProductionInputSnapshot({ ...existing.snapshot_json, state: existing.state, findings: existing.findings_json });
      }
      const project = (await tx.client.query('SELECT input_revision::text FROM projects WHERE workspace_id=$1 AND id=$2 FOR SHARE', [tenant.workspaceId, snapshot.projectId])).rows[0];
      if (!project) hidden(); if (project.input_revision !== snapshot.baseProjectRevision) conflict();
      const count = (await tx.client.query(`SELECT count(*)::integer AS count FROM shot_spec_heads
        WHERE workspace_id=$1 AND project_id=$2 AND episode_id=$3`, [tenant.workspaceId,snapshot.projectId,snapshot.episodeId])).rows[0];
      if (count!.count !== snapshot.shots.length) conflict();
      for (const expected of snapshot.shots) {
        const row = (await tx.client.query(`SELECT v.spec_json FROM shot_spec_versions v JOIN shot_spec_heads h
          ON h.workspace_id=v.workspace_id AND h.project_id=v.project_id AND h.episode_id=v.episode_id
            AND h.shot_id=v.shot_id AND h.current_version_id=v.id
          WHERE v.workspace_id=$1 AND v.project_id=$2 AND v.episode_id=$3 AND v.id=$4 FOR SHARE OF h,v`,
        [tenant.workspaceId, snapshot.projectId, snapshot.episodeId, expected.revisionId])).rows[0];
        if (!row) hidden(); const shot = verifyShotSpecV2(row.spec_json);
        if (shot.shotId !== expected.shotId || shot.contentDigest !== expected.contentDigest) {
          throw new ProductionError(409, 'DIGEST_MISMATCH', '快照镜头引用摘要不一致。');
        }
      }
      await tx.client.query(`INSERT INTO production_input_snapshots(workspace_id,id,project_id,episode_id,base_project_revision,
        snapshot_digest,snapshot_json,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenant.workspaceId,snapshot.id,snapshot.projectId,snapshot.episodeId,snapshot.baseProjectRevision,snapshot.snapshotDigest,snapshot,tenant.userId,snapshot.createdAt]);
      for (const [position, shot] of snapshot.shots.entries()) await tx.client.query(`INSERT INTO production_input_shots
        (workspace_id,snapshot_id,project_id,episode_id,shot_id,shot_version_id,position) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [tenant.workspaceId,snapshot.id,snapshot.projectId,snapshot.episodeId,shot.shotId,shot.revisionId,position]);
      await tx.client.query(`INSERT INTO production_input_states(workspace_id,snapshot_id,updated_by,updated_at) VALUES($1,$2,$3,$4)`,
      [tenant.workspaceId,snapshot.id,tenant.userId,snapshot.createdAt]);
      await tx.append(createDataEventV2({ workspaceId: tenant.workspaceId, eventType: 'production_input.created.v1',
        aggregateType: 'production_input', aggregateId: snapshot.id, aggregateVersion: 1, occurredAt: snapshot.createdAt,
        correlationId: tenant.requestId, authoritativeRef: { kind: 'production_input_snapshot', id: snapshot.id, digest: snapshot.snapshotDigest },
        payload: { projectId: snapshot.projectId, episodeId: snapshot.episodeId, digest: snapshot.snapshotDigest, actorId: tenant.userId } }));
      return snapshot;
    }));
  }
  async get(tenantValue: unknown, snapshotId: string) {
    const tenant = parseTenantContext(tenantValue);
    return this.database.runWithTenant(tenant, async () => {
      const row = (await this.database.query(`SELECT r.snapshot_json,s.state,s.findings_json FROM production_input_snapshots r
        JOIN production_input_states s ON s.workspace_id=r.workspace_id AND s.snapshot_id=r.id
        WHERE r.workspace_id=$1 AND r.id=$2`, [tenant.workspaceId,snapshotId])).rows[0];
      return row ? verifyProductionInputSnapshot({ ...row.snapshot_json, state: row.state, findings: row.findings_json }) : null;
    });
  }
}
