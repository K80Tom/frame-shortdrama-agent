import type { PlanRevisionRecord } from '../../breakdown/plan';
import type { BreakdownServicePort } from '../../breakdown/service';
import type { StoryboardRevision, StoryboardService, StoryboardShot } from '../../breakdown/storyboard';
import { canonicalDigest, ProductionError, type StoredProductionRun, type DirectorSceneVersion, type InputVersionRef } from '@lyra/shared';
import { requireFrozenExecutionInput } from '../frozen-execution-input';
import { checkDirectorSceneBinding, verifyDirectorSceneVersion } from '../director-scene';
import type {
  PreparedProductionExecution,
  ProductionExecutionContext,
  ProductionExecutor,
  ProductionExecutorOutcome,
} from '../executor';

const EXECUTOR_VERSION = 'production-director/1';
export const DIRECTOR_RULE_VERSION = 'production-director-complexity/1';
export const DIRECTOR_SNAPSHOT_VERSION = 'production-director-scene/1';

type BreakdownReader = Pick<BreakdownServicePort, 'getProject' | 'getPlanRevision'>;
type StoryboardReader = Pick<StoryboardService, 'get'>;

export interface DirectorProductionExecutorOptions {
  breakdown: BreakdownReader;
  storyboards: StoryboardReader;
  /** Exact authorized PG version read; NEVER a current browser scene or current project pointer. */
  frozenSceneLoader?: (run: Readonly<StoredProductionRun>, ref: InputVersionRef)=>Promise<DirectorSceneVersion|null>;
}

interface DirectorInput {
  state: 'ready';
  plan: PlanRevisionRecord;
  storyboard: StoryboardRevision;
}

interface DirectorBlocked {
  state: 'blocked';
  code: string;
  message: string;
}

export interface DirectorDecision {
  shotId: string;
  sceneId: string;
  required: boolean;
  reasons: string[];
}

/** JSON shape accepted by web/src/director/contracts.ts and fromSceneSnapshot(). */
export interface RuleBasedDirectorSnapshot {
  schemaVersion: 1;
  objects: Array<Record<string, unknown>>;
  cameras: Array<Record<string, unknown>>;
  selectedObjectId: string | null;
  activeCameraId: string;
  aspectRatio: '9:16' | '16:9';
  environment: { preset: string; backgroundColor: string; ambientLight: number; groundVisible: boolean };
  ui: Record<string, unknown>;
  provenance: { ruleBased: true; ruleVersion: typeof DIRECTOR_SNAPSHOT_VERSION; projectId: string;
    scriptVersionId: string; planRevisionId: string; storyboardRevisionId: string; shotId: string; sceneId: string };
}

export class DirectorProductionExecutor implements ProductionExecutor {
  readonly stage = 'director' as const;
  readonly frozenInputVersion = 1 as const;
  constructor(private readonly options: DirectorProductionExecutorOptions) {}

  async prepare(context: Omit<ProductionExecutionContext, 'attemptId' | 'inputDigest' | 'operationKey'>): Promise<PreparedProductionExecution> {
    if(context.run.inputSnapshot){
      const input=requireFrozenExecutionInput(context.run,context.frozenInput);
      const version=context.task.scope.kind==='shot'?await this.loadFrozen(context):null;
      return {executor:'production-director-frozen/1',inputDigest:canonicalDigest({snapshotDigest:input.snapshot.snapshotDigest,
        scope:context.task.scope,controls:input.shots.map(s=>({shotId:s.shotId,controls:s.controls.filter(c=>c.kind==='director_scene')})),
        sceneDigest:version?.contentDigest??null}),estimateCostMicros:0,requiresPaid:false,provider:null};
    }
    const loaded = await this.load(context.run);
    const shot = loaded.state === 'ready' && context.task.scope.kind === 'shot'
      ? loaded.storyboard.shots.find(item => item.id === context.task.scope.id) ?? null : null;
    return { executor: EXECUTOR_VERSION, inputDigest: canonicalDigest({ rule: DIRECTOR_RULE_VERSION,
      run: { projectId: context.run.projectId, scriptVersionId: context.run.scriptVersionId,
        ratio: context.run.ratio, directorPolicy: context.run.directorPolicy },
      planRevisionId: loaded.state === 'ready' ? loaded.plan.id : null,
      storyboardRevisionId: loaded.state === 'ready' ? loaded.storyboard.id : null,
      shot }), estimateCostMicros: 0, requiresPaid: false, provider: null };
  }

