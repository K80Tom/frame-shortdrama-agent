import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { MAX_ASSET_BYTES, inspectAssetImage, type AssetMedia } from '../assets/media';
import { ModelError } from './contracts';

export type MediaAuthType = 'api-key' | 'bearer';

export type MediaDnsLookup = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

/** Runtime-only media connection. Callers must pass the complete operation endpoint. */
export interface MediaClientConfig {
  endpoint: string;
  model: string;
  authType: MediaAuthType;
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
  /** Test/runtime injection point used only to validate provider-returned media download hosts. */
  lookup?: MediaDnsLookup;
  /**
   * Opt-in for networks where the provider's media CDN only resolves to intranet
   * addresses. When enabled, provider-returned download URLs skip the public-IP
   * DNS check (localhost-style hostnames stay blocked).
   */
  allowIntranetMediaSources?: boolean;
}

export interface GenerateImageInput {
  prompt: string;
  size?: string;
  watermark?: boolean;
  responseFormat?: 'url' | 'b64_json';
}

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: AssetMedia['mimeType'];
  source: 'url' | 'b64_json';
}

export interface SeedanceSubmitInput {
  prompt: string;
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
  generateAudio?: boolean;
  resolution?: string;
  duration?: number;
  ratio?: string;
  watermark?: boolean;
  safetyIdentifier?: string;
  omniReferenceTaskType?: string;
}

export interface SeedanceTask {
  taskId: string;
  status: string;
  done: boolean;
  videoUrl: string | null;
  errorMessage: string | null;
  model: string | null;
}

interface ResolvedConfig extends Omit<MediaClientConfig, 'fetch' | 'lookup'> {
  fetch: typeof globalThis.fetch;
  lookup: MediaDnsLookup;
}

const MAX_JSON_BYTES = Math.ceil(MAX_ASSET_BYTES / 3) * 4 + 64 * 1024;
const MAX_PROMPT_CHARS = 32_000;
export const MAX_REFERENCE_IMAGE_SOURCE_CHARS = Math.ceil(MAX_ASSET_BYTES / 3) * 4 + 64;
const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

function mediaError(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
  return new ModelError(status, code, message, details);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function cleanText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || hasUnpairedSurrogate(value)
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw mediaError(400, 'INVALID_MEDIA_REQUEST', `${name}不正确。`);
  }
  return value.trim();
}

function configText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || hasUnpairedSurrogate(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw mediaError(503, 'MEDIA_NOT_CONFIGURED', `${label}未完整配置。`);
  }
  return value.trim();
}

function operationUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw mediaError(503, 'MEDIA_NOT_CONFIGURED', '请配置完整的 HTTPS 媒体模型接口。'); }
  if (!/^https:\/\//.test(value) || /\\/.test(value) || parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.search || parsed.hash || parsed.pathname === '/') {
    throw mediaError(503, 'MEDIA_NOT_CONFIGURED', '媒体模型必须配置不含密钥、查询参数或片段的完整 HTTPS 接口。');
  }
  return parsed.href.replace(/\/$/, '');
}

function resolveConfig(value: MediaClientConfig): ResolvedConfig {
  const endpoint = operationUrl(value.endpoint);
  const model = configText(value.model, '模型名称', 200);
  const apiKey = configText(value.apiKey, 'API key', 4096);
  if (value.authType !== 'api-key' && value.authType !== 'bearer') {
    throw mediaError(503, 'MEDIA_NOT_CONFIGURED', '媒体模型鉴权方式不受支持。');
  }
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1_000 || value.timeoutMs > 600_000) {
    throw mediaError(503, 'MEDIA_NOT_CONFIGURED', '媒体模型超时时间不正确。');
  }
  if (value.allowIntranetMediaSources !== undefined && typeof value.allowIntranetMediaSources !== 'boolean') {
    throw mediaError(503, 'MEDIA_NOT_CONFIGURED', '媒体内网源开关配置不正确。');
  }
  return { endpoint, model, authType: value.authType, apiKey, timeoutMs: value.timeoutMs,
    fetch: value.fetch ?? globalThis.fetch,
    lookup: value.lookup ?? (hostname => dnsLookup(hostname, { all: true, verbatim: true })),
    allowIntranetMediaSources: value.allowIntranetMediaSources ?? false };
}

