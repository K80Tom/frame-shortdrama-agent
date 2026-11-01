/**
 * 3D 导演台 · zustand store（V0.1.1 移植：原 Wave 1 冻结版 + 场景装载动作）
 *
 * 唯一事实来源：所有场景对象、选中态、视角、环境、gizmo、叠加层开关都在这里。
 * Wave 2 各模块通过 useDirectorStore 读状态、调 action，不各自维护副本。
 *
 * 注意：store 是纯数据（可 JSON 序列化），three 的 Object3D 实例一律不进 store；
 * 渲染期需要 gl/scene 时走 ./runtime 的 directorRuntime。
 *
 * V0.1.1 移植新增（不改动旧 action 语义）：
 * - SceneStateSlice：可整体装载/序列化的状态切片（snapshot.ts 与 DirectorWorkspace 消费）
 * - replaceSceneState：整体替换场景（加载已存版本 / 命令执行器写回）
 * - resetToSeed：重置为空台（服务端无已存版本时）
 * - createSeedSceneState：导出空台状态构造（序列化测试与 workspace 复用）
 *
 * W5.5：默认空台——新开/无已存版本时不预置任何对象（含机位），
 * 环境/灯光/画幅/视角保持默认；铺场景由用户主动进行（模版包 / 资产库 / 添加对象）。
 *
 * S8（P1-9）：内部剪贴板 copyObject/pasteObject（Ctrl+C/V 快捷键消费）。
 * 剪贴板是会话级状态，不进 SceneStateSlice、不参与快照序列化。
 */
import { create } from "zustand";

import type {
  AspectRatio,
  BodyTypeId,
  CameraObject,
  CrowdObject,
  EnvironmentName,
  FocalLength,
  GeometryObject,
  GizmoMode,
  OverlayFlags,
  OverlayKey,
  SceneObject,
  SceneSettings,
  Transform,
  Vec3,
  ViewMode,
} from "./types";

/** 分配 id 用的分布式 Omit（对联合类型逐成员生效） */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** addObject 的入参：完整对象数据，id 由 store 生成 */
export type NewSceneObject = DistributiveOmit<SceneObject, "id">;

export interface AddCameraInit {
  name?: string;
  position?: Vec3;
  target?: Vec3;
  focalLength?: FocalLength;
}

export interface DirectorState {
  /* ── 状态 ── */
  objects: Record<string, SceneObject>;
  /** 对象顺序（左栏清单按此渲染，后加的在后） */
  order: string[];
  selectedId: string | null;
  /** 内部剪贴板（Ctrl+C 复制的对象深拷贝；会话级，不进 SceneStateSlice/快照） */
  clipboard: SceneObject | null;
  viewMode: ViewMode;
  activeCameraId: string | null;
  aspect: AspectRatio;
  environment: EnvironmentName;
  /** 场景级设置（天空色/地面/吸附），对应 LibTV「3D场景」面板 */
  scene: SceneSettings;
  gizmoMode: GizmoMode;
  overlays: OverlayFlags;

  /* ── 对象增删改 ── */
  addObject: (object: NewSceneObject) => string;
  removeObject: (id: string) => void;
  /** 清空全部场景对象（含机位），保留环境/场景设置/画幅/叠加层；空台调用幂等 */
  clearSceneObjects: () => void;
  /** 复制对象（名称加「 副本」，非机位向右前偏移 0.5m 避免重叠），返回新 id */
  duplicateObject: (id: string) => string | null;
  /** 复制对象进内部剪贴板（深拷贝，与源对象解耦）；对象不存在返回 false */
  copyObject: (id: string) => boolean;
  /** 粘贴剪贴板对象为新对象（新 uid、位置 x/z 各偏移 0.5m、选中新对象，
   *  连续粘贴按上一次落点递进偏移）；剪贴板为空返回 null */
  pasteObject: () => string | null;
  renameObject: (id: string, name: string) => void;
  setVisible: (id: string, visible: boolean) => void;
  select: (id: string | null) => void;
  updateTransform: (id: string, patch: Partial<Transform>) => void;
  /** 仅 mannequin：切换姿势预设（joints 微调保留） */
  setPose: (id: string, pose: string) => void;
  /** 仅 mannequin：切换素体体型 */
  setBodyType: (id: string, bodyType: BodyTypeId) => void;
  /** 仅 mannequin：设置单个关节的角度微调 */
  setJoint: (id: string, joint: string, value: Vec3) => void;
  /** mannequin / geometry / crowd 通用改色 */
  setColor: (id: string, color: string) => void;
  /** 仅 geometry：改尺寸（米） */
  updateGeometry: (id: string, patch: Partial<Pick<GeometryObject, "size">>) => void;
  setCrowdParams: (id: string, params: Partial<Pick<CrowdObject, "rows" | "cols" | "spacing">>) => void;

