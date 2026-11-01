/**
 * 3D 导演台 · 左栏对象清单（Wave 2 · UI 面板 agent；v3 搜索框 + 群众组折叠；W5.5 清空按钮）
 *
 * W5.5：根节点从 <aside class="ds-left"> 改为 <div class="ds-objlist">（外层 LeftDock
 * 提供 .ds-left 网格位与页签）；头部新增「清空」按钮（二次点击确认态，3 秒未确认
 * 自动复位）→ store.clearSceneObjects 移除全部对象（保留环境设置）。
 *
 * 按 store.order 平铺全部对象（含机位）：
 * - 顶部搜索框（对齐 LibTV 左栏，SPEC §5）：占位「请输入搜索内容」+ 右侧放大镜
 *   （SVG），按名称大小写不敏感子串实时过滤；过滤时标题计数显示「N/M」，清空恢复全量
 * - 类型徽标文字（素模/几何/阵列/模型/机位）+ 素模色点
 * - 名称（双击进入重命名 input，Enter/失焦提交，Escape 取消；store 自动 trim、空名忽略）
 * - 眼睛切换 visible、× 删除
 * - 行点击选中，与 3D 场景选中双向同步（场景侧选中时清单自动滚动到可见）
 * - crowd 行渲染为可折叠组（对齐 LibTV 打组，SPEC §5）：组行 = CSS 折叠箭头 +
 *   组名「名称 (RxC)」（R/C 实时跟随 rows/cols）；展开时组内缩进列出成员名
 *   （角色A…，与 3D 名牌同一份 crowdMemberName；只读、不可选不可编——成员不是
 *   独立对象）；折叠状态组件内 useState，默认展开；
 *   组行本身的选中/眼睛/删除/重命名行为与普通行一致
 * 底部对象/机位统计（移植原型 leftFoot）。
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { crowdMemberName } from "../scene/CrowdArray";
import { useDirectorStore } from "../store";
import type { CrowdObject, ObjectKind, SceneObject } from "../types";

import "./ObjectListPanel.css";

/* ──────────────────────────── 常量与图标 ──────────────────────────── */

/** 类型徽标短文案（任务书指定；全称见 types.ts OBJECT_KIND_LABELS） */
const KIND_BADGES: Record<ObjectKind, string> = {
  mannequin: "素模",
  geometry: "几何",
  crowd: "阵列",
  model: "模型",
  camera: "机位",
};

const eyeSvgProps = {
  viewBox: "0 0 24 24",
  width: 14,
  height: 14,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
} as const;

const EYE_ON: ReactNode = (
  <svg {...eyeSvgProps}>
    <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </svg>
);

const EYE_OFF: ReactNode = (
  <svg {...eyeSvgProps}>
    <path d="M3 3l18 18M10.6 6.1A10.9 10.9 0 0122 12s-1.4 2.6-4 4.4M6.6 6.9C3.7 8.8 2 12 2 12s3.5 6.5 10 6.5c1.5 0 2.9-.3 4.1-.9" />
  </svg>
);

/* 搜索框右侧放大镜（SPEC §5；SVG 绘制，不用 emoji） */
const SEARCH_ICON: ReactNode = (
  <svg
    className="ds-objlist__search-icon"
    viewBox="0 0 24 24"
    width={12}
    height={12}
    fill="none"
    stroke="currentColor"
    strokeWidth={2.4}
  >
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </svg>
);

/* ──────────────────────────── 清单行 ──────────────────────────── */

