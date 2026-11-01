import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight, ArrowUpRight, AudioLines, BookOpen, Box, Check, Clapperboard,
  FileJson, FileText, Image, Images, Layers3, MapPin, PackageOpen, Puzzle,
  Search, Sparkles, Users, Video, WandSparkles, X,
  type LucideIcon,
} from 'lucide-react';
import { plan, sampleImage, type Page } from './model';
import './library.css';
import './asset-references.css';

type PageProps = { go: (page: Page, step?: number) => void };
type AssetKind = '人物' | '场景' | '道具';
type LibraryItem = {
  id: string; title: string; kind: AssetKind; detail: string;
  shotCount: number; evidence: string[]; crop?: string;
};
const kindNames: Record<string, AssetKind> = { character: '人物', location: '场景', prop: '道具' };
const kindIcons: Record<AssetKind, LucideIcon> = { 人物: Users, 场景: MapPin, 道具: Box };
const entities = [...plan.characters, ...plan.locations, ...plan.props];
const requirements: LibraryItem[] = plan.assetRequirements.map(requirement => ({
  id: requirement.id,
  title: entities.find(entity => entity.id === requirement.entityId)?.name.value ?? '未命名需求',
  kind: kindNames[requirement.kind],
  detail: requirement.description.value,
  shotCount: requirement.shotIds.length,
  evidence: requirement.description.sourceRefs.map(ref => ref.quote),
}));
const visualReferences: LibraryItem[] = [
  { entityId: plan.characters[0].id, crop: 'character-left', detail: '黑衣造型 · 人物视觉参考' },
  { entityId: plan.characters[1].id, crop: 'character-right', detail: '白衣造型 · 人物视觉参考' },
  { entityId: plan.locations[0].id, crop: 'location', detail: '庭院空间 · 场景视觉参考' },
].map(reference => {
  const requirement = plan.assetRequirements.find(item => item.entityId === reference.entityId)!;
  const base = requirements.find(item => item.id === requirement.id)!;
  return { ...base, id: `reference-${reference.entityId}`, crop: reference.crop, detail: reference.detail };
});

function LibraryDetail({ item, onClose, go }: PageProps & { item: LibraryItem | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (item && !dialog.current?.open) dialog.current?.showModal();
    if (!item && dialog.current?.open) dialog.current.close();
  }, [item]);
  return <dialog ref={dialog} className="lib-dialog" aria-labelledby="lib-detail-title" onCancel={onClose} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }}>
    {item && <>
      <div className="lib-dialog-heading"><div><span className="lib-eyebrow">{item.crop ? 'VISUAL REFERENCE' : 'ASSET REQUIREMENT'}</span><h2 id="lib-detail-title">{item.title}</h2></div><button className="lib-icon-button" onClick={onClose} aria-label="关闭资产详情"><X size={19} /></button></div>
      {item.crop && <div className="lib-detail-image"><img src={sampleImage} alt="赴约练习的完整示意画面，两位人物在庭院相对而立" /><span>完整参考画面</span></div>}
      <div className="lib-detail-meta"><span className="lib-badge">{item.kind}</span><span>{item.crop ? '示意图裁切 · 非独立资产' : '待制作 · 暂无素材文件'}</span><span>{item.shotCount} 个参考镜头</span></div>
      <p className="lib-detail-description">{item.detail}</p>
      <div className="lib-evidence"><h3><FileText size={15} />练习原文依据</h3>{item.evidence.map((quote, index) => <blockquote key={`${quote}-${index}`}>{quote}</blockquote>)}</div>
      <p className="lib-detail-source">{item.crop ? '这张参考来自“赴约”练习的同一张 AI 示意图，人物外观、服装与场景是视觉设计示意，并非原文事实或官方设定。' : '需求来自“赴约”手写制作计划样例，保留原文依据；需求描述属于制作设计，目前没有对应的独立素材。'}</p>
      <button className="lib-button lib-button-primary" onClick={() => { onClose(); go('storyboard'); }}>查看示例分镜 <ArrowUpRight size={15} /></button>
    </>}
  </dialog>;
}

