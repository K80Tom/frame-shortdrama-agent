const {test}=require('node:test');
const assert=require('node:assert/strict');
const {MemoryProductionRepository}=require('../dist/production/repository');
const {compileFrozenProductionRun}=require('../dist/production/frozen-run');
const {ProductionService}=require('../dist/production/service');
const {at,tenant,fixture,request,reseal}=require('./helpers/frozen-input-fixture.cjs');

for(const paid of [false,true])for(const sinkMode of ['capture','sync','async','pending']){
 test(`V2 frozen rejection preserves exact input, authorization and settlement with paid=${paid}, sink=${sinkMode}`,async()=>{
  const f=reseal(fixture(),draft=>{draft.budgetPolicy.limitMicros=100;});
  const repository=new MemoryProductionRepository();
  const run=await repository.create(compileFrozenProductionRun(tenant,request(f),f,at));
  const rows=[];let loads=0,authorizations=0,submits=0;
  const service=new ProductionService(repository,{
   frozenInputLoader:async persisted=>{loads++;assert.equal(persisted.id,run.id);return structuredClone(f.input);},
   authorizeFrozenPaidExecution:async context=>{authorizations++;assert.deepEqual(context.input,f.input);},
   diagnosticSink:line=>{
    rows.push(JSON.parse(line));
    if(sinkMode==='sync')throw Error('PRIVATE_SINK_EXCEPTION');
    if(sinkMode==='async')return Promise.reject(Error('PRIVATE_SINK_EXCEPTION'));
    if(sinkMode==='pending')return new Promise(()=>{});
   },
   executors:[{stage:'prepare',frozenInputVersion:1,
    async prepare(context){assert.deepEqual(context.frozenInput,f.input);return {executor:'offline-diagnostic-fixture',inputDigest:'frozen-diagnostic-input',
      estimateCostMicros:paid?100:0,requiresPaid:paid,provider:paid?'offline-stub':null};},
    async execute(context){
     submits++;assert.deepEqual(context.frozenInput,f.input);
     return {state:'succeeded',artifacts:[{key:'bad',kind:'text',get title(){throw Error('sk-privatefixture https://provider.invalid/private?token=secret');}}]};
    },
   }],
  });
  await service.tick(run.id);await new Promise(resolve=>setImmediate(resolve));
  const stored=await repository.get(run.id),task=stored.tasks[0];
  assert.equal(submits,1);assert.equal(loads,1);assert.equal(authorizations,paid?1:0);
  assert.deepEqual(stored.inputSnapshot,run.inputSnapshot);assert.equal(stored.attempts[0].status,'failed');
  assert.equal(task.status,paid?'waitingHuman':'failed');
  assert.equal(stored.budgetLedger.filter(e=>e.kind==='charge').reduce((n,e)=>n+e.amountMicros,0),0);
  if(paid){
   assert.equal(stored.externalOperations[0].status,'unknown');
   assert.equal(stored.budgetLedger.filter(e=>e.kind==='reserve').reduce((n,e)=>n+e.amountMicros,0),100);
   assert.equal(stored.budgetLedger.filter(e=>e.kind==='release').reduce((n,e)=>n+e.amountMicros,0),0);
   await assert.rejects(service.action(run.id,{type:'retryTask',taskId:task.id,reason:'do not duplicate unknown paid operation'}),e=>e.code==='PRODUCTION_EXTERNAL_OPERATION_UNKNOWN');
  }else assert.equal(stored.externalOperations.length,0);
  assert.equal(rows.length,1);assert.equal(rows[0].runId,run.id);assert.equal(rows[0].taskId,task.id);
  if(paid)assert.equal(rows[0].operationId,stored.externalOperations[0].id);
  assert.equal(rows[0].event,'production.task.output_rejected');
  assert.ok(Object.keys(rows[0]).every(key=>['schemaVersion','level','event','timestamp','projectId','runId','taskId','attemptId','operationId'].includes(key)));
  assert.doesNotMatch(JSON.stringify(rows),/privatefixture|provider\.invalid|token=|PRIVATE_SINK_EXCEPTION|frozen-diagnostic-input/);
  await service.tick(run.id);assert.equal(submits,1,'diagnostic delivery cannot implicitly resubmit work');
 });
}
