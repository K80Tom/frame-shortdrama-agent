import { AlertCircle, ArrowRight, LoaderCircle, Plus, RefreshCw } from 'lucide-react';
import type { Draft, Page } from './model';
import { formatProjectDate, projectKindLabels, useProjectCatalog, type ProjectEntry } from './project-catalog';
import './home.css';

type Props = { go: (page: Page) => void; draft: Draft; onNew: () => void; onAdvanced: () => void;
  onOpenProject: (id: string) => void; onOpenNovel: (id: string) => void };

export default function WorkspaceHome({ go, draft, onNew, onAdvanced, onOpenProject, onOpenNovel }: Props) {
  const { entries, projects, novels } = useProjectCatalog(draft);
  const loading = projects.status === 'loading' || novels.status === 'loading';
  const recent = entries.filter(entry => entry.kind !== 'practice').slice(0, 6);
  const latest = recent[0];
  const failed = projects.status === 'error' || novels.status === 'error';
  function open(entry: ProjectEntry) {
    if (entry.kind === 'project') onOpenProject(entry.id);
    else if (entry.kind === 'novel') onOpenNovel(entry.id);
  }
  return <div className="workspace-home">
    <header className="home-heading"><div><h1>工作台</h1><p>从最近的项目继续，或为新故事建立项目。</p></div>
      <div className="home-actions"><button className="home-primary" onClick={onNew}><Plus size={16} />新建项目</button>
        <button className="home-secondary" disabled={!latest || loading} onClick={() => latest && open(latest)}>
          {failed ? '继续最近已加载项目' : '继续最近项目'}<ArrowRight size={15} /></button></div>
    </header>
    <section className="home-projects" aria-labelledby="home-recent-title">
      <div className="home-section-heading"><h2 id="home-recent-title">最近项目</h2><button onClick={() => go('projects')}>查看全部项目<ArrowRight size={14} /></button></div>
      <div className="home-recent-list" aria-busy={loading}>
        {recent.map(entry => <button className="home-project-row" key={`${entry.kind}:${entry.id}`} onClick={() => open(entry)}
          aria-label={`继续${projectKindLabels[entry.kind]}：${entry.title}`}>
          <span className="home-project-title"><strong>{entry.title}</strong><small>{projectKindLabels[entry.kind]} · {entry.status}</small></span>
          <time dateTime={entry.date ?? undefined}>{formatProjectDate(entry.date)}</time><ArrowRight size={16} aria-hidden="true" />
        </button>)}
        {loading && !recent.length && [0, 1].map(index => <div className="home-project-skeleton" key={index} aria-hidden="true" />)}
        {!loading && !recent.length && <p className="home-empty">{failed ? '暂时无法读取项目，请重试；不会用样例代替真实项目。' : '还没有项目。点击上方“新建项目”，从剧本或小说开始。'}</p>}
      </div>
      {loading && <p className="home-loading" role="status"><LoaderCircle size={14} />正在读取项目</p>}
      {[{ label: '剧本项目', source: projects }, { label: '小说原文', source: novels }].map(({ label, source }) => source.status === 'error' &&
        <div className="home-catalog-error" role="alert" key={label}><AlertCircle size={15} /><span>{label}未能读取：{source.error}</span>
          <button onClick={source.retry}><RefreshCw size={14} />重试{label}</button></div>)}
    </section>
    <footer className="home-advanced"><span>方法库、质量中心、3D 预演和创作指南</span><button onClick={onAdvanced}>更多/高级工具<ArrowRight size={14} /></button></footer>
  </div>;
}
