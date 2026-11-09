const shared=require('@lyra/shared');
const {sealShotSpecV2}=require('../../dist/production/shot-spec');
const {sealProductionInputSnapshot}=require('../../dist/production/input-snapshot');
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
module.exports={at,tenant,fixture,request,reseal};
