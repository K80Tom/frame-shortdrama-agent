/**
 * 项目正式工作区段（#182）的唯一事实来源。
 * 阶段 1 与 navigation.ts 的 legacy ProjectSection 并存：旧 hash 经 LEGACY_SECTION_ALIAS
 * 归一到主链区段，不出现 404；App.tsx 的接线由 TL 在集成 worktree 完成。
 */
export type ProjectFlowSection = 'overview' | 'script' | 'assets' | 'storyboard' | 'canvas' | 'production';

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
};

const FLOW_SECTION_IDS = new Set<string>(PROJECT_FLOW_SECTIONS.map(item => item.id));

export function projectFlowHash(projectId: string, section: ProjectFlowSection): string {
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
