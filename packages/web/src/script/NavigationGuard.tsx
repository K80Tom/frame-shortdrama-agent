import { useEffect } from 'react';

const DEFAULT_LEAVE_MESSAGE = '离开剧本工作台会丢失未保存的场次修改；已提交的保存请求不保证取消。确定离开？';

/**
 * 剧本工作台离开保护。
 * - `dirty` 为真时注册浏览器 `beforeunload`，拦截关闭标签页 / 刷新 / 跨页跳转；
 * - 通过 `onUnsavedChange` 把脏状态上报父级，内部 hash 导航由既有 navigation-guard 统一拦截；
 * - 保存后 `dirty` 变假，监听器解除、上报清除，不再弹出确认。
 */
export function NavigationGuard({ dirty, onUnsavedChange, message = DEFAULT_LEAVE_MESSAGE }: {
  dirty: boolean;
  onUnsavedChange?: (dirty: boolean) => void;
  message?: string;
}) {
  useEffect(() => {
    onUnsavedChange?.(dirty);
  }, [dirty, onUnsavedChange]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = message;
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, message]);

  return null;
}
