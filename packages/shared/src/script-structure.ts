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

/** 录入区预估场次数量时复用与 parseScriptStructure 完全一致的场次标题判定。 */
export function isSceneHeadingLine(raw: string): boolean {
  return SCENE_PATTERN.test(raw.trim());
}
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

/* -------------------------------------------------------------------------
 * 阶段一：解析草稿与正式版本的差异比对与选择性合并（纯函数，无副作用）。
 *
 * 设计约束：
 *  - 只做结构比对，不接触原文、数据库或模型；调用方（web / main）只传结构。
 *  - 差异项 ID 由结构里的稳定标识推导，使得同一对 (base, draft) 上
 *    diffScriptStructures 与 applySelectedDiffs 得到完全一致的清单，
 *    因此勾选结果可以直接作为 applySelectedDiffs 的输入。
 *  - applySelectedDiffs 只合并被勾选的项：未勾选项一律保持 base 原值，
 *    并且合并结果会再次走 validateScriptStructure，保证不会写坏正式链。
 * ---------------------------------------------------------------------- */

export type ScriptDiffCategory = 'episode' | 'scene' | 'element';

export type ScriptDiffKind =
  | 'episode-inserted' | 'episode-removed' | 'episode-title' | 'episode-synopsis'
  | 'scene-inserted' | 'scene-removed'
  | 'scene-heading' | 'scene-int-ext' | 'scene-location' | 'scene-time' | 'scene-description'
  | 'element-inserted' | 'element-removed' | 'element-type' | 'element-content'
  | 'dialogue-speaker' | 'dialogue-parenthetical';

export interface ScriptDiffItem {
  /** 稳定 ID：同一对 (base, draft) 上恒定，可直接作为勾选键。 */
  id: string;
  kind: ScriptDiffKind;
  category: ScriptDiffCategory;
  /** 人类可读的中文变更项名称。 */
  label: string;
  episodeNumber: number;
  episodeTitle: string;
  /** 变更所在场次编号；分集级变更沿用第一条场次编号或空串。 */
  sceneNumber: string;
  /** 变更所在场次在分集中的顺序（0 起）。 */
  sceneIndex: number;
  /** 元素级变更在场景中的顺序；非元素级为 null。 */
  elementIndex: number | null;
  /** 元素级变更涉及的元素类型。 */
  elementType: ScriptElementType | null;
  /** 原版内容（分集/场次级为摘要文本）。 */
  before: string;
  /** 解析草稿内容（分集/场次级为摘要文本）。 */
  after: string;
}

export const SCRIPT_DIFF_LABELS: Record<ScriptDiffKind, string> = {
  'episode-inserted': '新增分集',
  'episode-removed': '删除分集',
  'episode-title': '分集标题',
  'episode-synopsis': '剧情概览',
  'scene-inserted': '新增场次（场次切分或新增）',
  'scene-removed': '删除场次',
  'scene-heading': '场次标题',
  'scene-int-ext': '内/外景',
  'scene-location': '场次地点',
  'scene-time': '场次时间',
  'scene-description': '场景描述',
  'element-inserted': '新增元素',
  'element-removed': '删除元素',
  'element-type': '元素类型',
  'element-content': '内容',
  'dialogue-speaker': '对白说话人',
  'dialogue-parenthetical': '语气提示',
};

const SCRIPT_DIFF_CATEGORIES: Record<ScriptDiffKind, ScriptDiffCategory> = {
  'episode-inserted': 'episode', 'episode-removed': 'episode',
  'episode-title': 'episode', 'episode-synopsis': 'episode',
  'scene-inserted': 'scene', 'scene-removed': 'scene',
  'scene-heading': 'scene', 'scene-int-ext': 'scene', 'scene-location': 'scene',
  'scene-time': 'scene', 'scene-description': 'scene',
  'element-inserted': 'element', 'element-removed': 'element', 'element-type': 'element',
  'element-content': 'element', 'dialogue-speaker': 'element', 'dialogue-parenthetical': 'element',
};

const SCENE_MATCH_THRESHOLD = 0.45;
const ELEMENT_MATCH_THRESHOLD = 0.5;
/** 差异对齐的 DP 上限：超过后退化为按序对齐，避免长剧本拖慢浏览器。 */
const ALIGN_DP_LIMIT = 250_000;

