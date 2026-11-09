function sceneDraft(scope,revisionId='director_version_one',sceneId='director_scene_one'){
  return {schemaVersion:'lyra-director-scene/1',revisionId,sceneId,workspaceId:scope.workspaceId,projectId:scope.projectId,episodeId:scope.episodeId,
    shotId:scope.shotId,scriptVersionId:scope.scriptVersionId,planRevisionId:scope.planRevisionId,storyboardRevisionId:scope.storyboardRevisionId,
    createdBy:scope.createdBy??scope.source.actor,createdAt:scope.createdAt,scene:{objects:[{id:'platform_one',name:'Display platform',type:'geometry',entityId:null,
      visible:true,color:'#123456',transform:{position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}},mannequin:null,crowd:null,
      geometry:{shape:'box',size:{x:4,y:0.2,z:4}}}],
      cameras:[{id:'camera_one',name:'Display camera',focalLength:50,position:{x:2,y:3,z:8},target:{x:0,y:1,z:0},rollDeg:0}],
      activeCameraId:'camera_one',aspectRatio:'9:16',environment:{preset:'studio',backgroundColor:'#111111',ambientLight:0.6,groundVisible:true}}};
}
module.exports={sceneDraft};
