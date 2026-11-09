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

const DEFAULT_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks';

/** 方舟内容生成协议的终态/进行中状态映射（即梦与 Seedance 同协议）。 */
export const ARK_PENDING = new Set(['queued', 'running', 'generating']);
export const ARK_SUCCEEDED = new Set(['succeeded', 'success', 'completed']);

export function arkPollResult(response: unknown, provider: 'jimeng' | 'seedance',
  taskId: string): CommercialVideoPollResult {
  const status = responseStatus(response, 'status');
  if (status && ARK_SUCCEEDED.has(status)) {
    const content = response && typeof response === 'object' && !Array.isArray(response)
      ? (response as Record<string, unknown>).content : null;
    const videoUrl = content && typeof content === 'object' && !Array.isArray(content)
      ? httpsMediaUrl((content as Record<string, unknown>).video_url, '视频地址') ?? null : null;
    const lastFrameUrl = content && typeof content === 'object' && !Array.isArray(content)
      ? httpsMediaUrl((content as Record<string, unknown>).last_frame_url, '尾帧地址') ?? null : null;
    if (!videoUrl) {
      return { provider, taskId, state: 'failed', videoUrl: null,
        message: 'Ark 返回成功状态但没有可用的视频地址。' };
    }
    return { provider, taskId, state: 'succeeded', videoUrl, lastFrameUrl, message: null };
  }
  if (status && ARK_PENDING.has(status)) {
    return { provider, taskId, state: 'pending', videoUrl: null, message: null };
  }
  if (status === 'failed' || status === 'cancelled') {
    return { provider, taskId, state: 'failed', videoUrl: null,
      message: `Ark 任务状态：${status}` };
  }
  return { provider, taskId, state: 'failed', videoUrl: null, message: 'Ark 轮询响应缺少任务状态。' };
}

export class JimengVideoAdapter extends CommercialVideoAdapter {
  constructor(config: CommercialVideoProviderConfig, budget: PaidGenerationInterceptor) {
    super('jimeng', { ...config, endpoint: config.endpoint || DEFAULT_ENDPOINT }, budget);
  }

  protected buildRequest(raw: CommercialVideoRequest): ProviderHttpRequest {
    const request = parseCommercialVideoRequest(raw, 'jimeng');
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: request.prompt }];
    if (request.firstFrameUrl) {
      content.push({ type: 'image_url', image_url: { url: request.firstFrameUrl }, role: 'first_frame' });
    }
    if (request.lastFrameUrl) {
      content.push({ type: 'image_url', image_url: { url: request.lastFrameUrl }, role: 'last_frame' });
    }
    for (const url of request.referenceImageUrls ?? []) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
    }
    const body: Record<string, unknown> = {
      model: request.model,
      content,
      generate_audio: request.generateAudio,
      ratio: request.ratio,
      duration: request.durationSeconds,
      resolution: request.resolution,
      watermark: request.watermark ?? false,
      ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
    };
    return {
      url: this.config.endpoint,
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' },
      body,
    };
  }

  protected parseTaskId(response: unknown): string | null {
    if (response && typeof response === 'object' && !Array.isArray(response)
      && (response as Record<string, unknown>).error) {
      throw new CommercialVideoError(502, 'VIDEO_PROVIDER_REJECTED', '即梦/Ark 返回了错误响应。');
    }
    return responseString(response, 'id') ?? responseString(response, 'task_id')
      ?? responseString(response, 'data', 'task_id') ?? responseString(response, 'data', 'id');
  }

  protected buildPollRequest(query: CommercialVideoPollQuery): ProviderHttpRequest {
    const taskId = validateProviderTaskId(query.providerTaskId, 'jimeng');
    return {
      url: `${this.config.endpoint.replace(/\/+$/u, '')}/${encodeURIComponent(taskId)}`,
      method: 'GET',
      headers: { authorization: `Bearer ${this.config.apiKey}` },
    };
  }

  protected parsePollResponse(response: unknown, query: CommercialVideoPollQuery): CommercialVideoPollResult {
    return arkPollResult(response, 'jimeng', query.providerTaskId);
  }
}