function normalized(value: string | undefined | null): string {
  return (value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

export function episodeDiffId(kind: ScriptDiffKind, episodeNumber: number): string {
  return `${kind}|episode:${episodeNumber}`;
}

/** anchor 必须带来源前缀：`base:<id>` 或 `draft:<id>`，避免两侧同名 ID 冲突。 */
export function sceneDiffId(kind: ScriptDiffKind, episodeNumber: number, anchor: string): string {
  return `${kind}|episode:${episodeNumber}|scene:${anchor}`;
}

export function elementDiffId(kind: ScriptDiffKind, episodeNumber: number, sceneAnchor: string,
  elementAnchor: string): string {
  return `${kind}|episode:${episodeNumber}|scene:${sceneAnchor}|element:${elementAnchor}`;
}

interface AlignNode { baseIndex: number | null; draftIndex: number | null }

function alignByIndex(n: number, m: number): AlignNode[] {
  const nodes: AlignNode[] = [];
  const shared = Math.min(n, m);
  for (let index = 0; index < shared; index += 1) nodes.push({ baseIndex: index, draftIndex: index });
  for (let index = shared; index < n; index += 1) nodes.push({ baseIndex: index, draftIndex: null });
  for (let index = shared; index < m; index += 1) nodes.push({ baseIndex: null, draftIndex: index });
  return nodes;
}

/**
 * 加权最长公共子序列对齐：只在相似度达到阈值时配对，保证场次顺序不被破坏。
 * 两侧完全对不齐时退化为“先按序配对，再补增删”。
 */
function alignBySimilarity<T>(base: readonly T[], draft: readonly T[],
  similarity: (baseItem: T, draftItem: T) => number, threshold: number): AlignNode[] {
  const n = base.length;
  const m = draft.length;
  if (n === 0) return draft.map((_, index) => ({ baseIndex: null, draftIndex: index }));
  if (m === 0) return base.map((_, index) => ({ baseIndex: index, draftIndex: null }));
  if (n * m > ALIGN_DP_LIMIT) return alignByIndex(n, m);

  const scores: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const row: number[] = [];
    const baseItem = base[i]!;
    for (let j = 0; j < m; j += 1) row.push(similarity(baseItem, draft[j]!));
    scores.push(row);
  }
  const dp: number[][] = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const score = scores[i - 1]![j - 1]!;
      const diagonal = score >= threshold ? dp[i - 1]![j - 1]! + score : -1;
      dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!, diagonal);
    }
  }

  const nodes: AlignNode[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const score = scores[i - 1]![j - 1]!;
      const diagonal = score >= threshold ? dp[i - 1]![j - 1]! + score : -1;
      if (score >= threshold && Math.abs(diagonal - dp[i]![j]!) < 1e-9) {
        nodes.push({ baseIndex: i - 1, draftIndex: j - 1 });
        i -= 1; j -= 1;
        continue;
      }
    }
    if (i > 0 && (j === 0 || dp[i - 1]![j]! >= dp[i]![j - 1]!)) {
      nodes.push({ baseIndex: i - 1, draftIndex: null });
      i -= 1;
      continue;
    }
    nodes.push({ baseIndex: null, draftIndex: j - 1 });
    j -= 1;
  }
  return nodes.reverse();
}

/** 元素先归一化一次，避免 DP 对齐时对每一对重复做字符串处理。 */
function elementSignature(element: ScriptElement): string {
  return normalized(element.content);
}

function elementTextSimilarity(baseText: string, draftText: string): number {
  if (!baseText || !draftText) return 0;
  if (baseText === draftText) return 1;
  if (baseText.length >= 6 && draftText.length >= 6
    && (baseText.includes(draftText) || draftText.includes(baseText))) return 0.7;
  return 0;
}

interface SceneSignature {
  texts: Set<string>;
  location: string;
  timeOfDay: string;
  intExt: string;
  sceneNumber: string;
}

function sceneSignature(scene: ScriptScene): SceneSignature {
  return {
    texts: new Set(scene.dialogues.map(item => normalized(item.content)).filter(Boolean)),
    location: normalized(scene.location),
    timeOfDay: normalized(scene.timeOfDay),
    intExt: scene.intExt,
    sceneNumber: normalized(scene.sceneNumber),
  };
}

function sceneSignatureSimilarity(base: SceneSignature, draft: SceneSignature): number {
  const union = new Set([...base.texts, ...draft.texts]);
  let shared = 0;
  for (const text of draft.texts) if (base.texts.has(text)) shared += 1;
  if (union.size === 0) {
    // 没有对白时只能靠时空信息判断；完全相同才认为同一场。
    return base.location && base.location === draft.location
      && base.timeOfDay === draft.timeOfDay && base.intExt === draft.intExt ? 1 : 0;
  }
  let score = shared / union.size;
  if (base.location && base.location === draft.location) score += 0.12;
  if (base.timeOfDay && base.timeOfDay === draft.timeOfDay) score += 0.06;
  if (base.intExt && base.intExt === draft.intExt) score += 0.05;
  if (base.sceneNumber && base.sceneNumber === draft.sceneNumber) score += 0.2;
  return Math.min(score, 1);
}

