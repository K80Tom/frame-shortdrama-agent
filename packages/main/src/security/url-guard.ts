import { isIP } from 'node:net';

export class SecurityGuardError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'SecurityGuardError';
  }
}

export interface UrlGuardOptions {
  allowIntranet?: boolean;
  allowedProtocols?: readonly string[];
  allowedPorts?: readonly number[];
}

export function parseAndValidateSafeUrl(value: unknown, options: UrlGuardOptions = {}): URL {
  const allowedProtocols = options.allowedProtocols ?? ['https:'];
  const allowedPorts = options.allowedPorts ?? [443];

  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f\\]/u.test(value)) {
    throw new SecurityGuardError(400, 'SECURITY_URL_INVALID', 'URL 格式无效或包含非法控制字符。');
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new SecurityGuardError(400, 'SECURITY_URL_INVALID', '无法解析目标 URL。');
  }

  if (!allowedProtocols.includes(url.protocol.toLowerCase())) {
    throw new SecurityGuardError(403, 'SECURITY_PROTOCOL_FORBIDDEN', `协议 ${url.protocol} 不被允许，仅支持安全协议：${allowedProtocols.join(', ')}。`);
  }

  if (url.username || url.password) {
    throw new SecurityGuardError(400, 'SECURITY_URL_CREDENTIALS_FORBIDDEN', 'URL 不得包含明文认证凭据（用户名或密码）。');
  }

  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (!allowedPorts.includes(port)) {
    throw new SecurityGuardError(403, 'SECURITY_PORT_FORBIDDEN', `目标端口 ${port} 受限，仅允许安全端口：${allowedPorts.join(', ')}。`);
  }

  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
  if (isLocalHostname(hostname)) {
    throw new SecurityGuardError(403, 'SECURITY_ADDRESS_FORBIDDEN', '目标主机名指向本机或受保护的本地保留域。');
  }

  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    const isAllowed = options.allowIntranet
      ? isNonLocalIntranetAddress(hostname, literalFamily)
      : isPublicInternetAddress(hostname);
    if (!isAllowed) {
      throw new SecurityGuardError(403, 'SECURITY_ADDRESS_FORBIDDEN', '目标 IP 指向私网、回环或受保护网络。');
    }
  }

  return url;
}

export function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost'
    || h.endsWith('.localhost')
    || h.endsWith('.local')
    || h.endsWith('.internal')
    || h.endsWith('.home.arpa')
    || h.endsWith('.invalid')
    || h.endsWith('.test')
    || h.endsWith('.lan');
}

export function isPublicInternetAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b, c] = parts as [number, number, number, number];
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) // CGNAT
      || (a === 169 && b === 254)           // Link-local / Cloud metadata
      || (a === 172 && b >= 16 && b <= 31)  // RFC1918 Class B
      || (a === 192 && b === 168)           // RFC1918 Class C
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6 || address.includes('%')) return false;
  const value = ipv6ToBigInt(address);
  if (value === null || !matchesPrefix(value, ipv6ToBigInt('2000::')!, 3)) return false;
  return !matchesPrefix(value, ipv6ToBigInt('2001::')!, 32)
    && !matchesPrefix(value, ipv6ToBigInt('2001:10::')!, 28)
    && !matchesPrefix(value, ipv6ToBigInt('2001:20::')!, 28)
    && !matchesPrefix(value, ipv6ToBigInt('2001:db8::')!, 32)
    && !matchesPrefix(value, ipv6ToBigInt('2002::')!, 16);
}

export function isNonLocalIntranetAddress(address: string, family: number): boolean {
  if (family === 4) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b] = parts as [number, number, number, number];
    return !(a === 0 || a === 127 || (a === 169 && b === 254));
  }
  if (family !== 6) return false;
  const value = ipv6ToBigInt(address);
  if (value === null) return false;
  const unspecified = value === 0n;
  const loopback = value === 1n;
  const ipv4MappedLoopback = matchesPrefix(value, ipv6ToBigInt('::ffff:0:0')!, 96) && (value & 0xff000000n) === (0x7fn << 24n);
  const linkLocal = matchesPrefix(value, ipv6ToBigInt('fe80::')!, 10);
  return !unspecified && !loopback && !ipv4MappedLoopback && !linkLocal;
}

export function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
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