  /* ── 机位 ── */
  /** 新建机位（缺省 position [3,2.2,4] / target [0,1,0] / focal 35），返回新 id */
  addCamera: (init?: AddCameraInit) => string;
  /** 改机位的焦距 / 注视点；位置走 updateTransform，命名走 renameObject */
  updateCamera: (id: string, patch: Partial<Pick<CameraObject, "focalLength" | "target">>) => void;

  /* ── 视图与工具 ── */
  setViewMode: (mode: ViewMode) => void;
  setActiveCamera: (id: string | null) => void;
  setAspect: (aspect: AspectRatio) => void;
  setEnvironment: (environment: EnvironmentName) => void;
  /** 场景级设置（部分合并） */
  setSceneSettings: (patch: Partial<SceneSettings>) => void;
  setGizmoMode: (mode: GizmoMode) => void;
  toggleOverlay: (key: OverlayKey) => void;

  /* ── 场景装载（V0.1.1 移植新增） ── */
  /** 整体替换场景切片（加载已存版本 / 命令执行器写回）；不动 gizmoMode */
  replaceSceneState: (slice: SceneStateSlice) => void;
  /** 重置为空台（服务端无已存版本时）；gizmoMode 也回到默认 */
  resetToSeed: () => void;
}

/** 可整体装载/序列化的状态切片（snapshot.ts 与 DirectorWorkspace 消费） */
export interface SceneStateSlice {
  objects: Record<string, SceneObject>;
  order: string[];
  selectedId: string | null;
  viewMode: ViewMode;
  activeCameraId: string | null;
  aspect: AspectRatio;
  environment: EnvironmentName;
  scene: SceneSettings;
  overlays: OverlayFlags;
}

let uidSeq = 0;
const uid = () => `ds-${++uidSeq}`;

function firstCameraId(objects: Record<string, SceneObject>, order: string[]): string | null {
  for (const id of order) {
    if (objects[id]?.type === "camera") return id;
  }
  return null;
}

/* ──────────────────────────── 默认空台（W5.5） ────────────────────────────
 * 新开/无已存版本时不预置任何对象（原「三角对峙」种子场景已按 Dario W5.5 要求撤下）：
 * 环境/灯光（studio）、画幅、叠加层、视角保持默认；铺场景走模版包 / 资产库 / 添加对象。
 * 已有已存场景的项目不受影响（加载链路 fromSceneSnapshot 不动）。
 */

/** 默认场景级设置（store 初始值与 resetToSeed 共用） */
export const DEFAULT_SCENE_SETTINGS: SceneSettings = {
  skyColor: "#15181E",
  groundVisible: true,
  groundOpacity: 1,
  gridSnap: false,
  panoramaUrl: null,
  panoramaRotation: 0,
  panoramaRadius: 30,
};

const DEFAULT_OVERLAYS: OverlayFlags = { thirds: true, center: false, safeArea: false, nameTags: true };

/** 空台完整状态切片（store 初始化与 resetToSeed/加载兜底共用） */
export function createSeedSceneState(): SceneStateSlice {
  return {
    objects: {},
    order: [],
    selectedId: null,
    viewMode: "director",
    activeCameraId: null,
    aspect: "9:16",
    environment: "studio",
    scene: { ...DEFAULT_SCENE_SETTINGS },
    overlays: { ...DEFAULT_OVERLAYS },
  };
}

const seed = createSeedSceneState();

