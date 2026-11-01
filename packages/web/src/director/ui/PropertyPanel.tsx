/**
 * 3D 导演台 · 右栏属性面板（Wave 2 · UI 面板 agent）
 *
 * 随选中对象类型切换属性区（未选中对象时渲染场景面板 ScenePanel，CONTRACT §8）：
 * - 公共：名称 + 位置/旋转/缩放 XYZ 数值输入（角度制，与 store 双向同步；机位除外）
 * - 素模：体型选择（BODY_TYPES 8 种）+ 8 色 swatch + 姿势预设 4列×5行 按钮网格
 *   （SPEC §9.1，当前项高亮）+ 姿势调节语义关节树（JOINT_GROUPS：组名/左右 badge/
 *   逐轴 滑杆+数值框，量程取关节定义 min/max）+ 重置微调；
 *   「缩放」XYZ 下有统一缩放行（对齐 LibTV 角色属性：滑杆 0.5-2.0 step 0.05 + 数值，
 *   写 scale=[v,v,v]，当前值取 scale.x）
 * - 机位：顶部实时预览缩略图（LibTV §6.3：选中机位视角离屏渲染，宽满面板、高按当前
 *   画幅比，左上角 FOV 角标；触发=选中机位/机位 position·target·focal/画幅变化 +
 *   手动刷新，不做连续自动渲染）+ 焦段五档（16/24/35/50/85mm）+ 位置 XYZ + 目标点 XYZ
 * - 几何：形状名 + 尺寸 XYZ + 颜色
 * - 阵列：行/列/间距 stepper（1-10 / 1-10 / 0.5-5）；颜色输入已移除——群众阵列为
 *   多彩人偶（CrowdArray 多彩化由并行 agent 实现）
 * - 模型：文件名（缩放走公共变换区）
 *
 * 几何尺寸经 store.updateGeometry 写入（Wave 3 已补该 action，替代 Wave 2 的
 * setState 绕行）。
 */
import { useEffect, useRef, useState } from "react";

import { useDirectorStore } from "../store";
import { ASPECT_RATIO_VALUE, BODY_TYPES, FOCAL_LENGTHS, OBJECT_KIND_LABELS } from "../types";
import type {
  BodyTypeId,
  CameraObject,
  CrowdObject,
  GeometryObject,
  GeometryShape,
  MannequinObject,
  Vec3,
} from "../types";
import { JOINT_GROUPS, POSE_PRESETS, resolvePoseId } from "../scene/poses";
import { focalToVfov } from "../scene/StageCamera";
import { renderCameraPreview } from "../export/captureShot";
import { ScenePanel } from "./ScenePanel";

import "./PropertyPanel.css";

/* ──────────────────────────── 常量 ──────────────────────────── */

/** 素模 8 色 swatch：移植原型 FIGURE_COLORS（统一大写 hex 约定） */
const MANNEQUIN_COLORS = [
  "#9AA0A8",
  "#6B9BD8",
  "#D88AA0",
  "#C96A5E",
  "#7FB98A",
  "#D8B96A",
  "#9A86D8",
  "#6AC6C6",
];

const GEOMETRY_SHAPE_LABELS: Record<GeometryShape, string> = {
  box: "立方体",
  sphere: "球体",
  cylinder: "圆柱体",
  cone: "圆锥体",
  torus: "圆环",
  plane: "平面",
};

const AXIS_LABELS = ["X", "Y", "Z"] as const;

/** 关节微调缺省值（无微调记录时视为零向量） */
const ZERO_VEC: Vec3 = [0, 0, 0];

/* ──────────────────────────── 工具 ──────────────────────────── */

function withAxis(vec: Vec3, axis: number, next: number): Vec3 {
  const copy: Vec3 = [...vec];
  copy[axis] = next;
  return copy;
}

function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/* ──────────────────────────── 基础输入件 ──────────────────────────── */

