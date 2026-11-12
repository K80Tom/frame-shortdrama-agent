import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { Type, type Static } from '@sinclair/typebox';
import type { ScriptDialogueExclusion, ScriptParseAttempt, ScriptParseCharacter, ScriptParseEntity, ScriptParseResult } from '@lyra/shared';
import { ModelError, SCRIPT_DIALOGUE_REPAIR_PROMPT_VERSION, SCRIPT_PARSE_PROMPT_VERSION } from '@lyra/shared';
import { validateScriptStructure, type ScriptElementType, type ScriptStructure } from '@lyra/shared';
import type { AppConfig } from '../config';
import { assertModelSelection, configForRole } from '../models/connections';
import { ModelClient } from '../models/client';
import type { PostgresDatabase } from '../db/client';
import { BreakdownError } from './errors';
import type { BreakdownService } from './service';
import { canonicalJsonSha256 } from './service';
import type { CreateExtractFactsCandidateRequest, PlanRevisionRecord } from './plan';
import type { PlanIssueRecord } from './quality';
import type { StoredScriptVersion } from './repository';
import { dialogueBodySpans, sliceCodePoints } from './source-index';

export { SCRIPT_PARSE_PROMPT_VERSION };
export const SCRIPT_PARSE_VALIDATOR_VERSION = 'script-parse-validator/1';

const entitySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 160 }),
  aliases: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 32 }),
  description: Type.Union([Type.Null(), Type.String({ maxLength: 2000 })]),
}, { additionalProperties: false });
const elementSchema = Type.Object({
  type: Type.Integer({ minimum: 1, maximum: 5 }),
  characterName: Type.Optional(Type.String({ maxLength: 160 })),
  parenthetical: Type.Optional(Type.String({ maxLength: 160 })),
  content: Type.String({ minLength: 1, maxLength: 3000 }),
}, { additionalProperties: false });
const sceneSchema = Type.Object({
  sceneHeading: Type.Optional(Type.String({ maxLength: 160 })),
  location: Type.Optional(Type.String({ maxLength: 160 })),
  timeOfDay: Type.Optional(Type.String({ maxLength: 160 })),
  intExt: Type.Optional(Type.Union([Type.Literal(''), Type.Literal('内'), Type.Literal('外'), Type.Literal('内/外')])),
  sceneDescription: Type.Optional(Type.String({ maxLength: 3000 })),
  elements: Type.Array(elementSchema, { minItems: 1, maxItems: 200 }),
}, { additionalProperties: false });
const rawSchema = Type.Object({
  title: Type.Optional(Type.String({ maxLength: 160 })),
  synopsis: Type.Optional(Type.String({ maxLength: 3000 })),
  characters: Type.Array(entitySchema, { maxItems: 200 }),
  locations: Type.Optional(Type.Array(entitySchema, { maxItems: 200 })),
  props: Type.Optional(Type.Array(entitySchema, { maxItems: 200 })),
  scenes: Type.Array(sceneSchema, { minItems: 1, maxItems: 500 }),
}, { additionalProperties: false });
type RawParse = Static<typeof rawSchema>;
const validateRaw = new Ajv({ allErrors: false }).compile<RawParse>(rawSchema);

const repairOutputSchema = Type.Object({
  action: Type.Union([Type.Literal('append'), Type.Literal('exclude')]),
  reason: Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' }),
  candidateIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 50, uniqueItems: true })),
  dialogues: Type.Optional(Type.Array(Type.Object({
    candidateId: Type.String({ minLength: 1, maxLength: 80 }),
    characterName: Type.Optional(Type.String({ maxLength: 160 })),
    parenthetical: Type.Optional(Type.String({ maxLength: 160 })),
  }, { additionalProperties: false }), { maxItems: 50 })),
}, { additionalProperties: false });
type RepairOutput = Static<typeof repairOutputSchema>;
const validateRepairOutput = new Ajv({ allErrors: false }).compile<RepairOutput>(repairOutputSchema);

