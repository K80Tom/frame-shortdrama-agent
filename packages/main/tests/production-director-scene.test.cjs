const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const shared=require('@lyra/shared');
const {fixture,request,tenant,at,reseal}=require('./helpers/frozen-input-fixture.cjs');
const {sceneDraft}=require('./helpers/director-scene-fixture.cjs');
const {sealDirectorSceneVersion:seal,verifyDirectorSceneVersion:verify,checkDirectorSceneBinding:bind}=require('../dist/production/director-scene');
const {sealShotSpecV2}=require('../dist/production/shot-spec');
const {compileFrozenProductionRun}=require('../dist/production/frozen-run');
const {DirectorProductionExecutor}=require('../dist/production/executors/director');
const {PostgresDirectorSceneReferenceReader,PostgresDirectorSceneRepository}=require('../dist/production/director-scene-repository');
const {createProductionInputValidationPorts}=require('../dist/production/input-validation-ports');
function preparedFixture(change){
  const f=fixture(),draftScene=sceneDraft(f.input.shots[0]);if(change)change(draftScene.scene);
  const version=seal(draftScene),ref={id:version.sceneId,versionId:version.revisionId,digest:version.contentDigest};
  const {contentDigest,...draft}=f.input.shots[0];draft.controls=[{kind:'director_scene',artifact:ref,objectId:null,timeMs:null}];
  f.input.shots=[sealShotSpecV2(draft)];reseal(f,s=>{s.directorScenes=[ref];s.shots[0].contentDigest=f.input.shots[0].contentDigest;s.executionPolicy.directorPolicy='always';});
  const run=compileFrozenProductionRun(tenant,request(f),f,at),task={...run.tasks.find(t=>t.stage==='director'),scope:{kind:'shot',id:'shot_one'}};
  return {f,version,ref,run,context:{run,task,frozenInput:f.input,attemptId:'attempt_one',inputDigest:'x',operationKey:null}};
}
test('director scene public contract binds geometry/camera/source but excludes display labels and audit from content digest',()=>{
  const f=fixture(),draft=sceneDraft(f.input.shots[0]),a=seal(draft);assert.equal(shared.parseDirectorSceneVersion(a).revisionId,a.revisionId);
  const b=structuredClone(draft);b.revisionId='version_two';b.createdBy='usr_other';b.scene.objects[0].name='Translated display';b.scene.cameras[0].name='Other label';
  assert.equal(seal(b).contentDigest,a.contentDigest);
  b.scene.cameras[0].position.x++;assert.notEqual(seal(b).contentDigest,a.contentDigest);
  const uuid=structuredClone(draft);uuid.scene.cameras[0].id='1ac218e8-9727-4cdb-a712-a9b4cb672b6b';uuid.scene.activeCameraId=uuid.scene.cameras[0].id;
  assert.equal(seal(uuid).scene.activeCameraId,uuid.scene.activeCameraId);
  const changed=structuredClone(a);changed.scene.objects[0].transform.rotation.y=90;assert.throws(()=>verify(changed),e=>e.code==='DIGEST_MISMATCH');
});
test('closed geometry contract rejects URLs/attachments, unknown fields, nonfinite transforms, duplicate IDs and missing camera',()=>{
  for(const change of [d=>{d.scene.objects[0].attachments=[];},d=>{d.scene.ui={panoramaUrl:'https://private.test'};},d=>{d.scene.cameras[0].position.x=Infinity;},
    d=>{d.scene.activeCameraId='missing_camera';},d=>{d.scene.objects[0].id='camera_one';},d=>{d.scene.cameras.push(d.scene.cameras[0]);},
    d=>{d.scene.objects[0].geometry.size.x=0;},d=>{d.scene.objects[0].type='external_mesh';},d=>{d.schemaVersion='future';}]){
    const d=sceneDraft(fixture().input.shots[0]);change(d);assert.throws(()=>seal(d));
  }
  let reads=0;const d=sceneDraft(fixture().input.shots[0]);Object.defineProperty(d.scene,'cameras',{enumerable:true,get(){reads++;throw Error('secret');}});
  assert.throws(()=>seal(d));assert.equal(reads,0);
});
test('scene parser runs in a browser realm without crypto, filesystem, Buffer or process',()=>{
  const context=vm.createContext({exports:{},input:JSON.stringify(seal(sceneDraft(fixture().input.shots[0])))});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../shared/dist/shot-spec.js'),'utf8'),context);context.shot=context.exports;context.exports={};
  vm.runInContext('var require=()=>shot;\n'+fs.readFileSync(path.join(__dirname,'../../shared/dist/director-scene.js'),'utf8'),context);
  assert.equal(vm.runInContext('exports.parseDirectorSceneVersion(JSON.parse(input)).scene.activeCameraId',context),'camera_one');
});
test('exact scene reference reader scopes every query and checks owner/shot/source/ratio and entity coverage',async()=>{
  const {version,ref,f}=preparedFixture();let count=0;
  const client={async query(sql,args){count++;assert.match(sql,/FOR SHARE/);assert.deepEqual(args,[tenant.workspaceId,'project_one',ref.versionId]);return {rows:[{scene_json:version}]};}};
  const reader=new PostgresDirectorSceneReferenceReader(client,tenant,'project_one'),control=f.input.shots[0].controls[0];
  assert.equal(await reader.checkVersion(ref),null);assert.equal(await reader.checkBinding(control,f.input.shots[0]),null);assert.equal(count,2);
  assert.equal(bind(version,control,{...f.input.shots[0],shotId:'another_shot'}),'DIGEST_MISMATCH');
  assert.equal(bind(version,{...control,objectId:'obj_'+'a'.repeat(32)},f.input.shots[0]),'CAPABILITY_INCOMPATIBLE');
  const entity=sceneDraft(f.input.shots[0]);entity.scene.objects[0].entityId='entity_missing';const v=seal(entity);
  assert.equal(bind(v,{...control,artifact:{...ref,digest:v.contentDigest}},f.input.shots[0]),'REFERENCE_NOT_FOUND');
});
test('production owner hooks cannot bypass the real director scene version or binding checks',async()=>{
  const {f,ref}=preparedFixture();let calls=0;
  const ports=await createProductionInputValidationPorts({async query(){return {rows:[]};}},tenant,f.input.snapshot,undefined,
    async()=>({versions:{director_scene:async()=>{calls++;return null;}},controlBinding:async()=>{calls++;return null;}}));
  assert.equal(await ports.checkVersion(tenant,'director_scene',ref),'REFERENCE_NOT_FOUND');
  assert.equal(await ports.checkControl(tenant,f.input.shots[0].controls[0],f.input.shots[0]),'REFERENCE_NOT_FOUND');assert.equal(calls,0);
});
test('native director uses the exact frozen version, not a newer scene/current project or generated whitebox',async()=>{
  const {f,version,ref,context}=preparedFixture();let mutableCalls=0,loads=0;
  const forbidden=new Proxy({}, {get(){return ()=>{mutableCalls++;throw Error('current data forbidden');};}});
  const newer=sceneDraft(f.input.shots[0],'director_version_two');newer.scene.cameras[0].position.x=99;
  const versions=new Map([[version.revisionId,version],[newer.revisionId,seal(newer)]]);
  const director=new DirectorProductionExecutor({breakdown:forbidden,storyboards:forbidden,frozenSceneLoader:async(run,actual)=>{loads++;assert.deepEqual(actual,ref);return versions.get(actual.versionId);}});
  assert.equal((await director.prepare(context)).requiresPaid,false);
  const outcome=await director.execute(context);assert.equal(outcome.state,'succeeded');assert.equal(outcome.actualCostMicros,0);
  const artifact=outcome.artifacts[0];assert.equal(artifact.metadata.directorSceneVersionId,version.revisionId);
  assert.equal(artifact.metadata.snapshot.cameras[0].transform.position.x,2);assert.equal(artifact.metadata.snapshot.provenance.ruleBased,false);
  assert.equal(artifact.metadata.snapshotDigest,f.input.snapshot.snapshotDigest);assert.equal(mutableCalls,0);assert.equal(loads,2);
});
test('wrong or tampered scene can never fall back to regeneration; always policy needs a scene while auto may explicitly skip',async()=>{
  const {version,context}=preparedFixture();const wrong=structuredClone(version);wrong.scene.cameras[0].position.x=99;
  const forbidden=new Proxy({}, {get(){return ()=>{throw Error('must not regenerate');};}});
  const director=new DirectorProductionExecutor({breakdown:forbidden,storyboards:forbidden,frozenSceneLoader:async()=>wrong});
  await assert.rejects(director.prepare(context),e=>e.code==='DIGEST_MISMATCH');
  const denied=await director.execute(context);assert.equal(denied.state,'blocked');assert.equal(denied.artifacts,undefined);
  const f=reseal(fixture(),d=>{d.executionPolicy.directorPolicy='always';});let run=compileFrozenProductionRun(tenant,request(f),f,at);
  const task={...run.tasks.find(t=>t.stage==='director'),scope:{kind:'shot',id:'shot_one'}};
  await assert.rejects(director.prepare({run,task,frozenInput:f.input}),e=>e.code==='CAPABILITY_INCOMPATIBLE');
  reseal(f,d=>{d.executionPolicy.directorPolicy='auto';});run=compileFrozenProductionRun(tenant,request(f),f,at);
  const skipped=await director.execute({...context,run,task,frozenInput:f.input});assert.equal(skipped.state,'succeeded');assert.equal(skipped.artifacts[0].kind,'report');
});
test('all existing body/pose IDs, geometry and crowd project without dropping authored joint tuples',async()=>{
  for(const shape of ['box','sphere','cylinder','cone','torus','plane']){
    const d=sceneDraft(fixture().input.shots[0]);d.scene.objects[0].geometry.shape=shape;if(shape==='plane')d.scene.objects[0].geometry.size.y=0;
    assert.equal(seal(d).scene.objects[0].geometry.shape,shape);
  }
  for(const bodyType of shared.DIRECTOR_BODY_TYPES)for(const posePreset of shared.DIRECTOR_POSES){
    const d=sceneDraft(fixture().input.shots[0]),actor=d.scene.objects[0];actor.type='mannequin';actor.geometry=null;
    actor.mannequin={bodyType,posePreset,joints:[{name:'shoulderL',rotation:{x:10,y:20,z:30}}]};assert.equal(seal(d).scene.objects[0].mannequin.posePreset,posePreset);
  }
  const {version,context}=preparedFixture(scene=>{
    const base=structuredClone(scene.objects[0]);base.type='mannequin';base.geometry=null;base.mannequin={bodyType:'chibi',posePreset:'phone',joints:[{name:'shoulderL',rotation:{x:10,y:20,z:30}}]};
    const crowd={...structuredClone(scene.objects[0]),id:'crowd_one',type:'crowd',geometry:null,crowd:{rows:3,cols:4,spacing:1.5}};
    scene.objects=[base,crowd];
  });
  const director=new DirectorProductionExecutor({breakdown:{},storyboards:{},frozenSceneLoader:async()=>version});
  const out=await director.execute(context);assert.equal(out.state,'succeeded');const objects=out.artifacts[0].metadata.snapshot.objects;
  assert.deepEqual(objects[0].joints.shoulderL,[10,20,30]);assert.equal(objects[0].bodyType,'chibi');assert.equal(objects[0].pose.preset,'phone');
  assert.equal(objects[1].rows,3);assert.equal(objects[1].cols,4);assert.equal(objects[1].spacing,1.5);
  for(const change of [d=>{d.scene.cameras[0].target={...d.scene.cameras[0].position};},d=>{d.scene.objects[0].mannequin.posePreset='unknown';},
    d=>{d.scene.objects[0].mannequin.bodyType='unknown';},d=>{d.scene.objects[0].mannequin.joints[0].name='unknown_joint';},
    d=>{const crowd=d.scene.objects[1];d.scene.objects=Array.from({length:5},(_,i)=>({...structuredClone(crowd),id:'crowd_'+i,crowd:{rows:32,cols:32,spacing:1}}));}]){
    const draft={...version};delete draft.contentDigest;const copy=structuredClone(draft);change(copy);assert.throws(()=>seal(copy));
  }
});
test('repository rejects forbidden actors before IO and never exposes driver text',async()=>{
  const {version}=preparedFixture();let calls=0;
  const repo=new PostgresDirectorSceneRepository({runWithTenant(){calls++;throw Error('private credential and SQL');}});
  await assert.rejects(repo.create({...tenant,role:'viewer'},version),e=>e.status===403);
  await assert.rejects(repo.create({...tenant,workspaceId:'ws_'+'f'.repeat(32)},version),e=>e.status===404);
  await assert.rejects(repo.get(tenant,'version\ninvalid'),e=>e.status===400);assert.equal(calls,0);
  for(const work of [()=>repo.create(tenant,version),()=>repo.get(tenant,version.revisionId)]){
    await assert.rejects(work(),e=>e.code==='DIRECTOR_SCENE_UNAVAILABLE'&&e.status===503&&!e.message.includes('credential'));
  }
});
