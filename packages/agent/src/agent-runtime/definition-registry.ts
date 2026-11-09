import {
  AgentContractError, assertAgentDefinition, digestOf, isTerminalAgentState,
  type AgentDefinition, type AgentLimits, type AgentStatus, type AgentToolBinding, type FrozenAgentSnapshot,
  type JsonObject, type ToolPermissionLevel, type ToolSensitivity, type ToolVersionRef,
} from '@lyra/shared';
import { roleSatisfies, type ToolRegistry } from '../kernel/tool-registry';

/**
 * AgentDefinition 注册与冻结快照。
 *
 * - draft 可以反复修改，但永远不能创建 Run；
 * - freeze 后 manifestDigest 固定，任何字段变化都必须发布新版本；
 * - Snapshot 把 Agent / Prompt / 方法包 / 模型连接 / 工具精确版本 / Workflow / Code
 *   一次性钉死，运行期只读这份快照。
 */

export interface CreateAgentDefinitionInput {
  agentId: string;
  version: string;
  displayName: string;
  domain: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  promptRevisionDigest: string;
  methodProfileRevisionId: string | null;
  methodProfileDigest: string | null;
  allowedTools: AgentToolBinding[];
  allowedChildAgentIds: string[];
  limits: AgentLimits;
  requiredPermissions: ToolPermissionLevel[];
  sensitivity: { input: ToolSensitivity; output: ToolSensitivity };
  codeDigest: string;
}

export interface SnapshotInput {
  workspaceId: string;
  projectId: string | null;
  userId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  parentRunId: string | null;
  productionRunId: string | null;
  workflowTaskId: string | null;
  agentId: string;
  agentVersion: string;
  inputRevisions: Array<{ kind: string; id: string; digest: string }>;
  prompt: { revisionDigest: string };
  method: { profileRevisionId: string | null; profileDigest: string | null; packVersionIds: string[] };
  model: { connectionRevision: string; model: string };
  workflow: { version: string; digest: string } | null;
  code: { buildDigest: string };
  budget: { maxMicros: number; currency: string };
  timeout: { stepMs: number; runMs: number };
  maxSteps: number;
  seed: string | null;
  now?: string;
}

export class AgentDefinitionRegistry {
  private readonly versions = new Map<string, AgentDefinition>();
  private readonly toolRegistry: ToolRegistry;

  constructor(toolRegistry: ToolRegistry) {
    this.toolRegistry = toolRegistry;
  }

  create(input: CreateAgentDefinitionInput): AgentDefinition {
    const definition = buildDefinition(input, 'draft');
    assertAgentDefinition(definition);
    const key = definitionKey(definition.agentId, definition.version);
    if (this.versions.has(key)) throw new AgentContractError(409, 'AGENT_DEFINITION_EXISTS', `Agent ${key} 已存在，不能覆盖。`);
    this.versions.set(key, Object.freeze(definition));
    return structuredClone(definition);
  }

  freeze(agentId: string, version: string, expectedManifestDigest: string, now?: string): AgentDefinition {
    const key = definitionKey(agentId, version);
    const current = this.versions.get(key);
    if (!current) throw new AgentContractError(404, 'AGENT_DEFINITION_NOT_FOUND', `Agent ${key} 不存在。`);
    if (current.status !== 'draft') throw new AgentContractError(409, 'AGENT_DEFINITION_NOT_DRAFT', '只有 draft 定义可以冻结。');
    if (current.manifestDigest !== expectedManifestDigest) {
      throw new AgentContractError(409, 'AGENT_DEFINITION_DIGEST_MISMATCH', 'Agent 定义已被修改，请刷新后重试。');
    }
    this.assertReferencedAgents(current);
    const frozen = buildDefinition(current, 'frozen', now ?? new Date().toISOString());
    this.versions.set(key, Object.freeze(frozen));
    return structuredClone(frozen);
  }

  get(agentId: string, version: string): AgentDefinition | null {
    const definition = this.versions.get(definitionKey(agentId, version));
    return definition ? structuredClone(definition) : null;
  }

  runnable(agentId: string, version: string, manifestDigest: string): AgentDefinition {
    const definition = this.versions.get(definitionKey(agentId, version));
    if (!definition) throw new AgentContractError(404, 'AGENT_DEFINITION_NOT_FOUND', `Agent ${agentId}@${version} 不存在。`);
    if (definition.status !== 'frozen') throw new AgentContractError(409, 'AGENT_DEFINITION_NOT_FROZEN', '只有 frozen 定义可以创建生产 Run。');
    if (definition.manifestDigest !== manifestDigest) {
      throw new AgentContractError(409, 'AGENT_DEFINITION_MANIFEST_MISMATCH', 'Agent 定义 manifest 与冻结值不一致。');
    }
    return structuredClone(definition);
  }

