import { createHash } from 'node:crypto';

/**
 * Agent / Tool 公共契约。
 *
 * 这里只有类型、错误码与纯函数：不连接数据库、不读取密钥、不发起网络请求。
 * 真实执行由 main 注入；agent 只能提出 proposal，不能自行放大权限或预算。
 */

export class AgentContractError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AgentContractError';
  }
}

export type JsonObject = Record<string, unknown>;

/** 仅描述契约实际使用的 JSON Schema 子集，避免引入供应商私有扩展。 */
export interface ToolJsonSchema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean';
  properties?: Record<string, ToolJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ToolJsonSchema;
  enum?: Array<string | number | boolean>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  description?: string;
}

export type ToolSideEffect = 'none' | 'internal_write' | 'external_write' | 'paid_external';
export type ToolExecutionOwner = 'agent_selectable' | 'workflow_only' | 'runtime_internal';
export type ToolStatus = 'draft' | 'frozen' | 'deprecated' | 'disabled';
export type ToolPermissionLevel = 'workspace_read' | 'workspace_write' | 'workspace_admin' | 'platform_admin';
export type ToolSensitivity = 'public' | 'internal' | 'confidential' | 'restricted';

export interface ToolCostPolicy {
  /** 估价器版本；模型自报金额永远不可信。 */
  estimatorRevision: string;
  budgetDimension: 'tokens' | 'money' | 'calls';
  estimateMicros: number;
  currency: string;
}

export interface ToolIdempotencyPolicy {
  strategy: 'none' | 'tool_call_id' | 'client_request_id' | 'content_digest';
  keyVersion: number;
}

export interface ToolRetryPolicy {
  timeoutMs: number;
  maxAttempts: number;
  backoffMs: number;
  /** 可安全重试的 reason code；其余失败一律不得自动重试。 */
  retryableCodes: string[];
  /** 外部结果未知，只能进入对账，不能当普通失败重试。 */
  unknownCodes: string[];
}

export interface ToolCapability {
  async: boolean;
  reconcile: boolean;
  cancel: boolean;
}

export interface ToolProviderPolicy {
  /** 允许访问的出站 Host；Adapter 不得接受模型自带地址。 */
  hosts: string[];
  /** 冻结的 ModelConnection revision；不保存密钥。 */
  modelConnections: string[];
}

export interface ToolLimits {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxItems: number;
}

export interface ToolProduces {
  entities: string[];
  revisions: string[];
  artifacts: string[];
  evidence: string[];
  events: string[];
}

/** 不可变 Tool Version。被 Run 引用后任何字段都不能原地修改。 */
export interface ToolDefinition {
  toolId: string;
  version: string;
  displayName: string;
  description: string;
  ownerDomain: string;
  inputSchema: ToolJsonSchema;
  outputSchema: ToolJsonSchema;
  inputSchemaDigest: string;
  outputSchemaDigest: string;
  manifestDigest: string;
  sideEffect: ToolSideEffect;
  executionOwner: ToolExecutionOwner;
  requiredPermission: ToolPermissionLevel;
  /** 静态 allowlist：空数组表示不向任何 Agent 暴露。 */
  allowedAgentIds: string[];
  allowedWorkflowIds: string[];
  sensitivity: { input: ToolSensitivity; output: ToolSensitivity };
  cost: ToolCostPolicy | null;
  idempotency: ToolIdempotencyPolicy;
  retry: ToolRetryPolicy;
  capability: ToolCapability;
  providers: ToolProviderPolicy;
  limits: ToolLimits;
  produces: ToolProduces;
  adapterDigest: string;
  status: ToolStatus;
  frozenAt?: string;
}

/** 只保留可公开的 Tool 元信息，不包含 Adapter 实现、Endpoint 或密钥引用。 */
export type PublicToolDefinition = Omit<ToolDefinition, 'adapterDigest' | 'providers'> & {
  providers: { hosts: string[] };
};

export interface ToolVersionRef {
  toolId: string;
  version: string;
  manifestDigest: string;
}

export interface ToolCallProposal {
  proposalId: string;
  runId: string;
  stepId: string;
  toolId: string;
  version: string;
  /** 提案时的 manifest digest；与实际 Registry 不一致时拒绝。 */
  manifestDigest: string;
  arguments: JsonObject;
  /** 可公开的调用理由摘要，不保存模型隐藏推理。 */
  reasonSummary: string;
}

export type ToolInvocationState =
  | 'proposed'
  | 'rejected'
  | 'awaiting_approval'
  | 'approved'
  | 'queued'
  | 'running'
  | 'waiting_external'
  | 'reconciling'
  | 'interrupted'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'inconclusive';

