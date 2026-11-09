import { createHash } from 'node:crypto';
import {
  DRIVER_MANAGED_PREFIX, StorageDriverError, validateContentType, validateDriverKey,
  validateManagedPrefix, type BlobStorageDriver, type DriverListEntry, type DriverPutInput,
  type StoredObject,
} from './driver';
import { resolveStoragePublicUrl, type ResolvedStorageEndpoint } from './profiles';

/**
 * S3 家族驱动（AWS SDK v3，移植自融光 storage-providers.ts createStorageClient
 * 与 media-blob-store.ts 的 S3 读取语义）：
 * - HeadObject 校验长度后才允许读取；
 * - GetObject 用 Range 请求实现字节区间读取；
 * - 客户端通过最小结构接口注入，单测使用桩客户端，不出网。
 */
export interface AwsS3SendClient {
  send(command: unknown): Promise<unknown>;
}

export interface AwsS3CommandModule {
  PutObjectCommand: new (input: Record<string, unknown>) => unknown;
  HeadObjectCommand: new (input: Record<string, unknown>) => unknown;
  GetObjectCommand: new (input: Record<string, unknown>) => unknown;
  DeleteObjectCommand: new (input: Record<string, unknown>) => unknown;
  ListObjectsV2Command: new (input: Record<string, unknown>) => unknown;
}

export interface S3BlobStorageDriverOptions {
  readonly bucket: string;
  readonly endpoint: ResolvedStorageEndpoint;
  readonly client: AwsS3SendClient;
  readonly commands: AwsS3CommandModule;
  /** 对象基础前缀：驱动托管命名空间会挂在该前缀下。 */
  readonly basePrefix?: string | null;
  readonly customDomain?: string | null;
}

interface S3HeadResult { ContentLength?: number; ETag?: string }
interface S3GetResult { ContentLength?: number; Body?: { transformToByteArray(): Promise<Uint8Array> } | null }
interface S3ListResult { Contents?: Array<{ Key?: string; Size?: number; ETag?: string }>; IsTruncated?: boolean }

export class S3BlobStorageDriver implements BlobStorageDriver {
  readonly provider: string;
  readonly managedPrefix: string;
  private readonly endpoint: ResolvedStorageEndpoint;
  private readonly basePrefix: string;

  constructor(private readonly options: S3BlobStorageDriverOptions) {
    this.provider = options.endpoint.provider;
    this.endpoint = options.endpoint;
    if (typeof options.bucket !== 'string' || options.bucket.trim().length < 2 || options.bucket.length > 128) {
      throw new StorageDriverError('STORAGE_CONFIG_INVALID', '存储 bucket 名称无效。');
    }
    const base = options.basePrefix?.replace(/^\/+|\/+$/g, '') ?? '';
    if (base && (base.includes('..') || /[\n\r\\]/u.test(base))) {
      throw new StorageDriverError('STORAGE_CONFIG_INVALID', '存储对象基础前缀无效。');
    }
    this.basePrefix = base ? `${base}/` : '';
    this.managedPrefix = `${this.basePrefix}${DRIVER_MANAGED_PREFIX}`;
  }

  private physicalKey(key: string): string {
    const validated = validateDriverKey(key);
    return `${this.basePrefix}${validated}`;
  }

  async put(input: DriverPutInput): Promise<StoredObject> {
    const key = validateDriverKey(input.key);
    if (input.contentType !== undefined) validateContentType(input.contentType);
    const sha256 = createHash('sha256').update(input.body).digest('hex');
    const result = await this.send<{ ETag?: string }>(this.options.commands.PutObjectCommand, {
      Bucket: this.options.bucket, Key: this.physicalKey(key), Body: input.body,
      ContentType: input.contentType ?? 'application/octet-stream',
    });
    return { key, size: input.body.length, etag: normalizeEtag(result?.ETag), sha256, contentType: input.contentType ?? null };
  }

  async head(key: string): Promise<StoredObject | null> {
    const validated = validateDriverKey(key);
    try {
      const result = await this.send<S3HeadResult>(this.options.commands.HeadObjectCommand, {
        Bucket: this.options.bucket, Key: this.physicalKey(validated),
      });
      const size = Number(result?.ContentLength);
      if (!Number.isSafeInteger(size) || size < 0) throw new StorageDriverError('OBJECT_SIZE_INVALID', '对象长度无效。');
      return { key: validated, size, etag: normalizeEtag(result?.ETag), sha256: '', contentType: null };
    } catch (error) {
      const cause = error instanceof StorageDriverError ? error.cause : error;
      if (isNotFound(error) || isNotFound(cause)) return null;
      throw error;
    }
  }

