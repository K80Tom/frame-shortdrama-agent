import {
  AgentContractError, assertToolDefinition, digestOf, publicToolDefinition,
  toolVersionKey, versionSatisfies,
  type AgentDefinition, type AgentToolBinding, type PublicToolDefinition, type ToolDefinition,
  type ToolPermissionLevel, type ToolVersionRef,
} from '@lyra/shared';

export interface ToolAdapter {
  execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<unknown>;
}

export interface ToolExecutionContext {
  workspaceId: string;
  projectId: string | null;
  userId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  runId: string;
  stepId: string;
  toolCallId: string;
  requestId: string;
  /** 服务端已核验的权限；模型自述权限一律忽略。 */
  grantedPermissions: ToolPermissionLevel[];
  now: Date;
}

export interface ToolVisibilityRequest {
  agent: Pick<AgentDefinition, 'agentId' | 'allowedTools'>;
  grants: ToolPermissionLevel[];
  /** 当前 Workflow 阶段；workflow_only 工具只在该阶段显式授权时可见。 */
  workflow?: { stage: string; allowedToolIds: string[] } | null;
  budgetRemainingMicros?: number;
  disabledToolIds?: string[];
}

export interface ToolVisibility {
  tools: ToolDefinition[];
  denied: Array<{ toolId: string; version: string; reasonCode: string }>;
}

export interface RegistrySnapshot {
  tools: ToolVersionRef[];
  digest: string;
}

const ROLE_RANK: Record<'owner' | 'admin' | 'member' | 'viewer', number> = { viewer: 1, member: 2, admin: 3, owner: 4 };
const PERMISSION_RANK: Record<ToolPermissionLevel, number> = {
  workspace_read: 1, workspace_write: 2, workspace_admin: 3, platform_admin: 4,
};

function compareVersions(left: string, right: string): number {
  const [aMajor, aMinor, aPatch] = left.split('.').map(Number);
  const [bMajor, bMinor, bPatch] = right.split('.').map(Number);
  return (aMajor! - bMajor!) || (aMinor! - bMinor!) || (aPatch! - bPatch!);
}

export function roleSatisfies(role: 'owner' | 'admin' | 'member' | 'viewer', required: ToolPermissionLevel): boolean {
  if (required === 'platform_admin') return false;
  const rank = ROLE_RANK[role];
  if (required === 'workspace_admin') return rank >= 3;
  if (required === 'workspace_write') return rank >= 2;
  return rank >= 1;
}

/**
 * 版本化工具注册表。
 *
 * - 同一 toolId+version 只能有一个 manifest digest；内容变化必须升版本；
 * - 只暴露 frozen 工具给 Agent；
 * - 查询返回副本，调用方无法原地篡改 Registry。
 */