const SYSTEM_PROMPT = `你是中文短剧剧本结构解析器。输入是用户提供的一整段中文故事或剧本，没有任何分集、场次标题或编号。
请把它解析为恰好 1 集，并按地点、时间、连续动作或对话单元自动分场。只返回 JSON，不输出 Markdown。
输出结构：
{"title":"第1集","synopsis":"一句话剧情梗概","characters":[{"name":"人物名","aliases":["别名"],"description":"简短人物说明"}],"locations":[{"name":"地点名","aliases":["别名"],"description":"简短地点说明"}],"props":[{"name":"道具名","aliases":["别名"],"description":"简短道具说明"}],"scenes":[{"sceneHeading":"场次标题","location":"地点","timeOfDay":"日/夜/黄昏等","intExt":"内/外/内/外/空","sceneDescription":"本场整体描述","elements":[{"type":1,"characterName":"说话人","parenthetical":"语气提示，可空","content":"台词或文本"}]}]}
规则：
- 元素 type：1=对白，2=动作，3=旁白，4=镜头/特写/运镜，5=环境/氛围。
- 必须保留原文事实与语句，不得新增情节、人物或对白；可以写简短的场次标题和地点，但元素 content 不得改写。
- 每场至少 1 个元素；对白尽量识别说话人并写入 characterName；旁白也可以带说话人。
- characters 必须列出文本中出现的所有有名字人物（包含只被提到的人）；aliases 可为空；不要编造人物。
- locations 必须列出剧情实际发生的地点，名称尽量与 scenes.location 一致；没有明确地点时返回空数组。
- props 必须列出原文明确出现且对动作、对白或镜头有作用的物件，不得编造；没有明确道具时返回空数组。
- 不要输出分集编号、场次编号或 ID，服务端会生成。`;

function normalize(raw: RawParse): ScriptParseResult {
  let elementNumber = 0;
  const structure: ScriptStructure = {
    schemaVersion: 'script-structure/1',
    episodes: [{
      id: 'episode_1', episodeNumber: 1,
      title: (raw.title ?? '').trim() || '第1集',
      synopsis: (raw.synopsis ?? '').trim(),
      scenes: raw.scenes.map((scene, sceneIndex) => ({
        id: `scene_1_${sceneIndex + 1}`,
        sceneNumber: `1-${sceneIndex + 1}`,
        sceneHeading: (scene.sceneHeading ?? '').trim(),
        location: (scene.location ?? '').trim(),
        timeOfDay: (scene.timeOfDay ?? '').trim(),
        intExt: scene.intExt ?? '',
        sceneDescription: (scene.sceneDescription ?? '').trim(),
        dialogues: scene.elements.filter(element => element.content.trim()).map(element => {
          const type = element.type as ScriptElementType;
          return {
            id: `element_${++elementNumber}`,
            type,
            content: element.content.trim(),
            ...(type === 1 || type === 3 ? {
              characterName: (element.characterName ?? '').trim(),
              parenthetical: (element.parenthetical ?? '').trim(),
            } : {}),
          };
        }),
      })),
    }],
  };
  const structure2 = validateScriptStructure(structure);
  const characters = normalizeEntities(raw.characters);
  const locations = normalizeEntities([
    ...(raw.locations ?? []),
    ...raw.scenes.map(scene => ({
      name: scene.location ?? '', aliases: [] as string[], description: null,
    })),
  ]);
  const props = normalizeEntities(raw.props ?? []);
  return { structure: structure2, characters, locations, props };
}

function normalizeEntities(rawEntities: ScriptParseEntity[]): ScriptParseEntity[] {
  const entities: ScriptParseEntity[] = [];
  const seen = new Set<string>();
  for (const entity of rawEntities) {
    const name = entity.name.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    entities.push({
      name,
      aliases: entity.aliases.map(alias => alias.trim()).filter(Boolean),
      description: entity.description?.trim() || null,
    });
  }
  return entities;
}

/** 把解析结果作为预览返回，不创建剧本版本；确认保存由用户显式触发。 */
export class ScriptParseService {
  constructor(private readonly database: PostgresDatabase, private readonly breakdown: BreakdownService,
    private readonly config: AppConfig, private readonly transport: typeof fetch = fetch) {}

  async list(projectId: string): Promise<ScriptParseAttempt[]> {
    await this.breakdown.getProject(projectId);
    const result = await this.database.query(`SELECT a.id, a.script_version_id, v.version AS script_version,
      a.model, a.prompt_version, a.status, a.error_code, a.provider_request_id, a.usage_json, a.output_json,
      a.created_at, a.ended_at
      FROM script_parse_attempts a
      JOIN script_versions v ON v.id = a.script_version_id
      WHERE a.project_id=$1
      ORDER BY a.created_at DESC LIMIT 50`, [projectId]);
    return result.rows.map(row => ({
      id: row.id as string,
      scriptVersionId: row.script_version_id as string,
      scriptVersion: Number(row.script_version),
      model: row.model as string,
      promptVersion: row.prompt_version as string,
      status: row.status as ScriptParseAttempt['status'],
      errorCode: row.error_code as string | null,
      providerRequestId: row.provider_request_id as string | null,
      usage: (row.usage_json as ScriptParseAttempt['usage'] | null) ?? null,
      output: (row.output_json as ScriptParseResult | null) ?? null,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      endedAt: row.ended_at == null ? null : row.ended_at instanceof Date ? row.ended_at.toISOString() : String(row.ended_at),
    }));
  }

