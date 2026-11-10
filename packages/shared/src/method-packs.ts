import { AgentContractError, digestOf } from './agent/contracts';
import {
  SKILL_NODES,
  type SkillAdmissionStatus,
  type SkillBindingRole,
  type SkillNode,
  type SkillProfileStatus,
} from './agent/skills';

/**
 * 方法包（Method Pack）治理契约。
 *
 * 这里只包含纯类型与校验函数。正文永远只是低优先级创作参考，不能执行、
 * 联网、读取密钥、调用工具或覆盖系统/权限/预算/输出协议。
 *
 * SkillNode 是仓库既有 V1 节点契约：
 * script-adaptation / character-image / storyboard / video-prompt。
 */

export type MethodPackNode = SkillNode;
export type MethodBindingRole = SkillBindingRole;
export type MethodAdmissionStatus = SkillAdmissionStatus;
export type MethodProfileStatus = SkillProfileStatus;

export const METHOD_PACK_NODES: readonly MethodPackNode[] = SKILL_NODES;
export const METHOD_BINDING_ROLES: readonly MethodBindingRole[] = Object.freeze(['primary', 'reviewer', 'constraint']);
export const METHOD_COMPILER_VERSION = 'lyra-method-compiler/1.0.0';
export const METHOD_PACK_SCHEMA_VERSION = 'lyra.method-pack-manifest/1';
export const METHOD_MANIFEST_SCHEMA_VERSION = 'lyra.method-manifest/1';
export const MAX_METHOD_CONTENT_BYTES = 512 * 1024;
export const MAX_METHOD_BINDING_TOKEN_BUDGET = 200_000;
export const MAX_METHOD_PROFILE_TOKEN_BUDGET = 200_000;

/** 错误码与 UI 展示一一对应；不得统一折叠成“保存失败”。 */
export const METHOD_ERROR_CODES = Object.freeze({
  WORKSPACE_FORBIDDEN: 'workspace_forbidden',
  PACK_VERSION_NOT_ADMITTED: 'pack_version_not_admitted',
  LICENSE_NOT_ALLOWED: 'license_not_allowed',
  NODE_NOT_SUPPORTED: 'node_not_supported',
  BINDING_CONFLICT: 'binding_conflict',
  TOKEN_BUDGET_EXCEEDED: 'token_budget_exceeded',
  PROFILE_STALE: 'profile_stale',
  MANIFEST_DIGEST_MISMATCH: 'manifest_digest_mismatch',
  COMPILER_VERSION_UNSUPPORTED: 'compiler_version_unsupported',
  INVALID_INPUT: 'method_pack_invalid_input',
  NOT_FOUND: 'method_pack_not_found',
  VERSION_IMMUTABLE: 'method_pack_version_immutable',
  CONTENT_UNAVAILABLE: 'method_pack_content_unavailable',
  ADMISSION_TRANSITION_INVALID: 'method_admission_transition_invalid',
  PROFILE_NOT_DRAFT: 'method_profile_not_draft',
  PROFILE_NOT_ADOPTED: 'method_profile_not_adopted',
  PROJECT_FORBIDDEN: 'project_forbidden',
  ROLE_FORBIDDEN: 'method_role_forbidden',
  CONTENT_TOO_LARGE: 'method_content_too_large',
  PACK_ARCHIVED: 'method_pack_archived',
  REFERENCE_ONLY: 'method_pack_reference_only',
});

export class MethodPackError extends AgentContractError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = 'MethodPackError';
  }
}

export function methodError(status: number, code: string, message: string): never {
  throw new MethodPackError(status, code, message);
}

export type MethodPackOrigin = 'builtin' | 'workspace_import' | 'external_registry';
export type MethodQualityStatus = 'reference-only' | 'unevaluated' | 'evaluated';
export type MethodVersionApprovalStatus = 'published' | 'deprecated';

