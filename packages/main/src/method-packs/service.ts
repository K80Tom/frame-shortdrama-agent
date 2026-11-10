import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  LEGACY_WORKSPACE_ID,
  type TenantRole,
} from '../tenancy/context';
import {
  METHOD_COMPILER_VERSION,
  METHOD_ERROR_CODES,
  METHOD_PACK_NODES,
  METHOD_PACK_SCHEMA_VERSION,
  MethodPackError,
  computeMethodPackManifestDigest,
  computeMethodProfileDigest,
  digestOf,
  methodError,
  parseMethodAdmissionInput,
  parseMethodBindingsInput,
  parseMethodBody,
  parseMethodPackImportInput,
  parseMethodProfileAdoptInput,
  parseMethodProfileCreateInput,
  parseMethodSelectionForRun,
  sanitizeMethodContent,
  toMethodPackVersionSummary,
  type FrozenMethodProfile,
  type MethodAdmissionInput,
  type MethodAdmissionStatus,
  type MethodBinding,
  type MethodCatalogEntry,
  type MethodPack,
  type MethodPackImportInput,
  type MethodPackListQuery,
  type MethodManifestSections,
  type MethodPackManifestSpec,
  type MethodPackNode,
  type MethodPackVersion,
  type ProjectMethodProfileRevision,
  type WorkspaceMethodPackAccess,
} from '@lyra/shared';
import { compileMethodProfile, redactMethodManifest } from './compiler';
import {
  methodPackVersionId,
  methodProfileId,
  type MethodDomainEvent,
  type MethodPackRepositoryPort,
} from './repository';

export interface MethodActor {
  workspaceId: string;
  userId: string;
  role: TenantRole;
  requestId?: string;
}

export interface MethodPackServiceOptions {
  now?: () => Date;
  compilerVersion?: string;
  builtinRoot?: string;
  loadBuiltinPacks?: () => Array<{
    id: string; name: string; version: string; summary: string; stages: readonly string[];
    directory: string; entry: string; license: string;
    commercialUseAllowed?: boolean; quality: 'evaluated' | 'unevaluated';
    contentPolicy?: 'imported' | 'reference-only';
  }>;
}

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/u;

function assertClientRequestId(value: string | undefined, field = 'clientRequestId'): string {
  if (typeof value !== 'string' || !CLIENT_REQUEST_ID_PATTERN.test(value)) {
    methodError(400, METHOD_ERROR_CODES.INVALID_INPUT, `${field} 缺失或格式不正确。`);
  }
  return value;
}

function assertWriteRole(actor: MethodActor, admin = false): void {
  if (actor.role === 'viewer') {
    methodError(403, METHOD_ERROR_CODES.ROLE_FORBIDDEN, '当前角色只能查看方法包，不能修改或启用。');
  }
  if (admin && actor.role !== 'owner' && actor.role !== 'admin') {
    methodError(403, METHOD_ERROR_CODES.ROLE_FORBIDDEN, '只有工作区管理员可以执行准入或启用。');
  }
}

function assertWorkspace(actor: MethodActor, workspaceId: string): void {
  if (actor.workspaceId !== workspaceId) {
    methodError(403, METHOD_ERROR_CODES.WORKSPACE_FORBIDDEN, '不能操作其他工作区的方法包。');
  }
}

function slug(value: string, fallback: string): string {
  const base = value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '').slice(0, 60);
  return base.length >= 3 ? base : fallback;
}

function nextSemver(versions: readonly MethodPackVersion[]): string {
  if (!versions.length) return '1.0.0';
  const semver = versions.map(version => version.version)
    .map(version => /^([0-9]+)\.([0-9]+)\.([0-9]+)$/u.exec(version))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map(match => [Number(match[1]), Number(match[2]), Number(match[3])] as const)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]);
  if (!semver.length) return `0.0.1-${Date.now()}`;
  const latest = semver.at(-1)!;
  return `${latest[0]}.${latest[1]}.${latest[2] + 1}`;
}

function admissionStatusOf(versionId: string, rows: readonly WorkspaceMethodPackAccess[]): MethodAdmissionStatus | undefined {
  return rows.find(row => row.packVersionId === versionId)?.status;
}

