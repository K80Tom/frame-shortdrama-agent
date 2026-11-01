import type { PostgresDatabase } from '../db/client';
import { createHash } from 'node:crypto';
import { AssetError, localAssetUrl, validateAssetRecord, type AssetRecord } from '@lyra/shared';
import { inspectAssetImage, type AssetMedia } from './media';

export interface AssetRepository {
  list(): Promise<AssetRecord[]>;
  get(id: string): Promise<AssetRecord | null>;
  create(record: AssetRecord): Promise<AssetRecord>;
  createWithMedia(record: AssetRecord, media: AssetMedia): Promise<AssetRecord>;
  getMedia(id: string): Promise<AssetMedia | null>;
}

function validMedia(media: AssetMedia): void {
  if (inspectAssetImage(media.bytes) !== media.mimeType || createHash('sha256').update(media.bytes).digest('hex') !== media.sha256) {
    throw new AssetError(400, 'INVALID_ASSET_IMAGE', '图片内容与保存信息不一致。');
  }
}
function copyMedia(media: AssetMedia): AssetMedia { return { ...media, bytes: Buffer.from(media.bytes) }; }

const clone = <T>(value: T): T => structuredClone(value);
function compare(a: AssetRecord, b: AssetRecord): number {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function conflict(): never {
  throw new AssetError(409, 'ASSET_ALREADY_EXISTS', '资产登记已存在；不会覆盖已有素材记录。');
}
function stored(input: unknown): AssetRecord {
  try { validateAssetRecord(input); return clone(input); }
  catch { throw new AssetError(500, 'ASSET_STORED_DATA_INVALID', '保存的资产记录校验失败；未尝试修复或覆盖。'); }
}

export class InMemoryAssetRepository implements AssetRepository {
  private readonly records = new Map<string, AssetRecord>();
  private readonly media = new Map<string, AssetMedia>();
  async list(): Promise<AssetRecord[]> { return [...this.records.values()].map(stored).sort(compare); }
  async get(id: string): Promise<AssetRecord | null> {
    const record = this.records.get(id);
    return record ? stored(record) : null;
  }
  async create(input: AssetRecord): Promise<AssetRecord> {
    validateAssetRecord(input);
    if (input.resourceUrl === localAssetUrl(input.id)) throw new AssetError(400, 'ASSET_MEDIA_REQUIRED', '本地图片必须通过导入接口保存。');
    if (this.records.has(input.id)) return conflict();
    const record = clone(input);
    this.records.set(record.id, record);
    return clone(record);
  }
  async createWithMedia(record: AssetRecord, media: AssetMedia): Promise<AssetRecord> {
    validateAssetRecord(record); validMedia(media);
    if (record.resourceUrl !== localAssetUrl(record.id)) throw new AssetError(400, 'INVALID_ASSET_IMAGE', '本地图片地址不匹配。');
    if (this.records.has(record.id)) return conflict();
    this.records.set(record.id, clone(record)); this.media.set(record.id, copyMedia(media));
    return clone(record);
  }
  async getMedia(id: string): Promise<AssetMedia | null> {
    const media = this.media.get(id); return media ? copyMedia(media) : null;
  }
}

interface AssetRow {
  id: unknown; kind: unknown; name: unknown; description: unknown; resource_url: unknown; created_at: unknown;
}
function fromRow(row: AssetRow): AssetRecord {
  let createdAt: unknown = row.created_at;
  if (createdAt instanceof Date) {
    if (!Number.isFinite(createdAt.getTime())) {
      throw new AssetError(500, 'ASSET_STORED_DATA_INVALID', '保存的资产记录校验失败；未尝试修复或覆盖。');
    }
    createdAt = createdAt.toISOString();
  }
  return stored({ id: row.id, kind: row.kind, name: row.name, description: row.description, resourceUrl: row.resource_url, createdAt });
}
function databaseError(error: unknown): never {
  if (error instanceof AssetError) throw error;
  if (error && typeof error === 'object' && 'code' in error && error.code === '23505') return conflict();
  // Never expose a query, connection string, URL, or driver error detail.
  throw new AssetError(503, 'ASSET_PERSISTENCE_UNAVAILABLE', '资产目录暂时无法读取或保存，请检查本地数据库及 009、010 迁移。');
}

export class PostgresAssetRepository implements AssetRepository {
  constructor(private readonly database: PostgresDatabase) {}
  async list(): Promise<AssetRecord[]> {
    try {
      const result = await this.database.query<AssetRow>('SELECT id, kind, name, description, resource_url, created_at FROM asset_catalog ORDER BY created_at DESC, id COLLATE "C" ASC');
      return result.rows.map(fromRow);
    } catch (error) { return databaseError(error); }
  }
  async get(id: string): Promise<AssetRecord | null> {
    try {
      const result = await this.database.query<AssetRow>('SELECT id, kind, name, description, resource_url, created_at FROM asset_catalog WHERE id = $1', [id]);
      return result.rows[0] ? fromRow(result.rows[0]) : null;
    } catch (error) { return databaseError(error); }
  }
  async create(input: AssetRecord): Promise<AssetRecord> {
    validateAssetRecord(input);
    if (input.resourceUrl === localAssetUrl(input.id)) throw new AssetError(400, 'ASSET_MEDIA_REQUIRED', '本地图片必须通过导入接口保存。');
    // Own the snapshot before yielding to the database; callers cannot mutate it in flight.
    const record = clone(input);
    try {
      const result = await this.database.query<AssetRow>(
        'INSERT INTO asset_catalog (id, kind, name, description, resource_url, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, kind, name, description, resource_url, created_at',
        [record.id, record.kind, record.name, record.description, record.resourceUrl, record.createdAt],
      );
      if (!result.rows[0]) throw new Error('Asset insert returned no record.');
      return fromRow(result.rows[0]);
    } catch (error) { return databaseError(error); }
  }
  async createWithMedia(input: AssetRecord, inputMedia: AssetMedia): Promise<AssetRecord> {
    validateAssetRecord(input); validMedia(inputMedia);
    if (input.resourceUrl !== localAssetUrl(input.id)) throw new AssetError(400, 'INVALID_ASSET_IMAGE', '本地图片地址不匹配。');
    const record = clone(input); const media = copyMedia(inputMedia);
    try {
      return await this.database.transaction(async client => {
        const result = await client.query<AssetRow>(
          'INSERT INTO asset_catalog (id, kind, name, description, resource_url, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, kind, name, description, resource_url, created_at',
          [record.id, record.kind, record.name, record.description, record.resourceUrl, record.createdAt]);
        await client.query('INSERT INTO asset_media (asset_id, mime_type, sha256, content) VALUES ($1, $2, $3, $4)', [record.id, media.mimeType, media.sha256, media.bytes]);
        if (!result.rows[0]) throw new Error('Asset insert returned no record.');
        return fromRow(result.rows[0]);
      });
    } catch (error) { return databaseError(error); }
  }
  async getMedia(id: string): Promise<AssetMedia | null> {
    try {
      const result = await this.database.query<{ content: Buffer; mime_type: AssetMedia['mimeType']; sha256: string }>(
        'SELECT content, mime_type, sha256 FROM asset_media WHERE asset_id = $1', [id]);
      const row = result.rows[0];
      if (!row) return null;
      const media = { bytes: row.content, mimeType: row.mime_type, sha256: row.sha256 };
      try { validMedia(media); } catch { throw new AssetError(500, 'ASSET_STORED_DATA_INVALID', '保存的本地图片校验失败。'); }
      return copyMedia(media);
    } catch (error) { return databaseError(error); }
  }
}
