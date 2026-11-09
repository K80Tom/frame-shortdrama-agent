import { AgentContractError, type JsonObject, type PublicToolDefinition, type ToolDefinition } from '@lyra/shared';
import type { ProductionToolExecutor, ToolExecutionContext } from '@lyra/agent';

export interface ProjectReader {
  getProject(projectId: string): Promise<{ title: string; currentScriptVersionId?: string | null;
    activeStoryboardRevisionId?: string | null } | null>;
}
export interface RunReader {
  list(): Promise<{ runs: Array<Record<string, unknown>> }>;
  get(runId: string): Promise<JsonObject>;
}
export interface AssetReader {
  list(): Promise<unknown[]>;
  get(assetId: string): Promise<unknown>;
}
export interface ProductionToolReadDependencies {
  projects?: ProjectReader;
  productionRuns?: RunReader;
  assets?: AssetReader;
}

/**
 * 生产 Tool 的 main 侧执行分发。
 *
 * 只读工具直接复用现有 Service；草稿/付费工具没有稳定写端口时 fail closed，
 * 绝不伪造成功、绝不自动提交供应商。这样 Registry 可以先行发布 manifest，
 * 而执行权限仍由真实领域 Service 的接线进度决定。
 */
export class ProductionToolService implements ProductionToolExecutor {
  constructor(private readonly dependencies: ProductionToolReadDependencies) {}

  async execute(toolId: string, args: JsonObject, context: ToolExecutionContext): Promise<unknown> {
    switch (toolId) {
      case 'get_project_context': return this.projectContext(args, context);
      case 'get_current_revisions': return this.currentRevisions(args, context);
      case 'get_run_issues': return this.runIssues(args);
      default:
        throw new AgentContractError(503, 'PRODUCTION_TOOL_SOURCE_UNAVAILABLE',
          `工具「${toolId}」的领域写端口尚未接入；不会伪造草稿、资产或付费提交。`);
    }
  }

  private projectId(args: JsonObject): string {
    if (typeof args.projectId !== 'string' || !args.projectId.trim()) {
      throw new AgentContractError(400, 'PRODUCTION_TOOL_ARGUMENT_INVALID', '需要 projectId。');
    }
    return args.projectId;
  }

  private async projectContext(args: JsonObject, context: { workspaceId: string }): Promise<JsonObject> {
    if (!this.dependencies.projects) {
      throw new AgentContractError(503, 'PRODUCTION_TOOL_SOURCE_UNAVAILABLE', '项目读取端口未接入。');
    }
    const projectId = this.projectId(args);
    const project = await this.dependencies.projects.getProject(projectId);
    if (!project) throw new AgentContractError(404, 'PROJECT_NOT_FOUND', '项目不存在。');
    const runs = this.dependencies.productionRuns ? (await this.dependencies.productionRuns.list()).runs : [];
    const projectRuns = runs.filter(run => run.projectId === projectId);
    const assets = this.dependencies.assets ? await this.dependencies.assets.list() : [];
    return {
      workspaceId: context.workspaceId, projectId, title: project.title,
      currentScriptVersionId: project.currentScriptVersionId ?? null,
      activeStoryboardRevisionId: project.activeStoryboardRevisionId ?? null,
      productionRunCount: projectRuns.length,
      productionRunIds: projectRuns.map(run => run.id).slice(0, 10),
      assetCount: assets.length,
    };
  }

  private async currentRevisions(args: JsonObject, context: { workspaceId: string }): Promise<JsonObject> {
    if (!this.dependencies.projects) {
      throw new AgentContractError(503, 'PRODUCTION_TOOL_SOURCE_UNAVAILABLE', '项目读取端口未接入。');
    }
    const projectId = this.projectId(args);
    const project = await this.dependencies.projects.getProject(projectId);
    if (!project) throw new AgentContractError(404, 'PROJECT_NOT_FOUND', '项目不存在。');
    return {
      workspaceId: context.workspaceId, projectId,
      scriptVersionId: project.currentScriptVersionId ?? null,
      storyboardRevisionId: project.activeStoryboardRevisionId ?? null,
    };
  }

  private async runIssues(args: JsonObject): Promise<JsonObject> {
    if (!this.dependencies.productionRuns) {
      throw new AgentContractError(503, 'PRODUCTION_TOOL_SOURCE_UNAVAILABLE', '生产运行读取端口未接入。');
    }
    if (typeof args.runId !== 'string' || !args.runId.trim()) {
      throw new AgentContractError(400, 'PRODUCTION_TOOL_ARGUMENT_INVALID', '需要 runId。');
    }
    const run = await this.dependencies.productionRuns.get(args.runId);
    const issues = Array.isArray(run.issues) ? run.issues : [];
    return { runId: args.runId, status: run.status ?? null, issues };
  }
}

/** 公开视图只暴露版本、权限、副作用和 Schema，不含 Adapter 摘要与密钥引用。 */
export class ToolRegistryViewService {
  constructor(private readonly listDefinitions: () => ToolDefinition[],
    private readonly publicView: (definition: ToolDefinition) => PublicToolDefinition) {}

  list(): Array<PublicToolDefinition & { schema: { input: unknown; output: unknown } }> {
    return this.listDefinitions().map(definition => ({
      ...this.publicView(definition),
      schema: { input: definition.inputSchema, output: definition.outputSchema },
    }));
  }

  get(toolId: string, version: string): PublicToolDefinition | null {
    const definition = this.listDefinitions().find(item => item.toolId === toolId && item.version === version);
    return definition ? this.publicView(definition) : null;
  }
}