function eventOf(input: {
  eventType: string;
  aggregateType: 'method_pack' | 'method_profile';
  aggregateId: string;
  aggregateVersion: number;
  at: string;
  actor: MethodActor;
  refKind: string;
  refId: string;
  digest: string;
  payload: MethodDomainEvent['payload'];
}): MethodDomainEvent {
  return {
    eventType: input.eventType,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    occurredAt: input.at,
    correlationId: `method:${input.aggregateId}`,
    authoritativeRef: { kind: input.refKind, id: input.refId, revisionId: input.refId, digest: input.digest },
    payload: input.payload,
  };
}

function mergeSections(base: MethodManifestSections, override: MethodManifestSections | undefined): MethodManifestSections {
  if (!override) return base;
  return {
    rules: override.rules || base.rules,
    checklist: override.checklist || base.checklist,
    examples: override.examples || base.examples,
  };
}

export class MethodPackService {
  private readonly now: () => Date;
  private readonly compilerVersion: string;
  private readonly builtinRoot: string | undefined;
  private readonly loadBuiltinPacks: MethodPackServiceOptions['loadBuiltinPacks'];

  constructor(private readonly repository: MethodPackRepositoryPort,
    options: MethodPackServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.compilerVersion = options.compilerVersion ?? METHOD_COMPILER_VERSION;
    this.builtinRoot = options.builtinRoot;
    this.loadBuiltinPacks = options.loadBuiltinPacks;
  }

  list(actor: MethodActor, workspaceId: string, query: MethodPackListQuery): Promise<MethodCatalogEntry[]> {
    assertWorkspace(actor, workspaceId);
    return this.repository.listPacks(workspaceId, query);
  }

  async get(actor: MethodActor, workspaceId: string, packId: string): Promise<MethodCatalogEntry> {
    assertWorkspace(actor, workspaceId);
    const entry = await this.repository.getPack(workspaceId, packId);
    if (!entry) methodError(404, METHOD_ERROR_CODES.NOT_FOUND, '方法包不存在或不属于当前工作区。');
    return entry;
  }

  /** API 只返回摘要，正文不进入普通响应。 */
  async versionForPreview(actor: MethodActor, workspaceId: string, versionId: string) {
    assertWorkspace(actor, workspaceId);
    const version = await this.repository.getVersion(workspaceId, versionId);
    if (!version) methodError(404, METHOD_ERROR_CODES.NOT_FOUND, '方法版本不存在。');
    const admissions = await this.repository.getAdmissions(workspaceId, [versionId]);
    return { summary: toMethodPackVersionSummary(version), admission: admissions[0] ?? null };
  }

