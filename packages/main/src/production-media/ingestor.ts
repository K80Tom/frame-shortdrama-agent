import { lookup } from 'node:dns/promises';
import { request, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { ProductionMediaError, type LocalVideoObject } from './contracts';
import type { ProductionMediaStore } from './store';

export interface ResolvedAddress { address: string; family: 4 | 6 }
export interface MediaDnsResolver { resolve(hostname: string): Promise<ResolvedAddress[]> }

export interface MediaFetchOptions {
  addresses: readonly ResolvedAddress[];
  timeoutMs: number;
  maxBytes: number;
}

export interface MediaFetchResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: Buffer;
}

export interface PinnedMediaFetcher {
  /** Fetches exactly one URL. Implementations must not follow redirects. */
  fetch(url: URL, options: MediaFetchOptions): Promise<MediaFetchResponse>;
}

export class SystemMediaDnsResolver implements MediaDnsResolver {
  async resolve(hostname: string): Promise<ResolvedAddress[]> {
    try {
      const values = await lookup(hostname, { all: true, verbatim: true });
      return values.map(value => ({ address: value.address, family: value.family as 4 | 6 }));
    } catch {
      throw new ProductionMediaError(502, 'REMOTE_MEDIA_DNS_FAILED', '远程视频域名无法安全解析。');
    }
  }
}

export type HttpsRequest = (url: URL, options: RequestOptions,
  onResponse: (response: IncomingMessage) => void) => ClientRequest;

/** HTTPS fetcher whose socket lookup is pinned to an address already approved by policy. */
export class PinnedHttpsMediaFetcher implements PinnedMediaFetcher {
  constructor(private readonly httpsRequest: HttpsRequest = (url, options, onResponse) =>
    request(url, options, onResponse)) {}

  fetch(url: URL, options: MediaFetchOptions): Promise<MediaFetchResponse> {
    const target = options.addresses[0];
    if (!target || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1
      || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new ProductionMediaError(500, 'REMOTE_MEDIA_FETCH_CONFIG_INVALID', '远程媒体下载配置无效。');
    }
    return new Promise((resolve, reject) => {
      let requestHandle: ClientRequest;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (error?: ProductionMediaError, response?: MediaFetchResponse) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve(response!);
      };
      try {
        requestHandle = this.httpsRequest(url, {
          method: 'GET', agent: false,
          headers: { accept: 'video/mp4', 'user-agent': 'Lyra-local-media/1' },
          // Pin the TLS socket to the checked address. The URL hostname remains
          // unchanged, so certificate validation and SNI still use the provider host.
          // The all-form array is used because the classic (err, address, family)
          // callback shape breaks with ERR_INVALID_IP_ADDRESS on Node 22 whenever
          // the request options do not pin an address family.
          lookup: (_hostname, _options, callback) => callback(null, [{ address: target.address, family: target.family }]),
        }, response => {
          const status = response.statusCode;
          const headers = normalizeHeaders(response);
          if (!Number.isSafeInteger(status)) {
            response.destroy();
            finish(new ProductionMediaError(502, 'REMOTE_MEDIA_FETCH_FAILED', '远程视频服务返回了无效响应。'));
            return;
          }
          if (status !== 200) {
            response.destroy();
            finish(undefined, { status: status!, headers, body: Buffer.alloc(0) });
            return;
          }
          const declared = parseContentLength(headers['content-length']);
          if (declared !== null && declared > options.maxBytes) {
            response.destroy();
            finish(new ProductionMediaError(413, 'REMOTE_MEDIA_TOO_LARGE', '远程视频超过本地下载大小限制。'));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          response.on('data', (chunk: Buffer | string) => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += bytes.length;
            if (total > options.maxBytes) {
              response.destroy();
              finish(new ProductionMediaError(413, 'REMOTE_MEDIA_TOO_LARGE', '远程视频超过本地下载大小限制。'));
              return;
            }
            chunks.push(Buffer.from(bytes));
          });
          response.once('aborted', () => finish(new ProductionMediaError(502, 'REMOTE_MEDIA_FETCH_FAILED', '远程视频下载中断。')));
          response.once('error', () => finish(new ProductionMediaError(502, 'REMOTE_MEDIA_FETCH_FAILED', '远程视频下载失败。')));
          response.once('end', () => finish(undefined, { status: status!, headers, body: Buffer.concat(chunks) }));
        });
      } catch {
        finish(new ProductionMediaError(502, 'REMOTE_MEDIA_FETCH_FAILED', '远程视频下载无法启动。'));
        return;
      }
      requestHandle.once('error', error => finish(error instanceof ProductionMediaError ? error
        : new ProductionMediaError(502, 'REMOTE_MEDIA_FETCH_FAILED', '远程视频下载失败。')));
      timer = setTimeout(() => {
        finish(new ProductionMediaError(504, 'REMOTE_MEDIA_FETCH_TIMEOUT', '远程视频下载超时。'));
        requestHandle.destroy();
      }, options.timeoutMs);
      timer.unref();
      requestHandle.end();
    });
  }
}

