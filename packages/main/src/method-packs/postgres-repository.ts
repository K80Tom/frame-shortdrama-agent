import type { PoolClient, QueryResultRow } from 'pg';
import {
  METHOD_COMPILER_VERSION,
  METHOD_ERROR_CODES,
  MethodPackError,
  type MethodAdmissionStatus,
  type MethodCatalogEntry,
  type MethodPack,
  type MethodManifestSections,
  type MethodPackListQuery,
  type MethodPackManifestSpec,
  type MethodPackVersion,
  type ProjectMethodProfileRevision,
  type WorkspaceMethodPackAccess,
} from '@lyra/shared';
import { DataOutbox, appendDataEvent } from '../data/outbox';
import { createDataEventV2 } from '../data/tenant-event';
import type { PostgresDatabase } from '../db/client';
import { LEGACY_WORKSPACE_ID } from '../tenancy/context';
import {
  type AdoptProfileInput,
  type DecideAdmissionInput,
  type MethodDomainEvent,
  type MethodPackRepositoryPort,
  type ReplaceProfileInput,
  type SaveMethodVersionInput,
  type SaveMethodPackInput,
  type SaveProfileInput,
} from './repository';

interface PackRow extends QueryResultRow {
  id: string; name: string; summary: string; origin: MethodPack['origin'];
  workspace_id: string | null; source_uri: string | null; source_revision: string | null;
  created_by: string; created_at: Date; archived_at: Date | null; client_request_id: string | null;
}
interface VersionRow extends QueryResultRow {
  id: string; pack_id: string; workspace_id: string | null; version: string;
  content: string | null; content_ref: string | null; content_digest: string;
  manifest_json: MethodPackManifestSpec; manifest_digest: string; license_code: string;
  commercial_use_allowed: boolean; quality_status: MethodPackVersion['qualityStatus'];
  approval_status: MethodPackVersion['approvalStatus']; compatibility_json: MethodPackVersion['compatibility'];
  nodes_json: MethodPackVersion['nodes']; created_by: string; created_at: Date; archived_at: Date | null;
}
interface AdmissionRow extends QueryResultRow {
  workspace_id: string; pack_version_id: string; status: MethodAdmissionStatus;
  approved_by: string | null; approved_at: Date | null; rejection_reason: string | null;
  quality_evidence_version: string | null; updated_at: Date; client_request_id: string | null;
}
interface ProfileRow extends QueryResultRow {
  id: string; workspace_id: string; project_id: string; revision: number;
  status: ProjectMethodProfileRevision['status']; base_revision_id: string | null;
  digest: string; version: number; token_budget: number; created_by: string; created_at: Date;
  adopted_by: string | null; adopted_at: Date | null; archived_at: Date | null;
  validated_at: Date | null; validation_digest: string | null; client_request_id: string | null;
}
interface BindingRow extends QueryResultRow {
  profile_revision_id: string; workspace_id: string; node: ProjectMethodProfileRevision['bindings'][number]['node'];
  role: ProjectMethodProfileRevision['bindings'][number]['role']; pack_version_id: string;
  priority: number; token_budget: number; config_json: Record<string, unknown>;
}

const PACK_COLUMNS = `id, name, summary, origin, workspace_id, source_uri, source_revision, created_by, created_at, archived_at, client_request_id`;
const VERSION_COLUMNS = `id, pack_id, workspace_id, version, content, content_ref, content_digest,
  manifest_json, manifest_digest, license_code, commercial_use_allowed, quality_status, approval_status,
  compatibility_json, nodes_json, created_by, created_at, archived_at`;
const ADMISSION_COLUMNS = `workspace_id, pack_version_id, status, approved_by, approved_at, rejection_reason,
  quality_evidence_version, updated_at, client_request_id`;
const PROFILE_COLUMNS = `id, workspace_id, project_id, revision, status, base_revision_id, digest, version, token_budget,
  created_by, created_at, adopted_by, adopted_at, archived_at, validated_at, validation_digest, client_request_id`;
