/**
 * 3D 导演台 · 运镜预览与 WebM 录制（S6）
 *
 * 能力：选运镜预设 + 时长（3/5/8 秒）→「预览」在视口播放机位运动 →
 * 「导出运镜视频」把回放录成 WebM（720p、白模原样、本地渲染零 API 成本）。
 *
 * 实现口径（监视画布覆盖法）：
 * 1. 接管主画布：beginShotRender 同款（藏 dsHelper / pixelRatio=1 / 画布切到
 *    录制分辨率，updateStyle=false 不碰 CSS）；
 * 2. 盖一层监视层（position:fixed，几何=画布父容器与视口的可见交集，黑底）：
 *    内嵌一个 W×H 的 2D canvas（CSS object-fit:contain 自动黑边），每帧把
 *    主画布的机位渲染 drawImage 进来——用户看到的就是逐帧真实录制画面，
 *    R3F 自己的渲染被监视层盖住，天然无闪烁、无拉伸、不互相抢画布。
 *    不用 absolute inset-0：画布父容器是 static 定位且比视口高，inset-0 会
 *    落到最近的定位祖先上，把状态条顶出可视区；fixed+可见交集则始终贴着
 *    用户实际看到的画布区域（resize/scroll 时重算）；
 * 3. 每帧用 sampleMotion 计算机位位姿，一份写回 store（面板数值同步、
 *    结束后便于恢复），一份驱动离屏 shot camera 渲染；
 * 4. 录制：监视 canvas captureStream(30) + MediaRecorder（vp9→vp8→webm 依次
 *    探测），时长到点 stop 拼 Blob；编码不支持/产出为空 → 人话报错；
 * 5. 结束/取消：撤销全部接管（监视层移除、画布尺寸还原、机位位姿快照恢复），
 *    场景状态与进入前完全一致。
 *
 * 锁交互：监视层盖住画布区域（gizmo/漫游不可点），顶栏导出入口由调用方按
 * running 态禁用；Esc 或「取消」按钮随时终止（取消即丢弃，不产出文件）。
 */
import { PerspectiveCamera, Vector3 } from "three";

import { directorRuntime } from "../runtime";
import { useDirectorStore } from "../store";
import { ASPECT_RATIO_VALUE, isCameraObject } from "../types";
import type { CameraObject, Vec3 } from "../types";
import { focalToVfov } from "../scene/StageCamera";
import { MOTION_PRESETS, followAimFor, sampleMotion } from "./cameraMotions";
import type { MotionPresetId } from "./cameraMotions";
import { beginShotRender } from "./captureShot";
import { canvasThumbDataUrl } from "./thumb";

/** 录制高度（px）；宽度 = 高度 × 当前画幅比，取偶（编码器友好） */
const RECORD_HEIGHT = 720;
const RECORD_FPS = 30;
const RECORD_BITRATE = 5_000_000;
const MIME_CANDIDATES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

export interface MotionRunMeta {
  cameraName: string;
  presetLabel: string;
  durationSec: number;
  width: number;
  height: number;
}

export type MotionRunResult =
  | { status: "done"; blob: Blob | null; thumbUrl: string | null; meta: MotionRunMeta }
  | { status: "cancelled" }
  | { status: "error"; error: string };

export interface MotionRunHandle {
  done: Promise<MotionRunResult>;
  cancel: () => void;
}

export interface MotionRunOptions {
  presetId: MotionPresetId;
  durationSec: number;
  /** 缺省活动机位 */
  cameraId?: string;
  /** follow 预设必填：选中的非机位对象 id */
  followObjectId?: string | null;
  /** false=预览（不产出文件） */
  record: boolean;
}

function errorHandle(error: string): MotionRunHandle {
  return { done: Promise.resolve({ status: "error", error }), cancel: () => undefined };
}

