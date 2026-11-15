import {
  normalizeScriptCharacterName, serializeScriptStructure,
  type ParsedEntityCandidate,
  type ScriptCharacterImportPlanItem,
  type ScriptElement,
  type ScriptEntityKind,
  type ScriptEntityRole,
  type ScriptEpisode,
  type ScriptParseCharacter,
  type ScriptParseEntity,
  type ScriptScene,
  type ScriptStructure,
} from '@lyra/shared';
import { splitScene, type ScriptElementType } from '../script-structure';

/** 人物在候选清单中的粗分档：主角 / 配角 / 路人。地点与道具不参与分档。 */
export type EntityRole = '主角' | '配角' | '路人';

export type IngestionKind = ScriptEntityKind;

/** shared 角色档位到中文标签的映射。 */
export const ROLE_LABEL: Record<ScriptEntityRole, EntityRole> = {
  protagonist: '主角',
  supporting: '配角',
  background: '路人',
};

/**
 * 解析候选条目：模型识别出、但尚未写入正式库的人物 / 地点 / 道具。
 * `existing` 表示同名已在项目资产库中命中，确认时复用既有资产，绝不覆盖新建。
 */
export interface DrawerCandidate {
  candidateId: string;
  kind: IngestionKind;
  /** 当前显示名（可能已行内改名）；提交时原名取 `originalName`，改名走 `renameTo`。 */
  name: string;
  /** 解析候选的原始名称，改名后保持不变，供服务端匹配既有资产与级联。 */
  originalName: string;
  aliases: string[];
  description: string | null;
  role: EntityRole | null;
  roleKey: ScriptEntityRole | null;
  sceneCount: number;
  existing: boolean;
  existingAssetId: string | null;
  confidence: number | null;
  suggested: boolean;
}

/** 已有资产按名称归一化匹配；前端只做名称对齐，匹配规则仍以服务端为准。 */
export function matchExistingName(name: string, existingNames: readonly string[]): boolean {
  const key = normalizeScriptCharacterName(name);
  return existingNames.some(item => normalizeScriptCharacterName(item) === key);
}

/** 主角：已有角色或出场 ≥3 场；配角：出场 1–2 场；其余为路人。 */
export function classifyEntity(plan: Pick<ScriptCharacterImportPlanItem, 'existing' | 'sceneCount'>): EntityRole {
  if (plan.existing || plan.sceneCount >= 3) return '主角';
  if (plan.sceneCount >= 1) return '配角';
  return '路人';
}

export function candidateId(kind: IngestionKind, name: string): string {
  return `${kind}:${normalizeScriptCharacterName(name) || name}`;
}

/** 组装抽屉候选：人物带出场档与建议勾选；地点/道具默认进入候选清单，是否勾选由清单状态控制。 */
export function buildIngestionCandidates(input: {
  characters: readonly ScriptParseCharacter[];
  locations: readonly ScriptParseEntity[];
  props: readonly ScriptParseEntity[];
  plan: readonly ScriptCharacterImportPlanItem[];
  existingNames: readonly string[];
}): DrawerCandidate[] {
  const characterCandidates: DrawerCandidate[] = input.characters.map((item, index) => {
    const planItem = input.plan[index];
    const sceneCount = planItem?.sceneCount ?? 0;
    const existing = Boolean(planItem?.existing) || matchExistingName(item.name, input.existingNames);
    const role = classifyEntity({ existing, sceneCount });
    return {
      candidateId: candidateId('character', item.name),
      kind: 'character',
      name: item.name,
      originalName: item.name,
      aliases: item.aliases,
      description: item.description,
      role,
      roleKey: role === '主角' ? 'protagonist' : role === '配角' ? 'supporting' : 'background',
      sceneCount,
      existing,
      existingAssetId: null,
      confidence: null,
      suggested: planItem?.suggested ?? role !== '路人',
    };
  });
  const locationCandidates: DrawerCandidate[] = input.locations.map(item => ({
    candidateId: candidateId('location', item.name),
    kind: 'location',
    name: item.name,
    originalName: item.name,
    aliases: item.aliases,
    description: item.description,
    role: null,
    roleKey: null,
    sceneCount: 0,
    existing: matchExistingName(item.name, input.existingNames),
    existingAssetId: null,
    confidence: null,
    suggested: true,
  }));
  const propCandidates: DrawerCandidate[] = input.props.map(item => ({
    candidateId: candidateId('prop', item.name),
    kind: 'prop',
    name: item.name,
    originalName: item.name,
    aliases: item.aliases,
    description: item.description,
    role: null,
    roleKey: null,
    sceneCount: 0,
    existing: matchExistingName(item.name, input.existingNames),
    existingAssetId: null,
    confidence: null,
    suggested: true,
  }));
  return [...characterCandidates, ...locationCandidates, ...propCandidates];
}

