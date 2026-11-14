import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { Type, type Static } from '@sinclair/typebox';
import type { ScriptDialogueExclusion, ScriptParseAttempt, ScriptParseCharacter, ScriptParseEntity, ScriptParseResult } from '@lyra/shared';
import { ModelError, SCRIPT_DIALOGUE_REPAIR_PROMPT_VERSION, SCRIPT_PARSE_PROMPT_VERSION } from '@lyra/shared';
import {
  isNarrationCharacterName,
  planEpisodeEntityCandidates,
  repairModelJsonPayload,
  renameEntityInEpisode,
  type EpisodeParseResponse,
  type ExistingEntityMatch,
  type ParsedEntityInput,
  type ScriptEntityKind,
} from '@lyra/shared';
import { parseScriptStructure, serializeScriptStructure, validateScriptStructure, type ScriptElementType, type ScriptEpisode, type ScriptStructure } from '@lyra/shared';
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

/** 解析输入按集裁剪：未指定集时沿用整本原文（历史行为），指定集时只序列化该集。 */
export function resolveEpisodeParseInput(script: StoredScriptVersion, episodeId?: string): {
  text: string; episode: { id: string; episodeNumber: number } | null;
} {
  if (episodeId === undefined) return { text: script.rawText, episode: null };
  const episode = script.structure?.episodes.find(item => item.id === episodeId);
  if (!episode || !script.structure) {
    throw new BreakdownError(409, 'SCRIPT_EPISODE_NOT_FOUND', '找不到要解析的集，请刷新后重新选择。');
  }
  const text = serializeScriptStructure({ ...script.structure, episodes: [episode] });
  if (!text.trim()) throw new BreakdownError(409, 'SCRIPT_EPISODE_EMPTY', '该集原文为空，请先保存该集原文。');
  return { text, episode: { id: episode.id, episodeNumber: episode.episodeNumber } };
}

/** 按集号定位目标集：结构缺失时从原文临时解析，只把该集文本送给模型。 */
export function resolveEpisodeParseInputByNumber(script: StoredScriptVersion, episodeNumber: number): {
  text: string; episode: { id: string; episodeNumber: number };
} {
  const structure = script.structure ?? parseScriptStructure(script.rawText);
  const episode = structure.episodes.find(item => item.episodeNumber === episodeNumber);
  if (!episode) throw new BreakdownError(409, 'SCRIPT_EPISODE_NOT_FOUND', '找不到要解析的集，请刷新后重新选择。');
  const text = serializeScriptStructure({ ...structure, episodes: [episode] });
  if (!text.trim()) throw new BreakdownError(409, 'SCRIPT_EPISODE_EMPTY', '该集原文为空，请先保存该集原文。');
  return { text, episode: { id: episode.id, episodeNumber: episode.episodeNumber } };
}

export { SCRIPT_PARSE_PROMPT_VERSION };
export const SCRIPT_PARSE_VALIDATOR_VERSION = 'script-parse-validator/1';

const entitySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 160 }),
  aliases: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 32 }),
  description: Type.Union([Type.Null(), Type.String({ maxLength: 2000 })]),
  role: Type.Optional(Type.Union([Type.Literal('protagonist'), Type.Literal('supporting'), Type.Literal('background')])),
  confidence: Type.Optional(Type.Union([Type.Null(), Type.Number({ minimum: 0, maximum: 1 })])),
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
{"title":"第1集","synopsis":"一句话剧情梗概","characters":[{"name":"人物名","aliases":["别名"],"description":"简短人物说明","role":"protagonist|supporting|background","confidence":0.8}],"locations":[{"name":"地点名","aliases":["别名"],"description":"简短地点说明","role":"supporting","confidence":0.7}],"props":[{"name":"道具名","aliases":["别名"],"description":"简短道具说明","role":"background","confidence":0.5}],"scenes":[{"sceneHeading":"场次标题","location":"地点","timeOfDay":"日/夜/黄昏等","intExt":"内/外/内/外/空","sceneDescription":"本场整体描述","elements":[{"type":1,"characterName":"说话人","parenthetical":"语气提示，可空","content":"台词或文本"}]}]}
规则：
- 元素 type：1=对白，2=动作，3=旁白，4=镜头/特写/运镜，5=环境/氛围。
- 必须保留原文事实与语句，不得新增情节、人物或对白；可以写简短的场次标题和地点，但元素 content 不得改写。
- 每场至少 1 个元素；对白尽量识别说话人并写入 characterName；旁白也可以带说话人，但“旁白”只是叙事标签，不是人物，不得放入 characters。
- characters 必须列出文本中出现的所有有名字人物（包含只被提到的人）；aliases 可为空；不要编造人物。
- 每个实体必须给 role：protagonist=主角，supporting=配角，background=路人；confidence 取 0..1 的数字，把握不足时给低分，不要把主角或主要配角标成 background。
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
  const characters = normalizeEntities(raw.characters).filter(item => !isNarrationCharacterName(item.name));
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
      ...(entity.role ? { role: entity.role } : {}),
      confidence: typeof entity.confidence === 'number' ? entity.confidence : null,
    });
  }
  return entities;
}