export interface MethodPack {
  id: string;
  name: string;
  summary: string;
  origin: MethodPackOrigin;
  /** 内置公共目录为 null；私有导入必须是拥有它的 Workspace。 */
  workspaceId: string | null;
  sourceUri: string | null;
  sourceRevision: string | null;
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
  /** 导入幂等键；只用于服务层重放识别，不参与版本 digest。 */
  clientRequestId?: string | null;
}

export interface MethodManifestSections {
  rules: string;
  checklist: string;
  examples: string;
}

export interface MethodPackManifestSpec {
  schemaVersion: typeof METHOD_PACK_SCHEMA_VERSION;
  nodes: MethodPackNode[];
  roles: MethodBindingRole[];
  sections: MethodManifestSections;
  /** 节点专属 section；缺失时使用通用 sections。 */
  nodeSections?: Partial<Record<MethodPackNode, MethodManifestSections>>;
  compatibility: { models: string[]; minContextTokens: number | null };
  suggestedTokenBudget: number;
  licenseCode: string;
  sourceUri: string | null;
  sourceRevision: string | null;
}

/** 不可变版本。正文和 Manifest 修改必须创建新版本，不允许 UPDATE 覆盖。 */
export interface MethodPackVersion {
  id: string;
  packId: string;
  /** 内置公共目录为 null；私有版本与拥有它的 Workspace 绑定。 */
  workspaceId: string | null;
  version: string;
  content: string | null;
  contentRef: string | null;
  contentDigest: string;
  manifest: MethodPackManifestSpec;
  manifestDigest: string;
  licenseCode: string;
  commercialUseAllowed: boolean;
  qualityStatus: MethodQualityStatus;
  approvalStatus: MethodVersionApprovalStatus;
  compatibility: { models: string[]; minContextTokens: number | null };
  nodes: MethodPackNode[];
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
}

export interface WorkspaceMethodPackAccess {
  workspaceId: string;
  packVersionId: string;
  status: MethodAdmissionStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  qualityEvidenceVersion: string | null;
  updatedAt: string;
  clientRequestId: string | null;
}

export interface MethodBinding {
  profileRevisionId: string;
  workspaceId: string;
  node: MethodPackNode;
  role: MethodBindingRole;
  packVersionId: string;
  priority: number;
  tokenBudget: number;
  config: Record<string, unknown>;
}

export interface ProjectMethodProfileRevision {
  id: string;
  workspaceId: string;
  projectId: string;
  revision: number;
  status: MethodProfileStatus;
  baseRevisionId: string | null;
  digest: string;
  version: number;
  /** 项目级方法配置总 Token 预算；编译/启用/运行冻结共同使用。 */
  tokenBudget: number;
  createdBy: string;
  createdAt: string;
  adoptedBy: string | null;
  adoptedAt: string | null;
  archivedAt: string | null;
  validatedAt: string | null;
  validationDigest: string | null;
  clientRequestId: string | null;
  bindings: MethodBinding[];
}

export interface CompiledMethodBinding {
  methodPackVersionId: string;
  packId: string;
  packVersion: string;
  role: MethodBindingRole;
  priority: number;
  tokenBudget: number;
  contentDigest: string;
  packManifestDigest: string;
  sections: MethodManifestSections;
  chars: number;
  estimatedTokens: number;
}

export interface CompiledMethodNode {
  node: MethodPackNode;
  bindings: CompiledMethodBinding[];
  chars: number;
  estimatedTokens: number;
}

export interface CompiledMethodManifest {
  schemaVersion: typeof METHOD_MANIFEST_SCHEMA_VERSION;
  compilerVersion: string;
  workspaceId: string;
  projectId: string;
  profileRevisionId: string;
  profileDigest: string;
  nodes: CompiledMethodNode[];
  totalChars: number;
  estimatedTokens: number;
  tokenBudget: number;
  manifestDigest: string;
}

/** run_json 中的冻结事实；正文只留在这里，普通 API 必须脱敏。 */
export interface FrozenMethodProfile {
  workspaceId: string;
  projectId: string;
  profileRevisionId: string;
  profileDigest: string;
  compilerVersion: string;
  manifest: CompiledMethodManifest;
  manifestDigest: string;
  frozenAt: string;
}

