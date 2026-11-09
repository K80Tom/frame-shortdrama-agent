import type {PoolClient} from 'pg';
import type {ProductionInputErrorCode} from '@lyra/shared';
import type {ObjectStorage} from '../infrastructure/object-storage';
import {parseTenantContext} from '../tenancy/context';
import {readObjectVersionBytes,type StoredObjectVersionRow} from '../production-media/object-versions';
/** Same lifecycle transaction; actual immutable version bytes, NOT a HEAD claim. */
export class ProductionInputObjectVerifier {
  constructor(private readonly client:Pick<PoolClient,'query'>,private readonly objects:Pick<ObjectStorage,'provider'|'bucket'|'get'>,private readonly maxBytes=64*1024*1024){}
  async check(tenantValue:unknown,expected:{objectId:string;versionId:string;checksum:string}):Promise<ProductionInputErrorCode|null>{
    const tenant=parseTenantContext(tenantValue);
    if(typeof expected.objectId!=='string'||expected.objectId.length!==36||!/^obj_[a-f0-9]{32}$/u.test(expected.objectId)
      ||typeof expected.checksum!=='string'||expected.checksum.length!==64||!/^[a-f0-9]{64}$/u.test(expected.checksum))return 'DIGEST_MISMATCH';
    if(typeof expected.versionId!=='string'||expected.versionId.length!==39||!/^objver_[a-f0-9]{32}$/u.test(expected.versionId))return 'CAPABILITY_INCOMPATIBLE';
    try{
      const row=(await this.client.query<StoredObjectVersionRow>(`SELECT v.*,o.status AS parent_status,o.deleted_at AS parent_deleted_at,
        o.owner_id AS parent_owner_id,o.owner_type AS parent_owner_type,o.purpose AS parent_purpose FROM object_versions v
        JOIN object_records o ON o.workspace_id=v.workspace_id AND o.id=v.object_id
        WHERE v.workspace_id=$1 AND v.object_id=$2 AND v.id=$3 FOR SHARE OF v,o`,[tenant.workspaceId,expected.objectId,expected.versionId])).rows[0];
      if(!row)return 'REFERENCE_NOT_FOUND';
      if(row.workspace_id!==tenant.workspaceId)return 'REFERENCE_FORBIDDEN';
      if(row.status!=='ready'||!row.verified_at)return 'SNAPSHOT_NOT_READY';
      if(row.parent_status!=='ready'||row.parent_deleted_at||row.parent_owner_id!==row.owner_id||row.parent_owner_type!==row.owner_type||row.parent_purpose!==row.purpose)return 'REFERENCE_FORBIDDEN';
      if(row.object_id!==expected.objectId||row.id!==expected.versionId||row.sha256!==expected.checksum)return 'DIGEST_MISMATCH';
      await readObjectVersionBytes(row,this.objects,row.object_key,row.provider_version_id,this.maxBytes);return null;
    }catch(error){
      const code=error&&typeof error==='object'&&'code' in error?error.code:undefined;
      if(['DIGEST_MISMATCH','OBJECT_CHECKSUM_MISMATCH','OBJECT_VERSION_MISMATCH','OBJECT_METADATA_INVALID'].includes(String(code)))return 'DIGEST_MISMATCH';
      if(code==='OBJECT_NOT_FOUND')return 'REFERENCE_NOT_FOUND';
      if(code==='CAPABILITY_INCOMPATIBLE'||code==='OBJECT_SIZE_INVALID')return 'CAPABILITY_INCOMPATIBLE';
      return 'SNAPSHOT_NOT_READY';
    }
  }
}
