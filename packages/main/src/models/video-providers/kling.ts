import {
  CommercialVideoError,
  parseCommercialVideoRequest,
  httpsMediaUrl,
  responseStatus,
  responseString,
  validateProviderTaskId,
  type CommercialVideoPollQuery,
  type CommercialVideoPollResult,
  type CommercialVideoProviderConfig,
  type CommercialVideoRequest,
  type ProviderHttpRequest,
} from './types';
import type { PaidGenerationInterceptor } from '../../budget/paid-generation';
import { CommercialVideoAdapter } from './commercial-base';

const DEFAULT_ENDPOINT = 'https://api.klingai.com';

const KLING_PENDING = new Set(['submitted', 'processing', 'queued', 'running']);
const KLING_SUCCEEDED = new Set(['succeed', 'succeeded', 'completed']);

function klingVideoUrl(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const data = (body as Record<string, unknown>).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const result = (data as Record<string, unknown>).task_result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const videos = (result as Record<string, unknown>).videos;
  if (!Array.isArray(videos) || videos.length === 0) return null;
  const first = videos[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null;
  return httpsMediaUrl((first as Record<string, unknown>).url, 'Kling 视频地址') ?? null;
}

function checkedDuration(request: CommercialVideoRequest, max: number): number {
  if (request.durationSeconds > max) {
    throw new CommercialVideoError(400, 'VIDEO_PROVIDER_DURATION_UNSUPPORTED',
      `Kling 当前适配器只支持不超过 ${max} 秒的时长。`);
  }
  return request.durationSeconds;
}

export class KlingVideoAdapter extends CommercialVideoAdapter {
  constructor(config: CommercialVideoProviderConfig, budget: PaidGenerationInterceptor) {
    super('kling', { ...config, endpoint: config.endpoint || DEFAULT_ENDPOINT }, budget);
  }

  protected buildRequest(raw: CommercialVideoRequest): ProviderHttpRequest {
    const request = parseCommercialVideoRequest(raw, 'kling');
    const duration = checkedDuration(request, 10);
    if (!Number.isInteger(duration) || ![5, 10].includes(duration)) {
      throw new CommercialVideoError(400, 'VIDEO_PROVIDER_DURATION_UNSUPPORTED', 'Kling 适配器要求 5 或 10 秒时长。');
    }
    const path = request.firstFrameUrl ? '/v1/videos/image2video' : '/v1/videos/text2video';
    const body: Record<string, unknown> = {
      model_name: request.model,
      prompt: request.prompt,
      ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
      ...(request.firstFrameUrl ? { image: request.firstFrameUrl } : {}),
      ...(request.lastFrameUrl ? { image_tail: request.lastFrameUrl } : {}),
      duration: String(duration),
      aspect_ratio: request.ratio,
      mode: request.resolution === '1080p' ? 'pro' : 'std',
      cfg_scale: 0.5,
      external_task_id: request.clientRequestId,
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
    };
    return {
      url: `${this.config.endpoint.replace(/\/+$/u, '')}${path}`,
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' },
      body,
    };
  }

  protected parseTaskId(response: unknown): string | null {
    return responseString(response, 'data', 'task_id') ?? responseString(response, 'task_id');
  }

  protected buildPollRequest(query: CommercialVideoPollQuery): ProviderHttpRequest {
    const taskId = validateProviderTaskId(query.providerTaskId, 'kling');
    const path = query.imageToVideo ? 'image2video' : 'text2video';
    return {
      url: `${this.config.endpoint.replace(/\/+$/u, '')}/v1/videos/${path}/${encodeURIComponent(taskId)}`,
      method: 'GET',
      headers: { authorization: `Bearer ${this.config.apiKey}` },
    };
  }

  protected parsePollResponse(response: unknown, query: CommercialVideoPollQuery): CommercialVideoPollResult {
    const status = responseStatus(response, 'data', 'task_status') ?? responseStatus(response, 'task_status');
    const message = responseStatus(response, 'data', 'task_status_msg');
    if (status && KLING_SUCCEEDED.has(status)) {
      const videoUrl = klingVideoUrl(response);
      if (!videoUrl) {
        return { provider: 'kling', taskId: query.providerTaskId, state: 'failed', videoUrl: null,
          message: 'Kling 返回成功状态但没有可用的视频地址。' };
      }
      return { provider: 'kling', taskId: query.providerTaskId, state: 'succeeded', videoUrl, message };
    }
    if (status && KLING_PENDING.has(status)) {
      return { provider: 'kling', taskId: query.providerTaskId, state: 'pending', videoUrl: null, message };
    }
    return { provider: 'kling', taskId: query.providerTaskId, state: 'failed', videoUrl: null,
      message: status ? `Kling 任务状态：${status}${message ? `；${message}` : ''}` : 'Kling 轮询响应缺少任务状态。' };
  }
}
