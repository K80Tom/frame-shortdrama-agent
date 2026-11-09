import {
  AgentContractError, computeToolManifestDigest, defineTool, digestOf, mcpToolId,
  type JsonObject, type McpGatewayScope, type McpJsonRpcRequest, type McpJsonRpcResponse, type McpRemoteTool,
  type McpServerRevision, type McpToolManifest, type McpWorkspaceAdmission, type PublicToolDefinition,
  type ToolDefinition, type ToolJsonSchema, type ToolPermissionLevel,
} from '@lyra/shared';
import { ToolAdapterError, type ToolAdapter, type ToolExecutionContext } from '../kernel';
import { callMcpTool, type McpConnectionOptions } from './mcp-probe';

/**
 * 把远端 MCP Tool 映射为内部不可变 ToolDefinition。
 *
 * - 远端 schema 只允许可表达的子集，`$ref`/`anyOf`/`oneOf` 等一律拒绝，
 *   避免“校验通过但远端语义不同”的假安全感；
 * - annotations 只作为风险提示：写操作默认 workflow_only，模型不可直接调用；
 * - 工具 ID 带 server slug，两个 MCP 服务的同名工具不会互相覆盖。
 */

export interface MapMcpToolInput {
  server: McpServerRevision;
  workspaceId: string;
  remote: McpRemoteTool;
  version?: string;
  /** 静态 allowlist：哪些 Agent 可以使用该 MCP 工具；空数组表示不暴露给 Agent。 */
  allowedAgentIds?: string[];
  /** workflow_only 工具允许的 Workflow ID。 */
  allowedWorkflowIds?: string[];
}

export function mapMcpTool(input: MapMcpToolInput): McpToolManifest {
  const remote = input.remote;
  const readOnly = remote.annotations.readOnlyHint && !remote.annotations.destructiveHint;
  const inputSchema = toInternalSchema(remote.inputSchema, 'inputSchema');
  const outputSchema = remote.outputSchema
    ? toInternalSchema(remote.outputSchema, 'outputSchema')
    : { type: 'object' as const, properties: {}, additionalProperties: true };
  const toolId = mcpToolId(input.server.slug, remote.name);
  const permission: ToolPermissionLevel = readOnly ? 'workspace_read' : 'workspace_write';
  const definition: ToolDefinition = defineTool({
    toolId,
    version: input.version ?? '1.0.0',
    displayName: remote.title.slice(0, 120),
    description: (remote.description || `MCP 工具 ${remote.name}`).slice(0, 2000),
    ownerDomain: `mcp:${input.server.slug}`,
    inputSchema,
    outputSchema,
    sideEffect: readOnly ? 'none' : 'external_write',
    executionOwner: readOnly ? 'agent_selectable' : 'workflow_only',
    requiredPermission: permission,
    allowedAgentIds: readOnly ? [...(input.allowedAgentIds ?? [])] : [],
    allowedWorkflowIds: readOnly ? [] : [...(input.allowedWorkflowIds ?? [])],
    sensitivity: { input: 'internal', output: 'internal' },
    cost: null,
    idempotency: { strategy: readOnly ? 'content_digest' : 'client_request_id', keyVersion: 1 },
    retry: {
      timeoutMs: input.server.timeoutMs,
      maxAttempts: 1,
      backoffMs: 0,
      retryableCodes: [],
      unknownCodes: ['AGENT_TOOL_TIMEOUT', 'MCP_RESPONSE_INVALID', 'MCP_RPC_ERROR'],
    },
    capability: { async: false, reconcile: false, cancel: false },
    providers: { hosts: [new URL(input.server.url).hostname], modelConnections: [] },
    limits: { maxInputBytes: 64 * 1024, maxOutputBytes: input.server.maxResponseBytes, maxItems: 200 },
    produces: { entities: [], revisions: [], artifacts: [], evidence: [], events: [] },
    adapterDigest: digestOf({
      kind: 'mcp-adapter', serverId: input.server.serverId, revision: input.server.revision,
      remoteName: remote.name, capability: digestOf(remote),
    }),
    status: 'frozen',
  });
  return {
    manifestId: `mcpm_${digestOf({ server: input.server.serverId, revision: input.server.revision, toolId }).slice(0, 24)}`,
    serverId: input.server.serverId,
    serverRevision: input.server.revision,
    workspaceId: input.workspaceId,
    remoteName: remote.name,
    definition,
    annotations: remote.annotations,
    sensitivity: readOnly ? 'internal' : 'confidential',
    discoveredAt: new Date().toISOString(),
    manifestDigest: definition.manifestDigest,
  };
}

