/**
 * 3D 导演台 · 群众阵列（Wave 2 · presentational；v2 多彩个体化 + 逐实例名牌）
 *
 * 签名 `({object}: {object: CrowdObject})`，由 StageCanvas 包进 SceneObjectNode。
 * rows×cols 个简化人偶（单段锥形身 + 球头，刻意与主角关节素模拉开区分度），
 * 以对象原点为中心网格排布，spacing 米间距。
 *
 * 多彩个体化（对齐 LibTV 群众阵列，SPEC §2.2 / §8）：
 * - 逐实例配色：实例 i 取 CROWD_PALETTE[i % 8]（instanceColor 同时写入身体/头
 *   两个 InstancedMesh），索引序 = 行列遍历序，完全确定——rows/cols 变化时
 *   同一索引实例颜色不闪烁；object.color 不再参与实例着色（LibTV 群众本身就是
 *   多彩的，契约字段保留不动）；
 * - 逐实例名牌：rows×cols ≤ 20 且 overlays.nameTags 开时，每个实例头顶显示
 *   「角色A/B/…」（A–Z 字母序，超 26 用 角色A1/A2），名牌描边色 = 该实例色；
 *   >20 实例不渲染名牌（性能）。名牌走 drei Html DOM portal（屏幕恒定尺寸、
 *   pointerEvents:none），不进 WebGL 画面，仍按辅助对象标记 userData.dsHelper；
 * - 成员命名规则由 crowdMemberName 导出，左栏 ObjectListPanel 的群众组
 *   成员清单复用同一份，保证名牌与清单一一对应。
 *
 * 性能：身体 / 头各一个 InstancedMesh（100 个实例也只有 2 次 draw call）；
 * rows / cols / spacing 变化时 args=[undefined, undefined, count] 触发 R3F 重建，
 * useLayoutEffect 重写全部实例矩阵与实例色（含原型的确定性朝向/体型微抖动，避免复制人僵硬感）。
 *
 * 人偶局部空间原点在脚底（总高约 1.36m，比 1.7m 主角素模矮一截）：
 * - 身体：圆柱 r 0.13/0.15 × 高 1.10，实例网格整体抬升 0.55
 * - 头：球 r 0.11，实例网格整体抬升 1.25
 */
import { useLayoutEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";
import { Color, Object3D } from "three";
import type { InstancedMesh } from "three";
import { Html } from "@react-three/drei";

import { useDirectorStore } from "../store";
import type { CrowdObject } from "../types";

const BODY_RADIUS_TOP = 0.13;
const BODY_RADIUS_BOTTOM = 0.15;
const BODY_HEIGHT = 1.1;
const HEAD_RADIUS = 0.11;
const HEAD_Y = 1.25;

/**
 * 群众 8 色调色板（SPEC §2.2 实测/约值）：蓝/红/绿/橙/黄/紫/浅蓝/品红。
 * 紫色在 LibTV 截图中取样噪声大（SPEC 标「未见精确色值」），取近似 #8E5BD6。
 */
export const CROWD_PALETTE = [
  "#4A82E1",
  "#F75353",
  "#34C759",
  "#E7942C",
  "#ECC718",
  "#8E5BD6",
  "#69B0DE",
  "#B600AF",
] as const;

/** 群众成员命名：角色A…角色Z，第 27 个起 角色A1、角色A2…（3D 名牌与左栏成员清单共用） */
export function crowdMemberName(index: number): string {
  return index < 26 ? `角色${String.fromCharCode(65 + index)}` : `角色A${index - 25}`;
}

/** 实例数超过该值不渲染名牌（性能；LibTV 名牌场景均为小型阵列） */
const MAX_NAMED_INSTANCES = 20;

/** 名牌锚点高度：头顶（≈1.36m，含体型抖动上限）上方约 0.24m */
const NAME_TAG_Y = 1.6;

/* 名牌样式：与 Mannequin 头顶名牌一致（深色底圆角 + 实例色描边 + 白字） */
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

export function CrowdArray({ object }: { object: CrowdObject }) {
  const { rows, cols, spacing } = object;
  const count = rows * cols;
  const bodyRef = useRef<InstancedMesh>(null);
  const headRef = useRef<InstancedMesh>(null);
  const showNameTags = useDirectorStore((state) => state.overlays.nameTags);

  useLayoutEffect(() => {
    const bodies = bodyRef.current;
    const heads = headRef.current;
    if (!bodies || !heads) return;

    const dummy = new Object3D();
    const color = new Color();
    let seed = 0;
    let index = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        dummy.position.set(
          (c - (cols - 1) / 2) * spacing,
          0,
          (r - (rows - 1) / 2) * spacing,
        );
        // 按索引确定性微抖动（移植原型 rebuildCrowd）：朝向 ±0.15rad、体型 0.94–1.06
        const jr = Math.sin(seed * 12.9898) * 43758.5453;
        dummy.rotation.set(0, ((jr - Math.floor(jr)) - 0.5) * 0.3, 0);
        const js = Math.sin(seed * 78.233) * 12543.21;
        dummy.scale.setScalar(0.94 + (js - Math.floor(js)) * 0.12);
        dummy.updateMatrix();
        bodies.setMatrixAt(index, dummy.matrix);
        heads.setMatrixAt(index, dummy.matrix);
        // 逐实例配色：palette[index % 8]，同一索引颜色恒定（行列变化不闪烁）
        color.set(CROWD_PALETTE[index % CROWD_PALETTE.length] ?? CROWD_PALETTE[0]);
        bodies.setColorAt(index, color);
        heads.setColorAt(index, color);
        seed++;
        index++;
      }
    }
    bodies.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    if (heads.instanceColor) heads.instanceColor.needsUpdate = true;
    // 实例散布后重算包围球，避免视锥剔除误伤阵列边缘
    bodies.computeBoundingSphere();
    heads.computeBoundingSphere();
  }, [rows, cols, spacing, count]);

  // 名牌锚点：与矩阵逻辑同一套网格散布公式（仅 ≤20 实例时才会被消费渲染）
  const tagAnchors = useMemo(() => {
    const anchors: Array<{ x: number; z: number }> = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        anchors.push({
          x: (c - (cols - 1) / 2) * spacing,
          z: (r - (rows - 1) / 2) * spacing,
        });
      }
    }
    return anchors;
  }, [rows, cols, spacing]);

  return (
    <>
      <instancedMesh
        ref={bodyRef}
        args={[undefined, undefined, count]}
        position={[0, BODY_HEIGHT / 2, 0]}
        castShadow
        receiveShadow
      >
        <cylinderGeometry args={[BODY_RADIUS_TOP, BODY_RADIUS_BOTTOM, BODY_HEIGHT, 10]} />
        {/* 材质保持白色：实例色经 instanceColor 相乘后得到真实调色板色 */}
        <meshStandardMaterial roughness={0.8} />
      </instancedMesh>
      <instancedMesh
        ref={headRef}
        args={[undefined, undefined, count]}
        position={[0, HEAD_Y, 0]}
        castShadow
        receiveShadow
      >
        <sphereGeometry args={[HEAD_RADIUS, 12, 10]} />
        <meshStandardMaterial roughness={0.8} />
      </instancedMesh>

      {/* 逐实例名牌：≤20 实例 + 角色标签开关开（DOM overlay，屏幕恒定尺寸） */}
      {showNameTags && count <= MAX_NAMED_INSTANCES ? (
        <group userData={{ dsHelper: true }}>
          {tagAnchors.map((anchor, index) => (
            <group key={index} position={[anchor.x, NAME_TAG_Y, anchor.z]}>
              <Html center style={{ pointerEvents: "none" }}>
                <div
                  style={{
                    ...NAME_TAG_STYLE,
                    borderColor: CROWD_PALETTE[index % CROWD_PALETTE.length],
                  }}
                >
                  {crowdMemberName(index)}
                </div>
              </Html>
            </group>
          ))}
        </group>
      ) : null}
    </>
  );
}
