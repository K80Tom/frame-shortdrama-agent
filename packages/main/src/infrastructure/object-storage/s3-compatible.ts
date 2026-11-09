import { createHash } from 'node:crypto';
import {
  ObjectStorageError, normalizeObjectKey, validateContentType, validateMaxBytes, validateSha256, validateProviderVersionId,
  workspaceIdOf, type ObjectDescriptor, type ObjectStorage, type ObjectStorageProvider,
  type ObjectStorageScope, type ObjectReadResult, type PresignedGet, type PresignedGetRequest,
  type PresignedPut, type PresignedPutRequest,
  type PutObjectRequest, type ReadObjectRequest,
} from './port';

type CloudProvider = Exclude<ObjectStorageProvider, 'local'>;

/** Small facade around the chosen vendor SDK; production wiring supplies the actual client. */
export interface S3CompatibleClient {
  headBucket(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  putObject(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  getObject(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  headObject(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteObject(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface AwsS3SendClient { send(command: unknown): Promise<Record<string, unknown>> }
export interface AwsS3CommandModule {
  HeadBucketCommand: new (input: Record<string, unknown>) => unknown;
  PutObjectCommand: new (input: Record<string, unknown>) => unknown;
  GetObjectCommand: new (input: Record<string, unknown>) => unknown;
  HeadObjectCommand: new (input: Record<string, unknown>) => unknown;
  DeleteObjectCommand: new (input: Record<string, unknown>) => unknown;
}

/** Binds @aws-sdk/client-s3's send/command API without importing it into the offline core. */
export class AwsS3CompatibleClient implements S3CompatibleClient {
  constructor(private readonly client: AwsS3SendClient, private readonly commands: AwsS3CommandModule) {}
  headBucket(input: Record<string, unknown>) { return this.client.send(new this.commands.HeadBucketCommand(input)); }
  putObject(input: Record<string, unknown>) { return this.client.send(new this.commands.PutObjectCommand(input)); }
  getObject(input: Record<string, unknown>) { return this.client.send(new this.commands.GetObjectCommand(input)); }
  headObject(input: Record<string, unknown>) { return this.client.send(new this.commands.HeadObjectCommand(input)); }
  deleteObject(input: Record<string, unknown>) { return this.client.send(new this.commands.DeleteObjectCommand(input)); }
}

export type S3CompatiblePresigner = (input: Record<string, unknown>, expiresInSeconds: number) => Promise<string>;

/**
 * S3-protocol adapter. OSS/COS remain explicit provider choices because their
 * endpoint, addressing and signing compatibility must be verified per environment.
 */
export class S3CompatibleObjectStorage implements ObjectStorage {
  readonly provider: CloudProvider;
  readonly bucket: string;
  private readonly prefix: string;
  private readonly presignPut: S3CompatiblePresigner | undefined;
  private readonly presignGet: S3CompatiblePresigner | undefined;
  private readonly now: () => Date;

  constructor(private readonly client: S3CompatibleClient, options: {
    provider: CloudProvider;
    bucket: string;
    prefix?: string;
    presignPut?: S3CompatiblePresigner;
    presignGet?: S3CompatiblePresigner;
    now?: () => Date;
  }) {
    if (!['minio', 's3', 'oss', 'cos'].includes(options.provider)) {
      throw new ObjectStorageError('OBJECT_STORAGE_CONFIG_INVALID', '对象存储 provider 无效。');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u.test(options.bucket)) {
      throw new ObjectStorageError('OBJECT_STORAGE_CONFIG_INVALID', '对象存储 bucket 无效。');
    }
    this.provider = options.provider;
    this.bucket = options.bucket;
    this.prefix = options.prefix ? `${normalizeObjectKey(options.prefix)}/` : '';
    this.presignPut = options.presignPut;
    this.presignGet = options.presignGet;
    this.now = options.now ?? (() => new Date());
  }

  async probe(): Promise<void> {
    try { await this.client.headBucket({ Bucket: this.bucket }); }
    catch (error) {
      throw new ObjectStorageError('OBJECT_STORAGE_UNAVAILABLE', '对象存储 bucket 不可用或无权访问。', error);
    }
  }

  async put(request: PutObjectRequest): Promise<ObjectDescriptor> {
    if (!Buffer.isBuffer(request.body) || !request.body.length) {
      throw new ObjectStorageError('OBJECT_BODY_INVALID', '对象内容不能为空。');
    }
    const key = normalizeObjectKey(request.key);
    const contentType = validateContentType(request.contentType);
    const body = Buffer.from(request.body);
    const sha256 = createHash('sha256').update(body).digest('hex');
    if (request.expectedSha256 && validateSha256(request.expectedSha256) !== sha256) {
      throw new ObjectStorageError('OBJECT_CHECKSUM_MISMATCH', '对象内容与预期 SHA-256 不一致。');
    }
    const workspaceId = workspaceIdOf(request.scope);
    const physicalKey = this.physicalKey(workspaceId, key);
    const existing = await this.head(request.scope, key);
    if (existing) {
      if (existing.sha256 !== sha256 || existing.size !== body.length) {
        throw new ObjectStorageError('OBJECT_ALREADY_EXISTS', '同一对象键已存在不同内容，未覆盖。');
      }
      return { ...existing, contentType };
    }
    let response: Record<string, unknown>;
    try {
      response = await this.client.putObject({ Bucket: this.bucket, Key: physicalKey, Body: body,
        IfNoneMatch: '*',
        ContentType: contentType, ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
        Metadata: { sha256, workspace_id: workspaceId } });
    } catch (error) {
      if (isPreconditionFailed(error)) {
        const raced = await this.head(request.scope, key);
        if (raced?.sha256 === sha256 && raced.size === body.length) return { ...raced, contentType };
        throw new ObjectStorageError('OBJECT_ALREADY_EXISTS', '同一对象键已存在不同内容，未覆盖。');
      }
      throw new ObjectStorageError('OBJECT_STORAGE_UNAVAILABLE', '对象暂时无法写入。', error);
    }
    const descriptor = await this.head(request.scope, key);
    if (!descriptor || descriptor.sha256 !== sha256 || descriptor.size !== body.length) {
      throw new ObjectStorageError('OBJECT_WRITE_UNVERIFIED', '对象写入后校验失败，未登记为可用。');
    }
    return { ...descriptor, versionId: stringOrNull(response.VersionId) ?? descriptor.versionId,
      etag: cleanEtag(response.ETag) ?? descriptor.etag, contentType };
  }

  async get(request: ReadObjectRequest): Promise<ObjectReadResult> {
    const maxBytes = validateMaxBytes(request.maxBytes);
    const key = normalizeObjectKey(request.key);
    const workspaceId = workspaceIdOf(request.scope);
    const providerVersionId=validateProviderVersionId(request.providerVersionId);
    let response: Record<string, unknown>;
    try { response = await this.client.getObject({ Bucket: this.bucket, Key: this.physicalKey(workspaceId, key),...(providerVersionId?{VersionId:providerVersionId}:{}) }); }
    catch (error) { throw mapCloudError(error, '读取'); }
    if(providerVersionId!==undefined&&stringOrNull(response.VersionId)!==providerVersionId)
      throw new ObjectStorageError('OBJECT_VERSION_MISMATCH','存储未返回指定的供应商版本。');
    const declaredSize = contentLength(response.ContentLength, maxBytes);
    const body = await objectBody(response.Body, maxBytes);
    if (declaredSize !== null && body.length !== declaredSize) {
      throw new ObjectStorageError('OBJECT_SIZE_INVALID', '对象内容长度与存储元数据不一致。');
    }
    const sha256 = createHash('sha256').update(body).digest('hex');
    const metadataSha = metadataValue(response.Metadata, 'sha256');
    if ((metadataSha && metadataSha !== sha256)
      || (request.expectedSha256 && validateSha256(request.expectedSha256) !== sha256)) {
      throw new ObjectStorageError('OBJECT_CHECKSUM_MISMATCH', '对象内容与 SHA-256 元数据不一致。');
    }
    return { body, object: { provider: this.provider, bucket: this.bucket, key,
      versionId: stringOrNull(response.VersionId), etag: cleanEtag(response.ETag), sha256,
      size: body.length, contentType: stringOrNull(response.ContentType) } };
  }

  async head(scope: ObjectStorageScope, keyValue: string, options?:{providerVersionId?:string}): Promise<ObjectDescriptor | null> {
    const key = normalizeObjectKey(keyValue);
    const workspaceId = workspaceIdOf(scope);
    const providerVersionId=validateProviderVersionId(options?.providerVersionId);
    let response: Record<string, unknown>;
    try { response = await this.client.headObject({ Bucket: this.bucket, Key: this.physicalKey(workspaceId, key),...(providerVersionId?{VersionId:providerVersionId}:{}) }); }
    catch (error) {
      if (isNotFound(error)) return null;
      throw mapCloudError(error, '查询');
    }
    if(providerVersionId!==undefined&&stringOrNull(response.VersionId)!==providerVersionId)
      throw new ObjectStorageError('OBJECT_VERSION_MISMATCH','存储未返回指定的供应商版本。');
    const sha256 = metadataValue(response.Metadata, 'sha256');
    const size = Number(response.ContentLength);
    if (!sha256 || !/^[a-f0-9]{64}$/u.test(sha256) || !Number.isSafeInteger(size) || size < 1) {
      throw new ObjectStorageError('OBJECT_METADATA_INVALID', '对象缺少可信 SHA-256 或大小元数据。');
    }
    return { provider: this.provider, bucket: this.bucket, key,
      versionId: stringOrNull(response.VersionId), etag: cleanEtag(response.ETag), sha256, size,
      contentType: stringOrNull(response.ContentType) };
  }

  async delete(scope: ObjectStorageScope, keyValue: string): Promise<void> {
    const key = normalizeObjectKey(keyValue);
    const workspaceId = workspaceIdOf(scope);
    try { await this.client.deleteObject({ Bucket: this.bucket, Key: this.physicalKey(workspaceId, key) }); }
    catch (error) { throw mapCloudError(error, '删除'); }
  }

  async createPresignedPut(request: PresignedPutRequest): Promise<PresignedPut> {
    if (!this.presignPut) throw new ObjectStorageError('OBJECT_SIGNING_UNAVAILABLE', '当前对象存储未配置直传签名。');
    const key = normalizeObjectKey(request.key);
    if (!key.startsWith('staging/')) {
      throw new ObjectStorageError('OBJECT_STAGING_REQUIRED', '客户端直传只能写入 staging 对象键。');
    }
    if (!Number.isSafeInteger(request.expiresInSeconds) || request.expiresInSeconds < 30
      || request.expiresInSeconds > 900) {
      throw new ObjectStorageError('OBJECT_EXPIRY_INVALID', '直传签名有效期必须为 30–900 秒。');
    }
    const contentType = validateContentType(request.contentType);
    const sha256 = validateSha256(request.expectedSha256);
    const workspaceId = workspaceIdOf(request.scope);
    const headers = { 'content-type': contentType, 'if-none-match': '*', 'x-amz-meta-sha256': sha256,
      'x-amz-meta-workspace_id': workspaceId };
    const url = await this.presignPut({ Bucket: this.bucket, Key: this.physicalKey(workspaceId, key),
      ContentType: contentType, IfNoneMatch: '*', Metadata: { sha256, workspace_id: workspaceId } },
    request.expiresInSeconds);
    return { method: 'PUT', url, headers,
      expiresAt: new Date(this.now().getTime() + request.expiresInSeconds * 1000).toISOString() };
  }

  async createPresignedGet(request: PresignedGetRequest): Promise<PresignedGet> {
    if (!this.presignGet) throw new ObjectStorageError('OBJECT_SIGNING_UNAVAILABLE', '当前对象存储未配置下载签名。');
    const key = normalizeObjectKey(request.key);
    if (!Number.isSafeInteger(request.expiresInSeconds) || request.expiresInSeconds < 30
      || request.expiresInSeconds > 900) {
      throw new ObjectStorageError('OBJECT_EXPIRY_INVALID', '下载签名有效期必须为 30–900 秒。');
    }
    const providerVersionId=validateProviderVersionId(request.providerVersionId);
    const descriptor = await this.head(request.scope, key,{providerVersionId});
    if (!descriptor) throw new ObjectStorageError('OBJECT_NOT_FOUND', '对象不存在。');
    if (request.expectedSha256 && validateSha256(request.expectedSha256) !== descriptor.sha256) {
      throw new ObjectStorageError('OBJECT_CHECKSUM_MISMATCH', '对象与登记的 SHA-256 不一致。');
    }
    const workspaceId = workspaceIdOf(request.scope);
    const url = await this.presignGet({ Bucket: this.bucket, Key: this.physicalKey(workspaceId, key),...(providerVersionId?{VersionId:providerVersionId}:{}) },
      request.expiresInSeconds);
    return { method: 'GET', url,
      expiresAt: new Date(this.now().getTime() + request.expiresInSeconds * 1000).toISOString() };
  }

  private physicalKey(workspaceId: string, logicalKey: string): string {
    return `${this.prefix}workspaces/${workspaceId}/${logicalKey}`;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null;
}
function cleanEtag(value: unknown): string | null {
  const text = stringOrNull(value); return text ? text.replace(/^"|"$/gu, '') : null;
}
function metadataValue(value: unknown, name: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key.toLowerCase() === name && typeof raw === 'string') return raw;
  }
  return null;
}
function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as Record<string, unknown>;
  return value.name === 'NotFound' || value.name === 'NoSuchVersion' || value.Code === 'NoSuchKey' || value.Code === 'NoSuchVersion' || Boolean(value.$metadata
    && typeof value.$metadata === 'object'
    && (value.$metadata as Record<string, unknown>).httpStatusCode === 404);
}
function isPreconditionFailed(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as Record<string, unknown>;
  return value.name === 'PreconditionFailed' || value.Code === 'PreconditionFailed' || Boolean(value.$metadata
    && typeof value.$metadata === 'object'
    && (value.$metadata as Record<string, unknown>).httpStatusCode === 412);
}
function mapCloudError(error: unknown, action: string): ObjectStorageError {
  return isNotFound(error) ? new ObjectStorageError('OBJECT_NOT_FOUND', '对象不存在。')
    : new ObjectStorageError('OBJECT_STORAGE_UNAVAILABLE', `对象暂时无法${action}。`, error);
}

async function objectBody(value: unknown, maxBytes: number): Promise<Buffer> {
  if (Buffer.isBuffer(value)) return bounded(Buffer.from(value), maxBytes);
  if (value instanceof Uint8Array) return bounded(Buffer.from(value), maxBytes);
  // AWS SDK response streams also expose transformToByteArray(), but that helper
  // buffers the whole object before callers can enforce a limit. Prefer the
  // async iterator so a dishonest/missing ContentLength cannot exhaust memory.
  if (value && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = []; let total = 0;
    for await (const chunk of value as AsyncIterable<unknown>) {
      if (!(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) {
        throw new ObjectStorageError('OBJECT_BODY_INVALID', '对象存储返回了无法识别的数据流。');
      }
      const bytes = Buffer.from(chunk); total += bytes.length;
      if (total > maxBytes) throw new ObjectStorageError('OBJECT_SIZE_INVALID', '对象超过读取上限。');
      chunks.push(bytes);
    }
    return bounded(Buffer.concat(chunks), maxBytes);
  }
  if (value && typeof value === 'object'
    && typeof (value as { transformToByteArray?: unknown }).transformToByteArray === 'function') {
    const bytes = await (value as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    return bounded(Buffer.from(bytes), maxBytes);
  }
  throw new ObjectStorageError('OBJECT_BODY_INVALID', '对象存储返回了无法识别的内容。');
}
function contentLength(value: unknown, maxBytes: number): number | null {
  if (value === undefined || value === null) return null;
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes) {
    throw new ObjectStorageError('OBJECT_SIZE_INVALID', '对象为空、大小元数据无效或超过读取上限。');
  }
  return size;
}
function bounded(body: Buffer, maxBytes: number): Buffer {
  if (!body.length || body.length > maxBytes) throw new ObjectStorageError('OBJECT_SIZE_INVALID', '对象为空或超过读取上限。');
  return body;
}
