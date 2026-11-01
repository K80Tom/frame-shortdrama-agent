import { useState } from 'react';
import { FolderOpen, Images } from 'lucide-react';
import AssetLibrary from './AssetLibrary';
import { LibraryPage } from './LibraryPages';
import type { Page } from './model';
import './asset-workspace.css';

type AssetTab = 'library' | 'references';
export default function AssetWorkspace({ go, onUnsavedChange, initialTab = 'library' }: { go: (page: Page, step?: number) => void; onUnsavedChange: (dirty: boolean) => void; initialTab?: AssetTab }) {
  const [tab, setTab] = useState<AssetTab>(initialTab);
  const [assetCount, setAssetCount] = useState<number | null>(null);
  return <div className="asset-workspace">
    <aside className="asset-workspace-rail">
      <div className="asset-workspace-nav" role="tablist" aria-label="资产工作区" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'library' : event.key === 'End' ? 'references' : tab === 'library' ? 'references' : 'library';
        setTab(next); document.getElementById(`asset-${next}-tab`)?.focus();
      }}>
        <button id="asset-library-tab" role="tab" tabIndex={tab === 'library' ? 0 : -1} aria-selected={tab === 'library'} aria-controls="asset-library-panel" onClick={() => setTab('library')}><FolderOpen size={14} aria-hidden="true" /><span>个人资产库</span><small>{assetCount ?? '—'}</small></button>
        <button id="asset-references-tab" role="tab" tabIndex={tab === 'references' ? 0 : -1} aria-selected={tab === 'references'} aria-controls="asset-references-panel" onClick={() => setTab('references')}><Images size={14} aria-hidden="true" /><span>示例参考</span><small>3</small></button>
      </div>
    </aside>
    <div className="asset-workspace-panels">
      {/* Keep registration mounted so switching views preserves an unfinished registration. */}
      <div id="asset-library-panel" role="tabpanel" aria-labelledby="asset-library-tab" hidden={tab !== 'library'}><AssetLibrary active={tab === 'library'} onUnsavedChange={onUnsavedChange} onCountChange={setAssetCount} /></div>
      <div id="asset-references-panel" role="tabpanel" aria-labelledby="asset-references-tab" hidden={tab !== 'references'}><LibraryPage go={go} compact /></div>
    </div>
  </div>;
}