/** 监视层（内联样式，避免与 CSS 文件耦合；z-index 只需压住画布自身） */
function createMonitorOverlay(parent: HTMLElement, width: number, height: number, statusText: string, onCancel: () => void) {
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;z-index:5;display:flex;align-items:center;justify-content:center;background:#000;";
  /* 几何=父容器与视口的可见交集：状态条始终落在用户看得见的画布区域底部 */
  const place = () => {
    const rect = parent.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    overlay.style.left = `${left}px`;
    overlay.style.top = `${top}px`;
    overlay.style.width = `${Math.max(0, right - left)}px`;
    overlay.style.height = `${Math.max(0, bottom - top)}px`;
  };
  place();
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, true);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;";
  overlay.appendChild(canvas);

  const pill = document.createElement("div");
  pill.style.cssText =
    "position:absolute;left:50%;bottom:14px;transform:translateX(-50%);display:flex;align-items:center;gap:10px;" +
    "padding:6px 12px;border-radius:999px;background:rgba(20,22,28,0.85);border:1px solid rgba(255,255,255,0.14);" +
    "color:#E8EAEF;font-size:12px;white-space:nowrap;";
  const label = document.createElement("span");
  label.textContent = statusText;
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "取消";
  cancelButton.style.cssText =
    "padding:2px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);background:transparent;" +
    "color:#E8EAEF;font-size:12px;cursor:pointer;";
  cancelButton.addEventListener("click", onCancel);
  pill.appendChild(label);
  pill.appendChild(cancelButton);
  overlay.appendChild(pill);

  document.body.appendChild(overlay);
  const dispose = () => {
    window.removeEventListener("resize", place);
    window.removeEventListener("scroll", place, true);
  };
  return { overlay, canvas, dispose };
}