  async parse(projectId: string, scriptVersionId: string | undefined, expectedModelConnectionRevision?: string): Promise<ScriptParseResult & {
    attemptId: string; model: string; promptVersion: string; usage: unknown }> {
    const config = configForRole(this.config, 'breakdown');
    assertModelSelection(config, expectedModelConnectionRevision);
    const model = new ModelClient(config, this.transport);
    model.assertConfigured();
    const project = await this.breakdown.getProject(projectId);
    const versionId = scriptVersionId ?? project.currentScriptVersionId;
    if (!versionId) throw new BreakdownError(409, 'SCRIPT_VERSION_REQUIRED', '请先保存原文，再进行 AI 解析。');
    const script = await this.breakdown.getScriptVersion(projectId, versionId);
    if (!script.rawText.trim()) throw new BreakdownError(409, 'SCRIPT_VERSION_EMPTY', '原文为空，无法解析。');
    const inputDigest = canonicalJsonSha256({ scriptVersionId: script.id, rawText: script.rawText,
      promptVersion: SCRIPT_PARSE_PROMPT_VERSION });
    const attemptId = `scriptparse_${randomUUID().replaceAll('-', '')}`;
    await this.database.query(`INSERT INTO script_parse_attempts
      (id, project_id, script_version_id, model, prompt_version, input_digest, status, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,'running',now())`,
    [attemptId, projectId, script.id, config.defaultModel, SCRIPT_PARSE_PROMPT_VERSION, inputDigest]);
    let response: Awaited<ReturnType<ModelClient['call']>> | null = null;
    try {
      response = await model.call({
        model: config.defaultModel,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: script.rawText },
        ],
        ...(config.reasoningEffort !== 'model-default' ? { reasoningEffort: config.reasoningEffort } : {}),
        maxOutputTokens: config.maxOutputTokens,
        allowPaid: true,
        thinking: 'disabled',
        jsonOutput: true,
      });
      if (response.status !== 'completed') throw new BreakdownError(422, 'SCRIPT_PARSE_OUTPUT_INCOMPLETE', '模型解析输出被截断，请缩短原文后重试。');
      let raw: unknown;
      try { raw = JSON.parse(response.text.trim()); }
      catch { throw new BreakdownError(422, 'SCRIPT_PARSE_OUTPUT_NOT_JSON', '模型没有返回有效 JSON 解析结果。'); }
      if (!validateRaw(raw)) throw new BreakdownError(422, 'SCRIPT_PARSE_OUTPUT_INVALID', '模型解析结果不符合剧本结构约定。');
      const result = normalize(raw as RawParse);
      await this.database.query(`UPDATE script_parse_attempts SET status='succeeded', output_json=$2::jsonb,
        provider_request_id=$3, usage_json=$4::jsonb, ended_at=now() WHERE id=$1`,
      [attemptId, JSON.stringify(result),
        response.providerRequestId, JSON.stringify(response.usage)]);
      return { ...result, attemptId, model: config.defaultModel, promptVersion: SCRIPT_PARSE_PROMPT_VERSION, usage: response.usage };
    } catch (error) {
      await this.database.query(`UPDATE script_parse_attempts SET status='failed', error_code=$2,
        provider_request_id=$3, usage_json=$4::jsonb, ended_at=now() WHERE id=$1 AND status='running'`,
      [attemptId, error instanceof BreakdownError || error instanceof ModelError ? error.code : 'SCRIPT_PARSE_MODEL_FAILED',
        response?.providerRequestId ?? null, response ? JSON.stringify(response.usage) : null]);
      if (error instanceof BreakdownError || error instanceof ModelError) throw error;
      throw new BreakdownError(502, 'SCRIPT_PARSE_MODEL_FAILED', '剧本解析模型调用失败，请检查模型连接后重试。');
    }
  }

  /** AI 只选择原文候选范围；正文、引用和最终结构均由服务端生成。 */
  async repair(projectId: string, input: {
    planRevisionId: string; checkId: string; issueId: string; expectedModelConnectionRevision?: string;
  }): Promise<ScriptParseResult & { attemptId: string; model: string; promptVersion: string; usage: unknown }> {
    const config = configForRole(this.config, 'breakdown');
    assertModelSelection(config, input.expectedModelConnectionRevision);
    const model = new ModelClient(config, this.transport);
    model.assertConfigured();
    const project = await this.breakdown.getProject(projectId);
    const plan = await this.breakdown.getPlanRevision(input.planRevisionId);
    if (plan.projectId !== projectId || plan.status !== 'candidate') {
      throw new BreakdownError(409, 'SCRIPT_DIALOGUE_REPAIR_PLAN_STALE', '事实候选已变化，请刷新后重新修复。');
    }
    if (project.currentScriptVersionId !== plan.scriptVersionId) {
      throw new BreakdownError(409, 'SCRIPT_DIALOGUE_REPAIR_SCRIPT_STALE', '该问题不属于当前剧本版本，请先打开当前问题。');
    }
    const checks = await this.breakdown.listPlanChecks(plan.id);
    const check = checks.find(item => item.id === input.checkId);
    if (!check || check.result !== 'failed' || check.contentDigest !== canonicalJsonSha256(plan.content)) {
      throw new BreakdownError(409, 'SCRIPT_DIALOGUE_REPAIR_CHECK_STALE', '校验结果已过期，请重新校验后再修复。');
    }
    const issues = await this.breakdown.listPlanIssues(check.id);
    const issue = issues.find(item => item.id === input.issueId);
    if (!issue || issue.planRevisionId !== plan.id || issue.status !== 'open') {
      throw new BreakdownError(409, 'SCRIPT_DIALOGUE_REPAIR_ISSUE_STALE', '修复问题已变化，请重新校验。');
    }
    const script = await this.breakdown.getScriptVersion(projectId, plan.scriptVersionId);
    const candidates = repairCandidates(plan, script, issue);
    if (!script.structure || candidates.length === 0) {
      throw new BreakdownError(409, 'SCRIPT_DIALOGUE_REPAIR_NO_SOURCE', '原文没有可安全修复的对白候选，请转人工检查原文和场次。');
    }
    const attemptId = `scriptparse_${randomUUID().replaceAll('-', '')}`;
    const inputDigest = canonicalJsonSha256({
      planRevisionId: plan.id, checkId: check.id, issueId: issue.id,
      contentDigest: check.contentDigest, promptVersion: SCRIPT_DIALOGUE_REPAIR_PROMPT_VERSION,
    });
    await this.database.query(`INSERT INTO script_parse_attempts
      (id, project_id, script_version_id, model, prompt_version, input_digest, status, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,'running',now())`,
    [attemptId, projectId, script.id, config.defaultModel, SCRIPT_DIALOGUE_REPAIR_PROMPT_VERSION, inputDigest]);
    try {
      const response = await model.call({
        model: config.defaultModel,
        messages: [
          { role: 'system', content: `你是剧本完整性校验修复器，只返回 JSON。
只能补齐输入 candidates 中确实缺失的原文对白，不得改写、不得新增原文没有的对白。
若候选原文是叙事、说明或称谓引用而非人物对白，使用 action="exclude"，并在 candidateIds 中选择对应候选。
若补对白，使用 action="append"，dialogues 只返回 candidateId、characterName、parenthetical；characterName 只能选择输入人物或留空。
reason 必须简短说明判断依据。不要输出正文 content，不要输出 Markdown。` },
          { role: 'user', content: JSON.stringify({
            issue: { code: issue.code, message: issue.message, scope: issue.scope, sourceRefs: issue.sourceRefs },
            characters: plan.content.characters.map(item => item.name.value),
            candidates: candidates.map(candidate => ({
              candidateId: candidate.id, sceneNumber: candidate.sceneNumber,
              speakerCandidate: candidate.speakerCandidate, content: candidate.content,
              sourceRef: candidate.bodyRef,
            })),
            output: { action: 'append|exclude', reason: 'string', candidateIds: ['dialogue_1'],
              dialogues: [{ candidateId: 'dialogue_1', characterName: '人物或空', parenthetical: '' }] },
          }) },
        ],
        ...(config.reasoningEffort !== 'model-default' ? { reasoningEffort: config.reasoningEffort } : {}),
        maxOutputTokens: config.maxOutputTokens,
        allowPaid: true,
        thinking: 'disabled',
        jsonOutput: true,
      });
      if (response.status !== 'completed') throw new BreakdownError(422, 'SCRIPT_DIALOGUE_REPAIR_OUTPUT_INCOMPLETE', 'AI 修复输出被截断，请重试或转人工。');
      const parsed = JSON.parse(response.text.trim()) as unknown;
      if (!validateRepairOutput(parsed)) {
        throw new BreakdownError(502, 'SCRIPT_DIALOGUE_REPAIR_OUTPUT_INVALID', 'AI 修复结果不符合只读原文修复契约。');
      }
      const output = parsed as RepairOutput;
      const reason = output.reason.trim();
      const allowed = new Map(candidates.map(candidate => [candidate.id, candidate]));
      const structure = structuredClone(script.structure);
      const addedDialogues: NonNullable<ScriptParseResult['repair']>['addedDialogues'] = [];
      let exclusions: ScriptDialogueExclusion[] = (plan.content.dialogueExclusions ?? []).map(item => ({
        sourceRef: { ...item.sourceRef }, reason: item.reason,
      }));
      if (output.action === 'append') {
        if (!output.dialogues?.length || output.candidateIds?.length) {
          throw new BreakdownError(502, 'SCRIPT_DIALOGUE_REPAIR_OUTPUT_INVALID', '补对白结果缺少有效原文候选。');
        }
        const selected = new Set<string>();
        const knownCharacters = new Set(plan.content.characters.map(item => item.name.value));
        for (const item of output.dialogues) {
          if (selected.has(item.candidateId)) throw new BreakdownError(502, 'SCRIPT_DIALOGUE_REPAIR_OUTPUT_INVALID', '同一原文候选不能重复修复。');
          selected.add(item.candidateId);
          const candidate = allowed.get(item.candidateId);
          if (!candidate) throw new BreakdownError(502, 'SCRIPT_DIALOGUE_REPAIR_OUTPUT_INVALID', 'AI 返回了不属于当前问题的原文候选。');
          const characterName = (item.characterName ?? (knownCharacters.has(candidate.speakerCandidate ?? '')
            ? candidate.speakerCandidate : ''))?.trim() ?? '';
          if (characterName && !knownCharacters.has(characterName)) {
            throw new BreakdownError(502, 'SCRIPT_DIALOGUE_REPAIR_OUTPUT_INVALID', 'AI 不能在对白修复中新增人物。');
          }
          const scene = structureScene(structure, candidate.sceneNumber);
          const element = {
            id: `element_repair_${randomUUID().replaceAll('-', '')}`, type: 1 as const,
            characterName, parenthetical: (item.parenthetical ?? '').trim(), content: candidate.content,
          };
          const insertionIndex = scene.dialogues.findIndex(existingElement => {
            const existingRef = codePointRef(script.rawText, existingElement.content, script.id);
            return (existingRef?.start ?? Number.MAX_SAFE_INTEGER) > candidate.bodyRef.start;
          });
          if (insertionIndex < 0) scene.dialogues.push(element);
          else scene.dialogues.splice(insertionIndex, 0, element);
          addedDialogues.push({
            sceneId: scene.id, sceneNumber: scene.sceneNumber, characterName,
            parenthetical: element.parenthetical, content: candidate.content, sourceRef: candidate.bodyRef,
          });
        }
      } else {
        if (!output.candidateIds?.length || output.dialogues?.length) {
          throw new BreakdownError(502, 'SCRIPT_DIALOGUE_REPAIR_OUTPUT_INVALID', '非对白排除结果缺少精确原文候选。');
        }
        const selected = new Set(output.candidateIds);
        if (selected.size !== output.candidateIds.length) throw new BreakdownError(502, 'SCRIPT_DIALOGUE_REPAIR_OUTPUT_INVALID', '非对白候选不能重复。');
        for (const candidateId of selected) {
          const candidate = allowed.get(candidateId);
          if (!candidate) throw new BreakdownError(502, 'SCRIPT_DIALOGUE_REPAIR_OUTPUT_INVALID', 'AI 返回了不属于当前问题的排除候选。');
          exclusions.push({ sourceRef: candidate.spanRef, reason });
        }
      }
      validateScriptStructure(structure);
      const repair = {
        issueId: issue.id, kind: output.action, reason, addedDialogues, exclusions,
      } satisfies NonNullable<ScriptParseResult['repair']>;
      const result: ScriptParseResult = {
        structure, characters: planEntities(plan, 'characters'),
        locations: planEntities(plan, 'locations'), props: planEntities(plan, 'props'), repair,
      };
      const endedAt = new Date().toISOString();
      const updated = await this.database.query(`UPDATE script_parse_attempts SET
        status='succeeded', provider_request_id=$2, output_json=$3::jsonb,
        usage_json=$4::jsonb, ended_at=$5::timestamptz
        WHERE id=$1 AND status='running' AND script_version_id=$6
        AND EXISTS (SELECT 1 FROM projects p WHERE p.id=project_id AND p.current_script_version_id=script_version_id)`,
      [attemptId, response.providerRequestId ?? null, JSON.stringify(result), JSON.stringify(response.usage ?? {}),
        endedAt, script.id]);
      if (updated.rowCount !== 1) {
        throw new BreakdownError(409, 'SCRIPT_DIALOGUE_REPAIR_STALE', '剧本版本已变化，修复结果未保存，请重新发起。');
      }
      return { ...result, attemptId, model: config.defaultModel,
        promptVersion: SCRIPT_DIALOGUE_REPAIR_PROMPT_VERSION, usage: response.usage ?? {} };
    } catch (cause) {
      const error = scriptDialogueRepairFailed(cause);
      await this.database.query(`UPDATE script_parse_attempts SET
        status='failed', error_code=$2, provider_request_id=$3, ended_at=$4::timestamptz
        WHERE id=$1 AND status='running' AND script_version_id=$5`,
      [attemptId, error.code, null, new Date().toISOString(), script.id]);
      throw error;
    }
  }

  /** 确认保存后创建事实候选：不覆盖当前已采用事实，只新增一份 candidate plan。 */
  async createCharacterCandidate(projectId: string, scriptVersionId: string, characters: ScriptParseCharacter[],
    locationEntities: ScriptParseEntity[] = [], props: ScriptParseEntity[] = [],
    dialogueExclusions: ScriptDialogueExclusion[] = []) {
    const script = await this.breakdown.getScriptVersion(projectId, scriptVersionId);
    if (characters.length + locationEntities.length + props.length === 0) {
      throw new BreakdownError(400, 'SCRIPT_PARSE_CHARACTERS_REQUIRED', '至少保留一个人物、地点或道具。');
    }
    const run = await this.breakdown.createDraftRun(projectId, {
      scriptVersionId: script.id, requirements: {}, maxModelCalls: 1, maxOutputTokens: 4096,
    });
    const candidate = factsCandidate(script, characters, locationEntities, props, dialogueExclusions);
    return this.breakdown.createExtractFactsCandidate(run.id, candidate);
  }
}

