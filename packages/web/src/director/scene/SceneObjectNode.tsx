/**
 * 3D 导演台 · 场景对象包装节点（Wave 1 冻结，核心交互模式；v2 补选中环 + 网格吸附）
 *
 * Wave 2 所有场景对象（素模/几何体/群众/上传模型/机位）的渲染组件都是
 * presentational 的（签名 `({object}: {object: XxxObject}) => JSX`，不直接读 store），
 * 由 StageCanvas 统一包进本组件，获得一致的交互：
 *
 * - <group> 应用 object.transform（store 角度制 → three 弧度在此转换）
 * - onClick 选中（stopPropagation，不穿透到画布空白）
 * - 选中时挂 drei TransformControls（mode 取 store.gizmoMode；机位强制 translate）
 * - 拖拽期间 drei 自动禁用 makeDefault 的相机控制（OrbitControls）
 * - onMouseUp 把 three 侧最终 position/rotation/scale 写回 store.updateTransform
 *
 * v2 追加：
 * - 网格吸附：scene.gridSnap 开启时 TransformControls 接 translationSnap 0.25m /
 *   rotationSnap 15°（Math.PI/12），关闭传 null（three-stdlib 以 null 关吸附）
 * - 选中环：选中非机位对象时在其脚下画亮蓝圆环（#2E7CF6，SPEC §2.2 取样约值），
 *   微透明贴地（y=0.015，高于 Grid 的 0.01 避免 z-fighting）、dsHelper（导出隐藏）、
 *   raycast 置空不挡点击；机位选中不画（已有视锥强调）。
 *   环是 group 的兄弟节点（不继承对象旋转），useFrame 每帧同步 group 的实时
 *   位置与 xz 缩放——gizmo 拖拽中也跟随，对象旋转/缩放不会把环带歪。
 */
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { DoubleSide, MathUtils } from "three";
import type { Group, Mesh } from "three";
import { useFrame } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import { TransformControls } from "@react-three/drei";
import type { TransformControls as TransformControlsImpl } from "three-stdlib";

import { useDirectorStore } from "../store";
import type { SceneObject, Vec3 } from "../types";

const { degToRad, radToDeg } = MathUtils;

function toRadians([x, y, z]: Vec3): Vec3 {
  return [degToRad(x), degToRad(y), degToRad(z)];
}

/* ──────────────────────────── 选中环 ──────────────────────────── */

/** 选中环亮蓝（SPEC §2.2 gizmo 选中环取样约值） */
const RING_COLOR = "#2E7CF6";
/** 贴地高度：略高于 Grid 的 0.01，避免与网格/地面 z-fighting */
const RING_Y = 0.015;
const RING_THICKNESS = 0.05;

/** 网格吸附加载量：平移 0.25m、旋转 15°（types.ts SceneSettings 注释约定） */
const SNAP_TRANSLATE = 0.25;
const SNAP_ROTATE = Math.PI / 12;

/**
 * 选中环半径（米，未计对象缩放，缩放在 useFrame 里实时乘）：
 * 素模 0.45 / 几何按 size 占地对角一半（+0.1 余量）/ 阵列按网格跨度对角一半
 * （+0.35 人偶余量）/ 上传模型 0.6。
 */
function ringRadius(object: SceneObject): number {
  switch (object.type) {
    case "mannequin":
      return 0.45;
    case "model":
      return 0.6;
    case "geometry":
      return Math.hypot(object.size[0], object.size[2]) / 2 + 0.1;
    case "crowd": {
      const spanX = (object.cols - 1) * object.spacing;
      const spanZ = (object.rows - 1) * object.spacing;
      return Math.hypot(spanX, spanZ) / 2 + 0.35;
    }
    default:
      return 0.5;
  }
}

/**
 * 选中环网格：group 的兄弟节点（世界系，不随对象旋转倾斜）。
 * useFrame 同步 group 实时 x/z 与 xz 缩放（拖拽平移/缩放中同样贴脚）；
 * y 恒为 RING_Y（贴地，即使对象被抬升也留在地面作投影标记）。
 */
