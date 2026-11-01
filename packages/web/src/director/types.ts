/**
 * 3D 导演台 · 领域类型契约（Wave 1 冻结）
 *
 * Wave 2 各模块（scene/ ui/ export/）只读本文件，不修改。
 * 如需调整先找 Wave 1 对齐，避免接口漂移。
 *
 * 全局约定：
 * - 长度单位：米（米制网格，1 格 = 1m）
 * - 角度单位：度（store 内所有 rotation / joints 一律角度制欧拉角，XYZ 顺序；
 *   只在渲染边界（SceneObjectNode / 各 Node 组件）转换为 three 需要的弧度）
 * - 颜色统一 "#RRGGBB" 大写 hex 字符串
 */

export type Vec3 = [number, number, number];

/* ──────────────────────────── 变换 ──────────────────────────── */

export interface Transform {
  /** 世界坐标，米 */
  position: Vec3;
  /** 欧拉角 [x, y, z]，角度制，XYZ 顺序（three 默认顺序） */
  rotation: Vec3;
  scale: Vec3;
}

/* ──────────────────────────── 对象种类 ──────────────────────────── */

export type ObjectKind = "mannequin" | "geometry" | "crowd" | "model" | "camera";

export const OBJECT_KIND_LABELS: Record<ObjectKind, string> = {
  mannequin: "人体素模",
  geometry: "几何体",
  crowd: "群众阵列",
  model: "自定义模型",
  camera: "机位",
};

interface BaseObject {
  id: string;
  name: string;
  type: ObjectKind;
  visible: boolean;
  /**
   * 对象变换。约定：group 原点 = 对象落地中心点（y=0 为地面），
   * 素模 / 几何体网格在局部空间内自行抬升（与 HTML 原型一致）。
   */
  transform: Transform;
}

/* ──────────────────────────── 人体素模 ──────────────────────────── */

/**
 * 素体体型（v2，对齐 LibTV 添加菜单的 8 种素体）。
 * 每种体型的比例参数（身高/肩宽/头身比等）由 scene/bodies.ts 拥有并解释。
 */
export type BodyTypeId =
  | "male"
  | "female"
  | "wide"
  | "muscular"
  | "slim"
  | "teen"
  | "child"
  | "chibi";

export const BODY_TYPES: ReadonlyArray<{ id: BodyTypeId; label: string }> = [
  { id: "male", label: "男性素体" },
  { id: "female", label: "女性素体" },
  { id: "wide", label: "宽厚素体" },
  { id: "muscular", label: "健壮素体" },
  { id: "slim", label: "纤细素体" },
  { id: "teen", label: "少年素体" },
  { id: "child", label: "儿童素体" },
  { id: "chibi", label: "二头身" },
];

export interface MannequinObject extends BaseObject {
  type: "mannequin";
  /** 素体体型，决定人偶比例（bodies.ts 查表，未命中回落 male） */
  bodyType: BodyTypeId;
  /** 素模整体配色，"#RRGGBB" */
  color: string;
  /**
   * 姿势预设 id。预设表由 scene/MannequinNode 模块拥有并解释
   * （移植 HTML 原型的 POSES 表：站立/半蹲/坐姿/对峙/回头/行进/观察/指向，
   * 未命中时实现方必须回落到「站立」而不是报错）。
   */
  pose: string;
  /**
   * 关节微调：关节 id → [rx, ry, rz] 角度偏移，叠加在姿势预设之上。
   * 关节 id 集合由素模模块的关节表定义（原型 JOINT_TWEAKS：
   * head/torso/armL/armR/foreL/foreR/thighL/thighR/shinL/shinR 等）。
   */
  joints: Record<string, Vec3>;
}

/* ──────────────────────────── 几何体 ──────────────────────────── */

export type GeometryShape = "box" | "sphere" | "cylinder" | "cone" | "torus" | "plane";

export const GEOMETRY_SHAPES: readonly GeometryShape[] = [
  "box",
  "sphere",
  "cylinder",
  "cone",
  "torus",
  "plane",
];

export interface GeometryObject extends BaseObject {
  type: "geometry";
  shape: GeometryShape;
  color: string;
  /**
   * 尺寸 [x, y, z]，米。语义按 shape 解释（box=[宽,高,深]，sphere 用 x 作直径，
   * cylinder/cone 用 [直径,高,直径]，plane 用 [宽, -, 深]，torus 用 [外径, 管径, -]），
   * 具体映射由 scene/GeometryNode 实现并在其文件头注明。
   */
  size: Vec3;
}

/* ──────────────────────────── 群众阵列 ──────────────────────────── */

