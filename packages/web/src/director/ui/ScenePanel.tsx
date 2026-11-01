/**
 * 3D 导演台 · 场景面板（LibTV「3D场景」面板复刻，v2 正式实现，替换占位 stub）
 *
 * 无 props，直接读 store；PropertyPanel 在未选中对象时整体替换右栏渲染本组件，
 * 因此右栏容器（.ds-right，冻结布局类）由本组件自带。
 *
 * 字段（对齐 SPEC §6.1 本轮范围；「场景缩放/平移/旋转」本轮不做，也不留占位）：
 * - 天空颜色：色板 + hex 输入 → scene.skyColor（视口背景色，雾色跟随）
 * - 全景背景：上传 equirect 2:1 全景图 → scene.panoramaUrl（URL.createObjectURL，
 *   保存场景后可恢复、不落库）；已设置时显示缩略图 + 文件名 + 清除（revokeObjectURL）。
 *   文件名只存组件 state（objectURL 刷新即失效，名字无持久化意义）
 * - 全景球：水平旋转 slider 0-360° → scene.panoramaRotation；
 *   球形半径 slider 10-100m → scene.panoramaRadius（StageCanvas 消费渲染全景球）
 * - 角色标签：toggle → overlays.nameTags（走现有 toggleOverlay）
 * - 网格吸附：toggle → scene.gridSnap（gizmo 平移 0.25m / 旋转 15°，SceneObjectNode 消费）
 * - 地面：toggle → scene.groundVisible（Grid 显隐联动）
 * - 透明度：slider 0-1 → scene.groundOpacity（地面材质不透明度）
 */
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";

import { readLocalFile } from "../local-storage";
import { useDirectorWorkspace } from "../workspace-context";

import { useDirectorStore } from "../store";

import "./ScenePanel.css";

/* ──────────────────────────── 基础控件 ──────────────────────────── */

/** 开关行：LibTV 式 label 居左 + toggle 居右（role=switch 语义） */
function ToggleRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="ds-scene__row">
      <span className="ds-scene__label">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={checked ? "ds-scene__toggle ds-scene__toggle--on" : "ds-scene__toggle"}
        onClick={onToggle}
      >
        <span className="ds-scene__toggle-knob" />
      </button>
    </div>
  );
}

/**
 * hex 输入：本地草稿允许中间态；合法值（#RRGGBB，# 可省略）在 Enter/失焦时提交
 * （统一转大写写入），非法值或 Escape 回显 store 当前值。
 */
function HexField({ value, onCommit }: { value: string; onCommit: (next: string) => void }) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const match = draft.trim().match(/^#?([0-9a-fA-F]{6})$/);
    if (match?.[1]) onCommit(`#${match[1].toUpperCase()}`);
    else setDraft(value);
  };

  return (
    <input
      type="text"
      className="ds-scene__hex"
      value={draft}
      spellCheck={false}
      maxLength={7}
      aria-label="天空颜色 hex"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
        event.stopPropagation();
      }}
    />
  );
}

/* ──────────────────────────── 面板主体 ──────────────────────────── */