  async execute(context: ProductionExecutionContext): Promise<ProductionExecutorOutcome> {
    if(context.run.inputSnapshot){
      try{return await this.executeFrozen(context);}catch(error){return blocked(error instanceof ProductionError?error.code:'DIRECTOR_INPUT_UNAVAILABLE','冻结导演场景不可用，未生成替代白模。');}
    }
    const loaded = await this.load(context.run);
    if (loaded.state === 'blocked') return blocked(loaded.code, loaded.message);
    if (context.task.scope.kind === 'episode') return this.expandEpisode(context.run, loaded);
    if (context.task.scope.kind !== 'shot') {
      return blocked('DIRECTOR_SCOPE_UNSUPPORTED', '3D 导演执行器只接受整集或镜头范围任务。');
    }
    return this.buildShot(context.run, loaded, context.task.scope.id);
  }

  private async loadFrozen(context: Pick<ProductionExecutionContext,'run'|'task'|'frozenInput'>){
    const input=requireFrozenExecutionInput(context.run,context.frozenInput),shot=input.shots.find(s=>s.shotId===context.task.scope.id);
    if(context.task.scope.kind!=='shot'||!shot)throw new ProductionError(409,'REFERENCE_NOT_FOUND','冻结镜头不存在。');
    if(context.run.directorPolicy==='never')return null;
    const controls=shot.controls.filter(c=>c.kind==='director_scene');
    if(!controls.length&&context.run.directorPolicy==='auto')return null;
    if(controls.length!==1||!this.options.frozenSceneLoader)throw new ProductionError(409,'CAPABILITY_INCOMPATIBLE','缺少唯一场景版本或读取器。');
    const v=await this.options.frozenSceneLoader(context.run,controls[0]!.artifact);
    if(!v)throw new ProductionError(404,'REFERENCE_NOT_FOUND','场景版本不存在。');
    const version=verifyDirectorSceneVersion(v),code=checkDirectorSceneBinding(version,controls[0]!,shot);
    if(code)throw new ProductionError(409,code,'冻结场景与镜头引用不一致。');
    return version;
  }
  private async executeFrozen(context: ProductionExecutionContext):Promise<ProductionExecutorOutcome>{
    const input=requireFrozenExecutionInput(context.run,context.frozenInput),run=context.run;
    if(context.task.scope.kind==='episode'){
      if(run.directorPolicy==='always'&&input.shots.some(s=>s.controls.filter(c=>c.kind==='director_scene').length!==1))
        return blocked('CAPABILITY_INCOMPATIBLE','强制导演策略需要每个冻结镜头引用唯一正式场景。');
      return {state:'succeeded',artifacts:[{key:'director-plan',kind:'report',title:'冻结导演场景清单',metadata:{frozen:true,
        snapshotId:input.snapshot.id,snapshotDigest:input.snapshot.snapshotDigest,policy:run.directorPolicy,
        scenes:input.shots.map(s=>({shotId:s.shotId,references:s.controls.filter(c=>c.kind==='director_scene').map(c=>c.artifact)}))}}]};
    }
    const version=await this.loadFrozen(context);
    if(!version)return {state:'succeeded',artifacts:[{key:'director-skip-'+context.task.scope.id,kind:'report',title:'冻结策略无需导演场景',
      metadata:{frozen:true,snapshotDigest:input.snapshot.snapshotDigest,policy:run.directorPolicy,shotId:context.task.scope.id}}]};
    const content=version.scene;
    // Deterministic view projection only. No re-design, current lookup, external attachments or UI state inference.
    const snapshot={schemaVersion:1,aspectRatio:content.aspectRatio,selectedObjectId:null,activeCameraId:content.activeCameraId,
      objects:content.objects.map(o=>({id:o.id,name:o.name,type:o.type,visible:o.visible,color:o.color,transform:o.transform,attachments:[],
        ...(o.mannequin?{bodyType:o.mannequin.bodyType,pose:{preset:o.mannequin.posePreset},joints:Object.fromEntries(o.mannequin.joints.map(j=>[j.name,[j.rotation.x,j.rotation.y,j.rotation.z]]))}:{}),
        ...(o.geometry?{shape:o.geometry.shape,size:[o.geometry.size.x,o.geometry.size.y,o.geometry.size.z]}:{}),...(o.crowd?o.crowd:{}),provenance:{planEntityId:o.entityId}})),
      cameras:content.cameras.map(c=>({id:c.id,name:c.name,type:'camera',focalLength:c.focalLength,transform:{position:c.position},target:c.target,rollDeg:c.rollDeg})),
      environment:content.environment,ui:{},provenance:{frozen:true,ruleBased:false,projectId:version.projectId,scriptVersionId:version.scriptVersionId,
        planRevisionId:version.planRevisionId,storyboardRevisionId:version.storyboardRevisionId,shotId:version.shotId,sceneId:version.sceneId,
        revisionId:version.revisionId,contentDigest:version.contentDigest}};
    return {state:'succeeded',actualCostMicros:0,artifacts:[{key:'director-'+version.shotId,kind:'directorScene',title:'冻结导演场景',metadata:{
      frozen:true,directorSceneVersionId:version.revisionId,contentDigest:version.contentDigest,snapshotId:input.snapshot.id,
      snapshotDigest:input.snapshot.snapshotDigest,snapshot}}]};
  }
  private expandEpisode(run: Readonly<StoredProductionRun>, loaded: DirectorInput): ProductionExecutorOutcome {
    const decisions = loaded.storyboard.shots.map(shot => directorDecision(run.directorPolicy, shot,
      loaded.plan.content.scenes.find(scene => scene.id === shot.sceneId)?.characterIds.length ?? 0));
    if (run.directorPolicy === 'never') {
      return { state: 'succeeded', artifacts: [{ key: 'director-plan', kind: 'report', title: '3D 导演预演决策',
        metadata: { ruleBased: true, ruleVersion: DIRECTOR_RULE_VERSION, policy: 'never', decisions: [] } }] };
    }
    const required = decisions.filter(item => item.required);
    return { state: 'succeeded', artifacts: [{ key: 'director-plan', kind: 'report', title: '3D 导演预演决策', metadata: {
      ruleBased: true, ruleVersion: DIRECTOR_RULE_VERSION, policy: run.directorPolicy,
      storyboardRevisionId: loaded.storyboard.id, totalShots: decisions.length, requiredShots: required.length, decisions,
    } }], qualityChecks: [{ level: 'episode', result: 'pass', ruleVersion: DIRECTOR_RULE_VERSION,
      summary: `已用显式复杂度规则判定 ${required.length}/${decisions.length} 个镜头需要 3D 白模预演；镜头子图由分镜阶段统一编译。` }] };
  }

