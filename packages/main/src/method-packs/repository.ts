import { randomBytes } from 'node:crypto';
import type {
  MethodAdmissionStatus,
  MethodCatalogEntry,
  MethodPack,
  MethodPackListQuery,
  MethodPackVersion,
  MethodPackVersionSummary,
  ProjectMethodProfileRevision,
  WorkspaceMethodPackAccess,
} from '@lyra/shared';

export interface MethodDomainEvent {
  eventType: string;
  aggregateType: 'method_pack' | 'method_profile';
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
  correlationId: string;
  authoritativeRef: { kind: string; id: string; revisionId: string | null; digest: string };
  payload: Record<string, string | number | boolean | null | Array<string | number | boolean | null>>;
}

export interface SaveMethodPackInput {
  pack: MethodPack;
  version: MethodPackVersion;
  clientRequestId: string | null;
  event: MethodDomainEvent;
}

export interface SaveMethodVersionInput {
  version: MethodPackVersion;
  clientRequestId: string | null;
  event: MethodDomainEvent;
}

export interface DecideAdmissionInput {
  workspaceId: string;
  packVersionId: string;
  status: MethodAdmissionStatus;
  actorId: string;
  reason: string | null;
  qualityEvidenceVersion: string | null;
  expectedStatus: MethodAdmissionStatus | null;
  clientRequestId: string | null;
  at: string;
  event: MethodDomainEvent;
}

export interface SaveProfileInput {
  profile: ProjectMethodProfileRevision;
  clientRequestId: string;
  event: MethodDomainEvent;
}

export interface ReplaceProfileInput {
  profile: ProjectMethodProfileRevision;
  expectedVersion: number;
  clientRequestId: string;
  event: MethodDomainEvent;
}

export interface AdoptProfileInput {
  profile: ProjectMethodProfileRevision;
  expectedVersion: number;
  expectedDigest: string;
  actorId: string;
  at: string;
  reason: string;
  clientRequestId: string;
  events: MethodDomainEvent[];
}

export interface MethodPackRepositoryPort {
  hasBuiltinCatalog(): Promise<boolean>;
  listPacks(workspaceId: string, query: MethodPackListQuery): Promise<MethodCatalogEntry[]>;
  getPack(workspaceId: string, packId: string): Promise<MethodCatalogEntry | null>;
  getPackVersions(workspaceId: string, packId: string): Promise<MethodPackVersion[]>;
  getVersion(workspaceId: string, versionId: string): Promise<MethodPackVersion | null>;
  getVersions(workspaceId: string, versionIds: readonly string[]): Promise<MethodPackVersion[]>;
  getAdmissions(workspaceId: string, versionIds: readonly string[]): Promise<WorkspaceMethodPackAccess[]>;
  findImportByClientRequestId(workspaceId: string, clientRequestId: string): Promise<{ pack: MethodPack; version: MethodPackVersion } | null>;
  saveImport(input: SaveMethodPackInput): Promise<{ pack: MethodPack; version: MethodPackVersion }>;
  saveVersion(input: SaveMethodVersionInput): Promise<MethodPackVersion>;
  decideAdmission(input: DecideAdmissionInput): Promise<WorkspaceMethodPackAccess>;
  projectExists(workspaceId: string, projectId: string): Promise<boolean>;
  listProfiles(workspaceId: string, projectId: string): Promise<ProjectMethodProfileRevision[]>;
  getProfile(workspaceId: string, projectId: string, revisionId: string): Promise<ProjectMethodProfileRevision | null>;
  currentAdopted(workspaceId: string, projectId: string): Promise<ProjectMethodProfileRevision | null>;
  createProfile(input: SaveProfileInput): Promise<ProjectMethodProfileRevision>;
  replaceProfile(input: ReplaceProfileInput): Promise<ProjectMethodProfileRevision>;
  recordValidation(profileId: string, expectedVersion: number, digest: string, at: string,
    event: MethodDomainEvent): Promise<ProjectMethodProfileRevision>;
  adoptProfile(input: AdoptProfileInput): Promise<ProjectMethodProfileRevision>;
  archiveProfile(workspaceId: string, projectId: string, revisionId: string, expectedVersion: number,
    event: MethodDomainEvent): Promise<ProjectMethodProfileRevision>;
  /** 失败事件也必须进统一 Outbox；不改变业务状态。 */
  emit(event: MethodDomainEvent, workspaceId: string): Promise<void>;
}

