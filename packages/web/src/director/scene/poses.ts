/**
 * 3D 导演台 · 素模姿势预设与语义关节树（v2 · 素模模块）
 *
 * v2 变更（对齐 LibTV SPEC §9）：
 * - POSE_PRESETS 8 → 20（SPEC §9.1，id/中文标签逐字对齐，顺序 = UI 4列×5行 网格顺序）；
 * - 关节 id 全面语义化（SPEC §9.2）：身体 body / 躯干 torso / 头部 head /
 *   肩 shoulderL·shoulderR / 肘 elbowL·elbowR / 髋 hipL·hipR / 膝 kneeL·kneeR，
 *   与 HTML 原型 rig 名（spine/shoulder/elbow/hip/knee）一一对应；
 * - 新增 JOINT_GROUPS 语义关节树：每项 {id,label,side?,axes:[{axis,label,min,max}]}，
 *   label 相同且相邻的项在 UI 上归为一组（手臂—肩/肘部/腿部—髋/膝部 左右成对）；
 * - v1 关节 id（upperArmL/forearmL/thighL/calfL 等）废弃：v1 预设数值即原型
 *   shoulder/elbow/hip/knee 原始数据，改键名后语义不变（见 POSE_JOINT_MAP 头注）。
 *
 * 约定：
 * - 角度全部是角度制欧拉角 [rx, ry, rz]（XYZ 顺序），弧度转换在渲染边界
 *   （Mannequin.tsx）完成；角色面朝 +Z（脚朝向 +Z）：
 *   · 躯干/身体前倾 = +x；肩前举 / 髋前抬 / 肘弯曲 = -x；膝弯曲 = +x；
 *   · 左侧外展 = -z、右侧外展 = +z（与原型 stand 的 ±5° A-pose 一致）；
 * - 原型的 pelvisY（蹲/坐/跪时骨盆根关节下移）不进关节表，单独放在
 *   POSE_PELVIS_Y；数值以男性基准髋高（bodies.ts BODIES.male.hipY=0.92）为基准，
 *   其他体型由 Mannequin 按比例缩放，未列出的姿势用该体型自身髋高；
 * - MannequinObject.pose 未命中时必须回落 stand（CONTRACT §3），
 *   resolvePoseId 同时兼容 v2 中文标签、v1 id 与 v1 中文标签。
 *
 * 量程说明（JOINT_GROUPS.axes.min/max，人体工学）：
 * - 肘/膝为单向关节：膝 +x 弯曲取 0..145；肘的解剖屈曲方向为 -x，故量程
 *   写作 -145..0（幅度 145，方向如实保留原始欧拉角符号，与预设数据同空间）；
 * - 肩扭转 ±90、髋扭转 ±45；肩前举 -170..60（后摆 60）；
 * - 左右外展量程符号相反（左负右正），滑杆值即关节角真值，不做镜像换算。
 */
import type { Vec3 } from "../types";

/* ──────────────────────────── id 与类型 ──────────────────────────── */

export type PoseId =
  | "stand"
  | "tpose"
  | "walk"
  | "run"
  | "sit"
  | "squat"
  | "kneelOne"
  | "kneelBoth"
  | "akimbo"
  | "lean"
  | "bow"
  | "think"
  | "fight"
  | "kick"
  | "throw"
  | "push"
  | "wave"
  | "reach"
  | "foldedArms"
  | "phone";

/** 语义关节 id（SPEC §9.2）；body = 整身（应用在脚踝之上的根 group，见 Mannequin） */
export type JointId =
  | "body"
  | "torso"
  | "head"
  | "shoulderL"
  | "shoulderR"
  | "elbowL"
  | "elbowR"
  | "hipL"
  | "hipR"
  | "kneeL"
  | "kneeR";

export interface PosePreset {
  id: PoseId;
  label: string;
}

/** 单轴定义：axis 为欧拉角分量下标（0=x 1=y 2=z），min/max 为角度制量程 */
export interface JointAxisDef {
  axis: 0 | 1 | 2;
  label: string;
  min: number;
  max: number;
}

