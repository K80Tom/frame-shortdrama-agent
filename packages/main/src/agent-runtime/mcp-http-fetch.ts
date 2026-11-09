import { AgentContractError } from '@lyra/shared';
import type { McpConnectionTarget, McpFetch, McpHttpResponse } from '@lyra/agent';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * 生产环境 MCP transport：连接固定到 guard 已校验的 Peer IP。
 *
 * - `hostname` 传 IP，Node 不会再做 DNS 解析；
 * - `Host` 头与 TLS `servername` 保留原始域名，证书仍按原 Host 校验；
 * - 只接受 `rejectUnauthorized: true`，不允许自签名/中间人绕过。
 */
export function createPinnedMcpFetch(): McpFetch {
  return async (target, init) => {
    const url = new URL(target.url);
    if (url.protocol !== target.protocol) {
      throw new AgentContractError(400, 'MCP_TARGET_INVALID', 'MCP 连接目标协议不一致。');
    }
    if (url.hostname.replace(/^\[|\]$/g, '') !== target.hostname) {
      throw new AgentContractError(400, 'MCP_TARGET_INVALID', 'MCP 连接目标 Host 与已校验 Host 不一致。');
    }
    const isHttps = target.protocol === 'https:';
    const headers: Record<string, string> = { ...init.headers, host: url.host };
    const request = isHttps ? httpsRequest : httpRequest;
    return new Promise<McpHttpResponse>((resolvePromise, reject) => {
      const req = request({
        protocol: target.protocol,
        hostname: target.address,
        port: target.port,
        path: `${url.pathname}${url.search}`,
        method: init.method,
        headers,
        ...(isHttps ? { servername: target.servername, rejectUnauthorized: true } : {}),
      }, response => {
        const status = response.statusCode ?? 0;
        if (status < 100) {
          response.resume();
          reject(new AgentContractError(502, 'MCP_RESPONSE_INVALID', 'MCP 响应缺少有效状态码。'));
          return;
        }
        const responseHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (value === undefined) continue;
          responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', chunk => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > target.maxResponseBytes) {
            response.destroy(new AgentContractError(413, 'MCP_RESPONSE_TOO_LARGE', 'MCP 响应超过允许的大小。'));
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          resolvePromise({
            status,
            headers: responseHeaders,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', error => reject(asContractError(error, 'MCP_RESPONSE_INVALID')));
      });
      req.setTimeout(60_000, () => {
        req.destroy(new AgentContractError(504, 'MCP_TIMEOUT', 'MCP 请求超时。'));
      });
      req.on('error', error => reject(asContractError(error, 'MCP_CONNECTION_FAILED')));
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
  };
}

function asContractError(error: unknown, code: string): AgentContractError {
  if (error instanceof AgentContractError) return error;
  return new AgentContractError(502, code, 'MCP 网络请求失败。');
}