export interface MethodCatalogEntry {
  pack: MethodPack;
  latestVersion: MethodPackVersionSummary | null;
  versions: MethodPackVersionSummary[];
  admission: WorkspaceMethodPackAccess | null;
  adoptedProjectCount: number;
}

/** 列表只返回摘要与摘要值，不返回正文。 */
export interface MethodPackVersionSummary {
  id: string;
  packId: string;
  version: string;
  contentDigest: string;
  manifestDigest: string;
  nodes: MethodPackNode[];
  licenseCode: string;
  commercialUseAllowed: boolean;
  qualityStatus: MethodQualityStatus;
  approvalStatus: MethodVersionApprovalStatus;
  compatibility: { models: string[]; minContextTokens: number | null };
  createdAt: string;
  archivedAt: string | null;
}

export interface MethodPackListQuery {
  q?: string;
  node?: MethodPackNode;
  admissionStatus?: MethodAdmissionStatus;
  license?: string;
  qualityStatus?: MethodQualityStatus;
  adoptedByProjectId?: string;
}

export interface MethodPackImportInput {
  name: string;
  summary: string;
  version: string;
  content: string;
  nodes: MethodPackNode[];
  licenseCode: string;
  commercialUseAllowed: boolean;
  qualityStatus: MethodQualityStatus;
  sourceUri: string | null;
  sourceRevision: string | null;
  compatibility: { models: string[]; minContextTokens: number | null };
  suggestedTokenBudget: number;
}

export interface MethodAdmissionInput {
  decision: 'approved' | 'rejected' | 'revoked';
  reason: string;
  qualityEvidenceVersion: string | null;
}

export interface MethodProfileCreateInput {
  baseRevisionId: string | null;
  bindings: Array<Pick<MethodBinding, 'node' | 'role' | 'packVersionId' | 'priority' | 'tokenBudget' | 'config'>>;
  tokenBudget: number;
}

export interface MethodBindingsInput {
  bindings: MethodProfileCreateInput['bindings'];
  tokenBudget: number;
  expectedVersion: number;
  clientRequestId: string;
}

export interface MethodProfileAdoptInput {
  expectedVersion: number;
  expectedDigest: string;
  clientRequestId: string;
  reason: string;
}

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]{2,127}$/u;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const CLIENT_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/u;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const MALFORMED_SURROGATE = /[\uD800-\uDFFF]/u;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, '请求参数必须是对象。');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number, required: boolean): string {
  if (value === undefined || value === null) {
    if (required) methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, `缺少${field}。`);
    return '';
  }
  if (typeof value !== 'string') methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, `${field}必须是文本。`);
  const trimmed = value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n').trim();
  if (required && !trimmed) methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, `${field}不能为空。`);
  if (Array.from(trimmed).length > max) methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, `${field}过长（上限 ${max} 字）。`);
  if (CONTROL.test(trimmed) || MALFORMED_SURROGATE.test(trimmed)) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, `${field}包含非法控制字符。`);
  }
  return trimmed;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  return text(value, field, max, false);
}

export function parseMethodPackNode(value: unknown): MethodPackNode {
  if (typeof value !== 'string' || !(METHOD_PACK_NODES as readonly string[]).includes(value)) {
    methodError(400, METHOD_ERROR_CODES.NODE_NOT_SUPPORTED, `方法包节点不受支持：${String(value).slice(0, 40)}。`);
  }
  return value as MethodPackNode;
}

function parseRole(value: unknown): MethodBindingRole {
  if (typeof value !== 'string' || !(METHOD_BINDING_ROLES as readonly string[]).includes(value)) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, `方法角色不受支持：${String(value).slice(0, 40)}。`);
  }
  return value as MethodBindingRole;
}

function uniqueNodes(value: unknown): MethodPackNode[] {
  if (!Array.isArray(value) || value.length === 0) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, '请至少声明一个真实运行节点。');
  }
  const nodes: MethodPackNode[] = [];
  for (const item of value) {
    const node = parseMethodPackNode(item);
    if (!nodes.includes(node)) nodes.push(node);
  }
  return nodes;
}

