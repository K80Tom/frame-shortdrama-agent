/**
 * 3D 导演台 · 命令执行器 + 撤销栈（与后端同构）
 *
 * 链路：directorCommandSchema 结构校验（zod，与后端 POST .../commands/validate 同一合同）
 * → store → 会话快照（snapshot.ts，session 模式全量无损）→ 后端同款纯函数 applyCommand
 * → 快照写回 store（replaceSceneState）→ inverse 入撤销栈。
 * undoDirectorCommand 弹出 inverse 经后端同款 undo 纯函数回放。
 *
 * 语义与后端 executor 对齐：
 * - save_scene / capture_view 是动作类命令：快照恒等，inverse 为 noop；
 *   真正的持久化走 persistence.ts、截图走 export/saveCapture.ts。
 * - undo 命令直接触发本地撤销栈（不压栈），返回 noop inverse。
 * - noop inverse 不压栈（撤销栈只保留可回滚的真实变更）。
 *
 * 本模块是 Pi SSE 将来的前端调用点：导出签名保持冻结
 * （executeDirectorCommand / undoDirectorCommand）。
 */
import { directorCommandSchema } from "../contracts";
import type { CommandInverse, DirectorCommand } from "../contracts";
import { applyCommand, undo as applyInverse } from "./executor-core";
import { fromSceneSnapshot, toSceneSnapshot } from "../snapshot";
import { useDirectorStore } from "../store";

/** 撤销栈上限（超出丢弃最旧记录） */
const UNDO_STACK_LIMIT = 100;

const undoStack: CommandInverse[] = [];

/**
 * 校验并执行一条 DirectorCommand，返回其 inverse。
 * 结构非法抛 zod ZodError；引用不存在对象等抛 CommandExecutionError（后端同款）。
 */
export function executeDirectorCommand(command: unknown): CommandInverse {
  const parsed = directorCommandSchema.parse(command) as DirectorCommand;

  // undo 是动作类命令：直接对本地撤销栈执行，不压栈（与后端「撤销由调用方执行」语义一致）
  if (parsed.type === "undo") {
    undoDirectorCommand();
    return { type: "noop", reason: "undo 已对本地撤销栈执行" };
  }

  const current = toSceneSnapshot(useDirectorStore.getState());
  const applied = applyCommand(current, parsed);
  writeBack(applied.snapshot);

  if (applied.inverse.type !== "noop") {
    undoStack.push(applied.inverse);
    if (undoStack.length > UNDO_STACK_LIMIT) undoStack.shift();
  }
  return applied.inverse;
}

/** 弹出栈顶 inverse 并回放；栈空返回 false */
export function undoDirectorCommand(): boolean {
  const inverse = undoStack.pop();
  if (!inverse) return false;
  const current = toSceneSnapshot(useDirectorStore.getState());
  writeBack(applyInverse(current, inverse));
  return true;
}

/** 当前撤销深度（UI 徽标 / 测试断言用） */
export function directorUndoDepth(): number {
  return undoStack.length;
}

/** 清空撤销栈（场景整体装载/换项目时调用） */
export function clearDirectorCommandHistory(): void {
  undoStack.length = 0;
}

function writeBack(snapshot: Parameters<typeof fromSceneSnapshot>[0]): void {
  const { slice } = fromSceneSnapshot(snapshot);
  useDirectorStore.getState().replaceSceneState(slice);
}
