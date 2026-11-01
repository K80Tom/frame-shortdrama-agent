/**
 * 3D 导演台 · 场景快照序列化（store SceneStateSlice ⇄ 后端 SceneSnapshot）
 *
 * 后端合同见 contracts.ts（sceneSnapshotSchema / SceneSnapshot）：
 * - objects/cameras 分数组存放；Vec3 是 {x,y,z} 对象（store 是 [x,y,z] 元组）；
 * - pose 是 { preset } 对象；aspectRatio 只有 5 档（无 auto/21:9）；
 * - environment 是 { preset, backgroundColor, ambientLight, groundVisible }。
 *
 * 快照 zod schema 全部是 looseObject（未知键透传），因此本模块用两层策略保证无损：
 * - 已知字段 ↔ store 字段互相映射（store 是真源）；
 * - store 不建模的字段（attachments、rollDeg、meta、ambientLight、模版透传字段等）
 *   收进 ui stash / objectExtras，加载时暂存、下次保存原样写回。
 *
 * ui stash（快照顶层松散键 `ui`）保存 store 专有状态：7 档画幅、视角、叠加层、
 * 完整 order、场景设置（地面透明度/吸附/全景参数），以及上述 extras。
 *
 * 资源限制（ephemeral）：
 * - persist 模式（保存到服务端）：blob: 模型对象打 ephemeral:true、assetUrl 置空；
 *   全景图 blob: 同样置空并打 panoramaEphemeral 标记。加载时跳过 ephemeral 对象并
 *   返回名单供 UI 提示「本地临时，保存场景后不保留」。
 * - session 模式（命令执行器内部往返）：全量保留 blob: 引用，不做任何剔除。
 */
import type {
  SceneSnapshot,
  SceneEnvironment as SnapshotSceneEnvironment,
  SceneVec3,
  SceneAspectRatio,
} from "./contracts";
import { sceneSnapshotSchema } from "./contracts";
import { ENV_PRESETS } from "./env-presets";
import { DEFAULT_SCENE_SETTINGS } from "./store";
import type { SceneStateSlice } from "./store";
import { ASPECT_RATIO_VALUE, FOCAL_LENGTHS } from "./types";
import type {
  AspectRatio,
  CameraObject,
  CrowdObject,
  EnvironmentName,
  FocalLength,
  GeometryObject,
  MannequinObject,
  OverlayFlags,
  SceneObject,
  UploadedModelObject,
  Vec3,
  ViewMode,
} from "./types";

/* ──────────────────────────── ui stash 类型 ──────────────────────────── */

export interface DirectorUiStash {
  /** store 7 档画幅全量（aspectRatio 字段只承载后端 5 档） */
  aspect: AspectRatio;
  viewMode: ViewMode;
  overlays: OverlayFlags;
  /** 完整对象顺序（objects/cameras 交错；快照分组后靠它还原清单顺序） */
  order: string[];
  scene: {
    groundOpacity: number;
    gridSnap: boolean;
    panoramaUrl: string | null;
    panoramaRotation: number;
    panoramaRadius: number;
    /** persist 时全景图是 blob: → 置空并标 true（加载提示本地临时未恢复） */
    panoramaEphemeral?: boolean;
  };
  /** 对象级未知字段暂存（attachments / 其他松散键），按键原样写回 */
  objectExtras?: Record<string, Record<string, unknown>>;
  /** environment 的未知键暂存（如 ambientLight） */
  envExtras?: Record<string, unknown>;
  /** 快照顶层未知键暂存（如模版透传 templateId/promptHints） */
  snapshotExtras?: Record<string, unknown>;
}

export type DirectorSceneSnapshot = SceneSnapshot & { ui?: DirectorUiStash };

/* ──────────────────────────── 基础映射 ──────────────────────────── */

/* 反向（快照 → store）不走这里：加载端入参是 unknown，必须带运行时校验，
   统一用 readVec / readVecFlexible（兼容 {x,y,z} 与 [x,y,z] 两种 JSON 形态）。 */
const vecToXYZ = ([x, y, z]: Vec3): SceneVec3 => ({ x, y, z });

/** store 7 档画幅 → 后端 5 档（auto/21:9 按导出回退 16:9 处理，全量值经 ui.aspect 保留） */
export function backendAspectOf(aspect: AspectRatio): SceneAspectRatio {
  switch (aspect) {
    case "9:16":
    case "16:9":
    case "1:1":
    case "4:3":
    case "3:4":
      return aspect;
    default:
      return "16:9";
  }
}

