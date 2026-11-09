import { createHash, randomBytes } from 'node:crypto';
import { OutboxTaskError } from './outbox/contracts';
import type { OutboxTaskHandler } from './outbox/consumer';
import { ProductionInputObjectVerifier } from './input-object-verifier';
import { DRIVER_MANAGED_PREFIX, sha256Of, type BlobStorageDriver } from '../storage/driver';
import {
  parseCommercialVideoRequest,
  parsePublicHttpsUrl,
  type CommercialVideoAcceptance,
  type CommercialVideoPollQuery,
  type CommercialVideoPollResult,
  type CommercialVideoProvider,
  type CommercialVideoRequest,
} from '../models/video-providers/types';
import {
  newModelGenerationCallId,
  promptDigestOf,
  type ModelGenerationAudit,
} from './model-generation-audit';

/** Worker 侧适配器端口：真实适配器或测试桩都只依赖 submit/poll。 */
export interface VideoGenerationAdapterPort {
  submit(request: CommercialVideoRequest): Promise<CommercialVideoAcceptance>;
  poll(query: CommercialVideoPollQuery): Promise<CommercialVideoPollResult>;
}

export type VideoGenerationAdapterRegistry = Partial<Record<CommercialVideoProvider, VideoGenerationAdapterPort>>;

/** 044 对象版本引用：验真三件套（对象、版本、指纹）。 */
export interface VideoFrameObjectRef {
  objectId: string;
  versionId: string;
  checksum: string;
}

export interface VideoGenerationJobPayload {
  operationKey: string;
  clientRequestId: string;
  provider: CommercialVideoProvider;
  model: string;
  prompt: string;
  negativePrompt?: string;
  durationSeconds: number;
  ratio: '9:16' | '16:9';
  resolution: '720p' | '1080p';
  seed?: number;
  watermark?: boolean;
  estimateMicros: number;
  budgetLimitMicros: number;
  currency: string;
  firstFrame?: VideoFrameObjectRef;
  lastFrame?: VideoFrameObjectRef;
  referenceImageUrls?: string[];
  /** 崩溃恢复：上次已拿到供应商任务号时只续查，不二次提交。 */
  providerTaskId?: string;
}

export interface VideoGenerationHandlerOptions {
  readonly adapters: VideoGenerationAdapterRegistry;
  readonly verifier: ProductionInputObjectVerifier;
  /** 读回已验真帧的原始字节（png/jpeg/webp），由装配方提供实现。 */
  readonly loadFrameBytes: (frame: VideoFrameObjectRef) => Promise<Buffer>;
  readonly driver: BlobStorageDriver;
  readonly audit?: ModelGenerationAudit;
  readonly pollIntervalMs?: number;
  readonly pollDeadlineMs?: number;
  readonly maxOutputBytes?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly random?: (size: number) => Buffer;
  /** 测试注入点；默认真实受控下载。 */
  readonly download?: (url: string, maxBytes: number) => Promise<Buffer>;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_DEADLINE_MS = 180_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const PROVIDERS = new Set<CommercialVideoProvider>(['kling', 'jimeng', 'minimax', 'seedance']);

function parseFrameRef(value: unknown, label: string): VideoFrameObjectRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OutboxTaskError('OUTBOX_TASK_INVALID', `${label} 缺少对象版本引用。`);
  }
  const ref = value as Record<string, unknown>;
  if (typeof ref.objectId !== 'string' || typeof ref.versionId !== 'string' || typeof ref.checksum !== 'string') {
    throw new OutboxTaskError('OUTBOX_TASK_INVALID', `${label} 的对象版本引用不完整。`);
  }
  return { objectId: ref.objectId, versionId: ref.versionId, checksum: ref.checksum };
}

function frameContentType(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw new OutboxTaskError('OUTBOX_TASK_INVALID', '已验真帧的格式必须是 png/jpeg/webp。');
}

function frameDataUri(bytes: Buffer): string {
  return `data:${frameContentType(bytes)};base64,${bytes.toString('base64')}`;
}

