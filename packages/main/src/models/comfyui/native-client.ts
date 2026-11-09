import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';

export type ComfyUiDnsLookup = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export interface ComfyUiNativeClientOptions {
  /** Native ComfyUI root, e.g. http://127.0.0.1:8188 (an internal instance). */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxJsonBytes?: number;
  /** Loopback HTTP is allowed by default because native ComfyUI is usually local. */
  allowLoopbackHttp?: boolean;
  /** Explicit opt-in to non-loopback private ComfyUI hosts inside the trusted main process. */
  allowIntranetHosts?: boolean;
  lookup?: ComfyUiDnsLookup;
}

export interface ComfyUiConnectionReport {
  reachable: true;
  baseUrl: string;
  comfyuiVersion: string;
  jobsApi: boolean;
  features: string[];
}

export interface ComfyUiNodeDefinition {
  classType: string;
  input: {
    required?: Record<string, unknown>;
    optional?: Record<string, unknown>;
  };
  output?: unknown[];
  outputName?: unknown[];
  description?: string;
}

export class ComfyUiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ComfyUiError';
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MAX_JSON = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT = 120_000;
const NODE_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;

function invalid(message: string): never {
  throw new ComfyUiError(400, 'COMFYUI_BASE_URL_INVALID', message);
}

function upstream(message: string, status = 502, code = 'COMFYUI_UPSTREAM_UNAVAILABLE'): never {
  throw new ComfyUiError(status, code, message);
}

export function isPrivateAddress(address: string): boolean {
  const value = address.trim();
  if (isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || a === 255;
  }
  if (isIP(value) === 6) {
    const normalized = value.toLowerCase();
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice('::ffff:'.length);
      return isIP(mapped) === 4 ? isPrivateAddress(mapped) : true;
    }
    return normalized === '::1' || normalized === '::'
      || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')
      || normalized.startsWith('ff');
  }
  return true;
}

export async function resolveComfyUiBaseUrl(input: string, options: Pick<ComfyUiNativeClientOptions,
  'allowLoopbackHttp' | 'allowIntranetHosts' | 'lookup'> = {}): Promise<string> {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048) invalid('ComfyUI 地址不能为空且不能超过 2048 字符。');
  let url: URL;
  try { url = new URL(input.trim()); } catch { invalid('ComfyUI 地址不是有效 URL。'); }
  if (url.username || url.password) invalid('ComfyUI 地址不能包含凭据。');
  if (url.search || url.hash) invalid('ComfyUI 地址不能包含查询参数或片段。');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') invalid('ComfyUI 地址只支持 http/https。');
  const hostname = url.hostname.toLowerCase();
  const loopback = LOOPBACK.has(hostname);
  if (url.protocol === 'http:' && !loopback && !options.allowIntranetHosts) {
    invalid('非本机 ComfyUI 只允许 HTTPS；如确属受信内网实例，需显式启用 allowIntranetHosts。');
  }
  if (loopback && url.protocol === 'http:' && options.allowLoopbackHttp === false) {
    invalid('当前配置禁止本机 HTTP ComfyUI。');
  }
  if (!loopback) {
    const lookup = options.lookup ?? (async (host: string) => dnsLookup(host, { all: true }));
    let addresses: ReadonlyArray<{ address: string; family: number }>;
    try { addresses = await lookup(hostname); }
    catch { throw new ComfyUiError(502, 'COMFYUI_HOST_UNRESOLVED', '无法解析 ComfyUI 主机。'); }
    if (!addresses.length) throw new ComfyUiError(502, 'COMFYUI_HOST_UNRESOLVED', 'ComfyUI 主机没有可用地址。');
    if (addresses.some(item => isPrivateAddress(item.address)) && !options.allowIntranetHosts) {
      invalid('ComfyUI 主机解析到内网地址；如确属受信实例，需显式启用 allowIntranetHosts。');
    }
    // Link-local / metadata addresses never become a valid ComfyUI target.
    if (addresses.some(item => /^169\.254\./u.test(item.address))) {
      invalid('ComfyUI 主机解析到链路本地地址，禁止访问。');
    }
  }
  const pathname = url.pathname.replace(/\/+$/u, '');
  return `${url.protocol}//${url.host}${pathname}`;
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        upstream(`ComfyUI JSON 响应超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 限制。`, 502, 'COMFYUI_RESPONSE_TOO_LARGE');
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof ComfyUiError) throw error;
    upstream('无法完整读取 ComfyUI 响应。');
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length).toString('utf8');
}

