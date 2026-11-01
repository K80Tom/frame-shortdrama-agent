/**
 * 3D 导演台 · 单机位截图导出（Wave 2 · 纯 TS，不 import React）
 *
 * renderCameraShot(cameraId?)：用指定机位（缺省活动机位）离屏渲一帧 PNG，
 * 返回 { blob, meta }（meta 带机位名/画幅/焦距/环境/分辨率，供保存到资产库时透传）。
 * exportCameraShot(cameraId?)：renderCameraShot + 触发浏览器下载（原 Wave 2 行为不变）。
 * renderCameraPreview(camera, {aspectValue, width?})：同一离屏路径渲一帧小图，
 * 同步返回 PNG dataURL——PropertyPanel 机位预览缩略图用（LibTV §6.3）。
 *
 * 渲染流程（对齐 HTML 原型 exportShot，helper 隐藏改走 userData.dsHelper 约定）：
 * 1. directorRuntime 取 {gl, scene}（未就绪 → console.warn 安静失败返回 null）
 * 2. store 取机位对象与画幅；分辨率查 EXPORT_RESOLUTION（7 档，auto 按 16:9）
 * 3. 离屏 PerspectiveCamera：垂直 FOV = focalToVfov(focalLength, aspect)
 *    （统一用 scene/StageCamera 的画幅感知公式，与视锥/机位视角三方一致）、
 *    aspect = 画幅值、position = 机位位置、lookAt(注视点)
 * 4. 遍历 scene 临时隐藏 userData.dsHelper 辅助对象（相机机身/视锥/网格/gizmo）
 * 5. gl.setPixelRatio(1) + gl.setSize(目标分辨率) → gl.render → 同帧立即 toBlob/toDataURL
 * 6. 恢复尺寸 / 像素比 / helper 可见性
 * 下载文件名 `导演台-{机位名}-YYYYMMDD-HHmm.png`
 */
import { PerspectiveCamera, Vector2, Vector3 } from "three";
import type { Object3D, Scene, WebGLRenderer } from "three";

import { directorRuntime } from "../runtime";
import { useDirectorStore } from "../store";
import { ASPECT_RATIO_VALUE, isCameraObject } from "../types";
import type { AspectRatio, CameraObject } from "../types";
import { focalToVfov } from "../scene/StageCamera";

/**
 * 7 档画幅 → 导出分辨率（产品规格冻结值；auto 按 16:9 处理，与 types.ts 注释一致）。
 * tests/director-aspect.test.ts 对本表做断言，改动需同步。
 */
export const EXPORT_RESOLUTION: Record<AspectRatio, { width: number; height: number }> = {
  auto: { width: 1920, height: 1080 },
  "21:9": { width: 1920, height: 824 },
  "16:9": { width: 1920, height: 1080 },
  "4:3": { width: 1600, height: 1200 },
  "1:1": { width: 1080, height: 1080 },
  "3:4": { width: 1200, height: 1600 },
  "9:16": { width: 1080, height: 1920 },
};

/** 机位预览缩略图渲染宽度（px；高度 = width / aspectValue） */
const PREVIEW_WIDTH = 300;

export type RenderedCameraShot = {
  blob: Blob;
  meta: {
    cameraName: string;
    aspect: string;
    focalLength: number;
    environment: string;
    width: number;
    height: number;
  };
};

/** 隐藏场景中全部 userData.dsHelper 辅助可视对象，返回被隐藏者以便恢复 */
export function hideHelpers(scene: Object3D): Object3D[] {
  const hidden: Object3D[] = [];
  scene.traverse((node) => {
    if (node.userData?.dsHelper === true && node.visible) {
      node.visible = false;
      hidden.push(node);
    }
  });
  return hidden;
}

/** 离屏渲染用的机位相机（S6 起支持自定义 near/far：深度图需要收紧 far 拉开灰度梯度） */
export function buildShotCamera(
  camera: CameraObject,
  aspect: number,
  near = 0.1,
  far = 200,
): PerspectiveCamera {
  const shot = new PerspectiveCamera(focalToVfov(camera.focalLength, aspect), aspect, near, far);
  shot.position.set(...camera.transform.position);
  shot.up.set(0, 1, 0);
  shot.lookAt(new Vector3(...camera.target));
  shot.updateProjectionMatrix();
  return shot;
}

