const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createApp}=require('../dist/app');const {readConfig}=require('../dist/config');
const ws='ws_'+'a'.repeat(32),candidate='evocand_'+'b'.repeat(32),rollout='evoroll_'+'c'.repeat(32);
const paths=[['candidates/'+candidate+'/gate','gate'],['candidates/'+candidate+'/approvals','gate'],['candidates/'+candidate+'/rejections','gate'],['candidates/'+candidate+'/rollback','gate'],['candidates/'+candidate+'/canary','gate'],['rollouts/'+rollout+'/observations','gate'],['rollouts/'+rollout+'/stop','gate'],['rollouts/'+rollout+'/promote','gate'],['candidates/'+candidate+'/shadow','facade'],['candidates/'+candidate+'/canary','facade'],['candidates/'+candidate+'/adopt','facade'],['registry/rollback','facade']];
test('both governance HTTP surfaces reject member/viewer roles before payload or service access',{timeout:15000},async t=>{
 let role='member',calls=0;
 const gate=Object.fromEntries(['bindGate','approve','reject','rollback','startCanary','observe','stopCanary','promote'].map(name=>[name,async()=>{calls++;return {ok:true};}]));
 const app=await createApp(readConfig({LYRA_AUTH_MODE:'session'}),async()=>{throw new Error('no provider');},{authService:{async authenticate(){return {tenant:{workspaceId:ws,userId:'usr_'+'d'.repeat(32),role,requestId:'publisher-test'},sessionId:'session-one'};},verifyCsrf(){}},evolutionGateService:gate,assetRetrievalGovernanceService:{evolutionGateService(){return gate;}}});
 t.after(()=>app.close());
 for(const denied of ['member','viewer']){role=denied;for(const [path,surface] of paths){
  const prefix=surface==='gate'?'/api/evolution/gate/':'/api/workspaces/'+ws+'/asset-retrieval-governance/';
  const response=await app.inject({method:'POST',url:prefix+path,headers:{host:'127.0.0.1:8788','x-shortdrama-call':'1'},payload:{role:'owner',actorId:'forged',expectedVersion:1}});
  assert.equal(response.statusCode,403,path+':'+response.body);
 }}assert.equal(calls,0);
 for(const allowed of ['owner','admin']){role=allowed;const response=await app.inject({method:'POST',url:'/api/evolution/gate/candidates/'+candidate+'/approvals',headers:{host:'127.0.0.1:8788','x-shortdrama-call':'1'},payload:{expectedVersion:1,reason:'explicit approval'}});assert.equal(response.statusCode,200,response.body);}
 assert.equal(calls,2);
});
