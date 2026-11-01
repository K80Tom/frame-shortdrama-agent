/**
 * 3D 导演台 · 舞台画布（Wave 3 重写：完整舞台；v2 补场景设置消费/重置视角/快捷键/方向指示球）
 *
 * 职责：
 * - R3F Canvas：antialias + preserveDrawingBuffer（导出截图依赖）+ shadows(PCF)
 * - 环境灯光预设（十档，数据在 env-presets.ts：棚拍亮调/黄昏暖调 + 夜戏冷调/日外景晴/
 *   室内暖光/逆光剪影/阴天柔光/霓虹夜景/烛光/月夜）：v2 起只管灯光/雾氛围/曝光/地面色，
 *   不再回写背景色；背景色只认 store.scene.skyColor，雾色跟随 skyColor
 * - 场景设置消费（store.scene，LibTV「3D场景」面板）：
 *   地面 mesh 按 groundVisible 显隐、按 groundOpacity 调不透明度（<1 时 transparent +
 *   关 depthWrite）；Grid 显隐与地面联动
 * - 全景背景（store.scene.panoramaUrl，LibTV 720° 全景联用）：equirect 图贴 BackSide
 *   全景球（MeshBasicMaterial，toneMapped=false、fog=false，不受灯光/雾影响），
 *   rotation.y = panoramaRotation、半径 = panoramaRadius（10-100m，相机 far=200 内安全）；
 *   全景球是场景内容（导出截图保留，不标 dsHelper），raycast 置空不可点选、不投/接影；
 *   球渲出后不再设 scene.background 纯色（纹理加载期仍以 skyColor 过渡，避免闪黑）；
 *   panoramaUrl 变 null / 更换时 useEffect 清理旧纹理（dispose）
 * - 米制 Grid（1 格 = 1m）+ 接阴影地面：
 *   Grid 是编辑辅助对象，带 userData.dsHelper（导出时隐藏，原型 hideHelpers 同样隐网格）；
 *   地面是场景内容（投影承载），不进 dsHelper，导出保留（原型同样不隐地面）
 * - OrbitControls(makeDefault)：导演视角自由环绕；机位视角由 CameraViewController 禁用
 *   （SceneObjectNode 拖拽 gizmo 时 drei 也自动禁用它）
 * - 视口右上角：drei GizmoHelper+GizmoViewport 方向指示球（Hud 独立场景渲染，不进主
 *   scene，导出截图天然不含）+ DOM「重置视角」按钮（恢复默认机位，仅导演视角显示）
 * - 键盘快捷键（useDirectorHotkeys）：G/R/S 切 gizmo 模式（平移/旋转/缩放）、
 *   Ctrl/Cmd+C/V 经内部剪贴板复制粘贴、Ctrl/Cmd+Z 撤销（命令栈）、F 聚焦选中对象、
 *   Delete/Backspace 删除选中、Escape 取消选中；表单输入不劫持，
 *   组合键只在真正处理时拦截（不抢 Cmd+R/⌘S 等浏览器/系统快捷键）
 * - 按 store.order 渲染场景对象：不可见跳过；按类型分发到 Wave 2 的
 *   Mannequin / GeometryObject / CrowdArray / ModelGuard（包 UploadedModel）/ StageCamera，
 *   全部包 SceneObjectNode（选中/选中环/gizmo/变换写回）；机位视角下不渲染任何机位节点
 * - 挂载时把 {gl, scene} 注册进 directorRuntime（export/ 模块依赖）；
 *   非生产环境暴露 window.__director 调试句柄（对齐原型 window.DS）
 */