/** 数值输入：本地草稿允许中间态（"-"、"1."），合法即实时提交；失焦回显 store 值 */
function NumberField({
  value,
  step = 0.1,
  onCommit,
}: {
  value: number;
  step?: number;
  onCommit: (next: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(() => formatNumber(value));

  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(formatNumber(value));
  }, [value]);

  return (
    <input
      ref={inputRef}
      type="number"
      step={step}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        const next = Number.parseFloat(event.target.value);
        if (Number.isFinite(next)) onCommit(next);
      }}
      onBlur={() => setDraft(formatNumber(value))}
    />
  );
}

/** XYZ 三轴数值行（角度/米制均由调用方保证，此处纯数值） */
function Vec3Row({
  label,
  value,
  step,
  onCommit,
}: {
  label?: string;
  value: Vec3;
  step?: number;
  onCommit: (axis: number, next: number) => void;
}) {
  return (
    <div className="ds-props__row">
      {label ? <label className="ds-props__label">{label}</label> : null}
      <div className="ds-props__triad">
        {AXIS_LABELS.map((axis, index) => (
          <span key={axis} className="ds-props__axis" data-axis={axis}>
            <NumberField value={value[index] ?? 0} step={step} onCommit={(next) => onCommit(index, next)} />
          </span>
        ))}
      </div>
    </div>
  );
}

/** 名称输入：失焦 / Enter 提交（store 自动 trim、空名忽略），Escape 还原 */
function NameField({ name, onCommit }: { name: string; onCommit: (next: string) => void }) {
  const [draft, setDraft] = useState(name);
  const cancelledRef = useRef(false);

  useEffect(() => setDraft(name), [name]);

  const commit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    if (draft.trim() && draft.trim() !== name) onCommit(draft);
    else setDraft(name);
  };

  return (
    <input
      type="text"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          cancelledRef.current = true;
          setDraft(name);
          event.currentTarget.blur();
        }
        event.stopPropagation();
      }}
    />
  );
}

/** 颜色行：color input + 当前 hex 文本（写回 store 统一转大写） */
function ColorRow({ color, onChange }: { color: string; onChange: (next: string) => void }) {
  return (
    <div className="ds-props__row">
      <input
        type="color"
        className="ds-props__color"
        value={color}
        onChange={(event) => onChange(event.target.value.toUpperCase())}
      />
      <span className="ds-props__hint">{color}</span>
    </div>
  );
}

/** 步进器行：− 值 ＋（阵列参数用） */
function StepperRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const nudge = (dir: 1 | -1) => onChange(clamp(Math.round((value + dir * step) * 100) / 100));
  return (
    <div className="ds-props__row">
      <label className="ds-props__label">{label}</label>
      <div className="ds-props__stepper">
        <button type="button" aria-label={`${label}减`} disabled={value <= min} onClick={() => nudge(-1)}>
          −
        </button>
        <span className="ds-props__stepper-val">{step < 1 ? value.toFixed(1) : value}</span>
        <button type="button" aria-label={`${label}加`} disabled={value >= max} onClick={() => nudge(1)}>
          ＋
        </button>
      </div>
    </div>
  );
}