export function ScenePanel() {
  const workspace = useDirectorWorkspace();
  const skyColor = useDirectorStore((state) => state.scene.skyColor);
  const panoramaUrl = useDirectorStore((state) => state.scene.panoramaUrl);
  const panoramaRotation = useDirectorStore((state) => state.scene.panoramaRotation);
  const panoramaRadius = useDirectorStore((state) => state.scene.panoramaRadius);
  const groundVisible = useDirectorStore((state) => state.scene.groundVisible);
  const groundOpacity = useDirectorStore((state) => state.scene.groundOpacity);
  const gridSnap = useDirectorStore((state) => state.scene.gridSnap);
  const nameTags = useDirectorStore((state) => state.overlays.nameTags);
  const setSceneSettings = useDirectorStore((state) => state.setSceneSettings);
  const toggleOverlay = useDirectorStore((state) => state.toggleOverlay);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [panoramaName, setPanoramaName] = useState<string | null>(null);

  const opacityPercent = Math.round(groundOpacity * 100);
  const rotationPercent = (panoramaRotation / 360) * 100;
  const radiusPercent = ((panoramaRadius - 10) / 90) * 100;

  const handlePanoramaPick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 全景图。');
      const url = await readLocalFile(file, 8);
      setPanoramaName(file.name);
      setSceneSettings({ panoramaUrl: url });
    } catch (error) { workspace?.notify(error instanceof Error ? error.message : '全景图读取失败。'); }
  };

  const handlePanoramaClear = () => {
    if (panoramaUrl) URL.revokeObjectURL(panoramaUrl);
    setPanoramaName(null);
    setSceneSettings({ panoramaUrl: null });
  };

  return (
    <aside className="ds-right ds-scene">
      <div className="ds-scene__head">3D场景</div>
      <div className="ds-scene__body">
        <section className="ds-scene__sec">
          <div className="ds-scene__sec-title">天空颜色</div>
          <div className="ds-scene__color-row">
            <input
              type="color"
              className="ds-scene__color"
              aria-label="天空颜色"
              value={skyColor}
              onChange={(event) => setSceneSettings({ skyColor: event.target.value.toUpperCase() })}
            />
            <HexField value={skyColor} onCommit={(next) => setSceneSettings({ skyColor: next })} />
          </div>
        </section>

        <section className="ds-scene__sec">
          <div className="ds-scene__sec-title">全景背景</div>
          {panoramaUrl ? (
            <>
              <div className="ds-scene__pano">
                <img className="ds-scene__pano-thumb" src={panoramaUrl} alt="全景图缩略图" />
                <span className="ds-scene__pano-name" title={panoramaName ?? undefined}>
                  {panoramaName ?? "全景图"}
                </span>
                <button type="button" className="ds-scene__pano-clear" onClick={handlePanoramaClear}>
                  清除
                </button>
              </div>
              {/* 资源限制明示：objectURL 保存场景后可恢复，保存快照置空并打 ephemeral 标记 */}
              <p className="ds-scene__pano-hint">保存场景时一并保留，可导出 JSON 备份</p>
            </>
          ) : (
            <>
              <button
                type="button"
                className="ds-scene__pano-upload"
                onClick={() => fileRef.current?.click()}
              >
                上传全景图
              </button>
              <p className="ds-scene__pano-hint">支持 2:1 等距柱状全景图</p>
              <p className="ds-scene__pano-hint">保存场景时一并保留，可导出 JSON 备份</p>
            </>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="ds-scene__pano-input"
            aria-label="选择全景图文件"
            onChange={handlePanoramaPick}
          />
        </section>

        <section className="ds-scene__sec">
          <div className="ds-scene__sec-title">全景球</div>
          {/* S8 bug5 修复：无全景图时滑杆禁用并说明——此前滑杆假活，拖了画面无反应（DC 实测投诉）。
              有全景图时旋转/半径实时生效（e2e 像素级验证） */}
          <div className="ds-scene__slider-row">
            <label>水平旋转</label>
            <input
              type="range"
              min={0}
              max={360}
              step={1}
              value={panoramaRotation}
              aria-label="全景球水平旋转"
              disabled={!panoramaUrl}
              style={{
                background: `linear-gradient(to right, var(--ds-accent) ${rotationPercent}%, var(--ds-menu-active) ${rotationPercent}%)`,
              }}
              onChange={(event) =>
                setSceneSettings({ panoramaRotation: Number(event.target.value) })
              }
            />
            <span className="ds-scene__slider-val">{Math.round(panoramaRotation)}°</span>
          </div>
          <div className="ds-scene__slider-row">
            <label>球形半径</label>
            <input
              type="range"
              min={10}
              max={100}
              step={1}
              value={panoramaRadius}
              aria-label="全景球半径"
              disabled={!panoramaUrl}
              style={{
                background: `linear-gradient(to right, var(--ds-accent) ${radiusPercent}%, var(--ds-menu-active) ${radiusPercent}%)`,
              }}
              onChange={(event) => setSceneSettings({ panoramaRadius: Number(event.target.value) })}
            />
            <span className="ds-scene__slider-val">{Math.round(panoramaRadius)}m</span>
          </div>
          {!panoramaUrl ? <p className="ds-scene__pano-hint">上传全景图后可实时调整</p> : null}
        </section>

        <section className="ds-scene__sec">
          <ToggleRow label="角色标签" checked={nameTags} onToggle={() => toggleOverlay("nameTags")} />
          <ToggleRow
            label="网格吸附"
            checked={gridSnap}
            onToggle={() => setSceneSettings({ gridSnap: !gridSnap })}
          />
          <ToggleRow
            label="地面"
            checked={groundVisible}
            onToggle={() => setSceneSettings({ groundVisible: !groundVisible })}
          />
          <div className="ds-scene__slider-row">
            <label>透明度</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={groundOpacity}
              aria-label="地面透明度"
              style={{
                background: `linear-gradient(to right, var(--ds-accent) ${opacityPercent}%, var(--ds-menu-active) ${opacityPercent}%)`,
              }}
              onChange={(event) => setSceneSettings({ groundOpacity: Number(event.target.value) })}
            />
            <span className="ds-scene__slider-val">{groundOpacity.toFixed(2)}</span>
          </div>
        </section>
      </div>
    </aside>
  );
}