import { Suspense, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { GizmoHelper, GizmoViewport, Grid, OrbitControls } from "@react-three/drei";
import { BackSide, MathUtils, SRGBColorSpace, TextureLoader } from "three";
import type { Texture } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

import { directorRuntime } from "./runtime";
import { ENV_PRESETS } from "./env-presets";
import { directorUndoDepth, undoDirectorCommand } from "./commands";
import { CameraViewController } from "./scene/CameraViewController";
import { CrowdArray } from "./scene/CrowdArray";
import { GeometryObject } from "./scene/GeometryObject";
import { Mannequin } from "./scene/Mannequin";
import { ModelGuard } from "./scene/ModelGuard";
import { SceneObjectNode } from "./scene/SceneObjectNode";
import { StageCamera } from "./scene/StageCamera";
import { useDirectorStore } from "./store";
import type { SceneObject, Vec3 } from "./types";

/* ──────────────────────────── 默认机位 ────────────────────────────
 * 初始 Canvas camera 与 OrbitControls target 共用；「重置视角」按钮也恢复到这组值
 */
const DEFAULT_CAMERA_POSITION: Vec3 = [5.6, 3.9, 7.8];
const DEFAULT_CAMERA_TARGET: Vec3 = [0, 0.9, 0];

/* ──────────────────────────── 环境预设 ────────────────────────────
 * 预置数据在 env-presets.ts（S8-7 扩为十档三组，TopBar 菜单同源 import）：
 * key/fill/rim 三点光 + 半球环境光 + 雾 + 曝光 + 地面色。
 * v2 起背景色归 store.scene.skyColor，雾只留 near/far，颜色运行时跟随 skyColor。
 */

/** 曝光写入渲染器（原型 setEnv：renderer.toneMappingExposure = p.exposure） */
function ExposureSync({ exposure }: { exposure: number }) {
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    gl.toneMappingExposure = exposure;
  }, [gl, exposure]);
  return null;
}

/* ──────────────────────────── 全景背景 ──────────────────────────── */

const { degToRad } = MathUtils;

/**
 * 手动加载 equirect 纹理（随 url 重建，SRGB 色彩空间）；url 变化 / 组件卸载时
 * dispose 旧纹理。state 里带 url，渲染时只认与当前 url 匹配的纹理——
 * 加载期返回 null（环境舞台以 skyColor 过渡），杜绝闪旧图 / 闪黑底
 */
function usePanoramaTexture(url: string | null): Texture | null {
  const [loaded, setLoaded] = useState<{ url: string; texture: Texture } | null>(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const texture = new TextureLoader().load(url, () => {
      if (!cancelled) setLoaded({ url, texture });
    });
    texture.colorSpace = SRGBColorSpace;
    return () => {
      cancelled = true;
      texture.dispose();
    };
  }, [url]);

  return loaded && loaded.url === url ? loaded.texture : null;
}

/** 环境舞台：天空/雾/灯光/全景球/地面/网格（灯光由环境预设驱动，背景与地面显隐/透明度归 store.scene） */
function EnvironmentStage() {
  const environment = useDirectorStore((state) => state.environment);
  const skyColor = useDirectorStore((state) => state.scene.skyColor);
  const panoramaUrl = useDirectorStore((state) => state.scene.panoramaUrl);
  const panoramaRotation = useDirectorStore((state) => state.scene.panoramaRotation);
  const panoramaRadius = useDirectorStore((state) => state.scene.panoramaRadius);
  const groundVisible = useDirectorStore((state) => state.scene.groundVisible);
  const groundOpacity = useDirectorStore((state) => state.scene.groundOpacity);
  const preset = ENV_PRESETS[environment];
  const groundOpaque = groundOpacity >= 1;
  const panoramaTexture = usePanoramaTexture(panoramaUrl);

  return (
    <>
      {/* 背景色只认 scene.skyColor（setEnvironment 不回写）；雾色跟随天空色。
          全景球渲出后不再设纯色背景（球覆盖天空）；纹理加载期仍以 skyColor 过渡 */}
      {panoramaTexture ? null : <color attach="background" args={[skyColor]} />}
      {preset.fog ? <fog attach="fog" args={[skyColor, preset.fog.near, preset.fog.far]} /> : null}
      <ExposureSync exposure={preset.exposure} />

      {/* 全景球：场景内容（导出截图保留，不标 dsHelper）；raycast 置空不可点选，
          默认不投/接影；MeshBasicMaterial 不受灯光影响，toneMapped=false 保原图亮度，
          fog=false 不被雾吞。dsPanorama 标记仅供 QA 定位 */}
      {panoramaTexture ? (
        <mesh
          rotation={[0, degToRad(panoramaRotation), 0]}
          raycast={() => null}
          userData={{ dsPanorama: true }}
        >
          <sphereGeometry args={[panoramaRadius, 48, 32]} />
          <meshBasicMaterial
            map={panoramaTexture}
            side={BackSide}
            toneMapped={false}
            fog={false}
          />
        </mesh>
      ) : null}

      {/* 三点光（key 带阴影，投影参数取原型 keyLight 配置）+ 半球环境光 */}
      <directionalLight
        position={preset.key.position}
        intensity={preset.key.intensity}
        color={preset.key.color}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-9}
        shadow-camera-right={9}
        shadow-camera-top={9}
        shadow-camera-bottom={-9}
        shadow-camera-far={30}
        shadow-bias={-0.0004}
      />
      <directionalLight
        position={preset.fill.position}
        intensity={preset.fill.intensity}
        color={preset.fill.color}
      />
      <directionalLight
        position={preset.rim.position}
        intensity={preset.rim.intensity}
        color={preset.rim.color}
      />
      <hemisphereLight args={[preset.hemi.sky, preset.hemi.ground, preset.hemi.intensity]} />

      {/* 接阴影地面：场景内容（导出截图保留，原型 hideHelpers 不隐地面）；
          raycast 置空让点击穿透到画布空白（触发取消选中）。
          不透明度 <1 时 transparent + 关 depthWrite（避免半透明地面写入深度挡网格），
          key 按透明态切换强制材质重建（three 切 transparent 需 needsUpdate，重建最稳）；
          dsGround 标记仅供 QA 定位 */}
      <mesh
        rotation-x={-Math.PI / 2}
        receiveShadow
        raycast={() => null}
        visible={groundVisible}
        userData={{ dsGround: true }}
      >
        <circleGeometry args={[16, 64]} />
        <meshStandardMaterial
          key={groundOpaque ? "opaque" : "translucent"}
          color={preset.floor}
          roughness={0.95}
          metalness={0}
          transparent={!groundOpaque}
          opacity={groundOpacity}
          depthWrite={groundOpaque}
        />
      </mesh>

      {/* 米制 Grid（1 格 = 1m）：编辑辅助对象，dsHelper 导出时隐藏；配色取原型 GridHelper；
          显隐与地面联动（LibTV「地面」开关同时控制地板与网格） */}
      <Grid
        position={[0, 0.01, 0]}
        visible={groundVisible}
        infiniteGrid
        cellSize={1}
        sectionSize={5}
        cellColor="#44474E"
        sectionColor="#63676F"
        fadeDistance={40}
        raycast={() => null}
        userData={{ dsHelper: true, dsGrid: true }}
      />
    </>
  );
}

