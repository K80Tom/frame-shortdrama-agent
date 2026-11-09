import { createContext, useContext, type ReactNode } from 'react';
import {
  ArrowLeft, ArrowRight, BookOpen, Box, Check, CheckCircle2, Circle, Clapperboard,
  Clock3, FileCheck2, FileText, Film, FolderClock, History, LayoutDashboard, Play,
  ShieldCheck, Sparkles,
} from 'lucide-react';
import type { Draft } from './model';
import { projectWorkspaceHash, type ProjectSection } from './navigation';
import {
  formatProjectDate, projectKindLabels, useProjectCatalog,
  type ProjectEntry, type ProjectSummary,
} from './project-catalog';
import './project-workspace.css';

type WorkspaceViewProps = { projectId: string; draft: Draft };
type ProjectWorkspaceProps = WorkspaceViewProps & {
  section: ProjectSection;
  children: ReactNode;
};
type WorkspaceContextValue = {
  projectId: string;
  entry: ProjectEntry;
  summary?: ProjectSummary;
  completed: Set<ProjectSection>;
  nextSection: ProjectSection;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const sectionMeta: Array<{
  id: ProjectSection;
  label: string;
  eyebrow: string;
  description: string;
  icon: typeof LayoutDashboard;
}> = [
  { id: 'overview', label: '项目概览', eyebrow: 'PROJECT OVERVIEW', description: '掌握当前版本、制作进度与下一步动作。', icon: LayoutDashboard },
  { id: 'source', label: '原著与素材', eyebrow: 'SOURCE', description: '整理原著、章节范围与改编所需的基础素材。', icon: BookOpen },
  { id: 'screenplay', label: '剧本拆解', eyebrow: 'SCREENPLAY', description: '校对人物、场景、对白与剧情事实。', icon: FileText },
  { id: 'storyboard', label: '分镜设计', eyebrow: 'STORYBOARD', description: '把剧本转译为镜头、构图与节奏。', icon: Clapperboard },
  { id: 'director', label: '3D 导演', eyebrow: 'SPATIAL DIRECTION', description: '在白模空间中安排站位、机位与调度。', icon: Box },
  { id: 'production', label: '自动制作', eyebrow: 'PRODUCTION', description: '统一查看生成任务、人工检查点与成片进度。', icon: Film },
  { id: 'review', label: '审核交付', eyebrow: 'REVIEW & DELIVERY', description: '汇总版本、技术检查和最终交付物。', icon: FileCheck2 },
  { id: 'history', label: '版本历史', eyebrow: 'PROJECT HISTORY', description: '回看项目的重要版本和制作节点。', icon: History },
];

function fallbackEntry(projectId: string, draft: Draft): ProjectEntry {
  if (projectId === 'local-practice') {
    return {
      id: projectId,
      title: '赴约 · 分镜练习',
      kind: 'practice',
      date: draft.savedAt,
      status: draft.savedAt ? `草稿 V${draft.revision}` : '本地练习',
    };
  }
  return { id: projectId, title: '正在读取项目', kind: 'project', date: null, status: '同步中' };
}

function progressFor(entry: ProjectEntry, summary?: ProjectSummary): Set<ProjectSection> {
  const completed = new Set<ProjectSection>(['overview']);
  if (entry.kind === 'practice') {
    completed.add('source'); completed.add('screenplay'); completed.add('storyboard');
    return completed;
  }
  if (entry.kind === 'novel') completed.add('source');
  if (summary?.currentScriptVersionId) completed.add('source');
  if (summary?.activePlanRevisionId) completed.add('screenplay');
  if (summary?.activeStoryboardRevisionId) completed.add('storyboard');
  return completed;
}

function nextFor(completed: Set<ProjectSection>): ProjectSection {
  return (['source', 'screenplay', 'storyboard', 'director', 'production', 'review'] as ProjectSection[])
    .find(section => !completed.has(section)) ?? 'production';
}

function useWorkspaceView(projectId: string, draft: Draft) {
  const current = useContext(WorkspaceContext);
  if (current?.projectId === projectId) return current;
  const entry = fallbackEntry(projectId, draft);
  const completed = progressFor(entry);
  return { projectId, entry, completed, nextSection: nextFor(completed) };
}

export default function ProjectWorkspace({ projectId, section, draft, children }: ProjectWorkspaceProps) {
  const catalog = useProjectCatalog(draft);
  const entry = catalog.entries.find(item => item.id === projectId) ?? fallbackEntry(projectId, draft);
  const summary = catalog.projects.items.find(item => item.id === projectId);
  const completed = progressFor(entry, summary);
  const nextSection = nextFor(completed);
  const current = sectionMeta.find(item => item.id === section) ?? sectionMeta[0]!;
  const progressSections = sectionMeta.filter(item => !['overview', 'history'].includes(item.id));
  const progress = Math.round((progressSections.filter(item => completed.has(item.id)).length / progressSections.length) * 100);
  const context = { projectId, entry, summary, completed, nextSection };

  return <WorkspaceContext.Provider value={context}>
    <section className="project-workspace">
      <aside className="project-rail" aria-label="项目工作区导航">
        <a className="project-back" href="#/projects"><ArrowLeft size={14} />所有项目</a>
        <div className="project-identity">
          <span className="project-identity-mark" aria-hidden="true">{entry.title.slice(0, 1)}</span>
          <div><strong>{entry.title}</strong><small>{projectKindLabels[entry.kind]} · {entry.status}</small></div>
        </div>
        <div className="project-progress" aria-label={`项目进度 ${progress}%`}>
          <span><b>制作进度</b><strong>{progress}%</strong></span>
          <i><span style={{ width: `${progress}%` }} /></i>
        </div>
        <nav className="project-stage-nav">
          {sectionMeta.map((item, index) => {
            const active = item.id === section;
            const done = completed.has(item.id);
            const Icon = item.icon;
            return <a key={item.id} href={projectWorkspaceHash(projectId, item.id)} aria-current={active ? 'page' : undefined}>
              <span className="project-stage-icon"><Icon size={16} strokeWidth={1.7} /></span>
              <span><strong>{item.label}</strong>{index > 0 && index < 7 && <small>{done ? '已准备' : active ? '进行中' : '待推进'}</small>}</span>
              {done ? <Check size={13} className="project-stage-state done" /> : <Circle size={8} className="project-stage-state" />}
            </a>;
          })}
        </nav>
        <div className="project-rail-foot"><ShieldCheck size={14} /><span>项目内容按版本保存<br /><small>关键操作均需人工确认</small></span></div>
      </aside>

      <div className="project-workspace-main">
        <header className="project-workspace-header">
          <div><p>{current.eyebrow}</p><h1>{current.label}</h1><span>{current.description}</span></div>
          <div className="project-save-state"><span /><div><strong>{entry.kind === 'practice' ? '保存在本浏览器' : '项目数据已同步'}</strong><small>{formatProjectDate(entry.date)}</small></div></div>
        </header>
        <div className={`project-workspace-content project-section-${section}`}>{children}</div>
      </div>
    </section>
  </WorkspaceContext.Provider>;
}

export function ProjectOverview({ projectId, draft }: WorkspaceViewProps) {
  const { entry, completed, nextSection } = useWorkspaceView(projectId, draft);
  const next = sectionMeta.find(item => item.id === nextSection)!;
  const NextIcon = next.icon;
  const completedCount = sectionMeta.filter(item => !['overview', 'history'].includes(item.id) && completed.has(item.id)).length;

  return <div className="project-overview">
    <section className="project-overview-hero">
      <div className="project-overview-copy">
        <span className="project-kicker"><Sparkles size={13} />下一步建议</span>
        <h2>让故事沿着一条清晰的制作路径向前。</h2>
        <p>原著、剧本、分镜、3D 预演与自动制作都归属于当前项目，切换步骤时不再丢失上下文。</p>
        <a className="project-primary-action" href={projectWorkspaceHash(projectId, nextSection)}><Play size={14} fill="currentColor" />继续：{next.label}<ArrowRight size={15} /></a>
      </div>
      <div className="project-overview-art" aria-hidden="true">
        <span className="project-art-glow" />
        <span className="project-art-frame"><i /><i /><i /></span>
        <span className="project-art-caption">LYRA PROJECT · {entry.title.toLocaleUpperCase()}</span>
      </div>
    </section>

    <section className="project-overview-stats" aria-label="项目摘要">
      <article><span>当前状态</span><strong>{entry.status}</strong><small>以保存版本为准</small></article>
      <article><span>已准备阶段</span><strong>{completedCount}<em>/ 6</em></strong><small>可随时回到任一步骤</small></article>
      <article><span>最近保存</span><strong>{formatProjectDate(entry.date)}</strong><small>{entry.kind === 'practice' ? '本地浏览器草稿' : '项目工作区'}</small></article>
    </section>

    <section className="project-overview-grid">
      <article className="project-next-card">
        <div className="project-card-heading"><span><Clock3 size={15} />当前工作</span><small>推荐</small></div>
        <div className="project-next-icon"><NextIcon size={24} /></div>
        <h3>{next.label}</h3><p>{next.description}</p>
        <a href={projectWorkspaceHash(projectId, nextSection)}>打开工作区<ArrowRight size={14} /></a>
      </article>
      <article className="project-path-card">
        <div className="project-card-heading"><span><FolderClock size={15} />制作路径</span><small>按项目组织</small></div>
        <div className="project-path-list">
          {sectionMeta.slice(1, 7).map((item, index) => <a key={item.id} href={projectWorkspaceHash(projectId, item.id)}>
            <span className={completed.has(item.id) ? 'complete' : ''}>{completed.has(item.id) ? <CheckCircle2 size={14} /> : String(index + 1).padStart(2, '0')}</span>
            <div><strong>{item.label}</strong><small>{item.description}</small></div><ArrowRight size={13} />
          </a>)}
        </div>
      </article>
    </section>
  </div>;
}

export function ProjectReview({ projectId, draft }: WorkspaceViewProps) {
  const { completed } = useWorkspaceView(projectId, draft);
  const checks = [
    { section: 'screenplay' as const, label: '剧本与事实版本', note: '采用后的拆解版本会进入交付清单' },
    { section: 'storyboard' as const, label: '分镜连续性', note: '镜头顺序、引用与对白覆盖' },
    { section: 'production' as const, label: '成片技术检查', note: '媒体完整性与最终输出仍需人工验收' },
  ];
  return <div className="project-simple-view">
    <div className="project-simple-icon"><FileCheck2 size={26} /></div>
    <p className="project-kicker">DELIVERY CHECKPOINT</p>
    <h2>交付前，把关键版本集中确认一次。</h2>
    <p>这里不会替你做视觉质量判断，只汇总项目中已经保存并采用的版本。</p>
    <div className="project-review-list">{checks.map(item => <div key={item.section}>
      {completed.has(item.section) ? <CheckCircle2 size={18} /> : <Circle size={16} />}
      <span><strong>{item.label}</strong><small>{item.note}</small></span>
      <em>{completed.has(item.section) ? '已准备' : '等待上一步'}</em>
    </div>)}</div>
    <a className="project-primary-action" href={projectWorkspaceHash(projectId, 'production')}>查看自动制作<ArrowRight size={15} /></a>
  </div>;
}

export function ProjectHistory({ projectId, draft }: WorkspaceViewProps) {
  const { entry, completed } = useWorkspaceView(projectId, draft);
  const latest = [...sectionMeta].reverse().find(item => completed.has(item.id)) ?? sectionMeta[0]!;
  return <div className="project-history-view">
    <div className="project-history-heading"><div className="project-simple-icon"><History size={24} /></div><div><p className="project-kicker">VERSION TIMELINE</p><h2>项目历史</h2><span>版本记录会随着每次正式保存逐步积累。</span></div></div>
    <div className="project-timeline">
      <article><i className="current" /><time>{formatProjectDate(entry.date)}</time><div><strong>{entry.status}</strong><p>当前项目已推进至“{latest.label}”。</p><span>当前版本</span></div></article>
      <article><i /><time>项目起点</time><div><strong>{entry.kind === 'practice' ? '载入本地练习' : '创建项目工作区'}</strong><p>建立独立的故事、版本和制作上下文。</p></div></article>
    </div>
    <p className="project-history-note"><Clock3 size={14} />更多剧本、分镜和制作运行记录会在保存后出现在这里。</p>
  </div>;
}
