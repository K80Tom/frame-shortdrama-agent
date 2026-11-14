import { useCallback, useEffect, useState } from 'react';
import {
  Camera, Clapperboard, Clock, Eye, Hash, Loader2, MapPin, MessageSquare,
  Pencil, Plus, Save, Trash2, Trees, Users, Volume2, X,
} from 'lucide-react';
import type {
  ScriptElement, ScriptElementType, ScriptEpisode, ScriptScene,
} from '../script-structure';
import { ELEMENT_TYPE_LABELS, incompleteDialogues } from './workbench-logic';

const ELEMENT_TYPES: ScriptElementType[] = [1, 2, 3, 4, 5];
const ELEMENT_ICONS = { 1: MessageSquare, 2: Eye, 3: Volume2, 4: Camera, 5: Trees };
const ELEMENT_PLACEHOLDERS: Record<ScriptElementType, string> = {
  1: '输入台词…', 2: '输入动作…', 3: '输入旁白…', 4: '输入镜头指令…', 5: '输入环境描写…',
};
let fallbackId = 0;
function elementId() {
  fallbackId += 1;
  const uuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replaceAll('-', '') : `${Date.now().toString(36)}_${fallbackId}`;
  return `element_${uuid}`;
}
function newElement(type: ScriptElementType): ScriptElement {
  return { id: elementId(), type, content: '',
    ...(type === 1 || type === 3 ? { characterName: '', parenthetical: '' } : {}) };
}

interface SceneCardListProps {
  episode: ScriptEpisode | null;
  selectedSceneId: string | null;
  disabled?: boolean;
  characterOptions: string[];
  onSelectScene: (sceneId: string) => void;
  onSaveScene: (episodeId: string, scene: ScriptScene) => Promise<boolean>;
  onSaveEpisode: (episodeId: string, patch: { title: string; synopsis: string }) => Promise<boolean>;
  onInsertSceneAfter: (episodeId: string, sceneId: string | null) => void;
  onDeleteScene: (episodeId: string, sceneId: string) => void;
  onDirtyChange: (sceneId: string, dirty: boolean) => void;
}

function EpisodeHeader({ episode, disabled, onSave, onDirtyChange }: {
  episode: ScriptEpisode;
  disabled?: boolean;
  onSave: SceneCardListProps['onSaveEpisode'];
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [title, setTitle] = useState(episode.title);
  const [synopsis, setSynopsis] = useState(episode.synopsis);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingSynopsis, setEditingSynopsis] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setTitle(episode.title); setSynopsis(episode.synopsis); }, [episode.id, episode.title, episode.synopsis]);
  useEffect(() => {
    onDirtyChange(title !== episode.title || synopsis !== episode.synopsis);
    return () => onDirtyChange(false);
  }, [episode.id, episode.title, episode.synopsis, title, synopsis, onDirtyChange]);

  async function save(kind: 'title' | 'synopsis') {
    setSaving(true);
    const ok = await onSave(episode.id, { title: title.trim() || `第${episode.episodeNumber}集`, synopsis: synopsis.trim() });
    setSaving(false);
    if (ok) {
      if (kind === 'title') setEditingTitle(false); else setEditingSynopsis(false);
    }
  }

  return <header className="script-episode-header">
    <div className="script-episode-title-line">
      <span>第 {episode.episodeNumber} 集 <small>共 {episode.scenes.length} 场</small></span>
      {editingTitle ? <div className="script-inline-edit">
        <input aria-label="分集标题" value={title} disabled={disabled || saving} autoFocus
          onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void save('title'); }} />
        <button type="button" aria-label="保存分集标题" disabled={disabled || saving} onClick={() => void save('title')}><Save size={13} /></button>
        <button type="button" aria-label="取消编辑分集标题" disabled={saving} onClick={() => { setTitle(episode.title); setEditingTitle(false); }}><X size={13} /></button>
      </div> : <div className="script-episode-value">
        <strong>{episode.title || `第${episode.episodeNumber}集`}</strong>
        <button type="button" aria-label="编辑分集标题" disabled={disabled} onClick={() => setEditingTitle(true)}><Pencil size={13} /></button>
      </div>}
    </div>
    <div className="script-episode-synopsis">
      <span>剧情概览</span>
      {editingSynopsis ? <div className="script-inline-edit is-multiline">
        <textarea aria-label="剧情概览" value={synopsis} disabled={disabled || saving} autoFocus rows={3}
          onChange={event => setSynopsis(event.target.value)} />
        <button type="button" aria-label="保存剧情概览" disabled={disabled || saving} onClick={() => void save('synopsis')}><Save size={13} /></button>
        <button type="button" aria-label="取消编辑剧情概览" disabled={saving} onClick={() => { setSynopsis(episode.synopsis); setEditingSynopsis(false); }}><X size={13} /></button>
      </div> : <div className="script-episode-value">
        <p>{episode.synopsis || '未填写'}</p>
        <button type="button" aria-label="编辑剧情概览" disabled={disabled} onClick={() => setEditingSynopsis(true)}><Pencil size={13} /></button>
      </div>}
    </div>
    {saving && <span className="script-episode-saving"><Loader2 size={12} />正在保存…</span>}
  </header>;
}

