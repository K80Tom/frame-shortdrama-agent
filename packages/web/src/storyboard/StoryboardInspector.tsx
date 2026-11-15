import { useEffect, useState } from 'react';
import { Check, FileText, Film, Image, LoaderCircle, Mic2, Package, Play, Trash2, Upload, User, Video } from 'lucide-react';
import { type AssetRecord, type CharacterVoiceAsset, type StoryboardVoiceBinding } from '@lyra/shared';
import type { FactPlan } from '../facts-editor';
import { localAssetLink } from '../asset-library';
import { relevantEntityIds, shotVideoPromptPreview, storyboardDialogueSpeakerId } from './workbench';
import type { StoryboardAssetRef, StoryboardScene, StoryboardShot } from './types';
import type { ProductionRun } from '../production-automation';

interface Props {
  projectId: string;
  plan: FactPlan | null;
  scene: StoryboardScene | undefined;
  shot: StoryboardShot | null;
  assets: AssetRecord[];
  readOnly: boolean;
  coverageComplete: boolean;
  adopted: boolean;
  stale: boolean;
  dirty: boolean;
  pruneRequired?: boolean;
  adopting: boolean;
  frameUploading: 'first' | 'last' | null;
  voiceUploading: boolean;
  voiceLibrary: StoryboardVoiceBinding[];
  voiceAssets?: CharacterVoiceAsset[];
  videoRun: ProductionRun | null;
  videoBusy: boolean;
  onVoiceUpload: (speakerEntityId: string, assetId: string, file: File, options: { displayName: string }) => Promise<void>;
  onVoiceSelect: (speakerEntityId: string, profileId: string) => void;
  onAsset: (entity: StoryboardAssetRef, assetId: string) => void;
  onFrame: (frame: 'first' | 'last', assetId: string) => void;
  onFrameUpload: (frame: 'first' | 'last', file: File) => Promise<void>;
  onProduction: (shotId?: string) => void;
  onAdopt: () => void;
}

const kindLabel = { character: '人物', location: '地点', prop: '道具' } as const;

