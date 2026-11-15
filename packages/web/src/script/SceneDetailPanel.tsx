import { Clapperboard, FileText, MapPin, Package, Users } from 'lucide-react';
import type { AssetRecord, ProjectAssetRequirementsResponse, ScriptScene } from '@lyra/shared';
import { matchRequirement, recognizeSceneProps, summarizeScene, type RequirementMatchView } from './workbench-logic';

type RequirementList = ProjectAssetRequirementsResponse['requirements'];

function MatchBadge({ match, assetName }: { match: RequirementMatchView | null; assetName?: string }) {
  if (!match) return <span className="asset-tag missing">未关联资产</span>;
  const className = match.state === 'matched' ? 'ok' : match.state === 'ambiguous' ? 'warn' : 'missing';
  const label = match.state === 'matched' ? (assetName ? `已绑定 · ${assetName}` : '已绑定资产') : match.label;
  return <span className={`asset-tag ${className}`}>{label}</span>;
}
function DetailRow({ name, match, asset }: { name: string; match: RequirementMatchView | null; asset?: AssetRecord }) {
  return <li className="script-detail-row" title={asset?.description ?? undefined}>
    {asset?.resourceUrl && <img className="script-detail-asset-image" src={asset.resourceUrl} alt={`${asset.name}资产`} />}
    <span className="script-detail-name">{name}</span><MatchBadge match={match} assetName={asset?.name} />
  </li>;
}

/** 右栏只读详情：未选场次显示剧本概览，选中后显示场景、角色和资产关联。 */
export function SceneDetailPanel({ scene, episodeNumber, requirements, recognizedProps,
  episodeCount = 0, totalScenes = 0, assets = [] }: {
  scene: ScriptScene | null;
  episodeNumber: number;
  requirements: RequirementList | null;
  recognizedProps: string[];
  episodeCount?: number;
  totalScenes?: number;
  assets?: AssetRecord[];
}) {
  if (!scene) return <aside className="script-detail" aria-label="剧本概览">
    <div className="script-detail-head"><span className="project-kicker">OVERVIEW</span><h3>剧本概览</h3></div>
    <div className="script-overview-stats">
      <span><FileText size={15} /><strong>{episodeCount}</strong><small>分集</small></span>
      <span><Clapperboard size={15} /><strong>{totalScenes}</strong><small>场次</small></span>
    </div>
    <p className="script-detail-empty">选择目录中的场次后，在这里查看场景、出场角色与关联资产。</p>
  </aside>;

  const summary = summarizeScene(scene);
  const requirementProps = (requirements ?? []).filter(item => item.kind === 'prop').map(item => item.name);
  const props = recognizeSceneProps(scene, [...recognizedProps, ...requirementProps]);
  const assetForMatch = (match: RequirementMatchView | null) => assets.find(asset => asset.id === match?.assetId);
  const characterMatches = summary.characters.map(name => {
    const match = matchRequirement(name, 'character', requirements);
    return { name, match, asset: assetForMatch(match) };
  });
  const locationMatch = summary.location ? matchRequirement(summary.location, 'location', requirements) : null;
  const propMatches = props.map(name => {
    const match = matchRequirement(name, 'prop', requirements);
    return { name, match, asset: assetForMatch(match) };
  });
  const dialogueCount = scene.dialogues.filter(item => item.type === 1 || item.type === 3).length;

  return <aside className="script-detail" aria-label="场景详情">
    <div className="script-detail-head">
      <span className="project-kicker">SCENE {scene.sceneNumber || `${episodeNumber}-?`}</span>
      <h3>场景详情</h3>
      <p>{scene.sceneHeading || '未命名场次'}</p>
    </div>
    <section className="script-detail-group">
      <h4><MapPin size={13} />时空</h4>
      <div className="script-detail-facts">
        <span>{scene.intExt ? `${scene.intExt}景` : '内/外待定'}</span>
        <span>{scene.location || '未写地点'}</span>
        <span>{scene.timeOfDay || '未写时间'}</span>
      </div>
    </section>
    <section className="script-detail-group" aria-label="出场角色">
      <h4><Users size={13} />出场角色 <span className="muted">{characterMatches.length}</span></h4>
      {characterMatches.length === 0 ? <p className="script-detail-empty">本场还没有标注说话人。</p>
        : <ul>{characterMatches.map(item => <DetailRow key={item.name} {...item} />)}</ul>}
    </section>
    <section className="script-detail-group" aria-label="场景地点">
      <h4><MapPin size={13} />场景地点</h4>
      {summary.location ? <DetailRow name={summary.location} match={locationMatch} asset={assetForMatch(locationMatch)} />
        : <p className="script-detail-empty">本场未写地点。</p>}
    </section>
    <section className="script-detail-group" aria-label="道具">
      <h4><Package size={13} />道具 <span className="muted">{propMatches.length}</span></h4>
      {propMatches.length === 0 ? <p className="script-detail-empty">本场正文未识别到道具。</p>
        : <ul>{propMatches.map(item => <DetailRow key={item.name} {...item} />)}</ul>}
    </section>
    {scene.sceneDescription && <section className="script-detail-group"><h4>场景描述</h4>
      <p className="script-detail-description">{scene.sceneDescription}</p></section>}
    <div className="script-detail-stats"><span>对白 {dialogueCount}</span><span>角色 {characterMatches.length}</span><span>元素 {scene.dialogues.length}</span></div>
    <p className="script-detail-foot muted">资产状态来自 Lyra 正式资产链；此面板只读，不自动生成素材。</p>
  </aside>;
}
