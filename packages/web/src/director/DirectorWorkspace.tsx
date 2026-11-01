import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, Box, RotateCcw, Upload } from 'lucide-react';
import { Modal, Tag } from '../components';
import { StageCanvas } from './StageCanvas';
import { TopBar } from './ui/TopBar';
import { ObjectListPanel } from './ui/ObjectListPanel';
import { PropertyPanel } from './ui/PropertyPanel';
import { FrameOverlays } from './ui/FrameOverlays';
import { useDirectorStore } from './store';
import { DirectorWorkspaceProvider } from './workspace-context';
import { currentSnapshot, parseLocalScene, persistScene, readSavedScene } from './local-storage';
import { sampleScene } from './sample-scene';
import { downloadBlob } from './export/captureShot';
import './director.css';
import './local-workspace.css';

let initialize: Promise<string | null> | undefined;
let unsaved = false;
export function initializeOnce() {
  return initialize ??= (async () => {
    try {
      const stored = await readSavedScene();
      useDirectorStore.getState().replaceSceneState(stored ? parseLocalScene(stored) : sampleScene());
      return null;
    } catch (error) {
      useDirectorStore.getState().replaceSceneState(sampleScene());
      return `${error instanceof Error ? error.message : '场景读取失败。'} 现显示练习场景。`;
    }
  })();
}

export class CanvasBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() {
    return this.state.error ? <div className="director-loading"><Box size={28} /><h3>3D 画布未能启动</h3><p>请启用浏览器硬件加速后刷新。已保存的场景仍可导出。</p></div> : this.props.children;
  }
}

export default function DirectorWorkspace({ notify }: { notify: (text: string) => void }) {
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(unsaved);
  const [saving, setSaving] = useState(false);
  const [exported, setExported] = useState<{ url: string; filename: string; type: string } | null>(null);
  const [confirm, setConfirm] = useState<'sample' | 'import' | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const pendingImport = useRef<ReturnType<typeof parseLocalScene> | null>(null);
  const [panel, setPanel] = useState<'objects' | 'properties'>('objects');
  const version = useRef(0);

  useEffect(() => () => { if (exported) URL.revokeObjectURL(exported.url); }, [exported]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void initializeOnce().then(message => {
      if (cancelled) return;
      if (message) notify(message);
      setReady(true);
      unsubscribe = useDirectorStore.subscribe((state, previous) => {
        if (state.objects !== previous.objects || state.scene !== previous.scene || state.aspect !== previous.aspect || state.environment !== previous.environment || state.overlays !== previous.overlays) {
          version.current += 1; unsaved = true; setDirty(true);
        }
      });
    });
    return () => { cancelled = true; unsubscribe?.(); };
  }, [notify]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (unsaved) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  async function save() {
    if (saving) return;
    setSaving(true);
    const savingVersion = version.current;
    try {
      await persistScene(currentSnapshot());
      if (version.current === savingVersion) { unsaved = false; setDirty(false); }
      notify('白模场景已保存到本浏览器，刷新后可继续编辑。');
    } catch (error) { notify(error instanceof Error ? error.message : '场景保存失败。'); }
    finally { setSaving(false); }
  }

  function exportScene() {
    downloadBlob(new Blob([JSON.stringify(currentSnapshot(), null, 2)], { type: 'application/json' }), 'Lyra-可编辑白模场景.json');
    notify('已导出可编辑场景 JSON，可在导演台重新导入。');
  }

  function applyReplacement() {
    const next = confirm === 'sample' ? sampleScene() : pendingImport.current;
    if (next) { useDirectorStore.getState().replaceSceneState(next); notify('场景已载入；点击保存场景后写入本浏览器。'); }
    pendingImport.current = null; setConfirm(null);
  }

  return <section className={`director-workspace director-panel-${panel}`}>
    <div className="director-heading"><div><p className="eyebrow">SPATIAL STORYTELLING</p><h1>先在空间里，把镜头想清楚。</h1><p>摆人物、搭场景、找机位。白模构图可作为后续画面生成的参考。</p></div><Tag tone={dirty ? 'orange' : 'green'}>{dirty ? '有未保存修改' : '本地白模工作台'}</Tag></div>
    <div className="director-document-bar"><span><Box size={15} />赴约 · 白模站位练习 <small>设计建议</small></span><div><button disabled={!ready} onClick={() => setConfirm('sample')}><RotateCcw size={14} />载入练习</button><button disabled={!ready} onClick={() => importRef.current?.click()}><Upload size={14} />导入场景</button><button disabled={!ready} onClick={exportScene}><ArrowDownToLine size={14} />导出场景</button></div></div>
    <input ref={importRef} hidden type="file" accept=".json,application/json" aria-label="导入白模场景文件" onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file) return;
      try {
        if (file.size > 80 * 1024 * 1024) throw new Error('场景文件不能超过 80 MB。');
        pendingImport.current = parseLocalScene(JSON.parse(await file.text()));
        setConfirm('import');
      } catch (error) { notify(error instanceof Error ? error.message : '场景文件无法读取。'); }
    }} />
    <div className="director-mobile-tabs"><button aria-pressed={panel === 'objects'} onClick={() => setPanel('objects')}>场景对象</button><button aria-pressed={panel === 'properties'} onClick={() => setPanel('properties')}>对象 / 场景属性</button></div>
    {ready ? <DirectorWorkspaceProvider value={{ saving, save, notify, previewExport: (blob, filename) => setExported({ url: URL.createObjectURL(blob), filename, type: blob.type }) }}><div className="director-root">
      <TopBar /><aside className="ds-left"><ObjectListPanel /></aside>
      <div className="ds-viewport"><CanvasBoundary><StageCanvas /><FrameOverlays /></CanvasBoundary></div>
      <PropertyPanel />
    </div></DirectorWorkspaceProvider> : <div className="director-loading">正在准备 3D 导演台…</div>}
    <div className="director-bottom-note"><span>鼠标拖动旋转视角 · 滚轮缩放 · G / R / S 移动、旋转、缩放</span><span>场景保存在本浏览器；导出 JSON 可备份与迁移。</span></div>
    <Modal open={exported !== null} onClose={() => setExported(null)} title="白模导出预览" className="director-export-modal">
      {exported && <><div className="director-export-preview">{exported.type.startsWith('video/') ? <video src={exported.url} controls playsInline preload="auto" /> : <img src={exported.url} alt="已渲染的白模参考图" />}</div><p className="muted">{exported.filename}</p><a className="button primary" href={exported.url} download={exported.filename}><ArrowDownToLine size={15} />下载到本地</a></>}
    </Modal>
    <Modal open={confirm !== null} onClose={() => setConfirm(null)} title={confirm === 'sample' ? '载入白模练习？' : '导入白模场景？'}><p className="muted">这会替换当前画布。已有修改可以先导出场景留存；浏览器中已保存的版本会保留到你再次点击“保存场景”。</p><div className="director-confirm"><button className="button secondary" onClick={() => { exportScene(); setConfirm(null); }}>先导出当前场景</button><button className="button primary" onClick={applyReplacement}>替换当前画布</button></div></Modal>
  </section>;
}
