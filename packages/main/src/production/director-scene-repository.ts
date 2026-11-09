import type {PoolClient} from 'pg';
import {canonicalDigest,ProductionError,type DirectorSceneVersion,type InputVersionRef,type ShotControl,type ShotSpecV2} from '@lyra/shared';
import type {PostgresDatabase} from '../db/client';
import {DataOutbox} from '../data/outbox';
import {createDataEventV2} from '../data/tenant-event';
import {parseTenantContext,type TenantContext} from '../tenancy/context';
import {verifyDirectorSceneVersion,checkDirectorSceneBinding} from './director-scene';
function hidden():never{throw new ProductionError(404,'REFERENCE_NOT_FOUND','导演场景版本不存在。');}
async function guarded<T>(work:()=>Promise<T>):Promise<T>{
  try{return await work();}catch(error){
    if(error instanceof ProductionError)throw error;
    throw new ProductionError(503,'DIRECTOR_SCENE_UNAVAILABLE','导演场景版本暂不可用。');
  }
}
export class PostgresDirectorSceneRepository {
  constructor(private readonly database:PostgresDatabase){}
  async create(tenantValue:unknown,value:unknown){
    const tenant=parseTenantContext(tenantValue),v=verifyDirectorSceneVersion(value);
    if(tenant.role==='viewer')throw new ProductionError(403,'REFERENCE_FORBIDDEN','当前角色不能创建导演场景版本。');
    if(v.workspaceId!==tenant.workspaceId)hidden();
    if(v.createdBy!==tenant.userId)throw new ProductionError(400,'DIRECTOR_SCENE_INVALID','版本创建人必须为当前用户。');
    return guarded(()=>this.database.runWithTenant(tenant,()=>new DataOutbox(this.database).transaction(async tx=>{
      await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['director-scene:'+tenant.workspaceId+':'+v.revisionId]);
      const old=(await tx.client.query('SELECT scene_json FROM director_scene_versions WHERE workspace_id=$1 AND id=$2',[tenant.workspaceId,v.revisionId])).rows[0];
      if(old){if(canonicalDigest(old.scene_json)!==canonicalDigest(v))throw new ProductionError(409,'REVISION_CONFLICT','不可变场景版本标识已使用。');return verifyDirectorSceneVersion(old.scene_json);}
      // Exact adopted source chain, never the project's current pointers.
      const source=(await tx.client.query(`SELECT b.id,b.content_json FROM storyboard_revisions b WHERE b.workspace_id=$1 AND b.project_id=$2 AND b.id=$3
        AND b.script_version_id=$4 AND b.source_plan_revision_id=$5
        AND EXISTS(SELECT 1 FROM storyboard_adoptions a WHERE a.workspace_id=b.workspace_id AND a.project_id=b.project_id AND a.to_revision_id=b.id)
        AND EXISTS(SELECT 1 FROM production_episodes e WHERE e.workspace_id=b.workspace_id AND e.project_id=b.project_id AND e.id=$6) FOR SHARE OF b`,
      [tenant.workspaceId,v.projectId,v.storyboardRevisionId,v.scriptVersionId,v.planRevisionId,v.episodeId])).rows[0];
      if(!source||!Array.isArray(source.content_json?.shots)||!source.content_json.shots.some((s:{id?:unknown})=>s.id===v.shotId))hidden();
      await tx.client.query(`INSERT INTO director_scene_versions(workspace_id,id,scene_id,project_id,episode_id,shot_id,script_version_id,
        plan_revision_id,storyboard_revision_id,content_digest,scene_json,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [tenant.workspaceId,v.revisionId,v.sceneId,v.projectId,v.episodeId,v.shotId,v.scriptVersionId,v.planRevisionId,v.storyboardRevisionId,v.contentDigest,v,tenant.userId,v.createdAt]);
      await tx.append(createDataEventV2({workspaceId:tenant.workspaceId,eventType:'director_scene.created.v1',aggregateType:'director_scene',aggregateId:v.revisionId,
        aggregateVersion:1,occurredAt:v.createdAt,correlationId:tenant.requestId,authoritativeRef:{kind:'director_scene_version',id:v.revisionId,digest:v.contentDigest},
        payload:{projectId:v.projectId,episodeId:v.episodeId,shotId:v.shotId,sceneId:v.sceneId,digest:v.contentDigest,actorId:tenant.userId}}));
      return v;
    })));
  }
  async get(tenantValue:unknown,revisionId:string):Promise<DirectorSceneVersion|null>{
    const tenant=parseTenantContext(tenantValue);
    if(typeof revisionId!=='string'||revisionId.length>128||/[\r\n]/u.test(revisionId)||!/^[A-Za-z][A-Za-z0-9_.:-]*$/u.test(revisionId))
      throw new ProductionError(400,'DIRECTOR_SCENE_INVALID','场景版本标识无效。');
    return guarded(()=>this.database.runWithTenant(tenant,async()=>{
      const row=(await this.database.query('SELECT scene_json FROM director_scene_versions WHERE workspace_id=$1 AND id=$2',[tenant.workspaceId,revisionId])).rows[0];
      return row?verifyDirectorSceneVersion(row.scene_json):null;
    }));
  }
}
/** Used by the same lifecycle transaction. Domain hooks cannot override these real PG checks. */
export class PostgresDirectorSceneReferenceReader {
  private readonly tenant:TenantContext;
  constructor(private readonly client:Pick<PoolClient,'query'>,tenant:unknown,private readonly projectId:string){this.tenant=parseTenantContext(tenant);}
  async load(ref:InputVersionRef){
    const row=(await this.client.query('SELECT scene_json FROM director_scene_versions WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR SHARE',
      [this.tenant.workspaceId,this.projectId,ref.versionId])).rows[0];
    if(!row)return null;const version=verifyDirectorSceneVersion(row.scene_json);
    if(version.workspaceId!==this.tenant.workspaceId||version.projectId!==this.projectId||version.revisionId!==ref.versionId
      ||version.sceneId!==ref.id||version.contentDigest!==ref.digest)throw new ProductionError(409,'DIGEST_MISMATCH','场景引用与内容不一致。');
    return version;
  }
  async checkVersion(ref:InputVersionRef){try{return await this.load(ref)?null:'REFERENCE_NOT_FOUND' as const;}catch{return 'DIGEST_MISMATCH' as const;}}
  async checkBinding(control:ShotControl,shot:Readonly<ShotSpecV2>){
    if(control.kind!=='director_scene'||control.objectId!==null||control.timeMs!==null)return 'CAPABILITY_INCOMPATIBLE' as const;
    try{
      const v=await this.load(control.artifact);if(!v)return 'REFERENCE_NOT_FOUND' as const;
      return checkDirectorSceneBinding(v,control,shot);
    }catch{return 'DIGEST_MISMATCH' as const;}
  }
}
