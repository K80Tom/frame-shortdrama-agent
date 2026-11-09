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

const DEFAULT_ENDPOINT = 'https://api.minimax.chat/v1/video_generation';

export class MiniMaxVideoAdapter extends CommercialVideoAdapter {
  constructor(config: CommercialVideoProviderConfig, budget: PaidGenerationInterceptor) {
    super('minimax', { ...config, endpoint: config.endpoint || DEFAULT_ENDPOINT }, budget);
  }

  protected buildRequest(raw: CommercialVideoRequest): ProviderHttpRequest {
    const request = parseCommercialVideoRequest(raw, 'minimax');
    if (request.durationSeconds > 15) {
      throw new CommercialVideoError(400, 'VIDEO_PROVIDER_DURATION_UNSUPPORTED', 'MiniMax 适配器只支持不超过 15 秒的时长。');
    }
    const groupId = this.config.groupId!;
    const body: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt,
      ...(request.firstFrameUrl ? { first_frame_image: request.firstFrameUrl } : {}),
      ...(request.lastFrameUrl ? { last_frame_image: request.lastFrameUrl } : {}),
      duration: request.durationSeconds,
      resolution: request.resolution === '1080p' ? '1080P' : '720P',
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
    };
    return {
      url: `${this.config.endpoint}?GroupId=${encodeURIComponent(groupId)}`,
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' },
      body,
    };
  }

  protected parseTaskId(response: unknown): string | null {
    return responseString(response, 'task_id') ?? responseString(response, 'data', 'task_id');
  }
}
