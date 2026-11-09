import {
  defineTool, digestOf,
  type JsonObject, type ToolDefinition, type ToolJsonSchema, type ToolPermissionLevel,
  type ToolSideEffect,
} from '@lyra/shared';

/**
 * 生产领域 Tool 目录（19 个）。
 *
 * 这里只定义不可变 manifest 与输入/输出 Schema，不实现 Adapter、不连接数据库、
 * 不读取密钥。真实执行由 main 注入 ProductionToolExecutor。
 *
 * 版本纪律：任何字段变化都必须发布新的 semver；已冻结版本不得原地修改。
 */

const SCHEMA_VERSION = '1.0.0';
const FROZEN_AT = '2026-11-09T00:00:00.000Z';
const AGENT = 'project-copilot';
const WORKFLOW = 'production';

const object = (properties: Record<string, ToolJsonSchema>, required: string[] = []): ToolJsonSchema => ({
  type: 'object', properties, required, additionalProperties: false,
});
const text = (description: string, maxLength = 200): ToolJsonSchema => ({
  type: 'string', minLength: 1, maxLength, description,
});
const optionalText = (description: string, maxLength = 200): ToolJsonSchema => ({
  type: 'string', maxLength, description,
});
const id = (description: string): ToolJsonSchema => text(description, 128);
const count = (description: string): ToolJsonSchema => ({
  type: 'integer', minimum: 1, maximum: 100, description,
});
const output = object({});

interface CatalogEntry {
  toolId: string;
  displayName: string;
  description: string;
  ownerDomain: string;
  inputSchema: ToolJsonSchema;
  outputSchema: ToolJsonSchema;
  sideEffect: ToolSideEffect;
  executionOwner: 'agent_selectable' | 'workflow_only' | 'runtime_internal';
  requiredPermission: ToolPermissionLevel;
  allowedAgents: string[];
  allowedWorkflows: string[];
  cost: ToolDefinition['cost'];
  timeoutMs: number;
  maxInputBytes: number;
  produces: ToolDefinition['produces'];
}

const READ = { sideEffect: 'none' as const, executionOwner: 'agent_selectable' as const,
  requiredPermission: 'workspace_read' as const, allowedAgents: [AGENT], allowedWorkflows: [],
  cost: null, timeoutMs: 15_000, maxInputBytes: 4 * 1024 };
const DRAFT = { sideEffect: 'internal_write' as const, executionOwner: 'agent_selectable' as const,
  requiredPermission: 'workspace_write' as const, allowedAgents: [AGENT], allowedWorkflows: [],
  cost: null, timeoutMs: 30_000, maxInputBytes: 16 * 1024 };
const WORKFLOW_ONLY = { sideEffect: 'paid_external' as const, executionOwner: 'workflow_only' as const,
  requiredPermission: 'workspace_write' as const, allowedAgents: [], allowedWorkflows: [WORKFLOW],
  cost: { estimatorRevision: 'estimate/v1', budgetDimension: 'money' as const,
    estimateMicros: 0, currency: 'CNY' }, timeoutMs: 5 * 60 * 1000, maxInputBytes: 8 * 1024 };

function productionTool(entry: CatalogEntry): ToolDefinition {
  return defineTool({
    toolId: entry.toolId,
    version: SCHEMA_VERSION,
    displayName: entry.displayName,
    description: entry.description,
    ownerDomain: entry.ownerDomain,
    inputSchema: entry.inputSchema,
    outputSchema: entry.outputSchema,
    sideEffect: entry.sideEffect,
    executionOwner: entry.executionOwner,
    requiredPermission: entry.requiredPermission,
    allowedAgentIds: entry.allowedAgents,
    allowedWorkflowIds: entry.allowedWorkflows,
    sensitivity: { input: 'internal', output: 'internal' },
    cost: entry.cost,
    idempotency: { strategy: entry.sideEffect === 'none' ? 'tool_call_id' : 'client_request_id', keyVersion: 1 },
    retry: { timeoutMs: entry.timeoutMs, maxAttempts: 1, backoffMs: 0,
      retryableCodes: [], unknownCodes: entry.sideEffect === 'paid_external' ? ['PROVIDER_UNKNOWN'] : [] },
    capability: { async: entry.sideEffect === 'paid_external', reconcile: entry.sideEffect === 'paid_external', cancel: false },
    providers: { hosts: [], modelConnections: [] },
    limits: { maxInputBytes: entry.maxInputBytes, maxOutputBytes: 32 * 1024, maxItems: 50 },
    produces: entry.produces,
    adapterDigest: digestOf({ adapter: 'production-tools', version: SCHEMA_VERSION }),
    status: 'frozen',
    frozenAt: FROZEN_AT,
  });
}