function authHeaders(config: ResolvedConfig): Record<string, string> {
  return config.authType === 'bearer'
    ? { Authorization: `Bearer ${config.apiKey}` }
    : { 'api-key': config.apiKey };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function boundedBytes(response: Response, maxBytes: number, tooLargeMessage: string): Promise<Buffer> {
  const announced = response.headers.get('content-length');
  if (announced && /^\d+$/.test(announced) && Number(announced) > maxBytes) {
    await response.body?.cancel();
    throw mediaError(502, 'MEDIA_RESPONSE_TOO_LARGE', tooLargeMessage);
  }
  const reader = response.body?.getReader();
  if (!reader) throw mediaError(502, 'INVALID_MEDIA_RESPONSE', '媒体服务返回了空响应。');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw mediaError(502, 'MEDIA_RESPONSE_TOO_LARGE', tooLargeMessage);
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof ModelError) throw error;
    throw mediaError(502, 'INVALID_MEDIA_RESPONSE', '无法完整读取媒体服务响应。');
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

async function boundedJson(response: Response): Promise<unknown> {
  const raw = await boundedBytes(response, MAX_JSON_BYTES, '媒体服务的 JSON 响应超过限制。');
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw mediaError(502, 'INVALID_MEDIA_RESPONSE', '媒体服务没有返回有效 JSON。'); }
}

async function configuredRequest(config: ResolvedConfig, url: string, init: RequestInit): Promise<Response> {
  const signal = AbortSignal.timeout(config.timeoutMs);
  try {
    const response = await config.fetch(url, { ...init, redirect: 'error', signal });
    if (!response.ok) {
      await response.body?.cancel();
      const hints: Record<number, string> = {
        400: '上游拒绝了媒体生成参数。',
        401: '请检查媒体模型密钥。',
        403: '当前账号没有此媒体模型权限。',
        404: '媒体模型或完整接口地址不可用。',
        429: '媒体模型限流或额度不足。',
      };
      throw mediaError(502, 'MEDIA_UPSTREAM_ERROR', hints[response.status] ?? '媒体模型上游服务失败。',
        { upstreamStatus: response.status });
    }
    return response;
  } catch (error) {
    if (error instanceof ModelError) throw error;
    if (signal.aborted) throw mediaError(504, 'MEDIA_UPSTREAM_TIMEOUT', '等待媒体模型超时；上游可能仍在执行或已计费，未自动重试。');
    throw mediaError(502, 'MEDIA_UPSTREAM_UNAVAILABLE', '无法完成媒体模型请求；结果可能未知，未自动重试。');
  }
}

function checkedImage(bytes: Buffer): GeneratedImage['mimeType'] {
  try { return inspectAssetImage(bytes); }
  catch { throw mediaError(502, 'INVALID_MEDIA_RESPONSE', '生图服务返回了不受支持、损坏或超过 6 MiB 的图片。'); }
}

function decodeBase64(value: string): Buffer {
  if (!value || value.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4 || value.length % 4
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw mediaError(502, 'INVALID_MEDIA_RESPONSE', '生图服务返回了无效图片数据。');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw mediaError(502, 'INVALID_MEDIA_RESPONSE', '生图服务返回了无效图片数据。');
  }
  return bytes;
}

function publicHttpsUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\\\x00-\x20\x7f]/.test(value)) {
    throw mediaError(502, 'INVALID_MEDIA_RESPONSE', `${label}不是可用的 HTTPS 地址。`);
  }
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw mediaError(502, 'INVALID_MEDIA_RESPONSE', `${label}不是可用的 HTTPS 地址。`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw mediaError(502, 'INVALID_MEDIA_RESPONSE', `${label}不是可用的 HTTPS 地址。`);
  }
  return parsed.href;
}

function ipv4Parts(value: string): number[] | null {
  if (isIP(value) !== 4) return null;
  const parts = value.split('.').map(Number);
  return parts.length === 4 ? parts : null;
}

function ipv6Bytes(value: string): Uint8Array | null {
  if (isIP(value) !== 6) return null;
  const halves = value.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] => {
    if (!half) return [];
    const tokens = half.split(':');
    const result: number[] = [];
    for (const token of tokens) {
      if (token.includes('.')) {
        const ipv4 = ipv4Parts(token);
        if (!ipv4) return [];
        result.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
      } else {
        result.push(Number.parseInt(token, 16));
      }
    }
    return result;
  };
  const left = parseHalf(halves[0] ?? '');
  const right = parseHalf(halves[1] ?? '');
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (words.length !== 8 || words.some(word => !Number.isInteger(word) || word < 0 || word > 0xffff)) return null;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < words.length; index++) {
    bytes[index * 2] = words[index]! >>> 8;
    bytes[index * 2 + 1] = words[index]! & 0xff;
  }
  return bytes;
}

