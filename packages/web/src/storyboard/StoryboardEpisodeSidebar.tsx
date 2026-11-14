import { useEffect, useState } from 'react';
import { Camera, CheckCircle2, ChevronRight, Clapperboard, Film, PanelLeftClose, PanelLeftOpen, Plus, RotateCw, Sparkles } from 'lucide-react';
import type { FactPlan } from '../facts-editor';
import { boardLabel, coverageForScenes, episodeSceneIds } from './workbench';
import type { EpisodeView, StoryboardRevision, StoryboardScene } from './types';

interface Props {
  boards: StoryboardRevision[];
  boardId: string;
  activeBoardId: string | null;
  plan: FactPlan | null;
  episodes: EpisodeView[];
  retainedEpisodeIds: Set<string> | null;
  episodeNumber: number;
  activeSceneId: string;
  shots: StoryboardRevision['shots'];
  generating: number | 'project' | null;
  refreshing: boolean;
  collapsed: boolean;
  onBoard: (id: string) => void;
  onEpisode: (episodeNumber: number) => void;
  onScene: (episodeNumber: number, sceneId: string) => void;
  onGenerate: (episodeNumber: number | 'project') => void;
  onRefresh: () => void;
  onCollapsedChange: (collapsed: boolean) => void;
}

export default function StoryboardEpisodeSidebar(props: Props) {
  const { boards, boardId, activeBoardId, plan, episodes, retainedEpisodeIds, episodeNumber, activeSceneId, shots, generating } = props;
  const visibleEpisodes = episodes.filter(episode => !retainedEpisodeIds || retainedEpisodeIds.has(episode.id));
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(episodes.map(episode => episode.episodeNumber)));
  useEffect(() => {
    setExpanded(current => new Set(current).add(episodeNumber));
  }, [episodeNumber]);

  if (props.collapsed) {
    return <aside className="sbw-sidebar is-collapsed" aria-label="分镜目录已折叠">
      <button className="sbw-icon-button" title="展开分镜目录" aria-label="展开分镜目录" onClick={() => props.onCollapsedChange(false)}><PanelLeftOpen size={17} /></button>
      <Film size={17} />
    </aside>;
  }

  function toggleEpisode(number: number) {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(number)) next.delete(number); else next.add(number);
      return next;
    });
  }

  return <aside className="sbw-sidebar" aria-label="分镜目录">
    <header className="sbw-directory-header">
      <h2>分镜目录</h2>
      <div>
        <button className="sbw-icon-button" title="刷新分镜目录" aria-label="刷新分镜目录" disabled={props.refreshing} onClick={props.onRefresh}>
          <RotateCw size={15} className={props.refreshing ? 'sbw-spin' : undefined} />
        </button>
        <span className="sbw-episode-count">{visibleEpisodes.length} 集</span>
        <button className="sbw-icon-button" title="收起分镜目录" aria-label="收起分镜目录" onClick={() => props.onCollapsedChange(true)}><PanelLeftClose size={16} /></button>
      </div>
    </header>
    <div className="sbw-directory-scroll">
      <div className="sbw-version-select-wrap">
        <select className="sbw-board-select" aria-label="选择分镜版本" value={boardId} onChange={event => props.onBoard(event.target.value)}>
          {!boards.length && <option value="">暂无分镜候选</option>}
          {boards.map(board => <option key={board.id} value={board.id}>{boardLabel(board, activeBoardId, plan?.id ?? null)}</option>)}
        </select>
      </div>
      <div className="sbw-episode-list">
        {visibleEpisodes.map(episode => {
          const ids = episodeSceneIds(episodes, plan, episode.episodeNumber, retainedEpisodeIds);
          const scenes = (plan?.content.scenes ?? []).filter(scene => ids.has(scene.id)).sort((a, b) => a.order - b.order) as StoryboardScene[];
          const coverage = coverageForScenes(shots, scenes, plan?.content.dialogues ?? []);
          const selected = episode.episodeNumber === episodeNumber;
          const isExpanded = expanded.has(episode.episodeNumber);
          return <section className={`sbw-episode-row${selected ? ' active' : ''}`} key={episode.id}>
            <div className="sbw-episode-line">
              <button className="sbw-episode-toggle" aria-label={`${isExpanded ? '收起' : '展开'}第 ${episode.episodeNumber} 集`} aria-expanded={isExpanded}
                onClick={() => toggleEpisode(episode.episodeNumber)}><ChevronRight size={13} className={isExpanded ? 'is-expanded' : undefined} /></button>
              <button className="sbw-episode-main" onClick={() => { props.onEpisode(episode.episodeNumber); if (!isExpanded) toggleEpisode(episode.episodeNumber); }}>
                <Clapperboard size={15} /><span>{episode.title || `第 ${episode.episodeNumber} 集`}</span>
              </button>
              {coverage.complete && <CheckCircle2 size={13} className="sbw-complete" />}
              <button className="sbw-episode-generate" title={`AI 生成第 ${episode.episodeNumber} 集分镜`} aria-label={`AI 生成第 ${episode.episodeNumber} 集分镜`}
                disabled={generating !== null || !plan} onClick={() => props.onGenerate(episode.episodeNumber)}><Sparkles size={13} /></button>
            </div>
            {isExpanded && <div className="sbw-scene-tree">
              {scenes.map(scene => {
                const sceneShots = shots.filter(shot => shot.sceneId === scene.id);
                return <button key={scene.id} className={`sbw-scene-link${activeSceneId === scene.id ? ' active' : ''}`}
                  onClick={() => props.onScene(episode.episodeNumber, scene.id)}>
                  <Camera size={13} /><span>{scene.title.value || `场次 ${scene.order}`}</span><small>{sceneShots.length}</small>
                </button>;
              })}
              {!scenes.length && <p className="sbw-no-scenes">暂无场次</p>}
              <a className="sbw-add-scene" href={`#/projects/${plan?.projectId ?? ''}/script-structure`} title="场次由剧本管理，前往剧本工作台添加"><Plus size={12} />添加场次</a>
            </div>}
          </section>;
        })}
      </div>
      {!episodes.length && <div className="sbw-empty-directory"><Film size={24} /><p>暂无分集，请先在剧本中创建。</p></div>}
    </div>
    <footer className="sbw-directory-footer">
      <button className="sbw-project-generate" disabled={generating !== null || !plan} onClick={() => props.onGenerate('project')}><Sparkles size={14} />生成全项目分镜</button>
      <p>保存会创建新候选，原版本保持不变。</p>
    </footer>
  </aside>;
}
