import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, ArrowUpRight, ChevronDown, FolderOpen, ImageIcon, LoaderCircle, Plus, RefreshCw, Search, X } from 'lucide-react';
import { assetApi, assetFileError, assetKindLabels, assetLink, assetRegistrationErrors, fileBase64, filterAssets, localAssetLink, type AssetKind, type AssetRecord, type AssetRegistration } from './asset-library';
import './asset-library-page.css';

const emptyRegistration: AssetRegistration = { kind: 'character', name: '', description: '', resourceUrl: '' };
const assetDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const assetDateTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function formatDate(value: string, full = false) {
  return Number.isFinite(Date.parse(value)) ? (full ? assetDateTime : assetDate).format(new Date(value)).replaceAll('/', '-') : '日期未知';
}

function AssetDialog({ open, title, onClose, children, className = '' }: { open: boolean; title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);
  return <dialog ref={dialogRef} className={`alib-dialog ${className}`} aria-label={title}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <div className="alib-dialog-heading"><h2>{title}</h2><button className="alib-icon-button" onClick={onClose} aria-label={`关闭${title}`}><X size={18} /></button></div>
    {children}
  </dialog>;
}

/** Cards preview server-owned images; external resources remain click-to-open. */
export function AssetRecordCard({ asset, onOpen }: { asset: AssetRecord; onOpen?: () => void }) {
  const preview = localAssetLink(asset.resourceUrl);
  return <button className="alib-card" onClick={onOpen} aria-label={`查看${assetKindLabels[asset.kind]}资产：${asset.name}`} title={`${asset.name} · ${assetKindLabels[asset.kind]} · ${asset.id}`}>
    <span className="alib-card-cover" aria-hidden="true">{preview ? <img src={preview} alt="" loading="lazy" /> : <ImageIcon size={34} strokeWidth={1.2} />}<span className="alib-card-kind">{assetKindLabels[asset.kind]}</span></span>
    <span className="alib-card-info"><strong>{asset.name}</strong><span>{formatDate(asset.createdAt)}</span></span>
  </button>;
}

/** Only local imports are previewed automatically; external links require a click. */
export function AssetRecordDetails({ asset }: { asset: AssetRecord }) {
  const link = assetLink(asset.resourceUrl);
  const preview = localAssetLink(asset.resourceUrl);
  return <div className="alib-detail">
    {preview && <img className="alib-image-preview" src={preview} alt={`${asset.name}预览`} />}
    <div className="alib-detail-summary"><span className="alib-detail-icon" aria-hidden="true"><ImageIcon size={31} strokeWidth={1.2} /></span><div><span className="alib-detail-kind">{assetKindLabels[asset.kind]}</span><h3>{asset.name}</h3></div></div>
    <dl className="alib-detail-fields"><div><dt>素材说明</dt><dd className="alib-description">{asset.description || '未填写说明'}</dd></div><div><dt>资产 ID</dt><dd><code>{asset.id}</code></dd></div><div><dt>登记时间</dt><dd>{formatDate(asset.createdAt, true)} · 北京时间</dd></div><div><dt>素材链接</dt><dd className="alib-resource-url">{asset.resourceUrl}</dd></div></dl>
    <p className="alib-detail-note">登记记录未自动质检。打开素材后，请人工确认内容与适用性。</p>
    {link ? <a className="alib-open-link" href={link} target="_blank" rel="noreferrer noopener">打开已登记素材 <ArrowUpRight size={14} /></a> : <p className="alib-form-errors" role="alert">素材链接无效，请勿使用。</p>}
    {preview && <a className="alib-download-link" href={`${preview}?download=1`} download>下载本地原图</a>}
  </div>;
}

