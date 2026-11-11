/**
 * 结构化剧本：分集 → 场次 → 对白/动作/旁白/镜头/环境元素。
 *
 * 这是正式剧本数据的唯一结构契约。`script_versions.structure_json` 持久化
 * 这份文档，`rawText` 只是由它派生的 canonical 文本，供既有拆解与索引链路读取。
 * 元素类型与融光项目 `DialogueElement` 对齐：
 *   1=对白, 2=动作, 3=旁白, 4=镜头, 5=环境
 */
export const SCRIPT_STRUCTURE_SCHEMA_VERSION = 'script-structure/1' as const;

export const SCRIPT_ELEMENT_TYPES = [1, 2, 3, 4, 5] as const;
export type ScriptElementType = (typeof SCRIPT_ELEMENT_TYPES)[number];

export const SCRIPT_ELEMENT_LABELS: Record<ScriptElementType, string> = {
  1: '对白',
  2: '动作',
  3: '旁白',
  4: '镜头',
  5: '环境',
};

/** 与融光 `DialogueElement` 对齐；对白/旁白用 characterName + parenthetical。 */
export interface ScriptElement {
  id: string;
  type: ScriptElementType;
  characterName?: string;
  parenthetical?: string;
  content: string;
}

/** 与融光 `SceneItem` 对齐；dialogues 就是五类元素的数组。 */
export interface ScriptScene {
  id: string;
  sceneNumber: string;
  sceneHeading: string;
  location: string;
  timeOfDay: string;
  intExt: '内' | '外' | '内/外' | '';
  sceneDescription: string;
  dialogues: ScriptElement[];
}

/** 与融光 `ScriptEpisode` 对齐。 */
export interface ScriptEpisode {
  id: string;
  episodeNumber: number;
  title: string;
  synopsis: string;
  scenes: ScriptScene[];
}

export interface ScriptStructure {
  schemaVersion: typeof SCRIPT_STRUCTURE_SCHEMA_VERSION;
  episodes: ScriptEpisode[];
}

export class ScriptStructureError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ScriptStructureError';
  }
}

const MAX_EPISODES = 1_000;
const MAX_SCENES_PER_EPISODE = 10_000;
const MAX_ELEMENTS_PER_SCENE = 20_000;
const MAX_TEXT = 2_000_000;
const MAX_FIELD = 160;

function fail(code: string, message: string): never {
  throw new ScriptStructureError(code, message);
}

function text(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== 'string') fail('INVALID_STRUCTURE', `${field} 必须是字符串。`);
  if (value.length > max) fail('INVALID_STRUCTURE', `${field} 超过长度上限。`);
  return value;
}

function optionalText(value: unknown, field: string, max = MAX_FIELD): string {
  if (value === undefined || value === null) return '';
  return text(value, field, max);
}

function id(value: unknown, field: string): string {
  const parsed = text(value, field, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(parsed)) fail('INVALID_STRUCTURE', `${field} 格式不合法。`);
  return parsed;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail('INVALID_STRUCTURE', `${field} 必须是 ${min}..${max} 的整数。`);
  }
  return value;
}

function element(value: unknown, field: string): ScriptElement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_STRUCTURE', `${field} 必须是对象。`);
  const source = value as Record<string, unknown>;
  if (!SCRIPT_ELEMENT_TYPES.includes(source.type as ScriptElementType)) {
    fail('INVALID_STRUCTURE', `${field}.type 必须是 1..5（对白/动作/旁白/镜头/环境）。`);
  }
  const type = source.type as ScriptElementType;
  const result: ScriptElement = {
    id: id(source.id, `${field}.id`),
    type,
    content: text(source.content, `${field}.content`),
  };
  if (type === 1 || type === 3) {
    result.characterName = optionalText(source.characterName, `${field}.characterName`);
    result.parenthetical = optionalText(source.parenthetical, `${field}.parenthetical`);
  }
  return result;
}