/** 语义关节树节点（JOINT_GROUPS 项）；label 相同且相邻的项 UI 归为一组 */
export interface JointGroupDef {
  id: JointId;
  /** 组名：身体/躯干/头部/手臂—肩/肘部/腿部—髋/膝部 */
  label: string;
  /** 左右 badge（身体/躯干/头部无） */
  side?: "L" | "R";
  axes: JointAxisDef[];
}

/** 扁平关节项（v1 兼容视图，barrel 旧导出保留；新代码请用 JOINT_GROUPS） */
export interface JointDef {
  id: JointId;
  label: string;
}

/* ──────────────────────────── 姿势预设（SPEC §9.1） ──────────────────────────── */

/** 姿势预设清单（顺序 = UI 4列×5行 网格顺序，逐字对齐 SPEC §9.1） */
export const POSE_PRESETS: PosePreset[] = [
  { id: "stand", label: "站立" },
  { id: "tpose", label: "T型" },
  { id: "walk", label: "行走" },
  { id: "run", label: "跑步" },
  { id: "sit", label: "坐姿" },
  { id: "squat", label: "蹲下" },
  { id: "kneelOne", label: "单膝跪" },
  { id: "kneelBoth", label: "双膝跪" },
  { id: "akimbo", label: "叉腰" },
  { id: "lean", label: "倚靠" },
  { id: "bow", label: "鞠躬" },
  { id: "think", label: "思考" },
  { id: "fight", label: "格斗" },
  { id: "kick", label: "踢球" },
  { id: "throw", label: "投掷" },
  { id: "push", label: "推进" },
  { id: "wave", label: "招手" },
  { id: "reach", label: "伸手" },
  { id: "foldedArms", label: "抱臂" },
  { id: "phone", label: "看手机" },
];

/* ──────────────────────────── 语义关节树（SPEC §9.2） ──────────────────────────── */

/**
 * 语义关节树（顺序 = UI 姿势调节区渲染顺序；左右成对相邻，左先右后）。
 * 量程见文件头说明；滑杆值 = 关节欧拉角真值（角度制）。
 */
export const JOINT_GROUPS: JointGroupDef[] = [
  {
    id: "body",
    label: "身体",
    axes: [
      { axis: 0, label: "前倾", min: -45, max: 45 },
      { axis: 1, label: "转身", min: -90, max: 90 },
      { axis: 2, label: "侧倾", min: -30, max: 30 },
    ],
  },
  {
    id: "torso",
    label: "躯干",
    axes: [
      { axis: 0, label: "前倾", min: -30, max: 45 },
      { axis: 1, label: "扭转", min: -45, max: 45 },
      { axis: 2, label: "侧倾", min: -30, max: 30 },
    ],
  },
  {
    id: "head",
    label: "头部",
    axes: [
      { axis: 0, label: "点头", min: -45, max: 45 },
      { axis: 1, label: "转头", min: -80, max: 80 },
      { axis: 2, label: "歪头", min: -30, max: 30 },
    ],
  },
  {
    id: "shoulderL",
    label: "手臂—肩",
    side: "L",
    axes: [
      { axis: 0, label: "前举", min: -170, max: 60 },
      { axis: 2, label: "外展", min: -100, max: 30 },
      { axis: 1, label: "扭转", min: -90, max: 90 },
    ],
  },
  {
    id: "shoulderR",
    label: "手臂—肩",
    side: "R",
    axes: [
      { axis: 0, label: "前举", min: -170, max: 60 },
      { axis: 2, label: "外展", min: -30, max: 100 },
      { axis: 1, label: "扭转", min: -90, max: 90 },
    ],
  },
  {
    id: "elbowL",
    label: "肘部",
    side: "L",
    axes: [{ axis: 0, label: "弯曲", min: -145, max: 0 }],
  },
  {
    id: "elbowR",
    label: "肘部",
    side: "R",
    axes: [{ axis: 0, label: "弯曲", min: -145, max: 0 }],
  },
  {
    id: "hipL",
    label: "腿部—髋",
    side: "L",
    axes: [
      { axis: 0, label: "前抬", min: -130, max: 45 },
      { axis: 2, label: "外展", min: -60, max: 30 },
      { axis: 1, label: "扭转", min: -45, max: 45 },
    ],
  },
  {
    id: "hipR",
    label: "腿部—髋",
    side: "R",
    axes: [
      { axis: 0, label: "前抬", min: -130, max: 45 },
      { axis: 2, label: "外展", min: -30, max: 60 },
      { axis: 1, label: "扭转", min: -45, max: 45 },
    ],
  },
  {
    id: "kneeL",
    label: "膝部",
    side: "L",
    axes: [{ axis: 0, label: "弯曲", min: 0, max: 145 }],
  },
  {
    id: "kneeR",
    label: "膝部",
    side: "R",
    axes: [{ axis: 0, label: "弯曲", min: 0, max: 145 }],
  },
];

