/**
 * 3D 导演台 · 命令 reducer/执行核心（自包含镜像）
 *
 * mirror of src/modules/director/commands/executor.ts @d47fdf7, keep in sync
 * —— 后端模块在另一分支 feature/v011-director-main，本前端基线（69e85cd）尚不含它。
 * 纯函数、不碰 IO；applyCommand 产出 inverse，undo 精确回滚。后端合同变更时手工同步。
 */
import type { CommandInverse, DirectorCommand } from "../contracts";
import type {
  AttachedAsset,
  SceneCamera,
  SceneEnvironment,
  SceneObject,
  SceneSnapshot,
  SceneTransform,
} from "../contracts";

/**
 * DirectorCommand 的 reducer/执行器：前端与 Pi 共用的真源。
 * 纯函数、不碰 IO；输入快照不被修改（structuredClone 后返回新快照）。
 * applyCommand 同时产出 inverse，undo(snapshot, inverse) 精确回滚。
 *
 * 边界（文档化语义）：
 * - delete_object 会清掉指向被删对象的 selectedObjectId / activeCameraId，
 *   撤销只恢复对象本身，不恢复这两个指针（调用方在撤销后自行重选）。
 * - save_scene / capture_view / undo 是动作类命令：apply 为恒等，inverse 为 noop；
 *   真正的持久化走 PUT scene，截图走 POST captures，撤销由调用方对 inverse 栈执行。
 */

export class CommandExecutionError extends Error {
  readonly commandType: string;

  constructor(message: string, commandType: string) {
    super(message);
    this.name = "CommandExecutionError";
    this.commandType = commandType;
  }
}

export interface AppliedCommand {
  snapshot: SceneSnapshot;
  inverse: CommandInverse;
}

type ObjectCollection = "objects" | "cameras";

interface LocatedEntry {
  collection: ObjectCollection;
  index: number;
  value: SceneObject | SceneCamera;
}

export function applyCommand(snapshot: SceneSnapshot, command: DirectorCommand): AppliedCommand {
  const next = structuredClone(snapshot);
  const inverse = reduce(next, command);
  return { snapshot: next, inverse };
}

export function undo(snapshot: SceneSnapshot, inverse: CommandInverse): SceneSnapshot {
  const next = structuredClone(snapshot);
  switch (inverse.type) {
    case "noop":
      return next;
    case "add_object": {
      const object = structuredClone(inverse.object);
      if (inverse.collection === "cameras") next.cameras.push(object as SceneCamera);
      else next.objects.push(object as SceneObject);
      return next;
    }
    case "delete_object":
      removeEntry(next, inverse.objectId);
      return next;
    case "set_transform": {
      const entry = requireEntry(next, inverse.objectId, "undo:set_transform");
      (entry.value as { transform: unknown }).transform = structuredClone(inverse.transform);
      return next;
    }
    case "set_pose": {
      const entry = requireEntry(next, inverse.objectId, "undo:set_pose");
      if (entry.collection !== "objects") throw new CommandExecutionError("镜头没有姿态可恢复", "undo:set_pose");
      (entry.value as SceneObject).pose = structuredClone(inverse.pose);
      return next;
    }
    case "set_camera": {
      const entry = requireEntry(next, inverse.cameraId, "undo:set_camera");
      if (entry.collection !== "cameras") throw new CommandExecutionError(`对象 ${inverse.cameraId} 不是镜头`, "undo:set_camera");
      next.cameras[entry.index] = structuredClone(inverse.camera);
      return next;
    }
    case "select_object":
      next.selectedObjectId = inverse.objectId;
      return next;
    case "set_aspect_ratio":
      next.aspectRatio = inverse.aspectRatio;
      return next;
    case "set_environment":
      next.environment = structuredClone(inverse.environment);
      return next;
    case "attach_asset": {
      const entry = requireEntry(next, inverse.objectId, "undo:attach_asset");
      if (entry.collection !== "objects") throw new CommandExecutionError("镜头不能挂资产", "undo:attach_asset");
      (entry.value as SceneObject).attachments.push(structuredClone(inverse.asset));
      return next;
    }
    case "detach_asset": {
      const entry = requireEntry(next, inverse.objectId, "undo:detach_asset");
      if (entry.collection === "objects") {
        const object = entry.value as SceneObject;
        object.attachments = object.attachments.filter((asset) => asset.assetEntityId !== inverse.assetEntityId);
      }
      return next;
    }
  }
}

