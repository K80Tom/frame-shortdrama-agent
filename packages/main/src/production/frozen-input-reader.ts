import { createHash } from 'node:crypto';
import { canonicalDigest, ProductionError } from '@lyra/shared';
import type { FrozenProductionInput } from '@lyra/shared';
import type { PostgresDatabase } from '../db/client';
import { parseTenantContext } from '../tenancy/context';
import { verifyProductionInputSnapshot } from './input-snapshot';
import { verifyShotSpecV2 } from './shot-spec';

function mismatch(): never { throw new ProductionError(409,'DIGEST_MISMATCH','冻结输入摘要或版本关联不一致。'); }
/** Worker recovery reads exact immutable IDs only, NEVER projects.current/active pointers or browser state. */
export class PostgresFrozenProductionInputReader {
  constructor(private readonly database: PostgresDatabase) {}
  async load(tenantValue: unknown, snapshotId: string, expectedDigest?: string): Promise<FrozenProductionInput & {
    sources: { scriptText: string; planContent: unknown; storyboardContent: unknown }
  }> {
    const tenant = parseTenantContext(tenantValue);
    if (typeof snapshotId!=='string' || snapshotId.length>128 || /[\r\n]/u.test(snapshotId) || !/^[A-Za-z][A-Za-z0-9_.:-]*$/u.test(snapshotId)
      || expectedDigest!==undefined && (typeof expectedDigest!=='string' || expectedDigest.length!==64 || !/^[a-f0-9]{64}$/u.test(expectedDigest))) mismatch();
    return this.database.runWithTenant(tenant,async()=>{
      try {
        const row=(await this.database.query(`SELECT r.snapshot_json,t.state,t.findings_json,
          s.id AS script_id,s.raw_text,s.content_sha256,p.id AS plan_id,p.content_json AS plan_content,
          b.id AS board_id,b.content_json AS storyboard_content,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('shotId',i.shot_id,'revisionId',i.shot_version_id,'spec',v.spec_json) ORDER BY i.position)
            FROM production_input_shots i JOIN shot_spec_versions v ON v.workspace_id=i.workspace_id AND v.id=i.shot_version_id
              AND v.project_id=i.project_id AND v.episode_id=i.episode_id AND v.shot_id=i.shot_id
            WHERE i.workspace_id=r.workspace_id AND i.snapshot_id=r.id),'[]'::jsonb) AS shots
          FROM production_input_snapshots r JOIN production_input_states t ON t.workspace_id=r.workspace_id AND t.snapshot_id=r.id
          LEFT JOIN script_versions s ON s.workspace_id=r.workspace_id AND s.project_id=r.project_id AND s.id=r.snapshot_json->'script'->>'versionId'
          LEFT JOIN plan_revisions p ON p.workspace_id=r.workspace_id AND p.project_id=r.project_id AND p.id=r.snapshot_json->'plan'->>'versionId'
            AND p.script_version_id=s.id
          LEFT JOIN storyboard_revisions b ON b.workspace_id=r.workspace_id AND b.project_id=r.project_id AND b.id=r.snapshot_json->'storyboard'->>'versionId'
            AND b.script_version_id=s.id AND b.source_plan_revision_id=p.id
          WHERE r.workspace_id=$1 AND r.id=$2`,[tenant.workspaceId,snapshotId])).rows[0];
        if (!row) throw new ProductionError(404,'REFERENCE_NOT_FOUND','冻结快照不存在。');
        if (row.state!=='frozen') throw new ProductionError(409,'SNAPSHOT_NOT_READY','快照尚未冻结。');
        const snapshot=verifyProductionInputSnapshot({...row.snapshot_json,state:row.state,findings:row.findings_json});
        if (snapshot.workspaceId!==tenant.workspaceId || expectedDigest!==undefined && snapshot.snapshotDigest!==expectedDigest) mismatch();
        if (!row.script_id || !row.plan_id || !row.board_id) throw new ProductionError(409,'REFERENCE_NOT_FOUND','冻结来源版本缺失。');
        if (snapshot.script.id!==row.script_id || snapshot.plan.id!==row.plan_id || snapshot.storyboard.id!==row.board_id
          || typeof row.raw_text!=='string' || createHash('sha256').update(row.raw_text,'utf8').digest('hex')!==snapshot.script.digest
          || row.content_sha256!==snapshot.script.digest || canonicalDigest(row.plan_content)!==snapshot.plan.digest
          || canonicalDigest(row.storyboard_content)!==snapshot.storyboard.digest) mismatch();
        if (!Array.isArray(row.shots) || row.shots.length!==snapshot.shots.length) mismatch();
        const points=Array.from(row.raw_text as string);
        const shots=snapshot.shots.map((expected,index)=>{
          const stored=row.shots[index];
          if (!stored || stored.shotId!==expected.shotId || stored.revisionId!==expected.revisionId) mismatch();
          const shot=verifyShotSpecV2(stored.spec);
          if (shot.workspaceId!==tenant.workspaceId || shot.projectId!==snapshot.projectId || shot.episodeId!==snapshot.episodeId
            || shot.shotId!==expected.shotId || shot.revisionId!==expected.revisionId || shot.contentDigest!==expected.contentDigest
            || shot.scriptVersionId!==row.script_id || shot.planRevisionId!==row.plan_id || shot.storyboardRevisionId!==row.board_id) mismatch();
          for (const ref of [...shot.sourceRefs,...shot.dialogue.map(d=>d.sourceRef),...shot.actions.flatMap(a=>a.sourceRefs)]) {
            if (ref.scriptVersionId!==row.script_id || ref.end>points.length || points.slice(ref.start,ref.end).join('')!==ref.quote) mismatch();
          }
          return shot;
        });
        return {snapshot,shots,sources:{scriptText:row.raw_text as string,planContent:row.plan_content as unknown,storyboardContent:row.storyboard_content as unknown}};
      } catch(error) {
        if (error instanceof ProductionError) throw error;
        throw new ProductionError(503,'PRODUCTION_INPUT_UNAVAILABLE','冻结输入暂不可用。');
      }
    });
  }
}
