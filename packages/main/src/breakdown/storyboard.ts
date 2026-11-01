import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { Type, type Static } from '@sinclair/typebox';
import type { AppConfig } from '../config';
import { assertModelSelection, configForRole } from '../models/connections';
import type { PostgresDatabase } from '../db/client';
import { ModelClient } from '../models/client';
import { BreakdownError, PaidModelExecutionError, type PaidModelCallState } from './errors';
import type { PlanRevisionRecord } from './plan';
import type { BreakdownService } from './service';
import { canonicalJsonSha256 } from './service';
import type { SourceRef } from './source-index';
import { runPiJsonAgent } from './pi-json';

export const STORYBOARD_PROMPT_VERSION = 'storyboard-design/1';
export const STORYBOARD_VALIDATOR_VERSION = 'storyboard-validator/2';

const refSchema = Type.Object({ scriptVersionId: Type.String(), start: Type.Integer({ minimum: 0 }),
  end: Type.Integer({ minimum: 1 }), quote: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const rawSchema = Type.Object({ shots: Type.Array(Type.Object({
  sceneId: Type.String({ minLength: 1 }), order: Type.Integer({ minimum: 1 }),
  visualDescription: Type.String({ minLength: 1, maxLength: 3000 }),
  shotSize: Type.String({ minLength: 1, maxLength: 100 }),
  cameraMovement: Type.String({ minLength: 1, maxLength: 200 }),
  durationMs: Type.Integer({ minimum: 100, maximum: 60000 }),
  sourceRefs: Type.Array(refSchema, { minItems: 1, maxItems: 20 }),
  dialogueIds: Type.Array(Type.String(), { maxItems: 20, uniqueItems: true }),
}, { additionalProperties: false }), { minItems: 1, maxItems: 2000 }) }, { additionalProperties: false });
type RawStoryboard = Static<typeof rawSchema>;
const validateRaw = new Ajv().compile<RawStoryboard>(rawSchema);

export interface StoryboardShot {
  id: string;
  sceneId: string;
  order: number;
  design: { origin: 'designSuggestion'; visualDescription: string; shotSize: string;
    cameraMovement: string; durationMs: number };
  sourceRefs: SourceRef[];
  dialogueIds: string[];
}
export interface StoryboardRevision {
  id: string; projectId: string; scriptVersionId: string; sourcePlanRevisionId: string;
  attemptId: string; shots: StoryboardShot[]; inputDigest: string;
  promptVersion: typeof STORYBOARD_PROMPT_VERSION; model: string;
  providerRequestId: string | null; usage: unknown; createdAt: string;
}

function sameRef(left: SourceRef, right: SourceRef) {
  return left.scriptVersionId === right.scriptVersionId && left.start === right.start
    && left.end === right.end && left.quote === right.quote;
}

/** Strict structural and provenance checks; visual semantics still need review. */
export function validateStoryboardOutput(value: unknown, plan: PlanRevisionRecord,
  nextId: () => string = () => `shot_${randomUUID().replaceAll('-', '')}`): StoryboardShot[] {
  if (!validateRaw(value)) throw new BreakdownError(422, 'STORYBOARD_OUTPUT_INVALID', '分镜输出结构不符合约定。');
  const raw = value as RawStoryboard;
  const scenes = new Map(plan.content.scenes.map(scene => [scene.id, scene]));
  const dialogues = new Map(plan.content.dialogues.map(dialogue => [dialogue.id, dialogue]));
  // The adopted plan already orders dialogue by scene.order and source position within each scene.
  const dialogueOrder = new Map(plan.content.dialogues.map((dialogue, index) => [dialogue.id, index]));
  const seenDialogues = new Set<string>();
  const counters = new Map<string, number>();
  const shots: StoryboardShot[] = [];
  let previousSceneOrder = 0;
  let previousDialogueOrder = -1;
  for (const shot of raw.shots) {
    const scene = scenes.get(shot.sceneId);
    if (!scene) throw new BreakdownError(422, 'STORYBOARD_SCENE_UNKNOWN', '分镜引用了不存在的场次。');
    if (scene.order < previousSceneOrder) {
      throw new BreakdownError(422, 'STORYBOARD_SCENE_ORDER_INVALID', '镜头必须按已采用的场次顺序排列，不得倒序或交错场次。');
    }
    previousSceneOrder = scene.order;
    const expected = (counters.get(scene.id) ?? 0) + 1;
    if (shot.order !== expected) throw new BreakdownError(422, 'STORYBOARD_ORDER_INVALID', '每场镜头需从 1 开始连续编号。');
    counters.set(scene.id, expected);
    const allowedRefs = [...scene.sourceRefs, ...plan.content.dialogues.filter(line => line.sceneId === scene.id).map(line => line.sourceRef)];
    if (shot.sourceRefs.some(ref => !allowedRefs.some(allowed => sameRef(ref, allowed)))) {
      throw new BreakdownError(422, 'STORYBOARD_SOURCE_INVALID', '镜头引用了场次之外或被改写的原文。');
    }
    for (const id of shot.dialogueIds) {
      const dialogue = dialogues.get(id);
      if (!dialogue || dialogue.sceneId !== scene.id || seenDialogues.has(id)) {
        throw new BreakdownError(422, 'STORYBOARD_DIALOGUE_INVALID', '对白绑定错误或重复。');
      }
      const currentDialogueOrder = dialogueOrder.get(id)!;
      if (currentDialogueOrder <= previousDialogueOrder) {
        throw new BreakdownError(422, 'STORYBOARD_DIALOGUE_ORDER_INVALID', '对白必须按已采用事实的原文顺序播放，镜头之间和镜头内均不得倒置。');
      }
      if (!shot.sourceRefs.some(ref => sameRef(ref, dialogue.sourceRef)
        || (ref.start <= dialogue.sourceRef.start && ref.end >= dialogue.sourceRef.end))) {
        throw new BreakdownError(422, 'STORYBOARD_DIALOGUE_SOURCE_MISSING', '绑定对白的镜头没有引用该段原文。');
      }
      seenDialogues.add(id);
      previousDialogueOrder = currentDialogueOrder;
    }
    shots.push({ id: nextId(), sceneId: scene.id, order: shot.order,
      design: { origin: 'designSuggestion', visualDescription: shot.visualDescription.trim(),
        shotSize: shot.shotSize.trim(), cameraMovement: shot.cameraMovement.trim(), durationMs: shot.durationMs },
      sourceRefs: shot.sourceRefs.map(ref => ({ ...ref })), dialogueIds: [...shot.dialogueIds] });
  }
  if (counters.size !== scenes.size || seenDialogues.size !== dialogues.size) {
    throw new BreakdownError(422, 'STORYBOARD_COVERAGE_INCOMPLETE', '分镜未覆盖全部场次和对白。');
  }
  return shots;
}

const SYSTEM_PROMPT = `你是中文短剧分镜设计 Agent。只返回 JSON，不输出 Markdown。
输入是已经核对并采用的事实计划。输出 {"shots":[...]}，每个 shots 元素就是一个连续镜头。
字段精确为 sceneId,order,visualDescription,shotSize,cameraMovement,durationMs,sourceRefs,dialogueIds。
sceneId、dialogueIds 必须引用输入中的真实 ID；sourceRefs 必须逐字复制该场 sourceRefs 或 dialogue sourceRef，绝不改写。
每场至少一个镜头，从 1 连续编号；每句对白恰好绑定一次，保持原顺序和剧情。不要新增人物、情节或对白。
visualDescription、shotSize、cameraMovement、durationMs 是你的拍摄设计建议，可补充景别和运镜。镜头时长单位毫秒。`;

interface StoryboardRow { id: string; project_id: string; script_version_id: string;
  source_plan_revision_id: string; attempt_id: string; content_json: unknown; input_digest: string;
  prompt_version: string; model: string; provider_request_id: string | null; usage_json: unknown;
  created_at: Date | string }

export class StoryboardService {
  constructor(private readonly database: PostgresDatabase, private readonly breakdown: BreakdownService,
    private readonly config: AppConfig, private readonly transport: typeof fetch = fetch) {}

  async generate(projectId: string, expectedModelConnectionRevision?: string): Promise<StoryboardRevision> {
    const config = configForRole(this.config, 'general');
    assertModelSelection(config, expectedModelConnectionRevision);
    const model = new ModelClient(config, this.transport);
    model.assertConfigured();
    const project = await this.breakdown.getProject(projectId);
    if (!project.activePlanRevisionId || !project.currentScriptVersionId) {
      throw new BreakdownError(409, 'ADOPTED_FACTS_REQUIRED', '请先采用当前剧本的事实拆解。');
    }
    const plan = await this.breakdown.getPlanRevision(project.activePlanRevisionId);
    if (plan.scriptVersionId !== project.currentScriptVersionId) {
      throw new BreakdownError(409, 'ADOPTED_FACTS_STALE', '已采用的拆解与当前剧本不一致。');
    }
    const context = { synopsis: plan.content.synopsis, characters: plan.content.characters,
      locations: plan.content.locations, props: plan.content.props, scenes: plan.content.scenes,
      dialogues: plan.content.dialogues };
    const userText = JSON.stringify(context);
    if (Buffer.byteLength(userText, 'utf8') > 500_000) {
      throw new BreakdownError(413, 'STORYBOARD_CONTEXT_TOO_LARGE', '当前分镜输入过长，请缩小单集剧本后重试。');
    }
    const inputDigest = canonicalJsonSha256({ planId: plan.id, context, promptVersion: STORYBOARD_PROMPT_VERSION });
    const attemptId = `sbattempt_${randomUUID().replaceAll('-', '')}`;
    await this.database.query(`INSERT INTO storyboard_attempts
      (id, project_id, source_plan_revision_id, model, prompt_version, input_digest, status, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,'running',now())`,
    [attemptId, projectId, plan.id, config.defaultModel, STORYBOARD_PROMPT_VERSION, inputDigest]);
    let responseMeta: Awaited<ReturnType<ModelClient['call']>> | null = null;
    let modelCallStarted = false;
    try {
      const raw = await runPiJsonAgent({ systemPrompt: SYSTEM_PROMPT,
        prompt: { operation: 'designStoryboard', context },
        invoke: async (systemPrompt, userContext) => {
          modelCallStarted = true;
          const response = await model.call({ model: config.defaultModel,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContext }],
            ...(config.reasoningEffort !== 'model-default' ? { reasoningEffort: config.reasoningEffort } : {}),
            maxOutputTokens: config.maxOutputTokens, allowPaid: true });
          responseMeta = response;
          if (response.status !== 'completed') throw new BreakdownError(422, 'STORYBOARD_OUTPUT_INCOMPLETE', '模型分镜输出被截断。');
          try { return JSON.parse(response.text.trim()); }
          catch { throw new BreakdownError(422, 'STORYBOARD_OUTPUT_NOT_JSON', '模型没有返回有效 JSON 分镜。'); }
        },
      });
      if (!responseMeta) throw new BreakdownError(502, 'STORYBOARD_MODEL_FAILED', '分镜模型未返回结果。');
      const response = responseMeta as Awaited<ReturnType<ModelClient['call']>>;
      const shots = validateStoryboardOutput(raw, plan);
      const revisionId = `storyboard_${randomUUID().replaceAll('-', '')}`;
      return await this.database.transaction(async client => {
        const current = await client.query<{ current_script_version_id: string | null; active_plan_revision_id: string | null }>(
          'SELECT current_script_version_id, active_plan_revision_id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
        if (current.rows[0]?.current_script_version_id !== plan.scriptVersionId
          || current.rows[0]?.active_plan_revision_id !== plan.id) {
          throw new BreakdownError(409, 'STORYBOARD_INPUT_CHANGED', '模型运行期间剧本或事实版本已变化，请重新生成。');
        }
        await client.query(`UPDATE storyboard_attempts SET status='succeeded', provider_request_id=$2,
          usage_json=$3::jsonb, ended_at=now() WHERE id=$1`,
        [attemptId, response.providerRequestId, JSON.stringify(response.usage)]);
        const result = await client.query<StoryboardRow>(`INSERT INTO storyboard_revisions
          (id,project_id,script_version_id,source_plan_revision_id,attempt_id,content_json,input_digest,
           prompt_version,model,provider_request_id,usage_json,created_at)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb,now()) RETURNING *`,
        [revisionId, projectId, plan.scriptVersionId, plan.id, attemptId,
          JSON.stringify({ shots, validatorVersion: STORYBOARD_VALIDATOR_VERSION }), inputDigest,
          STORYBOARD_PROMPT_VERSION, config.defaultModel, response.providerRequestId, JSON.stringify(response.usage)]);
        return toStoryboard(result.rows[0]!);
      });
    } catch (error) {
      const code = error instanceof BreakdownError ? error.code : 'STORYBOARD_MODEL_FAILED';
      const failedResponse = responseMeta as Awaited<ReturnType<ModelClient['call']>> | null;
      await this.database.query(`UPDATE storyboard_attempts SET status='failed', error_code=$2,
        provider_request_id=$3, usage_json=$4::jsonb, ended_at=now() WHERE id=$1 AND status='running'`,
      [attemptId, code, failedResponse?.providerRequestId ?? null,
        failedResponse ? JSON.stringify(failedResponse.usage) : null]);
      const paidModelCallState: PaidModelCallState = failedResponse ? 'confirmed' : modelCallStarted ? 'unknown' : 'none';
      if (error instanceof BreakdownError) {
        throw new PaidModelExecutionError(error.status, error.code, error.message, paidModelCallState);
      }
      throw new PaidModelExecutionError(502, code, '分镜生成失败，请检查本机模型代理；不会自动重试。', paidModelCallState);
    }
  }

  async list(projectId: string): Promise<StoryboardRevision[]> {
    await this.breakdown.getProject(projectId);
    const result = await this.database.query<StoryboardRow>(
      'SELECT * FROM storyboard_revisions WHERE project_id=$1 ORDER BY created_at DESC,id DESC', [projectId]);
    return result.rows.map(toStoryboard);
  }

  async get(revisionId: string): Promise<StoryboardRevision> {
    const result = await this.database.query<StoryboardRow>('SELECT * FROM storyboard_revisions WHERE id=$1', [revisionId]);
    if (!result.rows[0]) throw new BreakdownError(404, 'STORYBOARD_NOT_FOUND', '分镜版本不存在。');
    return toStoryboard(result.rows[0]);
  }

  async adopt(projectId: string, revisionId: string, expectedActiveStoryboardRevisionId: string | null,
    actor: 'user' | 'agent' = 'user') {
    if (actor !== 'user' && actor !== 'agent') {
      throw new BreakdownError(400, 'STORYBOARD_ADOPTION_ACTOR_INVALID', '采用操作者类型无效。');
    }
    // Revisions are immutable: validate before acquiring a transaction connection.
    // getPlanRevision reads through the pool and must not run while holding another connection.
    const candidate = await this.database.query<StoryboardRow>(
      'SELECT * FROM storyboard_revisions WHERE id=$1 AND project_id=$2', [revisionId, projectId]);
    const checkedRow = candidate.rows[0];
    if (checkedRow) {
      // Older revisions remain readable, but adoption must satisfy today's rules too.
      // Validate without rewriting history or allocating replacement shot IDs.
      const storyboard = toStoryboard(checkedRow);
      const plan = await this.breakdown.getPlanRevision(checkedRow.source_plan_revision_id);
      let shotIndex = 0;
      validateStoryboardOutput({ shots: storyboard.shots.map(shot => ({
        sceneId: shot.sceneId, order: shot.order, visualDescription: shot.design.visualDescription,
        shotSize: shot.design.shotSize, cameraMovement: shot.design.cameraMovement,
        durationMs: shot.design.durationMs, sourceRefs: shot.sourceRefs, dialogueIds: shot.dialogueIds,
      })) }, plan, () => storyboard.shots[shotIndex++]!.id);
    }
    return this.database.transaction(async client => {
      const result = await client.query<{ current_script_version_id: string | null; active_plan_revision_id: string | null;
        active_storyboard_revision_id: string | null }>(
        'SELECT current_script_version_id,active_plan_revision_id,active_storyboard_revision_id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
      const project = result.rows[0];
      if (!project) throw new BreakdownError(404, 'PROJECT_NOT_FOUND', '项目不存在。');
      if (project.active_storyboard_revision_id !== expectedActiveStoryboardRevisionId) {
        throw new BreakdownError(409, 'STORYBOARD_ADOPTION_CONFLICT', '已采用的分镜版本发生变化，请刷新。');
      }
      const target = await client.query<StoryboardRow>(
        'SELECT * FROM storyboard_revisions WHERE id=$1 AND project_id=$2', [revisionId, projectId]);
      const row = target.rows[0];
      if (!checkedRow || !row || row.script_version_id !== checkedRow.script_version_id
        || row.source_plan_revision_id !== checkedRow.source_plan_revision_id
        || row.script_version_id !== project.current_script_version_id
        || row.source_plan_revision_id !== project.active_plan_revision_id) {
        throw new BreakdownError(409, 'STORYBOARD_NOT_ADOPTABLE', '分镜版本与当前剧本或事实拆解不一致。');
      }
      const adoptionId = `sbadopt_${randomUUID().replaceAll('-', '')}`;
      await client.query(`INSERT INTO storyboard_adoptions
        (id,project_id,from_revision_id,to_revision_id,source_plan_revision_id,actor,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,now())`,
      [adoptionId, projectId, project.active_storyboard_revision_id, revisionId, row.source_plan_revision_id, actor]);
      await client.query('UPDATE projects SET active_storyboard_revision_id=$1 WHERE id=$2', [revisionId, projectId]);
      return { id: adoptionId, projectId, fromRevisionId: project.active_storyboard_revision_id,
        toRevisionId: revisionId, actor };
    });
  }
}

function toStoryboard(row: StoryboardRow): StoryboardRevision {
  const content = row.content_json as { shots: StoryboardShot[]; validatorVersion: string };
  if (!content || !Array.isArray(content.shots)
    || !['storyboard-validator/1', STORYBOARD_VALIDATOR_VERSION].includes(content.validatorVersion)) {
    throw new BreakdownError(500, 'STORYBOARD_STORED_INVALID', '已保存的分镜版本格式不受支持。');
  }
  return { id: row.id, projectId: row.project_id, scriptVersionId: row.script_version_id,
    sourcePlanRevisionId: row.source_plan_revision_id, attemptId: row.attempt_id,
    shots: structuredClone(content.shots), inputDigest: row.input_digest,
    promptVersion: STORYBOARD_PROMPT_VERSION, model: row.model,
    providerRequestId: row.provider_request_id, usage: row.usage_json,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at };
}
