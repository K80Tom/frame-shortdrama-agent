/**
 * 3D 导演台 · 程序化关节人偶（v2 · 素模模块）
 *
 * v2：按 scene/bodies.ts 的 BodyProportions 参数化 8 种体型（原 v1 固定
 * 数值即 bodies.male）；段结构不变：头/颈/躯干/骨盆/四肢段 + 球关节，
 * chibi 仅靠比例参数实现大头小身（头 ≈ 全身一半、颈≈0、短粗四肢），
 * 无需独立结构分支。
 *
 * 结构与姿势语义（与 v1/原型一致）：
 * - group 原点 = 落地中心（y=0 在脚底），骨盆根关节抬到 pelvisY：
 *   POSE_PELVIS_Y 以男性髋高 0.92 为基准，按当前体型 hipY 比例缩放，
 *   未列出的姿势用该体型自身 hipY（与原型 applyPose 一致）；
 * - 姿势 = POSE_JOINT_MAP[pose] 基础角 + object.joints 微调（角度制逐轴
 *   相加），渲染边界统一转弧度；pose 未命中经 resolvePoseId 回落 stand；
 * - 「身体 body」关节（JOINT_GROUPS 首项）应用在脚踝之上的根 group：
 *   整身前倾/转身/侧倾，骨盆/四肢全部随动（名牌不随动，见下）；
 * - 其余新关节 id 直接映射到对应肢体段：torso=脊柱 group、head=头 group、
 *   肩 shoulderL/shoulderR、肘 elbowL/elbowR、髋 hipL/hipR、膝 kneeL/kneeR；
 * - v1 旧关节 id（upperArmL/forearmL/thighL/calfL 等）不再读取：
 *   rotationOf 只查新语义 id，旧键自然静默忽略，不报错、不映射；
 * - 材质：全人偶共享一个 MeshStandardMaterial（color=object.color，
 *   roughness 0.62 / metalness 0.04，取自原型），全部 castShadow；
 * - 头顶名牌：drei Html 屏幕恒定尺寸，锚点头顶上方 0.25m
 *   （y = 体型 height + 0.25），仅 overlays.nameTags 开启且对象可见时渲染；
 *   Html 走 DOM portal 不进 WebGL 画面，仍按辅助对象标记 userData.dsHelper。
 *
 * presentational：选中 / 变换 / gizmo 由外层 SceneObjectNode 处理
 * （CONTRACT §4），本组件不处理交互、不写 store（仅读 overlays.nameTags）。
 */
import { useEffect, useMemo } from "react";
import type { CSSProperties } from "react";
import { MathUtils, MeshStandardMaterial } from "three";
import { Html } from "@react-three/drei";

import { useDirectorStore } from "../store";
import type { MannequinObject, Vec3 } from "../types";
import { BODIES, resolveBodyType } from "./bodies";
import type { BodyProportions } from "./bodies";
import { POSE_JOINT_MAP, POSE_PELVIS_Y, resolvePoseId } from "./poses";
import type { JointId } from "./poses";

const { degToRad } = MathUtils;

/** 男性基准体型：POSE_PELVIS_Y 的基准髋高 / 小件（手脚等）缩放参照 */
const MALE = BODIES.male;

const ZERO: Vec3 = [0, 0, 0];

type Side = "L" | "R";

/* 名牌样式：原型 makeNameSprite 的 DOM 版（深色底圆角 + 角色色描边 + 白字） */
const NAME_TAG_STYLE: CSSProperties = {
  pointerEvents: "none",
  userSelect: "none",
  whiteSpace: "nowrap",
  padding: "4px 11px",
  borderRadius: 8,
  border: "1.5px solid",
  background: "rgba(12,13,16,0.78)",
  color: "#f2f3f5",
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1.4,
  fontFamily: '-apple-system, "PingFang SC", sans-serif',
};

