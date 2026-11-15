import { createHash, randomUUID } from 'node:crypto';
import { canonicalDigest } from './production';

export type AssetKind = 'character' | 'location' | 'prop';
export interface AssetInput {
  kind: AssetKind;
  name: string;
  description: string;
  resourceUrl: string;
}
/** Immutable external registration or a server-owned, locally imported raster. */
export interface AssetRecord extends AssetInput {
  id: string;
  createdAt: string;
}

export function localAssetUrl(id: string): string { return `/api/assets/${id}/content`; }
export function isLocalAssetUrl(url: string): boolean { return /^\/api\/assets\/asset_[a-f0-9]{32}\/content$/u.test(url); }

export class AssetError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AssetError';
  }
}

const INPUT_KEYS = ['kind', 'name', 'description', 'resourceUrl'];
const RECORD_KEYS = [...INPUT_KEYS, 'id', 'createdAt'];

function objectWithKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every(key => keys.includes(key))
    && keys.every(key => Object.hasOwn(value, key));
}
function invalid(): never {
  throw new AssetError(400, 'INVALID_ASSET_INPUT', '资产信息无效：请填写类型、名称、说明和不含账号密码的 HTTPS 素材地址。');
}
function trimmed(value: unknown, max: number, required: boolean): string {
  if (typeof value !== 'string') return invalid();
  const text = value.trim();
  const points = Array.from(text);
  // JSON can contain lone UTF-16 surrogates. UTF-8 / PostgreSQL would replace
  // them, changing an immutable registration between validation and readback.
  const malformedUnicode = points.some(point => {
    const code = point.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff;
  });
  if ((required && !text) || points.length > max || text.includes('\0') || malformedUnicode) return invalid();
  return text;
}

export function parseAssetMetadata(input: Record<string, unknown>): Pick<AssetInput, 'kind' | 'name' | 'description'> {
  const kind = trimmed(input.kind, 20, true);
  if (kind !== 'character' && kind !== 'location' && kind !== 'prop') return invalid();
  return { kind, name: trimmed(input.name, 200, true), description: trimmed(input.description, 2000, false) };
}

/** Trim all strings; preserve the trimmed URL exactly (including signed queries). */
export function parseAssetInput(input: unknown): AssetInput {
  if (!objectWithKeys(input, INPUT_KEYS)) return invalid();
  const { kind, name, description } = parseAssetMetadata(input);
  const resourceUrl = trimmed(input.resourceUrl, 2000, true);
  let url: URL;
  try { url = new URL(resourceUrl); } catch { return invalid(); }
  // Reject parser repairs (backslash, control/space, omitted //) and any userinfo,
  // including an empty userinfo marker. This address is never fetched here.
  const authority = /^https:\/\/([^/?#]+)/iu.exec(resourceUrl)?.[1];
  if (!authority || authority.includes('@') || /[\s\u0000-\u001f\u007f\\]/u.test(resourceUrl)
    || url.protocol !== 'https:' || !url.hostname || url.username || url.password) return invalid();
  return { kind, name, description, resourceUrl };
}

export function createAssetRecord(input: unknown): AssetRecord {
  return { ...parseAssetInput(input), id: `asset_${randomUUID().replaceAll('-', '')}`, createdAt: new Date().toISOString() };
}

/**
 * 剧本解析产生的元数据实体：尚无图片素材，resourceUrl 为空，后续可上传本地图片。
 * 确定性 ID 让同名同类型实体在并发写入时复用，而不是重复创建或覆盖既有设定。
 */
export function createMetadataAssetRecord(input: unknown): AssetRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const { kind, name, description } = parseAssetMetadata(input as Record<string, unknown>);
  const normalizedName = name.replace(/\s+/g, '').toLowerCase();
  const id = `asset_${createHash('sha256').update(`${kind}\0${normalizedName}`).digest('hex').slice(0, 32)}`;
  return { kind, name, description, resourceUrl: '', id, createdAt: new Date().toISOString() };
}

/** Repository boundary validation; callers cannot smuggle fields through TS casts. */
export function validateAssetRecord(input: unknown): asserts input is AssetRecord {
  if (!objectWithKeys(input, RECORD_KEYS) || typeof input.id !== 'string' || !/^asset_[a-f0-9]{32}$/u.test(input.id)
    || typeof input.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input.createdAt)
    || !Number.isFinite(Date.parse(input.createdAt)) || new Date(input.createdAt).toISOString() !== input.createdAt) return invalid();
  const parsed = input.resourceUrl === '' || input.resourceUrl === localAssetUrl(input.id)
    ? { ...parseAssetMetadata(input), resourceUrl: input.resourceUrl }
    : parseAssetInput({ kind: input.kind, name: input.name, description: input.description, resourceUrl: input.resourceUrl });
  if (INPUT_KEYS.some(key => parsed[key as keyof AssetInput] !== input[key])) return invalid();
}

