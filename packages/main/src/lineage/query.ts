import type { LineageEdge, LineageNode } from '@lyra/shared';
import { canReadNode } from '@lyra/shared';
import type { LineageStore } from './store';

export type LineageDirection = 'upstream' | 'downstream';

export interface LineageQueryOptions {
  /** 最大追踪层数；必须显式提供且有上限，防止无界遍历与循环。 */
  maxDepth: number;
  /** 调用方持有的 scope；不在其中的节点只形成受限 permission gap，不暴露详情。 */
  allowedScopes: readonly string[];
}

/** 越权节点的受限投影：只保留定位所需的最少信息，绝不含 digest/ref/正文。 */
export interface RedactedGap {
  nodeId: string;
  kind: LineageNode['kind'] | null;
  authorization: string | null;
  gap: { type: 'permission'; reason: string };
}

export interface LineageTraversalResult {
  startNodeId: string;
  direction: LineageDirection;
  /** 调用方有权读取的已解析节点。 */
  nodes: LineageNode[];
  /** 遍历过程中经过的边（内部引用，不含业务正文）。 */
  edges: LineageEdge[];
  /** 已解析但自身带 unknown/orphan/digest 标记的节点。 */
  flaggedGaps: LineageNode[];
  /** 越权节点形成的受限 gap（不泄露节点详情）。 */
  permissionGaps: RedactedGap[];
  visitedCount: number;
  depthReached: number;
}

const MAX_DEPTH_CAP = 32;

/**
 * 血缘查询：显式深度上限 + visited 防环 + 权限过滤。越权上游不抛错、不返回
 * 节点正文，只落一条受限 permission gap。
 */
export class LineageQueryService {
  constructor(private readonly store: LineageStore) {}

  async traverse(startNodeId: string, direction: LineageDirection,
    options: LineageQueryOptions): Promise<LineageTraversalResult> {
    if (!Number.isInteger(options.maxDepth) || options.maxDepth < 1) {
      throw new Error('maxDepth 必须是正整数。');
    }
    const maxDepth = Math.min(options.maxDepth, MAX_DEPTH_CAP);
    const allowed = options.allowedScopes;

    const base: LineageTraversalResult = {
      startNodeId, direction, nodes: [], edges: [], flaggedGaps: [], permissionGaps: [],
      visitedCount: 0, depthReached: 0,
    };

    const start = await this.store.getNode(startNodeId);
    if (!start) return base;
    if (!canReadNode(start, allowed)) {
      base.permissionGaps.push(this.redact(start, '无权读取起始节点。'));
      base.visitedCount = 1;
      return base;
    }

    const nodes: LineageNode[] = [];
    const edges: LineageEdge[] = [];
    const flaggedGaps: LineageNode[] = [];
    const permissionGaps: RedactedGap[] = [];
    const visited = new Set<string>([startNodeId]);
    const edgeSeen = new Set<string>();
    let depthReached = 0;

    if (start.gap) flaggedGaps.push(start);
    else nodes.push(start);

    // BFS：队列元素为 (nodeId, depth)。
    let frontier: Array<{ nodeId: string; depth: number }> = [{ nodeId: startNodeId, depth: 0 }];
    while (frontier.length > 0) {
      const next: Array<{ nodeId: string; depth: number }> = [];
      for (const current of frontier) {
        if (current.depth >= maxDepth) continue;
        const neighbors = direction === 'upstream'
          ? await this.store.listIncoming(current.nodeId)
          : await this.store.listOutgoing(current.nodeId);
        for (const edge of neighbors) {
          if (!edgeSeen.has(edge.edgeId)) {
            edgeSeen.add(edge.edgeId);
            edges.push(edge);
          }
          const neighborId = direction === 'upstream' ? edge.fromNodeId : edge.toNodeId;
          if (visited.has(neighborId)) continue; // 防循环
          visited.add(neighborId);
          const neighbor = await this.store.getNode(neighborId);
          if (!neighbor) continue;
          depthReached = Math.max(depthReached, current.depth + 1);
          if (!canReadNode(neighbor, allowed)) {
            permissionGaps.push(this.redact(neighbor, '越权上游/下游，仅形成受限 gap。'));
            continue; // 不沿越权节点继续深入
          }
          if (neighbor.gap) flaggedGaps.push(neighbor);
          else nodes.push(neighbor);
          next.push({ nodeId: neighborId, depth: current.depth + 1 });
        }
      }
      frontier = next;
    }

    base.nodes = nodes;
    base.edges = edges;
    base.flaggedGaps = flaggedGaps;
    base.permissionGaps = permissionGaps;
    base.visitedCount = visited.size;
    base.depthReached = depthReached;
    return base;
  }

  private redact(node: LineageNode, reason: string): RedactedGap {
    return {
      nodeId: node.nodeId,
      kind: node.kind,
      authorization: node.authorization,
      gap: { type: 'permission', reason },
    };
  }
}
