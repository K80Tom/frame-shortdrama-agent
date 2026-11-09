import { defineTool, digestOf, type ToolDefinition } from '@lyra/shared';
import { ToolRegistry } from '../kernel/tool-registry';
import { AssistantError } from './contracts';

/**
 * 助手工具端口：由 main.ts 用真实的领域服务适配。
 * 端口本身就必须只返回可公开、已裁剪的字段；这里再做一次体积护栏。
 */
export interface AssistantToolPorts {
  listProjects?(): Promise<Array<Record<string, unknown>>>;
  listProductionRuns?(): Promise<Array<Record<string, unknown>>>;
  getProductionRun?(runId: string): Promise<Record<string, unknown>>;
  listAssets?(): Promise<Array<Record<string, unknown>>>;
}

export interface AssistantToolDefinition {
  name: string;
  description: string;
  /** 参数仅支持一个可选字符串，避免模型拼接复杂条件。 */
  argument?: { name: string; description: string; required: boolean };
}

/** 工具白名单。模型只能点名这里的工具，绝不允许执行自造名称或任意代码。 */
export const ASSISTANT_TOOLS: readonly AssistantToolDefinition[] = Object.freeze([
  { name: 'list_projects', description: '列出本机短剧项目（ID、标题、最近更新），用于回答“我有哪些项目”。' },
  { name: 'list_production_runs', description: '列出自动制片运行及其状态，用于回答“跑到哪一步了/哪些失败”。' },
  { name: 'get_production_run', description: '查看单个自动制片运行的阶段、任务与阻断原因。',
    argument: { name: 'runId', description: '运行 ID', required: true } },
  { name: 'list_assets', description: '列出已登记的资产（角色/场景/道具等），用于回答资产是否已准备。' },
]);

const MAX_ITEMS = 20;
const MAX_OBSERVATION_CHARS = 6000;

function clip(value: unknown): string {
  const text = JSON.stringify(value);
  if (text.length <= MAX_OBSERVATION_CHARS) return text;
  return `${text.slice(0, MAX_OBSERVATION_CHARS)}…（结果过长已截断）`;
}

function missing(tool: string): never {
  throw new AssistantError(503, 'ASSISTANT_TOOL_UNAVAILABLE', `「${tool}」依赖的本机服务尚未就绪，请先在对应页面完成配置与迁移。`);
}

export async function executeAssistantTool(
  ports: AssistantToolPorts, name: string, args: Record<string, unknown>,
): Promise<{ observation: string; itemCount?: number }> {
  switch (name) {
    case 'list_projects': {
      if (!ports.listProjects) missing('项目查询');
      const items = await ports.listProjects();
      return { observation: clip({ total: items.length, items: items.slice(0, MAX_ITEMS) }), itemCount: items.length };
    }
    case 'list_production_runs': {
      if (!ports.listProductionRuns) missing('运行查询');
      const items = await ports.listProductionRuns();
      return { observation: clip({ total: items.length, items: items.slice(0, MAX_ITEMS) }), itemCount: items.length };
    }
    case 'get_production_run': {
      if (!ports.getProductionRun) missing('运行查询');
      const runId = args.runId;
      if (typeof runId !== 'string' || !runId.trim()) {
        throw new AssistantError(400, 'ASSISTANT_TOOL_ARGUMENT_INVALID', '查询运行需要提供 runId。');
      }
      const run = await ports.getProductionRun(runId.trim());
      return { observation: clip(run) };
    }
    case 'list_assets': {
      if (!ports.listAssets) missing('资产查询');
      const items = await ports.listAssets();
      return { observation: clip({ total: items.length, items: items.slice(0, MAX_ITEMS) }), itemCount: items.length };
    }
    default:
      // 模型发明了工具名：不执行，如实回报，让它改用白名单工具或直接回答。
      throw new AssistantError(400, 'ASSISTANT_TOOL_UNKNOWN', `不支持的工具「${name}」。可用工具：${ASSISTANT_TOOLS.map(tool => tool.name).join('、')}。`);
  }
}

/**
 * 版本化 Tool Definition：旧 `ASSISTANT_TOOLS` 保持给 Prompt 使用，
 * 这里提供带 schema、副作用、权限与幂等声明的不可变定义，供 Registry 冻结。
 */
function assistantDefinition(input: {
  name: string; description: string; argument?: { name: string; description: string };
}): ToolDefinition {
  const properties = input.argument
    ? { [input.argument.name]: { type: 'string' as const, minLength: 1, maxLength: 128, description: input.argument.description } }
    : {};
  return defineTool({
    toolId: input.name,
    version: '1.0.0',
    displayName: input.name,
    description: input.description,
    ownerDomain: 'assistant',
    inputSchema: {
      type: 'object',
      properties,
      required: input.argument ? [input.argument.name] : [],
      additionalProperties: false,
    },
    outputSchema: { type: 'object', properties: {}, additionalProperties: true },
    sideEffect: 'none',
    executionOwner: 'agent_selectable',
    requiredPermission: 'workspace_read',
    allowedAgentIds: ['project-copilot'],
    allowedWorkflowIds: [],
    sensitivity: { input: 'internal', output: 'internal' },
    cost: null,
    idempotency: { strategy: 'tool_call_id', keyVersion: 1 },
    retry: { timeoutMs: 15_000, maxAttempts: 1, backoffMs: 0, retryableCodes: [], unknownCodes: [] },
    capability: { async: false, reconcile: false, cancel: false },
    providers: { hosts: [], modelConnections: [] },
    limits: { maxInputBytes: 1024, maxOutputBytes: 8 * 1024, maxItems: 20 },
    produces: { entities: [], revisions: [], artifacts: [], evidence: [], events: [] },
    adapterDigest: digestOf({ adapter: 'assistant-tools', version: '1.0.0' }),
    status: 'frozen',
    frozenAt: '2024-01-01T00:00:00.000Z',
  });
}

export const ASSISTANT_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze(
  ASSISTANT_TOOLS.map(tool => assistantDefinition({
    name: tool.name, description: tool.description,
    ...(tool.argument ? { argument: { name: tool.argument.name, description: tool.argument.description } } : {}),
  })),
);

/** 构造绑定真实 Port 的 Registry；Adapter 仍然只走既有的安全执行入口。 */
export function createAssistantToolRegistry(ports: AssistantToolPorts): ToolRegistry {
  const registry = new ToolRegistry();
  for (const definition of ASSISTANT_TOOL_DEFINITIONS) {
    registry.register(definition, {
      execute: async (args) => {
        const result = await executeAssistantTool(ports, definition.toolId, args);
        return { summary: result.observation, data: JSON.parse(result.observation) };
      },
    });
  }
  return registry;
}
