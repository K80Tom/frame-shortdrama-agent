import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Building2, Check, ChevronDown, LoaderCircle, RefreshCw } from 'lucide-react';
import { Modal } from './components';
import {
  DeploymentApiError, fetchWorkspaceDirectory, legacyWorkspaceDirectory, readActiveWorkspaceId,
  resolveActiveWorkspace, writeActiveWorkspaceId, type WorkspaceDirectory, type WorkspaceSummary,
} from './deployment';
import './deployment.css';

type DirectoryState = {
  phase: 'loading' | 'ready' | 'fallback';
  directory: WorkspaceDirectory;
  message: string;
};

function fallbackMessage(error: unknown): string {
  if (error instanceof DeploymentApiError && error.kind === 'unsupported') {
    return '当前后端没有 workspace 列表接口，已继续使用 Legacy workspace。';
  }
  return error instanceof Error ? error.message : 'workspace 列表暂不可用，已进入兼容模式。';
}

export function useWorkspaceDirectory(provided?: WorkspaceDirectory): DirectoryState & { retry: () => void } {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<DirectoryState>(() => provided
    ? { phase: 'ready', directory: provided, message: '' }
    : { phase: 'loading', directory: { items: [], currentWorkspaceId: null, legacyMode: false }, message: '' });
  useEffect(() => {
    if (provided) { setState({ phase: 'ready', directory: provided, message: '' }); return; }
    const controller = new AbortController();
    setState(previous => ({ ...previous, phase: 'loading', message: '' }));
    void fetchWorkspaceDirectory(controller.signal).then(directory => {
      if (controller.signal.aborted) return;
      const active = resolveActiveWorkspace(directory);
      if (active) {
        try { writeActiveWorkspaceId(active.id); } catch { /* Requests still use the backend default workspace. */ }
      }
      setState({ phase: 'ready', directory, message: '' });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ phase: 'fallback', directory: legacyWorkspaceDirectory(), message: fallbackMessage(error) });
    });
    return () => controller.abort();
  }, [revision, provided]);
  return { ...state, retry: useCallback(() => setRevision(value => value + 1), []) };
}

export function WorkspaceSwitcher({ onSelect, directory }: { onSelect: (workspace: WorkspaceSummary) => boolean; directory?: WorkspaceDirectory }) {
  const state = useWorkspaceDirectory(directory);
  const [open, setOpen] = useState(false);
  const current = resolveActiveWorkspace(state.directory);
  const canSwitch = state.phase === 'ready' && state.directory.items.length > 1;
  function select(workspace: WorkspaceSummary) {
    if (workspace.id === current?.id) return;
    if (!onSelect(workspace)) return;
    setOpen(false);
  }
  return <>
    <button className={`workspace-switcher ${state.phase === 'fallback' ? 'is-legacy' : ''}`} onClick={() => setOpen(true)} aria-label={`当前 workspace：${current?.name ?? '尚未识别'}，打开切换入口`}>
      {state.phase === 'loading' ? <LoaderCircle size={14} className="deployment-spin" /> : <Building2 size={14} />}
      <span><small>当前 workspace</small><strong>{current?.name ?? '尚未识别'}</strong></span><ChevronDown size={12} />
    </button>
    <Modal open={open} onClose={() => setOpen(false)} title="选择 workspace" className="workspace-modal">
      {state.phase === 'fallback' && <div className="workspace-compat" role="status"><AlertCircle size={16} /><p>{state.message}</p><button onClick={state.retry}><RefreshCw size={12} />重试</button></div>}
      <p className="workspace-modal-note">切换后会重新载入工作台；所有后端请求都会携带所选 workspace 上下文。</p>
      <div className="workspace-options">
        {state.directory.items.map(workspace => <button key={workspace.id} disabled={workspace.id === current?.id || state.phase !== 'ready'} aria-current={workspace.id === current?.id ? 'true' : undefined} onClick={() => select(workspace)}>
          <span className="workspace-option-icon">{workspace.id === current?.id ? <Check size={15} /> : <Building2 size={15} />}</span>
          <span><strong>{workspace.name}</strong><small>{workspace.legacy ? 'Legacy 兼容上下文' : `${workspace.slug ? `/${workspace.slug}` : workspace.id}${workspace.role ? ` · ${workspace.role}` : ''}`}</small></span>
          {workspace.id === current?.id && <em>当前</em>}
        </button>)}
      </div>
      {!canSwitch && state.phase === 'ready' && <p className="workspace-single">当前账号只有一个可用 workspace；切换入口会在获得其他成员资格后启用。</p>}
    </Modal>
  </>;
}

export function activateWorkspace(workspace: WorkspaceSummary): void {
  if (workspace.id === readActiveWorkspaceId()) return;
  writeActiveWorkspaceId(workspace.id);
}
