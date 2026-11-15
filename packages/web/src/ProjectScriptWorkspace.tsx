import { useCallback, useEffect, useMemo, useState } from 'react';
import { Info, Loader2, Menu, X } from 'lucide-react';
import type { AssetRecord, ProjectAssetRequirementsResponse, ScriptEpisode, ScriptScene, ScriptStructure } from '@lyra/shared';
import * as api from './project-workspace-api';
import type { ScriptWorkspacePanel } from './project-flow';
import {
  addEpisode, emptyScriptStructure, parseScriptStructure, patchEpisode,
  removeScene, serializeScriptStructure,
} from './script-structure';
import { EpisodeTree } from './script/EpisodeTree';
import { SceneCardList } from './script/SceneCardList';
import { SceneDetailPanel } from './script/SceneDetailPanel';
import { EpisodeParseDialog, type EpisodeParseDialogSubmit } from './script/EpisodeParseDialog';
import { NavigationGuard } from './script/NavigationGuard';
import { buildAutomaticEntitySelections, insertSceneAfter, removeEpisode } from './script/workbench-logic';
import './script/script-workbench.css';

function blankWorkbenchStructure(): ScriptStructure {
  const empty = emptyScriptStructure();
  return { ...empty, episodes: empty.episodes.map(episode => ({ ...episode, scenes: [] })) };
}

/**
 * 融光式单页剧本工作台。
 * UI 不再经过旧“原文阶段 / 结构阶段”；每次明确保存仍由 main 创建不可变版本，
 * AI 解析在付费确认后直接写回当前集并自动关联资产，不经过预览或待入库抽屉。
 */
