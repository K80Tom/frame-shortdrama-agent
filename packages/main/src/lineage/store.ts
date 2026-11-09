import type { QueryResultRow } from 'pg';
import type {
  DataEventV1, LineageEdge, LineageNode, LineageGap,
} from '@lyra/shared';
import { lineageEdgeDigest, lineageNodeDigest } from '@lyra/shared';
import type { PostgresDatabase } from '../db/client';

/**
 * 血缘投影的唯一写入口。实现必须在一个事务里：记录事件台账 + upsert 节点 +
 * upsert 边。节点只允许从“未知/空位”一次性闭合为已解析，绝不覆盖已解析节点；
 * 边按 (类型, 两端) 去重。store 不持有、也不回写任何业务表。
 */

export interface LineageFactSet {
  nodes: LineageNode[];
  edges: LineageEdge[];
}

export interface LineageCommitResult {
  /** 同一消费者重复投影同一事件时为 false，且不产生新节点/边。 */
  applied: boolean;
  nodeCount: number;
  edgeCount: number;
}

export interface LineageStore {
  hasProcessed(consumerName: string, eventId: string): Promise<boolean>;
  commit(consumerName: string, event: DataEventV1, factSet: LineageFactSet): Promise<LineageCommitResult>;
  getNode(nodeId: string): Promise<LineageNode | null>;
  listOutgoing(nodeId: string): Promise<LineageEdge[]>;
  listIncoming(nodeId: string): Promise<LineageEdge[]>;
  listNodes(consumerName?: string): Promise<LineageNode[]>;
  listEdges(): Promise<LineageEdge[]>;
}

/* -------------------------------------------------------------------------- */
/* In-memory（离线测试 / 本地开发）                                             */
/* -------------------------------------------------------------------------- */

interface MemoryState {
  processed: Set<string>;
  nodes: Map<string, LineageNode>;
  edges: Map<string, LineageEdge>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryLineageStore implements LineageStore {
  private readonly state = {
    processed: new Set<string>(),
    nodes: new Map<string, LineageNode>(),
    edges: new Map<string, LineageEdge>(),
  };

  private processedKey(consumerName: string, eventId: string): string {
    return `${consumerName}\u0000${eventId}`;
  }

  async hasProcessed(consumerName: string, eventId: string): Promise<boolean> {
    return this.state.processed.has(this.processedKey(consumerName, eventId));
  }

  async commit(consumerName: string, event: DataEventV1, factSet: LineageFactSet): Promise<LineageCommitResult> {
    const key = this.processedKey(consumerName, event.eventId);
    if (this.state.processed.has(key)) {
      return { applied: false, nodeCount: this.state.nodes.size, edgeCount: this.state.edges.size };
    }
    // 先在内存里算完整个新状态，再一次性替换，模拟同事务提交。
    const nodes = new Map(this.state.nodes);
    let newNodes = 0;
    for (const node of factSet.nodes) {
      const existing = nodes.get(node.nodeId);
      if (!existing) {
        nodes.set(node.nodeId, clone(node));
        newNodes += 1;
      } else if (existing.digest === null && node.digest !== null) {
        // 仅允许把未知空位闭合为已解析节点。
        nodes.set(node.nodeId, clone(node));
        newNodes += 1;
      }
    }
    const edges = new Map(this.state.edges);
    let newEdges = 0;
    for (const edge of factSet.edges) {
      if (!edges.has(edge.edgeId)) {
        edges.set(edge.edgeId, clone(edge));
        newEdges += 1;
      }
    }
    this.state.nodes = nodes;
    this.state.edges = edges;
    this.state.processed = new Set(this.state.processed).add(key);
    return { applied: true, nodeCount: newNodes, edgeCount: newEdges };
  }

  async getNode(nodeId: string): Promise<LineageNode | null> {
    const node = this.state.nodes.get(nodeId);
    return node ? clone(node) : null;
  }

  async listOutgoing(nodeId: string): Promise<LineageEdge[]> {
    return [...this.state.edges.values()].filter(edge => edge.fromNodeId === nodeId).map(clone);
  }

  async listIncoming(nodeId: string): Promise<LineageEdge[]> {
    return [...this.state.edges.values()].filter(edge => edge.toNodeId === nodeId).map(clone);
  }

  async listNodes(): Promise<LineageNode[]> {
    return [...this.state.nodes.values()].map(clone);
  }

  async listEdges(): Promise<LineageEdge[]> {
    return [...this.state.edges.values()].map(clone);
  }
}

/* -------------------------------------------------------------------------- */
/* Postgres                                                                    */
/* -------------------------------------------------------------------------- */

interface PgNodeRow extends QueryResultRow {
  node_id: string; kind: LineageNode['kind']; business_id: string; revision_id: string | null;
  ref_json: LineageNode['ref']; digest: string | null; schema_version: string;
  occurred_at: unknown; recorded_at: unknown; retention: LineageNode['retention'];
  visibility: LineageNode['visibility']; authorization: string;
  gap_json: LineageGap | null;
}
interface PgEdgeRow extends QueryResultRow {
  edge_id: string; edge_type: LineageEdge['edgeType']; from_node_id: string; to_node_id: string;
  source_event_id: string | null; edge_digest: string; recorded_at: unknown;
}

const iso = (value: unknown): string => value instanceof Date
  ? value.toISOString() : new Date(String(value)).toISOString();

function nodeOf(row: PgNodeRow): LineageNode {
  return {
    nodeId: row.node_id,
    kind: row.kind,
    ref: row.ref_json,
    businessId: row.business_id,
    revisionId: row.revision_id,
    digest: row.digest,
    schemaVersion: row.schema_version,
    occurredAt: iso(row.occurred_at),
    recordedAt: iso(row.recorded_at),
    retention: row.retention,
    visibility: row.visibility,
    authorization: row.authorization,
    gap: row.gap_json,
  };
}

function edgeOf(row: PgEdgeRow): LineageEdge {
  return {
    edgeId: row.edge_id,
    edgeType: row.edge_type,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    sourceEventId: row.source_event_id,
    edgeDigest: row.edge_digest,
    recordedAt: iso(row.recorded_at),
  };
}

export class PostgresLineageStore implements LineageStore {
  constructor(private readonly database: PostgresDatabase) {}

