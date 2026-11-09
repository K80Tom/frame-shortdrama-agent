import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { AgentContractError, type McpServerRevision, type McpTransport } from '@lyra/shared';
import { assertMcpEndpoint } from '@lyra/agent';

export interface McpManagementOptions {
  now?: () => Date;
  /** 测试或受控部署可注入解析器；默认使用系统 DNS。 */
  resolveHost?: (hostname: string) => Promise<string[]>;
  allowHttp?: boolean;
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) {
    throw new AgentContractError(400, 'MCP_CONFIG_INVALID', 'MCP 配置字段不符合约定。');
  }
  return value as Record<string, unknown>;
}
function bounded(value: unknown, field: string, max = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new AgentContractError(400, 'MCP_CONFIG_INVALID', `${field} 必须是非空字符串（最长 ${max} 字）。`);
  }
  return value.trim();
}
function stringArray(value: unknown, field: string, max = 20): string[] {
  if (!Array.isArray(value) || value.length > max
    || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 200)) {
    throw new AgentContractError(400, 'MCP_CONFIG_INVALID', `${field} 必须是最多 ${max} 项的字符串数组。`);
  }
  return [...new Set(value.map(item => (item as string).trim()))];
}

const SECRET_HEADER_REF = /^[a-zA-Z][a-zA-Z0-9._-]{1,63}$/;
const SENSITIVE_QUERY = /^(api[_-]?key|token|access[_-]?token|auth|authorization|key|secret|client[_-]?secret|password|passwd|sig|signature)$/i;

/** MCP 管理配置：只保存 Secret Reference，不接收明文密钥。 */
export class McpManagementService {
  private readonly revisions = new Map<string, McpServerRevision[]>();
  private readonly now: () => Date;
  private readonly resolveHost: (hostname: string) => Promise<string[]>;
  private readonly allowHttp: boolean;

  constructor(options: McpManagementOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.resolveHost = options.resolveHost ?? (async hostname => (await lookup(hostname, { all: true })).map(item => item.address));
    this.allowHttp = options.allowHttp === true;
  }

  list(workspaceId: string): McpServerRevision[] {
    return this.latest(workspaceId).map(revision => structuredClone(revision));
  }

  get(workspaceId: string, serverId: string): McpServerRevision {
    const found = this.latest(workspaceId).find(revision => revision.serverId === serverId);
    if (!found) throw new AgentContractError(404, 'MCP_SERVER_NOT_FOUND', 'MCP Server 配置不存在。');
    return structuredClone(found);
  }

