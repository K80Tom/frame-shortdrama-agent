/* ============================================================
   env-presets.ts — 3D 导演台 · 光影环境预置（S8-7 扩充）
   原 ENV_PRESETS 自 StageCanvas.tsx 抽出：预置数据与菜单清单一处维护，
   StageCanvas(渲染消费)与 TopBar(菜单 UI)共同 import,禁止两处各写一份。

   每个预置 = 环境光(hemi)+ 主光(key)+ 色调(曝光/雾/地面色)组合,
   参数逐项对齐原型 ENV_PRESETS 结构;新八档面向短剧常用光线场景。
   菜单分「室内 / 室外 / 风格化」三组,组内常用置顶(棚拍亮调默认第一)。
   ============================================================ */

import type { EnvironmentName, Vec3 } from "./types";

export interface EnvLight {
  color: string;
  intensity: number;
  position: Vec3;
}

export interface EnvPreset {
  /** 雾 near/far（颜色跟随 scene.skyColor）；null = 无雾 */
  fog: { near: number; far: number } | null;
  /** 色调映射曝光（renderer.toneMappingExposure） */
  exposure: number;
  key: EnvLight;
  fill: EnvLight;
  rim: EnvLight;
  hemi: { sky: string; ground: string; intensity: number };
  /** 地面材质色 */
  floor: string;
}

export const ENV_PRESETS: Record<EnvironmentName, EnvPreset> = {
  /* ── 室内 ── */
  studio: {
    fog: null,
    exposure: 1.0,
    key: { color: "#FFFFFF", intensity: 2.4, position: [4, 6, 3] },
    fill: { color: "#DFE8FF", intensity: 0.7, position: [-5, 3, 2.5] },
    rim: { color: "#FFF0DD", intensity: 1.3, position: [-2, 5, -5.5] },
    hemi: { sky: "#BFD0E0", ground: "#3A3A40", intensity: 0.55 },
    floor: "#3B3E45",
  },
  indoor_warm: {
    fog: null,
    exposure: 1.0,
    key: { color: "#FFD9A8", intensity: 2.0, position: [3, 4, 2] },
    fill: { color: "#B0A090", intensity: 0.5, position: [-4, 2.5, 2] },
    rim: { color: "#FFE8C8", intensity: 0.9, position: [-2, 4, -4] },
    hemi: { sky: "#C8B49A", ground: "#2E2620", intensity: 0.5 },
    floor: "#3A322B",
  },
  night_cold: {
    fog: { near: 16, far: 50 },
    exposure: 0.85,
    key: { color: "#9FB8E8", intensity: 1.2, position: [-3, 5, 2] },
    fill: { color: "#3A4A6A", intensity: 0.35, position: [4, 2, 3] },
    rim: { color: "#C9D9FF", intensity: 0.8, position: [2, 4.5, -5] },
    hemi: { sky: "#4A5A78", ground: "#14161C", intensity: 0.35 },
    floor: "#23262E",
  },
  candlelight: {
    fog: { near: 12, far: 40 },
    exposure: 0.8,
    key: { color: "#FFB45E", intensity: 1.6, position: [1.5, 1.8, 1.2] },
    fill: { color: "#5A3A28", intensity: 0.25, position: [-3, 1.5, 2] },
    rim: { color: "#FFDCA0", intensity: 0.6, position: [-1.5, 3, -3] },
    hemi: { sky: "#4A3626", ground: "#17100C", intensity: 0.3 },
    floor: "#2A201A",
  },
  /* ── 室外 ── */
  day_clear: {
    fog: { near: 20, far: 70 },
    exposure: 1.05,
    key: { color: "#FFF3E0", intensity: 3.0, position: [6, 8, 4] },
    fill: { color: "#C9DDF5", intensity: 0.8, position: [-6, 4, 3] },
    rim: { color: "#FFFFFF", intensity: 1.5, position: [-3, 6, -6] },
    hemi: { sky: "#A8C8E8", ground: "#4A5240", intensity: 0.7 },
    floor: "#4A4F45",
  },
  dusk: {
    fog: { near: 14, far: 46 },
    exposure: 0.95,
    key: { color: "#FFAB6E", intensity: 2.3, position: [-6, 3.2, -2] },
    fill: { color: "#6F87B8", intensity: 0.4, position: [5, 2.2, 3] },
    rim: { color: "#FFD9A0", intensity: 1.2, position: [3, 4, -6] },
    hemi: { sky: "#8A7A6A", ground: "#241F1C", intensity: 0.4 },
    floor: "#322B26",
  },
  overcast_soft: {
    fog: { near: 15, far: 55 },
    exposure: 0.95,
    key: { color: "#DDE4EA", intensity: 1.4, position: [2, 7, 3] },
    fill: { color: "#C4CCD4", intensity: 0.9, position: [-4, 3, 2] },
    rim: { color: "#E8ECF0", intensity: 0.5, position: [-2, 5, -5] },
    hemi: { sky: "#B8C0C8", ground: "#3A3E42", intensity: 0.8 },
    floor: "#3E4248",
  },
  moonlight: {
    fog: { near: 14, far: 48 },
    exposure: 0.8,
    key: { color: "#B8CCF0", intensity: 1.1, position: [-5, 7, -3] },
    fill: { color: "#2E3A52", intensity: 0.3, position: [4, 2, 3] },
    rim: { color: "#D8E4FF", intensity: 0.9, position: [3, 5, -6] },
    hemi: { sky: "#2A3450", ground: "#0E1016", intensity: 0.3 },
    floor: "#1E222A",
  },
  /* ── 风格化 ── */
  backlit_silhouette: {
    fog: { near: 12, far: 44 },
    exposure: 0.9,
    key: { color: "#FFE0B0", intensity: 0.5, position: [0, 3, 4] },
    fill: { color: "#6A6A7A", intensity: 0.2, position: [-3, 2, 3] },
    rim: { color: "#FFEFD0", intensity: 3.2, position: [0, 4.5, -6.5] },
    hemi: { sky: "#8A8578", ground: "#1C1A18", intensity: 0.35 },
    floor: "#2B2825",
  },
  neon_night: {
    fog: { near: 13, far: 46 },
    exposure: 0.9,
    key: { color: "#FF4FA3", intensity: 1.8, position: [3, 3.5, 2] },
    fill: { color: "#2EC9E8", intensity: 1.0, position: [-4, 2.5, 2.5] },
    rim: { color: "#8A5FFF", intensity: 1.2, position: [-2, 4.5, -5] },
    hemi: { sky: "#3A2A52", ground: "#12101A", intensity: 0.4 },
    floor: "#241F2E",
  },
};

