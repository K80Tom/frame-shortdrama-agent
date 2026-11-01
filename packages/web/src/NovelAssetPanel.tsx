import { useEffect, useState } from 'react';
import { ArrowUpRight, Link2, Save } from 'lucide-react';
import type { NovelItem, NovelRevision } from './novel-editor';
import { assetApi, assetKindLabels, assetLink, bindingBlock, bindingFor, buildAssetBinding, filterAssets, localAssetLink, type AssetBindingInput, type AssetRecord } from './asset-library';
import './assets.css';
import DesktopAssetGeneration, { type DesktopAssetState } from './DesktopAssetGeneration';

export default function NovelAssetPanel({ item, revision, editable, dirty, busy, onSave, onDraftChange, desktop }: {
  item: NovelItem; revision: NovelRevision; editable: boolean; dirty: boolean; busy: boolean;
  onSave: (binding: AssetBindingInput) => void; onDraftChange?: (dirty: boolean) => void;
  desktop?: DesktopAssetState;
}) {
  const binding = bindingFor(revision.content, item);
  const initialAssetId = binding?.status === 'linked' ? binding.asset?.id ?? '' : '';
  const initialNote = binding?.note ?? '';
  const [selectedAssetId, setSelectedAssetId] = useState(initialAssetId);
  const [note, setNote] = useState(initialNote);
  const [query, setQuery] = useState('');
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const block = bindingBlock(item, { editable, dirty, busy });
  const formDirty = selectedAssetId !== initialAssetId || note !== initialNote;
  const matching = item.kind === 'dialogue' ? [] : filterAssets(assets, item.kind, query);
  const selected = assets.find(asset => asset.id === selectedAssetId && asset.kind === item.kind);
  const currentAsset = binding?.asset ?? null;
  const currentLink = currentAsset && assetLink(currentAsset.resourceUrl);
  const selectedLink = selected && assetLink(selected.resourceUrl);

  useEffect(() => {
    let disposed = false;
    setLoading(true); setLoadError('');
    void assetApi<{ assets: AssetRecord[] }>('/api/assets').then(result => { if (!disposed) setAssets(result.assets); })
      .catch(cause => { if (!disposed) setLoadError(cause instanceof Error ? cause.message : '资产目录读取失败。'); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [refresh]);
  useEffect(() => { onDraftChange?.(formDirty); return () => onDraftChange?.(false); }, [formDirty, onDraftChange]);

  function save(status: 'linked' | 'missing') {
    if (block) return;
    try { const request = buildAssetBinding(item, status, selectedAssetId || null, note, assets); setError(''); onSave(request); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '请选择有效的同类型资产。'); }
  }

  if (item.kind === 'dialogue') return null;
  return <section className="novel-asset-panel" aria-label="当前条目资产引用">
    <div className="asset-list-heading"><h4><Link2 size={15} />资产引用</h4><span className={`asset-binding-status ${binding?.status ?? 'unconfirmed'}`}>{binding?.status === 'linked' ? '已关联' : binding?.status === 'needsReview' ? '引用待重核' : binding ? '待补资产' : '先校对确认'}</span></div>
    <p className="novel-note">引用已有素材，不改写小说事实；保存会追加本章新版本，不调用模型。</p>
    {dirty && binding?.status === 'linked' && <p className="novel-note">下方是已保存版本的引用，不代表当前校对草稿仍适用。修改此项并保存后，引用需要重新核对。</p>}
    {binding?.status === 'needsReview' && <p className="novel-message">此条目的事实或确认状态已变化，旧引用不能继续视为有效。请先重新校对确认并保存，再重选资产或明确标记待补。</p>}
    {currentAsset && <div className="asset-bound-record"><small>{binding?.status === 'needsReview' ? '待重核的旧登记快照（不是当前有效引用）' : '已保存的固定资产登记'}</small><strong>{currentAsset.name}</strong><span>{assetKindLabels[currentAsset.kind]}</span><code>{currentAsset.id}</code>{currentLink && <a href={currentLink} target="_blank" rel="noreferrer noopener">打开登记素材 <ArrowUpRight size={12} /></a>}</div>}
    {currentAsset && localAssetLink(currentAsset.resourceUrl) && <a className="novel-local-asset-preview" href={currentAsset.resourceUrl} target="_blank" rel="noreferrer noopener"><img src={currentAsset.resourceUrl} alt={`${currentAsset.name} · 已保存资产预览`} loading="lazy" /></a>}
    {binding?.note && <p className="asset-saved-note">已保存说明：{binding.note}</p>}
    {block && <p className="novel-note asset-block" role="status">{block}</p>}
    <div className="asset-binding-form"><div className="asset-list-heading"><label>查找同类型资产<input disabled={Boolean(block)} value={query} onChange={event => setQuery(event.target.value)} placeholder={`搜索${assetKindLabels[item.kind]}名称或 ID`} /></label><button disabled={busy || loading} onClick={() => setRefresh(value => value + 1)}>刷新资产</button></div>
      {loading && <p className="novel-note" role="status">正在读取资产目录…</p>}{loadError && <p className="novel-errors" role="alert">{loadError}</p>}
      <label>选择已有{assetKindLabels[item.kind]}素材<select aria-label="选择关联资产" disabled={Boolean(block) || loading || Boolean(loadError)} value={selectedAssetId} onChange={event => setSelectedAssetId(event.target.value)}><option value="">请选择；不自动按名称匹配</option>{selected && !matching.some(asset => asset.id === selected.id) && <option value={selected.id}>{selected.name} · 当前选择（不符合搜索条件）</option>}{matching.map(asset => <option key={asset.id} value={asset.id}>{asset.name} · {asset.id}</option>)}</select></label>
      {!loading && !loadError && !matching.length && <p className="novel-note">暂无匹配的同类资产。可以标记待补，或到<a href="#/assets">资产目录</a>登记已有素材后返回刷新。</p>}
      {selected && <div className="asset-choice-detail"><strong>准备关联：{selected.name}</strong><p>{selected.description || '无素材说明，请打开链接后人工判断适用性。'}</p><code>{selected.id}</code>{selectedLink && <a href={selectedLink} target="_blank" rel="noreferrer noopener">查看所选素材 <ArrowUpRight size={12} /></a>}</div>}
      <label>引用说明 / 待补原因（可选）<textarea rows={2} maxLength={2000} disabled={Boolean(block)} value={note} onChange={event => setNote(event.target.value)} placeholder="例如：已有素材服装不符，暂待补充。" /></label>
      <div className="novel-row"><button className="novel-primary" disabled={Boolean(block) || loading || Boolean(loadError) || !selected} onClick={() => save('linked')}><Save size={13} />保存资产引用</button><button disabled={Boolean(block)} onClick={() => save('missing')}>{binding?.status === 'linked' ? '解除引用并标记待补' : '保存为待补资产'}</button>{formDirty && <button disabled={busy} onClick={() => { setSelectedAssetId(initialAssetId); setNote(initialNote); setError(''); }}>放弃引用草稿</button>}</div>
      {formDirty && <p className="novel-note">有未保存的资产选择或说明。请保存或放弃后，再继续修改小说事实。</p>}
      {error && <p className="novel-errors" role="alert">{error}</p>}
    </div>
    {desktop && <DesktopAssetGeneration key={`${revision.id}:${item.id}`} item={item} revision={revision} editable={editable} dirty={dirty} busy={busy} assetDraftDirty={formDirty} desktop={desktop} />}
  </section>;
}