  async create(value: unknown, workspaceId: string): Promise<McpServerRevision> {
    const input = object(value, ['name', 'slug', 'transport', 'url', 'headerSecretRefs',
      'queryParams', 'protocolVersions', 'timeoutMs', 'initializationTimeoutMs', 'maxResponseBytes']);
    const name = bounded(input.name, 'name', 120);
    const slug = bounded(input.slug, 'slug', 64);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
      throw new AgentContractError(400, 'MCP_CONFIG_INVALID', 'slug 只允许小写字母、数字和单个连字符。');
    }
    const transport = input.transport;
    if (transport !== 'http' && transport !== 'sse') {
      throw new AgentContractError(400, 'MCP_CONFIG_INVALID', 'transport 只支持 http 或 sse。');
    }
    const url = bounded(input.url, 'url', 2048);
    let policyHost: string;
    try { policyHost = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); }
    catch { throw new AgentContractError(400, 'MCP_URL_INVALID', '无法解析 MCP 地址。'); }
    try {
      await assertMcpEndpoint(url, {
        allowedHosts: [policyHost], allowHttp: this.allowHttp, resolveHost: this.resolveHost,
      });
    } catch (error) {
      // guard 在 @lyra/agent 内使用其自身依赖的 shared 副本；跨副本 instanceof 不可靠，
      // 统一按稳定字段重抛为 main 侧契约错误。
      if (error instanceof Error && error.name === 'AgentContractError'
        && 'status' in error && 'code' in error) {
        throw new AgentContractError(Number((error as { status: unknown }).status),
          String((error as { code: unknown }).code), error.message);
      }
      throw error;
    }
    const secrets = stringArray(input.headerSecretRefs ?? [], 'headerSecretRefs', 10);
    if (secrets.some(item => !SECRET_HEADER_REF.test(item))) {
      throw new AgentContractError(400, 'MCP_CONFIG_INVALID', 'headerSecretRefs 只能保存 Secret 引用名称。');
    }
    const queryParams = input.queryParams ?? {};
    if (!queryParams || typeof queryParams !== 'object' || Array.isArray(queryParams)) {
      throw new AgentContractError(400, 'MCP_CONFIG_INVALID', 'queryParams 必须是对象。');
    }
    for (const [key, item] of Object.entries(queryParams as Record<string, unknown>)) {
      if (SENSITIVE_QUERY.test(key) || typeof item !== 'string' || item.length > 500) {
        throw new AgentContractError(400, 'MCP_URL_SECRET_IN_QUERY', 'queryParams 不能携带长期密钥或非字符串值。');
      }
    }
    const protocols = stringArray(input.protocolVersions ?? ['2025-06-18'], 'protocolVersions', 5);
    const timeoutMs = this.integer(input.timeoutMs ?? 30_000, 'timeoutMs', 1_000, 120_000);
    const initializationTimeoutMs = this.integer(input.initializationTimeoutMs ?? 15_000, 'initializationTimeoutMs', 1_000, 60_000);
    const maxResponseBytes = this.integer(input.maxResponseBytes ?? 1_000_000, 'maxResponseBytes', 4_096, 8_000_000);
    const workspaceServers = this.revisions.get(workspaceId) ?? [];
    if (this.latest(workspaceId).some(revision => revision.slug === slug)) {
      throw new AgentContractError(409, 'MCP_SERVER_SLUG_EXISTS', '同一 Workspace 内 MCP slug 已存在。');
    }
    const base = {
      serverId: `mcp_${randomUUID().replaceAll('-', '')}`,
      revision: 1, workspaceId, name, slug, transport: transport as McpTransport,
      url, headerSecretRefs: secrets, queryParams: queryParams as Record<string, string>,
      protocolVersions: protocols, timeoutMs, initializationTimeoutMs, maxResponseBytes,
      allowedHosts: [policyHost], status: 'active' as const, admission: 'pending' as const,
      createdAt: this.now().toISOString(),
    };
    this.revisions.set(workspaceId, [...workspaceServers, base]);
    return structuredClone(base);
  }

  disable(workspaceId: string, serverId: string, expectedRevision: number): McpServerRevision {
    const current = this.get(workspaceId, serverId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
      throw new AgentContractError(409, 'MCP_SERVER_REVISION_MISMATCH', 'MCP 配置已被修改，请刷新后重试。');
    }
    if (current.status === 'disabled') return current;
    const next: McpServerRevision = { ...current, revision: current.revision + 1, status: 'disabled',
      createdAt: this.now().toISOString() };
    const history = this.revisions.get(workspaceId) ?? [];
    this.revisions.set(workspaceId, [...history, next]);
    return structuredClone(next);
  }

  policy(): Record<string, unknown> {
    return {
      transports: ['http', 'sse'], allowHttp: this.allowHttp,
      secretStorage: 'reference-only', requireWorkspaceAdmission: true,
      maxResponseBytes: 8_000_000,
    };
  }

  private latest(workspaceId: string): McpServerRevision[] {
    const history = this.revisions.get(workspaceId) ?? [];
    const latest = new Map<string, McpServerRevision>();
    for (const revision of history) latest.set(revision.serverId, revision);
    return [...latest.values()];
  }

  private integer(value: unknown, field: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new AgentContractError(400, 'MCP_CONFIG_INVALID', `${field} 必须是 ${min}-${max} 的整数。`);
    }
    return value;
  }
}
