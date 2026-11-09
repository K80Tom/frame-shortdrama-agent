const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { canonicalDigest } = require('@lyra/shared');
const { PostgresDatabase } = require('../dist/db/client');
const { readConfig } = require('../dist/config');
const { PostgresBreakdownRepository } = require('../dist/breakdown/repository');
const { BreakdownService } = require('../dist/breakdown/service');
const { StoryboardService } = require('../dist/breakdown/storyboard');
const { PostgresShotSpecRepository } = require('../dist/production/shot-spec-repository');
const { sealShotSpecV2 } = require('../dist/production/shot-spec');
const { PostgresProductionInputSourceReader } = require('../dist/production/input-source-reader');
const { PostgresProductionInputReferenceReader } = require('../dist/production/input-reference-reader');
const { ProductionInputCandidateCompiler } = require('../dist/production/input-compiler');
const { PostgresProductionInputSnapshotRepository } = require('../dist/production/input-snapshot-repository');
const { PostgresProductionInputLifecycle } = require('../dist/production/input-lifecycle');
const { createProductionInputValidationPorts } = require('../dist/production/input-validation-ports');
const { PostgresFrozenProductionInputReader } = require('../dist/production/frozen-input-reader');
const token = () => randomBytes(16).toString('hex');
test('real adopted source chain compiles, validates, blocks revoked policy and freezes transactionally', {
  skip: process.env.DATABASE_URL && process.env.DATABASE_ADMIN_URL ? false : 'isolated application/admin database URLs required',
}, async t => {
  const admin = new Client({ connectionString: process.env.DATABASE_ADMIN_URL }); await admin.connect();
  const database = new PostgresDatabase({ connectionString: process.env.DATABASE_URL }, { unscopedAccess: 'deny' });
  t.after(async () => { await database.close(); await admin.end(); }); await database.verifyTenantRole();
  const suffix = token(), tenant = { userId: 'usr_' + suffix, workspaceId: 'ws_' + suffix, role: 'owner', requestId: 'lifecycle:' + suffix };
  await admin.query(`INSERT INTO users(id,subject,display_name,kind,status,created_at,updated_at)
    VALUES($1,$2,'Lifecycle test','human','active',now(),now())`, [tenant.userId,'lifecycle:' + suffix]);
  await admin.query(`INSERT INTO workspaces(id,slug,name,status,created_by_user_id,created_at,updated_at)
    VALUES($1,$2,'Lifecycle test','active',$3,now(),now())`, [tenant.workspaceId,'lifecycle-' + suffix,tenant.userId]);
  const scope = work => database.runWithTenant(tenant, work);
  const config = readConfig({ LLM_BASE_URL: 'https://model.test/openai', LLM_API_KEY: 'offline-test-key' });
  const breakdown = new BreakdownService(new PostgresBreakdownRepository(database), config);
  const project = await scope(() => breakdown.createProject({ title:'Snapshot lifecycle fixture' }));
  const rawText = '空房';
  const script = await scope(() => breakdown.createScriptVersion(project.id,{ rawText }));
  const sourceRef = { scriptVersionId:script.id,start:0,end:2,quote:rawText };
  const sourced = { value:rawText,origin:'source',sourceRefs:[sourceRef],answerIds:[] };
  const run = await scope(() => breakdown.createDraftRun(project.id,{ maxModelCalls:1,maxOutputTokens:4096 }));
  const plan = await scope(() => breakdown.createExtractFactsCandidate(run.id,{ synopsis:sourced,characters:[],locations:[],props:[],dialogues:[],
    scenes:[{ tempId:'scene_one',order:1,title:sourced,locationTempId:null,characterTempIds:[],sourceRefs:[sourceRef],timeOfDay:null }] }));
  const checked = await scope(() => breakdown.checkPlan(plan.id));
  assert.equal(checked.check.result,'passed',JSON.stringify(checked.issues));
  await scope(() => breakdown.adoptPlan(project.id,{ planRevisionId:plan.id,checkId:checked.check.id,expectedActivePlanRevisionId:null }));
  let modelStubs = 0;
  const boards = new StoryboardService(database,breakdown,config,async (url,request) => {
    assert.match(String(url),/^https:\/\/model\.test\//); modelStubs++;
    const input = JSON.parse(request.body);
    return new Response(JSON.stringify({ id:'offline-board',model:input.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify({shots:[{
      sceneId:plan.content.scenes[0].id,order:1,visualDescription:'An empty room',shotSize:'wide',cameraMovement:'still',durationMs:5000,sourceRefs:[sourceRef],dialogueIds:[] } ]})}}],
      usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2} }),{headers:{'Content-Type':'application/json'}});
  });
  const board = await scope(() => boards.generate(project.id)); await scope(() => boards.adopt(project.id,board.id,null));
  const reader = new PostgresProductionInputSourceReader(database), shots = new PostgresShotSpecRepository(database);
  const episodeId = 'episode_' + token(), at = '2026-11-09T08:00:00.000Z', ref = id => ({ id,versionId:id,digest:'a'.repeat(64) });
  await shots.createEpisode(tenant,{id:episodeId,projectId:project.id,title:'Episode',createdAt:at});
  const spec = sealShotSpecV2({ schemaVersion:'lyra-shot-spec/2',revisionId:'shotspec_' + token(),workspaceId:tenant.workspaceId,projectId:project.id,episodeId,
    scriptVersionId:script.id,planRevisionId:plan.id,storyboardRevisionId:board.id,shotId:board.shots[0].id,sceneId:plan.content.scenes[0].id,
    order:1,durationMs:5000,ratio:'9:16',shotSize:'wide',camera:{description:null,movement:'still',focalLengthMm:null,composition:null},
    dialogue:[],actions:[],assetPacks:[],controls:[],visualStyle:'offline',negativeConstraints:[],continuity:{before:[],after:[]},timeline:[],sourceRefs:[sourceRef],
    generation:{methodPackRevisions:[],promptPackRevision:ref('prompt-one'),modelCapabilityRevision:ref('capability-one'),candidatePolicy:{mode:'direct',limit:1}},
    source:{kind:'user',actor:tenant.userId,sourceRevisionId:board.id},createdAt:at });
  await shots.create(tenant,spec);
  const initial = await reader.readCurrentProjectInputs(tenant,project.id,episodeId);
  await shots.adopt(tenant,{revisionId:spec.revisionId,expectedCurrentVersion:null,expectedProjectRevision:initial.projectRevision,reason:'Fixture',at},async client => {
    const refs = new PostgresProductionInputReferenceReader(client,tenant,project.id);
    assert.equal(await refs.checkVersion('plan',{id:plan.id,versionId:plan.id,digest:canonicalDigest(plan.content)}),null);
    assert.equal(await refs.checkVersion('storyboard',{id:board.id,versionId:board.id,digest:initial.storyboard.digest}),null);
    assert.equal(await refs.checkSource(sourceRef),null);
  });
  const compiler = new ProductionInputCandidateCompiler(reader), snapshots = new PostgresProductionInputSnapshotRepository(database);
  const profile = {id:'snapshot_' + token(),createdAt:at,reason:'Lifecycle test',modelConnections:[{role:'video',connection:ref('model-one'),capability:ref('capability-one')}],
    retrievalPolicy:ref('retrieval-one'),qualityGates:[ref('gate-one')],budgetPolicy:{version:ref('budget-one'),limitMicros:0,currency:'CNY',allowPaid:false},
    candidatePolicy:{mode:'direct',limit:1},automationMode:'auto'};
  const makeCandidate = async () => {
    const result = await compiler.compile(tenant,project.id,episodeId,{...profile,id:'snapshot_' + token()});
    assert.equal(result.state,'draft'); await snapshots.create(tenant,result.candidate); return result.candidate;
  };
  let revoked = false, factories = 0;
  const lifecycle = new PostgresProductionInputLifecycle(database,(client,ctx,snapshot) => {
    factories++;
    // Concrete production wiring always owns the PostgreSQL base checks. Only missing domain owners are test oracles.
    return createProductionInputValidationPorts(client,ctx,snapshot,undefined,async()=>({
      versions:Object.fromEntries(['asset_pack','director_scene','control','method_pack','prompt_pack','model_connection','model_capability','retrieval_policy','quality_gate','budget_policy']
        .map(kind=>[kind,async()=>revoked?'REFERENCE_FORBIDDEN':null])),capabilities:async()=>[] }));
  });
  const candidate = await makeCandidate();
  const ready = await lifecycle.validate(tenant,candidate.id,1,at); assert.equal(ready.snapshot.state,'ready'); assert.equal(ready.stateVersion,3);
  assert.equal((await snapshots.get(tenant,candidate.id)).state,'ready');
  assert.equal((await snapshots.create(tenant,candidate)).state,'ready');
  revoked = true;
  const blocked = await lifecycle.freeze(tenant,candidate.id,3,at); assert.equal(blocked.snapshot.state,'blocked'); assert.equal(blocked.stateVersion,5);
  revoked = false;
  const revalidated = await lifecycle.validate(tenant,candidate.id,5,at); assert.equal(revalidated.stateVersion,7);
  const frozen = await lifecycle.freeze(tenant,candidate.id,7,at); assert.equal(frozen.snapshot.state,'frozen'); assert.equal(frozen.stateVersion,10);
  await assert.rejects(scope(()=>database.query('UPDATE production_input_states SET updated_at=now() WHERE snapshot_id=$1',[candidate.id])),e=>e.code==='55000');
  const retained = await scope(()=>database.query('SELECT * FROM production_input_source_refs WHERE snapshot_id=$1',[candidate.id]));
  assert.equal(retained.rows[0].script_version_id,script.id); assert.equal(retained.rows[0].plan_revision_id,plan.id);
  await assert.rejects(scope(()=>database.query('DELETE FROM production_input_source_refs WHERE snapshot_id=$1',[candidate.id])),e=>e.code==='55000');
  const frozenReader = new PostgresFrozenProductionInputReader(database);
  const loaded = await frozenReader.load(tenant,candidate.id,candidate.snapshotDigest);
  assert.equal(loaded.shots[0].revisionId,spec.revisionId); assert.equal(loaded.sources.scriptText,rawText);
  await assert.rejects(frozenReader.load(tenant,candidate.id,'0'.repeat(64)),e=>e.code==='DIGEST_MISMATCH');
  await assert.rejects(frozenReader.load({...tenant,workspaceId:'ws_'+token()},candidate.id),e=>e.code==='REFERENCE_NOT_FOUND');
  const beforeRetry = factories; assert.equal((await lifecycle.freeze(tenant,candidate.id,10,at)).stateVersion,10); assert.equal(factories,beforeRetry);
  const events = await admin.query('SELECT aggregate_version,event_type FROM data_outbox_events WHERE workspace_id=$1 AND aggregate_id=$2 ORDER BY aggregate_version',[tenant.workspaceId,candidate.id]);
  assert.deepEqual(events.rows.map(e=>e.aggregate_version),[1,2,3,4,5,6,7,8,9,10]);
  assert.equal(events.rows.filter(e=>e.event_type==='production_input.frozen.v1').length,1);
  const fault = await makeCandidate();
  const broken = new PostgresProductionInputLifecycle(database,()=>{throw new Error('test factory failure');});
  await assert.rejects(broken.validate(tenant,fault.id,1,at));
  assert.equal((await snapshots.get(tenant,fault.id)).state,'draft');
  await assert.rejects(frozenReader.load(tenant,fault.id),e=>e.code==='SNAPSHOT_NOT_READY');
  assert.equal((await admin.query('SELECT event_id FROM data_outbox_events WHERE workspace_id=$1 AND aggregate_id=$2',[tenant.workspaceId,fault.id])).rowCount,1);
  const concurrent = await makeCandidate();
  const races = await Promise.allSettled([0,1].map(()=>lifecycle.validate(tenant,concurrent.id,1,at)));
  assert.equal(races.filter(r=>r.status==='fulfilled').length,1); assert.equal(races.find(r=>r.status==='rejected').reason.code,'REVISION_CONFLICT');
  const missingDomains = await makeCandidate();
  const productionDefault = new PostgresProductionInputLifecycle(database,(client,ctx,snapshot)=>createProductionInputValidationPorts(client,ctx,snapshot));
  const unsupported = await productionDefault.validate(tenant,missingDomains.id,1,at);
  assert.equal(unsupported.snapshot.state,'blocked'); assert.ok(unsupported.snapshot.findings.length>0);
  assert.ok(unsupported.snapshot.findings.every(f=>f.code==='CAPABILITY_INCOMPATIBLE'));
  await assert.rejects(productionDefault.freeze(tenant,missingDomains.id,unsupported.stateVersion,at),e=>e.code==='SNAPSHOT_NOT_READY');
  await scope(()=>breakdown.createScriptVersion(project.id,{rawText:'新空房'}));
  await assert.rejects(scope(()=>database.query('DELETE FROM storyboard_revisions WHERE id=$1',[board.id])),e=>e.code==='23503');
  await assert.rejects(lifecycle.freeze(tenant,concurrent.id,3,at),e=>e.code==='REVISION_CONFLICT');
  assert.equal((await snapshots.get(tenant,candidate.id)).state,'frozen');
  assert.equal(await reader.checkSource(tenant,project.id,sourceRef),null); assert.equal(modelStubs,1);
  // Fresh database client simulates recovery without any previously held project/browser objects.
  const recoveredDatabase = new PostgresDatabase({connectionString:process.env.DATABASE_URL},{unscopedAccess:'deny'});
  try {
    const recovered = await new PostgresFrozenProductionInputReader(recoveredDatabase).load(tenant,candidate.id,candidate.snapshotDigest);
    assert.equal(recovered.sources.scriptText,rawText);
    assert.equal(recovered.snapshot.script.versionId,script.id);
    assert.equal(recovered.snapshot.storyboard.versionId,board.id);
    assert.deepEqual(recovered.shots,loaded.shots);
  } finally { await recoveredDatabase.close(); }
});