function sceneSummary(scene: ScriptScene): string {
  return [
    scene.sceneNumber.trim() || '新场次',
    scene.intExt ? `${scene.intExt}景` : '',
    normalized(scene.location),
    normalized(scene.timeOfDay),
    `${scene.dialogues.length} 个元素`,
  ].filter(Boolean).join(' · ');
}

function elementSummary(element: ScriptElement): string {
  const who = normalized(element.characterName);
  const head = `${SCRIPT_ELEMENT_LABELS[element.type]}${who ? `｜${who}` : ''}`;
  const content = normalized(element.content);
  return content ? `${head}：${content}` : head;
}

function emptyStructure(): ScriptStructure {
  return { schemaVersion: SCRIPT_STRUCTURE_SCHEMA_VERSION, episodes: [] };
}

/**
 * 计算解析草稿相对正式版本的结构差异，只返回真正变化的项（相同内容不出现）。
 * base 为 null / 无结构时，整个草稿视为「新增分集」，交由用户决定是否导入。
 */
export function diffScriptStructures(base: ScriptStructure | null | undefined,
  draft: ScriptStructure): ScriptDiffItem[] {
  const baseEpisodes = base?.episodes ?? [];
  const items: ScriptDiffItem[] = [];

  const push = (input: {
    id: string; kind: ScriptDiffKind; episode: ScriptEpisode; sceneNumber: string;
    sceneIndex: number; elementIndex?: number | null; elementType?: ScriptElementType | null;
    before?: string; after?: string;
  }) => {
    items.push({
      id: input.id,
      kind: input.kind,
      category: SCRIPT_DIFF_CATEGORIES[input.kind],
      label: SCRIPT_DIFF_LABELS[input.kind],
      episodeNumber: input.episode.episodeNumber,
      episodeTitle: normalized(input.episode.title) || `第${input.episode.episodeNumber}集`,
      sceneNumber: input.sceneNumber,
      sceneIndex: input.sceneIndex,
      elementIndex: input.elementIndex ?? null,
      elementType: input.elementType ?? null,
      before: input.before ?? '',
      after: input.after ?? '',
    });
  };

  const episodeNodes = alignBySimilarity(baseEpisodes, draft.episodes,
    (left, right) => left.episodeNumber === right.episodeNumber ? 1 : 0, 1);

  for (const node of episodeNodes) {
    if (node.draftIndex === null && node.baseIndex !== null) {
      const baseEpisode = baseEpisodes[node.baseIndex]!;
      push({
        id: episodeDiffId('episode-removed', baseEpisode.episodeNumber),
        kind: 'episode-removed', episode: baseEpisode,
        sceneNumber: baseEpisode.scenes[0]?.sceneNumber ?? '',
        sceneIndex: 0,
        before: `${normalized(baseEpisode.title) || `第${baseEpisode.episodeNumber}集`} · ${baseEpisode.scenes.length} 场`,
      });
      continue;
    }
    if (node.baseIndex === null && node.draftIndex !== null) {
      const draftEpisode = draft.episodes[node.draftIndex]!;
      push({
        id: episodeDiffId('episode-inserted', draftEpisode.episodeNumber),
        kind: 'episode-inserted', episode: draftEpisode,
        sceneNumber: draftEpisode.scenes[0]?.sceneNumber ?? '',
        sceneIndex: 0,
        after: `${normalized(draftEpisode.title) || `第${draftEpisode.episodeNumber}集`} · ${draftEpisode.scenes.length} 场`,
      });
      continue;
    }

    const baseEpisode = baseEpisodes[node.baseIndex!]!;
    const draftEpisode = draft.episodes[node.draftIndex!]!;

    if (normalized(baseEpisode.title) !== normalized(draftEpisode.title)) {
      push({
        id: episodeDiffId('episode-title', baseEpisode.episodeNumber), kind: 'episode-title',
        episode: baseEpisode, sceneNumber: baseEpisode.scenes[0]?.sceneNumber ?? '', sceneIndex: 0,
        before: baseEpisode.title, after: draftEpisode.title,
      });
    }
    if (normalized(baseEpisode.synopsis) !== normalized(draftEpisode.synopsis)) {
      push({
        id: episodeDiffId('episode-synopsis', baseEpisode.episodeNumber), kind: 'episode-synopsis',
        episode: baseEpisode, sceneNumber: baseEpisode.scenes[0]?.sceneNumber ?? '', sceneIndex: 0,
        before: baseEpisode.synopsis, after: draftEpisode.synopsis,
      });
    }

    const sceneNodes = alignBySimilarity(baseEpisode.scenes.map(sceneSignature),
      draftEpisode.scenes.map(sceneSignature), sceneSignatureSimilarity, SCENE_MATCH_THRESHOLD);
    for (const sceneNode of sceneNodes) {
      if (sceneNode.draftIndex === null && sceneNode.baseIndex !== null) {
        const baseScene = baseEpisode.scenes[sceneNode.baseIndex]!;
        push({
          id: sceneDiffId('scene-removed', baseEpisode.episodeNumber, `base:${baseScene.id}`),
          kind: 'scene-removed', episode: baseEpisode, sceneNumber: baseScene.sceneNumber,
          sceneIndex: sceneNode.baseIndex, before: sceneSummary(baseScene),
        });
        continue;
      }
      if (sceneNode.baseIndex === null && sceneNode.draftIndex !== null) {
        const draftScene = draftEpisode.scenes[sceneNode.draftIndex]!;
        push({
          id: sceneDiffId('scene-inserted', baseEpisode.episodeNumber, `draft:${draftScene.id}`),
          kind: 'scene-inserted', episode: baseEpisode, sceneNumber: draftScene.sceneNumber,
          sceneIndex: sceneNode.draftIndex, after: sceneSummary(draftScene),
        });
        continue;
      }

      const baseScene = baseEpisode.scenes[sceneNode.baseIndex!]!;
      const draftScene = draftEpisode.scenes[sceneNode.draftIndex!]!;
      const sceneAnchor = `base:${baseScene.id}`;
      const sceneContext = {
        episode: baseEpisode, sceneNumber: baseScene.sceneNumber, sceneIndex: sceneNode.baseIndex!,
      };
      const fieldPairs: Array<[ScriptDiffKind, string, string]> = [
        ['scene-heading', baseScene.sceneHeading, draftScene.sceneHeading],
        ['scene-int-ext', baseScene.intExt, draftScene.intExt],
        ['scene-location', baseScene.location, draftScene.location],
        ['scene-time', baseScene.timeOfDay, draftScene.timeOfDay],
        ['scene-description', baseScene.sceneDescription, draftScene.sceneDescription],
      ];
      for (const [kind, before, after] of fieldPairs) {
        if (normalized(before) === normalized(after)) continue;
        push({
          ...sceneContext, id: sceneDiffId(kind, baseEpisode.episodeNumber, sceneAnchor), kind, before, after,
        });
      }

      const elementNodes = alignBySimilarity(baseScene.dialogues.map(elementSignature),
        draftScene.dialogues.map(elementSignature), elementTextSimilarity, ELEMENT_MATCH_THRESHOLD);
      for (const elementNode of elementNodes) {
        if (elementNode.draftIndex === null && elementNode.baseIndex !== null) {
          const baseElement = baseScene.dialogues[elementNode.baseIndex]!;
          push({
            ...sceneContext, id: elementDiffId('element-removed', baseEpisode.episodeNumber, sceneAnchor,
              `base:${baseElement.id}`), kind: 'element-removed',
            elementIndex: elementNode.baseIndex, elementType: baseElement.type,
            before: elementSummary(baseElement),
          });
          continue;
        }
        if (elementNode.baseIndex === null && elementNode.draftIndex !== null) {
          const draftElement = draftScene.dialogues[elementNode.draftIndex]!;
          push({
            ...sceneContext, id: elementDiffId('element-inserted', baseEpisode.episodeNumber, sceneAnchor,
              `draft:${draftElement.id}`), kind: 'element-inserted',
            elementIndex: elementNode.draftIndex, elementType: draftElement.type,
            after: elementSummary(draftElement),
          });
          continue;
        }

        const baseElement = baseScene.dialogues[elementNode.baseIndex!]!;
        const draftElement = draftScene.dialogues[elementNode.draftIndex!]!;
        const elementAnchor = `base:${baseElement.id}`;
        const elementContext = { ...sceneContext, elementIndex: elementNode.baseIndex!, elementType: baseElement.type };
        if (baseElement.type !== draftElement.type) {
          push({
            ...elementContext, id: elementDiffId('element-type', baseEpisode.episodeNumber, sceneAnchor, elementAnchor),
            kind: 'element-type',
            before: SCRIPT_ELEMENT_LABELS[baseElement.type], after: SCRIPT_ELEMENT_LABELS[draftElement.type],
          });
        }
        // 说话人与语气只属于对白/旁白；其他类型即使带了历史脏字段也不产生差异项。
        const dialogueLike = baseElement.type === 1 || baseElement.type === 3
          || draftElement.type === 1 || draftElement.type === 3;
        if (dialogueLike && normalized(baseElement.characterName) !== normalized(draftElement.characterName)) {
          push({
            ...elementContext, id: elementDiffId('dialogue-speaker', baseEpisode.episodeNumber, sceneAnchor, elementAnchor),
            kind: 'dialogue-speaker',
            before: baseElement.characterName ?? '', after: draftElement.characterName ?? '',
          });
        }
        if (dialogueLike && normalized(baseElement.parenthetical) !== normalized(draftElement.parenthetical)) {
          push({
            ...elementContext, id: elementDiffId('dialogue-parenthetical', baseEpisode.episodeNumber, sceneAnchor, elementAnchor),
            kind: 'dialogue-parenthetical',
            before: baseElement.parenthetical ?? '', after: draftElement.parenthetical ?? '',
          });
        }
        if (normalized(baseElement.content) !== normalized(draftElement.content)) {
          push({
            ...elementContext, id: elementDiffId('element-content', baseEpisode.episodeNumber, sceneAnchor, elementAnchor),
            kind: 'element-content', before: baseElement.content, after: draftElement.content,
          });
        }
      }
    }
  }
  return items;
}