interface RepairCandidate {
  id: string;
  sceneNumber: string;
  speakerCandidate: string | null;
  content: string;
  bodyRef: { scriptVersionId: string; start: number; end: number; quote: string };
  spanRef: { scriptVersionId: string; start: number; end: number; quote: string };
}

function repairCandidates(plan: PlanRevisionRecord, script: StoredScriptVersion, issue: PlanIssueRecord): RepairCandidate[] {
  if (issue.code !== 'DIALOGUE_MISSING' && issue.code !== 'SCENE_DIALOGUE_MISSING') {
    throw new BreakdownError(400, 'SCRIPT_DIALOGUE_REPAIR_UNSUPPORTED', '该问题不是对白缺失，请使用对应的人工校对入口。');
  }
  const existing = plan.content.dialogues.map(item => item.sourceRef);
  const exclusions = plan.content.dialogueExclusions ?? [];
  const structureScenes = script.structure?.episodes.flatMap(episode => episode.scenes) ?? [];
  const candidates: RepairCandidate[] = [];
  for (const span of script.sourceIndex.spans) {
    if (span.kind !== 'dialogueTurnCandidate') continue;
    if (exclusions.some(item => item.sourceRef.start === span.start && item.sourceRef.end === span.end)) continue;
    const body = dialogueBodySpans(span);
    if (!body || existing.some(ref => ref.start <= body.inner.start && ref.end >= body.inner.end)) continue;
    const scenes = plan.content.scenes.filter(scene => scene.sourceRefs.some(ref => ref.start <= span.start && ref.end >= span.end));
    if (issue.code === 'SCENE_DIALOGUE_MISSING') {
      if (issue.scope.kind !== 'scene' || !scenes.some(scene => scene.id === issue.scope.targetId)) continue;
    } else if (!issue.sourceRefs.some(ref => ref.start === span.start && ref.end === span.end)) continue;
    const scene = scenes.sort((left, right) => left.order - right.order)[0];
    if (!scene) continue;
    const content = sliceCodePoints(script.rawText, body.inner.start, body.inner.end);
    const structureTarget = structureScenes.find(item => item.sceneNumber === scene.title.value)
      ?? structureScenes[scene.order - 1];
    if (!structureTarget) continue;
    candidates.push({
      id: `dialogue_${candidates.length + 1}`, sceneNumber: structureTarget.sceneNumber,
      speakerCandidate: span.speakerCandidate, content,
      bodyRef: { scriptVersionId: script.id, start: body.inner.start, end: body.inner.end, quote: content },
      spanRef: { scriptVersionId: script.id, start: span.start, end: span.end, quote: span.quote },
    });
  }
  return candidates;
}