/** Versioned, immutable asset pack contracts. Legacy AssetRecord remains readable. */
export const ASSET_PACK_SCHEMA_VERSION = 'lyra.asset-pack/1' as const;
export const ASSET_PACK_STATUSES = ['draft', 'reviewing', 'adopted', 'superseded', 'revoked'] as const;
export type AssetPackStatus = typeof ASSET_PACK_STATUSES[number];
export const ASSET_AUTHORIZATION_STATUSES = ['unknown', 'allowed', 'expired', 'revoked', 'not_reviewed', 'usage_mismatch', 'project_mismatch'] as const;
export type AssetAuthorizationStatus = typeof ASSET_AUTHORIZATION_STATUSES[number];
export const ASSET_AUTHORIZATION_ERROR_CODES: Record<Exclude<AssetAuthorizationStatus, 'allowed'>, string> = {
  unknown: 'ASSET_AUTHORIZATION_UNKNOWN',
  expired: 'ASSET_AUTHORIZATION_EXPIRED',
  revoked: 'ASSET_AUTHORIZATION_REVOKED',
  not_reviewed: 'ASSET_AUTHORIZATION_NOT_REVIEWED',
  usage_mismatch: 'ASSET_AUTHORIZATION_USAGE_MISMATCH',
  project_mismatch: 'ASSET_AUTHORIZATION_PROJECT_MISMATCH',
};
export const ASSET_VIEWS = ['front', 'side_left', 'side_right', 'back', 'profile', 'full_body', 'medium', 'close_up'] as const;
export type AssetView = typeof ASSET_VIEWS[number];
export const ASSET_PACK_MEDIA_ROLES = ['reference', 'view', 'expression', 'costume', 'state', 'scene_layer', 'prop_state'] as const;
export type AssetPackMediaRole = typeof ASSET_PACK_MEDIA_ROLES[number];
export const ASSET_PACK_QUALITY_STATUSES = ['pending', 'pass', 'fail', 'quarantined'] as const;
export type AssetPackQualityStatus = typeof ASSET_PACK_QUALITY_STATUSES[number];
export const ASSET_REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type AssetReviewStatus = typeof ASSET_REVIEW_STATUSES[number];