const BINDING_COLUMNS = `profile_revision_id, workspace_id, node, role, pack_version_id, priority, token_budget, config_json`;

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
function packOf(row: PackRow): MethodPack {
  return {
    id: row.id, name: row.name, summary: row.summary, origin: row.origin,
    workspaceId: row.workspace_id, sourceUri: row.source_uri, sourceRevision: row.source_revision,
    createdBy: row.created_by, createdAt: iso(row.created_at)!, archivedAt: iso(row.archived_at),
    clientRequestId: row.client_request_id,
  };
}
function versionOf(row: VersionRow): MethodPackVersion {
  return {
    id: row.id, packId: row.pack_id, workspaceId: row.workspace_id, version: row.version,
    content: row.content, contentRef: row.content_ref, contentDigest: row.content_digest,
    manifest: row.manifest_json, manifestDigest: row.manifest_digest,
    licenseCode: row.license_code, commercialUseAllowed: row.commercial_use_allowed,
    qualityStatus: row.quality_status, approvalStatus: row.approval_status,
    compatibility: row.compatibility_json, nodes: row.nodes_json,
    createdBy: row.created_by, createdAt: iso(row.created_at)!, archivedAt: iso(row.archived_at),
  };
}
function admissionOf(row: AdmissionRow): WorkspaceMethodPackAccess {
  return {
    workspaceId: row.workspace_id, packVersionId: row.pack_version_id, status: row.status,
    approvedBy: row.approved_by, approvedAt: iso(row.approved_at),
    rejectionReason: row.rejection_reason, qualityEvidenceVersion: row.quality_evidence_version,
    updatedAt: iso(row.updated_at)!, clientRequestId: row.client_request_id,
  };
}
function summaryOf(version: MethodPackVersion) {
  return {
    id: version.id, packId: version.packId, version: version.version,
    contentDigest: version.contentDigest, manifestDigest: version.manifestDigest,
    nodes: version.nodes, licenseCode: version.licenseCode,
    commercialUseAllowed: version.commercialUseAllowed, qualityStatus: version.qualityStatus,
    approvalStatus: version.approvalStatus, compatibility: version.compatibility,
    createdAt: version.createdAt, archivedAt: version.archivedAt,
  };
}

async function append(client: PoolClient, workspaceId: string, event: MethodDomainEvent): Promise<void> {
  const dataEvent = createDataEventV2({
    workspaceId,
    eventType: event.eventType,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateVersion: event.aggregateVersion,
    occurredAt: event.occurredAt,
    recordedAt: event.occurredAt,
    correlationId: event.correlationId,
    authoritativeRef: event.authoritativeRef,
    payload: event.payload,
  });
  await appendDataEvent(client, dataEvent);
}

async function nextAggregateVersion(client: PoolClient, aggregateType: string, aggregateId: string): Promise<number> {
  const result = await client.query<{ next: number }>(
    `SELECT COALESCE(MAX(aggregate_version), 0) + 1 AS next FROM data_outbox_events
     WHERE aggregate_type = $1 AND aggregate_id = $2`, [aggregateType, aggregateId],
  );
  return Number(result.rows[0]?.next ?? 1);
}

function bindingsFromRows(rows: readonly BindingRow[]): Map<string, ProjectMethodProfileRevision['bindings']> {
  const byProfile = new Map<string, ProjectMethodProfileRevision['bindings']>();
  for (const row of rows) {
    const items = byProfile.get(row.profile_revision_id) ?? [];
    items.push({
      profileRevisionId: row.profile_revision_id, workspaceId: row.workspace_id, node: row.node,
      role: row.role, packVersionId: row.pack_version_id, priority: row.priority,
      tokenBudget: row.token_budget, config: row.config_json,
    });
    byProfile.set(row.profile_revision_id, items);
  }
  return byProfile;
}

function profileOf(row: ProfileRow, bindings: ProjectMethodProfileRevision['bindings']): ProjectMethodProfileRevision {
  return {
    id: row.id, workspaceId: row.workspace_id, projectId: row.project_id, revision: row.revision,
    status: row.status, baseRevisionId: row.base_revision_id ?? null, digest: row.digest,
    version: row.version, tokenBudget: row.token_budget, createdBy: row.created_by, createdAt: iso(row.created_at)!,
    adoptedBy: row.adopted_by ?? null, adoptedAt: iso(row.adopted_at), archivedAt: iso(row.archived_at),
    validatedAt: iso(row.validated_at), validationDigest: row.validation_digest ?? null,
    clientRequestId: row.client_request_id, bindings,
  };
}

export class PostgresMethodPackRepository implements MethodPackRepositoryPort {
  private readonly outbox: DataOutbox;

  constructor(private readonly database: PostgresDatabase) {
    this.outbox = new DataOutbox(database);
  }

