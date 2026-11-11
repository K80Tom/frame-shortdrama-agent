import { ModelError, parseModelExecutionBinding, type ModelExecutionBinding, type ModelKind, type ModelPresetEntry } from '@lyra/shared';
import { MODEL_PRESETS } from './presets/catalog';
import { assertNativeMediaProtocol, mediaProtocolBlocked } from './media-protocol-guard';

export function bindingForPreset(preset: ModelPresetEntry): ModelExecutionBinding {
  const adapter = preset.kind === 'text' ? 'openai-chat'
    : preset.providerId !== 'volcengine' ? 'unavailable' : preset.kind === 'image' ? 'ark-image' : 'ark-video';
  const protocol = adapter === 'unavailable' ? 'metadata-only' : `${adapter}-v1` as ModelExecutionBinding['protocol'];
  return parseModelExecutionBinding({ providerId: preset.providerId, adapter, protocol,
    presetCode: preset.code, config: preset.config ?? {} }, preset.kind);
}

/** Preserve the existing manual Ark-compatible connection API, but persist its protocol explicitly. */
export function bindingForConnection(kind: ModelKind, endpoint: string, model: string): ModelExecutionBinding {
  const preset = mediaProtocolBlocked(kind, endpoint, model)
    ? MODEL_PRESETS.find(p => p.kind === kind && p.modelCode === model) : undefined;
  if (preset && kind !== 'text' && preset.providerId !== 'volcengine') return bindingForPreset(preset);
  const adapter = kind === 'text' ? 'openai-chat' : mediaProtocolBlocked(kind, endpoint, model)
    ? 'unavailable' : kind === 'image' ? 'ark-image' : 'ark-video';
  const known = MODEL_PRESETS.find(p => p.providerId === 'volcengine' && p.kind === kind && p.modelCode === model);
  const config = structuredClone(known?.config ?? {});
  // A manual/legacy connection did not opt into a preset's defaults. Apply known
  // limits, but never silently change the parameters of an already-authorized run.
  delete config.defaultDuration; delete config.defaultResolution; delete config.defaultAspectRatio;
  delete config.defaultWidth; delete config.defaultHeight;
  return { providerId: 'custom', adapter, protocol: adapter === 'unavailable' ? 'metadata-only' : `${adapter}-v1`, config };
}

export function assertExecutionBinding(kind: ModelKind, endpoint: string, model: string,
  input: ModelExecutionBinding): ModelExecutionBinding {
  let binding: ModelExecutionBinding;
  try { binding = parseModelExecutionBinding(input, kind); }
  catch { throw new ModelError(400, 'MODEL_EXECUTION_INVALID', '模型的类型、适配器、协议或能力参数不一致，未调用供应商。'); }
  assertNativeMediaProtocol(kind, endpoint, model);
  if (binding.adapter === 'unavailable') throw new ModelError(400, 'MEDIA_PROTOCOL_UNSUPPORTED',
    '此预设仅供目录参考，尚无匹配的执行适配器；未调用供应商。');
  if (binding.presetCode) {
    const preset = MODEL_PRESETS.find(p => p.code === binding.presetCode);
    const expected = preset && bindingForPreset(preset);
    if (!preset || preset.kind !== kind || preset.modelCode !== model || preset.defaultBaseUrl !== endpoint
      || expected?.providerId !== binding.providerId || expected.adapter !== binding.adapter || expected.protocol !== binding.protocol) {
      throw new ModelError(400, 'MODEL_EXECUTION_INVALID', '预设执行身份与连接不一致；请新建正确的连接，未调用供应商。');
    }
  } else if (binding.providerId !== 'custom') {
    throw new ModelError(400, 'MODEL_EXECUTION_INVALID', '厂商连接缺少预设执行身份，未调用供应商。');
  }
  return binding;
}

export function freezeExecutionBinding(binding: ModelExecutionBinding): ModelExecutionBinding {
  const frozen = structuredClone(binding);
  for (const value of Object.values(frozen.config)) if (Array.isArray(value)) Object.freeze(value);
  Object.freeze(frozen.config);
  return Object.freeze(frozen);
}