/** 手臂三段：肩关节球 → 上臂 → 肘关节球 → 前臂 → 腕关节球 → 手（左=角色自身左侧，-X） */
function Arm({
  side,
  upper,
  fore,
  body,
  material,
}: {
  side: Side;
  /** 肩关节弧度欧拉角 */
  upper: Vec3;
  /** 肘关节弧度欧拉角 */
  fore: Vec3;
  body: BodyProportions;
  material: MeshStandardMaterial;
}) {
  // 关节球/肢段半径随 limbR，手部小件随整体身高比例
  const lr = body.limbR;
  const s = body.hipY / MALE.hipY;
  return (
    <group position={[side === "L" ? -body.shoulderX : body.shoulderX, body.shoulderRise, 0]} rotation={upper}>
      <mesh material={material} castShadow>
        <sphereGeometry args={[0.062 * lr, 16, 12]} />
      </mesh>
      <mesh material={material} castShadow position={[0, -body.upperArm / 2, 0]}>
        <cylinderGeometry args={[0.052 * lr, 0.045 * lr, body.upperArm, 18]} />
      </mesh>
      <group position={[0, -body.upperArm, 0]} rotation={fore}>
        <mesh material={material} castShadow>
          <sphereGeometry args={[0.048 * lr, 16, 12]} />
        </mesh>
        <mesh material={material} castShadow position={[0, -body.forearm / 2, 0]}>
          <cylinderGeometry args={[0.044 * lr, 0.037 * lr, body.forearm, 18]} />
        </mesh>
        <group position={[0, -body.forearm, 0]}>
          <mesh material={material} castShadow>
            <sphereGeometry args={[0.036 * lr, 16, 12]} />
          </mesh>
          <mesh material={material} castShadow position={[0, -0.085 * s, 0]}>
            <boxGeometry args={[0.055 * s, 0.14 * s, 0.032 * s]} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

/** 腿三段：髋关节球 → 大腿 → 膝关节球 → 小腿 → 踝关节球 → 脚（左=角色自身左侧，-X） */
function Leg({
  side,
  thigh,
  calf,
  body,
  material,
}: {
  side: Side;
  /** 髋关节弧度欧拉角 */
  thigh: Vec3;
  /** 膝关节弧度欧拉角 */
  calf: Vec3;
  body: BodyProportions;
  material: MeshStandardMaterial;
}) {
  const lr = body.limbR;
  const s = body.hipY / MALE.hipY;
  return (
    <group position={[side === "L" ? -body.hipX : body.hipX, 0, 0]} rotation={thigh}>
      <mesh material={material} castShadow>
        <sphereGeometry args={[0.076 * lr, 16, 12]} />
      </mesh>
      <mesh material={material} castShadow position={[0, -body.thigh / 2, 0]}>
        <cylinderGeometry args={[0.075 * lr, 0.058 * lr, body.thigh, 18]} />
      </mesh>
      <group position={[0, -body.thigh, 0]} rotation={calf}>
        <mesh material={material} castShadow>
          <sphereGeometry args={[0.062 * lr, 16, 12]} />
        </mesh>
        <mesh material={material} castShadow position={[0, -body.shin / 2, 0]}>
          <cylinderGeometry args={[0.055 * lr, 0.038 * lr, body.shin, 18]} />
        </mesh>
        <group position={[0, -body.shin, 0]}>
          <mesh material={material} castShadow>
            <sphereGeometry args={[0.044 * lr, 16, 12]} />
          </mesh>
          <mesh material={material} castShadow position={[0, -0.055 * s, 0.048 * s]}>
            <boxGeometry args={[0.078 * s, 0.055 * s, 0.21 * s]} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

export function Mannequin({ object }: { object: MannequinObject }) {
  const showNameTag = useDirectorStore((state) => state.overlays.nameTags);

  // 全人偶共享材质：改色整体原子更新；换色/卸载时释放旧实例
  const material = useMemo(
    () =>
      new MeshStandardMaterial({
        color: object.color,
        roughness: 0.62,
        metalness: 0.04,
      }),
    [object.color]
  );
  useEffect(() => () => material.dispose(), [material]);

  const body = BODIES[resolveBodyType(object.bodyType)];
  const poseId = resolvePoseId(object.pose);
  const poseJoints = POSE_JOINT_MAP[poseId];
  // POSE_PELVIS_Y 以男性髋高 0.92 为基准，按当前体型髋高等比缩放
  const pelvisY = (POSE_PELVIS_Y[poseId] ?? MALE.hipY) * (body.hipY / MALE.hipY);

  // 小件缩放：整体身高比（手/脚/骨盆偏移）；躯干厚度比（颈/肩梁）
  const sizeScale = body.hipY / MALE.hipY;
  const torsoScale = body.torsoR / MALE.torsoR;

  // 关节最终角 = 姿势基础角 + joints 微调（角度制逐轴相加）→ 弧度。
  // 只读 JOINT_GROUPS 的新语义 id；object.joints 里残留的 v1 旧 id
  // （upperArmL 等）在此不被引用，静默忽略。
  const rotationOf = (joint: JointId): Vec3 => {
    const base = poseJoints[joint] ?? ZERO;
    const tweak = object.joints[joint] ?? ZERO;
    return [
      degToRad(base[0] + tweak[0]),
      degToRad(base[1] + tweak[1]),
      degToRad(base[2] + tweak[2]),
    ];
  };

  return (
    <group>
      {/* 身体 body 关节：整身前倾/转身/侧倾，应用在脚踝之上的根 group */}
      <group rotation={rotationOf("body")}>
        {/* 骨盆（根关节，蹲/坐/跪时整体下移） */}
        <group position={[0, pelvisY, 0]}>
          <mesh
            material={material}
            castShadow
            position={[0, 0.03 * sizeScale, 0]}
            scale={[1, 1, 0.62]}
          >
            <cylinderGeometry args={[body.pelvisR * 0.96, body.pelvisR * 1.04, body.pelvisR * 1.21, 20]} />
          </mesh>

          {/* 脊柱（torso 关节） */}
          <group position={[0, body.spineBase, 0]} rotation={rotationOf("torso")}>
            <mesh material={material} castShadow>
              <sphereGeometry args={[0.07 * torsoScale, 16, 12]} />
            </mesh>
            <mesh
              material={material}
              castShadow
              position={[0, body.torsoLen * 0.477, 0]}
              scale={[1, 1, 0.58]}
            >
              <cylinderGeometry args={[body.torsoR, body.torsoR * 0.87, body.torsoLen, 20]} />
            </mesh>
            {/* 肩梁：横向圆柱，让手臂衔接自然 */}
            <mesh
              material={material}
              castShadow
              position={[0, body.shoulderRise, 0]}
              rotation={[0, 0, Math.PI / 2]}
            >
              <cylinderGeometry
                args={[0.056 * torsoScale, 0.056 * torsoScale, body.shoulderX * 2 + 0.02 * sizeScale, 14]}
              />
            </mesh>

            {/* 颈 + 头（微椭圆头型，避免球头玩具感；chibi 颈≈0 头直接坐在躯干上） */}
            <group position={[0, body.torsoLen, 0]}>
              <mesh material={material} castShadow position={[0, 0.03 * sizeScale, 0]}>
                <cylinderGeometry args={[0.048 * torsoScale, 0.055 * torsoScale, 0.09 * sizeScale, 14]} />
              </mesh>
              <group position={[0, body.neckLen, 0]} rotation={rotationOf("head")}>
                <mesh
                  material={material}
                  castShadow
                  position={[0, body.headLift, 0]}
                  scale={[0.94, 1.12, 1]}
                >
                  <sphereGeometry args={[body.headR, 24, 18]} />
                </mesh>
              </group>
            </group>

            <Arm
              side="L"
              upper={rotationOf("shoulderL")}
              fore={rotationOf("elbowL")}
              body={body}
              material={material}
            />
            <Arm
              side="R"
              upper={rotationOf("shoulderR")}
              fore={rotationOf("elbowR")}
              body={body}
              material={material}
            />
          </group>

          <Leg
            side="L"
            thigh={rotationOf("hipL")}
            calf={rotationOf("kneeL")}
            body={body}
            material={material}
          />
          <Leg
            side="R"
            thigh={rotationOf("hipR")}
            calf={rotationOf("kneeR")}
            body={body}
            material={material}
          />
        </group>
      </group>

      {/* 头顶名牌（DOM overlay；不随 body 关节摆动；visible=false 时随对象隐藏） */}
      {showNameTag && object.visible ? (
        <group position={[0, body.height + 0.25, 0]} userData={{ dsHelper: true }}>
          <Html center style={{ pointerEvents: "none" }}>
            <div style={{ ...NAME_TAG_STYLE, borderColor: object.color }}>{object.name}</div>
          </Html>
        </group>
      ) : null}
    </group>
  );
}
