/**
 * 3D 导演台 · 素体体型比例参数表（v2 · 素模模块，新建）
 *
 * 对齐 LibTV 添加菜单的 8 种素体（types.ts BODY_TYPES）。每种体型给出一套
 * 完整的人偶几何参数，由 Mannequin.tsx 直接消费（与 HTML 原型 buildFigure
 * 的 P 表逐项对接，male = 原型 1.7m 基准身材的原始数值）：
 *
 * - 角色面朝 +Z；长度单位米；身高指头顶总高（不含名牌）；
 * - hipY 同时是骨盆根关节静止高度：POSE_PELVIS_Y 的蹲坐数值以 male.hipY
 *   为基准，Mannequin 按各体型 hipY 比例缩放；
 * - limbR 是四肢粗细系数（乘到 v1 固定肢段半径上，1 = 男性基准）；
 *   torsoR/pelvisR 直接是躯干/骨盆圆柱半径， torsoLen 为躯干圆柱高；
 * - chibi（二头身 Q 版）靠同一套参数实现「头大身小」：头半径 ≈0.24
 *   （头高占全身约一半）、躯干/四肢短、颈几乎为零，无需独立结构分支。
 */
import type { BodyTypeId } from "../types";

export interface BodyProportions {
  /** 头顶总高（米，参考值；名牌锚点 = height + 0.25） */
  height: number;
  /** 骨盆根关节静止高度（= 髋高；蹲坐姿势按 hipY/male.hipY 缩放） */
  hipY: number;
  /** 肩半宽（肩关节到身体中线） */
  shoulderX: number;
  /** 髋半宽（髋关节到身体中线） */
  hipX: number;
  /** 上臂长 */
  upperArm: number;
  /** 前臂长 */
  forearm: number;
  /** 大腿长 */
  thigh: number;
  /** 小腿长 */
  shin: number;
  /** 脊柱关节相对骨盆根的高度（原型 0.10） */
  spineBase: number;
  /** 躯干圆柱高（脊柱关节 → 颈关节；肩梁位于其顶端附近） */
  torsoLen: number;
  /** 肩关节相对脊柱关节的高度（原型 0.415 ≈ torsoLen - 0.025） */
  shoulderRise: number;
  /** 颈关节 → 头关节的距离（chibi 头直接坐在躯干上，取极小值） */
  neckLen: number;
  /** 头网格中心相对头关节的上抬量 */
  headLift: number;
  /** 头半径（椭圆头基准球半径，渲染时 scale [0.94,1.12,1]） */
  headR: number;
  /** 躯干圆柱半径（顶端；底端取 0.87×，前后压扁 0.58） */
  torsoR: number;
  /** 骨盆圆柱半径（中值；前后压扁 0.62） */
  pelvisR: number;
  /** 四肢粗细系数（乘到肢段/关节球/颈半径上，1 = 男性基准） */
  limbR: number;
}

/**
 * 8 种体型比例表。male 数值 = HTML 原型 buildFigure 原始 P 表（总高 ≈1.76m）；
 * 其余按相对关系设定：female 略矮窄肩宽骨盆、wide 加宽加厚、muscular 肩宽臂粗、
 * slim 纤细、teen ≈1.55m、child ≈1.15m、chibi 二头身 Q 版（头大身小）。
 */