function structureScene(structure: ScriptStructure, sceneNumber: string) {
  for (const episode of structure.episodes) {
    const scene = episode.scenes.find(item => item.sceneNumber === sceneNumber);
    if (scene) return scene;
  }
  throw new BreakdownError(409, 'SCRIPT_DIALOGUE_REPAIR_TARGET_UNAVAILABLE', '候选场次无法定位到当前结构，请转人工修复。');
}

function planEntities(plan: PlanRevisionRecord, key: 'characters' | 'locations' | 'props'): ScriptParseEntity[] {
  return plan.content[key].map(item => ({
    name: item.name.value, aliases: item.aliases.map(alias => alias.value),
    description: item.description?.value ?? null,
  }));
}

function scriptDialogueRepairFailed(cause: unknown): BreakdownError {
  if (cause instanceof BreakdownError) return cause;
  if (cause instanceof ModelError) {
    return new BreakdownError(502, 'SCRIPT_DIALOGUE_REPAIR_FAILED', `AI 修复调用失败：${cause.message}`);
  }
  return new BreakdownError(502, 'SCRIPT_DIALOGUE_REPAIR_OUTPUT_INVALID', 'AI 修复输出无法解析，未创建正式剧本版本。');
}

function codePointRef(rawText: string, quote: string, scriptVersionId: string) {
  const haystack = Array.from(rawText);
  const needle = Array.from(quote);
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((char, offset) => haystack[start + offset] === char)) {
      return { scriptVersionId, start, end: start + needle.length, quote };
    }
  }
  return null;
}

