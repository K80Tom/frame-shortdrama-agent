import {
  CommercialVideoError,
  parseCommercialVideoRequest,
  responseString,
  type CommercialVideoProviderConfig,
  type CommercialVideoRequest,
  type ProviderHttpRequest,
} from './types';
import type { PaidGenerationInterceptor } from '../../budget/paid-generation';
import { CommercialVideoAdapter } from './commercial-base';

const DEFAULT_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks';

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
}
