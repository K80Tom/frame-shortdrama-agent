import { useEffect, useMemo, useState } from 'react';
import {
  addElement, addEpisode, addScene, patchEpisode, patchScene, removeElement, removeScene, updateElement,
  type ScriptElement, type ScriptElementType, type ScriptEpisode, type ScriptScene, type ScriptStructure,
} from './script-structure';

const elementLabels: Record<ScriptElementType, string> = {
  1: '对白', 2: '动作', 3: '旁白', 4: '镜头', 5: '环境',
};
const elementTypes: ScriptElementType[] = [1, 2, 3, 4, 5];
const elementPlaceholders: Record<ScriptElementType, string> = {
  1: '添加台词…', 2: '添加动作或场景描述…', 3: '添加旁白…', 4: '添加镜头设计…', 5: '添加环境说明…',
};

interface Props {
  structure: ScriptStructure;
  onChange: (next: ScriptStructure) => void;
  onSaveScene?: (episodeId: string, sceneId: string) => void;
  savingSceneId?: string | null;
  disabled?: boolean;
  preview?: boolean;
}

function sceneTitle(scene: ScriptScene) {
  return [scene.sceneNumber || '新场次', scene.intExt ? `${scene.intExt}景` : '', scene.location, scene.timeOfDay]
    .filter(Boolean).join(' · ');
}

function ElementFields({ element, onPatch, disabled }: {
  element: ScriptElement; onPatch: (patch: Partial<ScriptElement>) => void; disabled?: boolean;
}) {
  if (element.type !== 1 && element.type !== 3) return null;
  return <div className="structured-dialogue-meta">
    <input aria-label="说话人" value={element.characterName ?? ''} disabled={disabled} placeholder="角色名"
      onChange={event => onPatch({ characterName: event.target.value })} />
    <input aria-label="语气或动作提示" value={element.parenthetical ?? ''} disabled={disabled} placeholder="（语气）"
      onChange={event => onPatch({ parenthetical: event.target.value })} />
  </div>;
}