export const BODIES: Record<BodyTypeId, BodyProportions> = {
  /* 男性素体：原型 1.7m 基准身材 */
  male: {
    height: 1.76,
    hipY: 0.92,
    shoulderX: 0.195,
    hipX: 0.095,
    upperArm: 0.3,
    forearm: 0.27,
    thigh: 0.44,
    shin: 0.38,
    spineBase: 0.1,
    torsoLen: 0.44,
    shoulderRise: 0.415,
    neckLen: 0.08,
    headLift: 0.1,
    headR: 0.108,
    torsoR: 0.155,
    pelvisR: 0.14,
    limbR: 1,
  },
  /* 女性素体：略矮、窄肩、骨盆略宽、肢体更细 */
  female: {
    height: 1.64,
    hipY: 0.86,
    shoulderX: 0.175,
    hipX: 0.105,
    upperArm: 0.28,
    forearm: 0.25,
    thigh: 0.41,
    shin: 0.35,
    spineBase: 0.1,
    torsoLen: 0.4,
    shoulderRise: 0.375,
    neckLen: 0.075,
    headLift: 0.095,
    headR: 0.102,
    torsoR: 0.14,
    pelvisR: 0.145,
    limbR: 0.88,
  },
  /* 宽厚素体：骨架与厚度全面加大 */
  wide: {
    height: 1.78,
    hipY: 0.93,
    shoulderX: 0.23,
    hipX: 0.115,
    upperArm: 0.3,
    forearm: 0.27,
    thigh: 0.44,
    shin: 0.38,
    spineBase: 0.1,
    torsoLen: 0.45,
    shoulderRise: 0.425,
    neckLen: 0.08,
    headLift: 0.1,
    headR: 0.11,
    torsoR: 0.19,
    pelvisR: 0.175,
    limbR: 1.25,
  },
  /* 健壮素体：肩宽臂粗、倒三角（骨盆不随肩加宽） */
  muscular: {
    height: 1.82,
    hipY: 0.95,
    shoulderX: 0.24,
    hipX: 0.1,
    upperArm: 0.31,
    forearm: 0.28,
    thigh: 0.45,
    shin: 0.39,
    spineBase: 0.1,
    torsoLen: 0.46,
    shoulderRise: 0.435,
    neckLen: 0.08,
    headLift: 0.1,
    headR: 0.11,
    torsoR: 0.18,
    pelvisR: 0.15,
    limbR: 1.35,
  },
  /* 纤细素体：身高接近男性、围度全面收窄 */
  slim: {
    height: 1.7,
    hipY: 0.9,
    shoulderX: 0.18,
    hipX: 0.088,
    upperArm: 0.29,
    forearm: 0.26,
    thigh: 0.43,
    shin: 0.37,
    spineBase: 0.1,
    torsoLen: 0.43,
    shoulderRise: 0.405,
    neckLen: 0.075,
    headLift: 0.1,
    headR: 0.104,
    torsoR: 0.135,
    pelvisR: 0.125,
    limbR: 0.8,
  },
  /* 少年素体：≈1.55m，头身比略大、围度偏小 */
  teen: {
    height: 1.55,
    hipY: 0.82,
    shoulderX: 0.17,
    hipX: 0.085,
    upperArm: 0.26,
    forearm: 0.235,
    thigh: 0.39,
    shin: 0.33,
    spineBase: 0.09,
    torsoLen: 0.38,
    shoulderRise: 0.355,
    neckLen: 0.07,
    headLift: 0.095,
    headR: 0.104,
    torsoR: 0.135,
    pelvisR: 0.12,
    limbR: 0.85,
  },
  /* 儿童素体：≈1.15m，头相对更大、四肢短 */
  child: {
    height: 1.15,
    hipY: 0.56,
    shoulderX: 0.13,
    hipX: 0.07,
    upperArm: 0.19,
    forearm: 0.17,
    thigh: 0.26,
    shin: 0.21,
    spineBase: 0.065,
    torsoLen: 0.25,
    shoulderRise: 0.235,
    neckLen: 0.06,
    headLift: 0.085,
    headR: 0.095,
    torsoR: 0.105,
    pelvisR: 0.095,
    limbR: 0.7,
  },
  /* 二头身 Q 版：头高约占全身一半、颈几乎为零、短粗四肢 */
  chibi: {
    height: 1.04,
    hipY: 0.24,
    shoulderX: 0.14,
    hipX: 0.08,
    upperArm: 0.1,
    forearm: 0.09,
    thigh: 0.11,
    shin: 0.09,
    spineBase: 0.045,
    torsoLen: 0.15,
    shoulderRise: 0.14,
    neckLen: 0.02,
    headLift: 0.045,
    headR: 0.24,
    torsoR: 0.14,
    pelvisR: 0.13,
    limbR: 1.1,
  },
};

/** 解析体型 id：精确命中 BODIES，未命中（旧数据/脏数据）回落 male */
export function resolveBodyType(bodyType: string): BodyTypeId {
  return bodyType in BODIES ? (bodyType as BodyTypeId) : "male";
}