  private buildShot(run: Readonly<StoredProductionRun>, loaded: DirectorInput, shotId: string): ProductionExecutorOutcome {
    const shot = loaded.storyboard.shots.find(item => item.id === shotId);
    if (!shot) return blocked('DIRECTOR_SHOT_STALE', '该镜头已不存在于当前采用的分镜版本中。');
    const scene = loaded.plan.content.scenes.find(item => item.id === shot.sceneId);
    if (!scene) return blocked('DIRECTOR_SCENE_STALE', '分镜引用的场次不存在于当前事实计划中。');
    const decision = directorDecision(run.directorPolicy, shot, scene.characterIds.length);
    if (!decision.required) {
      return { state: 'succeeded', artifacts: [{ key: `director-skip-${shot.id}`, kind: 'report',
        title: `3D 预演无需构建·${scene.order}-${shot.order}`, metadata: {
          ruleBased: true, ruleVersion: DIRECTOR_RULE_VERSION, decision,
          storyboardRevisionId: loaded.storyboard.id, planRevisionId: loaded.plan.id,
        } }] };
    }
    const snapshot = buildDirectorSnapshot(run, loaded.plan, loaded.storyboard, shot);
    return { state: 'succeeded', artifacts: [{ key: `director-${shot.id}`, kind: 'directorScene',
      title: `3D 白模·${scene.order}-${shot.order}`, metadata: {
        ruleBased: true, ruleVersion: DIRECTOR_SNAPSHOT_VERSION, decision, snapshot,
        storyboardRevisionId: loaded.storyboard.id, planRevisionId: loaded.plan.id,
      } }], qualityChecks: [{ level: 'shot', result: 'pass', ruleVersion: DIRECTOR_SNAPSHOT_VERSION,
        summary: '白模已包含地台、场内人物站位、活动机位和本次运行画幅，可导入现有 3D 导演台。' }] };
  }

