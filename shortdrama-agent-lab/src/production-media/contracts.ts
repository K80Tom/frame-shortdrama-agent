export const LOCAL_VIDEO_SCHEMA_VERSION = 'production-local-video/1' as const;
export const TIMELINE_MANIFEST_SCHEMA_VERSION = 'production-timeline/1' as const;

export class ProductionMediaError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ProductionMediaError';
  }
}

export interface VideoProbeResult {
  container: 'mp4';
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  hasAudio: boolean;
  audioCodec: string | null;
}

export interface LocalVideoObject {
  schemaVersion: typeof LOCAL_VIDEO_SCHEMA_VERSION;
  id: string;
  sha256: string;
  bytes: number;
  mimeType: 'video/mp4';
  relativePath: string;
  sourceKind: 'buffer' | 'ownedFile' | 'providerDownload' | 'composition';
  probe: VideoProbeResult;
  createdAt: string;
}

export interface OwnedLocalVideo {
  object: LocalVideoObject;
  /** Internal-only path. Controllers must never serialize it to a browser. */
  absolutePath: string;
}

export interface LocalVideoContent {
  object: LocalVideoObject;
  /** Detached bytes safe for a controller to stream without reopening a path. */
  bytes: Buffer;
}

export interface ComposeTimelineRequest {
  videoIds: string[];
  title?: string;
  /** 提供该字段即启用自动剪辑：片头/片尾卡 + 镜头间叠化。 */
  edit?: TimelineEditRequest;
}

export interface TimelineEditRequest {
  titleCardText?: string;
  titleCardSubtitle?: string;
  endCardText?: string;
  /** 叠化时长，0 表示硬切；默认 0.4s，上限 1.5s。 */
  transitionSeconds?: number;
  /** 目标总时长（秒，含卡片与转场）。提供时各镜头按比例裁剪，保证成片落在目标时长附近。 */
  targetSeconds?: number;
  /** 逐镜头剪辑指令（来自抽帧质量评估）：保留/裁短/加速/剔除。 */
  clipDirectives?: TimelineClipDirective[];
}

export interface TimelineClipDirective {
  videoId: string;
  action: 'keep' | 'trim' | 'speedup' | 'drop';
  /** action=trim 时保留的秒数。 */
  trimSeconds?: number;
  /** action=speedup 时的倍速（1.2–2）。 */
  speedFactor?: number;
}

export interface TimelineManifest {
  schemaVersion: typeof TIMELINE_MANIFEST_SCHEMA_VERSION;
  id: string;
  inputDigest: string;
  title: string;
  createdAt: string;
  inputs: Array<{
    order: number;
    mediaId: string;
    sha256: string;
    durationSeconds: number;
    width: number;
    height: number;
    hasAudio: boolean;
  }>;
  output: LocalVideoObject;
  composition: {
    strategy: 'ffmpeg-concat-filter' | 'ffmpeg-auto-edit';
    videoCodec: 'libx264';
    audioCodec: 'aac' | null;
    width: number;
    height: number;
    expectedDurationSeconds: number;
    /** 仅 strategy === 'ffmpeg-auto-edit' 时存在。 */
    edit?: TimelineEditPlan;
  };
}

export interface TimelineEditPlan {
  titleCardText: string | null;
  titleCardSubtitle: string | null;
  endCardText: string | null;
  transitionSeconds: number;
  titleCardSeconds: number | null;
  endCardSeconds: number | null;
}

export interface ProductionMediaLimits {
  maxBytes: number;
  maxDurationSeconds: number;
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
}

export const DEFAULT_MEDIA_LIMITS: Readonly<ProductionMediaLimits> = Object.freeze({
  maxBytes: 512 * 1024 * 1024,
  maxDurationSeconds: 10 * 60,
  maxWidth: 3840,
  maxHeight: 3840,
  maxPixels: 3840 * 2160,
});

export function parseMediaId(value: unknown): string {
  if (typeof value === 'string' && /^https?:\/\//iu.test(value)) {
    throw new ProductionMediaError(409, 'REMOTE_MEDIA_NOT_LOCAL',
      '供应商远程链接尚未下载并校验，不能作为本地成片输入或交付。');
  }
  if (typeof value !== 'string' || !/^media_[a-f0-9]{64}$/u.test(value)) {
    throw new ProductionMediaError(400, 'LOCAL_MEDIA_ID_INVALID', '本地视频标识无效。');
  }
  return value;
}

export function validateProbe(result: VideoProbeResult, bytes: number, limits: ProductionMediaLimits): VideoProbeResult {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > limits.maxBytes) {
    throw new ProductionMediaError(413, 'LOCAL_VIDEO_SIZE_INVALID', '视频文件为空或超过本地媒体大小限制。');
  }
  if (!result || result.container !== 'mp4' || !Number.isFinite(result.durationSeconds)
    || result.durationSeconds <= 0 || result.durationSeconds > limits.maxDurationSeconds
    || !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height)
    || result.width < 1 || result.height < 1 || result.width > limits.maxWidth || result.height > limits.maxHeight
    || result.width * result.height > limits.maxPixels
    || typeof result.videoCodec !== 'string' || !result.videoCodec || result.videoCodec.length > 80
    || typeof result.hasAudio !== 'boolean'
    || (result.hasAudio ? typeof result.audioCodec !== 'string' || !result.audioCodec || result.audioCodec.length > 80
      : result.audioCodec !== null)) {
    throw new ProductionMediaError(415, 'LOCAL_VIDEO_PROBE_INVALID',
      '视频容器、时长、分辨率或音视频流不符合本地生产限制。');
  }
  return structuredClone(result);
}
