import { copyBoundedProductionInput } from './shot-spec';

export const DIRECTOR_SCENE_SCHEMA_VERSION='lyra-director-scene/1' as const;
export const DIRECTOR_BODY_TYPES=['male','female','wide','muscular','slim','teen','child','chibi'] as const;
export const DIRECTOR_POSES=['stand','tpose','walk','run','sit','squat','kneelOne','kneelBoth','akimbo','lean','bow','think','fight','kick','throw','push','wave','reach','foldedArms','phone'] as const;
export const DIRECTOR_JOINTS=['body','torso','head','shoulderL','shoulderR','elbowL','elbowR','hipL','hipR','kneeL','kneeR'] as const;
/** Positions/sizes use scene metres. Transform/joint Euler rotations use degrees, XYZ order. */
export interface DirectorVector { x:number;y:number;z:number }
export interface DirectorSceneContent {
  objects:Array<{id:string;name:string;type:'mannequin'|'geometry'|'crowd';entityId:string|null;visible:boolean;color:string;
    transform:{position:DirectorVector;rotation:DirectorVector;scale:DirectorVector};
    mannequin:{bodyType:typeof DIRECTOR_BODY_TYPES[number];posePreset:typeof DIRECTOR_POSES[number];joints:Array<{name:typeof DIRECTOR_JOINTS[number];rotation:DirectorVector}>}|null;
    geometry:{shape:'box'|'sphere'|'cylinder'|'cone'|'torus'|'plane';size:DirectorVector}|null;
    crowd:{rows:number;cols:number;spacing:number}|null}>;
  cameras:Array<{id:string;name:string;focalLength:number;position:DirectorVector;target:DirectorVector;rollDeg:number}>;
  activeCameraId:string;
  aspectRatio:'9:16'|'16:9';
  environment:{preset:string;backgroundColor:string;ambientLight:number;groundVisible:boolean};
}
/** Production geometry only: UI selection, temporary URLs and unversioned attachments are NOT accepted.
 * Adoption is through a ShotSpec control + project CAS, not a parallel mutable director registry. */
