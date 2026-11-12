/**
 * 项目正式工作区段（#182）的唯一事实来源。
 * 阶段 1 与 navigation.ts 的 legacy ProjectSection 并存：旧 hash 经 LEGACY_SECTION_ALIAS
 * 归一到主链区段，不出现 404；App.tsx 的接线由 TL 在集成 worktree 完成。
 */
export type ProjectFlowSection = 'overview' | 'script' | 'assets' | 'storyboard' | 'canvas' | 'production';
export type ScriptWorkspacePanel = 'parse' | 'structure';
export type ProjectWorkspaceSection = ProjectFlowSection | 'script-parse' | 'script-structure';

export interface ProjectFlowSectionMeta {
  id: ProjectFlowSection;
  label: string;
  note: string;
}

/** 顺序固定：概览→剧本→资产→分镜→画布→制作。 */
export const PROJECT_FLOW_SECTIONS: ReadonlyArray<ProjectFlowSectionMeta> = [
  { id: 'overview', label: '项目概览', note: '真实状态摘要与唯一主行动' },
  { id: 'script', label: '剧本与事实', note: '原文版本、拆解与事实采用' },
  { id: 'assets', label: '资产需求', note: '需求 vs 已绑定资产，只读' },
  { id: 'storyboard', label: '正式分镜', note: '已采用事实生成的候选分镜' },
  { id: 'canvas', label: '生产画布', note: '镜头、资产与运行依赖图' },
  { id: 'production', label: '制作交付', note: '生成任务、检查点与交付' },
];

/** 旧区段别名：source/screenplay→script，review/history→production，director→storyboard。 */
export const LEGACY_SECTION_ALIAS: Record<string, ProjectFlowSection> = {
  source: 'script',
  screenplay: 'script',
  review: 'production',
  history: 'production',
  director: 'storyboard',
  'script-parse': 'script',
  'script-structure': 'script',
};

const FLOW_SECTION_IDS = new Set<string>(PROJECT_FLOW_SECTIONS.map(item => item.id));

export function projectFlowHash(projectId: string, section: ProjectWorkspaceSection): string {
  return `#/projects/${encodeURIComponent(projectId)}/${section}`;
}

/**
 * 接受新区段与旧区段别名；非法值返回 null（调用方决定降级行为）。
 */
export function parseProjectFlowSection(value: string | undefined | null): ProjectFlowSection | null {
  if (!value) return null;
  if (FLOW_SECTION_IDS.has(value)) return value as ProjectFlowSection;
  return LEGACY_SECTION_ALIAS[value] ?? null;
}

/** 解析中心与剧本结构使用独立 URL；旧 script 链接默认进入解析中心。 */
export function parseProjectWorkspaceSection(value: string | undefined | null): ProjectWorkspaceSection | null {
  if (value === 'script-parse' || value === 'script-structure') return value;
  return parseProjectFlowSection(value);
}

export function scriptWorkspacePanel(value: string | undefined | null): ScriptWorkspacePanel {
  return value === 'script-structure' ? 'structure' : 'parse';
}

/** 两个剧本子页共享动画 key，避免切换时卸载整个工作区并丢失修复上下文。 */
export function projectWorkspaceMotionSection(value: string | undefined | null): string {
  return value === 'script-parse' || value === 'script-structure' ? 'script' : value ?? '';
}
