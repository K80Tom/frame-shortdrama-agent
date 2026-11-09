const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sealProductionInputSnapshot } = require('../dist/production/input-snapshot');
const { createProductionInputValidationPorts: create } = require('../dist/production/input-validation-ports');
function fixture() {
  const tenant = { userId:'usr_'+'a'.repeat(32),workspaceId:'ws_'+'b'.repeat(32),role:'owner',requestId:'test-ports-factory' };
  const ref = {id:'resource-one',versionId:'resource-one',digest:'a'.repeat(64)};
  const snapshot = sealProductionInputSnapshot({schemaVersion:'lyra-production-input/1',id:'snapshot-one',workspaceId:tenant.workspaceId,
    projectId:'project-one',episodeId:'episode-one',baseProjectRevision:'1',state:'draft',shots:[{shotId:'shot-one',revisionId:'version-one',contentDigest:'a'.repeat(64)}],
    script:ref,plan:ref,storyboard:ref,assetPacks:[],directorScenes:[],controls:[],methodPacks:[],promptPacks:[],modelConnections:[],retrievalPolicy:ref,qualityGates:[],
    budgetPolicy:{version:ref,limitMicros:0,currency:'CNY',allowPaid:false},candidatePolicy:{mode:'direct',limit:1},automationMode:'auto',findings:[],
    createdBy:tenant.userId,createdAt:'2026-11-09T08:00:00.000Z',reason:'test'});
  let queries=0; const client={async query(sql,args){queries++;assert.match(sql,/FOR SHARE/);assert.equal(args[0],tenant.workspaceId);return {rows:[],rowCount:0};}};
  return {tenant,ref,snapshot,client,queries:()=>queries};
}
test('unregistered domains, bindings and capabilities fail closed with no pretend authorization',async()=>{
  const f=fixture(),ports=await create(f.client,f.tenant,f.snapshot);
  assert.equal(await ports.checkVersion(f.tenant,'model_connection',f.ref),'CAPABILITY_INCOMPATIBLE');
  assert.equal(await ports.checkObject(f.tenant,{}),'CAPABILITY_INCOMPATIBLE');
  assert.equal(await ports.checkAssetBinding(f.tenant,{}),'CAPABILITY_INCOMPATIBLE');
  assert.equal(await ports.checkControl(f.tenant,{}),'CAPABILITY_INCOMPATIBLE');
  assert.deepEqual(await ports.checkCapabilities(f.tenant,f.snapshot,[]),[{code:'CAPABILITY_INCOMPATIBLE',referenceId:null}]);
  assert.equal(f.queries(),0);
});
test('owner adapter receives exact transaction and cannot override PostgreSQL source checks',async()=>{
  const f=fixture();let domainCalls=0;
  const ports=await create(f.client,f.tenant,f.snapshot,undefined,async(client,ctx,snapshot)=>{
    assert.equal(client,f.client);assert.equal(ctx.workspaceId,f.tenant.workspaceId);assert.equal(snapshot.snapshotDigest,f.snapshot.snapshotDigest);
    return {versions:{model_connection:async()=>{domainCalls++;return null;},script:async()=>null}};
  });
  assert.equal(await ports.checkVersion(f.tenant,'script',f.ref),'REFERENCE_NOT_FOUND');assert.equal(f.queries(),1);
  assert.equal(await ports.checkVersion(f.tenant,'model_connection',f.ref),null);assert.equal(domainCalls,1);
});
test('ports reject a rebound principal or another project before touching database/domain adapters',async()=>{
  const f=fixture(),ports=await create(f.client,f.tenant,f.snapshot);
  await assert.rejects(ports.checkSource({...f.tenant,userId:'usr_'+'c'.repeat(32)},{}),e=>e.code==='REFERENCE_NOT_FOUND');
  assert.equal(await ports.authorizeProject(f.tenant,'project-other'),false);assert.equal(f.queries(),0);
  await assert.rejects(create(f.client,{...f.tenant,workspaceId:'ws_'+'c'.repeat(32)},f.snapshot),e=>e.code==='REFERENCE_NOT_FOUND');
});