  private async load(run: Readonly<StoredProductionRun>): Promise<DirectorInput | DirectorBlocked> {
    try {
      const project = await this.options.breakdown.getProject(run.projectId);
      if (project.currentScriptVersionId !== run.scriptVersionId) return { state: 'blocked', code: 'PRODUCTION_SCRIPT_STALE',
        message: '项目当前剧本已变更，本次生产固定的剧本版本已过期。' };
      if (!project.activePlanRevisionId) return { state: 'blocked', code: 'ADOPTED_FACTS_REQUIRED',
        message: '请先采用与当前剧本匹配的事实拆解。' };
      if (!project.activeStoryboardRevisionId) return { state: 'blocked', code: 'ADOPTED_STORYBOARD_REQUIRED',
        message: '请先采用与当前剧本和事实计划匹配的分镜。' };
      const [plan, storyboard] = await Promise.all([
        this.options.breakdown.getPlanRevision(project.activePlanRevisionId),
        this.options.storyboards.get(project.activeStoryboardRevisionId),
      ]);
      if (plan.projectId !== run.projectId || plan.scriptVersionId !== run.scriptVersionId
        || storyboard.projectId !== run.projectId || storyboard.scriptVersionId !== run.scriptVersionId
        || storyboard.sourcePlanRevisionId !== plan.id) {
        return { state: 'blocked', code: 'DIRECTOR_INPUT_STALE',
          message: '已采用的事实计划或分镜与本次生产的剧本版本不匹配。' };
      }
      return { state: 'ready', plan, storyboard };
    } catch {
      return { state: 'blocked', code: 'DIRECTOR_INPUT_UNAVAILABLE',
        message: '无法读取已采用的事实计划或分镜，未构建 3D 白模。' };
    }
  }
}

export function directorDecision(policy: StoredProductionRun['directorPolicy'], shot: StoryboardShot,
  characterCount: number): DirectorDecision {
  if (policy === 'never') return { shotId: shot.id, sceneId: shot.sceneId, required: false, reasons: ['policy:never'] };
  if (policy === 'always') return { shotId: shot.id, sceneId: shot.sceneId, required: true, reasons: ['policy:always'] };
  const reasons: string[] = [];
  const movement = shot.design.cameraMovement.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, '');
  const fixed = /^(?:无|固定|静止|定镜|固定镜头|static|locked)$/u.test(movement);
  if (!fixed) reasons.push('cameraMovement');
  if (characterCount >= 3) reasons.push('threeOrMoreCharacters');
  if (shot.design.durationMs >= 8_000) reasons.push('longContinuousShot');
  if (/(全景|大全|远景|俯拍|仰拍|wide|aerial)/iu.test(shot.design.shotSize)) reasons.push('spatialShotSize');
  if (/(追逐|打斗|搏斗|奔跑|对峙|穿过|转身|走位|人群|群演|爆炸|跌倒|环绕|升降|车辆|楼梯|跨越)/u.test(shot.design.visualDescription)) reasons.push('spatialAction');
  return { shotId: shot.id, sceneId: shot.sceneId, required: reasons.length > 0, reasons: reasons.length ? reasons : ['simpleStaticComposition'] };
}

