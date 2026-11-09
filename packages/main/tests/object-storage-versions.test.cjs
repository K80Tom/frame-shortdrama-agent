const {test}=require('node:test');const assert=require('node:assert/strict');const {createHash}=require('node:crypto');
const {S3CompatibleObjectStorage,LocalObjectStorage}=require('../dist/infrastructure/object-storage');
const scope={workspaceId:'ws_'+'a'.repeat(32)},body=Buffer.from('old immutable bytes'),hash=createHash('sha256').update(body).digest('hex');
function fixture(){
 const calls=[];let responseVersion='provider-old';
 const response=()=>({VersionId:responseVersion,ContentLength:body.length,ContentType:'image/png',Metadata:{sha256:hash}});
 const client={async getObject(input){calls.push(['get',input]);return {...response(),Body:body};},async headObject(input){calls.push(['head',input]);return response();}};
 const storage=new S3CompatibleObjectStorage(client,{provider:'s3',bucket:'private-test',presignGet:async input=>{calls.push(['sign',input]);return 'https://storage.test/signed';}});
 return {calls,storage,setVersion:v=>{responseVersion=v;}};
}
test('exact provider selector propagates through GET, HEAD and signed GET without reading current version',async()=>{
 const f=fixture(),key='media/private.png',providerVersionId='provider-old';
 assert.deepEqual((await f.storage.get({scope,key,maxBytes:1000,expectedSha256:hash,providerVersionId})).body,body);
 assert.equal((await f.storage.head(scope,key,{providerVersionId})).versionId,providerVersionId);
 await f.storage.createPresignedGet({scope,key,expectedSha256:hash,providerVersionId,expiresInSeconds:60});
 assert.equal(f.calls.length,4);assert.ok(f.calls.every(([,input])=>input.VersionId===providerVersionId));
 assert.ok(f.calls.every(([,input])=>input.Key.startsWith('workspaces/'+scope.workspaceId+'/')));
});
test('ignored, missing or substituted provider selectors are rejected, never retried as current',async()=>{
 for(const version of [undefined,'provider-new']){
  const f=fixture();f.setVersion(version);
  await assert.rejects(f.storage.get({scope,key:'media/x',maxBytes:1000,providerVersionId:'provider-old'}),e=>e.code==='OBJECT_VERSION_MISMATCH');
  await assert.rejects(f.storage.head(scope,'media/x',{providerVersionId:'provider-old'}),e=>e.code==='OBJECT_VERSION_MISMATCH');
  assert.deepEqual(f.calls.map(c=>c[0]),['get','head']);
 }
 const f=fixture();for(const version of ['',null,'secret\n']){
  await assert.rejects(f.storage.get({scope,key:'media/x',maxBytes:1000,providerVersionId:version}),e=>e.code==='OBJECT_VERSION_INVALID');
 }assert.equal(f.calls.length,0);
});
test('local adapter explicitly rejects a provider selector rather than inventing one',async()=>{
 const local=new LocalObjectStorage('unused-object-version-fixture');
 await assert.rejects(local.get({scope,key:'media/x',maxBytes:1000,providerVersionId:'provider-token'}),e=>e.code==='OBJECT_VERSION_UNSUPPORTED');
 await assert.rejects(local.head(scope,'media/x',{providerVersionId:'provider-token'}),e=>e.code==='OBJECT_VERSION_UNSUPPORTED');
});
test('missing cloud historical version never falls back to latest',async()=>{
 let calls=0;const storage=new S3CompatibleObjectStorage({async getObject(){calls++;throw {name:'NoSuchVersion'};},
  async headObject(){calls++;throw {Code:'NoSuchVersion'};}},{provider:'s3',bucket:'private-test'});
 await assert.rejects(storage.get({scope,key:'media/x',maxBytes:1000,providerVersionId:'old'}),e=>e.code==='OBJECT_NOT_FOUND');
 assert.equal(await storage.head(scope,'media/x',{providerVersionId:'old'}),null);assert.equal(calls,2);
});
test('public internal-version request cannot choose selectors/paths/checksums or execute getters',()=>{
 const {parseObjectVersionRequest}=require('@lyra/shared'),objectId='obj_'+'a'.repeat(32);
 assert.deepEqual(parseObjectVersionRequest({objectId}),{objectId});
 for(const extra of [{providerVersionId:'fake'},{key:'secret/path'},{checksum:hash}])assert.throws(()=>parseObjectVersionRequest({objectId,...extra}),e=>e.code==='OBJECT_VERSION_INVALID');
 let reads=0;const value={};Object.defineProperty(value,'objectId',{enumerable:true,get(){reads++;throw Error('secret');}});
 assert.throws(()=>parseObjectVersionRequest(value));assert.equal(reads,0);
});