export function parseSemver(value: unknown): string {
  if (typeof value !== 'string' || !SEMVER.test(value)) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, '版本必须是 SemVer（例如 1.2.3）。');
  }
  return value;
}

function parseCompat(value: unknown): { models: string[]; minContextTokens: number | null } {
  if (value === undefined || value === null) return { models: [], minContextTokens: null };
  const input = record(value);
  const models = Array.isArray(input.models)
    ? input.models.map(model => text(model, '模型', 120, true)).slice(0, 32)
    : [];
  const min = input.minContextTokens;
  if (min !== undefined && min !== null && (!Number.isSafeInteger(min) || Number(min) < 1 || Number(min) > 10_000_000)) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, '最小上下文 Token 不合法。');
  }
  return { models: [...new Set(models)], minContextTokens: min === undefined || min === null ? null : Number(min) };
}

export function parseMethodPackImportInput(value: unknown): MethodPackImportInput {
  const input = record(value);
  const content = text(input.content, '正文', MAX_METHOD_CONTENT_BYTES, true);
  if (Buffer.byteLength(content, 'utf8') > MAX_METHOD_CONTENT_BYTES) {
    methodError(413, METHOD_ERROR_CODES.CONTENT_TOO_LARGE, '方法包正文超过 512KB 上限。');
  }
  const qualityStatus = input.qualityStatus ?? 'unevaluated';
  if (!['reference-only', 'unevaluated', 'evaluated'].includes(qualityStatus as string)) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, '质量状态不合法。');
  }
  const commercial = input.commercialUseAllowed;
  if (typeof commercial !== 'boolean') {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, 'commercialUseAllowed 必须是布尔值。');
  }
  const suggested = input.suggestedTokenBudget ?? 4_000;
  if (!Number.isSafeInteger(suggested) || Number(suggested) < 1 || Number(suggested) > MAX_METHOD_BINDING_TOKEN_BUDGET) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, '建议 Token 预算不合法。');
  }
  return {
    name: text(input.name, '名称', 120, true),
    summary: text(input.summary, '摘要', 500, false),
    version: parseSemver(input.version),
    content,
    nodes: uniqueNodes(input.nodes),
    licenseCode: text(input.licenseCode, '许可码', 64, true),
    commercialUseAllowed: commercial,
    qualityStatus: qualityStatus as MethodQualityStatus,
    sourceUri: optionalText(input.sourceUri, '来源地址', 500),
    sourceRevision: optionalText(input.sourceRevision, '来源 revision', 160),
    compatibility: parseCompat(input.compatibility),
    suggestedTokenBudget: Number(suggested),
  };
}

export function parseMethodAdmissionInput(value: unknown): MethodAdmissionInput {
  const input = record(value);
  if (!['approved', 'rejected', 'revoked'].includes(input.decision as string)) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, '准入决定必须是 approved / rejected / revoked。');
  }
  return {
    decision: input.decision as MethodAdmissionInput['decision'],
    reason: text(input.reason ?? '', '原因', 500, input.decision !== 'approved'),
    qualityEvidenceVersion: optionalText(input.qualityEvidenceVersion, '质量证据版本', 160),
  };
}