function clone<T>(value: T): T { return structuredClone(value); }

function summaryOf(version: MethodPackVersion): MethodPackVersionSummary {
  return {
    id: version.id, packId: version.packId, version: version.version,
    contentDigest: version.contentDigest, manifestDigest: version.manifestDigest,
    nodes: [...version.nodes], licenseCode: version.licenseCode,
    commercialUseAllowed: version.commercialUseAllowed, qualityStatus: version.qualityStatus,
    approvalStatus: version.approvalStatus, compatibility: clone(version.compatibility),
    createdAt: version.createdAt, archivedAt: version.archivedAt,
  };
}

/** 离线单测/服务测试实现；生产必须使用 PostgresMethodPackRepository。 */
export class MemoryMethodPackRepository implements MethodPackRepositoryPort {
  async hasBuiltinCatalog(): Promise<boolean> {
    return [...this.packs.values()].some(pack => pack.origin === 'builtin' && !pack.archivedAt);
  }
  private readonly packs = new Map<string, MethodPack>();
  private readonly versions = new Map<string, MethodPackVersion>();
  private readonly admissions = new Map<string, WorkspaceMethodPackAccess>();
  private readonly profiles = new Map<string, ProjectMethodProfileRevision>();
  private readonly projects = new Set<string>();
  readonly events: MethodDomainEvent[] = [];

  addProject(workspaceId: string, projectId: string): void { this.projects.add(`${workspaceId}\u0000${projectId}`); }

  async listPacks(workspaceId: string, query: MethodPackListQuery): Promise<MethodCatalogEntry[]> {
    const entries: MethodCatalogEntry[] = [];
    for (const pack of this.packs.values()) {
      if (pack.workspaceId !== null && pack.workspaceId !== workspaceId) continue;
      if (pack.archivedAt) continue;
      if (query.q && !`${pack.name} ${pack.summary} ${pack.id}`.toLowerCase().includes(query.q.toLowerCase())) continue;
      const versions = [...this.versions.values()].filter(version => version.packId === pack.id && !version.archivedAt);
      if (query.node && !versions.some(version => version.nodes.includes(query.node!))) continue;
      if (query.license && !versions.some(version => version.licenseCode === query.license)) continue;
      if (query.qualityStatus && !versions.some(version => version.qualityStatus === query.qualityStatus)) continue;
      versions.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const latest = versions.at(-1);
      const admission = latest ? this.admissions.get(`${workspaceId}\u0000${latest.id}`) ?? null : null;
      if (query.admissionStatus && (admission?.status ?? 'pending') !== query.admissionStatus) continue;
      if (query.adoptedByProjectId && ![...this.profiles.values()].some(profile =>
        profile.workspaceId === workspaceId && profile.projectId === query.adoptedByProjectId
        && profile.status === 'adopted' && profile.bindings.some(binding => binding.packVersionId === latest?.id))) continue;
      const adoptedProjects = new Set([...this.profiles.values()]
        .filter(profile => profile.workspaceId === workspaceId && profile.status === 'adopted'
          && latest && profile.bindings.some(binding => binding.packVersionId === latest.id))
        .map(profile => profile.projectId));
      entries.push({ pack: clone(pack), latestVersion: latest ? summaryOf(latest) : null,
        versions: versions.map(summaryOf), admission: admission ? clone(admission) : null,
        adoptedProjectCount: adoptedProjects.size });
    }
    return entries.sort((left, right) => left.pack.createdAt.localeCompare(right.pack.createdAt));
  }

