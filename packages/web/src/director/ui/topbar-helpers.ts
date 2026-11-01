/**
 * 3D 导演台 · TopBar 纯逻辑（S8 · 不 import React/CSS，node:test 直接 import）
 *
 * - groupTemplatesByCategory：模版菜单按 category 分组（P1-8），组名中文、常用组置顶；
 * - TEMPLATE_CATEGORY_LABELS：后端 TEMPLATE_CATEGORIES（dialogue/confrontation/emotion/
 *   movement/action/establishing）→ 中文组名，未知类目归「其他」；
 * - DIRECTOR_SHORTCUTS：帮助浮层（P1-9）快捷键清单——与 StageCanvas useDirectorHotkeys
 *   的实际绑定是同一份契约（G/R/S、Ctrl+C/V/Z、Delete、F、Esc），逐字一致，改动需同步。
 */

/** 模版类目 → 中文组名（后端枚举值见 src/modules/director/templates/types.ts） */
export const TEMPLATE_CATEGORY_LABELS: Record<string, string> = {
  dialogue: "对话",
  action: "打戏",
  confrontation: "对峙",
  emotion: "情绪",
  establishing: "开场",
  movement: "运动",
};

/**
 * 组排序（常用组置顶）：暂无用量数据，按短剧场景合理频率定序——
 * 对话戏最多，对峙/情绪其次，打戏/开场/运动殿后；「其他」永远排最后。
 */
const TEMPLATE_CATEGORY_ORDER: readonly string[] = [
  "dialogue",
  "confrontation",
  "emotion",
  "action",
  "establishing",
  "movement",
];

export interface TemplateCategoryGroup<T> {
  /** 已知类目枚举值；未知类目统一 "other" */
  key: string;
  label: string;
  items: T[];
}

/** 模版按 category 分组：已知类目按 TEMPLATE_CATEGORY_ORDER 排序，未知归「其他」殿后。 */
export function groupTemplatesByCategory<T extends { category: string }>(
  templates: readonly T[],
): TemplateCategoryGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const template of templates) {
    const key = TEMPLATE_CATEGORY_LABELS[template.category] !== undefined ? template.category : "other";
    const list = buckets.get(key) ?? [];
    list.push(template);
    buckets.set(key, list);
  }
  const groups: TemplateCategoryGroup<T>[] = [];
  for (const key of TEMPLATE_CATEGORY_ORDER) {
    const items = buckets.get(key);
    if (items?.length) groups.push({ key, label: TEMPLATE_CATEGORY_LABELS[key]!, items });
  }
  const others = buckets.get("other");
  if (others?.length) groups.push({ key: "other", label: "其他", items: others });
  return groups;
}

/**
 * 帮助浮层快捷键清单（与快捷键实现的契约，逐字一致）：
 * G 平移 / R 旋转 / S 缩放 / Ctrl+C 复制 / Ctrl+V 粘贴 / Ctrl+Z 撤销 /
 * Delete 删除 / F 聚焦 / Esc 取消选中。
 */
export const DIRECTOR_SHORTCUTS: readonly { keys: string; action: string }[] = [
  { keys: "G", action: "平移" },
  { keys: "R", action: "旋转" },
  { keys: "S", action: "缩放" },
  { keys: "Ctrl+C", action: "复制" },
  { keys: "Ctrl+V", action: "粘贴" },
  { keys: "Delete", action: "删除" },
  { keys: "F", action: "聚焦" },
  { keys: "Esc", action: "取消选中" },
];
