import type { PoolClient } from 'pg';
import { ProductionError } from '@lyra/shared';
import type { ProductionInputSnapshot } from '@lyra/shared';
import type { PostgresDatabase } from '../db/client';
import { DataOutbox } from '../data/outbox';
import { createDataEventV2 } from '../data/tenant-event';
import { parseTenantContext, type TenantContext } from '../tenancy/context';
import { verifyProductionInputSnapshot } from './input-snapshot';
import { validateProductionInputCandidate, type ProductionInputValidationPorts } from './input-validation';

/** Main-owned factory must bind every reader/authorization check to this exact transaction. */
export type InputValidationPortsFactory = (client: PoolClient, tenant: TenantContext, snapshot: ProductionInputSnapshot)
  => ProductionInputValidationPorts | Promise<ProductionInputValidationPorts>;
function conflict(): never { throw new ProductionError(409, 'REVISION_CONFLICT', '快照状态或项目输入已变化。'); }
function hidden(): never { throw new ProductionError(404, 'REFERENCE_NOT_FOUND', '快照或项目不存在。'); }
export class PostgresProductionInputLifecycle {
  private readonly outbox: DataOutbox;
  constructor(private readonly database: PostgresDatabase, private readonly portsFactory: InputValidationPortsFactory) {
    this.outbox = new DataOutbox(database);
  }
  validate(tenant: unknown, snapshotId: string, expectedStateVersion: number, at: string) {
    return this.transition(tenant, snapshotId, expectedStateVersion, at, false);
  }
  freeze(tenant: unknown, snapshotId: string, expectedStateVersion: number, at: string) {
    return this.transition(tenant, snapshotId, expectedStateVersion, at, true);
  }
  private async transition(tenantValue: unknown, snapshotId: string, expectedStateVersion: number, at: string, freeze: boolean) {
    const tenant = parseTenantContext(tenantValue);
    if (tenant.role === 'viewer') throw new ProductionError(403, 'REFERENCE_FORBIDDEN', '当前角色不能验证或冻结快照。');
    if (typeof snapshotId !== 'string' || snapshotId.length > 128 || /[\r\n]/u.test(snapshotId) || !/^[A-Za-z][A-Za-z0-9_.:-]*$/u.test(snapshotId)
      || !Number.isInteger(expectedStateVersion) || expectedStateVersion < 1 || expectedStateVersion > 2147483644
      || typeof at !== 'string' || at.length !== 24 || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) {
      throw new ProductionError(400, 'PRODUCTION_INPUT_INVALID', '验证或冻结参数无效。');
    }
    return this.database.runWithTenant(tenant, () => this.outbox.transaction(async tx => {
      const row = (await tx.client.query('SELECT snapshot_json FROM production_input_snapshots WHERE workspace_id=$1 AND id=$2', [tenant.workspaceId,snapshotId])).rows[0];
      if (!row) hidden(); const snapshot = verifyProductionInputSnapshot(row.snapshot_json);
      // Same order as creation/adoption: project lock, then state/head lock.
      const project = (await tx.client.query(`SELECT input_revision::text,current_script_version_id,active_plan_revision_id,active_storyboard_revision_id
        FROM projects WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [tenant.workspaceId,snapshot.projectId])).rows[0];
      if (!project) hidden();
      const state = (await tx.client.query('SELECT state,version,findings_json FROM production_input_states WHERE workspace_id=$1 AND snapshot_id=$2 FOR UPDATE', [tenant.workspaceId,snapshotId])).rows[0];
      if (!state) hidden(); if (state.version !== expectedStateVersion) conflict();
      if (freeze && state.state === 'frozen') return { snapshot: verifyProductionInputSnapshot({ ...snapshot,state:'frozen',findings:state.findings_json }), stateVersion: state.version as number };
      if (project.input_revision !== snapshot.baseProjectRevision) conflict();
      if (project.current_script_version_id !== snapshot.script.versionId || project.active_plan_revision_id !== snapshot.plan.versionId
        || project.active_storyboard_revision_id !== snapshot.storyboard.versionId) conflict();
      if (state.state === 'frozen' || freeze && state.state !== 'ready' || !['draft','blocked','ready'].includes(state.state)) {
        throw new ProductionError(409, 'SNAPSHOT_NOT_READY', '当前快照状态不能执行此操作。');
      }
      let version = state.version as number;
      const write = async (next: string, findings: unknown[], validated: string | null, eventType: string) => {
        version++;
        await tx.client.query(`UPDATE production_input_states SET state=$3,version=$4,findings_json=$5,
          validated_project_revision=$6,updated_by=$7,updated_at=$8 WHERE workspace_id=$1 AND snapshot_id=$2`,
        [tenant.workspaceId,snapshotId,next,version,JSON.stringify(findings),validated,tenant.userId,at]);
        await tx.append(createDataEventV2({ workspaceId: tenant.workspaceId, eventType, aggregateType:'production_input',
          aggregateId:snapshotId, aggregateVersion:version, occurredAt:at, correlationId:tenant.requestId,
          authoritativeRef:{kind:'production_input_snapshot',id:snapshotId,digest:snapshot.snapshotDigest},
          payload:{projectId:snapshot.projectId,episodeId:snapshot.episodeId,digest:snapshot.snapshotDigest,
            state:next,stateVersion:version,findingCount:findings.length,actorId:tenant.userId} }));
      };
      await write('validating',[],null,'production_input.validation_started.v1');
      const ports = await this.portsFactory(tx.client,tenant,snapshot);
      const report = await validateProductionInputCandidate(tenant,snapshot,ports);
      if (report.state === 'blocked') {
        await write('blocked',report.findings,null,'production_input.validation_failed.v1');
        return { snapshot:verifyProductionInputSnapshot({...snapshot,state:'blocked',findings:report.findings}),stateVersion:version };
      }
      await write('ready',[],snapshot.baseProjectRevision,'production_input.validated.v1');
      if (freeze) await write('frozen',[],snapshot.baseProjectRevision,'production_input.frozen.v1');
      return { snapshot:verifyProductionInputSnapshot({...snapshot,state:freeze?'frozen':'ready',findings:[]}),stateVersion:version };
    }));
  }
}
