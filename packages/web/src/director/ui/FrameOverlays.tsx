/**
 * 3D 导演台 · 机位视角画幅遮幅与构图叠加层（Wave 2 · 相机模块）
 *
 * 纯 DOM 覆盖层，不进 Canvas：由页面侧挂在 .ds-viewport 容器内（StageCanvas 之后，
 * 见交接说明），仅 viewMode === "camera" 时显示，pointer-events: none 不拦截 3D 交互。
 *
 * - 遮幅：按 store.aspect 求视口内最大画幅矩形，矩形外用大范围 box-shadow 压暗
 *   （letterbox/pillarbox；矩形算法与 ResizeObserver 跟随移植原型
 *   frameRect()/updateOverlayRect() ~L1371）。auto 档不渲染遮幅——画幅矩形取满
 *   全视口并去掉压暗阴影（辅助线同样按全视口画，对齐「auto=跟随视口」语义）；
 * - 构图线：按 store.overlays 画三分线 / 中心线 / 安全区（画面内缩 12% 虚线框，
 *   原型 .ov-thirds/.ov-center/.ov-safe ~L182，安全区内缩比例按任务要求 12%）。
 */
import { useLayoutEffect, useRef, useState } from "react";

import { useDirectorStore } from "../store";
import { ASPECT_RATIO_VALUE } from "../types";
import "./FrameOverlays.css";

interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function FrameOverlays() {
  const active = useDirectorStore((state) => state.viewMode === "camera");
  const aspect = useDirectorStore((state) => state.aspect);
  const thirds = useDirectorStore((state) => state.overlays.thirds);
  const center = useDirectorStore((state) => state.overlays.center);
  const safeArea = useDirectorStore((state) => state.overlays.safeArea);

  const rootRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<FrameRect | null>(null);

  // 视口内按画幅取最大内接矩形（原型 frameRect）；ResizeObserver 跟随视口尺寸
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const update = () => {
      const { clientWidth: w, clientHeight: h } = element;
      if (!w || !h) return;
      // auto：不遮幅，画幅矩形取满全视口（构图辅助线也按全视口画）
      if (aspect === "auto") {
        setRect({ x: 0, y: 0, w, h });
        return;
      }
      const a = ASPECT_RATIO_VALUE[aspect];
      let rw = w;
      let rh = w / a;
      if (rh > h) {
        rh = h;
        rw = h * a;
      }
      setRect({ x: (w - rw) / 2, y: (h - rh) / 2, w: rw, h: rh });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, aspect]);

  if (!active) return null;

  return (
    <div ref={rootRef} className="ds-frame-overlays" aria-hidden="true">
      {rect ? (
        <div
          className={
            aspect === "auto"
              ? "ds-frame-overlays__frame ds-frame-overlays__frame--auto"
              : "ds-frame-overlays__frame"
          }
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        >
          {thirds ? (
            <div className="ds-frame-overlays__layer">
              <i
                className="ds-frame-overlays__line ds-frame-overlays__line--v"
                style={{ left: "33.3333%" }}
              />
              <i
                className="ds-frame-overlays__line ds-frame-overlays__line--v"
                style={{ left: "66.6667%" }}
              />
              <i
                className="ds-frame-overlays__line ds-frame-overlays__line--h"
                style={{ top: "33.3333%" }}
              />
              <i
                className="ds-frame-overlays__line ds-frame-overlays__line--h"
                style={{ top: "66.6667%" }}
              />
            </div>
          ) : null}
          {center ? (
            <div className="ds-frame-overlays__layer">
              <i
                className="ds-frame-overlays__line ds-frame-overlays__line--v"
                style={{ left: "50%" }}
              />
              <i
                className="ds-frame-overlays__line ds-frame-overlays__line--h"
                style={{ top: "50%" }}
              />
            </div>
          ) : null}
          {safeArea ? <div className="ds-frame-overlays__safe" /> : null}
        </div>
      ) : null}
    </div>
  );
}