  async import(actor: MethodActor, workspaceId: string, value: unknown, clientRequestId?: string) {
    assertWorkspace(actor, workspaceId);
    assertWriteRole(actor, true);
    const input = parseMethodPackImportInput(value);
    const requestId = assertClientRequestId(clientRequestId ?? (value as Record<string, unknown>)?.clientRequestId as string);
    if (!workspaceId) methodError(403, METHOD_ERROR_CODES.WORKSPACE_FORBIDDEN, '私有导入必须属于一个工作区。');
    const previous = await this.repository.findImportByClientRequestId(workspaceId, requestId);
    if (previous) return { pack: previous.pack, version: toMethodPackVersionSummary(previous.version) };
    const at = this.now().toISOString();
    const parsed = parseMethodBody(input.content);
    const manifest: MethodPackManifestSpec = {
      schemaVersion: METHOD_PACK_SCHEMA_VERSION,
      nodes: [...input.nodes],
      roles: ['primary', 'reviewer', 'constraint'],
      sections: parsed.sections,
      ...(Object.keys(parsed.nodeSections).length ? { nodeSections: parsed.nodeSections } : {}),
      compatibility: input.compatibility,
      suggestedTokenBudget: input.suggestedTokenBudget,
      licenseCode: input.licenseCode,
      sourceUri: input.sourceUri,
      sourceRevision: input.sourceRevision,
    };
    const contentDigest = digestOf({ content: parsed.body, nodes: input.nodes });
    const manifestDigest = computeMethodPackManifestDigest({ contentDigest, manifest });
    const sameName = (await this.repository.listPacks(workspaceId, { q: input.name }))
      .find(entry => entry.pack.name === input.name && entry.pack.origin === 'workspace_import'
        && entry.pack.workspaceId === workspaceId)?.pack ?? null;
    const reusedPack = sameName;
    if (reusedPack) {
      const versions = await this.repository.getPackVersions(workspaceId, reusedPack.id);
      const sameContent = versions.find(version => version.contentDigest === contentDigest
        && version.nodes.join('|') === input.nodes.join('|') && version.version === input.version);
      if (sameContent) {
        if (sameContent.licenseCode !== input.licenseCode
          || sameContent.commercialUseAllowed !== input.commercialUseAllowed
          || sameContent.qualityStatus !== input.qualityStatus) {
          methodError(409, METHOD_ERROR_CODES.VERSION_IMMUTABLE,
            '已发布方法版本不能原地修改许可或质量元数据；请使用新版本号。');
        }
        return { pack: reusedPack, version: toMethodPackVersionSummary(sameContent) };
      }
    }
    const packId = reusedPack?.id ?? await this.nextPackId(workspaceId, input.name);
    const versionId = methodPackVersionId();
    const pack: MethodPack = {
      id: packId,
      name: input.name,
      summary: input.summary,
      origin: 'workspace_import',
      workspaceId,
      sourceUri: input.sourceUri,
      sourceRevision: input.sourceRevision,
      createdBy: actor.userId,
      createdAt: at,
      archivedAt: null,
      clientRequestId: requestId,
    };
    const version: MethodPackVersion = {
      id: versionId,
      packId,
      workspaceId,
      version: input.version,
      content: parsed.body,
      contentRef: null,
      contentDigest,
      manifest,
      manifestDigest,
      licenseCode: input.licenseCode,
      commercialUseAllowed: input.commercialUseAllowed,
      qualityStatus: input.qualityStatus,
      approvalStatus: 'published',
      compatibility: input.compatibility,
      nodes: [...input.nodes],
      createdBy: actor.userId,
      createdAt: at,
      archivedAt: null,
    };
    const event = eventOf({
        eventType: 'method_pack.version_published.v1', aggregateType: 'method_pack',
        aggregateId: versionId, aggregateVersion: 1, at, actor,
        refKind: 'method_pack_version', refId: versionId, digest: manifestDigest,
        payload: { packId, versionId, version: input.version, contentDigest, manifestDigest,
          licenseCode: input.licenseCode, commercialUseAllowed: input.commercialUseAllowed,
          origin: 'workspace_import', nodes: input.nodes },
    });
    if (reusedPack) {
      const savedVersion = await this.repository.saveVersion({ version, clientRequestId: requestId, event });
      return { pack: reusedPack, version: toMethodPackVersionSummary(savedVersion) };
    }
    const saved = await this.repository.saveImport({ pack, version, clientRequestId: requestId, event });
    return { pack: saved.pack, version: toMethodPackVersionSummary(saved.version) };
  }

  private async nextPackId(workspaceId: string, name: string): Promise<string> {
    const base = `mpk_${slug(name, `pack-${createHash('sha256').update(`${workspaceId}:${name}`).digest('hex').slice(0, 12)}`)}`;
    const existing = await this.repository.getPack(workspaceId, base);
    if (!existing) return base;
    return `${base.slice(0, 72)}-${randomBytes(3).toString('hex')}`;
  }

