import type {
  LineageEdge, LineageEdgeType, LineageGap, LineageKind, LineageNode,
  LineageRetention, LineageVisibility, LineageSourceRef, TenantDataEvent,
} from '@lyra/shared';
import {
  DATA_EVENT_LEGACY_WORKSPACE_ID, LINEAGE_NODE_SCHEMA_VERSION, lineageEdgeDigest, lineageEdgeId,
  lineageNodeDigest, lineageNodeId, workspaceIdOfDataEvent,
} from '@lyra/shared';
import type { LineageFactSet, LineageStore } from './store';
import type {
  AuthoritativeFact, AuthoritativeInputRef, AuthoritativeNodeRef, SourceLineageReader,
} from './source-reader';

export interface LineageProjectorOptions {
  now?: () => Date;
}

export interface LineageProjectResult {
  status: 'projected' | 'duplicate' | 'unknown';
  nodeCount: number;
  edgeCount: number;
}

function isoAt(fallback: string, value?: string): string {
  return value ?? fallback;
}

/** V1 保留迁移前节点身份；V2 必须按 workspace 隔离，避免跨租户同 ID 合并。 */
function scopeOf(event: TenantDataEvent): string | undefined {
  const workspaceId = workspaceIdOfDataEvent(event);
  return workspaceId === DATA_EVENT_LEGACY_WORKSPACE_ID ? undefined : workspaceId;
}

function buildNode(params: {
  kind: LineageKind; businessId: string; revisionId: string | null;
  ref: LineageSourceRef; digest: string | null;
  occurredAt: string; recordedAt: string;
  retention: LineageRetention; visibility: LineageVisibility; authorization: string;
  gap: LineageGap | null;
  workspaceId?: string;
}): LineageNode {
  return {
    // V1/legacy 事件继续使用旧确定性 ID，避免历史节点在升级后被复制成两份。
    nodeId: lineageNodeId(params.kind, params.businessId, params.revisionId,
      params.workspaceId === DATA_EVENT_LEGACY_WORKSPACE_ID ? undefined : params.workspaceId),
    kind: params.kind,
    ref: params.ref,
    businessId: params.businessId,
    revisionId: params.revisionId,
    digest: params.digest,
    schemaVersion: LINEAGE_NODE_SCHEMA_VERSION,
    occurredAt: params.occurredAt,
    recordedAt: params.recordedAt,
    retention: params.retention,
    visibility: params.visibility,
    authorization: params.authorization,
    gap: params.gap,
  };
}

function mergeNode(map: Map<string, LineageNode>, node: LineageNode): LineageNode {
  const existing = map.get(node.nodeId);
  if (!existing) {
    map.set(node.nodeId, node);
    return node;
  }
  // 已解析节点优先于 unknown 占位；同一身份绝不产生两个节点。
  if (existing.digest === null && node.digest !== null) {
    map.set(node.nodeId, node);
    return node;
  }
  return existing;
}

/**
 * 血缘专用 projector。它不重写业务、也不复用通用投影的扁平 output；而是通过
 * 只读 SourceLineageReader 在首次投影时抓取 sanitized 血缘事实集（节点 + 边 +
 * gap + 多跳 links），写入独立的 lineage_* 表。重复事件在读取权威记录之前就判重，
 * 保证 replay 不会用当前可变业务状态覆盖历史快照。
 */
export class LineageProjector {
  constructor(
    readonly consumerName: string,
    private readonly store: LineageStore,
    private readonly reader: SourceLineageReader,
    private readonly options: LineageProjectorOptions = {},
  ) {}

  async deliver(event: TenantDataEvent): Promise<LineageProjectResult> {
    const workspaceId = workspaceIdOfDataEvent(event);
    // 先判重：已处理过的事件直接返回 duplicate，绝不重新读取权威业务状态。
    if (await this.store.hasProcessed(this.consumerName, event.eventId, workspaceId)) {
      return { status: 'duplicate', nodeCount: 0, edgeCount: 0 };
    }

    const fact = await this.reader.resolve(event);
    if (!fact) {
      // 连当前事实都无法在权威记录定位：记录一个 unknown 根节点，不猜关系。
      const placeholder = buildNode({
        kind: this.kindFromAggregate(event),
        businessId: event.aggregateId,
        revisionId: event.authoritativeRef.revisionId,
        ref: { kind: 'unknown', id: event.authoritativeRef.id, revisionId: event.authoritativeRef.revisionId },
        digest: null,
        occurredAt: event.occurredAt,
        recordedAt: event.recordedAt,
        retention: 'run_lifetime',
        visibility: 'internal',
        authorization: 'project:read',
        gap: { type: 'unknown', reason: '权威记录无法定位该聚合。' },
        workspaceId: scopeOf(event),
      });
      const committed = await this.store.commit(this.consumerName, event, {
        nodes: [placeholder], edges: [],
      });
      return { status: 'unknown', nodeCount: committed.nodeCount, edgeCount: 0 };
    }

    const { nodes, edges } = this.buildFactSet(event, fact);
    const committed = await this.store.commit(this.consumerName, event, { nodes, edges });
    return { status: committed.applied ? 'projected' : 'duplicate',
      nodeCount: committed.nodeCount, edgeCount: committed.edgeCount };
  }

  private kindFromAggregate(event: TenantDataEvent): LineageKind {
    switch (event.aggregateType) {
      case 'novel_chapter': return 'novel_revision';
      case 'script': return 'script_version';
      case 'shot_spec': return 'shot_spec';
      case 'asset': return 'asset';
      case 'production_run': return 'production_run';
      case 'production_attempt': return 'production_attempt';
      case 'external_operation': return 'external_operation';
      case 'quality_check': return 'quality_check';
      case 'delivery_artifact': return 'delivery';
      case 'production_input': return 'production_input';
      case 'evaluation_run': return 'evaluation_run';
      default: return 'artifact';
    }
  }