function firstRef(rawText: string, scriptVersionId: string) {
  const chars = Array.from(rawText);
  const quote = chars.slice(0, Math.min(chars.length, 200)).join('');
  return { scriptVersionId, start: 0, end: Math.max(1, quote.length), quote };
}

function sourced(value: string, ref: { scriptVersionId: string; start: number; end: number; quote: string }) {
  return { value, origin: 'source' as const, sourceRefs: [ref], answerIds: [] };
}

function spanRef(rawText: string, scriptVersionId: string, refs: Array<{ start: number; end: number }>) {
  if (refs.length === 0) return firstRef(rawText, scriptVersionId);
  const start = Math.min(...refs.map(ref => ref.start));
  const end = Math.max(...refs.map(ref => ref.end));
  const chars = Array.from(rawText);
  return { scriptVersionId, start, end, quote: chars.slice(start, end).join('') };
}

function factsCandidate(script: { id: string; rawText: string; structure: ScriptStructure | null }, characters: ScriptParseCharacter[],
  locationEntities: ScriptParseEntity[] = [], propEntities: ScriptParseEntity[] = [],
  dialogueExclusions: ScriptDialogueExclusion[] = []): CreateExtractFactsCandidateRequest {
  const structure = script.structure;
  const episode = structure?.episodes[0];
  if (!structure || !episode) {
    return { synopsis: null, characters: [], locations: [], props: [], scenes: [], dialogues: [], dialogueExclusions };
  }
  const characterTempIds = new Map<string, string>();
  const characterEntities = characters
    .map(character => character.name.trim())
    .filter(Boolean)
    .map((name, index) => {
      const tempId = `character_candidate_${index + 1}`;
      characterTempIds.set(name, tempId);
      const source = characters.find(character => character.name.trim() === name)!;
      const ref = codePointRef(script.rawText, name, script.id) ?? firstRef(script.rawText, script.id);
      return {
        tempId,
        name: sourced(name, ref),
        aliases: source.aliases.map(alias => alias.trim()).filter(Boolean)
          .map(alias => sourced(alias, codePointRef(script.rawText, alias, script.id) ?? ref)),
        description: source.description ? sourced(source.description, ref) : null,
        sourceRefs: [ref],
      };
    });

  const locationTempIds = new Map<string, string>();
  const locationInputs = [
    ...locationEntities,
    ...episode.scenes.map(scene => ({ name: scene.location, aliases: [] as string[], description: null })),
  ];
  const locations = locationInputs
    .map(location => ({ ...location, name: location.name.trim() }))
    .filter(location => location.name)
    .filter((location, index, all) => all.findIndex(item => item.name === location.name) === index)
    .map((location, index) => {
      const tempId = `location_candidate_${index + 1}`;
      locationTempIds.set(location.name, tempId);
      const ref = codePointRef(script.rawText, location.name, script.id) ?? firstRef(script.rawText, script.id);
      return {
        tempId,
        name: sourced(location.name, ref),
        aliases: location.aliases.map(alias => alias.trim()).filter(Boolean)
          .map(alias => sourced(alias, codePointRef(script.rawText, alias, script.id) ?? ref)),
        description: location.description ? sourced(location.description, ref) : null,
        sourceRefs: [ref],
      };
    });
  const props = propEntities
    .map(prop => ({ ...prop, name: prop.name.trim() }))
    .filter(prop => prop.name)
    .filter((prop, index, all) => all.findIndex(item => item.name === prop.name) === index)
    .map((prop, index) => {
      const ref = codePointRef(script.rawText, prop.name, script.id) ?? firstRef(script.rawText, script.id);
      return {
        tempId: `prop_candidate_${index + 1}`,
        name: sourced(prop.name, ref),
        aliases: prop.aliases.map(alias => alias.trim()).filter(Boolean)
          .map(alias => sourced(alias, codePointRef(script.rawText, alias, script.id) ?? ref)),
        description: prop.description ? sourced(prop.description, ref) : null,
        sourceRefs: [ref],
      };
    });

  const sceneElementRefs = episode.scenes.map(scene => scene.dialogues
    .map(element => codePointRef(script.rawText, element.content, script.id))
    .filter((ref): ref is NonNullable<ReturnType<typeof codePointRef>> => Boolean(ref)));
  const sceneLastEnds = sceneElementRefs.map(refs => refs.length ? Math.max(...refs.map(ref => ref.end)) : 0);
  const rawLength = Array.from(script.rawText).length;
  const sceneSpans = episode.scenes.map((_, sceneIndex) => {
    const start = sceneIndex === 0 ? 0 : (sceneLastEnds[sceneIndex - 1] ?? 0);
    const end = sceneIndex === episode.scenes.length - 1 ? rawLength : (sceneLastEnds[sceneIndex] ?? rawLength);
    const safeEnd = Math.max(start + 1, Math.min(rawLength, end));
    return { scriptVersionId: script.id, start, end: safeEnd,
      quote: Array.from(script.rawText).slice(start, safeEnd).join('') };
  });
  const scenes = episode.scenes.map((scene, sceneIndex) => {
    const elementRefs = sceneElementRefs[sceneIndex] ?? [];
    const title = scene.sceneHeading.trim() || scene.location.trim() || `第${sceneIndex + 1}场`;
    const titleRef = codePointRef(script.rawText, title, script.id)
      ?? codePointRef(script.rawText, scene.location, script.id)
      ?? elementRefs[0] ?? firstRef(script.rawText, script.id);
    const presentNames = scene.dialogues
      .map(element => element.characterName?.trim() ?? '')
      .filter(Boolean);
    const presentCharacterTempIds = presentNames
      .map(name => characterTempIds.get(name))
      .filter((id): id is string => Boolean(id))
      .filter((id, index, all) => all.indexOf(id) === index);
    const timeRef = scene.timeOfDay.trim() ? codePointRef(script.rawText, scene.timeOfDay.trim(), script.id) : null;
    return {
      tempId: `scene_candidate_${sceneIndex + 1}`,
      order: sceneIndex + 1,
      title: sourced(title, titleRef),
      locationTempId: locationTempIds.get(scene.location.trim()) ?? null,
      characterTempIds: presentCharacterTempIds,
      sourceRefs: [sceneSpans[sceneIndex]!],
      timeOfDay: scene.timeOfDay.trim() ? sourced(scene.timeOfDay.trim(), timeRef ?? titleRef) : null,
    };
  });

  const sceneTempIds = new Map<string, string>();
  episode.scenes.forEach((scene, index) => sceneTempIds.set(scene.id, `scene_candidate_${index + 1}`));
  const dialogues = episode.scenes.flatMap(scene => {
    const sceneTempId = sceneTempIds.get(scene.id)!;
    return scene.dialogues
      .filter(element => element.type === 1)
      .map((element, index) => {
        const ref = codePointRef(script.rawText, element.content, script.id);
        if (!ref) return null;
        const speaker = element.characterName?.trim() ?? '';
        const speakerTempId = speaker ? characterTempIds.get(speaker) ?? null : null;
        const speakerRef = speaker ? codePointRef(script.rawText, speaker, script.id) : null;
        return {
          tempId: `dialogue_candidate_${scene.id}_${index + 1}`,
          sceneTempId,
          speakerTempId,
          speakerSourceRefs: speakerTempId && speakerRef ? [speakerRef] : [],
          speakerAnswerIds: [],
          sourceRef: ref,
        };
      })
      .filter((dialogue): dialogue is NonNullable<typeof dialogue> => Boolean(dialogue));
  });

  const synopsisValue = episode.synopsis.trim();
  const synopsisRef = (synopsisValue ? codePointRef(script.rawText, synopsisValue, script.id) : null)
    ?? (episode.scenes[0]?.dialogues[0] ? codePointRef(script.rawText, episode.scenes[0].dialogues[0].content, script.id) : null)
    ?? firstRef(script.rawText, script.id);
  return {
    synopsis: sourced(synopsisValue || synopsisRef.quote, synopsisRef),
    characters: characterEntities,
    locations,
    props,
    scenes,
    dialogues,
    dialogueExclusions,
  };
}
