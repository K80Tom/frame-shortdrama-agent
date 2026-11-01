import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { AppConfig } from '../config';
import { DoubaoImageClient } from '../models/media-client';
import { ModelError } from '../models/contracts';
import { classifyPaidProviderError } from '../models/submit-disposition';
import type { DesktopAssetAdapter, DesktopBridgeHealth, DesktopSubmitInput, DesktopSubmitResult } from './adapter';

export interface DoubaoImageApiAdapterOptions {
  projectRoot?: string;
  fetch?: typeof globalThis.fetch;
}

function unavailable(code: string, message: string, model?: string, connectionRevision?: string): DesktopBridgeHealth {
  return { available: false, installed: true, accessibilityTrusted: true, code, message,
    transport: 'api', ...(model ? { model } : {}), ...(connectionRevision ? { connectionRevision } : {}) };
}

/** Executes the image role selected in Settings. The adapter persists the
 * returned bytes into the existing resumable asset-job directory; credentials
 * and provider payloads never enter task JSON or browser responses. */
export class DoubaoImageApiAdapter implements DesktopAssetAdapter {
  readonly promptMode = 'api' as const;
  private readonly outputRoot: string;
  private readonly transport: typeof globalThis.fetch;

  constructor(private readonly resolveConfig: () => AppConfig, options: DoubaoImageApiAdapterOptions = {}) {
    this.outputRoot = resolve(options.projectRoot ?? process.cwd(), 'outputs/private/desktop-assets');
    this.transport = options.fetch ?? globalThis.fetch;
  }

  private snapshot() {
    const config = this.resolveConfig();
    return {
      endpoint: config.endpointUrl ?? '',
      model: config.defaultModel,
      authType: config.authType ?? 'api-key' as const,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      connectionRevision: config.connectionRevision,
    };
  }

  async health(): Promise<DesktopBridgeHealth> {
    const config = this.snapshot();
    if (!config.endpoint || !config.model || !config.apiKey || !config.connectionRevision) {
      return unavailable('IMAGE_MODEL_NOT_CONFIGURED', '请在「工作台设置 → 模型连接」完整配置并选中生图模型。',
        config.model, config.connectionRevision);
    }
    try {
      // Construction performs local-only validation; health never spends quota.
      new DoubaoImageClient({ ...config, fetch: this.transport });
    } catch {
      return unavailable('IMAGE_MODEL_CONFIG_INVALID', '生图模型的接口、鉴权或超时配置无效。', config.model, config.connectionRevision);
    }
    return { available: true, installed: true, accessibilityTrusted: true, code: 'IMAGE_MODEL_READY',
      message: `已选中生图模型 ${config.model}。连接配置完整，实际可用性将在用户授权的生成请求中验证。`,
      model: config.model, connectionRevision: config.connectionRevision, transport: 'api' };
  }

  async submit(input: DesktopSubmitInput): Promise<DesktopSubmitResult> {
    if (!/^desktop_[a-f0-9]{32}$/.test(input.jobId)
      || resolve(input.outputPath) !== join(this.outputRoot, input.jobId, 'result.png')) {
      return { state: 'blocked', code: 'IMAGE_OUTPUT_PATH_INVALID', message: '生图产物路径不正确，未调用模型。' };
    }
    const config = this.snapshot();
    if (!config.connectionRevision || input.expectedModelConnectionRevision !== config.connectionRevision) {
      return { state: 'blocked', code: 'MODEL_SELECTION_CHANGED', message: '生图连接已变化，未调用模型；请刷新后重新确认。' };
    }
    const directory = dirname(input.outputPath);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) {
        return { state: 'blocked', code: 'IMAGE_OUTPUT_PATH_INVALID', message: '生图产物目录不安全，未调用模型。' };
      }
    } catch {
      return { state: 'blocked', code: 'IMAGE_OUTPUT_PATH_INVALID', message: '生图产物目录未准备好，未调用模型。' };
    }

    let generated: Awaited<ReturnType<DoubaoImageClient['generateImage']>>;
    try {
      const client = new DoubaoImageClient({ ...config, fetch: this.transport });
      generated = await client.generateImage({ prompt: input.prompt, size: '2K', responseFormat: 'url', watermark: false });
    } catch (error) {
      if (classifyPaidProviderError(error) === 'notSent') {
        return { state: 'blocked', code: error instanceof ModelError ? error.code : 'IMAGE_REQUEST_NOT_SENT',
          message: '生图请求在发送前被拒绝，未调用模型，可以在修正后重试。' };
      }
      // Once transport begins, even a timeout or malformed reply may have spent
      // quota. Persist uncertainty and never turn it into an automatic retry.
      return { state: 'unknown', code: 'IMAGE_SUBMISSION_UNCERTAIN',
        message: '未能确认生图请求的最终结果；已停止自动重试，避免重复消耗额度。' };
    }

    const temporary = join(directory, `.result-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(generated.bytes); await handle.sync(); }
      finally { await handle.close(); }
      // Hard-linking is an atomic, no-overwrite publish on the same filesystem.
      await link(temporary, input.outputPath);
      await unlink(temporary);
      return { state: 'submitted', code: 'IMAGE_READY', message: '生成图片已安全保存，等待导入资产库。' };
    } catch {
      await unlink(temporary).catch(() => undefined);
      return { state: 'unknown', code: 'IMAGE_OUTPUT_SAVE_UNCERTAIN',
        message: '上游可能已生成图片，但本地产物未能安全核对；不会自动重试。' };
    }
  }
}
