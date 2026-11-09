import { digestOf, type JsonObject, type McpJsonRpcResponse, type McpProbeResult, type McpRemoteTool,
  type McpServerRevision, type McpTransport } from '@lyra/shared';
import { AgentContractError } from '@lyra/shared';
import {
  assertMcpEndpoint, safeMcpFetch, type EndpointPolicy, type McpFetch, type McpHttpResponse,
} from './mcp-guard';

/**
 * MCP 客户端握手与工具探测。
 *
 * 只实现协议必需的最小面：initialize → notifications/initialized → tools/list
 * → tools/call。所有请求都经过 safeMcpFetch（Host/端口/私网/重定向校验），
 * 响应有大小上限，错误只返回脱敏消息，不回显远端原始报文。
 */

export interface McpSseEvent { event: string; data: string }

export interface McpStreamHandle {
  events: AsyncIterable<McpSseEvent>;
  close(): Promise<void>;
}

export type McpStream = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string> },
) => Promise<McpStreamHandle>;

export interface McpConnectionOptions {
  server: McpServerRevision;
  policy: EndpointPolicy;
  fetch: McpFetch;
  stream?: McpStream;
  /** 已解析的鉴权头值；只在调用期短暂存在，任何日志与返回值都不得包含。 */
  secretHeaders?: Record<string, string>;
  now?: () => Date;
}

interface McpSession {
  request(payload: JsonObject, wantReply: boolean): Promise<McpJsonRpcResponse>;
  protocolVersion: string;
  sessionId: string | null;
  close(): Promise<void>;
}

const MAX_TOOLS = 256;
const MAX_LIST_PAGES = 20;
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

export async function probeMcpServer(options: McpConnectionOptions): Promise<McpProbeResult> {
  const server = options.server;
  const session = await connectMcpSession(options);
  try {
    const listed = await listTools(session);
    return {
      serverId: server.serverId,
      serverRevision: server.revision,
      protocolVersion: session.protocolVersion,
      sessionId: session.sessionId,
      tools: listed.tools,
      capabilityDigest: digestOf({
        protocolVersion: session.protocolVersion,
        tools: listed.tools.map(tool => ({
          name: tool.name,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          annotations: tool.annotations,
        })),
      }),
      probedAt: (options.now?.() ?? new Date()).toISOString(),
    };
  } finally {
    await session.close().catch(() => undefined);
  }
}

export async function callMcpTool(
  options: McpConnectionOptions, toolName: string, args: Record<string, unknown>,
): Promise<{ summary: string; data: unknown; isError: boolean }> {
  if (!/^[A-Za-z0-9_.:/-]{1,128}$/.test(toolName)) {
    throw new AgentContractError(400, 'MCP_TOOL_NAME_INVALID', '远端工具名不合法。');
  }
  const session = await connectMcpSession(options);
  try {
    const response = await session.request({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: toolName, arguments: args },
    }, true);
    if (response.error) throw remoteError(response.error.message);
    const result = response.result;
    if (!result || typeof result !== 'object') throw new AgentContractError(502, 'MCP_RESULT_INVALID', 'MCP 服务没有返回调用结果。');
    const record = result as Record<string, unknown>;
    const content = Array.isArray(record.content) ? record.content : [];
    const text = content
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .filter(item => item.type === 'text')
      .map(item => String(item.text ?? ''))
      .join('\n');
    return {
      summary: (text || 'MCP 工具已执行').slice(0, 2000),
      data: { isError: record.isError === true, contentCount: content.length },
      isError: record.isError === true,
    };
  } finally {
    await session.close().catch(() => undefined);
  }
}

async function connectMcpSession(options: McpConnectionOptions): Promise<McpSession> {
  const server = options.server;
  const headers = buildHeaders(options);
  const protocolVersion = server.protocolVersions[0] ?? DEFAULT_PROTOCOL_VERSION;
  if (server.transport === 'sse') return connectSse(options, headers, protocolVersion);
  return connectHttp(options, headers, protocolVersion);
}

function buildHeaders(options: McpConnectionOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const protocol = options.server.protocolVersions[0];
  if (protocol) headers['MCP-Protocol-Version'] = protocol;
  for (const name of options.server.headerSecretRefs) {
    const value = options.secretHeaders?.[name];
    if (typeof value === 'string' && value.trim()) headers[name] = value;
  }
  return headers;
}