function scene(value: unknown, field: string): ScriptScene {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_STRUCTURE', `${field} 必须是对象。`);
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.dialogues)) fail('INVALID_STRUCTURE', `${field}.dialogues 必须是数组。`);
  const dialogues = source.dialogues.map((item, index) => element(item, `${field}.dialogues[${index}]`));
  const intExt = source.intExt;
  if (intExt !== '' && intExt !== '内' && intExt !== '外' && intExt !== '内/外') {
    fail('INVALID_STRUCTURE', `${field}.intExt 必须是 内/外/内/外/空。`);
  }
  return {
    id: id(source.id, `${field}.id`),
    sceneNumber: text(source.sceneNumber, `${field}.sceneNumber`, MAX_FIELD),
    sceneHeading: optionalText(source.sceneHeading, `${field}.sceneHeading`, MAX_FIELD),
    location: optionalText(source.location, `${field}.location`, MAX_FIELD),
    timeOfDay: optionalText(source.timeOfDay, `${field}.timeOfDay`, MAX_FIELD),
    intExt: intExt as ScriptScene['intExt'],
    sceneDescription: optionalText(source.sceneDescription, `${field}.sceneDescription`),
    dialogues,
  };
}

function episode(value: unknown, field: string): ScriptEpisode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_STRUCTURE', `${field} 必须是对象。`);
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.scenes)) fail('INVALID_STRUCTURE', `${field}.scenes 必须是数组。`);
  if (source.scenes.length > MAX_SCENES_PER_EPISODE) fail('INVALID_STRUCTURE', `${field}.scenes 超过上限。`);
  const scenes = source.scenes.map((item, index) => scene(item, `${field}.scenes[${index}]`));
  return {
    id: id(source.id, `${field}.id`),
    episodeNumber: integer(source.episodeNumber, `${field}.episodeNumber`, 1, MAX_EPISODES),
    title: optionalText(source.title, `${field}.title`),
    synopsis: optionalText(source.synopsis, `${field}.synopsis`),
    scenes,
  };
}

/**
 * 校验并返回一份不可变的结构。这里不做业务语义判断（例如某场有没有对白），
 * 只保证 JSON 形状、类型、排序与 ID 唯一性，避免把非法结构写进正式链。
 */
export function validateScriptStructure(value: unknown): ScriptStructure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_STRUCTURE', '结构化剧本必须是对象。');
  const source = value as Record<string, unknown>;
  if (source.schemaVersion !== SCRIPT_STRUCTURE_SCHEMA_VERSION) {
    fail('INVALID_STRUCTURE', `schemaVersion 必须是 ${SCRIPT_STRUCTURE_SCHEMA_VERSION}。`);
  }
  if (!Array.isArray(source.episodes)) fail('INVALID_STRUCTURE', 'episodes 必须是数组。');
  if (source.episodes.length === 0) fail('INVALID_STRUCTURE', '剧本至少需要一集。');
  if (source.episodes.length > MAX_EPISODES) fail('INVALID_STRUCTURE', '分集数量超过上限。');

  const episodes = source.episodes.map((item, index) => episode(item, `episodes[${index}]`));
  const episodeNumbers = new Set<number>();
  const episodeIds = new Set<string>();
  for (const item of episodes) {
    if (episodeNumbers.has(item.episodeNumber)) fail('INVALID_STRUCTURE', `分集编号重复：${item.episodeNumber}`);
    if (episodeIds.has(item.id)) fail('INVALID_STRUCTURE', `分集 ID 重复：${item.id}`);
    episodeNumbers.add(item.episodeNumber);
    episodeIds.add(item.id);
    const sceneIds = new Set<string>();
    const sceneNumbers = new Set<string>();
    for (const itemScene of item.scenes) {
      if (sceneIds.has(itemScene.id)) fail('INVALID_STRUCTURE', `场次 ID 重复：${itemScene.id}`);
      if (sceneNumbers.has(itemScene.sceneNumber)) fail('INVALID_STRUCTURE', `场次编号重复：${itemScene.sceneNumber}`);
      sceneIds.add(itemScene.id);
      sceneNumbers.add(itemScene.sceneNumber);
      if (itemScene.dialogues.length > MAX_ELEMENTS_PER_SCENE) fail('INVALID_STRUCTURE', '场次元素数量超过上限。');
      const elementIds = new Set<string>();
      for (const itemElement of itemScene.dialogues) {
        if (elementIds.has(itemElement.id)) fail('INVALID_STRUCTURE', `元素 ID 重复：${itemElement.id}`);
        elementIds.add(itemElement.id);
      }
    }
  }
  return structuredClone({ schemaVersion: SCRIPT_STRUCTURE_SCHEMA_VERSION, episodes }) as ScriptStructure;
}