/**
 * 离屏渲帧准备：隐藏 dsHelper、pixelRatio 置 1、画布切到目标分辨率。
 * 返回 restore()：渲染+取图（同帧）完成后调用，恢复尺寸/像素比/helper 可见性。
 * updateStyle=false：导出全程不碰 canvas CSS，样式始终归 R3F 管。
 */
export function beginShotRender(gl: WebGLRenderer, scene: Scene, width: number, height: number): () => void {
  const previousSize = gl.getSize(new Vector2());
  const previousPixelRatio = gl.getPixelRatio();
  const hidden = hideHelpers(scene);

  gl.setPixelRatio(1);
  gl.setSize(width, height, false);
  gl.setScissorTest(false);

  return () => {
    gl.setPixelRatio(previousPixelRatio);
    gl.setSize(previousSize.x, previousSize.y, false);
    for (const node of hidden) node.visible = true;
  };
}

export function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Keep the URL alive until the browser has started reading the download.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function renderCameraShot(cameraId?: string): Promise<RenderedCameraShot | null> {
  const context = directorRuntime.getContext();
  if (!context) {
    console.warn("[director] renderCameraShot：渲染运行时未就绪（StageCanvas 未挂载）");
    return null;
  }

  const state = useDirectorStore.getState();
  const id = cameraId ?? state.activeCameraId;
  const object = id ? state.objects[id] : undefined;
  if (!object || !isCameraObject(object)) {
    console.warn(`[director] renderCameraShot：机位无效（id=${id ?? "null"}）`);
    return null;
  }

  const { width, height } = EXPORT_RESOLUTION[state.aspect];
  const shot = buildShotCamera(object, ASPECT_RATIO_VALUE[state.aspect]);

  const { gl, scene } = context;
  const restore = beginShotRender(gl, scene, width, height);
  gl.render(scene, shot);
  // 同帧同步渲染后立即取图：toBlob 调用瞬间快照位图，随后的恢复不影响产物
  const blobPromise = new Promise<Blob | null>((resolve) =>
    gl.domElement.toBlob(resolve, "image/png"),
  );
  restore();

  const blob = await blobPromise;
  if (!blob) {
    console.warn("[director] renderCameraShot：toBlob 失败");
    return null;
  }
  return {
    blob,
    meta: {
      cameraName: object.name,
      aspect: state.aspect,
      focalLength: object.focalLength,
      environment: state.environment,
      width,
      height,
    },
  };
}

/**
 * 机位预览缩略图（LibTV §6.3）：同一离屏路径渲一帧小图，同步返回 PNG dataURL。
 * 纯同步（toDataURL 同帧快照）；未就绪 / toDataURL 失败 → console.warn + null，不抛错。
 * 调用方（PropertyPanel）负责节流：仅在机位参数/画幅变化或手动刷新时调用。
 */
export function renderCameraPreview(
  camera: CameraObject,
  options: { aspectValue: number; width?: number },
): string | null {
  const context = directorRuntime.getContext();
  if (!context) {
    console.warn("[director] renderCameraPreview：渲染运行时未就绪（StageCanvas 未挂载）");
    return null;
  }

  const width = options.width ?? PREVIEW_WIDTH;
  const height = Math.max(1, Math.round(width / options.aspectValue));
  const shot = buildShotCamera(camera, options.aspectValue);

  const { gl, scene } = context;
  const restore = beginShotRender(gl, scene, width, height);
  try {
    gl.render(scene, shot);
    // 同帧同步渲染后立即取图：toDataURL 同步快照位图，随后的恢复不影响产物
    return gl.domElement.toDataURL("image/png");
  } catch (error: unknown) {
    console.warn("[director] renderCameraPreview：toDataURL 失败", error);
    return null;
  } finally {
    restore();
  }
}

export async function exportCameraShot(cameraId?: string): Promise<void> {
  const shot = await renderCameraShot(cameraId);
  if (!shot) return;
  downloadBlob(shot.blob, `导演台-${shot.meta.cameraName}-${timestamp()}.png`);
}
