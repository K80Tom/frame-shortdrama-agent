import { createHash } from 'node:crypto';
import { canonicalDigest } from './production';

/**
 * 统一血缘（#50）共享契约。
 *
 * 血缘节点/边只保存权威 SourceRef、业务 ID/revision/digest、schema/version、
 * 时间、保留期、可见性与所需授权；不复制正文、提示词或媒体字节。节点一旦
 * 投影即不可变；同一权威身份（kind+businessId+revisionId）幂等复用。
 *
 * 本模块只含类型、纯函数与错误定义，不连接数据库、不读取密钥、不回写业务事实。
 */

export const LINEAGE_NODE_SCHEMA_VERSION = 'lyra.lineage.node/v1';
export const LINEAGE_EDGE_SCHEMA_VERSION = 'lyra.lineage.edge/v1';
export const LINEAGE_MAX_SCOPE_LENGTH = 64;

export type LineageKind =
  | 'novel_source' | 'novel_revision'
  | 'script_version' | 'plan_revision' | 'storyboard_revision' | 'shot_spec'
  | 'asset'
  | 'production_run' | 'production_task' | 'production_attempt'
  | 'external_operation' | 'production_input'
  | 'quality_check' | 'review_decision'
  | 'artifact' | 'timeline_revision' | 'delivery' | 'evaluation_run';

export const LINEAGE_KINDS: readonly LineageKind[] = Object.freeze([
  'novel_source', 'novel_revision',
  'script_version', 'plan_revision', 'storyboard_revision', 'shot_spec',
  'asset',
  'production_run', 'production_task', 'production_attempt',
  'external_operation', 'production_input',
  'quality_check', 'review_decision',
  'artifact', 'timeline_revision', 'delivery', 'evaluation_run',
]);

/**
 * 有向边统一约定：fromNodeId 为上游（来源），toNodeId 为下游（派生/被使用/
 * 被生成/被校验/被替代/被交付）。edgeType 描述这条关系的语义。
 * 双向索引在存储层提供，正向沿 from→to，反向沿 to→from；禁止按时间接近猜关系。
 */
export type LineageEdgeType =
  | 'derived-from'   // 下游内容派生自上游权威版本（script <- novel_revision）
  | 'used-by'        // 上游输入被下游任务/产物使用（asset -> production_task）
  | 'generated-by'    // 下游产物由上游外部操作生成（artifact <- external_operation）
  | 'validated-by'   // 下游对象由上游检查/复核验证（artifact <- quality_check/review）
  | 'supersedes'     // 下游新版本替代上游旧版本（new_revision <- old_revision）
  | 'delivered-as';  // 上游运行/产物以下游交付记录形式交付（delivery <- artifact）

export const LINEAGE_EDGE_TYPES: readonly LineageEdgeType[] = Object.freeze([
  'derived-from', 'used-by', 'generated-by', 'validated-by', 'supersedes', 'delivered-as',
]);

export type LineageGapType = 'unknown' | 'orphan' | 'digest' | 'permission';

export const LINEAGE_GAP_TYPES: readonly LineageGapType[] = Object.freeze([
  'unknown', 'orphan', 'digest', 'permission',
]);

export type LineageRetention = 'project_lifetime' | 'run_lifetime' | 'replay_lifetime';
export type LineageVisibility = 'public' | 'internal' | 'confidential';

export const LINEAGE_RETENTIONS: readonly LineageRetention[] = Object.freeze([
  'project_lifetime', 'run_lifetime', 'replay_lifetime',
]);
export const LINEAGE_VISIBILITIES: readonly LineageVisibility[] = Object.freeze([
  'public', 'internal', 'confidential',
]);

export class LineageContractError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Array<{ path: string; code: string; message: string }> = [],
  ) {
    super(message);
    this.name = 'LineageContractError';
    this.details = details;
  }
}