export default function StructuredScriptEditor({ structure, onChange, onSaveScene, savingSceneId, disabled, preview }: Props) {
  const firstEpisode = structure.episodes[0];
  const [episodeId, setEpisodeId] = useState(firstEpisode?.id ?? '');
  const [sceneId, setSceneId] = useState(firstEpisode?.scenes[0]?.id ?? '');
  const episode = useMemo(() => structure.episodes.find(item => item.id === episodeId) ?? structure.episodes[0],
    [episodeId, structure.episodes]);
  const scene = useMemo(() => episode?.scenes.find(item => item.id === sceneId) ?? episode?.scenes[0],
    [episode, sceneId]);

  useEffect(() => {
    if (!structure.episodes.some(item => item.id === episodeId)) setEpisodeId(structure.episodes[0]?.id ?? '');
    const current = structure.episodes.find(item => item.id === episodeId) ?? structure.episodes[0];
    if (current && !current.scenes.some(item => item.id === sceneId)) setSceneId(current.scenes[0]?.id ?? '');
  }, [structure, episodeId, sceneId]);

  if (!episode) return <p className="muted">还没有分集。</p>;

  const selectEpisode = (next: ScriptEpisode) => {
    setEpisodeId(next.id);
    setSceneId(next.scenes[0]?.id ?? '');
  };

  const appendEpisode = () => {
    const next = addEpisode(structure);
    onChange(next);
    setEpisodeId(next.episodes.at(-1)!.id);
    setSceneId(next.episodes.at(-1)!.scenes[0]?.id ?? '');
  };

  const appendScene = (target: ScriptEpisode) => {
    const next = addScene(structure, target.id);
    onChange(next);
    const updated = next.episodes.find(item => item.id === target.id);
    setSceneId(updated?.scenes.at(-1)?.id ?? '');
  };

  return <div className="structured-script">
    <aside className="structured-directory">
      <div className="structured-directory-head">
        <span>剧本目录</span>
        <small>{preview ? 'AI 预览 · ' : ''}{structure.episodes.length} 集</small>
      </div>
      {structure.episodes.map((item, index) => <div key={item.id} className="structured-episode-nav">
        <button type="button" className={item.id === episode.id ? 'is-active' : ''}
          onClick={() => selectEpisode(item)} disabled={disabled}>
          {item.title || `第${item.episodeNumber}集`}
        </button>
        <div className="structured-scene-nav">
          {item.scenes.map((entry, sceneIndex) => <button type="button" key={entry.id}
            className={entry.id === scene?.id ? 'is-active' : ''}
            onClick={() => { setEpisodeId(item.id); setSceneId(entry.id); }} disabled={disabled}>
            {entry.sceneNumber || `${item.episodeNumber}-${sceneIndex + 1}`} {entry.location}
          </button>)}
        </div>
        <button type="button" className="structured-add-link" onClick={() => appendScene(item)} disabled={disabled}>+ 添加场次</button>
      </div>)}
      <button type="button" className="structured-add-episode" onClick={appendEpisode} disabled={disabled}>+ 添加分集</button>
    </aside>

    <main className="structured-content">
      <div className="structured-content-head">
        <div><span className="project-kicker">EPISODE {episode.episodeNumber}</span><h3>{episode.title || '未命名分集'}</h3></div>
        <small>{episode.scenes.length} 场</small>
      </div>
      <label className="structured-field">
        <span>分集标题</span>
        <input value={episode.title} disabled={disabled} placeholder="第1集"
          onChange={event => onChange(patchEpisode(structure, episode.id, { title: event.target.value }))} />
      </label>
      <label className="structured-field">
        <span>剧情概览</span>
        <textarea value={episode.synopsis} disabled={disabled} placeholder="本集剧情概览"
          onChange={event => onChange(patchEpisode(structure, episode.id, { synopsis: event.target.value }))} />
      </label>

      <div className="structured-scenes">
        {episode.scenes.map((item) => <article key={item.id}
          className={`structured-scene ${item.id === scene?.id ? 'is-active' : ''}`}
          onClick={() => { setEpisodeId(episode.id); setSceneId(item.id); }}>
          <div className="structured-scene-head">
            <span className="structured-scene-index"># {item.sceneNumber || '新场次'}</span>
            <input aria-label="场次编号" value={item.sceneNumber} disabled={disabled} placeholder="1-1"
              onChange={event => onChange(patchScene(structure, episode.id, item.id, { sceneNumber: event.target.value }))} />
            <select aria-label="内景或外景" value={item.intExt} disabled={disabled}
              onChange={event => onChange(patchScene(structure, episode.id, item.id, { intExt: event.target.value as ScriptScene['intExt'] }))}>
              <option value="">内/外</option><option value="内">内景</option><option value="外">外景</option><option value="内/外">内/外</option>
            </select>
            <input aria-label="地点" value={item.location} disabled={disabled} placeholder="地点"
              onChange={event => onChange(patchScene(structure, episode.id, item.id, { location: event.target.value }))} />
            <input aria-label="时间" value={item.timeOfDay} disabled={disabled} placeholder="时间"
              onChange={event => onChange(patchScene(structure, episode.id, item.id, { timeOfDay: event.target.value }))} />
            <button type="button" className="structured-remove" onClick={event => {
              event.stopPropagation();
              onChange(removeScene(structure, episode.id, item.id));
              if (scene?.id === item.id) setSceneId(episode.scenes.find(entry => entry.id !== item.id)?.id ?? '');
            }} disabled={disabled}>删除</button>
            {onSaveScene && <button type="button" className="structured-save-scene"
              onClick={event => { event.stopPropagation(); onSaveScene(episode.id, item.id); }}
              disabled={disabled || savingSceneId === item.id}>
              {savingSceneId === item.id ? '保存中…' : '保存本场'}
            </button>}
          </div>
          <h4>{sceneTitle(item)}</h4>
          <label className="structured-field structured-scene-description">
            <span>场景描述</span>
            <textarea value={item.sceneDescription} disabled={disabled} placeholder="本场环境、调度或整体画面描述（可选）"
              onChange={event => onChange(patchScene(structure, episode.id, item.id, { sceneDescription: event.target.value }))} />
          </label>

          <div className="structured-blocks">
            {item.dialogues.map(element => <div key={element.id} className={`structured-block kind-${element.type}`}>
              <div className="structured-block-head">
                <span>{elementLabels[element.type]}</span>
                <div className="structured-block-actions">
                  <select aria-label="元素类型" value={element.type} disabled={disabled}
                    onChange={event => onChange(updateElement(structure, episode.id, item.id, element.id,
                      { type: Number(event.target.value) as ScriptElementType }))}>
                    {elementTypes.map(type => (
                      <option key={type} value={type}>{elementLabels[type]}</option>
                    ))}
                  </select>
                  <button type="button" className="structured-remove" onClick={event => {
                    event.stopPropagation();
                    onChange(removeElement(structure, episode.id, item.id, element.id));
                  }} disabled={disabled}>×</button>
                </div>
              </div>
              <ElementFields element={element} disabled={disabled}
                onPatch={patch => onChange(updateElement(structure, episode.id, item.id, element.id, patch))} />
              <textarea aria-label={elementLabels[element.type]} value={element.content} disabled={disabled}
                placeholder={elementPlaceholders[element.type]}
                onChange={event => onChange(updateElement(structure, episode.id, item.id, element.id, { content: event.target.value }))} />
            </div>)}
          </div>

          <div className="structured-add-row">
            {elementTypes.map(type => <button type="button" key={type}
              className="structured-add-link" disabled={disabled}
              onClick={event => { event.stopPropagation(); onChange(addElement(structure, episode.id, item.id, type)); }}>
              + 添加{elementLabels[type]}
            </button>)}
          </div>
        </article>)}
      </div>
      <button type="button" className="structured-add-scene" onClick={() => appendScene(episode)} disabled={disabled}>+ 添加场次</button>
    </main>
  </div>;
}
