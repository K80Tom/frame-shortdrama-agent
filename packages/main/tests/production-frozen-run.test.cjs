const {test}=require('node:test');
const assert=require('node:assert/strict');
const shared=require('@lyra/shared');
const {sealShotSpecV2}=require('../dist/production/shot-spec');
const {sealProductionInputSnapshot,verifyProductionInputSnapshot}=require('../dist/production/input-snapshot');
const {compileFrozenProductionRun,FrozenProductionRunCreator}=require('../dist/production/frozen-run');
const {MemoryProductionRepository}=require('../dist/production/repository');
const {ProductionService}=require('../dist/production/service');
const {BreakdownProductionExecutor,StoryboardProductionExecutor}=require('../dist/production/runtime');
const {at,tenant,fixture,request,reseal}=require('./helpers/frozen-input-fixture.cjs');

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
test('native frozen source executors expand exact ShotSpec versions without any current lookup or generation',async()=>{
  const f=fixture(),run=compileFrozenProductionRun(tenant,request(f),f,at);
  let calls=0;const forbidden=new Proxy({}, {get(){return ()=>{calls++;throw Error('mutable reader/generation must not be used');};}});
  const breakdown=new BreakdownProductionExecutor(forbidden,forbidden,{estimateCostMicros:100});
  const storyboard=new StoryboardProductionExecutor(forbidden,forbidden,{estimateCostMicros:100});
  for(const executor of [breakdown,storyboard]) {
    const task=run.tasks.find(t=>t.stage===executor.stage),context={run,task,frozenInput:f.input,attemptId:'attempt_one',inputDigest:'x',operationKey:null};
    const prepared=await executor.prepare(context);assert.equal(prepared.requiresPaid,false);assert.equal(prepared.estimateCostMicros,0);
    const outcome=await executor.execute(context);assert.equal(outcome.state,'succeeded');
    assert.equal(outcome.artifacts[0].metadata.snapshotDigest,f.input.snapshot.snapshotDigest);
    if(executor.stage==='storyboard') {
      assert.deepEqual([...new Set(outcome.spawnTasks.map(t=>t.scope.id))],['shot_one']);
      assert.equal(outcome.artifacts[0].metadata.shots[0].revisionId,f.input.shots[0].revisionId);
      assert.equal(outcome.artifacts[0].metadata.shots[0].durationMs,5000);
    }
    await assert.rejects(executor.prepare({run,task}),e=>e.code==='SNAPSHOT_NOT_READY');
    await executor.review({...context,input:{decision:'approve'}});
  }
  assert.equal(calls,0);
});
test('scheduler loads and validates the frozen bundle, then runs native source stages before unsupported media',async()=>{
  const f=fixture(),repo=new MemoryProductionRepository(),run=await repo.create(compileFrozenProductionRun(tenant,request(f),f,at));
  const forbidden=new Proxy({}, {get(){return ()=>{throw Error('current input forbidden');};}});
  let loads=0;const service=new ProductionService(repo,{frozenInputLoader:async persisted=>{loads++;assert.equal(persisted.id,run.id);return structuredClone(f.input);},
    executors:[new BreakdownProductionExecutor(forbidden,forbidden,{estimateCostMicros:100}),new StoryboardProductionExecutor(forbidden,forbidden,{estimateCostMicros:100})]});
  assert.equal(run.tasks.find(t=>t.stage==='storyboard').status,'pending');
  await service.tick(run.id);let stored=await repo.get(run.id);
  assert.equal(stored.tasks.find(t=>t.stage==='prepare').status,'succeeded');assert.equal(stored.tasks.find(t=>t.stage==='breakdown').status,'ready');
  await service.tick(run.id);await service.tick(run.id);stored=await repo.get(run.id);
  assert.equal(stored.tasks.find(t=>t.stage==='storyboard').status,'succeeded');assert.equal(loads,3);
  assert.ok(stored.tasks.some(t=>t.stage==='video'&&t.scope.kind==='shot'&&t.scope.id==='shot_one'));
  assert.ok(stored.tasks.every(t=>t.inputManifest.some(r=>r.kind==='productionInput'&&r.digest===run.inputSnapshot.snapshotDigest)));
  assert.equal(stored.externalOperations.length,0);assert.equal(stored.budgetLedger.length,0);
});
test('tampered loader result or an unadapted executor is blocked before prepare, claim or budget',async()=>{
  const f=fixture();for(const malformed of [true,false]) {
    const repo=new MemoryProductionRepository(),run=await repo.create(compileFrozenProductionRun(tenant,request(f),f,at));let calls=0;
    const executor={stage:'prepare',...(malformed?{frozenInputVersion:1}:{}),async prepare(){calls++;return {executor:'stub',inputDigest:'x',estimateCostMicros:0,requiresPaid:false,provider:null};},async execute(){calls++;return {state:'succeeded'};}};
    const bad=structuredClone(f.input);if(malformed)bad.shots[0].durationMs++;
    const service=new ProductionService(repo,{frozenInputLoader:async()=>bad,executors:[executor]});await service.tick(run.id);
    const saved=await repo.get(run.id);assert.equal(calls,0);assert.equal(saved.attempts.length,0);assert.equal(saved.budgetLedger.length,0);
  }
});
test('snapshotDigest binds the paid operation and a new service reconciles the same frozen input without resubmit',async()=>{
  const f=fixture(),repo=new MemoryProductionRepository(),run=await repo.create(compileFrozenProductionRun(tenant,request(f),f,at));
  let submits=0,authorizations=0,reconciles=0;let key;
  const executor={stage:'prepare',frozenInputVersion:1,
    async prepare(ctx){assert.deepEqual(ctx.frozenInput,f.input);return {executor:'stub-paid',inputDigest:'exact-provider-input',estimateCostMicros:0,requiresPaid:true,provider:'offline-stub'};},
    async execute(ctx){submits++;key=ctx.operationKey;assert.ok(key);return {state:'waitingExternal',providerTaskId:'stub_one'};},
    async reconcile(ctx,op){reconciles++;assert.deepEqual(ctx.frozenInput,f.input);assert.equal(ctx.operationKey,key);assert.equal(op.providerTaskId,'stub_one');return {state:'succeeded',actualCostMicros:0};}};
  const options={frozenInputLoader:async()=>structuredClone(f.input),authorizeFrozenPaidExecution:async()=>{authorizations++;},executors:[executor]};
  await new ProductionService(repo,options).tick(run.id);
  const saved=await repo.get(run.id);const expected=shared.canonicalDigest({snapshotDigest:run.inputSnapshot.snapshotDigest,executorInputDigest:'exact-provider-input'});
  assert.equal(saved.attempts[0].inputDigest,expected);
  assert.equal(key,shared.canonicalDigest({runId:run.id,taskId:run.tasks[0].id,taskVersion:0,attempt:1,inputDigest:expected}));
  await new ProductionService(repo,options).tick(run.id);
  assert.equal(submits,1);assert.equal(authorizations,1);assert.equal(reconciles,1);
  assert.equal((await repo.get(run.id)).externalOperations[0].status,'succeeded');
});
test('missing/revoked current paid authorization never reaches the executor and settles at zero, not unknown',async()=>{
  const f=reseal(fixture(),d=>{d.budgetPolicy.limitMicros=100;});
  for(const [revoked,requiresPaid] of [[false,true],[true,true],[false,false],[true,false]]) {
    const repo=new MemoryProductionRepository(),run=await repo.create(compileFrozenProductionRun(tenant,request(f),f,at));let calls=0;
    const options={frozenInputLoader:async()=>f.input,executors:[{stage:'prepare',frozenInputVersion:1,
      async prepare(){return {executor:'stub',inputDigest:'x',estimateCostMicros:50,requiresPaid,provider:requiresPaid?'offline-stub':null};},
      async execute(){calls++;return {state:'succeeded'};}}]};
    if(revoked)options.authorizeFrozenPaidExecution=async()=>{throw Error('revoked secret');};
    await new ProductionService(repo,options).tick(run.id);const saved=await repo.get(run.id);
    assert.equal(calls,0);
    if(requiresPaid) {assert.equal(saved.externalOperations[0].status,'failed');assert.equal(saved.externalOperations[0].actualCostMicros,0);}
    else assert.equal(saved.externalOperations.length,0);
    assert.equal(saved.tasks[0].blockingReason.code,'FROZEN_INPUT_AUTHORIZATION_REQUIRED');
    assert.equal(saved.budgetLedger.filter(e=>e.kind==='charge').reduce((n,e)=>n+e.amountMicros,0),0);
    assert.equal(saved.budgetLedger.filter(e=>e.kind==='release').reduce((n,e)=>n+e.amountMicros,0),50);
  }
});