export const PRODUCTION_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  productionTool({
    toolId: 'get_project_context', displayName: '项目上下文', ownerDomain: 'project',
    description: '读取项目标题、当前剧本/分镜 revision、活动生产运行与预算摘要。',
    inputSchema: object({ projectId: id('项目 ID') }, ['projectId']), outputSchema: output,
    ...READ, produces: { entities: ['project'], revisions: [], artifacts: [], evidence: [], events: [] },
  }),
  productionTool({
    toolId: 'get_current_revisions', displayName: '当前版本', ownerDomain: 'project',
    description: '读取项目当前采用的剧本、分镜、资产包与导演场景 revision，不返回历史全文。',
    inputSchema: object({ projectId: id('项目 ID') }, ['projectId']), outputSchema: output,
    ...READ, produces: { entities: [], revisions: ['script', 'storyboard', 'asset_pack', 'director_scene'], artifacts: [], evidence: [], events: [] },
  }),
  productionTool({
    toolId: 'get_run_issues', displayName: '运行问题', ownerDomain: 'production',
    description: '读取生产运行的阻断、失败、待人工确认与对账问题。',
    inputSchema: object({ runId: id('生产运行 ID'), severity: optionalText('可选严重级别') }, ['runId']),
    outputSchema: output, ...READ,
    produces: { entities: ['production_issue'], revisions: [], artifacts: [], evidence: [], events: [] },
  }),
  productionTool({
    toolId: 'get_budget_status', displayName: '预算状态', ownerDomain: 'production',
    description: '读取 Workspace/项目/运行的预算上限、已预留、已结算与剩余额度。',
    inputSchema: object({ projectId: optionalText('可选项目 ID'), runId: optionalText('可选运行 ID') }), outputSchema: output,
    ...READ, produces: { entities: ['budget'], revisions: [], artifacts: [], evidence: [], events: [] },
  }),
  productionTool({
    toolId: 'get_novel_segments', displayName: '小说片段', ownerDomain: 'novel',
    description: '读取小说源与章节段落摘要，供拆解与剧本引用；不返回未授权全文。',
    inputSchema: object({ projectId: id('项目 ID'), chapterId: optionalText('可选章节 ID'), limit: count('返回条数') },
      ['projectId']), outputSchema: output, ...READ,
    produces: { entities: ['novel_source', 'novel_chapter'], revisions: [], artifacts: [], evidence: [], events: [] },
  }),
  productionTool({
    toolId: 'create_screenplay_revision_draft', displayName: '剧本草稿', ownerDomain: 'script',
    description: '基于已冻结小说片段创建剧本 revision 草稿；只草稿，不采用、不付费。',
    inputSchema: object({ projectId: id('项目 ID'), sourceRevisionId: optionalText('小说/剧本来源 revision'),
      title: text('草稿标题'), content: text('剧本文本', 8000) }, ['projectId', 'title', 'content']),
    outputSchema: output, ...DRAFT,
    produces: { entities: ['screenplay_revision'], revisions: ['screenplay'], artifacts: ['draft'], evidence: [], events: ['screenplay.drafted'] },
  }),
  productionTool({
    toolId: 'search_assets', displayName: '资产检索', ownerDomain: 'asset',
    description: '在 Workspace 资产库中做混合检索；返回候选与授权摘要，不自动绑定。',
    inputSchema: object({ projectId: id('项目 ID'), query: text('检索描述', 300), limit: count('返回条数') },
      ['projectId', 'query']), outputSchema: output, ...READ,
    produces: { entities: ['asset'], revisions: [], artifacts: [], evidence: ['retrieval'], events: [] },
  }),
  productionTool({
    toolId: 'verify_asset_access', displayName: '资产授权核验', ownerDomain: 'asset',
    description: '核验资产对当前项目、用途与商业范围的授权，不返回对象内容。',
    inputSchema: object({ projectId: id('项目 ID'), assetId: id('资产 ID'), usage: optionalText('用途') },
      ['projectId', 'assetId']), outputSchema: output, ...READ,
    produces: { entities: ['asset_license'], revisions: [], artifacts: [], evidence: ['authorization'], events: [] },
  }),
  productionTool({
    toolId: 'create_asset_plan_draft', displayName: '资产计划草稿', ownerDomain: 'asset',
    description: '为镜头生成资产需求与候选来源计划草稿，不创建真实资产。',
    inputSchema: object({ projectId: id('项目 ID'), shotIds: { type: 'array', items: id('镜头 ID'), maxItems: 20 },
      notes: optionalText('计划说明', 1000) }, ['projectId', 'shotIds']), outputSchema: output, ...DRAFT,
    produces: { entities: ['asset_plan'], revisions: [], artifacts: ['draft'], evidence: [], events: ['asset_plan.drafted'] },
  }),
  productionTool({
    toolId: 'create_asset_pack_candidate', displayName: '资产包候选', ownerDomain: 'asset',
    description: '把已核验资产组合为项目资产包候选 revision；采用仍需人工确认。',
    inputSchema: object({ projectId: id('项目 ID'), assetIds: { type: 'array', items: id('资产 ID'), maxItems: 20 },
      title: text('候选标题') }, ['projectId', 'assetIds', 'title']), outputSchema: output, ...DRAFT,
    produces: { entities: ['asset_pack_candidate'], revisions: ['asset_pack'], artifacts: ['candidate'], evidence: ['license'], events: ['asset_pack.candidate'] },
  }),
  productionTool({
    toolId: 'create_shot_spec_draft', displayName: '分镜规格草稿', ownerDomain: 'storyboard',
    description: '把剧本段落转成 ShotSpecV2 草稿，保留来源与强约束引用；不冻结。',
    inputSchema: object({ projectId: id('项目 ID'), scriptRevisionId: optionalText('剧本 revision'),
      sceneIds: { type: 'array', items: id('场景 ID'), maxItems: 20 } }, ['projectId']), outputSchema: output, ...DRAFT,
    produces: { entities: ['shot_spec'], revisions: ['shot_spec'], artifacts: ['draft'], evidence: [], events: ['shot_spec.drafted'] },
  }),
  productionTool({
    toolId: 'create_storyboard_revision_draft', displayName: '分镜草稿', ownerDomain: 'storyboard',
    description: '基于已选 ShotSpec 创建分镜 revision 草稿；不替代生产冻结。',
    inputSchema: object({ projectId: id('项目 ID'), shotSpecRevisionIds: { type: 'array', items: id('ShotSpec revision'), maxItems: 20 },
      title: text('草稿标题') }, ['projectId', 'shotSpecRevisionIds', 'title']), outputSchema: output, ...DRAFT,
    produces: { entities: ['storyboard_revision'], revisions: ['storyboard'], artifacts: ['draft'], evidence: [], events: ['storyboard.drafted'] },
  }),
  productionTool({
    toolId: 'create_image_generation_spec', displayName: '生图请求规格', ownerDomain: 'image',
    description: '为镜头生成 provider-neutral 生图请求规格；不提交供应商、不扣费。',
    inputSchema: object({ projectId: id('项目 ID'), shotId: id('镜头 ID'), purpose: optionalText('用途'),
      referenceAssetIds: { type: 'array', items: id('参考资产 ID'), maxItems: 10 } }, ['projectId', 'shotId']),
    outputSchema: output, ...DRAFT,
    produces: { entities: ['image_generation_spec'], revisions: [], artifacts: ['spec'], evidence: [], events: ['image_spec.created'] },
  }),
  productionTool({
    toolId: 'create_video_generation_spec', displayName: '生视频请求规格', ownerDomain: 'video',
    description: '为镜头生成 provider-neutral 生视频请求规格，含首尾帧与候选策略；不提交供应商。',
    inputSchema: object({ projectId: id('项目 ID'), shotId: id('镜头 ID'), candidateIndex: count('候选序号'),
      firstFrameAssetId: optionalText('首帧资产 ID'), lastFrameAssetId: optionalText('尾帧资产 ID') },
    ['projectId', 'shotId']), outputSchema: output, ...DRAFT,
    produces: { entities: ['video_generation_spec'], revisions: [], artifacts: ['spec'], evidence: [], events: ['video_spec.created'] },
  }),
  productionTool({
    toolId: 'generate_image', displayName: '生成图片', ownerDomain: 'image',
    description: '通过预算预留与人工确认后提交图片生成；仅 Workflow 可执行。',
    inputSchema: object({ projectId: id('项目 ID'), specArtifactId: id('生图规格产物 ID'),
      modelConnectionRevision: id('已准入模型连接 revision') }, ['projectId', 'specArtifactId', 'modelConnectionRevision']),
    outputSchema: output, ...WORKFLOW_ONLY,
    produces: { entities: ['image_candidate'], revisions: [], artifacts: ['image'], evidence: ['provider_call'], events: ['image.generated'] },
  }),
  productionTool({
    toolId: 'generate_video', displayName: '生成视频', ownerDomain: 'video',
    description: '通过预算预留与人工确认后提交视频生成；仅 Workflow 可执行。',
    inputSchema: object({ projectId: id('项目 ID'), specArtifactId: id('生视频规格产物 ID'),
      modelConnectionRevision: id('已准入模型连接 revision'), candidateIndex: count('候选序号') },
    ['projectId', 'specArtifactId', 'modelConnectionRevision']), outputSchema: output, ...WORKFLOW_ONLY,
    produces: { entities: ['video_candidate'], revisions: [], artifacts: ['video'], evidence: ['provider_call'], events: ['video.generated'] },
  }),
  productionTool({
    toolId: 'inspect_media_technical', displayName: '媒体技术检查', ownerDomain: 'quality',
    description: '对已入库媒体执行容器、画幅、时长、音轨存在性等技术检查，不判断视觉语义。',
    inputSchema: object({ projectId: id('项目 ID'), mediaId: id('媒体 ID') }, ['projectId', 'mediaId']), outputSchema: output,
    ...READ, produces: { entities: [], revisions: [], artifacts: ['technical_report'], evidence: ['technical_check'], events: ['media.inspected'] },
  }),
  productionTool({
    toolId: 'compare_character_identity', displayName: '角色一致性对比', ownerDomain: 'quality',
    description: '对比候选画面与角色参考的身份相似度，输出证据摘要，不改写资产。',
    inputSchema: object({ projectId: id('项目 ID'), shotId: id('镜头 ID'), mediaId: id('候选媒体 ID'),
      referenceAssetIds: { type: 'array', items: id('角色参考资产 ID'), maxItems: 5 } },
    ['projectId', 'shotId', 'mediaId']), outputSchema: output,
    ...READ, produces: { entities: [], revisions: [], artifacts: ['identity_report'], evidence: ['identity_check'], events: ['identity.compared'] },
  }),
  productionTool({
    toolId: 'inspect_shot_continuity', displayName: '镜头连续性检查', ownerDomain: 'quality',
    description: '检查相邻镜头的位置、朝向、动作阶段、道具、轴线与光线连续性，返回问题清单。',
    inputSchema: object({ projectId: id('项目 ID'), shotIds: { type: 'array', items: id('镜头 ID'), maxItems: 10 } },
      ['projectId', 'shotIds']), outputSchema: output,
    ...READ, produces: { entities: [], revisions: [], artifacts: ['continuity_report'], evidence: ['continuity_check'], events: ['continuity.inspected'] },
  }),
]);

export const PRODUCTION_TOOL_IDS: readonly string[] = Object.freeze(
  PRODUCTION_TOOL_DEFINITIONS.map(definition => definition.toolId),
);

export interface ProductionToolExecutor {
  execute(toolId: string, args: JsonObject, context: {
    workspaceId: string; projectId: string | null; userId: string;
    role: 'owner' | 'admin' | 'member' | 'viewer'; runId: string; stepId: string;
    toolCallId: string; requestId: string; grantedPermissions: ToolPermissionLevel[];
    now: Date;
  }): Promise<unknown>;
}

export function productionToolCatalog(): ToolDefinition[] {
  return PRODUCTION_TOOL_DEFINITIONS.map(definition => structuredClone(definition));
}
