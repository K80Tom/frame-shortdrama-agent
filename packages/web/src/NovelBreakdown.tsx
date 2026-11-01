import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, FileUp, Plus, Save, Search, Trash2 } from 'lucide-react';
import {
  chapterTextarea, confirmationBlock, createNovelRequestGate, editNovelItem, evidenceFromRange, evidenceFromSelection,
  filterNovelItems, isNovelItemPending, newNovelItem, novelDraftChanged, novelKindLabels, removeNovelItem, selectionAfterNovelSave, selectionForEvidence, validateNovelDraft,
  type NovelChapter, type NovelEvidence, type NovelFilter, type NovelItem, type NovelKind, type NovelRevision, type NovelSource,
} from './novel-editor';
import './novel.css';
import NovelAssetPanel from './NovelAssetPanel';
import { assetBindingSummary, type AssetBindingInput } from './asset-library';
import type { EntityMergeCandidate, EntityRegistryEntry } from '@lyra/shared';
import { useDesktopAssetTasks } from './DesktopAssetGeneration';
import { desktopCompletionNeedsRefresh, desktopReloadAllowed, desktopTaskActive, desktopTaskLabels } from './desktop-asset-generation';

type LibraryItem = { id: string; title: string; createdAt: string; chapterCount: number };
type DraftSession = { base: NovelRevision; items: NovelItem[] };
type ModelCatalog = { configured: boolean; provider: string; defaultModel: string; connectionRevision?: string };
type IsCurrent = () => boolean;
const classificationLabels = { speech: '人物对白', thought: '心理活动', quotation: '引用 / 文字', sound: '音效', uncertain: '类型待确认' };
const occurrenceLabels = { present: '本章现场', mentioned: '仅被提及', historical: '历史 / 转述', imagined: '设想 / 假设' };
const entityTypeLabels = { person: '个体人物', group: '群体', creature: '生物 / 怪兽', place: '地点', object: '物件', material: '材料' };
const revisionLabels = { model: '模型提取 · 待人工核对', user: '人工校对 / 资产引用', program: '引号待核对初稿 · 不是 AI 拆解' };

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shortdrama-Call': '1' }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${data?.error?.message ?? `请求失败（${response.status}）`}${response.status === 409 ? ' 本页草稿已保留，请刷新版本并核对；不会覆盖其他保存结果。' : ''}`);
  return data as T;
}

