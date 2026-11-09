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

const DEFAULT_ENDPOINT = 'https://api.minimax.chat/v1/video_generation';

const MINIMAX_SUCCEEDED = new Set(['success', 'succeeded', 'completed']);
const MINIMAX_PENDING = new Set(['queueing', 'processing', 'pending', 'running']);

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

  protected buildPollRequest(query: CommercialVideoPollQuery): ProviderHttpRequest {
    const taskId = validateProviderTaskId(query.providerTaskId, 'minimax');
    const origin = new URL(this.config.endpoint).origin;
    const groupId = this.config.groupId!;
    return {
      url: `${origin}/v1/query/video_generation?GroupId=${encodeURIComponent(groupId)}&task_id=${encodeURIComponent(taskId)}`,
      method: 'GET',
      headers: { authorization: `Bearer ${this.config.apiKey}` },
    };
  }

  protected parsePollResponse(response: unknown, query: CommercialVideoPollQuery): CommercialVideoPollResult {
    const status = responseStatus(response, 'status');
    if (status && MINIMAX_SUCCEEDED.has(status.toLowerCase())) {
      const file = response && typeof response === 'object' && !Array.isArray(response)
        ? (response as Record<string, unknown>).file : null;
      const videoUrl = file && typeof file === 'object' && !Array.isArray(file)
        ? httpsMediaUrl((file as Record<string, unknown>).download_url, 'MiniMax 视频地址') ?? null : null;
      if (!videoUrl) {
        return { provider: 'minimax', taskId: query.providerTaskId, state: 'failed', videoUrl: null,
          message: 'MiniMax 返回成功状态但没有可用的视频地址。' };
      }
      return { provider: 'minimax', taskId: query.providerTaskId, state: 'succeeded', videoUrl, message: null };
    }
    if (status && MINIMAX_PENDING.has(status.toLowerCase())) {
      return { provider: 'minimax', taskId: query.providerTaskId, state: 'pending', videoUrl: null, message: null };
    }
    return { provider: 'minimax', taskId: query.providerTaskId, state: 'failed', videoUrl: null,
      message: status ? `MiniMax 任务状态：${status}` : 'MiniMax 轮询响应缺少任务状态。' };
  }
}