export interface DirectorSceneVersion {
  schemaVersion:typeof DIRECTOR_SCENE_SCHEMA_VERSION;
  revisionId:string;sceneId:string;workspaceId:string;projectId:string;episodeId:string;shotId:string;
  scriptVersionId:string;planRevisionId:string;storyboardRevisionId:string;
  scene:DirectorSceneContent;createdBy:string;createdAt:string;contentDigest:string;
}
export type DirectorSceneVersionDraft=Omit<DirectorSceneVersion,'contentDigest'>;
export class DirectorSceneContractError extends Error {
  readonly code='DIRECTOR_SCENE_INVALID';readonly status=400;
  constructor(){super('导演场景版本契约无效。');this.name='DirectorSceneContractError';}
}
function bad():never{throw new DirectorSceneContractError();}
function obj(value:unknown,keys:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))bad();
  return value as Record<string,unknown>;
}
function text(v:unknown,max:number):string {
  if(typeof v!=='string'||!v.trim()||v.length>max||/[\x00-\x1f\x7f]/u.test(v)
    ||Array.from(v).some(c=>{const n=c.codePointAt(0)!;return n>=0xd800&&n<=0xdfff;}))bad();return v;
}
function id(v:unknown):string{const s=text(v,128);if(!/^[A-Za-z][A-Za-z0-9_.:-]*$/u.test(s))bad();return s;}
function objectId(v:unknown):string{const s=text(v,128);if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(s))bad();return s;}
function num(v:unknown,min:number,max:number):number{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)bad();return v;}
function bool(v:unknown):boolean{if(typeof v!=='boolean')bad();return v;}
function choice<T extends string>(v:unknown,choices:readonly T[]):T{if(!choices.includes(v as T))bad();return v as T;}
function color(v:unknown):string{if(typeof v!=='string'||v.length!==7||!/^#[a-f0-9]{6}$/iu.test(v))bad();return v.toLowerCase();}
function vec(v:unknown,min=-1_000_000,max=1_000_000):DirectorVector{const r=obj(v,['x','y','z']);return{x:num(r.x,min,max),y:num(r.y,min,max),z:num(r.z,min,max)};}
function list<T>(v:unknown,max:number,parse:(x:unknown)=>T,key:(x:T)=>string):T[]{
  if(!Array.isArray(v)||v.length>max)bad();const out=v.map(parse);if(new Set(out.map(key)).size!==out.length)bad();return out;
}
function scene(value:unknown):DirectorSceneContent{
  const s=obj(value,['objects','cameras','activeCameraId','aspectRatio','environment']);
  const objects=list(s.objects,256,value=>{
    const o=obj(value,['id','name','type','entityId','visible','color','transform','mannequin','geometry','crowd']);
    const transform=obj(o.transform,['position','rotation','scale']);
    const type=choice(o.type,['mannequin','geometry','crowd'] as const);
    let mannequin:DirectorSceneContent['objects'][number]['mannequin']=null,geometry:DirectorSceneContent['objects'][number]['geometry']=null,
      crowd:DirectorSceneContent['objects'][number]['crowd']=null;
    if(type==='mannequin'){
      if(o.geometry!==null||o.crowd!==null)bad();const m=obj(o.mannequin,['bodyType','posePreset','joints']);
      mannequin={bodyType:choice(m.bodyType,DIRECTOR_BODY_TYPES),posePreset:choice(m.posePreset,DIRECTOR_POSES),
        joints:list(m.joints,128,value=>{const j=obj(value,['name','rotation']);return{name:choice(j.name,DIRECTOR_JOINTS),rotation:vec(j.rotation,-360,360)};},j=>j.name)};
    }else if(type==='geometry'){
      if(o.mannequin!==null||o.crowd!==null)bad();const g=obj(o.geometry,['shape','size']);
      const shape=choice(g.shape,['box','sphere','cylinder','cone','torus','plane'] as const),size=vec(g.size,0,10000);
      if(size.x===0 || shape==='box'&&(size.y===0||size.z===0) || shape==='plane'&&size.z===0
        || ['cylinder','cone','torus'].includes(shape)&&size.y===0)bad();
      geometry={shape,size};
    }else{
      if(o.mannequin!==null||o.geometry!==null)bad();const c=obj(o.crowd,['rows','cols','spacing']);
      if(!Number.isInteger(c.rows)||!Number.isInteger(c.cols))bad();
      crowd={rows:num(c.rows,1,32),cols:num(c.cols,1,32),spacing:num(c.spacing,0.01,1000)};
    }
    return{id:objectId(o.id),name:text(o.name,160),type,entityId:o.entityId===null?null:id(o.entityId),visible:bool(o.visible),color:color(o.color),
      transform:{position:vec(transform.position),rotation:vec(transform.rotation,-360000,360000),scale:vec(transform.scale,0.0001,1000)},mannequin,geometry,crowd};
  },o=>o.id);
  if(objects.reduce((n,o)=>n+(o.crowd?o.crowd.rows*o.crowd.cols:1),0)>4096)bad();
  const cameras=list(s.cameras,32,value=>{
    const c=obj(value,['id','name','focalLength','position','target','rollDeg']);
    return{id:objectId(c.id),name:text(c.name,160),focalLength:num(c.focalLength,1,1000),position:vec(c.position),target:vec(c.target),rollDeg:num(c.rollDeg,-45,45)};
  },c=>c.id);
  const activeCameraId=objectId(s.activeCameraId);
  if(!cameras.length||!cameras.some(c=>c.id===activeCameraId)||objects.some(o=>cameras.some(c=>c.id===o.id)))bad();
  if(cameras.some(c=>(c.position.x-c.target.x)**2+(c.position.y-c.target.y)**2+(c.position.z-c.target.z)**2<1e-12))bad();
  const e=obj(s.environment,['preset','backgroundColor','ambientLight','groundVisible']);
  return{objects,cameras,activeCameraId,aspectRatio:choice(s.aspectRatio,['9:16','16:9'] as const),environment:{preset:text(e.preset,64),
    backgroundColor:color(e.backgroundColor),ambientLight:num(e.ambientLight,0,1),groundVisible:bool(e.groundVisible)}};
}
function parse(value:unknown,sealed:boolean):DirectorSceneVersion{
  const keys=['schemaVersion','revisionId','sceneId','workspaceId','projectId','episodeId','shotId','scriptVersionId','planRevisionId','storyboardRevisionId','scene','createdBy','createdAt'];
  if(sealed)keys.push('contentDigest');const r=obj(copyBoundedProductionInput(value),keys);
  if(r.schemaVersion!==DIRECTOR_SCENE_SCHEMA_VERSION||typeof r.workspaceId!=='string'||r.workspaceId.length!==35||!/^ws_[a-f0-9]{32}$/u.test(r.workspaceId)
    ||typeof r.createdAt!=='string'||r.createdAt.length!==24||!Number.isFinite(Date.parse(r.createdAt))||new Date(r.createdAt).toISOString()!==r.createdAt)bad();
  if(sealed&&(typeof r.contentDigest!=='string'||r.contentDigest.length!==64||!/^([a-f0-9]){64}$/u.test(r.contentDigest)))bad();
  return{schemaVersion:DIRECTOR_SCENE_SCHEMA_VERSION,revisionId:id(r.revisionId),sceneId:id(r.sceneId),workspaceId:r.workspaceId,
    projectId:id(r.projectId),episodeId:id(r.episodeId),shotId:id(r.shotId),scriptVersionId:id(r.scriptVersionId),planRevisionId:id(r.planRevisionId),
    storyboardRevisionId:id(r.storyboardRevisionId),scene:scene(r.scene),createdBy:id(r.createdBy),createdAt:r.createdAt,
    contentDigest:sealed?r.contentDigest as string:'0'.repeat(64)};
}
export function parseDirectorSceneVersion(value:unknown){return parse(value,true);}
export function parseDirectorSceneVersionDraft(value:unknown):DirectorSceneVersionDraft{const{contentDigest,...draft}=parse(value,false);return draft;}