  private async versionsFor(workspaceId: string, packIds: readonly string[]): Promise<VersionRow[]> {
    const result = await this.database.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM method_pack_versions
       WHERE pack_id = ANY($1::text[]) AND (workspace_id IS NULL OR workspace_id = $2)
       ORDER BY created_at, id`, [packIds, workspaceId],
    );
    return result.rows;
  }

  private async admissionsFor(workspaceId: string, versionIds: readonly string[]): Promise<Map<string, WorkspaceMethodPackAccess>> {
    if (!versionIds.length) return new Map();
    const result = await this.database.query<AdmissionRow>(
      `SELECT ${ADMISSION_COLUMNS} FROM workspace_method_pack_access
       WHERE workspace_id = $1 AND pack_version_id = ANY($2::text[])`, [workspaceId, versionIds],
    );
    return new Map(result.rows.map(row => [row.pack_version_id, admissionOf(row)]));
  }

  async hasBuiltinCatalog(): Promise<boolean> {
    const result = await this.database.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM method_packs WHERE origin = 'builtin' AND archived_at IS NULL) AS present`,
    );
    return Boolean(result.rows[0]?.present);
  }

  async listPacks(workspaceId: string, query: MethodPackListQuery): Promise<MethodCatalogEntry[]> {
    const result = await this.database.query<PackRow>(
      `SELECT ${PACK_COLUMNS} FROM method_packs
       WHERE (workspace_id = $1 OR workspace_id IS NULL) AND archived_at IS NULL
       ORDER BY created_at, id`, [workspaceId],
    );
    const packs = result.rows.map(packOf);
    const versions = await this.versionsFor(workspaceId, packs.map(pack => pack.id));
    const byPack = new Map<string, MethodPackVersion[]>();
    for (const row of versions) {
      const version = versionOf(row);
      const items = byPack.get(version.packId) ?? [];
      items.push(version);
      byPack.set(version.packId, items);
    }
    const admissions = await this.admissionsFor(workspaceId, versions.map(row => row.id));
    const adoptedCounts = new Map<string, number>();
    if (versions.length) {
      const adopted = await this.database.query<{ pack_version_id: string; count: number }>(
        `SELECT b.pack_version_id, count(DISTINCT p.project_id)::int AS count
           FROM project_method_profile_revisions p
           JOIN project_method_bindings b ON b.profile_revision_id = p.id
          WHERE p.workspace_id = $1 AND p.status = 'adopted' AND b.pack_version_id = ANY($2::text[])
          GROUP BY b.pack_version_id`, [workspaceId, versions.map(row => row.id)],
      );
      for (const row of adopted.rows) adoptedCounts.set(row.pack_version_id, Number(row.count));
    }
    const entries: MethodCatalogEntry[] = [];
    for (const pack of packs) {
      const items = byPack.get(pack.id) ?? [];
      const latest = items.at(-1);
      if (query.q && !`${pack.name} ${pack.summary} ${pack.id}`.toLowerCase().includes(query.q.toLowerCase())) continue;
      if (query.node && !items.some(version => version.nodes.includes(query.node!))) continue;
      if (query.license && !items.some(version => version.licenseCode === query.license)) continue;
      if (query.qualityStatus && !items.some(version => version.qualityStatus === query.qualityStatus)) continue;
      const admission = latest ? admissions.get(latest.id) ?? null : null;
      if (query.admissionStatus && (admission?.status ?? 'pending') !== query.admissionStatus) continue;
      if (query.adoptedByProjectId) {
        const bound = latest ? await this.database.query(
          `SELECT 1 FROM project_method_profile_revisions p
           JOIN project_method_bindings b ON b.profile_revision_id = p.id
           WHERE p.workspace_id = $1 AND p.project_id = $2 AND p.status = 'adopted' AND b.pack_version_id = $3
           LIMIT 1`, [workspaceId, query.adoptedByProjectId, latest.id]) : { rowCount: 0 };
        if (!bound.rowCount) continue;
      }
      entries.push({ pack, latestVersion: latest ? summaryOf(latest) : null,
        versions: items.map(summaryOf), admission,
        adoptedProjectCount: latest ? adoptedCounts.get(latest.id) ?? 0 : 0 });
    }
    return entries;
  }

  async getPack(workspaceId: string, packId: string): Promise<MethodCatalogEntry | null> {
    const result = await this.database.query<PackRow>(
      `SELECT ${PACK_COLUMNS} FROM method_packs
       WHERE id = $1 AND (workspace_id = $2 OR workspace_id IS NULL)`, [packId, workspaceId],
    );
    if (!result.rows[0]) return null;
    const pack = packOf(result.rows[0]);
    const versions = (await this.versionsFor(workspaceId, [packId])).map(versionOf);
    const admissions = await this.admissionsFor(workspaceId, versions.map(version => version.id));
    const latest = versions.at(-1);
    const adopted = latest ? await this.database.query<{ count: number }>(
      `SELECT count(DISTINCT p.project_id)::int AS count
         FROM project_method_profile_revisions p
         JOIN project_method_bindings b ON b.profile_revision_id = p.id
        WHERE p.workspace_id = $1 AND p.status = 'adopted' AND b.pack_version_id = $2`,
      [workspaceId, latest.id]) : { rows: [{ count: 0 }] };
    return { pack, latestVersion: latest ? summaryOf(latest) : null,
      versions: versions.map(summaryOf), admission: latest ? admissions.get(latest.id) ?? null : null,
      adoptedProjectCount: Number(adopted.rows[0]?.count ?? 0) };
  }

  async getPackVersions(workspaceId: string, packId: string): Promise<MethodPackVersion[]> {
    return (await this.versionsFor(workspaceId, [packId])).map(versionOf);
  }

  async getVersion(workspaceId: string, versionId: string): Promise<MethodPackVersion | null> {
    const result = await this.database.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM method_pack_versions
       WHERE id = $1 AND (workspace_id IS NULL OR workspace_id = $2)`, [versionId, workspaceId],
    );
    return result.rows[0] ? versionOf(result.rows[0]) : null;
  }

  async getVersions(workspaceId: string, versionIds: readonly string[]): Promise<MethodPackVersion[]> {
    const ids = [...new Set(versionIds)];
    if (!ids.length) return [];
    const result = await this.database.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM method_pack_versions
       WHERE id = ANY($1::text[]) AND (workspace_id IS NULL OR workspace_id = $2)`,
      [ids, workspaceId],
    );
    return result.rows.map(versionOf);
  }

  async getAdmissions(workspaceId: string, versionIds: readonly string[]): Promise<WorkspaceMethodPackAccess[]> {
    return [...(await this.admissionsFor(workspaceId, versionIds)).values()];
  }

  async findImportByClientRequestId(workspaceId: string, clientRequestId: string)
  : Promise<{ pack: MethodPack; version: MethodPackVersion } | null> {
    const pack = await this.database.query<PackRow>(
      `SELECT ${PACK_COLUMNS} FROM method_packs
       WHERE workspace_id = $1 AND client_request_id = $2`, [workspaceId, clientRequestId],
    );
    if (!pack.rows[0]) return null;
    const versions = await this.versionsFor(workspaceId, [pack.rows[0].id]);
    if (!versions[0]) return null;
    return { pack: packOf(pack.rows[0]), version: versionOf(versions[0]) };
  }

  async saveImport(input: SaveMethodPackInput): Promise<{ pack: MethodPack; version: MethodPackVersion }> {
    try {
      return await this.outbox.transaction(async tx => {
        const pack = await tx.client.query<PackRow>(
          `INSERT INTO method_packs (${PACK_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (id) DO NOTHING RETURNING ${PACK_COLUMNS}`,
          [input.pack.id, input.pack.name, input.pack.summary, input.pack.origin, input.pack.workspaceId,
            input.pack.sourceUri, input.pack.sourceRevision, input.pack.createdBy, input.pack.createdAt,
            input.pack.archivedAt, input.clientRequestId],
        );
        const storedPack = pack.rows[0];
        if (!storedPack) throw new MethodPackError(409, METHOD_ERROR_CODES.INVALID_INPUT,
          '方法包标识已存在；重复导入请使用相同 clientRequestId，变更正文请创建新版本。');
        const version = await tx.client.query<VersionRow>(
          `INSERT INTO method_pack_versions (${VERSION_COLUMNS})
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18)
           RETURNING ${VERSION_COLUMNS}`,
          [input.version.id, input.version.packId, input.version.workspaceId, input.version.version,
            input.version.content, input.version.contentRef, input.version.contentDigest,
            JSON.stringify(input.version.manifest), input.version.manifestDigest, input.version.licenseCode,
            input.version.commercialUseAllowed, input.version.qualityStatus, input.version.approvalStatus,
            JSON.stringify(input.version.compatibility), JSON.stringify(input.version.nodes),
            input.version.createdBy, input.version.createdAt, input.version.archivedAt],
        );
        await append(tx.client, input.pack.workspaceId ?? LEGACY_WORKSPACE_ID, input.event);
        return { pack: packOf(storedPack), version: versionOf(version.rows[0]!) };
      });
    } catch (error) {
      const record = error as { code?: string; constraint?: string };
      if (record.code === '23505') {
        if (!input.clientRequestId) throw error;
        const existing = await this.findImportByClientRequestId(input.pack.workspaceId!, input.clientRequestId);
        if (existing) return existing;
      }
      throw error;
    }
  }

  async saveVersion(input: SaveMethodVersionInput): Promise<MethodPackVersion> {
    try {
      return await this.outbox.transaction(async tx => {
        const version = await tx.client.query<VersionRow>(
          `INSERT INTO method_pack_versions (${VERSION_COLUMNS})
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18)
           ON CONFLICT (id) DO NOTHING RETURNING ${VERSION_COLUMNS}`,
          [input.version.id, input.version.packId, input.version.workspaceId, input.version.version,
            input.version.content, input.version.contentRef, input.version.contentDigest,
            JSON.stringify(input.version.manifest), input.version.manifestDigest, input.version.licenseCode,
            input.version.commercialUseAllowed, input.version.qualityStatus, input.version.approvalStatus,
            JSON.stringify(input.version.compatibility), JSON.stringify(input.version.nodes),
            input.version.createdBy, input.version.createdAt, input.version.archivedAt],
        );
        if (!version.rows[0]) {
          const existing = await tx.client.query<VersionRow>(
            `SELECT ${VERSION_COLUMNS} FROM method_pack_versions WHERE id = $1`, [input.version.id],
          );
          if (!existing.rows[0]) throw new MethodPackError(409, METHOD_ERROR_CODES.VERSION_IMMUTABLE, '方法版本写入失败。');
          if (existing.rows[0].content_digest !== input.version.contentDigest) {
            throw new MethodPackError(409, METHOD_ERROR_CODES.VERSION_IMMUTABLE, '已发布方法版本不可原地覆盖。');
          }
          return versionOf(existing.rows[0]);
        }
      if (input.event.aggregateVersion > 1) {
        const next = await nextAggregateVersion(tx.client, 'method_pack', input.version.id);
        input.event.aggregateVersion = next;
      }
        await append(tx.client, input.version.workspaceId ?? LEGACY_WORKSPACE_ID, input.event);
        return versionOf(version.rows[0]);
      });
    } catch (error) {
      const record = error as { code?: string; constraint?: string };
      if (record.code === '23505') {
        const existing = await this.database.query<VersionRow>(
          `SELECT ${VERSION_COLUMNS} FROM method_pack_versions WHERE pack_id = $1 AND version = $2`,
          [input.version.packId, input.version.version],
        );
        if (existing.rows[0] && existing.rows[0].content_digest === input.version.contentDigest) {
          return versionOf(existing.rows[0]);
        }
        throw new MethodPackError(409, METHOD_ERROR_CODES.VERSION_IMMUTABLE, '已发布方法版本不可原地覆盖。');
      }
      throw error;
    }
  }

  async decideAdmission(input: DecideAdmissionInput): Promise<WorkspaceMethodPackAccess> {
    return this.outbox.transaction(async tx => {
      const version = await tx.client.query(`SELECT 1 FROM method_pack_versions WHERE id = $1`, [input.packVersionId]);
      if (!version.rowCount) throw new MethodPackError(404, METHOD_ERROR_CODES.NOT_FOUND, '方法版本不存在。');
      const current = await tx.client.query<AdmissionRow>(
        `SELECT ${ADMISSION_COLUMNS} FROM workspace_method_pack_access
         WHERE workspace_id = $1 AND pack_version_id = $2 FOR UPDATE`, [input.workspaceId, input.packVersionId],
      );
      const existing = current.rows[0] ? admissionOf(current.rows[0]) : null;
      if (existing && input.clientRequestId && existing.clientRequestId === input.clientRequestId
        && existing.status === input.status) return existing;
      if (existing && (input.expectedStatus === null || existing.status !== input.expectedStatus)) {
        throw new MethodPackError(409, METHOD_ERROR_CODES.ADMISSION_TRANSITION_INVALID,
          '准入状态已被其他请求更新，请刷新后重试。');
      }
      if (!existing && input.expectedStatus !== null) {
        throw new MethodPackError(409, METHOD_ERROR_CODES.ADMISSION_TRANSITION_INVALID,
          '准入状态已被其他请求更新，请刷新后重试。');
      }
      const approved = input.status === 'approved';
      const row = await tx.client.query<AdmissionRow>(
        `INSERT INTO workspace_method_pack_access (${ADMISSION_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (workspace_id, pack_version_id) DO UPDATE SET
           status = EXCLUDED.status, approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at,
           rejection_reason = EXCLUDED.rejection_reason, quality_evidence_version = EXCLUDED.quality_evidence_version,
           updated_at = EXCLUDED.updated_at, client_request_id = EXCLUDED.client_request_id
         RETURNING ${ADMISSION_COLUMNS}`,
        [input.workspaceId, input.packVersionId, input.status, approved ? input.actorId : existing?.approvedBy ?? null,
          approved ? input.at : existing?.approvedAt ?? null, approved ? null : input.reason,
          input.qualityEvidenceVersion ?? existing?.qualityEvidenceVersion ?? null, input.at, input.clientRequestId],
      );
      input.event.aggregateVersion = await nextAggregateVersion(tx.client, 'method_pack', input.packVersionId);
      await append(tx.client, input.workspaceId, input.event);
      return admissionOf(row.rows[0]!);
    });
  }

  async projectExists(workspaceId: string, projectId: string): Promise<boolean> {
    const result = await this.database.query(
      `SELECT 1 FROM projects WHERE workspace_id = $1 AND id = $2`, [workspaceId, projectId],
    );
    return Boolean(result.rowCount);
  }

  async listProfiles(workspaceId: string, projectId: string): Promise<ProjectMethodProfileRevision[]> {
    const result = await this.database.query<ProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM project_method_profile_revisions
       WHERE workspace_id = $1 AND project_id = $2 ORDER BY revision DESC`, [workspaceId, projectId],
    );
    if (!result.rows.length) return [];
    const bindingRows = await this.database.query<BindingRow>(
      `SELECT ${BINDING_COLUMNS} FROM project_method_bindings
       WHERE workspace_id = $1 AND profile_revision_id = ANY($2::text[])
       ORDER BY profile_revision_id, node, role, priority, pack_version_id`,
      [workspaceId, result.rows.map(row => row.id)],
    );
    const bindings = bindingsFromRows(bindingRows.rows);
    return result.rows.map(row => profileOf(row, bindings.get(row.id) ?? []));
  }

  async getProfile(workspaceId: string, projectId: string, revisionId: string): Promise<ProjectMethodProfileRevision | null> {
    const result = await this.database.query<ProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM project_method_profile_revisions
       WHERE workspace_id = $1 AND project_id = $2 AND id = $3`, [workspaceId, projectId, revisionId],
    );
    if (!result.rows[0]) return null;
    const bindings = await this.database.query<BindingRow>(
      `SELECT ${BINDING_COLUMNS} FROM project_method_bindings
       WHERE workspace_id = $1 AND profile_revision_id = $2
       ORDER BY node, role, priority, pack_version_id`, [workspaceId, revisionId],
    );
    return profileOf(result.rows[0], bindings.rows.map(row => ({
      profileRevisionId: row.profile_revision_id, workspaceId: row.workspace_id, node: row.node,
      role: row.role, packVersionId: row.pack_version_id, priority: row.priority,
      tokenBudget: row.token_budget, config: row.config_json,
    })));
  }

  async currentAdopted(workspaceId: string, projectId: string): Promise<ProjectMethodProfileRevision | null> {
    const result = await this.database.query<ProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM project_method_profile_revisions
       WHERE workspace_id = $1 AND project_id = $2 AND status = 'adopted'
       ORDER BY revision DESC LIMIT 1`, [workspaceId, projectId],
    );
    if (!result.rows[0]) return null;
    return this.getProfile(workspaceId, projectId, result.rows[0].id);
  }

  private async insertBindings(client: PoolClient, profile: ProjectMethodProfileRevision): Promise<void> {
    for (const binding of profile.bindings) {
      await client.query(
        `INSERT INTO project_method_bindings (${BINDING_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [profile.id, binding.workspaceId, binding.node, binding.role, binding.packVersionId,
          binding.priority, binding.tokenBudget, JSON.stringify(binding.config)],
      );
    }
  }

  async createProfile(input: SaveProfileInput): Promise<ProjectMethodProfileRevision> {
    return this.outbox.transaction(async tx => {
      const profile = await tx.client.query<ProfileRow>(
        `INSERT INTO project_method_profile_revisions (${PROFILE_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING ${PROFILE_COLUMNS}`,
        [input.profile.id, input.profile.workspaceId, input.profile.projectId, input.profile.revision,
          input.profile.status, input.profile.baseRevisionId, input.profile.digest, input.profile.version,
          input.profile.tokenBudget, input.profile.createdBy, input.profile.createdAt, input.profile.adoptedBy,
          input.profile.adoptedAt, input.profile.archivedAt, input.profile.validatedAt,
          input.profile.validationDigest, input.clientRequestId],
      );
      await this.insertBindings(tx.client, input.profile);
      await append(tx.client, input.profile.workspaceId, input.event);
      return profileOf(profile.rows[0]!, input.profile.bindings);
    });
  }

  async replaceProfile(input: ReplaceProfileInput): Promise<ProjectMethodProfileRevision> {
    return this.outbox.transaction(async tx => {
      const existing = await tx.client.query<ProfileRow>(
        `SELECT ${PROFILE_COLUMNS} FROM project_method_profile_revisions
         WHERE id = $1 FOR UPDATE`, [input.profile.id],
      );
      if (!existing.rows[0]) throw new MethodPackError(404, METHOD_ERROR_CODES.NOT_FOUND, '方法配置不存在。');
      if (existing.rows[0].version !== input.expectedVersion) {
        throw new MethodPackError(409, METHOD_ERROR_CODES.PROFILE_STALE, '方法配置已被其他人更新，请刷新后重试。');
      }
      if (existing.rows[0].status !== 'draft') {
        throw new MethodPackError(409, METHOD_ERROR_CODES.PROFILE_NOT_DRAFT, '只有草稿可以修改绑定。');
      }
      await tx.client.query(
        `UPDATE project_method_profile_revisions SET digest = $2, version = $3, base_revision_id = $4,
          token_budget = $5, client_request_id = $6, validated_at = NULL, validation_digest = NULL
         WHERE id = $1`, [input.profile.id, input.profile.digest, input.profile.version,
          input.profile.baseRevisionId, input.profile.tokenBudget, input.clientRequestId],
      );
      await tx.client.query(`DELETE FROM project_method_bindings WHERE profile_revision_id = $1`, [input.profile.id]);
      await this.insertBindings(tx.client, input.profile);
      await append(tx.client, input.profile.workspaceId, input.event);
      return input.profile;
    });
  }

  async recordValidation(profileId: string, expectedVersion: number, digest: string, at: string,
    event: MethodDomainEvent): Promise<ProjectMethodProfileRevision> {
    return this.outbox.transaction(async tx => {
      const updated = await tx.client.query<ProfileRow>(
        `UPDATE project_method_profile_revisions
         SET version = version + 1, validated_at = $2, validation_digest = $3
         WHERE id = $1 AND version = $4 AND status = 'draft'
         RETURNING ${PROFILE_COLUMNS}`, [profileId, at, digest, expectedVersion],
      );
      if (!updated.rows[0]) {
        throw new MethodPackError(409, METHOD_ERROR_CODES.PROFILE_STALE, '方法配置已被更新，请重新校验。');
      }
      event.aggregateVersion = updated.rows[0].version;
      await append(tx.client, updated.rows[0].workspace_id, event);
      const bindings = await tx.client.query<BindingRow>(
        `SELECT ${BINDING_COLUMNS} FROM project_method_bindings WHERE profile_revision_id = $1`, [profileId],
      );
      return profileOf(updated.rows[0], bindings.rows.map(row => ({
        profileRevisionId: row.profile_revision_id, workspaceId: row.workspace_id, node: row.node,
        role: row.role, packVersionId: row.pack_version_id, priority: row.priority,
        tokenBudget: row.token_budget, config: row.config_json,
      })));
    });
  }

  async adoptProfile(input: AdoptProfileInput): Promise<ProjectMethodProfileRevision> {
    return this.outbox.transaction(async tx => {
      const target = await tx.client.query<ProfileRow>(
        `SELECT ${PROFILE_COLUMNS} FROM project_method_profile_revisions WHERE id = $1 FOR UPDATE`, [input.profile.id],
      );
      if (!target.rows[0]) throw new MethodPackError(404, METHOD_ERROR_CODES.NOT_FOUND, '方法配置不存在。');
      if (target.rows[0].version !== input.expectedVersion || target.rows[0].digest !== input.expectedDigest) {
        throw new MethodPackError(409, METHOD_ERROR_CODES.PROFILE_STALE, '方法配置与确认时的版本不一致，请重新确认。');
      }
      if (target.rows[0].status !== 'draft') {
        throw new MethodPackError(409, METHOD_ERROR_CODES.PROFILE_NOT_DRAFT, '只有草稿可以启用。');
      }
      const archived = await tx.client.query<ProfileRow>(
        `UPDATE project_method_profile_revisions
         SET status = 'archived', archived_at = $3, version = version + 1
         WHERE workspace_id = $1 AND project_id = $2 AND status = 'adopted' AND id <> $4
         RETURNING ${PROFILE_COLUMNS}`,
        [target.rows[0].workspace_id, target.rows[0].project_id, input.at, input.profile.id],
      );
      for (const row of archived.rows) {
        const version = row.version;
        await append(tx.client, row.workspace_id, {
          eventType: 'method_profile.revision_archived.v1', aggregateType: 'method_profile',
          aggregateId: row.id, aggregateVersion: version, occurredAt: input.at,
          correlationId: input.events[0]?.correlationId ?? `method-profile:${row.id}`,
          authoritativeRef: { kind: 'method_profile_revision', id: row.id, revisionId: row.id,
            digest: row.digest },
          payload: { profileRevisionId: row.id, reason: input.reason, archivedByReplacement: true },
        });
      }
      const adopted = await tx.client.query<ProfileRow>(
        `UPDATE project_method_profile_revisions
         SET status = 'adopted', adopted_by = $2, adopted_at = $3, version = version + 1,
           archived_at = NULL, client_request_id = $4
         WHERE id = $1 RETURNING ${PROFILE_COLUMNS}`,
        [input.profile.id, input.actorId, input.at, input.clientRequestId],
      );
      const bindings = await tx.client.query<BindingRow>(
        `SELECT ${BINDING_COLUMNS} FROM project_method_bindings WHERE profile_revision_id = $1`, [input.profile.id],
      );
      for (const event of input.events) {
        event.aggregateVersion = adopted.rows[0]!.version;
        await append(tx.client, adopted.rows[0]!.workspace_id, event);
      }
      return profileOf(adopted.rows[0]!, bindings.rows.map(row => ({
        profileRevisionId: row.profile_revision_id, workspaceId: row.workspace_id, node: row.node,
        role: row.role, packVersionId: row.pack_version_id, priority: row.priority,
        tokenBudget: row.token_budget, config: row.config_json,
      })));
    });
  }

  async archiveProfile(workspaceId: string, projectId: string, revisionId: string, expectedVersion: number,
    event: MethodDomainEvent): Promise<ProjectMethodProfileRevision> {
    return this.outbox.transaction(async tx => {
      const updated = await tx.client.query<ProfileRow>(
        `UPDATE project_method_profile_revisions
         SET status = 'archived', archived_at = $4, version = version + 1
         WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND version = $5
         RETURNING ${PROFILE_COLUMNS}`, [workspaceId, projectId, revisionId, event.occurredAt, expectedVersion],
      );
      if (!updated.rows[0]) throw new MethodPackError(409, METHOD_ERROR_CODES.PROFILE_STALE, '方法配置已被更新。');
      event.aggregateVersion = updated.rows[0].version;
      await append(tx.client, workspaceId, event);
      const bindings = await tx.client.query<BindingRow>(
        `SELECT ${BINDING_COLUMNS} FROM project_method_bindings WHERE profile_revision_id = $1`, [revisionId],
      );
      return profileOf(updated.rows[0], bindings.rows.map(row => ({
        profileRevisionId: row.profile_revision_id, workspaceId: row.workspace_id, node: row.node,
        role: row.role, packVersionId: row.pack_version_id, priority: row.priority,
        tokenBudget: row.token_budget, config: row.config_json,
      })));
    });
  }

  async emit(event: MethodDomainEvent, workspaceId: string): Promise<void> {
    await this.outbox.transaction(async tx => {
      event.aggregateVersion = await nextAggregateVersion(tx.client, event.aggregateType, event.aggregateId);
      await append(tx.client, workspaceId, event);
    });
  }
}

/** 用于迁移/启动时确认编译版本与数据库一致。 */
export const POSTGRES_METHOD_COMPILER_VERSION = METHOD_COMPILER_VERSION;
export type { MethodManifestSections };
