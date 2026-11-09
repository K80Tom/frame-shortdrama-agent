import { isIP } from 'node:net';
import { AgentContractError } from '@lyra/shared';

/**
 * MCP 出站地址准入。
 *
 * 远端 MCP 地址由用户配置，属于不可信输入：必须防 SSRF（含 DNS 解析后地址、
 * IPv4-mapped IPv6、重定向）、禁止 URL 用户凭据、禁止在查询参数里塞长期密钥。
 * DNS 解析通过端口注入，agent 自身不发起网络请求。
 */

export type ResolveHost = (hostname: string) => Promise<string[]>;

export interface EndpointPolicy {
  /** 允许的出站 Host；必须显式声明，空数组表示不允许任何地址。 */
  allowedHosts: string[];
  /** 允许的端口；默认只允许 443，显式配置 http 时允许 80。 */
  allowedPorts?: number[];
  /** 是否允许明文 HTTP；默认 false，仅本地开发可显式打开。 */
  allowHttp?: boolean;
  /** DNS 解析器；测试或 main 注入。 */
  resolveHost?: ResolveHost;
  /** 允许的最大重定向次数；默认 3。 */
  maxRedirects?: number;
}

export interface GuardedEndpoint {
  url: URL;
  hostname: string;
  addresses: string[];
}

const SENSITIVE_QUERY_NAMES = new Set([
  'api_key', 'apikey', 'api-key', 'token', 'access_token', 'auth', 'authorization',
  'key', 'secret', 'client_secret', 'password', 'passwd', 'sig', 'signature',
]);

const PRIVATE_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', '127.0.0.1', '::1', '0.0.0.0']);

export async function assertMcpEndpoint(raw: string, policy: EndpointPolicy): Promise<GuardedEndpoint> {
  if (policy.allowedHosts.length === 0) {
    throw new AgentContractError(400, 'MCP_HOST_NOT_ALLOWED', 'MCP 地址必须配置明确的出站 Host 白名单。');
  }
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new AgentContractError(400, 'MCP_URL_INVALID', '无法解析 MCP 地址。'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AgentContractError(400, 'MCP_URL_INVALID', 'MCP 地址必须是 HTTP(S) URL。');
  }
  if (url.protocol === 'http:' && policy.allowHttp !== true) {
    throw new AgentContractError(400, 'MCP_PLAINTEXT_FORBIDDEN', 'MCP 默认只允许 HTTPS；明文 HTTP 需要显式开启。');
  }
  if (url.username || url.password) {
    throw new AgentContractError(400, 'MCP_URL_CREDENTIALS_FORBIDDEN', 'MCP 地址不能包含 URL 用户凭据。');
  }
  if (url.hash) throw new AgentContractError(400, 'MCP_URL_INVALID', 'MCP 地址不能包含 Fragment。');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (PRIVATE_HOSTNAMES.has(hostname)) {
    throw new AgentContractError(400, 'MCP_ADDRESS_FORBIDDEN', 'MCP 地址不能指向本机或内网地址。');
  }
  if (!hostAllowed(hostname, policy.allowedHosts)) {
    throw new AgentContractError(400, 'MCP_HOST_NOT_ALLOWED', `MCP 出站 Host 不在白名单内：${hostname}。`);
  }
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  const allowedPorts = policy.allowedPorts ?? (url.protocol === 'https:' ? [443] : [80]);
  if (!allowedPorts.includes(port)) {
    throw new AgentContractError(400, 'MCP_PORT_NOT_ALLOWED', `MCP 出站端口不在白名单内：${port}。`);
  }
  for (const [name] of url.searchParams) {
    if (SENSITIVE_QUERY_NAMES.has(name.toLowerCase())) {
      throw new AgentContractError(400, 'MCP_URL_SECRET_IN_QUERY', `MCP 地址不能在查询参数中携带长期密钥：${name}。`);
    }
  }

  let addresses: string[];
  if (isIP(hostname) !== 0) {
    addresses = [hostname];
  } else {
    const resolver = policy.resolveHost;
    if (!resolver) throw new AgentContractError(503, 'MCP_DNS_UNAVAILABLE', 'MCP 地址需要 DNS 校验，但当前环境未注入解析器。');
    try { addresses = await resolver(hostname); }
    catch { throw new AgentContractError(400, 'MCP_DNS_FAILED', `无法解析 MCP 地址：${hostname}。`); }
    if (addresses.length === 0) throw new AgentContractError(400, 'MCP_DNS_FAILED', `MCP 地址没有可用解析结果：${hostname}。`);
  }
  const forbidden = addresses.filter(address => isForbiddenAddress(address));
  if (forbidden.length > 0) {
    throw new AgentContractError(400, 'MCP_ADDRESS_FORBIDDEN', 'MCP 地址解析到本机或内网地址，已拒绝。');
  }
  return { url, hostname, addresses };
}