export interface ApplySelectedDiffsOptions {
  /** 合并后生成的新对象 ID 前缀，默认 `merged`；仅测试或迁移需要显式指定。 */
  idPrefix?: string;
}

function cloneEpisodeForMerge(episode: ScriptEpisode): ScriptEpisode {
  return structuredClone(episode);
}

/**
 * 只合并用户勾选采纳的差异项，其余内容严格保持 base 原值。
 * 返回的新结构已通过 validateScriptStructure，可直接作为不可变新版本写入正式链。
 */
export function applySelectedDiffs(base: ScriptStructure | null | undefined, draft: ScriptStructure,
  selectedIds: Iterable<string>, options: ApplySelectedDiffsOptions = {}): ScriptStructure {
  const baseStructure = base ?? emptyStructure();
  const selected = new Set(Array.from(selectedIds));
  const idPrefix = options.idPrefix ?? 'merged';
  const takenIds = new Set<string>();
  for (const episode of baseStructure.episodes) {
    takenIds.add(episode.id);
    for (const scene of episode.scenes) {
      takenIds.add(scene.id);
      for (const element of scene.dialogues) takenIds.add(element.id);
    }
  }
  let counter = 0;
  const nextId = (prefix: string): string => {
    let candidate = '';
    do {
      counter += 1;
      candidate = `${prefix}_${idPrefix}_${counter}`;
    } while (takenIds.has(candidate));
    takenIds.add(candidate);
    return candidate;
  };

  const draftEpisodeClone = (episode: ScriptEpisode): ScriptEpisode => ({
    ...structuredClone(episode),
    id: nextId('episode'),
    scenes: episode.scenes.map(scene => ({
      ...structuredClone(scene),
      id: nextId('scene'),
      dialogues: scene.dialogues.map(element => ({ ...structuredClone(element), id: nextId('element') })),
    })),
  });

  const episodeNodes = alignBySimilarity(baseStructure.episodes, draft.episodes,
    (left, right) => left.episodeNumber === right.episodeNumber ? 1 : 0, 1);
  const episodes: ScriptEpisode[] = [];

  for (const node of episodeNodes) {
    if (node.draftIndex === null && node.baseIndex !== null) {
      const baseEpisode = baseStructure.episodes[node.baseIndex]!;
      if (!selected.has(episodeDiffId('episode-removed', baseEpisode.episodeNumber))) {
        episodes.push(cloneEpisodeForMerge(baseEpisode));
      }
      continue;
    }
    if (node.baseIndex === null && node.draftIndex !== null) {
      const draftEpisode = draft.episodes[node.draftIndex]!;
      if (selected.has(episodeDiffId('episode-inserted', draftEpisode.episodeNumber))) {
        episodes.push(draftEpisodeClone(draftEpisode));
      }
      continue;
    }

    const baseEpisode = baseStructure.episodes[node.baseIndex!]!;
    const draftEpisode = draft.episodes[node.draftIndex!]!;
    const episodeNumber = baseEpisode.episodeNumber;
    const merged = cloneEpisodeForMerge(baseEpisode);
    if (selected.has(episodeDiffId('episode-title', episodeNumber))) merged.title = draftEpisode.title;
    if (selected.has(episodeDiffId('episode-synopsis', episodeNumber))) merged.synopsis = draftEpisode.synopsis;

    const sceneNodes = alignBySimilarity(baseEpisode.scenes.map(sceneSignature),
      draftEpisode.scenes.map(sceneSignature), sceneSignatureSimilarity, SCENE_MATCH_THRESHOLD);
    const scenes: ScriptScene[] = [];
    let structuralChange = false;

    for (const sceneNode of sceneNodes) {
      if (sceneNode.draftIndex === null && sceneNode.baseIndex !== null) {
        const baseScene = baseEpisode.scenes[sceneNode.baseIndex]!;
        if (selected.has(sceneDiffId('scene-removed', episodeNumber, `base:${baseScene.id}`))) {
          structuralChange = true;
          continue;
        }
        scenes.push(structuredClone(baseScene));
        continue;
      }
      if (sceneNode.baseIndex === null && sceneNode.draftIndex !== null) {
        const draftScene = draftEpisode.scenes[sceneNode.draftIndex]!;
        if (!selected.has(sceneDiffId('scene-inserted', episodeNumber, `draft:${draftScene.id}`))) continue;
        structuralChange = true;
        scenes.push({
          ...structuredClone(draftScene),
          id: nextId('scene'),
          dialogues: draftScene.dialogues.map(element => ({ ...structuredClone(element), id: nextId('element') })),
        });
        continue;
      }

      const baseScene = baseEpisode.scenes[sceneNode.baseIndex!]!;
      const draftScene = draftEpisode.scenes[sceneNode.draftIndex!]!;
      const sceneAnchor = `base:${baseScene.id}`;
      const mergedScene = structuredClone(baseScene);
      const fieldPairs: Array<[ScriptDiffKind, 'sceneHeading' | 'location' | 'timeOfDay' | 'sceneDescription']> = [
        ['scene-heading', 'sceneHeading'],
        ['scene-location', 'location'],
        ['scene-time', 'timeOfDay'],
        ['scene-description', 'sceneDescription'],
      ];
      for (const [kind, field] of fieldPairs) {
        if (selected.has(sceneDiffId(kind, episodeNumber, sceneAnchor))) mergedScene[field] = draftScene[field];
      }
      if (selected.has(sceneDiffId('scene-int-ext', episodeNumber, sceneAnchor))) {
        mergedScene.intExt = draftScene.intExt;
      }

      const elementNodes = alignBySimilarity(baseScene.dialogues.map(elementSignature),
        draftScene.dialogues.map(elementSignature), elementTextSimilarity, ELEMENT_MATCH_THRESHOLD);
      const elements: ScriptElement[] = [];
      for (const elementNode of elementNodes) {
        if (elementNode.draftIndex === null && elementNode.baseIndex !== null) {
          const baseElement = baseScene.dialogues[elementNode.baseIndex]!;
          if (selected.has(elementDiffId('element-removed', episodeNumber, sceneAnchor, `base:${baseElement.id}`))) continue;
          elements.push(structuredClone(baseElement));
          continue;
        }
        if (elementNode.baseIndex === null && elementNode.draftIndex !== null) {
          const draftElement = draftScene.dialogues[elementNode.draftIndex]!;
          if (!selected.has(elementDiffId('element-inserted', episodeNumber, sceneAnchor, `draft:${draftElement.id}`))) continue;
          elements.push({ ...structuredClone(draftElement), id: nextId('element') });
          continue;
        }

        const baseElement = baseScene.dialogues[elementNode.baseIndex!]!;
        const draftElement = draftScene.dialogues[elementNode.draftIndex!]!;
        const elementAnchor = `base:${baseElement.id}`;
        const mergedElement = structuredClone(baseElement);
        if (selected.has(elementDiffId('element-type', episodeNumber, sceneAnchor, elementAnchor))) {
          mergedElement.type = draftElement.type;
          // 类型切换后按该类型的字段约定保留/补齐可选字段。
          if (draftElement.type === 1 || draftElement.type === 3) {
            mergedElement.characterName = draftElement.characterName ?? '';
            mergedElement.parenthetical = draftElement.parenthetical ?? '';
          } else {
            delete mergedElement.characterName;
            delete mergedElement.parenthetical;
          }
        }
        if (selected.has(elementDiffId('dialogue-speaker', episodeNumber, sceneAnchor, elementAnchor))) {
          mergedElement.characterName = draftElement.characterName ?? '';
        }
        if (selected.has(elementDiffId('dialogue-parenthetical', episodeNumber, sceneAnchor, elementAnchor))) {
          mergedElement.parenthetical = draftElement.parenthetical ?? '';
        }
        if (selected.has(elementDiffId('element-content', episodeNumber, sceneAnchor, elementAnchor))) {
          mergedElement.content = draftElement.content;
        }
        elements.push(mergedElement);
      }
      mergedScene.dialogues = elements;
      scenes.push(mergedScene);
    }

    if (structuralChange) {
      // 场次切分/新增/删除后按位置重排编号，避免与原有编号冲突。
      merged.scenes = scenes.map((scene, index) => ({ ...scene, sceneNumber: `${episodeNumber}-${index + 1}` }));
    } else {
      merged.scenes = scenes;
    }
    episodes.push(merged);
  }

  if (episodes.length === 0) {
    fail('EMPTY_MERGE', '所选差异没有留下任何分集：请至少采纳一个分集或保留原版内容。');
  }
  return validateScriptStructure({ schemaVersion: SCRIPT_STRUCTURE_SCHEMA_VERSION, episodes });
}