function invalid(path: string, message: string, code = 'LINEAGE_INPUT_INVALID'): never {
  throw new LineageContractError(400, code, '血缘契约校验失败。', [{ path, code, message }]);
}

function object(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(path, '必须是对象。');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) invalid(`${path}.${key}`, '未知字段。');
  }
  return record;
}

function required(record: Record<string, unknown>, key: string, path: string): unknown {
  if (!(key in record) || record[key] === undefined) invalid(`${path}.${key}`, '缺少字段。');
  return record[key];
}

function text(value: unknown, path: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim()) invalid(path, '必须是非空字符串。');
  if (value.length > max) invalid(path, `长度不能超过 ${max}。`);
  return value;
}

function safeId(value: unknown, path: string, label = 'ID', max = 160): string {
  const parsed = text(value, path, max);
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{2,159}$/u.test(parsed)) invalid(path, `${label} 格式不合法。`);
  return parsed;
}

function enumValue<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    invalid(path, `必须是 ${allowed.join(' / ')}。`);
  }
  return value as T;
}

function timestamp(value: unknown, path: string): string {
  const parsed = text(value, path, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(parsed)
    || Number.isNaN(Date.parse(parsed))) invalid(path, '必须是 UTC ISO 8601 时间。');
  return new Date(parsed).toISOString();
}

function digest(value: unknown, path: string): string {
  const parsed = text(value, path, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) invalid(path, '必须是 64 位小写十六进制摘要。');
  return parsed;
}

function nodeId(value: unknown, path: string): string {
  const parsed = text(value, path, 48);
  if (!/^ln_[a-f0-9]{32}$/u.test(parsed)) invalid(path, '节点 ID 格式不合法。');
  return parsed;
}

function edgeId(value: unknown, path: string): string {
  const parsed = text(value, path, 48);
  if (!/^le_[a-f0-9]{32}$/u.test(parsed)) invalid(path, '边 ID 格式不合法。');
  return parsed;
}

function eventIdRef(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  const parsed = text(value, path, 40);
  if (!/^evt_[a-f0-9]{32}$/u.test(parsed)) invalid(path, '来源事件 ID 格式不合法。');
  return parsed;
}