export function parseMethodBinding(value: unknown): Pick<MethodBinding,
  'node' | 'role' | 'packVersionId' | 'priority' | 'tokenBudget' | 'config'> {
  const input = record(value);
  const packVersionId = text(input.packVersionId, '方法版本', 128, true);
  if (!SAFE_ID.test(packVersionId)) methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, '方法版本标识不合法。');
  const priority = input.priority ?? 100;
  if (!Number.isSafeInteger(priority) || Number(priority) < 0 || Number(priority) > 10_000) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, 'priority 必须是 0 到 10000 的整数。');
  }
  const tokenBudget = input.tokenBudget ?? 4_000;
  if (!Number.isSafeInteger(tokenBudget) || Number(tokenBudget) < 0 || Number(tokenBudget) > MAX_METHOD_BINDING_TOKEN_BUDGET) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, 'tokenBudget 必须是 0 到 200000 的整数。');
  }
  const role = parseRole(input.role);
  if (role === 'primary' && Number(tokenBudget) === 0) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, '主方法必须分配正数 Token 预算。');
  }
  if (input.config !== undefined && input.config !== null && (typeof input.config !== 'object' || Array.isArray(input.config))) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, 'config 必须是对象。');
  }
  return {
    node: parseMethodPackNode(input.node),
    role,
    packVersionId,
    priority: Number(priority),
    tokenBudget: Number(tokenBudget),
    config: input.config ? structuredClone(input.config as Record<string, unknown>) : {},
  };
}

export function parseMethodBindings(value: unknown): Array<ReturnType<typeof parseMethodBinding>> {
  if (!Array.isArray(value)) methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, 'bindings 必须是数组。');
  if (value.length > 64) methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, '单个配置最多 64 个绑定。');
  return value.map(parseMethodBinding);
}

export function parseMethodProfileCreateInput(value: unknown): MethodProfileCreateInput {
  const input = record(value);
  const baseRevisionId = input.baseRevisionId === undefined || input.baseRevisionId === null
    ? null : text(input.baseRevisionId, '基础配置', 128, true);
  if (baseRevisionId !== null && !SAFE_ID.test(baseRevisionId)) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, '基础配置标识不合法。');
  }
  const tokenBudget = input.tokenBudget ?? 32_000;
  if (!Number.isSafeInteger(tokenBudget) || Number(tokenBudget) < 1 || Number(tokenBudget) > MAX_METHOD_PROFILE_TOKEN_BUDGET) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, '总 Token 预算必须是 1 到 200000 的整数。');
  }
  return {
    baseRevisionId,
    bindings: parseMethodBindings(input.bindings ?? []),
    tokenBudget: Number(tokenBudget),
  };
}

export function parseMethodBindingsInput(value: unknown): MethodBindingsInput {
  const input = record(value);
  const expectedVersion = input.expectedVersion;
  if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, 'expectedVersion 必须是正整数。');
  }
  const clientRequestId = text(input.clientRequestId, '请求标识', 128, true);
  if (!CLIENT_REQUEST_ID.test(clientRequestId)) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, 'clientRequestId 格式不正确。');
  }
  const tokenBudget = input.tokenBudget ?? 32_000;
  if (!Number.isSafeInteger(tokenBudget) || Number(tokenBudget) < 1 || Number(tokenBudget) > MAX_METHOD_PROFILE_TOKEN_BUDGET) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, '总 Token 预算必须是 1 到 200000 的整数。');
  }
  return {
    bindings: parseMethodBindings(input.bindings ?? []),
    tokenBudget: Number(tokenBudget),
    expectedVersion: Number(expectedVersion),
    clientRequestId,
  };
}

export function parseMethodProfileAdoptInput(value: unknown): MethodProfileAdoptInput {
  const input = record(value);
  const expectedVersion = input.expectedVersion;
  if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, 'expectedVersion 必须是正整数。');
  }
  if (typeof input.expectedDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(input.expectedDigest)) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, 'expectedDigest 必须是 sha256。');
  }
  const clientRequestId = text(input.clientRequestId, '请求标识', 128, true);
  if (!CLIENT_REQUEST_ID.test(clientRequestId)) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, 'clientRequestId 格式不正确。');
  }
  return {
    expectedVersion: Number(expectedVersion),
    expectedDigest: input.expectedDigest,
    clientRequestId,
    reason: text(input.reason ?? '', '原因', 500, false),
  };
}

export interface MethodSelectionForRun {
  revisionId?: string;
  digest?: string;
}

