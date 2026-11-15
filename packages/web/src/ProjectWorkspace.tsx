import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  ArrowRight, BookOpen, Box, CheckCircle2, Circle, Clapperboard, Film, Images,
  LayoutDashboard, Network, Play, ShieldCheck,
} from 'lucide-react';
import type { Draft } from './model';
import type { ProjectSection } from './navigation';
import {
  parseProjectFlowSection, parseProjectWorkspaceSection, projectFlowHash, scriptWorkspacePanel,
  PROJECT_FLOW_SECTIONS, type ProjectFlowSection, type ProjectWorkspaceSection, type ScriptWorkspacePanel,
} from './project-flow';
import type { ProjectWorkspaceOverview } from '@lyra/shared';
import { fetchProjectWorkspaceOverview } from './project-workspace-api';
import {
  formatProjectDate, projectKindLabels, useProjectCatalog,
  type ProjectEntry, type ProjectSummary,
} from './project-catalog';
import ProjectScriptWorkspace from './ProjectScriptWorkspace';
import ProjectStoryboardWorkspace from './ProjectStoryboardWorkspace';
import ProjectAssetsWorkspace from './ProjectAssetsWorkspace';
import './project-workspace.css';

type WorkspaceViewProps = { projectId: string; draft: Draft };
type ProjectWorkspaceProps = WorkspaceViewProps & {
  /** 接受既有 ProjectSection 与新区段 ProjectFlowSection；旧区段由 parseProjectFlowSection 归一。 */
  section: ProjectSection | ProjectWorkspaceSection;
  /** 正式剧本工作区的未保存状态上报给 App 的 hash 守卫。 */
  onUnsavedChange?: (dirty: boolean) => void;
  children: ReactNode;
};
type WorkspaceContextValue = {
  projectId: string;
  entry: ProjectEntry;
  summary?: ProjectSummary;
  flowSection: ProjectFlowSection;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const sectionIcons: Record<ProjectFlowSection, typeof LayoutDashboard> = {
  overview: LayoutDashboard,
  script: BookOpen,
  assets: Images,
  storyboard: Clapperboard,
  canvas: Network,
  production: Film,
};

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

/** 新主链区段的内部渲染；practice 项目与画布/制作区段继续使用 children。 */
function sectionBody({ projectId, flowSection, scriptPanel, practice, children, onUnsavedChange }: {
  projectId: string; flowSection: ProjectFlowSection; scriptPanel: ScriptWorkspacePanel; practice: boolean; children: ReactNode;
  onUnsavedChange?: (dirty: boolean) => void;
}) {
  if (practice) return children;
  switch (flowSection) {
    case 'script': return <ProjectScriptWorkspace projectId={projectId} panel={scriptPanel} onUnsavedChange={onUnsavedChange} />;
    case 'assets': return <ProjectAssetsWorkspace projectId={projectId} />;
    case 'storyboard': return <ProjectStoryboardWorkspace projectId={projectId} />;
    default: return children;
  }
}

export default function ProjectWorkspace({ projectId, section, draft, children, onUnsavedChange }: ProjectWorkspaceProps) {
  const catalog = useProjectCatalog(draft);
  const entry = catalog.entries.find(item => item.id === projectId) ?? fallbackEntry(projectId, draft);
  const summary = catalog.projects.items.find(item => item.id === projectId);
  const flowSection = parseProjectFlowSection(section) ?? 'overview';
  const scriptPanel = scriptWorkspacePanel(parseProjectWorkspaceSection(section));
  const practice = projectId === 'local-practice';
  const current = PROJECT_FLOW_SECTIONS.find(item => item.id === flowSection)!;
  const Icon = sectionIcons[flowSection];
  const context = { projectId, entry, summary, flowSection };

  return <WorkspaceContext.Provider value={context}>
    <section className={`project-workspace project-workspace-${flowSection}`}>
      <aside className="project-rail" aria-label="项目工作区导航">
        <a className="project-back" href="#/projects"><Circle size={12} />所有项目</a>
        <div className="project-identity">
          <span className="project-identity-mark" aria-hidden="true">{entry.title.slice(0, 1)}</span>
          <div><strong>{entry.title}</strong><small>{projectKindLabels[entry.kind]} · {entry.status}</small></div>
        </div>
        <nav className="project-stage-nav">
          {PROJECT_FLOW_SECTIONS.map((item) => {
            const active = item.id === flowSection;
            const ItemIcon = sectionIcons[item.id];
            return <a key={item.id} href={projectFlowHash(projectId, item.id)} aria-current={active ? 'page' : undefined}>
              <span className="project-stage-icon"><ItemIcon size={16} strokeWidth={1.7} /></span>
              <span><strong>{item.label}</strong><small>{item.note}</small></span>
              {active ? <CheckCircle2 size={13} className="project-stage-state done" /> : <Circle size={8} className="project-stage-state" />}
            </a>;
          })}
        </nav>
        <div className="project-rail-foot"><ShieldCheck size={14} /><span>项目内容按版本保存<br /><small>关键操作均需人工确认</small></span></div>
      </aside>

      <div className="project-workspace-main">
        <header className="project-workspace-header">
          <div><p>PROJECT · {current.label}</p><h1><Icon size={20} strokeWidth={1.7} /> {current.label}</h1><span>{current.note}</span></div>
          <div className="project-save-state"><span /><div><strong>{entry.kind === 'practice' ? '保存在本浏览器（练习用，不用于正式制作）' : '项目数据已同步'}</strong><small>{formatProjectDate(entry.date)}</small></div></div>
        </header>
        <div className={`project-workspace-content project-section-${flowSection}`}>
          {sectionBody({ projectId, flowSection, scriptPanel, practice, children, onUnsavedChange })}
        </div>
      </div>
    </section>
  </WorkspaceContext.Provider>;
}

export function useProjectWorkspaceContext(): WorkspaceContextValue | null {
  return useContext(WorkspaceContext);
}

/** 概览：真实状态摘要 + 服务端给定的唯一主行动；练习/失败时退化为静态卡片。 */
export function ProjectOverview({ projectId, draft }: WorkspaceViewProps) {
  const ctx = useProjectWorkspaceContext();
  const entry = ctx?.entry ?? fallbackEntry(projectId, draft);
  const practice = projectId === 'local-practice';
  return <OverviewBody projectId={projectId} title={entry.title} practice={practice} />;
}

function OverviewBody({ projectId, title, practice }: { projectId: string; title: string; practice: boolean }) {
  const [overview, setOverview] = useState<ProjectWorkspaceOverview | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (practice) return;
    let alive = true;
    fetchProjectWorkspaceOverview(projectId)
      .then(data => { if (alive) setOverview(data); })
      .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : '读取项目概览失败。'); });
    return () => { alive = false; };
  }, [projectId, practice]);

  if (practice) {
    return <div className="project-overview">
      <section className="project-overview-hero">
        <div className="project-overview-copy">
          <span className="project-kicker"><BookOpen size={13} />本地练习</span>
          <h2>这是练习草稿</h2>
          <p>「赴约」分镜练习只保存在本浏览器，不写入项目正式版本。</p>
        </div>
      </section>
    </div>;
  }
  if (error) return <div className="project-simple-view"><p className="project-kicker">PROJECT OVERVIEW</p><h2>读取项目概览失败</h2><p>{error}</p></div>;
  if (!overview) return <div className="project-simple-view"><p className="project-kicker">PROJECT OVERVIEW</p><h2>正在读取真实状态…</h2></div>;

  const next = overview.nextAction;
  return <div className="project-overview">
    <section className="project-overview-hero">
      <div className="project-overview-copy">
        <span className="project-kicker"><Play size={13} />唯一主行动</span>
        <h2>{next ? next.label : '项目状态良好'}</h2>
        <p>{next ? next.detail : '剧本、事实、资产与分镜均已就绪，可以继续制作流程。'}</p>
        {next && <a className="project-primary-action" href={projectFlowHash(projectId, next.section)}>{next.label}<ArrowRight size={15} /></a>}
      </div>
    </section>
    <section className="project-overview-stats" aria-label="项目真实状态">
      <article><span>剧本版本</span><strong>{overview.script ? `V${overview.script.version}` : '未保存'}</strong><small>{overview.script?.updatedAt ? formatProjectDate(overview.script.updatedAt) : '请先保存原文'}</small></article>
      <article><span>已采用事实</span><strong>{overview.facts ? `${overview.facts.sceneCount} 场` : '未采用'}</strong><small>{overview.facts ? `${overview.facts.entityCount} 个实体${overview.facts.stale ? ' · 已过期' : ''}` : '等待拆解与采用'}</small></article>
      <article><span>资产绑定</span><strong>{overview.assets.ready}/{overview.assets.total}</strong><small>{overview.assets.missing + overview.assets.ambiguous > 0 ? `缺 ${overview.assets.missing} · 歧义 ${overview.assets.ambiguous}` : '已全部绑定'}</small></article>
      <article><span>采用分镜</span><strong>{overview.storyboard ? `${overview.storyboard.shotCount} 镜` : '未采用'}</strong><small>{overview.storyboard ? `${overview.storyboard.candidateCount} 个候选${overview.storyboard.stale ? ' · 已过期' : ''}` : '等待生成分镜候选'}</small></article>
      <article><span>最新运行</span><strong>{overview.latestRun ? overview.latestRun.status : '无'}</strong><small>{overview.latestRun?.stage ?? '尚未运行'}</small></article>
      <article><span>待办</span><strong>{overview.todos.length} 项</strong><small>{overview.delivery.available ? '已有交付物' : '暂无交付'}</small></article>
    </section>
    {overview.todos.length > 0 && <section className="project-overview-grid">
      <article className="project-next-card">
        <div className="project-card-heading"><span><Circle size={15} />待办清单</span></div>
        <ul className="project-todo-list">{overview.todos.map(todo => <li key={todo.id}><strong>{todo.label}</strong><small>{todo.kind}</small></li>)}</ul>
      </article>
    </section>}
  </div>;
}

export function ProjectReview({ projectId, draft }: WorkspaceViewProps) {
  void projectId; void draft;
  return <div className="project-simple-view">
    <div className="project-simple-icon"><CheckCircle2 size={26} /></div>
    <p className="project-kicker">DELIVERY CHECKPOINT</p>
    <h2>交付前把关键版本集中确认一次。</h2>
    <p>本区段已并入「制作交付」主链；正式版本与交付状态以上方概览为准。</p>
    <a className="project-primary-action" href={projectFlowHash(projectId, 'production')}>前往制作交付<ArrowRight size={15} /></a>
  </div>;
}

export function ProjectHistory({ projectId, draft }: WorkspaceViewProps) {
  const entry = fallbackEntry(projectId, draft);
  return <div className="project-history-view">
    <div className="project-history-heading"><div className="project-simple-icon"><Box size={24} /></div><div><p className="project-kicker">VERSION TIMELINE</p><h2>项目历史</h2><span>版本记录随每次正式保存积累。</span></div></div>
    <div className="project-timeline">
      <article><i className="current" /><time>{formatProjectDate(entry.date)}</time><div><strong>{entry.status}</strong><p>当前项目以概览区的真实版本快照为准。</p><span>当前状态</span></div></article>
    </div>
  </div>;
}
