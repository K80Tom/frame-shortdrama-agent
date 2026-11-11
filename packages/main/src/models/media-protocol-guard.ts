import { ModelError, type ModelKind } from '@lyra/shared';
import { MODEL_PRESETS, PROVIDER_CATALOG } from './presets/catalog';

// Containment for the catalog introduced in #173, not a generic adapter registry.
// Only the existing Ark image/video adapters have an implementation in this tree.
const nativeProvider = 'volcengine';
const nativeHosts = new Set(MODEL_PRESETS.filter(p => p.providerId === nativeProvider)
  .map(p => new URL(p.defaultBaseUrl).hostname));
const foreignHosts = new Set(PROVIDER_CATALOG.filter(p => p.id !== nativeProvider)
  .map(p => new URL(p.defaultBaseUrl).hostname).filter(host => !nativeHosts.has(host)));
for (const preset of MODEL_PRESETS) {
  const host = new URL(preset.defaultBaseUrl).hostname;
  if (preset.providerId !== nativeProvider && !nativeHosts.has(host)) foreignHosts.add(host);
}

/** Missing metadata on old profiles must not enable known foreign protocols. */
export function mediaProtocolBlocked(kind: ModelKind, endpoint: string, model: string): boolean {
  if (kind === 'text') return false;
  const normalizedModel = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (typeof endpoint !== 'string') return false;
  if (MODEL_PRESETS.some(p => p.kind !== 'text' && p.providerId !== nativeProvider
    && [p.modelCode.toLowerCase(), p.code.toLowerCase()].includes(normalizedModel))) return true;
  try { return foreignHosts.has(new URL(endpoint).hostname); }
  catch { return false; } // Existing connection validation rejects malformed endpoints.
}

export function assertNativeMediaProtocol(kind: ModelKind, endpoint: string, model: string): void {
  if (mediaProtocolBlocked(kind, endpoint, model)) {
    throw new ModelError(400, 'MEDIA_PROTOCOL_UNSUPPORTED',
      '此媒体预设目前仅供目录参考，尚无匹配的执行适配器；不能分配用途或提交生成，未调用供应商。');
  }
}
