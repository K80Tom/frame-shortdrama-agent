import { useEffect, useRef, useState, type RefObject } from 'react';
import { ArrowLeft, ArrowUpRight, Check, Copy, Download, FileText, Film, Image, KeyRound, Pencil, Plus, RefreshCw, Save, Settings2, ShieldCheck, Sparkles } from 'lucide-react';
import { Card, PageHeading, Tag } from './components';
import { compatibleProfiles, copyProfileDraft, isTextRole, kindForRole, kindNames, modelRoles, modelSettingsApi,
  profileDraft, profilePayload, roleInfo, validateProfileDraft, type ModelCatalog, type ModelConnection, type ModelProfile, type ModelRole, type ProfileDraft } from './model-connections';
import './model-connections.css';
import './model-library.css';

const icons = { breakdown: FileText, image: Image, video: Film, general: Sparkles };
type Editor = { profile?: ModelProfile; copySource?: ModelProfile; draft: ProfileDraft; baseline: ProfileDraft };
const signal = () => AbortSignal.timeout(15000);

export function ModelConnectionSummary() {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void modelSettingsApi<ModelCatalog>('/api/model-profiles', undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]))
      .then(result => { if (!controller.signal.aborted) setCatalog(result); }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);
  return <Card className="settings-card"><span className="round-icon"><Settings2 size={23} /></span><h2>模型连接</h2>
    <Tag>{error ? '后端暂不可用' : catalog ? `${catalog.profiles.length} 个已保存连接 · ${catalog.connections.filter(item => item.configured).length} 个用途已配置` : '读取配置中'}</Tag>
    <p>先保存多套完整模型连接，再为拆解、生图、生视频和通用用途选择。切换不覆盖原模型的地址和密钥。</p>
    <p className="settings-small">密钥只保存在本机后端、不回显。小说资产使用生图连接；「自动成片」使用视频连接生成一段视频，尚未绑定分镜制作。</p>
    <a className="button secondary" href="#/settings/models">管理模型连接 <ArrowUpRight size={14} /></a>
  </Card>;
}

export function ProfileCard({ profile, disabled, onEdit, onCopy }: { profile: ModelProfile; disabled: boolean;
  onEdit: () => void; onCopy: () => void }) {
  return <article className="saved-model-card">
    <div className="saved-model-top"><Tag>{kindNames[profile.kind]}</Tag><span className={`model-status ${profile.configured ? 'configured' : ''}`}><i />{profile.configured ? '配置完整' : '待补配置'}</span></div>
    <h3>{profile.name}</h3><code>{profile.model || '尚未填写模型 ID'}</code>
    <p><KeyRound size={12} />{profile.hasApiKey ? '密钥已保存 · 不回显' : '尚未设置密钥'}<span>{profile.authType === 'bearer' ? 'Bearer' : 'api-key'}</span></p>
    <div className="saved-model-roles">{profile.roles.length ? profile.roles.map(role => <span key={role}>{roleInfo[role].short}正在使用</span>) : <span>已保存，未分配用途</span>}</div>
    <div className="saved-model-actions"><button className="button secondary" disabled={disabled} onClick={onEdit} aria-label={`编辑 ${profile.name}`}><Pencil size={13} />编辑连接</button>
      <button className="button secondary" disabled={disabled} onClick={onCopy} aria-label={`复制 ${profile.name}`}><Copy size={13} />复制连接</button></div>
  </article>;
}