const isBlobUrl = (url: string): boolean => url.startsWith("blob:");

/**
 * ambientLight 发射默认值（与后端 environmentSchema 默认一致）。
 * 解析端只在值 ≠ 默认时暂存：等于默认时序列化原样发射，无需 extras 即可规范往返。
 */
const DEFAULT_AMBIENT_LIGHT = 0.6;

/** 快照里由本模块写入/消费的保留键（其余松散键进 extras 暂存） */
const OBJECT_KNOWN_KEYS = new Set([
  "id", "type", "name", "visible", "transform",
  "pose", "bodyType", "color", "joints",
  "shape", "size", "rows", "cols", "spacing",
  "assetUrl", "fileName", "ephemeral",
  // attachments 由 readObjectExtras 显式处理（空数组是 zod 默认值，不进 extras）
  "attachments",
]);
const CAMERA_KNOWN_KEYS = new Set(["id", "type", "name", "visible", "focalLength", "target", "transform"]);
const ENV_KNOWN_KEYS = new Set(["preset", "backgroundColor", "ambientLight", "groundVisible"]);
const SNAPSHOT_KNOWN_KEYS = new Set([
  "schemaVersion", "objects", "cameras", "selectedObjectId", "activeCameraId",
  "aspectRatio", "environment", "ui",
]);

function pickExtras(
  record: Record<string, unknown>,
  knownKeys: Set<string>,
): Record<string, unknown> | undefined {
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!knownKeys.has(key)) extras[key] = value;
  }
  return Object.keys(extras).length > 0 ? extras : undefined;
}

/* ──────────────────────────── 松散键暂存（模块级，伴随 store 单例） ────────────────────────────
 * store 不建模的快照字段（attachments/rollDeg/meta/ambientLight/模版透传键）不进 zustand，
 * 由本模块以 ui stash 形式伴随持有：fromSceneSnapshot 装载时更新，toSceneSnapshot 默认
 * 以其为 previousUi 合并写回。store 是纯领域状态、stash 是「上次快照的未知字段」，
 * 两者同为模块单例，生命周期一致。删除对象后其 extras 在下次序列化时自然丢弃。
 */
let currentStash: DirectorUiStash | undefined;

/** 当前伴随暂存（命令执行器/保存链路默认的 previousUi 来源） */
export function currentUiStash(): DirectorUiStash | undefined {
  return currentStash;
}

/** 手工登记某对象的松散键（模版合入时写入 rollDeg/meta/来源标记，保存时透传留痕） */
export function noteObjectExtras(objectId: string, extras: Record<string, unknown>): void {
  const stash = currentStash ?? {
    aspect: "9:16" as AspectRatio,
    viewMode: "director" as const,
    overlays: { thirds: true, center: false, safeArea: false, nameTags: true },
    order: [],
    scene: {
      groundOpacity: 1,
      gridSnap: false,
      panoramaUrl: null,
      panoramaRotation: 0,
      panoramaRadius: 30,
    },
  };
  currentStash = {
    ...stash,
    objectExtras: {
      ...(stash.objectExtras ?? {}),
      [objectId]: { ...(stash.objectExtras?.[objectId] ?? {}), ...extras },
    },
  };
}

/* ──────────────────────────── 序列化（store → 快照） ──────────────────────────── */

export interface ToSnapshotOptions {
  /** true = 保存到服务端（blob: 资源打 ephemeral 标记）；缺省 false = 会话内无损 */
  persist?: boolean;
}