export function LibraryPage({ go, compact = false }: PageProps & { compact?: boolean }) {
  const [mode, setMode] = useState<'references' | 'requirements'>('references');
  const [filter, setFilter] = useState<'全部' | AssetKind>('全部');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  const source = mode === 'references' ? visualReferences : requirements;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = source.filter(item => (filter === '全部' || item.kind === filter)
    && `${item.title} ${item.kind} ${item.detail}`.toLocaleLowerCase().includes(normalizedQuery));
  function resetFilters() { setFilter('全部'); setQuery(''); }
  const search = <label className="lib-search"><Search size={15} /><span className="lib-sr-only">搜索示例参考</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称或描述" />{query && <button onClick={() => setQuery('')} aria-label="清除资产搜索"><X size={14} /></button>}</label>;
  return <div className={`lib-page${compact ? ' lib-page-compact' : ''}`}>
    {compact ? <div className="lib-compact-toolbar"><h1>示例参考</h1><div className="lib-compact-controls">{search}<label className="lib-compact-select"><span className="lib-sr-only">示例内容类型</span><select value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="references">视觉参考</option><option value="requirements">资产需求</option></select></label><label className="lib-compact-select"><span className="lib-sr-only">示例资产分类</span><select value={filter} onChange={event => setFilter(event.target.value as typeof filter)}>{(['全部', '人物', '场景', '道具'] as const).map(kind => <option key={kind} value={kind}>{kind === '全部' ? '全部类型' : kind}</option>)}</select></label></div></div> : <>
      <header className="lib-heading"><div><span className="lib-eyebrow">CREATIVE LIBRARY</span><h1>视觉参考<span className="lib-heading-dot" /></h1><p>把角色、场景与道具，放进同一个创作空间。</p></div><button className="lib-button lib-button-secondary" onClick={() => go('flow', 4)}><Layers3 size={16} />了解资产准备<ArrowUpRight size={14} /></button></header>
      <div className="lib-banner"><span className="lib-banner-icon"><Images size={23} strokeWidth={1.6} /></span><div><strong>从一个故事，建立统一的视觉。</strong><p>这里展示“赴约”练习参考与素材需求。正式资产页可登记或导入图片；小说待补项可单张生图。</p></div><span className="lib-banner-label">示例内容</span></div>
      <div className="lib-mode-row"><div className="lib-mode-tabs" aria-label="资产内容类型"><button aria-pressed={mode === 'references'} onClick={() => setMode('references')}>视觉参考 <span>{visualReferences.length}</span></button><button aria-pressed={mode === 'requirements'} onClick={() => setMode('requirements')}>资产需求 <span>{requirements.length}</span></button></div>{search}</div>
      <div className="lib-filter-row"><div className="lib-filters" aria-label="资产分类">{(['全部', '人物', '场景', '道具'] as const).map(kind => <button key={kind} aria-pressed={filter === kind} onClick={() => setFilter(kind)}>{kind}</button>)}</div><span>{visible.length} {mode === 'references' ? '项参考' : '项需求'}</span></div>
    </>}
    {visible.length > 0 ? <div className={`lib-grid ${mode === 'requirements' ? 'lib-requirement-grid' : ''}`}>
      {visible.map(item => {
        const Icon = kindIcons[item.kind];
        return <button className={`lib-card ${item.crop ? 'lib-visual-card' : 'lib-requirement-card'}`} key={item.id} onClick={() => setSelected(item)} aria-label={`查看${item.crop ? '示例参考' : '资产需求'}：${item.title}`}>
          {item.crop ? <div className={`lib-card-image lib-crop-${item.crop}`}><img src={sampleImage} alt={`${item.title} · 同一示意图的裁切参考`} />{!compact && <><span className="lib-image-label">视觉参考</span><span className="lib-open-icon"><ArrowUpRight size={18} /></span></>}</div>
            : <div className={`lib-requirement-top lib-kind-${item.kind}`}><span className="lib-requirement-icon"><Icon size={26} strokeWidth={1.5} /></span>{!compact && <span className="lib-pending-badge">待制作</span>}</div>}
          <div className="lib-card-content"><div className="lib-card-title"><h2>{item.title}</h2><span>{!compact && <Icon size={12} />}{item.kind}</span></div>{!compact && <><p>{item.detail}</p><div className="lib-card-bottom"><span>{item.crop ? '赴约 · 练习参考' : `${item.shotCount} 个参考镜头 · 暂无素材`}</span>{item.crop ? <span className="lib-card-dot" /> : <ArrowUpRight size={15} />}</div></>}</div>
        </button>;
      })}
    </div> : <div className="lib-empty"><span><PackageOpen size={28} strokeWidth={1.4} /></span><h2>{mode === 'references' && filter === '道具' && !query.trim() ? '道具还在需求清单里' : '没有找到匹配的内容'}</h2><p>{mode === 'references' && filter === '道具' && !query.trim() ? '剑与重尺已有制作需求，独立参考素材尚未制作。' : '试试其他名称，或调整分类继续查找。'}</p>{mode === 'references' && filter === '道具' && !query.trim() ? <button className="lib-button lib-button-secondary" onClick={() => setMode('requirements')}>查看道具需求 <ArrowRight size={15} /></button> : <button className="lib-button lib-button-secondary" onClick={resetFilters}>清除筛选</button>}</div>}
    <div className="lib-footnote">{!compact && <FileText size={14} />}<p>{compact ? mode === 'references' ? '同一示意图的 3 个参考裁切，不属于已登记素材；原文与来源见详情。' : '手写样例的 5 项待制作需求，尚无独立素材；原文与来源见详情。' : mode === 'references' ? '3 张参考均为同一示意图的裁切；视觉参考用于探索方向，不代表已生成独立的角色或场景资产。' : '资产需求来自手写计划样例，是待制作清单；需求数量不代表已经完成的素材数量。'}</p></div>
    <LibraryDetail item={selected} onClose={() => setSelected(null)} go={go} />
  </div>;
}