export function RoleSelection({ item, profiles, selectedId, busy, onChange, onApply, onAdd }: { item: ModelConnection; profiles: ModelProfile[];
  selectedId: string; busy: boolean; onChange: (id: string) => void; onApply: () => void; onAdd: () => void }) {
  const choices = compatibleProfiles(profiles, item.role);
  const Icon = icons[item.role];
  const changed = selectedId !== (item.profileId ?? '');
  const valid = !selectedId || choices.some(p => p.id === selectedId);
  const picked = choices.find(p => p.id === selectedId);
  return <section className="model-role-choice model-form panel" aria-label={`${roleInfo[item.role].short}选择`}>
    <div className="model-form-heading"><span className="round-icon"><Icon size={23} /></span><div><small>{roleInfo[item.role].en}</small><h2>{roleInfo[item.role].title}</h2></div><Tag>{isTextRole(item.role) ? '文本路由' : item.role === 'image' ? '资产生图已接入' : '任务协议已接入'}</Tag></div>
    <p className="model-form-description">{roleInfo[item.role].description}</p>
    <div className="model-selection-row"><label>使用哪个模型<select aria-label={`${roleInfo[item.role].short}使用的连接`} disabled={busy} value={valid ? selectedId : ''} onChange={event => onChange(event.target.value)}>
      <option value="">不分配模型（停用此用途）</option>{choices.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model || '未填写模型 ID'}{profile.configured ? '' : ' · 配置待补'}</option>)}
    </select></label><button className="button primary" disabled={busy || !changed || !valid} onClick={onApply}><Check size={15} />应用到此用途</button></div>
    <p className="model-choice-current">当前已保存：<strong>{item.profileName ?? '未分配'}</strong>{changed ? ' · 选择尚未应用' : ' · 切换不覆盖连接库'}</p>
    {picked && !picked.configured && <p className="model-field-help">此连接配置不完整，选用后仍不能调用模型；请在连接库编辑补齐。</p>}
    {!choices.length && <p className="model-field-help">还没有{kindNames[kindForRole(item.role)]}连接。<button className="model-inline-button" disabled={busy} onClick={onAdd}>添加此类连接</button>；不能把文本连接当作生图或视频连接。</p>}
    {item.role === 'image' && <p className="model-field-help">小说条目标记待补后，可在校对页为每个候选单独授权生成 1 张图；图片自动导入候选区，只有人工确认后才关联资产。</p>}
    {item.role === 'video' && <p className="model-field-help">「自动成片」可显式授权提交 Seedance 任务并持续查看进度；当前生成独立视频片段，尚未绑定小说或分镜生产任务。</p>}
  </section>;
}