export default function StoryboardInspector(props: Props) {
  const { shot, scene, plan, assets } = props;
  const [manualCharacterId, setManualCharacterId] = useState('');
  const [manualAssetId, setManualAssetId] = useState('');
  useEffect(() => { setManualCharacterId(''); setManualAssetId(''); }, [shot?.id]);
  const relevant = relevantEntityIds(scene, shot, plan);
  const entities = plan ? [
    ...plan.content.characters.map(entity => ({ entity, kind: 'character' as const })),
    ...plan.content.locations.map(entity => ({ entity, kind: 'location' as const })),
    ...plan.content.props.map(entity => ({ entity, kind: 'prop' as const })),
  ].filter(item => relevant.has(item.entity.id) || shot?.assetRefs?.some(ref => ref.entityId === item.entity.id)) : [];
  const availableCharacters = plan?.content.characters.filter(character => !entities.some(item => item.entity.id === character.id)) ?? [];
  const characterAssets = assets.filter(asset => asset.kind === 'character');
  const dialogueIds = new Set(shot?.dialogueIds ?? []);
  const dialogues = plan?.content.dialogues.filter(line => dialogueIds.has(line.id)) ?? [];
  const voiceSpeakers = [...new Set(dialogues.map(line => storyboardDialogueSpeakerId(line)).filter((id): id is string => Boolean(id)))]
    .flatMap(id => { const character = plan?.content.characters.find(item => item.id === id); return character ? [character] : []; });
  const promptPreview = shot && plan ? shotVideoPromptPreview(shot, plan, assets) : { prompt: '', timingIssue: null };
  const videoArtifacts = props.videoRun?.artifacts.filter(item => item.kind === 'video' && item.url) ?? [];
  const latestVideo = videoArtifacts[videoArtifacts.length - 1];
  const videoIssue = props.videoRun?.issues.find(item => item.status === 'open');
  const videoActive = !!props.videoRun && ['queued', 'running', 'waitingHuman', 'paused', 'pausedBudget', 'reconciling'].includes(props.videoRun.status);
  return <aside className="sbw-inspector">
    <header className="sbw-column-header"><div><span>ASSET / MEDIA</span><h2>{shot ? `镜 ${shot.order} 制作输入` : '镜头详情'}</h2>
      <small>{scene ? `场 ${scene.order} · ${scene.title.value}` : '选择镜头后查看'}</small></div></header>
    {shot && scene ? <div className="sbw-inspector-scroll">
      <section className="sbw-inspector-section" id="sbw-shot-assets">
        <h3><Package size={15} />子资产引用<small>{(shot.assetRefs ?? []).length}/{entities.length}</small></h3>
        {entities.map(({ entity, kind }) => {
          const selected = (shot.assetRefs ?? []).find(ref => ref.entityId === entity.id);
          const asset = assets.find(item => item.id === selected?.assetId);
          return <div className="sbw-asset-row" key={entity.id}>
            <div className="sbw-asset-thumb">{asset?.resourceUrl ? <img src={asset.resourceUrl} alt="" /> : <User size={18} />}</div>
            <div className="sbw-asset-fields"><strong>{entity.name.value}</strong><small>{kindLabel[kind]} · {asset ? asset.name : '未绑定资产'}</small>
              <div className="sbw-asset-select">
                <select aria-label={`${entity.name.value}资产`} value={selected?.assetId ?? ''} disabled={props.readOnly}
                  onChange={event => props.onAsset({ entityId: entity.id, kind, assetId: '' }, event.target.value)}>
                  <option value="">暂不绑定</option>
                  {assets.filter(item => item.kind === kind).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                {kind === 'character' && selected && <button className="sbw-asset-remove" aria-label={`将${entity.name.value}移出本镜`} disabled={props.readOnly}
                  onClick={() => props.onAsset({ entityId: entity.id, kind, assetId: selected?.assetId ?? '' }, '')}>移出本镜</button>}
              </div>
            </div>
          </div>;
        })}
        <div className="sbw-person-add">
          <strong>手动添加人物</strong>
          <select aria-label="选择要添加的人物" value={manualCharacterId} disabled={props.readOnly}
            onChange={event => { setManualCharacterId(event.target.value); setManualAssetId(''); }}>
            <option value="">选择剧本人物</option>
            {availableCharacters.map(character => <option key={character.id} value={character.id}>{character.name.value}</option>)}
          </select>
          <select aria-label="选择新增人物资产" value={manualAssetId} disabled={props.readOnly || !manualCharacterId}
            onChange={event => setManualAssetId(event.target.value)}>
            <option value="">选择人物图片资产</option>
            {characterAssets.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
          </select>
          <button className="sbw-person-add-button" disabled={props.readOnly || !manualCharacterId || !manualAssetId}
            onClick={() => {
              props.onAsset({ entityId: manualCharacterId, kind: 'character', assetId: manualAssetId }, manualAssetId);
              setManualCharacterId(''); setManualAssetId('');
            }}>添加到本镜</button>
          <small>仅调整当前镜头的参考人物，不修改剧本人物库；移出后不再作为本镜参考图。</small>
        </div>
        {!availableCharacters.length && <p className="sbw-muted">其他剧本人物均已显示；可在上方更换图片或移出本镜。</p>}
        {!entities.length && <p className="sbw-muted">当前场次没有自动关联实体，可手动添加人物。</p>}
      </section>
      <section className="sbw-inspector-section" id="sbw-shot-frames">
        <h3><Image size={15} />首尾帧<small>镜头图片绑定</small></h3>
        <p className="sbw-muted">可上传 PNG、JPEG、静态 WebP（最大 6 MiB），或选择已有图片资产。上传会写入本地资产库，绑定需保存为新候选。</p>
        <div className="sbw-frame-list">{(['first', 'last'] as const).map(frame => {
          const label = frame === 'first' ? '首帧' : '尾帧';
          const assetId = frame === 'first' ? shot.firstFrameAssetId : shot.lastFrameAssetId;
          const otherAssetId = frame === 'first' ? shot.lastFrameAssetId : shot.firstFrameAssetId;
          const asset = assets.find(item => item.id === assetId);
          const previewUrl = asset ? localAssetLink(asset.resourceUrl) : null;
          const disabled = props.readOnly || !!props.frameUploading || (frame === 'last' && !shot.firstFrameAssetId);
          return <div className="sbw-frame-control" key={frame}>
            <div className="sbw-frame-preview">{previewUrl ? <img src={previewUrl} alt={`${label}预览`} /> : <Image size={25} />}</div>
            <div className="sbw-frame-settings"><strong>{label}</strong>
              <small>{asset?.name ?? (assetId ? '图片资产不可用' : frame === 'last' && !shot.firstFrameAssetId ? '请先设置首帧' : '未设置图片')}</small>
              <select aria-label={`${label}图片资产`} value={assetId ?? ''} disabled={disabled}
                onChange={event => props.onFrame(frame, event.target.value)}>
                <option value="">未设置</option>
                {assets.filter(item => item.resourceUrl && item.id !== otherAssetId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <div className="sbw-frame-actions">
                <label className={disabled ? 'sbw-frame-upload disabled' : 'sbw-frame-upload'}><Upload size={12} />
                  {props.frameUploading === frame ? '导入中…' : assetId ? '上传替换' : '上传图片'}
                  <input aria-label={`上传${label}图片`} type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled}
                    onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void props.onFrameUpload(frame, file); }} />
                </label>
                <button className="sbw-frame-clear" disabled={props.readOnly || !assetId || !!props.frameUploading}
                  onClick={() => props.onFrame(frame, '')}><Trash2 size={12} />清除</button>
              </div>
            </div>
          </div>;
        })}</div>
        <small className="sbw-muted">尾帧不能单独使用，首尾帧不能选择同一图片；清除首帧会同时清除尾帧。</small>
      </section>
      <section className="sbw-inspector-section" id="sbw-shot-video">
        <h3><Video size={15} />单镜视频<small>{props.videoRun ? props.videoRun.status === 'completed' ? '已生成' : videoActive ? '生成中' : '需要处理' : '未生成'}</small></h3>
        <p className="sbw-muted">使用当前正式分镜、已绑定资产和视频提示词直接生成；每镜 1 条，不使用 3D，不抽卡。</p>
        {latestVideo && <video className="sbw-shot-video-preview" controls preload="metadata" src={latestVideo.url} aria-label={`镜 ${shot.order} 生成视频`} />}
        {videoIssue && <p className="sbw-timing-warning" role="alert">{videoIssue.message}</p>}
        {videoIssue && /MODEL_NOT_CONFIGURED|CAPABILITY_UNAVAILABLE/u.test(videoIssue.code) && <a className="sbw-production-link" href="#/settings/models">配置视频模型后在任务详情中局部重试</a>}
        <button className="sbw-production-link sbw-generate-shot-video" disabled={props.videoBusy}
          onClick={() => { if (props.shot) props.onProduction(props.shot.id); }}>
          {videoActive ? <LoaderCircle className="sbw-spin" size={14} /> : latestVideo ? <Play size={14} /> : <Video size={14} />}
          {videoActive ? '当前镜正在生成' : latestVideo ? '重新生成当前镜' : '生成当前镜视频'}
        </button>
        {props.videoRun && <a className="sbw-video-run-link" href={`#/projects/${props.projectId}/production`}>查看本次运行与费用</a>}
      </section>
      <section className="sbw-inspector-section" id="sbw-shot-voices">
        <h3><Mic2 size={15} />角色参考音色<small>{shot.voiceBindings?.length ?? 0}/{voiceSpeakers.length}</small></h3>
        <p className="sbw-muted">人物资产已有音色时自动装填；上传 WAV/MP3（最大 16 MiB）后会保存到人物资产，供同人物的其他镜头复用。</p>
        {voiceSpeakers.map(character => {
          const binding = (shot.voiceBindings ?? []).find(item => item.speakerEntityId === character.id);
          const assetId = (shot.assetRefs ?? []).find(ref => ref.entityId === character.id && ref.kind === 'character')?.assetId ?? '';
          const assetVoice = props.voiceAssets?.find(item => item.assetId === assetId && item.binding.speakerEntityId === character.id)?.binding;
          const library = props.voiceLibrary.filter((item, index, all) => item.speakerEntityId === character.id
            && all.findIndex(other => other.speakerEntityId === item.speakerEntityId && other.profile.id === item.profile.id) === index);
          return <div className="sbw-voice-row" key={character.id}>
            <strong>#{character.name.value}</strong>
            <select aria-label={`${character.name.value}参考音色`} value={binding?.profile.id ?? ''}
              disabled={props.readOnly || props.voiceUploading} onChange={event => props.onVoiceSelect(character.id, event.target.value)}>
              <option value="">不使用参考音色</option>
              {library.map(item => <option key={item.profile.id} value={item.profile.id}>{item.profile.displayName}</option>)}
            </select>
            <label className={props.readOnly || props.voiceUploading || !assetId ? 'sbw-frame-upload disabled' : 'sbw-frame-upload'}><Upload size={12} />{props.voiceUploading ? '上传中…' : '上传音色'}
              <input aria-label={`上传${character.name.value}音色`} type="file" accept="audio/wav,audio/x-wav,audio/mpeg,.wav,.mp3"
                disabled={props.readOnly || props.voiceUploading || !assetId}
                onChange={event => { const file = event.target.files?.[0]; event.target.value = '';
                  if (file) void props.onVoiceUpload(character.id, assetId, file, { displayName: file.name.replace(/\.[^.]+$/u, '') }); }} />
            </label>
            {binding ? <small>{binding.profile.displayName} · {assetVoice?.profile.id === binding.profile.id ? '已从人物资产装填' : '已装填到当前镜'}</small>
              : !assetId && <small>请先在上方绑定人物图片资产，再上传音色</small>}
          </div>;
        })}
        {!voiceSpeakers.length && <p className="sbw-muted">本镜没有具名角色对白，无需绑定参考音色。</p>}
      </section>
      <section className="sbw-inspector-section">
        <h3><Video size={15} />视频提示词预览<small>基础提示词</small></h3>
        <p className="sbw-muted">与视频运行时使用同一组装函数；正式生成会追加项目视觉风格及已确认的声音上下文。</p>
        <pre className="sbw-video-prompt">{promptPreview.prompt}</pre>
        {promptPreview.timingIssue && <p className="sbw-timing-warning" role="alert">{promptPreview.timingIssue}</p>}
        <small className="sbw-muted">时长 {Math.max(4, Math.min(30, Math.ceil(shot.design.durationMs / 1000)))} 秒 · {shot.voiceBindings?.length ? '原生参考音色已启用，正式混音仍由独立声音链负责' : '未启用原生参考音色'}</small>
      </section>
      <section className="sbw-inspector-section">
        <h3><FileText size={15} />对白与原文证据</h3>
        {dialogues.map(line => <blockquote key={line.id}>{line.sourceRef.quote}</blockquote>)}
        {shot.sourceRefs.map(ref => <details key={`${ref.start}:${ref.end}`} open={shot.sourceRefs.length === 1}>
          <summary>原文 {ref.start}–{ref.end}</summary><p>{ref.quote}</p></details>)}
      </section>
    </div> : <div className="sbw-empty"><Image size={28} /><p>在中栏选择一个镜头，查看资产、首尾帧、视频和原文证据。</p></div>}
    <footer className="sbw-adopt-footer">
      <button className="sbw-episode-production" disabled={props.videoBusy} onClick={() => props.onProduction()}><Film size={14} />生成本集视频</button>
      {!props.stale && !props.coverageComplete && <small>覆盖全部保留场次和对白后才能采用。</small>}
      {!props.stale && props.dirty && <small>将先保存为新候选，再采用；原版本保持不变。</small>}
      {props.stale && <small>旧版本仅供查看，不能编辑或采用。</small>}
      {!props.stale && props.pruneRequired && <small>已删除集的镜头将在保存并采用时剔除，其他集资产绑定保持不变。</small>}
      <button className="sbw-adopt" disabled={!props.coverageComplete || props.stale || (props.adopted && !props.dirty && !props.pruneRequired) || props.adopting}
        onClick={props.onAdopt}><Check size={15} />{props.adopting ? '保存并采用中…' : props.dirty || props.pruneRequired ? '保存并采用新版本' : props.adopted ? '当前已采用' : '采用为正式分镜'}</button>
    </footer>
  </aside>;
}
