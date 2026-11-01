/**
 * 3D 导演台 · 机位机身与视锥（Wave 2 · 相机模块）
 *
 * presentational：({object}: {object: CameraObject}) => JSX，
 * 由 StageCanvas 包进 SceneObjectNode（外层 group 已应用 transform / 选中 / gizmo）。
 * 渲染内容全部是「舞台辅助可视对象」——机身、视锥、目标点十字、连线的每个节点
 * 都带 userData.dsHelper = true，导出截图时会被临时隐藏（CONTRACT §铁律）。
 *
 * 视觉/行为移植 HTML 原型（buildCameraRig ~L810 / rebuildFrustum ~L862 /
 * updateCamVisual ~L877 / highlightCam ~L891）：
 * - 机身：LibTV 橙（#E59C3E，SPEC §2.2）box + 提手 + 镜头圆柱（原型尺寸，按 -Z 朝前建模），
 *   朝向由 transform.position → target 推导（lookAt 令 +Z 朝目标，故再 rotateY(180°)）；
 * - 视锥线框：focalToVfov(focalLength, aspect) 得垂直 FOV，近/远裁剪矩形 + 四条棱线；
 * - 目标点十字标记 + 机身→目标连线；
 * - 机身橙 / 视锥中性灰配色，选中时视锥/十字换强调青（--ds-accent #1ABEF3）。
 *
 * store 读取（对 CONTRACT §4「presentational 不读 store」的例外，均为只读单字段订阅）：
 * - selectedId：选中强调色（任务允许的唯一读取）；
 * - aspect：视锥宽高比必须跟随画幅才是 WYSIWYG（原型 rebuildFrustum 同样依赖画幅）；
 * - viewMode：机位视角下隐藏全部机身/视锥（原型 updateViewMode：rigRoot.visible = !isCam）。
 *   Wave 3 起 StageCanvas 侧已按 viewMode 过滤不渲染机位，本组件内部判断作为兜底保留。
 *
 * 瞄准/定位走 useFrame 而非 store 派生：gizmo 拖拽中 store 不回写（CONTRACT §4），
 * 每帧从 three 侧实时矩阵计算机身朝向与目标点本地坐标，拖拽中也保持视锥指向正确。
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { BufferGeometry, Float32BufferAttribute, Vector3 } from "three";
import type { BufferAttribute, Group } from "three";

import { useDirectorStore } from "../store";
import { ASPECT_RATIO_VALUE } from "../types";
import type { AspectRatio, CameraObject } from "../types";

/* ── FOV 换算：移植原型 focalToVfov（~L801），全画幅等效，长边 36mm ──
 * CONTRACT §0/§5 指定公式（导出模块也用它）。竖画幅（9:16）竖边 = 长边 36mm；
 * 横画幅（16:9）竖边 = 36 / aspect。视锥、机位视角、导出截图三者必须共用同一公式。 */
const SENSOR_LONG_MM = 36;

/** 焦距（mm）→ 垂直 FOV（角度制）。aspect 传 "9:16"/"16:9" 或宽高比数值 */
export function focalToVfov(focalLength: number, aspect: AspectRatio | number): number {
  const value = typeof aspect === "number" ? aspect : ASPECT_RATIO_VALUE[aspect];
  const sensorV = value >= 1 ? SENSOR_LONG_MM / value : SENSOR_LONG_MM;
  return (2 * Math.atan(sensorV / (2 * focalLength)) * 180) / Math.PI;
}

/* 视锥线框的近/远平面距离（米；原型只画 far=0.55 的矩形，此处按任务要求补近平面） */
const FRUSTUM_NEAR = 0.28;
const FRUSTUM_FAR = 0.6;
/* 目标点十字标记的臂展（米） */
const CROSS_SIZE = 0.16;

/* 配色：机身/镜头用 LibTV 橙系（SPEC §2.2 实测相机模型 ≈#E59C3E，镜头取同系深色）；
   视锥/十字中性灰，选中时换强调青（--ds-accent 实测值） */
const COLOR_BODY = "#E59C3E";
const COLOR_LENS = "#8A5E25";
const COLOR_LINE = "#8B8E97";
const COLOR_LINK = "#4A4D55";
const COLOR_CROSS = "#B9BCC4";
const COLOR_SELECTED = "#1ABEF3";

/** 视锥线框：近/远裁剪矩形（各 4 段）+ 四条棱线，共 12 段 24 点，沿 -Z 展开 */
function buildFrustumGeometry(vfovDeg: number, aspectValue: number): BufferGeometry {
  const tanHalf = Math.tan((vfovDeg * Math.PI) / 360);
  const rects = [FRUSTUM_NEAR, FRUSTUM_FAR].map((d): number[][] => {
    const h = tanHalf * d;
    const w = h * aspectValue;
    return [
      [-w, -h, -d],
      [w, -h, -d],
      [w, h, -d],
      [-w, h, -d],
    ];
  });
  const points: number[] = [];
  for (const rect of rects) {
    for (let i = 0; i < 4; i++) points.push(...rect[i]!, ...rect[(i + 1) % 4]!);
  }
  for (let i = 0; i < 4; i++) points.push(...rects[0]![i]!, ...rects[1]![i]!);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(points, 3));
  return geometry;
}

