import {
  DRIVER_MANAGED_PREFIX, StorageDriverError, sha256Of, validateContentType, validateDriverKey,
  validateManagedPrefix, type BlobStorageDriver, type DriverListEntry, type DriverPutInput,
  type StoredObject,
} from './driver';

/** 内存驱动：单测与离线冒烟使用，语义与本地/S3 驱动保持一致。 */
export class MemoryBlobStorageDriver implements BlobStorageDriver {
  readonly provider = 'memory';
  readonly managedPrefix = DRIVER_MANAGED_PREFIX;
  private readonly objects = new Map<string, { body: Buffer; contentType: string | null; etag: string; storedAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async put(input: DriverPutInput): Promise<StoredObject> {
    const key = validateDriverKey(input.key);
    if (input.contentType !== undefined) validateContentType(input.contentType);
    const etag = sha256Of(input.body).slice(0, 32);
    this.objects.set(key, {
      body: Buffer.from(input.body), contentType: input.contentType ?? null,
      etag, storedAt: this.now(),
    });
    return { key, size: input.body.length, etag, sha256: sha256Of(input.body), contentType: input.contentType ?? null };
  }

  async head(key: string): Promise<StoredObject | null> {
    validateDriverKey(key);
    const object = this.objects.get(key);
    if (!object) return null;
    return { key, size: object.body.length, etag: object.etag, sha256: sha256Of(object.body), contentType: object.contentType };
  }

  async readRange(key: string, offset: number, length: number): Promise<Buffer> {
    validateDriverKey(key);
    const object = this.objects.get(key);
    if (!object) throw new StorageDriverError('OBJECT_NOT_FOUND', `对象不存在：${key}`);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
      || offset < 0 || length <= 0 || offset + length > object.body.length) {
      throw new StorageDriverError('OBJECT_RANGE_INVALID', '对象读取范围无效。');
    }
    return Buffer.from(object.body.subarray(offset, offset + length));
  }

  async delete(key: string): Promise<void> {
    validateDriverKey(key);
    this.objects.delete(key);
  }

  async list(prefix: string, options?: { limit?: number }): Promise<DriverListEntry[]> {
    const scoped = validateManagedListPrefix(this.managedPrefix, prefix);
    const limit = options?.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new StorageDriverError('OBJECT_LIMIT_INVALID', '列表上限无效。');
    }
    const entries: DriverListEntry[] = [];
    for (const [key, object] of [...this.objects.entries()].sort(([a], [b]) => a.localeCompare(b) || this.objects.get(a)!.storedAt - this.objects.get(b)!.storedAt)) {
      if (!key.startsWith(scoped)) continue;
      entries.push({ key, size: object.body.length, etag: object.etag, sha256: sha256Of(object.body), contentType: object.contentType });
      if (entries.length >= limit) break;
    }
    return entries;
  }
}

function validateManagedListPrefix(managedPrefix: string, prefix: string): string {
  if (typeof prefix !== 'string' || prefix.length === 0) return managedPrefix;
  const normalized = validateManagedPrefix(prefix);
  if (!normalized.startsWith(managedPrefix)) {
    throw new StorageDriverError('OBJECT_KEY_INVALID', '列表前缀必须位于托管命名空间内。');
  }
  return normalized;
}
