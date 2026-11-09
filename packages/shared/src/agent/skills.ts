import { AgentContractError, digestOf } from './contracts';

/**
 * 方法包 / Skill 公共契约。
 *
 * SKILL.md 是低优先级创作参考：它不是代码插件，不能执行脚本、联网、读环境变量
 * 或覆盖系统 Prompt。版本一经发布不可原地覆盖，运行只消费冻结 Manifest。
 */

export type SkillNode = 'script-adaptation' | 'character-image' | 'storyboard' | 'video-prompt';
export type SkillBindingRole = 'primary' | 'reviewer' | 'constraint';
export type SkillVersionStatus = 'draft' | 'published' | 'deprecated';
export type SkillAdmissionStatus = 'pending' | 'approved' | 'rejected' | 'revoked';
export type SkillProfileStatus = 'draft' | 'adopted' | 'archived';

export const SKILL_NODES: readonly SkillNode[] = Object.freeze([
  'script-adaptation', 'character-image', 'storyboard', 'video-prompt',
]);

export interface SkillFrontmatter {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  /** 原样保存，但绝不自动授予工具权限。 */
  allowedTools: string[];
  metadata: Record<string, string>;
  extra: Record<string, string>;
}

export interface SkillSource {
  origin: 'builtin' | 'workspace_import' | 'external_registry';
  sourceUri: string | null;
  sourceRevision: string | null;
  importedBy: string | null;
  importedAt: string | null;
}

/** 不可变版本。正文与 Manifest 修改必须创建新版本。 */
export interface SkillVersionRecord {
  skillId: string;
  version: number;
  content: string;
  contentDigest: string;
  frontmatter: SkillFrontmatter;
  /** 文件级 Manifest：相对路径、大小、摘要。 */
  files: Array<{ path: string; bytes: number; digest: string }>;
  manifestDigest: string;
  licenseCode: string;
  commercialUseAllowed: boolean;
  nodes: SkillNode[];
  compatibility: { models: string[]; minContextTokens: number | null };
  status: SkillVersionStatus;
  createdBy: string;
  createdAt: string;
}

export interface WorkspaceSkillAdmission {
  workspaceId: string;
  skillId: string;
  version: number;
  status: SkillAdmissionStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  updatedAt: string;
}

export interface SkillBinding {
  node: SkillNode;
  role: SkillBindingRole;
  skillId: string;
  version: number;
  priority: number;
  tokenBudget: number;
  config: Record<string, unknown>;
}

export interface SkillProfileRevision {
  profileRevisionId: string;
  workspaceId: string;
  projectId: string;
  revision: number;
  status: SkillProfileStatus;
  baseRevisionId: string | null;
  bindings: SkillBinding[];
  digest: string;
  version: number;
  createdBy: string;
  createdAt: string;
  adoptedBy?: string;
  adoptedAt?: string;
}

export interface CompiledSkillSection {
  node: SkillNode;
  role: SkillBindingRole;
  skillId: string;
  version: number;
  contentDigest: string;
  /** 已去除控制字符、按角色分区后的正文。 */
  body: string;
  chars: number;
  estimatedTokens: number;
}

export interface CompiledSkillManifest {
  compilerVersion: string;
  workspaceId: string;
  projectId: string;
  profileRevisionId: string;
  profileDigest: string;
  sections: CompiledSkillSection[];
  totalChars: number;
  estimatedTokens: number;
  tokenBudget: number;
  manifestDigest: string;
}

export interface SkillImportFile {
  path: string;
  bytes: number;
  digest: string;
}

export interface SkillImportCandidate {
  rootPath: string;
  name: string | null;
  description: string | null;
  version: number | null;
  nodes: SkillNode[];
  files: SkillImportFile[];
  totalBytes: number;
  warnings: string[];
  errors: string[];
}