function ipv6Prefix(value: Uint8Array, prefix: number[], bits: number): boolean {
  const wholeBytes = Math.floor(bits / 8);
  for (let index = 0; index < wholeBytes; index++) {
    if (value[index] !== prefix[index]) return false;
  }
  const remainder = bits % 8;
  if (!remainder) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (value[wholeBytes]! & mask) === (prefix[wholeBytes]! & mask);
}

function isPublicIpAddress(value: string): boolean {
  const ipv4 = ipv4Parts(value);
  if (ipv4) {
    const [a, b, c] = ipv4 as [number, number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 88 && c === 99)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113));
  }
  const ipv6 = ipv6Bytes(value);
  if (!ipv6) return false;
  // Only global-unicast IPv6 is eligible. Exclude IETF special, documentation and 6to4 ranges within 2000::/3.
  return ipv6Prefix(ipv6, [0x20], 3)
    && !ipv6Prefix(ipv6, [0x20, 0x01, 0x00], 23)
    && !ipv6Prefix(ipv6, [0x20, 0x01, 0x0d, 0xb8], 32)
    && !ipv6Prefix(ipv6, [0x20, 0x02], 16)
    && !ipv6Prefix(ipv6, [0x3f, 0xff, 0x00], 20);
}

/** Intranet mode: allow private ranges but never loopback, unspecified or link-local targets. */
function isNonLocalIntranetAddress(value: string): boolean {
  const ipv4 = ipv4Parts(value);
  if (ipv4) {
    const [a, b] = ipv4 as [number, number, number, number];
    return !(a === 0 || a === 127 || (a === 169 && b === 254));
  }
  const ipv6 = ipv6Bytes(value);
  if (!ipv6) return false;
  const unspecified = ipv6.every(byte => byte === 0);
  const loopback = ipv6[0] === 0 && ipv6.slice(1, 15).every(byte => byte === 0) && ipv6[15] === 1;
  const ipv4MappedLoopback = ipv6[10] === 0xff && ipv6[11] === 0xff && ipv6[12] === 0x7f;
  const linkLocal = ipv6[0] === 0xfe && ((ipv6[1] ?? 0) & 0xc0) === 0x80;
  return !unspecified && !loopback && !ipv4MappedLoopback && !linkLocal;
}

async function safeDownloadUrl(value: unknown, config: ResolvedConfig): Promise<string> {
  const href = publicHttpsUrl(value, '图片 URL');
  const parsed = new URL(href);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw mediaError(502, 'MEDIA_DOWNLOAD_UNSAFE', '上游返回的媒体下载地址不是公网地址。');
  }
  if (config.allowIntranetMediaSources) {
    // Opt-in mode for vendor CDNs that only resolve inside the corporate network.
    // Loopback, unspecified and link-local targets stay blocked; TLS still verifies the hostname.
    if (isIP(hostname) && !isNonLocalIntranetAddress(hostname)) {
      throw mediaError(502, 'MEDIA_DOWNLOAD_UNSAFE', '上游返回的媒体下载地址指向本机或链路本地地址。');
    }
    return href;
  }
  if (isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) {
      throw mediaError(502, 'MEDIA_DOWNLOAD_UNSAFE', '上游返回的媒体下载地址不是公网地址。');
    }
    return href;
  }
  let addresses: ReadonlyArray<{ address: string; family: number }>;
  try { addresses = await config.lookup(hostname); }
  catch { throw mediaError(502, 'MEDIA_DOWNLOAD_UNSAFE', '无法安全解析上游返回的媒体下载地址。'); }
  if (!addresses.length || addresses.some(item => !isPublicIpAddress(item.address))) {
    throw mediaError(502, 'MEDIA_DOWNLOAD_UNSAFE', '上游返回的媒体下载地址不是公网地址。');
  }
  return href;
}

function inputHttpsUrl(value: string, label: string): string {
  try { return publicHttpsUrl(value, label); }
  catch { throw mediaError(400, 'INVALID_MEDIA_REQUEST', `${label}必须是 HTTPS 地址。`); }
}