  private buildFactSet(event: TenantDataEvent, fact: AuthoritativeFact): LineageFactSet {
    const workspaceId = fact.workspaceId ?? scopeOf(event);
    const nodeMap = new Map<string, LineageNode>();
    const edgeMap = new Map<string, LineageEdge>();
    const now = event.recordedAt;

    // 当前事实节点；digest 不一致时记为 digest gap，但仍保存权威身份。
    let targetGap: LineageGap | null = null;
    let targetDigest: string | null = fact.digest;
    if (fact.digestMismatch) {
      targetGap = {
        type: 'digest',
        reason: '权威摘要与历史快照不一致。',
        expectedDigest: fact.digestMismatch.expected,
        actualDigest: fact.digestMismatch.actual,
      };
      targetDigest = null;
    } else if (fact.gap) {
      targetGap = fact.gap;
    }

    const resolvedInputs = fact.inputs.filter(input => input.present).length;
    if (fact.inputs.length > 0 && resolvedInputs === 0 && !targetGap) {
      // 声明了上游引用但全部缺失：这是 orphan，而不是静默当作根节点。
      targetGap = { type: 'orphan', reason: '声明的上游引用全部无法解析。' };
    }

    const target = mergeNode(nodeMap, buildNode({
      kind: fact.kind, businessId: fact.businessId, revisionId: fact.revisionId,
      ref: fact.ref, digest: targetDigest,
      occurredAt: fact.occurredAt, recordedAt: fact.recordedAt,
      retention: fact.retention, visibility: fact.visibility, authorization: fact.authorization,
      gap: targetGap,
      workspaceId,
    }));

    const addEdge = (edgeType: LineageEdgeType, fromNodeId: string, toNodeId: string) => {
      if (fromNodeId === toNodeId) return;
      const edge = this.buildEdge(edgeType, fromNodeId, toNodeId, event, now);
      if (!edgeMap.has(edge.edgeId)) edgeMap.set(edge.edgeId, edge);
    };

    // 完整多跳关系先入库，覆盖“剧本→镜头→资产→成片”的双向链。
    for (const link of fact.links ?? []) {
      const from = mergeNode(nodeMap, this.buildLinkNode(event, fact, link.from, workspaceId));
      const to = mergeNode(nodeMap, this.buildLinkNode(event, fact, link.to, workspaceId));
      addEdge(link.edgeType, from.nodeId, to.nodeId);
    }

    for (const input of fact.inputs) {
      const inputNode = mergeNode(nodeMap, this.buildInputNode(event, fact, input, workspaceId));
      const fromNodeId = input.factIsTo ? inputNode.nodeId : target.nodeId;
      const toNodeId = input.factIsTo ? target.nodeId : inputNode.nodeId;
      addEdge(input.edgeType, fromNodeId, toNodeId);
    }

    return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()], workspaceId };
  }

  private buildInputNode(event: TenantDataEvent, fact: AuthoritativeFact,
    input: AuthoritativeInputRef, workspaceId?: string): LineageNode {
    return this.buildLinkNode(event, fact, {
      kind: input.kind,
      businessId: input.businessId,
      revisionId: input.revisionId,
      present: input.present,
      ref: input.ref,
      digest: input.digest,
      occurredAt: input.occurredAt,
      recordedAt: input.recordedAt,
      retention: input.retention,
      visibility: input.visibility,
      authorization: input.authorization,
    }, workspaceId);
  }

  private buildLinkNode(event: TenantDataEvent, fact: AuthoritativeFact,
    ref: AuthoritativeNodeRef, workspaceId?: string): LineageNode {
    // 已解析节点必须有权威 digest；没有 digest 的“present”引用不能冒充已解析事实。
    if (ref.present === false || !ref.digest) {
      // 缺失的引用：形成 unknown 占位节点，保留可遍历的边，但不冒充已解析事实。
      return buildNode({
        kind: ref.kind,
        businessId: ref.businessId,
        revisionId: ref.revisionId,
        ref: { kind: 'unknown', id: ref.businessId, revisionId: ref.revisionId },
        digest: null,
        occurredAt: event.occurredAt,
        recordedAt: event.recordedAt,
        retention: ref.retention ?? fact.retention,
        visibility: 'internal',
        authorization: ref.authorization ?? fact.authorization,
        gap: { type: 'unknown', reason: '权威记录中找不到该引用。' },
        workspaceId,
      });
    }
    return buildNode({
      kind: ref.kind,
      businessId: ref.businessId,
      revisionId: ref.revisionId,
      ref: ref.ref ?? { kind: ref.kind, id: ref.businessId, revisionId: ref.revisionId },
      digest: ref.digest ?? null,
      occurredAt: isoAt(event.occurredAt, ref.occurredAt),
      recordedAt: isoAt(event.recordedAt, ref.recordedAt),
      retention: ref.retention ?? fact.retention,
      visibility: ref.visibility ?? fact.visibility,
      authorization: ref.authorization ?? fact.authorization,
      gap: null,
      workspaceId,
    });
  }

  private buildEdge(edgeType: LineageEdgeType, fromNodeId: string, toNodeId: string,
    event: TenantDataEvent, recordedAt: string): LineageEdge {
    const edgeId = lineageEdgeId(edgeType, fromNodeId, toNodeId);
    return {
      edgeId,
      edgeType,
      fromNodeId,
      toNodeId,
      sourceEventId: event.eventId,
      edgeDigest: lineageEdgeDigest({ edgeType, fromNodeId, toNodeId }),
      recordedAt,
    };
  }
}

export { lineageNodeDigest };
