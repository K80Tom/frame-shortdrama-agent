/**
 * 3D 导演台 · 分镜宫格导出（Wave 2 · 纯 TS，不 import React）
 *
 * exportCameraGrid()：把 store.order 里全部机位按清单顺序各渲一帧，
 * 拼成 2 列宫格 PNG 并触发下载。renderCameraGrid()：同一渲染路径只产 Blob 不下载，
 * 供「保存并归组」管线入资产库（saveCapture.ts，P0 衔接流）。流程（对齐 HTML 原型 exportGrid）：
 * 1. directorRuntime 取 {gl, scene}（未就绪 / 无机位 → console.warn 安静失败）
 * 2. 单格尺寸 gridCellSize(画幅值)：按当前画幅等比缩到长边 1000px（7 档通用，
 *    auto 取 ASPECT_RATIO_VALUE 回退 16/9；相机 aspect 取格比，与原型一致）
 * 3. 每台机位构建离屏 PerspectiveCamera（垂直 FOV = focalToVfov(focalLength, 格比)，
 *    统一用 scene/StageCamera 的画幅感知公式；position = 机位位置、lookAt(注视点)），
 *    gl.setSize(单格) 渲一帧 drawImage 进 2D 画布
 * 4. 每格左上角绘「序号 · 机位名」深色圆角角标白字（序号两位补零）
 * 5. helper（userData.dsHelper）整轮只隐藏/恢复一次；恢复 gl 尺寸与像素比
 * 6. 画布 toBlob 下载，文件名 `导演台-分镜宫格-YYYYMMDD-HHmm.png`
 */
import { PerspectiveCamera, Vector2, Vector3 } from "three";
import type { Object3D } from "three";

import { directorRuntime } from "../runtime";
import { useDirectorStore } from "../store";
import { ASPECT_RATIO_VALUE, isCameraObject } from "../types";
import type { CameraObject } from "../types";
import { focalToVfov } from "../scene/StageCamera";

/** 宫格列数（产品规格：固定 2 列） */
const GRID_COLS = 2;
/** 宫格四边与格间留白（px） */
const PAD = 12;
/** 宫格底色 */
const BG_COLOR = "#0A0A0C";
/** 单格长边（px）：按画幅等比缩放，长边恒为 1000 */
const CELL_LONG_EDGE = 1000;

/**
 * 宫格单格尺寸：按画幅宽高比等比缩到长边 CELL_LONG_EDGE（7 档通用）。
 * tests/director-aspect.test.ts 对本函数做断言，改动需同步。
 */
export function gridCellSize(aspectValue: number): { width: number; height: number } {
  if (aspectValue >= 1) {
    return { width: CELL_LONG_EDGE, height: Math.round(CELL_LONG_EDGE / aspectValue) };
  }
  return { width: Math.round(CELL_LONG_EDGE * aspectValue), height: CELL_LONG_EDGE };
}

function hideHelpers(scene: Object3D): Object3D[] {
  const hidden: Object3D[] = [];
  scene.traverse((node) => {
    if (node.userData?.dsHelper === true && node.visible) {
      node.visible = false;
      hidden.push(node);
    }
  });
  return hidden;
}

function buildShotCamera(camera: CameraObject, aspect: number): PerspectiveCamera {
  const shot = new PerspectiveCamera(focalToVfov(camera.focalLength, aspect), aspect, 0.1, 200);
  shot.position.set(...camera.transform.position);
  shot.up.set(0, 1, 0);
  shot.lookAt(new Vector3(...camera.target));
  shot.updateProjectionMatrix();
  return shot;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 单格左上角角标：「01 · 机位名」，深色圆角底 + 白字 */
function drawBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  index: number,
  name: string,
): void {
  const label = `${String(index + 1).padStart(2, "0")} · ${name}`;
  ctx.font = '600 22px -apple-system, "PingFang SC", sans-serif';
  const textWidth = ctx.measureText(label).width;
  ctx.beginPath();
  ctx.roundRect(x + 12, y + 12, textWidth + 28, 36, 8);
  ctx.fillStyle = "rgba(10,10,12,0.75)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#F2F3F5";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + 26, y + 31);
}

/** 宫格渲染产物（P0 衔接流：入资产库走 saveBlobToLibrary，下载走 exportCameraGrid） */
export interface RenderedCameraGrid {
  blob: Blob;
  cameraCount: number;
}

/**
 * 渲染分镜宫格 PNG（不触发下载）：全部机位按清单顺序各渲一帧拼 2 列宫格。
 * 运行时未就绪 / 无机位 / 取图失败 → console.warn 安静失败返回 null。
 */
export async function renderCameraGrid(): Promise<RenderedCameraGrid | null> {
  const context = directorRuntime.getContext();
  if (!context) {
    console.warn("[director] renderCameraGrid：渲染运行时未就绪（StageCanvas 未挂载）");
    return null;
  }

  const state = useDirectorStore.getState();
  const cameras: CameraObject[] = [];
  for (const id of state.order) {
    const object = state.objects[id];
    if (object && isCameraObject(object)) cameras.push(object);
  }
  if (cameras.length === 0) {
    console.warn("[director] renderCameraGrid：没有可导出的机位");
    return null;
  }

  const { width: cellWidth, height: cellHeight } = gridCellSize(ASPECT_RATIO_VALUE[state.aspect]);
  const rows = Math.ceil(cameras.length / GRID_COLS);

  const canvas = document.createElement("canvas");
  canvas.width = GRID_COLS * cellWidth + (GRID_COLS + 1) * PAD;
  canvas.height = rows * cellHeight + (rows + 1) * PAD;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    console.warn("[director] renderCameraGrid：无法创建 2D 画布");
    return null;
  }
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const { gl, scene } = context;
  const previousSize = gl.getSize(new Vector2());
  const previousPixelRatio = gl.getPixelRatio();
  const hidden = hideHelpers(scene);

  gl.setPixelRatio(1);
  gl.setScissorTest(false);
  cameras.forEach((camera, index) => {
    const x = PAD + (index % GRID_COLS) * (cellWidth + PAD);
    const y = PAD + Math.floor(index / GRID_COLS) * (cellHeight + PAD);
    const shot = buildShotCamera(camera, cellWidth / cellHeight);
    gl.setSize(cellWidth, cellHeight, false);
    gl.render(scene, shot);
    // 同步渲染后立即使画布位图入格，再进入下一台机位
    ctx.drawImage(gl.domElement, x, y);
    drawBadge(ctx, x, y, index, camera.name);
  });

  gl.setPixelRatio(previousPixelRatio);
  // updateStyle=false：导出全程不碰 canvas CSS，样式始终归 R3F 管
  gl.setSize(previousSize.x, previousSize.y, false);
  for (const node of hidden) node.visible = true;

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) {
    console.warn("[director] renderCameraGrid：toBlob 失败");
    return null;
  }
  return { blob, cameraCount: cameras.length };
}

/** 渲染 + 触发浏览器下载（「下载到本地」次要路径；主路径=renderCameraGrid + 入资产库） */
export async function exportCameraGrid(): Promise<void> {
  const grid = await renderCameraGrid();
  if (!grid) return;
  downloadBlob(grid.blob, `导演台-分镜宫格-${timestamp()}.png`);
}
