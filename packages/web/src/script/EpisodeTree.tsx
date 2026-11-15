import { useEffect, useState } from 'react';
import { ChevronRight, Clapperboard, Film, Plus, Sparkles, Trash2 } from 'lucide-react';
import type { ScriptEpisode } from '@lyra/shared';

interface EpisodeTreeProps {
  episodes: ScriptEpisode[];
  selectedEpisodeId: string | null;
  selectedSceneId: string | null;
  disabled?: boolean;
  onSelect: (episodeId: string) => void;
  onSelectScene: (episodeId: string, sceneId: string) => void;
  onDelete: (episodeId: string) => void;
  onAiParse: (episode: ScriptEpisode) => void;
  onCreate: () => void;
  onAddScene: (episodeId: string) => void;
  onDeleteScene: (episodeId: string, sceneId: string) => void;
}

/** 融光式剧本目录：分集可展开嵌套场次，悬浮显示单集解析与删除。 */
export function EpisodeTree({ episodes, selectedEpisodeId, selectedSceneId, disabled,
  onSelect, onSelectScene, onDelete, onAiParse, onCreate, onAddScene, onDeleteScene }: EpisodeTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(selectedEpisodeId ? [selectedEpisodeId] : []));

  useEffect(() => {
    if (!selectedEpisodeId) return;
    setExpanded(previous => new Set(previous).add(selectedEpisodeId));
  }, [selectedEpisodeId]);

  function toggle(episodeId: string) {
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(episodeId)) next.delete(episodeId); else next.add(episodeId);
      return next;
    });
  }

  return <aside className="script-tree" aria-label="剧本目录">
    <div className="script-tree-head">
      <strong>剧本目录</strong>
      <small>{episodes.length} 集</small>
    </div>
    <ul className="script-tree-list">
      {episodes.map(episode => {
        const selected = episode.id === selectedEpisodeId;
        const isExpanded = expanded.has(episode.id);
        const canDelete = episodes.length > 1;
        return <li key={episode.id} className={`script-tree-item ${selected ? 'is-selected' : ''}`}>
          <div className="script-tree-row">
            <button type="button" className="script-tree-expand" disabled={disabled}
              aria-label={`${isExpanded ? '收起' : '展开'}第${episode.episodeNumber}集`}
              onClick={() => toggle(episode.id)}>
              <ChevronRight size={13} className={isExpanded ? 'is-expanded' : ''} />
            </button>
            <button type="button" className="script-tree-main" aria-pressed={selected} disabled={disabled}
              onClick={() => { onSelect(episode.id); setExpanded(previous => new Set(previous).add(episode.id)); }}>
              <Film size={14} />
              <span className="script-tree-title">{episode.title || `第 ${episode.episodeNumber} 集`}</span>
            </button>
            <div className="script-tree-actions" role="group" aria-label={`第${episode.episodeNumber}集操作`}>
              <button type="button" className="script-tree-action is-ai" disabled={disabled}
                aria-label={`AI 解析第${episode.episodeNumber}集`} title="AI 解析该集"
                onClick={() => onAiParse(episode)}>
                <Sparkles size={13} />
              </button>
              <button type="button" className="script-tree-action is-danger"
                disabled={disabled || !canDelete}
                aria-label={canDelete ? `删除第${episode.episodeNumber}集` : '至少保留一集，不能删除'}
                title={canDelete ? '删除分集' : '至少保留一集'}
                onClick={() => onDelete(episode.id)}>
                <Trash2 size={13} />
              </button>
            </div>
          </div>
          {isExpanded && <div className="script-tree-scenes">
            {episode.scenes.length === 0 && <p>暂无场次</p>}
            {episode.scenes.map(scene => <div key={scene.id}
              className={`script-tree-scene-row ${scene.id === selectedSceneId ? 'is-selected' : ''}`}>
              <button type="button" className="script-tree-scene" disabled={disabled}
                onClick={() => onSelectScene(episode.id, scene.id)}>
                <Clapperboard size={12} />
                <span>{scene.sceneNumber} {scene.sceneHeading || '新场次'}</span>
              </button>
              <button type="button" className="script-tree-scene-delete" disabled={disabled}
                aria-label={`删除场次 ${scene.sceneNumber}`} title="删除场次"
                onClick={() => onDeleteScene(episode.id, scene.id)}>
                <Trash2 size={12} />
              </button>
            </div>)}
            <button type="button" className="script-tree-add-scene" disabled={disabled}
              onClick={() => onAddScene(episode.id)}>
              <Plus size={12} />添加场次
            </button>
          </div>}
        </li>;
      })}
    </ul>
    <button type="button" className="script-tree-create" disabled={disabled} onClick={onCreate}>
      <Plus size={14} /><span>添加分集</span>
    </button>
  </aside>;
}
