import { BookOpen, Box, Clapperboard, FileText, Film, FolderOpen, House, Images, Puzzle, Settings2, Sparkles, Wand2, Workflow } from 'lucide-react';
import type { Page } from './model';
import type { NovelAdaptationResult } from '@lyra/shared';

export const workspaceNavigation = [
  { id: 'studio' as Page, label: '首页', en: 'Home', icon: House },
  { id: 'projects' as Page, label: '项目', en: 'Projects', icon: FolderOpen },
  { id: 'assets' as Page, label: '资产', en: 'Assets', icon: Images },
  { id: 'plugins' as Page, label: '插件', en: 'Plugins', icon: Puzzle },
];
export const creationNavigation = [
  { id: 'automation' as Page, label: '自动成片', en: 'Production Automation', icon: Film },
  { id: 'evolution' as Page, label: '自进化', en: 'Evolution', icon: Sparkles },
  { id: 'methods' as Page, label: '方法包', en: 'Method Packs', icon: Wand2 },
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
export type WorkspaceRoute = { page: Page; step: number; resourceId?: string; screenplay?: NovelAdaptationResult };
export function screenplayProductionHash(value: NovelAdaptationResult): string {
  return `#/automation/from-script/${encodeURIComponent(value.projectId)}/${encodeURIComponent(value.scriptVersionId)}`;
}
export function routeFromHash(hash: string): WorkspaceRoute {
  const screenplay = /^#\/automation\/from-script\/([a-z][a-z0-9_-]{2,127})\/([a-z][a-z0-9_-]{2,127})$/u.exec(hash);
  if (screenplay) return { page: 'automation', step: 1, resourceId: screenplay[0].slice(2),
    screenplay: { projectId: screenplay[1]!, scriptVersionId: screenplay[2]! } };
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