/** 远端 JSON Schema → 内部可校验子集。无法表达的 schema 直接拒绝，不做“降级放行”。 */
export function toInternalSchema(value: unknown, label: string, depth = 0): ToolJsonSchema {
  if (depth > 8) throw new AgentContractError(502, `MCP_${label.toUpperCase()}_TOO_DEEP`, '远端工具 Schema 嵌套过深。');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentContractError(502, `MCP_${label.toUpperCase()}_INVALID`, '远端工具 Schema 必须是对象。');
  }
  const raw = value as Record<string, unknown>;
  for (const keyword of ['$ref', 'anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else', 'patternProperties', 'dependentSchemas']) {
    if (raw[keyword] !== undefined) {
      throw new AgentContractError(502, 'MCP_SCHEMA_UNSUPPORTED', `远端工具 Schema 使用了不支持的 ${keyword}。`);
    }
  }
  const type = raw.type;
  if (type === undefined) {
    if (raw.properties && typeof raw.properties === 'object') return toInternalObject(raw, label, depth);
    throw new AgentContractError(502, 'MCP_SCHEMA_UNSUPPORTED', '远端工具 Schema 缺少 type。');
  }
  if (type === 'object') return toInternalObject(raw, label, depth);
  if (type === 'array') {
    if (raw.items === undefined) throw new AgentContractError(502, 'MCP_SCHEMA_UNSUPPORTED', '远端数组 Schema 缺少 items。');
    return {
      type: 'array',
      items: toInternalSchema(raw.items, `${label}[]`, depth + 1),
      ...(integerInRange(raw.maxItems, 0, 500) ? { maxItems: Number(raw.maxItems) } : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description.slice(0, 200) } : {}),
    };
  }
  if (type === 'string') {
    return {
      type: 'string',
      ...(integerInRange(raw.minLength, 0, 65535) ? { minLength: Number(raw.minLength) } : {}),
      maxLength: integerInRange(raw.maxLength, 1, 65535) ? Number(raw.maxLength) : 65535,
      ...(Array.isArray(raw.enum) ? { enum: allowedEnum(raw.enum) } : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description.slice(0, 200) } : {}),
    };
  }
  if (type === 'integer' || type === 'number') {
    return {
      type,
      ...(typeof raw.minimum === 'number' && Number.isFinite(raw.minimum) ? { minimum: raw.minimum } : {}),
      ...(typeof raw.maximum === 'number' && Number.isFinite(raw.maximum) ? { maximum: raw.maximum } : {}),
      ...(Array.isArray(raw.enum) ? { enum: allowedEnum(raw.enum) } : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description.slice(0, 200) } : {}),
    };
  }
  if (type === 'boolean') return { type: 'boolean' };
  throw new AgentContractError(502, 'MCP_SCHEMA_UNSUPPORTED', `远端工具 Schema 类型不受支持：${String(type)}。`);
}

function toInternalObject(raw: Record<string, unknown>, label: string, depth: number): ToolJsonSchema {
  const properties: Record<string, ToolJsonSchema> = {};
  const rawProperties = raw.properties;
  if (rawProperties !== undefined) {
    if (!rawProperties || typeof rawProperties !== 'object' || Array.isArray(rawProperties)) {
      throw new AgentContractError(502, 'MCP_SCHEMA_INVALID', '远端对象 Schema 的 properties 不合法。');
    }
    const entries = Object.entries(rawProperties as Record<string, unknown>);
    if (entries.length > 64) throw new AgentContractError(502, 'MCP_SCHEMA_TOO_LARGE', '远端工具参数超过 64 个字段。');
    for (const [name, child] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(name)) {
        throw new AgentContractError(502, 'MCP_SCHEMA_INVALID', '远端工具参数名不合法。');
      }
      properties[name] = toInternalSchema(child, `${label}.${name}`, depth + 1);
    }
  }
  const required = Array.isArray(raw.required)
    ? raw.required.filter((name): name is string => typeof name === 'string' && Object.hasOwn(properties, name)).slice(0, 64)
    : [];
  return {
    type: 'object',
    properties,
    required,
    // 远端省略 additionalProperties 时保持宽松，避免破坏既有服务参数；
    // 内部工具（非 MCP）仍然默认严格。
    additionalProperties: raw.additionalProperties !== false,
    ...(typeof raw.description === 'string' ? { description: raw.description.slice(0, 200) } : {}),
  };
}