  async decideAdmission(actor: MethodActor, workspaceId: string, versionId: string, value: unknown,
    clientRequestId?: string) {
    assertWorkspace(actor, workspaceId);
    assertWriteRole(actor, true);
    const input = parseMethodAdmissionInput(value);
    const requestId = assertClientRequestId(clientRequestId ?? (value as Record<string, unknown>)?.clientRequestId as string);
    const version = await this.repository.getVersion(workspaceId, versionId);
    if (!version) methodError(404, METHOD_ERROR_CODES.NOT_FOUND, '方法版本不存在。');
    const current = (await this.repository.getAdmissions(workspaceId, [versionId]))[0] ?? null;
    if (current?.clientRequestId === requestId && current.status === input.decision) return current;
    if (current?.status === 'revoked') {
      methodError(409, METHOD_ERROR_CODES.ADMISSION_TRANSITION_INVALID, '已撤销的方法包不能重新准入，请导入新版本。');
    }
    if (input.decision === 'approved') {
      if (version.qualityStatus === 'reference-only') {
        methodError(409, METHOD_ERROR_CODES.REFERENCE_ONLY, '仅供查阅的方法包不能通过生产准入。');
      }
      if (!version.licenseCode.trim() || !version.commercialUseAllowed) {
        methodError(403, METHOD_ERROR_CODES.LICENSE_NOT_ALLOWED, '方法包缺少可商用许可，不能进入生产。');
      }
      if (!version.nodes.length) {
        methodError(409, METHOD_ERROR_CODES.NODE_NOT_SUPPORTED, '方法版本没有声明任何真实运行节点。');
      }
    }
    if (current?.status === 'approved' && input.decision === 'approved') return current;
    if (current?.status === 'rejected' && input.decision === 'rejected') return current;
    const at = this.now().toISOString();
    const eventType = input.decision === 'approved' ? 'method_pack.admission_approved.v1'
      : input.decision === 'rejected' ? 'method_pack.admission_rejected.v1'
        : 'method_pack.admission_revoked.v1';
    return this.repository.decideAdmission({
      workspaceId, packVersionId: versionId, status: input.decision,
      actorId: actor.userId, reason: input.reason || null,
      qualityEvidenceVersion: input.qualityEvidenceVersion,
      expectedStatus: current?.status ?? null,
      clientRequestId: requestId, at,
      event: eventOf({
        eventType, aggregateType: 'method_pack', aggregateId: versionId, aggregateVersion: 1,
        at, actor, refKind: 'method_pack_version', refId: versionId, digest: version.manifestDigest,
        payload: { workspaceId, packVersionId: versionId, packId: version.packId, status: input.decision,
          reason: input.reason, qualityEvidenceVersion: input.qualityEvidenceVersion, actorId: actor.userId },
      }),
    });
  }

  async listProfiles(actor: MethodActor, workspaceId: string, projectId: string) {
    assertWorkspace(actor, workspaceId);
    return this.repository.listProfiles(workspaceId, projectId);
  }

  async getProfile(actor: MethodActor, workspaceId: string, projectId: string, revisionId: string) {
    assertWorkspace(actor, workspaceId);
    const profile = await this.repository.getProfile(workspaceId, projectId, revisionId);
    if (!profile) methodError(404, METHOD_ERROR_CODES.NOT_FOUND, '方法配置不存在。');
    return profile;
  }

  async createProfile(actor: MethodActor, workspaceId: string, projectId: string, value: unknown,
    clientRequestId?: string) {
    assertWorkspace(actor, workspaceId);
    assertWriteRole(actor);
    if (!await this.repository.projectExists(workspaceId, projectId)) {
      methodError(403, METHOD_ERROR_CODES.PROJECT_FORBIDDEN, '项目不存在或不属于当前工作区。');
    }
    const input = parseMethodProfileCreateInput(value);
    const requestId = assertClientRequestId(clientRequestId ?? (value as Record<string, unknown>)?.clientRequestId as string);
    let bindings = input.bindings;
    let baseRevisionId = input.baseRevisionId;
    if (baseRevisionId) {
      const base = await this.repository.getProfile(workspaceId, projectId, baseRevisionId);
      if (!base) methodError(404, METHOD_ERROR_CODES.NOT_FOUND, '基础方法配置不存在。');
      baseRevisionId = base.id;
      if (bindings.length === 0) {
        bindings = base.bindings.map(({ node, role, packVersionId, priority, tokenBudget, config }) =>
          ({ node, role, packVersionId, priority, tokenBudget, config }));
      }
    }
    const existing = await this.repository.listProfiles(workspaceId, projectId);
    const revision = existing.length ? Math.max(...existing.map(profile => profile.revision)) + 1 : 1;
    const at = this.now().toISOString();
    const id = methodProfileId();
    const digest = computeMethodProfileDigest({ workspaceId, projectId, revision, baseRevisionId,
      tokenBudget: input.tokenBudget, bindings });
    const profile: ProjectMethodProfileRevision = {
      id, workspaceId, projectId, revision, status: 'draft', baseRevisionId,
      digest, version: 1, tokenBudget: input.tokenBudget, createdBy: actor.userId, createdAt: at,
      adoptedBy: null, adoptedAt: null, archivedAt: null, validatedAt: null,
      validationDigest: null, clientRequestId: requestId,
      bindings: bindings.map(binding => ({ ...binding, profileRevisionId: id, workspaceId })),
    };
    await this.repository.createProfile({
      profile, clientRequestId: requestId,
      event: eventOf({
        eventType: 'method_profile.revision_drafted.v1', aggregateType: 'method_profile',
        aggregateId: id, aggregateVersion: 1, at, actor, refKind: 'method_profile_revision',
        refId: id, digest, payload: { profileRevisionId: id, projectId, revision,
          bindingCount: bindings.length, tokenBudget: input.tokenBudget },
      }),
    });
    return profile;
  }