export function parseVideoGenerationPayload(value: Record<string, unknown>): VideoGenerationJobPayload {
  const provider = value.provider;
  if (typeof provider !== 'string' || !PROVIDERS.has(provider as CommercialVideoProvider)) {
    throw new OutboxTaskError('OUTBOX_TASK_INVALID', 'provider 必须是 kling/jimeng/minimax/seedance 之一。');
  }
  for (const key of ['operationKey', 'clientRequestId', 'model', 'prompt'] as const) {
    if (typeof value[key] !== 'string' || !(value[key] as string).length) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', `${key} 必须是非空字符串。`);
    }
  }
  for (const key of ['durationSeconds', 'estimateMicros', 'budgetLimitMicros'] as const) {
    if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key])) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', `${key} 必须是整数。`);
    }
  }
  if (value.ratio !== '9:16' && value.ratio !== '16:9') {
    throw new OutboxTaskError('OUTBOX_TASK_INVALID', 'ratio 必须是 9:16 或 16:9。');
  }
  if (value.resolution !== '720p' && value.resolution !== '1080p') {
    throw new OutboxTaskError('OUTBOX_TASK_INVALID', 'resolution 必须是 720p 或 1080p。');
  }
  if (value.generateAudio === true) {
    throw new OutboxTaskError('OUTBOX_TASK_INVALID', '视频生成 Worker 不接受 generateAudio=true。');
  }
  if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/u.test(value.currency)) {
    throw new OutboxTaskError('OUTBOX_TASK_INVALID', 'currency 必须是三位大写币种代码。');
  }
  return {
    operationKey: value.operationKey as string,
    clientRequestId: value.clientRequestId as string,
    provider: provider as CommercialVideoProvider,
    model: value.model as string,
    prompt: value.prompt as string,
    ...(typeof value.negativePrompt === 'string' ? { negativePrompt: value.negativePrompt } : {}),
    durationSeconds: value.durationSeconds as number,
    ratio: value.ratio,
    resolution: value.resolution,
    ...(typeof value.seed === 'number' ? { seed: value.seed } : {}),
    ...(typeof value.watermark === 'boolean' ? { watermark: value.watermark } : {}),
    estimateMicros: value.estimateMicros as number,
    budgetLimitMicros: value.budgetLimitMicros as number,
    currency: value.currency,
    ...(value.firstFrame ? { firstFrame: parseFrameRef(value.firstFrame, '首帧') } : {}),
    ...(value.lastFrame ? { lastFrame: parseFrameRef(value.lastFrame, '尾帧') } : {}),
    ...(Array.isArray(value.referenceImageUrls)
      ? { referenceImageUrls: value.referenceImageUrls.filter(item => typeof item === 'string') } : {}),
    ...(typeof value.providerTaskId === 'string' ? { providerTaskId: value.providerTaskId } : {}),
  };
}

