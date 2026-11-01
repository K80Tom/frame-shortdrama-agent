import { useState } from 'react';
import { AlertCircle, BookOpen, Box, Check, ChevronRight, Clapperboard, FileText, Film, ImageIcon, Images, LoaderCircle, Plus, Puzzle, RefreshCw, Search, Workflow, X } from 'lucide-react';
import { sampleImage, type Draft, type Page } from './model';
import { formatProjectDate, projectKindLabels, useProjectCatalog, type ProjectEntry } from './project-catalog';
import './home.css';

const tools: { title: string; icon: typeof BookOpen; page: Page }[] = [
  { title: '小说拆解', icon: BookOpen, page: 'novel' },
  { title: '剧本拆解', icon: FileText, page: 'production' },
  { title: '分镜编辑', icon: Clapperboard, page: 'storyboard' },
  { title: '3D 导演台', icon: Box, page: 'director' },
  { title: '资产管理', icon: Images, page: 'assets' },
  { title: '自动制作', icon: Film, page: 'automation' },
  { title: '创作指南', icon: Workflow, page: 'flow' },
  { title: '全部工具', icon: Puzzle, page: 'plugins' },
];
const features: { title: string; note: string; art: string; page: Page }[] = [
  { title: '小说逐章校对', note: '原文与事实', art: 'novel', page: 'novel' },
  { title: '剧本事实拆解', note: '对照原文', art: 'facts', page: 'production' },
  { title: '3D 构图预演', note: '手工白模', art: 'director', page: 'director' },
  { title: '示例分镜编辑', note: '镜头设计', art: 'storyboard', page: 'storyboard' },
  { title: '角色与场景参考', note: '视觉参考', art: 'assets', page: 'assets' },
];
const references: { id: string; title: string; category: string; detail: string; page: Page }[] = [
  { id: 'scene', title: '赴约 · 双人对峙', category: '画面构图', detail: '赴约示意图 · 全景构图', page: 'assets' },
  { id: 'character', title: '黑衣人物 · 造型参考', category: '人物参考', detail: '赴约示意图 · 同图裁切', page: 'assets' },
  { id: 'portrait', title: '白衣人物 · 造型参考', category: '人物参考', detail: '赴约示意图 · 同图裁切', page: 'assets' },
  { id: 'stage', title: '白模站位 · 空间与机位', category: '空间预演', detail: '赴约白模 · 手工练习截图', page: 'director' },
];
const referenceFilters = ['全部', '画面构图', '人物参考', '空间预演'];
type Props = {
  go: (page: Page, step?: number) => void; draft: Draft; onNew: () => void;
  onOpenProject: (id: string) => void; onOpenNovel: (id: string) => void;
  onOpenReferences: () => void;
};

function FeatureArt({ art }: { art: string }) {
  if (art === 'novel') return <div className="home-art home-art-novel" aria-hidden="true"><div className="home-book-shadow" /><div className="home-book"><small>STORY NOTES</small><strong>第一章<br />故事的起点</strong><span /><BookOpen size={20} strokeWidth={1.2} /></div><span className="home-book-leaf" /></div>;
  if (art === 'facts') return <div className="home-art home-art-facts" aria-hidden="true"><div className="home-fact-sheet"><span className="home-fact-heading"><FileText size={12} />原文 · 事实校对</span><i /><i /><i /><div><span><Check size={10} />人物</span><span><Check size={10} />场景</span></div></div><span className="home-fact-tag">每个细节，都有依据</span></div>;
  if (art === 'director') return <div className="home-art home-art-director" role="img" aria-label="手工白模站位练习截图" />;
  if (art === 'storyboard') return <div className="home-art home-art-storyboard" aria-hidden="true"><img src={sampleImage} alt="" /><div className="home-mini-timeline"><span>01</span><i /><i /><i /><i /></div></div>;
  return <div className="home-art home-art-assets" aria-hidden="true"><div className="home-asset-crop home-asset-left" /><div className="home-asset-crop home-asset-center" /><div className="home-asset-crop home-asset-right" /></div>;
}

