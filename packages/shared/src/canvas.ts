/**
 * 生产画布公共契约。
 *
 * 画布只保存“稳定的后端引用 + 布局”，绝不保存媒体字节、签名 URL、
 * 业务字段的权威副本或执行状态。节点和连线是可视化组织，ShotSpec、
 * AssetPack、Candidate、Job、Run 的事实仍在各自领域表。
 *
 * 纯函数集中在这里，main / web 共用同一套校验、归约、摘要与比较逻辑，
 * 避免前后端各写一套“看起来都对”的规则。
 */
export const CANVAS_SCHEMA_VERSION = 1 as const;

export const canvasNodeKinds = [
  'source', 'asset', 'control', 'generation', 'quality', 'gate', 'run', 'delivery', 'annotation', 'group',
] as const;
export type CanvasNodeKind = typeof canvasNodeKinds[number];

/**
 * V1 只允许引用已经存在正式读取路径的对象类型。
 * 声音/AgentRun/ToolInvocation 等后续节点通过新增类型扩展，旧读取器必须保留节点。
 */
export const canvasResourceTypes = [
  'project', 'scriptVersion', 'storyboardRevision', 'shotSpec', 'asset', 'productionRun',
] as const;
export type CanvasResourceType = typeof canvasResourceTypes[number];

/** 依赖边：参与生产语义摘要与循环校验。 */
export const canvasDependencyEdgeTypes = [
  'consumes', 'controls', 'derivedFrom', 'requires', 'produces', 'selectedFor', 'blocks',
] as const;
export type CanvasDependencyEdgeType = typeof canvasDependencyEdgeTypes[number];

export const canvasAnnotationEdgeTypes = ['annotation'] as const;
export type CanvasAnnotationEdgeType = typeof canvasAnnotationEdgeTypes[number];

export const canvasEdgeTypes = [...canvasDependencyEdgeTypes, ...canvasAnnotationEdgeTypes] as const;
export type CanvasEdgeType = typeof canvasEdgeTypes[number];

export const CANVAS_LIMITS = Object.freeze({
  nodes: 2000,
  edges: 4000,
  commandsPerBatch: 100,
  titleChars: 200,
  metadataJsonChars: 8000,
  graphJsonChars: 20_000_000,
  revisionHistory: 500,
});

const ID_PATTERN = /^[a-z][a-z0-9_-]{2,127}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

export type CanvasErrorCode =
  | 'canvas_not_found'
  | 'canvas_revision_not_found'
  | 'canvas_revision_conflict'
  | 'canvas_validation_failed'
  | 'canvas_permission_denied'
  | 'canvas_command_invalid'
  | 'canvas_command_conflict'
  | 'canvas_foreign_reference'
  | 'canvas_unknown_node_type'
  | 'canvas_limit_exceeded'
  | 'canvas_quote_stale'
  | 'canvas_quote_required'
  | 'canvas_domain_command_unavailable'
  | 'canvas_persistence_unavailable';

export class CanvasError extends Error {
  constructor(
    readonly status: number,
    readonly code: CanvasErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CanvasError';
  }
}

export function canvasError(
  code: CanvasErrorCode, message: string, details: Record<string, unknown> = {},
): CanvasError {
  const status = code === 'canvas_not_found' || code === 'canvas_revision_not_found' ? 404
    : code === 'canvas_permission_denied' ? 403
    : code === 'canvas_revision_conflict' || code === 'canvas_command_conflict' || code === 'canvas_quote_stale' ? 409
    : code === 'canvas_persistence_unavailable' || code === 'canvas_domain_command_unavailable' ? 503
    : 400;
  return new CanvasError(status, code, message, details);
}

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

export interface CanvasResourceRef {
  resourceType: CanvasResourceType;
  resourceId: string;
  /** 正式版本 ID；无版本概念的资源（如 project）为 null。 */
  versionId: string | null;
  /** 引用时的内容摘要；服务端会与当前对象摘要比对。 */
  digest: string | null;
  workspaceId: string;
  projectId: string;
}

export interface CanvasNodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasNode {
  id: string;
  nodeType: CanvasNodeKind;
  title: string;
  position: CanvasNodePosition;
  groupId: string | null;
  collapsed: boolean;
  /** 仅展示用标量（例如景别、时长、模型名），不是权威业务内容。 */
  metadata: Record<string, string | number | boolean | null>;
  resource: CanvasResourceRef | null;
}

export interface CanvasEdge {
  id: string;
  edgeType: CanvasEdgeType;
  sourceNodeId: string;
  targetNodeId: string;
}

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasGraph {
  schemaVersion: number;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: CanvasViewport;
}

