/**
 * 3D 导演台 · 命令与快照合同（自包含镜像）
 *
 * mirror of src/modules/director/commands.ts + commands/snapshot.ts @d47fdf7, keep in sync
 * —— 后端模块在另一分支 feature/v011-director-main，本前端基线（69e85cd）尚不含它，
 *    因此按任务约定镜像为自包含 zod 合同，与后端 POST .../commands/validate、
 *    PUT .../scene 的结构校验保持同一份形状；后端合同变更时手工同步本文件。
 * 唯一有意省略：CommandValidationError（依赖后端 src/shared/errors.ts 的 AppError，
 * 前端执行器不需要）。
 */
import { z } from "zod";

/* ════════════ mirror of commands/snapshot.ts ════════════ */

/**
 * 导演台场景快照（DirectorSceneSnapshot）契约。
 * 这是 scene 持久化、命令 executor、前端与 Pi 共用的同一份结构定义；
 * 与模版实例化输出同为 camelCase 数据契约（loose object：模版字段
 * templateId/promptHints 等原样透传，不参与命令计算）。
 */

export const SCENE_ASPECT_RATIOS = ["9:16", "16:9", "1:1", "4:3", "3:4"] as const;

export const vec3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export const transformSchema = z.object({
  position: vec3Schema,
  rotation: vec3Schema.default({ x: 0, y: 0, z: 0 }),
  scale: vec3Schema.default({ x: 1, y: 1, z: 1 }),
});

/** 局部变换补丁（set_transform 用）：至少提供一个分量。 */
export const transformPatchSchema = z.object({
  position: vec3Schema.optional(),
  rotation: vec3Schema.optional(),
  scale: vec3Schema.optional(),
}).refine((value) => value.position !== undefined || value.rotation !== undefined || value.scale !== undefined, {
  message: "transform 至少提供 position/rotation/scale 之一",
});

export const poseSchema = z.looseObject({
  preset: z.string().min(1),
});

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "颜色必须是 #RRGGBB 形式");

export const attachedAssetSchema = z.looseObject({
  assetEntityId: z.string().uuid(),
  assetMediaId: z.string().uuid().nullable().default(null),
  name: z.string().min(1).max(128).optional(),
});

export const sceneObjectSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  transform: transformSchema,
  pose: poseSchema.optional(),
  attachments: z.array(attachedAssetSchema).default([]),
});

export const sceneCameraSchema = z.looseObject({
  id: z.string().min(1),
  type: z.literal("camera").default("camera"),
  name: z.string().min(1),
  focalLength: z.number().positive(),
  target: vec3Schema,
  transform: z.looseObject({ position: vec3Schema }),
  rollDeg: z.number().min(-45).max(45).optional(),
});

export const aspectRatioSchema = z.enum(SCENE_ASPECT_RATIOS);

export const environmentSchema = z.looseObject({
  preset: z.string().min(1).default("studio"),
  backgroundColor: colorSchema.default("#1E1E1E"),
  ambientLight: z.number().min(0).max(1).default(0.6),
  groundVisible: z.boolean().default(true),
});

/** set_environment 的环境补丁：字段全部可选但至少一项。 */
export const environmentPatchSchema = z.looseObject({
  preset: z.string().min(1).optional(),
  backgroundColor: colorSchema.optional(),
  ambientLight: z.number().min(0).max(1).optional(),
  groundVisible: z.boolean().optional(),
}).refine(
  (value) => Object.values(value).some((item) => item !== undefined),
  { message: "patch 至少提供一个环境字段" },
);

export const DEFAULT_SCENE_ENVIRONMENT = {
  preset: "studio",
  backgroundColor: "#1E1E1E",
  ambientLight: 0.6,
  groundVisible: true,
};

export const sceneSnapshotSchema = z.looseObject({
  schemaVersion: z.literal(1),
  objects: z.array(sceneObjectSchema).default([]),
  cameras: z.array(sceneCameraSchema).default([]),
  selectedObjectId: z.string().min(1).nullable().default(null),
  activeCameraId: z.string().min(1).nullable().default(null),
  aspectRatio: aspectRatioSchema.default("9:16"),
  environment: environmentSchema.default(DEFAULT_SCENE_ENVIRONMENT),
});

