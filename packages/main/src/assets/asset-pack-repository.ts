import type { PoolClient, QueryResultRow } from 'pg';
import {
  AssetError,
  assetPackContentDigest,
  parseAssetPackVersion,
  type AssetPackAdoption,
  type AssetPackMediaEntry,
  type AssetPackVersion,
} from '@lyra/shared';
import type { PostgresDatabase } from '../db/client';

export interface AssetPackRepository {
  create(version: AssetPackVersion): Promise<AssetPackVersion>;
  get(workspaceId: string, versionId: string): Promise<AssetPackVersion | null>;
  listByLogical(workspaceId: string, logicalAssetId: string): Promise<AssetPackVersion[]>;
  latestAdopted(workspaceId: string, logicalAssetId: string): Promise<AssetPackVersion | null>;
  adopt(adoption: AssetPackAdoption): Promise<AssetPackAdoption>;
  listAdoptions(workspaceId: string, logicalAssetId: string): Promise<AssetPackAdoption[]>;
}

const clone = <T>(value: T): T => structuredClone(value);
const key = (workspaceId: string, versionId: string) => `${workspaceId}\0${versionId}`;
const adoptionKey = (workspaceId: string, adoptionId: string) => `${workspaceId}\0${adoptionId}`;

function parse(version: unknown): AssetPackVersion {
  try {
    return clone(parseAssetPackVersion(version));
  } catch (error) {
    if (error instanceof AssetError) throw error;
    throw new AssetError(400, 'INVALID_ASSET_PACK', '资产包版本无效。');
  }
}

function adoptionValid(adoption: AssetPackAdoption): void {
  if (!/^ws_[a-f0-9]{32}$/u.test(adoption.workspaceId)
    || !/^apa_[a-f0-9]{32}$/u.test(adoption.adoptionId)
    || !/^apv_[a-f0-9]{32}$/u.test(adoption.versionId)
    || !/^[A-Za-z][A-Za-z0-9_.:-]{2,159}$/u.test(adoption.logicalAssetId)
    || !/^usr_[A-Za-z0-9]{4,}$/u.test(adoption.adoptedBy)
    || !adoption.reason.trim() || adoption.reason.length > 1000
    || !Number.isFinite(Date.parse(adoption.createdAt))
    || new Date(adoption.createdAt).toISOString() !== adoption.createdAt) {
    throw new AssetError(400, 'INVALID_ASSET_PACK_ADOPTION', '资产包采用记录无效。');
  }
}

export class InMemoryAssetPackRepository implements AssetPackRepository {
  private readonly versions = new Map<string, AssetPackVersion>();
  private readonly adoptions = new Map<string, AssetPackAdoption>();

  async create(version: AssetPackVersion): Promise<AssetPackVersion> {
    const parsed = parse(version);
    const existing = this.versions.get(key(parsed.workspaceId, parsed.id));
    if (existing) {
      if (existing.contentDigest === parsed.contentDigest) return clone(existing);
      throw new AssetError(409, 'ASSET_PACK_VERSION_EXISTS', '该资产包版本已存在且内容不同；不会覆写不可变版本。');
    }
    const slot = [...this.versions.values()].find(item => item.workspaceId === parsed.workspaceId
      && item.logicalAssetId === parsed.logicalAssetId && item.version === parsed.version);
    if (slot) throw new AssetError(409, 'ASSET_PACK_VERSION_EXISTS', '同一逻辑资产的版本号已被占用。');
    this.versions.set(key(parsed.workspaceId, parsed.id), clone(parsed));
    return clone(parsed);
  }

  async get(workspaceId: string, versionId: string): Promise<AssetPackVersion | null> {
    const version = this.versions.get(key(workspaceId, versionId));
    return version ? clone(version) : null;
  }

  async listByLogical(workspaceId: string, logicalAssetId: string): Promise<AssetPackVersion[]> {
    return [...this.versions.values()].filter(item => item.workspaceId === workspaceId
      && item.logicalAssetId === logicalAssetId).sort((a, b) => b.version - a.version).map(clone);
  }