/** 直接从单集解析响应的候选清单构建抽屉条目；角色档位、置信度与既有资产 ID 以服务端为准。 */
export function buildCandidatesFromParseResult(result: {
  characters: readonly ParsedEntityCandidate[];
  locations: readonly ParsedEntityCandidate[];
  props: readonly ParsedEntityCandidate[];
}): DrawerCandidate[] {
  const map = (item: ParsedEntityCandidate): DrawerCandidate => ({
    candidateId: item.candidateId,
    kind: item.kind,
    name: item.name,
    originalName: item.name,
    aliases: item.aliases,
    description: item.description,
    role: ROLE_LABEL[item.role] ?? null,
    roleKey: item.role,
    sceneCount: 0,
    existing: item.existing,
    existingAssetId: item.existingAssetId,
    confidence: item.confidence,
    suggested: item.suggested,
  });
  return [...result.characters.map(map), ...result.locations.map(map), ...result.props.map(map)];
}

/**
 * 默认勾选：人物按服务端建议，但路人默认不勾选；地点与道具默认勾选。
 * 同名已有资产仍勾选表示“复用并绑定”，不会新建重复资产。
 */
export function defaultCandidateSelection(candidates: readonly DrawerCandidate[]): Set<string> {
  return new Set(candidates
    .filter(item => item.kind !== 'character' || (item.suggested && item.role !== '路人'))
    .map(item => item.candidateId));
}

export function toggleCandidate(selected: ReadonlySet<string>, id: string, next: boolean): Set<string> {
  const nextSet = new Set(selected);
  if (next) nextSet.add(id); else nextSet.delete(id);
  return nextSet;
}

export function selectAllCandidates(candidates: readonly DrawerCandidate[]): Set<string> {
  return new Set(candidates.map(item => item.candidateId));
}

export function selectNoCandidates(): Set<string> {
  return new Set<string>();
}