/* -------------------------------------------------------------------------
 * 角色导入总控（#191）
 * 模型识别出的角色默认只是草稿，只有总开关开启且逐项勾选的角色才会进入正式库，
 * 避免“路人甲 / 龙套小妹”等无效角色污染项目角色资产。
 * ---------------------------------------------------------------------- */

/** 角色勾选状态使用归一化名称作为键：忽略空白与大小写，避免同名重复导入。 */
export function normalizeScriptCharacterName(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase();
}

export interface ScriptCharacterImportInput {
  name: string;
  aliases?: string[];
}

export interface ScriptCharacterImportPlanItem {
  /** 勾选状态键，等于 normalizeScriptCharacterName(name)。 */
  key: string;
  name: string;
  /** 在草稿结构中作为说话人出现的场次数（名称或别名命中即计）。 */
  sceneCount: number;
  /** 是否已匹配项目已有角色：命中时不重复创建，只更新引用。 */
  existing: boolean;
  /** 默认勾选建议：已有角色，或出场两场及以上的核心角色。 */
  suggested: boolean;
}

/** 汇总每个角色在草稿里的出场场数，并标记已存在于项目中的角色。 */
export function planCharacterImport(draft: ScriptStructure | null | undefined,
  characters: readonly ScriptCharacterImportInput[], existingNames: Iterable<string>): ScriptCharacterImportPlanItem[] {
  const existing = new Set([...existingNames].map(normalizeScriptCharacterName).filter(Boolean));
  const sceneSpeakers: Array<Set<string>> = [];
  for (const episode of draft?.episodes ?? []) {
    for (const scene of episode.scenes) {
      const speakers = new Set<string>();
      for (const element of scene.dialogues) {
        if (element.type !== 1) continue;
        const key = normalizeScriptCharacterName(element.characterName ?? '');
        if (key) speakers.add(key);
      }
      sceneSpeakers.push(speakers);
    }
  }
  return characters.map(character => {
    const names = new Set([character.name, ...(character.aliases ?? [])]
      .map(normalizeScriptCharacterName).filter(Boolean));
    const key = normalizeScriptCharacterName(character.name);
    const sceneCount = sceneSpeakers.filter(speakers => [...names].some(name => speakers.has(name))).length;
    const isExisting = existing.has(key);
    return { key, name: character.name, sceneCount, existing: isExisting, suggested: isExisting || sceneCount >= 2 };
  });
}