export function emptyScriptStructure(): ScriptStructure {
  return {
    schemaVersion: SCRIPT_STRUCTURE_SCHEMA_VERSION,
    episodes: [{
      id: 'episode_1', episodeNumber: 1, title: '第1集', synopsis: '',
      scenes: [{
        id: 'scene_1_1', sceneNumber: '1-1', sceneHeading: '', location: '', timeOfDay: '',
        intExt: '', sceneDescription: '', dialogues: [],
      }],
    }],
  };
}

const EPISODE_PATTERN = /^\s*第([0-9一二三四五六七八九十百零〇两]+)集(?:\s*[·:：-]?\s*(.*))?$/;
const SCENE_PATTERN = /^\s*(?:第)?([0-9]+[-—][0-9]+(?=\s|$)|[0-9]+(?=\s*场)|[一二三四五六七八九十百零〇两]+(?=\s*场))\s*(?:场)?\s*(?:[·:：-]\s*)?(.*)$/;
const SPECIAL_PATTERN = /^\s*(?:【|\[)(旁白|镜头|环境|动作)(?:】|\])\s*(.*)$/;
const DIALOGUE_PATTERN = /^\s*([^：:（(\n]{1,24})(?:（([^）)\n]*)）)?[：:]\s*(.*)$/;
const SYNOPSIS_PATTERN = /^\s*(?:剧情概览|剧情梗概|梗概)[：:]\s*(.*)$/;
const SETTING_PATTERN = /(内景|外景|内|外)/;
const TIME_PATTERN = /(清晨|黄昏|傍晚|白天|夜晚|日|夜|晨)/;

function parseSceneHeader(raw: string): Pick<ScriptScene, 'sceneHeading' | 'location' | 'timeOfDay' | 'intExt'> {
  const setting = raw.match(SETTING_PATTERN)?.[1] ?? '';
  const timeOfDay = raw.match(TIME_PATTERN)?.[1] ?? '';
  const location = raw
    .replace(SETTING_PATTERN, '')
    .replace(TIME_PATTERN, '')
    .replace(/^(场景|地点)\s*[:：]?\s*/, '')
    .replace(/[·:：,，、|/\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    sceneHeading: raw.trim(),
    location: location === '新场次' ? '' : location,
    timeOfDay,
    intExt: setting.startsWith('内') ? '内' : setting.startsWith('外') ? '外' : '',
  };
}

function parseElement(line: string, index: number): ScriptElement | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const special = trimmed.match(SPECIAL_PATTERN);
  if (special) {
    const type = ({ 对白: 1, 动作: 2, 旁白: 3, 镜头: 4, 环境: 5 } as const)[special[1] as '对白' | '动作' | '旁白' | '镜头' | '环境'];
    return { id: `element_${index}`, type, content: (special[2] ?? '').trim() };
  }
  const dialogue = trimmed.match(DIALOGUE_PATTERN);
  if (dialogue) {
    return {
      id: `element_${index}`,
      type: 1,
      characterName: (dialogue[1] ?? '').trim(),
      parenthetical: dialogue[2]?.trim() || '',
      content: (dialogue[3] ?? '').trim(),
    };
  }
  return { id: `element_${index}`, type: 2, content: trimmed };
}

/**
 * 把原始剧本文本解析成可编辑结构：导入原文时由服务端自动调用，
 * 也用于旧版本首次进入编辑器或用户切回原文时。解析结果不替代原文，
 * 用户保存后，结构会成为正式数据，rawText 由结构派生。
 */