  async updateBindings(actor: MethodActor, workspaceId: string, projectId: string, revisionId: string, value: unknown) {
    assertWorkspace(actor, workspaceId);
    assertWriteRole(actor);
    const input = parseMethodBindingsInput(value);
    const profile = await this.repository.getProfile(workspaceId, projectId, revisionId);
    if (!profile) methodError(404, METHOD_ERROR_CODES.NOT_FOUND, '方法配置不存在。');
    if (profile.status !== 'draft') {
      methodError(409, METHOD_ERROR_CODES.PROFILE_NOT_DRAFT, '已启用或已归档的方法配置不能修改；请新建草稿。');
    }
    if (profile.version !== input.expectedVersion) {
      methodError(409, METHOD_ERROR_CODES.PROFILE_STALE, '方法配置已被其他人更新，请刷新后重试。');
    }
    const bindings = input.bindings.map(binding => ({
      ...binding, profileRevisionId: revisionId, workspaceId,
    })) as MethodBinding[];
    const digest = computeMethodProfileDigest({
      workspaceId, projectId, revision: profile.revision, baseRevisionId: profile.baseRevisionId,
      tokenBudget: input.tokenBudget, bindings,
    });
    const at = this.now().toISOString();
    const next: ProjectMethodProfileRevision = {
      ...profile, bindings, digest, version: input.expectedVersion + 1,
      tokenBudget: input.tokenBudget,
      validatedAt: null, validationDigest: null, clientRequestId: input.clientRequestId,
    };
    await this.repository.replaceProfile({
      profile: next, expectedVersion: input.expectedVersion, clientRequestId: input.clientRequestId,
      event: eventOf({
        eventType: 'method_profile.bindings_updated.v1', aggregateType: 'method_profile',
        aggregateId: revisionId, aggregateVersion: next.version, at, actor,
        refKind: 'method_profile_revision', refId: revisionId, digest,
        payload: { profileRevisionId: revisionId, projectId, revision: profile.revision,
          bindingCount: bindings.length, tokenBudget: input.tokenBudget },
      }),
    });
    return next;
  }

  private async compileProfile(workspaceId: string, profile: ProjectMethodProfileRevision,
    tokenBudget?: number) {
    const ids = [...new Set(profile.bindings.map(binding => binding.packVersionId))];
    const versions = await this.repository.getVersions(workspaceId, ids);
    const admissions = await this.repository.getAdmissions(workspaceId, ids);
    return compileMethodProfile({
      workspaceId, projectId: profile.projectId, profile, versions: new Map(versions.map(version => [version.id, version])),
      admissions: new Map(admissions.map(admission => [admission.packVersionId, admission.status])),
      compilerVersion: this.compilerVersion, tokenBudget: tokenBudget ?? profile.tokenBudget,
    });
  }