/** 解析重定向目标：每次跳转都重新过白名单与私网检查，不继承原凭据。 */
export async function assertMcpRedirect(raw: string, policy: EndpointPolicy, originalHost: string): Promise<GuardedEndpoint> {
  const endpoint = await assertMcpEndpoint(raw, policy);
  if (endpoint.hostname !== originalHost.toLowerCase()) {
    // 跨 Host 跳转只允许已显式列入白名单的地址，且调用方必须丢弃鉴权头。
    if (!hostAllowed(endpoint.hostname, policy.allowedHosts)) {
      throw new AgentContractError(400, 'MCP_REDIRECT_HOST_NOT_ALLOWED', 'MCP 重定向目标不在白名单内。');
    }
  }
  return endpoint;
}

export function isForbiddenAddress(address: string): boolean {
  const trimmed = address.trim().toLowerCase();
  if (isIP(trimmed) === 6) return isForbiddenIpv6(trimmed);
  if (isIP(trimmed) === 4) return isForbiddenIpv4(trimmed);
  // 无法识别的地址一律按禁止处理，避免解析器返回异常格式时绕过。
  return true;
}

export function isForbiddenIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [first, second, third] = parts as [number, number, number, number];
  if (first === 0 || first === 127) return true;
  if (first === 10) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 100 && second >= 64 && second <= 127) return true; // CGNAT
  if (first === 192 && second === 0 && (third === 0 || third === 2)) return true;
  if (first === 198 && (second === 18 || second === 19)) return true;
  if (first === 198 && second === 51 && third === 100) return true;
  if (first === 203 && second === 0 && third === 113) return true;
  if (first >= 224) return true; // 组播/保留
  return false;
}

function isForbiddenIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  // IPv4-mapped (::ffff:127.0.0.1) 与 IPv4-compatible (::127.0.0.1) 统一拆出 IPv4 再判定。
  const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(normalized);
  if (mapped) return isForbiddenIpv4(mapped[1]!);
  const groups = normalized.replace(/^::/, '').split(':').filter(Boolean);
  const first = parseInt(groups[0] ?? '0', 16);
  if (Number.isNaN(first)) return true;
  if (first >= 0xfc00 && first <= 0xfdff) return true; // unique local
  if (first >= 0xfe80 && first <= 0xfebf) return true; // link local
  if (first >= 0xff00 && first <= 0xffff) return true; // multicast
  if (first >= 0xfec0 && first <= 0xfeff) return true; // site local (deprecated)
  return false;
}

function hostAllowed(hostname: string, allowed: string[]): boolean {
  for (const entry of allowed) {
    const rule = entry.trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!rule) continue;
    if (rule === hostname) return true;
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(1); // .example.com
      if (hostname.endsWith(suffix) && hostname.length > suffix.length) return true;
    }
  }
  return false;
}

/** 安全跟随重定向的最小 fetch 形状；由 main 注入真实实现。 */
export interface McpHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type McpFetch = (
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
) => Promise<McpHttpResponse>;

export interface SafeFetchOptions {
  policy: EndpointPolicy;
  maxResponseBytes: number;
  headers: Record<string, string>;
  body?: string;
  method?: 'GET' | 'POST';
}

export async function safeMcpFetch(fetchPort: McpFetch, rawUrl: string, options: SafeFetchOptions): Promise<McpHttpResponse> {
  let endpoint = await assertMcpEndpoint(rawUrl, options.policy);
  let method = options.method ?? 'POST';
  let headers = { ...options.headers };
  let body = options.body;
  const maxRedirects = options.policy.maxRedirects ?? 3;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await fetchPort(endpoint.url.toString(), { method, headers, ...(body === undefined ? {} : { body }) });
    if (response.body.length > options.maxResponseBytes) {
      throw new AgentContractError(413, 'MCP_RESPONSE_TOO_LARGE', 'MCP 响应超过允许的大小。');
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.location ?? response.headers.Location;
    if (!location) throw new AgentContractError(502, 'MCP_REDIRECT_INVALID', 'MCP 重定向缺少 Location。');
    const next = await assertMcpRedirect(new URL(location, endpoint.url).toString(), options.policy, endpoint.hostname);
    if (next.hostname !== endpoint.hostname) {
      // 跨 Host 跳转绝不转发鉴权头。
      headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !/authorization|cookie|x-api-key/i.test(name)));
    }
    if (response.status === 303) { method = 'GET'; body = undefined; }
    endpoint = next;
  }
  throw new AgentContractError(502, 'MCP_TOO_MANY_REDIRECTS', 'MCP 重定向次数超过限制。');
}