export default function ProjectScriptWorkspace({ projectId, onUnsavedChange }: {
  projectId: string;
  panel?: ScriptWorkspacePanel;
  onUnsavedChange?: (dirty: boolean) => void;
}) {
  const [project, setProject] = useState<api.ProjectRecord | null>(null);
  const [savedScript, setSavedScript] = useState<api.ScriptVersionRecord | null>(null);
  const [structure, setStructure] = useState<ScriptStructure>(() => blankWorkbenchStructure());
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null);
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [requirements, setRequirements] = useState<ProjectAssetRequirementsResponse['requirements'] | null>(null);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [parseDialogEpisode, setParseDialogEpisode] = useState<ScriptEpisode | null>(null);
  const [parseError, setParseError] = useState('');
  const [dirtySceneIds, setDirtySceneIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [model, setModel] = useState('默认拆解模型');
  const [modelRevision, setModelRevision] = useState('');
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);

  const selectedEpisode = useMemo(() => structure.episodes.find(item => item.id === selectedEpisodeId)
    ?? structure.episodes[0] ?? null, [structure, selectedEpisodeId]);
  const selectedScene = useMemo(() => selectedEpisode?.scenes.find(item => item.id === selectedSceneId)
    ?? selectedEpisode?.scenes[0] ?? null, [selectedEpisode, selectedSceneId]);
  const characterOptions = useMemo(() => [...new Set(structure.episodes.flatMap(episode => episode.scenes
    .flatMap(scene => scene.dialogues.filter(item => item.type === 1)
      .map(item => item.characterName?.trim() ?? '').filter(Boolean))))], [structure]);
  const totalScenes = useMemo(() => structure.episodes.reduce((total, episode) => total + episode.scenes.length, 0), [structure]);
  const parseInitialRawText = useMemo(() => parseDialogEpisode
    ? serializeScriptStructure({ ...structure, episodes: [parseDialogEpisode] }) : '', [parseDialogEpisode, structure]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    void Promise.all([api.getProject(projectId), api.getCurrentScriptVersion(projectId)])
      .then(([nextProject, nextSaved]) => {
        if (!alive) return;
        const nextStructure = nextSaved?.structure ?? (nextSaved ? parseScriptStructure(nextSaved.rawText) : blankWorkbenchStructure());
        setProject(nextProject);
        setSavedScript(nextSaved);
        setStructure(nextStructure);
        setSelectedEpisodeId(nextStructure.episodes[0]?.id ?? null);
        setSelectedSceneId(null);
      })
      .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : '读取剧本工作台失败。'); })
      .finally(() => { if (alive) setLoading(false); });
    api.getBreakdownModel().then(value => {
      if (!alive) return;
      setModel(value.model);
      setModelRevision(value.connectionRevision);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    api.fetchProjectAssetRequirements(projectId)
      .then(value => { if (alive) setRequirements(value.requirements); })
      .catch(reason => {
        if (!alive) return;
        setRequirements(null);
        setError(`资产关联读取失败：${reason instanceof Error ? reason.message : '未知错误'}。资产库记录未被修改，请刷新重试。`);
      });
    api.request<{ assets: AssetRecord[] }>('/assets')
      .then(value => { if (alive) setAssets(value.assets); })
      .catch(reason => {
        if (!alive) return;
        setAssets([]);
        setError(`人物资产读取失败：${reason instanceof Error ? reason.message : '未知错误'}。请刷新重试。`);
      });
    return () => { alive = false; };
  }, [projectId, savedScript?.id]);

  const handleDirtyChange = useCallback((sceneId: string, dirty: boolean) => {
    setDirtySceneIds(previous => {
      if (previous.has(sceneId) === dirty) return previous;
      const next = new Set(previous);
      if (dirty) next.add(sceneId); else next.delete(sceneId);
      return next;
    });
  }, []);

  async function persistStructure(next: ScriptStructure): Promise<api.ScriptVersionRecord> {
    const rawText = serializeScriptStructure(next);
    const saved = await api.saveScriptVersion(projectId, { rawText, structure: next });
    setSavedScript(saved);
    setStructure(saved.structure ?? next);
    setProject(current => current ? { ...current, currentScriptVersionId: saved.id } : current);
    return saved;
  }

  async function runMutation(work: () => Promise<void>): Promise<boolean> {
    setBusy(true); setError(''); setMessage('');
    try { await work(); return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，请稍后重试。'); return false; }
    finally { setBusy(false); }
  }

  function guardSceneDrafts(): boolean {
    if (dirtySceneIds.size === 0) return true;
    return window.confirm('当前场次有未保存修改，继续操作会丢失这些修改。确定继续？');
  }

  function selectEpisode(episodeId: string) {
    if (episodeId !== selectedEpisode?.id && !guardSceneDrafts()) return;
    setSelectedEpisodeId(episodeId);
    setSelectedSceneId(null);
    setLeftOpen(false);
  }

  function selectScene(episodeId: string, sceneId: string) {
    if (episodeId !== selectedEpisode?.id && !guardSceneDrafts()) return;
    setSelectedEpisodeId(episodeId);
    setSelectedSceneId(sceneId);
    setLeftOpen(false);
  }

  function createEpisode() {
    if (!guardSceneDrafts()) return;
    const next = addEpisode(structure);
    const created = next.episodes.at(-1);
    void runMutation(async () => {
      await persistStructure(next);
      if (created) { setSelectedEpisodeId(created.id); setSelectedSceneId(null); }
      setDirtySceneIds(new Set());
      setMessage(`已添加第${created?.episodeNumber ?? '?'}集。`);
    });
  }

  function saveEpisode(episodeId: string, patch: { title: string; synopsis: string }): Promise<boolean> {
    return runMutation(async () => {
      await persistStructure(patchEpisode(structure, episodeId, patch));
      setMessage('分集信息已保存。');
    });
  }

  function deleteEpisode(episodeId: string) {
    const episode = structure.episodes.find(item => item.id === episodeId);
    if (!episode || structure.episodes.length <= 1) return;
    if (!guardSceneDrafts()) return;
    if (!window.confirm(`将删除「${episode.title || `第${episode.episodeNumber}集`}」及其 ${episode.scenes.length} 个场次，并保存新的剧本版本。`)) return;
    const next = removeEpisode(structure, episodeId);
    void runMutation(async () => {
      await persistStructure(next);
      setSelectedEpisodeId(next.episodes[0]?.id ?? null);
      setSelectedSceneId(null);
      setDirtySceneIds(new Set());
      setMessage('分集已删除。');
    });
  }

  function addScene(episodeId: string, afterSceneId: string | null = null) {
    const previousIds = new Set(structure.episodes.find(item => item.id === episodeId)?.scenes.map(scene => scene.id));
    const next = insertSceneAfter(structure, episodeId, afterSceneId);
    const inserted = next.episodes.find(item => item.id === episodeId)?.scenes.find(scene => !previousIds.has(scene.id));
    void runMutation(async () => {
      await persistStructure(next);
      setSelectedEpisodeId(episodeId);
      if (inserted) setSelectedSceneId(inserted.id);
      setMessage('已新增场次，点击卡片直接编辑。');
    });
  }

  function deleteScene(episodeId: string, sceneId: string) {
    const scene = structure.episodes.find(item => item.id === episodeId)?.scenes.find(item => item.id === sceneId);
    if (!scene || !window.confirm(`确定删除场次「${scene.sceneNumber}」吗？`)) return;
    void runMutation(async () => {
      await persistStructure(removeScene(structure, episodeId, sceneId));
      if (selectedSceneId === sceneId) setSelectedSceneId(null);
      setDirtySceneIds(previous => { const next = new Set(previous); next.delete(sceneId); return next; });
      setMessage('场次已删除。');
    });
  }

  function saveScene(episodeId: string, nextScene: ScriptScene): Promise<boolean> {
    const next: ScriptStructure = {
      ...structure,
      episodes: structure.episodes.map(episode => episode.id === episodeId ? {
        ...episode,
        scenes: episode.scenes.map(scene => scene.id === nextScene.id ? nextScene : scene),
      } : episode),
    };
    return runMutation(async () => {
      await persistStructure(next);
      setMessage(`场次 ${nextScene.sceneNumber} 已保存。`);
    });
  }

  function openParse(episode: ScriptEpisode) {
    if (dirtySceneIds.size > 0) {
      setError('请先保存当前场次修改，再发起 AI 解析。');
      return;
    }
    setParseError('');
    setParseDialogEpisode(episode);
  }

  async function submitEpisodeParse(input: EpisodeParseDialogSubmit) {
    if (!parseDialogEpisode || busy) return;
    const episode = parseDialogEpisode;
    let baseVersionId: string | null = null;
    setBusy(true); setError(''); setParseError(''); setMessage('');
    try {
      const baseVersion = savedScript ?? await persistStructure(structure);
      baseVersionId = baseVersion.id;
      const result = await api.parseEpisode(projectId, episode.episodeNumber, {
        rawText: input.rawText,
        episodeNumber: episode.episodeNumber,
        scriptVersionId: baseVersion.id,
        overwriteConfirmed: input.overwriteConfirmed,
        allowPaid: input.allowPaid,
        commandId: input.commandId,
        expectedModelConnectionRevision: modelRevision,
      });
      // 融光没有候选勾选抽屉：所有模型识别实体自动进入正式链；服务端仍负责同名复用。
      const selections = buildAutomaticEntitySelections([...result.characters, ...result.locations, ...result.props]);
      const confirmed = await api.confirmEpisodeEntities(projectId, episode.episodeNumber, {
        scriptVersionId: baseVersion.id,
        attemptId: result.attemptId,
        selections,
      });
      setSavedScript(confirmed.scriptVersion);
      setStructure(confirmed.scriptVersion.structure ?? structure);
      setProject(current => current ? { ...current, currentScriptVersionId: confirmed.scriptVersion.id } : current);
      setParseDialogEpisode(null);
      setSelectedSceneId(null);
      setDirtySceneIds(new Set());

      let assetMessage = '资产已自动关联。';
      if (confirmed.plan && confirmed.check) {
        const issueCount = confirmed.check.issues.length;
        const acceptWarnings = confirmed.check.check.result === 'passed' || window.confirm(
          `剧本已保存，但完整性校验仍有 ${issueCount} 项警告。确定仍采用本次人物、场景与道具事实吗？`);
        if (acceptWarnings) {
          try {
            await api.request(`/projects/${projectId}/adoptions`, { method: 'POST', body: {
              planRevisionId: confirmed.plan.id,
              checkId: confirmed.check.check.id,
              expectedActivePlanRevisionId: project?.activePlanRevisionId ?? null,
              ...(confirmed.check.check.result === 'failed' ? { allowCheckWarnings: true } : {}),
            } });
            setProject(current => current ? { ...current, activePlanRevisionId: confirmed.plan!.id } : current);
            let linkedCount = 0;
            for (const candidate of [...result.characters, ...result.locations, ...result.props]) {
              await api.createMetadataAsset(candidate);
              linkedCount += 1;
            }
            assetMessage = `${linkedCount} 个实体资产已自动复用或创建；无素材项标记为待补。`;
            void api.fetchProjectAssetRequirements(projectId)
              .then(value => setRequirements(value.requirements)).catch(() => undefined);
          } catch (reason) {
            assetMessage = `新版本已保存，但资产采用或写入失败：${reason instanceof Error ? reason.message : '未知错误'}。已写入记录不会因重试重复创建。`;
          }
        } else assetMessage = '新版本已保存；校验警告未确认，资产暂未采用。';
      }
      const sceneCount = confirmed.scriptVersion.structure?.episodes
        .find(item => item.episodeNumber === episode.episodeNumber)?.scenes.length ?? 0;
      setMessage(`第${episode.episodeNumber}集解析完成：${sceneCount} 个场次，已保存为剧本 V${confirmed.scriptVersion.version}。${assetMessage}`);
    } catch (reason) {
      const failure = reason instanceof Error ? reason.message : '单集解析失败，请稍后重试。';
      // 确认链会先保存不可变新版本，再创建 FactPlan 和校验；后段失败不能让用户继续看旧结构。
      // 409 覆盖冲突也可能只是本地版本落后，统一以服务端当前版本恢复可观察状态。
      if (baseVersionId) {
        try {
          const latest = await api.getCurrentScriptVersion(projectId);
          if (latest && latest.id !== baseVersionId) {
            const latestStructure = latest.structure ?? parseScriptStructure(latest.rawText);
            setSavedScript(latest);
            setStructure(latestStructure);
            setProject(current => current ? { ...current, currentScriptVersionId: latest.id } : current);
            setSelectedEpisodeId(episode.id);
            setSelectedSceneId(null);
            setDirtySceneIds(new Set());
            setParseDialogEpisode(null);
            setError(`第${episode.episodeNumber}集解析未完整完成：${failure}。服务端当前为剧本 V${latest.version}，已同步最新场次；请核对后再继续。`);
            return;
          }
        } catch (refreshReason) {
          setParseError(`${failure}；同时刷新服务端最新剧本失败：${refreshReason instanceof Error ? refreshReason.message : '未知错误'}。`);
          return;
        }
      }
      setParseError(failure);
    } finally { setBusy(false); }
  }

  async function recoverAssetAssociations() {
    if (!project || !savedScript || busy) return;
    await runMutation(async () => {
      const rebuilt = await api.rebuildCurrentFactPlan(projectId);
      const plan = rebuilt.plan;
      const check = rebuilt.check;
      if (!plan || !check) throw new Error('资产事实候选或完整性校验未生成，请稍后重试。');
      const issueCount = check.issues.length;
      const acceptWarnings = check.check.result === 'passed' || window.confirm(
        `已基于当前剧本 V${rebuilt.scriptVersion.version} 重建全部 ${plan.content.scenes.length} 个场次的事实候选，但完整性校验有 ${issueCount} 项警告。确定仍采用人物、场景与道具事实并关联资产吗？`);
      if (!acceptWarnings) {
        setMessage(`资产事实候选已保存，但 ${issueCount} 项校验警告未确认，暂未采用；可以核对后再次操作。`);
        return;
      }
      let adopted = false;
      try {
        await api.request(`/projects/${projectId}/adoptions`, { method: 'POST', body: {
          planRevisionId: plan.id,
          checkId: check.check.id,
          expectedActivePlanRevisionId: project.activePlanRevisionId,
          ...(check.check.result === 'failed' ? { allowCheckWarnings: true } : {}),
        } });
        adopted = true;
        setProject(current => current ? { ...current, activePlanRevisionId: plan.id } : current);
        let linkedCount = 0;
        const groups = [
          { kind: 'character' as const, items: plan.content.characters },
          { kind: 'location' as const, items: plan.content.locations },
          { kind: 'prop' as const, items: plan.content.props },
        ];
        for (const group of groups) {
          for (const entity of group.items) {
            await api.createMetadataAsset({
              kind: group.kind, name: entity.name.value,
              aliases: entity.aliases.map(alias => alias.value),
              description: entity.description?.value ?? null,
            });
            linkedCount += 1;
          }
        }
        const latestProject = await api.getProject(projectId);
        setProject(latestProject);
        const latestRequirements = await api.fetchProjectAssetRequirements(projectId);
        setRequirements(latestRequirements.requirements);
        setMessage(`资产事实已采用：${plan.content.scenes.length} 个场次，${linkedCount} 个实体已复用或创建。${issueCount > 0 ? `已明确接受 ${issueCount} 项校验警告。` : ''}`);
      } catch (reason) {
        if (adopted) {
          const latestProject = await api.getProject(projectId).catch(() => null);
          if (latestProject) setProject(latestProject);
          const latestRequirements = await api.fetchProjectAssetRequirements(projectId).catch(() => null);
          if (latestRequirements) setRequirements(latestRequirements.requirements);
        }
        setError(`${adopted ? '资产事实已采用，但资产写入或关联刷新失败' : '资产事实候选已保存，但采用失败'}：${reason instanceof Error ? reason.message : '未知错误'}。不会覆盖已有资产，请核对后重试。`);
      }
    });
  }

  const tree = <EpisodeTree episodes={structure.episodes} selectedEpisodeId={selectedEpisode?.id ?? null}
    selectedSceneId={selectedSceneId} disabled={busy || loading}
    onSelect={selectEpisode} onSelectScene={selectScene} onDelete={deleteEpisode} onAiParse={openParse}
    onCreate={createEpisode} onAddScene={addScene} onDeleteScene={deleteScene} />;
  const detail = <SceneDetailPanel scene={selectedScene} episodeNumber={selectedEpisode?.episodeNumber ?? 0}
    requirements={requirements} assets={assets} recognizedProps={[]} episodeCount={structure.episodes.length} totalScenes={totalScenes} />;

  const showAssetRecovery = Boolean(project && savedScript && !project.activePlanRevisionId && totalScenes > 0);

  return <section className="script-fusion-workspace">
    <NavigationGuard dirty={dirtySceneIds.size > 0} onUnsavedChange={onUnsavedChange} />
    <header className="script-workspace-mobilebar">
      <button type="button" aria-label="打开剧本目录" onClick={() => setLeftOpen(true)}><Menu size={17} /></button>
      <strong>剧本内容</strong>
      <button type="button" aria-label="打开场景详情" onClick={() => setRightOpen(true)}><Info size={17} /></button>
    </header>
    {(error || message || showAssetRecovery) && <div className="script-workbench-notices">
      {error && <p className="project-error" role="alert">{error}</p>}
      {message && <p className="notice" role="status">{message}</p>}
      {showAssetRecovery && <div className="notice script-asset-recovery" role="status">
        <span>资产库记录仍在，但当前剧本尚未采用资产事实，所以场次无法显示正式关联。</span>
        <button type="button" className="button-secondary" disabled={busy}
          onClick={() => { void recoverAssetAssociations(); }}>
          {busy ? '正在处理…' : '基于当前场次重新关联'}
        </button>
      </div>}
    </div>}
    {loading ? <div className="script-workbench-loading"><Loader2 size={18} />正在读取剧本…</div>
      : <div className="script-workbench-grid">
        {tree}
        <SceneCardList episode={selectedEpisode} selectedSceneId={selectedScene?.id ?? null} disabled={busy}
          characterOptions={characterOptions} onSelectScene={setSelectedSceneId}
          onSaveScene={saveScene} onSaveEpisode={saveEpisode}
          onInsertSceneAfter={addScene} onDeleteScene={deleteScene} onDirtyChange={handleDirtyChange} />
        {detail}
      </div>}

    {leftOpen && <div className="script-workbench-sheet-layer">
      <button type="button" className="script-workbench-sheet-overlay" aria-label="关闭剧本目录" onClick={() => setLeftOpen(false)} />
      <div className="script-workbench-sheet is-left"><button type="button" aria-label="关闭剧本目录" onClick={() => setLeftOpen(false)}><X size={16} /></button>{tree}</div>
    </div>}
    {rightOpen && <div className="script-workbench-sheet-layer">
      <button type="button" className="script-workbench-sheet-overlay" aria-label="关闭场景详情" onClick={() => setRightOpen(false)} />
      <div className="script-workbench-sheet is-right"><button type="button" aria-label="关闭场景详情" onClick={() => setRightOpen(false)}><X size={16} /></button>{detail}</div>
    </div>}

    <EpisodeParseDialog open={Boolean(parseDialogEpisode)} episode={parseDialogEpisode}
      existingSceneCount={parseDialogEpisode?.scenes.length ?? 0} initialRawText={parseInitialRawText}
      busy={busy} modelLabel={model} submitError={parseError} onClose={() => setParseDialogEpisode(null)}
      onSubmit={input => { void submitEpisodeParse(input); }} />
  </section>;
}