/** 受控下载成品视频：HTTPS、无凭据、非内网、redirect 禁止、总量封顶。 */
export async function downloadProviderVideo(url: string, maxBytes: number): Promise<Buffer> {
  const parsed = parsePublicHttpsUrl(url, '供应商视频地址');
  const response = await fetch(parsed.href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new OutboxTaskError('OUTBOX_TASK_INVALID', `供应商视频下载失败（HTTP ${response.status}）。`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^(video\/|application\/octet-stream)/u.test(contentType)) {
    await response.body?.cancel();
    throw new OutboxTaskError('OUTBOX_TASK_INVALID', `供应商成品的内容类型不是视频（${contentType || '缺失'}）。`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new OutboxTaskError('OUTBOX_TASK_INVALID', '供应商视频响应没有内容。');
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new OutboxTaskError('OUTBOX_TASK_INVALID', '供应商成品超过大小上限。');
      }
      chunks.push(Buffer.from(item.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

/**
 * video.generate：视频生成 Worker 任务。
 *
 * 流程：验真首/尾帧（044 验真器）→ 读回字节内联提交（预算 reserve/commit 在适配器内）→
 * 台账先落 provider_task_id → 有界轮询至终态 → 成品受控下载 → 驱动托管前缀落盘 →
 * 台账 completed。任何一步失败：INVALID 不重投，其余按 outbox 退避重试，
 * 重投时经台账找回任务号续查，绝不二次提交。
 */
export function createVideoGenerationHandler(options: VideoGenerationHandlerOptions): OutboxTaskHandler {
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const random = options.random ?? randomBytes;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollDeadlineMs = options.pollDeadlineMs ?? DEFAULT_POLL_DEADLINE_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return {
    taskType: 'video.generate',
    async execute({ task }) {
      if (!task.payload || typeof task.payload !== 'object' || Array.isArray(task.payload)) {
        throw new OutboxTaskError('OUTBOX_TASK_INVALID', '视频生成负载必须是 JSON 对象。');
      }
      const payload = parseVideoGenerationPayload(task.payload);
      const adapter = options.adapters[payload.provider];
      if (!adapter) {
        throw new OutboxTaskError('OUTBOX_TASK_INVALID', `${payload.provider} 供应商适配器未配置。`);
      }
      const workspaceId = task.workspaceId;
      const callId = newModelGenerationCallId(random);
      const controlInputDigest = (payload.firstFrame || payload.lastFrame)
        ? createHash('sha256').update(JSON.stringify({
          first: payload.firstFrame?.versionId ?? null, last: payload.lastFrame?.versionId ?? null,
        }), 'utf8').digest('hex')
        : null;

      let providerTaskId = payload.providerTaskId
        ?? await options.audit?.findProviderTaskId(workspaceId, payload.operationKey)
        ?? null;
      let submittedCallId: string | null = null;
      if (providerTaskId) {
        submittedCallId = await options.audit?.findCallId(workspaceId, payload.operationKey, providerTaskId) ?? null;
      }
      if (!providerTaskId) {
        for (const [label, frame] of [['首帧', payload.firstFrame], ['尾帧', payload.lastFrame]] as const) {
          if (!frame) continue;
          const code = await options.verifier.check(workspaceId, frame);
          if (code) {
            throw new OutboxTaskError('OUTBOX_TASK_INVALID', `${label}对象验真未通过（${code}）。`);
          }
        }
        const request = parseCommercialVideoRequest({
          workspaceId, operationKey: payload.operationKey, clientRequestId: payload.clientRequestId,
          provider: payload.provider, model: payload.model, prompt: payload.prompt,
          ...(payload.negativePrompt ? { negativePrompt: payload.negativePrompt } : {}),
          durationSeconds: payload.durationSeconds, ratio: payload.ratio, resolution: payload.resolution,
          ...(payload.firstFrame ? { firstFrameUrl: frameDataUri(await options.loadFrameBytes(payload.firstFrame)) } : {}),
          ...(payload.lastFrame ? { lastFrameUrl: frameDataUri(await options.loadFrameBytes(payload.lastFrame)) } : {}),
          ...(payload.referenceImageUrls?.length ? { referenceImageUrls: payload.referenceImageUrls } : {}),
          generateAudio: false,
          ...(payload.seed !== undefined ? { seed: payload.seed } : {}),
          ...(payload.watermark !== undefined ? { watermark: payload.watermark } : {}),
          estimateMicros: payload.estimateMicros, budgetLimitMicros: payload.budgetLimitMicros,
          currency: payload.currency,
        }, payload.provider);
        const acceptance = await adapter.submit(request);
        providerTaskId = acceptance.taskId;
        submittedCallId = callId;
        await options.audit?.recordSubmitted(workspaceId, {
          callId, operationKey: payload.operationKey, provider: payload.provider, model: payload.model,
          promptDigest: promptDigestOf(payload.prompt), controlInputDigest,
          reservationId: acceptance.reservationId, providerTaskId,
        });
      }

      const deadline = now() + pollDeadlineMs;
      let outcome: CommercialVideoPollResult | null = null;
      while (true) {
        const poll = await adapter.poll({ providerTaskId });
        if (poll.state === 'succeeded') { outcome = poll; break; }
        if (poll.state === 'failed') {
          await options.audit?.recordFailed(workspaceId, submittedCallId ?? callId, 'VIDEO_GENERATION_FAILED');
          throw new Error(`VIDEO_GENERATION_FAILED: ${poll.message ?? '供应商任务失败'}`);
        }
        if (now() >= deadline) {
          throw new Error(`VIDEO_GENERATION_POLL_TIMEOUT: ${payload.provider} 任务 ${providerTaskId} 在时限内未完成，等待重投续查。`);
        }
        await sleep(pollIntervalMs);
      }

      const bytes = await (options.download ?? downloadProviderVideo)(outcome.videoUrl!, maxOutputBytes);
      const outputKey = `${DRIVER_MANAGED_PREFIX}outputs/${workspaceId}/${submittedCallId ?? callId}.mp4`;
      const stored = await options.driver.put({ key: outputKey, body: bytes, contentType: 'video/mp4' });
      await options.audit?.recordCompleted(workspaceId, submittedCallId ?? callId, providerTaskId, null);
      return {
        taskType: task.taskType,
        taskId: task.taskId,
        provider: payload.provider,
        providerTaskId,
        outputKey: stored.key,
        sha256: stored.sha256 || sha256Of(bytes),
        sizeBytes: stored.size,
        lastFrameUrl: outcome.lastFrameUrl ?? null,
        processedAt: new Date().toISOString(),
      };
    },
  };
}