function SelectionRing({ object, target }: { object: SceneObject; target: Group }) {
  const ringRef = useRef<Mesh>(null);
  const radius = ringRadius(object);

  useFrame(() => {
    const ring = ringRef.current;
    if (!ring) return;
    ring.position.set(target.position.x, RING_Y, target.position.z);
    ring.scale.setScalar(Math.max(target.scale.x, target.scale.z));
  });

  return (
    <mesh
      ref={ringRef}
      position={[object.transform.position[0], RING_Y, object.transform.position[2]]}
      rotation-x={-Math.PI / 2}
      renderOrder={1}
      raycast={() => null}
      userData={{ dsHelper: true, dsRing: true }}
    >
      <ringGeometry args={[radius - RING_THICKNESS, radius, 64]} />
      <meshBasicMaterial
        color={RING_COLOR}
        transparent
        opacity={0.9}
        side={DoubleSide}
        depthWrite={false}
      />
    </mesh>
  );
}

/* ──────────────────────────── gizmo 辅助标记 ──────────────────────────── */

/**
 * gizmo 是编辑辅助对象：给 three-stdlib TransformControls 实例（extends Object3D，
 * 经 <primitive> 入场）打 dsHelper 标记，导出截图时隐藏（对齐原型 hideHelpers 隐 tc）。
 * 注意不能走 <TransformControls userData=…>：drei 把多余 props 铺到内部 group 而非实例。
 */
function markGizmoHelper(controls: TransformControlsImpl | null): void {
  if (controls) controls.userData.dsHelper = true;
}

export function SceneObjectNode({
  object,
  children,
  readOnly = false,
}: {
  object: SceneObject;
  children?: ReactNode;
  readOnly?: boolean;
}) {
  // 用 callback ref + state 持有 group：保证 TransformControls 拿到已挂载的实例且类型安全
  const [group, setGroup] = useState<Group | null>(null);
  const isSelected = useDirectorStore((state) => state.selectedId === object.id);
  const gizmoMode = useDirectorStore((state) => state.gizmoMode);
  const gridSnap = useDirectorStore((state) => state.scene.gridSnap);
  const select = useDirectorStore((state) => state.select);
  const updateTransform = useDirectorStore((state) => state.updateTransform);

  // 机位机身只允许平移：朝向由 position→target 推导，缩放无意义
  const mode = object.type === "camera" ? "translate" : gizmoMode;

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    if (!readOnly) select(object.id);
  };

  // 拖拽结束才写回 store（拖拽中 three 侧临时变更不进 store，避免受控属性回打）
  const handleMouseUp = () => {
    if (!group) return;
    updateTransform(object.id, {
      position: [group.position.x, group.position.y, group.position.z],
      rotation: [
        radToDeg(group.rotation.x),
        radToDeg(group.rotation.y),
        radToDeg(group.rotation.z),
      ],
      scale: [group.scale.x, group.scale.y, group.scale.z],
    });
  };

  return (
    <>
      <group
        ref={setGroup}
        position={object.transform.position}
        rotation={toRadians(object.transform.rotation)}
        scale={object.transform.scale}
        visible={object.visible}
        onClick={handleClick}
        userData={{ objectId: object.id, objectType: object.type }}
      >
        {children}
      </group>
      {!readOnly && isSelected && group && object.type !== "camera" ? (
        <SelectionRing object={object} target={group} />
      ) : null}
      {!readOnly && isSelected && group ? (
        <TransformControls
          ref={markGizmoHelper}
          object={group}
          mode={mode}
          onMouseUp={handleMouseUp}
          translationSnap={gridSnap ? SNAP_TRANSLATE : null}
          rotationSnap={gridSnap ? SNAP_ROTATE : null}
        />
      ) : null}
    </>
  );
}
