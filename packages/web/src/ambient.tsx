import { useEffect, useRef } from 'react';

/**
 * LibTV 风格环境层：
 * - ambient-backdrop：深色底上的紫蓝极光光晕 + 网格纹理 + 暗角，铺在整个工作台后面；
 * - ambient-clickfx：监听全局 pointerdown，在点击位置生成渐隐的涟漪反馈。
 * 两者都 pointer-events:none，不影响任何交互；跟随系统“减弱动态效果”自动停用。
 */
export function AmbientFX() {
  const clickLayer = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const spawn = (event: PointerEvent) => {
      if (reduced.matches) return;
      const layer = clickLayer.current;
      if (!layer || layer.childElementCount > 24) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const ripple = document.createElement('span');
      ripple.className = 'ambient-ripple';
      ripple.style.left = `${event.clientX}px`;
      ripple.style.top = `${event.clientY}px`;
      layer.appendChild(ripple);
      window.setTimeout(() => { ripple.remove(); }, 700);
    };
    window.addEventListener('pointerdown', spawn);
    return () => window.removeEventListener('pointerdown', spawn);
  }, []);
  return <>
    <div className="ambient-backdrop" aria-hidden="true">
      <span className="ambient-aurora a1" />
      <span className="ambient-aurora a2" />
      <span className="ambient-aurora a3" />
      <span className="ambient-grid" />
      <span className="ambient-vignette" />
    </div>
    <div className="ambient-clickfx" ref={clickLayer} aria-hidden="true" />
  </>;
}
