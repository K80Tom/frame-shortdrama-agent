import { buildStoryboardVideoBasePrompt, storyboardDialogueTimingIssue, storyboardNarrativeBeats, storyboardSceneAtmosphere, type AssetRecord, type CharacterVoiceAsset, type StoryboardEditRequest } from '@lyra/shared';
import type { FactPlan } from '../facts-editor';
import type { EpisodeView, StoryboardRevision, StoryboardScene, StoryboardShot } from './types';

/** Only a storyboard from the active script and facts may seed a generated revision. */
export function storyboardGenerationBase(boards: StoryboardRevision[], plan: FactPlan | null,
  selectedBoardId: string): StoryboardRevision | null {
  if (!plan) return null;
  const compatible = boards.filter(board => board.scriptVersionId === plan.scriptVersionId && board.sourcePlanRevisionId === plan.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return compatible.find(board => board.id === selectedBoardId) ?? compatible[0] ?? null;
}

/** Fill only missing bindings from the character asset used by each shot. */
export function automaticAssetVoiceBindings(shots: StoryboardShot[], voiceAssets: CharacterVoiceAsset[],
  dialogues: FactPlan['content']['dialogues']): { shots: StoryboardShot[]; changed: boolean } {
  let changed = false;
  const next = shots.map(shot => {
    const speakers = new Set((shot.dialogueIds ?? []).map(id => dialogues.find(line => line.id === id))
      .filter(line => line !== undefined).map(line => storyboardDialogueSpeakerId(line)).filter(id => id !== null));
    let bindings = shot.voiceBindings ?? [];
    let shotChanged = false;
    for (const speaker of speakers) {
      if (bindings.some(item => item.speakerEntityId === speaker)) continue;
      const assetIds = new Set((shot.assetRefs ?? []).filter(ref => ref.entityId === speaker && ref.kind === 'character').map(ref => ref.assetId));
      const saved = voiceAssets.find(item => assetIds.has(item.assetId) && item.binding.speakerEntityId === speaker);
      if (!saved) continue;
      bindings = [...bindings, structuredClone(saved.binding)]; changed = true; shotChanged = true;
    }
    return shotChanged ? { ...shot, voiceBindings: bindings } : shot;
  });
  return { shots: changed ? next : shots, changed };
}

export function retainedPlanSceneIds(episodes: EpisodeView[], plan: FactPlan | null, currentEpisodeIds: Set<string> | null): Set<string> {
  const allIds = new Set((plan?.content.scenes ?? []).map(scene => scene.id));
  if (!plan || !currentEpisodeIds) return allIds;
  const ordered = [...plan.content.scenes].sort((a, b) => a.order - b.order);
  const retained = new Set<string>();
  let offset = 0;
  for (const episode of [...episodes].sort((a, b) => a.episodeNumber - b.episodeNumber)) {
    if (currentEpisodeIds.has(episode.id)) {
      for (const scene of ordered.slice(offset, offset + episode.scenes.length)) retained.add(scene.id);
    }
    offset += episode.scenes.length;
  }
  return retained;
}

export function episodeSceneIds(episodes: EpisodeView[], plan: FactPlan | null, episodeNumber: number,
  currentEpisodeIds: Set<string> | null = null): Set<string> {
  if (!plan) return new Set();
  const ordered = [...plan.content.scenes].sort((a, b) => a.order - b.order);
  let offset = 0;
  for (const episode of [...episodes].sort((a, b) => a.episodeNumber - b.episodeNumber)) {
    if (episode.episodeNumber === episodeNumber) {
      if (currentEpisodeIds && !currentEpisodeIds.has(episode.id)) return new Set();
      return new Set(ordered.slice(offset, offset + episode.scenes.length).map(scene => scene.id));
    }
    offset += episode.scenes.length;
  }
  return new Set();
}

export function coverageForScenes(shots: StoryboardShot[], scenes: StoryboardScene[], dialogues: FactPlan['content']['dialogues']) {
  const sceneIds = new Set(scenes.map(scene => scene.id));
  const dialogueIds = new Set(dialogues.filter(line => sceneIds.has(line.sceneId)).map(line => line.id));
  const narrativeBeats = storyboardNarrativeBeats(scenes);
  const narrativeBeatIds = new Set(narrativeBeats.map(beat => beat.id));
  const coveredScenes = new Set(shots.filter(shot => sceneIds.has(shot.sceneId)).map(shot => shot.sceneId));
  const coveredDialogues = new Set(shots.flatMap(shot => shot.dialogueIds).filter(id => dialogueIds.has(id)));
  const narrativeBindings = shots.filter(shot => sceneIds.has(shot.sceneId)).flatMap(shot => shot.narrativeBeatIds ?? []);
  const coveredNarrativeBeats = new Set(narrativeBindings.filter(id => narrativeBeatIds.has(id)));
  return {
    scenes: coveredScenes.size,
    sceneTotal: sceneIds.size,
    dialogues: coveredDialogues.size,
    dialogueTotal: dialogueIds.size,
    narrativeBeats: coveredNarrativeBeats.size,
    narrativeBeatTotal: narrativeBeatIds.size,
    complete: sceneIds.size > 0 && coveredScenes.size === sceneIds.size && coveredDialogues.size === dialogueIds.size,
  };
}

export function backfillStoryboardNarrativeBeats(shots: StoryboardShot[], scenes: StoryboardScene[]) {
  const beats = storyboardNarrativeBeats(scenes);
  const beatOrder = new Map(beats.map((beat, index) => [beat.id, index]));
  const next = shots.map(shot => ({ ...shot, narrativeBeatIds: [...shot.narrativeBeatIds ?? []] }));
  const bindings = next.flatMap((shot, shotIndex) => (shot.narrativeBeatIds ?? [])
    .flatMap(id => beatOrder.has(id) ? [{ id, shotIndex, beatIndex: beatOrder.get(id)! }] : []));
  const assigned = new Set(bindings.map(binding => binding.id));
  let added = 0;
  for (const [beatIndex, beat] of beats.entries()) {
    if (assigned.has(beat.id)) continue;
    let firstShot = 0;
    let lastShot = next.length - 1;
    for (const binding of bindings) {
      if (binding.beatIndex < beatIndex) firstShot = Math.max(firstShot, binding.shotIndex);
      if (binding.beatIndex > beatIndex) lastShot = Math.min(lastShot, binding.shotIndex);
    }
    const shotIndex = next.findIndex((shot, index) => index >= firstShot && index <= lastShot
      && shot.sceneId === beat.sceneId && shot.sourceRefs.some(ref => ref.scriptVersionId === beat.sourceRef.scriptVersionId
        && ref.start <= beat.sourceRef.start && ref.end >= beat.sourceRef.end));
    if (shotIndex < 0) continue;
    const ids = next[shotIndex]!.narrativeBeatIds!;
    const insertAt = ids.findIndex(id => (beatOrder.get(id) ?? Number.POSITIVE_INFINITY) > beatIndex);
    ids.splice(insertAt < 0 ? ids.length : insertAt, 0, beat.id);
    bindings.push({ id: beat.id, shotIndex, beatIndex });
    assigned.add(beat.id);
    added += 1;
  }
  return { shots: next, added, missing: beats.filter(beat => !assigned.has(beat.id)).map(beat => beat.id) };
}

export function boardCoverage(board: StoryboardRevision | null, plan: FactPlan | null) {
  return coverageForScenes(board?.shots ?? [], (plan?.content.scenes ?? []) as StoryboardScene[], plan?.content.dialogues ?? []);
}

export function storyboardDraftIssue(shots: StoryboardShot[], scenes: Array<Pick<StoryboardScene, 'id' | 'order'>>): string | null {
  for (const shot of shots) {
    const sceneOrder = scenes.find(scene => scene.id === shot.sceneId)?.order ?? '?';
    const label = `场 ${sceneOrder} · 镜 ${shot.order}`;
    if (!shot.design.visualDescription.trim()) return `${label}：画面描述不能为空，请补充后再保存。`;
    if (!shot.design.shotSize.trim()) return `${label}：景别不能为空。`;
    if (!shot.design.cameraMovement.trim()) return `${label}：运镜不能为空。`;
    if (!Number.isInteger(shot.design.durationMs) || shot.design.durationMs < 100 || shot.design.durationMs > 60000) {
      return `${label}：时长需为 0.1–60 秒。`;
    }
    if (!shot.sourceRefs.length) return `${label}：至少保留一段原文引用。`;
    if (shot.lastFrameAssetId && !shot.firstFrameAssetId) return `${label}：请先设置首帧，再设置尾帧。`;
    if (shot.firstFrameAssetId && shot.firstFrameAssetId === shot.lastFrameAssetId) return `${label}：首帧和尾帧不能使用同一图片资产。`;
  }
  return null;
}

export function storyboardEditPayload(shots: StoryboardShot[]): StoryboardEditRequest {
  return { shots: shots.map(shot => ({
    id: shot.id, sceneId: shot.sceneId, order: shot.order,
    visualDescription: shot.design.visualDescription, shotSize: shot.design.shotSize,
    cameraMovement: shot.design.cameraMovement, durationMs: shot.design.durationMs,
    ...(shot.design.cameraAngle?.trim() ? { cameraAngle: shot.design.cameraAngle.trim() } : {}),
    ...(shot.design.sound?.trim() ? { sound: shot.design.sound.trim() } : {}),
    ...(shot.design.visualBeats?.length ? { visualBeats: shot.design.visualBeats.map(beat => beat.trim()).filter(Boolean) } : {}),
    ...(shot.design.atmosphere?.trim() ? { atmosphere: shot.design.atmosphere.trim() } : {}),
    ...(shot.design.timeline ? { timeline: true } : {}),
    sourceRefs: shot.sourceRefs, dialogueIds: shot.dialogueIds, narrativeBeatIds: shot.narrativeBeatIds ?? [],
    ...(shot.firstFrameAssetId ? { firstFrameAssetId: shot.firstFrameAssetId } : {}),
    ...(shot.lastFrameAssetId ? { lastFrameAssetId: shot.lastFrameAssetId } : {}),
    assetRefs: shot.assetRefs ?? [], voiceBindings: shot.voiceBindings ?? [],
  })) };
}

export function storyboardFrameImportInput(shot: StoryboardShot, scene: StoryboardScene,
  frame: 'first' | 'last', contentBase64: string) {
  return { kind: 'prop' as const, name: `${scene.title.value.slice(0, 80)} · 镜 ${shot.order} · ${frame === 'first' ? '首帧' : '尾帧'}`,
    description: '分镜镜头首尾帧控制图片，不作为角色、场景或道具参考。', contentBase64 };
}

export function reindexSceneShots(shots: StoryboardShot[], sceneId: string): StoryboardShot[] {
  let order = 0;
  return shots.map(shot => shot.sceneId === sceneId ? { ...shot, order: ++order } : shot);
}

export function relevantEntityIds(scene: StoryboardScene | undefined, shot: StoryboardShot | null, plan: FactPlan | null): Set<string> {
  const ids = new Set<string>(scene?.characterIds ?? []);
  if (scene?.locationId) ids.add(scene.locationId);
  if (scene && shot && plan) {
    for (const prop of plan.content.props) {
      if (prop.sourceRefs.some(ref => shot.sourceRefs.some(source => ref.scriptVersionId === source.scriptVersionId
        && ref.start < source.end && source.start < ref.end))) ids.add(prop.id);
    }
  }
  return ids;
}

export function shotDuration(seconds: number): number {
  return Math.max(0.1, Math.min(60, Math.round(seconds * 10) * 100));
}

export function storyboardDialogueSpeakerId(line: FactPlan['content']['dialogues'][number]): string | null {
  if ('speakerEntityId' in line && typeof storyboardDialogueSpeakerId(line) === 'string') return storyboardDialogueSpeakerId(line);
  return line.speakerId ?? null;
}

export function shotVideoPromptPreview(shot: StoryboardShot, plan: FactPlan, assets: AssetRecord[]): { prompt: string; timingIssue: string | null } {
  const dialogueIds = new Set(shot.dialogueIds);
  const dialogues = plan.content.dialogues.filter(line => dialogueIds.has(line.id)).map(line => ({
    speaker: plan.content.characters.find(character => character.id === storyboardDialogueSpeakerId(line))?.name.value ?? null,
    quote: line.sourceRef.quote,
  }));
  const entities = [...plan.content.characters.map(entity => ({ ...entity, kind: 'character' as const })),
    ...plan.content.locations.map(entity => ({ ...entity, kind: 'location' as const })),
    ...plan.content.props.map(entity => ({ ...entity, kind: 'prop' as const }))];
  const grouped = new Map<string, string[]>();
  for (const ref of shot.assetRefs ?? []) {
    const entity = entities.find(item => item.id === ref.entityId);
    const label = `${ref.kind === 'character' ? '角色' : ref.kind === 'location' ? '场景' : '道具'}「${entity?.name.value
      ?? assets.find(asset => asset.id === ref.assetId)?.name ?? ref.assetId}」`;
    grouped.set(ref.assetId, [...grouped.get(ref.assetId) ?? [], label]);
  }
  const frameIds = new Set([shot.firstFrameAssetId, shot.lastFrameAssetId].filter(Boolean));
  const references = [...grouped].filter(([assetId]) => !frameIds.has(assetId))
    .map(([assetId, labels]) => ({ assetId, names: labels.map(label => label.replace(/^[^「]*「|」$/gu, '')) }));
  const speakerOrder = new Map(shot.dialogueIds.map((dialogueId, index) => {
    const line = plan.content.dialogues.find(item => item.id === dialogueId);
    const speakerId = line ? storyboardDialogueSpeakerId(line) : null;
    return [speakerId, index] as const;
  }).filter((entry): entry is readonly [string, number] => Boolean(entry[0])));
  const voiceBindings = [...shot.voiceBindings ?? []].sort((left, right) =>
    (speakerOrder.get(left.speakerEntityId) ?? 0) - (speakerOrder.get(right.speakerEntityId) ?? 0))
    .map(binding => ({ speakerName: plan.content.characters.find(character => character.id === binding.speakerEntityId)?.name.value ?? '',
      profileId: binding.profile.id }));
  const scene = plan.content.scenes.find(item => item.id === shot.sceneId);
  const narrativeBeatIds = new Set(shot.narrativeBeatIds ?? []);
  const sceneBeats = scene ? storyboardNarrativeBeats([scene]) : [];
  const narrativeBeats = sceneBeats.filter(beat => narrativeBeatIds.has(beat.id));
  const narrativeExclusions = sceneBeats.filter(beat => beat.kind === 'narration').map(beat => beat.text);
  return {
    prompt: buildStoryboardVideoBasePrompt({ shot, dialogues, references, voiceBindings,
      narrativeBeats, narrativeExclusions, atmosphere: storyboardSceneAtmosphere(scene) }),
    timingIssue: storyboardDialogueTimingIssue(shot.design.durationMs, dialogues),
  };
}

export function boardLabel(board: StoryboardRevision, activeId: string | null, planId: string | null): string {
  const scope = board.scope?.kind === 'episode' ? `第 ${board.scope.episodeNumber} 集 · ` : '';
  const status = board.id === activeId ? '已采用' : board.sourcePlanRevisionId !== planId ? '旧版本 · 只读' : '候选';
  const time = new Date(board.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `${scope}${status} · ${time} · ${board.id.slice(-6)}`;
}