  list(): AgentDefinition[] {
    return [...this.versions.values()].map(definition => structuredClone(definition));
  }

  /** 冻结快照：运行期唯一可信输入。 */
  snapshot(input: SnapshotInput): FrozenAgentSnapshot {
    const definition = this.runnable(input.agentId, input.agentVersion, this.requireManifest(input.agentId, input.agentVersion));
    if (definition.promptRevisionDigest !== input.prompt.revisionDigest) {
      throw new AgentContractError(409, 'AGENT_SNAPSHOT_PROMPT_MISMATCH', 'Prompt revision 与 Agent 冻结值不一致。');
    }
    if (definition.methodProfileRevisionId !== input.method.profileRevisionId
      || (definition.methodProfileDigest ?? null) !== input.method.profileDigest) {
      throw new AgentContractError(409, 'AGENT_SNAPSHOT_METHOD_MISMATCH', '方法包 Profile 与 Agent 冻结值不一致。');
    }
    if (definition.codeDigest !== input.code.buildDigest) {
      throw new AgentContractError(409, 'AGENT_SNAPSHOT_CODE_MISMATCH', '代码构建摘要与 Agent 冻结值不一致。');
    }
    if (!input.model.connectionRevision || !input.model.model) {
      throw new AgentContractError(400, 'AGENT_SNAPSHOT_MODEL_REQUIRED', '必须冻结模型连接 revision 与模型名。');
    }
    if (input.maxSteps < 1 || input.maxSteps > definition.limits.maxSteps) {
      throw new AgentContractError(400, 'AGENT_SNAPSHOT_STEP_LIMIT_INVALID', 'Run 最大步数超过 Agent 限额。');
    }
    if (input.budget.maxMicros < 0 || input.budget.maxMicros > definition.limits.maxBudgetMicros) {
      throw new AgentContractError(400, 'AGENT_SNAPSHOT_BUDGET_INVALID', 'Run 预算超过 Agent 限额。');
    }
    if (input.timeout.stepMs < 1 || input.timeout.runMs < input.timeout.stepMs
      || input.timeout.stepMs > definition.limits.stepTimeoutMs
      || input.timeout.runMs > definition.limits.runTimeoutMs) {
      throw new AgentContractError(400, 'AGENT_SNAPSHOT_TIMEOUT_INVALID', 'Run 超时超过 Agent 限额。');
    }
    const tools = this.resolveSnapshotTools(definition, input);

    const payload = {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      userId: input.userId,
      role: input.role,
      parentRunId: input.parentRunId,
      productionRunId: input.productionRunId,
      workflowTaskId: input.workflowTaskId,
      agent: { agentId: definition.agentId, version: definition.version, manifestDigest: definition.manifestDigest },
      inputRevisions: [...input.inputRevisions].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)),
      prompt: input.prompt,
      method: {
        profileRevisionId: input.method.profileRevisionId,
        profileDigest: input.method.profileDigest,
        packVersionIds: [...input.method.packVersionIds].sort(),
      },
      model: input.model,
      tools,
      workflow: input.workflow,
      code: input.code,
      budget: input.budget,
      timeout: input.timeout,
      maxSteps: input.maxSteps,
      seed: input.seed,
      createdAt: input.now ?? new Date().toISOString(),
    };
    const contextSnapshotDigest = digestOf(payload);
    return Object.freeze({ ...payload, contextSnapshotDigest }) as FrozenAgentSnapshot;
  }

  private resolveSnapshotTools(definition: AgentDefinition, input: SnapshotInput): ToolVersionRef[] {
    const tools: ToolVersionRef[] = [];
    for (const binding of definition.allowedTools) {
      const tool = this.toolRegistry.resolveRange(binding.toolId, binding.range);
      if (!tool.allowedAgentIds.includes(definition.agentId)) {
        throw new AgentContractError(403, 'AGENT_TOOL_NOT_ALLOWED_FOR_AGENT', `工具 ${tool.toolId}@${tool.version} 未授权给 Agent ${definition.agentId}。`);
      }
      if (tool.sideEffect === 'paid_external' && !input.workflowTaskId) {
        throw new AgentContractError(409, 'AGENT_TOOL_PAID_REQUIRES_WORKFLOW', '付费工具必须挂在 Workflow 任务下冻结。');
      }
      if (tool.executionOwner === 'workflow_only') {
        if (!input.workflowTaskId || !tool.allowedWorkflowIds.includes(input.workflowTaskId)) {
          throw new AgentContractError(403, 'AGENT_TOOL_WORKFLOW_ONLY', `工具 ${tool.toolId} 只能在授权 Workflow 内使用。`);
        }
      }
      if (!roleSatisfies(input.role, tool.requiredPermission)) {
        throw new AgentContractError(403, 'AGENT_TOOL_PERMISSION_REQUIRED', `当前角色无权使用工具 ${tool.toolId}。`);
      }
      tools.push({ toolId: tool.toolId, version: tool.version, manifestDigest: tool.manifestDigest });
    }
    return tools.sort((left, right) => `${left.toolId}@${left.version}`.localeCompare(`${right.toolId}@${right.version}`));
  }

  private requireManifest(agentId: string, version: string): string {
    const definition = this.versions.get(definitionKey(agentId, version));
    if (!definition) throw new AgentContractError(404, 'AGENT_DEFINITION_NOT_FOUND', `Agent ${agentId}@${version} 不存在。`);
    return definition.manifestDigest;
  }

  private assertReferencedAgents(definition: AgentDefinition): void {
    for (const childId of definition.allowedChildAgentIds) {
      const exists = [...this.versions.values()].some(candidate =>
        candidate.agentId === childId && (candidate.status === 'frozen' || candidate.status === 'draft'));
      if (!exists) throw new AgentContractError(404, 'AGENT_CHILD_DEFINITION_NOT_FOUND', `子 Agent 未定义：${childId}。`);
    }
  }
}

