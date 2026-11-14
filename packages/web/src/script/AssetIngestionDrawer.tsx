import { useMemo } from 'react';
import { Check, RotateCcw, Sparkles, Trash2, X } from 'lucide-react';
import {
  visibleCandidates,
  type DrawerCandidate, type IngestionKind,
} from './workbench-logic';

const GROUPS: Array<{ kind: IngestionKind; label: string }> = [
  { kind: 'character', label: '人物' },
  { kind: 'location', label: '场景 / 地点' },
  { kind: 'prop', label: '道具' },
];

const ROLE_HINT: Record<string, string> = {
  主角: '核心主角',
  配角: '配角',
  路人: '路人 · 默认不勾选',
};

interface AssetIngestionDrawerProps {
  open: boolean;
  candidates: DrawerCandidate[];
  selected: ReadonlySet<string>;
  /** 被忽略的候选 id；忽略项不参与勾选操作，也绝不入库。状态由父级持有。 */
  ignored: ReadonlySet<string>;
  busy?: boolean;
  onToggle: (id: string, next: boolean) => void;
  onToggleIgnore: (id: string, next: boolean) => void;
  onRename: (id: string, name: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onInvert: () => void;
  onSelectCore: () => void;
  onSelectGroup: (kind: IngestionKind, next: boolean) => void;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * 解析完成后的资产入库抽屉：按人物 / 地点 / 道具分组，支持全选、反选、只选核心、
 * 分组全选；行内改名、垃圾桶忽略；路人默认不勾选；同名已有资产标记复用而非新建。
 * 忽略状态受控于父级，全选 / 反选只作用可见项；确认时只提交可见且勾选的条目，
 * 零资产也可确认（仅采纳解析场次，不入库任何资产）。
 */
export function AssetIngestionDrawer({ open, candidates, selected, ignored, busy,
  onToggle, onToggleIgnore, onRename, onSelectAll, onSelectNone, onInvert, onSelectCore,
  onSelectGroup, onConfirm, onClose }: AssetIngestionDrawerProps) {
  const visible = useMemo(
    () => visibleCandidates(candidates, ignored),
    [candidates, ignored],
  );
  const selectedCount = visible.filter(item => selected.has(item.candidateId)).length;

  if (!open) return null;

  function groupItems(kind: IngestionKind) {
    return visible.filter(item => item.kind === kind);
  }

  function groupAllChecked(kind: IngestionKind) {
    const items = groupItems(kind);
    return items.length > 0 && items.every(item => selected.has(item.candidateId));
  }

  return <div className="script-drawer-layer" role="presentation">
    <div className="script-drawer-overlay" onClick={() => { if (!busy) onClose(); }} />
    <aside className="script-drawer-panel" role="dialog" aria-modal="true" aria-label="资产候选入库">
      <header className="script-drawer-head">
        <div className="script-dialog-title">
          <Sparkles size={17} />
          <div>
            <h2>资产候选入库</h2>
            <small>解析识别出 {candidates.length} 项；仅勾选的可见条目进入事实候选，未勾选与忽略项不入库。</small>
          </div>
        </div>
        <button type="button" className="script-dialog-close" aria-label="关闭候选抽屉"
          disabled={busy} onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      <div className="script-drawer-toolbar">
        <button type="button" className="button-secondary" disabled={busy} onClick={onSelectAll}>全选</button>
        <button type="button" className="button-secondary" disabled={busy} onClick={onSelectNone}>全消</button>
        <button type="button" className="button-secondary" disabled={busy} onClick={onInvert}>反选</button>
        <button type="button" className="button-secondary" disabled={busy} onClick={onSelectCore}>只选核心主角</button>
      </div>

      <div className="script-drawer-groups">
        {GROUPS.map(group => {
          const items = groupItems(group.kind);
          return <section className="script-drawer-group" key={group.kind} aria-label={group.label}>
            <header className="script-drawer-group-head">
              <label className="script-drawer-group-check">
                <input type="checkbox" disabled={busy || items.length === 0}
                  checked={groupAllChecked(group.kind)}
                  onChange={event => onSelectGroup(group.kind, event.target.checked)} />
                <span>{group.label}</span>
              </label>
              <small>{items.length} 项</small>
            </header>
            {items.length === 0 && <p className="muted">本类没有识别到候选。</p>}
            <ul>
              {items.map(item => {
                const checked = selected.has(item.candidateId);
                return <li className={`script-drawer-row ${checked ? 'is-selected' : ''} ${item.existing ? 'is-existing' : ''}`}
                  key={item.candidateId}>
                  <input type="checkbox" className="script-drawer-check"
                    aria-label={`选择${group.label} ${item.name}`}
                    checked={checked} disabled={busy}
                    onChange={event => onToggle(item.candidateId, event.target.checked)} />
                  <div className="script-drawer-row-main">
                    <input className="script-drawer-name" aria-label={`${group.label}名称`}
                      value={item.name} disabled={busy}
                      onChange={event => onRename(item.candidateId, event.target.value)} />
                    <div className="script-drawer-row-meta">
                      {item.role && <span className="script-drawer-role">{ROLE_HINT[item.role] ?? item.role}
                        {item.sceneCount > 0 && ` · 出场 ${item.sceneCount} 场`}</span>}
                      {item.confidence != null && (
                        <span className="script-drawer-confidence">置信度 {Math.round(item.confidence * 100)}%</span>
                      )}
                      {item.existing
                        ? <span className="asset-tag ok">复用已有资产，不新建</span>
                        : <span className="asset-tag missing">待新建候选</span>}
                    </div>
                  </div>
                  <button type="button" className="script-drawer-action is-danger" title="忽略此项"
                    aria-label={`忽略${group.label} ${item.name}`} disabled={busy}
                    onClick={() => onToggleIgnore(item.candidateId, true)}>
                    <Trash2 size={14} />
                  </button>
                </li>;
              })}
            </ul>
          </section>;
        })}
      </div>

      <footer className="script-drawer-foot">
        <p className="muted">同名已有资产按名称匹配复用；改名会同步当前集所有场次的说话人 / 地点。不勾选任何资产时，仅采纳解析场次。</p>
        <div className="script-drawer-foot-actions">
          <button type="button" className="button-secondary" disabled={busy} onClick={onClose}>
            <RotateCcw size={14} />稍后处理
          </button>
          <button type="button" className="button-primary" disabled={busy} onClick={onConfirm}
            data-selected-count={selectedCount}>
            <Check size={15} />
            {selectedCount === 0 ? '确认解析，不入库资产（0 项）' : `确认入库所选（${selectedCount}）`}
          </button>
        </div>
      </footer>
    </aside>
  </div>;
}
