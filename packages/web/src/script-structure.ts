import {
  emptyScriptStructure,
  parseScriptStructure,
  serializeScriptStructure,
  type ScriptElement,
  type ScriptElementType,
  type ScriptEpisode,
  type ScriptScene,
  type ScriptStructure,
} from '@lyra/shared/dist/script-structure';

export {
  emptyScriptStructure, parseScriptStructure, serializeScriptStructure,
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
