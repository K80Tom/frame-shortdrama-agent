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

const DEFAULT_ENDPOINT = 'https://api.klingai.com';

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
}