  async hasProcessed(consumerName: string, eventId: string): Promise<boolean> {
    const result = await this.database.query<{ found: number }>(`
      SELECT 1 AS found FROM lineage_events WHERE consumer_name = $1 AND event_id = $2
    `, [consumerName, eventId]);
    return result.rows.length > 0;
  }

  async commit(consumerName: string, event: DataEventV1, factSet: LineageFactSet): Promise<LineageCommitResult> {
    return this.database.transaction(async client => {
      const ledger = await client.query<{ event_id: string }>(`
        INSERT INTO lineage_events (consumer_name, event_id, node_count, edge_count, recorded_at)
        VALUES ($1, $2, $3, $4, $5::timestamptz)
        ON CONFLICT (consumer_name, event_id) DO NOTHING
        RETURNING event_id
      `, [consumerName, event.eventId, factSet.nodes.length, factSet.edges.length,
        event.recordedAt]);
      if (!ledger.rows[0]) {
        const nodes = await client.query(`SELECT COUNT(*)::int AS c FROM lineage_nodes`);
        const edges = await client.query(`SELECT COUNT(*)::int AS c FROM lineage_edges`);
        return { applied: false, nodeCount: nodes.rows[0].c, edgeCount: edges.rows[0].c };
      }
      for (const node of factSet.nodes) {
        await client.query(`
          INSERT INTO lineage_nodes
            (node_id, kind, business_id, revision_id, ref_json, digest, schema_version,
             occurred_at, recorded_at, retention, visibility, authorization, gap_json, gap_type)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::timestamptz, $9::timestamptz,
                  $10, $11, $12, $13::jsonb, $14)
          ON CONFLICT (node_id) DO UPDATE SET
            digest = EXCLUDED.digest,
            ref_json = EXCLUDED.ref_json,
            gap_json = EXCLUDED.gap_json,
            gap_type = EXCLUDED.gap_type
          WHERE lineage_nodes.digest IS NULL AND EXCLUDED.digest IS NOT NULL
        `, [node.nodeId, node.kind, node.businessId, node.revisionId,
          JSON.stringify(node.ref), node.digest, node.schemaVersion,
          node.occurredAt, node.recordedAt, node.retention, node.visibility, node.authorization,
          node.gap ? JSON.stringify(node.gap) : null, node.gap?.type ?? null]);
      }
      for (const edge of factSet.edges) {
        await client.query(`
          INSERT INTO lineage_edges
            (edge_id, edge_type, from_node_id, to_node_id, source_event_id, edge_digest, recorded_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
          ON CONFLICT (edge_id) DO NOTHING
        `, [edge.edgeId, edge.edgeType, edge.fromNodeId, edge.toNodeId, edge.sourceEventId,
          lineageEdgeDigest(edge), edge.recordedAt]);
      }
      return { applied: true, nodeCount: factSet.nodes.length, edgeCount: factSet.edges.length };
    });
  }

  async getNode(nodeId: string): Promise<LineageNode | null> {
    const result = await this.database.query<PgNodeRow>(`
      SELECT node_id, kind, business_id, revision_id, ref_json, digest, schema_version,
             occurred_at, recorded_at, retention, visibility, authorization, gap_json
      FROM lineage_nodes WHERE node_id = $1
    `, [nodeId]);
    return result.rows[0] ? nodeOf(result.rows[0]) : null;
  }

  async listOutgoing(nodeId: string): Promise<LineageEdge[]> {
    const result = await this.database.query<PgEdgeRow>(`
      SELECT edge_id, edge_type, from_node_id, to_node_id, source_event_id, edge_digest, recorded_at
      FROM lineage_edges WHERE from_node_id = $1
    `, [nodeId]);
    return result.rows.map(edgeOf);
  }

  async listIncoming(nodeId: string): Promise<LineageEdge[]> {
    const result = await this.database.query<PgEdgeRow>(`
      SELECT edge_id, edge_type, from_node_id, to_node_id, source_event_id, edge_digest, recorded_at
      FROM lineage_edges WHERE to_node_id = $1
    `, [nodeId]);
    return result.rows.map(edgeOf);
  }

  async listNodes(): Promise<LineageNode[]> {
    const result = await this.database.query<PgNodeRow>(`
      SELECT node_id, kind, business_id, revision_id, ref_json, digest, schema_version,
             occurred_at, recorded_at, retention, visibility, authorization, gap_json
      FROM lineage_nodes ORDER BY recorded_at, node_id
    `);
    return result.rows.map(nodeOf);
  }

  async listEdges(): Promise<LineageEdge[]> {
    const result = await this.database.query<PgEdgeRow>(`
      SELECT edge_id, edge_type, from_node_id, to_node_id, source_event_id, edge_digest, recorded_at
      FROM lineage_edges ORDER BY recorded_at, edge_id
    `);
    return result.rows.map(edgeOf);
  }
}

export { lineageNodeDigest };