export const useDirectorStore = create<DirectorState>()((set, get) => ({
  objects: seed.objects,
  order: seed.order,
  selectedId: null,
  clipboard: null,
  viewMode: "director",
  activeCameraId: seed.activeCameraId,
  aspect: "9:16",
  environment: "studio",
  scene: {
    skyColor: "#15181E",
    groundVisible: true,
    groundOpacity: 1,
    gridSnap: false,
    panoramaUrl: null,
    panoramaRotation: 0,
    panoramaRadius: 30,
  },
  gizmoMode: "translate",
  overlays: { thirds: true, center: false, safeArea: false, nameTags: true },

  addObject: (object) => {
    const id = uid();
    set((state) => ({
      objects: { ...state.objects, [id]: { ...object, id } as SceneObject },
      order: [...state.order, id],
      // 首个机位自动成为活动机位
      activeCameraId:
        object.type === "camera" ? (state.activeCameraId ?? id) : state.activeCameraId,
    }));
    return id;
  },

  removeObject: (id) => {
    set((state) => {
      const removed = state.objects[id];
      if (!removed) return state;
      const objects = { ...state.objects };
      delete objects[id];
      const order = state.order.filter((existing) => existing !== id);

      let activeCameraId = state.activeCameraId;
      let viewMode = state.viewMode;
      if (removed.type === "camera" && activeCameraId === id) {
        activeCameraId = firstCameraId(objects, order);
        if (!activeCameraId && viewMode === "camera") viewMode = "director";
      }

      return {
        objects,
        order,
        activeCameraId,
        viewMode,
        selectedId: state.selectedId === id ? null : state.selectedId,
      };
    });
  },

  clearSceneObjects: () => {
    set((state) => {
      if (state.order.length === 0) return state;
      // 保留环境/场景设置/画幅/叠加层/gizmo；机位清空后视角退回导演视角
      return {
        objects: {},
        order: [],
        selectedId: null,
        activeCameraId: null,
        viewMode: "director" as ViewMode,
      };
    });
  },

  duplicateObject: (id) => {
    const source = get().objects[id];
    if (!source) return null;
    const copy = structuredClone(source) as SceneObject;
    copy.id = uid();
    copy.name = `${source.name} 副本`;
    if (copy.type !== "camera") {
      copy.transform.position = [
        copy.transform.position[0] + 0.5,
        copy.transform.position[1],
        copy.transform.position[2] + 0.5,
      ];
    }
    set((state) => {
      const objects = { ...state.objects, [copy.id]: copy };
      const order = [...state.order];
      order.splice(order.indexOf(id) + 1, 0, copy.id);
      return {
        objects,
        order,
        activeCameraId:
          copy.type === "camera" ? (state.activeCameraId ?? copy.id) : state.activeCameraId,
      };
    });
    return copy.id;
  },

  copyObject: (id) => {
    const source = get().objects[id];
    if (!source) return false;
    // 深拷贝进剪贴板：源对象后续改动/删除都不影响已复制的内容
    set({ clipboard: structuredClone(source) as SceneObject });
    return true;
  },

  pasteObject: () => {
    const source = get().clipboard;
    if (!source) return null;
    const copy = structuredClone(source) as SceneObject;
    copy.id = uid();
    // 与 duplicateObject 同向的 0.5m 偏移，避免与源/上一次粘贴重叠
    copy.transform.position = [
      copy.transform.position[0] + 0.5,
      copy.transform.position[1],
      copy.transform.position[2] + 0.5,
    ];
    set((state) => ({
      objects: { ...state.objects, [copy.id]: copy },
      order: [...state.order, copy.id],
      selectedId: copy.id,
      activeCameraId:
        copy.type === "camera" ? (state.activeCameraId ?? copy.id) : state.activeCameraId,
      // 连续粘贴递进：剪贴板位置推进到本次落点，下一次再偏 0.5m，不叠罗汉
      clipboard: {
        ...source,
        transform: { ...source.transform, position: copy.transform.position },
      },
    }));
    return copy.id;
  },

  renameObject: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set((state) => {
      const object = state.objects[id];
      if (!object) return state;
      return { objects: { ...state.objects, [id]: { ...object, name: trimmed } } };
    });
  },

  setVisible: (id, visible) => {
    set((state) => {
      const object = state.objects[id];
      if (!object) return state;
      return { objects: { ...state.objects, [id]: { ...object, visible } } };
    });
  },

  select: (id) => set({ selectedId: id }),

  updateTransform: (id, patch) => {
    set((state) => {
      const object = state.objects[id];
      if (!object) return state;
      return {
        objects: {
          ...state.objects,
          [id]: { ...object, transform: { ...object.transform, ...patch } },
        },
      };
    });
  },

  setPose: (id, pose) => {
    set((state) => {
      const object = state.objects[id];
      if (!object || object.type !== "mannequin") return state;
      return { objects: { ...state.objects, [id]: { ...object, pose } } };
    });
  },

  setBodyType: (id, bodyType) => {
    set((state) => {
      const object = state.objects[id];
      if (!object || object.type !== "mannequin") return state;
      return { objects: { ...state.objects, [id]: { ...object, bodyType } } };
    });
  },

  setJoint: (id, joint, value) => {
    set((state) => {
      const object = state.objects[id];
      if (!object || object.type !== "mannequin") return state;
      return {
        objects: {
          ...state.objects,
          [id]: { ...object, joints: { ...object.joints, [joint]: value } },
        },
      };
    });
  },

  setColor: (id, color) => {
    set((state) => {
      const object = state.objects[id];
      if (!object || object.type === "camera" || object.type === "model") return state;
      return { objects: { ...state.objects, [id]: { ...object, color } } };
    });
  },

  updateGeometry: (id, patch) => {
    set((state) => {
      const object = state.objects[id];
      if (!object || object.type !== "geometry") return state;
      return { objects: { ...state.objects, [id]: { ...object, ...patch } } };
    });
  },

  setCrowdParams: (id, params) => {
    set((state) => {
      const object = state.objects[id];
      if (!object || object.type !== "crowd") return state;
      const next = { ...object, ...params };
      next.rows = Math.max(1, Math.round(next.rows));
      next.cols = Math.max(1, Math.round(next.cols));
      next.spacing = Math.max(0.2, next.spacing);
      return { objects: { ...state.objects, [id]: next } };
    });
  },

  addCamera: (init = {}) => {
    const state = get();
    const cameraCount = state.order.filter((id) => state.objects[id]?.type === "camera").length;
    const id = uid();
    const camera: CameraObject = {
      id,
      name: init.name ?? `机位 ${cameraCount + 1}`,
      type: "camera",
      visible: true,
      transform: {
        position: init.position ?? [3, 2.2, 4],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      focalLength: init.focalLength ?? 35,
      target: init.target ?? [0, 1, 0],
    };
    set((current) => ({
      objects: { ...current.objects, [id]: camera },
      order: [...current.order, id],
      activeCameraId: current.activeCameraId ?? id,
    }));
    return id;
  },

  updateCamera: (id, patch) => {
    set((state) => {
      const object = state.objects[id];
      if (!object || object.type !== "camera") return state;
      return { objects: { ...state.objects, [id]: { ...object, ...patch } } };
    });
  },

  setViewMode: (mode) => {
    set((state) => {
      if (mode === "camera") {
        // 机位视角必须有一个活动机位：优先沿用，否则取清单里第一个；一个都没有则留在导演视角
        const fallback = state.activeCameraId ?? firstCameraId(state.objects, state.order);
        if (!fallback) return state;
        return { viewMode: "camera", activeCameraId: fallback };
      }
      return { viewMode: mode };
    });
  },

  setActiveCamera: (id) => set({ activeCameraId: id }),

  setAspect: (aspect) => set({ aspect }),

  setEnvironment: (environment) => set({ environment }),

  setSceneSettings: (patch) => {
    set((state) => ({ scene: { ...state.scene, ...patch } }));
  },

  setGizmoMode: (gizmoMode) => set({ gizmoMode }),

  toggleOverlay: (key) => {
    set((state) => ({ overlays: { ...state.overlays, [key]: !state.overlays[key] } }));
  },

  replaceSceneState: (slice) => {
    // 装载的 id 可能是任意外部格式（模版 mannequin-A / 旧快照 ds-N）：
    // 把 uid 序号推进到所有 ds-N 之后，保证后续新增对象 id 不撞车
    for (const id of slice.order) {
      const match = /^ds-(\d+)$/.exec(id);
      if (match) uidSeq = Math.max(uidSeq, Number(match[1]));
    }
    set(() => {
      // 防御：活动机位/选中对象必须在装载后的对象表内，机位视角无机位时退回导演视角
      const activeCameraId =
        slice.activeCameraId && slice.objects[slice.activeCameraId]?.type === "camera"
          ? slice.activeCameraId
          : firstCameraId(slice.objects, slice.order);
      const viewMode = slice.viewMode === "camera" && !activeCameraId ? "director" : slice.viewMode;
      const selectedId = slice.selectedId && slice.objects[slice.selectedId] ? slice.selectedId : null;
      return {
        objects: slice.objects,
        order: slice.order,
        selectedId,
        viewMode,
        activeCameraId,
        aspect: slice.aspect,
        environment: slice.environment,
        scene: slice.scene,
        overlays: slice.overlays,
      };
    });
  },

  resetToSeed: () => {
    set(() => ({
      ...createSeedSceneState(),
      gizmoMode: "translate" as GizmoMode,
      // 剪贴板是会话级状态，重置空台时一并清空
      clipboard: null,
    }));
  },
}));