  async readRange(key: string, offset: number, length: number): Promise<Buffer> {
    const validated = validateDriverKey(key);
    const head = await this.head(validated);
    if (!head) throw new StorageDriverError('OBJECT_NOT_FOUND', `对象不存在：${validated}`);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
      || offset < 0 || length <= 0 || offset + length > head.size) {
      throw new StorageDriverError('OBJECT_RANGE_INVALID', '对象读取范围无效。');
    }
    const result = await this.send<S3GetResult>(this.options.commands.GetObjectCommand, {
      Bucket: this.options.bucket, Key: this.physicalKey(validated),
      Range: `bytes=${offset}-${offset + length - 1}`,
    });
    if (!result?.Body) throw new StorageDriverError('OBJECT_EMPTY', '对象内容为空。');
    const data = Buffer.from(await result.Body.transformToByteArray());
    if (data.length !== length) throw new StorageDriverError('OBJECT_RANGE_INVALID', '对象读取长度不符。');
    return data;
  }

  async delete(key: string): Promise<void> {
    const validated = validateDriverKey(key);
    await this.send(this.options.commands.DeleteObjectCommand, {
      Bucket: this.options.bucket, Key: this.physicalKey(validated),
    });
  }

  async list(prefix: string, options?: { limit?: number }): Promise<DriverListEntry[]> {
    const scoped = validateManagedPrefix(prefix);
    if (!scoped.startsWith(this.managedPrefix)) {
      throw new StorageDriverError('OBJECT_KEY_INVALID', '列表前缀必须位于托管命名空间内。');
    }
    const limit = options?.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new StorageDriverError('OBJECT_LIMIT_INVALID', '列表上限无效。');
    }
    const out: DriverListEntry[] = [];
    let continuationToken: string | undefined;
    do {
      const result = await this.send<S3ListResult>(this.options.commands.ListObjectsV2Command, {
        Bucket: this.options.bucket, Prefix: `${this.basePrefix}${scoped}`, MaxKeys: Math.min(limit - out.length, 1000),
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      });
      for (const item of result?.Contents ?? []) {
        const key = typeof item.Key === 'string' ? item.Key.slice(this.basePrefix.length) : '';
        if (!key.startsWith(DRIVER_MANAGED_PREFIX)) continue;
        try { validateDriverKey(key); } catch { continue; }
        out.push({
          key, size: Number(item.Size ?? 0), etag: normalizeEtag(item.ETag), sha256: '', contentType: null,
        });
        if (out.length >= limit) return out;
      }
      continuationToken = result?.IsTruncated ? (result as { NextContinuationToken?: string }).NextContinuationToken : undefined;
    } while (continuationToken && out.length < limit);
    return out;
  }

  publicUrl(objectKey: string): string {
    const key = this.physicalKey(validateDriverKey(objectKey));
    return resolveStoragePublicUrl({ resolved: this.endpoint, bucket: this.options.bucket, customDomain: this.options.customDomain, objectKey: key });
  }

  private async send<T>(commandFactory: new (input: Record<string, unknown>) => unknown, input: Record<string, unknown>): Promise<T> {
    try {
      const command = new commandFactory(input);
      return await this.options.client.send(command) as T;
    } catch (error) {
      if (error instanceof StorageDriverError) throw error;
      throw new StorageDriverError('STORAGE_REMOTE_FAILED', '存储请求失败。', error);
    }
  }
}

function normalizeEtag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.replaceAll('"', '');
}

export function isNotFound(error: unknown): boolean {
  const record = error && typeof error === 'object' ? error as { name?: string; Code?: string; code?: string; $metadata?: { httpStatusCode?: number } } : {};
  return record.name === 'NoSuchKey' || record.Code === 'NoSuchKey' || record.code === 'ENOENT'
    || record.$metadata?.httpStatusCode === 404;
}

export interface S3DriverClientConfig {
  readonly bucket: string;
  readonly endpoint: ResolvedStorageEndpoint;
  readonly accessKey?: string | null;
  readonly secretKey?: string | null;
  readonly customDomain?: string | null;
  readonly basePrefix?: string | null;
}

export interface S3DriverDependencies {
  s3Module?: AwsS3CommandModule & { S3Client: new (options: Record<string, unknown>) => AwsS3SendClient };
}

function loadS3Module(): NonNullable<S3DriverDependencies['s3Module']> {
  try { return require('@aws-sdk/client-s3') as NonNullable<S3DriverDependencies['s3Module']>; }
  catch {
    throw new StorageDriverError('STORAGE_DEPENDENCY_MISSING', '缺少 @aws-sdk/client-s3 运行依赖。');
  }
}

/** 由解析后的端点配置创建 S3 驱动；构造期不发请求，部署问题在首次探活暴露。 */
export function createS3BlobStorageDriver(config: S3DriverClientConfig, dependencies: S3DriverDependencies = {}): S3BlobStorageDriver {
  if (Boolean(config.accessKey) !== Boolean(config.secretKey)) {
    throw new StorageDriverError('STORAGE_CONFIG_INVALID', '对象存储 access key 与 secret key 必须成对配置。');
  }
  const module = dependencies.s3Module ?? loadS3Module();
  const client = new module.S3Client({
    region: config.endpoint.signingRegion,
    forcePathStyle: config.endpoint.pathStyleAccessEnabled,
    ...(config.endpoint.endpoint ? { endpoint: config.endpoint.endpoint } : {}),
    ...(config.accessKey && config.secretKey ? { credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey } } : {}),
  });
  return new S3BlobStorageDriver({
    bucket: config.bucket, endpoint: config.endpoint, client, commands: module,
    basePrefix: config.basePrefix, customDomain: config.customDomain,
  });
}
