/**
 * 3D 导演台 · 深度图导出（S6 · 空间关系参考）
 *
 * 当前机位渲染深度通道为灰度 PNG（近亮远暗），用途：分镜空间关系参考——
 * 白模深度由真实几何算出，比 AI 估算准，且本地渲染零 API 成本。
 *
 * 实现口径：
 * - scene.overrideMaterial = 线性视深 ShaderMaterial（近亮远暗）：片元取
 *   视空间深度 -mvPosition.z，按 DEPTH_FAR 归一后 1-d 输出灰度。
 *   不能用 MeshDepthMaterial——BasicDepthPacking 输出的是非线性窗口深度
 *   （精度全挤在近裁剪面附近，1m 外全被压成纯黑，灰度梯度不可用）；
 * - DEPTH_FAR 30m：20m 内的场景内容占满灰度区间，30m 外一律纯黑=「远」；
 * - 渲染期间临时摘掉 scene.fog（雾会污染深度色）并把背景涂纯黑
 *   （背景不是网格、不吃 overrideMaterial，天空色会被读成「近」）；
 * - 复用 captureShot 的 beginShotRender（藏 dsHelper / 切分辨率 / 同帧取图）。
 */
import { Color, ShaderMaterial } from "three";

import { directorRuntime } from "../runtime";
import { useDirectorStore } from "../store";
import { ASPECT_RATIO_VALUE, isCameraObject } from "../types";
import {
  EXPORT_RESOLUTION,
  beginShotRender,
  buildShotCamera,
  downloadBlob,
  timestamp,
  type RenderedCameraShot,
} from "./captureShot";
import { canvasThumbDataUrl } from "./thumb";

/** 深度渲染的远裁剪面（米）：超出即纯黑，拉开近景灰度梯度 */
const DEPTH_FAR = 30;

/** 线性视深材质：近亮（白）远暗（黑），按 uFar 归一 */
function createDepthMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uFar: { value: DEPTH_FAR } },
    vertexShader: /* glsl */ `
      varying float vViewZ;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewZ = -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uFar;
      varying float vViewZ;
      void main() {
        float d = clamp(vViewZ / uFar, 0.0, 1.0);
        gl_FragColor = vec4(vec3(1.0 - d), 1.0);
      }
    `,
  });
}

export interface RenderedDepthMap extends RenderedCameraShot {
  /** 192px JPEG dataURL（参考清单条目缩略图；失败为 null） */
  thumbUrl: string | null;
}

export async function renderDepthMap(cameraId?: string): Promise<RenderedDepthMap | null> {
  const context = directorRuntime.getContext();
  if (!context) {
    console.warn("[director] renderDepthMap：渲染运行时未就绪（StageCanvas 未挂载）");
    return null;
  }

  const state = useDirectorStore.getState();
  const id = cameraId ?? state.activeCameraId;
  const object = id ? state.objects[id] : undefined;
  if (!object || !isCameraObject(object)) {
    console.warn(`[director] renderDepthMap：机位无效（id=${id ?? "null"}）`);
    return null;
  }

  const { width, height } = EXPORT_RESOLUTION[state.aspect];
  const shot = buildShotCamera(object, ASPECT_RATIO_VALUE[state.aspect], 0.1, DEPTH_FAR);

  const { gl, scene } = context;
  const restore = beginShotRender(gl, scene, width, height);
  // 深度渲染环境隔离：overrideMaterial 全场深度化；雾与背景摘为纯黑（=无穷远）
  const depthMaterial = createDepthMaterial();
  const previousFog = scene.fog;
  const previousBackground = scene.background;
  scene.overrideMaterial = depthMaterial;
  scene.fog = null;
  scene.background = new Color(0x000000);

  gl.render(scene, shot);
  // 同帧同步渲染后立即取图/取缩略图，随后的恢复不影响产物
  const blobPromise = new Promise<Blob | null>((resolve) =>
    gl.domElement.toBlob(resolve, "image/png"),
  );
  const thumbUrl = canvasThumbDataUrl(gl.domElement);

  scene.overrideMaterial = null;
  scene.fog = previousFog;
  scene.background = previousBackground;
  depthMaterial.dispose();
  restore();

  const blob = await blobPromise;
  if (!blob) {
    console.warn("[director] renderDepthMap：toBlob 失败");
    return null;
  }
  return {
    blob,
    thumbUrl,
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

/** 渲染 + 触发浏览器下载；返回缩略图（归参考清单用），失败返回 null */
export async function exportDepthMap(cameraId?: string): Promise<{ thumbUrl: string | null } | null> {
  const depth = await renderDepthMap(cameraId);
  if (!depth) return null;
  downloadBlob(depth.blob, `导演台-${depth.meta.cameraName}-深度图-${timestamp()}.png`);
  return { thumbUrl: depth.thumbUrl };
}