  async latestAdopted(workspaceId: string, logicalAssetId: string): Promise<AssetPackVersion | null> {
    const latest = [...this.adoptions.values()].filter(item => item.workspaceId === workspaceId
      && item.logicalAssetId === logicalAssetId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).at(0);
    return latest ? this.get(latest.workspaceId, latest.versionId) : null;
  }

  async adopt(adoption: AssetPackAdoption): Promise<AssetPackAdoption> {
    adoptionValid(adoption);
    const version = await this.get(adoption.workspaceId, adoption.versionId);
    if (!version || version.logicalAssetId !== adoption.logicalAssetId) {
      throw new AssetError(409, 'ASSET_PACK_VERSION_UNKNOWN', '采用目标不存在或逻辑资产身份不匹配。');
    }
    if (version.status !== 'adopted' && version.status !== 'superseded') {
      throw new AssetError(409, 'ASSET_PACK_NOT_ADOPTABLE', '只有 adopted 或 superseded 版本可被采用。');
    }
    const duplicate = [...this.adoptions.values()].find(item => item.workspaceId === adoption.workspaceId
      && item.logicalAssetId === adoption.logicalAssetId && item.versionId === adoption.versionId);
    if (duplicate) return clone(duplicate);
    this.adoptions.set(adoptionKey(adoption.workspaceId, adoption.adoptionId), clone(adoption));
    return clone(adoption);
  }

  async listAdoptions(workspaceId: string, logicalAssetId: string): Promise<AssetPackAdoption[]> {
    return [...this.adoptions.values()].filter(item => item.workspaceId === workspaceId
      && item.logicalAssetId === logicalAssetId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone);
  }
}

interface VersionRow extends QueryResultRow {
  workspace_id: string; version_id: string; logical_asset_id: string; kind: string; version: number;
  parent_version_id: string | null; status: string; project_scope: string; project_id: string | null;
  display_name: string; aliases: unknown; description: string; tags: unknown; source_type: string;
  source_refs: unknown; license: string | null; authorization_status: string; authorization_reason: string | null;
  review_status: string; reviewed_by: string | null; reviewed_at: unknown; valid_from: unknown; valid_until: unknown;
  allowed_usages: unknown; restricted_projects: unknown; content_digest: string; schema_version: string;
  created_by: string; created_at: unknown;
}
interface MediaRow extends QueryResultRow {
  version_id: string; media_id: string; role: string; view: string | null; state: string | null; object_id: string;
  object_version_id: string; checksum: string; size_bytes: string | number; content_type: string;
  crop_json: unknown; quality_status: string; provenance_json: unknown;
}
interface AdoptionRow extends QueryResultRow {
  adoption_id: string; logical_asset_id: string; version_id: string; adopted_by: string; reason: string; created_at: unknown;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new AssetError(500, 'ASSET_PACK_STORED_DATA_INVALID', '保存的资产包时间无效。');
  return parsed.toISOString();
}
function jsonArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') as string[] : [];
}
function jsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function mediaOf(row: MediaRow): AssetPackMediaEntry {
  return {
    mediaId: row.media_id, role: row.role as AssetPackMediaEntry['role'],
    view: row.view as AssetPackMediaEntry['view'], state: row.state,
    objectId: row.object_id, objectVersionId: row.object_version_id, checksum: row.checksum,
    sizeBytes: Number(row.size_bytes), contentType: row.content_type,
    crop: jsonObject(row.crop_json) as AssetPackMediaEntry['crop'],
    qualityStatus: row.quality_status as AssetPackMediaEntry['qualityStatus'],
    provenance: jsonObject(row.provenance_json) as unknown as AssetPackMediaEntry['provenance'],
  };
}
function versionOf(row: VersionRow, media: MediaRow[]): AssetPackVersion {
  return parse({
    schemaVersion: row.schema_version, id: row.version_id, workspaceId: row.workspace_id,
    projectScope: row.project_scope, projectId: row.project_id, kind: row.kind,
    logicalAssetId: row.logical_asset_id, version: row.version, parentVersionId: row.parent_version_id,
    displayName: row.display_name, aliases: jsonArray(row.aliases), description: row.description,
    tags: jsonArray(row.tags), sourceType: row.source_type, sourceRefs: jsonArray(row.source_refs),
    license: row.license, authorizationStatus: row.authorization_status,
    authorizationReason: row.authorization_reason, reviewStatus: row.review_status,
    reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at === null ? null : iso(row.reviewed_at),
    validFrom: iso(row.valid_from), validUntil: row.valid_until === null ? null : iso(row.valid_until),
    allowedUsages: jsonArray(row.allowed_usages), restrictedProjects: jsonArray(row.restricted_projects),
    mediaEntries: media.map(mediaOf), contentDigest: row.content_digest, status: row.status,
    createdBy: row.created_by, createdAt: iso(row.created_at),
  });
}
function adoptionOf(row: AdoptionRow, workspaceId: string): AssetPackAdoption {
  return { workspaceId, adoptionId: row.adoption_id, logicalAssetId: row.logical_asset_id,
    versionId: row.version_id, adoptedBy: row.adopted_by, reason: row.reason, createdAt: iso(row.created_at) };
}
function databaseError(error: unknown): never {
  if (error instanceof AssetError) throw error;
  if (error && typeof error === 'object' && 'code' in error) {
    if (error.code === '23505') throw new AssetError(409, 'ASSET_PACK_VERSION_EXISTS', '资产包版本或采用记录已存在。');
    if (error.code === '23514') throw new AssetError(409, 'ASSET_PACK_IMMUTABLE', '资产包版本不可变或违反授权/审核约束。');
    if (error.code === '23503') throw new AssetError(409, 'ASSET_PACK_REFERENCE_INVALID', '资产包引用的租户、用户或父版本不存在。');
  }
  throw new AssetError(503, 'ASSET_PACK_PERSISTENCE_UNAVAILABLE', '资产包暂时无法读取或保存，请检查 030、050 迁移。');
}