type ToolItem = {
  id: string; name: string; category: string; description: string;
  icon: LucideIcon; color: string; available: boolean; page?: Page; href?: string; action?: string;
};
const builtInTools: ToolItem[] = [
  { id: 'automation', name: '自动制作总控', category: '整集生产', description: '从剧本拆解到资产、分镜、3D、视频抽卡、复核和出片，按真实任务状态推进。', icon: Sparkles, color: 'lime', available: true, page: 'automation', action: '打开生产总控' },
  { id: 'novel', name: '小说逐章拆解', category: '原文与故事', description: '按章提取人物、地点、道具与对白，回到原文核对每一处依据。', icon: BookOpen, color: 'lime', available: true, page: 'novel', action: '打开小说工作区' },
  { id: 'production', name: '剧本拆解', category: '原文与故事', description: '保存真实项目，校对事实候选，检查并采用文字拆解。', icon: FileText, color: 'blue', available: true, page: 'production', action: '打开项目工作区' },
  { id: 'storyboard', name: '分镜编辑', category: '镜头设计', description: '编辑示例镜头的画面、景别、运镜与时长，逐镜对照原文。', icon: Clapperboard, color: 'purple', available: true, page: 'storyboard', action: '打开示例分镜' },
  { id: 'director', name: '3D 导演台', category: '空间预演', description: '手工调整人物站位、机位与光照，预演构图并导出浏览器渲染。', icon: Box, color: 'peach', available: true, page: 'director', action: '进入 3D 导演台' },
  { id: 'json', name: 'JSON 草稿导出', category: '保存与交付', description: '在分镜工作台导出当前浏览器的编辑草稿，留存设计与修改。', icon: FileJson, color: 'mint', available: true, page: 'storyboard', action: '前往分镜导出' },
  { id: 'image', name: '图像生成', category: '视觉创作', description: '将角色、场景与构图设计转为独立图片素材。', icon: Image, color: 'blue', available: false },
  { id: 'video', name: '单镜头视频实验', category: '动态影像', description: '独立测试一段画面的生视频连接，不建立整集生产流水线。', icon: Video, color: 'purple', available: true, href: '#/automation/video', action: '打开单镜头工具' },
  { id: 'voice', name: '对白与配音', category: '声音制作', description: '为原文对白准备角色声音，组织台词与声音素材。', icon: AudioLines, color: 'peach', available: false },
  { id: 'edit', name: '剪辑与成片', category: '后期制作', description: '编排多镜头时间线、对白与字幕，完成整集交付。', icon: WandSparkles, color: 'mint', available: false },
];