/** 运行创建的可选方法配置选择；revision 与 digest 必须成对出现。 */
export function parseMethodSelectionForRun(value: unknown): MethodSelectionForRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const revisionId = input.methodProfileRevisionId;
  const digest = input.methodProfileDigest;
  if (revisionId === undefined && digest === undefined) return {};
  if (typeof revisionId !== 'string' || !SAFE_ID.test(revisionId)
    || typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, '运行必须同时携带合法的 methodProfileRevisionId 与 methodProfileDigest。');
  }
  return { revisionId, digest };
}

export function assertMethodBindings(bindings: readonly Pick<MethodBinding,
  'node' | 'role' | 'packVersionId' | 'tokenBudget'>[]): void {
  const byNode = new Map<MethodPackNode, typeof bindings[number][]>();
  for (const binding of bindings) {
    const items = byNode.get(binding.node) ?? [];
    items.push(binding);
    byNode.set(binding.node, items);
    if (!Number.isSafeInteger(binding.tokenBudget) || binding.tokenBudget < 0
      || binding.tokenBudget > MAX_METHOD_BINDING_TOKEN_BUDGET) {
      methodError(400, METHOD_ERROR_CODES.TOKEN_BUDGET_EXCEEDED, '单节点方法预算超出范围。');
    }
    if (binding.role === 'primary' && binding.tokenBudget === 0) {
      methodError(409, METHOD_ERROR_CODES.TOKEN_BUDGET_EXCEEDED, '主方法必须保留正数 Token 预算。');
    }
  }
  for (const [node, items] of byNode) {
    const primaries = items.filter(item => item.role === 'primary');
    if (primaries.length > 1) {
      methodError(409, METHOD_ERROR_CODES.BINDING_CONFLICT, `节点 ${node} 只能有一个主方法。`);
    }
    if (items.length - primaries.length > 2) {
      methodError(409, METHOD_ERROR_CODES.BINDING_CONFLICT, `节点 ${node} 最多两个辅助方法。`);
    }
    const keys = new Set(items.map(item => `${item.role}:${item.packVersionId}`));
    if (keys.size !== items.length) {
      methodError(409, METHOD_ERROR_CODES.BINDING_CONFLICT, `节点 ${node} 存在重复方法绑定。`);
    }
  }
}

export function computeMethodProfileDigest(input: {
  workspaceId: string;
  projectId: string;
  revision: number;
  baseRevisionId: string | null;
  tokenBudget: number;
  bindings: readonly Pick<MethodBinding, 'node' | 'role' | 'packVersionId' | 'priority' | 'tokenBudget' | 'config'>[];
}): string {
  const order = { primary: 0, reviewer: 1, constraint: 2 } as const;
  const nodeOrder = METHOD_PACK_NODES.map((node, index) => [node, index] as const);
  const nodeIndex = new Map(nodeOrder);
  const bindings = [...input.bindings].sort((left, right) =>
    (nodeIndex.get(left.node) ?? 99) - (nodeIndex.get(right.node) ?? 99)
    || order[left.role] - order[right.role]
    || left.priority - right.priority
    || left.packVersionId.localeCompare(right.packVersionId)).map(binding => ({
    node: binding.node, role: binding.role, packVersionId: binding.packVersionId,
    priority: binding.priority, tokenBudget: binding.tokenBudget, config: binding.config,
  }));
  return digestOf({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    revision: input.revision,
    baseRevisionId: input.baseRevisionId,
    tokenBudget: input.tokenBudget,
    bindings,
  });
}

export function computeMethodPackManifestDigest(input: {
  contentDigest: string;
  manifest: MethodPackManifestSpec;
}): string {
  return digestOf({ contentDigest: input.contentDigest, manifest: input.manifest });
}

export function computeCompiledMethodManifestDigest(input: Omit<CompiledMethodManifest, 'manifestDigest'>): string {
  return digestOf({
    schemaVersion: input.schemaVersion,
    compilerVersion: input.compilerVersion,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    profileRevisionId: input.profileRevisionId,
    profileDigest: input.profileDigest,
    nodes: input.nodes.map(node => ({
      node: node.node,
      bindings: node.bindings.map(binding => ({
        methodPackVersionId: binding.methodPackVersionId,
        role: binding.role,
        priority: binding.priority,
        tokenBudget: binding.tokenBudget,
        contentDigest: binding.contentDigest,
        packManifestDigest: binding.packManifestDigest,
      })),
    })),
    totalChars: input.totalChars,
    estimatedTokens: input.estimatedTokens,
    tokenBudget: input.tokenBudget,
  });
}

