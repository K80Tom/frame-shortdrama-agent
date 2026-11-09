const {test}=require('node:test');const assert=require('node:assert/strict');const {randomBytes,createHash}=require('node:crypto');
const {mkdtemp,rm}=require('node:fs/promises');const {tmpdir}=require('node:os');const {join,resolve,dirname,basename}=require('node:path');
const {Client}=require('pg');const {PostgresDatabase}=require('../dist/db/client');
const {LocalObjectStorage,ObjectStorageError}=require('../dist/infrastructure/object-storage');
const {PostgresObjectVersionRepository,OBJECT_VERSION_QUEUE}=require('../dist/production-media/object-versions');
const {ObjectVersionJobHandler}=require('../dist/production-media/object-version-worker');
const {PostgresJobQueueRepository}=require('../dist/jobs/repository');const {PostgresJobTenantResolver}=require('../dist/jobs/tenant');
const {PersistentJobWorker}=require('../dist/jobs/worker');const {ProductionInputObjectVerifier}=require('../dist/production/input-object-verifier');
const token=()=>randomBytes(16).toString('hex');
test('real PG + real immutable local bytes materialize internal versions through fenced jobs and one Outbox',{
 skip:process.env.DATABASE_URL&&process.env.DATABASE_ADMIN_URL?false:'isolated application/admin URLs required',
},async t=>{
 const admin=new Client({connectionString:process.env.DATABASE_ADMIN_URL});await admin.connect();
 const db=new PostgresDatabase({connectionString:process.env.DATABASE_URL},{unscopedAccess:'deny'});await db.verifyTenantRole();
 const base=resolve(tmpdir()),root=await mkdtemp(join(base,'lyra-object-version-test-'));
 t.after(async()=>{await db.close();await admin.end();if(dirname(resolve(root))!==base||!basename(root).startsWith('lyra-object-version-test-'))throw Error('测试目录越界，拒绝清理。');await rm(root,{recursive:true,force:true});});
 let clock=Date.now();const now=()=>new Date(clock),at=now().toISOString();
 const tenants=[];for(const label of ['a','b']){
  const id=token(),ctx={userId:'usr_'+id,workspaceId:'ws_'+id,role:'owner',requestId:'object-version:'+id};tenants.push(ctx);
  await admin.query("INSERT INTO users(id,subject,display_name,kind,status,created_at,updated_at) VALUES($1,$2,'test','human','active',$3,$3)",[ctx.userId,'object-version:'+id,at]);
  await admin.query("INSERT INTO workspaces(id,slug,name,status,created_by_user_id,created_at,updated_at) VALUES($1,$2,'object version test','active',$3,$4,$4)",[ctx.workspaceId,'object-version-'+id,ctx.userId,at]);
  await admin.query("INSERT INTO workspace_members(workspace_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,'owner','active',$3,$3)",[ctx.workspaceId,ctx.userId,at]);
 }
 const [a,b]=tenants,scope=work=>db.runWithTenant(a,work),storage=new LocalObjectStorage(root,{bucket:'version-test'});
 const repo=new PostgresObjectVersionRepository(db,now),jobs=new PostgresJobQueueRepository(db),resolver=new PostgresJobTenantResolver(db);
 // Claims are restricted to this test's workspace to avoid consuming another test's jobs; all SQL uses the non-owner app role.
 const workerScope={runAsSystem:(reason,work)=>db.runWithTenant(a,work),runWithTenant:(ctx,work)=>db.runWithTenant(ctx,work)};
 const worker=objects=>new PersistentJobWorker(jobs,resolver,[new ObjectVersionJobHandler(repo,objects)],{workerId:'version-test-'+token(),now,executionScope:workerScope});
 const body=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6usAAAAASUVORK5CYII=','base64');
 async function source(){
  const id='obj_'+token(),key='input/'+token()+'.png',descriptor=await storage.put({scope:a,key,body,contentType:'image/png'});
  // Ready source metadata fixture; this test proves versioning, not the original ingest/authorization UI.
  await scope(()=>db.query(`INSERT INTO object_records(id,workspace_id,provider,bucket,object_key,sha256,size_bytes,content_type,purpose,owner_type,owner_id,
    status,created_at,updated_at,verified_at) VALUES($1,$2,'local','version-test',$3,$4,$5,'image/png','production.input','version_test',$6,'ready',$7,$7,$7)`,
    [id,a.workspaceId,key,descriptor.sha256,body.length,'source_'+token(),at]));return {id,key,descriptor};
 }
 const first=await source();const [pending,duplicate]=await Promise.all([repo.request(a,{objectId:first.id}),repo.request(a,{objectId:first.id})]);
 assert.equal(pending.id,duplicate.id);assert.match(pending.id,/^objver_[a-f0-9]{32}$/);assert.equal(pending.status,'pending');
 const queued=(await scope(()=>db.query('SELECT * FROM object_versions WHERE id=$1',[pending.id]))).rows[0];
 assert.equal(await storage.head(a,queued.object_key),null,'request must not mutate the object store');
 assert.equal((await scope(()=>db.query('SELECT id FROM jobs WHERE aggregate_id=$1',[pending.id]))).rowCount,1);
 await assert.rejects(repo.request(b,{objectId:first.id}),e=>e.status===404);
 await worker(storage).runOnce(OBJECT_VERSION_QUEUE);const ready=await repo.get(a,pending.id);assert.equal(ready.status,'ready');
 const record=(await scope(()=>db.query('SELECT * FROM object_versions WHERE id=$1',[ready.id]))).rows[0];assert.equal(record.provider_version_id,null);
 assert.notEqual(record.object_key,first.key);assert.equal((await scope(()=>jobs.get(a,record.job_id))).state,'succeeded');
 await storage.delete(a,first.key);await storage.put({scope:a,key:first.key,body:Buffer.from('new current bytes'),contentType:'image/png'});
 assert.deepEqual((await repo.read(a,ready.id,storage)).bytes,body,'frozen copy must not follow the replaced original key');
 const expected={objectId:first.id,versionId:ready.id,checksum:ready.checksum};
 const check=ctx=>db.runWithTenant(ctx,()=>db.transaction(client=>new ProductionInputObjectVerifier(client,storage).check(ctx,expected)));
 assert.equal(await check(a),null);assert.equal(await check(b),'REFERENCE_NOT_FOUND');
 await assert.rejects(scope(()=>db.query('UPDATE object_versions SET sha256=sha256 WHERE id=$1',[ready.id])),e=>e.code==='55000');
 await assert.rejects(scope(()=>db.query('DELETE FROM object_versions WHERE id=$1',[ready.id])),e=>e.code==='55000');
 await storage.delete(a,record.object_key);await storage.put({scope:a,key:record.object_key,body:Buffer.from('corrupt copy'),contentType:'image/png'});
 assert.equal(await check(a),'DIGEST_MISMATCH','HEAD/metadata alone cannot approve corrupt bytes');
 await scope(()=>db.query("UPDATE object_records SET status='deleted',deleted_at=$2 WHERE id=$1",[first.id,at]));assert.equal(await check(a),'REFERENCE_FORBIDDEN');
 // Old lease may leave an idempotent private copy, but cannot publish metadata, event or completion after takeover.
 const second=await source(),reserved=await repo.request(a,{objectId:second.id});
 const lease=await scope(()=>jobs.claim({queueName:OBJECT_VERSION_QUEUE,workerId:'old-version-worker',leaseMs:1000,now:now().toISOString()}));let replacement;
 const racing=new Proxy(storage,{get(target,key){if(key==='put')return async request=>{const result=await target.put(request);clock+=2000;
  replacement=await scope(()=>jobs.claim({queueName:OBJECT_VERSION_QUEUE,workerId:'new-version-worker',leaseMs:60000,now:now().toISOString()}));return result;};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 await assert.rejects(repo.materialize(a,lease,racing,async()=>{}),e=>e.code==='JOB_LEASE_LOST');
 assert.equal((await repo.get(a,reserved.id)).status,'pending');assert.ok(replacement.fencingToken>lease.fencingToken);
 assert.equal((await scope(()=>db.query("SELECT event_id FROM data_outbox_events WHERE aggregate_id=$1 AND event_type='object_version.ready.v1'",[reserved.id]))).rowCount,0);
 const heartbeat=()=>scope(()=>jobs.heartbeat({workspaceId:a.workspaceId,jobId:replacement.job.id,workerId:replacement.workerId,
  fencingToken:replacement.fencingToken,leaseMs:60000,now:now().toISOString()}));
 assert.equal((await repo.materialize(a,replacement,storage,heartbeat)).status,'ready');
 // A transient storage failure and retry settle domain + Outbox + job together, without double-completing the job.
 const third=await source(),retry=await repo.request(a,{objectId:third.id});let unavailable=true;
 const flaky=new Proxy(storage,{get(target,key){if(key==='get')return async request=>{if(unavailable)throw new ObjectStorageError('OBJECT_STORAGE_UNAVAILABLE','private provider diagnostic');return target.get(request);};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 await worker(flaky).runOnce(OBJECT_VERSION_QUEUE);const retryRow=(await scope(()=>db.query('SELECT * FROM object_versions WHERE id=$1',[retry.id]))).rows[0];
 assert.equal(retryRow.status,'pending');assert.equal((await scope(()=>jobs.get(a,retryRow.job_id))).state,'queued');
 unavailable=false;clock+=5001;await worker(flaky).runOnce(OBJECT_VERSION_QUEUE);assert.equal((await repo.get(a,retry.id)).status,'ready');
 const events=(await scope(()=>db.query('SELECT event_type,aggregate_version,payload_json FROM data_outbox_events WHERE aggregate_id=$1 ORDER BY aggregate_version',[retry.id]))).rows;
 assert.deepEqual(events.map(e=>e.event_type),['object_version.requested.v1','object_version.retry_scheduled.v1','object_version.ready.v1']);
 assert.deepEqual(events.map(e=>Number(e.aggregate_version)),[1,2,3]);assert.ok(!JSON.stringify(events).includes('private provider diagnostic'));
 // Fault only this newly created test version's ready event, proving the AFTER-byte domain/job/event transaction rolls back.
 const fourth=await source(),faulted=await repo.request(a,{objectId:fourth.id}),faultName='version_event_fault_'+token();
 assert.match(faultName,/^version_event_fault_[a-f0-9]{32}$/);
 await admin.query(`CREATE FUNCTION public.${faultName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.aggregate_id='${faulted.id}' AND NEW.event_type='object_version.ready.v1' THEN RAISE EXCEPTION 'PRIVATE_TEST_EVENT_FAILURE';END IF;RETURN NEW;END;$$;
  CREATE TRIGGER ${faultName} BEFORE INSERT ON data_outbox_events FOR EACH ROW EXECUTE FUNCTION public.${faultName}()`);
 try{
  await worker(storage).runOnce(OBJECT_VERSION_QUEUE);const row=(await scope(()=>db.query('SELECT * FROM object_versions WHERE id=$1',[faulted.id]))).rows[0];
  assert.equal(row.status,'pending');assert.equal(row.verified_at,null);assert.equal(row.provider_version_id,null);
  assert.equal((await scope(()=>jobs.get(a,row.job_id))).state,'queued');
  assert.equal((await scope(()=>db.query("SELECT event_id FROM data_outbox_events WHERE aggregate_id=$1 AND event_type='object_version.ready.v1'",[faulted.id]))).rowCount,0);
  assert.equal(row.last_error_code,'OBJECT_VERSION_UNAVAILABLE');
 }finally{await admin.query(`DROP TRIGGER ${faultName} ON data_outbox_events;DROP FUNCTION public.${faultName}()`);}
 await storage.delete(a,fourth.key); // original cache disappears after copy; recovery must verify the already materialized copy
 clock+=5001;await worker(storage).runOnce(OBJECT_VERSION_QUEUE);assert.equal((await repo.get(a,faulted.id)).status,'ready');
 const fifth=await source(),missing=await repo.request(a,{objectId:fifth.id});await storage.delete(a,fifth.key);
 await worker(storage).runOnce(OBJECT_VERSION_QUEUE);const failed=(await scope(()=>db.query('SELECT * FROM object_versions WHERE id=$1',[missing.id]))).rows[0];
 assert.equal(failed.status,'failed');assert.equal((await scope(()=>jobs.get(a,failed.job_id))).state,'failed');
 assert.equal(failed.last_error_code,'OBJECT_NOT_FOUND');assert.equal((await repo.request(a,{objectId:fifth.id})).status,'failed','no silent resurrection of a failed immutable version');
});
