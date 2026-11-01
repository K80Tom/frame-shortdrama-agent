/**
 * 3D 导演台 · 机位视角控制器（Wave 2 · 相机模块）
 *
 * 职责：viewMode === "camera" 且 activeCameraId 有效时，把默认渲染相机切换成
 * 活动机位的 WYSIWYG 相机；切回导演视角时 drei makeDefault 自动恢复原漫游相机，
 * OrbitControls 同步恢复（恢复依赖 drei 的默认相机存取机制，本组件不写 store）。
 *
 * 实现要点：
 * - drei <PerspectiveCamera makeDefault manual>：
 *   makeDefault 挂载时替换 state.camera、卸载时还原；manual 阻止 drei/R3F
 *   按画布尺寸自动写投影（本组件自己在 useLayoutEffect 里写 aspect/FOV，
 *   写错时机会与 FrameOverlays 遮幅错位）。
 * - 画幅值：auto 档跟随视口实际宽高比（useThree size 响应式，窗口变化即更新，
 *   与 FrameOverlays 的全视口无遮幅行为一致）；其余档取 ASPECT_RATIO_VALUE 契约数值。
 * - 不变形关键（B5 修复）：相机 aspect 始终跟随画布，FOV 经 cameraViewFov 按画幅
 *   等效放大——直接把相机 aspect 设成画幅值会把画面拉伸（投影比 ≠ 画布比）；
 *   过扫描方案下遮幅区域与真实机位完全一致（遮幅外是余量，不进入导出）。
 * - position/target/focalLength/画幅值 → 相机参数在 useLayoutEffect 里统一设置并
 *   updateProjectionMatrix（near/far 取原型 cam3 的 0.1/200；FOV 用原型 focalToVfov，
 *   与 StageCamera 视锥、导出截图同一公式）。
 * - OrbitControls 禁用：经 useThree(s => s.controls) 拿到 makeDefault 控制器实例
 *   置 enabled=false。drei OrbitControls 会在默认相机切换后重建实例并回写
 *   state.controls，故副作用以 controls 实例为依赖，切走/卸载时兜底 enabled=true。
 *
 * 挂载方式：作为 <Canvas> 的子节点（StageCanvas 内），无视觉输出。
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import type { PerspectiveCamera as ThreePerspectiveCamera } from "three";

import { useDirectorStore } from "../store";
import { ASPECT_RATIO_VALUE, isCameraObject } from "../types";
import { cameraViewFov } from "./camera-view-fov";
import { focalToVfov } from "./StageCamera";

/* 原型 cam3 的裁剪参数（index.html ~L964） */
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 200;

export function CameraViewController() {
  // 仅在机位视角且活动机位有效时返回机位对象，其余情况为 null（不接管默认相机）
  const camera = useDirectorStore((state) => {
    if (state.viewMode !== "camera" || !state.activeCameraId) return null;
    const object = state.objects[state.activeCameraId];
    return object && isCameraObject(object) ? object : null;
  });
  const aspect = useDirectorStore((state) => state.aspect);
  const size = useThree((state) => state.size);
  const controls = useThree((state) => state.controls) as unknown as {
    enabled: boolean;
  } | null;
  const cameraRef = useRef<ThreePerspectiveCamera | null>(null);

  // 画布宽高比（size 响应式：页签切换/全屏切换/窗口变化都会变）
  const canvasAspect = size.width / Math.max(1, size.height);
  // 画幅宽高比：auto 档跟随画布；其余档取契约数值
  const frameAspect = aspect === "auto" ? canvasAspect : ASPECT_RATIO_VALUE[aspect];

  // 机位视角下禁用 OrbitControls（禁止环绕破坏构图）；切回导演视角/卸载时恢复
  useEffect(() => {
    if (!controls) return;
    controls.enabled = !camera;
    return () => {
      controls.enabled = true;
    };
  }, [controls, camera]);

  // 机位对象 → 默认相机参数（store 角度/米制原样使用；朝向由 position→target 推导）。
  // aspect 永远跟画布（不拉伸），FOV 按画幅等效（cameraViewFov 过扫描换算）——
  // 画布尺寸变化（全屏/页签切换）时 canvasAspect 驱动本副作用重跑，投影随视口同步
  useLayoutEffect(() => {
    const cam = cameraRef.current;
    if (!cam || !camera) return;
    const [px, py, pz] = camera.transform.position;
    cam.position.set(px, py, pz);
    cam.up.set(0, 1, 0);
    cam.lookAt(camera.target[0], camera.target[1], camera.target[2]);
    cam.fov = cameraViewFov(focalToVfov(camera.focalLength, frameAspect), frameAspect, canvasAspect);
    cam.aspect = canvasAspect;
    cam.near = CAMERA_NEAR;
    cam.far = CAMERA_FAR;
    cam.updateProjectionMatrix();
  }, [camera, frameAspect, canvasAspect]);

  if (!camera) return null;
  return <PerspectiveCamera ref={cameraRef} makeDefault manual />;
}