  async validate(actor: MethodActor, workspaceId: string, projectId: string, revisionId: string) {
    assertWorkspace(actor, workspaceId);
    assertWriteRole(actor);
    const profile = await this.repository.getProfile(workspaceId, projectId, revisionId);
    if (!profile) methodError(404, METHOD_ERROR_CODES.NOT_FOUND, '方法配置不存在。');
    if (profile.status !== 'draft') {
      methodError(409, METHOD_ERROR_CODES.PROFILE_NOT_DRAFT, '只有草稿需要校验。');
    }
    const at = this.now().toISOString();
    let result;
    try {
      result = await this.compileProfile(workspaceId, profile);
    } catch (error) {
      if (error instanceof MethodPackError) {
        await this.repository.emit({
          eventType: 'method_profile.compilation_failed.v1', aggregateType: 'method_profile',
          aggregateId: `${profile.id}:compilation-failure`, aggregateVersion: 1, occurredAt: at,
          correlationId: `method:${profile.id}`,
          authoritativeRef: { kind: 'method_profile_revision', id: profile.id, revisionId: profile.id, digest: profile.digest },
          payload: { profileRevisionId: profile.id, projectId, code: error.code, message: error.message.slice(0, 500) },
        }, workspaceId);
      }
      throw error;
    }
    const saved = await this.repository.recordValidation(profile.id, profile.version,
      result.manifest.manifestDigest, at, eventOf({
        eventType: 'method_profile.revision_validated.v1', aggregateType: 'method_profile',
        aggregateId: profile.id, aggregateVersion: profile.version + 1, at, actor,
        refKind: 'method_profile_revision', refId: profile.id, digest: profile.digest,
        payload: { profileRevisionId: profile.id, manifestDigest: result.manifest.manifestDigest,
          estimatedTokens: result.manifest.estimatedTokens, tokenBudget: result.manifest.tokenBudget },
      }));
    return { profile: saved, manifest: redactMethodManifest(result.manifest) };
  }

  async preview(actor: MethodActor, workspaceId: string, projectId: string, revisionId: string) {
    assertWorkspace(actor, workspaceId);
    const profile = await this.repository.getProfile(workspaceId, projectId, revisionId);
    if (!profile) methodError(404, METHOD_ERROR_CODES.NOT_FOUND, '方法配置不存在。');
    const result = await this.compileProfile(workspaceId, profile);
    return redactMethodManifest(result.manifest);
  }

  async adopt(actor: MethodActor, workspaceId: string, projectId: string, revisionId: string, value: unknown) {
    assertWorkspace(actor, workspaceId);
    assertWriteRole(actor, true);
    const input = parseMethodProfileAdoptInput(value);
    const profile = await this.repository.getProfile(workspaceId, projectId, revisionId);
    if (!profile) methodError(404, METHOD_ERROR_CODES.NOT_FOUND, '方法配置不存在。');
    if (profile.status !== 'draft') {
      methodError(409, METHOD_ERROR_CODES.PROFILE_NOT_DRAFT, '只有草稿可以被启用。');
    }
    if (profile.version !== input.expectedVersion) {
      methodError(409, METHOD_ERROR_CODES.PROFILE_STALE, '确认版本已过期，请重新确认后再启用。');
    }
    if (profile.digest !== input.expectedDigest) {
      methodError(409, METHOD_ERROR_CODES.MANIFEST_DIGEST_MISMATCH, '确认摘要与当前配置不一致，请重新校验。');
    }
    const result = await this.compileProfile(workspaceId, profile);
    const at = this.now().toISOString();
    const adopted = await this.repository.adoptProfile({
      profile: { ...profile, status: 'adopted', adoptedBy: actor.userId, adoptedAt: at,
        version: profile.version + 1, digest: profile.digest },
      expectedVersion: input.expectedVersion, expectedDigest: input.expectedDigest,
      actorId: actor.userId, at, reason: input.reason, clientRequestId: input.clientRequestId,
      events: [eventOf({
        eventType: 'method_profile.revision_adopted.v1', aggregateType: 'method_profile',
        aggregateId: profile.id, aggregateVersion: profile.version + 1, at, actor,
        refKind: 'method_profile_revision', refId: profile.id, digest: profile.digest,
        payload: { profileRevisionId: profile.id, projectId, manifestDigest: result.manifest.manifestDigest,
          estimatedTokens: result.manifest.estimatedTokens, tokenBudget: result.manifest.tokenBudget,
          reason: input.reason },
      })],
    });
    return { profile: adopted, manifest: redactMethodManifest(result.manifest) };
  }