export class PostgresAssetPackRepository implements AssetPackRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async create(version: AssetPackVersion): Promise<AssetPackVersion> {
    const parsed = parse(version);
    if (parsed.contentDigest !== assetPackContentDigest(parsed)) {
      throw new AssetError(400, 'INVALID_ASSET_PACK', '资产包内容摘要不匹配。');
    }
    try {
      return await this.db.transaction(async client => {
        const inserted = await client.query<VersionRow>(
          `INSERT INTO asset_pack_versions (workspace_id,version_id,logical_asset_id,kind,version,parent_version_id,status,
             project_scope,project_id,display_name,aliases,description,tags,source_type,source_refs,license,
             authorization_status,authorization_reason,review_status,reviewed_by,reviewed_at,valid_from,valid_until,
             allowed_usages,restricted_projects,content_digest,schema_version,created_by,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14,$15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23,
             $24::jsonb,$25::jsonb,$26,$27,$28,$29)
           RETURNING *`,
          [parsed.workspaceId, parsed.id, parsed.logicalAssetId, parsed.kind, parsed.version, parsed.parentVersionId,
            parsed.status, parsed.projectScope, parsed.projectId, parsed.displayName, JSON.stringify(parsed.aliases),
            parsed.description, JSON.stringify(parsed.tags), parsed.sourceType, JSON.stringify(parsed.sourceRefs),
            parsed.license, parsed.authorizationStatus, parsed.authorizationReason, parsed.reviewStatus,
            parsed.reviewedBy, parsed.reviewedAt, parsed.validFrom, parsed.validUntil, JSON.stringify(parsed.allowedUsages),
            JSON.stringify(parsed.restrictedProjects), parsed.contentDigest, parsed.schemaVersion, parsed.createdBy, parsed.createdAt]);
        for (const item of parsed.mediaEntries) await this.insertMedia(client, parsed.workspaceId, parsed.id, item);
        return versionOf(inserted.rows[0]!, await this.media(client, parsed.workspaceId, parsed.id));
      });
    } catch (error) {
      if (error instanceof AssetError && error.code === 'ASSET_PACK_VERSION_EXISTS') {
        const existing = await this.get(parsed.workspaceId, parsed.id);
        if (existing && existing.contentDigest === parsed.contentDigest) return existing;
      }
      return databaseError(error);
    }
  }

  private async insertMedia(client: PoolClient, workspaceId: string, versionId: string, item: AssetPackMediaEntry): Promise<void> {
    await client.query(
      `INSERT INTO asset_pack_media (workspace_id,version_id,media_id,role,view,state,object_id,object_version_id,
         checksum,size_bytes,content_type,crop_json,quality_status,provenance_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb)`,
      [workspaceId, versionId, item.mediaId, item.role, item.view, item.state, item.objectId, item.objectVersionId,
        item.checksum, item.sizeBytes, item.contentType, item.crop === null ? null : JSON.stringify(item.crop),
        item.qualityStatus, JSON.stringify(item.provenance)]);
  }

  private async media(client: PoolClient, workspaceId: string, versionId: string): Promise<MediaRow[]> {
    const result = await client.query<MediaRow>(
      `SELECT * FROM asset_pack_media WHERE workspace_id=$1 AND version_id=$2 ORDER BY media_id`, [workspaceId, versionId]);
    return result.rows;
  }

  async get(workspaceId: string, versionId: string): Promise<AssetPackVersion | null> {
    try {
      const version = await this.db.query<VersionRow>(
        'SELECT * FROM asset_pack_versions WHERE workspace_id=$1 AND version_id=$2', [workspaceId, versionId]);
      if (!version.rows[0]) return null;
      const media = await this.db.query<MediaRow>(
        'SELECT * FROM asset_pack_media WHERE workspace_id=$1 AND version_id=$2 ORDER BY media_id', [workspaceId, versionId]);
      return versionOf(version.rows[0], media.rows);
    } catch (error) { return databaseError(error); }
  }

  async listByLogical(workspaceId: string, logicalAssetId: string): Promise<AssetPackVersion[]> {
    try {
      const versions = await this.db.query<VersionRow>(
        'SELECT * FROM asset_pack_versions WHERE workspace_id=$1 AND logical_asset_id=$2 ORDER BY version DESC',
        [workspaceId, logicalAssetId]);
      if (!versions.rows.length) return [];
      const media = await this.db.query<MediaRow>(
        'SELECT * FROM asset_pack_media WHERE workspace_id=$1 AND version_id = ANY($2::text[]) ORDER BY media_id',
        [workspaceId, versions.rows.map(row => row.version_id)]);
      return versions.rows.map(row => versionOf(row, media.rows.filter(item => item.version_id === row.version_id)));
    } catch (error) { return databaseError(error); }
  }

  async latestAdopted(workspaceId: string, logicalAssetId: string): Promise<AssetPackVersion | null> {
    try {
      const adoption = await this.db.query<AdoptionRow>(
        `SELECT * FROM asset_pack_adoptions WHERE workspace_id=$1 AND logical_asset_id=$2
         ORDER BY created_at DESC, adoption_id DESC LIMIT 1`, [workspaceId, logicalAssetId]);
      if (!adoption.rows[0]) return null;
      return await this.get(workspaceId, adoption.rows[0].version_id);
    } catch (error) { return databaseError(error); }
  }

  async adopt(adoption: AssetPackAdoption): Promise<AssetPackAdoption> {
    adoptionValid(adoption);
    try {
      await this.db.query(
        `INSERT INTO asset_pack_adoptions (workspace_id,adoption_id,logical_asset_id,version_id,adopted_by,reason,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [adoption.workspaceId, adoption.adoptionId, adoption.logicalAssetId, adoption.versionId,
          adoption.adoptedBy, adoption.reason, adoption.createdAt]);
      return clone(adoption);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        const existing = await this.listAdoptions(adoption.workspaceId, adoption.logicalAssetId);
        const match = existing.find(item => item.versionId === adoption.versionId);
        if (match) return match;
      }
      return databaseError(error);
    }
  }

  async listAdoptions(workspaceId: string, logicalAssetId: string): Promise<AssetPackAdoption[]> {
    try {
      const result = await this.db.query<AdoptionRow>(
        `SELECT * FROM asset_pack_adoptions WHERE workspace_id=$1 AND logical_asset_id=$2
         ORDER BY created_at DESC, adoption_id DESC`, [workspaceId, logicalAssetId]);
      return result.rows.map(row => adoptionOf(row, workspaceId));
    } catch (error) { return databaseError(error); }
  }
}
