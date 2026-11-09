import {createHash} from 'node:crypto';
import {canonicalDigest,parseObjectVersionRequest,ProductionError,type ObjectVersion} from '@lyra/shared';
import type {PostgresDatabase} from '../db/client';
import {DataOutbox,type OutboxTransaction} from '../data/outbox';
import {createDataEventV2} from '../data/tenant-event';
import {PostgresJobQueueRepository} from '../jobs/repository';
import {JobQueueError,type JobLease} from '../jobs/contracts';
import {parseTenantContext,type TenantContext} from '../tenancy/context';
import {ObjectStorageError,normalizeObjectKey,validateContentType,validateSha256,validateMaxBytes,
  validateProviderVersionId,type ObjectStorage,type ObjectReadResult,type ObjectDescriptor} from '../infrastructure/object-storage';

export const OBJECT_VERSION_QUEUE='object_versions';
export const OBJECT_VERSION_JOB_KIND='object.version.materialize';
interface Source {id:string;workspace_id:string;provider:ObjectStorage['provider'];bucket:string;object_key:string;version_id:string|null;
  sha256:string;size_bytes:string|number;content_type:string;purpose:string;owner_type:string;owner_id:string;status:string;verified_at:unknown;deleted_at:unknown}
export interface StoredObjectVersionRow extends Omit<Source,'version_id'> {object_id:string;source_facts_digest:string;source_key:string;source_provider_version_id:string|null;
  provider_version_id:string|null;job_id:string;created_by:string;created_at:string|Date;version:number;last_error_code:string|null;
  parent_status?:string;parent_deleted_at?:unknown;parent_owner_id?:string;parent_owner_type?:string;parent_purpose?:string}
function fail(code:string,status=409):never{throw new ProductionError(status,code,'对象版本不可用或未通过字节验真。');}
function timestamp(v:string){if(typeof v!=='string'||v.length!==24||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)fail('OBJECT_VERSION_INVALID',400);return v;}
function versionId(v:string){if(typeof v!=='string'||v.length!==39||!/^objver_[a-f0-9]{32}$/u.test(v))fail('OBJECT_VERSION_INVALID',400);return v;}
function sourceFacts(s:Source){if(s.version_id!==null)validateProviderVersionId(s.version_id);return {workspaceId:s.workspace_id,objectId:s.id,provider:s.provider,bucket:s.bucket,key:normalizeObjectKey(s.object_key),
  providerVersionId:s.version_id,checksum:validateSha256(s.sha256),size:validateMaxBytes(Number(s.size_bytes)),contentType:validateContentType(s.content_type),
  purpose:s.purpose,ownerType:s.owner_type,ownerId:s.owner_id};}
function publicOf(v:StoredObjectVersionRow):ObjectVersion{return {schemaVersion:'lyra-object-version/1',id:v.id,objectId:v.object_id,workspaceId:v.workspace_id,
  status:v.status as ObjectVersion['status'],checksum:v.sha256,sizeBytes:Number(v.size_bytes),contentType:v.content_type,version:v.version,
  createdBy:v.created_by,createdAt:new Date(v.created_at).toISOString(),verifiedAt:v.verified_at?new Date(v.verified_at as string).toISOString():null};}
function active(s:Pick<Source,'status'|'verified_at'|'deleted_at'>){if(s.status!=='ready'||!s.verified_at||s.deleted_at)fail('REFERENCE_FORBIDDEN');}
async function guarded<T>(work:()=>Promise<T>){try{return await work();}catch(e){
  if(e instanceof ProductionError||e instanceof JobQueueError)throw e;
  if(e instanceof ObjectStorageError&&/^[A-Z][A-Z0-9_]{2,95}$/u.test(e.code))fail(e.code);
  return fail('OBJECT_VERSION_UNAVAILABLE',503);
}}
async function append(tx:OutboxTransaction,v:StoredObjectVersionRow,type:string,at:string){await tx.append(createDataEventV2({workspaceId:v.workspace_id,eventType:type,
  aggregateType:'object_version',aggregateId:v.id,aggregateVersion:v.version,occurredAt:at,correlationId:'object-version:'+v.id,
  authoritativeRef:{kind:'object_version',id:v.id,digest:canonicalDigest(publicOf(v))},payload:{objectId:v.object_id,objectVersionId:v.id,
    status:v.status,checksum:v.sha256,sizeBytes:Number(v.size_bytes),jobId:v.job_id,requestedBy:v.created_by}}));}