export interface ProductionMediaIngestorOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxDnsAddresses?: number;
  /**
   * Opt-in for vendor video CDNs that only resolve inside the corporate network.
   * When enabled, private-range addresses are accepted for provider-returned URLs;
   * loopback, link-local and local hostnames remain blocked and the fetch stays
   * pinned to the resolved address with full TLS hostname verification.
   */
  allowIntranetMediaSources?: boolean;
}

/** Downloads a provider result into verified local storage; the URL itself is never a deliverable. */
export class ProductionMediaIngestor {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxDnsAddresses: number;
  private readonly allowIntranetMediaSources: boolean;

  constructor(private readonly store: ProductionMediaStore,
    private readonly resolver: MediaDnsResolver = new SystemMediaDnsResolver(),
    private readonly fetcher: PinnedMediaFetcher = new PinnedHttpsMediaFetcher(),
    options: ProductionMediaIngestorOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxBytes = options.maxBytes ?? store.limits.maxBytes;
    this.maxDnsAddresses = options.maxDnsAddresses ?? 16;
    this.allowIntranetMediaSources = options.allowIntranetMediaSources ?? false;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1
      || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > store.limits.maxBytes
      || !Number.isSafeInteger(this.maxDnsAddresses) || this.maxDnsAddresses < 1 || this.maxDnsAddresses > 64
      || typeof this.allowIntranetMediaSources !== 'boolean') {
      throw new ProductionMediaError(500, 'REMOTE_MEDIA_INGEST_CONFIG_INVALID', '远程媒体入库配置无效。');
    }
  }

  async ingestProviderUrl(value: unknown): Promise<LocalVideoObject> {
    const url = parseProviderUrl(value);
    const addresses = await this.resolveAndValidate(url.hostname);
    let response: MediaFetchResponse;
    try {
      response = await this.fetcher.fetch(url, { addresses, timeoutMs: this.timeoutMs, maxBytes: this.maxBytes });
    } catch (error) {
      if (error instanceof ProductionMediaError) throw error;
      throw new ProductionMediaError(502, 'REMOTE_MEDIA_FETCH_FAILED', '远程视频下载失败。');
    }
    if (!response || !Number.isSafeInteger(response.status) || !response.headers || !Buffer.isBuffer(response.body)) {
      throw new ProductionMediaError(502, 'REMOTE_MEDIA_FETCH_FAILED', '远程视频服务返回了无效响应。');
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ProductionMediaError(409, 'REMOTE_MEDIA_REDIRECT_FORBIDDEN', '远程视频下载不允许重定向，需重新校验目标地址。');
    }
    if (response.status !== 200) {
      throw new ProductionMediaError(502, 'REMOTE_MEDIA_FETCH_FAILED', '远程视频服务未返回可入库的视频。');
    }
    const contentType = response.headers['content-type'];
    if (typeof contentType !== 'string' || contentType.split(';', 1)[0]!.trim().toLowerCase() !== 'video/mp4') {
      throw new ProductionMediaError(415, 'REMOTE_MEDIA_CONTENT_TYPE_INVALID', '远程响应不是 video/mp4，不能登记为视频。');
    }
    const encoding = response.headers['content-encoding'];
    if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') {
      throw new ProductionMediaError(415, 'REMOTE_MEDIA_ENCODING_INVALID', '远程视频不接受压缩传输编码。');
    }
    const declared = parseContentLength(response.headers['content-length']);
    if (response.headers['content-length'] !== undefined && declared === null) {
      throw new ProductionMediaError(502, 'REMOTE_MEDIA_LENGTH_INVALID', '远程视频长度标头无效。');
    }
    if (response.body.length < 1 || response.body.length > this.maxBytes || (declared !== null && declared !== response.body.length)) {
      throw new ProductionMediaError(413, 'REMOTE_MEDIA_SIZE_INVALID', '远程视频为空、过大或长度与响应标头不一致。');
    }
    return this.store.putVideoBuffer(response.body, 'providerDownload');
  }

  private async resolveAndValidate(hostnameValue: string): Promise<ResolvedAddress[]> {
    const hostname = stripIpv6Brackets(hostnameValue).toLowerCase();
    if (isLocalHostname(hostname)) {
      throw new ProductionMediaError(403, 'REMOTE_MEDIA_ADDRESS_FORBIDDEN', '远程视频地址指向本机或保留网络。');
    }
    const literalFamily = isIP(hostname);
    let addresses: ResolvedAddress[];
    if (literalFamily) addresses = [{ address: hostname, family: literalFamily as 4 | 6 }];
    else {
      try { addresses = await this.resolver.resolve(hostname); }
      catch (error) {
        if (error instanceof ProductionMediaError) throw error;
        throw new ProductionMediaError(502, 'REMOTE_MEDIA_DNS_FAILED', '远程视频域名无法安全解析。');
      }
    }
    if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > this.maxDnsAddresses) {
      throw new ProductionMediaError(502, 'REMOTE_MEDIA_DNS_INVALID', '远程视频域名没有返回可验证的地址。');
    }
    const unique = new Map<string, ResolvedAddress>();
    for (const value of addresses) {
      const family = value && typeof value.address === 'string' ? isIP(value.address) : 0;
      const addressAllowed = (family === 4 || family === 6) && value.family === family && (this.allowIntranetMediaSources
        ? isNonLocalIntranetAddress(value.address, family)
        : isPublicInternetAddress(value.address));
      if (!addressAllowed) {
        throw new ProductionMediaError(403, 'REMOTE_MEDIA_ADDRESS_FORBIDDEN', '远程视频地址指向私网、本机或保留网络。');
      }
      unique.set(`${family}:${value.address.toLowerCase()}`, { address: value.address, family });
    }
    return [...unique.values()];
  }
}