async function connectHttp(options: McpConnectionOptions, headers: Record<string, string>, protocolVersion: string): Promise<McpSession> {
  const endpoint = await assertMcpEndpoint(options.server.url, options.policy);
  const state = { sessionId: null as string | null };
  const post = async (payload: JsonObject, method: 'POST' | 'GET' = 'POST'): Promise<McpHttpResponse> => {
    const extra: Record<string, string> = { ...headers, ...(state.sessionId ? { 'Mcp-Session-Id': state.sessionId } : {}) };
    return safeMcpFetch(options.fetch, endpoint.url.toString(), {
      policy: options.policy,
      maxResponseBytes: options.server.maxResponseBytes,
      headers: extra,
      ...(method === 'POST' ? { body: JSON.stringify(payload), method: 'POST' as const } : {}),
    });
  };
  const initialized = await request(payloadOfInitialize(protocolVersion), post, 1, options, state);
  if (initialized.error) throw remoteError(initialized.error.message);
  const result = initialized.result as Record<string, unknown> | undefined;
  const negotiated = typeof result?.protocolVersion === 'string' ? result.protocolVersion : protocolVersion;
  const sessionId = state.sessionId;

  await notifyInitialized(post, state, options, headers);

  return {
    protocolVersion: negotiated,
    sessionId,
    request: async (payload) => request(payload, post, payload.id as number, options, state),
    close: async () => undefined,
  };
}

async function connectSse(options: McpConnectionOptions, headers: Record<string, string>, protocolVersion: string): Promise<McpSession> {
  if (!options.stream) throw new AgentContractError(503, 'MCP_SSE_UNAVAILABLE', '当前环境未注入 SSE 流能力。');
  const endpoint = await assertMcpEndpoint(options.server.url, options.policy);
  const handle = await options.stream(endpoint.url.toString(), {
    method: 'GET', headers: { ...headers, Accept: 'text/event-stream' },
  });
  let messageEndpoint: string | null = null;
  let initialized: McpJsonRpcResponse | null = null;
  const deadline = Date.now() + options.server.initializationTimeoutMs;
  const iterator = handle.events[Symbol.asyncIterator]();
  try {
    while (Date.now() < deadline) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<'timeout'>(resolvePromise => setTimeout(() => resolvePromise('timeout'), Math.max(1, deadline - Date.now()))),
      ]);
      if (next === 'timeout' || next.done) break;
      const event = next.value;
      if (event.event === 'endpoint' && event.data.trim()) {
        messageEndpoint = new URL(event.data.trim(), endpoint.url).toString();
        assertSameOrigin(messageEndpoint, endpoint.url.toString());
      }
      if (event.event === 'message' && event.data.trim()) {
        const parsed = parseJson<McpJsonRpcResponse>(event.data);
        if (parsed && parsed.id === 1) initialized = parsed;
      }
      if (messageEndpoint && initialized) break;
    }
  } finally {
    await iterator.return?.().catch(() => undefined);
    await handle.close().catch(() => undefined);
  }
  if (!messageEndpoint) throw new AgentContractError(502, 'MCP_SSE_ENDPOINT_MISSING', 'MCP SSE 流没有提供消息端点。');
  if (!initialized) {
    initialized = await request(payloadOfInitialize(protocolVersion), async payload => safeMcpFetch(
      options.fetch, messageEndpoint!, {
        policy: options.policy, maxResponseBytes: options.server.maxResponseBytes,
        headers: { ...headers, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), method: 'POST',
      },
    ), 1, options);
  }
  if (initialized.error) throw remoteError(initialized.error.message);
  const result = initialized.result as Record<string, unknown> | undefined;
  const negotiated = typeof result?.protocolVersion === 'string' ? result.protocolVersion : protocolVersion;
  const post = async (payload: JsonObject): Promise<McpHttpResponse> => safeMcpFetch(options.fetch, messageEndpoint!, {
    policy: options.policy, maxResponseBytes: options.server.maxResponseBytes,
    headers: { ...headers, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), method: 'POST',
  });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => undefined);
  return {
    protocolVersion: negotiated,
    sessionId: null,
    request: async (payload) => request(payload, post, payload.id as number, options),
    close: async () => undefined,
  };
}

async function request(
  payload: JsonObject,
  post: (payload: JsonObject) => Promise<McpHttpResponse>,
  wantId: number,
  options: McpConnectionOptions,
  state?: { sessionId: string | null },
): Promise<McpJsonRpcResponse> {
  const response = await post(payload);
  const sessionId = headerValue(response.headers, 'mcp-session-id');
  if (state && sessionId) state.sessionId = sessionId;
  if (response.status < 200 || response.status >= 300) {
    throw new AgentContractError(502, 'MCP_HTTP_ERROR', `MCP 服务返回 HTTP ${response.status}。`);
  }
  const contentType = headerValue(response.headers, 'content-type') ?? '';
  const text = response.body.trim();
  if (!text && wantId === 0) return { jsonrpc: '2.0', id: null, result: {} };
  if (contentType.includes('text/event-stream') || text.startsWith('event:') || text.startsWith('data:')) {
    const parsed = parseSseMessages(text, wantId);
    if (!parsed) throw new AgentContractError(502, 'MCP_RESPONSE_INVALID', 'MCP SSE 响应中没有目标消息。');
    return parsed;
  }
  const parsed = parseJson<McpJsonRpcResponse>(text);
  if (!parsed) throw new AgentContractError(502, 'MCP_RESPONSE_INVALID', 'MCP 响应不是合法 JSON-RPC。');
  if (parsed.id !== undefined && parsed.id !== null && parsed.id !== wantId) {
    throw new AgentContractError(502, 'MCP_RESPONSE_ID_MISMATCH', 'MCP 响应 ID 与请求不一致。');
  }
  void options;
  return parsed;
}

