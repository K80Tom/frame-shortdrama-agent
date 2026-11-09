import { createHash } from 'node:crypto';
import {
  CANVAS_SCHEMA_VERSION, CanvasError, canvasError, canonicalStringify, layoutGraphInput,
  semanticGraphInput, type CanvasBaseline, type CanvasGraph, type CanvasNode, type CanvasNodeKind,
  type CanvasResourceRef, type CanvasResourceType,
} from '@lyra/shared';

/** 与 shared 的 digest 格式保持一致：sha256:<64 lowercase hex>。 */
export function sha256Digest(input: string): string {
  return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

export interface GraphDigests {
  semanticGraphDigest: string;
  layoutDigest: string;
  contentDigest: string;
}

/** 语义、布局与完整内容分开摘要：移动节点不会改变生产输入标记。 */
export function digestGraph(graph: CanvasGraph): GraphDigests {
  return {
    semanticGraphDigest: sha256Digest(semanticGraphInput(graph)),
    layoutDigest: sha256Digest(layoutGraphInput(graph)),
    contentDigest: sha256Digest(canonicalStringify(graph)),
  };
}

export function emptyBaseline(): CanvasBaseline {
  return {
    scriptVersionId: null, planRevisionId: null, storyboardRevisionId: null,
    productionInputSnapshotId: null, productionInputDigest: null,
  };
}

export function blankGraph(): CanvasGraph {
  return { schemaVersion: CANVAS_SCHEMA_VERSION, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

export function cloneGraph(graph: CanvasGraph): CanvasGraph {
  return {
    schemaVersion: graph.schemaVersion,
    nodes: graph.nodes.map(node => ({
      ...node, position: { ...node.position }, metadata: { ...node.metadata },
      resource: node.resource ? { ...node.resource } : null,
    })),
    edges: graph.edges.map(edge => ({ ...edge })),
    viewport: { ...graph.viewport },
  };
}

const RESOURCE_TYPES = new Set<string>([
  'project', 'scriptVersion', 'storyboardRevision', 'shotSpec', 'asset', 'productionRun',
]);
const NODE_KINDS = new Set<string>([
  'source', 'asset', 'control', 'generation', 'quality', 'gate', 'run', 'delivery', 'annotation', 'group',
]);
const EDGE_TYPES = new Set<string>([
  'consumes', 'controls', 'derivedFrom', 'requires', 'produces', 'selectedFor', 'blocks', 'annotation',
]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw canvasError('canvas_command_invalid', '画布内容必须是对象。');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw canvasError('canvas_command_invalid', `${field} 不是合法文本。`);
  }
  return value;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw canvasError('canvas_command_invalid', `${field} 不是有效数字。`);
  }
  return value;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{2,127}$/u.test(value)) {
    throw canvasError('canvas_command_invalid', `${field} 标识不合法。`);
  }
  return value;
}

function nullableIdentifier(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return identifier(value, field);
}

/**
 * 从数据库 JSON 读取时做一次防御性重建。
 * 未知 nodeType 不在这里丢弃：交给 shared 校验按 warning 保留。
 */
