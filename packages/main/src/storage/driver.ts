import { createHash } from 'node:crypto';

/**
 * 统一存储驱动接口（移植自融光 storage-providers.ts + media-blob-store.ts）。
 *
 * 与 infrastructure/object-storage 的 ObjectStorage 端口互补：该端口服务
 * 业务对象（staging/验真/授权引用）；本驱动是 Worker 拓扑使用的底层
 * 字节驱动，统一 S3（AWS SDK v3）与本地文件实现，并补充:
 * - 字节区间读取（readRange），供探测/抽帧等按需读取；
 * - 前缀列表（list），供 GC 类 Worker 任务扫描；
 * - 全部 key 被限制在驱动托管的 managedPrefix 内，避免误触业务对象。
 */
export class StorageDriverError extends Error {
  constructor(public readonly code: string, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'StorageDriverError';
  }
}

export interface StoredObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string | null;
  readonly sha256: string;
  readonly contentType: string | null;
}

export interface DriverPutInput {
  readonly key: string;
  readonly body: Buffer;
  readonly contentType?: string;
}

export interface DriverListEntry extends StoredObject {}

export interface BlobStorageDriver {
  readonly provider: string;
  /** 驱动托管命名空间：所有 key 必须位于该前缀之下。 */
  readonly managedPrefix: string;
  put(input: DriverPutInput): Promise<StoredObject>;
  head(key: string): Promise<StoredObject | null>;
  readRange(key: string, offset: number, length: number): Promise<Buffer>;
  delete(key: string): Promise<void>;
  list(prefix: string, options?: { limit?: number }): Promise<DriverListEntry[]>;
}

export const DRIVER_MANAGED_PREFIX = '.lyra-driver/';

/** 托管 key：只允许受控前缀内的安全路径段，阻断路径穿越与绝对路径。 */
export function validateDriverKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024) {
    throw new StorageDriverError('OBJECT_KEY_INVALID', '对象键格式无效。');
  }
  if (value.includes('\\') || value.startsWith('/') || value.endsWith('/')
    || value.includes('//') || value.includes('\0')) {
    throw new StorageDriverError('OBJECT_KEY_INVALID', '对象键格式无效。');
  }
  if (!value.startsWith(DRIVER_MANAGED_PREFIX)) {
    throw new StorageDriverError('OBJECT_KEY_INVALID', `对象键必须位于 ${DRIVER_MANAGED_PREFIX} 托管前缀内。`);
  }
  const relative = value.slice(DRIVER_MANAGED_PREFIX.length);
  if (relative.length > 0) {
    const parts = relative.split('/');
    if (parts.some(part => part === '.' || part === '..'
      || !/^[A-Za-z0-9][A-Za-z0-9._=-]{0,127}$/u.test(part))) {
      throw new StorageDriverError('OBJECT_KEY_INVALID', '对象键格式无效。');
    }
  }
  return value;
}

export function validateManagedPrefix(value: unknown): string {
  const prefix = validateDriverKey(typeof value === 'string' && value.endsWith('/')
    ? value.slice(0, -1) : value);
  return `${prefix}/`;
}

export function validateRange(offset: number, length: number, size: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
    || offset < 0 || length <= 0 || offset + length > size) {
    throw new StorageDriverError('OBJECT_RANGE_INVALID', '对象读取范围无效。');
  }
}

export function sha256Of(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

export function validateContentType(value: unknown): string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 255
    || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(value)) {
    throw new StorageDriverError('OBJECT_CONTENT_TYPE_INVALID', '对象 Content-Type 格式无效。');
  }
  return value;
}
