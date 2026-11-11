import { ModelError, type ModelPresetConfig } from '@lyra/shared';
import type { GenerateImageInput, SeedanceSubmitInput } from './media-client';

function reject(): never {
  throw new ModelError(400, 'INVALID_MEDIA_REQUEST', '请求的分辨率、画幅、时长或首尾帧超出当前模型冻结的能力范围；未调用供应商。');
}

export function imageInputWithCapabilities(config: ModelPresetConfig, input: GenerateImageInput): GenerateImageInput {
  if (input.watermark !== undefined && typeof input.watermark !== 'boolean') reject();
  const size = input.size ?? (config.defaultWidth && config.defaultHeight
    ? `${config.defaultWidth}x${config.defaultHeight}` : undefined);
  if (size && config.supportedResolutions && !config.supportedResolutions.includes(size)) reject();
  if (size && config.supportedAspectRatios) {
    const dims = /^(\d+)x(\d+)$/.exec(size);
    const width = dims ? Number(dims[1]) : /^[1-9]\d*K$/i.test(size) ? 1 : 0;
    const height = dims ? Number(dims[2]) : /^[1-9]\d*K$/i.test(size) ? 1 : 0;
    if (!width || !height || !config.supportedAspectRatios.some(ratio => {
      const [w, h] = ratio.split(':').map(Number);
      return w !== undefined && h !== undefined && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && width * h === height * w;
    })) reject();
  }
  return { ...input, ...(size === undefined ? {} : { size }) };
}

export function videoInputWithCapabilities(config: ModelPresetConfig, input: SeedanceSubmitInput): SeedanceSubmitInput {
  if (input.watermark !== undefined && typeof input.watermark !== 'boolean'
    || input.generateAudio !== undefined && typeof input.generateAudio !== 'boolean') reject();
  const duration = input.duration ?? config.defaultDuration;
  const resolution = input.resolution ?? config.defaultResolution;
  const ratio = input.ratio ?? config.defaultAspectRatio;
  if (duration !== undefined && (config.minDuration !== undefined && duration < config.minDuration
    || config.maxDuration !== undefined && duration > config.maxDuration
    || config.supportedDurations && !config.supportedDurations.includes(duration))) reject();
  if (resolution !== undefined && config.supportedResolutions && !config.supportedResolutions.includes(resolution)) reject();
  if (ratio !== undefined && config.supportedAspectRatios && !config.supportedAspectRatios.includes(ratio)) reject();
  if (input.firstFrameUrl && config.supportFirstFrame === false || input.lastFrameUrl && config.supportLastFrame === false) reject();
  return { ...input, ...(duration === undefined ? {} : { duration }),
    ...(resolution === undefined ? {} : { resolution }), ...(ratio === undefined ? {} : { ratio }) };
}
