import { randomUUID } from 'node:crypto';

export type CommercialVideoProvider = 'kling' | 'jimeng' | 'minimax';

export interface CommercialVideoRequest {
  workspaceId: string;
  operationKey: string;
  clientRequestId: string;
  runId?: string | null;
  taskId?: string | null;
  provider: CommercialVideoProvider;
  model: string;
  prompt: string;
  negativePrompt?: string;
  durationSeconds: number;
  ratio: '9:16' | '16:9';
  resolution: '720p' | '1080p';
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  referenceImageUrls?: string[];
  generateAudio: boolean;
  seed?: number;
  watermark?: boolean;
  estimateMicros: number;
  budgetLimitMicros: number;
  currency: string;
}

export interface CommercialVideoAcceptance {
  provider: CommercialVideoProvider;
  taskId: string;
  model: string;
  operationKey: string;
  reservationId: string;
  status: 'submitted';
}

export interface CommercialVideoProviderConfig {
  endpoint: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /** MiniMax GroupId; sent as a query parameter, never persisted in a run. */
  groupId?: string;
}

export interface ProviderHttpRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export class CommercialVideoError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'CommercialVideoError';
  }
}

export class ProviderHttpError extends CommercialVideoError {
  constructor(public readonly upstreamStatus: number, message: string) {
    super(502, 'VIDEO_PROVIDER_HTTP_ERROR', message);
    this.name = 'ProviderHttpError';
  }
}

const WORKSPACE = /^ws_[a-f0-9]{32}$/u;
const OPERATION = /^[A-Za-z0-9_.:-]{1,160}$/u;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,100}$/u;
const PROVIDERS = new Set<CommercialVideoProvider>(['kling', 'jimeng', 'minimax']);
const MAX_IMAGE_URL = 4096;

function invalid(message: string): never {
  throw new CommercialVideoError(400, 'VIDEO_PROVIDER_REQUEST_INVALID', message);
}

function privateImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (host.startsWith('::ffff:')) {
    const mapped = host.slice(7);
    return mapped.includes('.') ? privateImageHost(mapped) : true;
  }
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '::') return true;
  if (/^127\./u.test(host) || /^10\./u.test(host) || /^192\.168\./u.test(host) || /^169\.254\./u.test(host)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./u.test(host)) return true;
  if (/^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./u.test(host)) return true;
  if (/^(fc|fd|fe80|ff)[0-9a-f:]*$/u.test(host)) return true;
  return false;
}

function httpsImageUrl(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > MAX_IMAGE_URL || /[\\\x00-\x20\x7f]/u.test(value)) {
    invalid(`${label}必须是 HTTPS 图片地址。`);
  }
  let url: URL;
  try { url = new URL(value); } catch { invalid(`${label}必须是 HTTPS 图片地址。`); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) invalid(`${label}必须是 HTTPS 图片地址。`);
  if (privateImageHost(url.hostname)) invalid(`${label}不能指向本机或内网地址。`);
  return url.href;
}

