import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Film, Grid2X2, Info, List, LoaderCircle, Music2, Save, Sparkles, Video } from 'lucide-react';
import { type AssetRecord, type CharacterVoiceAsset, type StoryboardVoiceBinding } from '@lyra/shared';
import { Modal, Notice } from './components';
import { getStoryboardModel, getCurrentScriptVersion, getScriptVersion, getProject, listPlanRevisions, request, type ProjectRecord, type ScriptVersionRecord } from './project-workspace-api';
import type { FactPlan } from './facts-editor';
import StoryboardEpisodeSidebar from './storyboard/StoryboardEpisodeSidebar';
import StoryboardShotList from './storyboard/StoryboardShotList';
import StoryboardInspector from './storyboard/StoryboardInspector';
import { automaticAssetVoiceBindings, coverageForScenes, episodeSceneIds, retainedPlanSceneIds, reindexSceneShots, storyboardDraftIssue, storyboardEditPayload, storyboardFrameImportInput, storyboardGenerationBase } from './storyboard/workbench';
import { assetFileError, fileBase64 } from './asset-library';
import { defaultProductionForm, productionCreateBody, productionRunActive, saveStoryboardProductionIntent } from './production-automation';
import { fetchMediaModelConnections, MediaGenerationDialog, MediaRunNotice, useMediaProductionRun, type MediaModelConnections } from './media-generation';
import type { EpisodeView, StoryboardAssetRef, StoryboardRevision, StoryboardScene, StoryboardShot } from './storyboard/types';
import './storyboard/storyboard-workspace.css';

export function isConflictError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'status' in error && error.status === 409;
}