/** 目标点十字：三条过原点的轴线段（x/y/z 各一） */
function buildCrossGeometry(): BufferGeometry {
  const s = CROSS_SIZE / 2;
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new Float32BufferAttribute([-s, 0, 0, s, 0, 0, 0, -s, 0, 0, s, 0, 0, 0, -s, 0, 0, s], 3),
  );
  return geometry;
}

/** 机身 → 目标连线：两点线段，端点 1 每帧由 useFrame 更新 */
function buildLinkGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(6), 3));
  return geometry;
}

export function StageCamera({ object }: { object: CameraObject }) {
  const selected = useDirectorStore((state) => state.selectedId === object.id);
  const aspect = useDirectorStore((state) => state.aspect);
  const inCameraView = useDirectorStore((state) => state.viewMode === "camera");

  const rootRef = useRef<Group>(null);
  const aimRef = useRef<Group>(null);
  const crossRef = useRef<Group>(null);

  const frustumGeometry = useMemo(
    () => buildFrustumGeometry(focalToVfov(object.focalLength, aspect), ASPECT_RATIO_VALUE[aspect]),
    [object.focalLength, aspect],
  );
  const crossGeometry = useMemo(buildCrossGeometry, []);
  const linkGeometry = useMemo(buildLinkGeometry, []);
  useEffect(() => () => frustumGeometry.dispose(), [frustumGeometry]);
  useEffect(
    () => () => {
      crossGeometry.dispose();
      linkGeometry.dispose();
    },
    [crossGeometry, linkGeometry],
  );

  // 每帧：机身+视锥瞄准 target；十字/连线跟随目标点（世界→本地，gizmo 拖拽中也正确）
  const targetVec = useMemo(() => new Vector3(), []);
  useFrame(() => {
    const root = rootRef.current;
    const aim = aimRef.current;
    const cross = crossRef.current;
    if (!root || !aim || !cross) return;
    const target = object.target;
    targetVec.set(target[0], target[1], target[2]);
    // Object3D.lookAt 令 +Z 朝目标；机身/视锥按 -Z 建模，翻转 180°（原型 updateCamVisual 一致）
    aim.lookAt(targetVec);
    aim.rotateY(Math.PI);
    // 目标点（世界坐标）→ 本组件本地坐标（父 group 可能正被 gizmo 拖拽，取实时矩阵）
    root.updateWorldMatrix(true, false);
    root.worldToLocal(targetVec);
    cross.position.copy(targetVec);
    const attribute = linkGeometry.getAttribute("position") as BufferAttribute;
    attribute.setXYZ(1, targetVec.x, targetVec.y, targetVec.z);
    attribute.needsUpdate = true;
  });

  // 机位视角下隐藏全部机身/视锥（WYSIWYG，原型 updateViewMode 一致）
  if (inCameraView) return null;

  const lineColor = selected ? COLOR_SELECTED : COLOR_LINE;
  const crossColor = selected ? COLOR_SELECTED : COLOR_CROSS;

  return (
    <group ref={rootRef} userData={{ dsHelper: true }}>
      {/* 机身 + 视锥（-Z 朝前，由 useFrame 瞄准 target） */}
      <group ref={aimRef} userData={{ dsHelper: true }}>
        <mesh castShadow userData={{ dsHelper: true }}>
          <boxGeometry args={[0.2, 0.12, 0.26]} />
          <meshStandardMaterial color={COLOR_BODY} roughness={0.55} metalness={0.25} />
        </mesh>
        <mesh position={[0, 0.075, 0.02]} castShadow userData={{ dsHelper: true }}>
          <boxGeometry args={[0.09, 0.035, 0.12]} />
          <meshStandardMaterial color={COLOR_BODY} roughness={0.55} metalness={0.25} />
        </mesh>
        <mesh
          position={[0, 0, -0.19]}
          rotation={[Math.PI / 2, 0, 0]}
          castShadow
          userData={{ dsHelper: true }}
        >
          <cylinderGeometry args={[0.04, 0.048, 0.13, 18]} />
          <meshStandardMaterial color={COLOR_LENS} roughness={0.35} metalness={0.5} />
        </mesh>
        <lineSegments geometry={frustumGeometry} raycast={() => null} userData={{ dsHelper: true }}>
          <lineBasicMaterial color={lineColor} transparent opacity={selected ? 1 : 0.8} />
        </lineSegments>
      </group>

      {/* 机身 → 目标连线（端点每帧更新，跳过视锥剔除） */}
      <lineSegments
        geometry={linkGeometry}
        raycast={() => null}
        frustumCulled={false}
        userData={{ dsHelper: true }}
      >
        <lineBasicMaterial color={COLOR_LINK} transparent opacity={0.6} />
      </lineSegments>

      {/* 目标点十字标记 */}
      <group ref={crossRef} userData={{ dsHelper: true }}>
        <lineSegments geometry={crossGeometry} raycast={() => null} userData={{ dsHelper: true }}>
          <lineBasicMaterial color={crossColor} transparent opacity={selected ? 1 : 0.9} />
        </lineSegments>
      </group>
    </group>
  );
}
