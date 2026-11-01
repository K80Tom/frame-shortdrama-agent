/**
 * 3D 导演台 · 渲染运行时单例（Wave 1 冻结）
 *
 * 用途：导出模块（export/）在 React 树外拿到 three 渲染上下文，
 * 用活动机位 gl.render(scene, camera) 后 toDataURL 出图。
 * StageCanvas 挂载时 register、卸载时 unregister。
 *
 * 注意：这里只存渲染上下文，不存领域数据（领域数据在 ./store）。
 */
import type { Scene, WebGLRenderer } from "three";

export interface DirectorRuntimeContext {
  gl: WebGLRenderer;
  scene: Scene;
}

let current: DirectorRuntimeContext | null = null;

export const directorRuntime = {
  /** StageCanvas 挂载时调用；重复调用以后者覆盖（严格模式双挂载安全） */
  register(context: DirectorRuntimeContext): void {
    current = context;
  },
  unregister(): void {
    current = null;
  },
  isReady(): boolean {
    return current !== null;
  },
  /** 未就绪返回 null；调用方应先 isReady() 或判空 */
  getContext(): DirectorRuntimeContext | null {
    return current;
  },
};