/**
 * 角色导入总控 + 逐项筛选：总开关关闭时一个角色都不导入；
 * 开启时只保留被勾选项，返回新数组，不修改入参。
 */
export function filterImportEntities<T extends { name: string }>(items: readonly T[],
  options: { enabled: boolean; selectedNames: ReadonlySet<string> }): T[] {
  if (!options.enabled) return [];
  return items.filter(item => options.selectedNames.has(normalizeScriptCharacterName(item.name)));
}

/* -------------------------------------------------------------------------
 * 阶段一：场次合并、元素拆分与当前集实体级联更名（纯函数，无副作用）。
 *
 * 设计约束：
 *  - 所有函数返回全新结构，绝不修改入参；返回值再次走 validateScriptStructure，
 *    保证 ID、场次编号与元素类型仍然合法，可直接写入不可变版本链。
 *  - 级联更名只作用于目标集：不跨集改写说话人或地点，避免影响其他集草稿。
 * ---------------------------------------------------------------------- */

export const SCRIPT_ENTITY_KINDS = ['character', 'location', 'prop'] as const;
export type ScriptEntityKind = (typeof SCRIPT_ENTITY_KINDS)[number];

export const SCRIPT_ENTITY_ROLES = ['protagonist', 'supporting', 'background'] as const;
export type ScriptEntityRole = (typeof SCRIPT_ENTITY_ROLES)[number];