  async archive(actor: MethodActor, workspaceId: string, projectId: string, revisionId: string) {
    assertWorkspace(actor, workspaceId);
    assertWriteRole(actor, true);
    const profile = await this.repository.getProfile(workspaceId, projectId, revisionId);
    if (!profile) methodError(404, METHOD_ERROR_CODES.NOT_FOUND, '方法配置不存在。');
    if (profile.status === 'archived') return profile;
    const at = this.now().toISOString();
    return this.repository.archiveProfile(workspaceId, projectId, revisionId, profile.version,
      eventOf({
        eventType: 'method_profile.revision_archived.v1', aggregateType: 'method_profile',
        aggregateId: profile.id, aggregateVersion: profile.version + 1, at, actor,
        refKind: 'method_profile_revision', refId: profile.id, digest: profile.digest,
        payload: { profileRevisionId: profile.id, projectId, reason: 'manual_archive' },
      }));
  }

  /**
   * ProductionRun 创建时一次性冻结。只接受当前 adopted 或显式确认过的 revision+digest。
   * 后续准入撤销不会改变已创建运行。
   */
  async freezeForRun(workspaceId: string, projectId: string, revisionId?: string,
    digest?: string): Promise<FrozenMethodProfile | null> {
    const profile = revisionId
      ? await this.repository.getProfile(workspaceId, projectId, revisionId)
      : await this.repository.currentAdopted(workspaceId, projectId);
    if (!profile) {
      if (revisionId) methodError(404, METHOD_ERROR_CODES.NOT_FOUND, '方法配置不存在。');
      return null;
    }
    if (profile.status !== 'adopted') {
      methodError(409, METHOD_ERROR_CODES.PROFILE_NOT_ADOPTED,
        '只有已启用的方法配置才能创建生产运行；草稿需先人工审核并启用。');
    }
    if (digest && digest !== profile.digest) {
      methodError(409, METHOD_ERROR_CODES.MANIFEST_DIGEST_MISMATCH,
        '方法配置摘要与确认卡不一致，请重新确认。');
    }
    const result = await this.compileProfile(workspaceId, profile);
    return {
      workspaceId,
      projectId,
      profileRevisionId: profile.id,
      profileDigest: profile.digest,
      compilerVersion: result.manifest.compilerVersion,
      manifest: result.manifest,
      manifestDigest: result.manifestDigest,
      frozenAt: this.now().toISOString(),
    };
  }

  async freezeSelection(workspaceId: string, projectId: string, value: unknown): Promise<FrozenMethodProfile | null> {
    const selection = parseMethodSelectionForRun(value);
    return this.freezeForRun(workspaceId, projectId, selection.revisionId, selection.digest);
  }