export interface ToolResult {
  invocationId: string;
  attemptId: string;
  status: 'succeeded' | 'failed' | 'cancelled' | 'inconclusive';
  reasonCode: string;
  /** 面向用户/审计的摘要；不得包含 Prompt、供应商原始报文、媒体字节或签名 URL。 */
  summary: string;
  outputSchemaDigest: string;
  references: Array<{
    kind: 'entity' | 'revision' | 'artifact' | 'evidence' | 'event' | 'object';
    id: string;
    revision?: string;
    digest?: string;
  }>;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  cost: { estimateMicros: number; reservedMicros: number; settledMicros: number; currency: string };
  provider: { provider?: string; model?: string; connectionRevision?: string };
  startedAt: string;
  endedAt: string;
  reconciliation: 'not_required' | 'pending' | 'reconciled' | 'mismatch';
  sensitivity: ToolSensitivity;
}

export type ToolPermissionDecision = 'allow' | 'require_confirmation' | 'deny';

export interface ToolPermissionVerdict {
  decision: ToolPermissionDecision;
  reasonCode: string;
  /** 触发拦截的规则 ID，便于审计与测试。 */
  rule: string | null;
  sideEffect: ToolSideEffect;
}

export interface ToolInvocationRecord {
  invocationId: string;
  workspaceId: string;
  agentRunId: string;
  stepId: string;
  tool: ToolVersionRef;
  state: ToolInvocationState;
  version: number;
  idempotencyKey: string;
  proposal: ToolCallProposal;
  approvalRequestId?: string;
  result?: ToolResult;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

const TOOL_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

/** 稳定 JSON：对象键递归排序，保证 manifest digest 可复算。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new AgentContractError(500, 'AGENT_CONTRACT_UNSERIALIZABLE', '契约包含不可序列化的值。');
}

export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function toolVersionKey(toolId: string, version: string): string {
  return `${toolId}@${version}`;
}

export function parseToolVersionKey(value: string): { toolId: string; version: string } {
  const at = value.lastIndexOf('@');
  if (at <= 0) throw new AgentContractError(400, 'AGENT_TOOL_REF_INVALID', '工具版本引用必须形如 tool-id@1.2.3。');
  const toolId = value.slice(0, at);
  const version = value.slice(at + 1);
  if (!TOOL_ID_PATTERN.test(toolId) || !VERSION_PATTERN.test(version)) {
    throw new AgentContractError(400, 'AGENT_TOOL_REF_INVALID', '工具版本引用必须形如 tool-id@1.2.3。');
  }
  return { toolId, version };
}

function semverParts(value: string): [number, number, number] {
  const parts = value.split('.').map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function compareSemver(left: string, right: string): number {
  const [a, b, c] = semverParts(left);
  const [x, y, z] = semverParts(right);
  return a !== x ? a - x : b !== y ? b - y : c - z;
}

/**
 * 支持精确版本、`*`、`^1.2.3`、`^0.2.3`、`^0.0.3`、`^1`、`^1.2`。
 * 不做通配符区间猜测：无法识别的范围直接拒绝，避免扩大权限。
 */
export function versionSatisfies(version: string, range: string): boolean {
  if (!VERSION_PATTERN.test(version)) return false;
  const wanted = range.trim();
  if (wanted === '' || wanted === '*' || wanted === 'latest') return true;
  if (VERSION_PATTERN.test(wanted)) return version === wanted;
  const caret = /^\^(?:(\d+)\.(\d+)\.(\d+)|(\d+)\.(\d+)|(\d+))$/.exec(wanted);
  if (!caret) throw new AgentContractError(400, 'AGENT_TOOL_RANGE_INVALID', `不支持的版本范围：${range}。`);
  const [vMajor, vMinor] = semverParts(version);
  if (caret[1] !== undefined && caret[2] !== undefined && caret[3] !== undefined) {
    const major = Number(caret[1]);
    const minor = Number(caret[2]);
    if (major > 0) return vMajor === major && compareSemver(version, wanted.slice(1)) >= 0;
    if (minor > 0) return vMajor === 0 && vMinor === minor && compareSemver(version, wanted.slice(1)) >= 0;
    return version === wanted.slice(1);
  }
  if (caret[4] !== undefined && caret[5] !== undefined) {
    return vMajor === Number(caret[4]) && vMinor === Number(caret[5]);
  }
  if (caret[6] !== undefined) return vMajor === Number(caret[6]);
  return false;
}

/** 共享同一套字段顺序，便于跨包生成一致的 digest。 */
export function toolManifestPayload(definition: ToolDefinition): JsonObject {
  return {
    toolId: definition.toolId,
    version: definition.version,
    displayName: definition.displayName,
    description: definition.description,
    ownerDomain: definition.ownerDomain,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    inputSchemaDigest: definition.inputSchemaDigest,
    outputSchemaDigest: definition.outputSchemaDigest,
    sideEffect: definition.sideEffect,
    executionOwner: definition.executionOwner,
    requiredPermission: definition.requiredPermission,
    allowedAgentIds: [...definition.allowedAgentIds].sort(),
    allowedWorkflowIds: [...definition.allowedWorkflowIds].sort(),
    sensitivity: definition.sensitivity,
    cost: definition.cost,
    idempotency: definition.idempotency,
    retry: definition.retry,
    capability: definition.capability,
    providers: { hosts: [...definition.providers.hosts].sort(), modelConnections: [...definition.providers.modelConnections].sort() },
    limits: definition.limits,
    produces: definition.produces,
    adapterDigest: definition.adapterDigest,
    status: definition.status,
  };
}

export function computeToolManifestDigest(definition: ToolDefinition): string {
  return digestOf(toolManifestPayload(definition));
}

/** 注册前做结构校验；失败直接抛错，不允许半成品进入 Registry。 */
export function assertToolDefinition(definition: ToolDefinition): void {
  if (!TOOL_ID_PATTERN.test(definition.toolId)) {
    throw new AgentContractError(500, 'AGENT_TOOL_ID_INVALID', `工具 ID 不合法：${definition.toolId}。`);
  }
  if (!VERSION_PATTERN.test(definition.version)) {
    throw new AgentContractError(500, 'AGENT_TOOL_VERSION_INVALID', `工具版本必须是 semver：${definition.version}。`);
  }
  if (!definition.displayName.trim() || !definition.description.trim()) {
    throw new AgentContractError(500, 'AGENT_TOOL_DESCRIPTION_REQUIRED', '工具必须有可展示名称与说明。');
  }
  for (const digest of [definition.inputSchemaDigest, definition.outputSchemaDigest, definition.manifestDigest, definition.adapterDigest]) {
    if (!DIGEST_PATTERN.test(digest)) throw new AgentContractError(500, 'AGENT_TOOL_DIGEST_INVALID', '工具 digest 必须是 sha256 十六进制。');
  }
  if (definition.inputSchemaDigest !== digestOf(definition.inputSchema)) {
    throw new AgentContractError(500, 'AGENT_TOOL_SCHEMA_DIGEST_MISMATCH', '输入 Schema digest 与内容不一致。');
  }
  if (definition.outputSchemaDigest !== digestOf(definition.outputSchema)) {
    throw new AgentContractError(500, 'AGENT_TOOL_SCHEMA_DIGEST_MISMATCH', '输出 Schema digest 与内容不一致。');
  }
  if (definition.manifestDigest !== computeToolManifestDigest(definition)) {
    throw new AgentContractError(500, 'AGENT_TOOL_MANIFEST_DIGEST_MISMATCH', 'Tool manifest digest 与内容不一致。');
  }
  if (definition.sideEffect === 'paid_external' && definition.cost === null) {
    throw new AgentContractError(500, 'AGENT_TOOL_COST_POLICY_REQUIRED', '付费工具必须声明估价与预算策略。');
  }
  if (definition.sideEffect === 'paid_external' && definition.executionOwner === 'agent_selectable') {
    throw new AgentContractError(500, 'AGENT_TOOL_PAID_OWNER_INVALID', '付费工具不能由模型直接选择执行，必须归 Workflow。');
  }
  if (definition.cost !== null && (!Number.isSafeInteger(definition.cost.estimateMicros) || definition.cost.estimateMicros < 0)) {
    throw new AgentContractError(500, 'AGENT_TOOL_COST_INVALID', '估价必须是安全的非负整数（micros）。');
  }
  if (definition.retry.timeoutMs < 1 || definition.retry.timeoutMs > 30 * 60 * 1000) {
    throw new AgentContractError(500, 'AGENT_TOOL_TIMEOUT_INVALID', '工具超时必须在 1ms 到 30 分钟之间。');
  }
  if (definition.retry.maxAttempts < 1 || definition.retry.maxAttempts > 10) {
    throw new AgentContractError(500, 'AGENT_TOOL_ATTEMPTS_INVALID', '工具最大尝试次数必须在 1 到 10 之间。');
  }
  if (definition.limits.maxInputBytes < 1 || definition.limits.maxOutputBytes < 1) {
    throw new AgentContractError(500, 'AGENT_TOOL_LIMIT_INVALID', '工具输入/输出上限必须为正数。');
  }
  if (definition.sideEffect === 'none' && definition.cost !== null && definition.cost.estimateMicros > 0) {
    throw new AgentContractError(500, 'AGENT_TOOL_COST_INVALID', '只读工具不能声明付费估价。');
  }
}

/** 构造一份 schema digest 正确的 ToolDefinition。 */
export function defineTool(definition: Omit<ToolDefinition, 'inputSchemaDigest' | 'outputSchemaDigest' | 'manifestDigest'>): ToolDefinition {
  const withDigests: ToolDefinition = {
    ...definition,
    inputSchemaDigest: digestOf(definition.inputSchema),
    outputSchemaDigest: digestOf(definition.outputSchema),
    manifestDigest: '0'.repeat(64),
  };
  withDigests.manifestDigest = computeToolManifestDigest(withDigests);
  assertToolDefinition(withDigests);
  return withDigests;
}

export function publicToolDefinition(definition: ToolDefinition): PublicToolDefinition {
  const { adapterDigest, providers, ...rest } = definition;
  void adapterDigest;
  return { ...rest, providers: { hosts: [...providers.hosts] } };
}

export function isPaidSideEffect(effect: ToolSideEffect): boolean {
  return effect === 'paid_external';
}

export function sideEffectRank(effect: ToolSideEffect): number {
  return ['none', 'internal_write', 'external_write', 'paid_external'].indexOf(effect);
}
