import type {
  DataEventV1, LineageEdge, LineageEdgeType, LineageGap, LineageKind, LineageNode,
  LineageRetention, LineageVisibility,
} from '@lyra/shared';
import {
  LINEAGE_NODE_SCHEMA_VERSION, lineageEdgeDigest, lineageEdgeId, lineageNodeDigest, lineageNodeId,
} from '@lyra/shared';
import type { LineageFactSet, LineageStore } from './store';
import type { AuthoritativeFact, AuthoritativeInputRef, SourceLineageReader } from './source-reader';

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

function buildNode(params: {
  kind: LineageKind; businessId: string; revisionId: string | null;
  ref: LineageNode['ref']; digest: string | null;
  occurredAt: string; recordedAt: string;
  retention: LineageRetention; visibility: LineageVisibility; authorization: string;
  gap: LineageGap | null;
}): LineageNode {
  return {
    nodeId: lineageNodeId(params.kind, params.businessId, params.revisionId),
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

/**
 * 血缘专用 projector。它不重写业务、也不复用通用投影的扁平 output；而是通过
 * 只读 SourceLineageReader 在首次投影时抓取 sanitized 血缘事实集（节点 + 边 +
 * gap），写入独立的 lineage_* 表。重复事件在读取权威记录之前就判重，保证 replay
 * 不会用当前可变业务状态覆盖历史快照。
 */
export class LineageProjector {
  constructor(
    readonly consumerName: string,
    private readonly store: LineageStore,
    private readonly reader: SourceLineageReader,
    private readonly options: LineageProjectorOptions = {},
  ) {}

  async deliver(event: DataEventV1): Promise<LineageProjectResult> {
    // 先判重：已处理过的事件直接返回 duplicate，绝不重新读取权威业务状态。
    if (await this.store.hasProcessed(this.consumerName, event.eventId)) {
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

  private kindFromAggregate(event: DataEventV1): LineageKind {
    switch (event.aggregateType) {
      case 'novel_chapter': return 'novel_revision';
      case 'script': return 'script_version';
      case 'asset': return 'asset';
      case 'production_run': return 'production_run';
      case 'production_attempt': return 'production_attempt';
      case 'external_operation': return 'external_operation';
      case 'quality_check': return 'quality_check';
      case 'delivery_artifact': return 'delivery';
      default: return 'artifact';
    }
  }

  private buildFactSet(event: DataEventV1, fact: AuthoritativeFact): LineageFactSet {
    const nodes: LineageNode[] = [];
    const edges: LineageEdge[] = [];
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
    }

    const resolvedInputs = fact.inputs.filter(input => input.present).length;
    if (fact.inputs.length > 0 && resolvedInputs === 0 && !targetGap) {
      // 声明了上游引用但全部缺失：这是 orphan，而不是静默当作根节点。
      targetGap = { type: 'orphan', reason: '声明的上游引用全部无法解析。' };
    }

    const target = buildNode({
      kind: fact.kind, businessId: fact.businessId, revisionId: fact.revisionId,
      ref: fact.ref, digest: targetDigest,
      occurredAt: fact.occurredAt, recordedAt: fact.recordedAt,
      retention: fact.retention, visibility: fact.visibility, authorization: fact.authorization,
      gap: targetGap,
    });
    nodes.push(target);

    for (const input of fact.inputs) {
      const inputNode = this.buildInputNode(event, fact, input);
      nodes.push(inputNode);
      const fromNodeId = input.factIsTo ? inputNode.nodeId : target.nodeId;
      const toNodeId = input.factIsTo ? target.nodeId : inputNode.nodeId;
      edges.push(this.buildEdge(input.edgeType, fromNodeId, toNodeId, event, now));
    }

    return { nodes, edges };
  }

  private buildInputNode(event: DataEventV1, fact: AuthoritativeFact, input: AuthoritativeInputRef): LineageNode {
    if (!input.present) {
      // 缺失的上游：形成 unknown 占位节点，保留可遍历的边，但不冒充已解析事实。
      return buildNode({
        kind: input.kind,
        businessId: input.businessId,
        revisionId: input.revisionId,
        ref: { kind: 'unknown', id: input.businessId, revisionId: input.revisionId },
        digest: null,
        occurredAt: event.occurredAt,
        recordedAt: event.recordedAt,
        retention: fact.retention,
        visibility: 'internal',
        authorization: fact.authorization,
        gap: { type: 'unknown', reason: '权威记录中找不到该上游引用。' },
      });
    }
    return buildNode({
      kind: input.kind,
      businessId: input.businessId,
      revisionId: input.revisionId,
      ref: input.ref ?? { kind: input.kind, id: input.businessId, revisionId: input.revisionId },
      digest: input.digest ?? null,
      occurredAt: isoAt(event.occurredAt, input.occurredAt),
      recordedAt: isoAt(event.recordedAt, input.recordedAt),
      retention: input.retention ?? fact.retention,
      visibility: input.visibility ?? fact.visibility,
      authorization: input.authorization ?? fact.authorization,
      gap: null,
    });
  }

  private buildEdge(edgeType: LineageEdgeType, fromNodeId: string, toNodeId: string,
    event: DataEventV1, recordedAt: string): LineageEdge {
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
