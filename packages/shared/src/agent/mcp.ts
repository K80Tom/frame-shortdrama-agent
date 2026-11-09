import { AgentContractError, type JsonObject, type ToolDefinition, type ToolSensitivity } from './contracts';

/**
 * MCP 互操作公共契约。
 *
 * MCP 只是 Tool Registry 之下的一种外部 Adapter：远端 Tool 必须经过工作区准入、
 * Schema 快照、digest 和 SSRF 校验后才能映射为内部 ToolDefinition。
 * 任何情况下都不把远端 Endpoint、鉴权头、OAuth Token 暴露给 Agent。
 */

export type McpTransport = 'http' | 'sse';
export type McpServerStatus = 'active' | 'disabled';
export type McpAdmissionStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

export interface McpServerRevision {
  serverId: string;
  revision: number;
  workspaceId: string;
  name: string;
  slug: string;
  transport: McpTransport;
  /** 已通过准入校验的 HTTPS/HTTP(S) Endpoint，可含查询参数。 */
  url: string;
  /** 只保存 Secret 引用的名称；真实值在 main 的密钥系统中。 */
  headerSecretRefs: string[];
  queryParams: Record<string, string>;
  protocolVersions: string[];
  timeoutMs: number;
  initializationTimeoutMs: number;
  maxResponseBytes: number;
  /** 允许的出站 Host；远端重定向也必须命中。 */
  allowedHosts: string[];
  status: McpServerStatus;
  admission: McpAdmissionStatus;
  createdAt: string;
}

export interface McpRemoteToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface McpRemoteTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject | null;
  annotations: McpRemoteToolAnnotations;
}

export interface McpProbeResult {
  serverId: string;
  serverRevision: number;
  protocolVersion: string;
  sessionId: string | null;
  tools: McpRemoteTool[];
  /** 协议、Schema 与能力摘要，用于判断远端是否悄悄换了工具。 */
  capabilityDigest: string;
  probedAt: string;
}

export interface McpToolManifest {
  manifestId: string;
  serverId: string;
  serverRevision: number;
  workspaceId: string;
  remoteName: string;
  definition: ToolDefinition;
  annotations: McpRemoteToolAnnotations;
  sensitivity: ToolSensitivity;
  discoveredAt: string;
  manifestDigest: string;
}

export interface McpWorkspaceAdmission {
  workspaceId: string;
  serverId: string;
  revision: number;
  status: McpAdmissionStatus;
  /** 允许映射的远端 Tool 名称；空数组表示一个都不允许。 */
  enabledTools: string[];
  approvedBy: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  updatedAt: string;
}

export interface McpGatewayScope {
  workspaceId: string;
  subject: string;
  permission: 'workspace_read' | 'workspace_write';
  /** 只允许暴露显式列入的 Tool ID。 */
  allowedToolIds: string[];
  requestsPerMinute: number;
}

export interface McpJsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: JsonObject;
}

export interface McpJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface McpJsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: McpJsonRpcError;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SECRET_REF_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{2,127}$/;

export function assertMcpServerRevision(server: McpServerRevision): void {
  if (!SLUG_PATTERN.test(server.slug) || server.slug.length > 64) {
    throw new AgentContractError(400, 'MCP_SLUG_INVALID', 'MCP 服务标识只能包含小写字母、数字与短横线。');
  }
  if (server.transport !== 'http' && server.transport !== 'sse') {
    throw new AgentContractError(400, 'MCP_TRANSPORT_UNSUPPORTED', 'MCP 只支持 HTTP 或 SSE 传输。');
  }
  if (server.revision < 1 || !Number.isSafeInteger(server.revision)) {
    throw new AgentContractError(500, 'MCP_REVISION_INVALID', 'MCP 服务 revision 必须是正整数。');
  }
  for (const reference of server.headerSecretRefs) {
    if (!SECRET_REF_PATTERN.test(reference)) throw new AgentContractError(500, 'MCP_SECRET_REF_INVALID', 'MCP 鉴权头只能引用 Secret 名称。');
  }
  if (server.timeoutMs < 1000 || server.timeoutMs > 10 * 60 * 1000) {
    throw new AgentContractError(500, 'MCP_TIMEOUT_INVALID', 'MCP 调用超时必须在 1 秒到 10 分钟之间。');
  }
  if (server.maxResponseBytes < 1024 || server.maxResponseBytes > 16 * 1024 * 1024) {
    throw new AgentContractError(500, 'MCP_RESPONSE_LIMIT_INVALID', 'MCP 响应上限必须在 1KB 到 16MB 之间。');
  }
  if (!server.url.startsWith('https://') && !server.url.startsWith('http://')) {
    throw new AgentContractError(400, 'MCP_URL_INVALID', 'MCP 地址必须是 HTTP(S) URL。');
  }
}

/** 远端工具名要可追溯到 server，避免两个 MCP 服务同名工具互相覆盖。 */
export function mcpToolId(serverSlug: string, remoteName: string): string {
  const normalized = remoteName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!SLUG_PATTERN.test(serverSlug) || !normalized) {
    throw new AgentContractError(400, 'MCP_TOOL_NAME_INVALID', '远端工具名无法映射为内部 Tool ID。');
  }
  return `mcp.${serverSlug}.${normalized}`;
}

/** 远端 annotations 是提示不是授权；破坏性/未知副作用一律升级治理等级。 */
export function deriveMcpSideEffect(annotations: McpRemoteToolAnnotations, enabledForWorkflow: boolean): 'none' | 'external_write' {
  if (annotations.readOnlyHint && !annotations.destructiveHint) return 'none';
  void enabledForWorkflow;
  return 'external_write';
}