export function parseScriptStructure(rawText: string): ScriptStructure {
  const lines = rawText.replace(/\r\n?/g, '\n').split('\n');
  const episodes: ScriptEpisode[] = [];
  let currentEpisode: ScriptEpisode | null = null;
  let currentScene: ScriptScene | null = null;
  let elementIndex = 0;

  const ensureEpisode = (): ScriptEpisode => {
    if (!currentEpisode) {
      currentEpisode = { id: 'episode_1', episodeNumber: 1, title: '第1集', synopsis: '', scenes: [] };
      episodes.push(currentEpisode);
    }
    return currentEpisode;
  };
  const ensureScene = (): ScriptScene => {
    const targetEpisode = ensureEpisode();
    if (!currentScene) {
      currentScene = {
        id: `scene_${targetEpisode.episodeNumber}_1`,
        sceneNumber: `${targetEpisode.episodeNumber}-1`,
        sceneHeading: '', location: '', timeOfDay: '', intExt: '',
        sceneDescription: '', dialogues: [],
      };
      targetEpisode.scenes.push(currentScene);
    }
    return currentScene;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const episodeMatch = trimmed.match(EPISODE_PATTERN);
    if (episodeMatch) {
      const episodeNumber = episodes.length + 1;
      const suffix = (episodeMatch[2] ?? '').replace(/^[·:：-]\s*/, '').trim();
      currentEpisode = {
        id: `episode_${episodeNumber}`, episodeNumber,
        title: suffix ? `第${episodeNumber}集 · ${suffix}` : `第${episodeNumber}集`,
        synopsis: '', scenes: [],
      };
      episodes.push(currentEpisode);
      currentScene = null;
      continue;
    }
    const sceneMatch = trimmed.match(SCENE_PATTERN);
    if (sceneMatch) {
      const targetEpisode = ensureEpisode();
      const normalized = (sceneMatch[1] ?? '').replace(/^第/, '').replace(/场$/, '').trim();
      const sceneNumber = /^[0-9]+[-—][0-9]+$/.test(normalized)
        ? normalized.replace('—', '-')
        : /^[0-9]+$/.test(normalized)
          ? `${targetEpisode.episodeNumber}-${normalized}`
          : `${targetEpisode.episodeNumber}-${targetEpisode.scenes.length + 1}`;
      currentScene = {
        id: `scene_${targetEpisode.episodeNumber}_${targetEpisode.scenes.length + 1}`,
        sceneNumber,
        ...parseSceneHeader(sceneMatch[2] ?? ''),
        sceneDescription: '', dialogues: [],
      };
      targetEpisode.scenes.push(currentScene);
      continue;
    }
    const synopsisMatch = trimmed.match(SYNOPSIS_PATTERN);
    if (synopsisMatch) {
      ensureEpisode().synopsis = (synopsisMatch[1] ?? '').trim();
      continue;
    }
    const element = parseElement(trimmed, ++elementIndex);
    if (element) ensureScene().dialogues.push(element);
  }

  if (episodes.length === 0) return emptyScriptStructure();
  for (const item of episodes) {
    if (item.scenes.length === 0) {
      item.scenes.push({
        id: `scene_${item.episodeNumber}_1`, sceneNumber: `${item.episodeNumber}-1`,
        sceneHeading: '', location: '', timeOfDay: '', intExt: '', sceneDescription: '', dialogues: [],
      });
    }
  }
  return validateScriptStructure({ schemaVersion: SCRIPT_STRUCTURE_SCHEMA_VERSION, episodes });
}

function elementText(element: ScriptElement): string {
  const content = element.content.trim();
  if (element.type === 1) {
    const who = element.characterName?.trim() || '角色';
    const parenthetical = element.parenthetical?.trim();
    return `${who}${parenthetical ? `（${parenthetical}）` : ''}：${content}`;
  }
  if (element.type === 3) {
    const who = element.characterName?.trim();
    const parenthetical = element.parenthetical?.trim();
    return `【旁白】${who ? `${who}${parenthetical ? `（${parenthetical}）` : ''}：` : ''}${content}`;
  }
  return `【${SCRIPT_ELEMENT_LABELS[element.type]}】${content}`;
}

/**
 * 结构派生 canonical 文本。旧拆解链路只读 rawText，因此每次保存结构时
 * 由服务端重新派生，避免客户端同时提交两份互相矛盾的内容。
 */
export function serializeScriptStructure(structure: ScriptStructure): string {
  const lines: string[] = [];
  structure.episodes.forEach((episode, episodeIndex) => {
    if (episodeIndex > 0) lines.push('');
    lines.push(episode.title.trim() || `第${episode.episodeNumber}集`);
    if (episode.synopsis.trim()) lines.push(`剧情概览：${episode.synopsis.trim()}`);
    episode.scenes.forEach((scene, sceneIndex) => {
      lines.push('');
      const header = [
        scene.sceneNumber.trim() || `${episode.episodeNumber}-${sceneIndex + 1}`,
        scene.intExt ? `${scene.intExt}景` : '',
        scene.location.trim(),
        scene.timeOfDay.trim(),
      ].filter(Boolean).join(' ');
      lines.push(header);
      if (scene.sceneDescription.trim()) lines.push(scene.sceneDescription.trim());
      for (const item of scene.dialogues) {
        const rendered = elementText(item);
        if (rendered.trim()) lines.push(rendered);
      }
    });
  });
  return lines.join('\n').trim();
}
