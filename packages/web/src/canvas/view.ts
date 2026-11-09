import type {
  CanvasEdge, CanvasGraph, CanvasNode, CanvasNodeKind, CanvasRuntimeState, CanvasRuntimeView,
} from '@lyra/shared';

export const CANVAS_NODE_WIDTH = 168;
export const CANVAS_NODE_HEIGHT = 96;
export const CANVAS_COLUMN_GAP = 96;
export const CANVAS_ROW_GAP = 22;

const KIND_LABELS: Record<CanvasNodeKind, string> = {
  source: '来源',
  asset: '资产',
  control: '控制',
  generation: '生成',
  quality: '质检',
  gate: '人工门',
  run: '运行',
  delivery: '交付',
  annotation: '批注',
  group: '分组',
};

export const STATE_LABELS: Record<CanvasRuntimeState, string> = {
  unknown: '未运行',
  pending: '待执行',
  running: '执行中',
  waitingHuman: '等待人工',
  failed: '失败',
  succeeded: '已完成',
  reconciling: '对账中',
};

const STATE_TONES: Record<CanvasRuntimeState, string> = {
  unknown: 'muted', pending: 'idle', running: 'active', waitingHuman: 'warn',
  failed: 'danger', succeeded: 'ok', reconciling: 'warn',
};

export interface CanvasNodeBox {
  id: string;
  kind: CanvasNodeKind;
  kindLabel: string;
  title: string;
  subtitle: string;
  x: number;
  y: number;
  width: number;
  height: number;
  state: CanvasRuntimeState;
  stateLabel: string;
  tone: string;
  groupId: string | null;
  shotId: string | null;
  resourceType: string | null;
  /** 节点在拓扑层级中的列，用于对齐“依赖从左到右”的阅读顺序。 */
  column: number;
  /** 以下字段全部来自后端运行覆盖，缺失时保持 null，不在前端推断。 */
  stage: string | null;
  progressPercent: number | null;
  queuePosition: number | null;
  runStatus: string | null;
  message: string | null;
  artifact: { id: string; kind: string; title: string; uri: string } | null;
}

export interface CanvasEdgeBox {
  id: string;
  edgeType: CanvasEdge['edgeType'];
  from: string;
  to: string;
  x1: number; y1: number; x2: number; y2: number;
}

export interface CanvasGroupBox {
  id: string;
  title: string;
  x: number; y: number; width: number; height: number;
}

export interface CanvasLayout {
  nodes: CanvasNodeBox[];
  edges: CanvasEdgeBox[];
  groups: CanvasGroupBox[];
  width: number;
  height: number;
}

function resourceLabel(node: CanvasNode): string {
  if (!node.resource) return '无正式引用';
  return `${node.resource.resourceType} · ${node.resource.resourceId}`;
}

function subtitleOf(node: CanvasNode): string {
  const parts: string[] = [];
  if (node.groupId) parts.push('分组内');
  if (typeof node.metadata.shotSize === 'string') parts.push(String(node.metadata.shotSize));
  if (typeof node.metadata.durationMs === 'number') parts.push(`${(Number(node.metadata.durationMs) / 1000).toFixed(1)}s`);
  if (parts.length) return parts.join(' · ');
  return resourceLabel(node);
}

/** Kahn 分层：依赖从左到右；环内节点归入最后一列，不隐藏也不伪造成功。 */
export function topologicalColumns(graph: CanvasGraph): Map<string, number> {
  const indegree = new Map<string, number>();
  const outbound = new Map<string, string[]>();
  for (const node of graph.nodes) { indegree.set(node.id, 0); outbound.set(node.id, []); }
  for (const edge of graph.edges) {
    if (!indegree.has(edge.targetNodeId) || !outbound.has(edge.sourceNodeId)) continue;
    indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) ?? 0) + 1);
    outbound.get(edge.sourceNodeId)!.push(edge.targetNodeId);
  }
  const columns = new Map<string, number>();
  let frontier = graph.nodes.filter(node => (indegree.get(node.id) ?? 0) === 0).map(node => node.id);
  let column = 0;
  const visited = new Set<string>();
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      if (visited.has(id)) continue;
      visited.add(id);
      columns.set(id, column);
      for (const target of outbound.get(id) ?? []) {
        const remaining = (indegree.get(target) ?? 0) - 1;
        indegree.set(target, remaining);
        if (remaining === 0) next.push(target);
      }
    }
    frontier = next;
    column += 1;
  }
  const last = Math.max(0, column - 1);
  for (const node of graph.nodes) if (!columns.has(node.id)) columns.set(node.id, last + 1);
  return columns;
}

function groupBounds(nodes: CanvasNode[], groupId: string) {
  const children = nodes.filter(node => node.groupId === groupId);
  if (!children.length) return null;
  const minX = Math.min(...children.map(node => node.position.x));
  const minY = Math.min(...children.map(node => node.position.y));
  const maxX = Math.max(...children.map(node => node.position.x));
  const maxY = Math.max(...children.map(node => node.position.y));
  return { x: minX - 42, y: minY - 42, width: maxX - minX + CANVAS_NODE_WIDTH + 84,
    height: maxY - minY + CANVAS_NODE_HEIGHT + 84 };
}

/**
 * 把后端图投影成可渲染的坐标。纯函数：不改动输入，也不在本地保存任何“画布事实”。
 * 只有后端未提供 position 时才做兜底网格排列。
 */