export const SCRIPT_ENTITY_ROLE_LABELS: Record<ScriptEntityRole, string> = {
  protagonist: '主角',
  supporting: '配角',
  background: '路人',
};

function requireEpisode(structure: ScriptStructure, episodeNumber: number): {
  episode: ScriptEpisode; index: number;
} {
  const index = structure.episodes.findIndex(item => item.episodeNumber === episodeNumber);
  if (index < 0) fail('SCRIPT_EPISODE_NOT_FOUND', `找不到第 ${episodeNumber} 集。`);
  return { episode: structure.episodes[index]!, index };
}

function requireScene(episode: ScriptEpisode, sceneId: string): { scene: ScriptScene; index: number } {
  const index = episode.scenes.findIndex(item => item.id === sceneId);
  if (index < 0) fail('SCRIPT_SCENE_NOT_FOUND', `场次 ${sceneId} 不存在。`);
  return { scene: episode.scenes[index]!, index };
}

/** 把指定场次的全部元素向下合并到紧邻的下一场，源场次随之删除。 */
export function mergeSceneDown(structure: ScriptStructure, episodeNumber: number, sceneId: string): ScriptStructure {
  const clone = structuredClone(structure) as ScriptStructure;
  const { episode, index } = requireEpisode(clone, episodeNumber);
  const { scene, index: sceneIndex } = requireScene(episode, sceneId);
  if (sceneIndex >= episode.scenes.length - 1) {
    fail('SCRIPT_SCENE_NO_NEXT', '最后一场没有下一场可以向下合并。');
  }
  const nextScene = episode.scenes[sceneIndex + 1]!;
  nextScene.dialogues = [...scene.dialogues, ...nextScene.dialogues];
  episode.scenes.splice(sceneIndex, 1);
  renumberEpisodeScenes(episode);
  return validateScriptStructure(clone);
}