export interface AssetPackCrop { x: number; y: number; width: number; height: number }
export interface AssetPackProvenance {
  source: 'generated' | 'imported' | 'external';
  provider: string | null;
  sourceRef: string | null;
}
export interface AssetPackMediaEntry {
  mediaId: string;
  role: AssetPackMediaRole;
  view: AssetView | null;
  state: string | null;
  objectId: string;
  objectVersionId: string;
  checksum: string;
  sizeBytes: number;
  contentType: string;
  crop: AssetPackCrop | null;
  qualityStatus: AssetPackQualityStatus;
  provenance: AssetPackProvenance;
}
export interface AssetPackVersion {
  schemaVersion: typeof ASSET_PACK_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  projectScope: 'workspace' | 'project';
  projectId: string | null;
  kind: AssetKind;
  logicalAssetId: string;
  version: number;
  parentVersionId: string | null;
  displayName: string;
  aliases: string[];
  description: string;
  tags: string[];
  sourceType: 'generated' | 'imported' | 'external';
  sourceRefs: string[];
  license: string | null;
  authorizationStatus: AssetAuthorizationStatus;
  authorizationReason: string | null;
  reviewStatus: AssetReviewStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  validFrom: string;
  validUntil: string | null;
  allowedUsages: string[];
  restrictedProjects: string[];
  mediaEntries: AssetPackMediaEntry[];
  contentDigest: string;
  status: AssetPackStatus;
  createdBy: string;
  createdAt: string;
}
export interface AssetPackRequirementGap {
  code: 'ASSET_PACK_MEDIA_MISSING' | 'ASSET_PACK_REVIEW_REQUIRED' | 'ASSET_PACK_AUTHORIZATION_DENIED';
  field: 'media' | 'review' | 'authorization';
  detail: string;
  requiredView: AssetView | null;
  requiredState: string | null;
}

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{2,159}$/u;
const WORKSPACE_ID = /^ws_[a-f0-9]{32}$/u;
const PACK_ID = /^apv_[a-f0-9]{32}$/u;
const MEDIA_ID = /^apm_[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PACK_KEYS = [
  'schemaVersion', 'id', 'workspaceId', 'projectScope', 'projectId', 'kind', 'logicalAssetId',
  'version', 'parentVersionId', 'displayName', 'aliases', 'description', 'tags', 'sourceType',
  'sourceRefs', 'license', 'authorizationStatus', 'authorizationReason', 'reviewStatus',
  'reviewedBy', 'reviewedAt', 'validFrom', 'validUntil', 'allowedUsages', 'restrictedProjects',
  'mediaEntries', 'contentDigest', 'status', 'createdBy', 'createdAt',
] as const;
const MEDIA_KEYS = ['mediaId', 'role', 'view', 'state', 'objectId', 'objectVersionId', 'checksum',
  'sizeBytes', 'contentType', 'crop', 'qualityStatus', 'provenance'] as const;
const PROVENANCE_KEYS = ['source', 'provider', 'sourceRef'] as const;
const CROP_KEYS = ['x', 'y', 'width', 'height'] as const;

function packInvalid(): never {
  throw new AssetError(400, 'INVALID_ASSET_PACK', '资产包版本无效：请检查版本、媒资对象引用、授权与审核字段。');
}
function packObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every(key => keys.includes(key))
    && keys.every(key => Object.hasOwn(value, key));
}
function packString(value: unknown, max: number, required = true): string {
  if (typeof value !== 'string') return packInvalid();
  const text = value.trim();
  if ((required && !text) || Array.from(text).length > max || text.includes('\0')) return packInvalid();
  return text;
}
function packNullableString(value: unknown, max: number): string | null {
  return value === null ? null : packString(value, max, false);
}
function packIso(value: unknown): string {
  if (typeof value !== 'string' || !ISO.test(value) || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) return packInvalid();
  return value;
}
function packArray(value: unknown, maxItems: number, itemMax: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) return packInvalid();
  return [...new Set(value.map(item => packString(item, itemMax, false)))]
    .filter(Boolean);
}
function packCrop(value: unknown): AssetPackCrop | null {
  if (value === null) return null;
  if (!packObject(value, CROP_KEYS)) return packInvalid();
  const numbers = CROP_KEYS.map(key => value[key]);
  if (numbers.some(number => typeof number !== 'number' || !Number.isFinite(number) || number < 0)) return packInvalid();
  const crop = value as unknown as AssetPackCrop;
  if (crop.width === 0 || crop.height === 0) return packInvalid();
  return crop;
}
function packMedia(value: unknown): AssetPackMediaEntry {
  if (!packObject(value, MEDIA_KEYS)) return packInvalid();
  if (typeof value.mediaId !== 'string' || !MEDIA_ID.test(value.mediaId)) return packInvalid();
  if (!ASSET_PACK_MEDIA_ROLES.includes(value.role as AssetPackMediaRole)) return packInvalid();
  if (value.view !== null && !ASSET_VIEWS.includes(value.view as AssetView)) return packInvalid();
  if (!ASSET_PACK_QUALITY_STATUSES.includes(value.qualityStatus as AssetPackQualityStatus)) return packInvalid();
  if (typeof value.objectId !== 'string' || !SAFE_ID.test(value.objectId)) return packInvalid();
  if (typeof value.objectVersionId !== 'string' || !/^objver_[a-f0-9]{32}$/u.test(value.objectVersionId)) return packInvalid();
  if (typeof value.checksum !== 'string' || !SHA256.test(value.checksum)) return packInvalid();
  if (typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0) return packInvalid();
  if (typeof value.contentType !== 'string' || !/^image\/(?:png|jpeg|webp)$/u.test(value.contentType)) return packInvalid();
  if (!packObject(value.provenance, PROVENANCE_KEYS)) return packInvalid();
  if (!['generated', 'imported', 'external'].includes(value.provenance.source as string)) return packInvalid();
  return {
    mediaId: value.mediaId,
    role: value.role as AssetPackMediaRole,
    view: value.view as AssetView | null,
    state: packNullableString(value.state, 120),
    objectId: value.objectId,
    objectVersionId: value.objectVersionId,
    checksum: value.checksum,
    sizeBytes: value.sizeBytes,
    contentType: value.contentType,
    crop: packCrop(value.crop),
    qualityStatus: value.qualityStatus as AssetPackQualityStatus,
    provenance: {
      source: value.provenance.source as AssetPackProvenance['source'],
      provider: packNullableString(value.provenance.provider, 120),
      sourceRef: packNullableString(value.provenance.sourceRef, 2000),
    },
  };
}
function packContent(version: Omit<AssetPackVersion, 'contentDigest'>): unknown {
  return {
    schemaVersion: version.schemaVersion, workspaceId: version.workspaceId,
    projectScope: version.projectScope, projectId: version.projectId, kind: version.kind,
    logicalAssetId: version.logicalAssetId, version: version.version,
    parentVersionId: version.parentVersionId, displayName: version.displayName,
    aliases: version.aliases, description: version.description, tags: version.tags,
    sourceType: version.sourceType, sourceRefs: version.sourceRefs, license: version.license,
    authorizationStatus: version.authorizationStatus, authorizationReason: version.authorizationReason,
    reviewStatus: version.reviewStatus, reviewedBy: version.reviewedBy, reviewedAt: version.reviewedAt,
    validFrom: version.validFrom, validUntil: version.validUntil,
    allowedUsages: version.allowedUsages, restrictedProjects: version.restrictedProjects,
    // Media order is presentation detail, not content identity. Canonicalize by
    // media id so PostgreSQL round-trips cannot invalidate a legitimate digest.
    mediaEntries: [...version.mediaEntries].sort((left, right) => left.mediaId.localeCompare(right.mediaId)),
  };
}
export function assetPackContentDigest(version: Omit<AssetPackVersion, 'contentDigest'>): string {
  return canonicalDigest(packContent(version));
}