function ObjectRow({ object, selected }: { object: SceneObject; selected: boolean }) {
  const select = useDirectorStore((state) => state.select);
  const setVisible = useDirectorStore((state) => state.setVisible);
  const removeObject = useDirectorStore((state) => state.removeObject);
  const renameObject = useDirectorStore((state) => state.renameObject);
  const [editing, setEditing] = useState(false);
  // 群众组折叠状态（默认展开，对齐 LibTV 左栏打组截图；仅 crowd 行消费）
  const [collapsed, setCollapsed] = useState(false);

  const classNames = ["ds-objlist__row"];
  if (selected) classNames.push("ds-objlist__row--selected");
  if (!object.visible) classNames.push("ds-objlist__row--hidden");

  const crowd: CrowdObject | null = object.type === "crowd" ? object : null;

  return (
    <>
      <li className={classNames.join(" ")} data-id={object.id} tabIndex={0} aria-label={`选中${object.name}`} onClick={() => select(object.id)} onKeyDown={event => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault(); event.stopPropagation(); select(object.id);
        }
      }}>
        {crowd ? (
          <button
            type="button"
            className={collapsed ? "ds-objlist__caret" : "ds-objlist__caret ds-objlist__caret--open"}
            title={collapsed ? "展开" : "折叠"}
            onClick={(event) => {
              event.stopPropagation();
              setCollapsed((value) => !value);
            }}
          />
        ) : null}
        <span className={`ds-objlist__badge ds-objlist__badge--${object.type}`}>{KIND_BADGES[object.type]}</span>
        {object.type === "mannequin" ? (
          <span className="ds-objlist__dot" style={{ background: object.color }} />
        ) : null}
        {editing ? (
          <input
            className="ds-objlist__rename"
            autoFocus
            defaultValue={object.name}
            onFocus={(event) => event.target.select()}
            onClick={(event) => event.stopPropagation()}
            onBlur={(event) => {
              renameObject(object.id, event.target.value);
              setEditing(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                event.currentTarget.value = object.name;
                event.currentTarget.blur();
              }
              event.stopPropagation();
            }}
          />
        ) : (
          <span
            className="ds-objlist__name"
            title={
              // P1-10：模型对象默认中文名入台，title 回显原始文件名（Female_LookingUp.glb）
              object.type === "model" && object.fileName
                ? `${object.fileName} · 双击重命名`
                : "双击重命名"
            }
            onDoubleClick={(event) => {
              event.stopPropagation();
              setEditing(true);
            }}
          >
            {object.name}
            {crowd ? (
              <span className="ds-objlist__dims">{` (${crowd.rows}x${crowd.cols})`}</span>
            ) : null}
          </span>
        )}
        <span className="ds-objlist__ops">
          <button
            type="button"
            className="ds-objlist__op"
            title={object.visible ? "隐藏" : "显示"}
            onClick={(event) => {
              event.stopPropagation();
              setVisible(object.id, !object.visible);
            }}
          >
            {object.visible ? EYE_ON : EYE_OFF}
          </button>
          <button
            type="button"
            className="ds-objlist__op ds-objlist__op--del"
            title="删除"
            onClick={(event) => {
              event.stopPropagation();
              removeObject(object.id);
            }}
          >
            ✕
          </button>
        </span>
      </li>
      {/* 群众组成员：只读缩进列出（成员不是独立对象，不可选不可编） */}
      {crowd && !collapsed
        ? Array.from({ length: crowd.rows * crowd.cols }, (_, index) => (
            <li key={index} className="ds-objlist__member">
              {crowdMemberName(index)}
            </li>
          ))
        : null}
    </>
  );
}

/* ──────────────────────────── 面板主体 ──────────────────────────── */

export function ObjectListPanel() {
  const objects = useDirectorStore((state) => state.objects);
  const order = useDirectorStore((state) => state.order);
  const selectedId = useDirectorStore((state) => state.selectedId);
  const clearSceneObjects = useDirectorStore((state) => state.clearSceneObjects);
  const [query, setQuery] = useState("");
  // 「清空」二次点击确认态（W5.5）：3 秒未确认自动复位，防误触
  const [confirmingClear, setConfirmingClear] = useState(false);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const listRef = useRef<HTMLUListElement>(null);

  // 场景侧选中时，清单对应行滚动到可见（双向同步）
  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    listRef.current
      .querySelector(`[data-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  useEffect(() => () => {
    if (clearTimer.current) clearTimeout(clearTimer.current);
  }, []);

  const handleClear = () => {
    if (!confirmingClear) {
      setConfirmingClear(true);
      if (clearTimer.current) clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setConfirmingClear(false), 3000);
      return;
    }
    if (clearTimer.current) clearTimeout(clearTimer.current);
    setConfirmingClear(false);
    clearSceneObjects();
  };

  const objectList: SceneObject[] = [];
  for (const id of order) {
    const object = objects[id];
    if (object) objectList.push(object);
  }
  const cameraCount = objectList.filter((object) => object.type === "camera").length;

  // 搜索过滤：名称大小写不敏感子串；空串 = 全量
  const keyword = query.trim().toLowerCase();
  const visibleList = keyword
    ? objectList.filter((object) => object.name.toLowerCase().includes(keyword))
    : objectList;

  return (
    <div className="ds-objlist">
      <div className="ds-objlist__head">
        场景对象
        <span className="ds-objlist__head-right">
          <span className="ds-objlist__count">
            {keyword ? `${visibleList.length}/${objectList.length}` : objectList.length}
          </span>
          <button
            type="button"
            className={
              confirmingClear ? "ds-objlist__clear ds-objlist__clear--confirm" : "ds-objlist__clear"
            }
            disabled={objectList.length === 0}
            title="清空全部对象与机位（环境设置保留；需二次确认）"
            onClick={handleClear}
          >
            {confirmingClear ? "确认清空？" : "清空场景"}
          </button>
        </span>
      </div>
      <div className="ds-objlist__search">
        <input
          className="ds-objlist__search-input"
          type="text"
          autoComplete="off"
          value={query}
          placeholder="请输入搜索内容"
          onChange={(event) => setQuery(event.target.value)}
        />
        {SEARCH_ICON}
      </div>
      <ul className="ds-objlist__list" ref={listRef}>
        {visibleList.map((object) => (
          <ObjectRow key={object.id} object={object} selected={object.id === selectedId} />
        ))}
      </ul>
      <div className="ds-objlist__foot">
        对象 {objectList.length - cameraCount} · 机位 {cameraCount}
      </div>
    </div>
  );
}
