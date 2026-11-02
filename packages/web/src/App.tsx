import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, ArrowUpRight, BookOpen, Bot, Box, ChevronRight, Command, FileText, Film, Menu, Plus, Search, Settings2, Workflow, X } from 'lucide-react';
import { Brand, Modal, Toast } from './components';
import { FlowPage, ScriptPage, SettingsPage, StoryboardPage } from './pages';
import WorkspaceHome from './WorkspaceHome';
import ProjectsPage from './ProjectsPage';
import { PluginsPage } from './LibraryPages';
import AssetWorkspace from './AssetWorkspace';
import { commands, creationNavigation, workspaceNavigation, routeFromHash } from './navigation';
import { readDraft, saveDraft, type Draft, type Page } from './model';
import ProductionPage from './production';
import NovelBreakdown from './NovelBreakdown';
import ModelConnections from './ModelConnections';
import VideoAutomationPage from './VideoAutomationPage';
import ProductionAutomationPage from './ProductionAutomationPage';
import EvolutionPage from './EvolutionPage';
import PromptPacksPage from './PromptPacksPage';
import { applyHashNavigation } from './navigation-guard';
import { AmbientFX } from './ambient';
import AssistantPanel from './assistant/AssistantPanel';
import './assistant/assistant.css';

const DirectorWorkspace = lazy(() => import('./director/DirectorWorkspace'));

