import type { AppConfig } from '../config';
import { AssetError, localAssetUrl } from '../assets/contracts';
import type { AssetService } from '../assets/service';
import { SeedanceVideoClient, type SeedanceTask } from '../models/media-client';
import { ModelError } from '../models/contracts';
import { classifyPaidProviderError } from '../models/submit-disposition';
import { VideoAutomationError, type StoredVideoRun, type VideoAvailability } from './contracts';

export type VideoSubmitResult = { state: 'submitted'; task: SeedanceTask }
  | { state: 'blocked' | 'unknown'; code: string; message: string };
export interface VideoAutomationAdapter {
  health(): Promise<VideoAvailability>;
  submit(run: StoredVideoRun): Promise<VideoSubmitResult>;
  query(run: StoredVideoRun): Promise<SeedanceTask>;
}

/** Only runtime clients hold credentials. Persisted runs contain no endpoint or key. */
export class SeedanceVideoAutomationAdapter implements VideoAutomationAdapter {
  private readonly clients = new Map<string, SeedanceVideoClient>();
  constructor(private readonly resolveConfig: () => AppConfig, private readonly transport: typeof fetch = fetch,
    private readonly assets?: Pick<AssetService, 'get' | 'content'>) {}
  private client(config: AppConfig) {
    return new SeedanceVideoClient({ endpoint: config.endpointUrl ?? '', model: config.defaultModel,
      authType: config.authType ?? 'api-key', apiKey: config.apiKey, timeoutMs: config.timeoutMs, fetch: this.transport });
  }
  async health(): Promise<VideoAvailability> {
    const config = this.resolveConfig();
    const base = { model: config.defaultModel || null, connectionRevision: config.connectionRevision ?? null };
    if (!config.endpointUrl || !config.defaultModel || !config.apiKey || !config.connectionRevision) {
      return { ...base, available: false, code: 'VIDEO_MODEL_NOT_CONFIGURED', message: '请先在模型设置中完整配置并选中生视频连接。' };
    }
    try { this.client(config); }
    catch { return { ...base, available: false, code: 'VIDEO_MODEL_CONFIG_INVALID', message: '生视频接口、鉴权或超时配置无效。' }; }
    return { ...base, available: true, code: 'VIDEO_MODEL_READY', message: '生视频连接配置完整；实际可用性将在授权生成时验证。' };
  }
  async submit(run: StoredVideoRun): Promise<VideoSubmitResult> {
    const config = this.resolveConfig();
    if (config.connectionRevision !== run.modelConnectionRevision || config.defaultModel !== run.model) {
      return { state: 'blocked', code: 'MODEL_SELECTION_CHANGED', message: '生视频连接已变化，未调用模型。请刷新设置后重新确认。' };
    }
    let client: SeedanceVideoClient;
    try { client = this.client(config); }
    catch { return { state: 'blocked', code: 'VIDEO_MODEL_NOT_CONFIGURED', message: '生视频连接未完整配置，未调用模型。' }; }
    const references = await this.referenceImages(run);
    if (references.state === 'blocked') return references;
    // Keep the exact client for result queries even if settings change mid-run.
    this.clients.set(run.id, client);
    try {
      return { state: 'submitted', task: await client.submit({ prompt: run.prompt, ratio: run.ratio,
        duration: run.duration, resolution: run.resolution, generateAudio: run.generateAudio,
        referenceImageUrls: references.sources, watermark: false }) };
    } catch (error) {
      if (classifyPaidProviderError(error) === 'notSent') {
        if (error instanceof ModelError && error.code === 'INVALID_MEDIA_REQUEST') {
          return { state: 'blocked', code: 'VIDEO_REFERENCE_ASSET_INVALID',
            message: '视频参考图片未通过本地校验，未调用模型。' };
        }
        return { state: 'blocked', code: error instanceof ModelError ? error.code : 'VIDEO_REQUEST_NOT_SENT',
          message: '视频请求在发送前被拒绝，未调用模型，可以在修正后重试。' };
      }
      return { state: 'unknown', code: 'VIDEO_SUBMISSION_UNCERTAIN',
        message: '无法确认供应商是否已收到视频请求，可能已消耗额度；不会自动重发。' };
    }
  }

  private async referenceImages(run: StoredVideoRun): Promise<{ state: 'ready'; sources: string[] }
    | { state: 'blocked'; code: string; message: string }> {
    const ids = run.referenceAssetIds ?? [];
    if (!Array.isArray(ids) || ids.length > 30 || new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== 'string' || !/^asset_[a-f0-9]{32}$/u.test(id))) {
      return { state: 'blocked', code: 'VIDEO_REFERENCE_ASSETS_INVALID',
        message: '视频任务中的参考资产清单无效，未调用模型。' };
    }
    if (!ids.length) return { state: 'ready', sources: [] };
    if (!this.assets) return { state: 'blocked', code: 'VIDEO_REFERENCE_ASSETS_UNAVAILABLE',
      message: '当前视频执行器未连接资产库，未调用模型。' };
    const sources: string[] = [];
    try {
      for (const id of ids) {
        const asset = await this.assets.get(id);
        if (asset.id !== id) throw new AssetError(409, 'ASSET_REFERENCE_MISMATCH', '资产返回标识不匹配。');
        if (asset.resourceUrl === localAssetUrl(id)) {
          const media = await this.assets.content(id);
          sources.push(`data:${media.mimeType};base64,${media.bytes.toString('base64')}`);
        } else {
          sources.push(asset.resourceUrl);
        }
      }
    } catch (error) {
      const code = error instanceof AssetError ? error.code : 'ASSET_REFERENCE_UNAVAILABLE';
      return { state: 'blocked', code: 'VIDEO_REFERENCE_ASSET_UNAVAILABLE',
        message: `无法读取已绑定的视频参考资产（${code}），未调用模型。` };
    }
    return { state: 'ready', sources };
  }
  async query(run: StoredVideoRun): Promise<SeedanceTask> {
    if (!run.providerTaskId) throw new VideoAutomationError(409, 'VIDEO_TASK_ID_UNKNOWN', '尚无供应商任务 ID，不能安全查询或重发。');
    let client = this.clients.get(run.id);
    if (!client) {
      const config = this.resolveConfig();
      if (config.connectionRevision !== run.modelConnectionRevision || config.defaultModel !== run.model) {
        throw new VideoAutomationError(409, 'VIDEO_QUERY_CONNECTION_CHANGED', '本次任务的原模型连接已变更，无法安全查询；供应商任务 ID 已保留，不会重新生成。');
      }
      client = this.client(config);
      this.clients.set(run.id, client);
    }
    return client.query(run.providerTaskId);
  }
}