/* ──────────────────────────── 场景对象渲染 ──────────────────────────── */

/** 按类型分发到 Wave 2 渲染组件，统一包 SceneObjectNode（transform/选中/选中环/gizmo） */
function SceneObjectView({ object, readOnly }: { object: SceneObject; readOnly: boolean }) {
  switch (object.type) {
    case "mannequin":
      return (
        <SceneObjectNode object={object} readOnly={readOnly}>
          <Mannequin object={object} />
        </SceneObjectNode>
      );
    case "geometry":
      return (
        <SceneObjectNode object={object} readOnly={readOnly}>
          <GeometryObject object={object} />
        </SceneObjectNode>
      );
    case "crowd":
      return (
        <SceneObjectNode object={object} readOnly={readOnly}>
          <CrowdArray object={object} />
        </SceneObjectNode>
      );
    case "model":
      return (
        <SceneObjectNode object={object} readOnly={readOnly}>
          {/* ModelGuard：模型级 Suspense + ErrorBoundary（加载失败不连坐整个画布） */}
          <ModelGuard object={object} />
        </SceneObjectNode>
      );
    case "camera":
      return (
        <SceneObjectNode object={object} readOnly={readOnly}>
          <StageCamera object={object} />
        </SceneObjectNode>
      );
  }
}

function SceneObjects({ readOnly }: { readOnly: boolean }) {
  const objects = useDirectorStore((state) => state.objects);
  const order = useDirectorStore((state) => state.order);
  const inCameraView = useDirectorStore((state) => state.viewMode === "camera");

  return (
    <>
      {order.map((id) => {
        const object = objects[id];
        // 不可见对象跳过渲染
        if (!object || !object.visible) return null;
        // 机位视角（WYSIWYG）下隐藏全部机位机身/视锥，避免活动机位自拍穿帮
        if (inCameraView && object.type === "camera") return null;
        return <SceneObjectView key={id} object={object} readOnly={readOnly} />;
      })}
    </>
  );
}