async function readJson(response: Response, maxBytes = MAX_JSON): Promise<unknown> {
  const text = await boundedText(response, maxBytes);
  try { return JSON.parse(text); }
  catch { upstream('ComfyUI 没有返回有效 JSON。', 502, 'COMFYUI_RESPONSE_INVALID'); }
}

export class ComfyUiNativeClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxJsonBytes: number;
  private readonly options: ComfyUiNativeClientOptions;
  private resolvedBaseUrl: string | null = null;

  constructor(options: ComfyUiNativeClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    this.maxJsonBytes = options.maxJsonBytes ?? MAX_JSON;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 600_000) {
      invalid('ComfyUI 超时必须在 1s–10min 之间。');
    }
    if (!Number.isSafeInteger(this.maxJsonBytes) || this.maxJsonBytes < 1024 || this.maxJsonBytes > 64 * 1024 * 1024) {
      invalid('ComfyUI 响应上限必须在 1 KiB–64 MiB 之间。');
    }
  }

  async resolveBaseUrl(): Promise<string> {
    if (!this.resolvedBaseUrl) this.resolvedBaseUrl = await resolveComfyUiBaseUrl(this.options.baseUrl, this.options);
    return this.resolvedBaseUrl;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const base = await this.resolveBaseUrl();
    const url = `${base}${path}`;
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        method: init.method ?? 'GET',
        redirect: 'error', signal,
        headers: { accept: 'application/json', ...(init.headers ?? {}) },
      });
      return response;
    } catch (error) {
      if (signal.aborted) upstream('等待 ComfyUI 超时；未自动重试。', 504, 'COMFYUI_UPSTREAM_TIMEOUT');
      upstream('无法连接 ComfyUI；未自动重试。');
    }
  }

  private async json(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.request(path, init);
    if (!response.ok) {
      await response.body?.cancel();
      upstream(`ComfyUI 返回 HTTP ${response.status}。`, response.status >= 400 && response.status < 500 ? response.status : 502, 'COMFYUI_UPSTREAM_ERROR');
    }
    return readJson(response, this.maxJsonBytes);
  }

  async testConnection(): Promise<ComfyUiConnectionReport> {
    let stats: unknown;
    try { stats = await this.json('/system_stats'); }
    catch (error) {
      if (error instanceof ComfyUiError && error.code === 'COMFYUI_UPSTREAM_TIMEOUT') throw error;
      throw new ComfyUiError(502, 'COMFYUI_UNREACHABLE', '无法读取 ComfyUI /system_stats；未调用生成。');
    }
    const comfyuiVersion = versionFromStats(stats);
    if (!comfyuiVersion) {
      throw new ComfyUiError(502, 'COMFYUI_VERSION_MISSING', 'ComfyUI /system_stats 缺少 system.comfyui_version。');
    }
    let features: string[] = [];
    try {
      const raw = await this.json('/features');
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        features = Object.entries(raw as Record<string, unknown>).filter(([, value]) => value === true)
          .map(([key]) => key).filter(key => /^[A-Za-z0-9_.-]{1,80}$/u.test(key)).slice(0, 100);
      }
    } catch { /* /features is optional across ComfyUI versions. */ }
    let jobsApi = false;
    try {
      const response = await this.request(`/api/jobs/${randomUUID()}`);
      if (response.ok) { await response.body?.cancel(); jobsApi = true; }
      else if (response.status === 404) {
        const body = await readJson(response);
        jobsApi = Boolean(body && typeof body === 'object' && !Array.isArray(body)
          && (body as Record<string, unknown>).error === 'Job not found');
      } else await response.body?.cancel();
    } catch { /* Jobs API is an optional capability probe. */ }
    return { reachable: true, baseUrl: await this.resolveBaseUrl(), comfyuiVersion, jobsApi, features };
  }

  async getNodeInfo(classType: string): Promise<ComfyUiNodeDefinition> {
    if (typeof classType !== 'string' || !NODE_CLASS.test(classType)) {
      throw new ComfyUiError(400, 'COMFYUI_CLASS_INVALID', 'ComfyUI 节点 class_type 无效。');
    }
    let raw: unknown;
    try { raw = await this.json(`/object_info/${encodeURIComponent(classType)}`); }
    catch (error) {
      if (error instanceof ComfyUiError && error.status === 400) throw error;
      throw new ComfyUiError(502, 'COMFYUI_OBJECT_INFO_UNAVAILABLE',
        `无法读取 ComfyUI 节点 ${classType} 的 object_info；未调用生成。`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ComfyUiError(502, 'COMFYUI_OBJECT_INFO_INVALID', 'ComfyUI object_info 响应格式无效。');
    }
    const definition = (raw as Record<string, unknown>)[classType];
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new ComfyUiError(404, 'COMFYUI_NODE_NOT_FOUND', `ComfyUI 未注册节点 ${classType}。`);
    }
    const record = definition as Record<string, unknown>;
    const input = record.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ComfyUiError(502, 'COMFYUI_OBJECT_INFO_INVALID', `ComfyUI 节点 ${classType} 缺少 input 定义。`);
    }
    const inputRecord = input as Record<string, unknown>;
    const required = inputRecord.required && typeof inputRecord.required === 'object' && !Array.isArray(inputRecord.required)
      ? inputRecord.required as Record<string, unknown> : {};
    const optional = inputRecord.optional && typeof inputRecord.optional === 'object' && !Array.isArray(inputRecord.optional)
      ? inputRecord.optional as Record<string, unknown> : {};
    return {
      classType,
      input: { required, optional },
      ...(Array.isArray(record.output) ? { output: record.output } : {}),
      ...(Array.isArray(record.output_name) ? { outputName: record.output_name } : {}),
      ...(typeof record.description === 'string' ? { description: record.description.slice(0, 500) } : {}),
    };
  }
  async submitPrompt(workflow: unknown, clientId: string): Promise<{ promptId: string; number: number; nodeErrors: string[] }> {
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/u.test(clientId)) {
      throw new ComfyUiError(400, 'COMFYUI_CLIENT_ID_INVALID', 'ComfyUI client_id 无效。');
    }
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
      throw new ComfyUiError(400, 'COMFYUI_WORKFLOW_INVALID', 'ComfyUI 工作流必须是 API 格式对象。');
    }
    let raw: unknown;
    try {
      raw = await this.json('/prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
      });
    } catch (error) {
      if (error instanceof ComfyUiError) throw error;
      throw new ComfyUiError(502, 'COMFYUI_SUBMIT_UNCERTAIN', 'ComfyUI 提交结果不明；不会自动重发。');
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ComfyUiError(502, 'COMFYUI_SUBMIT_INVALID', 'ComfyUI /prompt 没有返回有效响应。');
    }
    const record = raw as Record<string, unknown>;
    const promptId = record.prompt_id;
    if (typeof promptId !== 'string' || !/^[A-Za-z0-9-]{8,100}$/u.test(promptId)) {
      throw new ComfyUiError(502, 'COMFYUI_SUBMIT_INVALID', 'ComfyUI 没有返回有效的 prompt_id。');
    }
    const nodeErrors = isNodeErrors(record.node_errors) ? Object.keys(record.node_errors as Record<string, unknown>).slice(0, 100) : [];
    return { promptId, number: typeof record.number === 'number' && Number.isInteger(record.number) ? record.number : 0, nodeErrors };
  }

  /** History is query-only; callers must never resubmit after a query failure. */
  async getHistory(promptId: string): Promise<Record<string, unknown>> {
    if (typeof promptId !== 'string' || !/^[A-Za-z0-9-]{8,100}$/u.test(promptId)) {
      throw new ComfyUiError(400, 'COMFYUI_PROMPT_ID_INVALID', 'ComfyUI prompt_id 无效。');
    }
    const raw = await this.json(`/history/${encodeURIComponent(promptId)}`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ComfyUiError(502, 'COMFYUI_HISTORY_INVALID', 'ComfyUI /history 响应格式无效。');
    }
    return raw as Record<string, unknown>;
  }
}

function isNodeErrors(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length > 0;
}

function versionFromStats(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const system = (raw as Record<string, unknown>).system;
  if (!system || typeof system !== 'object' || Array.isArray(system)) return null;
  const value = (system as Record<string, unknown>).comfyui_version;
  return typeof value === 'string' && value.length <= 80 && /^[0-9A-Za-z.+_-]+$/u.test(value) ? value : null;
}