export default function WorkspaceHome({ go, draft, onNew, onOpenProject, onOpenNovel, onOpenReferences }: Props) {
  const { entries, projects, novels } = useProjectCatalog(draft);
  const [filter, setFilter] = useState('全部');
  const [query, setQuery] = useState('');
  const loading = projects.status === 'loading' || novels.status === 'loading';
  const visibleReferences = references.filter(item => (filter === '全部' || item.category === filter)
    && `${item.title} ${item.category} ${item.detail}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  function openEntry(entry: ProjectEntry) {
    if (entry.kind === 'project') onOpenProject(entry.id);
    else if (entry.kind === 'novel') onOpenNovel(entry.id);
    else go('storyboard');
  }
  function openFeature(page: Page) {
    if (page === 'assets') onOpenReferences();
    else go(page);
  }
  return <div className="workspace-home">
    <h1 className="home-sr-only">创作首页</h1>
    <section className="home-hero" aria-label="Lyra 品牌与新建项目">
      <div className="home-hero-copy"><span className="home-hero-eyebrow">LYRA · STORY STUDIO</span><h2 className="home-hero-title">每一集短剧，都是一颗新星。</h2><p className="home-hero-sub">从故事、分镜到白模预演，让创作看得见。</p></div>
      <button className="home-hero-cta" onClick={onNew}><Plus size={17} strokeWidth={2} aria-hidden="true" />新建创作项目</button>
      <img className="home-hero-mark" src="/brand/lyra-mark.svg" alt="" aria-hidden="true" />
    </section>

    <nav className="home-tools" aria-label="快捷创作工具">{tools.map(tool => <button key={tool.page} onClick={() => go(tool.page)}><span className="home-tool-icon"><tool.icon size={24} strokeWidth={1.6} aria-hidden="true" /></span><span>{tool.title}</span></button>)}</nav>

    <section aria-labelledby="home-recent-title">
      <div className="home-section-heading"><h2 id="home-recent-title">最近项目</h2><button onClick={() => go('projects')}>查看全部<ChevronRight size={14} aria-hidden="true" /></button></div>
      <div className="home-recent-grid" aria-busy={loading}>
        {entries.slice(0, 4).map(entry => <button className="home-recent-card" key={`${entry.kind}:${entry.id}`} onClick={() => openEntry(entry)} aria-label={`继续${projectKindLabels[entry.kind]}：${entry.title}`} title={`${entry.title} · ${projectKindLabels[entry.kind]}`}><span className="home-recent-cover">{entry.kind === 'practice' ? <img src={sampleImage} alt="" /> : <ImageIcon size={22} strokeWidth={1.2} aria-hidden="true" />}</span><span className="home-recent-copy"><strong>{entry.title}</strong><small>{formatProjectDate(entry.date)}</small></span></button>)}
        {loading && entries.length === 1 && [0, 1].map(index => <div key={index} className="home-recent-skeleton" aria-hidden="true"><span /><i /></div>)}
      </div>
      {loading && <p className="home-loading" role="status"><LoaderCircle size={12} aria-hidden="true" />正在读取项目</p>}
      {([{ label: '剧本项目', collection: projects }, { label: '小说原文', collection: novels }]).map(({ label, collection }) => collection.status === 'error' && <p className="home-catalog-error" role="alert" key={label}><AlertCircle size={13} aria-hidden="true" /><span title={collection.error}>{label}暂未加载</span><button onClick={collection.retry} aria-label={`重试加载${label}`}><RefreshCw size={12} aria-hidden="true" />重试</button></p>)}
    </section>

    <section aria-labelledby="home-features-title"><div className="home-section-heading"><h2 id="home-features-title">特色功能</h2></div><div className="home-feature-grid">{features.map(feature => <button className="home-feature-card" key={feature.art} onClick={() => openFeature(feature.page)}><FeatureArt art={feature.art} /><span className="home-feature-caption"><strong>{feature.title}</strong><small>{feature.note}</small></span></button>)}</div></section>

    <section aria-labelledby="home-references-title"><div className="home-section-heading"><h2 id="home-references-title">创作参考</h2><span className="home-section-note">从示例里，找一点灵感</span></div>
      <div className="home-reference-toolbar"><div className="home-reference-filters" role="group" aria-label="参考分类">{referenceFilters.map(value => <button key={value} aria-pressed={value === filter} onClick={() => setFilter(value)}>{value}</button>)}</div><label className="home-reference-search"><Search size={14} aria-hidden="true" /><input aria-label="搜索创作参考" placeholder="搜索参考内容" value={query} onChange={event => setQuery(event.target.value)} />{query && <button aria-label="清空参考搜索" onClick={() => setQuery('')}><X size={13} /></button>}</label></div>
      {visibleReferences.length ? <div className="home-reference-grid">{visibleReferences.map(item => <button className="home-reference-card" key={item.id} onClick={() => openFeature(item.page)} aria-label={`查看参考：${item.title}`}><span className={`home-reference-image home-reference-${item.id}`} role="img" aria-label={item.detail}><span className="home-reference-category">{item.category}</span></span><span className="home-reference-caption"><strong>{item.title}</strong><small>{item.detail}</small></span></button>)}</div> : <div className="home-reference-empty"><Search size={22} strokeWidth={1.4} /><p>没有找到匹配的参考</p><button onClick={() => { setQuery(''); setFilter('全部'); }}>清空搜索与筛选</button></div>}
    </section>
  </div>;
}