function scope(value: unknown, path: string): string {
  const parsed = text(value, path, LINEAGE_MAX_SCOPE_LENGTH);
  if (!/^[a-z]+:[a-z]+$/u.test(parsed)) invalid(path, '授权 scope 必须为 域:动作。');
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* 权威引用                                                                    */
/* -------------------------------------------------------------------------- */

/** 只读权威来源定位；kind 为系统记录（systemOfRecord），不存正文。 */
export interface LineageSourceRef {
  kind: string;
  id: string;
  revisionId: string | null;
}

function parseSourceRef(value: unknown, path: string): LineageSourceRef {
  const record = object(value, path, ['kind', 'id', 'revisionId']);
  return {
    kind: safeId(required(record, 'kind', path), `${path}.kind`, '权威来源类型', 64),
    id: safeId(required(record, 'id', path), `${path}.id`, '权威来源 ID'),
    revisionId: record.revisionId === null ? null
      : safeId(record.revisionId, `${path}.revisionId`, '权威 revision ID'),
  };
}

/* -------------------------------------------------------------------------- */
/* Gap                                                                         */
/* -------------------------------------------------------------------------- */

export interface LineageGap {
  type: LineageGapType;
  reason: string;
  expectedDigest?: string;
  actualDigest?: string;
}

function parseGap(value: unknown, path: string): LineageGap | null {
  if (value === null || value === undefined) return null;
  const record = object(value, path, ['type', 'reason', 'expectedDigest', 'actualDigest']);
  const type = enumValue(required(record, 'type', path), `${path}.type`, LINEAGE_GAP_TYPES);
  const gap: LineageGap = {
    type,
    reason: text(required(record, 'reason', path), `${path}.reason`, 500),
  };
  if (record.expectedDigest !== undefined && record.expectedDigest !== null) {
    gap.expectedDigest = digest(record.expectedDigest, `${path}.expectedDigest`);
  }
  if (record.actualDigest !== undefined && record.actualDigest !== null) {
    gap.actualDigest = digest(record.actualDigest, `${path}.actualDigest`);
  }
  return gap;
}

/* -------------------------------------------------------------------------- */
/* 节点 / 边                                                                    */
/* -------------------------------------------------------------------------- */

export interface LineageNode {
  nodeId: string;
  kind: LineageKind;
  ref: LineageSourceRef;
  businessId: string;
  revisionId: string | null;
  /** unknown gap 节点没有权威摘要；其余节点必须有 64 位摘要。 */
  digest: string | null;
  schemaVersion: string;
  occurredAt: string;
  recordedAt: string;
  retention: LineageRetention;
  visibility: LineageVisibility;
  authorization: string;
  gap: LineageGap | null;
}

export interface LineageEdge {
  edgeId: string;
  edgeType: LineageEdgeType;
  fromNodeId: string;
  toNodeId: string;
  sourceEventId: string | null;
  edgeDigest: string;
  recordedAt: string;
}

/* -------------------------------------------------------------------------- */
/* 确定性身份                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 节点的权威业务身份键；同一身份永远得到同一 nodeId。
 * 可选的 workspaceId 用于 Stage 1 多租户隔离：不同 workspace 的相同业务 ID
 * 必须得到不同节点。省略 workspace 时保留迁移前 V1 节点的确定性 ID。
 */
export function lineageNodeKey(kind: LineageKind, businessId: string, revisionId: string | null,
  workspaceId?: string): string {
  const scope = workspaceId ? `${workspaceId}:` : '';
  return `${scope}${kind}:${businessId}:${revisionId ?? ''}`;
}

export function lineageNodeId(kind: LineageKind, businessId: string, revisionId: string | null,
  workspaceId?: string): string {
  const hash = createHash('sha256').update(lineageNodeKey(kind, businessId, revisionId, workspaceId)).digest('hex');
  return `ln_${hash.slice(0, 32)}`;
}

/** 边的唯一逻辑键；重复关系不会产生第二条边。 */
export function lineageEdgeKey(edgeType: LineageEdgeType, fromNodeId: string, toNodeId: string): string {
  return `${edgeType}:${fromNodeId}:${toNodeId}`;
}

export function lineageEdgeId(edgeType: LineageEdgeType, fromNodeId: string, toNodeId: string): string {
  const hash = createHash('sha256').update(lineageEdgeKey(edgeType, fromNodeId, toNodeId)).digest('hex');
  return `le_${hash.slice(0, 32)}`;
}

/* -------------------------------------------------------------------------- */
/* 摘要                                                                        */
/* -------------------------------------------------------------------------- */

export function lineageNodeDigest(node: Pick<LineageNode, 'kind' | 'ref' | 'businessId' | 'revisionId'
  | 'digest' | 'retention' | 'visibility' | 'authorization'>): string {
  return canonicalDigest({
    kind: node.kind,
    ref: node.ref,
    businessId: node.businessId,
    revisionId: node.revisionId,
    digest: node.digest,
    retention: node.retention,
    visibility: node.visibility,
    authorization: node.authorization,
  });
}

export function lineageEdgeDigest(edge: Pick<LineageEdge, 'edgeType' | 'fromNodeId' | 'toNodeId'>): string {
  return canonicalDigest({ edgeType: edge.edgeType, from: edge.fromNodeId, to: edge.toNodeId });
}

/* -------------------------------------------------------------------------- */
/* 解析                                                                        */
/* -------------------------------------------------------------------------- */

const NODE_KEYS = ['nodeId', 'kind', 'ref', 'businessId', 'revisionId', 'digest', 'schemaVersion',
  'occurredAt', 'recordedAt', 'retention', 'visibility', 'authorization', 'gap'] as const;
const EDGE_KEYS = ['edgeId', 'edgeType', 'fromNodeId', 'toNodeId', 'sourceEventId', 'edgeDigest',
  'recordedAt'] as const;

export function parseLineageNode(value: unknown, path = 'node'): LineageNode {
  const record = object(value, path, NODE_KEYS);
  const kind = enumValue(required(record, 'kind', path), `${path}.kind`, LINEAGE_KINDS);
  const businessId = safeId(required(record, 'businessId', path), `${path}.businessId`, '业务 ID');
  const revisionId = record.revisionId === null ? null
    : safeId(record.revisionId, `${path}.revisionId`, '业务 revision ID');
  const ref = parseSourceRef(required(record, 'ref', path), `${path}.ref`);
  const gap = parseGap(record.gap, `${path}.gap`);
  const rawDigest = record.digest === null ? null : digest(record.digest, `${path}.digest`);
  // unknown/digest gap 允许 digest 缺失或为占位；其余情况必须有权威摘要。
  if (rawDigest === null && gap?.type !== 'unknown' && gap?.type !== 'digest') {
    invalid(`${path}.digest`, '已解析节点必须提供权威摘要。');
  }
  const node: LineageNode = {
    nodeId: nodeId(required(record, 'nodeId', path), `${path}.nodeId`),
    kind, ref, businessId, revisionId,
    digest: rawDigest,
    schemaVersion: text(required(record, 'schemaVersion', path), `${path}.schemaVersion`, 96),
    occurredAt: timestamp(required(record, 'occurredAt', path), `${path}.occurredAt`),
    recordedAt: timestamp(required(record, 'recordedAt', path), `${path}.recordedAt`),
    retention: enumValue(required(record, 'retention', path), `${path}.retention`, LINEAGE_RETENTIONS),
    visibility: enumValue(required(record, 'visibility', path), `${path}.visibility`, LINEAGE_VISIBILITIES),
    authorization: scope(required(record, 'authorization', path), `${path}.authorization`),
    gap,
  };
  if (node.occurredAt > node.recordedAt) invalid(`${path}.occurredAt`, '发生时间不能晚于记录时间。');
  return node;
}

export function parseLineageEdge(value: unknown, path = 'edge'): LineageEdge {
  const record = object(value, path, EDGE_KEYS);
  const edgeType = enumValue(required(record, 'edgeType', path), `${path}.edgeType`, LINEAGE_EDGE_TYPES);
  const fromNode = nodeId(required(record, 'fromNodeId', path), `${path}.fromNodeId`);
  const toNode = nodeId(required(record, 'toNodeId', path), `${path}.toNodeId`);
  if (fromNode === toNode) invalid(`${path}.toNodeId`, '边不能自环。');
  const edge: LineageEdge = {
    edgeId: edgeId(required(record, 'edgeId', path), `${path}.edgeId`),
    edgeType, fromNodeId: fromNode, toNodeId: toNode,
    sourceEventId: eventIdRef(record.sourceEventId, `${path}.sourceEventId`),
    edgeDigest: digest(required(record, 'edgeDigest', path), `${path}.edgeDigest`),
    recordedAt: timestamp(required(record, 'recordedAt', path), `${path}.recordedAt`),
  };
  // 边身份必须可由 (类型, 两端) 复算，防止手工伪造重复关系。
  if (edge.edgeId !== lineageEdgeId(edgeType, fromNode, toNode)) {
    invalid(`${path}.edgeId`, '边 ID 与 (类型, 两端) 不一致。', 'LINEAGE_EDGE_ID_MISMATCH');
  }
  return edge;
}

/* -------------------------------------------------------------------------- */
/* 权限                                                                        */
/* -------------------------------------------------------------------------- */

/** 调用方持有任一 scope 即可读取该节点。 */
export function canReadNode(node: Pick<LineageNode, 'authorization'>,
  allowedScopes: readonly string[]): boolean {
  return allowedScopes.includes(node.authorization);
}
