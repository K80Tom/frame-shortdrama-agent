import {
  AgentContractError, assertSkillBindings, computeProfileDigest, computeSkillManifestDigest, digestOf, sanitizeSkillBody,
  skillVersionKey, type SkillBinding, type SkillImportFile, type SkillNode, type SkillProfileRevision,
  type SkillVersionRecord, type WorkspaceSkillAdmission,
} from '@lyra/shared';
import { assertSkillName } from '@lyra/shared';

/**
 * 方法包版本库与工作区准入。
 *
 * 版本不可变：同一 skill 的内容或 manifest 变化必须形成新版本；旧版本永远保留。
 * 准入是唯一的运行入口，且必须精确到 version——批准 v1 不会放行 v2。
 */

export interface PublishSkillInput {
  name: string;
  body: string;
  frontmatter: SkillVersionRecord['frontmatter'];
  files: SkillImportFile[];
  licenseCode: string;
  commercialUseAllowed: boolean;
  nodes: SkillNode[];
  compatibility?: { models: string[]; minContextTokens: number | null };
  createdBy: string;
  createdAt?: string;
  status?: SkillVersionRecord['status'];
}

export interface AdmissionInput {
  workspaceId: string;
  skillId: string;
  version: number;
}

export class SkillRegistry {
  private readonly bySkill = new Map<string, SkillVersionRecord[]>();
  private readonly admissions = new Map<string, WorkspaceSkillAdmission>();

  publishVersion(input: PublishSkillInput): SkillVersionRecord {
    assertSkillName(input.name);
    const body = sanitizeSkillBody(input.body);
    if (body === '') throw new AgentContractError(400, 'SKILL_BODY_REQUIRED', '方法包正文不能为空。');
    const files = [...input.files].sort((left, right) => left.path.localeCompare(right.path));
    const contentDigest = digestOf({ frontmatter: input.frontmatter, body });
    const manifestDigest = computeSkillManifestDigest(files, contentDigest);
    const skillId = `skl_${input.name}`;
    const versions = this.bySkill.get(skillId) ?? [];
    const latest = versions[versions.length - 1];
    if (latest && latest.contentDigest === contentDigest && latest.manifestDigest === manifestDigest) {
      return clone(latest);
    }
    const version = (latest?.version ?? 0) + 1;
    const record: SkillVersionRecord = {
      skillId, version, content: body, contentDigest,
      frontmatter: structuredClone(input.frontmatter),
      files,
      manifestDigest,
      licenseCode: input.licenseCode.slice(0, 64),
      commercialUseAllowed: input.commercialUseAllowed,
      nodes: [...input.nodes],
      compatibility: input.compatibility ?? { models: [], minContextTokens: null },
      status: input.status ?? 'published',
      createdBy: input.createdBy,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    versions.push(deepFreeze(record));
    this.bySkill.set(skillId, versions);
    return clone(record);
  }

  get(skillId: string, version: number): SkillVersionRecord | null {
    const record = this.bySkill.get(skillId)?.find(item => item.version === version);
    return record ? clone(record) : null;
  }

  latest(skillId: string): SkillVersionRecord | null {
    const versions = this.bySkill.get(skillId);
    return versions && versions.length > 0 ? clone(versions[versions.length - 1]!) : null;
  }

  versions(skillId: string): SkillVersionRecord[] {
    return (this.bySkill.get(skillId) ?? []).map(clone);
  }

  list(): Array<{ skillId: string; latestVersion: number; name: string; status: SkillVersionRecord['status'] }> {
    return [...this.bySkill.entries()].map(([skillId, versions]) => {
      const latest = versions[versions.length - 1]!;
      return { skillId, latestVersion: latest.version, name: latest.frontmatter.name, status: latest.status };
    });
  }

  submitAdmission(input: AdmissionInput & { now?: string }): WorkspaceSkillAdmission {
    const record = this.get(input.skillId, input.version);
    if (!record) throw new AgentContractError(404, 'SKILL_VERSION_NOT_FOUND', '方法包版本不存在。');
    if (record.status !== 'published') throw new AgentContractError(409, 'SKILL_VERSION_NOT_PUBLISHED', '只有已发布版本可以申请准入。');
    if (record.nodes.length === 0 && record.frontmatter.name) {
      throw new AgentContractError(409, 'SKILL_NODES_REQUIRED', '方法包未声明支持节点，不能申请准入。');
    }
    const key = admissionKey(input.workspaceId, input.skillId, input.version);
    const existing = this.admissions.get(key);
    if (existing && (existing.status === 'pending' || existing.status === 'approved')) {
      throw new AgentContractError(409, 'SKILL_ADMISSION_EXISTS', `该版本在当前工作区已是 ${existing.status} 状态。`);
    }
    const admission: WorkspaceSkillAdmission = {
      workspaceId: input.workspaceId, skillId: input.skillId, version: input.version,
      status: 'pending', approvedBy: null, approvedAt: null, rejectionReason: null,
      updatedAt: input.now ?? new Date().toISOString(),
    };
    this.admissions.set(key, deepFreeze(admission));
    return clone(admission);
  }

  decideAdmission(input: {
    workspaceId: string; skillId: string; version: number;
    decision: 'approved' | 'rejected' | 'revoked'; actor: string; reason?: string; now?: string;
  }): WorkspaceSkillAdmission {
    const key = admissionKey(input.workspaceId, input.skillId, input.version);
    const existing = this.admissions.get(key);
    if (!existing) throw new AgentContractError(404, 'SKILL_ADMISSION_NOT_FOUND', '准入申请不存在。');
    const allowed: Record<string, string[]> = {
      pending: ['approved', 'rejected'], approved: ['revoked'], rejected: ['pending'], revoked: [],
    };
    if (!(allowed[existing.status] ?? []).includes(input.decision)) {
      throw new AgentContractError(409, 'SKILL_ADMISSION_TRANSITION_INVALID', `准入状态不能从 ${existing.status} 变为 ${input.decision}。`);
    }
    const next: WorkspaceSkillAdmission = {
      ...existing,
      status: input.decision,
      approvedBy: input.decision === 'approved' ? input.actor : existing.approvedBy,
      approvedAt: input.decision === 'approved' ? (input.now ?? new Date().toISOString()) : existing.approvedAt,
      rejectionReason: input.decision === 'rejected' ? (input.reason ?? '未说明原因').slice(0, 500) : null,
      updatedAt: input.now ?? new Date().toISOString(),
    };
    this.admissions.set(key, deepFreeze(next));
    return clone(next);
  }

  admission(workspaceId: string, skillId: string, version: number): WorkspaceSkillAdmission | null {
    const record = this.admissions.get(admissionKey(workspaceId, skillId, version));
    return record ? clone(record) : null;
  }

  isAdmitted(workspaceId: string, skillId: string, version: number): boolean {
    return this.admissions.get(admissionKey(workspaceId, skillId, version))?.status === 'approved';
  }

  assertAdmitted(workspaceId: string, skillId: string, version: number): SkillVersionRecord {
    const record = this.get(skillId, version);
    if (!record) throw new AgentContractError(404, 'SKILL_VERSION_NOT_FOUND', `方法包版本不存在：${skillVersionKey(skillId, version)}。`);
    if (record.status !== 'published') throw new AgentContractError(409, 'SKILL_VERSION_NOT_PUBLISHED', '方法包版本未发布。');
    if (!this.isAdmitted(workspaceId, skillId, version)) {
      throw new AgentContractError(403, 'SKILL_NOT_ADMITTED', `方法包版本未在当前工作区准入：${skillVersionKey(skillId, version)}。`);
    }
    return record;
  }
}

export interface DraftProfileInput {
  workspaceId: string;
  projectId: string;
  baseRevisionId: string | null;
  revision: number;
  bindings: SkillBinding[];
  createdBy: string;
  createdAt?: string;
}

/** 项目方法配置：draft → adopted → archived；运行只读 adopted。 */
export class SkillProfileService {
  private readonly profiles = new Map<string, SkillProfileRevision>();

