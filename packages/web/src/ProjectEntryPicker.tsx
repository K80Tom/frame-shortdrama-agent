import type { Draft } from './model';
import { projectWorkspaceHash, type ProjectSection } from './navigation';
import { useProjectCatalog } from './project-catalog';

export default function ProjectEntryPicker({ section, draft, onNew }: { section: ProjectSection; draft: Draft; onNew: () => void }) {
  const { projects } = useProjectCatalog(draft);
  const title = section === 'source' ? '打开项目剧本' : section === 'canvas' ? '打开项目画布' : '打开项目制作';
  return <section className="project-entry-picker panel"><h1>{title}</h1><p>先选择项目。后续工作区保留项目上下文，不另建全局生产数据。</p>
    {projects.status === 'loading' && <p role="status">正在读取项目…</p>}
    {projects.status === 'error' && <div role="alert"><p>{projects.error}</p><button className="button secondary" onClick={projects.retry}>重试读取项目</button></div>}
    <ul>{projects.items.map(project => <li key={project.id}><a href={projectWorkspaceHash(project.id, section)}>{project.title}</a></li>)}</ul>
    {projects.status === 'ready' && !projects.items.length && <p>还没有真实项目，请先新建项目。</p>}
    <button className="button primary" onClick={onNew}>新建项目</button>
  </section>;
}