export function toSceneSnapshot(
  slice: SceneStateSlice,
  options: ToSnapshotOptions = {},
  previousUi?: DirectorUiStash,
): DirectorSceneSnapshot {
  const persist = options.persist === true;
  const stash = previousUi ?? currentStash;
  // 对象 extras：暂存按键合并，且只保留仍存在的对象（删除后自然丢弃）
  const objectExtras: Record<string, Record<string, unknown>> = {};
  for (const id of slice.order) {
    const extras = stash?.objectExtras?.[id];
    if (extras && slice.objects[id]) objectExtras[id] = extras;
  }
  const objects: Array<Record<string, unknown>> = [];
  const cameras: Array<Record<string, unknown>> = [];

  for (const id of slice.order) {
    const object = slice.objects[id];
    if (!object) continue;
    const extras = stash?.objectExtras?.[id];
    if (object.type === "camera") {
      cameras.push(serializeCamera(object, extras));
    } else {
      objects.push(serializeObject(object, extras, persist));
    }
  }

  const environment: Record<string, unknown> = {
    ...(stash?.envExtras ?? {}),
    preset: slice.environment,
    backgroundColor: slice.scene.skyColor,
    ambientLight:
      typeof stash?.envExtras?.["ambientLight"] === "number"
        ? stash.envExtras["ambientLight"]
        : DEFAULT_AMBIENT_LIGHT,
    groundVisible: slice.scene.groundVisible,
  };

  const panoramaEphemeral = persist && slice.scene.panoramaUrl !== null
    && isBlobUrl(slice.scene.panoramaUrl);

  const ui: DirectorUiStash = {
    aspect: slice.aspect,
    viewMode: slice.viewMode,
    overlays: { ...slice.overlays },
    order: [...slice.order],
    scene: {
      groundOpacity: slice.scene.groundOpacity,
      gridSnap: slice.scene.gridSnap,
      panoramaUrl: persist && panoramaEphemeral ? null : slice.scene.panoramaUrl,
      panoramaRotation: slice.scene.panoramaRotation,
      panoramaRadius: slice.scene.panoramaRadius,
      ...(panoramaEphemeral ? { panoramaEphemeral: true } : {}),
    },
    ...(Object.keys(objectExtras).length > 0 ? { objectExtras } : {}),
    ...(stash?.envExtras ? { envExtras: stash.envExtras } : {}),
    ...(stash?.snapshotExtras ? { snapshotExtras: stash.snapshotExtras } : {}),
  };

  // 会话序列化刷新暂存（保存链路 persist 不刷新：blob 置空是出栈表现，不污染会话状态）
  if (!persist) currentStash = ui;

  return {
    ...(stash?.snapshotExtras ?? {}),
    schemaVersion: 1,
    objects: objects as unknown as SceneSnapshot["objects"],
    cameras: cameras as unknown as SceneSnapshot["cameras"],
    selectedObjectId: slice.selectedId,
    activeCameraId: slice.activeCameraId,
    aspectRatio: backendAspectOf(slice.aspect),
    environment: environment as unknown as SnapshotSceneEnvironment,
    ui,
  };
}

function serializeObject(
  object: Exclude<SceneObject, CameraObject>,
  extras: Record<string, unknown> | undefined,
  persist: boolean,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ...(extras ?? {}),
    id: object.id,
    type: object.type,
    name: object.name,
    visible: object.visible,
    transform: {
      position: vecToXYZ(object.transform.position),
      rotation: vecToXYZ(object.transform.rotation),
      scale: vecToXYZ(object.transform.scale),
    },
  };
  // schema 字段（默认 []）：后端 applyCommand 直接读 object.attachments，必须恒在；
  // extras 暂存的非空 attachments 经此处恢复
  base["attachments"] = Array.isArray(extras?.["attachments"]) ? extras["attachments"] : [];

  switch (object.type) {
    case "mannequin":
      base["pose"] = { preset: object.pose };
      base["bodyType"] = object.bodyType;
      base["color"] = object.color;
      base["joints"] = object.joints;
      break;
    case "geometry":
      base["shape"] = object.shape;
      base["color"] = object.color;
      base["size"] = object.size;
      break;
    case "crowd":
      base["rows"] = object.rows;
      base["cols"] = object.cols;
      base["spacing"] = object.spacing;
      base["color"] = object.color;
      break;
    case "model": {
      // blob: objectURL 不落库：persist 时置空并打 ephemeral 标记，加载端跳过
      const ephemeral = persist && isBlobUrl(object.assetUrl);
      base["assetUrl"] = ephemeral ? "" : object.assetUrl;
      base["fileName"] = object.fileName;
      if (ephemeral) base["ephemeral"] = true;
      break;
    }
  }

  // 其余松散键（rollDeg/meta/templateId 等）已在 base 展开里带上
  return base;
}

