/**
 * 3D 导演台 · 基础几何体（Wave 2 · presentational）
 *
 * 签名 `({object}: {object: GeometryObject})`，由 StageCanvas 包进 SceneObjectNode
 * 获得 transform / 选中 / gizmo；本组件只按 shape 渲染网格，不读 store。
 *
 * object.size（米，Vec3）按 shape 的语义映射（对齐 types.ts 注释与 HTML 原型
 * rebuildGeometry，落地原点约定：group 原点在地面，网格自行抬升）：
 * - box      size=[宽, 高, 深]     → BoxGeometry(size)，抬升 高/2
 * - sphere   size=[直径, -, -]     → SphereGeometry(直径/2)，抬升 半径
 * - cylinder size=[直径, 高, -]    → CylinderGeometry(直径/2, 直径/2, 高, 24)，抬升 高/2
 * - cone     size=[直径, 高, -]    → ConeGeometry(直径/2, 高, 24)，抬升 高/2
 * - torus    size=[外径, 管径, -]  → TorusGeometry((外径-管径)/2, 管径/2)，平放（rotation-x=-90°），
 *            抬升 管半径（管中心距地 = 管半径，正好落地）
 * - plane    size=[宽, -, 深]      → PlaneGeometry(宽, 深)，平放，抬升 0.01 防与地面 z-fighting
 */
import type { GeometryObject } from "../types";

const PLANE_LIFT = 0.01;

export function GeometryObject({ object }: { object: GeometryObject }) {
  const [sx, sy, sz] = object.size;

  switch (object.shape) {
    case "box":
      return (
        <mesh position={[0, sy / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={object.size} />
          <meshStandardMaterial color={object.color} roughness={0.7} metalness={0.02} />
        </mesh>
      );
    case "sphere": {
      const radius = sx / 2;
      return (
        <mesh position={[0, radius, 0]} castShadow receiveShadow>
          <sphereGeometry args={[radius, 28, 20]} />
          <meshStandardMaterial color={object.color} roughness={0.7} metalness={0.02} />
        </mesh>
      );
    }
    case "cylinder": {
      const radius = sx / 2;
      return (
        <mesh position={[0, sy / 2, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[radius, radius, sy, 24]} />
          <meshStandardMaterial color={object.color} roughness={0.7} metalness={0.02} />
        </mesh>
      );
    }
    case "cone": {
      const radius = sx / 2;
      return (
        <mesh position={[0, sy / 2, 0]} castShadow receiveShadow>
          <coneGeometry args={[radius, sy, 24]} />
          <meshStandardMaterial color={object.color} roughness={0.7} metalness={0.02} />
        </mesh>
      );
    }
    case "torus": {
      const tubeRadius = sy / 2;
      // three 的 radius 是环心到管心距离：外径 = 2*(radius + tubeRadius)
      const ringRadius = Math.max(sx / 2 - tubeRadius, 0.001);
      return (
        <mesh position={[0, tubeRadius, 0]} rotation-x={-Math.PI / 2} castShadow receiveShadow>
          <torusGeometry args={[ringRadius, tubeRadius, 16, 48]} />
          <meshStandardMaterial color={object.color} roughness={0.7} metalness={0.02} />
        </mesh>
      );
    }
    case "plane":
      return (
        <mesh
          position={[0, PLANE_LIFT, 0]}
          rotation-x={-Math.PI / 2}
          castShadow
          receiveShadow
        >
          <planeGeometry args={[sx, sz]} />
          <meshStandardMaterial color={object.color} roughness={0.7} metalness={0.02} />
        </mesh>
      );
  }
}
