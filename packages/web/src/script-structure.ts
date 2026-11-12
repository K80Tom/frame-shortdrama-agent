import {
  applySelectedDiffs,
  diffScriptStructures,
  emptyScriptStructure,
  episodeDiffId,
  elementDiffId,
  filterImportEntities,
  isSceneHeadingLine,
  normalizeScriptCharacterName,
  parseScriptStructure,
  planCharacterImport,
  sceneDiffId,
  serializeScriptStructure,
  type ScriptCharacterImportPlanItem,
  type ScriptDiffItem,
  type ScriptDiffKind,
  type ScriptElement,
  type ScriptElementType,
  type ScriptEpisode,
  type ScriptScene,
  type ScriptStructure,
} from '@lyra/shared/dist/script-structure';

export {
  applySelectedDiffs, diffScriptStructures, emptyScriptStructure, episodeDiffId, elementDiffId,
  filterImportEntities, isSceneHeadingLine, normalizeScriptCharacterName, parseScriptStructure,
  planCharacterImport, sceneDiffId, serializeScriptStructure,
  type ScriptCharacterImportPlanItem,
  type ScriptDiffItem, type ScriptDiffKind,
  type ScriptElement, type ScriptElementType, type ScriptEpisode, type ScriptScene, type ScriptStructure,
};

let fallback = 0;
function uid(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
  }
  fallback += 1;
  return `${prefix}_${Date.now().toString(36)}_${fallback}`;
}

function updateEpisode(structure: ScriptStructure, episodeId: string,
  update: (episode: ScriptEpisode) => ScriptEpisode): ScriptStructure {
  return { ...structure, episodes: structure.episodes.map(episode => (
    episode.id === episodeId ? update(episode) : episode
  )) };
}

function updateScene(structure: ScriptStructure, episodeId: string, sceneId: string,
  update: (scene: ScriptScene) => ScriptScene): ScriptStructure {
  return updateEpisode(structure, episodeId, episode => ({
    ...episode,
    scenes: episode.scenes.map(scene => scene.id === sceneId ? update(scene) : scene),
  }));
}

export function addEpisode(structure: ScriptStructure): ScriptStructure {
  const episodeNumber = structure.episodes.length + 1;
  return { ...structure, episodes: [...structure.episodes, {
    id: uid('episode'), episodeNumber, title: `第${episodeNumber}集`, synopsis: '',
    scenes: [{
      id: uid('scene'), sceneNumber: `${episodeNumber}-1`, sceneHeading: '',
      location: '', timeOfDay: '', intExt: '', sceneDescription: '', dialogues: [],
    }],
  }] };
}

export function addScene(structure: ScriptStructure, episodeId: string): ScriptStructure {
  return updateEpisode(structure, episodeId, episode => ({
    ...episode,
    scenes: [...episode.scenes, {
      id: uid('scene'), sceneNumber: `${episode.episodeNumber}-${episode.scenes.length + 1}`,
      sceneHeading: '', location: '', timeOfDay: '', intExt: '', sceneDescription: '', dialogues: [],
    }],
  }));
}

export function addElement(structure: ScriptStructure, episodeId: string, sceneId: string,
  type: ScriptElementType): ScriptStructure {
  return updateScene(structure, episodeId, sceneId, scene => ({
    ...scene,
    dialogues: [...scene.dialogues, {
      id: uid('element'), type, content: '',
      ...(type === 1 || type === 3 ? { characterName: '', parenthetical: '' } : {}),
    }],
  }));
}

export function addElementAfter(structure: ScriptStructure, episodeId: string, sceneId: string,
  index: number, type: ScriptElementType): ScriptStructure {
  return updateScene(structure, episodeId, sceneId, scene => {
    const item: ScriptElement = {
      id: uid('element'), type, content: '',
      ...(type === 1 || type === 3 ? { characterName: '', parenthetical: '' } : {}),
    };
    return { ...scene, dialogues: [...scene.dialogues.slice(0, index), item, ...scene.dialogues.slice(index)] };
  });
}

export function updateElement(structure: ScriptStructure, episodeId: string, sceneId: string,
  elementId: string, patch: Partial<ScriptElement>): ScriptStructure {
  return updateScene(structure, episodeId, sceneId, scene => ({
    ...scene,
    dialogues: scene.dialogues.map(item => item.id === elementId ? { ...item, ...patch } : item),
  }));
}

export function removeElement(structure: ScriptStructure, episodeId: string, sceneId: string,
  elementId: string): ScriptStructure {
  return updateScene(structure, episodeId, sceneId, scene => ({
    ...scene, dialogues: scene.dialogues.filter(item => item.id !== elementId),
  }));
}