export function classifyStoryboards<T extends { id: string; sourcePlanRevisionId: string; createdAt: string }>(
  items: T[], activeId: string | null, activePlanId: string | null,
): Array<T & { status: 'active' | 'candidate' | 'stale'; adopted: boolean; stale: boolean }> {
  const latest = items.filter(item => item.sourcePlanRevisionId === activePlanId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  return items.map(item => ({ ...item,
    status: item.id === activeId ? 'active' : item.id === latest?.id ? 'candidate' : 'stale',
    adopted: item.id === activeId, stale: item.sourcePlanRevisionId !== activePlanId }));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}

async function audioDurationMs(file: File): Promise<number> {
  if (/\.wav$/iu.test(file.name)) {
    const buffer = await file.slice(0, 64 * 1024).arrayBuffer();
    const view = new DataView(buffer);
    if (buffer.byteLength >= 44 && view.getUint32(0, false) === 0x52494646 && view.getUint32(8, false) === 0x57415645) {
      let offset = 12; let byteRate = 0; let dataBytes = 0;
      while (offset + 8 <= buffer.byteLength) {
        const size = view.getUint32(offset + 4, true); const type = view.getUint32(offset, false);
        if (offset + 8 + size > buffer.byteLength && type !== 0x64617461) break;
        if (type === 0x666d7420 && size >= 16) byteRate = view.getUint32(offset + 16, true);
        if (type === 0x64617461) { dataBytes = size; break; }
        offset += 8 + size + (size % 2);
      }
      if (byteRate > 0 && dataBytes > 0) {
        const duration = Math.round(dataBytes / byteRate * 1000);
        if (duration > 0) return duration;
      }
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file); const audio = document.createElement('audio');
    const finish = (callback: () => void) => { window.clearTimeout(timeout); URL.revokeObjectURL(url); callback(); };
    const timeout = window.setTimeout(() => finish(() => reject(new Error('读取音频时长超时，请重新导出为标准 WAV 或 MP3。'))), 10_000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => { const duration = Math.round(audio.duration * 1000);
      finish(() => { if (Number.isFinite(duration) && duration > 0) resolve(duration); else reject(new Error('无法读取音频时长。')); }); };
    audio.onerror = () => finish(() => reject(new Error('无法解码该 WAV/MP3 音频。')));
    audio.src = url;
  });
}

export default function ProjectStoryboardWorkspace({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [script, setScript] = useState<ScriptVersionRecord | null>(null);
  const [planScript, setPlanScript] = useState<ScriptVersionRecord | null>(null);
  const [plan, setPlan] = useState<FactPlan | null>(null);
  const [boards, setBoards] = useState<StoryboardRevision[]>([]);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [voiceAssets, setVoiceAssets] = useState<CharacterVoiceAsset[]>([]);
  const [model, setModel] = useState<{ model: string; connectionRevision: string; configured: boolean } | null>(null);
  const [boardId, setBoardId] = useState('');
  const [shots, setShots] = useState<StoryboardShot[]>([]);
  const [dirty, setDirty] = useState(false);
  const [episodeNumber, setEpisodeNumber] = useState(1);
  const [selectedShotId, setSelectedShotId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [generateTarget, setGenerateTarget] = useState<number | 'project' | null>(null);
  const [generating, setGenerating] = useState<number | 'project' | null>(null);
  const [allowPaid, setAllowPaid] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [frameUploading, setFrameUploading] = useState<'first' | 'last' | null>(null);
  const [voiceUploading, setVoiceUploading] = useState(false);
  const [selectedSceneId, setSelectedSceneId] = useState('');
  const [viewMode, setViewMode] = useState<'card' | 'table'>('card');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth >= 1400);
  const [mediaModels, setMediaModels] = useState<MediaModelConnections | null>(null);
  const [videoTarget, setVideoTarget] = useState<'episode' | string | null>(null);
  const videoMedia = useMediaProductionRun(projectId, 'video');

  const load = useCallback(async () => {
    setError('');
    try {
      const [projectValue, scriptValue, plans, boardResult, assetResult, modelValue, voiceResult, mediaModelValue] = await Promise.all([
        getProject(projectId), getCurrentScriptVersion(projectId), listPlanRevisions(projectId),
        request<{ items: StoryboardRevision[] }>(`/projects/${encodeURIComponent(projectId)}/storyboards`),
        request<{ assets: AssetRecord[] }>('/assets'), getStoryboardModel(),
        request<{ items: CharacterVoiceAsset[] }>(`/voice-references?projectId=${encodeURIComponent(projectId)}`), fetchMediaModelConnections(),
      ]);
      const items = boardResult.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const activePlan = plans.find(item => item.id === projectValue.activePlanRevisionId) ?? null;
      const adoptedScript = activePlan
        ? (scriptValue?.id === activePlan.scriptVersionId ? scriptValue : await getScriptVersion(projectId, activePlan.scriptVersionId))
        : null;
      setProject(projectValue); setScript(scriptValue); setPlanScript(adoptedScript); setPlan(activePlan); setBoards(items);
      setAssets(assetResult.assets); setModel(modelValue); setVoiceAssets(voiceResult.items); setMediaModels(mediaModelValue);
      setBoardId(current => {
        if (items.some(item => item.id === current)) return current;
        return items.find(item => item.id === projectValue.activeStoryboardRevisionId)?.id
          ?? items.find(item => item.sourcePlanRevisionId === activePlan?.id)?.id ?? items[0]?.id ?? '';
      });
    } catch (cause) { setError(errorText(cause)); } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);
  async function refresh() {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  }
  const board = boards.find(item => item.id === boardId) ?? null;
  useEffect(() => {
    const initial = structuredClone(board?.shots ?? []);
    const filled = automaticAssetVoiceBindings(initial, voiceAssets, plan?.content.dialogues ?? []);
    setShots(filled.shots);
    setDirty(filled.changed);
    setSelectedShotId(board?.shots[0]?.id ?? '');
    setSelectedSceneId('');
  }, [boardId]); // 版本切换才重置草稿；assets/boards 刷新不会覆盖正在编辑的内容。

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  const episodes = useMemo<EpisodeView[]>(() => {
    const adoptedEpisodes = planScript?.structure?.episodes;
    if (adoptedEpisodes?.length) return adoptedEpisodes;
    if (script?.structure?.episodes?.length) return script.structure.episodes;
    return plan?.content.scenes.length ? [{ id: 'project', episodeNumber: 1, title: '全项目', synopsis: '',
      scenes: plan.content.scenes.map((scene, index) => ({ id: scene.id, sceneNumber: String(index + 1) })) }] : [];
  }, [script, planScript, plan]);
  const retainedEpisodeIds = useMemo(() => {
    if (!script || !planScript || script.id === planScript.id || !script.structure?.episodes || !planScript.structure?.episodes) return null;
    return new Set(script.structure.episodes.map(episode => episode.id));
  }, [script, planScript]);
  const retainedSceneIds = useMemo(() => retainedPlanSceneIds(episodes, plan, retainedEpisodeIds), [episodes, plan, retainedEpisodeIds]);
  const retainedScenes = useMemo(() => (plan?.content.scenes ?? []).filter(scene => retainedSceneIds.has(scene.id)) as StoryboardScene[], [plan, retainedSceneIds]);
  const prunedShots = useMemo(() => shots.filter(shot => retainedSceneIds.has(shot.sceneId)), [shots, retainedSceneIds]);
  const pruneRequired = prunedShots.length !== shots.length;
  const sceneIds = useMemo(() => episodeSceneIds(episodes, plan, episodeNumber, retainedEpisodeIds), [episodes, plan, episodeNumber, retainedEpisodeIds]);
  const scenes = useMemo(() => (plan?.content.scenes ?? []).filter(scene => sceneIds.has(scene.id)) as StoryboardScene[], [plan, sceneIds]);
  const visibleScenes = useMemo(() => selectedSceneId ? scenes.filter(scene => scene.id === selectedSceneId) : scenes, [scenes, selectedSceneId]);
  const visibleShots = useMemo(() => {
    const visibleSceneIds = new Set(visibleScenes.map(scene => scene.id));
    return shots.filter(shot => visibleSceneIds.has(shot.sceneId));
  }, [shots, visibleScenes]);
  const selectedShot = visibleShots.find(shot => shot.id === selectedShotId) ?? visibleShots[0] ?? null;
  const voiceLibrary = useMemo(() => [...voiceAssets.map(item => item.binding), ...prunedShots.flatMap(shot => shot.voiceBindings ?? [])]
    .filter((binding, index, all) => all.findIndex(other => other.speakerEntityId === binding.speakerEntityId
      && other.profile.id === binding.profile.id) === index), [prunedShots, voiceAssets]);
  useEffect(() => {
    const filled = automaticAssetVoiceBindings(shots, voiceAssets, plan?.content.dialogues ?? []);
    if (!filled.changed) return;
    setShots(filled.shots); setDirty(true);
    setNotice('已从人物资产自动装填音色；保存候选后进入正式分镜。');
  }, [voiceAssets]);
  const selectedScene = plan?.content.scenes.find(scene => scene.id === selectedShot?.sceneId) as StoryboardScene | undefined;
  const stale = !!board && (!!plan && (board.sourcePlanRevisionId !== plan.id || board.scriptVersionId !== plan.scriptVersionId));
  const generationBase = storyboardGenerationBase(boards, plan, boardId);
  const coverage = coverageForScenes(prunedShots, retainedScenes, plan?.content.dialogues ?? []);
  const adopted = !!board && board.id === project?.activeStoryboardRevisionId;
  const currentEpisode = episodes.find(item => item.episodeNumber === episodeNumber
    && (!retainedEpisodeIds || retainedEpisodeIds.has(item.id)))
    ?? episodes.find(item => !retainedEpisodeIds || retainedEpisodeIds.has(item.id));
  useEffect(() => {
    if (currentEpisode && currentEpisode.episodeNumber !== episodeNumber) {
      setEpisodeNumber(currentEpisode.episodeNumber); setSelectedSceneId(''); setSelectedShotId('');
    }
  }, [currentEpisode, episodeNumber]);

  function chooseBoard(id: string) {
    if (dirty && !window.confirm('当前草稿尚未保存。切换版本会丢弃这些修改，是否继续？')) return;
    setBoardId(id);
  }
  function chooseEpisode(number: number) {
    setEpisodeNumber(number);
    setSelectedSceneId('');
    setSelectedShotId('');
  }
  function chooseScene(number: number, sceneId: string) {
    setEpisodeNumber(number);
    setSelectedSceneId(sceneId);
    setSelectedShotId(shots.find(shot => shot.sceneId === sceneId)?.id ?? '');
  }
  function updateShot(id: string, patch: Partial<StoryboardShot['design']>) {
    setShots(current => current.map(shot => shot.id === id ? { ...shot, design: { ...shot.design, ...patch } } : shot));
    setDirty(true); setNotice('');
  }
  function updateShotField(id: string, field: 'visualDescription' | 'shotSize' | 'cameraMovement' | 'cameraAngle' | 'sound' | 'duration' | 'timeline', value: string | number | boolean) {
    if (field === 'duration') updateShot(id, { durationMs: Number(value) * 1000 });
    else if (field === 'timeline') updateShot(id, { timeline: Boolean(value) });
    else updateShot(id, { [field]: value });
  }
  function addShot(sceneId: string) {
    const scene = plan?.content.scenes.find(item => item.id === sceneId);
    if (!scene) return;
    const id = `shot_draft_${crypto.randomUUID().replaceAll('-', '')}`;
    const order = Math.max(0, ...shots.filter(shot => shot.sceneId === sceneId).map(shot => shot.order)) + 1;
    const shot: StoryboardShot = { id, sceneId, order, design: { origin: 'designSuggestion',
      visualDescription: scene.sourceRefs.map(ref => ref.quote).join('\n').slice(0, 3000) || scene.title.value,
      shotSize: '中景', cameraMovement: '固定', cameraAngle: '平视', sound: '', durationMs: 3000 }, sourceRefs: scene.sourceRefs.slice(0, 3), dialogueIds: [], narrativeBeatIds: [], assetRefs: [] };
    setShots(current => [...current, shot]); setSelectedShotId(id); setDirty(true);
  }
  function deleteShot(id: string) {
    const shot = shots.find(item => item.id === id);
    if (!shot) return;
    setShots(current => reindexSceneShots(current.filter(item => item.id !== id), shot.sceneId));
    setSelectedShotId(''); setDirty(true);
  }
  function updateAsset(ref: StoryboardAssetRef, assetId: string) {
    if (!selectedShot) return;
    setShots(current => current.map(shot => {
      if (shot.id !== selectedShot.id) return shot;
      const rest = (shot.assetRefs ?? []).filter(item => item.entityId !== ref.entityId);
      return { ...shot, assetRefs: assetId ? [...rest, { entityId: ref.entityId, kind: ref.kind, assetId }] : rest };
    }));
    setDirty(true);
  }
  function updateFrame(frame: 'first' | 'last', assetId: string) {
    if (!selectedShot) return;
    setShots(current => current.map(shot => {
      if (shot.id !== selectedShot.id) return shot;
      const next = { ...shot };
      const key = frame === 'first' ? 'firstFrameAssetId' : 'lastFrameAssetId';
      if (assetId) next[key] = assetId;
      else delete next[key];
      if (frame === 'first' && !assetId) delete next.lastFrameAssetId;
      return next;
    }));
    setDirty(true); setNotice(''); setError('');
  }
  async function uploadFrame(frame: 'first' | 'last', file: File) {
    if (!selectedShot || !selectedScene || frameUploading) return;
    const issue = assetFileError(file);
    if (issue) { setError(issue); return; }
    setFrameUploading(frame); setError(''); setNotice('');
    try {
      const input = storyboardFrameImportInput(selectedShot, selectedScene, frame, await fileBase64(file));
      const asset = await request<AssetRecord>('/assets/import', { method: 'POST', body: input });
      setAssets(current => [asset, ...current.filter(item => item.id !== asset.id)]);
      updateFrame(frame, asset.id);
      setNotice(`${frame === 'first' ? '首帧' : '尾帧'}图片已导入本地资产库；请保存为新候选以持久化镜头绑定。`);
    } catch (cause) { setError(errorText(cause)); } finally { setFrameUploading(null); }
  }
  function selectVoice(speakerEntityId: string, profileId: string) {
    if (!selectedShot) return;
    const binding = voiceLibrary.find(item => item.speakerEntityId === speakerEntityId && item.profile.id === profileId);
    setShots(current => current.map(shot => {
      if (shot.id !== selectedShot.id) return shot;
      const rest = (shot.voiceBindings ?? []).filter(item => item.speakerEntityId !== speakerEntityId);
      return { ...shot, voiceBindings: binding ? [...rest, binding] : rest };
    }));
    setDirty(true); setNotice(''); setError('');
  }
  async function uploadVoice(speakerEntityId: string, assetId: string, file: File, options: { displayName: string }) {
    if (!selectedShot || !plan || voiceUploading) return;
    if (!assetId) { setError('请先在上方绑定人物图片资产，再上传音色。'); return; }
    if (file.size < 1 || file.size > 16 * 1024 * 1024 || !/\.(wav|mp3)$/iu.test(file.name)) {
      setError('请选择 16 MiB 以内的 WAV 或 MP3 音色样本。'); return;
    }
    setVoiceUploading(true); setError(''); setNotice('');
    try {
      const character = plan.content.characters.find(item => item.id === speakerEntityId);
      if (!character) throw new Error('找不到对应对白人物。');
      const binding = await request<StoryboardVoiceBinding>('/voice-references', { method: 'POST', body: {
        speakerEntityId, projectId, assetId, displayName: options.displayName || character.name.value, language: 'zh-CN',
        format: file.name.toLowerCase().endsWith('.mp3') ? 'mp3' : 'wav', durationMs: await audioDurationMs(file),
        audioBase64: await fileBase64(file), attributes: { gender: null, age: null, style: [] },
      } });
      setVoiceAssets(current => [...current.filter(item => item.assetId !== assetId), { assetId, binding }]);
      setShots(current => current.map(shot => shot.id === selectedShot.id
        ? { ...shot, voiceBindings: [...(shot.voiceBindings ?? []).filter(item => item.speakerEntityId !== speakerEntityId), binding] }
        : shot));
      setDirty(true);
      setNotice(binding.reference.provider === 'local'
        ? '音色已保存到人物资产并自动装填；请保存候选。正式供应商使用仍需配置公网对象存储。'
        : '音色已保存到人物资产并自动装填；请保存分镜候选。');
    } catch (cause) { setError(errorText(cause)); } finally { setVoiceUploading(false); }
  }
  function openGeneration(target: number | 'project') {
    setAllowPaid(false); setError(''); setGenerateTarget(target);
  }
  async function generate() {
    if (generateTarget === null || !allowPaid || !model) return;
    setGenerating(generateTarget); setError('');
    try {
      const revision = await request<StoryboardRevision>(`/projects/${encodeURIComponent(projectId)}/storyboards`, {
        method: 'POST', body: { allowPaid: true, expectedModelConnectionRevision: model.connectionRevision,
          episodeNumber: generateTarget === 'project' ? undefined : generateTarget, baseRevisionId: generationBase?.id },
      });
      setBoards(current => [revision, ...current.filter(item => item.id !== revision.id)]);
      setBoardId(revision.id); setShots(structuredClone(revision.shots)); setDirty(false);
      if (generateTarget !== 'project') setEpisodeNumber(generateTarget);
      setNotice(generateTarget === 'project' ? '全项目分镜候选已生成。' : `第 ${generateTarget} 集分镜候选已生成，并合并为新版本。`);
      setGenerateTarget(null);
    } catch (cause) { setError(errorText(cause)); } finally { setGenerating(null); }
  }
  async function save(): Promise<StoryboardRevision | null> {
    if (!board || !plan) return null;
    if (!dirty && !pruneRequired) return board;
    const draftIssue = storyboardDraftIssue(prunedShots, retainedScenes);
    if (draftIssue) { setError(draftIssue); return null; }
    setSaving(true); setError('');
    try {
      const revision = await request<StoryboardRevision>(`/storyboards/${encodeURIComponent(board.id)}/edits`, {
        method: 'POST', body: storyboardEditPayload(prunedShots),
      });
      setBoards(current => [revision, ...current]); setBoardId(revision.id);
      setShots(structuredClone(revision.shots)); setDirty(false); setNotice('已保存为新的不可变分镜候选，原版本保持不变。');
      return revision;
    } catch (cause) { setError(errorText(cause)); return null; } finally { setSaving(false); }
  }
  async function adopt() {
    if (!board || !project || !coverage.complete || stale || adopting || saving || (adopted && !dirty && !pruneRequired)) return;
    setAdopting(true); setError('');
    try {
      const revision = dirty || pruneRequired ? await save() : board;
      if (!revision) return;
      await request(`/projects/${encodeURIComponent(projectId)}/storyboards/${encodeURIComponent(revision.id)}/adoptions`, {
        method: 'POST', body: { expectedActiveStoryboardRevisionId: project.activeStoryboardRevisionId },
      });
      setProject(current => current ? { ...current, activeStoryboardRevisionId: revision.id } : current);
      setNotice(dirty || pruneRequired ? '已保存新候选并采用为项目正式分镜，原版本保持不变。' : '已采用为项目正式分镜。');
    } catch (cause) { setError(errorText(cause)); } finally { setAdopting(false); }
  }
  function openVideoGeneration(shotId?: string) {
    if (!board) { setError('请先选择一版已保存的分镜。'); return; }
    if (dirty) { setError('请先保存并采用当前修改，再生成视频。'); return; }
    if (!adopted || stale) { setError('请先采用当前正式分镜，再生成视频。'); return; }
    if (shotId && !board.shots.some(item => item.id === shotId)) { setError('所选镜头不在当前分镜版本中。'); return; }
    if (pruneRequired) { setError('请先保存并采用精简后的候选，再生成视频。'); return; }
    setError(''); setVideoTarget(shotId ?? 'episode');
  }
  async function startVideoGeneration(budgetYuan: number) {
    if (!board || videoTarget === null) return;
    const shot = videoTarget === 'episode' ? undefined : board.shots.find(item => item.id === videoTarget);
    if (videoTarget !== 'episode' && !shot) { setError('所选镜头已变化，请重新选择。'); return; }
    const targetDurationSec = shot ? Math.max(1, Math.ceil(shot.design.durationMs / 1000)) : 90;
    const created = await videoMedia.start(clientRequestId => productionCreateBody({
      ...defaultProductionForm, projectId, scriptVersionId: board.scriptVersionId,
      storyboardRevisionId: board.id, ...(shot ? { shotId: shot.id } : {}), targetDurationSec, budgetYuan,
    }, clientRequestId));
    if (created) setVideoTarget(null);
  }
  function openProduction(shotId?: string) {
    if (!board || !script) { setError('请先选择一版已保存的分镜。'); return; }
    if (dirty) { setError('当前草稿尚未保存。请先保存并重新采用，再进入制作，未保存修改不会静默带入。'); return; }
    if (!adopted || stale) { setError('当前分镜尚未采用为正式版本。请先人工采用，再开始单镜或整集制作。'); return; }
    const shot = shotId ? board.shots.find(item => item.id === shotId) : undefined;
    if (shotId && !shot) { setError('所选镜头不在当前分镜版本中。'); return; }
    if (pruneRequired) { setError('已删除集仍在当前正式版本中。请先保存并采用精简后的候选，再进入制作。'); return; }
    const saved = saveStoryboardProductionIntent({ projectId, scriptVersionId: board.scriptVersionId,
      storyboardRevisionId: board.id, ...(shotId ? { shotId } : {}),
      ...(shot ? { targetDurationSec: Math.max(1, Math.ceil(shot.design.durationMs / 1000)) } : {}),
      sourceLabel: shot ? `单镜制作 · 镜 ${shot.order}` : `整集制作 · ${board.shots.length} 个镜头` });
    if (!saved) { setError('浏览器无法保存本次制作上下文，请允许会话存储后重试。'); return; }
    setError('');
    window.location.hash = `#/projects/${projectId}/production`;
  }
  function openInspectorSection(shotId: string, sectionId: string) {
    setSelectedShotId(shotId);
    setInspectorOpen(true);
    window.requestAnimationFrame(() => document.getElementById(sectionId)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }
  function openFrames(shotId: string) {
    openInspectorSection(shotId, 'sbw-shot-frames');
  }
  function openAssets(shotId: string) {
    openInspectorSection(shotId, 'sbw-shot-assets');
  }
  const currentVideoRun = videoMedia.run;
  const episodeVideoRun = currentVideoRun && currentVideoRun.storyboardRevisionId === board?.id && !currentVideoRun.shotId ? currentVideoRun : null;
  const selectedVideoRun = currentVideoRun && currentVideoRun.storyboardRevisionId === board?.id && currentVideoRun.shotId === selectedShot?.id ? currentVideoRun : null;
  const videoTargetShot = videoTarget && videoTarget !== 'episode' ? board?.shots.find(item => item.id === videoTarget) ?? null : null;
  const videoBusy = videoMedia.creating || Boolean(videoMedia.run && productionRunActive(videoMedia.run));

  return <div className="sbw-page">
    {error && <div className="sbw-global-error"><Notice>{error}</Notice></div>}
    {notice && <div className="sbw-global-notice"><CheckCircle2 size={16} />{notice}</div>}
    {loading ? <div className="sbw-loading"><LoaderCircle className="sbw-spin" />正在加载分镜工作区…</div> : !plan ? <div className="sbw-empty sbw-page-empty"><Film size={36} /><h2>还没有已采用的项目事实</h2><p>请先完成剧本场次、人物、地点与道具拆解，再生成逐集分镜。</p></div> : <>
      <header className="sbw-toolbar">
        <div className="sbw-toolbar-title"><Film size={18} /><h1>{project?.title ?? currentEpisode?.title ?? '项目分镜'}</h1><span>第 {episodeNumber} 集</span><small>{visibleScenes.length} 场次 · {visibleShots.length} 镜头{planScript && script && planScript.id !== script.id ? ` · 采用剧本 V${planScript.version}` : ''}</small></div>
        <div className="sbw-toolbar-actions">
          <button className="sbw-save" disabled={(!dirty && !pruneRequired) || saving || stale || !board} onClick={() => void save()}><Save size={14} />{saving ? '保存中…' : '保存候选'}</button>
          <button className="sbw-ai-generate" disabled={generating !== null} onClick={() => openGeneration(episodeNumber)}><Sparkles size={14} />AI 生成</button>
          <button className="sbw-toolbar-button sbw-video-generate" disabled={videoBusy} onClick={() => openVideoGeneration()}><Video size={14} />生成本集视频</button>
          <button className="sbw-toolbar-button sbw-bgm-button" title="前往制作中心设置配乐" onClick={() => openProduction()}><Music2 size={14} />配乐</button>
          <button className="sbw-toolbar-button" onClick={() => openProduction()}><Video size={14} />合成</button>
          <div className="sbw-view-toggle" role="group" aria-label="分镜视图">
            <button className={viewMode === 'table' ? 'active' : ''} aria-pressed={viewMode === 'table'} onClick={() => setViewMode('table')}><List size={14} />表格</button>
            <button className={viewMode === 'card' ? 'active' : ''} aria-pressed={viewMode === 'card'} onClick={() => setViewMode('card')}><Grid2X2 size={14} />卡片</button>
          </div>
          <button className={`sbw-icon-button sbw-info-toggle${inspectorOpen ? ' active' : ''}`} title="切换镜头详情" aria-label="切换镜头详情" aria-pressed={inspectorOpen} onClick={() => setInspectorOpen(open => !open)}><Info size={17} /></button>
        </div>
      </header>
      <div className={`sbw-layout${sidebarCollapsed ? ' sidebar-collapsed' : ''}${inspectorOpen ? ' inspector-open' : ''}`}>
        <StoryboardEpisodeSidebar boards={boards} boardId={boardId} activeBoardId={project?.activeStoryboardRevisionId ?? null}
          plan={plan} episodes={episodes} retainedEpisodeIds={retainedEpisodeIds} episodeNumber={episodeNumber} activeSceneId={selectedSceneId || selectedShot?.sceneId || ''} shots={prunedShots}
          generating={generating} refreshing={refreshing} collapsed={sidebarCollapsed}
          onBoard={chooseBoard} onEpisode={chooseEpisode} onScene={chooseScene} onGenerate={openGeneration}
          onRefresh={() => void refresh()} onCollapsedChange={setSidebarCollapsed} />
        <main className="sbw-shot-column">
          {episodeVideoRun && <MediaRunNotice run={episodeVideoRun} projectId={projectId}
            successText={`本集已生成 ${episodeVideoRun.artifacts.filter(item => item.kind === 'video').length} 条镜头视频，可在各镜头详情中播放。`} />}
          {videoMedia.error && <p className="sbw-media-error" role="alert">{videoMedia.error}</p>}
          <StoryboardShotList scenes={visibleScenes} shots={visibleShots} plan={plan} dialogues={plan.content.dialogues} assets={assets}
            selectedShotId={selectedShot?.id ?? ''} viewMode={viewMode}
            readOnlyReason={!board ? '还没有分镜候选，请点击顶部 AI 生成。' : null}
            onSelect={setSelectedShotId} onUpdate={updateShotField} onAdd={addShot} onDelete={deleteShot}
            onOpenFrames={openFrames} onOpenAssets={openAssets} onProduction={openVideoGeneration} />
        </main>
        {inspectorOpen && <StoryboardInspector projectId={projectId} plan={plan} scene={selectedScene} shot={selectedShot} assets={assets}
          readOnly={stale || !board} coverageComplete={coverage.complete}
          adopted={adopted} stale={stale} dirty={dirty} pruneRequired={pruneRequired}
          adopting={adopting} frameUploading={frameUploading} voiceUploading={voiceUploading} voiceLibrary={voiceLibrary} voiceAssets={voiceAssets}
          videoRun={selectedVideoRun} videoBusy={videoBusy}
          onVoiceUpload={uploadVoice} onVoiceSelect={selectVoice} onAsset={updateAsset}
          onFrame={updateFrame} onFrameUpload={uploadFrame} onProduction={openVideoGeneration} onAdopt={() => void adopt()} />}
      </div>
    </>}
    <MediaGenerationDialog open={videoTarget !== null} kind="video"
      title={videoTargetShot ? `生成镜 ${videoTargetShot.order} 视频` : '生成本集视频'}
      description="使用当前正式分镜、已绑定人物与场景资产、音色和视频提示词直接生成，不跳转到其他制作表单。"
      facts={[{ label: '生成范围', value: videoTargetShot ? `仅镜 ${videoTargetShot.order}` : `当前正式分镜 · ${board?.shots.length ?? 0} 个镜头` },
        { label: '生成方式', value: '每镜 1 条 · 不使用 3D · 不抽卡' },
        { label: '当前模型', value: mediaModels?.video.configured ? mediaModels.video.model : '尚未配置' }]}
      model={mediaModels?.video ?? null} busy={videoMedia.creating} onClose={() => setVideoTarget(null)} onConfirm={budgetYuan => void startVideoGeneration(budgetYuan)} />
    <Modal open={generateTarget !== null} title={generateTarget === 'project' ? '生成全项目分镜' : `生成第 ${generateTarget ?? ''} 集分镜`}
      onClose={() => { if (generating === null) setGenerateTarget(null); }} className="sbw-generate-modal">
      <div className="sbw-generate-copy"><Sparkles size={24} /><div><strong>将创建新的不可变分镜候选</strong>
        <p>{generateTarget === 'project' ? '覆盖当前项目的全部场次。' : generationBase ? '只生成本集镜头；同版本其他集镜头会保留并合并。' : '只生成本集镜头；旧剧本分镜仅保留历史，不带入新剧本。'}</p></div></div>
      <dl className="sbw-generation-facts"><div><dt>模型</dt><dd>{model?.model ?? '读取中'}</dd></div>
        <div><dt>基础版本</dt><dd>{generationBase ? `${generationBase.id.slice(-8)} · ${generationBase.shots.length} 镜` : '无，将从当前剧本和已采用事实创建'}</dd></div>
        <div><dt>合并策略</dt><dd>{generationBase ? '合并同版本候选，旧版本保持不变' : '不合并旧剧本分镜'}</dd></div></dl>
      <label className="sbw-paid-check"><input type="checkbox" checked={allowPaid} disabled={generating !== null}
        onChange={event => setAllowPaid(event.target.checked)} />
        <span>我已确认使用上述模型，并授权本次真实模型调用及可能产生的费用。</span></label>
      <p className="sbw-paid-note">请求会同步等待模型返回；成功后仍需逐镜检查，并人工采用完整候选。不会自动启动首尾帧或视频生成。</p>
      <div className="sbw-modal-actions"><button disabled={generating !== null} onClick={() => setGenerateTarget(null)}>取消</button>
        <button className="primary" disabled={!allowPaid || generating !== null || !model?.configured} onClick={() => void generate()}>
          {generating !== null ? <LoaderCircle size={15} className="sbw-spin" /> : <Sparkles size={15} />}
          {generating !== null ? '正在生成，请等待…' : '确认付费并生成'}</button></div>
      {model && !model.configured && <p className="sbw-global-error">当前分镜模型尚未配置，不能发起真实调用。</p>}
    </Modal>
  </div>;
}