function ProfileEditor({ editor, busy, onEdit, onSave, onCancel, editorRef }: { editor: Editor; busy: boolean;
  onEdit: (patch: Partial<ProfileDraft>) => void; onSave: () => void; onCancel: () => void; editorRef: RefObject<HTMLElement | null> }) {
  const { draft, profile, copySource } = editor;
  const canReuse = copySource && draft.endpoint.trim() === copySource.endpoint && draft.authType === copySource.authType;
  return <section className="model-profile-editor" ref={editorRef} aria-label="模型连接编辑器">
    <form className="model-form panel" autoComplete="off" onSubmit={event => { event.preventDefault(); onSave(); }}>
      <div className="model-form-heading"><span className="round-icon"><Settings2 size={23} /></span><div><small>SAVED MODEL CONNECTION</small><h2>{profile ? `编辑 ${profile.name}` : copySource ? '复制为新模型连接' : '添加模型连接'}</h2></div><Tag>{profile ? '修改已有连接' : '不会自动分配用途'}</Tag></div>
      <p className="model-form-description">{profile?.roles.length ? `这份连接正在用于：${profile.roles.map(role => roleInfo[role].short).join('、')}。修改将影响这些用途的新任务；进行中的任务不变。` : '名称、地址、模型与密钥作为一套连接保存。保存不调用上游，也不改变当前用途选择。'}</p>
      <fieldset disabled={busy}>
        <div className="model-field-row"><label>连接名称<input aria-label="连接名称" maxLength={80} value={draft.name} placeholder="例如 DeepSeek、Kimi K3" onChange={event => onEdit({ name: event.target.value })} /></label>
          <label>连接类型<select aria-label="连接类型" value={draft.kind} disabled={Boolean(profile?.roles.length)} onChange={event => onEdit({ kind: event.target.value as ProfileDraft['kind'] })}><option value="text">文本模型</option><option value="image">生图模型</option><option value="video">生视频模型</option></select></label></div>
        <label>接口地址 <span>完整 HTTPS URL</span><input aria-label="接口地址" type="url" maxLength={2048} value={draft.endpoint} placeholder={`https://api.example.com/v1/${draft.kind === 'text' ? 'chat/completions' : draft.kind === 'image' ? 'images/generations' : 'videos'}`} onChange={event => onEdit({ endpoint: event.target.value })} /></label>
        <p className="model-field-help">{draft.kind === 'text' ? '兼容 Chat Completions，包含 /chat/completions。不要只填 Base URL。' : draft.kind === 'image' ? '填写完整的图片生成接口（例如 /images/generations）。' : '填写 Seedance 完整的任务集合接口（/contents/generations/tasks）。'}</p>
        <div className="model-field-row"><label>模型名称<input aria-label="模型名称" list={draft.kind === 'text' ? 'text-model-suggestions' : undefined} maxLength={100} value={draft.model} placeholder="服务商提供的准确模型 ID" onChange={event => onEdit({ model: event.target.value })} /></label>
          <label>鉴权方式<select aria-label="鉴权方式" value={draft.authType} onChange={event => onEdit({ authType: event.target.value as ProfileDraft['authType'] })}><option value="bearer">Authorization: Bearer</option><option value="api-key">api-key 请求头</option></select></label></div>
        <datalist id="text-model-suggestions"><option value="kimi-k3" /><option value="GPT-5.6 Sol" /><option value="GPT-5.6 Terra" /><option value="deepseek-v4.1-flash-1017" /></datalist>
        {copySource && <><label className="model-checkbox"><input type="checkbox" checked={Boolean(draft.copyCredentialsFrom)} disabled={!canReuse} onChange={event => onEdit({ copyCredentialsFrom: event.target.checked ? { profileId: copySource.id, revision: copySource.revision } : undefined, apiKey: '', clearApiKey: false })} />复用「{copySource.name}」已保存的密钥（不回显）</label><p className="model-field-help">复用只允许相同地址和鉴权方式；改用其他接口请填写新密钥。复制后两份连接独立。</p></>}
        <label>API 密钥 <span><KeyRound size={12} />{profile?.hasApiKey ? '已保存 · 不回显' : draft.copyCredentialsFrom ? '从原连接复用 · 不回显' : '尚未设置'}</span><input aria-label="API 密钥" type="password" autoComplete="new-password" maxLength={4096} value={draft.apiKey} disabled={draft.clearApiKey || Boolean(draft.copyCredentialsFrom)} placeholder={profile?.hasApiKey ? '留空保留现有密钥；输入以替换' : '输入此模型的 API Key'} onChange={event => onEdit({ apiKey: event.target.value })} /></label>
        {profile?.hasApiKey && <label className="model-checkbox"><input type="checkbox" checked={draft.clearApiKey} onChange={event => onEdit({ clearApiKey: event.target.checked, apiKey: '' })} />保存时清除此连接的密钥（所有引用它的用途都会停用）</label>}
        <div className="model-field-row">{draft.kind === 'text' && <label>最大输出 Token<input aria-label="最大输出 Token" type="number" min={256} max={32768} step={1} value={draft.maxOutputTokens} onChange={event => onEdit({ maxOutputTokens: Number(event.target.value) })} /></label>}
          <label>请求超时（秒）<input aria-label="请求超时（秒）" type="number" min={1} max={600} step={1} value={draft.timeoutMs / 1000} onChange={event => onEdit({ timeoutMs: Number(event.target.value) * 1000 })} /></label></div>
      </fieldset>
      <div className="model-save-row"><span>密钥仅存本机后端 · 保存后清空输入框</span><div className="saved-model-actions"><button type="button" className="button secondary" disabled={busy} onClick={onCancel}>取消编辑</button><button type="submit" className="button primary" disabled={busy || Boolean(profile && JSON.stringify(draft) === JSON.stringify(editor.baseline))}><Save size={15} />保存连接</button></div></div>
    </form>
  </section>;
}

