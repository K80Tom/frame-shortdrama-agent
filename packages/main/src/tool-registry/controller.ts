import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AgentContractError } from '@lyra/shared';
import { LEGACY_MIGRATION_USER_ID, LEGACY_WORKSPACE_ID, type TenantContext } from '../tenancy/context';
import type { McpManagementService } from '../mcp-management/service';
import type { ToolRegistryViewService } from './service';

export const TOOL_REGISTRY_VIEW = Symbol('TOOL_REGISTRY_VIEW');
export const MCP_MANAGEMENT = Symbol('MCP_MANAGEMENT');

type AuthedRequest = FastifyRequest & { auth?: { tenant: TenantContext } };

function tenantOf(request: AuthedRequest) {
  const tenant = request.auth?.tenant;
  return tenant ?? { workspaceId: LEGACY_WORKSPACE_ID, userId: LEGACY_MIGRATION_USER_ID,
    role: 'owner' as const, requestId: 'req_tool_registry_legacy' };
}

@Controller()
export class ToolRegistryController {
  constructor(@Inject(TOOL_REGISTRY_VIEW) private readonly tools: ToolRegistryViewService | null,
    @Inject(MCP_MANAGEMENT) private readonly mcp: McpManagementService | null) {}

  private readyTools(): ToolRegistryViewService {
    if (!this.tools) throw new AgentContractError(503, 'TOOL_REGISTRY_UNAVAILABLE', 'Tool Registry 尚未完成 041 迁移或服务装配。');
    return this.tools;
  }
  private readyMcp(): McpManagementService {
    if (!this.mcp) throw new AgentContractError(503, 'MCP_MANAGEMENT_UNAVAILABLE', 'MCP 管理服务尚未就绪。');
    return this.mcp;
  }

  @Get('api/tools')
  list(@Query('domain') domain: string | undefined) {
    const list = this.readyTools().list();
    const tools = domain ? list.filter(tool => tool.ownerDomain === domain) : list;
    return { tools, total: tools.length };
  }

  @Get('api/tools/:toolId/:version')
  get(@Param('toolId') toolId: string, @Param('version') version: string) {
    const tool = this.readyTools().get(toolId, version);
    if (!tool) throw new AgentContractError(404, 'TOOL_NOT_FOUND', '工具版本不存在或未发布。');
    return tool;
  }

  @Get(['api/mcp', 'api/integrations/mcp'])
  mcpConfig(@Req() request: AuthedRequest) {
    const tenant = tenantOf(request);
    return { workspaceId: tenant.workspaceId, servers: this.readyMcp().list(tenant.workspaceId),
      policy: this.readyMcp().policy() };
  }

  @Get('api/mcp/servers')
  mcpServers(@Req() request: AuthedRequest) {
    return { servers: this.readyMcp().list(tenantOf(request).workspaceId) };
  }

  @Post(['api/mcp/servers', 'api/integrations/mcp/servers'])
  @HttpCode(201)
  async createServer(@Body() body: unknown, @Req() request: AuthedRequest) {
    const tenant = tenantOf(request);
    this.requireAdmin(tenant.role);
    return this.readyMcp().create(body, tenant.workspaceId);
  }

  @Post(['api/mcp/servers/:serverId/disable', 'api/integrations/mcp/servers/:serverId/disable'])
  @HttpCode(200)
  disableServer(@Param('serverId') serverId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const tenant = tenantOf(request);
    this.requireAdmin(tenant.role);
    const expected = body && typeof body === 'object' && !Array.isArray(body)
      ? Number((body as Record<string, unknown>).expectedRevision) : Number.NaN;
    if (!Number.isSafeInteger(expected) || expected < 1) {
      throw new AgentContractError(400, 'MCP_CONFIG_INVALID', '必须提供 expectedRevision。');
    }
    return this.readyMcp().disable(tenant.workspaceId, serverId, expected);
  }

  private requireAdmin(role: string): void {
    if (role !== 'owner' && role !== 'admin') {
      throw new AgentContractError(403, 'MCP_WORKSPACE_ADMIN_REQUIRED', 'MCP 配置需要 Workspace 管理员权限。');
    }
  }
}