/** 允许 deprecated 被读，但不能被新 Run 使用；disable 后彻底退出。 */
export function assertAgentStatusUsable(status: AgentStatus): void {
  if (status !== 'frozen') throw new AgentContractError(409, 'AGENT_DEFINITION_NOT_FROZEN', 'Agent 定义当前不可运行。');
  if (isTerminalAgentState('succeeded')) return; // 明确 AgentStatus 与 Run 终态互不复用
}

function buildDefinition(
  input: CreateAgentDefinitionInput | AgentDefinition,
  status: AgentStatus,
  frozenAt?: string,
): AgentDefinition {
  const base: AgentDefinition = {
    agentId: input.agentId,
    version: input.version,
    displayName: input.displayName,
    domain: input.domain,
    description: input.description,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    inputSchemaDigest: digestOf(input.inputSchema),
    outputSchemaDigest: digestOf(input.outputSchema),
    manifestDigest: '',
    promptRevisionDigest: input.promptRevisionDigest,
    methodProfileRevisionId: input.methodProfileRevisionId,
    methodProfileDigest: input.methodProfileDigest,
    allowedTools: [...input.allowedTools],
    allowedChildAgentIds: [...input.allowedChildAgentIds],
    limits: { ...input.limits },
    requiredPermissions: [...input.requiredPermissions],
    sensitivity: { ...input.sensitivity },
    codeDigest: input.codeDigest,
    status,
    ...(frozenAt ? { frozenAt } : {}),
  };
  base.manifestDigest = digestOf(agentManifestPayload(base));
  return base;
}

export function computeAgentManifestDigest(definition: AgentDefinition): string {
  return digestOf(agentManifestPayload(definition));
}

function agentManifestPayload(definition: AgentDefinition): JsonObject {
  return {
    agentId: definition.agentId,
    version: definition.version,
    displayName: definition.displayName,
    domain: definition.domain,
    description: definition.description,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    inputSchemaDigest: definition.inputSchemaDigest,
    outputSchemaDigest: definition.outputSchemaDigest,
    promptRevisionDigest: definition.promptRevisionDigest,
    methodProfileRevisionId: definition.methodProfileRevisionId,
    methodProfileDigest: definition.methodProfileDigest,
    allowedTools: [...definition.allowedTools].sort((left, right) => `${left.toolId}@${left.range}`.localeCompare(`${right.toolId}@${right.range}`)),
    allowedChildAgentIds: [...definition.allowedChildAgentIds].sort(),
    limits: definition.limits,
    requiredPermissions: [...definition.requiredPermissions].sort(),
    sensitivity: definition.sensitivity,
    codeDigest: definition.codeDigest,
    status: definition.status,
  };
}

function definitionKey(agentId: string, version: string): string {
  return `${agentId}@${version}`;
}