export default function ModelConnections({ onUnsavedChange }: { onUnsavedChange?: (dirty: boolean) => void }) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [selections, setSelections] = useState<Partial<Record<ModelRole, string>>>({});
  const [selected, setSelected] = useState<ModelRole>('breakdown');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const editorRef = useRef<HTMLElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const editorDirty = Boolean(editor && JSON.stringify(editor.draft) !== JSON.stringify(editor.baseline));
  const dirty = Object.keys(selections).length > 0 || editorDirty;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onUnsavedChange?.(dirty || Boolean(busy)); return () => onUnsavedChange?.(false); }, [dirty, busy, onUnsavedChange]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void modelSettingsApi<ModelCatalog>('/api/model-profiles', undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]))
      .then(result => { if (!controller.signal.aborted) setCatalog(result); })
      .catch(() => { if (!controller.signal.aborted) setError('无法读取连接库。请确认本机后端已启动再重试；未覆盖任何已保存配置。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);
  useEffect(() => { if (editor) editorRef.current?.scrollIntoView({ block: 'start' }); }, [Boolean(editor)]);
  useEffect(() => { if (error) errorRef.current?.scrollIntoView({ block: 'center' }); }, [error]);
  const item = catalog?.connections.find(c => c.role === selected);
  async function action(label: string, work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(label); setMessage(''); setError('');
    try { await work(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error && cause.name !== 'TimeoutError' ? cause.message
      : '保存响应超时，结果未知。请重新读取配置核对，不要盲目重复保存。'); }
    finally { busyRef.current = false; if (mounted.current) setBusy(''); }
  }
  function choose(role: ModelRole, id: string) {
    const current = catalog?.connections.find(c => c.role === role)?.profileId ?? '';
    setSelections(values => { const next = { ...values }; if (current === id) delete next[role]; else next[role] = id; return next; });
    setMessage(''); setError('');
  }
  function apply() {
    if (!item) return;
    const role = selected; const id = selections[role] ?? item.profileId ?? '';
    void action('应用模型选择', async () => {
      const result = await modelSettingsApi<ModelCatalog>(`/api/model-assignments/${role}`, { profileId: id || null, expectedRevision: item.revision }, signal());
      if (!mounted.current) return;
      setCatalog(result); setSelections(values => { const next = { ...values }; delete next[role]; return next; });
      setMessage(`${roleInfo[role].short}选择已保存，新任务使用所选连接。原模型配置仍在库中；未请求上游。`);
    });
  }
  function openEditor(profile?: ModelProfile, copy = false) {
    if (editorDirty && !window.confirm('当前连接编辑尚未保存，确定放弃后打开另一份？')) return;
    const draft = copy && profile ? copyProfileDraft(profile) : profileDraft(profile, kindForRole(selected));
    setEditor({ profile: copy ? undefined : profile, copySource: copy ? profile : undefined, draft, baseline: draft });
    setMessage(''); setError('');
    if (editor) editorRef.current?.scrollIntoView({ block: 'start' });
  }
  function edit(patch: Partial<ProfileDraft>) {
    setEditor(current => {
      if (!current) return null;
      const draft = { ...current.draft, ...patch };
      if (current.copySource && (draft.endpoint.trim() !== current.copySource.endpoint || draft.authType !== current.copySource.authType)) draft.copyCredentialsFrom = undefined;
      return { ...current, draft };
    });
    setMessage(''); setError('');
  }
  function saveProfile() {
    if (!editor) return;
    const issue = validateProfileDraft(editor.draft);
    if (issue) { setError(issue); return; }
    if (editor.draft.clearApiKey && !window.confirm('清除这份连接的密钥后，引用它的所有用途将不能调用模型。确定保存？')) return;
    const current = editor;
    void action('保存模型连接', async () => {
      const result = await modelSettingsApi<ModelCatalog>(`/api/model-profiles${current.profile ? `/${current.profile.id}` : ''}`, profilePayload(current.draft, current.profile), signal());
      if (!mounted.current) return;
      setCatalog(result); setEditor(null); setMessage('模型连接已保存，密钥输入已清空。可在上方选择并应用；未调用上游。');
    });
  }
  function refresh() {
    if (dirty && !window.confirm('重新读取会丢弃尚未保存的模型选择、连接编辑与新输入密钥，确定继续？')) return;
    setSelections({}); setEditor(null); setReload(value => value + 1); setMessage('');
  }
  return <div className="model-connections">
    <a className="model-back" href="#/settings"><ArrowLeft size={15} />工作台设置</a>
    <PageHeading eyebrow="MODEL CONNECTIONS" title="模型都留着，选择权交给你。" description="连接库保存完整地址与密钥；四种用途各自选择，不自动回退，不覆盖其他模型。">
      <button className="button secondary" onClick={refresh} disabled={Boolean(busy) || loading}><RefreshCw size={15} />重新读取</button>
    </PageHeading>
    <div className="model-role-grid" role="tablist" aria-label="模型用途">{modelRoles.map(role => {
      const RoleIcon = icons[role]; const saved = catalog?.connections.find(c => c.role === role);
      return <button role="tab" id={`model-tab-${role}`} aria-controls="model-role-settings" aria-selected={selected === role} className={`model-role ${selected === role ? 'selected' : ''}`} key={role} disabled={Boolean(busy)} onClick={() => { setSelected(role); setMessage(''); setError(''); }}>
        <span className="model-role-top"><RoleIcon size={19} /><small>{roleInfo[role].en}</small></span><strong>{roleInfo[role].short}</strong>
        <span className="model-role-name">{loading ? '读取中…' : saved?.profileName || '尚未选择模型'}</span><span className={`model-status ${saved?.configured ? 'configured' : ''}`}><i />{saved?.configured ? '配置完整' : '未配置完整'}{selections[role] !== undefined ? ' · 选择未保存' : ''}</span>
      </button>;
    })}</div>
    {error && <p className="model-alert error" role="alert" ref={errorRef}>{error}</p>}{message && <p className="model-alert success" role="status"><Check size={16} />{message}</p>}
    {busy && <p className="model-loading" role="status">{busy}…</p>}
    {loading ? <p className="model-loading" role="status">正在读取本机连接库…</p> : catalog && <>
      <div id="model-role-settings" role="tabpanel" aria-labelledby={`model-tab-${selected}`} className="model-config-layout">
        {item && <RoleSelection item={item} profiles={catalog.profiles} selectedId={selections[selected] ?? item.profileId ?? ''} busy={Boolean(busy)} onChange={id => choose(selected, id)} onApply={apply} onAdd={() => openEditor()} />}
        <aside className="model-guide"><div><ShieldCheck size={22} /><h3>切换模型，不重填凭据</h3><p>连接库保存多套完整配置。每种用途只选择一个连接，同一文本连接也可同时用于拆解和通用。</p></div><p className="model-guide-foot">配置完整不等于上游可用。保存与切换不测试连接、不消耗模型额度；进行中的任务使用原快照。</p></aside>
      </div>
      <section className="saved-model-library" aria-label="已保存模型连接库"><div className="saved-model-heading"><div><p className="eyebrow">YOUR MODEL LIBRARY</p><h2>已保存模型 <span>{catalog.profiles.length}</span></h2><p>每个模型一份完整连接，随时选用；密钥不回显。</p></div><div className="saved-model-actions">
        {catalog.legacyImportAvailable && <button className="button secondary" disabled={Boolean(busy)} onClick={() => void action('导入旧环境连接', async () => {
          const result = await modelSettingsApi<ModelCatalog>('/api/model-profiles/import-environment', {}, signal());
          if (mounted.current) { setCatalog(result); setMessage('旧环境模型已保留在连接库中，当前用途选择未变；重复导入不覆盖已保存密钥。'); }
        })}><Download size={14} />导入旧环境连接</button>}
        <button className="button secondary" disabled={Boolean(busy)} onClick={() => openEditor()}><Plus size={14} />添加模型连接</button></div></div>
        <div className="saved-model-grid">{catalog.profiles.map(profile => <ProfileCard key={profile.id} profile={profile} disabled={Boolean(busy)} onEdit={() => openEditor(profile)} onCopy={() => openEditor(profile, true)} />)}</div>
        {!catalog.profiles.length && <p className="model-field-help">连接库为空，请添加模型连接，再分配用途。</p>}
      </section>
      {editor && <ProfileEditor editor={editor} busy={Boolean(busy)} onEdit={edit} onSave={saveProfile} onCancel={() => { if (!editorDirty || window.confirm('确定放弃当前尚未保存的连接编辑？')) setEditor(null); }} editorRef={editorRef} />}
      <p className="model-library-foot">密钥只存本机后端 · 不写入浏览器草稿或版本库 · 生图只在用户逐次授权后执行 · 不自动重试或换模型</p>
    </>}
  </div>;
}