  constructor(private readonly registry: SkillRegistry) {}

  draft(input: DraftProfileInput): SkillProfileRevision {
    assertSkillBindings(input.bindings);
    if (input.revision < 1) throw new AgentContractError(400, 'SKILL_PROFILE_REVISION_INVALID', '方法配置 revision 必须从 1 开始。');
    for (const binding of input.bindings) {
      const record = this.registry.assertAdmitted(input.workspaceId, binding.skillId, binding.version);
      if (!record.nodes.includes(binding.node)) {
        throw new AgentContractError(409, 'SKILL_NODE_MISMATCH',
          `${skillVersionKey(binding.skillId, binding.version)} 不支持节点 ${binding.node}。`);
      }
    }
    const digest = computeProfileDigest({
      workspaceId: input.workspaceId, projectId: input.projectId, revision: input.revision,
      baseRevisionId: input.baseRevisionId, bindings: input.bindings,
    });
    const profile: SkillProfileRevision = {
      profileRevisionId: `skp_${digest.slice(0, 24)}`,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      revision: input.revision,
      status: 'draft',
      baseRevisionId: input.baseRevisionId,
      bindings: structuredClone(input.bindings),
      digest,
      version: 1,
      createdBy: input.createdBy,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.profiles.set(profile.profileRevisionId, deepFreeze(profile));
    return clone(profile);
  }

  adopt(profileRevisionId: string, actor: string, expectedDigest: string, now?: string): SkillProfileRevision {
    const current = this.profiles.get(profileRevisionId);
    if (!current) throw new AgentContractError(404, 'SKILL_PROFILE_NOT_FOUND', '方法配置不存在。');
    if (current.status !== 'draft') throw new AgentContractError(409, 'SKILL_PROFILE_NOT_DRAFT', '只有 draft 状态的方法配置可以采纳。');
    if (current.digest !== expectedDigest) throw new AgentContractError(409, 'SKILL_PROFILE_DIGEST_MISMATCH', '方法配置已被修改，请刷新后重试。');
    // 采纳时再次校验准入，防止 draft 创建后准入被撤销。
    for (const binding of current.bindings) this.registry.assertAdmitted(current.workspaceId, binding.skillId, binding.version);
    const next: SkillProfileRevision = {
      ...current, status: 'adopted', adoptedBy: actor, adoptedAt: now ?? new Date().toISOString(), version: current.version + 1,
    };
    this.profiles.set(profileRevisionId, deepFreeze(next));
    return clone(next);
  }

  archive(profileRevisionId: string, actor: string): SkillProfileRevision {
    const current = this.profiles.get(profileRevisionId);
    if (!current) throw new AgentContractError(404, 'SKILL_PROFILE_NOT_FOUND', '方法配置不存在。');
    if (current.status !== 'adopted') throw new AgentContractError(409, 'SKILL_PROFILE_NOT_ADOPTED', '只有已采纳的方法配置可以归档。');
    void actor;
    const next: SkillProfileRevision = { ...current, status: 'archived', version: current.version + 1 };
    this.profiles.set(profileRevisionId, deepFreeze(next));
    return clone(next);
  }

  get(profileRevisionId: string): SkillProfileRevision | null {
    const record = this.profiles.get(profileRevisionId);
    return record ? clone(record) : null;
  }
}

function admissionKey(workspaceId: string, skillId: string, version: number): string {
  return `${workspaceId}:${skillId}@${version}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>) as unknown[]) deepFreeze(child);
  }
  return value;
}