async function notifyInitialized(
  post: (payload: JsonObject) => Promise<McpHttpResponse>,
  _state: { sessionId: string | null },
  options: McpConnectionOptions,
  _headers: Record<string, string>,
): Promise<void> {
  try {
    const response = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    if (response.status === 405) {
      // 部分实现不接受初始化通知；不影响 tools/list，但记录为探测警告更合适。
      void options;
    }
  } catch {
    // 通知失败不阻断 tools/list：README 允许服务端忽略该通知。
  }
}

async function listTools(session: McpSession): Promise<{ tools: McpRemoteTool[] }> {
  const tools: McpRemoteTool[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const response = await session.request({
      jsonrpc: '2.0', id: 2 + page, method: 'tools/list',
      ...(cursor ? { params: { cursor } } : { params: {} }),
    }, true);
    if (response.error) throw remoteError(response.error.message);
    const result = response.result as Record<string, unknown> | undefined;
    const items = result?.tools;
    if (!Array.isArray(items)) throw new AgentContractError(502, 'MCP_TOOL_LIST_INVALID', 'MCP 服务没有返回工具列表。');
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const tool = normalizeRemoteTool(item as Record<string, unknown>);
      if (tools.some(existing => existing.name === tool.name)) {
        throw new AgentContractError(502, 'MCP_TOOL_DUPLICATE', `MCP 服务返回重复工具：${tool.name}。`);
      }
      tools.push(tool);
      if (tools.length > MAX_TOOLS) throw new AgentContractError(502, 'MCP_TOOL_LIMIT', 'MCP 服务工具数量超过上限。');
    }
    const next = result?.nextCursor;
    if (typeof next !== 'string' || !next.trim()) return { tools };
    cursor = next.trim().slice(0, 256);
  }
  throw new AgentContractError(502, 'MCP_TOOL_LIST_TOO_LONG', 'MCP 工具列表分页超过上限。');
}

function normalizeRemoteTool(raw: Record<string, unknown>): McpRemoteTool {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!/^[A-Za-z0-9_.:/-]{1,128}$/.test(name)) {
    throw new AgentContractError(502, 'MCP_TOOL_NAME_INVALID', 'MCP 工具名称不合法。');
  }
  const annotations = raw.annotations && typeof raw.annotations === 'object' && !Array.isArray(raw.annotations)
    ? raw.annotations as Record<string, unknown> : {};
  return {
    name,
    title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : name,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 4000) : '',
    inputSchema: raw.inputSchema && typeof raw.inputSchema === 'object' && !Array.isArray(raw.inputSchema)
      ? raw.inputSchema as JsonObject : { type: 'object', properties: {}, additionalProperties: true },
    outputSchema: raw.outputSchema && typeof raw.outputSchema === 'object' && !Array.isArray(raw.outputSchema)
      ? raw.outputSchema as JsonObject : null,
    annotations: {
      readOnlyHint: annotations.readOnlyHint === true,
      destructiveHint: annotations.destructiveHint === true,
      idempotentHint: annotations.idempotentHint === true,
      openWorldHint: annotations.openWorldHint !== false,
    },
  };
}

function payloadOfInitialize(protocolVersion: string): JsonObject {
  return {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'lyra', version: '0.2.0' },
    },
  };
}

function remoteError(message: string | undefined): AgentContractError {
  return new AgentContractError(502, 'MCP_RPC_ERROR', (message ?? 'MCP 调用失败').slice(0, 300));
}

function assertSameOrigin(target: string, base: string): void {
  const targetUrl = new URL(target);
  const baseUrl = new URL(base);
  if (targetUrl.hostname !== baseUrl.hostname || targetUrl.protocol !== baseUrl.protocol) {
    throw new AgentContractError(400, 'MCP_SSE_ENDPOINT_CROSS_ORIGIN', 'MCP SSE 消息端点不能跨源。');
  }
}

export function parseSseMessages(text: string, wantId: number): McpJsonRpcResponse | null {
  for (const block of text.split(/\n\n+/)) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (event !== 'message' || data.length === 0) continue;
    const parsed = parseJson<McpJsonRpcResponse>(data.join('\n'));
    if (parsed && (parsed.result !== undefined || parsed.error !== undefined) && parsed.id === wantId) return parsed;
  }
  return null;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct !== undefined) return direct;
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function parseJson<T>(text: string): T | null {
  try { return JSON.parse(text) as T; }
  catch { return null; }
}

export function mcpTransportLabel(transport: McpTransport): string {
  return transport === 'sse' ? 'HTTP+SSE' : 'Streamable HTTP';
}