export type SceneVec3 = z.infer<typeof vec3Schema>;
export type SceneTransform = z.infer<typeof transformSchema>;
export type SceneTransformPatch = z.infer<typeof transformPatchSchema>;
export type ScenePose = z.infer<typeof poseSchema>;
export type AttachedAsset = z.infer<typeof attachedAssetSchema>;
export type SceneObject = z.infer<typeof sceneObjectSchema>;
export type SceneCamera = z.infer<typeof sceneCameraSchema>;
export type SceneAspectRatio = z.infer<typeof aspectRatioSchema>;
export type SceneEnvironment = z.infer<typeof environmentSchema>;
export type SceneEnvironmentPatch = z.infer<typeof environmentPatchSchema>;
export type SceneSnapshot = z.infer<typeof sceneSnapshotSchema>;

/* ════════════ mirror of commands.ts（略 AppError/CommandValidationError） ════════════ */
/**
 * DirectorCommand 合同：导演台 14 种命令的结构与校验（本期不接 Pi，只定契约）。
 * 每条命令都带 projectId/sceneId/sceneVersion（乐观锁）与类型化 payload；
 * 执行语义（applyCommand/undo 纯函数）在 commands/executor.ts，
 * inverse 由 executor 在应用时生成，调用方据此实现撤销栈。
 */

const commandBase = {
  projectId: z.string().uuid(),
  sceneId: z.string().uuid(),
  sceneVersion: z.number().int().min(0),
};

const objectIdSchema = z.string().min(1);

export const addObjectCommandSchema = z.object({
  ...commandBase,
  type: z.literal("add_object"),
  payload: z.object({ object: sceneObjectSchema }),
});

export const duplicateObjectCommandSchema = z.object({
  ...commandBase,
  type: z.literal("duplicate_object"),
  payload: z.object({
    objectId: objectIdSchema,
    newObjectId: objectIdSchema.optional(),
    name: z.string().min(1).max(128).optional(),
  }),
});

export const deleteObjectCommandSchema = z.object({
  ...commandBase,
  type: z.literal("delete_object"),
  payload: z.object({ objectId: objectIdSchema }),
});

export const selectObjectCommandSchema = z.object({
  ...commandBase,
  type: z.literal("select_object"),
  payload: z.object({ objectId: objectIdSchema.nullable() }),
});

export const setTransformCommandSchema = z.object({
  ...commandBase,
  type: z.literal("set_transform"),
  payload: z.object({
    objectId: objectIdSchema,
    transform: transformPatchSchema,
  }),
});

export const setPoseCommandSchema = z.object({
  ...commandBase,
  type: z.literal("set_pose"),
  payload: z.object({
    objectId: objectIdSchema,
    pose: poseSchema,
  }),
});

export const addCameraCommandSchema = z.object({
  ...commandBase,
  type: z.literal("add_camera"),
  payload: z.object({ camera: sceneCameraSchema }),
});

export const setCameraCommandSchema = z.object({
  ...commandBase,
  type: z.literal("set_camera"),
  payload: z.object({
    cameraId: objectIdSchema,
    patch: z.looseObject({
      name: z.string().min(1).max(128).optional(),
      focalLength: z.number().positive().optional(),
      target: vec3Schema.optional(),
      position: vec3Schema.optional(),
      rollDeg: z.number().min(-45).max(45).nullable().optional(),
    }).refine(
      (value) => Object.values(value).some((item) => item !== undefined),
      { message: "patch 至少提供一个机位字段" },
    ),
  }),
});

export const setAspectRatioCommandSchema = z.object({
  ...commandBase,
  type: z.literal("set_aspect_ratio"),
  payload: z.object({ aspectRatio: aspectRatioSchema }),
});

export const setEnvironmentCommandSchema = z.object({
  ...commandBase,
  type: z.literal("set_environment"),
  payload: z.object({ patch: environmentPatchSchema }),
});

