import {
  CommercialVideoError,
  parseCommercialVideoRequest,
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
import { arkPollResult } from './jimeng';

const DEFAULT_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks';

/**
 * Seedance（火山方舟 doubao-seedance-*）：
 * - 与即梦同用方舟 content 协议；first/last frame 以显式 role 传递；
 * - 1.0 系模型不支持音画同生，generateAudio=true 时显式 unsupported，不静默丢弃；
 * - 时长域 2–30 秒（各具体模型上下限由 #127 CapabilityRevision 编译器进一步裁剪）。
 */
export class SeedanceVideoAdapter extends CommercialVideoAdapter {
  constructor(config: CommercialVideoProviderConfig, budget: PaidGenerationInterceptor) {
    super('seedance', { ...config, endpoint: config.endpoint || DEFAULT_ENDPOINT }, budget);
  }

  protected buildRequest(raw: CommercialVideoRequest): ProviderHttpRequest {
    const request = parseCommercialVideoRequest(raw, 'seedance');
    if (request.durationSeconds < 2) {
      throw new CommercialVideoError(400, 'VIDEO_PROVIDER_DURATION_UNSUPPORTED', 'Seedance 适配器要求至少 2 秒时长。');
    }
    if (request.generateAudio && /seedance-1-0/u.test(request.model)) {
      throw new CommercialVideoError(400, 'VIDEO_PROVIDER_AUDIO_UNSUPPORTED',
        'Seedance 1.0 系模型不支持音画同生；请关闭 generateAudio 或改用 1.5/2.x 模型。');
    }
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
      return_last_frame: true,
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
      throw new CommercialVideoError(502, 'VIDEO_PROVIDER_REJECTED', 'Seedance/Ark 返回了错误响应。');
    }
    return responseString(response, 'id') ?? responseString(response, 'task_id')
      ?? responseString(response, 'data', 'task_id') ?? responseString(response, 'data', 'id');
  }

  protected buildPollRequest(query: CommercialVideoPollQuery): ProviderHttpRequest {
    const taskId = validateProviderTaskId(query.providerTaskId, 'seedance');
    return {
      url: `${this.config.endpoint.replace(/\/+$/u, '')}/${encodeURIComponent(taskId)}`,
      method: 'GET',
      headers: { authorization: `Bearer ${this.config.apiKey}` },
    };
  }

  protected parsePollResponse(response: unknown, query: CommercialVideoPollQuery): CommercialVideoPollResult {
    return arkPollResult(response, 'seedance', query.providerTaskId);
  }
}