export function layoutCanvas(graph: CanvasGraph, runtime?: CanvasRuntimeView | null): CanvasLayout {
  const runtimeOf = new Map((runtime?.nodes ?? []).map(item => [item.nodeId, item]));
  const columns = topologicalColumns(graph);
  const sorted = [...graph.nodes].sort((a, b) => {
    const columnDelta = (columns.get(a.id) ?? 0) - (columns.get(b.id) ?? 0);
    if (columnDelta !== 0) return columnDelta;
    return String(a.metadata.order ?? a.title).localeCompare(String(b.metadata.order ?? b.title));
  });
  const rowByColumn = new Map<number, number>();
  const placed = sorted.map(node => {
    const column = columns.get(node.id) ?? 0;
    const row = rowByColumn.get(column) ?? 0;
    rowByColumn.set(column, row + 1);
    const fallbackX = 24 + column * (CANVAS_NODE_WIDTH + CANVAS_COLUMN_GAP);
    const fallbackY = 24 + row * (CANVAS_NODE_HEIGHT + CANVAS_ROW_GAP);
    const x = node.position.x || fallbackX;
    const y = node.position.y || fallbackY;
    const live = runtimeOf.get(node.id);
    const state = live?.state ?? 'unknown';
    const shotId = typeof node.metadata.shotId === 'string' ? node.metadata.shotId : null;
    return {
      id: node.id, kind: node.nodeType, kindLabel: KIND_LABELS[node.nodeType] ?? node.nodeType,
      title: node.title, subtitle: subtitleOf(node), x, y,
      width: CANVAS_NODE_WIDTH, height: CANVAS_NODE_HEIGHT,
      state, stateLabel: STATE_LABELS[state] ?? '未知', tone: STATE_TONES[state] ?? 'muted',
      groupId: node.groupId, shotId, resourceType: node.resource?.resourceType ?? null, column,
      stage: live?.stage ?? null, progressPercent: live?.progressPercent ?? null,
      queuePosition: live?.queuePosition ?? null, runStatus: live?.runStatus ?? null,
      message: live?.message ?? null, artifact: live?.artifact ?? null,
    };
  });
  const byId = new Map(placed.map(node => [node.id, node]));
  const edges: CanvasEdgeBox[] = graph.edges.length
    ? graph.edges.flatMap(edge => {
      const from = byId.get(edge.sourceNodeId);
      const to = byId.get(edge.targetNodeId);
      if (!from || !to) return [];
      return [{
        id: edge.id, edgeType: edge.edgeType, from: from.id, to: to.id,
        x1: from.x + from.width, y1: from.y + from.height / 2,
        x2: to.x, y2: to.y + to.height / 2,
      }];
    })
    : [];
  const groupNodes = graph.nodes.filter(node => node.nodeType === 'group');
  const groups = groupNodes.flatMap(node => {
    const bounds = groupBounds(graph.nodes, node.id);
    return bounds ? [{ id: node.id, title: node.title, ...bounds }] : [];
  });
  const width = placed.reduce((max, node) => Math.max(max, node.x + node.width), 0) + 72;
  const height = placed.reduce((max, node) => Math.max(max, node.y + node.height), 0) + 72;
  return { nodes: placed, edges, groups, width: Math.max(width, 480), height: Math.max(height, 320) };
}

/** 依赖摘要：直接上游与直接下游，给无障碍文本与侧栏使用。 */
export function summarizeDependencies(graph: CanvasGraph, nodeId: string): {
  upstream: string[]; downstream: string[];
} {
  const titles = new Map(graph.nodes.map(node => [node.id, node.title]));
  const upstream: string[] = [];
  const downstream: string[] = [];
  for (const edge of graph.edges) {
    if (edge.targetNodeId === nodeId) upstream.push(titles.get(edge.sourceNodeId) ?? edge.sourceNodeId);
    if (edge.sourceNodeId === nodeId) downstream.push(titles.get(edge.targetNodeId) ?? edge.targetNodeId);
  }
  return { upstream: [...new Set(upstream)], downstream: [...new Set(downstream)] };
}

/** 只读投影：把运行覆盖合并到节点，缺失运行一律 unknown，绝不默认“成功”。 */
export function runtimeStates(graph: CanvasGraph, runtime: CanvasRuntimeView | null | undefined): Map<string, CanvasRuntimeState> {
  const live = new Map((runtime?.nodes ?? []).map(item => [item.nodeId, item.state]));
  const result = new Map<string, CanvasRuntimeState>();
  for (const node of graph.nodes) result.set(node.id, live.get(node.id) ?? 'unknown');
  return result;
}

export function canvasProgress(graph: CanvasGraph, runtime: CanvasRuntimeView | null | undefined): {
  total: number; succeeded: number; failed: number; running: number; waitingHuman: number;
} {
  const states = [...runtimeStates(graph, runtime).values()];
  return {
    total: states.length,
    succeeded: states.filter(state => state === 'succeeded').length,
    failed: states.filter(state => state === 'failed').length,
    running: states.filter(state => state === 'running').length,
    waitingHuman: states.filter(state => state === 'waitingHuman').length,
  };
}

const STAGE_TEXT: Record<string, string> = {
  prepare: '准备', breakdown: '拆解', assets: '资产', storyboard: '分镜', director: '导演',
  video: '渲染', candidates: '候选', review: '复核', compose: '合成', deliver: '交付',
};

/** 节点徽章：优先展示后端运行覆盖里的排队位置/百分比，缺失时退回状态文案。 */
export function nodeStatusBadge(node: CanvasNodeBox): string {
  if (node.artifact) return '成片可回显';
  if (node.state === 'succeeded') return '已完成';
  if (node.queuePosition !== null) return `排队第 ${node.queuePosition} 位`;
  if (node.progressPercent !== null) return `${node.stage ? STAGE_TEXT[node.stage] ?? node.stage : '生产'} ${node.progressPercent}%`;
  return node.stateLabel;
}