export function buildDirectorSnapshot(run: Readonly<StoredProductionRun>, plan: PlanRevisionRecord,
  storyboard: StoryboardRevision, shot: StoryboardShot): RuleBasedDirectorSnapshot {
  const scene = plan.content.scenes.find(item => item.id === shot.sceneId);
  if (!scene) throw new Error('shot scene is missing from adopted plan');
  const characters = scene.characterIds.map(id => plan.content.characters.find(item => item.id === id)).filter((item): item is PlanRevisionRecord['content']['characters'][number] => Boolean(item));
  const actorIds = characters.map(character => `actor-${canonicalDigest({ shot: shot.id, character: character.id }).slice(0, 16)}`);
  const platformId = `platform-${canonicalDigest({ shot: shot.id, scene: scene.id }).slice(0, 16)}`;
  const cameraId = `camera-${canonicalDigest({ shot: shot.id, storyboard: storyboard.id }).slice(0, 16)}`;
  const spread = characters.length > 3 ? 1.35 : 1.15;
  const palette = ['#9AA0A8', '#7587A8', '#A88575', '#7F9B82', '#9B7FA6', '#A69A72'];
  const actors = characters.map((character, index) => {
    const x = round((index - (characters.length - 1) / 2) * spread);
    const z = round(index % 2 === 0 ? 0.25 : -0.35);
    return { id: actorIds[index]!, type: 'mannequin', name: character.name.value, visible: true,
      transform: { position: { x, y: 0.1, z }, rotation: { x: 0, y: actorYawDegrees(index, characters.length), z: 0 },
        scale: { x: 1, y: 1, z: 1 } }, pose: { preset: posePreset(shot.design.visualDescription) }, attachments: [],
      bodyType: 'male', color: palette[index % palette.length], joints: {},
      provenance: { planEntityId: character.id, sourceRefs: character.sourceRefs } };
  });
  const distance = cameraDistance(shot.design.shotSize, characters.length);
  const cameraX = /(侧|斜)/u.test(shot.design.visualDescription) ? round(distance * 0.28) : 0;
  const focalLength = focalFor(shot.design.shotSize);
  const camera = { id: cameraId, type: 'camera', name: `${scene.order}-${shot.order} 主机位`, visible: true,
    focalLength, target: { x: 0, y: 1.25, z: 0 }, transform: { position: { x: cameraX, y: 1.65, z: distance } },
    provenance: { storyboardShotId: shot.id, cameraMovement: shot.design.cameraMovement } };
  const platform = { id: platformId, type: 'geometry', name: `${scene.title.value}·地台`, visible: true,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    attachments: [], shape: 'box', color: '#323841', size: [Math.max(6, characters.length * 1.8), 0.2, 6],
    provenance: { planSceneId: scene.id, locationId: scene.locationId } };
  const order = [platformId, ...actorIds, cameraId];
  return { schemaVersion: 1, objects: [platform, ...actors], cameras: [camera], selectedObjectId: null,
    activeCameraId: cameraId, aspectRatio: run.ratio,
    environment: { preset: environmentFor(scene.timeOfDay?.value ?? ''), backgroundColor: '#15181E', ambientLight: 0.6, groundVisible: true },
    ui: { aspect: run.ratio, viewMode: 'camera', overlays: { thirds: true, center: false, safeArea: true, nameTags: true }, order,
      scene: { groundOpacity: 1, gridSnap: true, panoramaUrl: null, panoramaRotation: 0, panoramaRadius: 30 } },
    provenance: { ruleBased: true, ruleVersion: DIRECTOR_SNAPSHOT_VERSION, projectId: run.projectId,
      scriptVersionId: run.scriptVersionId, planRevisionId: plan.id, storyboardRevisionId: storyboard.id,
      shotId: shot.id, sceneId: scene.id } };
}

function blocked(code: string, message: string): ProductionExecutorOutcome {
  return { state: 'blocked', issue: { code, title: '3D 导演预演已停止', message,
    severity: 'error', recommendedActions: ['检查已采用的剧本、事实计划和分镜版本', '修复后局部重试'] } };
}

/** Pose ids the director stage resolves. `turn` is not one of them and imports as stand. */
export function posePreset(description: string): string {
  if (/(奔跑|冲|追逐)/u.test(description)) return 'walk';
  if (/(坐|落座)/u.test(description)) return 'sit';
  if (/(指|手指)/u.test(description)) return 'point';
  if (/(观察|凝视|查看)/u.test(description)) return 'observe';
  if (/(对峙|打斗|搏斗)/u.test(description)) return 'confront';
  if (/(转身|回头)/u.test(description)) return 'lookback';
  return 'stand';
}

/** Director transforms use degrees. 0.18 rad (~10.313°) was written raw and opened as 0.18°. */
function actorYawDegrees(index: number, count: number): number {
  const sign = index < count / 2 ? 1 : -1;
  return round(sign * 0.18 * 180 / Math.PI);
}

function focalFor(shotSize: string): 16 | 24 | 35 | 50 | 85 {
  if (/(特写|close)/iu.test(shotSize)) return 85;
  if (/(近景|mediumclose)/iu.test(shotSize)) return 50;
  if (/(全景|大全|远景|wide)/iu.test(shotSize)) return 24;
  return 35;
}

function cameraDistance(shotSize: string, count: number): number {
  const base = /(特写|close)/iu.test(shotSize) ? 2.4 : /(全景|大全|远景|wide)/iu.test(shotSize) ? 7.5 : 4.5;
  return round(base + Math.max(0, count - 2) * 0.55);
}

function environmentFor(time: string): string {
  if (/(夜|深夜|凌晨)/u.test(time)) return 'night_cold';
  if (/(黄昏|傍晚|日落)/u.test(time)) return 'dusk';
  if (/(室内|房间)/u.test(time)) return 'indoor_warm';
  return 'studio';
}

function round(value: number): number { return Math.round(value * 1000) / 1000; }