/* ──────────────────────────── 键盘快捷键 ────────────────────────────
 * G→平移 / R→旋转 / S→缩放（写 store.gizmoMode，TopBar 高亮联动读同一字段）、
 * Ctrl/Cmd+C→复制选中对象进内部剪贴板（深拷贝）、Ctrl/Cmd+V→粘贴为新对象、
 * Ctrl/Cmd+Z→撤销（走 commands 命令栈，不自建第二撤销栈）、
 * F→聚焦选中对象（仅导演视角）、Delete/Backspace→删除选中对象、Escape→取消选中。
 * 不劫持表单输入（input/textarea/select/contentEditable）；NameField 等输入件自身
 * keydown 已 stopPropagation，这里的 target 判断是兜底。
 * 组合键只放行 Ctrl/Cmd+C/V/Z，且只在真正处理时 preventDefault：无选中不抢 copy
 * （浏览器复制仍可用）、剪贴板空不抢 paste、撤销栈空不抢 undo；
 * Cmd+R/⌘S/Alt 组合等浏览器/系统快捷键一律不碰。
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

/** F 聚焦后相机距对象的 dolly 距离（米） */
const FOCUS_DISTANCE_M = 4;

/**
 * F 聚焦选中对象：OrbitControls target 移到对象位置，相机沿当前视线方向
 * 等距 dolly 到距对象约 FOCUS_DISTANCE_M（保持当前观察角度不变）
 */
function dollyCameraToObject(controls: OrbitControlsImpl, position: Vec3): void {
  const [x, y, z] = position;
  const direction = controls.object.position.clone().sub(controls.target).normalize();
  controls.target.set(x, y, z);
  controls.object.position.set(
    x + direction.x * FOCUS_DISTANCE_M,
    y + direction.y * FOCUS_DISTANCE_M,
    z + direction.z * FOCUS_DISTANCE_M,
  );
  controls.update();
}

function useDirectorHotkeys(orbitRef: { current: OrbitControlsImpl | null }, readOnly: boolean): void {
  useEffect(() => {
    if (readOnly) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (isEditableTarget(event.target)) return;
      // 直读 getState：handler 生命周期内不依赖渲染闭包，action 永远最新
      const state = useDirectorStore.getState();

      // Ctrl/Cmd 组合：只放行 C/V/Z 三条编辑组合（Shift/Alt 再叠加也不接，
      // Cmd+Shift+Z 是重做惯例，本栈暂无重做，不劫持）
      if (event.metaKey || event.ctrlKey) {
        if (event.altKey || event.shiftKey) return;
        switch (event.key.toLowerCase()) {
          case "c":
            if (!state.selectedId) return; // 无选中不劫持浏览器复制
            event.preventDefault();
            state.copyObject(state.selectedId);
            return;
          case "v":
            if (!state.clipboard) return; // 剪贴板空不劫持粘贴
            event.preventDefault();
            state.pasteObject();
            return;
          case "z":
            if (directorUndoDepth() === 0) return; // 撤销栈空不劫持
            event.preventDefault();
            undoDirectorCommand();
            return;
          default:
            return; // Cmd+R/⌘S 等浏览器/系统快捷键一律放行
        }
      }
      if (event.altKey) return;

      switch (event.key.toLowerCase()) {
        case "g":
          state.setGizmoMode("translate");
          break;
        case "r":
          state.setGizmoMode("rotate");
          break;
        case "s":
          state.setGizmoMode("scale");
          break;
        case "delete":
        case "backspace":
          if (state.selectedId) {
            event.preventDefault();
            state.removeObject(state.selectedId);
          }
          break;
        case "f": {
          const controls = orbitRef.current;
          const object = state.selectedId ? state.objects[state.selectedId] : undefined;
          // 仅导演视角聚焦：机位视角的相机由活动机位接管
          if (!controls || !object || state.viewMode !== "director") break;
          event.preventDefault();
          dollyCameraToObject(controls, object.transform.position);
          break;
        }
        case "escape":
          state.select(null);
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [orbitRef, readOnly]);
}

/* ──────────────────────────── 运行时桥接 ──────────────────────────── */

function RuntimeBridge() {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  useEffect(() => {
    directorRuntime.register({ gl, scene });
    return () => directorRuntime.unregister();
  }, [gl, scene]);
  return null;
}

/** 开发调试句柄（对齐原型的 window.DS）：控制台/e2e 可直接查看 store、runtime 与当前相机 */
type DirectorDebugHandle = {
  store: typeof useDirectorStore;
  runtime: typeof directorRuntime;
  camera?: unknown;
};

function DebugBridge() {
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    if (import.meta.env.PROD) return;
    const win = window as unknown as { __director?: DirectorDebugHandle };
    win.__director = { store: useDirectorStore, runtime: directorRuntime, camera };
    return () => {
      delete win.__director;
    };
  }, []);
  // makeDefault 切换（机位视角进出）后同步最新相机实例
  useEffect(() => {
    if (import.meta.env.PROD) return;
    const win = window as unknown as { __director?: DirectorDebugHandle };
    if (win.__director) win.__director.camera = camera;
  }, [camera]);
  return null;
}