export function parseGraph(value: unknown, workspaceId: string, projectId: string): CanvasGraph {
  const input = record(value);
  const nodesRaw = Array.isArray(input.nodes) ? input.nodes : [];
  const edgesRaw = Array.isArray(input.edges) ? input.edges : [];
  const nodes: CanvasNode[] = nodesRaw.map(rawNode => {
    const node = record(rawNode);
    const layout = record(node.position);
    const metadata = node.metadata && typeof node.metadata === 'object' && !Array.isArray(node.metadata)
      ? Object.fromEntries(Object.entries(node.metadata as Record<string, unknown>)
        .filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value))
        .map(([key, value]) => [key, value as string | number | boolean | null]))
      : {};
    const kind = typeof node.nodeType === 'string' ? node.nodeType : '';
    let resource: CanvasResourceRef | null = null;
    if (node.resource && typeof node.resource === 'object' && !Array.isArray(node.resource)) {
      const raw = node.resource as Record<string, unknown>;
      if (RESOURCE_TYPES.has(String(raw.resourceType))) {
        resource = {
          resourceType: raw.resourceType as CanvasResourceType,
          resourceId: String(raw.resourceId ?? ''),
          versionId: typeof raw.versionId === 'string' ? raw.versionId : null,
          digest: typeof raw.digest === 'string' ? raw.digest : null,
          workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : workspaceId,
          projectId: typeof raw.projectId === 'string' ? raw.projectId : projectId,
        };
      }
    }
    return {
      id: String(node.id ?? ''),
      nodeType: kind as CanvasNodeKind,
      title: typeof node.title === 'string' ? node.title : '',
      position: {
        x: Number(layout.x ?? 0), y: Number(layout.y ?? 0),
        width: Number(layout.width ?? 220), height: Number(layout.height ?? 120),
      },
      groupId: typeof node.groupId === 'string' ? node.groupId : null,
      collapsed: node.collapsed === true,
      metadata,
      resource,
    };
  });
  const edges = edgesRaw.map(rawEdge => {
    const edge = record(rawEdge);
    return {
      id: String(edge.id ?? ''),
      edgeType: String(edge.edgeType ?? ''),
      sourceNodeId: String(edge.sourceNodeId ?? ''),
      targetNodeId: String(edge.targetNodeId ?? ''),
    } as CanvasGraph['edges'][number];
  });
  const viewport = input.viewport && typeof input.viewport === 'object' && !Array.isArray(input.viewport)
    ? {
      x: Number((input.viewport as Record<string, unknown>).x ?? 0),
      y: Number((input.viewport as Record<string, unknown>).y ?? 0),
      zoom: Number((input.viewport as Record<string, unknown>).zoom ?? 1),
    }
    : { x: 0, y: 0, zoom: 1 };
  return { schemaVersion: Number(input.schemaVersion ?? CANVAS_SCHEMA_VERSION), nodes, edges, viewport };
}

export function requireGraph(value: unknown, workspaceId: string, projectId: string): CanvasGraph {
  const graph = parseGraph(value, workspaceId, projectId);
  for (const node of graph.nodes) {
    if (!identifier(node.id, 'nodeId')) throw canvasError('canvas_command_invalid', '画布包含非法节点 ID。');
    if (!NODE_KINDS.has(node.nodeType)) {
      // 未知类型保留，但服务端不再接受它参与新连线。
      continue;
    }
    if (node.resource) {
      identifier(node.resource.resourceId, 'resourceId');
      if (!RESOURCE_TYPES.has(node.resource.resourceType)) {
        throw canvasError('canvas_command_invalid', '画布包含不支持的资源类型。');
      }
    }
  }
  for (const edge of graph.edges) {
    if (!identifier(edge.id, 'edgeId')) throw canvasError('canvas_command_invalid', '画布包含非法连线 ID。');
    if (!EDGE_TYPES.has(edge.edgeType)) throw canvasError('canvas_command_invalid', '画布包含不支持的连线类型。');
  }
  return graph;
}

export interface CanvasSeedShot {
  id: string;
  sceneId: string;
  order: number;
  shotSize: string;
  cameraMovement: string;
  durationMs: number;
  visualDescription: string;
}

export interface CanvasSeed {
  workspaceId: string;
  projectId: string;
  storyboardRevisionId: string;
  storyboardDigest: string | null;
  scriptVersionId: string | null;
  planRevisionId: string | null;
  shots: CanvasSeedShot[];
}

/** 节点/连线 ID 必须稳定：同一分镜版本重复初始化得到同一张图。 */
function nodeId(prefix: string, value: string): string {
  const safe = value.toLowerCase().replaceAll(/[^a-z0-9]/gu, '');
  return `${prefix}_${safe.slice(0, 96)}`;
}

function ref(input: CanvasSeed, resourceType: CanvasResourceType, resourceId: string,
  versionId: string | null, digest: string | null): CanvasResourceRef {
  return {
    resourceType, resourceId, versionId, digest,
    workspaceId: input.workspaceId, projectId: input.projectId,
  };
}

/**
 * 从已采用的正式分镜初始化画布：分镜版本节点 + 镜头节点 + 场次分组。
 * 只引用正式对象，不复制分镜业务内容作为权威事实。
 */