function allowedEnum(values: unknown[]): Array<string | number | boolean> {
  const allowed = values.filter((value): value is string | number | boolean =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean');
  if (allowed.length === 0 || allowed.length > 64) {
    throw new AgentContractError(502, 'MCP_SCHEMA_UNSUPPORTED', '远端工具枚举为空或超过 64 项。');
  }
  return allowed;
}

function integerInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** 把 allowed tools 与工作区准入合并成一个稳定的可见清单。 */
export function admittedManifests(
  all: McpToolManifest[], admission: McpWorkspaceAdmission, agentId: string,
): McpToolManifest[] {
  if (admission.status !== 'approved') return [];
  const enabled = new Set(admission.enabledTools);
  return all
    .filter(manifest => manifest.workspaceId === admission.workspaceId)
    .filter(manifest => manifest.serverId === admission.serverId && manifest.serverRevision === admission.revision)
    .filter(manifest => enabled.size === 0 ? false : enabled.has(manifest.remoteName))
    .filter(manifest => manifest.definition.allowedAgentIds.includes(agentId));
}

/** MCP Adapter 只在执行期短暂持有连接配置，不把 Secret 带入结果。 */
export function createMcpToolAdapter(
  connection: McpConnectionOptions, manifest: McpToolManifest,
): ToolAdapter {
  return {
    async execute(args: Record<string, unknown>, context: ToolExecutionContext) {
      void context;
      try {
        const result = await callMcpTool(connection, manifest.remoteName, args);
        if (result.isError) throw new ToolAdapterError('MCP_TOOL_REPORTED_ERROR', result.summary, { retryable: false });
        return {
          summary: result.summary,
          data: result.data,
          provider: manifest.serverId,
        };
      } catch (error) {
        if (error instanceof ToolAdapterError) throw error;
        if (error instanceof AgentContractError) {
          throw new ToolAdapterError(error.code, error.message, { retryable: false, unknown: true });
        }
        throw new ToolAdapterError('MCP_TOOL_FAILED', 'MCP 工具执行失败，远端结果未知。', { unknown: true });
      }
    },
  };
}

/**
 * Lyra 作为 MCP Server 的协议面。
 *
 * 外部 Agent 只能看到 scope 显式列入、且已冻结的公开 Tool；所有调用仍走同一个
 * ToolDefinition schema 校验与执行回调。这里不监听端口，HTTP 由 main 负责。
 */
export interface McpGatewayToolSource {
  list(): Promise<PublicToolDefinition[]>;
  execute(toolId: string, args: Record<string, unknown>, scope: McpGatewayScope): Promise<{ summary: string; data?: unknown }>;
}

export class LyraMcpGateway {
  private readonly buckets = new Map<string, number[]>();

  constructor(
    private readonly tools: McpGatewayToolSource,
    private readonly options: { protocolVersion?: string; now?: () => Date } = {},
  ) {}

  async handle(request: McpJsonRpcRequest, scope: McpGatewayScope): Promise<McpJsonRpcResponse> {
    const id = request.id ?? null;
    try {
      if (request.method === 'initialize') {
        return ok(id, {
          protocolVersion: this.options.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'lyra', version: '0.2.0' },
        });
      }
      if (request.method === 'ping') return ok(id, {});
      if (request.method === 'tools/list') {
        const visible = await this.visibleTools(scope);
        return ok(id, {
          tools: visible.map(tool => ({
            name: tool.toolId.replaceAll('.', '_'),
            title: tool.displayName,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            annotations: {
              readOnlyHint: tool.sideEffect === 'none',
              destructiveHint: tool.sideEffect === 'paid_external' || tool.sideEffect === 'external_write',
              idempotentHint: tool.idempotency.strategy !== 'none',
              openWorldHint: false,
            },
          })),
        });
      }
      if (request.method === 'tools/call') {
        if (!this.consumeRateLimit(scope)) return rpcError(id, -32029, '请求超过速率限制。');
        const params = request.params ?? {};
        const rawName = typeof params.name === 'string' ? params.name : '';
        const visible = await this.visibleTools(scope);
        const tool = visible.find(item => item.toolId.replaceAll('.', '_') === rawName || item.toolId === rawName);
        if (!tool) return rpcError(id, -32602, '工具未在外部访问范围内。');
        const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? params.arguments as Record<string, unknown> : {};
        const result = await this.tools.execute(tool.toolId, args, scope);
        return ok(id, {
          content: [{ type: 'text', text: result.summary.slice(0, 4000) }],
          ...(result.data === undefined ? {} : { structuredContent: result.data }),
          isError: false,
        });
      }
      return rpcError(id, -32601, '不支持的 MCP 方法。');
    } catch (error) {
      if (error instanceof AgentContractError) return rpcError(id, -32602, error.message.slice(0, 300));
      return rpcError(id, -32603, 'Lyra MCP 服务内部错误。');
    }
  }

  async visibleTools(scope: McpGatewayScope): Promise<PublicToolDefinition[]> {
    const allowed = new Set(scope.allowedToolIds);
    const tools = await this.tools.list();
    return tools.filter(tool =>
      allowed.has(tool.toolId)
      && tool.status === 'frozen'
      && tool.executionOwner !== 'runtime_internal'
      && (scope.permission === 'workspace_write' || tool.sideEffect === 'none'));
  }

  private consumeRateLimit(scope: McpGatewayScope): boolean {
    const now = (this.options.now?.() ?? new Date()).getTime();
    const key = `${scope.workspaceId}:${scope.subject}`;
    const window = this.buckets.get(key) ?? [];
    const recent = window.filter(timestamp => now - timestamp < 60_000);
    if (recent.length >= scope.requestsPerMinute) {
      this.buckets.set(key, recent);
      return false;
    }
    recent.push(now);
    this.buckets.set(key, recent);
    return true;
  }
}

function ok(id: string | number | null, result: unknown): McpJsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): McpJsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export { computeToolManifestDigest };