export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();
  private readonly adapters = new Map<string, ToolAdapter>();

  register(definition: ToolDefinition, adapter: ToolAdapter): void {
    assertToolDefinition(definition);
    const key = toolVersionKey(definition.toolId, definition.version);
    const existing = this.definitions.get(key);
    if (existing) {
      if (existing.manifestDigest !== definition.manifestDigest) {
        throw new AgentContractError(409, 'AGENT_TOOL_VERSION_IMMUTABLE', `工具 ${key} 已注册且内容不同，必须发布新版本。`);
      }
      if (this.adapters.get(key) !== adapter) {
        throw new AgentContractError(409, 'AGENT_TOOL_ADAPTER_CONFLICT', `工具 ${key} 的 Adapter 已绑定，不能原地替换。`);
      }
      return;
    }
    this.definitions.set(key, definition);
    this.adapters.set(key, adapter);
  }

  has(toolId: string, version: string): boolean {
    return this.definitions.has(toolVersionKey(toolId, version));
  }

  /** 按范围解析最高可用版本；冻结 snapshot 时把范围收敛成精确版本。 */
  resolveRange(toolId: string, range: string): ToolDefinition {
    const candidates = [...this.definitions.values()]
      .filter(definition => definition.toolId === toolId && definition.status !== 'disabled' && definition.status !== 'draft')
      .filter(definition => versionSatisfies(definition.version, range))
      .sort((left, right) => compareVersions(right.version, left.version));
    const best = candidates[0];
    if (!best) throw new AgentContractError(404, 'AGENT_TOOL_VERSION_UNAVAILABLE', `工具 ${toolId} 在范围 ${range} 内没有可用版本。`);
    return best;
  }

  find(toolId: string, version: string): ToolDefinition | undefined {
    return this.definitions.get(toolVersionKey(toolId, version));
  }

  /** 按 manifest digest 精确解析；digest 不匹配说明版本漂移，直接拒绝。 */
  resolve(ref: ToolVersionRef): ToolDefinition {
    const definition = this.find(ref.toolId, ref.version);
    if (!definition) throw new AgentContractError(404, 'AGENT_TOOL_UNKNOWN', `工具未注册：${toolVersionKey(ref.toolId, ref.version)}。`);
    if (definition.manifestDigest !== ref.manifestDigest) {
      throw new AgentContractError(409, 'AGENT_TOOL_MANIFEST_MISMATCH', `工具 ${ref.toolId}@${ref.version} 的 manifest 已变化，运行必须使用冻结版本。`);
    }
    return definition;
  }

  adapterFor(ref: ToolVersionRef): ToolAdapter {
    const adapter = this.adapters.get(toolVersionKey(ref.toolId, ref.version));
    if (!adapter) throw new AgentContractError(503, 'AGENT_TOOL_ADAPTER_UNAVAILABLE', `工具 ${ref.toolId} 没有可用 Adapter。`);
    return adapter;
  }

  all(): ToolDefinition[] {
    return [...this.definitions.values()]
      .filter(definition => definition.status !== 'disabled' && definition.status !== 'draft')
      .sort((left, right) => toolVersionKey(left.toolId, left.version).localeCompare(toolVersionKey(right.toolId, right.version)));
  }

  /** 冻结当前 Registry 的 Tool manifest 列表，用于写入 AgentRun snapshot。 */
  snapshot(tools: ToolDefinition[]): RegistrySnapshot {
    const refs = tools
      .map(tool => ({ toolId: tool.toolId, version: tool.version, manifestDigest: tool.manifestDigest }))
      .sort((left, right) => toolVersionKey(left.toolId, left.version).localeCompare(toolVersionKey(right.toolId, right.version)));
    return { tools: refs, digest: digestOf({ tools: refs }) };
  }

  /**
   * 三层收敛中的第一、二层：Agent 静态 allowlist + 运行时权限/阶段/预算裁剪。
   * 第三层（每次提案的最终校验）由 ToolKernel 再做，不能依赖这里。
   */
  visibleFor(request: ToolVisibilityRequest): ToolVisibility {
    const denied: ToolVisibility['denied'] = [];
    const granted = new Set(request.grants);
    const disabled = new Set(request.disabledToolIds ?? []);
    const selected: ToolDefinition[] = [];
    for (const binding of request.agent.allowedTools) {
      const versions = [...this.definitions.values()]
        .filter(definition => definition.toolId === binding.toolId)
        .sort((left, right) => right.version.localeCompare(left.version));
      if (versions.length === 0) {
        denied.push({ toolId: binding.toolId, version: binding.range, reasonCode: 'AGENT_TOOL_UNKNOWN' });
        continue;
      }
      const candidates = versions.filter(definition => {
        try { return versionSatisfies(definition.version, binding.range); }
        catch { return false; }
      });
      if (candidates.length === 0) {
        denied.push({ toolId: binding.toolId, version: binding.range, reasonCode: 'AGENT_TOOL_VERSION_UNAVAILABLE' });
        continue;
      }
      const definition = candidates[0]!;
      if (definition.status !== 'frozen') {
        denied.push({ toolId: definition.toolId, version: definition.version, reasonCode: 'AGENT_TOOL_NOT_FROZEN' });
        continue;
      }
      if (disabled.has(definition.toolId)) {
        denied.push({ toolId: definition.toolId, version: definition.version, reasonCode: 'AGENT_TOOL_DISABLED' });
        continue;
      }
      if (!definition.allowedAgentIds.includes(request.agent.agentId)) {
        denied.push({ toolId: definition.toolId, version: definition.version, reasonCode: 'AGENT_TOOL_NOT_ALLOWED_FOR_AGENT' });
        continue;
      }
      if (definition.executionOwner === 'runtime_internal') {
        denied.push({ toolId: definition.toolId, version: definition.version, reasonCode: 'AGENT_TOOL_RUNTIME_INTERNAL' });
        continue;
      }
      if (definition.executionOwner === 'workflow_only') {
        const workflow = request.workflow;
        if (!workflow || !workflow.allowedToolIds.includes(definition.toolId)) {
          denied.push({ toolId: definition.toolId, version: definition.version, reasonCode: 'AGENT_TOOL_WORKFLOW_ONLY' });
          continue;
        }
      }
      if (!granted.has(definition.requiredPermission) && ![...granted].some(permission => PERMISSION_RANK[permission] >= PERMISSION_RANK[definition.requiredPermission])) {
        denied.push({ toolId: definition.toolId, version: definition.version, reasonCode: 'AGENT_TOOL_PERMISSION_REQUIRED' });
        continue;
      }
      if (definition.cost && request.budgetRemainingMicros !== undefined && definition.cost.estimateMicros > request.budgetRemainingMicros) {
        denied.push({ toolId: definition.toolId, version: definition.version, reasonCode: 'AGENT_BUDGET_INSUFFICIENT' });
        continue;
      }
      selected.push(definition);
    }
    return { tools: selected, denied };
  }

  /** 模型侧只看到公开字段；Adapter、Secret 引用、Provider Host 不进入 Prompt。 */
  modelDefinitions(tools: ToolDefinition[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.toolId.replaceAll('.', '_'),
        description: `[${tool.toolId}@${tool.version}] ${tool.displayName}：${tool.description}`,
        parameters: tool.inputSchema,
      },
    }));
  }

  publicView(tool: ToolDefinition): PublicToolDefinition {
    return publicToolDefinition(tool);
  }
}

export type { AgentToolBinding };
