import { BookOpen, Box, Clapperboard, FileText, Film, FolderOpen, House, Images, Network, Settings2, Sparkles, Wand2, Workflow } from 'lucide-react';
import type { Page } from './model';
import type { NovelAdaptationResult } from '@lyra/shared';

export const workspaceNavigation = [
  { id: 'studio' as Page, label: '工作台', en: 'Workspace', icon: House },
  { id: 'projects' as Page, label: '项目', en: 'Projects', icon: FolderOpen },
  { id: 'assets' as Page, label: '资产库', en: 'Assets', icon: Images },
  { id: 'automation' as Page, label: 'AI 视频', en: 'AI Video', icon: Film, hash: '#/automation/video' },
  { id: 'settings' as Page, label: '设置', en: 'Settings', icon: Settings2 },
];
export const advancedNavigation = [
  { id: 'methods' as Page, label: '方法库', en: 'Method Library', icon: Wand2 },
  { id: 'evolution' as Page, label: '质量中心', en: 'Quality Center', icon: Sparkles },
  { id: 'director' as Page, label: '3D 导演预演', en: '3D Preview', icon: Box },
  { id: 'flow' as Page, label: '创作指南与样例', en: 'Guide and Practice', icon: Workflow },
];
// Kept as route inventory for existing go() calls and bookmarks, not global navigation.
export const creationNavigation = [
  { id: 'automation' as Page, label: '项目制作', en: 'Production', icon: Film },
  { id: 'novel' as Page, label: '小说导入', en: 'Novel', icon: BookOpen },
  { id: 'production' as Page, label: '项目剧本', en: 'Script', icon: FileText },
  { id: 'storyboard' as Page, label: '分镜练习', en: 'Storyboard Practice', icon: Clapperboard },
  { id: 'canvas' as Page, label: '项目画布', en: 'Canvas', icon: Network },
  { id: 'director' as Page, label: '3D 导演预演', en: 'Director', icon: Box },
];
export const commands = [...workspaceNavigation, ...advancedNavigation];
export function navigationHash(item: { id: Page; hash?: string }): string {
  return item.hash ?? `#/${item.id}`;
}
export type ProjectSection = 'overview' | 'source' | 'screenplay' | 'storyboard' | 'canvas' | 'director' | 'production' | 'review' | 'history';
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
  canvas: 'canvas', director: 'director', production: 'automation', review: 'projects', history: 'projects',
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
  const project = /^#\/projects\/([^/]+)\/(overview|source|screenplay|storyboard|canvas|director|production|review|history)\/?$/u.exec(hash);
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
  const page = [...commands, ...creationNavigation, { id: 'script' }].some(item => item.id === name) ? name as Page : 'studio';
  let resourceId: string | undefined;
  if ((page === 'production' || page === 'novel' || page === 'canvas') && value) {
    try { resourceId = decodeURIComponent(value); } catch { /* Malformed URLs still open the editor safely. */ }
  }
  if (page === 'assets' && value === 'references') resourceId = 'references';
  if (page === 'automation' && value === 'video') resourceId = 'video';
  if (page === 'settings' && value === 'models') resourceId = 'models';
  return { page, step: page === 'flow' && /^[1-9]$/.test(value ?? '') ? Number(value) : 1, ...(resourceId ? { resourceId } : {}) };
}