/**
 * 在元素内容的码点索引处定点拆成两个元素：前半保留原 ID，后半生成新 ID。
 * splitIndex 必须落在 1..length-1 之间，避免产生空元素。
 */
export function splitElementAt(structure: ScriptStructure, episodeNumber: number, sceneId: string,
  elementId: string, splitIndex: number): ScriptStructure {
  if (!Number.isInteger(splitIndex) || splitIndex < 1) fail('INVALID_SPLIT_INDEX', '拆分位置必须是非负整数。');
  const clone = structuredClone(structure) as ScriptStructure;
  const { episode } = requireEpisode(clone, episodeNumber);
  const { scene, index: sceneIndex } = requireScene(episode, sceneId);
  const elementIndex = scene.dialogues.findIndex(item => item.id === elementId);
  if (elementIndex < 0) fail('SCRIPT_ELEMENT_NOT_FOUND', `元素 ${elementId} 不存在。`);
  const element = scene.dialogues[elementIndex]!;
  const codePoints = Array.from(element.content);
  if (splitIndex >= codePoints.length) fail('INVALID_SPLIT_INDEX', '拆分位置不能落在内容末尾。');
  const head = codePoints.slice(0, splitIndex).join('');
  const tail = codePoints.slice(splitIndex).join('');
  if (!head.trim() || !tail.trim()) fail('INVALID_SPLIT_INDEX', '拆分后两侧内容不能为空。');
  const second: ScriptElement = {
    ...structuredClone(element),
    id: `element_${episode.episodeNumber}_${sceneIndex + 1}_${scene.dialogues.length + 1}`,
    content: tail,
  };
  element.content = head;
  scene.dialogues.splice(elementIndex + 1, 0, second);
  return validateScriptStructure(clone);
}

export interface EntityRenameMatch {
  /** 待匹配的当前名称。 */
  name: string;
  /** 待一并识别的旧别名。 */
  aliases?: readonly string[];
}

/**
 * 在目标集内把命中的角色说话人（对白/旁白 characterName）或场次地点
 * （scene.location）级联更名为新名称；别名命中同样替换。只返回新结构。
 */
export function renameEntityInEpisode(structure: ScriptStructure, episodeNumber: number,
  kind: 'character' | 'location', match: EntityRenameMatch, newName: string): ScriptStructure {
  const targetName = newName.trim();
  if (!targetName) fail('INVALID_ENTITY_NAME', '新名称不能为空。');
  const clone = structuredClone(structure) as ScriptStructure;
  const { episode } = requireEpisode(clone, episodeNumber);
  const targets = new Set([match.name, ...(match.aliases ?? [])]
    .map(normalizeScriptCharacterName).filter(Boolean));
  if (targets.size === 0) fail('INVALID_ENTITY_NAME', '待更名名称不能为空。');
  if (kind === 'character') {
    for (const scene of episode.scenes) {
      for (const element of scene.dialogues) {
        if (element.type !== 1 && element.type !== 3) continue;
        if (targets.has(normalizeScriptCharacterName(element.characterName ?? ''))) {
          element.characterName = targetName;
        }
      }
    }
  } else {
    for (const scene of episode.scenes) {
      if (targets.has(normalizeScriptCharacterName(scene.location))) scene.location = targetName;
    }
  }
  return validateScriptStructure(clone);
}

function renumberEpisodeScenes(episode: ScriptEpisode): void {
  episode.scenes.forEach((scene, index) => {
    scene.sceneNumber = `${episode.episodeNumber}-${index + 1}`;
  });
}