export interface SkillImportPreview {
  sourceType: 'zip' | 'directory';
  totalFiles: number;
  totalBytes: number;
  candidates: SkillImportCandidate[];
  warnings: string[];
  errors: string[];
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function skillVersionKey(skillId: string, version: number): string {
  return `${skillId}@${version}`;
}

export function assertSkillName(name: string): void {
  if (name.length > 64 || !SKILL_NAME.test(name)) {
    throw new AgentContractError(400, 'SKILL_NAME_INVALID', 'Skill 名称只能包含小写字母、数字和非连续短横线，最长 64 位。');
  }
}

export function normalizeSkillNode(value: string): SkillNode {
  if ((SKILL_NODES as readonly string[]).includes(value)) return value as SkillNode;
  throw new AgentContractError(400, 'SKILL_NODE_UNSUPPORTED', `尚不支持的方法节点：${value}。`);
}

/** 编译正文前的清洗；返回 null 表示正文含非法控制字符过多，应拒绝导入。 */
export function sanitizeSkillBody(body: string): string {
  return body.replace(CONTROL_CHARS, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

/** Token 估算按保守的 3 字符/Token，宁可提前阻断也不超预算。 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3);
}

export function computeProfileDigest(input: {
  workspaceId: string; projectId: string; revision: number; baseRevisionId: string | null;
  bindings: SkillBinding[];
}): string {
  const bindings = [...input.bindings]
    .sort((left, right) => (left.node === right.node
      ? left.role === right.role ? left.skillId.localeCompare(right.skillId) : left.role.localeCompare(right.role)
      : left.node.localeCompare(right.node)))
    .map(binding => ({
      node: binding.node, role: binding.role, skillId: binding.skillId, version: binding.version,
      priority: binding.priority, tokenBudget: binding.tokenBudget, config: binding.config,
    }));
  return digestOf({
    workspaceId: input.workspaceId, projectId: input.projectId, revision: input.revision,
    baseRevisionId: input.baseRevisionId, bindings,
  });
}

export function computeSkillManifestDigest(files: SkillImportFile[], contentDigest: string): string {
  return digestOf({
    contentDigest,
    files: [...files].sort((left, right) => left.path.localeCompare(right.path)).map(file => ({
      path: file.path, bytes: file.bytes, digest: file.digest,
    })),
  });
}

/** 校验项目配置：每节点最多 1 primary + 2 辅助；只允许已准入版本。 */
export function assertSkillBindings(bindings: SkillBinding[]): void {
  const byNode = new Map<string, SkillBinding[]>();
  for (const binding of bindings) {
    const items = byNode.get(binding.node) ?? [];
    items.push(binding);
    byNode.set(binding.node, items);
    if (binding.tokenBudget < 0 || binding.tokenBudget > 200_000) {
      throw new AgentContractError(400, 'SKILL_TOKEN_BUDGET_INVALID', '单节点方法预算必须在 0 到 200000 Token 之间。');
    }
    if (binding.role === 'primary' && binding.tokenBudget === 0) {
      throw new AgentContractError(400, 'SKILL_TOKEN_BUDGET_INVALID', '主方法必须分配正数 Token 预算。');
    }
  }
  for (const [node, items] of byNode) {
    const primaries = items.filter(item => item.role === 'primary');
    if (primaries.length > 1) throw new AgentContractError(409, 'SKILL_BINDING_CONFLICT', `节点 ${node} 只能有一个主方法。`);
    if (items.length - primaries.length > 2) throw new AgentContractError(409, 'SKILL_BINDING_CONFLICT', `节点 ${node} 最多两个辅助方法。`);
    const keys = new Set(items.map(item => `${item.role}:${item.skillId}@${item.version}`));
    if (keys.size !== items.length) throw new AgentContractError(409, 'SKILL_BINDING_CONFLICT', `节点 ${node} 存在重复方法绑定。`);
  }
}

export function assertSkillProfile(profile: SkillProfileRevision): void {
  assertSkillBindings(profile.bindings);
  if (profile.revision < 1 || !Number.isSafeInteger(profile.version) || profile.version < 1) {
    throw new AgentContractError(500, 'SKILL_PROFILE_VERSION_INVALID', '项目方法配置必须携带合法 revision 与 version。');
  }
  if (profile.digest !== computeProfileDigest(profile)) {
    throw new AgentContractError(409, 'SKILL_PROFILE_DIGEST_MISMATCH', '项目方法配置 digest 与内容不一致。');
  }
}