/** 统一缩放行（对齐 LibTV 角色属性：滑杆 0.5-2.0 step 0.05 + 数值框；写 scale=[v,v,v]） */
function UniformScaleRow({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  const commit = (next: number) => onChange(Math.min(2, Math.max(0.5, next)));
  return (
    <div className="ds-props__slider-row ds-props__uniform-scale">
      <label>统一缩放</label>
      <input
        type="range"
        min={0.5}
        max={2}
        step={0.05}
        value={value}
        onChange={(event) => commit(Number(event.target.value))}
      />
      <span className="ds-props__axis-num">
        <NumberField value={value} step={0.05} onCommit={commit} />
      </span>
    </div>
  );
}

/* ──────────────────────────── 各类型属性区 ──────────────────────────── */

function MannequinSections({ object }: { object: MannequinObject }) {
  const setColor = useDirectorStore((state) => state.setColor);
  const setPose = useDirectorStore((state) => state.setPose);
  const setBodyType = useDirectorStore((state) => state.setBodyType);
  const setJoint = useDirectorStore((state) => state.setJoint);

  // store 里 pose 可能是 PoseId（stand…）或中文标签（种子场景「站立」），统一解析后回显
  const currentPose = resolvePoseId(object.pose);

  return (
    <>
      <section className="ds-props__sec">
        <div className="ds-props__sec-title">体型</div>
        <div className="ds-props__select-wrap">
          <select
            value={object.bodyType}
            onChange={(event) => setBodyType(object.id, event.target.value as BodyTypeId)}
          >
            {BODY_TYPES.map((bodyType) => (
              <option key={bodyType.id} value={bodyType.id}>
                {bodyType.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="ds-props__sec">
        <div className="ds-props__sec-title">配色</div>
        <div className="ds-props__swatches">
          {MANNEQUIN_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              title={color}
              className={
                color.toLowerCase() === object.color.toLowerCase()
                  ? "ds-props__swatch ds-props__swatch--on"
                  : "ds-props__swatch"
              }
              style={{ background: color }}
              onClick={() => setColor(object.id, color)}
            />
          ))}
        </div>
      </section>

      <section className="ds-props__sec">
        <div className="ds-props__sec-title">姿势预设</div>
        <div className="ds-props__pose-grid">
          {POSE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={
                preset.id === currentPose
                  ? "ds-props__pose-btn ds-props__pose-btn--on"
                  : "ds-props__pose-btn"
              }
              onClick={() => setPose(object.id, preset.id)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </section>

      <section className="ds-props__sec">
        <div className="ds-props__sec-title">姿势调节</div>
        {JOINT_GROUPS.map((joint, index) => {
          // label 相同且相邻的项归为一组，只在首项渲染组名（手臂—肩/肘部/腿部—髋/膝部）
          const showGroupName = index === 0 || JOINT_GROUPS[index - 1]?.label !== joint.label;
          const value = object.joints[joint.id] ?? ZERO_VEC;
          return (
            <div className="ds-props__joint" key={joint.id}>
              {showGroupName ? <div className="ds-props__joint-group">{joint.label}</div> : null}
              {joint.side ? (
                <span
                  className={
                    joint.side === "L"
                      ? "ds-props__joint-badge ds-props__joint-badge--l"
                      : "ds-props__joint-badge ds-props__joint-badge--r"
                  }
                >
                  {joint.side === "L" ? "左" : "右"}
                </span>
              ) : null}
              {joint.axes.map((axis) => (
                <div className="ds-props__slider-row" key={axis.label}>
                  <label>{axis.label}</label>
                  <input
                    type="range"
                    min={axis.min}
                    max={axis.max}
                    step={1}
                    value={value[axis.axis]}
                    onChange={(event) =>
                      setJoint(
                        object.id,
                        joint.id,
                        withAxis(value, axis.axis, Number(event.target.value)),
                      )
                    }
                  />
                  <span className="ds-props__axis-num">
                    <NumberField
                      value={value[axis.axis]}
                      step={1}
                      onCommit={(next) => setJoint(object.id, joint.id, withAxis(value, axis.axis, next))}
                    />
                  </span>
                </div>
              ))}
            </div>
          );
        })}
        <div className="ds-props__btn-row">
          <button
            type="button"
            className="ds-props__btn"
            onClick={() => {
              // store 只有单关节 setJoint：把已存在的微调键全部归零即等效清空
              // （含 v1 旧关节 id 残留；未出现的键本就等于 [0,0,0]）
              for (const key of Object.keys(object.joints)) {
                setJoint(object.id, key, [0, 0, 0]);
              }
            }}
          >
            重置微调
          </button>
        </div>
      </section>
    </>
  );
}

/**
 * 机位实时预览缩略图（LibTV §6.3）：复用 export/captureShot 离屏路径渲一帧小图。
 * 触发时机：选中机位/该机位 position·target·focal 变化（object 引用随 store 更新即变）、
 * 画幅变化（aspectValue）+ 手动刷新按钮；不做连续自动渲染（性能）。
 * StrictMode 下 effect 双执行 → 同参数重渲两帧，幂等无害。
 * auto 档取 ASPECT_RATIO_VALUE 回退值 16/9（与导出「auto 按 16:9 处理」一致）。
 */
function CameraPreview({ object }: { object: CameraObject }) {
  const aspect = useDirectorStore((state) => state.aspect);
  const aspectValue = ASPECT_RATIO_VALUE[aspect];
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    setUrl(renderCameraPreview(object, { aspectValue }));
  }, [object, aspectValue]);

  const fov = Math.round(focalToVfov(object.focalLength, aspectValue));

  return (
    <div className="ds-cam-preview" style={{ aspectRatio: `${aspectValue}` }}>
      {url ? (
        <img className="ds-cam-preview__img" src={url} alt={`${object.name} 机位预览`} />
      ) : (
        <div className="ds-cam-preview__empty">预览未就绪（点右下角刷新）</div>
      )}
      <span className="ds-cam-preview__fov">FOV {fov}°</span>
      <button
        type="button"
        className="ds-cam-preview__refresh"
        title="刷新预览"
        onClick={() => setUrl(renderCameraPreview(object, { aspectValue }))}
      >
        ↻
      </button>
    </div>
  );
}

function CameraSections({ object }: { object: CameraObject }) {
  const updateCamera = useDirectorStore((state) => state.updateCamera);
  const updateTransform = useDirectorStore((state) => state.updateTransform);

  return (
    <>
      <section className="ds-props__sec">
        <CameraPreview object={object} />
      </section>

      <section className="ds-props__sec">
        <div className="ds-props__sec-title">焦段（等效全画幅，mm）</div>
        <div className="ds-props__focal">
          {FOCAL_LENGTHS.map((focal) => (
            <button
              key={focal}
              type="button"
              className={
                focal === object.focalLength
                  ? "ds-props__focal-btn ds-props__focal-btn--on"
                  : "ds-props__focal-btn"
              }
              onClick={() => updateCamera(object.id, { focalLength: focal })}
            >
              {focal}
            </button>
          ))}
        </div>
      </section>

      <section className="ds-props__sec">
        <div className="ds-props__sec-title">机位摆放</div>
        <Vec3Row
          label="位置"
          value={object.transform.position}
          onCommit={(axis, next) =>
            updateTransform(object.id, { position: withAxis(object.transform.position, axis, next) })
          }
        />
        <Vec3Row
          label="目标点"
          value={object.target}
          onCommit={(axis, next) => updateCamera(object.id, { target: withAxis(object.target, axis, next) })}
        />
        <div className="ds-props__hint">导演视角下可拖拽机身 gizmo 调整位置</div>
      </section>
    </>
  );
}

function GeometrySections({ object }: { object: GeometryObject }) {
  const setColor = useDirectorStore((state) => state.setColor);
  const updateGeometry = useDirectorStore((state) => state.updateGeometry);

  return (
    <>
      <section className="ds-props__sec">
        <div className="ds-props__sec-title">形状</div>
        <div className="ds-props__static">{GEOMETRY_SHAPE_LABELS[object.shape]}</div>
      </section>

      <section className="ds-props__sec">
        <div className="ds-props__sec-title">尺寸（米）</div>
        <Vec3Row
          value={object.size}
          step={0.05}
          onCommit={(axis, next) =>
            updateGeometry(object.id, { size: withAxis(object.size, axis, Math.max(0.02, next)) })
          }
        />
      </section>

      <section className="ds-props__sec">
        <div className="ds-props__sec-title">颜色</div>
        <ColorRow color={object.color} onChange={(color) => setColor(object.id, color)} />
      </section>
    </>
  );
}

function CrowdSections({ object }: { object: CrowdObject }) {
  const setCrowdParams = useDirectorStore((state) => state.setCrowdParams);

  return (
    <section className="ds-props__sec">
      <div className="ds-props__sec-title">阵列布局</div>
      <StepperRow
        label="行数"
        value={object.rows}
        min={1}
        max={10}
        step={1}
        onChange={(next) => setCrowdParams(object.id, { rows: next })}
      />
      <StepperRow
        label="列数"
        value={object.cols}
        min={1}
        max={10}
        step={1}
        onChange={(next) => setCrowdParams(object.id, { cols: next })}
      />
      <StepperRow
        label="间距m"
        value={object.spacing}
        min={0.5}
        max={5}
        step={0.1}
        onChange={(next) => setCrowdParams(object.id, { spacing: next })}
      />
      <div className="ds-props__hint">共 {object.rows * object.cols} 人，整体可用 gizmo 拖拽</div>
      <div className="ds-props__hint">群众阵列为多彩人偶</div>
    </section>
  );
}

/* ──────────────────────────── 面板主体 ──────────────────────────── */

export function PropertyPanel() {
  const object = useDirectorStore((state) => (state.selectedId ? state.objects[state.selectedId] : undefined));
  const renameObject = useDirectorStore((state) => state.renameObject);
  const updateTransform = useDirectorStore((state) => state.updateTransform);

  // 未选中对象：右栏整体换成场景面板（LibTV「3D场景」面板；容器归 ScenePanel 自带）
  if (!object) return <ScenePanel />;

  return (
    <aside className="ds-right ds-props">
      <div className="ds-props__head">属性</div>
      {/* key 按对象切换重置各输入件本地草稿 */}
      <div className="ds-props__body" key={object.id}>
          <div className="ds-props__kind">{OBJECT_KIND_LABELS[object.type]}</div>

          <section className="ds-props__sec">
            <div className="ds-props__row">
              <label className="ds-props__label">名称</label>
              <NameField name={object.name} onCommit={(name) => renameObject(object.id, name)} />
            </div>
          </section>

          {object.type !== "camera" ? (
            <section className="ds-props__sec">
              <div className="ds-props__sec-title">变换</div>
              <Vec3Row
                label="位置"
                value={object.transform.position}
                onCommit={(axis, next) =>
                  updateTransform(object.id, { position: withAxis(object.transform.position, axis, next) })
                }
              />
              <Vec3Row
                label="旋转°"
                value={object.transform.rotation}
                step={1}
                onCommit={(axis, next) =>
                  updateTransform(object.id, { rotation: withAxis(object.transform.rotation, axis, next) })
                }
              />
              <Vec3Row
                label="缩放"
                value={object.transform.scale}
                onCommit={(axis, next) =>
                  updateTransform(object.id, { scale: withAxis(object.transform.scale, axis, next) })
                }
              />
              {object.type === "mannequin" ? (
                <UniformScaleRow
                  value={object.transform.scale[0]}
                  onChange={(next) => updateTransform(object.id, { scale: [next, next, next] })}
                />
              ) : null}
            </section>
          ) : null}

          {object.type === "mannequin" ? <MannequinSections object={object} /> : null}
          {object.type === "camera" ? <CameraSections object={object} /> : null}
          {object.type === "geometry" ? <GeometrySections object={object} /> : null}
          {object.type === "crowd" ? <CrowdSections object={object} /> : null}
          {object.type === "model" ? (
            <section className="ds-props__sec">
              <div className="ds-props__sec-title">来源</div>
              <div className="ds-props__hint" title={object.fileName}>
                {object.fileName || "本地上传"}
              </div>
              {/* 资源限制明示：blob: objectURL 不落库，保存快照打 ephemeral 标记，加载跳过 */}
              <div className="ds-props__hint">本地临时，保存场景后不保留</div>
            </section>
          ) : null}
        </div>
    </aside>
  );
}
