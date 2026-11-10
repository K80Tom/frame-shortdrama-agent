const {test}=require('node:test');
const assert=require('node:assert/strict');
const {assetRetrievalAuthorization}=require('../dist/asset-retrieval-governance/authorization');
const {parseRecordAssetRetrievalDecisionInput}=require('@lyra/shared');
const ws='ws_'+'a'.repeat(32), at='2026-11-10T00:00:00.000Z';
function fixture(){
 const v={workspaceId:ws,id:'apv-one',logicalAssetId:'asset-one',contentDigest:'a'.repeat(64),status:'adopted',authorizationStatus:'allowed',reviewStatus:'approved',license:'owned',reviewedBy:'owner',reviewedAt:at,validFrom:at,validUntil:null,projectScope:'project',projectId:'project-one',restrictedProjects:[],allowedUsages:['evaluation']};
 const observation={workspaceId:ws,projectId:'project-one',candidates:[{assetId:v.logicalAssetId,assetVersionId:v.id,assetVersionDigest:v.contentDigest}]};
 return {v,observation,decision:{selectedAssetId:v.logicalAssetId,selectedAssetVersionId:v.id}};
}
test('missing authorization or missing quality defaults to unverified',()=>{
 const input={observationId:'arobs_'+'a'.repeat(32),clientRequestId:'request-one',decision:'accept',selectedAssetId:'asset-one',reason:'test',actorId:'actor-one'};
 assert.equal(parseRecordAssetRetrievalDecisionInput(input).authorization.quality,'unverified');
 assert.equal(parseRecordAssetRetrievalDecisionInput({...input,authorization:{}}).authorization.quality,'unverified');
});
test('exact authoritative version and explicit evaluation rights are required; denial and lookup faults fail closed',async()=>{
 const f=fixture();let seen;
 const check=assetRetrievalAuthorization({async get(workspace,id){seen=[workspace,id];return f.v;}},()=>new Date(at));
 assert.equal(await check(ws,f.observation,f.decision),true);assert.deepEqual(seen,[ws,f.v.id]);
 for(const change of [{workspaceId:'other'},{authorizationStatus:'revoked'},{reviewStatus:'pending'},{status:'draft'},{validUntil:at},{projectId:'other'},{allowedUsages:['video']},{contentDigest:'b'.repeat(64)},{restrictedProjects:['project-one']}]){
  const original={...f.v};Object.assign(f.v,change);assert.equal(await check(ws,f.observation,f.decision),false,JSON.stringify(change));Object.assign(f.v,original);
 }
 assert.equal(await check(ws,f.observation,{...f.decision,selectedAssetVersionId:null}),false);
 assert.equal(await assetRetrievalAuthorization({async get(){throw new Error('private');}})(ws,f.observation,f.decision),false);
});