export const attachAssetCommandSchema = z.object({
  ...commandBase,
  type: z.literal("attach_asset"),
  payload: z.object({
    objectId: objectIdSchema,
    asset: attachedAssetSchema,
  }),
});

/** 动作类命令：不改变快照（持久化/截图/撤销各有专门通道），executor 中为恒等。 */
export const saveSceneCommandSchema = z.object({
  ...commandBase,
  type: z.literal("save_scene"),
});

export const captureViewCommandSchema = z.object({
  ...commandBase,
  type: z.literal("capture_view"),
  payload: z.looseObject({
    cameraId: objectIdSchema.optional(),
    label: z.string().max(128).optional(),
  }).optional(),
});

export const undoCommandSchema = z.object({
  ...commandBase,
  type: z.literal("undo"),
});

export const directorCommandSchema = z.discriminatedUnion("type", [
  addObjectCommandSchema,
  duplicateObjectCommandSchema,
  deleteObjectCommandSchema,
  selectObjectCommandSchema,
  setTransformCommandSchema,
  setPoseCommandSchema,
  addCameraCommandSchema,
  setCameraCommandSchema,
  setAspectRatioCommandSchema,
  setEnvironmentCommandSchema,
  attachAssetCommandSchema,
  saveSceneCommandSchema,
  captureViewCommandSchema,
  undoCommandSchema,
]);

export const DIRECTOR_COMMAND_TYPES = [
  "add_object",
  "duplicate_object",
  "delete_object",
  "select_object",
  "set_transform",
  "set_pose",
  "add_camera",
  "set_camera",
  "set_aspect_ratio",
  "set_environment",
  "attach_asset",
  "save_scene",
  "capture_view",
  "undo",
] as const;

/* ---------- 逆操作（inverse）合同：applyCommand 的输出、undo 的输入 ---------- */

export const commandInverseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noop"), reason: z.string().optional() }),
  z.object({
    type: z.literal("add_object"),
    collection: z.enum(["objects", "cameras"]),
    object: z.union([sceneObjectSchema, sceneCameraSchema]),
  }),
  z.object({ type: z.literal("delete_object"), objectId: objectIdSchema }),
  z.object({
    type: z.literal("set_transform"),
    objectId: objectIdSchema,
    /** 撤销时整体替换 transform；机位只有 position，故 rotation/scale 可选。 */
    transform: z.looseObject({
      position: vec3Schema,
      rotation: vec3Schema.optional(),
      scale: vec3Schema.optional(),
    }),
  }),
  z.object({
    type: z.literal("set_pose"),
    objectId: objectIdSchema,
    pose: poseSchema,
  }),
  z.object({
    type: z.literal("set_camera"),
    cameraId: objectIdSchema,
    camera: sceneCameraSchema,
  }),
  z.object({ type: z.literal("select_object"), objectId: objectIdSchema.nullable() }),
  z.object({ type: z.literal("set_aspect_ratio"), aspectRatio: aspectRatioSchema }),
  z.object({ type: z.literal("set_environment"), environment: environmentSchema }),
  z.object({
    type: z.literal("attach_asset"),
    objectId: objectIdSchema,
    asset: attachedAssetSchema,
  }),
  z.object({
    type: z.literal("detach_asset"),
    objectId: objectIdSchema,
    assetEntityId: z.string().uuid(),
  }),
]);

export type DirectorCommand = z.infer<typeof directorCommandSchema>;
export type DirectorCommandType = (typeof DIRECTOR_COMMAND_TYPES)[number];
export type CommandInverse = z.infer<typeof commandInverseSchema>;

/** 批量校验请求体（POST .../director/commands/validate）。 */
export const validateCommandsBodySchema = z.object({
  sceneId: z.string().uuid(),
  sceneVersion: z.number().int().min(0),
  commands: z.array(directorCommandSchema).min(1).max(100),
});

export type ValidateCommandsBody = z.infer<typeof validateCommandsBodySchema>;