export default function App() {
  const [{ draft: loaded, error: storageError }] = useState(readDraft);
  const [draft, setDraft] = useState(loaded);
  const [route, setRoute] = useState(() => routeFromHash(location.hash));
  const acceptedLocation = useRef({ route, hash: location.hash });
  const hasUnsavedProduction = useRef(false);
  const reportProductionUnsaved = useCallback((dirty: boolean) => { hasUnsavedProduction.current = dirty; }, []);
  const hasUnsavedNovel = useRef(false);
  const reportNovelUnsaved = useCallback((dirty: boolean) => { hasUnsavedNovel.current = dirty; }, []);
  const hasUnsavedAssets = useRef(false);
  const reportAssetsUnsaved = useCallback((dirty: boolean) => { hasUnsavedAssets.current = dirty; }, []);
  const hasUnsavedModelConnections = useRef(false);
  const reportModelConnectionsUnsaved = useCallback((dirty: boolean) => { hasUnsavedModelConnections.current = dirty; }, []);
  const hasUnsavedAutomation = useRef(false);
  const reportAutomationUnsaved = useCallback((dirty: boolean) => { hasUnsavedAutomation.current = dirty; }, []);
  const [mobileNav, setMobileNav] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [novelImportRequest, setNovelImportRequest] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((text: string) => {
    if (timer.current) clearTimeout(timer.current);
    setToast(text); timer.current = setTimeout(() => setToast(''), 4500);
  }, []);
  useEffect(() => {
    if (storageError) notify('本地草稿无法读取，现显示参考样例；原保存内容尚未改动。');
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [storageError, notify]);
  useEffect(() => {
    const change = () => {
      acceptedLocation.current = applyHashNavigation(acceptedLocation.current, { route: routeFromHash(location.hash), hash: location.hash }, {
        hasUnsavedProduction: hasUnsavedProduction.current,
        hasUnsavedNovel: hasUnsavedNovel.current,
        hasUnsavedAssets: hasUnsavedAssets.current,
        hasUnsavedModelConnections: hasUnsavedModelConnections.current,
        hasUnsavedAutomation: hasUnsavedAutomation.current,
        confirmLeave: () => window.confirm(acceptedLocation.current.route.page === 'settings'
          ? '离开会丢弃未保存的模型配置与新输入密钥；已提交的保存请求可能仍完成。确定离开？'
          : acceptedLocation.current.route.page === 'automation'
          ? '离开会丢失未提交的自动制作设置；已创建的运行会继续执行。确定离开？'
          : acceptedLocation.current.route.page === 'novel'
          ? '离开小说页面会丢失未保存草稿；已提交的模型请求不保证取消。确定离开？'
          : acceptedLocation.current.route.page === 'assets'
            ? '离开资产目录会丢失尚未登记的信息；已提交的保存请求不保证取消。确定离开？'
            : '离开真实项目页面会丢失未保存草稿。确定离开？'),
        restoreHash: hash => window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${hash}`),
        commitRoute: next => { setRoute(next); setMobileNav(false); window.scrollTo({ top: 0 }); },
      });
    };
    const keys = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(value => !value); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') { event.preventDefault(); setAssistantOpen(value => !value); }
      if (event.key === 'Escape') setMobileNav(false);
    };
    window.addEventListener('hashchange', change); window.addEventListener('keydown', keys);
    return () => { window.removeEventListener('hashchange', change); window.removeEventListener('keydown', keys); };
  }, []);
  function go(page: Page, step?: number) {
    const hash = `#/${page}${page === 'flow' ? `/${step ?? 1}` : ''}`;
    if (location.hash === hash) setMobileNav(false);
    else location.hash = hash;
  }
  function openProject(id: string) { location.hash = `#/production/${encodeURIComponent(id)}`; }
  function openNovel(id: string) { location.hash = `#/novel/${encodeURIComponent(id)}`; }
  function startNovel() {
    setNewOpen(false);
    if (route.page === 'novel') { setNovelImportRequest(value => value + 1); window.scrollTo({ top: 0 }); }
    else openNovel('new');
  }
  function startProject() {
    setNewOpen(false);
    if (route.page === 'production') { window.scrollTo({ top: 0 }); document.getElementById('new-project-title')?.focus(); }
    else openProject('new');
  }
  function save(next: Draft = draft) {
    try { const saved = saveDraft(next); setDraft(saved); notify(`已保存到本浏览器 · 草稿 V${saved.revision}`); }
    catch { notify('未能保存，浏览器存储可能不可用或已满。请导出草稿留存。'); }
  }
  const props = { draft, setDraft, save, go, notify };
  const current = commands.find(item => item.id === route.page)!;
  const activeProjectId = route.page === 'production' && route.resourceId && route.resourceId !== 'new' ? route.resourceId : undefined;
  const assistantContext = {
    label: activeProjectId ? `项目 ${activeProjectId}` : current.label,
    ...(activeProjectId ? { projectId: activeProjectId } : {}),
  };
  return <div className="app-shell">
    <AmbientFX />
    <a className="skip-link" href="#main-content" onClick={e => { e.preventDefault(); document.getElementById('main-content')?.focus(); document.getElementById('main-content')?.scrollIntoView(); }}>跳到主要内容</a>
    {mobileNav && <button className="nav-backdrop" onClick={() => setMobileNav(false)} aria-label="关闭导航菜单" />}
    <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`} aria-label="主导航"><div className="sidebar-brand"><Brand /><button className="icon-button mobile-only" onClick={() => setMobileNav(false)} aria-label="收起导航"><X size={19} /></button></div>
      <nav className="main-nav workspace-nav" aria-label="工作空间">{workspaceNavigation.map(item => <a href={`#/${item.id}`} key={item.id} aria-current={route.page === item.id ? 'page' : undefined}><item.icon size={19} strokeWidth={1.7} /><span>{item.label}</span>{route.page === item.id && <span className="nav-active-dot" />}</a>)}</nav>
      <span className="nav-section-label">创作工具</span><nav className="main-nav" aria-label="创作工具">{creationNavigation.map(item => <a href={`#/${item.id}`} key={item.id} aria-current={route.page === item.id ? 'page' : undefined}><item.icon size={18} strokeWidth={1.6} /><span>{item.label}</span>{item.id === 'director' && <span className="nav-mini">3D</span>}</a>)}</nav>
      <span className="nav-section-label">探索</span><nav className="main-nav"><a href="#/flow/1" aria-current={route.page === 'flow' ? 'page' : undefined}><Workflow size={18} strokeWidth={1.6} /><span>创作指南</span><span className="nav-mini">9 步</span></a></nav>
      <div className="sidebar-bottom"><button className="sidebar-feature" onClick={() => go('director')}><span className="sidebar-feature-art" aria-hidden="true"><Box size={44} strokeWidth={.8} /><span /></span><span><strong>先试一个好机位</strong><small>探索 3D 白模预演 <ArrowUpRight size={12} /></small></span></button><button className={`profile-button ${route.page === 'settings' ? 'active' : ''}`} onClick={() => go('settings')} aria-label="打开工作台设置"><span className="profile-avatar">L</span><span><strong>个人工作空间</strong><small>本地创作 · Early Preview</small></span><Settings2 size={16} /></button></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="topbar-left"><button className="icon-button mobile-only" onClick={() => setMobileNav(value => !value)} aria-label="打开导航菜单" aria-expanded={mobileNav}><Menu size={20} /></button><span className="breadcrumb">工作空间 <ChevronRight size={12} /><strong>{current.label}</strong></span></div><div className="topbar-right"><button aria-label="快速查找" className="search-trigger" onClick={() => { setQuery(''); setSearchOpen(true); }}><Search size={15} /><span>搜索工作空间</span><kbd>⌘ K</kbd></button><span className="local-state"><i />个人空间</span><button className="topbar-create" onClick={() => setNewOpen(true)}><Plus size={15} /><span>新建项目</span></button></div></header>
      <main id="main-content" tabIndex={-1} className={`main-content page-${route.page}`}><AnimatePresence mode="wait" initial={false}><motion.div key={`${route.page}/${route.resourceId ?? ''}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.18 }}>
        {route.page === 'studio' && <WorkspaceHome {...props} onNew={() => setNewOpen(true)} onOpenProject={openProject} onOpenNovel={openNovel} onOpenReferences={() => { location.hash = '#/assets/references'; }} />}
        {route.page === 'projects' && <ProjectsPage {...props} onNew={() => setNewOpen(true)} onOpenProject={openProject} onOpenNovel={openNovel} />}
        {route.page === 'plugins' && <PluginsPage go={go} />}
        {route.page === 'automation' && (route.resourceId === 'video'
          ? <VideoAutomationPage onUnsavedChange={reportAutomationUnsaved} />
          : <ProductionAutomationPage initialScript={route.screenplay} onUnsavedChange={reportAutomationUnsaved} />)}
        {route.page === 'evolution' && <EvolutionPage go={go} />}
        {route.page === 'methods' && <PromptPacksPage notify={notify} />}
        {route.page === 'production' && <ProductionPage initialProjectId={route.resourceId} onUnsavedChange={reportProductionUnsaved} />}
        {route.page === 'novel' && <NovelBreakdown initialNovelId={route.resourceId} importRequest={novelImportRequest} onUnsavedChange={reportNovelUnsaved} />}
        {route.page === 'script' && <ScriptPage {...props} />}
        {route.page === 'storyboard' && <StoryboardPage {...props} />}
        {route.page === 'director' && <Suspense fallback={<p className="notice">正在准备 3D 导演台…</p>}><DirectorWorkspace notify={notify} /></Suspense>}
        {route.page === 'assets' && <AssetWorkspace go={go} initialTab={route.resourceId === 'references' ? 'references' : 'library'} onUnsavedChange={reportAssetsUnsaved} />}
        {route.page === 'flow' && <FlowPage {...props} step={route.step} />}
        {route.page === 'settings' && (route.resourceId === 'models' ? <ModelConnections onUnsavedChange={reportModelConnectionsUnsaved} /> : <SettingsPage {...props} />)}
      </motion.div></AnimatePresence></main>
    </div>
    <Modal open={newOpen} onClose={() => setNewOpen(false)} title="从一个故事开始"><p className="muted">选择你的起点，进入对应的创作工作区。</p><div className="start-options"><button onClick={startNovel}><BookOpen size={24} /><div><strong>从小说开始</strong><p>导入原文，逐章提取与校对人物、场景和对白</p></div><ArrowRight size={18} /></button><button onClick={startProject}><Film size={24} /><div><strong>从剧本开始</strong><p>创建项目，保存剧本、拆解事实与设计分镜</p></div><ArrowRight size={18} /></button><button onClick={() => { setNewOpen(false); go('script'); }}><FileText size={24} /><div><strong>先体验一个样例</strong><p>打开「赴约」练习，自由编辑文字分镜</p></div><ArrowRight size={18} /></button></div><p className="modal-footnote">小说与剧本项目需要本地后端；调用模型前会另行确认。样例可直接体验。</p></Modal>
    <Modal open={searchOpen} onClose={() => setSearchOpen(false)} title="快速查找" className="command-modal"><div className="command-input"><Search size={19} /><input autoFocus aria-label="查找工作区" placeholder="试试：分镜、剧本、流程…" value={query} onChange={e => setQuery(e.target.value)} /></div><div className="command-results">{commands.filter(item => `${item.label} ${item.en}`.toLowerCase().includes(query.toLowerCase())).map(item => <button key={item.id} onClick={() => { setSearchOpen(false); go(item.id); }}><item.icon size={18} /><span>{item.label}</span><ArrowUpRight size={15} /></button>)}{!commands.some(item => `${item.label} ${item.en}`.toLowerCase().includes(query.toLowerCase())) && <p className="muted">没有匹配的工作区，换个词试试。</p>}</div><div className="command-footer"><Command size={12} /><span>K 打开 / Esc 关闭</span></div></Modal>
    <AssistantPanel open={assistantOpen} onClose={() => setAssistantOpen(false)} context={assistantContext} notify={notify} />
    {!assistantOpen && <button className="assistant-fab" onClick={() => setAssistantOpen(true)} title="打开 AI 工作区（⌘J / Ctrl+J）"><Bot size={17} /><span>AI 工作区</span></button>}
    <Toast text={toast} />
  </div>;
}