function inputImageSource(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.startsWith('data:')) return inputHttpsUrl(value as string, label);
  if (value.length > MAX_REFERENCE_IMAGE_SOURCE_CHARS) {
    throw mediaError(400, 'INVALID_MEDIA_REQUEST', `${label}超过 Base64 图片大小限制。`);
  }
  const matched = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value);
  const encoded = matched?.[2];
  if (!matched || !encoded || encoded.length % 4) {
    throw mediaError(400, 'INVALID_MEDIA_REQUEST', `${label}必须是 HTTPS 地址或规范的 Base64 图片。`);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_ASSET_BYTES || bytes.toString('base64') !== encoded) {
    throw mediaError(400, 'INVALID_MEDIA_REQUEST', `${label}的 Base64 图片数据无效。`);
  }
  let detected: AssetMedia['mimeType'];
  try { detected = inspectAssetImage(bytes); }
  catch { throw mediaError(400, 'INVALID_MEDIA_REQUEST', `${label}不是可用的 PNG、JPEG 或 WebP 图片。`); }
  if (detected !== matched[1]) {
    throw mediaError(400, 'INVALID_MEDIA_REQUEST', `${label}声明的格式与图片内容不一致。`);
  }
  return value;
}

/** OpenAI-compatible/Doubao image-generation adapter with bounded, verified image output. */
export class DoubaoImageClient {
  private readonly config: ResolvedConfig;
  constructor(config: MediaClientConfig) { this.config = resolveConfig(config); }

  async generateImage(input: GenerateImageInput): Promise<GeneratedImage> {
    const prompt = cleanText(input.prompt, '生图提示词', MAX_PROMPT_CHARS);
    const size = input.size === undefined ? '2K' : cleanText(input.size, '图片尺寸', 40);
    if (input.responseFormat !== undefined && input.responseFormat !== 'url' && input.responseFormat !== 'b64_json') {
      throw mediaError(400, 'INVALID_MEDIA_REQUEST', '图片返回格式不受支持。');
    }
    const response = await configuredRequest(this.config, this.config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(this.config) },
      // Default to inline bytes: many gateways return CDN URLs that are only
      // resolvable inside corporate networks. A URL-only response still works
      // through the guarded download path below.
      body: JSON.stringify({ model: this.config.model, prompt, size, n: 1,
        response_format: input.responseFormat ?? 'b64_json', stream: false, watermark: input.watermark ?? false }),
    });
    const payload = object(await boundedJson(response));
    const data = payload.data;
    if (!Array.isArray(data) || data.length < 1) {
      throw mediaError(502, 'INVALID_MEDIA_RESPONSE', '生图服务没有返回图片。');
    }
    const first = object(data[0]);
    if (typeof first.b64_json === 'string') {
      const bytes = decodeBase64(first.b64_json);
      return { bytes, mimeType: checkedImage(bytes), source: 'b64_json' };
    }
    if (typeof first.url !== 'string') {
      throw mediaError(502, 'INVALID_MEDIA_RESPONSE', '生图服务没有返回 URL 或 Base64 图片。');
    }
    const imageUrl = await safeDownloadUrl(first.url, this.config);
    // Provider credentials are deliberately not forwarded to the returned media host.
    const imageResponse = await configuredRequest(this.config, imageUrl, { method: 'GET', headers: {} });
    const bytes = await boundedBytes(imageResponse, MAX_ASSET_BYTES, '生成图片超过 6 MiB 限制。');
    return { bytes, mimeType: checkedImage(bytes), source: 'url' };
  }
}

function optionalUrlList(value: string[] | undefined, label: string, max: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw mediaError(400, 'INVALID_MEDIA_REQUEST', `${label}数量超过限制。`);
  return value.map(item => inputHttpsUrl(item, label));
}

function optionalImageSourceList(value: string[] | undefined, label: string, max: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw mediaError(400, 'INVALID_MEDIA_REQUEST', `${label}数量超过限制。`);
  return value.map(item => inputImageSource(item, label));
}

function statusString(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : '';
}

function safeProviderMessage(value: unknown, config: ResolvedConfig): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let result = value.trim();
  for (const secret of [config.apiKey, config.model, config.endpoint]) {
    if (secret) result = result.replaceAll(secret, '[REDACTED]');
  }
  result = result.replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\b(?:Bearer\s+)?(?:MAAS|sk-|ak-)[A-Za-z0-9._-]{8,}\b/gi, '[REDACTED]')
    .replace(/https:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]');
  return result.slice(0, 500);
}

