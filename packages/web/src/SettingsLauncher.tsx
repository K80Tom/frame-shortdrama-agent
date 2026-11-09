import type { CSSProperties } from 'react';
import { Settings2 } from 'lucide-react';
import './settings-launcher.css';

type Props = { active: boolean; onOpen: () => void };
const title = [...'工作台设置'];

export default function SettingsLauncher({ active, onOpen }: Props) {
  return <button
    type="button"
    className={`settings-launcher${active ? ' is-active' : ''}`}
    onClick={onOpen}
    aria-label="打开工作台设置"
    aria-current={active ? 'page' : undefined}
  >
    <span className="settings-launcher-outline" aria-hidden="true" />
    <span className="settings-launcher-state">
      <span className="settings-launcher-icon" aria-hidden="true"><Settings2 size={18} strokeWidth={2} /></span>
      <span className="settings-launcher-copy">
        <strong aria-hidden="true">{title.map((letter, index) => <span
          key={`${letter}-${index}`}
          style={{ '--letter-index': index } as CSSProperties}
        >{letter}</span>)}</strong>
        <span className="settings-launcher-sr-only">工作台设置</span>
        <small>系统状态 · 模型连接</small>
      </span>
      <span className="settings-launcher-active-dot" aria-hidden="true" />
    </span>
  </button>;
}