export function parseAssetPackVersion(input: unknown): AssetPackVersion {
  if (!packObject(input, PACK_KEYS)) return packInvalid();
  if (input.schemaVersion !== ASSET_PACK_SCHEMA_VERSION) return packInvalid();
  if (typeof input.id !== 'string' || !PACK_ID.test(input.id)) return packInvalid();
  if (typeof input.workspaceId !== 'string' || !WORKSPACE_ID.test(input.workspaceId)) return packInvalid();
  if (input.projectScope !== 'workspace' && input.projectScope !== 'project') return packInvalid();
  if (input.projectScope === 'project' && (typeof input.projectId !== 'string' || !SAFE_ID.test(input.projectId))) return packInvalid();
  if (input.projectScope === 'workspace' && input.projectId !== null) return packInvalid();
  if (!['character', 'location', 'prop'].includes(input.kind as string)) return packInvalid();
  if (typeof input.logicalAssetId !== 'string' || !SAFE_ID.test(input.logicalAssetId)) return packInvalid();
  if (typeof input.version !== 'number' || !Number.isSafeInteger(input.version) || input.version < 1) return packInvalid();
  if (input.parentVersionId !== null && (typeof input.parentVersionId !== 'string' || !PACK_ID.test(input.parentVersionId))) return packInvalid();
  if (input.parentVersionId === input.id) return packInvalid();
  if (!ASSET_PACK_STATUSES.includes(input.status as AssetPackStatus)) return packInvalid();
  if (!ASSET_AUTHORIZATION_STATUSES.includes(input.authorizationStatus as AssetAuthorizationStatus)) return packInvalid();
  if (!ASSET_REVIEW_STATUSES.includes(input.reviewStatus as AssetReviewStatus)) return packInvalid();
  if (typeof input.contentDigest !== 'string' || !SHA256.test(input.contentDigest)) return packInvalid();
  if (typeof input.createdBy !== 'string' || !SAFE_ID.test(input.createdBy)) return packInvalid();
  const validFrom = packIso(input.validFrom);
  const validUntil = input.validUntil === null ? null : packIso(input.validUntil);
  if (validUntil !== null && Date.parse(validUntil) <= Date.parse(validFrom)) return packInvalid();
  if (input.reviewStatus === 'approved' && (!input.reviewedBy || !input.reviewedAt)) return packInvalid();
  if (input.status === 'adopted' && (input.reviewStatus !== 'approved' || input.authorizationStatus !== 'allowed')) return packInvalid();
  const media = Array.isArray(input.mediaEntries) ? input.mediaEntries.map(packMedia) : packInvalid();
  const slots = new Set(media.map(item => `${item.role}\0${item.view ?? ''}\0${item.state ?? ''}`));
  if (slots.size !== media.length) return packInvalid();
  if (new Set(media.map(item => item.mediaId)).size !== media.length) return packInvalid();
  const parsed: AssetPackVersion = {
    schemaVersion: ASSET_PACK_SCHEMA_VERSION,
    id: input.id, workspaceId: input.workspaceId,
    projectScope: input.projectScope, projectId: input.projectId as string | null,
    kind: input.kind as AssetKind, logicalAssetId: input.logicalAssetId, version: input.version,
    parentVersionId: input.parentVersionId as string | null,
    displayName: packString(input.displayName, 200), aliases: packArray(input.aliases, 20, 200),
    description: packString(input.description, 4000, false), tags: packArray(input.tags, 40, 80),
    sourceType: input.sourceType as AssetPackVersion['sourceType'],
    sourceRefs: packArray(input.sourceRefs, 40, 2000),
    license: packNullableString(input.license, 200),
    authorizationStatus: input.authorizationStatus as AssetAuthorizationStatus,
    authorizationReason: packNullableString(input.authorizationReason, 500),
    reviewStatus: input.reviewStatus as AssetReviewStatus,
    reviewedBy: packNullableString(input.reviewedBy, 160), reviewedAt: input.reviewedAt === null ? null : packIso(input.reviewedAt),
    validFrom, validUntil, allowedUsages: packArray(input.allowedUsages, 20, 120),
    restrictedProjects: packArray(input.restrictedProjects, 40, 160),
    mediaEntries: media, contentDigest: input.contentDigest, status: input.status as AssetPackStatus,
    createdBy: input.createdBy, createdAt: packIso(input.createdAt),
  };
  if (!['generated', 'imported', 'external'].includes(parsed.sourceType)) return packInvalid();
  if (assetPackContentDigest({ ...parsed, contentDigest: undefined } as never) !== parsed.contentDigest) return packInvalid();
  return parsed;
}

/** Append-only adoption evidence; the latest adopted version is selected by created_at. */
export interface AssetPackAdoption {
  workspaceId: string;
  adoptionId: string;
  logicalAssetId: string;
  versionId: string;
  adoptedBy: string;
  reason: string;
  createdAt: string;
}