function serializeCamera(
  camera: CameraObject,
  extras: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...(extras ?? {}),
    id: camera.id,
    type: "camera",
    name: camera.name,
    visible: camera.visible,
    focalLength: camera.focalLength,
    target: vecToXYZ(camera.target),
    transform: { position: vecToXYZ(camera.transform.position) },
  };
}

/* ──────────────────────────── 反序列化（快照 → store） ──────────────────────────── */

export interface FromSnapshotResult {
  slice: SceneStateSlice;
  /** 被跳过的本地临时对象名（ephemeral:true；UI 提示「本地临时，保存场景后不保留」） */
  skippedEphemeral: string[];
  /** 结构无法识别的对象名（未知 type 等，防御性跳过） */
  skippedUnknown: string[];
  /** 暂存的松散键（下一次 toSceneSnapshot 传回 previousUi 实现无损往返） */
  ui: DirectorUiStash;
}

/**
 * 解析服务端快照。结构非法（zod 校验失败）抛 Error；
 * ephemeral/未知对象跳过并记入名单。
 */
export function fromSceneSnapshot(input: unknown): FromSnapshotResult {
  const parsed = sceneSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("场景快照结构无法识别（schemaVersion/objects/cameras 校验失败）");
  }
  const snapshot = parsed.data as DirectorSceneSnapshot;
  const ui = snapshot.ui;

  const objects: Record<string, SceneObject> = {};
  const skippedEphemeral: string[] = [];
  const skippedUnknown: string[] = [];
  const objectExtras: Record<string, Record<string, unknown>> = {};

  for (const raw of snapshot.objects) {
    const record = raw as Record<string, unknown>;
    if (record["ephemeral"] === true) {
      skippedEphemeral.push(typeof record["name"] === "string" ? record["name"] : String(record["id"] ?? "未知对象"));
      continue;
    }
    const object = readStoreObject(record);
    if (!object) {
      skippedUnknown.push(typeof record["name"] === "string" ? record["name"] : String(record["id"] ?? "未知对象"));
      continue;
    }
    objects[object.id] = object;
    const extras = readObjectExtras(record);
    if (extras) objectExtras[object.id] = extras;
  }

  const cameraIds: string[] = [];
  for (const raw of snapshot.cameras) {
    const record = raw as Record<string, unknown>;
    const camera = readStoreCamera(record);
    if (!camera) {
      skippedUnknown.push(typeof record["name"] === "string" ? record["name"] : String(record["id"] ?? "未知机位"));
      continue;
    }
    objects[camera.id] = camera;
    cameraIds.push(camera.id);
    const extras = pickExtras(record, CAMERA_KNOWN_KEYS);
    if (extras) objectExtras[camera.id] = extras;
  }

  // 清单顺序：ui.order 过滤到实际装载的对象，缺失的按快照分组顺序补齐
  const snapshotOrder = [
    ...snapshot.objects.map((item) => item.id),
    ...snapshot.cameras.map((item) => item.id),
  ];
  const stashedOrder = Array.isArray(ui?.order) ? ui.order : [];
  const order: string[] = [];
  const seen = new Set<string>();
  for (const id of stashedOrder) {
    if (objects[id] && !seen.has(id)) {
      order.push(id);
      seen.add(id);
    }
  }
  for (const id of snapshotOrder) {
    if (objects[id] && !seen.has(id)) {
      order.push(id);
      seen.add(id);
    }
  }

  // 画幅还原：ui.aspect 与快照 aspectRatio 一致时取全量值（auto/21:9 往返无损）；
  // 不一致说明快照 aspectRatio 被命令/外部改写，以快照字段为准
  const stashedAspect = ui?.aspect;
  const aspect: AspectRatio =
    stashedAspect && backendAspectOf(stashedAspect) === snapshot.aspectRatio
      ? stashedAspect
      : snapshot.aspectRatio;

  const environmentRecord = snapshot.environment as unknown as Record<string, unknown>;
  // S8-7：十档预置直通还原（ENV_PRESETS 有的键原样恢复）；未知值回落 studio（旧快照兼容）
  const persistedPreset = environmentRecord["preset"];
  const environment: EnvironmentName =
    typeof persistedPreset === "string" && persistedPreset in ENV_PRESETS
      ? (persistedPreset as EnvironmentName)
      : "studio";
  const envExtras = pickExtras(environmentRecord, ENV_KNOWN_KEYS);
  // ambientLight 是 schema 字段但 store 不建模：非默认值暂存以便下次保存原样写回；
  // 等于发射默认值时序列化自然覆盖，不暂存（保证序列化→解析→序列化规范相等）
  const ambientLight = environmentRecord["ambientLight"];
  const envExtrasWithAmbient =
    typeof ambientLight === "number" && ambientLight !== DEFAULT_AMBIENT_LIGHT
      ? { ...envExtras, ambientLight }
      : envExtras;

  const uiScene = ui?.scene;
  const slice: SceneStateSlice = {
    objects,
    order,
    selectedId:
      snapshot.selectedObjectId && objects[snapshot.selectedObjectId]
        ? snapshot.selectedObjectId
        : null,
    viewMode: ui?.viewMode === "camera" ? "camera" : "director",
    activeCameraId:
      snapshot.activeCameraId && objects[snapshot.activeCameraId]?.type === "camera"
        ? snapshot.activeCameraId
        : cameraIds[0] ?? null,
    aspect,
    environment,
    scene: {
      ...DEFAULT_SCENE_SETTINGS,
      ...(uiScene
        ? {
            groundOpacity: uiScene.groundOpacity,
            gridSnap: uiScene.gridSnap,
            panoramaUrl: uiScene.panoramaUrl,
            panoramaRotation: uiScene.panoramaRotation,
            panoramaRadius: uiScene.panoramaRadius,
          }
        : {}),
      skyColor: typeof environmentRecord["backgroundColor"] === "string"
        ? (environmentRecord["backgroundColor"] as string).toUpperCase()
        : DEFAULT_SCENE_SETTINGS.skyColor,
      groundVisible: environmentRecord["groundVisible"] !== false,
    },
    overlays: ui?.overlays
      ? { ...{ thirds: true, center: false, safeArea: false, nameTags: true }, ...(ui.overlays as Partial<OverlayFlags>) }
      : { thirds: true, center: false, safeArea: false, nameTags: true },
  };
  if (slice.viewMode === "camera" && !slice.activeCameraId) slice.viewMode = "director";

  const snapshotExtras = pickExtras(snapshot as unknown as Record<string, unknown>, SNAPSHOT_KNOWN_KEYS);

  const nextStash: DirectorUiStash = {
    aspect: slice.aspect,
    viewMode: slice.viewMode,
    overlays: { ...slice.overlays },
    order: [...slice.order],
    scene: {
      groundOpacity: slice.scene.groundOpacity,
      gridSnap: slice.scene.gridSnap,
      panoramaUrl: slice.scene.panoramaUrl,
      panoramaRotation: slice.scene.panoramaRotation,
      panoramaRadius: slice.scene.panoramaRadius,
      ...(uiScene?.panoramaEphemeral ? { panoramaEphemeral: true } : {}),
    },
    ...(Object.keys(objectExtras).length > 0 ? { objectExtras } : {}),
    ...(envExtrasWithAmbient ? { envExtras: envExtrasWithAmbient } : {}),
    ...(snapshotExtras ? { snapshotExtras } : {}),
  };
  // 装载即接管暂存：后续 toSceneSnapshot / 命令执行器以它为 previousUi 无损往返
  currentStash = nextStash;

  return {
    slice,
    skippedEphemeral,
    skippedUnknown,
    ui: nextStash,
  };
}