export function initializeGraphFromStoryboard(seed: CanvasSeed): { graph: CanvasGraph; baseline: CanvasBaseline } {
  const graph = blankGraph();
  const storyboardDigest = seed.storyboardDigest?.startsWith('sha256:')
    ? seed.storyboardDigest : seed.storyboardDigest ? `sha256:${seed.storyboardDigest.replace(/^0x/u, '')}` : null;
  const storyboardNode: CanvasNode = {
    id: nodeId('node', `storyboard-${seed.storyboardRevisionId}`),
    nodeType: 'source',
    title: '正式分镜版本',
    position: { x: 60, y: 60, width: 240, height: 110 },
    groupId: null,
    collapsed: false,
    metadata: { label: '分镜', shots: seed.shots.length },
    resource: ref(seed, 'storyboardRevision', seed.storyboardRevisionId, seed.storyboardRevisionId, storyboardDigest),
  };
  graph.nodes.push(storyboardNode);

  const scenes = [...new Set(seed.shots.map(shot => shot.sceneId))].sort();
  const sceneGroups = new Map<string, string>();
  scenes.forEach((sceneId, index) => {
    const id = nodeId('node', `scene-${sceneId}`);
    sceneGroups.set(sceneId, id);
    graph.nodes.push({
      id, nodeType: 'group', title: `场次 ${index + 1}`,
      position: { x: 60 + index * 320, y: 220, width: 300, height: 240 },
      groupId: null, collapsed: false, metadata: { sceneId }, resource: null,
    });
  });

  const ordered = [...seed.shots].sort((left, right) => left.order - right.order);
  ordered.forEach((shot, index) => {
    const id = nodeId('node', `shot-${shot.id}`);
    const sceneIndex = scenes.indexOf(shot.sceneId);
    const positionInScene = ordered.slice(0, index).filter(item => item.sceneId === shot.sceneId).length;
    graph.nodes.push({
      id, nodeType: 'source', title: `镜头 ${String(shot.order).padStart(2, '0')}`,
      position: { x: 76 + Math.max(0, sceneIndex) * 320, y: 252 + positionInScene * 132, width: 268, height: 112 },
      groupId: sceneGroups.get(shot.sceneId) ?? null, collapsed: false,
      metadata: {
        shotId: shot.id, sceneId: shot.sceneId, order: shot.order,
        shotSize: shot.shotSize, cameraMovement: shot.cameraMovement,
        durationMs: shot.durationMs, visualDescription: shot.visualDescription.slice(0, 240),
      },
      resource: ref(seed, 'shotSpec', shot.id, seed.storyboardRevisionId, storyboardDigest),
    });
    graph.edges.push({
      id: nodeId('edge', `produces-${seed.storyboardRevisionId}-${shot.id}`),
      edgeType: 'produces', sourceNodeId: storyboardNode.id, targetNodeId: id,
    });
  });

  graph.viewport = { x: 0, y: 0, zoom: 1 };
  return {
    graph,
    baseline: {
      scriptVersionId: seed.scriptVersionId,
      planRevisionId: seed.planRevisionId,
      storyboardRevisionId: seed.storyboardRevisionId,
      productionInputSnapshotId: null,
      productionInputDigest: storyboardDigest,
    },
  };
}

/**
 * 运行状态投影：只读取运行/任务的真实状态，unknown 不伪装成成功。
 */
export function runtimeStateOf(status: unknown): 'unknown' | 'pending' | 'running' | 'waitingHuman' | 'failed' | 'succeeded' | 'reconciling' {
  switch (status) {
    case 'succeeded': case 'completed': case 'done': return 'succeeded';
    case 'running': case 'started': case 'inProgress': return 'running';
    case 'waitingHuman': case 'waiting': case 'needsAttention': return 'waitingHuman';
    case 'failed': case 'error': return 'failed';
    case 'reconciling': case 'unknown': return 'reconciling';
    case 'pending': case 'queued': return 'pending';
    default: return 'unknown';
  }
}

export function assertRevisionIdentifier(value: unknown, field: string): string {
  return identifier(value, field);
}

export function ensurePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw canvasError('canvas_command_invalid', `${field} 必须是正整数。`);
  }
  return value as number;
}

export function clampLimit(value: unknown, fallback: number, max = 200): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export function isCanvasError(error: unknown): error is CanvasError {
  return error instanceof CanvasError;
}

export function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function boundedText(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function requireText(value: unknown, field: string, max = 200): string {
  return text(value, field, max);
}

export function requireFinite(value: unknown, field: string): number {
  return finite(value, field);
}