/** Intranet mode: accept private ranges but never loopback, unspecified or link-local targets. */
function isNonLocalIntranetAddress(address: string, family: number): boolean {
  if (family === 4) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b] = parts as [number, number, number, number];
    return !(a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254));
  }
  if (family !== 6) return false;
  const value = ipv6ToBigInt(address);
  if (value === null) return false;
  // IPv4-mapped IPv6 must obey the same local-target rules as plain IPv4.
  if (matchesPrefix(value, ipv6ToBigInt('::ffff:0:0')!, 96)) {
    const bytes = [24n, 16n, 8n, 0n].map(shift => Number((value >> shift) & 255n));
    return isNonLocalIntranetAddress(bytes.join('.'), 4);
  }
  // Deprecated IPv4-compatible and multicast addresses are not CDN unicast targets.
  if (matchesPrefix(value, 0n, 96) || matchesPrefix(value, ipv6ToBigInt('ff00::')!, 8)) return false;
  const unspecified = value === 0n;
  const loopback = value === 1n;
  const linkLocal = matchesPrefix(value, ipv6ToBigInt('fe80::')!, 10);
  return !unspecified && !loopback && !linkLocal;
}

/** Project media-source filter; deliberately stricter than global routability. */
export function isPublicInternetAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b, c] = parts as [number, number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes('%')) return false;
  const value = ipv6ToBigInt(address);
  if (value === null || !matchesPrefix(value, ipv6ToBigInt('2000::')!, 3)) return false;
  // A conservative media-CDN policy, not an IANA routability oracle. Exclude
  // IETF protocol assignments (including unassigned holes and special anycast/
  // overlay identifiers) rather than treating the gaps as ordinary CDN hosts.
  return !matchesPrefix(value, ipv6ToBigInt('2001::')!, 23)
    && !matchesPrefix(value, ipv6ToBigInt('2001:db8::')!, 32)
    && !matchesPrefix(value, ipv6ToBigInt('3fff::')!, 20)
    && !matchesPrefix(value, ipv6ToBigInt('2002::')!, 16);
}

function parseProviderUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || value !== value.trim()
    || !/^https:\/\//iu.test(value) || /[\u0000-\u001f\u007f\\]/u.test(value)) {
    throw new ProductionMediaError(400, 'REMOTE_MEDIA_URL_INVALID', '远程视频地址必须是规范的 HTTPS URL。');
  }
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ProductionMediaError(400, 'REMOTE_MEDIA_URL_INVALID', '远程视频地址必须是规范的 HTTPS URL。'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || (url.port && url.port !== '443')) {
    throw new ProductionMediaError(400, 'REMOTE_MEDIA_URL_INVALID', '远程视频地址必须使用 HTTPS 443 且不能包含账号信息。');
  }
  return url;
}

function normalizeHeaders(response: IncomingMessage): Readonly<Record<string, string | undefined>> {
  const read = (name: string): string | undefined => {
    const value = response.headers[name];
    return typeof value === 'string' ? value : undefined;
  };
  return Object.freeze({
    'content-type': read('content-type'), 'content-length': read('content-length'),
    'content-encoding': read('content-encoding'),
  });
}

function parseContentLength(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : null;
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname.endsWith('.internal') || hostname.endsWith('.home.arpa') || hostname.endsWith('.invalid')
    || hostname.endsWith('.test');
}

function matchesPrefix(value: bigint, base: bigint, bits: number): boolean {
  const shift = 128n - BigInt(bits);
  return value >> shift === base >> shift;
}

function ipv6ToBigInt(input: string): bigint | null {
  let address = input.toLowerCase();
  if (address.includes('%')) return null;
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!isIP(tail) || isIP(tail) !== 4) return null;
    const bytes = tail.split('.').map(Number);
    address = `${address.slice(0, lastColon)}:${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`;
  }
  if ((address.match(/::/gu) ?? []).length > 1) return null;
  const compressed = address.includes('::');
  const [leftText, rightText = ''] = address.split('::');
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  if ([...left, ...right].some(part => !/^[0-9a-f]{1,4}$/u.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((!compressed && missing !== 0) || (compressed && missing < 1)) return null;
  const parts = [...left, ...Array(missing).fill('0'), ...right];
  if (parts.length !== 8) return null;
  return parts.reduce((result, part) => (result << 16n) | BigInt(`0x${part}`), 0n);
}
