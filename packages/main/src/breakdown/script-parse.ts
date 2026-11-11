import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { Type, type Static } from '@sinclair/typebox';
import type { ScriptParseCharacter, ScriptParseResult } from '@lyra/shared';
import { SCRIPT_PARSE_PROMPT_VERSION } from '@lyra/shared';
import { validateScriptStructure, type ScriptElementType, type ScriptStructure } from '@lyra/shared';
import type { AppConfig } from '../config';
import { assertModelSelection, configForRole } from '../models/connections';
import { ModelClient } from '../models/client';
import type { PostgresDatabase } from '../db/client';
import { BreakdownError } from './errors';
import type { BreakdownService } from './service';
import { canonicalJsonSha256 } from './service';
import type { CreateExtractFactsCandidateRequest } from './plan';

export { SCRIPT_PARSE_PROMPT_VERSION };
export const SCRIPT_PARSE_VALIDATOR_VERSION = 'script-parse-validator/1';

const characterSchema = Type.Object({
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
  characters: Type.Array(characterSchema, { maxItems: 200 }),
  scenes: Type.Array(sceneSchema, { minItems: 1, maxItems: 500 }),
}, { additionalProperties: false });
type RawParse = Static<typeof rawSchema>;
const validateRaw = new Ajv({ allErrors: false }).compile<RawParse>(rawSchema);

const SYSTEM_PROMPT = `你是中文短剧剧本结构解析器。输入是用户提供的一整段中文故事或剧本，没有任何分集、场次标题或编号。
请把它解析为恰好 1 集，并按地点、时间、连续动作或对话单元自动分场。只返回 JSON，不输出 Markdown。
输出结构：
{"title":"第1集","synopsis":"一句话剧情梗概","characters":[{"name":"人物名","aliases":["别名"],"description":"简短人物说明"}],"scenes":[{"sceneHeading":"场次标题","location":"地点","timeOfDay":"日/夜/黄昏等","intExt":"内/外/内/外/空","sceneDescription":"本场整体描述","elements":[{"type":1,"characterName":"说话人","parenthetical":"语气提示，可空","content":"台词或文本"}]}]}
规则：
- 元素 type：1=对白，2=动作，3=旁白，4=镜头/特写/运镜，5=环境/氛围。
- 必须保留原文事实与语句，不得新增情节、人物或对白；可以写简短的场次标题和地点，但元素 content 不得改写。
- 每场至少 1 个元素；对白尽量识别说话人并写入 characterName；旁白也可以带说话人。
- characters 必须列出文本中出现的所有有名字人物（包含只被提到的人）；aliases 可为空；不要编造人物。
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
  const characters: ScriptParseCharacter[] = [];
  const seen = new Set<string>();
  for (const character of raw.characters) {
    const name = character.name.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    characters.push({
      name,
      aliases: character.aliases.map(alias => alias.trim()).filter(Boolean),
      description: character.description?.trim() || null,
    });
  }
  return { structure: structure2, characters };
}

/** 把解析结果作为预览返回，不创建剧本版本；确认保存由用户显式触发。 */
export class ScriptParseService {
  constructor(private readonly database: PostgresDatabase, private readonly breakdown: BreakdownService,
    private readonly config: AppConfig, private readonly transport: typeof fetch = fetch) {}

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
      [attemptId, JSON.stringify({ structure: result.structure, characters: result.characters }),
        response.providerRequestId, JSON.stringify(response.usage)]);
      return { ...result, attemptId, model: config.defaultModel, promptVersion: SCRIPT_PARSE_PROMPT_VERSION, usage: response.usage };
    } catch (error) {
      await this.database.query(`UPDATE script_parse_attempts SET status='failed', error_code=$2,
        provider_request_id=$3, usage_json=$4::jsonb, ended_at=now() WHERE id=$1 AND status='running'`,
      [attemptId, error instanceof BreakdownError ? error.code : 'SCRIPT_PARSE_MODEL_FAILED',
        response?.providerRequestId ?? null, response ? JSON.stringify(response.usage) : null]);
      if (error instanceof BreakdownError) throw error;
      throw new BreakdownError(502, 'SCRIPT_PARSE_MODEL_FAILED', '剧本解析模型调用失败，请检查模型连接后重试。');
    }
  }

  /** 确认保存后创建人物候选：不覆盖当前已采用事实，只新增一份 candidate plan。 */
  async createCharacterCandidate(projectId: string, scriptVersionId: string, characters: ScriptParseCharacter[]) {
    const script = await this.breakdown.getScriptVersion(projectId, scriptVersionId);
    if (characters.length === 0) throw new BreakdownError(400, 'SCRIPT_PARSE_CHARACTERS_REQUIRED', '至少保留一个人物。');
    const run = await this.breakdown.createDraftRun(projectId, {
      scriptVersionId: script.id, requirements: {}, maxModelCalls: 1, maxOutputTokens: 4096,
    });
    const candidate = factsCandidate(script, characters);
    return this.breakdown.createExtractFactsCandidate(run.id, candidate);
  }
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

function factsCandidate(script: { id: string; rawText: string; structure: ScriptStructure | null }, characters: ScriptParseCharacter[]): CreateExtractFactsCandidateRequest {
  const structure = script.structure;
  const episode = structure?.episodes[0];
  if (!structure || !episode) {
    return { synopsis: null, characters: [], locations: [], props: [], scenes: [], dialogues: [] };
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
  const locations = episode.scenes
    .map(scene => scene.location.trim())
    .filter(Boolean)
    .filter((name, index, all) => all.indexOf(name) === index)
    .map((name, index) => {
      const tempId = `location_candidate_${index + 1}`;
      locationTempIds.set(name, tempId);
      const ref = codePointRef(script.rawText, name, script.id) ?? firstRef(script.rawText, script.id);
      return { tempId, name: sourced(name, ref), aliases: [], description: null, sourceRefs: [ref] };
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
    props: [],
    scenes,
    dialogues,
  };
}