function reduce(snapshot: SceneSnapshot, command: DirectorCommand): CommandInverse {
  switch (command.type) {
    case "add_object": {
      const object = structuredClone(command.payload.object);
      if (findEntry(snapshot, object.id)) {
        throw new CommandExecutionError(`对象 ${object.id} 已存在`, command.type);
      }
      snapshot.objects.push(object);
      return { type: "delete_object", objectId: object.id };
    }
    case "duplicate_object": {
      const source = requireEntry(snapshot, command.payload.objectId, command.type);
      const newObjectId = command.payload.newObjectId ?? `${command.payload.objectId}-copy`;
      if (findEntry(snapshot, newObjectId)) {
        throw new CommandExecutionError(`对象 ${newObjectId} 已存在`, command.type);
      }
      const copy = structuredClone(source.value) as SceneObject & SceneCamera;
      copy.id = newObjectId;
      copy.name = command.payload.name ?? `${source.value.name} 副本`;
      if (source.collection === "cameras") snapshot.cameras.push(copy);
      else snapshot.objects.push(copy);
      return { type: "delete_object", objectId: newObjectId };
    }
    case "delete_object": {
      const entry = requireEntry(snapshot, command.payload.objectId, command.type);
      const removed = structuredClone(entry.value);
      removeEntry(snapshot, entry);
      if (snapshot.selectedObjectId === command.payload.objectId) snapshot.selectedObjectId = null;
      if (snapshot.activeCameraId === command.payload.objectId) snapshot.activeCameraId = null;
      return { type: "add_object", collection: entry.collection, object: removed };
    }
    case "select_object": {
      const objectId = command.payload.objectId;
      if (objectId !== null) requireEntry(snapshot, objectId, command.type);
      const previous = snapshot.selectedObjectId;
      snapshot.selectedObjectId = objectId;
      return { type: "select_object", objectId: previous };
    }
    case "set_transform": {
      const entry = requireEntry(snapshot, command.payload.objectId, command.type);
      const previous = structuredClone(entry.value.transform);
      const patch = command.payload.transform;
      if (patch.position) entry.value.transform.position = patch.position;
      const transform = entry.value.transform as SceneTransform;
      if (patch.rotation) transform.rotation = patch.rotation;
      if (patch.scale) transform.scale = patch.scale;
      return { type: "set_transform", objectId: command.payload.objectId, transform: previous };
    }
    case "set_pose": {
      const entry = requireEntry(snapshot, command.payload.objectId, command.type);
      if (entry.collection !== "objects") {
        throw new CommandExecutionError(`镜头 ${command.payload.objectId} 没有姿态`, command.type);
      }
      const object = entry.value as SceneObject;
      if (!object.pose) {
        throw new CommandExecutionError(`对象 ${command.payload.objectId} 不支持姿态`, command.type);
      }
      const previous = structuredClone(object.pose);
      object.pose = structuredClone(command.payload.pose);
      return { type: "set_pose", objectId: command.payload.objectId, pose: previous };
    }
    case "add_camera": {
      const camera = structuredClone(command.payload.camera);
      if (findEntry(snapshot, camera.id)) {
        throw new CommandExecutionError(`对象 ${camera.id} 已存在`, command.type);
      }
      snapshot.cameras.push(camera);
      return { type: "delete_object", objectId: camera.id };
    }
    case "set_camera": {
      const entry = requireEntry(snapshot, command.payload.cameraId, command.type);
      if (entry.collection !== "cameras") {
        throw new CommandExecutionError(`对象 ${command.payload.cameraId} 不是镜头`, command.type);
      }
      const camera = entry.value as SceneCamera;
      const previous = structuredClone(camera);
      const patch = command.payload.patch;
      if (patch.name !== undefined) camera.name = patch.name;
      if (patch.focalLength !== undefined) camera.focalLength = patch.focalLength;
      if (patch.target !== undefined) camera.target = patch.target;
      if (patch.position !== undefined) camera.transform.position = patch.position;
      if (patch.rollDeg !== undefined) {
        if (patch.rollDeg === null) delete camera.rollDeg;
        else camera.rollDeg = patch.rollDeg;
      }
      return { type: "set_camera", cameraId: command.payload.cameraId, camera: previous };
    }
    case "set_aspect_ratio": {
      const previous = snapshot.aspectRatio;
      snapshot.aspectRatio = command.payload.aspectRatio;
      return { type: "set_aspect_ratio", aspectRatio: previous };
    }
    case "set_environment": {
      const previous = structuredClone(snapshot.environment);
      snapshot.environment = { ...snapshot.environment, ...command.payload.patch } as SceneEnvironment;
      return { type: "set_environment", environment: previous };
    }
    case "attach_asset": {
      const entry = requireEntry(snapshot, command.payload.objectId, command.type);
      if (entry.collection !== "objects") {
        throw new CommandExecutionError(`镜头 ${command.payload.objectId} 不能挂资产`, command.type);
      }
      const object = entry.value as SceneObject;
      const asset = structuredClone(command.payload.asset) as AttachedAsset;
      if (object.attachments.some((item) => item.assetEntityId === asset.assetEntityId)) {
        throw new CommandExecutionError(`资产 ${asset.assetEntityId} 已挂在对象 ${object.id} 上`, command.type);
      }
      object.attachments.push(asset);
      return { type: "detach_asset", objectId: object.id, assetEntityId: asset.assetEntityId };
    }
    case "save_scene":
      return { type: "noop", reason: "save_scene 由 PUT scene 持久化，快照不变" };
    case "capture_view":
      return { type: "noop", reason: "capture_view 由 POST captures 落地，快照不变" };
    case "undo":
      return { type: "noop", reason: "undo 由调用方对 inverse 栈执行，快照不变" };
  }
}

function findEntry(snapshot: SceneSnapshot, objectId: string): LocatedEntry | null {
  const objectIndex = snapshot.objects.findIndex((item) => item.id === objectId);
  if (objectIndex >= 0) return { collection: "objects", index: objectIndex, value: snapshot.objects[objectIndex]! };
  const cameraIndex = snapshot.cameras.findIndex((item) => item.id === objectId);
  if (cameraIndex >= 0) return { collection: "cameras", index: cameraIndex, value: snapshot.cameras[cameraIndex]! };
  return null;
}

function requireEntry(snapshot: SceneSnapshot, objectId: string, commandType: string): LocatedEntry {
  const entry = findEntry(snapshot, objectId);
  if (!entry) throw new CommandExecutionError(`对象 ${objectId} 不存在`, commandType);
  return entry;
}

function removeEntry(snapshot: SceneSnapshot, entry: LocatedEntry | string): void {
  const located = typeof entry === "string" ? findEntry(snapshot, entry) : entry;
  if (!located) return;
  if (located.collection === "cameras") snapshot.cameras.splice(located.index, 1);
  else snapshot.objects.splice(located.index, 1);
}