function readObjectExtras(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const extras = pickExtras(record, OBJECT_KNOWN_KEYS);
  // attachments 是 schema 字段（attach_asset 命令写），store 不建模，显式暂存；
  // 空数组是 zod 解析注入的默认值，不暂存（保证规范往返相等）
  const attachments = record["attachments"];
  const merged =
    attachments !== undefined && !(Array.isArray(attachments) && attachments.length === 0)
      ? { ...extras, attachments }
      : extras;
  return merged && Object.keys(merged).length > 0 ? merged : undefined;
}

function readVec(record: unknown): Vec3 | null {
  if (!record || typeof record !== "object") return null;
  const { x, y, z } = record as Record<string, unknown>;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  return [x, y, z];
}

/** 兼容元组 [x,y,z] 与 {x,y,z} 两种 JSON 形态（会话内是元组，服务端往返后是数组） */
function readVecFlexible(record: unknown): Vec3 | null {
  if (Array.isArray(record) && record.length === 3 && record.every((n) => typeof n === "number")) {
    return [record[0] as number, record[1] as number, record[2] as number];
  }
  return readVec(record);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readStoreObject(record: Record<string, unknown>): Exclude<SceneObject, CameraObject> | null {
  const id = readString(record["id"]);
  const name = readString(record["name"]);
  const type = readString(record["type"]);
  const transformRecord = record["transform"] as Record<string, unknown> | undefined;
  const position = readVec(transformRecord?.["position"]);
  if (!id || !name || !type || !position) return null;
  const rotation = readVec(transformRecord?.["rotation"]) ?? [0, 0, 0];
  const scale = readVec(transformRecord?.["scale"]) ?? [1, 1, 1];
  const visible = record["visible"] !== false;
  const base = { id, name, visible, transform: { position, rotation, scale } };

  switch (type) {
    case "mannequin": {
      const poseRecord = record["pose"];
      const pose =
        typeof poseRecord === "string"
          ? poseRecord
          : readString((poseRecord as Record<string, unknown> | undefined)?.["preset"]) ?? "stand";
      return {
        ...base,
        type: "mannequin",
        bodyType: readBodyType(record["bodyType"]),
        color: readColor(record["color"]),
        pose,
        joints: readJoints(record["joints"]),
      } satisfies MannequinObject;
    }
    case "geometry": {
      const shape = readString(record["shape"]);
      if (!shape || !["box", "sphere", "cylinder", "cone", "torus", "plane"].includes(shape)) return null;
      const size = readVecFlexible(record["size"]) ?? [1, 1, 1];
      return {
        ...base,
        type: "geometry",
        shape: shape as GeometryObject["shape"],
        color: readColor(record["color"]),
        size,
      } satisfies GeometryObject;
    }
    case "crowd": {
      const rows = Number(record["rows"]);
      const cols = Number(record["cols"]);
      const spacing = Number(record["spacing"]);
      if (!Number.isFinite(rows) || !Number.isFinite(cols) || !Number.isFinite(spacing)) return null;
      return {
        ...base,
        type: "crowd",
        rows: Math.max(1, Math.round(rows)),
        cols: Math.max(1, Math.round(cols)),
        spacing: Math.max(0.2, spacing),
        color: readColor(record["color"]),
      } satisfies CrowdObject;
    }
    case "model": {
      const assetUrl = readString(record["assetUrl"]);
      if (!assetUrl) return null; // blob: 被持久化置空的对象由 ephemeral 分支拦截，这里兜底
      return {
        ...base,
        type: "model",
        assetUrl,
        fileName: readString(record["fileName"]) ?? "模型",
      } satisfies UploadedModelObject;
    }
    default:
      return null;
  }
}

function readStoreCamera(record: Record<string, unknown>): CameraObject | null {
  const id = readString(record["id"]);
  const name = readString(record["name"]);
  const transformRecord = record["transform"] as Record<string, unknown> | undefined;
  const position = readVec(transformRecord?.["position"]);
  const target = readVec(record["target"]);
  if (!id || !name || !position || !target) return null;
  const focal = Number(record["focalLength"]);
  const focalLength = (FOCAL_LENGTHS as readonly number[]).includes(focal)
    ? (focal as FocalLength)
    : 35;
  return {
    id,
    name,
    type: "camera",
    visible: record["visible"] !== false,
    transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    focalLength,
    target,
  };
}

function readBodyType(value: unknown): MannequinObject["bodyType"] {
  const id = readString(value);
  switch (id) {
    case "female":
    case "wide":
    case "muscular":
    case "slim":
    case "teen":
    case "child":
    case "chibi":
      return id;
    default:
      return "male";
  }
}

function readColor(value: unknown): string {
  const color = readString(value);
  return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color.toUpperCase() : "#9AA0A8";
}

function readJoints(value: unknown): Record<string, Vec3> {
  if (!value || typeof value !== "object") return {};
  const joints: Record<string, Vec3> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    // 会话内保存的是元组，服务端往返后是数组形态；两种都接
    if (Array.isArray(raw) && raw.length === 3 && raw.every((n) => typeof n === "number")) {
      joints[key] = [raw[0] as number, raw[1] as number, raw[2] as number];
    }
  }
  return joints;
}

/** ASPECT_RATIO_VALUE 仅供外部消费方取数值；此处 re-export 避免调用方再引 types */
export { ASPECT_RATIO_VALUE };
