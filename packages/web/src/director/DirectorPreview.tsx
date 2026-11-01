import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { StageCanvas } from './StageCanvas';
import { FrameOverlays } from './ui/FrameOverlays';
import { CanvasBoundary, initializeOnce } from './DirectorWorkspace';

export default function DirectorPreview() {
  const [ready, setReady] = useState(false);
  useEffect(() => { let disposed = false; void initializeOnce().then(() => { if (!disposed) setReady(true); }); return () => { disposed = true; }; }, []);
  return <div className="white-module">
    <div className="director-root" style={{ display: 'block', height: 350, minHeight: 350, borderRadius: 0 }}>
      <div className="ds-viewport" style={{ height: '100%' }}>{ready ? <CanvasBoundary><StageCanvas readOnly /><FrameOverlays /></CanvasBoundary> : <p className="notice">正在准备白模场景…</p>}</div>
    </div>
    <div className="camera-controls"><span style={{ fontSize: 12, color: '#b4aba2' }}>拖动观察站位与空间；进入导演台编辑人物和机位。</span><a className="button primary" href="#/director">打开 3D 导演台 <ArrowUpRight size={16} /></a></div>
  </div>;
}