export function invertCandidates(candidates: readonly DrawerCandidate[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set<string>();
  for (const item of candidates) {
    if (!selected.has(item.candidateId)) next.add(item.candidateId);
  }
  return next;
}

/** 只选核心主角：人物仅保留主角；配角与路人不选。地点/道具维持当前勾选不变。 */
export function selectCoreCandidates(candidates: readonly DrawerCandidate[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set<string>();
  for (const item of candidates) {
    if (item.kind === 'character') {
      if (item.role === '主角') next.add(item.candidateId);
    } else if (selected.has(item.candidateId)) {
      next.add(item.candidateId);
    }
  }
  return next;
}

/** 可见候选：被忽略的条目不参与勾选操作，也不会进入最终入库清单。 */
export function visibleCandidates(
  candidates: readonly DrawerCandidate[],
  ignored: ReadonlySet<string>,
): DrawerCandidate[] {
  return candidates.filter(item => !ignored.has(item.candidateId));
}

/** 最终入库条目：必须可见（未忽略）且被勾选；忽略项绝不提交。 */
export function filterChosen(
  candidates: readonly DrawerCandidate[],
  selected: ReadonlySet<string>,
  ignored: ReadonlySet<string>,
): DrawerCandidate[] {
  return candidates.filter(item => selected.has(item.candidateId) && !ignored.has(item.candidateId));
}

/** 提交给 confirm-entities 的单项：原名固定取自 originalName，改名经 renameTo 传递。 */
export interface EntitySelectionItem {
  candidateId: string;
  kind: IngestionKind;
  name: string;
  aliases: string[];
  description: string | null;
  selected: boolean;
  renameTo: string | null;
}

/**
 * 覆盖全部候选生成 selections：只有勾选且未忽略才 `selected: true`；
 * 忽略与未勾选项仍列在清单中但标记 false，绝不入库。改名与原名分离传递。
 */
export function buildEntitySelections(
  candidates: readonly DrawerCandidate[],
  selected: ReadonlySet<string>,
  ignored: ReadonlySet<string>,
): EntitySelectionItem[] {
  return candidates.map(item => {
    const renamed = item.name.trim() && item.name.trim() !== item.originalName.trim();
    return {
      candidateId: item.candidateId,
      kind: item.kind,
      name: item.originalName,
      aliases: item.aliases,
      description: item.description,
      selected: selected.has(item.candidateId) && !ignored.has(item.candidateId),
      renameTo: renamed ? item.name.trim() : null,
    };
  });
}

/** 融光式自动写入：所有解析候选（含路人）均选中，同名复用仍由服务端决定。 */
export function buildAutomaticEntitySelections(candidates: readonly ParsedEntityCandidate[]): EntitySelectionItem[] {
  return candidates.map(item => ({
    candidateId: item.candidateId,
    kind: item.kind,
    name: item.name,
    aliases: item.aliases,
    description: item.description,
    selected: true,
    renameTo: null,
  }));
}

/** 目标集派生 canonical 文本：只序列化该集，避免把整本原文带进单集解析弹窗。 */
export function episodeCanonicalText(structure: ScriptStructure, episodeId: string): string {
  const episode = structure.episodes.find(item => item.id === episodeId);
  if (!episode) return '';
  return serializeScriptStructure({ ...structure, episodes: [episode] });
}

/** 分组全选/全消：只影响指定类型。 */
export function selectGroupCandidates(
  candidates: readonly DrawerCandidate[],
  selected: ReadonlySet<string>,
  kind: IngestionKind,
  next: boolean,
): Set<string> {
  const result = new Set(selected);
  for (const item of candidates) {
    if (item.kind !== kind) continue;
    if (next) result.add(item.candidateId); else result.delete(item.candidateId);
  }
  return result;
}

/** 按候选 id 取回条目；改名后调用方需用新名称重建候选，避免键漂移。 */
export function candidateById(candidates: readonly DrawerCandidate[], id: string): DrawerCandidate | undefined {
  return candidates.find(item => item.candidateId === id);
}

/**
 * 改名级联：把当前集所有场次里命中的旧说话人 / 地点名替换为新名。
 * 只作用于目标集，其他集保持不变；不改动候选清单之外的元素。
 */
export function cascadeEpisodeRename(
  structure: ScriptStructure,
  episodeId: string,
  oldName: string,
  newName: string,
  scope: 'speaker' | 'location',
): ScriptStructure {
  const from = oldName.trim();
  if (!from || oldName === newName) return structure;
  return {
    ...structure,
    episodes: structure.episodes.map(episode => {
      if (episode.id !== episodeId) return episode;
      return {
        ...episode,
        scenes: episode.scenes.map(scene => {
          if (scope === 'location') {
            return scene.location.trim() === from ? { ...scene, location: newName } : scene;
          }
          return {
            ...scene,
            dialogues: scene.dialogues.map(element => (
              element.characterName?.trim() === from
                ? { ...element, characterName: newName }
                : element
            )),
          };
        }),
      };
    }),
  };
}

let workbenchFallback = 0;
function workbenchUid(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
  }
  workbenchFallback += 1;
  return `${prefix}_${Date.now().toString(36)}_${workbenchFallback}`;
}

/** 在指定场次之后插入空场次，随后按位置重排整集场次编号。 */
export function insertSceneAfter(
  structure: ScriptStructure,
  episodeId: string,
  sceneId: string | null,
): ScriptStructure {
  return {
    ...structure,
    episodes: structure.episodes.map(episode => {
      if (episode.id !== episodeId) return episode;
      const blank: ScriptScene = {
        id: workbenchUid('scene'),
        sceneNumber: `${episode.episodeNumber}-${episode.scenes.length + 1}`,
        sceneHeading: '', location: '', timeOfDay: '', intExt: '', sceneDescription: '', dialogues: [],
      };
      const index = sceneId ? episode.scenes.findIndex(scene => scene.id === sceneId) : -1;
      const scenes = index < 0
        ? [...episode.scenes, blank]
        : [...episode.scenes.slice(0, index + 1), blank, ...episode.scenes.slice(index + 1)];
      return {
        ...episode,
        scenes: scenes.map((scene, sceneIndex) => ({
          ...scene,
          sceneNumber: `${episode.episodeNumber}-${sceneIndex + 1}`,
        })),
      };
    }),
  };
}

/** 删除整集：只移除目标集，其余集与既有 ID 保持不变。 */
export function removeEpisode(structure: ScriptStructure, episodeId: string): ScriptStructure {
  return { ...structure, episodes: structure.episodes.filter(episode => episode.id !== episodeId) };
}

/** 本场提炼出的说话人与地点；道具由识别清单与正文关键词匹配后传入。 */
export function summarizeScene(scene: ScriptScene): { characters: string[]; location: string } {
  const characters = [...new Set(scene.dialogues
    .filter(element => element.type === 1)
    .map(element => element.characterName?.trim() ?? '')
    .filter(Boolean))];
  return { characters, location: scene.location.trim() };
}

/** 道具名出现在本场任一元素正文中即视为本场道具。 */
export function recognizeSceneProps(scene: ScriptScene, propNames: readonly string[]): string[] {
  const content = scene.dialogues.map(element => element.content).join('\n');
  return propNames.filter(name => name.trim() && content.includes(name.trim()));
}

/** 对白缺说话人或缺台词内容，用黄标提示；旁白/动作/镜头/环境不按对白完整性判定。 */
export function isIncompleteDialogue(element: ScriptElement): boolean {
  if (element.type !== 1) return false;
  return !element.content.trim() || !element.characterName?.trim();
}

export function incompleteDialogues(scene: ScriptScene): ScriptElement[] {
  return scene.dialogues.filter(isIncompleteDialogue);
}

/** 定点拆分：以指定元素为第二场的起始元素，复用既有 splitScene 的编号与 ID 保留规则。 */
export function splitSceneAtElement(
  structure: ScriptStructure,
  episodeId: string,
  sceneId: string,
  elementId: string,
): ScriptStructure {
  const episode = structure.episodes.find(item => item.id === episodeId);
  const scene = episode?.scenes.find(item => item.id === sceneId);
  if (!scene) return structure;
  const index = scene.dialogues.findIndex(element => element.id === elementId);
  if (index <= 0) return structure;
  return splitScene(structure, episodeId, sceneId, index);
}

/** 生成解析命令 ID：一次打开内稳定生成，网络重试时复用同一个，避免重复扣费/重复建单。 */
export function newCommandId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `cmd_${crypto.randomUUID().replaceAll('-', '')}`;
  }
  return `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface RequirementMatchView {
  state: 'matched' | 'missing' | 'ambiguous';
  assetId: string | null;
  matchedBy: string | null;
  label: string;
}

/** 右栏只读匹配视图：名称 + 类型对齐服务端需求清单；找不到对应需求时记为未匹配，不伪造定妆。 */
export function matchRequirement(
  name: string,
  kind: IngestionKind,
  requirements: ReadonlyArray<{
    requirementId: string;
    kind: string;
    name: string;
    match: { assetId: string | null; matchedBy: 'name' | 'alias' | 'retrieval' | null; ambiguous: boolean };
  }> | null,
): RequirementMatchView | null {
  if (!requirements) return null;
  const requirement = requirements.find(item => item.kind === kind
    && normalizeScriptCharacterName(item.name) === normalizeScriptCharacterName(name));
  if (!requirement) return null;
  if (requirement.match.assetId) {
    return {
      state: 'matched',
      assetId: requirement.match.assetId,
      matchedBy: requirement.match.matchedBy,
      label: `已绑定资产${requirement.match.matchedBy ? ` · ${requirement.match.matchedBy}` : ''}`,
    };
  }
  if (requirement.match.ambiguous) return { state: 'ambiguous', assetId: null, matchedBy: null, label: '存在多个候选，需人工选择' };
  return { state: 'missing', assetId: null, matchedBy: null, label: '尚未绑定资产' };
}

export const ELEMENT_TYPE_LABELS: Record<ScriptElementType, string> = {
  1: '对白', 2: '动作', 3: '旁白', 4: '镜头', 5: '环境',
};

export type { ScriptEpisode };
