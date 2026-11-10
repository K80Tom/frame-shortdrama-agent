const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../dist/app');
const { readConfig } = require('../dist/config');
const tenant = { workspaceId: 'ws_'+'a'.repeat(32),userId:'usr_'+'b'.repeat(32),role:'owner',requestId:'route-test-one' };
const routes = [ ['candidates/candidate-one/evaluate','startEvaluation',{}],
  ['candidates/candidate-one/shadow','startCanary',{}], ['candidates/candidate-one/canary','startCanary',{}],
  ['candidates/candidate-one/adopt','promote',{rolloutId:'rollout-one',rolloutExpectedVersion:2,reason:'explicit adoption'}],
  ['registry/rollback','rollback',{candidateVersionId:'version-one',reason:'explicit rollback'}] ];
for (const [path,method,extra] of routes) test('governance HTTP '+path+' delegates only a valid scalar version', async t => {
  const calls=[];
  const gate=Object.fromEntries(['startEvaluation','startCanary','promote','rollback'].map(name=>[name,async(...args)=>{calls.push({name,args});return {ok:true};}]));
  const app=await createApp(readConfig({LYRA_AUTH_MODE:'session'}),async()=>{throw new Error('no provider');},{
    // Controlled authenticated principal and gate collaborators: real HTTP routing/parsing, not an authority/DB integration test.
    authService:{async authenticate(){return {tenant,sessionId:'session-test',csrfToken:'test-token'};},verifyCsrf(){}},
    assetRetrievalGovernanceService:{evolutionGateService(){return gate;}}
  });t.after(()=>app.close());
  const invoke=body=>app.inject({method:'POST',url:'/api/workspaces/'+tenant.workspaceId+'/asset-retrieval-governance/'+path,
    headers:{host:'127.0.0.1:8788','x-shortdrama-call':'1','content-type':'application/json'},payload:body});
  const good=await invoke({...extra,expectedVersion:3,actorId:'forged-client'});
  assert.ok([200,201].includes(good.statusCode),good.body);assert.equal(calls.length,1);assert.equal(calls[0].name,method);
  const delegated=calls[0].args[2];assert.equal(delegated.expectedVersion,3);assert.equal(delegated.actorId,tenant.userId);
  for(const value of [undefined,null,0,-1,1.5,'3',{},[]]) {
    const response=await invoke({...extra,...(value===undefined?{}:{expectedVersion:value})});
    assert.equal(response.statusCode,400,response.body);assert.equal(response.json().error.code,'ASSET_RETRIEVAL_INPUT_INVALID');assert.equal(calls.length,1);
  }
  if(method==='promote') {const response=await invoke({...extra,expectedVersion:3,rolloutExpectedVersion:'2'});assert.equal(response.statusCode,400);assert.equal(calls.length,1);}
});
