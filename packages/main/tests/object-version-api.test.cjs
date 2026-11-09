const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createApp}=require('../dist/app');
const {readConfig}=require('../dist/config');
const {AuthService,passwordHash}=require('../dist/auth/service');
const {createObjectVersionRuntime}=require('../dist/production-media/object-version-worker');
const {tenantExecutionScope}=require('../dist/tenancy/scope');
const userId='usr_'+'1'.repeat(32),workspaceId='ws_'+'2'.repeat(32),other='ws_'+'3'.repeat(32);
const objectId='obj_'+'4'.repeat(32),id='objver_'+'5'.repeat(32);
const base={host:'127.0.0.1:8788','x-shortdrama-call':'1'};
async function fixture(t,role='member',enabled=true){
 const sessions=new Map(),salt='6'.repeat(32),hash=await passwordHash('correct horse battery staple',salt),calls=[];
 const auth=new AuthService({
  async findCredential(){return {userId,displayName:'test',passwordSalt:salt,passwordHash:hash,passwordAlgorithm:'scrypt-v1'};},
  async listWorkspaces(){return [{id:workspaceId,slug:'one',name:'one',role},{id:other,slug:'two',name:'two',role}];},
  async createSession(s){sessions.set(s.tokenHash,s);},
  async findSession(tokenHash){const s=sessions.get(tokenHash);return s?{id:s.id,userId,currentWorkspaceId:s.currentWorkspaceId,csrfHash:s.csrfHash,expiresAt:s.expiresAt,revokedAt:null,displayName:'test'}:null;},
  async touchSession(_id,currentWorkspaceId){for(const s of sessions.values())s.currentWorkspaceId=currentWorkspaceId;},
 },{sessionTtlSeconds:3600});
 const version={schemaVersion:'lyra-object-version/1',id,objectId,workspaceId,status:'pending',checksum:'a'.repeat(64),sizeBytes:42,contentType:'image/png',createdBy:userId,createdAt:new Date().toISOString(),verifiedAt:null,version:1};
 const api={async request(tenant,input){calls.push({tenant,input,scope:tenantExecutionScope.current()});return version;},async get(tenant,key){calls.push({tenant,key});return tenant.workspaceId===workspaceId&&key===id?version:null;}};
 const app=await createApp(readConfig({LYRA_AUTH_MODE:'session'}),fetch,{authService:auth,...(enabled?{objectVersions:api}:{})});t.after(()=>app.close());
 const login=await app.inject({method:'POST',url:'/api/auth/login',headers:base,payload:{email:'test@example.com',password:'correct horse battery staple'}});assert.equal(login.statusCode,200);
 const cookie=[].concat(login.headers['set-cookie']).map(s=>s.split(';')[0]).join('; ');
 const csrf=decodeURIComponent(cookie.split('; ').find(s=>s.startsWith('lyra_csrf=')).slice('lyra_csrf='.length));
 return {app,calls,version,headers:{...base,cookie,'x-csrf-token':csrf}};
}
test('object version API uses real session/CSRF middleware and trusted tenant; closed requests return 400',async t=>{
 const {app,headers,calls,version}=await fixture(t);
 const send=(payload,extra={})=>app.inject({method:'POST',url:'/api/object-versions',headers:{...headers,...extra},payload});
 assert.equal((await send({objectId},{cookie:''})).statusCode,401);
 assert.equal((await send({objectId},{'x-csrf-token':''})).statusCode,403);
 let deep='bad';for(let i=0;i<30;i++)deep={nested:deep};
 for(const payload of [{objectId,workspaceId:other},{objectId,createdBy:userId},{objectId,key:'private/key'},{objectId,providerVersionId:'current'},{objectId:'bad'},{},deep]){
  const response=await send(payload);assert.equal(response.statusCode,400);assert.equal(response.json().error.code,'OBJECT_VERSION_INVALID');
 }
 assert.equal(calls.length,0);
 const accepted=await send({objectId});assert.equal(accepted.statusCode,202);assert.deepEqual(accepted.json(),version);assert.equal(accepted.headers['cache-control'],'private, no-store');
 assert.equal(calls[0].tenant.workspaceId,workspaceId);assert.equal(calls[0].tenant.userId,userId);assert.equal(calls[0].scope.tenant.workspaceId,workspaceId);assert.deepEqual(calls[0].input,{objectId});
 const status=await app.inject({url:'/api/object-versions/'+id,headers});assert.equal(status.statusCode,200);assert.deepEqual(status.json(),version);
 assert.equal((await app.inject({url:'/api/object-versions/'+id,headers:{...headers,'x-workspace-id':other}})).statusCode,404);
 assert.equal((await app.inject({url:'/api/object-versions/provider-latest',headers})).statusCode,400);
});
test('viewers may read status but cannot schedule version copies; unmigrated API fails closed',async t=>{
 const viewer=await fixture(t,'viewer');
 assert.equal((await viewer.app.inject({method:'POST',url:'/api/object-versions',headers:viewer.headers,payload:{objectId}})).statusCode,403);
 assert.equal((await viewer.app.inject({url:'/api/object-versions/'+id,headers:viewer.headers})).statusCode,200);
 assert.equal(viewer.calls.length,1);
 const absent=await fixture(t,'owner',false);
 const response=await absent.app.inject({method:'POST',url:'/api/object-versions',headers:absent.headers,payload:{objectId}});assert.equal(response.statusCode,503);assert.equal(response.json().error.code,'OBJECT_VERSION_UNAVAILABLE');
});
test('legacy local-token access cannot invent an authenticated tenant for object versions',async t=>{
 let called=false;const app=await createApp(readConfig({}),fetch,{objectVersions:{async request(){called=true;},async get(){called=true;}}});t.after(()=>app.close());
 const response=await app.inject({method:'POST',url:'/api/object-versions',headers:base,payload:{objectId}});assert.equal(response.statusCode,401);assert.equal(called,false);
});
test('object version runtime is migration gated and constructs the existing fenced handler without storage IO',async()=>{
 const queries=[],db={async hasMigrations(versions){queries.push(versions);return false;}};
 assert.equal(await createObjectVersionRuntime(db,{}),null);assert.deepEqual(queries,[['044']]);
 db.hasMigrations=async()=>true;const runtime=await createObjectVersionRuntime(db,{});assert.equal(runtime.handler.kind,'object.version.materialize');assert.equal(runtime.handler.queueName,'object_versions');assert.equal(runtime.handler.settlement,'domain_transaction');assert.equal(typeof runtime.repository.request,'function');
});
