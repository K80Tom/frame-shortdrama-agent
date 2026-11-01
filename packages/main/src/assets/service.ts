import { AssetError, createAssetRecord, localAssetUrl, type AssetRecord } from '@lyra/shared';
import type { AssetRepository } from './repository';
import { parseAssetImport, type AssetMedia } from './media';

export class AssetService {
  constructor(private readonly repository: AssetRepository, private readonly mediaReady = true) {}
  list(): Promise<AssetRecord[]> { return this.repository.list(); }
  async create(input: unknown): Promise<AssetRecord> { return this.repository.create(createAssetRecord(input)); }
  private requireMedia() {
    if (!this.mediaReady) throw new AssetError(503, 'ASSET_MEDIA_MIGRATION_REQUIRED', '本地图片导入需先执行 npm run db:migrate（包含 010），然后重启后端。');
  }
  async importImage(input: unknown): Promise<AssetRecord> {
    this.requireMedia();
    const { record, media } = parseAssetImport(input);
    const existing = await this.repository.get(record.id);
    if (existing) return this.existingImport(existing, record, media);
    try { return await this.repository.createWithMedia(record, media); }
    catch (error) {
      if (!(error instanceof AssetError) || error.code !== 'ASSET_ALREADY_EXISTS') throw error;
      const raced = await this.repository.get(record.id);
      if (!raced) throw error;
      return this.existingImport(raced, record, media);
    }
  }
  private async existingImport(existing: AssetRecord, expected: AssetRecord, media: AssetMedia): Promise<AssetRecord> {
    const saved = await this.repository.getMedia(existing.id);
    if (existing.kind !== expected.kind || existing.name !== expected.name || existing.description !== expected.description
      || existing.resourceUrl !== expected.resourceUrl || !saved || saved.sha256 !== media.sha256 || !saved.bytes.equals(media.bytes)) {
      throw new AssetError(409, 'ASSET_IMPORT_CONFLICT', '同一导入标识的保存内容不一致，未覆盖已有记录。');
    }
    return existing;
  }
  async content(id: string): Promise<AssetMedia> {
    this.requireMedia();
    const record = await this.get(id);
    if (record.resourceUrl !== localAssetUrl(record.id)) throw new AssetError(404, 'ASSET_MEDIA_NOT_LOCAL', '此记录是外部素材链接，没有本地图片。');
    const media = await this.repository.getMedia(id);
    if (!media) throw new AssetError(404, 'ASSET_MEDIA_NOT_FOUND', '此资产的本地图片不存在。');
    return media;
  }
  async get(id: string): Promise<AssetRecord> {
    if (typeof id !== 'string' || !/^asset_[a-f0-9]{32}$/u.test(id)) {
      throw new AssetError(400, 'INVALID_ASSET_ID', '资产标识无效。');
    }
    const asset = await this.repository.get(id);
    if (!asset) throw new AssetError(404, 'ASSET_NOT_FOUND', '找不到此资产登记。');
    return asset;
  }
}