  async getPack(workspaceId: string, packId: string): Promise<MethodCatalogEntry | null> {
    const pack = this.packs.get(packId);
    if (!pack || (pack.workspaceId !== null && pack.workspaceId !== workspaceId)) return null;
    const versions = [...this.versions.values()].filter(version => version.packId === packId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const latest = versions.at(-1);
    const adoptedProjects = new Set([...this.profiles.values()]
      .filter(profile => profile.workspaceId === workspaceId && profile.status === 'adopted'
        && latest && profile.bindings.some(binding => binding.packVersionId === latest.id))
      .map(profile => profile.projectId));
    return { pack: clone(pack), latestVersion: latest ? summaryOf(latest) : null,
      versions: versions.map(summaryOf),
      admission: latest ? clone(this.admissions.get(`${workspaceId}\u0000${latest.id}`) ?? null) : null,
      adoptedProjectCount: adoptedProjects.size };
  }

  async getPackVersions(_workspaceId: string, packId: string): Promise<MethodPackVersion[]> {
    return [...this.versions.values()].filter(version => version.packId === packId).map(clone);
  }

  async getVersion(workspaceId: string, versionId: string): Promise<MethodPackVersion | null> {
    const version = this.versions.get(versionId);
    if (!version || (version.workspaceId !== null && version.workspaceId !== workspaceId)) return null;
    return clone(version);
  }

  async getVersions(workspaceId: string, versionIds: readonly string[]): Promise<MethodPackVersion[]> {
    return [...new Set(versionIds)].map(id => this.versions.get(id)).filter((version): version is MethodPackVersion =>
      Boolean(version) && (version!.workspaceId === null || version!.workspaceId === workspaceId)).map(clone);
  }

  async getAdmissions(workspaceId: string, versionIds: readonly string[]): Promise<WorkspaceMethodPackAccess[]> {
    return [...new Set(versionIds)].map(id => this.admissions.get(`${workspaceId}\u0000${id}`))
      .filter((item): item is WorkspaceMethodPackAccess => Boolean(item)).map(clone);
  }

  async findImportByClientRequestId(workspaceId: string, clientRequestId: string): Promise<{ pack: MethodPack; version: MethodPackVersion } | null> {
    const pack = [...this.packs.values()].find(item => item.workspaceId === workspaceId && item.clientRequestId === clientRequestId);
    if (!pack) return null;
    const version = [...this.versions.values()].find(item => item.packId === pack.id);
    return version ? { pack: clone(pack), version: clone(version) } : null;
  }

  async saveImport(input: SaveMethodPackInput): Promise<{ pack: MethodPack; version: MethodPackVersion }> {
    if (input.clientRequestId) {
      const existing = await this.findImportByClientRequestId(input.pack.workspaceId!, input.clientRequestId);
      if (existing) return existing;
    }
    this.packs.set(input.pack.id, clone(input.pack));
    this.versions.set(input.version.id, clone(input.version));
    this.events.push(clone(input.event));
    return { pack: clone(input.pack), version: clone(input.version) };
  }

  async saveVersion(input: SaveMethodVersionInput): Promise<MethodPackVersion> {
    const existing = this.versions.get(input.version.id);
    if (existing) {
      if (existing.contentDigest !== input.version.contentDigest) {
        throw new Error('METHOD_VERSION_IMMUTABLE');
      }
      return clone(existing);
    }
    this.versions.set(input.version.id, clone(input.version));
    this.events.push(clone(input.event));
    return clone(input.version);
  }

  async decideAdmission(input: DecideAdmissionInput): Promise<WorkspaceMethodPackAccess> {
    const key = `${input.workspaceId}\u0000${input.packVersionId}`;
    const existing = this.admissions.get(key);
    if (existing && input.clientRequestId && existing.clientRequestId === input.clientRequestId
      && existing.status === input.status) return clone(existing);
    if (existing && input.expectedStatus !== null && existing.status !== input.expectedStatus) {
      throw new Error('METHOD_ADMISSION_TRANSITION_INVALID');
    }
    if (!this.versions.has(input.packVersionId)) throw new Error('METHOD_PACK_VERSION_NOT_FOUND');
    const admitted = input.status === 'approved';
    const row: WorkspaceMethodPackAccess = {
      workspaceId: input.workspaceId, packVersionId: input.packVersionId, status: input.status,
      approvedBy: admitted ? input.actorId : existing?.approvedBy ?? null,
      approvedAt: admitted ? input.at : existing?.approvedAt ?? null,
      rejectionReason: admitted ? null : (input.reason ?? ''),
      qualityEvidenceVersion: input.qualityEvidenceVersion ?? existing?.qualityEvidenceVersion ?? null,
      updatedAt: input.at, clientRequestId: input.clientRequestId,
    };
    this.admissions.set(key, row);
    this.events.push(clone(input.event));
    return clone(row);
  }

  async projectExists(workspaceId: string, projectId: string): Promise<boolean> {
    return this.projects.size === 0 || this.projects.has(`${workspaceId}\u0000${projectId}`);
  }

  async listProfiles(workspaceId: string, projectId: string): Promise<ProjectMethodProfileRevision[]> {
    return [...this.profiles.values()].filter(profile => profile.workspaceId === workspaceId && profile.projectId === projectId)
      .sort((left, right) => right.revision - left.revision).map(clone);
  }

  async getProfile(workspaceId: string, projectId: string, revisionId: string): Promise<ProjectMethodProfileRevision | null> {
    const profile = this.profiles.get(revisionId);
    return profile && profile.workspaceId === workspaceId && profile.projectId === projectId ? clone(profile) : null;
  }

  async currentAdopted(workspaceId: string, projectId: string): Promise<ProjectMethodProfileRevision | null> {
    const profile = [...this.profiles.values()].find(item => item.workspaceId === workspaceId
      && item.projectId === projectId && item.status === 'adopted');
    return profile ? clone(profile) : null;
  }

  async createProfile(input: SaveProfileInput): Promise<ProjectMethodProfileRevision> {
    if ([...this.profiles.values()].some(profile => profile.workspaceId === input.profile.workspaceId
      && profile.projectId === input.profile.projectId && profile.clientRequestId === input.clientRequestId)) {
      throw new Error('METHOD_PROFILE_REQUEST_REUSED');
    }
    this.profiles.set(input.profile.id, clone(input.profile));
    this.events.push(clone(input.event));
    return clone(input.profile);
  }

  async replaceProfile(input: ReplaceProfileInput): Promise<ProjectMethodProfileRevision> {
    const existing = this.profiles.get(input.profile.id);
    if (!existing) throw new Error('METHOD_PROFILE_NOT_FOUND');
    if (existing.version !== input.expectedVersion) throw new Error('METHOD_PROFILE_STALE');
    this.profiles.set(input.profile.id, clone(input.profile));
    this.events.push(clone(input.event));
    return clone(input.profile);
  }

  async recordValidation(profileId: string, expectedVersion: number, _digest: string, at: string,
    event: MethodDomainEvent): Promise<ProjectMethodProfileRevision> {
    const existing = this.profiles.get(profileId);
    if (!existing) throw new Error('METHOD_PROFILE_NOT_FOUND');
    if (existing.version !== expectedVersion) throw new Error('METHOD_PROFILE_STALE');
    const next = { ...existing, version: existing.version + 1, validatedAt: at, validationDigest: _digest };
    this.profiles.set(profileId, next);
    this.events.push(clone(event));
    return clone(next);
  }

  async adoptProfile(input: AdoptProfileInput): Promise<ProjectMethodProfileRevision> {
    const existing = this.profiles.get(input.profile.id);
    if (!existing) throw new Error('METHOD_PROFILE_NOT_FOUND');
    if (existing.version !== input.expectedVersion || existing.digest !== input.expectedDigest) {
      throw new Error('METHOD_PROFILE_STALE');
    }
    for (const profile of this.profiles.values()) {
      if (profile.id !== existing.id && profile.workspaceId === existing.workspaceId
        && profile.projectId === existing.projectId && profile.status === 'adopted') {
        profile.status = 'archived'; profile.archivedAt = input.at; profile.version += 1;
      }
    }
    const next = { ...existing, status: 'adopted' as const, adoptedBy: input.actorId, adoptedAt: input.at,
      version: existing.version + 1, archivedAt: null };
    this.profiles.set(next.id, next);
    this.events.push(...input.events.map(clone));
    return clone(next);
  }

  async archiveProfile(workspaceId: string, projectId: string, revisionId: string, expectedVersion: number,
    event: MethodDomainEvent): Promise<ProjectMethodProfileRevision> {
    const existing = this.profiles.get(revisionId);
    if (!existing || existing.workspaceId !== workspaceId || existing.projectId !== projectId) {
      throw new Error('METHOD_PROFILE_NOT_FOUND');
    }
    if (existing.version !== expectedVersion) throw new Error('METHOD_PROFILE_STALE');
    const next = { ...existing, status: 'archived' as const, archivedAt: event.occurredAt, version: existing.version + 1 };
    this.profiles.set(revisionId, next);
    this.events.push(clone(event));
    return clone(next);
  }

  async emit(event: MethodDomainEvent, _workspaceId: string): Promise<void> {
    this.events.push(clone(event));
  }
}

export function methodProfileId(): string { return `mpr_${randomBytes(16).toString('hex')}`; }
export function methodPackVersionId(): string { return `mpv_${randomBytes(16).toString('hex')}`; }
