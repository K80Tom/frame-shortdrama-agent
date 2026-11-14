import { Camera, Clock3, Film, Image as ImageIcon, Plus, Trash2, Video } from 'lucide-react';
import type { FactPlan } from '../facts-editor';
import type { AssetRecord } from '../asset-library';
import { localAssetLink } from '../asset-library';
import { shotVideoPromptPreview } from './workbench';
import type { StoryboardScene, StoryboardShot } from './types';

interface Props {
  scenes: StoryboardScene[];
  shots: StoryboardShot[];
  plan: FactPlan;
  dialogues: FactPlan['content']['dialogues'];
  assets: AssetRecord[];
  selectedShotId: string;
  viewMode: 'card' | 'table';
  readOnlyReason: string | null;
  onSelect: (id: string) => void;
  onUpdate: (id: string, field: 'visualDescription' | 'shotSize' | 'cameraMovement' | 'cameraAngle' | 'sound' | 'duration', value: string | number) => void;
  onAdd: (sceneId: string) => void;
  onDelete: (id: string) => void;
  onOpenFrames: (id: string) => void;
  onOpenAssets: (id: string) => void;
  onProduction: (shotId?: string) => void;
}

function previewAsset(shot: StoryboardShot, scene: StoryboardScene, assets: AssetRecord[]) {
  const ids = [shot.firstFrameAssetId, ...(shot.assetRefs ?? []).map(ref => ref.assetId), ...(scene.characterIds ?? []), scene.locationId].filter(Boolean);
  return assets.find(asset => asset.id === shot.firstFrameAssetId) ?? assets.find(asset => ids.includes(asset.id)) ?? null;
}