function InsertElement({ index, onInsert }: { index: number; onInsert: (index: number, type: ScriptElementType) => void }) {
  const [open, setOpen] = useState(false);
  return <div className="script-element-insert">
    <button type="button" aria-label={`在第${index + 1}个元素前插入`} onClick={() => setOpen(!open)}><Plus size={11} /></button>
    {open && <div className="script-element-picker">
      {ELEMENT_TYPES.map(type => <button type="button" key={type} onClick={() => { onInsert(index, type); setOpen(false); }}>
        {ELEMENT_TYPE_LABELS[type]}
      </button>)}
    </div>}
  </div>;
}

function SceneCard({ scene, selected, disabled, onSelect, onSave, onDelete, onDirtyChange }: {
  scene: ScriptScene;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  onSave: (scene: ScriptScene) => Promise<boolean>;
  onDelete: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState(scene);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!dirty) setDraft(scene); }, [scene, dirty]);
  useEffect(() => () => onDirtyChange(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  function markDirty() { setDirty(true); onDirtyChange(true); }
  function patch(update: Partial<ScriptScene>) { setDraft(previous => ({ ...previous, ...update })); markDirty(); }
  function patchElement(id: string, update: Partial<ScriptElement>) {
    setDraft(previous => ({ ...previous, dialogues: previous.dialogues.map(item => item.id === id ? { ...item, ...update } : item) }));
    markDirty();
  }
  function insert(index: number, type: ScriptElementType) {
    setDraft(previous => ({ ...previous, dialogues: [...previous.dialogues.slice(0, index), newElement(type), ...previous.dialogues.slice(index)] }));
    markDirty();
  }
  function remove(id: string) {
    setDraft(previous => ({ ...previous, dialogues: previous.dialogues.filter(item => item.id !== id) }));
    markDirty();
  }
  async function save() {
    setSaving(true);
    const ok = await onSave(draft);
    setSaving(false);
    if (ok) { setDirty(false); onDirtyChange(false); }
  }

  const speakers = [...new Set(draft.dialogues.filter(item => item.type === 1)
    .map(item => item.characterName?.trim() ?? '').filter(Boolean))];
  const incomplete = incompleteDialogues(draft);
  return <article id={`script-scene-${scene.id}`} onClick={onSelect}
    className={`script-card ${selected ? 'is-active' : ''} ${incomplete.length ? 'has-warning' : ''}`}>
    <header className="script-card-head">
      <div className="script-card-fields">
        <label><Hash size={13} /><input aria-label="场次编号" value={draft.sceneNumber} disabled={disabled || saving}
          onChange={event => patch({ sceneNumber: event.target.value })} /></label>
        <select aria-label="内景或外景" value={draft.intExt} disabled={disabled || saving}
          onChange={event => patch({ intExt: event.target.value as ScriptScene['intExt'] })}>
          <option value="">内/外</option><option value="内">内景</option><option value="外">外景</option><option value="内/外">内/外</option>
        </select>
        <label><MapPin size={13} /><input aria-label="地点" value={draft.location} disabled={disabled || saving} placeholder="地点"
          onChange={event => patch({ location: event.target.value })} /></label>
        <label><Clock size={13} /><input aria-label="时间" value={draft.timeOfDay} disabled={disabled || saving} placeholder="日 / 夜"
          onChange={event => patch({ timeOfDay: event.target.value })} /></label>
      </div>
      <div className="script-card-head-actions">
        {(dirty || saving) && <button type="button" className="script-card-save" disabled={disabled || saving}
          onClick={event => { event.stopPropagation(); void save(); }}>
          {saving ? <Loader2 size={13} /> : <Save size={13} />}保存
        </button>}
        <button type="button" className="script-card-action is-danger" title="删除场次" aria-label={`删除场次 ${scene.sceneNumber}`}
          disabled={disabled || saving} onClick={event => { event.stopPropagation(); onDelete(); }}><Trash2 size={14} /></button>
      </div>
    </header>
    <label className="script-card-heading"><Clapperboard size={15} /><input aria-label="场景标题" value={draft.sceneHeading}
      disabled={disabled || saving} placeholder="场景标题" onChange={event => patch({ sceneHeading: event.target.value })} /></label>
    {speakers.length > 0 && <div className="script-card-speakers"><Users size={12} />
      {speakers.map(name => <span className="script-card-character-tag" key={name}>{name}</span>)}</div>}
    <textarea className="script-card-description" aria-label="场景描述" value={draft.sceneDescription}
      disabled={disabled || saving} placeholder="添加场景描述…" onChange={event => patch({ sceneDescription: event.target.value })} />
    {incomplete.length > 0 && <p className="script-card-warning" role="note">有 {incomplete.length} 条对白缺少说话人或台词内容。</p>}
    <div className="script-card-elements">
      {draft.dialogues.map((element, index) => {
        const isSpeech = element.type === 1 || element.type === 3;
        const Icon = ELEMENT_ICONS[element.type];
        return <div key={element.id} className="script-card-element-wrap">
          <InsertElement index={index} onInsert={insert} />
          <div className={`script-card-element kind-${element.type} ${element.type === 1 && (!element.content.trim() || !element.characterName?.trim()) ? 'is-incomplete' : ''}`}>
            <div className="script-card-element-head">
              <Icon size={13} />
              <select aria-label="元素类型" value={element.type} disabled={disabled || saving}
                onChange={event => patchElement(element.id, { type: Number(event.target.value) as ScriptElementType })}>
                {ELEMENT_TYPES.map(type => <option key={type} value={type}>{ELEMENT_TYPE_LABELS[type]}</option>)}
              </select>
              <button type="button" className="script-card-action is-danger" title="删除元素" disabled={disabled || saving}
                onClick={() => remove(element.id)}><Trash2 size={12} /></button>
            </div>
            {isSpeech && <div className="script-card-speaker-row">
              <input aria-label="说话人" list="script-card-character-options" value={element.characterName ?? ''}
                disabled={disabled || saving} placeholder="角色名" onChange={event => patchElement(element.id, { characterName: event.target.value })} />
              <input aria-label="语气或动作提示" value={element.parenthetical ?? ''} disabled={disabled || saving} placeholder="（语气）"
                onChange={event => patchElement(element.id, { parenthetical: event.target.value })} />
            </div>}
            <textarea aria-label={ELEMENT_TYPE_LABELS[element.type]} value={element.content} disabled={disabled || saving}
              placeholder={ELEMENT_PLACEHOLDERS[element.type]} onChange={event => patchElement(element.id, { content: event.target.value })} />
          </div>
        </div>;
      })}
      {draft.dialogues.length > 0 && <InsertElement index={draft.dialogues.length} onInsert={insert} />}
    </div>
    <div className="script-card-add-row">
      {ELEMENT_TYPES.map(type => { const Icon = ELEMENT_ICONS[type]; return <button type="button" key={type} className="script-card-add-link"
        disabled={disabled || saving} onClick={event => { event.stopPropagation(); insert(draft.dialogues.length, type); }}>
        <Plus size={11} /><Icon size={12} />添加{ELEMENT_TYPE_LABELS[type]}
      </button>; })}
    </div>
  </article>;
}

/** 融光式当前集编辑：分集信息内联编辑，每场本地草稿、单卡保存。 */
export function SceneCardList({ episode, selectedSceneId, disabled, characterOptions,
  onSelectScene, onSaveScene, onSaveEpisode, onInsertSceneAfter, onDeleteScene, onDirtyChange }: SceneCardListProps) {
  const episodeId = episode?.id ?? '';
  const handleEpisodeDirty = useCallback((dirty: boolean) => onDirtyChange(`episode:${episodeId}`, dirty), [episodeId, onDirtyChange]);
  if (!episode) return <main className="script-cards"><p className="muted">从左侧选择分集，或添加一集开始。</p></main>;
  return <main className="script-cards" aria-label={`第${episode.episodeNumber}集场次`}>
    <datalist id="script-card-character-options">{characterOptions.map(name => <option key={name} value={name} />)}</datalist>
    <EpisodeHeader episode={episode} disabled={disabled} onSave={onSaveEpisode} onDirtyChange={handleEpisodeDirty} />
    {episode.scenes.length === 0 && <div className="script-cards-empty">
      <Clapperboard size={34} /><p className="muted">本集暂无场次</p>
      <button type="button" className="button-secondary" disabled={disabled} onClick={() => onInsertSceneAfter(episode.id, null)}>
        <Plus size={14} />添加第一个场次
      </button>
    </div>}
    {episode.scenes.map((scene, index) => <div key={scene.id} className="script-cards-group">
      <div className="script-card-insert"><button type="button" className="script-card-insert-btn" disabled={disabled}
        aria-label={`在${scene.sceneNumber}之前插入场次`}
        onClick={() => onInsertSceneAfter(episode.id, index === 0 ? null : episode.scenes[index - 1].id)}>
        <Plus size={13} /><span>插入场次</span></button></div>
      <SceneCard scene={scene} selected={scene.id === selectedSceneId} disabled={disabled}
        onSelect={() => onSelectScene(scene.id)} onSave={next => onSaveScene(episode.id, next)}
        onDelete={() => onDeleteScene(episode.id, scene.id)}
        onDirtyChange={dirty => onDirtyChange(scene.id, dirty)} />
    </div>)}
    {episode.scenes.length > 0 && <div className="script-card-insert">
      <button type="button" className="script-card-insert-btn" disabled={disabled}
        onClick={() => onInsertSceneAfter(episode.id, episode.scenes.at(-1)?.id ?? null)}><Plus size={13} />新增场次</button>
    </div>}
  </main>;
}