/** 资产库只读端口：确认环节按同名/别名复用既有资产 ID，服务端不回写既有资产字段。 */
export interface ScriptEntityAssetPort {
  list(): Promise<Array<{ id: string; kind: string; name: string; description: string | null }>>;
}

/** 把解析结果作为预览返回，不创建剧本版本；确认保存由用户显式触发。 */
export class ScriptParseService {
  constructor(private readonly database: PostgresDatabase, private readonly breakdown: BreakdownService,
    private readonly config: AppConfig, private readonly transport: typeof fetch = fetch,
    private readonly assets: ScriptEntityAssetPort | null = null) {}

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

  async parse(projectId: string, scriptVersionId: string | undefined, expectedModelConnectionRevision?: string, episodeId?: string): Promise<ScriptParseResult & {
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
    // 按集解析：模型只接收目标集文本，集信息随记录保存，前端据此前嵌回整本做差异。
    const target = resolveEpisodeParseInput(script, episodeId);
    const inputDigest = canonicalJsonSha256({ scriptVersionId: script.id, rawText: target.text,
      episodeId: target.episode?.id ?? null, promptVersion: SCRIPT_PARSE_PROMPT_VERSION });
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
          { role: 'user', content: target.text },
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
      const output = target.episode ? { ...result, episode: target.episode } : result;
      await this.database.query(`UPDATE script_parse_attempts SET status='succeeded', output_json=$2::jsonb,
        provider_request_id=$3, usage_json=$4::jsonb, ended_at=now() WHERE id=$1`,
      [attemptId, JSON.stringify(output),
        response.providerRequestId, JSON.stringify(response.usage)]);
      return { ...output, attemptId, model: config.defaultModel, promptVersion: SCRIPT_PARSE_PROMPT_VERSION, usage: response.usage };
    } catch (error) {
      await this.database.query(`UPDATE script_parse_attempts SET status='failed', error_code=$2,
        provider_request_id=$3, usage_json=$4::jsonb, ended_at=now() WHERE id=$1 AND status='running'`,
      [attemptId, error instanceof BreakdownError || error instanceof ModelError ? error.code : 'SCRIPT_PARSE_MODEL_FAILED',
        response?.providerRequestId ?? null, response ? JSON.stringify(response.usage) : null]);
      if (error instanceof BreakdownError || error instanceof ModelError) throw error;
      throw new BreakdownError(502, 'SCRIPT_PARSE_MODEL_FAILED', '剧本解析模型调用失败，请检查模型连接后重试。');
    }
  }

  private async listExistingMatches(): Promise<ExistingEntityMatch[]> {
    if (!this.assets) return [];
    try {
      const assets = await this.assets.list();
      return assets
        .filter(asset => asset.kind === 'character' || asset.kind === 'location' || asset.kind === 'prop')
        .map(asset => ({ id: asset.id, kind: asset.kind as ScriptEntityKind, name: asset.name, aliases: [] }));
    } catch {
      return [];
    }
  }

  /**
   * 单集增量解析：只解析目标集的原文与五类元素，不影响其他集。
   * 模型输入来自弹窗传入的 rawText；已保存版本只提供目标集元数据、覆盖检查与审计锚点。
   * commandId 是幂等键：重复命令在配置/覆盖检查之前回放历史结果，不会再次调用付费模型。
   */
  async parseEpisode(projectId: string, input: {
    episodeNumber: number;
    rawText: string;
    commandId: string;
    overwriteConfirmed: boolean;
    allowPaid: boolean;
    expectedModelConnectionRevision?: string;
    scriptVersionId?: string;
  }): Promise<EpisodeParseResponse> {
    if (input.allowPaid !== true) {
      throw new BreakdownError(400, 'PAID_CALL_NOT_AUTHORIZED', 'AI 解析前须明确传入 allowPaid: true。');
    }
    const pastedText = input.rawText.trim();
    if (!pastedText) throw new BreakdownError(400, 'INVALID_SCRIPT_RAW_TEXT', '待解析原文不能为空。');
    if (Array.from(pastedText).length > 20_000) {
      throw new BreakdownError(400, 'INVALID_SCRIPT_RAW_TEXT', '待解析原文超出单集长度上限，请拆分后重试。');
    }
    const project = await this.breakdown.getProject(projectId);
    const versionId = input.scriptVersionId ?? project.currentScriptVersionId;
    if (!versionId) throw new BreakdownError(409, 'SCRIPT_VERSION_REQUIRED', '请先保存原文，再进行 AI 解析。');
    const script = await this.breakdown.getScriptVersion(projectId, versionId);

    // 幂等回放前置：同一 commandId 的成功记录直接返回，不做模型配置判定或覆盖检查。
    const prior = await this.database.query(`SELECT id, status, output_json, error_code, model, prompt_version, usage_json
      FROM script_parse_attempts WHERE project_id=$1 AND command_id=$2 ORDER BY created_at DESC LIMIT 1`,
    [projectId, input.commandId]);
    const priorRow = prior.rows[0] as Record<string, unknown> | undefined;
    if (priorRow) {
      if (priorRow.status === 'running') {
        throw new BreakdownError(409, 'SCRIPT_PARSE_COMMAND_IN_FLIGHT', '相同命令正在解析中，请稍后查看结果。');
      }
      if (priorRow.status === 'failed') {
        throw new BreakdownError(409, 'SCRIPT_PARSE_COMMAND_FAILED',
          '相同命令此前已失败，未再次调用模型；请更换 commandId 后重试。');
      }
      const output = priorRow.output_json as (EpisodeParseResponse & { commandId?: string }) | null;
      if (output) {
        return {
          episodeNumber: output.episodeNumber, commandId: input.commandId, attemptId: priorRow.id as string,
          model: priorRow.model as string, promptVersion: priorRow.prompt_version as string,
          usage: (priorRow.usage_json as Record<string, unknown> | null) ?? null,
          structure: output.structure, characters: output.characters.filter(item => !isNarrationCharacterName(item.name)), locations: output.locations,
          props: output.props, reused: true,
        };
      }
    }

    const config = configForRole(this.config, 'breakdown');
    assertModelSelection(config, input.expectedModelConnectionRevision);
    const model = new ModelClient(config, this.transport);
    model.assertConfigured();

    const target = resolveEpisodeParseInputByNumber(script, input.episodeNumber);
    const baseStructure = script.structure ?? parseScriptStructure(script.rawText);
    const baseEpisode = baseStructure.episodes.find(item => item.id === target.episode.id);
    // 只要目标集已存在场次（含空场），覆盖解析前就必须显式确认。
    if (baseEpisode && baseEpisode.scenes.length > 0 && input.overwriteConfirmed !== true) {
      throw new BreakdownError(409, 'SCRIPT_EPISODE_OVERWRITE_CONFIRM_REQUIRED',
        '该集已有场次，覆盖解析前须显式确认 overwriteConfirmed: true。');
    }

    const inputDigest = canonicalJsonSha256({
      scriptVersionId: script.id, episodeNumber: target.episode.episodeNumber,
      rawText: pastedText, commandId: input.commandId, promptVersion: SCRIPT_PARSE_PROMPT_VERSION,
    });
    const attemptId = `scriptparse_${randomUUID().replaceAll('-', '')}`;
    await this.database.query(`INSERT INTO script_parse_attempts
      (id, project_id, script_version_id, model, prompt_version, input_digest, command_id, status, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'running',now())`,
    [attemptId, projectId, script.id, config.defaultModel, SCRIPT_PARSE_PROMPT_VERSION, inputDigest, input.commandId]);

    let response: Awaited<ReturnType<ModelClient['call']>> | null = null;
    try {
      response = await model.call({
        model: config.defaultModel,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: pastedText },
        ],
        ...(config.reasoningEffort !== 'model-default' ? { reasoningEffort: config.reasoningEffort } : {}),
        maxOutputTokens: config.maxOutputTokens,
        allowPaid: true,
        thinking: 'disabled',
        jsonOutput: true,
      });
      if (response.status !== 'completed') {
        throw new BreakdownError(422, 'SCRIPT_PARSE_OUTPUT_INCOMPLETE', '模型解析输出被截断，请缩短原文后重试。');
      }
      const repaired = repairModelJsonPayload(response.text.trim());
      if (!repaired.ok) {
        const code = repaired.reason === 'UNREPAIRABLE_JSON'
          ? 'SCRIPT_PARSE_OUTPUT_UNREPAIRABLE' : 'SCRIPT_PARSE_OUTPUT_NOT_JSON';
        const message = repaired.reason === 'UNREPAIRABLE_JSON'
          ? '模型 JSON 输出截断后仍无法安全修复，请缩短原文后重试。'
          : '模型没有返回有效 JSON 解析结果。';
        throw new BreakdownError(422, code, message);
      }
      if (!validateRaw(repaired.value)) {
        throw new BreakdownError(422, 'SCRIPT_PARSE_OUTPUT_INVALID', '模型解析结果不符合剧本结构约定。');
      }
      const result = normalize(repaired.value as RawParse);
      const episodeNumber = target.episode.episodeNumber;
      const episode = result.structure.episodes[0]!;
      episode.episodeNumber = episodeNumber;
      episode.id = target.episode.id;
      // 提示词示例和 normalize 骨架都可能留下“第1集”；通用集号标题必须服从目标集，
      // 但模型返回的自定义剧名（如“江岸重逢”）仍原样保留。
      if (!episode.title.trim() || /^第\s*\d+\s*集$/.test(episode.title.trim())) {
        episode.title = `第${episodeNumber}集`;
      }
      // normalize 只产出第 1 集骨架；按目标集重排集号、场次编号与稳定 ID，
      // 避免第 N 集草稿沿用 1-1 编号或与既有场次 ID 冲突。
      episode.scenes.forEach((scene, sceneIndex) => {
        scene.id = `scene_${episodeNumber}_${sceneIndex + 1}`;
        scene.sceneNumber = `${episodeNumber}-${sceneIndex + 1}`;
        scene.dialogues.forEach((element, elementIndex) => {
          element.id = `element_${episodeNumber}_${sceneIndex + 1}_${elementIndex + 1}`;
        });
      });
      validateScriptStructure(result.structure);

      const existing = await this.listExistingMatches();
      const allEntities: ParsedEntityInput[] = [
        ...result.characters.map(item => ({ kind: 'character' as ScriptEntityKind, name: item.name, aliases: item.aliases, description: item.description, role: item.role, confidence: item.confidence })),
        ...result.locations.map(item => ({ kind: 'location' as ScriptEntityKind, name: item.name, aliases: item.aliases, description: item.description, role: item.role, confidence: item.confidence })),
        ...result.props.map(item => ({ kind: 'prop' as ScriptEntityKind, name: item.name, aliases: item.aliases, description: item.description, role: item.role, confidence: item.confidence })),
      ];
      const candidates = planEpisodeEntityCandidates(result.structure, allEntities, existing);
      const byKind = (kind: ScriptEntityKind) => candidates.filter(item => item.kind === kind);

      const output = {
        ...result,
        episode: target.episode,
        commandId: input.commandId,
        characters: byKind('character'),
        locations: byKind('location'),
        props: byKind('prop'),
      };
      await this.database.query(`UPDATE script_parse_attempts SET status='succeeded', output_json=$2::jsonb,
        provider_request_id=$3, usage_json=$4::jsonb, ended_at=now() WHERE id=$1`,
      [attemptId, JSON.stringify(output), response.providerRequestId, JSON.stringify(response.usage)]);
      return {
        episodeNumber: target.episode.episodeNumber, commandId: input.commandId, attemptId,
        model: config.defaultModel, promptVersion: SCRIPT_PARSE_PROMPT_VERSION, usage: response.usage,
        structure: result.structure, characters: byKind('character'), locations: byKind('location'),
        props: byKind('prop'), reused: false,
      };
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
    if (characters.some(item => isNarrationCharacterName(item.name))) {
      throw new BreakdownError(422, 'SCRIPT_NARRATION_CHARACTER_INVALID', '旁白是叙事标签，不能保存为人物资产。');
    }
    const script = await this.breakdown.getScriptVersion(projectId, scriptVersionId);
    if (characters.length + locationEntities.length + props.length === 0) {
      throw new BreakdownError(400, 'SCRIPT_PARSE_CHARACTERS_REQUIRED', '至少保留一个人物、地点或道具。');
    }
    const episode = script.structure?.episodes[0] ?? null;
    const run = await this.breakdown.createDraftRun(projectId, {
      scriptVersionId: script.id, requirements: {}, maxModelCalls: 1, maxOutputTokens: 4096,
    });
    const candidate = factsCandidate(script, episode, characters, locationEntities, props, dialogueExclusions);
    return this.breakdown.createExtractFactsCandidate(run.id, candidate);
  }

  /**
   * 从当前不可变剧本恢复项目级事实候选，不调用模型，也不创建新剧本版本。
   * 分集解析只保存目标集；这里把全部分集合回同一候选，避免采用后只有最后一集可关联资产。
   * 候选仍须通过既有完整性检查，并由用户明确采用，不能在这里直接写 activePlanRevisionId。
   */
  async rebuildCurrentFactPlan(projectId: string) {
    const project = await this.breakdown.getProject(projectId);
    if (!project.currentScriptVersionId) {
      throw new BreakdownError(409, 'SCRIPT_VERSION_REQUIRED', '请先保存剧本，再重建资产事实。');
    }
    const script = await this.breakdown.getScriptVersion(projectId, project.currentScriptVersionId);
    const structure = script.structure ?? parseScriptStructure(script.rawText);
    if (structure.episodes.length === 0) {
      throw new BreakdownError(409, 'SCRIPT_EPISODE_NOT_FOUND', '当前剧本没有分集，无法重建资产事实。');
    }
    const existing = await this.listExistingMatches();
    const candidates = structure.episodes.map(episode => {
      const episodeText = serializeScriptStructure({ ...structure, episodes: [episode] });
      const names = [...new Set(episode.scenes.flatMap(scene => scene.dialogues
        .map(element => element.characterName?.trim() ?? '').filter(name => name && name !== '旁白')))];
      const characters = names.map(name => ({ name, aliases: [] as string[], description: null }));
      // 道具没有独立的结构字段，只恢复在当前集原文中有直接证据的既有资产；不猜测新道具。
      const props = existing.filter(item => item.kind === 'prop' && episodeText.includes(item.name))
        .map(item => ({ name: item.name, aliases: [] as string[], description: null }));
      return factsCandidate(script, episode, characters, [], props);
    });
    const run = await this.breakdown.createDraftRun(projectId, {
      scriptVersionId: script.id, requirements: {}, maxModelCalls: 1, maxOutputTokens: 4096,
    });
    const plan = await this.breakdown.createExtractFactsCandidate(run.id, mergeFactsCandidates(candidates));
    const check = await this.breakdown.checkPlan(plan.id);
    return { scriptVersion: script, plan, check, reusedAssets: [] };
  }

  /**
   * 候选确认入库入口：
   *  - 草稿来自服务端持久化的成功解析 attempt（不接受客户端直接上传结构）；
   *  - 只有被勾选的角色/场景/道具进入事实候选，不直接写正式资产库；
   *  - 同名/别名命中既有资产时复用既有 ID，不覆盖名称、定妆照、设定或其他字段；
   *  - 改名在目标集内级联同步对白 speaker 与场次地点（既有资产本身不改写）；
   *  - 经正式保存链生成新的不可变 script_versions.structure_json，再跑既有完整性校验；
   *  - 允许 0 勾选：仍保存解析场次并创建空实体候选跑完整性校验，不跳过校验。
   */
  async confirmEpisodeEntities(projectId: string, input: {
    scriptVersionId: string;
    attemptId: string;
    episodeNumber: number;
    selections: Array<{
      candidateId: string;
      kind: ScriptEntityKind;
      name: string;
      aliases: string[];
      description: string | null;
      selected: boolean;
      renameTo?: string | null;
    }>;
  }) {
    const script = await this.breakdown.getScriptVersion(projectId, input.scriptVersionId);

    const attemptRows = await this.database.query(
      `SELECT id, project_id, script_version_id, status, output_json
       FROM script_parse_attempts WHERE id=$1 AND project_id=$2`,
      [input.attemptId, projectId]);
    const attempt = attemptRows.rows[0] as Record<string, unknown> | undefined;
    if (!attempt) throw new BreakdownError(409, 'SCRIPT_PARSE_ATTEMPT_NOT_FOUND', '找不到对应的解析记录。');
    if (attempt.status !== 'succeeded') {
      throw new BreakdownError(409, 'SCRIPT_PARSE_ATTEMPT_NOT_READY', '解析记录尚未成功，不能确认。');
    }
    if (attempt.script_version_id !== script.id) {
      throw new BreakdownError(409, 'SCRIPT_PARSE_ATTEMPT_VERSION_MISMATCH', '解析记录不属于当前剧本版本。');
    }
    const attemptOutput = attempt.output_json as (EpisodeParseResponse & {
      episode?: { id: string; episodeNumber: number };
    }) | null;
    if (attemptOutput?.episode && attemptOutput.episode.episodeNumber !== input.episodeNumber) {
      throw new BreakdownError(409, 'SCRIPT_PARSE_ATTEMPT_EPISODE_MISMATCH', '解析草稿不属于目标集。');
    }
    const draftEpisode = attemptOutput?.structure?.episodes
      .find(item => item.episodeNumber === input.episodeNumber);
    if (!draftEpisode) {
      throw new BreakdownError(409, 'SCRIPT_PARSE_ATTEMPT_EPISODE_MISMATCH', '解析草稿不包含目标集。');
    }
    // 只允许引用本次 attempt 产出的候选；客户端不能凭空提交候选 ID。
    const knownCandidateIds = new Set([
      ...(attemptOutput?.characters ?? []), ...(attemptOutput?.locations ?? []), ...(attemptOutput?.props ?? []),
    ].map(item => item.candidateId));
    for (const item of input.selections) {
      if (item.selected && !knownCandidateIds.has(item.candidateId)) {
        throw new BreakdownError(409, 'SCRIPT_PARSE_CANDIDATE_UNKNOWN', '候选不属于本次解析记录，请重新解析后再确认。');
      }
    }

    // 用草稿目标集替换 base structure 对应集，其他集原样保留；结构重新走校验。
    const baseStructure = script.structure ?? parseScriptStructure(script.rawText);
    const merged = structuredClone(baseStructure) as ScriptStructure;
    const baseIndex = merged.episodes.findIndex(item => item.episodeNumber === input.episodeNumber);
    const draftClone = structuredClone(draftEpisode) as ScriptEpisode;
    if (baseIndex >= 0) merged.episodes[baseIndex] = draftClone;
    else merged.episodes.push(draftClone);
    let workingStructure = validateScriptStructure(merged);

    const selected = input.selections.filter(item => item.selected);
    const existing = await this.listExistingMatches();
    const reusedAssets: Array<{ kind: ScriptEntityKind; name: string; existingAssetId: string | null }> = [];
    const byKind: Record<ScriptEntityKind, ScriptParseEntity[]> = { character: [], location: [], prop: [] };

    for (const item of selected) {
      const renameTo = (item.renameTo ?? '').trim();
      const finalName = renameTo || item.name.trim();
      if (item.kind === 'character' && isNarrationCharacterName(finalName)) {
        throw new BreakdownError(422, 'SCRIPT_NARRATION_CHARACTER_INVALID', '旁白是叙事标签，不能保存为人物资产。');
      }
      const normalizedNames = new Set([item.name, ...item.aliases]
        .map(name => name.replace(/\s+/g, '').toLowerCase()).filter(Boolean));
      const match = existing.find(entry => entry.kind === item.kind
        && [entry.name, ...(entry.aliases ?? [])].some(name => normalizedNames.has(name.replace(/\s+/g, '').toLowerCase())));
      reusedAssets.push({ kind: item.kind, name: item.name, existingAssetId: match?.id ?? null });

      byKind[item.kind].push({ name: finalName, aliases: item.aliases.map(alias => alias.trim()), description: item.description });

      // 既有资产只复用 ID、不改写其名称/设定/素材；当前集结构引用仍按 renameTo 级联更新。
      if (!renameTo || renameTo === item.name.trim() || item.kind === 'prop') continue;
      workingStructure = renameEntityInEpisode(workingStructure, input.episodeNumber, item.kind,
        { name: item.name, aliases: item.aliases }, renameTo);
    }

    // 正式保存链：新版本不可变，rawText 由结构派生；不原地改写旧版本。
    const rawText = serializeScriptStructure(workingStructure);
    const saved = await this.breakdown.createScriptVersion(projectId, { rawText, structure: workingStructure });
    const savedEpisode = saved.structure?.episodes.find(entry => entry.episodeNumber === input.episodeNumber) ?? null;

    const run = await this.breakdown.createDraftRun(projectId, {
      scriptVersionId: saved.id, requirements: {}, maxModelCalls: 1, maxOutputTokens: 4096,
    });
    const candidate = factsCandidate(saved, savedEpisode, byKind.character, byKind.location, byKind.prop, []);
    const plan = await this.breakdown.createExtractFactsCandidate(run.id, candidate);
    const check = await this.breakdown.checkPlan(plan.id);
    return { scriptVersion: saved, plan, check, reusedAssets };
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

function codePointRef(rawText: string, quote: string, scriptVersionId: string, rangeStart = 0, rangeEnd?: number) {
  const haystack = Array.from(rawText);
  const needle = Array.from(quote);
  const end = Math.min(rangeEnd ?? haystack.length, haystack.length);
  for (let start = Math.max(0, rangeStart); start + needle.length <= end; start++) {
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

function factsCandidate(script: { id: string; rawText: string; structure: ScriptStructure | null },
  episode: ScriptEpisode | null, characters: ScriptParseCharacter[],
  locationEntities: ScriptParseEntity[] = [], propEntities: ScriptParseEntity[] = [],
  dialogueExclusions: ScriptDialogueExclusion[] = []): CreateExtractFactsCandidateRequest {
  if (!script.structure || !episode) {
    return { synopsis: null, characters: [], locations: [], props: [], scenes: [], dialogues: [], dialogueExclusions };
  }
  // 保存版本的 rawText 由完整结构序列化，因此目标集也能在整本原文中精确定位。
  // 所有证据都必须落在该集范围内；相同对白出现在其他集时不能引用前面的同名文本。
  const rawChars = Array.from(script.rawText);
  const episodeText = serializeScriptStructure({ ...script.structure, episodes: [episode] });
  const episodeIndex = script.rawText.indexOf(episodeText);
  const episodeStart = episodeIndex < 0 ? 0 : Array.from(script.rawText.slice(0, episodeIndex)).length;
  const episodeEnd = episodeIndex < 0 ? rawChars.length : episodeStart + Array.from(episodeText).length;
  const episodeRef = (quote: string, searchStart = episodeStart) =>
    codePointRef(script.rawText, quote, script.id, searchStart, episodeEnd);
  const episodeFirstRef = () => episodeRef(Array.from(episodeText).slice(0, 200).join(''))
    ?? firstRef(script.rawText, script.id);
  const characterTempIds = new Map<string, string>();
  const characterEntities = characters
    .map(character => character.name.trim())
    .filter(Boolean)
    .map((name, index) => {
      const tempId = `character_candidate_${index + 1}`;
      characterTempIds.set(name, tempId);
      const source = characters.find(character => character.name.trim() === name)!;
      const ref = episodeRef(name) ?? episodeFirstRef();
      return {
        tempId,
        name: sourced(name, ref),
        aliases: source.aliases.map(alias => alias.trim()).filter(Boolean)
          .map(alias => sourced(alias, episodeRef(alias) ?? ref)),
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
      const ref = episodeRef(location.name) ?? episodeFirstRef();
      return {
        tempId,
        name: sourced(location.name, ref),
        aliases: location.aliases.map(alias => alias.trim()).filter(Boolean)
          .map(alias => sourced(alias, episodeRef(alias) ?? ref)),
        description: location.description ? sourced(location.description, ref) : null,
        sourceRefs: [ref],
      };
    });
  const props = propEntities
    .map(prop => ({ ...prop, name: prop.name.trim() }))
    .filter(prop => prop.name)
    .filter((prop, index, all) => all.findIndex(item => item.name === prop.name) === index)
    .map((prop, index) => {
      const ref = episodeRef(prop.name) ?? episodeFirstRef();
      return {
        tempId: `prop_candidate_${index + 1}`,
        name: sourced(prop.name, ref),
        aliases: prop.aliases.map(alias => alias.trim()).filter(Boolean)
          .map(alias => sourced(alias, episodeRef(alias) ?? ref)),
        description: prop.description ? sourced(prop.description, ref) : null,
        sourceRefs: [ref],
      };
    });

  // 同集不同场次也可能重复同一句台词，按元素顺序推进游标并保存逐元素引用。
  let sceneCursor = episodeStart;
  const sceneSearchEnds: number[] = [];
  const elementRefById = new Map<string, NonNullable<ReturnType<typeof codePointRef>>>();
  const sceneElementRefs = episode.scenes.map(scene => {
    const refs = scene.dialogues.map(element => {
      const ref = episodeRef(element.content, sceneCursor);
      if (ref) {
        elementRefById.set(element.id, ref);
        sceneCursor = ref.end;
      }
      return ref;
    }).filter((ref): ref is NonNullable<ReturnType<typeof codePointRef>> => Boolean(ref));
    sceneSearchEnds.push(sceneCursor);
    return refs;
  });
  const sceneSpans = episode.scenes.map((_, sceneIndex) => {
    const start = sceneIndex === 0 ? episodeStart : (sceneSearchEnds[sceneIndex - 1] ?? episodeStart);
    const end = sceneIndex === episode.scenes.length - 1 ? episodeEnd : (sceneSearchEnds[sceneIndex] ?? episodeEnd);
    const safeEnd = Math.min(episodeEnd, Math.max(start + 1, end));
    return { scriptVersionId: script.id, start, end: safeEnd,
      quote: rawChars.slice(start, safeEnd).join('') };
  });
  const scenes = episode.scenes.map((scene, sceneIndex) => {
    const elementRefs = sceneElementRefs[sceneIndex] ?? [];
    const title = scene.sceneHeading.trim() || scene.location.trim() || `第${sceneIndex + 1}场`;
    const titleRef = episodeRef(title)
      ?? episodeRef(scene.location)
      ?? elementRefs[0] ?? episodeFirstRef();
    const presentNames = scene.dialogues
      .map(element => element.characterName?.trim() ?? '')
      .filter(Boolean);
    const presentCharacterTempIds = presentNames
      .map(name => characterTempIds.get(name))
      .filter((id): id is string => Boolean(id))
      .filter((id, index, all) => all.indexOf(id) === index);
    const timeRef = scene.timeOfDay.trim() ? episodeRef(scene.timeOfDay.trim()) : null;
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
        const ref = elementRefById.get(element.id) ?? null;
        if (!ref) return null;
        const speaker = element.characterName?.trim() ?? '';
        const speakerTempId = speaker ? characterTempIds.get(speaker) ?? null : null;
        const speakerRef = speaker ? episodeRef(speaker) : null;
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
  const synopsisRef = (synopsisValue ? episodeRef(synopsisValue) : null)
    ?? (episode.scenes[0]?.dialogues[0]
      ? elementRefById.get(episode.scenes[0].dialogues[0].id) ?? episodeRef(episode.scenes[0].dialogues[0].content)
      : null)
    ?? episodeFirstRef();
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

/** 合并单集证据候选，同时重映射临时 ID；事实内容不跨集拼接，也不复用旧剧本版本证据。 */
function mergeFactsCandidates(candidates: CreateExtractFactsCandidateRequest[]): CreateExtractFactsCandidateRequest {
  const merged: CreateExtractFactsCandidateRequest = {
    synopsis: candidates.find(candidate => candidate.synopsis !== null)?.synopsis ?? null,
    characters: [], locations: [], props: [], scenes: [], dialogues: [], dialogueExclusions: [],
  };
  const mergeEntities = <T extends { tempId: string; name: { value: string } }>(
    target: T[], entities: T[], prefix: string,
  ) => {
    const byName = new Map(target.map(entity => [entity.name.value.trim(), entity.tempId]));
    const idMap = new Map<string, string>();
    for (const entity of entities) {
      const key = entity.name.value.trim();
      let tempId = byName.get(key);
      if (!tempId) {
        tempId = `${prefix}_${target.length + 1}`;
        target.push({ ...entity, tempId });
        byName.set(key, tempId);
      }
      idMap.set(entity.tempId, tempId);
    }
    return idMap;
  };
  for (const candidate of candidates) {
    const characterIds = mergeEntities(merged.characters, candidate.characters, 'character_candidate');
    const locationIds = mergeEntities(merged.locations, candidate.locations, 'location_candidate');
    mergeEntities(merged.props, candidate.props, 'prop_candidate');
    const sceneIds = new Map<string, string>();
    for (const scene of candidate.scenes) {
      const tempId = `scene_candidate_${merged.scenes.length + 1}`;
      sceneIds.set(scene.tempId, tempId);
      merged.scenes.push({
        ...scene, tempId, order: merged.scenes.length + 1,
        locationTempId: scene.locationTempId ? locationIds.get(scene.locationTempId) ?? null : null,
        characterTempIds: [...new Set(scene.characterTempIds.map(id => characterIds.get(id)).filter((id): id is string => Boolean(id)))],
      });
    }
    for (const dialogue of candidate.dialogues) {
      const sceneTempId = sceneIds.get(dialogue.sceneTempId);
      if (!sceneTempId) throw new BreakdownError(500, 'SCRIPT_FACT_REBUILD_INVALID', '分集事实合并时找不到所属场次。');
      merged.dialogues.push({
        ...dialogue, tempId: `dialogue_candidate_${merged.dialogues.length + 1}`, sceneTempId,
        speakerTempId: dialogue.speakerTempId ? characterIds.get(dialogue.speakerTempId) ?? null : null,
      });
    }
    merged.dialogueExclusions?.push(...(candidate.dialogueExclusions ?? []));
  }
  return merged;
}