export interface CrowdObject extends BaseObject {
  type: "crowd";
  rows: number;
  cols: number;
  /** 人偶间距，米 */
  spacing: number;
  color: string;
}

/* ──────────────────────────── 上传模型 ──────────────────────────── */

export interface UploadedModelObject extends BaseObject {
  type: "model";
  /** URL.createObjectURL 产生的浏览器内地址（不落库、刷新即失效） */
  assetUrl: string;
  fileName: string;
}

/* ──────────────────────────── 机位 ──────────────────────────── */

/** 全画幅等效焦距（mm），与 LibTV 的 5 档一致 */
export type FocalLength = 16 | 24 | 35 | 50 | 85;

export const FOCAL_LENGTHS: readonly FocalLength[] = [16, 24, 35, 50, 85];

export interface CameraObject extends BaseObject {
  type: "camera";
  focalLength: FocalLength;
  /**
   * 注视点（世界坐标，米）。机身朝向由 transform.position → target 推导，
   * 因此 CameraObject 的 transform.rotation 不使用（恒为 [0,0,0]），
   * gizmo 也只允许 translate（SceneObjectNode 已强制）。
   */
  target: Vec3;
}

/* ──────────────────────────── 联合类型与类型守卫 ──────────────────────────── */

export type SceneObject =
  | MannequinObject
  | GeometryObject
  | CrowdObject
  | UploadedModelObject
  | CameraObject;

export function isMannequinObject(object: SceneObject): object is MannequinObject {
  return object.type === "mannequin";
}

export function isGeometryObject(object: SceneObject): object is GeometryObject {
  return object.type === "geometry";
}

export function isCrowdObject(object: SceneObject): object is CrowdObject {
  return object.type === "crowd";
}

export function isUploadedModelObject(object: SceneObject): object is UploadedModelObject {
  return object.type === "model";
}

export function isCameraObject(object: SceneObject): object is CameraObject {
  return object.type === "camera";
}

/* ──────────────────────────── 视图 / 环境 / 工具状态 ──────────────────────────── */

/** director=导演视角（自由环绕）；camera=机位视角（活动机位 WYSIWYG 构图） */
export type ViewMode = "director" | "camera";

/**
 * 画幅（v3，对齐 LibTV 比例选择器 7 档）。
 * auto=跟随视口比例（机位相机用画布实际 aspect；导出按 16:9 处理）。
 */
export type AspectRatio = "auto" | "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";

/** 画幅数值（宽/高）。auto 为计算回退值 16/9，语义见上 */
export const ASPECT_RATIO_VALUE: Record<AspectRatio, number> = {
  auto: 16 / 9,
  "21:9": 21 / 9,
  "16:9": 16 / 9,
  "4:3": 4 / 3,
  "1:1": 1,
  "3:4": 3 / 4,
  "9:16": 9 / 16,
};

/** 灯光/天空环境预设，预设参数由 env-presets.ts 拥有（S8-7 扩为十档，原移植原型 ENV_PRESETS） */
export type EnvironmentName =
  | "studio"
  | "indoor_warm"
  | "night_cold"
  | "candlelight"
  | "day_clear"
  | "dusk"
  | "overcast_soft"
  | "moonlight"
  | "backlit_silhouette"
  | "neon_night";

/**
 * 场景级设置（v2，对应 LibTV「3D场景」面板）。
 * 与 environment 的关系：environment 只管灯光/雾的氛围预设，
 * skyColor 是独立的背景色，setEnvironment 不回写 skyColor。
 */
export interface SceneSettings {
  /** 天空/视口背景色 "#RRGGBB"（panoramaUrl 存在时被全景球取代） */
  skyColor: string;
  /** 地面显隐 */
  groundVisible: boolean;
  /** 地面不透明度 0-1 */
  groundOpacity: number;
  /** 网格吸附：平移 0.25m、旋转 15°（SceneObjectNode 的 TransformControls 消费） */
  gridSnap: boolean;
  /**
   * 全景背景图（equirect 2:1，URL.createObjectURL 的浏览器内地址，本地会话有效）。
   * null = 用 skyColor 纯色天空。全景球是场景内容，导出截图时保留（不是 dsHelper）。
   */
  panoramaUrl: string | null;
  /** 全景球水平旋转，角度制 0-360 */
  panoramaRotation: number;
  /** 全景球半径，米 */
  panoramaRadius: number;
}

export type GizmoMode = "translate" | "rotate" | "scale";

export type OverlayKey = "thirds" | "center" | "safeArea" | "nameTags";

export type OverlayFlags = Record<OverlayKey, boolean>;