export function removeScene(structure: ScriptStructure, episodeId: string, sceneId: string): ScriptStructure {
  return updateEpisode(structure, episodeId, episode => ({
    ...episode, scenes: episode.scenes.filter(scene => scene.id !== sceneId),
  }));
}

export function patchEpisode(structure: ScriptStructure, episodeId: string,
  patch: Partial<Pick<ScriptEpisode, 'title' | 'synopsis' | 'episodeNumber'>>): ScriptStructure {
  return updateEpisode(structure, episodeId, episode => ({ ...episode, ...patch }));
}

export function patchScene(structure: ScriptStructure, episodeId: string, sceneId: string,
  patch: Partial<Pick<ScriptScene, 'sceneNumber' | 'sceneHeading' | 'location' | 'timeOfDay' | 'intExt' | 'sceneDescription'>>): ScriptStructure {
  return updateScene(structure, episodeId, sceneId, scene => ({ ...scene, ...patch }));
}

/** 合并相邻两场：保留当前场次时空，拼接元素与场景描述，并按顺序重排场次编号。 */
export function mergeScenes(structure: ScriptStructure, episodeId: string, sceneId: string): ScriptStructure {
  return updateEpisode(structure, episodeId, episode => {
    const index = episode.scenes.findIndex(scene => scene.id === sceneId);
    const current = episode.scenes[index];
    const next = episode.scenes[index + 1];
    if (!current || !next) return episode;
    const merged: ScriptScene = {
      ...current,
      sceneHeading: current.sceneHeading.trim() || next.sceneHeading,
      location: current.location.trim() || next.location,
      timeOfDay: current.timeOfDay.trim() || next.timeOfDay,
      intExt: current.intExt || next.intExt,
      sceneDescription: [current.sceneDescription.trim(), next.sceneDescription.trim()].filter(Boolean).join('\n'),
      dialogues: [...current.dialogues, ...next.dialogues],
    };
    return {
      ...episode,
      scenes: episode.scenes
        .filter(scene => scene.id !== next.id)
        .map((scene, sceneIndex) => ({
          ...(scene.id === current.id ? merged : scene),
          sceneNumber: `${episode.episodeNumber}-${sceneIndex + 1}`,
        })),
    };
  });
}

/**
 * 把长场次拆成两场：默认按元素列表中段切分，第二场继承原场次的时空与标题，
 * 元素 id 保持不变（只是移动归属），随后按顺序重排整场编号。
 */
export function splitScene(structure: ScriptStructure, episodeId: string, sceneId: string,
  splitIndex?: number): ScriptStructure {
  return updateEpisode(structure, episodeId, episode => {
    const index = episode.scenes.findIndex(scene => scene.id === sceneId);
    const current = episode.scenes[index];
    if (!current || current.dialogues.length < 2) return episode;
    const at = Math.min(Math.max(splitIndex ?? Math.floor(current.dialogues.length / 2), 1), current.dialogues.length - 1);
    const first: ScriptScene = { ...current, dialogues: current.dialogues.slice(0, at) };
    const second: ScriptScene = {
      ...current,
      id: uid('scene'),
      sceneDescription: '',
      dialogues: current.dialogues.slice(at),
    };
    return {
      ...episode,
      scenes: episode.scenes.flatMap((scene, sceneIndex) => sceneIndex === index ? [first, second] : [scene])
        .map((scene, sceneIndex) => ({ ...scene, sceneNumber: `${episode.episodeNumber}-${sceneIndex + 1}` })),
    };
  });
}

/** 步骤二概览栏：总场次数、核心角色数（排除“旁白”）与对白句数。 */
export function summarizeScriptStructure(structure: ScriptStructure): { scenes: number; characters: number; dialogues: number } {
  const names = new Set<string>();
  let scenes = 0;
  let dialogues = 0;
  for (const episode of structure.episodes) {
    scenes += episode.scenes.length;
    for (const scene of episode.scenes) {
      for (const element of scene.dialogues) {
        if (element.type === 1) dialogues += 1;
        if (element.type !== 1 && element.type !== 3) continue;
        const name = element.characterName?.trim() ?? '';
        if (name && name !== '旁白') names.add(name);
      }
    }
  }
  return { scenes, characters: names.size, dialogues };
}

/** 录入区展示用：不含空白的字符数。 */
export function countScriptCharacters(rawText: string): number {
  return rawText.replace(/\s+/g, '').length;
}

/**
 * 录入区展示用：按行预估场次数量。
 * 直接复用 parseScriptStructure 的场次标题判定，避免两套规则漂移。
 */
export function estimateSceneCount(rawText: string): number {
  let count = 0;
  for (const line of rawText.replace(/\r\n?/g, '\n').split('\n')) {
    if (isSceneHeadingLine(line)) count += 1;
  }
  return count;
}