export default function StoryboardShotList(props: Props) {
  const { scenes, shots, dialogues, assets, selectedShotId, viewMode, readOnlyReason } = props;
  const dialogueById = new Map(dialogues.map(dialogue => [dialogue.id, dialogue]));

  if (!scenes.length) return <div className="sbw-workspace-empty">
    <div className="sbw-empty-camera"><Camera size={34} strokeWidth={1.4} /></div>
    <h2>暂无分镜内容</h2>
    <p>请在左侧创建分集和场次，或使用顶部 AI 生成</p>
  </div>;

  return <>
    {readOnlyReason && <div className="sbw-readonly">{readOnlyReason}</div>}
    <div className="sbw-scene-list" aria-label={`${viewMode === 'card' ? '卡片' : '表格'}分镜列表`}>
      {scenes.map(scene => {
        const sceneShots = shots.filter(shot => shot.sceneId === scene.id).sort((a, b) => a.order - b.order);
        const sceneDialogueIds = new Set(sceneShots.flatMap(shot => shot.dialogueIds));
        const quotes = dialogues.filter(dialogue => sceneDialogueIds.has(dialogue.id));
        return <section className="sbw-scene" key={scene.id} id={`sbw-scene-${scene.id}`}>
          <header className="sbw-scene-heading">
            <span>场 {scene.order}</span><h3>{scene.title.value || '未命名场次'}</h3>
            <small>{sceneShots.length} 镜{quotes.length ? ` · ${quotes.length} 句对白` : ''}</small>
          </header>
          {!sceneShots.length && <div className="sbw-scene-empty"><Film size={20} /><span>本场暂无镜头</span></div>}
          {viewMode === 'card' ? <div className="sbw-shot-list">
            {sceneShots.map(shot => {
              const asset = previewAsset(shot, scene, assets);
              const imageUrl = localAssetLink(asset?.resourceUrl ?? '');
              const quote = shot.dialogueIds.map(id => dialogueById.get(id)?.sourceRef.quote).filter(Boolean).join(' / ');
              return <article key={shot.id} className={`sbw-shot-card${selectedShotId === shot.id ? ' active' : ''}`} onClick={() => props.onSelect(shot.id)}>
                <div className="sbw-shot-media">
                  {imageUrl ? <img src={imageUrl} alt={asset?.name ?? `镜 ${shot.order} 画面`} /> : <div className="sbw-media-placeholder"><ImageIcon size={27} strokeWidth={1.3} /><span>暂无画面</span></div>}
                  <span className="sbw-shot-media-number">#{shot.order}</span>
                  <span className="sbw-shot-media-duration"><Clock3 size={11} />{shot.design.durationMs / 1000}s</span>
                  <div className="sbw-frame-shortcuts">
                    <button className={shot.firstFrameAssetId ? 'has-frame' : ''} title="设置首帧图片" onClick={event => { event.stopPropagation(); props.onOpenFrames(shot.id); }}>首</button>
                    <button className={shot.lastFrameAssetId ? 'has-frame' : ''} title="设置尾帧图片" onClick={event => { event.stopPropagation(); props.onOpenFrames(shot.id); }}>尾</button>
                  </div>
                </div>
                <div className="sbw-shot-body">
                  <div className="sbw-shot-topline">
                    <button className="sbw-shot-number" onClick={() => props.onSelect(shot.id)}><Camera size={13} />镜 {shot.order}</button>
                    <span className="sbw-shot-tag">{shot.design.shotSize || '未设景别'}</span>
                    <span className="sbw-shot-tag">{shot.design.cameraMovement || '未设运镜'}</span>
                    <button className="sbw-icon-danger" aria-label={`删除镜 ${shot.order}`} title="删除镜头" disabled={Boolean(readOnlyReason)}
                      onClick={event => { event.stopPropagation(); props.onDelete(shot.id); }}><Trash2 size={14} /></button>
                  </div>
                  <textarea aria-label={`镜 ${shot.order} 画面描述`} value={shot.design.visualDescription} readOnly={Boolean(readOnlyReason)}
                    onChange={event => props.onUpdate(shot.id, 'visualDescription', event.target.value)} />
                  {quote && <p className="sbw-shot-quote">{quote}</p>}
                  <div className="sbw-shot-fields">
                    <label>景别<input value={shot.design.shotSize} readOnly={Boolean(readOnlyReason)} onChange={event => props.onUpdate(shot.id, 'shotSize', event.target.value)} /></label>
                    <label>运镜<input value={shot.design.cameraMovement} readOnly={Boolean(readOnlyReason)} onChange={event => props.onUpdate(shot.id, 'cameraMovement', event.target.value)} /></label>
                    <label>时长 (秒)<input type="number" min={1} max={60} value={shot.design.durationMs / 1000} readOnly={Boolean(readOnlyReason)} onChange={event => props.onUpdate(shot.id, 'duration', Number(event.target.value))} /></label>
                  </div>
                </div>
              </article>;
            })}
          </div> : <div className="sbw-table-wrap"><table className="sbw-shot-table">
            <thead><tr>{['镜号', '画面', '首尾帧', '视频', '视频提示词', '关联资产', '景别', '时长', '摄像机角度', '运镜', '分镜内容', '对白', '声音', '操作'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
            <tbody>{sceneShots.map(shot => {
              const asset = previewAsset(shot, scene, assets);
              const imageUrl = localAssetLink(asset?.resourceUrl ?? '');
              const quote = shot.dialogueIds.map(id => dialogueById.get(id)?.sourceRef.quote).filter(Boolean).join('\n');
              const prompt = shotVideoPromptPreview(shot, props.plan, assets);
              const linkedAssets = [...new Map((shot.assetRefs ?? []).map(ref => [ref.assetId, ref])).values()]
                .map(ref => assets.find(item => item.id === ref.assetId)).filter(item => item != null);
              return <tr key={shot.id} className={selectedShotId === shot.id ? 'active' : ''} onClick={() => props.onSelect(shot.id)}>
                <td><button className="sbw-shot-number" onClick={() => props.onSelect(shot.id)}>{shot.order}</button></td>
                <td><button className="sbw-table-preview" aria-label={`选择镜 ${shot.order} 画面`} onClick={() => props.onSelect(shot.id)}>
                  {imageUrl ? <img src={imageUrl} alt={asset?.name ?? `镜 ${shot.order} 画面`} /> : <ImageIcon size={20} strokeWidth={1.4} />}
                </button></td>
                <td><div className="sbw-table-frame-buttons">
                  <button className={shot.firstFrameAssetId ? 'has-frame' : ''} title={shot.firstFrameAssetId ? '首帧已设置' : '设置首帧图片'}
                    onClick={event => { event.stopPropagation(); props.onOpenFrames(shot.id); }}>首</button>
                  <button className={shot.lastFrameAssetId ? 'has-frame' : ''} title={shot.lastFrameAssetId ? '尾帧已设置' : '设置尾帧图片'}
                    onClick={event => { event.stopPropagation(); props.onOpenFrames(shot.id); }}>尾</button>
                </div></td>
                <td><button className="sbw-table-video" aria-label={`打开镜 ${shot.order} 视频制作`} title="尚未生成 · 使用当前采用分镜制作这一镜"
                  onClick={event => { event.stopPropagation(); props.onSelect(shot.id); props.onProduction(shot.id); }}><Video size={19} strokeWidth={1.4} /></button></td>
                <td><textarea className="sbw-table-prompt" aria-label={`镜 ${shot.order} 视频提示词`} rows={4} readOnly value={prompt.prompt}
                  title={prompt.timingIssue ?? '由当前镜画面、对白和资产生成；正式制作会追加上下文'} /></td>
                <td><button className="sbw-table-assets" aria-label={`编辑镜 ${shot.order} 关联资产`}
                  onClick={event => { event.stopPropagation(); props.onOpenAssets(shot.id); }}>
                  {linkedAssets.map(item => <span className="sbw-table-asset" key={item.id}>
                    <span className="sbw-table-asset-thumb">{localAssetLink(item.resourceUrl)
                      ? <img src={localAssetLink(item.resourceUrl) ?? ''} alt="" /> : <ImageIcon size={15} />}</span>
                    <span>{item.name}</span>
                  </span>)}
                  <span className="sbw-table-asset-add"><Plus size={14} />{linkedAssets.length ? '添加' : '关联资产'}</span>
                </button></td>
                <td><input aria-label={`镜 ${shot.order} 景别`} value={shot.design.shotSize} readOnly={Boolean(readOnlyReason)} onChange={event => props.onUpdate(shot.id, 'shotSize', event.target.value)} /></td>
                <td><input aria-label={`镜 ${shot.order} 时长`} type="number" min={1} max={60} value={shot.design.durationMs / 1000} readOnly={Boolean(readOnlyReason)} onChange={event => props.onUpdate(shot.id, 'duration', Number(event.target.value))} /></td>
                <td><input aria-label={`镜 ${shot.order} 摄像机角度`} maxLength={100} placeholder="平视" value={shot.design.cameraAngle ?? ''} readOnly={Boolean(readOnlyReason)} onChange={event => props.onUpdate(shot.id, 'cameraAngle', event.target.value)} /></td>
                <td><input aria-label={`镜 ${shot.order} 运镜`} value={shot.design.cameraMovement} readOnly={Boolean(readOnlyReason)} onChange={event => props.onUpdate(shot.id, 'cameraMovement', event.target.value)} /></td>
                <td><textarea className="sbw-table-content" aria-label={`镜 ${shot.order} 画面描述`} rows={4} value={shot.design.visualDescription} readOnly={Boolean(readOnlyReason)} onChange={event => props.onUpdate(shot.id, 'visualDescription', event.target.value)} /></td>
                <td><textarea className="sbw-table-dialogue" aria-label={`镜 ${shot.order} 对白`} rows={4} readOnly value={quote} placeholder="无对白" /></td>
                <td><textarea className="sbw-table-sound" aria-label={`镜 ${shot.order} 声音`} rows={4} maxLength={2000} placeholder="环境音、音效"
                  value={shot.design.sound ?? ''} readOnly={Boolean(readOnlyReason)} onChange={event => props.onUpdate(shot.id, 'sound', event.target.value)} /></td>
                <td><button className="sbw-icon-danger" aria-label={`删除镜 ${shot.order}`} title="删除镜头" disabled={Boolean(readOnlyReason)}
                  onClick={event => { event.stopPropagation(); props.onDelete(shot.id); }}><Trash2 size={15} /></button></td>
              </tr>;
            })}</tbody>
          </table></div>}
          <button className="sbw-add-shot" disabled={Boolean(readOnlyReason)} onClick={() => props.onAdd(scene.id)}><Plus size={14} />添加镜头</button>
        </section>;
      })}
      <div className="sbw-list-summary">已加载 {scenes.length} 场次 · {shots.length} 镜头</div>
    </div>
  </>;
}