export default function NovelBreakdown({ onUnsavedChange, initialNovelId, importRequest = 0 }: { onUnsavedChange?: (dirty: boolean) => void; initialNovelId?: string; importRequest?: number }) {
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [source, setSource] = useState<NovelSource | null>(null);
  const [chapterId, setChapterId] = useState('');
  const [revisions, setRevisions] = useState<NovelRevision[]>([]);
  const [revisionId, setRevisionId] = useState('');
  const [draftBook, setDraftBook] = useState<Record<string, DraftSession>>({});
  const [title, setTitle] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [rawText, setRawText] = useState('');
  const [importOpen, setImportOpen] = useState(true);
  const lastImportRequest = useRef(importRequest);
  useEffect(() => {
    if (lastImportRequest.current !== importRequest) { setImportOpen(true); lastImportRequest.current = importRequest; }
  }, [importRequest]);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [allowPaid, setAllowPaid] = useState(false);
  const [extractionMode, setExtractionMode] = useState<'single' | 'reviewed'>('reviewed');
  const [registry, setRegistry] = useState<EntityRegistryEntry[]>([]);
  const [mergeCandidates, setMergeCandidates] = useState<EntityMergeCandidate[]>([]);
  const [filter, setFilter] = useState<NovelFilter>('all');
  const [pendingOnly, setPendingOnly] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [selection, setSelection] = useState<NovelEvidence | null>(null);
  const [newKind, setNewKind] = useState<NovelKind>('character');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [assetDraftDirty, setAssetDraftDirty] = useState(false);
  const busyRef = useRef(false);
  const gate = useRef(createNovelRequestGate());
  const sourceArea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const chapter = source?.chapters.find(item => item.id === chapterId) ?? null;
  const revision = revisions.find(item => item.id === revisionId) ?? null;
  const items = revision ? draftBook[revision.id]?.items ?? revision.content.items : [];
  const dirty = Boolean(revision && novelDraftChanged(revision, items));
  const importDirty = Boolean(title || rawText || sourceUrl);
  const anyDirty = importDirty || assetDraftDirty || Object.values(draftBook).some(session => novelDraftChanged(session.base, session.items));
  const editable = Boolean(chapter && revision && chapter.latestRevisionId === revision.id);
  const visible = filterNovelItems(items, filter, pendingOnly);
  const selectedItem = visible.find(item => item.id === selectedItemId) ?? visible[0] ?? null;
  const errors = source && chapter && dirty ? validateNovelDraft(source, chapter, items) : [];
  const pendingCount = items.filter(isNovelItemPending).length;
  const modelReady = Boolean(catalog?.configured);
  const assetCounts = revision ? assetBindingSummary(revision.content) : null;
  const desktop = useDesktopAssetTasks(chapterId);
  const desktopRefreshed = useRef(new Set<string>());
  const completedDesktopTask = desktop.tasks.find(task => desktopCompletionNeedsRefresh(task, chapterId, revisions));
  const activeDesktopTasks = desktop.tasks.filter(desktopTaskActive);
  useEffect(() => {
    let disposed = false;
    if (!source) { setRegistry([]); setMergeCandidates([]); return; }
    void api<{ entries: EntityRegistryEntry[]; mergeCandidates?: EntityMergeCandidate[] }>(`/api/novels/${source.id}/entities`)
      .then(result => { if (!disposed) { setRegistry(result.entries); setMergeCandidates(result.mergeCandidates ?? []); } })
      .catch(() => { if (!disposed) { setRegistry([]); setMergeCandidates([]); } });
    return () => { disposed = true; };
  }, [source]);

  async function action(name: string, work: (isCurrent: IsCurrent) => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    const isCurrent = gate.current.begin();
    setBusy(name); setMessage('');
    try { await work(isCurrent); }
    catch (error) { if (isCurrent()) setMessage(error instanceof Error ? error.message : '操作未完成。'); }
    finally { if (isCurrent()) { busyRef.current = false; setBusy(''); } }
  }

  async function loadChapter(nextSource: NovelSource, id: string, isCurrent: IsCurrent) {
    const nextChapter = nextSource.chapters.find(item => item.id === id) ?? nextSource.chapters[0];
    const history = nextChapter ? await api<{ revisions: NovelRevision[] }>(`/api/novel-chapters/${encodeURIComponent(nextChapter.id)}/revisions`) : { revisions: [] };
    if (!isCurrent()) return;
    setSource(nextSource); setChapterId(nextChapter?.id ?? ''); setRevisions(history.revisions);
    setRevisionId(nextChapter?.latestRevisionId ?? ''); setSelection(null); setSelectedItemId(''); setAllowPaid(false);
  }

  async function loadNovel(id: string, preferredChapter: string | null, isCurrent: IsCurrent) {
    const nextSource = await api<NovelSource>(`/api/novels/${encodeURIComponent(id)}`);
    if (!isCurrent()) return;
    await loadChapter(nextSource, preferredChapter ?? nextSource.chapters[0]?.id ?? '', isCurrent);
  }

  useEffect(() => {
    const task = completedDesktopTask;
    if (!task || !source || desktopRefreshed.current.has(task.id)
      || !desktopReloadAllowed({ dirty: anyDirty, editable, busy: Boolean(busy) }) || busyRef.current) return;
    desktopRefreshed.current.add(task.id);
    const itemToKeep = selectedItem?.id ?? '';
    void action('加载生图资产的保存结果', async isCurrent => {
      await loadNovel(source.id, chapterId, isCurrent);
      if (!isCurrent()) return;
      setSelectedItemId(itemToKeep);
      setMessage('候选图片已由人工确认并关联，已读取本章最新版本。小说事实保持不变；请继续核对视觉设计是否合适。');
    });
  }, [completedDesktopTask, source, chapterId, anyDirty, editable, busy, selectedItem?.id]);

  function confirmSwitch(): boolean {
    if (assetDraftDirty && !window.confirm('当前资产选择或说明尚未保存，切换会放弃这份引用草稿。确定切换？')) return false;
    return !dirty || window.confirm('当前校对尚未保存。切换后草稿暂留本页，返回相同版本可继续；刷新或离开小说页面会丢失草稿。确定切换？');
  }
  function confirmAssetSwitch(): boolean {
    return !assetDraftDirty || window.confirm('当前资产选择或说明尚未保存，切换条目会放弃这份引用草稿。确定切换？');
  }

  useEffect(() => {
    let disposed = false;
    void api<ModelCatalog>('/api/models?role=breakdown').then(result => { if (!disposed) setCatalog(result); }).catch(() => undefined);
    void action('读取小说目录', async isCurrent => {
      const result = await api<{ novels: LibraryItem[] }>('/api/novels');
      if (!isCurrent()) return;
      setLibrary(result.novels);
      const selectedId = initialNovelId === 'new' ? undefined : initialNovelId ?? result.novels[0]?.id;
      if (selectedId) { setImportOpen(false); await loadNovel(selectedId, null, isCurrent); }
    });
    return () => { disposed = true; gate.current.invalidate(); busyRef.current = false; };
  }, []);

  useEffect(() => {
    onUnsavedChange?.(anyDirty || Boolean(busy));
    return () => onUnsavedChange?.(false);
  }, [anyDirty, busy, onUnsavedChange]);
  useEffect(() => {
    if (!anyDirty && !busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [anyDirty, busy]);

  function storeItems(next: NovelItem[]) {
    if (!revision || !editable || busyRef.current) return;
    setDraftBook(previous => ({ ...previous, [revision.id]: { base: revision, items: next } }));
  }
  function updateItem(item: NovelItem, patch: Partial<NovelItem>) {
    storeItems(items.map(value => value.id === item.id ? editNovelItem(value, patch) : value));
  }
  function acceptRevision(saved: NovelRevision, preferredItemId = '') {
    setRevisions(previous => [...previous.filter(value => value.id !== saved.id), saved]);
    setRevisionId(saved.id); setSelectedItemId(preferredItemId); setAllowPaid(false);
    setAssetDraftDirty(false);
    setSource(previous => previous ? { ...previous, chapters: previous.chapters.map(value => value.id === saved.chapterId ? { ...value, latestRevisionId: saved.id } : value) } : previous);
  }
  function saveAssetBinding(binding: AssetBindingInput) {
    if (!revision || dirty || !editable || busyRef.current) return;
    const base = revision;
    void action('保存本章资产引用', async isCurrent => {
      const saved = await api<NovelRevision>(`/api/novel-revisions/${encodeURIComponent(base.id)}/asset-bindings`, {
        expectedRevisionId: base.id, bindings: [binding],
      });
      if (!isCurrent()) return;
      acceptRevision(saved); setSelectedItemId(binding.itemId);
      setMessage(binding.status === 'linked' ? '资产引用已保存为本章新版本。小说原文、校对内容和其他章节未改动。' : '已保存为待补资产。没有生成素材，也没有改写小说或进入 3D 导演台。');
    });
  }
  function showEvidence(ref: NovelEvidence) {
    if (!source || !chapter || !sourceArea.current) return;
    let before: number;
    let end: number;
    try { ({ start: before, end } = selectionForEvidence(source, chapter, ref)); }
    catch (error) { setMessage(error instanceof Error ? error.message : '无法定位这处原文依据。'); return; }
    sourceArea.current.focus(); sourceArea.current.setSelectionRange(before, end);
    // Measure wrapping as well as line breaks: a novel paragraph may span many visual lines.
    const area = sourceArea.current;
    const style = window.getComputedStyle(area);
    const mirror = document.createElement('div');
    Object.assign(mirror.style, { position: 'fixed', left: '-10000px', top: '0', visibility: 'hidden',
      width: `${area.clientWidth}px`, boxSizing: 'border-box', whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
      padding: style.padding, font: style.font, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing });
    mirror.textContent = area.value.slice(0, before);
    const marker = document.createElement('span'); marker.textContent = Array.from(ref.quote)[0] || ' '; mirror.append(marker);
    document.body.append(mirror);
    area.scrollTop = Math.max(0, marker.offsetTop - area.clientHeight / 3);
    mirror.remove();
    setSelection(ref);
  }
  function exportUnsavedDraft() {
    if (!source || !chapter || !revision || !dirty) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ schemaVersion: 'novel-review-draft/1',
      notice: '未保存校对草稿，不是服务端已保存版本。', documentId: source.id, chapterId: chapter.id,
      baseRevisionId: revision.id, items }, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = '小说-未保存校对草稿.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function addItem() {
    if (!selection || !editable) { setMessage('先在左侧原文选中依据，再新增条目。'); return; }
    const item = newNovelItem(newKind, selection, `manual_${crypto.randomUUID()}`);
    storeItems([...items, item]); setFilter(newKind); setPendingOnly(false); setSelectedItemId(item.id);
  }
  function removeItem(item: NovelItem) {
    const used = items.filter(value => value.speakerId === item.id).length;
    if (!window.confirm(`删除「${item.label.slice(0, 30) || '未命名条目'}」？${used ? `\n它被 ${used} 条对白 / 心理活动引用，删除后这些归属将改为待确认。` : ''}\n保存后会创建新版本，历史版本仍保留。`)) return;
    storeItems(removeNovelItem(items, item.id)); setSelectedItemId('');
  }
  function saveCorrections() {
    if (!revision || !dirty || errors.length || !editable) return;
    const base = revision;
    const visibleItemId = selectedItem?.id ?? '';
    void action('保存本章校对', async isCurrent => {
      const saved = await api<NovelRevision>(`/api/novel-revisions/${encodeURIComponent(base.id)}/corrections`, { expectedRevisionId: base.id, items });
      if (!isCurrent()) return;
      acceptRevision(saved, selectionAfterNovelSave(saved.content.items, visibleItemId, filter, pendingOnly));
      setDraftBook(previous => { const next = { ...previous }; delete next[base.id]; return next; });
      setMessage('本章校对已保存为新版本。原文与历史版本未改动；其他章节不受影响。');
    });
  }
  function generate(mode: 'seed' | 'extract') {
    if (!chapter || dirty || assetDraftDirty || (mode === 'extract' && !allowPaid)) return;
    if (mode === 'extract' && chapter.latestRevisionId && !window.confirm(`重新提取将保存新的模型版本，已有校对保留在历史中。${extractionMode === 'reviewed' ? '本次最多调用五次模型，包含查漏、复核及一次局部修复。' : '本次调用一次模型。'}确定继续？`)) return;
    const currentChapter = chapter;
    setAllowPaid(false);
    void action(mode === 'seed' ? '建立引号待核对初稿' : '模型正在拆解与检查本章，请勿重复提交', async isCurrent => {
      const saved = await api<NovelRevision>(`/api/novel-chapters/${encodeURIComponent(currentChapter.id)}/${mode}`, {
        expectedRevisionId: currentChapter.latestRevisionId, ...(mode === 'extract' ? { allowPaid: true, mode: extractionMode,
          expectedModelConnectionRevision: catalog?.connectionRevision } : {}),
      });
      if (!isCurrent()) return;
      acceptRevision(saved);
      setMessage(mode === 'seed' ? '已建立免费引号初稿，仅标出待核对引文；人物、场景和道具需人工添加或运行模型提取。' : '本章模型结果已保存。引用匹配不等于理解正确，请逐项核对人物归属、遗漏和待确认项。');
    });
  }

  return <div className="novel-page">
    <header className="novel-hero"><div><span>NOVEL · SOURCE FIRST</span><h1>小说逐章拆解</h1><p>先读清原文，再确认事实。人物、场景、道具和对白逐章保存，所有依据可回到原文核对。</p></div><BookOpen size={46} strokeWidth={1} /><p className="novel-boundary">校对确认并保存后，可关联已有素材；缺少时可授权调用设置中选定的生图 API，逐张生成候选并导入资产库，只有人工确认后才正式关联。外观补充属于设计，不改写小说事实。不改编剧本，不生成分镜，不进入 3D 导演台。</p></header>

    <section className="novel-card novel-library"><div className="novel-row"><label htmlFor="novel-library">已保存的小说</label><select id="novel-library" value={source?.id ?? ''} disabled={Boolean(busy) || !library.length} onChange={event => { if (confirmSwitch()) void action('读取小说', isCurrent => loadNovel(event.target.value, null, isCurrent)); }}><option value="" disabled>选择小说</option>{library.map(item => <option key={item.id} value={item.id}>{item.title} · {item.chapterCount} 章</option>)}</select><button disabled={Boolean(busy)} onClick={() => setImportOpen(value => !value)}><Plus size={14} />导入小说</button><button disabled={Boolean(busy)} onClick={() => { if (!confirmSwitch()) return; void action('刷新小说与版本', async isCurrent => { const result = await api<{ novels: LibraryItem[] }>('/api/novels'); if (!isCurrent()) return; setLibrary(result.novels); if (source) await loadNovel(source.id, chapterId, isCurrent); }); }}>刷新</button></div>
      {importOpen && <form className="novel-import" onSubmit={event => { event.preventDefault(); if (busyRef.current || !title.trim() || !rawText.trim() || !confirmSwitch()) return; void action('保存小说与章节', async isCurrent => {
        const saved = await api<NovelSource>('/api/novels', { title: title.trim(), rawText, ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}) });
        if (!isCurrent()) return;
        setLibrary(previous => [{ id: saved.id, title: saved.title, createdAt: saved.createdAt, chapterCount: saved.chapters.length }, ...previous]);
        setTitle(''); setRawText(''); setSourceUrl(''); setImportOpen(false);
        await loadChapter(saved, saved.chapters[0]?.id ?? '', isCurrent);
      }); }}><div className="novel-import-fields"><label>小说名称<input required value={title} onChange={event => setTitle(event.target.value)} disabled={Boolean(busy)} maxLength={200} placeholder="作品名称 · 本次导入章节" /></label><label>出处链接（可选，仅记录来源）<input type="url" value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} disabled={Boolean(busy)} placeholder="https://…" /></label></div><label>小说原文<textarea className="novel-import-text" required value={rawText} onChange={event => setRawText(event.target.value)} disabled={Boolean(busy)} placeholder={'粘贴小说原文，保留“第一章 …”“第二章 …”等独立章节标题。\n不需要先改写成剧本。'} /></label><div className="novel-row"><input className="novel-file-input" ref={fileInput} type="file" accept=".txt,text/plain" aria-label="导入 UTF-8 TXT" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (!file || busyRef.current) return;
        if (file.size > 5 * 1024 * 1024) { setMessage('请导入不超过 5 MB 的 UTF-8 TXT，先选择需要校对的章节。'); return; }
        if (rawText && !window.confirm('导入文件会替换输入框里尚未保存的原文，确定继续？')) return;
        void action('读取 TXT 文件', async isCurrent => { const text = await file.text(); if (!isCurrent()) return; setRawText(text); if (!title) setTitle(file.name.replace(/\.txt$/i, '')); if (text.includes('\uFFFD')) setMessage('文本包含替换字符，请确认文件编码为 UTF-8 后再保存。'); });
      }} /><button type="button" disabled={Boolean(busy)} onClick={() => fileInput.current?.click()}><FileUp size={14} />读取 TXT</button><button type="submit" className="novel-primary" disabled={Boolean(busy) || !title.trim() || !rawText.trim()}>保存原文并分章</button><small>原文保存后只读；不会下载链接，也不会调用模型。请仅导入你有权使用的文本。</small></div></form>}
    </section>

    {message && <p className="novel-message" role="status">{message}</p>}
    {busy && <p className="novel-message novel-busy" role="status" aria-live="polite">{busy}…{busy.includes('模型') && <small>离开页面不保证取消已提交请求；不要为相同章节重复发起付费调用。</small>}</p>}
    {!source && !busy && <section className="novel-empty"><BookOpen size={28} /><h2>从原文章节开始</h2><p>导入 TXT 或粘贴原文后，会显示每章的独立校对与版本历史。这里没有预置或凭空补写的小说正文。</p></section>}

    {source && chapter && <div className="novel-workspace"><aside className="novel-chapters novel-card"><h2>{source.title}</h2><p>{source.chapters.length} 个章节 · 原文只读</p>{source.sourceUrl && <a href={source.sourceUrl} target="_blank" rel="noreferrer">查看记录的出处 ↗</a>}<nav aria-label="小说章节">{source.chapters.map(item => <button key={item.id} className={item.id === chapter.id ? 'active' : ''} disabled={Boolean(busy)} aria-current={item.id === chapter.id ? 'page' : undefined} onClick={() => { if (item.id !== chapter.id && confirmSwitch()) void action('读取章节', isCurrent => loadChapter(source, item.id, isCurrent)); }}><span>{String(item.order).padStart(2, '0')}</span><strong>{item.title}</strong><small>{item.latestRevisionId ? '有保存版本' : '尚未拆解'}</small></button>)}</nav></aside>
      <div className="novel-main"><section className="novel-card novel-chapter-head"><div><span>当前章节</span><h2>{chapter.title}</h2><p>全文码点 {chapter.start}–{chapter.end} · {chapter.end - chapter.start} 字符。引用使用零基、左闭右开范围，包含换行。</p></div>
        <div className="novel-extract-actions"><button disabled={Boolean(busy) || Boolean(chapter.latestRevisionId)} onClick={() => generate('seed')}>免费建立引号待核对初稿</button><small>只标记引号，不猜人物，不是 AI 拆解。</small>
          <small>{modelReady ? `当前拆解模型：${catalog!.defaultModel}` : '拆解模型未配置或状态不可用'} · <a href="#/settings/models">管理模型连接</a></small>
          <label>拆解方式<select aria-label="拆解方式" value={extractionMode} disabled={Boolean(busy)} onChange={event => { setExtractionMode(event.target.value as 'single' | 'reviewed'); setAllowPaid(false); }}><option value="reviewed">拆解＋逐段查漏＋证据复核（最多五次调用）</option><option value="single">单次初稿（一次调用）</option></select></label>
          <label className="novel-consent"><input type="checkbox" checked={allowPaid} disabled={Boolean(busy) || !modelReady || dirty || assetDraftDirty} onChange={event => setAllowPaid(event.target.checked)} /><span>允许向已配置模型发送本章原文{extractionMode === 'reviewed' ? '及前章实体依据，完成三阶段检查；有问题再局部修复与复核一次，最多五次调用' : '，调用一次'}，可能计费；请求失败不自动重试。</span></label>
          <button className="novel-primary" disabled={Boolean(busy) || !modelReady || !allowPaid || dirty || assetDraftDirty} onClick={() => generate('extract')}>{chapter.latestRevisionId ? '重新提取本章（新版本）' : '提取本章人物、场景、道具与对白'}</button>{!modelReady && <small>模型未配置或服务未连接；仍可使用免费初稿和人工校对。</small>}{(dirty || assetDraftDirty) && <small>先保存或放弃本章校对与引用草稿，再运行模型。</small>}</div></section>
        {registry.length > 0 && <EntityRegistryPanel entries={registry} mergeCandidates={mergeCandidates} />}
        {revision?.content.analysis && <details className="novel-card" open><summary>模型检查记录 · {revision.content.analysis.calls.length} 次调用 · {{ partial: '未完成，成果已保留', needsReview: '有问题待确认', reviewed: '模型复核完成，待人工确认', humanEdited: '已有人工修改，检查记录仅供追溯' }[revision.content.analysis.status]}</summary><p>逐段扫描 {revision.content.analysis.paragraphCoverage.length} 段 · 前章上下文 {revision.content.analysis.contextRevisionIds.length} 个版本。扫描覆盖不等于语义完整。</p><ol>{revision.content.analysis.issues.map((issue, index) => <li key={index}>{issue.reason}（{issue.paragraphIds.join('、')}）</li>)}</ol></details>}

        {revision && <section className="novel-card novel-revision-bar"><div className="novel-row"><label htmlFor="novel-revision">版本历史</label><select id="novel-revision" value={revision.id} disabled={Boolean(busy)} onChange={event => { if (confirmSwitch()) { setRevisionId(event.target.value); setSelectedItemId(''); setSelection(null); } }}>{revisions.map((item, index) => <option key={item.id} value={item.id}>V{index + 1} · {revisionLabels[item.createdBy]} · {new Date(item.createdAt).toLocaleString()}{item.id === chapter.latestRevisionId ? ' · 最新' : ''}</option>)}</select></div><p>{editable ? '只编辑当前章的最新版本。保存会追加新版本，不覆盖原文或历史。' : dirty ? '此基准已不是最新版本。当前显示保留的未保存草稿，不是服务器历史原版；可先导出留存，再放弃草稿查看原版。不能覆盖最新保存结果。' : '这是历史版本，只读。切回最新版本后可继续校对。'} · 当前 {items.length} 项，{pendingCount} 项待确认 / 未校对。</p>{revision.content.warnings.length > 0 && <details className="novel-warnings" open><summary>本版本检查提示 · 不等于语义验收通过</summary><ul>{revision.content.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
          {dirty && <div className="novel-save-bar"><div><strong>有未保存的本章校对</strong><small>可以保留待确认项再保存；保存本身不调用模型。</small></div><div className="novel-row"><button disabled={Boolean(busy)} onClick={exportUnsavedDraft}>导出草稿</button><button disabled={Boolean(busy)} onClick={() => { if (window.confirm('放弃该版本尚未保存的校对？已保存的历史不会改动。')) setDraftBook(previous => { const next = { ...previous }; delete next[revision.id]; return next; }); }}>放弃草稿</button><button className="novel-primary" disabled={Boolean(busy) || !editable || errors.length > 0} onClick={saveCorrections}><Save size={14} />保存为新版本</button></div></div>}{errors.length > 0 && <ul className="novel-errors" role="alert">{errors.slice(0, 8).map(error => <li key={error}>{error}</li>)}{errors.length > 8 && <li>另有 {errors.length - 8} 个待修正问题。</li>}</ul>}</section>}

        {assetCounts && <div className="novel-asset-summary" aria-label="本章已保存资产状态"><strong>本章资产引用 · 已保存版本</strong><span>已关联 {assetCounts.linked}</span><span>待补 {assetCounts.missing}</span><span>引用待重核 {assetCounts.needsReview}</span><span>待校对 {assetCounts.unconfirmed}</span><a href="#/assets">查看资产目录 ↗</a></div>}
        {activeDesktopTasks.length > 0 && <p className="novel-message novel-desktop-notice" role="status">生图任务：{activeDesktopTasks.map(task => `${task.label} · ${desktopTaskLabels[task.status]}`).join('；')}。任务已保存，刷新页面可继续查看进度；不会因刷新重复提交。</p>}
        {completedDesktopTask && (anyDirty || !editable) && <p className="novel-message novel-desktop-notice" role="status">「{completedDesktopTask.label}」图片已导回并关联到服务器新版本。{anyDirty ? '本页有未保存草稿，已保留，没有自动覆盖。请先导出或处理草稿，再刷新查看。' : '当前正在查看历史版本，已保持原视图。刷新可查看新关联。'}</p>}
        <div className="novel-proofread"><section className="novel-card novel-source"><header><h3>章节原文</h3><span>只读 · 选中文字可作为依据</span></header><textarea ref={sourceArea} readOnly aria-label="当前章节原文（可选择引用）" value={chapterTextarea(source, chapter).text} spellCheck={false} onSelect={event => { const area = event.currentTarget; try { setSelection(evidenceFromSelection(source, chapter, area.selectionStart, area.selectionEnd)); } catch { setSelection(null); } }} /><div className="novel-selection">{selection ? <><strong>已选原文 · {selection.start}–{selection.end}</strong><p>{selection.quote.slice(0, 160)}{selection.quote.length > 160 ? '…' : ''}</p></> : <p>在原文中选择一段文字，或点击条目的“定位原文”。原文始终保持原样，不由模型重写。</p>}</div><div className="novel-row"><select aria-label="新增条目类型" value={newKind} disabled={!editable || Boolean(busy) || assetDraftDirty} onChange={event => setNewKind(event.target.value as NovelKind)}>{Object.entries(novelKindLabels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select><button disabled={!editable || !selection || Boolean(busy) || assetDraftDirty} onClick={addItem}><Plus size={14} />从所选原文新增</button></div>{!revision && <p className="novel-note">先建立免费引号初稿，或运行一次本章提取，再开始校对。</p>}</section>

          <section className="novel-card novel-results"><header><h3>事实与校对</h3><span>{visible.length} / {items.length} 项</span></header><div className="novel-filter"><select aria-label="筛选条目类型" disabled={Boolean(busy)} value={filter} onChange={event => { if (confirmAssetSwitch()) setFilter(event.target.value as NovelFilter); }}><option value="all">全部类型</option>{Object.entries(novelKindLabels).map(([kind, label]) => <option key={kind} value={kind}>{label} · {items.filter(item => item.kind === kind).length}</option>)}</select><label><input type="checkbox" disabled={Boolean(busy)} checked={pendingOnly} onChange={event => { if (confirmAssetSwitch()) setPendingOnly(event.target.checked); }} />仅待确认 / 未校对</label></div><div className="novel-item-list" aria-label="拆解条目列表">{visible.map(item => <button key={item.id} disabled={Boolean(busy)} className={selectedItem?.id === item.id ? 'active' : ''} onClick={() => { if (item.id !== selectedItem?.id && confirmAssetSwitch()) setSelectedItemId(item.id); }}><span>{novelKindLabels[item.kind]}</span><strong>{item.label || '未命名 · 请补充'}</strong><small className={isNovelItemPending(item) ? 'pending' : 'confirmed'}>{isNovelItemPending(item) ? '待确认' : '已人工确认'}</small></button>)}</div>
            {!visible.length && <p className="novel-note">{revision ? '当前筛选下没有条目。可以在原文中选取依据，添加遗漏的人物、场景、道具或对白。' : '本章尚无拆解版本。'}</p>}
            {assetDraftDirty && <p className="novel-note">请先保存或放弃下方资产引用草稿，再修改小说事实。</p>}
            {selectedItem && <ItemEditor key={`${revision?.id}:${selectedItem.id}`} item={selectedItem} source={source} chapter={chapter} items={items} selection={selection} disabled={!editable || Boolean(busy) || assetDraftDirty} onChange={patch => updateItem(selectedItem, patch)} onLocate={showEvidence} onDelete={() => removeItem(selectedItem)} />}
            {selectedItem && revision && selectedItem.kind !== 'dialogue' && <NovelAssetPanel key={`assets:${revision.id}:${selectedItem.id}`} item={selectedItem} revision={revision} editable={editable} dirty={dirty} busy={Boolean(busy)} onSave={saveAssetBinding} onDraftChange={setAssetDraftDirty} desktop={desktop} />}
          </section></div>
      </div></div>}
  </div>;
}

export function describeEntityMergeCandidate(candidate: EntityMergeCandidate): string {
  const quotes = candidate.evidence.map(item => item.quote).filter(quote => quote.length > 0);
  const evidence = quotes.length ? `依据：${quotes.join('；')}。` : '';
  if (candidate.relation === 'duplicate-chapter') {
    return `「${candidate.names[0] ?? ''}」在同一章有 ${candidate.evidence.length} 条记录，仍属于同一身份，章节条目没有被合并。${evidence}`;
  }
  const [left, right] = candidate.names;
  const shared = candidate.sharedTerms.join('、');
  const reason = candidate.relation === 'shared-name' ? `名称同为「${shared}」` : `共用称呼「${shared}」`;
  return `「${left ?? ''}」与「${right ?? ''}」${reason}，目前仍是两个独立身份。${evidence}`;
}

export function EntityRegistryPanel({ entries, mergeCandidates }: {
  entries: EntityRegistryEntry[]; mergeCandidates: EntityMergeCandidate[];
}) {
  return <details className="novel-card"><summary>跨章实体表 · {entries.length} 项</summary><p>根据各章最新保存版本汇总；模型身份仍需核对。名称相似不自动合并。</p>{mergeCandidates.length > 0 && <div className="novel-merge-candidates"><p>待核对身份 · {mergeCandidates.length} 组。这些只是候选，没有写入统一身份，也没有改写任何章节。</p><ul>{mergeCandidates.map(candidate => <li key={candidate.id}>{describeEntityMergeCandidate(candidate)}</li>)}</ul></div>}<table><thead><tr><th>名称 / 别名</th><th>分类</th><th>章节 / 确认</th></tr></thead><tbody>{entries.map(entry => <tr key={entry.id}><td>{entry.name}<small> · {entry.aliases.filter(alias => alias !== entry.name).join('、')}</small></td><td>{entry.entityType ? entityTypeLabels[entry.entityType] : '旧记录未分类'}</td><td>{new Set(entry.occurrences.map(occurrence => occurrence.chapterId)).size} 章 · {entry.occurrences.filter(occurrence => occurrence.confirmed).length} 项已确认</td></tr>)}</tbody></table></details>;
}

export function ItemEditor({ item, source, chapter, items, selection, disabled, onChange, onLocate, onDelete }: {
  item: NovelItem; source: NovelSource; chapter: NovelChapter; items: NovelItem[]; selection: NovelEvidence | null; disabled: boolean;
  onChange: (patch: Partial<NovelItem>) => void; onLocate: (ref: NovelEvidence) => void; onDelete: () => void;
}) {
  const [start, setStart] = useState(String(item.sourceRefs[0]?.start ?? chapter.start));
  const [end, setEnd] = useState(String(item.sourceRefs[0]?.end ?? chapter.start));
  const [error, setError] = useState('');
  const block = confirmationBlock(item);
  function applyEvidence(ref: NovelEvidence, mode: 'append' | 'replace') {
    if (disabled) return;
    if (mode === 'append' && item.sourceRefs.some(value => value.start === ref.start && value.end === ref.end)) { setError('这段原文已经是当前条目的依据。'); return; }
    if (mode === 'append' && item.sourceRefs.length >= 20) { setError('每项最多保存 20 处依据。'); return; }
    onChange({ sourceRefs: mode === 'replace' ? [ref, ...item.sourceRefs.slice(1)] : [...item.sourceRefs, ref] }); setError('');
  }
  function applyRange(mode: 'append' | 'replace') {
    try {
      if (!start.trim() || !end.trim()) throw new Error('请填写开始与结束位置。');
      applyEvidence(evidenceFromRange(source, chapter, Number(start), Number(end)), mode);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '引用范围无效。'); }
  }
  return <article className="novel-item-editor"><div className="novel-item-heading"><h4>{novelKindLabels[item.kind]}</h4><small>{item.origin === 'user' ? '含人工修改' : item.origin === 'model' ? '模型提取' : '程序引号候选'}</small><button disabled={disabled} onClick={onDelete} aria-label="删除当前条目"><Trash2 size={14} /></button></div>
    {item.kind === 'dialogue' ? <><label>原文内容（只读，需改边界请修改第一处依据）<textarea value={item.label} readOnly className="novel-quote" /></label><div className="novel-two-fields"><label>文本类型<select aria-label="文本类型" disabled={disabled} value={item.classification ?? 'uncertain'} onChange={event => onChange({ classification: event.target.value as NovelItem['classification'] })}>{Object.entries(classificationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>说话人 / 心理活动所属人物<select aria-label="说话人 / 心理活动所属人物" disabled={disabled} value={item.speakerId ?? ''} onChange={event => onChange({ speakerId: event.target.value || null })}><option value="">未知 / 不适用</option>{items.filter(value => value.kind === 'character').map(value => <option value={value.id} key={value.id}>{value.label || '未命名人物'}</option>)}</select></label></div><p className="novel-note">不能把心理活动或引用直接当作人物对白。归属依据不足时保持未知，并填写待确认说明。</p></> : <label>名称<input value={item.label} disabled={disabled} maxLength={20000} onChange={event => onChange({ label: event.target.value })} /></label>}
    {item.kind !== 'dialogue' && <><div className="novel-two-fields"><label>实体细分类<select aria-label="实体细分类" value={item.entityType ?? ''} disabled={disabled} onChange={event => onChange({ entityType: event.target.value as NovelItem['entityType'] || undefined, canonicalEntityId: undefined })}><option value="">旧版本未分类</option>{Object.entries(entityTypeLabels).filter(([type]) => item.kind === 'character' ? ['person', 'group', 'creature'].includes(type) : item.kind === 'location' ? type === 'place' : ['object', 'material'].includes(type)).map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select></label><label>本章出现方式<select aria-label="本章出现方式" value={item.occurrence ?? ''} disabled={disabled} onChange={event => onChange({ occurrence: event.target.value as NovelItem['occurrence'] || undefined })}><option value="">旧版本未分类</option>{Object.entries(occurrenceLabels).map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select></label></div><label>别名（用顿号分隔）<input value={(item.aliases ?? []).join('、')} disabled={disabled} onChange={event => onChange({ aliases: [...new Set(event.target.value.split('、').map(s => s.trim()).filter(Boolean))] })} /></label>{item.canonicalEntityId && <small>跨章身份：{item.canonicalEntityId}</small>}</>}
    <label>说明（忠于原文，不补写设定）<textarea value={item.description} disabled={disabled} maxLength={5000} onChange={event => onChange({ description: event.target.value })} rows={3} /></label><label>待确认说明<input value={item.uncertainty ?? ''} disabled={disabled} maxLength={2000} onChange={event => onChange({ uncertainty: event.target.value || null })} placeholder="例如：这处代称无法确定指向哪个人物" /></label>
    <div className="novel-review"><label><input type="checkbox" checked={item.review === 'confirmed'} disabled={disabled || (item.review !== 'confirmed' && Boolean(block))} onChange={event => onChange({ review: event.target.checked ? 'confirmed' : 'unreviewed' })} /><span><Check size={13} />我已对照原文确认此项</span></label>{block && <small>{block}</small>}</div>
    <section className="novel-evidence"><h5>原文依据 · {item.sourceRefs.length} 处</h5>{item.sourceRefs.map((ref, index) => <div key={`${index}:${ref.start}:${ref.end}`}><div className="novel-row"><small>{index === 0 && item.kind === 'dialogue' ? '正文依据' : '上下文依据'} · {ref.start}–{ref.end}</small><button onClick={() => onLocate(ref)}><Search size={12} />定位原文</button><button disabled={disabled || item.sourceRefs.length <= 1 || (item.kind === 'dialogue' && index === 0)} onClick={() => onChange({ sourceRefs: item.sourceRefs.filter((_, position) => position !== index) })}>移除</button></div><blockquote>{ref.quote}</blockquote></div>)}
      {!disabled && <details><summary>补充或更正依据</summary><p>选择左侧原文后使用下方按钮，或填写全文码点范围。对白第一处依据决定逐字正文；补充依据用于说明人物归属与上下文。</p><div className="novel-row"><button disabled={!selection} onClick={() => selection && applyEvidence(selection, 'append')}>追加所选原文</button><button disabled={!selection} onClick={() => selection && applyEvidence(selection, 'replace')}>所选原文替换第一处</button></div><div className="novel-two-fields"><label>开始（含）<input type="number" value={start} min={chapter.start} max={chapter.end - 1} step={1} onChange={event => setStart(event.target.value)} /></label><label>结束（不含）<input type="number" value={end} min={chapter.start + 1} max={chapter.end} step={1} onChange={event => setEnd(event.target.value)} /></label></div><div className="novel-row"><button onClick={() => applyRange('append')}>按范围追加</button><button onClick={() => applyRange('replace')}>按范围更正第一处</button></div>{error && <p className="novel-errors" role="alert">{error}</p>}</details>}
    </section>
  </article>;
}