/**
 * 扁平关节清单（v1 JOINTS 兼容视图，仅供 barrel 旧导出；
 * UI 一律走 JOINT_GROUPS）。
 */
export const JOINTS: JointDef[] = JOINT_GROUPS.map((group) => ({
  id: group.id,
  label: group.side === "L" ? `左${group.label}` : group.side === "R" ? `右${group.label}` : group.label,
}));

/* ──────────────────────────── 姿势关节角表 ──────────────────────────── */

/**
 * 姿势 → 关节基础角（角度制 [rx,ry,rz]，未列出的关节为 [0,0,0]）。
 * stand/walk/sit/squat/fight/think/reach 的数值移植自 HTML 原型 POSES 表
 * （原型键名 shoulder/elbow/hip/knee/spine 改用语义 id），其余按人体常识设定。
 */
export const POSE_JOINT_MAP: Record<PoseId, Partial<Record<JointId, Vec3>>> = {
  /* 站立：原型「站立」，双臂微张 A-pose */
  stand: {
    shoulderL: [0, 0, -5],
    shoulderR: [0, 0, 5],
  },
  /* T型：双臂侧平举（外展 ±90），绑骨/摆位基准姿势 */
  tpose: {
    shoulderL: [0, 0, -90],
    shoulderR: [0, 0, 90],
    elbowL: [-5, 0, 0],
    elbowR: [-5, 0, 0],
  },
  /* 行走：原型「行进」，左腿前迈右腿后蹬、双臂对摆 */
  walk: {
    hipL: [-28, 0, 0],
    kneeL: [12, 0, 0],
    hipR: [24, 0, 0],
    kneeR: [38, 0, 0],
    shoulderL: [22, 0, -4],
    shoulderR: [-24, 0, 4],
    elbowR: [-20, 0, 0],
    torso: [4, 0, 0],
  },
  /* 跑步：行走幅度加大 + 双肘屈起 + 躯干前倾 */
  run: {
    torso: [12, 0, 0],
    head: [-6, 0, 0],
    hipL: [-48, 0, 0],
    kneeL: [22, 0, 0],
    hipR: [32, 0, 0],
    kneeR: [75, 0, 0],
    shoulderL: [38, 0, -6],
    elbowL: [-70, 0, 0],
    shoulderR: [-42, 0, 6],
    elbowR: [-85, 0, 0],
  },
  /* 坐姿：原型「坐姿」，髋膝各约 90°，小臂搭腿 */
  sit: {
    hipL: [-88, 0, 0],
    hipR: [-88, 0, 0],
    kneeL: [88, 0, 0],
    kneeR: [88, 0, 0],
    torso: [7, 0, 0],
    shoulderL: [-16, 0, -4],
    shoulderR: [-16, 0, 4],
    elbowL: [-20, 0, 0],
    elbowR: [-20, 0, 0],
  },
  /* 蹲下：原型「半蹲」，深蹲膝过髋、躯干补偿前倾、双臂前平举保持平衡 */
  squat: {
    hipL: [-80, 0, 0],
    hipR: [-80, 0, 0],
    kneeL: [85, 0, 0],
    kneeR: [85, 0, 0],
    torso: [15, 0, 0],
    shoulderL: [-32, 0, -4],
    shoulderR: [-32, 0, 4],
    elbowL: [-14, 0, 0],
    elbowR: [-14, 0, 0],
  },
  /* 单膝跪：右膝触地、左腿前跨踩实（pelvisY 0.48 = 小腿+踝高） */
  kneelOne: {
    hipL: [-85, 0, 0],
    kneeL: [90, 0, 0],
    hipR: [15, 0, 0],
    kneeR: [100, 0, 0],
    torso: [6, 0, 0],
    shoulderL: [-20, 0, -6],
    shoulderR: [-20, 0, 6],
    elbowL: [-20, 0, 0],
    elbowR: [-20, 0, 0],
  },
  /* 双膝跪：双小腿贴地、躯干直立（pelvisY 0.44 ≈ 大腿长） */
  kneelBoth: {
    hipL: [8, 0, 0],
    hipR: [8, 0, 0],
    kneeL: [95, 0, 0],
    kneeR: [95, 0, 0],
    torso: [4, 0, 0],
    shoulderL: [-15, 0, -5],
    shoulderR: [-15, 0, 5],
    elbowL: [-12, 0, 0],
    elbowR: [-12, 0, 0],
  },
  /* 叉腰：双肘外张屈曲、手抵髋部，站姿略开 */
  akimbo: {
    torso: [4, 0, 0],
    shoulderL: [-12, 0, -22],
    elbowL: [-78, -18, 0],
    shoulderR: [-12, 0, 22],
    elbowR: [-78, 18, 0],
  },
  /* 倚靠：整身侧倾（body 关节）+ 一腿微屈交叠、一臂弯起 */
  lean: {
    body: [0, 0, 6],
    torso: [-6, 0, -4],
    head: [0, 0, -4],
    hipR: [-20, 0, 6],
    kneeR: [30, 0, 0],
    shoulderL: [0, 0, -8],
    elbowL: [-15, 0, 0],
    shoulderR: [10, 0, 10],
    elbowR: [-40, 0, 0],
  },
  /* 鞠躬：躯干大幅前倾、头微低、双臂垂放腿侧 */
  bow: {
    body: [8, 0, 0],
    torso: [50, 0, 0],
    head: [10, 0, 0],
    hipL: [8, 0, 0],
    hipR: [8, 0, 0],
    shoulderL: [-25, 0, -4],
    shoulderR: [-25, 0, 4],
    elbowL: [-8, 0, 0],
    elbowR: [-8, 0, 0],
  },
  /* 思考：原型「观察」的手抵下颌意象 + 低头偏头、左臂横抱 */
  think: {
    torso: [6, 0, 0],
    head: [12, 0, -4],
    shoulderL: [-20, 0, -8],
    elbowL: [-75, 0, 0],
    shoulderR: [-40, -10, 12],
    elbowR: [-110, 0, 0],
  },
  /* 格斗：原型「对峙」基础 + 双拳护颌、前后站架（pelvisY 0.86 微沉） */
  fight: {
    torso: [12, 8, 0],
    head: [-4, 0, 0],
    shoulderL: [-30, -10, -10],
    elbowL: [-95, 0, 0],
    shoulderR: [-25, 10, 10],
    elbowR: [-90, 0, 0],
    hipL: [-15, 0, -4],
    kneeL: [18, 0, 0],
    hipR: [10, 0, 4],
    kneeR: [12, 0, 0],
  },
  /* 踢球：右腿前踢、左腿支撑微屈、双臂展开维持平衡（pelvisY 0.88） */
  kick: {
    torso: [-10, 0, 0],
    hipR: [-75, 0, 5],
    kneeR: [30, 0, 0],
    hipL: [-6, 0, 0],
    kneeL: [12, 0, 0],
    shoulderL: [-20, 0, -35],
    elbowL: [-25, 0, 0],
    shoulderR: [-30, 0, 20],
    elbowR: [-45, 0, 0],
  },
  /* 投掷：右臂后引蓄力、左臂前指、躯干扭转、前后弓步 */
  throw: {
    torso: [5, 15, 0],
    head: [0, -8, 0],
    shoulderR: [25, -15, 40],
    elbowR: [-70, 0, 0],
    shoulderL: [-55, 0, -10],
    elbowL: [-15, 0, 0],
    hipL: [-20, 0, 0],
    kneeL: [15, 0, 0],
    hipR: [12, 0, 0],
    kneeR: [8, 0, 0],
  },
  /* 推进：双臂前推、整身前倾、前后箭步（pelvisY 0.85） */
  push: {
    body: [6, 0, 0],
    torso: [18, 0, 0],
    shoulderL: [-70, 0, -8],
    elbowL: [-15, 0, 0],
    shoulderR: [-70, 0, 8],
    elbowR: [-15, 0, 0],
    hipL: [-30, 0, 0],
    kneeL: [25, 0, 0],
    hipR: [18, 0, 0],
    kneeR: [20, 0, 0],
  },
  /* 招手：右臂高举挥动、头转向来向 */
  wave: {
    torso: [0, -6, 0],
    head: [0, -6, 0],
    shoulderR: [-150, 0, 15],
    elbowR: [-25, 0, 0],
    shoulderL: [0, 0, -6],
    elbowL: [-10, 0, 0],
  },
  /* 伸手：原型「指向」基础 + 躯干前倾探出 */
  reach: {
    torso: [10, -6, 0],
    head: [0, -8, 0],
    shoulderL: [-4, 0, -5],
    shoulderR: [-75, 0, 8],
    elbowR: [-10, 0, 0],
  },
  /* 抱臂：双臂交叉抱胸、躯干微后仰 */
  foldedArms: {
    torso: [-4, 0, 0],
    head: [4, 0, 0],
    shoulderL: [-35, -15, -10],
    elbowL: [-100, 0, 0],
    shoulderR: [-35, 15, 10],
    elbowR: [-100, 0, 0],
  },
  /* 看手机：低头 + 右手抬至面前、左手自然下垂 */
  phone: {
    torso: [8, 0, 0],
    head: [28, 0, 0],
    shoulderR: [-50, 0, 8],
    elbowR: [-105, -10, 0],
    shoulderL: [0, 0, -5],
    elbowL: [-10, 0, 0],
  },
};