/** 预置中文名（菜单/帮助唯一来源） */
export const ENV_PRESET_LABELS: Record<EnvironmentName, string> = {
  studio: "棚拍亮调",
  indoor_warm: "室内暖光",
  night_cold: "夜戏冷调",
  candlelight: "烛光",
  day_clear: "日外景晴",
  dusk: "黄昏暖调",
  overcast_soft: "阴天柔光",
  moonlight: "月夜",
  backlit_silhouette: "逆光剪影",
  neon_night: "霓虹夜景",
};

export type EnvPresetGroupKey = "indoor" | "outdoor" | "stylized";

export interface EnvPresetMenuGroup {
  key: EnvPresetGroupKey;
  label: string;
  items: ReadonlyArray<{ value: EnvironmentName; label: string }>;
}

/**
 * 菜单分组清单（TopBar 环境菜单消费）：室内 / 室外 / 风格化三组,
 * 组内常用置顶——棚拍亮调是默认预置排第一,其余按短剧使用频率。
 */
export const ENV_PRESET_MENU: readonly EnvPresetMenuGroup[] = [
  {
    key: "indoor",
    label: "室内",
    items: [
      { value: "studio", label: ENV_PRESET_LABELS.studio },
      { value: "indoor_warm", label: ENV_PRESET_LABELS.indoor_warm },
      { value: "night_cold", label: ENV_PRESET_LABELS.night_cold },
      { value: "candlelight", label: ENV_PRESET_LABELS.candlelight },
    ],
  },
  {
    key: "outdoor",
    label: "室外",
    items: [
      { value: "day_clear", label: ENV_PRESET_LABELS.day_clear },
      { value: "dusk", label: ENV_PRESET_LABELS.dusk },
      { value: "overcast_soft", label: ENV_PRESET_LABELS.overcast_soft },
      { value: "moonlight", label: ENV_PRESET_LABELS.moonlight },
    ],
  },
  {
    key: "stylized",
    label: "风格化",
    items: [
      { value: "backlit_silhouette", label: ENV_PRESET_LABELS.backlit_silhouette },
      { value: "neon_night", label: ENV_PRESET_LABELS.neon_night },
    ],
  },
];
