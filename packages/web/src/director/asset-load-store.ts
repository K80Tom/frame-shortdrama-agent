/**
 * 3D 导演台 · 资产 GLB 加载状态（W5.5 · 资产面板进度/失败态）
 *
 * 与 useDirectorStore 分离：这里只装「URL → 加载态」的瞬时 UI 状态（可随会话丢弃，
 * 不进场景快照）。流向：
 * - AssetsPanel 点「添加」→ begin(url) → addObject（对象落场景中心）
 * - UploadedModel 归一化完成 → done(url)（面板进度态解除）
 * - ModelGuard 捕获加载异常 → fail(url, message)（面板显示人话错误）
 * - 面板点「重试」→ retry(url)：清 useLoader 缓存 + attempt+1，
 *   ModelGuard 以 attempt 为 key 重挂载子树重新加载
 *
 * 本模块只在 UI 渲染链引用（不经 node:test 直接 import），因此可以依赖 three/R3F。
 */
import { create } from "zustand";
import { useLoader } from "@react-three/fiber";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export interface ModelLoadEntry {
  status: "loading" | "error";
  /** 人话错误（humanModelLoadError 产出） */
  message?: string;
  /** 重试代数：ModelGuard 用它做子树 key，+1 即重挂载 */
  attempt: number;
}

export interface AssetLoadState {
  byUrl: Record<string, ModelLoadEntry>;
  /** 标记开始加载（同 URL 重复添加时复位进度态） */
  begin: (url: string) => void;
  /** 加载完成（无记录时静默忽略——本地上传等不走面板的入口不上报） */
  done: (url: string) => void;
  /** 加载失败（ModelGuard 上报人话错误） */
  fail: (url: string, message: string) => void;
  /** 重试：清 three 侧缓存并推进 attempt（无记录时退化为 begin） */
  retry: (url: string) => void;
}

export const useAssetLoadStore = create<AssetLoadState>()((set) => ({
  byUrl: {},

  begin: (url) => {
    set((state) => ({
      byUrl: { ...state.byUrl, [url]: { status: "loading", attempt: state.byUrl[url]?.attempt ?? 0 } },
    }));
  },

  done: (url) => {
    set((state) => {
      if (!state.byUrl[url]) return state;
      const byUrl = { ...state.byUrl };
      delete byUrl[url];
      return { byUrl };
    });
  },

  fail: (url, message) => {
    set((state) => {
      const entry = state.byUrl[url];
      if (!entry) return state;
      return { byUrl: { ...state.byUrl, [url]: { ...entry, status: "error", message } } };
    });
  },

  retry: (url) => {
    // useLoader 连错误一起缓存，不清缓存重挂载会立刻再次抛同一个错
    useLoader.clear(GLTFLoader, url);
    set((state) => ({
      byUrl: {
        ...state.byUrl,
        [url]: { status: "loading", attempt: (state.byUrl[url]?.attempt ?? 0) + 1 },
      },
    }));
  },
}));
