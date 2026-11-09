import { useState } from 'react';
import { AlertCircle, ArrowUpRight, ChevronDown, ChevronLeft, FolderOpen, Grid2X2, ImageIcon, List, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import { sampleImage, type Draft, type Page } from './model';
import { formatProjectDate, projectKindLabels, useProjectCatalog, type ProjectEntry } from './project-catalog';
import HoloCard from './HoloCard';
import './projects.css';

type Filter = 'all' | ProjectEntry['kind'];
type ViewMode = 'grid' | 'list';
type Props = {
  go: (page: Page, step?: number) => void;
  draft: Draft;
  onNew: () => void;
  onOpenProject?: (id: string) => void;
  onOpenNovel?: (id: string) => void;
};

const filters: { id: Filter; label: string }[] = [
  { id: 'all', label: '全部类型' }, { id: 'project', label: '剧本项目' },
  { id: 'novel', label: '小说原文' }, { id: 'practice', label: '本地练习' },
];
function CollectionError({ label, message, retry }: { label: string; message: string; retry: () => void }) {
  return <div className="hub-error" role="alert">
    <AlertCircle size={17} aria-hidden="true" />
    <div className="hub-error-copy"><strong>{label}未能加载</strong><span>{message}</span></div>
    <button className="hub-retry" onClick={retry}><RefreshCw size={14} aria-hidden="true" />重试</button>
  </div>;
}

export function ProjectCard({ entry, open, view }: { entry: ProjectEntry; open: () => void; view: ViewMode }) {
  const hasHoloCover = entry.kind === 'practice' && view === 'grid';
  return <button className="hub-card" onClick={open} aria-label={`打开${projectKindLabels[entry.kind]}：${entry.title}`} title={`${entry.title} · ${projectKindLabels[entry.kind]}`}>
    <div className={`hub-cover${hasHoloCover ? ' hub-cover--holo' : ''}`} aria-hidden="true">
      {hasHoloCover ? <HoloCard
        className="hub-holo-card"
        image={sampleImage}
        alt=""
        preset="gold"
        foilColor="#e8c878"
        intensity={0.7}
        edgeSparkle={0.65}
        glare={0.35}
        tiltMax={8}
        hoverScale={1.025}
        radius={10}
        idle={false}
        shadow={false}
      /> : entry.kind === 'practice' ? <img className="hub-cover-image" src={sampleImage} alt="" /> : <ImageIcon className="hub-cover-placeholder" size={38} strokeWidth={1.2} />}
    </div>
    <div className="hub-card-body"><h2 className="hub-card-title">{entry.title}</h2>
      <span className="hub-date">{formatProjectDate(entry.date)}</span>
    </div>
  </button>;
}

export default function ProjectsPage({ go, draft, onNew, onOpenProject, onOpenNovel }: Props) {
  const { entries: allEntries, projects, novels } = useProjectCatalog(draft);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<ViewMode>('grid');
  const hasPractice = allEntries.some(entry => entry.kind === 'practice');
  const activeFilter: Filter = filter === 'practice' && !hasPractice ? 'all' : filter;
  const visibleFilters = hasPractice ? filters : filters.filter(item => item.id !== 'practice');
  const remoteCount = projects.items.length + novels.items.length;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const entries = allEntries.filter(entry => (activeFilter === 'all' || entry.kind === activeFilter)
    && (!normalizedQuery || `${entry.title} ${projectKindLabels[entry.kind]} ${entry.status}`.toLocaleLowerCase().includes(normalizedQuery)));
  const showProjects = activeFilter === 'all' || activeFilter === 'project';
  const showNovels = activeFilter === 'all' || activeFilter === 'novel';
  const loading = (showProjects && projects.status === 'loading') || (showNovels && novels.status === 'loading');
  const failed = (showProjects && projects.status === 'error') || (showNovels && novels.status === 'error');

  function openEntry(entry: ProjectEntry) {
    if (entry.kind === 'practice') onOpenProject ? onOpenProject(entry.id) : go('script');
    else if (entry.kind === 'project') onOpenProject ? onOpenProject(entry.id) : go('production');
    else onOpenNovel ? onOpenNovel(entry.id) : go('novel');
  }

  return <div className="hub-page">
    <header className="hub-toolbar"><div className="hub-location"><button className="hub-back" onClick={() => go('studio')}><ChevronLeft size={16} aria-hidden="true" />返回</button><h1 className="hub-title">全部项目</h1></div>
      <div className="hub-tools"><label className="hub-search"><Search size={15} aria-hidden="true" /><input className="hub-search-input" aria-label="搜索项目" value={query} placeholder="搜索项目" onChange={event => setQuery(event.target.value)} />{query && <button className="hub-search-clear" onClick={() => setQuery('')} aria-label="清空搜索"><X size={13} /></button>}</label>
        <label className="hub-filter"><select aria-label="项目类型" value={activeFilter} onChange={event => setFilter(event.target.value as Filter)}>{visibleFilters.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><ChevronDown size={13} aria-hidden="true" /></label>
        <div className="hub-view-toggle" role="group" aria-label="项目显示方式"><button className={`hub-view-button${view === 'grid' ? ' hub-view-button--active' : ''}`} onClick={() => setView('grid')} aria-label="网格视图" aria-pressed={view === 'grid'}><Grid2X2 size={16} /></button><button className={`hub-view-button${view === 'list' ? ' hub-view-button--active' : ''}`} onClick={() => setView('list')} aria-label="列表视图" aria-pressed={view === 'list'}><List size={18} /></button></div>
      </div>
    </header>

    {showProjects && projects.status === 'error' && <CollectionError label="剧本项目" message={projects.error} retry={projects.retry} />}
    {showNovels && novels.status === 'error' && <CollectionError label="小说原文" message={novels.error} retry={novels.retry} />}

    <span className="hub-screen-reader" aria-live="polite">{loading ? '正在读取项目' : `${entries.length} 个${normalizedQuery ? '匹配结果' : hasPractice ? '项目与练习' : '项目'}`}</span>

    <div className={`hub-projects hub-projects--${view}`} aria-busy={loading}>
      {entries.map(entry => <ProjectCard key={`${entry.kind}:${entry.id}`} entry={entry} open={() => openEntry(entry)} view={view} />)}
      {loading && !remoteCount && Array.from({ length: 2 }, (_, index) => <div key={`loading-${index}`} className="hub-skeleton" aria-hidden="true"><div className="hub-skeleton-cover" /><div className="hub-skeleton-line" /><div className="hub-skeleton-line hub-skeleton-line--short" /></div>)}
    </div>

    {!entries.length && !loading && <div className="hub-empty"><span className="hub-empty-icon">{normalizedQuery ? <Search size={27} /> : <FolderOpen size={30} />}</span>
      <h2 className="hub-empty-title">{normalizedQuery ? '没有找到匹配的项目' : failed ? hasPractice ? '连接服务后，继续你的创作' : '部分项目暂时无法读取' : activeFilter === 'novel' ? '还没有导入小说' : '为你的下一个故事建立项目'}</h2>
      <p className="hub-empty-description">{normalizedQuery ? '试试其他关键词，或切换项目类型。' : failed ? hasPractice ? '已保存内容仍在本地服务中。你也可以先打开本地练习。' : '部分目录读取失败，你可以返回全部项目或稍后重试。' : activeFilter === 'novel' ? '导入小说原文，按章节整理和校对人物、场景与对白。' : '添加剧本或小说原文，让想法逐渐成为清晰的镜头。'}</p>
      <button className="hub-empty-action" onClick={normalizedQuery ? () => { setQuery(''); setFilter('all'); } : failed ? () => setFilter(hasPractice ? 'practice' : 'all') : activeFilter === 'novel' ? () => go('novel') : onNew}>{normalizedQuery ? '清空搜索与筛选' : failed ? hasPractice ? '查看本地练习' : '查看全部项目' : activeFilter === 'novel' ? '导入小说原文' : '新建项目'}<ArrowUpRight size={15} aria-hidden="true" /></button>
    </div>}

    {loading ? <p className="hub-end"><LoaderCircle className="hub-spinner" size={14} aria-hidden="true" />正在读取项目</p> : !failed && entries.length > 0 && <p className="hub-end">没有更多了</p>}
  </div>;
}