export default function AssetLibrary({ onUnsavedChange, onCountChange, active = true }: {
  onUnsavedChange?: (dirty: boolean) => void;
  onCountChange?: (count: number) => void;
  active?: boolean;
}) {
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [form, setForm] = useState<AssetRegistration>(emptyRegistration);
  const [sourceMode, setSourceMode] = useState<'link' | 'file'>('link');
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<AssetKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [catalogRead, setCatalogRead] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [registrationFailed, setRegistrationFailed] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<AssetRecord | null>(null);
  const alive = useRef(false);
  const savingRef = useRef(false);
  const loadId = useRef(0);
  const dirty = Boolean(form.name || form.description || form.resourceUrl || form.kind !== 'character' || file);
  const errors = sourceMode === 'link' ? assetRegistrationErrors(form) : [
    ...assetRegistrationErrors({ ...form, resourceUrl: 'https://example.invalid/local-import' }),
    ...(assetFileError(file) ? [assetFileError(file)!] : []),
  ];
  const visible = filterAssets(assets, kind, query);

  async function load() {
    const token = ++loadId.current;
    setLoading(true); setLoadError('');
    try {
      const result = await assetApi<{ assets: AssetRecord[] }>('/api/assets');
      if (alive.current && token === loadId.current) { setAssets(result.assets); setCatalogRead(true); }
    } catch (cause) {
      if (alive.current && token === loadId.current) setLoadError(cause instanceof Error ? cause.message : '未能读取资产目录。');
    } finally { if (alive.current && token === loadId.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; loadId.current += 1; }; }, []);
  useEffect(() => { if (catalogRead) onCountChange?.(assets.length); }, [assets.length, catalogRead, onCountChange]);
  useEffect(() => { onUnsavedChange?.(dirty || saving); return () => onUnsavedChange?.(false); }, [dirty, saving, onUnsavedChange]);
  useEffect(() => { if (!active) { setCreateOpen(false); setSelectedAsset(null); } }, [active]);
  useEffect(() => {
    if (!file || assetFileError(file)) { setFilePreview(null); return; }
    const url = URL.createObjectURL(file); setFilePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    if (!dirty && !saving) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty, saving]);

  async function register() {
    if (savingRef.current || errors.length) return;
    savingRef.current = true; setSaving(true); setMessage(''); setRegistrationFailed(false);
    // Invalidate an older list request so it cannot erase this newly registered record.
    loadId.current += 1; setLoading(false);
    try {
      const metadata = { kind: form.kind, name: form.name.trim(), description: form.description.trim() };
      const saved = sourceMode === 'file' && file
        ? await assetApi<AssetRecord>('/api/assets/import', { ...metadata, contentBase64: await fileBase64(file) })
        : await assetApi<AssetRecord>('/api/assets', { ...metadata, resourceUrl: form.resourceUrl.trim() });
      if (!alive.current) return;
      setAssets(previous => [saved, ...previous.filter(value => value.id !== saved.id)]);
      setCatalogRead(true);
      setForm(emptyRegistration); setFile(null); if (fileInput.current) fileInput.current.value = ''; setLoadError(''); setCreateOpen(false);
      setMessage(sourceMode === 'file' ? '图片已导入个人资产库，刷新后仍可预览，可关联到已校对确认的同类条目。' : '已登记到个人资产库，可在小说中关联到已校对确认的同类条目。');
    } catch (cause) {
      if (alive.current) { setRegistrationFailed(true); setMessage(cause instanceof Error ? cause.message : '登记未完成，输入已保留。'); }
    } finally { if (alive.current) { savingRef.current = false; setSaving(false); } }
  }

  function openRegistration() { setSelectedAsset(null); setCreateOpen(true); }

  return <div className="alib-page">
    <header className="alib-toolbar"><h1>个人资产库</h1><div className="alib-tools">
      <label className="alib-search"><Search size={14} aria-hidden="true" /><input aria-label="搜索资产名称或 ID" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索资产" />{query && <button className="alib-search-clear" aria-label="清空资产搜索" onClick={() => setQuery('')}><X size={13} /></button>}</label>
      <label className="alib-filter"><select aria-label="筛选资产类型" value={kind} onChange={event => setKind(event.target.value as AssetKind | 'all')}><option value="all">全部类型</option>{Object.entries(assetKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><ChevronDown size={12} aria-hidden="true" /></label>
      <button className="alib-refresh" disabled={loading || saving} onClick={() => void load()} aria-label="刷新资产目录" title="刷新资产目录"><RefreshCw className={loading ? 'alib-spin' : ''} size={15} /></button>
      <button className="alib-new" onClick={openRegistration} disabled={saving}><Plus size={15} aria-hidden="true" />新建资产</button>
    </div></header>

    {dirty && !createOpen && <p className="alib-draft-notice">未登记的输入已暂存于当前页面。<button disabled={saving} onClick={openRegistration}>{saving ? '正在登记…' : '继续填写'}</button></p>}
    {message && <p className={`alib-message${registrationFailed ? ' alib-message--error' : ''}`} role={registrationFailed ? 'alert' : 'status'}>{message}</p>}
    {loadError && <div className="alib-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{loadError}</span><button disabled={loading || saving} onClick={() => void load()}><RefreshCw size={13} aria-hidden="true" />重试</button></div>}

    <div className="alib-grid" aria-busy={loading}>
      {visible.map(asset => <AssetRecordCard asset={asset} key={asset.id} onOpen={() => { setCreateOpen(false); setSelectedAsset(asset); }} />)}
      {loading && !assets.length && Array.from({ length: 3 }, (_, index) => <div className="alib-skeleton" key={index} aria-hidden="true"><span /><i /><i /></div>)}
    </div>
    {loading && <p className="alib-loading" role="status"><LoaderCircle className="alib-spin" size={14} aria-hidden="true" />正在读取资产目录…</p>}
    {!loading && !loadError && !visible.length && <section className="alib-empty"><span className="alib-empty-icon" aria-hidden="true">{assets.length ? <Search size={33} strokeWidth={1.1} /> : <FolderOpen size={36} strokeWidth={1.1} />}</span><h2>{assets.length ? '没有找到匹配的资产' : '你的资产库还是空的'}</h2><p>{assets.length ? '换个名称或 ID 试试，或清除类型筛选。' : '添加已有的人物、场景和道具素材，供创作时查找和复用。'}</p><button className={assets.length ? 'alib-secondary' : 'alib-new'} onClick={assets.length ? () => { setQuery(''); setKind('all'); } : openRegistration}>{assets.length ? '清除搜索与筛选' : <><Plus size={15} aria-hidden="true" />新建资产</>}</button></section>}
    {!loading && !loadError && visible.length > 0 && <p className="alib-end">{visible.length} 项资产 · 没有更多了</p>}

    <AssetDialog open={active && createOpen} title="新建资产" onClose={() => setCreateOpen(false)}>
      <p className="alib-form-intro">导入已有图片或登记素材链接，供后续选择与关联。关闭弹窗会保留尚未登记的输入。</p>
      <form className="alib-form" onSubmit={event => { event.preventDefault(); void register(); }}>
        <div className="alib-source-switch" role="group" aria-label="资产来源"><button type="button" aria-pressed={sourceMode === 'link'} disabled={saving} onClick={() => setSourceMode('link')}>登记链接</button><button type="button" aria-pressed={sourceMode === 'file'} disabled={saving} onClick={() => setSourceMode('file')}>上传本地图片</button></div>
        <div className="alib-form-row"><label>资产类型<select aria-label="资产类型" value={form.kind} disabled={saving} onChange={event => setForm(value => ({ ...value, kind: event.target.value as AssetKind }))}>{Object.entries(assetKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>资产名称<input required maxLength={200} disabled={saving} value={form.name} onChange={event => setForm(value => ({ ...value, name: event.target.value }))} placeholder="例如：现代青年 · 深色便装" /></label></div>
        {sourceMode === 'link' ? <><label>已有素材的 HTTPS 链接<input type="url" required maxLength={2000} disabled={saving} value={form.resourceUrl} onChange={event => setForm(value => ({ ...value, resourceUrl: event.target.value }))} placeholder="https://…" /></label><p className="alib-help">链接仅作为记录，不保证可达或永久有效；请勿填写含密钥或账号密码的地址。</p></> : <><label>本地图片<input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" disabled={saving} onChange={event => {
          const selected = event.target.files?.[0] ?? null; setFile(selected);
          if (selected) setForm(value => ({ ...value, name: value.name || selected.name.replace(/\.[^.]+$/, '').slice(0, 200) }));
        }} /></label><p className="alib-help">PNG、JPEG、静态 WebP，最多 6 MiB。原图保存在本机数据库；导入不消耗模型额度。</p>{filePreview && <img className="alib-image-preview" src={filePreview} alt="待导入图片预览" />}</>}
        <label>素材说明（可选）<textarea rows={3} maxLength={2000} disabled={saving} value={form.description} onChange={event => setForm(value => ({ ...value, description: event.target.value }))} placeholder="记录素材的服装、角度、内容或使用限制。" /></label>
        {dirty && errors.length > 0 && <ul className="alib-form-errors">{errors.map(error => <li key={error}>{error}</li>)}</ul>}
        {registrationFailed && message && <p className="alib-form-errors" role="alert">{message}</p>}
        <p className="alib-help">导入会检查格式和大小，不生成、不自动质检。登记记录不可覆盖，当前不提供修改或删除；保存不调用模型。</p>
        <div className="alib-form-actions"><button className="alib-text-button" type="button" disabled={!dirty || saving} onClick={() => { if (window.confirm('放弃尚未登记的资产信息？')) { setForm(emptyRegistration); setFile(null); if (fileInput.current) fileInput.current.value = ''; setMessage(''); setRegistrationFailed(false); } }}>清空表单</button><button className="alib-secondary" type="button" onClick={() => setCreateOpen(false)}>稍后继续</button><button className="alib-new" disabled={saving || errors.length > 0} type="submit">{saving ? <><LoaderCircle className="alib-spin" size={14} aria-hidden="true" />正在登记…</> : '保存到资产目录'}</button></div>
      </form>
    </AssetDialog>
    <AssetDialog open={active && Boolean(selectedAsset)} title="资产详情" onClose={() => setSelectedAsset(null)} className="alib-detail-dialog">{selectedAsset && <AssetRecordDetails asset={selectedAsset} />}</AssetDialog>
  </div>;
}
