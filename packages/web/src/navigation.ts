import { BookOpen, Box, Clapperboard, FileText, Film, FolderOpen, House, Images, Settings2, Sparkles, Wand2, Workflow } from 'lucide-react';
import type { Page } from './model';
import type { NovelAdaptationResult } from '@lyra/shared';

export const workspaceNavigation = [
  { id: 'studio' as Page, label: '首页', en: 'Home', icon: House },
  { id: 'projects' as Page, label: '项目', en: 'Projects', icon: FolderOpen },
  { id: 'assets' as Page, label: '资产', en: 'Assets', icon: Images },
  { id: 'methods' as Page, label: '方法库', en: 'Method Library', icon: Wand2 },
  { id: 'evolution' as Page, label: '质量中心', en: 'Quality Center', icon: Sparkles },
];
export const creationNavigation = [
  { id: 'automation' as Page, label: '自动成片', en: 'Production Automation', icon: Film },
  { id: 'novel' as Page, label: '小说拆解', en: 'Novel', icon: BookOpen },
  { id: 'production' as Page, label: '剧本拆解', en: 'Production', icon: FileText },
  { id: 'storyboard' as Page, label: '分镜工作台', en: 'Storyboard', icon: Clapperboard },
  { id: 'director' as Page, label: '3D 导演台', en: 'Director', icon: Box },
];
export const commands = [...workspaceNavigation, ...creationNavigation,
  { id: 'script' as Page, label: '剧本编辑样例', en: 'Script', icon: FileText },
  { id: 'flow' as Page, label: '创作指南', en: 'Workflow', icon: Workflow },
  { id: 'settings' as Page, label: '工作台设置', en: 'Settings', icon: Settings2 },
];
export type ProjectSection = 'overview' | 'source' | 'screenplay' | 'storyboard' | 'director' | 'production' | 'review' | 'history';
export type WorkspaceRoute = {
  page: Page;
  step: number;
  resourceId?: string;
  screenplay?: NovelAdaptationResult;
  projectId?: string;
  projectSection?: ProjectSection;
};
const projectPages: Record<ProjectSection, Page> = {
  overview: 'projects', source: 'production', screenplay: 'production', storyboard: 'storyboard',
  director: 'director', production: 'automation', review: 'projects', history: 'projects',
};
export function projectWorkspaceHash(projectId: string, section: ProjectSection): string {
  return `#/projects/${encodeURIComponent(projectId)}/${section}`;
}
export function screenplayProductionHash(value: NovelAdaptationResult): string {
  return `#/automation/from-script/${encodeURIComponent(value.projectId)}/${encodeURIComponent(value.scriptVersionId)}`;
}
export function routeFromHash(hash: string): WorkspaceRoute {
  const screenplay = /^#\/automation\/from-script\/([a-z][a-z0-9_-]{2,127})\/([a-z][a-z0-9_-]{2,127})$/u.exec(hash);
  if (screenplay) return { page: 'automation', step: 1, resourceId: screenplay[0].slice(2),
    screenplay: { projectId: screenplay[1]!, scriptVersionId: screenplay[2]! } };
  const project = /^#\/projects\/([^/]+)\/(overview|source|screenplay|storyboard|director|production|review|history)\/?$/u.exec(hash);
  if (project) {
    try {
      const projectId = decodeURIComponent(project[1]!);
      const projectSection = project[2]! as ProjectSection;
      return { page: projectPages[projectSection], step: 1, projectId, projectSection };
    } catch { return { page: 'projects', step: 1 }; }
  }
  const legacy = /^#step-([1-9])$/.exec(hash);
  if (legacy) return { page: 'flow', step: Number(legacy[1]) };
  const [name, value] = hash.replace(/^#\/?/, '').split('/');
  const page = commands.some(item => item.id === name) ? name as Page : 'studio';
  let resourceId: string | undefined;
  if ((page === 'production' || page === 'novel') && value) {
    try { resourceId = decodeURIComponent(value); } catch { /* Malformed URLs still open the editor safely. */ }
  }
  if (page === 'assets' && value === 'references') resourceId = 'references';
  if (page === 'automation' && value === 'video') resourceId = 'video';
  if (page === 'settings' && value === 'models') resourceId = 'models';
  return { page, step: page === 'flow' && /^[1-9]$/.test(value ?? '') ? Number(value) : 1, ...(resourceId ? { resourceId } : {}) };
}