export function startCameraMotionRun(options: MotionRunOptions): MotionRunHandle {
  /* ── 前置校验（全部人话报错，不抛异常） ── */
  const context = directorRuntime.getContext();
  if (!context) return errorHandle("渲染运行时未就绪，请稍后再试");

  const state = useDirectorStore.getState();
  const cameraId = options.cameraId ?? state.activeCameraId;
  const object = cameraId ? state.objects[cameraId] : undefined;
  if (!cameraId || !object || !isCameraObject(object)) return errorHandle("需要先新增机位");
  const camera: CameraObject = object;

  const preset = MOTION_PRESETS.find((item) => item.id === options.presetId);
  if (!preset) return errorHandle("未知运镜预设");

  let followAim: Vec3 | undefined;
  if (preset.needsFollowTarget) {
    const followObject = options.followObjectId ? state.objects[options.followObjectId] : undefined;
    if (!followObject || isCameraObject(followObject)) return errorHandle("跟随需要先选中一个对象");
    followAim = followAimFor(followObject);
  }

  /* ── 录制参数与画布接管 ── */
  const aspectValue = ASPECT_RATIO_VALUE[state.aspect];
  const height = RECORD_HEIGHT;
  const width = Math.max(2, Math.round((height * aspectValue) / 2) * 2);

  let recorder: MediaRecorder | null = null;
  let mime = "";
  if (options.record) {
    if (typeof MediaRecorder === "undefined") {
      return errorHandle("当前浏览器不支持录制 WebM，请用最新版 Chrome 或 Edge");
    }
    mime = MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
    if (!mime) return errorHandle("当前浏览器不支持 WebM 编码，请用最新版 Chrome 或 Edge");
  }

  const { gl, scene } = context;
  const parent = gl.domElement.parentElement;
  if (!parent) return errorHandle("画布容器未就绪，请稍后再试");

  const snapshot = {
    position: [...camera.transform.position] as Vec3,
    target: [...camera.target] as Vec3,
  };
  const meta: MotionRunMeta = {
    cameraName: camera.name,
    presetLabel: preset.label,
    durationSec: options.durationSec,
    width,
    height,
  };

  let settled = false;
  let cancelled = false;
  let rafId = 0;
  let thumbUrl: string | null = null;
  const chunks: BlobPart[] = [];

  const done = new Promise<MotionRunResult>((resolve) => {
    /* 画布接管：藏辅助对象 + 切到录制分辨率（restore 还原） */
    const restore = beginShotRender(gl, scene, width, height);

    /* 监视层：用户所见=录制画面 */
    const statusText = options.record
      ? `● 录制中 · ${preset.label} ${options.durationSec} 秒`
      : `预览中 · ${preset.label} ${options.durationSec} 秒`;
    const finish = (result: MotionRunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const { overlay, canvas: monitorCanvas, dispose: disposeOverlay } = createMonitorOverlay(parent, width, height, statusText, () => {
      cancelled = true;
    });
    const monitorContext = monitorCanvas.getContext("2d");

    /* Esc 取消/停止 */
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelled = true;
    };
    document.addEventListener("keydown", onKeyDown);

    /* 机位位姿恢复 + 接管撤销 */
    const cleanup = () => {
      cancelAnimationFrame(rafId);
      document.removeEventListener("keydown", onKeyDown);
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          /* 重复 stop 静默忽略 */
        }
      }
      disposeOverlay();
      overlay.remove();
      restore();
      // 机位恢复快照（运行中被删除则跳过）
      useDirectorStore.setState((current) => {
        const existing = current.objects[cameraId];
        if (!existing || existing.type !== "camera") return current;
        return {
          objects: {
            ...current.objects,
            [cameraId]: {
              ...existing,
              transform: { ...existing.transform, position: snapshot.position },
              target: snapshot.target,
            },
          },
        };
      });
    };

    if (!monitorContext) {
      finish({ status: "error", error: "监视画布创建失败" });
      return;
    }

    /* 录制器 */
    let recorderStopped: Promise<void> | null = null;
    if (options.record) {
      const stream = monitorCanvas.captureStream(RECORD_FPS);
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: RECORD_BITRATE });
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => finish({ status: "error", error: "WebM 编码失败，请重试" });
      recorderStopped = new Promise<void>((resolveStop) => {
        recorder!.onstop = () => resolveStop();
      });
      recorder.start(250);
    }

    /* 逐帧驱动 */
    const shot = new PerspectiveCamera(focalToVfov(camera.focalLength, aspectValue), aspectValue, 0.1, 200);
    let startTime: number | null = null;

    const step = (now: number) => {
      if (settled) return;
      if (startTime === null) startTime = now;
      const t = Math.min(1, (now - startTime) / (options.durationSec * 1000));
      const pose = sampleMotion(options.presetId, camera, t, followAim);
      if (!pose) {
        finish({ status: "error", error: "运镜采样失败" });
        return;
      }

      // 写回 store（面板数值同步；机位被删则空转）
      useDirectorStore.setState((current) => {
        const existing = current.objects[cameraId];
        if (!existing || existing.type !== "camera") return current;
        return {
          objects: {
            ...current.objects,
            [cameraId]: {
              ...existing,
              transform: { ...existing.transform, position: pose.position },
              target: pose.target,
            },
          },
        };
      });

      // 渲染录制帧 → 监视画布
      shot.position.set(...pose.position);
      shot.up.set(0, 1, 0);
      shot.lookAt(new Vector3(...pose.target));
      gl.render(scene, shot);
      monitorContext.drawImage(gl.domElement, 0, 0, width, height);
      if (!thumbUrl) thumbUrl = canvasThumbDataUrl(monitorCanvas);

      if (cancelled) {
        finish({ status: "cancelled" });
        return;
      }
      if (t >= 1) {
        /* 时长到点：录制路径等编码器收尾后拼 Blob */
        if (recorder && recorderStopped) {
          const activeRecorder = recorder;
          const waitStop = recorderStopped;
          // 先停编码器再走统一 cleanup，避免 cleanup 里重复 stop
          recorder = null;
          activeRecorder.stop();
          void waitStop.then(() => {
            const blob = new Blob(chunks, { type: mime || "video/webm" });
            if (blob.size === 0) {
              finish({ status: "error", error: "WebM 编码失败，未产生有效画面" });
            } else {
              finish({ status: "done", blob, thumbUrl, meta });
            }
          });
        } else {
          finish({ status: "done", blob: null, thumbUrl, meta });
        }
        return;
      }
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  });

  return {
    done,
    cancel: () => {
      cancelled = true;
    },
  };
}