  /**
   * 内置目录同步：按现有正文 digest 生成不可变版本；正文变化只追加 patch 版本。
   * 内置公共目录方法包仍需每个 Workspace 显式准入后才能绑定。
   */
  async syncBuiltinCatalog(): Promise<{ imported: number; versions: number }> {
    if (!this.loadBuiltinPacks || !this.builtinRoot) return { imported: 0, versions: 0 };
    let imported = 0;
    let versions = 0;
    const at = this.now().toISOString();
    for (const meta of this.loadBuiltinPacks()) {
      if ((meta.contentPolicy ?? 'imported') === 'reference-only') continue;
      const nodes = builtinNodes(meta.stages ?? []);
      if (!nodes.length) continue;
      try {
        const stat = statSync(join(meta.directory, meta.entry));
        if (stat.size > 512 * 1024) continue;
        const raw = readFileSync(join(meta.directory, meta.entry), 'utf8');
        const parsed = parseMethodBody(raw);
        const contentDigest = digestOf({ content: parsed.body, nodes });
        const manifest: MethodPackManifestSpec = {
          schemaVersion: METHOD_PACK_SCHEMA_VERSION,
          nodes,
          roles: ['primary', 'reviewer', 'constraint'],
          sections: parsed.sections,
          ...(Object.keys(parsed.nodeSections).length ? { nodeSections: parsed.nodeSections } : {}),
          compatibility: { models: ['*'], minContextTokens: null },
          suggestedTokenBudget: 4_000,
          licenseCode: meta.license,
          sourceUri: `prompt-library:${meta.id}`,
          sourceRevision: meta.version,
        };
        const manifestDigest = computeMethodPackManifestDigest({ contentDigest, manifest });
        const hash = createHash('sha256').update(meta.id).digest('hex').slice(0, 8);
        const packId = `mpk_${slug(meta.id, `builtin-${hash}`)}-${hash}`;
        const existingPack = await this.repository.getPack(LEGACY_WORKSPACE_ID, packId);
        const existingVersions = existingPack ? await this.repository.getPackVersions(LEGACY_WORKSPACE_ID, packId) : [];
        if (existingVersions.some(version => version.contentDigest === contentDigest
          && version.nodes.join('|') === nodes.join('|'))) continue;
        const version: MethodPackVersion = {
          id: methodPackVersionId(),
          packId,
          workspaceId: null,
          version: nextSemver(existingVersions),
          content: parsed.body,
          contentRef: null,
          contentDigest,
          manifest,
          manifestDigest,
          licenseCode: meta.license,
          commercialUseAllowed: meta.commercialUseAllowed ?? false,
          qualityStatus: meta.quality === 'evaluated' ? 'evaluated' : 'unevaluated',
          approvalStatus: 'published',
          compatibility: { models: ['*'], minContextTokens: null },
          nodes,
          createdBy: 'system:builtin-catalog',
          createdAt: at,
          archivedAt: null,
        };
        const event = eventOf({
          eventType: 'method_pack.version_published.v1', aggregateType: 'method_pack',
          aggregateId: version.id, aggregateVersion: 1, at,
          actor: { workspaceId: LEGACY_WORKSPACE_ID, userId: 'system:builtin-catalog', role: 'admin' },
          refKind: 'method_pack_version', refId: version.id, digest: manifestDigest,
          payload: { packId, versionId: version.id, version: version.version, contentDigest,
            manifestDigest, licenseCode: meta.license, commercialUseAllowed: version.commercialUseAllowed,
            origin: 'builtin', nodes },
        });
        if (existingPack) {
          await this.repository.saveVersion({ version, clientRequestId: null, event });
          versions += 1;
        } else {
          await this.repository.saveImport({
            pack: {
              id: packId, name: meta.name, summary: meta.summary, origin: 'builtin', workspaceId: null,
              sourceUri: `prompt-library:${meta.id}`, sourceRevision: meta.version,
              createdBy: 'system:builtin-catalog', createdAt: at, archivedAt: null,
            },
            version, clientRequestId: null, event,
          });
          imported += 1;
          versions += 1;
        }
      } catch {
        // 单个内置包损坏不应阻塞其余目录；错误在目录列表中以缺失体现，绝不注入半成品。
      }
    }
    return { imported, versions };
  }
}

export function builtinNodes(stages: readonly string[]): MethodPackNode[] {
  const nodes: MethodPackNode[] = [];
  const push = (node: MethodPackNode) => { if (!nodes.includes(node)) nodes.push(node); };
  for (const stage of stages) {
    if (['adaptation', 'breakdown', 'episode-outline', 'script', 'script-review'].includes(stage)) push('script-adaptation');
    else if (stage === 'character') push('character-image');
    else if (stage === 'storyboard') push('storyboard');
    else if (['video-prompt', 'production', 'video'].includes(stage)) push('video-prompt');
  }
  return METHOD_PACK_NODES.filter(node => nodes.includes(node));
}

/** 供装配层读取当前租户，禁止从请求体自报 workspace。 */
export function actorFromTenant(tenant: { workspaceId: string; userId: string; role: TenantRole; requestId: string }): MethodActor {
  return { workspaceId: tenant.workspaceId, userId: tenant.userId, role: tenant.role, requestId: tenant.requestId };
}

export type { MethodAdmissionInput, MethodPackImportInput, MethodManifestSections };
