import {canonicalDigest,parseDirectorSceneVersion,parseDirectorSceneVersionDraft,ProductionError,type DirectorSceneVersionDraft,type ShotControl,type ShotSpecV2} from '@lyra/shared';
function content(draft:DirectorSceneVersionDraft){
  const{revisionId,createdBy,createdAt,...inputs}=draft;
  return{...inputs,scene:{...inputs.scene,objects:inputs.scene.objects.map(({name,...o})=>o),cameras:inputs.scene.cameras.map(({name,...c})=>c)}};
}
export function sealDirectorSceneVersion(value:unknown){const draft=parseDirectorSceneVersionDraft(value);return parseDirectorSceneVersion({...draft,contentDigest:canonicalDigest(content(draft))});}
export function verifyDirectorSceneVersion(value:unknown){
  const version=parseDirectorSceneVersion(value);const{contentDigest,...draft}=version;
  if(canonicalDigest(content(draft))!==contentDigest)throw new ProductionError(409,'DIGEST_MISMATCH','导演场景摘要不一致。');return version;
}
export function checkDirectorSceneBinding(value:unknown,control:ShotControl,shot:Readonly<ShotSpecV2>){
  if(control.kind!=='director_scene'||control.objectId!==null||control.timeMs!==null)return 'CAPABILITY_INCOMPATIBLE' as const;
  const v=verifyDirectorSceneVersion(value),ref=control.artifact;
  if(v.revisionId!==ref.versionId||v.sceneId!==ref.id||v.contentDigest!==ref.digest||v.shotId!==shot.shotId||v.episodeId!==shot.episodeId
    ||v.projectId!==shot.projectId||v.workspaceId!==shot.workspaceId||v.scriptVersionId!==shot.scriptVersionId
    ||v.planRevisionId!==shot.planRevisionId||v.storyboardRevisionId!==shot.storyboardRevisionId||v.scene.aspectRatio!==shot.ratio)return 'DIGEST_MISMATCH' as const;
  if(v.scene.objects.some(o=>o.entityId!==null&&!shot.assetPacks.some(p=>p.entityId===o.entityId)))return 'REFERENCE_NOT_FOUND' as const;
  return null;
}
