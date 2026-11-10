const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const {Client}=require('pg');
const {AgentRuntime}=require('@lyra/agent');
const {PostgresDatabase}=require('../dist/db/client');
const {PostgresAgentRuntimeStore}=require('../dist/agent-runtime/postgres-store');
const token=()=>randomBytes(16).toString('hex');
test('real PostgreSQL claim rolls back Run/Attempt/event together and concurrent claim has one winner',{
 skip:process.env.DATABASE_ADMIN_URL && (process.env.DATABASE_APP_URL||process.env.DATABASE_URL)?false:'isolated app/admin URLs required',timeout:20000,
},async t=>{
 const admin=new Client({connectionString:process.env.DATABASE_ADMIN_URL});await admin.connect();
 const db=new PostgresDatabase({connectionString:process.env.DATABASE_APP_URL||process.env.DATABASE_URL},{unscopedAccess:'deny'});
 t.after(async()=>{await db.close();await admin.end();});await db.verifyTenantRole();
 const workspaceId='ws_'+'0'.repeat(32), userId='usr_'+token(), now=new Date('2026-01-01T00:00:00.000Z'), digest='a'.repeat(64);
 await db.runWithTenant({workspaceId,userId,role:'member',requestId:'claim-test-'+token()},async()=>{
  const store=new PostgresAgentRuntimeStore(db), runtime=new AgentRuntime(store,{now:()=>now});
  const snapshot={workspaceId,projectId:null,userId,role:'member',agent:{agentId:'claim-test',version:'1.0.0',manifestDigest:digest},inputRevisions:[],prompt:{revisionId:'pmt_test',digest},method:null,model:{role:'general',modelId:'stub'},tools:[],workflow:null,code:{digest},budget:{maxMicros:10000,currency:'CNY'},timeout:{runMs:60000},maxSteps:4,seed:1,contextSnapshotDigest:digest,createdAt:now.toISOString()};
  for(const target of ['agent_run_attempts','agent_events']) {
   const run=await runtime.createRun({runId:'run_'+token(),snapshot,now:()=>now});
   await runtime.transition(run.runId,'planning',{summary:'plan'});await runtime.transition(run.runId,'queued',{summary:'queue'});
   const before=await store.getRun(run.runId), events=(await store.listEvents(run.runId)).length;
   const constraint='reject_claim_'+token();
   await admin.query(`ALTER TABLE ${target} ADD CONSTRAINT ${constraint} CHECK(run_id<>'${run.runId}') NOT VALID`);
   try {
    await assert.rejects(runtime.claim(run.runId,{leaseOwner:'worker-one',ttlMs:5000}));
    assert.deepEqual(await store.getRun(run.runId),before);
    assert.equal((await store.listAttempts(run.runId)).length,0);
    assert.equal((await store.listEvents(run.runId)).length,events);
   }finally{await admin.query(`ALTER TABLE ${target} DROP CONSTRAINT ${constraint}`);}
   const outcomes=await Promise.allSettled(['worker-one','worker-two'].map(leaseOwner=>runtime.claim(run.runId,{leaseOwner,ttlMs:5000})));
   assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
   const current=await store.getRun(run.runId), attempts=await store.listAttempts(run.runId);
   assert.equal(current.state,'running');assert.equal(attempts.length,1);assert.equal(current.currentAttemptId,attempts[0].attemptId);
   assert.equal(current.leaseOwner,attempts[0].leaseOwner);assert.equal((await store.listEvents(run.runId)).length,events+1);
  }
 });
});