export function methodPackVersionKey(packId: string, version: string): string {
  return `${packId}@${version}`;
}

export function toMethodPackVersionSummary(version: MethodPackVersion): MethodPackVersionSummary {
  return {
    id: version.id,
    packId: version.packId,
    version: version.version,
    contentDigest: version.contentDigest,
    manifestDigest: version.manifestDigest,
    nodes: [...version.nodes],
    licenseCode: version.licenseCode,
    commercialUseAllowed: version.commercialUseAllowed,
    qualityStatus: version.qualityStatus,
    approvalStatus: version.approvalStatus,
    compatibility: structuredClone(version.compatibility),
    createdAt: version.createdAt,
    archivedAt: version.archivedAt,
  };
}

/** 编译时正文必须清洗；只作为低优先级参考，不执行。 */
export function sanitizeMethodContent(content: string): string {
  return content
    .replace(/\r\n/gu, '\n')
    .replace(/\r/gu, '\n')
    .replace(CONTROL, ' ')
    .replace(MALFORMED_SURROGATE, '')
    .trim();
}

/** 只剥离 frontmatter，绝不把 YAML 当作可执行指令。 */
export function stripMethodFrontmatter(content: string): string {
  const match = /^---\n[\s\S]*?\n---(?:\n|$)/u.exec(content);
  return match ? content.slice(match[0].length) : content;
}

export interface ParsedMethodBody {
  body: string;
  sections: MethodManifestSections;
  nodeSections: Partial<Record<MethodPackNode, MethodManifestSections>>;
}

/**
 * 解析 Markdown section：
 * - `## 规则 / checklist / examples` 等角色分区；
 * - `## script-adaptation / storyboard ...` 等节点分区，其下再按角色分区；
 * - 未识别标题落到当前分区，避免丢失用户内容。
 */
export function parseMethodBody(content: string): ParsedMethodBody {
  const body = sanitizeMethodContent(stripMethodFrontmatter(content));
  const generic: MethodManifestSections = { rules: '', checklist: '', examples: '' };
  const nodes: Partial<Record<MethodPackNode, MethodManifestSections>> = {};
  let activeNode: MethodPackNode | null = null;
  let activeRole: keyof MethodManifestSections = 'rules';
  const append = (line: string) => {
    const target = activeNode ? (nodes[activeNode] ??= { rules: '', checklist: '', examples: '' }) : generic;
    target[activeRole] += `${line}\n`;
  };
  for (const line of body.split('\n')) {
    const heading = /^#{2,4}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading) {
      const title = heading[1]!.trim().toLowerCase();
      const node = (METHOD_PACK_NODES as readonly string[]).includes(title) ? title as MethodPackNode : null;
      if (node) {
        activeNode = node;
        activeRole = 'rules';
        nodes[node] ??= { rules: '', checklist: '', examples: '' };
        continue;
      }
      if (/^(?:规则|rules?|要求|instructions?)$/u.test(title)) activeRole = 'rules';
      else if (/^(?:检查表|检查清单|checklist|check)$/u.test(title)) activeRole = 'checklist';
      else if (/^(?:示例|案例|examples?|samples?)$/u.test(title)) activeRole = 'examples';
      else if (activeNode) activeRole = 'rules';
    }
    append(line);
  }
  for (const key of ['rules', 'checklist', 'examples'] as const) {
    generic[key] = generic[key].trim();
    for (const node of METHOD_PACK_NODES) {
      const section = nodes[node];
      if (section) {
        section[key] = section[key].trim();
        if (!section.rules && !section.checklist && !section.examples) delete nodes[node];
      }
    }
  }
  return { body, sections: generic, nodeSections: nodes };
}