/**
 * 触地/沉髋姿势的骨盆根关节高度（米，男性基准髋高 0.92 体系；
 * 其他体型由 Mannequin 按 hipY 比例缩放）。未列出的姿势用该体型自身髋高。
 */
export const POSE_PELVIS_Y: Partial<Record<PoseId, number>> = {
  sit: 0.46,
  squat: 0.58,
  kneelOne: 0.48,
  kneelBoth: 0.44,
  fight: 0.86,
  kick: 0.88,
  push: 0.85,
};

/* ──────────────────────────── 兼容解析 ──────────────────────────── */

/**
 * v1 id / v1 中文标签 → v2 id 映射（v1 预设与 v2 的语义对应选择）：
 * - crouch/半蹲 → squat（蹲下，数值同源）
 * - confront/对峙 → fight（格斗，v2 对峙类即格斗架式）
 * - lookback/回头 → think（v2 无回头类；思考带最明显的头部转动，回落最接近）
 * - observe/观察 → think（原型「观察」即手抵下颌，与思考同构）
 * - point/指向 → reach（伸手，同为单臂前伸）
 * v1 的 stand/sit/walk 与 v2 同 id，v1 标签 站立/坐姿 与 v2 相同，
 * 均由精确匹配与标签匹配覆盖；v1 标签「行进」与 v2「行走」字面不同，需别名。
 */
const LEGACY_POSE_ALIASES: Record<string, PoseId> = {
  crouch: "squat",
  confront: "fight",
  lookback: "think",
  observe: "think",
  point: "reach",
  半蹲: "squat",
  对峙: "fight",
  回头: "think",
  行进: "walk",
  观察: "think",
  指向: "reach",
};

/**
 * 解析姿势 id：v2 id 精确命中 → v2 中文标签（store 种子场景 pose 写的是「站立」）
 * → v1 id / v1 中文标签（LEGACY_POSE_ALIASES）→ 回落 stand（CONTRACT §3）。
 */
export function resolvePoseId(pose: string): PoseId {
  if (pose in POSE_JOINT_MAP) return pose as PoseId;
  const byLabel = POSE_PRESETS.find((preset) => preset.label === pose);
  if (byLabel) return byLabel.id;
  return LEGACY_POSE_ALIASES[pose] ?? "stand";
}
