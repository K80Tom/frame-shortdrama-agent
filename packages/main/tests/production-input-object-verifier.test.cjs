const {test}=require('node:test');const assert=require('node:assert/strict');const {createHash}=require('node:crypto');
const {ProductionInputObjectVerifier}=require('../dist/production/input-object-verifier');
function fixture(){
 const tenant={userId:'usr_'+'a'.repeat(32),workspaceId:'ws_'+'b'.repeat(32),role:'owner',requestId:'test-object-input'};
 const body=Buffer.from('byte-verification fixture, not MIME-sniff evidence');const checksum=createHash('sha256').update(body).digest('hex');
 const expected={objectId:'obj_'+'c'.repeat(32),versionId:'objver_'+'d'.repeat(32),checksum};
 const row={id:expected.versionId,object_id:expected.objectId,workspace_id:tenant.workspaceId,provider:'s3',bucket:'private-test',object_key:'production-media/objects/versions/one',
   provider_version_id:'real-provider-one',sha256:checksum,size_bytes:String(body.length),content_type:'image/png',status:'ready',verified_at:'2026-11-09T00:00:00.000Z',
   owner_id:'asset_one',owner_type:'asset',purpose:'input.asset',parent_status:'ready',parent_deleted_at:null,parent_owner_id:'asset_one',parent_owner_type:'asset',parent_purpose:'input.asset'};
 const descriptor={provider:'s3',bucket:row.bucket,key:row.object_key,versionId:row.provider_version_id,sha256:checksum,size:body.length,contentType:'image/png',etag:null};
 const calls=[];const client={async query(sql,args){assert.match(sql,/FOR SHARE OF v,o/);assert.deepEqual(args,[tenant.workspaceId,expected.objectId,expected.versionId]);calls.push('db');return {rows:row.absent?[]:[row]};}};
 const storage={provider:'s3',bucket:row.bucket,async get(request){calls.push('get');assert.equal(request.scope.workspaceId,tenant.workspaceId);assert.equal(request.key,row.object_key);
   assert.equal(request.providerVersionId,row.provider_version_id??undefined);return {object:descriptor,body};},async head(){throw Error('HEAD is not byte proof');}};
 return {tenant,body,expected,row,descriptor,storage,client,calls,check(){return new ProductionInputObjectVerifier(client,storage).check(tenant,expected);}};
}
test('internal version and actual checksum-verified bytes are required; provider selector is distinct',async()=>{
 const f=fixture();assert.equal(await f.check(),null);assert.deepEqual(f.calls,['db','get']);assert.notEqual(f.expected.versionId,f.row.provider_version_id);
});
test('missing, foreign, pending, revoked or mismatched versions stop before storage',async()=>{
 for(const [edit,code] of [[r=>{r.absent=true;},'REFERENCE_NOT_FOUND'],[r=>{r.workspace_id='other';},'REFERENCE_FORBIDDEN'],
  [r=>{r.status='pending';},'SNAPSHOT_NOT_READY'],[r=>{r.parent_deleted_at='deleted';},'REFERENCE_FORBIDDEN'],
  [r=>{r.parent_owner_id='another';},'REFERENCE_FORBIDDEN'],[r=>{r.sha256='0'.repeat(64);},'DIGEST_MISMATCH']]){
  const f=fixture();edit(f.row);assert.equal(await f.check(),code);assert.deepEqual(f.calls,['db']);
 }
 const legacy=fixture();legacy.expected.versionId='provider-only';assert.equal(await legacy.check(),'CAPABILITY_INCOMPATIBLE');assert.equal(legacy.calls.length,0);
});
test('versionless managed local copy uses null provider version, not a fabricated token',async()=>{
 const f=fixture();f.row.provider='local';f.storage.provider='local';f.descriptor.provider='local';f.row.provider_version_id=null;f.descriptor.versionId=null;f.descriptor.contentType=null;
 assert.equal(await f.check(),null);
});
test('changed selector/checksum/size/type or dishonest metadata with corrupted bytes cannot pass',async()=>{
 for(const [field,value] of [['versionId','new-provider-version'],['sha256','0'.repeat(64)],['size',999],['contentType','text/html'],['bucket','other'],['key','different']]){
  const f=fixture();f.descriptor[field]=value;assert.equal(await f.check(),'DIGEST_MISMATCH');
 }
 const f=fixture();f.body[0]^=1;assert.equal(await f.check(),'DIGEST_MISMATCH');
});
test('storage and database failures do not leak URLs or diagnostics',async()=>{
 const f=fixture();f.storage.get=async()=>{throw Error('https://secret.invalid?token=private');};assert.equal(await f.check(),'SNAPSHOT_NOT_READY');
 f.client.query=async()=>{throw Error('database-secret');};assert.equal(await f.check(),'SNAPSHOT_NOT_READY');
});