/* ──────────────────────────── 画布主体 ──────────────────────────── */

/**
 * 「重置视角」悬浮按钮样式：StageCanvas 无独立 CSS 文件（契约约定每个 UI 组件一个，
 * 本文件不在其列），用内联样式保证与 FrameOverlays（z-index 10、pointer-events none）
 * 共存不打架；垂直位置错开右上角 GizmoViewport 方向指示球。
 */
const RESET_BUTTON_STYLE: CSSProperties = {
  position: "absolute",
  top: 132,
  right: 12,
  zIndex: 20,
  padding: "5px 11px",
  borderRadius: 7,
  border: "1px solid var(--ds-border)",
  background: "var(--ds-menu)",
  color: "var(--ds-text)",
  fontSize: 12,
  lineHeight: 1.4,
  cursor: "pointer",
};

export function StageCanvas({ readOnly = false }: { readOnly?: boolean }) {
  const select = useDirectorStore((state) => state.select);
  const viewMode = useDirectorStore((state) => state.viewMode);
  const orbitRef = useRef<OrbitControlsImpl | null>(null);
  useDirectorHotkeys(orbitRef, readOnly);

  // 恢复默认机位：写回 position/target 后 update 立即生效（机位视角不渲染按钮，不会误触）。
  // 注意先带 enableDamping=false 走一次 update：drei OrbitControls 默认开阻尼，拖拽残留的
  // 惯性增量（sphericalDelta/panOffset）只会在非阻尼 update 里清零，否则重置后仍会漂移
  const handleResetView = () => {
    const controls = orbitRef.current;
    if (!controls) return;
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    controls.object.position.set(...DEFAULT_CAMERA_POSITION);
    controls.target.set(...DEFAULT_CAMERA_TARGET);
    controls.update();
    controls.enableDamping = damping;
  };

  return (
    <>
      <Canvas
        // three 0.185 已废弃 PCFSoftShadowMap（boolean true 会触发告警并自动回落 PCF），直接用 PCF
        shadows="percentage"
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        camera={{ position: DEFAULT_CAMERA_POSITION, fov: 45, near: 0.1, far: 200 }}
        onPointerMissed={() => { if (!readOnly) select(null); }}
      >
        <RuntimeBridge />
        <DebugBridge />
        <EnvironmentStage />

        {/* Suspense：UploadedModel 的 useLoader 加载期挂起，不阻塞其余场景 */}
        <Suspense fallback={null}>
          <SceneObjects readOnly={readOnly} />
        </Suspense>

        <CameraViewController />

        <OrbitControls
          ref={orbitRef}
          makeDefault
          target={DEFAULT_CAMERA_TARGET}
          maxPolarAngle={Math.PI * 0.495}
          minDistance={0.5}
          maxDistance={60}
        />

        {/* 方向指示球（右上角）：Hud 独立场景渲染，不进主 scene，导出截图天然不含；
            仅导演视角显示——机位视角是 WYSIWYG 构图，不叠加漫游辅助。
            dsHelper 标记按辅助对象约定补上（即使 Hud 场景不参与导出遍历） */}
        {viewMode === "director" ? (
          <GizmoHelper alignment="top-right" margin={[76, 76]}>
            <group userData={{ dsHelper: true }}>
              <GizmoViewport />
            </group>
          </GizmoHelper>
        ) : null}
      </Canvas>

      {/* 重置视角：导演视角专属（机位视角隐藏，视角由活动机位决定） */}
      {viewMode === "director" ? (
        <button
          type="button"
          className="ds-view-reset"
          style={RESET_BUTTON_STYLE}
          onClick={handleResetView}
        >
          重置视角
        </button>
      ) : null}
    </>
  );
}