export function parseCommercialVideoRequest(value: CommercialVideoRequest,
  expectedProvider?: CommercialVideoProvider): CommercialVideoRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('商用视频请求格式无效。');
  if (!PROVIDERS.has(value.provider) || expectedProvider && value.provider !== expectedProvider) {
    invalid('视频供应商适配器不匹配。');
  }
  if (typeof value.workspaceId !== 'string' || !WORKSPACE.test(value.workspaceId)) invalid('视频请求缺少有效工作区。');
  if (typeof value.operationKey !== 'string' || !OPERATION.test(value.operationKey)) invalid('视频请求缺少有效 operationKey。');
  if (typeof value.clientRequestId !== 'string' || !REQUEST_ID.test(value.clientRequestId)) invalid('视频请求标识无效。');
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 160
    || /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value.model)) invalid('视频模型标识无效。');
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 32000
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value.prompt)) invalid('视频提示词无效。');
  if (value.negativePrompt !== undefined
    && (typeof value.negativePrompt !== 'string' || value.negativePrompt.length > 4000
      || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value.negativePrompt))) invalid('视频负向提示词无效。');
  if (!Number.isInteger(value.durationSeconds) || value.durationSeconds < 1 || value.durationSeconds > 30) {
    invalid('视频时长必须在 1–30 秒。');
  }
  if (value.ratio !== '9:16' && value.ratio !== '16:9') invalid('视频画幅只支持 9:16 或 16:9。');
  if (value.resolution !== '720p' && value.resolution !== '1080p') invalid('视频分辨率只支持 720p 或 1080p。');
  const firstFrameUrl = httpsImageUrl(value.firstFrameUrl, '首帧');
  const lastFrameUrl = httpsImageUrl(value.lastFrameUrl, '尾帧');
  if (lastFrameUrl && !firstFrameUrl) invalid('尾帧必须同时提供首帧。');
  if (firstFrameUrl && lastFrameUrl && firstFrameUrl === lastFrameUrl) invalid('首帧与尾帧不能是同一张图。');
  const references = value.referenceImageUrls === undefined ? [] : value.referenceImageUrls;
  if (!Array.isArray(references) || references.length > 10 || new Set(references).size !== references.length) {
    invalid('参考图片最多 10 张且不能重复。');
  }
  const normalizedReferences = references.map((item, index) => {
    if (typeof item !== 'string') invalid(`参考图 ${index + 1} 必须是 HTTPS 图片地址。`);
    return httpsImageUrl(item, `参考图 ${index + 1}`)!;
  });
  if ([firstFrameUrl, lastFrameUrl].some(item => item && normalizedReferences.includes(item))) {
    invalid('参考图片不能与首尾帧重复。');
  }
  if (typeof value.generateAudio !== 'boolean') invalid('视频音轨策略必须是布尔值。');
  if (value.seed !== undefined && (!Number.isInteger(value.seed) || value.seed < 0 || value.seed > 2_147_483_647)) {
    invalid('视频 seed 无效。');
  }
  if (!Number.isSafeInteger(value.estimateMicros) || value.estimateMicros <= 0
    || !Number.isSafeInteger(value.budgetLimitMicros) || value.budgetLimitMicros < value.estimateMicros) {
    invalid('视频生成必须提供正数预算估价且不超过已授权上限。');
  }
  if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/u.test(value.currency)) invalid('视频预算币种无效。');
  return {
    ...value,
    prompt: value.prompt.trim(),
    negativePrompt: value.negativePrompt?.trim() || undefined,
    ...(firstFrameUrl ? { firstFrameUrl } : {}),
    ...(lastFrameUrl ? { lastFrameUrl } : {}),
    ...(normalizedReferences.length ? { referenceImageUrls: normalizedReferences } : {}),
    runId: value.runId ?? null,
    taskId: value.taskId ?? null,
  };
}

export function assertProviderConfig(config: CommercialVideoProviderConfig, provider: CommercialVideoProvider): void {
  if (!config || typeof config !== 'object') invalid('视频供应商配置缺失。');
  if (typeof config.endpoint !== 'string' || !config.endpoint.trim()) invalid('视频供应商 endpoint 缺失。');
  let url: URL;
  try { url = new URL(config.endpoint); } catch { invalid('视频供应商 endpoint 无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    invalid('视频供应商 endpoint 必须是无查询参数、无凭据的 HTTPS 地址。');
  }
  if (provider === 'minimax' && (typeof config.groupId !== 'string' || !/^[0-9]{6,32}$/u.test(config.groupId))) {
    invalid('MiniMax 需要有效的 GroupId。');
  }
  if (typeof config.apiKey !== 'string' || !config.apiKey.trim() || config.apiKey.length > 4096) {
    invalid('视频供应商密钥缺失。');
  }
  if (config.timeoutMs !== undefined && (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 600_000)) {
    invalid('视频供应商超时配置无效。');
  }
}

export async function providerPostJson(config: CommercialVideoProviderConfig, request: ProviderHttpRequest): Promise<unknown> {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 180_000;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method, headers: request.headers, body: JSON.stringify(request.body),
      redirect: 'error', signal,
    });
  } catch {
    if (signal.aborted) throw new ProviderHttpError(408, '视频供应商请求超时；提交结果不明。');
    throw new ProviderHttpError(0, '视频供应商网络请求失败；提交结果不明。');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderHttpError(response.status, `视频供应商返回 HTTP ${response.status}。`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new CommercialVideoError(502, 'VIDEO_PROVIDER_RESPONSE_INVALID', '视频供应商返回空响应。');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new CommercialVideoError(502, 'VIDEO_PROVIDER_RESPONSE_TOO_LARGE', '视频供应商响应超过 4 MiB。');
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof CommercialVideoError) throw error;
    throw new CommercialVideoError(502, 'VIDEO_PROVIDER_RESPONSE_INVALID', '无法完整读取视频供应商响应。');
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
  catch { throw new CommercialVideoError(502, 'VIDEO_PROVIDER_RESPONSE_INVALID', '视频供应商没有返回有效 JSON。'); }
}

export function responseString(body: unknown, ...keys: string[]): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  let current: unknown = body;
  for (const key of keys) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && /^[A-Za-z0-9_.:-]{8,160}$/u.test(current) ? current : null;
}

export function newProviderClientId(): string { return `lyra_${randomUUID().replaceAll('-', '')}`; }
