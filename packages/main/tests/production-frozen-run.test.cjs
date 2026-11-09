const {test}=require('node:test');
const assert=require('node:assert/strict');
const shared=require('@lyra/shared');
const {sealShotSpecV2}=require('../dist/production/shot-spec');
const {sealProductionInputSnapshot,verifyProductionInputSnapshot}=require('../dist/production/input-snapshot');
const {compileFrozenProductionRun,FrozenProductionRunCreator}=require('../dist/production/frozen-run');
const {MemoryProductionRepository}=require('../dist/production/repository');
const {ProductionService}=require('../dist/production/service');
const at='2026-11-09T09:00:00.000Z';
const tenant={userId:'usr_'+'a'.repeat(32),workspaceId:'ws_'+'b'.repeat(32),role:'owner',requestId:'frozen-run-test'};
const ref=id=>({id,versionId:id,digest:'c'.repeat(64)});
function fixture() {
  const policy=shared.DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY;
  const shot=sealShotSpecV2({schemaVersion:'lyra-shot-spec/2',revisionId:'shotversion_one',workspaceId:tenant.workspaceId,
    projectId:'project_one',episodeId:'episode_one',scriptVersionId:'script_one',planRevisionId:'plan_one',storyboardRevisionId:'board_one',
    shotId:'shot_one',sceneId:'scene_one',order:1,durationMs:5000,ratio:'9:16',shotSize:'wide',
    camera:{description:null,movement:'still',focalLengthMm:null,composition:null},dialogue:[],actions:[],assetPacks:[],controls:[],
    visualStyle:'offline',negativeConstraints:[],continuity:{before:[],after:[]},timeline:[],sourceRefs:[],
    generation:{methodPackRevisions:[],promptPackRevision:ref('prompt_one'),modelCapabilityRevision:ref('capability_one'),candidatePolicy:{mode:'direct',limit:1}},
    source:{kind:'user',actor:tenant.userId,sourceRevisionId:null},createdAt:at});
  const snapshot=sealProductionInputSnapshot({schemaVersion:'lyra-production-input/1',id:'snapshot_one',workspaceId:tenant.workspaceId,
    projectId:shot.projectId,episodeId:shot.episodeId,baseProjectRevision:'10',state:'frozen',findings:[],
    shots:[{shotId:shot.shotId,revisionId:shot.revisionId,contentDigest:shot.contentDigest}],script:ref('script_one'),plan:ref('plan_one'),storyboard:ref('board_one'),
    assetPacks:[],directorScenes:[],controls:[],methodPacks:[],promptPacks:[ref('prompt_one')],modelConnections:[],
    retrievalPolicy:{...ref('retrieval_one'),digest:policy.policyDigest},qualityGates:[ref('gate_one')],
    budgetPolicy:{version:ref('budget_one'),limitMicros:0,currency:'CNY',allowPaid:true},candidatePolicy:{mode:'direct',limit:1},automationMode:'auto',
    executionPolicy:{ratio:'9:16',visualStyle:'offline',targetDurationSec:15,qualityPreset:'balanced',directorPolicy:'never'},
    createdBy:tenant.userId,createdAt:at,reason:'unit oracle, not production authorization'});
  return {input:{snapshot,shots:[shot]},assetRetrievalPolicy:policy,methodPacks:[]};
}
const request=f=>({snapshotId:f.input.snapshot.id,snapshotDigest:f.input.snapshot.snapshotDigest,clientRequestId:'request_one',allowPaid:true});
function reseal(f,change) {const {snapshotDigest,...draft}=f.input.snapshot;change(draft);f.input.snapshot=sealProductionInputSnapshot(draft);return f;}
test('exact frozen policy/versions bind all task manifests and the created event',()=>{
  const f=fixture(),run=compileFrozenProductionRun(tenant,request(f),f,at);
  assert.equal(run.scriptVersionId,'script_one');assert.equal(run.budgetMicros,0);assert.equal(run.visualStyle,'offline');
  assert.equal(run.inputSnapshot.snapshotDigest,f.input.snapshot.snapshotDigest);
  assert.ok(run.tasks.every(t=>t.inputManifest.some(r=>r.kind==='productionInput'&&r.digest===run.inputSnapshot.snapshotDigest)));
  assert.ok(run.tasks.every(t=>t.inputManifest.some(r=>r.kind==='script'&&r.digest===f.input.snapshot.script.digest)));
  assert.equal(run.outbox[0].payload.snapshotDigest,run.inputSnapshot.snapshotDigest);
});
test('closed request rejects overrides, absent payment confirmation and active accessors',()=>{
  const f=fixture();for(const override of [{ratio:'16:9'},{budgetMicros:1},{allowPaid:false},{clientRequestId:'x\n'}]) {
    assert.throws(()=>shared.parseCreateSnapshotProductionRun({...request(f),...override}));
  }
  let reads=0;const input=request(f);Object.defineProperty(input,'snapshotId',{enumerable:true,get(){reads++;return 'secret';}});
  assert.throws(()=>shared.parseCreateSnapshotProductionRun(input));assert.equal(reads,0);
});
test('older snapshot body remains readable with the same digest, but is not upgraded from current defaults',()=>{
  const f=reseal(fixture(),d=>{delete d.executionPolicy;});
  assert.equal(Object.hasOwn(verifyProductionInputSnapshot(f.input.snapshot),'executionPolicy'),false);
  assert.throws(()=>compileFrozenProductionRun(tenant,request(f),f,at),e=>e.code==='CAPABILITY_INCOMPATIBLE');
});
test('execution policy contributes to digest; malformed and unknown execution fields are rejected',()=>{
  const f=fixture(),old=f.input.snapshot.snapshotDigest;reseal(f,d=>{d.executionPolicy.visualStyle='new';});assert.notEqual(f.input.snapshot.snapshotDigest,old);
  for(const policy of [{targetDurationSec:0},{qualityPreset:'unknown'},{extra:true},{visualStyle:'\ud800'}]) {
    assert.throws(()=>reseal(fixture(),d=>{Object.assign(d.executionPolicy,policy);}));
  }
});
test('draft/ready, denied budget, cross-tenant and modified shot/ref cannot create a run',()=>{
  for(const state of ['draft','ready']) {const f=reseal(fixture(),d=>{d.state=state;});assert.throws(()=>compileFrozenProductionRun(tenant,request(f),f,at),e=>e.code==='SNAPSHOT_NOT_READY');}
  const denied=reseal(fixture(),d=>{d.budgetPolicy.allowPaid=false;});assert.throws(()=>compileFrozenProductionRun(tenant,request(denied),denied,at));
  const f=fixture();assert.throws(()=>compileFrozenProductionRun({...tenant,workspaceId:'ws_'+'d'.repeat(32)},request(f),f,at),e=>e.status===404);
  assert.throws(()=>compileFrozenProductionRun({...tenant,role:'viewer'},request(f),f,at),e=>e.status===403);
  f.input.shots[0].camera.movement='changed';assert.throws(()=>compileFrozenProductionRun(tenant,request(f),f,at));
  const wrong=fixture();wrong.assetRetrievalPolicy={...wrong.assetRetrievalPolicy,threshold:0.4};assert.throws(()=>compileFrozenProductionRun(tenant,request(wrong),wrong,at));
  const methods=fixture();methods.methodPacks=[{id:'extra',digest:'a'.repeat(64),nodes:[],excerpt:'unfrozen'}];assert.throws(()=>compileFrozenProductionRun(tenant,request(methods),methods,at));
});
test('creator retries/concurrent requests preserve original facts without registry re-resolution',async()=>{
  const f=fixture(),repo=new MemoryProductionRepository();let reads=0;
  const creator=new FrozenProductionRunCreator(repo,async()=>{reads++;return f;},()=>new Date(at));
  const [a,b]=await Promise.all([creator.create(tenant,request(f)),creator.create(tenant,request(f))]);assert.equal(a.id,b.id);
  const before=reads;await creator.create(tenant,request(f));assert.equal(reads,before);
  await assert.rejects(creator.create(tenant,{...request(f),snapshotDigest:'f'.repeat(64)}),e=>e.code==='PRODUCTION_REQUEST_REUSED');
  assert.equal(reads,before);
});
test('repository cannot remove/change binding, frozen budget, policy contents or task binding',async()=>{
  const f=fixture(),repo=new MemoryProductionRepository(),run=await repo.create(compileFrozenProductionRun(tenant,request(f),f,at));
  for(const change of [r=>{delete r.inputSnapshot;},r=>{r.inputSnapshot.snapshotDigest='a'.repeat(64);},r=>{r.budgetMicros++;},r=>{r.assetRetrievalPolicy.threshold=0.4;},r=>{r.tasks[0].inputManifest=[];}]) {
    const next=structuredClone(run);change(next);await assert.rejects(repo.replace(next,0));
  }
  const next=structuredClone(run);next.updatedAt='2026-11-09T10:00:00.000Z';assert.equal((await repo.replace(next,0)).version,1);
});
test('unfinished V2 is never handed to legacy current-project executors or legacy create/budget paths',async()=>{
  const f=fixture(),repo=new MemoryProductionRepository(),run=await repo.create(compileFrozenProductionRun(tenant,request(f),f,at));
  let calls=0;const service=new ProductionService(repo,{executors:[{stage:'prepare',async prepare(){calls++;throw Error('legacy');},async execute(){calls++;}}]});
  await service.tick(run.id);assert.equal(calls,0);assert.equal((await repo.get(run.id)).attempts.length,0);
  await assert.rejects(service.action(run.id,{type:'raiseBudget',budgetMicros:1,reason:'unsafe'}),e=>e.code==='FROZEN_BUDGET_REQUIRES_NEW_SNAPSHOT');
  const legacy=Object.fromEntries(shared.CREATE_KEYS.map(k=>[k,run[k]]));await assert.rejects(service.create(legacy),e=>e.code==='PRODUCTION_REQUEST_REUSED');
});
