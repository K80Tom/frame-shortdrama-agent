import { renderCameraShot } from './captureShot';
import { renderCameraGrid } from './exportGrid';
import { renderDepthMap } from './depthMap';

export type StaticExportKind = 'shot' | 'grid' | 'depth';
export function renderStaticExport(kind: StaticExportKind): Promise<{ blob: Blob } | null> {
  return kind === 'shot' ? renderCameraShot() : kind === 'grid' ? renderCameraGrid() : renderDepthMap();
}