/** Seedance asynchronous task adapter. The configured endpoint is the complete task-collection URL. */
export class SeedanceVideoClient {
  private readonly config: ResolvedConfig;
  constructor(config: MediaClientConfig) { this.config = resolveConfig(config); }

  async submit(input: SeedanceSubmitInput): Promise<SeedanceTask> {
    const prompt = cleanText(input.prompt, '生视频提示词', MAX_PROMPT_CHARS);
    const content: Record<string, unknown>[] = [{ type: 'text', text: prompt }];
    if (input.firstFrameUrl) content.push({ type: 'image_url',
      image_url: { url: inputImageSource(input.firstFrameUrl, '首帧图片') }, role: 'first_frame' });
    if (input.lastFrameUrl) content.push({ type: 'image_url',
      image_url: { url: inputImageSource(input.lastFrameUrl, '尾帧图片') }, role: 'last_frame' });
    for (const url of optionalImageSourceList(input.referenceImageUrls, '参考图片', 30)) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
    }
    for (const url of optionalUrlList(input.referenceVideoUrls, '参考视频', 10)) {
      content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' });
    }
    for (const url of optionalUrlList(input.referenceAudioUrls, '参考音频', 10)) {
      content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' });
    }
    if (input.duration !== undefined && (!Number.isInteger(input.duration)
      || (input.duration !== -1 && (input.duration < 4 || input.duration > 30)))) {
      throw mediaError(400, 'INVALID_MEDIA_REQUEST', '视频时长参数不正确。');
    }
    const body: Record<string, unknown> = {
      model: this.config.model,
      content,
      generate_audio: input.generateAudio ?? false,
      watermark: input.watermark ?? false,
    };
    if (input.resolution !== undefined) body.resolution = cleanText(input.resolution, '视频分辨率', 40);
    if (input.duration !== undefined) body.duration = input.duration;
    if (input.ratio !== undefined) body.ratio = cleanText(input.ratio, '视频比例', 40);
    if (input.safetyIdentifier !== undefined) body.safety_identifier = cleanText(input.safetyIdentifier, '安全标识', 200);
    if (input.omniReferenceTaskType !== undefined) {
      body.omni_reference_task_type = cleanText(input.omniReferenceTaskType, '全能参考任务类型', 100);
    }
    const response = await configuredRequest(this.config, this.config.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders(this.config) }, body: JSON.stringify(body),
    });
    // The task-creation API acknowledges only {id}; status is supplied by GET.
    return this.parseTask(await boundedJson(response), null, true);
  }

  async query(taskIdValue: string): Promise<SeedanceTask> {
    const taskId = cleanText(taskIdValue, '视频任务 ID', 200);
    if (!/^[A-Za-z0-9_.:-]+$/.test(taskId)) throw mediaError(400, 'INVALID_MEDIA_REQUEST', '视频任务 ID 格式不正确。');
    const response = await configuredRequest(this.config, `${this.config.endpoint}/${encodeURIComponent(taskId)}`, {
      method: 'GET', headers: { 'Content-Type': 'application/json', ...authHeaders(this.config) },
    });
    return this.parseTask(await boundedJson(response), taskId);
  }

  private parseTask(value: unknown, fallbackTaskId: string | null, submitted = false): SeedanceTask {
    const payload = object(value);
    const taskId = statusString(payload.id) || statusString(payload.task_id) || fallbackTaskId;
    if (!taskId) throw mediaError(502, 'INVALID_MEDIA_RESPONSE', '生视频服务没有返回任务 ID。');
    const status = statusString(payload.status) || (submitted && payload.status === undefined ? 'queued' : '');
    if (!status) throw mediaError(502, 'INVALID_MEDIA_RESPONSE', '生视频服务没有返回有效任务状态。');
    const content = object(payload.content);
    const videoUrl = content.video_url === undefined || content.video_url === ''
      ? null : publicHttpsUrl(content.video_url, '视频 URL');
    const providerError = object(payload.error).message ?? payload.message;
    const normalized = status.toLowerCase();
    if (normalized === 'succeeded' && !videoUrl) {
      throw mediaError(502, 'INVALID_MEDIA_RESPONSE', '生视频任务成功但没有返回视频 URL。');
    }
    return { taskId, status, done: terminalStatuses.has(normalized), videoUrl,
      errorMessage: safeProviderMessage(providerError, this.config),
      model: statusString(payload.model) || null };
  }
}