export function PluginsPage({ go }: PageProps) {
  const [filter, setFilter] = useState<'全部' | '已可用' | '规划中'>('全部');
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = builtInTools.filter(tool => (filter === '全部' || tool.available === (filter === '已可用'))
    && `${tool.name} ${tool.category} ${tool.description}`.toLocaleLowerCase().includes(normalizedQuery));
  return <div className="plugin-page">
    <header className="plugin-heading"><div><span className="plugin-eyebrow">LYRA · CREATIVE TOOLKIT</span><h1>插件与工具<span className="plugin-heading-dot" /></h1><p>让合适的工具，接住每一步创作。</p></div><span className="plugin-built-in-label"><Puzzle size={14} />{builtInTools.length} 项内置工具<span aria-hidden="true">·</span>{builtInTools.filter(tool => tool.available).length} 项可用</span></header>
    <section className="plugin-feature" aria-labelledby="plugin-feature-title">
      <div className="plugin-feature-copy"><span className="plugin-feature-tag"><Sparkles size={13} />推荐创作路径</span><h2 id="plugin-feature-title">从读懂故事，到看清镜头。</h2><p>把原文、分镜与空间预演，串成一条清晰的创作路径。</p><button onClick={() => go('novel')}>从小说拆解开始 <ArrowUpRight size={15} /></button></div>
      <ol className="plugin-feature-steps" aria-label="推荐创作步骤"><li><span>01</span><strong>读懂故事</strong><small>原文与事实拆解</small></li><li><span>02</span><strong>设计镜头</strong><small>画面与运镜编排</small></li><li><span>03</span><strong>预演空间</strong><small>白模构图与机位</small></li></ol>
    </section>
    <div className="plugin-toolbar"><div className="plugin-filters" aria-label="工具可用状态">{(['全部', '已可用', '规划中'] as const).map(value => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value}<span>{builtInTools.filter(tool => value === '全部' || tool.available === (value === '已可用')).length}</span></button>)}</div><label className="plugin-search"><Search size={16} /><span className="plugin-sr-only">搜索插件与工具</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索创作工具" />{query && <button onClick={() => setQuery('')} aria-label="清除工具搜索"><X size={14} /></button>}</label></div>
    {visible.length ? <div className="plugin-grid">{visible.map(tool => <article className={`plugin-card ${!tool.available ? 'plugin-card-planned' : ''}`} key={tool.id}><div className="plugin-card-top"><span className={`plugin-tool-icon plugin-color-${tool.color}`}><tool.icon size={25} strokeWidth={1.6} /></span><span className={`plugin-status ${tool.available ? 'plugin-status-ready' : ''}`}>{tool.available && <Check size={11} />}{tool.available ? '已可用' : '规划中'}</span></div><span className="plugin-category">{tool.category}</span><h2>{tool.name}</h2><p>{tool.description}</p><div className="plugin-card-footer"><span>{tool.available ? 'Lyra 内置' : '尚未接入'}</span><button disabled={!tool.available} onClick={() => { if (tool.href) location.hash = tool.href; else if (tool.page) go(tool.page); }} aria-label={tool.action ?? `${tool.name}尚未接入`}>{tool.available ? '打开工具' : '敬请期待'}{tool.available && <ArrowUpRight size={14} />}</button></div></article>)}</div> : <div className="plugin-empty"><Search size={27} strokeWidth={1.4} /><h2>没有找到这个工具</h2><p>换一个关键词，或查看全部工具。</p><button onClick={() => { setFilter('全部'); setQuery(''); }}>查看全部工具 <ArrowRight size={14} /></button></div>}
    <div className="plugin-footnote"><Puzzle size={15} /><p>这里展示 Lyra 内置能力，目前没有第三方插件安装系统。小说与剧本的模型提取需要本地服务及单次授权；打开工具不会触发生成。</p></div>
  </div>;
}