export interface CanvasValidationIssue {
  code:
    | 'invalid_node' | 'duplicate_node' | 'unknown_node_type' | 'invalid_resource' | 'dangling_reference'
    | 'foreign_reference' | 'invalid_edge' | 'duplicate_edge' | 'annotation_as_input' | 'dependency_cycle'
    | 'mutually_exclusive_selection' | 'invalid_group' | 'limit_exceeded' | 'invalid_viewport';
  severity: 'error' | 'warning';
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface CanvasValidationResult {
  valid: boolean;
  errors: CanvasValidationIssue[];
  warnings: CanvasValidationIssue[];
  topologicalOrder: string[];
}

export const canvasRevisionStatuses = ['draft', 'adopted', 'archived'] as const;
export type CanvasRevisionStatus = typeof canvasRevisionStatuses[number];

export interface CanvasDocument {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  adoptedRevisionId: string | null;
  latestRevision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface CanvasBaseline {
  scriptVersionId: string | null;
  planRevisionId: string | null;
  storyboardRevisionId: string | null;
  productionInputSnapshotId: string | null;
  productionInputDigest: string | null;
}

export interface CanvasRevision {
  id: string;
  documentId: string;
  revision: number;
  baseRevisionId: string | null;
  workspaceId: string;
  projectId: string;
  schemaVersion: number;
  status: CanvasRevisionStatus;
  semanticGraphDigest: string;
  layoutDigest: string;
  contentDigest: string;
  baseline: CanvasBaseline;
  createdBy: string;
  createdAt: string;
  adoptedBy: string | null;
  adoptedAt: string | null;
  /** 未知 nodeType 必须在读取器侧提示升级，而不是丢弃。 */
  readerVersion: number;
  graph: CanvasGraph;
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

export type CanvasNodePositionInput = { nodeId: string; x: number; y: number };

export type CanvasCommand =
  | { type: 'addReferenceNode'; commandId: string; node: CanvasNode }
  | { type: 'removeDraftNode'; commandId: string; nodeId: string }
  | { type: 'moveNodes'; commandId: string; positions: CanvasNodePositionInput[] }
  | { type: 'resizeNode'; commandId: string; nodeId: string; width: number; height: number }
  | { type: 'createGroup'; commandId: string; node: CanvasNode }
  | { type: 'connect'; commandId: string; edge: CanvasEdge }
  | { type: 'disconnect'; commandId: string; edgeId: string }
  | { type: 'replaceResource'; commandId: string; nodeId: string; resource: CanvasResourceRef }
  | { type: 'selectCandidate'; commandId: string; nodeId: string; resource: CanvasResourceRef; candidateId: string }
  | { type: 'requestDomainEdit'; commandId: string; nodeId: string; edit: CanvasDomainEditPayload }
  | { type: 'removeDraftNodeBatch'; commandId: string; nodeIds: string[] }
  | { type: 'updateNodeMetadata'; commandId: string; nodeId: string; title?: string; metadata?: CanvasNode['metadata'] }
  | { type: 'setViewport'; commandId: string; viewport: CanvasViewport };

export interface CanvasDomainEditPayload {
  shotId: string;
  field: 'durationMs' | 'shotSize' | 'cameraMovement' | 'visualDescription';
  value: string | number;
}

export interface CanvasCommandBatch {
  clientRequestId: string;
  expectedRevision: number;
  commands: CanvasCommand[];
}

export interface CanvasChangeSet {
  upsertedNodeIds: string[];
  deletedNodeIds: string[];
  upsertedEdgeIds: string[];
  deletedEdgeIds: string[];
}

export interface CanvasCommandReceipt {
  clientRequestId: string;
  revision: number;
  appliedCommandIds: string[];
  changes: CanvasChangeSet;
  /** 可逆命令：只对纯布局/结构操作提供，领域采用类命令不提供破坏性回滚。 */
  inverse: CanvasCommand[];
  semanticGraphDigest: string;
  layoutDigest: string;
  contentDigest: string;
}

// ---------------------------------------------------------------------------
// 纯函数：规范化与摘要输入
// ---------------------------------------------------------------------------

/** 稳定序列化：对象键递归排序，数组保持顺序，拒绝 NaN/Infinity。 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalStringify: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalStringify(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(',')}}`;
  }
  throw new Error(`canonicalStringify: unsupported ${typeof value}`);
}

/**
 * 语义摘要输入：只包含会影响生产输入的信息。
 * 位置、尺寸、颜色、折叠、分组、viewport 与注释节点一律排除。
 */
export function semanticGraphOf(graph: CanvasGraph): Record<string, unknown> {
  return {
    schemaVersion: graph.schemaVersion,
    nodes: graph.nodes
      .filter(node => node.nodeType !== 'annotation' && node.nodeType !== 'group')
      .map(node => ({
        id: node.id,
        nodeType: node.nodeType,
        resource: node.resource ? {
          resourceType: node.resource.resourceType,
          resourceId: node.resource.resourceId,
          versionId: node.resource.versionId,
          digest: node.resource.digest,
        } : null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    edges: graph.edges
      .filter(edge => !canvasAnnotationEdgeTypes.includes(edge.edgeType as CanvasAnnotationEdgeType))
      .map(edge => ({ id: edge.id, edgeType: edge.edgeType, sourceNodeId: edge.sourceNodeId, targetNodeId: edge.targetNodeId }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

/** 布局摘要输入：只包含可视化状态。 */
export function layoutGraphOf(graph: CanvasGraph): Record<string, unknown> {
  return {
    viewport: graph.viewport,
    nodes: graph.nodes
      .map(node => ({
        id: node.id, position: node.position, groupId: node.groupId, collapsed: node.collapsed,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function semanticGraphInput(graph: CanvasGraph): string {
  return canonicalStringify(semanticGraphOf(graph));
}

export function layoutGraphInput(graph: CanvasGraph): string {
  return canonicalStringify(layoutGraphOf(graph));
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export interface CanvasValidationOptions {
  workspaceId: string;
  projectId: string;
  /** 解析结果由 main 注入：true 存在；false 不存在；undefined 表示未能校验。 */
  resolveReference?: (ref: CanvasResourceRef) => Promise<boolean | undefined> | boolean | undefined;
}

function issue(
  code: CanvasValidationIssue['code'], message: string, severity: 'error' | 'warning',
  extra: { nodeId?: string; edgeId?: string } = {},
): CanvasValidationIssue {
  return { code, message, severity, ...extra };
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function validDigest(value: unknown): boolean {
  return value === null || (typeof value === 'string' && DIGEST_PATTERN.test(value));
}

function validPosition(position: CanvasNodePosition | undefined): boolean {
  return Boolean(position) && Number.isFinite(position!.x) && Number.isFinite(position!.y)
    && Number.isFinite(position!.width) && Number.isFinite(position!.height)
    && position!.width > 0 && position!.height > 0;
}

function validViewport(viewport: CanvasViewport | undefined): boolean {
  return Boolean(viewport) && Number.isFinite(viewport!.x) && Number.isFinite(viewport!.y)
    && Number.isFinite(viewport!.zoom) && viewport!.zoom >= 0.2 && viewport!.zoom <= 4;
}

function validResource(ref: CanvasResourceRef | null, options: CanvasValidationOptions): string | null {
  if (ref === null) return null;
  if (!canvasResourceTypes.includes(ref.resourceType)) return 'invalid_resource';
  if (!validId(ref.resourceId)) return 'invalid_resource';
  if (ref.versionId !== null && !validId(ref.versionId)) return 'invalid_resource';
  if (!validDigest(ref.digest)) return 'invalid_resource';
  if (!WORKSPACE_PATTERN.test(ref.workspaceId)) return 'invalid_resource';
  if (!validId(ref.projectId)) return 'invalid_resource';
  if (ref.workspaceId !== options.workspaceId || ref.projectId !== options.projectId) return 'foreign_reference';
  return null;
}

/**
 * 同步校验图结构；引用存在性通过 resolveReference 逐条异步确认。
 * 未知 nodeType 作为 warning 保留节点，而不是让旧客户端丢数据。
 */
export async function validateCanvasGraph(
  graph: CanvasGraph, options: CanvasValidationOptions,
): Promise<CanvasValidationResult> {
  const errors: CanvasValidationIssue[] = [];
  const warnings: CanvasValidationIssue[] = [];
  const push = (entry: CanvasValidationIssue) => (entry.severity === 'error' ? errors : warnings).push(entry);

  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    return { valid: false, errors: [issue('invalid_node', '画布结构必须是对象。', 'error')], warnings: [], topologicalOrder: [] };
  }
  if (graph.schemaVersion !== CANVAS_SCHEMA_VERSION) {
    errors.push(issue('invalid_node', `画布结构版本 ${String(graph.schemaVersion)} 不受支持。`, 'error'));
  }
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return { valid: false, errors: [issue('invalid_node', '画布必须包含节点与连线集合。', 'error')], warnings: [], topologicalOrder: [] };
  }
  if (!validViewport(graph.viewport)) errors.push(issue('invalid_viewport', '画布视口或缩放级别不合法。', 'error'));
  if (graph.nodes.length > CANVAS_LIMITS.nodes || graph.edges.length > CANVAS_LIMITS.edges) {
    errors.push(issue('limit_exceeded', `单画布最多 ${CANVAS_LIMITS.nodes} 个节点、${CANVAS_LIMITS.edges} 条连线。`, 'error'));
  }

  const nodes = new Map<string, CanvasNode>();
  for (const node of graph.nodes) {
    if (!node || !validId(node.id)) { errors.push(issue('invalid_node', '节点 ID 不合法。', 'error')); continue; }
    if (nodes.has(node.id)) { errors.push(issue('duplicate_node', `节点 ID 重复：${node.id}。`, 'error', { nodeId: node.id })); continue; }
    nodes.set(node.id, node);
    if (!canvasNodeKinds.includes(node.nodeType)) {
      push(issue('unknown_node_type', `节点 ${node.id} 使用了当前读取器不认识的类型 ${String(node.nodeType)}，请升级后再编辑。`, 'warning', { nodeId: node.id }));
      continue;
    }
    if (typeof node.title !== 'string' || !node.title.trim() || node.title.length > CANVAS_LIMITS.titleChars) {
      errors.push(issue('invalid_node', `节点 ${node.id} 的标题为空或过长。`, 'error', { nodeId: node.id }));
    }
    if (!validPosition(node.position)) {
      errors.push(issue('invalid_node', `节点 ${node.id} 的坐标或尺寸不合法。`, 'error', { nodeId: node.id }));
    }
    if (node.metadata !== null && typeof node.metadata !== 'object') {
      errors.push(issue('invalid_node', `节点 ${node.id} 的展示字段必须是对象。`, 'error', { nodeId: node.id }));
    } else if (canonicalStringify(node.metadata ?? {}).length > CANVAS_LIMITS.metadataJsonChars) {
      errors.push(issue('invalid_node', `节点 ${node.id} 的展示字段过大。`, 'error', { nodeId: node.id }));
    }
    if (node.nodeType === 'group' && node.resource !== null) {
      errors.push(issue('invalid_resource', `分组节点 ${node.id} 不能绑定业务对象。`, 'error', { nodeId: node.id }));
    }
    const resourceProblem = validResource(node.resource, options);
    if (resourceProblem === 'invalid_resource') errors.push(issue('invalid_resource', `节点 ${node.id} 的资源引用格式不合法。`, 'error', { nodeId: node.id }));
    if (resourceProblem === 'foreign_reference') errors.push(issue('foreign_reference', `节点 ${node.id} 引用了其他 workspace/project 的资源。`, 'error', { nodeId: node.id }));
    if (node.nodeType === 'annotation' && node.resource !== null) {
      errors.push(issue('invalid_resource', `注释节点 ${node.id} 不能进入生产输入。`, 'error', { nodeId: node.id }));
    }
  }

  // 分组父链必须指向同一画布中的 group，且不能成环。
  for (const node of nodes.values()) {
    if (node.groupId === null) continue;
    if (!nodes.has(node.groupId) || nodes.get(node.groupId)!.nodeType !== 'group') {
      errors.push(issue('invalid_group', `节点 ${node.id} 的分组必须指向本画布中的分组节点。`, 'error', { nodeId: node.id }));
    }
  }
  const visited = new Set<string>();
  for (const node of nodes.values()) {
    const path = new Set<string>();
    let cursor: string | null = node.id;
    while (cursor && !visited.has(cursor)) {
      if (path.has(cursor)) { errors.push(issue('invalid_group', '分组关系形成了循环。', 'error', { nodeId: node.id })); break; }
      path.add(cursor);
      cursor = nodes.get(cursor)?.groupId ?? null;
    }
    path.forEach(id => visited.add(id));
  }

  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (!edge || !validId(edge.id)) { errors.push(issue('invalid_edge', '连线 ID 不合法。', 'error')); continue; }
    if (edgeIds.has(edge.id)) { errors.push(issue('duplicate_edge', `连线 ID 重复：${edge.id}。`, 'error', { edgeId: edge.id })); continue; }
    edgeIds.add(edge.id);
    if (!canvasEdgeTypes.includes(edge.edgeType)) {
      errors.push(issue('invalid_edge', `连线 ${edge.id} 的类型不受支持。`, 'error', { edgeId: edge.id }));
      continue;
    }
    const source = nodes.get(edge.sourceNodeId);
    const target = nodes.get(edge.targetNodeId);
    if (!source || !target) {
      errors.push(issue('invalid_edge', `连线 ${edge.id} 的端点不存在。`, 'error', { edgeId: edge.id }));
      continue;
    }
    if (source.nodeType === 'annotation' || target.nodeType === 'annotation' || source.nodeType === 'group' || target.nodeType === 'group') {
      if (edge.edgeType !== 'annotation') {
        errors.push(issue('annotation_as_input', `注释/分组节点不能作为生产输入：${edge.id}。`, 'error', { edgeId: edge.id }));
      }
    }
  }

  // 同一镜头/资产节点不能同时采用两个互斥候选。
  const selections = new Map<string, Set<string>>();
  for (const node of nodes.values()) {
    if (node.nodeType !== 'generation' || node.resource === null) continue;
    const candidate = node.metadata?.selectedCandidateId;
    if (typeof candidate !== 'string') continue;
    const key = `${node.resource.resourceType}:${node.resource.resourceId}`;
    const list = selections.get(key) ?? new Set<string>();
    list.add(candidate);
    selections.set(key, list);
  }
  for (const [key, candidates] of selections) {
    if (candidates.size > 1) {
      errors.push(issue('mutually_exclusive_selection', `同一对象 ${key} 同时采用了多个互斥候选。`, 'error'));
    }
  }

  // 依赖图拓扑排序（annotation 边不参与执行依赖）。
  const dependencyEdges = graph.edges.filter(edge => edge.edgeType !== 'annotation');
  const order = topologicalOrder(nodes, dependencyEdges);
  if (order.length !== nodes.size) {
    const cyclic = [...nodes.keys()].filter(id => !order.includes(id));
    errors.push(issue('dependency_cycle', `生产依赖存在循环：${cyclic.slice(0, 5).join('、')}。`, 'error'));
  }

  if (options.resolveReference) {
    for (const node of nodes.values()) {
      if (!node.resource) continue;
      let resolved: boolean | undefined;
      try { resolved = await options.resolveReference(node.resource); }
      catch { resolved = undefined; }
      if (resolved === false) {
        errors.push(issue('dangling_reference', `节点 ${node.id} 引用的 ${node.resource.resourceType} 已不存在。`, 'error', { nodeId: node.id }));
      } else if (resolved === undefined) {
        warnings.push(issue('dangling_reference', `节点 ${node.id} 的资源本次未能核验，运行时将重新尝试。`, 'warning', { nodeId: node.id }));
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    topologicalOrder: errors.length === 0 ? order : order,
  };
}

function topologicalOrder(nodes: Map<string, CanvasNode>, edges: CanvasEdge[]): string[] {
  const incoming = new Map<string, number>([...nodes.keys()].map(id => [id, 0]));
  const outgoing = new Map<string, string[]>();
  const declared = new Set<string>();
  for (const edge of edges) {
    if (!nodes.has(edge.sourceNodeId) || !nodes.has(edge.targetNodeId)) continue;
    const key = `${edge.sourceNodeId}->${edge.targetNodeId}`;
    if (declared.has(key)) continue;
    declared.add(key);
    incoming.set(edge.targetNodeId, (incoming.get(edge.targetNodeId) ?? 0) + 1);
    outgoing.set(edge.sourceNodeId, [...(outgoing.get(edge.sourceNodeId) ?? []), edge.targetNodeId]);
  }
  const ready = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
  const result: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    result.push(id);
    for (const target of outgoing.get(id) ?? []) {
      const count = (incoming.get(target) ?? 0) - 1;
      incoming.set(target, count);
      if (count === 0) ready.push(target);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 命令归约
// ---------------------------------------------------------------------------

export interface CanvasReduceResult {
  graph: CanvasGraph;
  changes: CanvasChangeSet;
  inverse: CanvasCommand[];
  /** 需要调用领域服务的命令：画布只能提出，不能直接改业务事实。 */
  domainIntents: Array<{ commandId: string; nodeId: string; kind: 'selectCandidate' | 'requestDomainEdit'; payload: unknown }>;
}

function cloneGraph(graph: CanvasGraph): CanvasGraph {
  return {
    schemaVersion: graph.schemaVersion,
    nodes: graph.nodes.map(node => ({ ...node, position: { ...node.position }, metadata: { ...node.metadata }, resource: node.resource ? { ...node.resource } : null })),
    edges: graph.edges.map(edge => ({ ...edge })),
    viewport: { ...graph.viewport },
  };
}

function takeCommandId(command: CanvasCommand): string {
  if (!command || typeof command !== 'object' || !validId((command as { commandId?: unknown }).commandId)) {
    throw canvasError('canvas_command_invalid', '每条画布命令必须携带合法的 commandId。');
  }
  return command.commandId;
}

/**
 * 把一批命令归约到内存图。纯布局变更可回滚；领域命令只产生 intent。
 * 调用方必须在写入后重新校验整图，不能信任局部 patch。
 */
export function reduceCanvasCommands(base: CanvasGraph, commands: CanvasCommand[]): CanvasReduceResult {
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > CANVAS_LIMITS.commandsPerBatch) {
    throw canvasError('canvas_command_invalid', `每次提交必须包含 1–${CANVAS_LIMITS.commandsPerBatch} 条命令。`);
  }
  const graph = cloneGraph(base);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const edges = new Map(graph.edges.map(edge => [edge.id, edge]));
  const initialNodeIds = new Set(nodes.keys());
  const initialEdgeIds = new Set(edges.keys());
  const inverse: CanvasCommand[] = [];
  const domainIntents: CanvasReduceResult['domainIntents'] = [];
  const applied: string[] = [];
  const seen = new Set<string>();

  for (const command of commands) {
    const commandId = takeCommandId(command);
    if (seen.has(commandId)) throw canvasError('canvas_command_invalid', `命令 ID 在同批次内重复：${commandId}。`);
    seen.add(commandId);
    applied.push(commandId);

    switch (command.type) {
      case 'addReferenceNode': {
        if (nodes.has(command.node.id)) throw canvasError('canvas_command_conflict', `节点已存在：${command.node.id}。`);
        nodes.set(command.node.id, { ...command.node });
        inverse.push({ type: 'removeDraftNode', commandId: `inv_${commandId}`, nodeId: command.node.id });
        break;
      }
      case 'removeDraftNode': {
        const node = nodes.get(command.nodeId);
        if (!node) throw canvasError('canvas_command_conflict', `节点不存在：${command.nodeId}。`);
        nodes.delete(node.id);
        for (const [id, edge] of edges) if (edge.sourceNodeId === node.id || edge.targetNodeId === node.id) edges.delete(id);
        inverse.push({ type: 'addReferenceNode', commandId: `inv_${commandId}`, node });
        break;
      }
      case 'removeDraftNodeBatch': {
        for (const nodeId of command.nodeIds) {
          const node = nodes.get(nodeId);
          if (!node) throw canvasError('canvas_command_conflict', `节点不存在：${nodeId}。`);
          nodes.delete(node.id);
          for (const [id, edge] of edges) if (edge.sourceNodeId === node.id || edge.targetNodeId === node.id) edges.delete(id);
          inverse.push({ type: 'addReferenceNode', commandId: `inv_${commandId}_${node.id}`, node });
        }
        break;
      }
      case 'moveNodes': {
        const previous: CanvasNodePositionInput[] = [];
        for (const position of command.positions) {
          const node = nodes.get(position.nodeId);
          if (!node) throw canvasError('canvas_command_conflict', `节点不存在：${position.nodeId}。`);
          previous.push({ nodeId: node.id, x: node.position.x, y: node.position.y });
          node.position = { ...node.position, x: position.x, y: position.y };
        }
        inverse.push({ type: 'moveNodes', commandId: `inv_${commandId}`, positions: previous });
        break;
      }
      case 'resizeNode': {
        const node = nodes.get(command.nodeId);
        if (!node) throw canvasError('canvas_command_conflict', `节点不存在：${command.nodeId}。`);
        if (command.width <= 0 || command.height <= 0) throw canvasError('canvas_command_invalid', '节点尺寸必须大于 0。');
        inverse.push({ type: 'resizeNode', commandId: `inv_${commandId}`, nodeId: node.id, width: node.position.width, height: node.position.height });
        node.position = { ...node.position, width: command.width, height: command.height };
        break;
      }
      case 'createGroup': {
        if (command.node.nodeType !== 'group') throw canvasError('canvas_command_invalid', 'createGroup 只能创建分组节点。');
        if (nodes.has(command.node.id)) throw canvasError('canvas_command_conflict', `节点已存在：${command.node.id}。`);
        nodes.set(command.node.id, { ...command.node });
        inverse.push({ type: 'removeDraftNode', commandId: `inv_${commandId}`, nodeId: command.node.id });
        break;
      }
      case 'connect': {
        if (edges.has(command.edge.id)) throw canvasError('canvas_command_conflict', `连线已存在：${command.edge.id}。`);
        if (!nodes.has(command.edge.sourceNodeId) || !nodes.has(command.edge.targetNodeId)) {
          throw canvasError('canvas_command_invalid', '连线端点必须存在于同一画布。');
        }
        edges.set(command.edge.id, { ...command.edge });
        inverse.push({ type: 'disconnect', commandId: `inv_${commandId}`, edgeId: command.edge.id });
        break;
      }
      case 'disconnect': {
        const edge = edges.get(command.edgeId);
        if (!edge) throw canvasError('canvas_command_conflict', `连线不存在：${command.edgeId}。`);
        edges.delete(edge.id);
        inverse.push({ type: 'connect', commandId: `inv_${commandId}`, edge });
        break;
      }
      case 'replaceResource': {
        const node = nodes.get(command.nodeId);
        if (!node) throw canvasError('canvas_command_conflict', `节点不存在：${command.nodeId}。`);
        if (node.nodeType === 'annotation' || node.nodeType === 'group') {
          throw canvasError('canvas_command_invalid', '注释或分组节点不能绑定业务资源。');
        }
        inverse.push({
          type: 'replaceResource', commandId: `inv_${commandId}`, nodeId: node.id,
          resource: node.resource as CanvasResourceRef,
        });
        node.resource = { ...command.resource };
        break;
      }
      case 'selectCandidate': {
        const node = nodes.get(command.nodeId);
        if (!node) throw canvasError('canvas_command_conflict', `节点不存在：${command.nodeId}。`);
        // 画布不直接写入采用事实：记录 intent，由 main 调用领域服务后再替换引用。
        domainIntents.push({ commandId, nodeId: node.id, kind: 'selectCandidate', payload: { ...command } });
        break;
      }
      case 'requestDomainEdit': {
        const node = nodes.get(command.nodeId);
        if (!node) throw canvasError('canvas_command_conflict', `节点不存在：${command.nodeId}。`);
        domainIntents.push({ commandId, nodeId: node.id, kind: 'requestDomainEdit', payload: { ...command } });
        break;
      }
      case 'updateNodeMetadata': {
        const node = nodes.get(command.nodeId);
        if (!node) throw canvasError('canvas_command_conflict', `节点不存在：${command.nodeId}。`);
        const previous = { title: node.title, metadata: { ...node.metadata } };
        if (command.title !== undefined) {
          if (!command.title.trim() || command.title.length > CANVAS_LIMITS.titleChars) {
            throw canvasError('canvas_command_invalid', '节点标题不能为空且最多 200 字符。');
          }
          node.title = command.title;
        }
        if (command.metadata !== undefined) node.metadata = { ...command.metadata };
        inverse.push({
          type: 'updateNodeMetadata', commandId: `inv_${commandId}`, nodeId: node.id,
          title: previous.title, metadata: previous.metadata,
        });
        break;
      }
      case 'setViewport': {
        inverse.push({ type: 'setViewport', commandId: `inv_${commandId}`, viewport: graph.viewport });
        graph.viewport = { ...command.viewport };
        break;
      }
      default: {
        const unknown = (command as { type?: unknown }).type;
        throw canvasError('canvas_command_invalid', `不支持的命令类型：${String(unknown)}。`);
      }
    }
  }

  const nextNodes = [...nodes.values()];
  const nextEdges = [...edges.values()];
  const upsertedNodeIds = nextNodes.filter(node => {
    const original = base.nodes.find(item => item.id === node.id);
    return !original || canonicalStringify(original) !== canonicalStringify(node);
  }).map(node => node.id);
  const deletedNodeIds = [...initialNodeIds].filter(id => !nodes.has(id));
  const upsertedEdgeIds = nextEdges.filter(edge => {
    const original = base.edges.find(item => item.id === edge.id);
    return !original || canonicalStringify(original) !== canonicalStringify(edge);
  }).map(edge => edge.id);
  const deletedEdgeIds = [...initialEdgeIds].filter(id => !edges.has(id));

  return {
    graph: { ...graph, nodes: nextNodes, edges: nextEdges },
    changes: { upsertedNodeIds, deletedNodeIds, upsertedEdgeIds, deletedEdgeIds },
    inverse,
    domainIntents,
  };
}

/** 每批命令最多产生一个 revision；超出单批的命令由调用方拆批。 */
export function parseCanvasCommandBatch(value: unknown): CanvasCommandBatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw canvasError('canvas_command_invalid', '命令批次必须是对象。');
  }
  const input = value as Record<string, unknown>;
  if (typeof input.clientRequestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/u.test(input.clientRequestId)) {
    throw canvasError('canvas_command_invalid', 'clientRequestId 必须是 8–128 位可重试标识。');
  }
  if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1) {
    throw canvasError('canvas_command_invalid', 'expectedRevision 必须是正整数。');
  }
  if (!Array.isArray(input.commands) || input.commands.length < 1 || input.commands.length > CANVAS_LIMITS.commandsPerBatch) {
    throw canvasError('canvas_command_invalid', `每次提交必须包含 1–${CANVAS_LIMITS.commandsPerBatch} 条命令。`);
  }
  return {
    clientRequestId: input.clientRequestId as string,
    expectedRevision: input.expectedRevision as number,
    commands: input.commands as CanvasCommand[],
  };
}

// ---------------------------------------------------------------------------
// 版本比较
// ---------------------------------------------------------------------------

export interface CanvasGraphDiff {
  addedNodeIds: string[];
  removedNodeIds: string[];
  movedNodeIds: string[];
  addedEdgeIds: string[];
  removedEdgeIds: string[];
  changedReferences: Array<{ nodeId: string; before: CanvasResourceRef | null; after: CanvasResourceRef | null }>;
  /** 引用变化或节点移除影响到的正式镜头；用于“局部重做”的影响范围。 */
  affectedShotIds: string[];
  semanticChanged: boolean;
}

export function compareCanvasGraphs(before: CanvasGraph, after: CanvasGraph): CanvasGraphDiff {
  const beforeNodes = new Map(before.nodes.map(node => [node.id, node]));
  const afterNodes = new Map(after.nodes.map(node => [node.id, node]));
  const addedNodeIds = [...afterNodes.keys()].filter(id => !beforeNodes.has(id));
  const removedNodeIds = [...beforeNodes.keys()].filter(id => !afterNodes.has(id));
  const movedNodeIds = [...afterNodes.keys()].filter(id => {
    const left = beforeNodes.get(id);
    const right = afterNodes.get(id);
    return Boolean(left && right) && canonicalStringify(left!.position) !== canonicalStringify(right!.position);
  });
  const beforeEdges = new Map(before.edges.map(edge => [edge.id, edge]));
  const afterEdges = new Map(after.edges.map(edge => [edge.id, edge]));
  const addedEdgeIds = [...afterEdges.keys()].filter(id => !beforeEdges.has(id));
  const removedEdgeIds = [...beforeEdges.keys()].filter(id => !afterEdges.has(id));

  const changedReferences: CanvasGraphDiff['changedReferences'] = [];
  for (const [id, node] of afterNodes) {
    const old = beforeNodes.get(id);
    if (old && canonicalStringify(old.resource) !== canonicalStringify(node.resource)) {
      changedReferences.push({ nodeId: id, before: old.resource, after: node.resource });
    }
  }

  const affected = new Set<string>();
  for (const change of changedReferences) {
    const shotId = change.after?.resourceType === 'shotSpec' ? change.after.resourceId
      : change.before?.resourceType === 'shotSpec' ? change.before.resourceId : null;
    if (shotId) affected.add(shotId);
  }
  for (const id of removedNodeIds) {
    const node = beforeNodes.get(id);
    if (node?.resource?.resourceType === 'shotSpec') affected.add(node.resource.resourceId);
  }
  for (const id of addedNodeIds) {
    const node = afterNodes.get(id);
    if (node?.resource?.resourceType === 'shotSpec') affected.add(node.resource.resourceId);
  }

  return {
    addedNodeIds, removedNodeIds, movedNodeIds, addedEdgeIds, removedEdgeIds, changedReferences,
    affectedShotIds: [...affected].sort(),
    semanticChanged: semanticGraphInput(before) !== semanticGraphInput(after),
  };
}

// ---------------------------------------------------------------------------
// 运行覆盖与估价 DTO
// ---------------------------------------------------------------------------

export type CanvasRuntimeState = 'unknown' | 'pending' | 'running' | 'waitingHuman' | 'failed' | 'succeeded' | 'reconciling';

export interface CanvasNodeArtifact {
  id: string;
  kind: string;
  title: string;
  /** 来自 Main 的受控媒体路由（例如 /api/production-media/:id），不是第三方签名 URL。 */
  uri: string;
}

export interface CanvasNodeRuntime {
  nodeId: string;
  state: CanvasRuntimeState;
  message: string | null;
  sourceAggregateId: string | null;
  sourceRevision: number | null;
  observedAt: string;
  /** 该镜头当前所处生产阶段（video/candidates/review…）；非镜头节点为 null。 */
  stage?: string | null;
  /** 该镜头已完成阶段占全部阶段的比例（0–100），仅作展示。 */
  progressPercent?: number | null;
  /** 在 Worker 队列中的 1-based 位置；不在排队时为 null。 */
  queuePosition?: number | null;
  /** 该镜头已产出的成片/候选，前端可直接渲染。 */
  artifact?: CanvasNodeArtifact | null;
  /** 整片运行状态，便于画布显示“排队/执行/等待人工”。 */
  runStatus?: string | null;
}

export interface CanvasRunQueue {
  pending: number;
  ready: number;
  running: number;
  waitingHuman: number;
  failed: number;
}

export interface CanvasRuntimeView {
  revisionId: string;
  revision: number;
  cursor: string | null;
  nodes: CanvasNodeRuntime[];
  generatedAt: string;
  /** 当前 revision 绑定的生产运行摘要；没有运行时为 null。 */
  run?: {
    id: string;
    status: string;
    queue: CanvasRunQueue;
    stages: Array<{ key: string; state: string; completed: number; total: number }>;
    /** 整集成片（deliver 阶段产物）；尚未产出时为 null。 */
    delivery?: { id: string; title: string; uri: string } | null;
  } | null;
}

export interface CanvasQuote {
  id: string;
  documentId: string;
  revisionId: string;
  semanticGraphDigest: string;
  currency: string;
  budgetMicros: number;
  estimateCostMicros: number;
  estimateRange: { lowMicros: number; highMicros: number };
  priceRevision: string;
  assumptions: string[];
  shotCount: number;
  model: string;
  candidatePolicy: string;
  expiresAt: string;
  status: 'pending' | 'confirmed' | 'expired';
  createdAt: string;
}

export interface CanvasProductionRunRef {
  id: string;
  documentId: string;
  revisionId: string;
  semanticGraphDigest: string;
  quoteId: string;
  createdAt: string;
}
