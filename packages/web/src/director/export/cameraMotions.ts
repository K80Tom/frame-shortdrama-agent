/**
 * 3D 导演台 · 运镜预设（S6 · 纯逻辑，不 import React/three，node 可测）
 *
 * 六个预设：推近 / 拉远 / 左摇 / 右摇 / 环绕 / 跟随（Fable S6 冻结口径）。
 * 每个预设由「当前机位 position/target」推导出运动终点，sampleMotion 用
 * smoothstep 缓动在起点→终点之间插值，输出某一时刻的 {position, target}。
 *
 * 语义约定：
 * - 推近 dolly-in：机位沿视线向注视点推进 40%（构图变紧，目标不变）；
 * - 拉远 dolly-out：机位沿视线反向后退 60%（构图变松）；
 * - 左摇 pan-left / 右摇 pan-right：机位不动，注视点绕机位水平转 ±25°
 *   （+角=向左摇：视线绕 +Y 轴正转即背离右手侧，数学推导见单测）；
 * - 环绕 orbit：机位绕注视点水平环绕 180°（距离与高度不变）；
 * - 跟随 follow：注视点锁定选中对象（其落地中心 +1m 躯干高度），机位沿
 *   自身右手方向横移（距离 30%、最小 0.8m）——白模对象本身静止，跟随的
 *   表现是「镜头锁定主体横移跟拍」。
 *
 * 录制/预览逐帧驱动见 export/recordMotion.ts；本文件只做确定性数学。
 */
import type { CameraObject, SceneObject, Vec3 } from "../types";

export type MotionPresetId = "dolly-in" | "dolly-out" | "pan-left" | "pan-right" | "orbit" | "follow";

export interface MotionPreset {
  id: MotionPresetId;
  label: string;
  /** 一句话说明（菜单副行 / 悬停提示） */
  hint: string;
  /** 是否需要一个选中的非机位对象作为跟随目标 */
  needsFollowTarget: boolean;
}

export const MOTION_PRESETS: readonly MotionPreset[] = [
  { id: "dolly-in", label: "推近", hint: "沿视线向注视点推进", needsFollowTarget: false },
  { id: "dolly-out", label: "拉远", hint: "沿视线远离注视点后退", needsFollowTarget: false },
  { id: "pan-left", label: "左摇", hint: "机位不动，视线向左摇", needsFollowTarget: false },
  { id: "pan-right", label: "右摇", hint: "机位不动，视线向右摇", needsFollowTarget: false },
  { id: "orbit", label: "环绕", hint: "绕注视点环绕半周", needsFollowTarget: false },
  { id: "follow", label: "跟随", hint: "锁定选中对象，横向跟拍", needsFollowTarget: true },
];

/** 运镜时长档位（秒），Fable S6 冻结 */
export const MOTION_DURATIONS: readonly number[] = [3, 5, 8];

/* ── 运动参数（冻结值，改动需同步单测） ── */
const DOLLY_IN_RATIO = 0.4;
const DOLLY_OUT_RATIO = 0.6;
const PAN_ANGLE = (25 * Math.PI) / 180;
const ORBIT_ANGLE = Math.PI;
const FOLLOW_TRUCK_RATIO = 0.3;
const FOLLOW_TRUCK_MIN = 0.8;

export interface MotionPose {
  position: Vec3;
  target: Vec3;
}

/* ──────────────────────────── 向量工具（零依赖，不进 three） ──────────────────────────── */

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function normalize(a: Vec3, fallback: Vec3): Vec3 {
  const len = length(a);
  return len < 1e-6 ? fallback : scale(a, 1 / len);
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** 绕 +Y 轴（过 center）水平旋转 point；angle 弧度，正值=从上方看逆时针 */
function rotateAroundY(point: Vec3, center: Vec3, angle: number): Vec3 {
  const dx = point[0] - center[0];
  const dz = point[2] - center[2];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [center[0] + dx * cos + dz * sin, point[1], center[2] + dz * cos - dx * sin];
}

/** smoothstep 缓动：起步/落幅柔和，中段匀速（t ∈ [0,1]） */
export function motionEase(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
}

/** 跟随预设的注视点：对象落地中心 +1m（躯干高度，对齐机位默认 target [0,1,0] 约定） */
export function followAimFor(object: SceneObject): Vec3 {
  const [x, y, z] = object.transform.position;
  return [x, y + 1, z];
}

/**
 * 预设运动终点（起点恒为机位当前 position/target）。
 * follow 预设必须给 followAim（followAimFor 的产物），否则返回 null。
 */
export function motionEndPose(
  presetId: MotionPresetId,
  camera: CameraObject,
  followAim?: Vec3,
): MotionPose | null {
  const position = camera.transform.position;
  const target = camera.target;
  const viewDir = sub(target, position);

  switch (presetId) {
    case "dolly-in":
      return { position: add(position, scale(viewDir, DOLLY_IN_RATIO)), target: [...target] };
    case "dolly-out":
      return { position: sub(position, scale(viewDir, DOLLY_OUT_RATIO)), target: [...target] };
    case "pan-left":
      return { position: [...position], target: rotateAroundY(target, position, PAN_ANGLE) };
    case "pan-right":
      return { position: [...position], target: rotateAroundY(target, position, -PAN_ANGLE) };
    case "orbit":
      return { position: rotateAroundY(position, target, ORBIT_ANGLE), target: [...target] };
    case "follow": {
      if (!followAim) return null;
      // 横移方向 = 机位右手侧（forward × up = (-fz, 0, fx)，天然水平）；俯视退化时用 +X 兜底
      const forward = normalize(sub(followAim, position), [0, 0, -1]);
      const right = normalize([-forward[2], 0, forward[0]], [1, 0, 0]);
      const truck = Math.max(FOLLOW_TRUCK_MIN, length(sub(followAim, position)) * FOLLOW_TRUCK_RATIO);
      return { position: add(position, scale(right, truck)), target: [...followAim] };
    }
  }
}

/**
 * 采样 t 时刻的运动位姿（t ∈ [0,1]，内部 smoothstep 缓动）。
 * t=0 严格等于机位当前位姿；t=1 等于 motionEndPose。follow 缺 aim 返回 null。
 */
export function sampleMotion(
  presetId: MotionPresetId,
  camera: CameraObject,
  t: number,
  followAim?: Vec3,
): MotionPose | null {
  const end = motionEndPose(presetId, camera, followAim);
  if (!end) return null;
  const eased = motionEase(t);
  return {
    position: lerp(camera.transform.position, end.position, eased),
    target: lerp(camera.target, end.target, eased),
  };
}