function leaseIdentity(lease:JobLease,now:string){return {workspaceId:lease.job.workspaceId,jobId:lease.job.id,workerId:lease.workerId,fencingToken:lease.fencingToken,now};}

/** Metadata + existing jobs + the single DataOutbox; request never writes bytes. */
export class PostgresObjectVersionRepository {
  private readonly outbox:DataOutbox;private readonly jobs:PostgresJobQueueRepository;
  constructor(private readonly database:PostgresDatabase,private readonly now:()=>Date=()=>new Date()){
    this.outbox=new DataOutbox(database);this.jobs=new PostgresJobQueueRepository(database);
  }
  async request(tenantValue:unknown,value:unknown){
    const tenant=parseTenantContext(tenantValue),input=parseObjectVersionRequest(value),at=this.time();
    if(tenant.role==='viewer')fail('REFERENCE_FORBIDDEN',403);
    return guarded(()=>this.database.runWithTenant(tenant,()=>this.outbox.transaction(async tx=>{
      const s=(await tx.client.query<Source>('SELECT * FROM object_records WHERE workspace_id=$1 AND id=$2 FOR SHARE',[tenant.workspaceId,input.objectId])).rows[0];
      if(!s)fail('REFERENCE_NOT_FOUND',404);active(s);const digest=canonicalDigest(sourceFacts(s)),id='objver_'+digest.slice(0,32);
      await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['object-version:'+tenant.workspaceId+':'+id]);
      const old=(await tx.client.query<StoredObjectVersionRow>('SELECT * FROM object_versions WHERE workspace_id=$1 AND id=$2',[tenant.workspaceId,id])).rows[0];
      if(old){if(old.source_facts_digest!==digest||old.object_id!==s.id)fail('REVISION_CONFLICT');return publicOf(old);}
      const queued=await this.jobs.enqueueInTransaction(tx.client,tenant,{queueName:OBJECT_VERSION_QUEUE,kind:OBJECT_VERSION_JOB_KIND,
        aggregateType:'object_version',aggregateId:id,idempotencyKey:'object-version:'+id,payload:{schemaVersion:'lyra-object-version/1',objectVersionId:id},
        availableAt:at,maxAttempts:5});
      const row=(await tx.client.query<StoredObjectVersionRow>(`INSERT INTO object_versions(workspace_id,id,object_id,source_facts_digest,provider,bucket,source_key,
        source_provider_version_id,object_key,sha256,size_bytes,content_type,purpose,owner_type,owner_id,status,job_id,created_by,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending',$16,$17,$18) RETURNING *`,
      [tenant.workspaceId,id,s.id,digest,s.provider,s.bucket,s.object_key,s.version_id,`production-media/objects/versions/${id}/${s.sha256}`,
        s.sha256,s.size_bytes,s.content_type,s.purpose,s.owner_type,s.owner_id,queued.job.id,tenant.userId,at])).rows[0]!;
      await append(tx,row,'object_version.requested.v1',at);return publicOf(row);
    })));
  }
  async get(tenantValue:unknown,id:string){const tenant=parseTenantContext(tenantValue);versionId(id);
    return guarded(()=>this.database.runWithTenant(tenant,async()=>{const row=await this.load(tenant,id);return row?publicOf(row):null;}));}
  private async load(tenant:TenantContext,id:string){return (await this.database.query<StoredObjectVersionRow>(`SELECT v.*,o.status AS parent_status,o.deleted_at AS parent_deleted_at,
    o.owner_id AS parent_owner_id,o.owner_type AS parent_owner_type,o.purpose AS parent_purpose
    FROM object_versions v JOIN object_records o ON o.workspace_id=v.workspace_id AND o.id=v.object_id WHERE v.workspace_id=$1 AND v.id=$2`,[tenant.workspaceId,id])).rows[0]??null;}
  /** Exact managed copy. Versionless storage uses a private immutable key and real checksum, not a fabricated provider ID. */
  async read(tenantValue:unknown,id:string,objects:ObjectStorage,maxBytes=64*1024*1024){
    const tenant=parseTenantContext(tenantValue);versionId(id);validateMaxBytes(maxBytes);
    return guarded(()=>this.database.runWithTenant(tenant,async()=>{
      const row=await this.load(tenant,id);if(!row)fail('REFERENCE_NOT_FOUND',404);
      if(row.status!=='ready'||row.parent_status!=='ready'||row.parent_deleted_at||row.parent_owner_id!==row.owner_id
        ||row.parent_owner_type!==row.owner_type||row.parent_purpose!==row.purpose)fail('REFERENCE_FORBIDDEN');
      return {version:publicOf(row),bytes:(await readObjectVersionBytes(row,objects,row.object_key,row.provider_version_id,maxBytes)).body};
    }));
  }
  /** Called from a fenced Worker with heartbeat/assertLease supplied by the existing scheduler. */
  async materialize(tenantValue:unknown,lease:JobLease,objects:ObjectStorage,assertLease:()=>Promise<void>,maxBytes=64*1024*1024){
    const tenant=parseTenantContext(tenantValue),id=this.leaseId(tenant,lease);validateMaxBytes(maxBytes);
    if(tenant.role==='viewer')fail('REFERENCE_FORBIDDEN',403);
    return guarded(()=>this.database.runWithTenant(tenant,async()=>{
      await assertLease();const row=await this.load(tenant,id);if(!row||row.job_id!==lease.job.id)fail('REFERENCE_NOT_FOUND',404);
      if(row.status!=='pending'||row.parent_status!=='ready'||row.parent_deleted_at||row.parent_owner_id!==row.owner_id
        ||row.parent_owner_type!==row.owner_type||row.parent_purpose!==row.purpose)fail('REFERENCE_FORBIDDEN');
      let copy:ObjectDescriptor;
      try{
        // A crash may occur after immutable copy succeeds but before the PG commit. Verify/reuse it; do not require the original cache to survive.
        copy=(await readObjectVersionBytes(row,objects,row.object_key,null,maxBytes)).object;
      }catch(error){
        if(!(error instanceof ObjectStorageError)||error.code!=='OBJECT_NOT_FOUND')throw error;
        const original=await readObjectVersionBytes(row,objects,row.source_key,row.source_provider_version_id,maxBytes);await assertLease();
        copy=await objects.put({scope:tenant,key:row.object_key,body:original.body,contentType:row.content_type,expectedSha256:row.sha256});
      }
      if(copy.versionId!==null)validateProviderVersionId(copy.versionId);
      assertVersionDescriptor(row,copy,row.object_key,copy.versionId);await assertLease();
      await readObjectVersionBytes(row,objects,row.object_key,copy.versionId,maxBytes);await assertLease();
      const at=this.time();return this.outbox.transaction(async tx=>{
        const source=(await tx.client.query<Source>('SELECT * FROM object_records WHERE workspace_id=$1 AND id=$2 FOR SHARE',[tenant.workspaceId,row.object_id])).rows[0];
        if(!source)fail('REFERENCE_NOT_FOUND');active(source);if(canonicalDigest(sourceFacts(source))!==row.source_facts_digest)fail('DIGEST_MISMATCH');
        const current=(await tx.client.query<StoredObjectVersionRow>('SELECT * FROM object_versions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[tenant.workspaceId,id])).rows[0];
        if(!current||current.status!=='pending'||current.job_id!==lease.job.id)fail('REVISION_CONFLICT');
        await this.jobs.completeInTransaction(tx.client,leaseIdentity(lease,at)); // stale fence rolls back ALL metadata/events
        const ready=(await tx.client.query<StoredObjectVersionRow>(`UPDATE object_versions SET status='ready',provider_version_id=$3,verified_at=$4,version=version+1,last_error_code=NULL
          WHERE workspace_id=$1 AND id=$2 RETURNING *`,[tenant.workspaceId,id,copy.versionId,at])).rows[0]!;
        await append(tx,ready,'object_version.ready.v1',at);return publicOf(ready);
      });
    }));
  }
  async fail(tenantValue:unknown,lease:JobLease,code:string,retryable:boolean){
    const tenant=parseTenantContext(tenantValue),id=this.leaseId(tenant,lease),at=this.time();
    if(!/^[A-Z][A-Z0-9_]{2,95}$/u.test(code))code='OBJECT_VERSION_UNAVAILABLE';
    return guarded(()=>this.database.runWithTenant(tenant,()=>this.outbox.transaction(async tx=>{
      const row=(await tx.client.query<StoredObjectVersionRow>('SELECT * FROM object_versions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[tenant.workspaceId,id])).rows[0];
      if(!row||row.status!=='pending'||row.job_id!==lease.job.id)fail('REVISION_CONFLICT');
      const job=await this.jobs.failInTransaction(tx.client,{...leaseIdentity(lease,at),error:code,retryable,retryAt:new Date(Date.parse(at)+5000).toISOString()});
      const next=(await tx.client.query<StoredObjectVersionRow>(`UPDATE object_versions SET status=$3,last_error_code=$4,version=version+1
        WHERE workspace_id=$1 AND id=$2 RETURNING *`,[tenant.workspaceId,id,job.state==='queued'?'pending':'failed',code])).rows[0]!;
      await append(tx,next,job.state==='queued'?'object_version.retry_scheduled.v1':'object_version.failed.v1',at);return publicOf(next);
    })));
  }
  private leaseId(tenant:TenantContext,lease:JobLease){
    const p=lease.job.payload;
    if(tenant.workspaceId!==lease.job.workspaceId||lease.job.queueName!==OBJECT_VERSION_QUEUE||lease.job.kind!==OBJECT_VERSION_JOB_KIND
      ||!p||Object.keys(p).length!==2||p.schemaVersion!=='lyra-object-version/1'||typeof p.objectVersionId!=='string')fail('OBJECT_VERSION_INVALID',400);
    const id=versionId(p.objectVersionId);
    if(lease.job.aggregateType!=='object_version'||lease.job.aggregateId!==id)fail('OBJECT_VERSION_INVALID',400);
    return id;
  }
  private time(){const now=this.now();if(!(now instanceof Date)||!Number.isFinite(now.valueOf()))fail('OBJECT_VERSION_UNAVAILABLE',503);return timestamp(now.toISOString());}
}
function assertVersionDescriptor(v:StoredObjectVersionRow,d:ObjectDescriptor,key:string,providerVersion:string|null){
    if(d.provider!==v.provider||d.bucket!==v.bucket||d.key!==key||d.sha256!==v.sha256||d.size!==Number(v.size_bytes)
      ||(providerVersion!==null&&d.versionId!==providerVersion)||(d.contentType!==v.content_type&&!(v.provider==='local'&&d.contentType===null)))fail('DIGEST_MISMATCH');
  }
export async function readObjectVersionBytes(v:StoredObjectVersionRow,objects:Pick<ObjectStorage,'provider'|'bucket'|'get'>,key:string,providerVersion:string|null,maxBytes:number):Promise<ObjectReadResult>{
    if(objects.provider!==v.provider||objects.bucket!==v.bucket)fail('CAPABILITY_INCOMPATIBLE');
    if(Number(v.size_bytes)>maxBytes)fail('OBJECT_SIZE_INVALID');
    const result=await objects.get({scope:{workspaceId:v.workspace_id},key,maxBytes,expectedSha256:v.sha256,...(providerVersion!==null?{providerVersionId:providerVersion}:{})});
    assertVersionDescriptor(v,result.object,key,providerVersion);
    if(!Buffer.isBuffer(result.body)||result.body.length!==Number(v.size_bytes)||createHash('sha256').update(result.body).digest('hex')!==v.sha256)fail('DIGEST_MISMATCH');
    return result;
  }
