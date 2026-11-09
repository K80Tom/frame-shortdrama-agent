import type { TenantContext } from '../../tenancy/context';
import { parseWorkspaceId } from '../../tenancy/context';

export type ObjectStorageScope = Pick<TenantContext, 'workspaceId'>;
export type ObjectStorageProvider = 'local' | 'minio' | 's3' | 'oss' | 'cos';

export class ObjectStorageError extends Error {
  constructor(public readonly code: string, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ObjectStorageError';
  }
}

export interface ObjectDescriptor {
  provider: ObjectStorageProvider;
  bucket: string;
  /** Logical key. Adapters add the workspace prefix and never expose a cross-tenant physical key. */
  key: string;
  /** Actual backend selector (or null), never an internal ObjectVersion ID. */
  versionId: string | null;
  etag: string | null;
  sha256: string;
  size: number;
  contentType: string | null;
}

export interface PutObjectRequest {
  scope: ObjectStorageScope;
  key: string;
  body: Buffer;
  contentType: string;
  /** If supplied, a mismatch is rejected before storage is mutated. */
  expectedSha256?: string;
}

export interface ReadObjectRequest {
  scope: ObjectStorageScope;
  key: string;
  maxBytes: number;
  expectedSha256?: string;
  /** Real provider selector only, NEVER an internal objver_ ID or an ETag. */
  providerVersionId?: string;
}

export interface ObjectReadResult {
  object: ObjectDescriptor;
  body: Buffer;
}

export interface PresignedPutRequest {
  scope: ObjectStorageScope;
  /** Only staging/ keys may be signed for direct client upload. */
  key: string;
  contentType: string;
  expiresInSeconds: number;
  expectedSha256: string;
}

export interface PresignedPut {
  method: 'PUT';
  url: string;
  headers: Readonly<Record<string, string>>;
  expiresAt: string;
}

export interface PresignedGetRequest {
  scope: ObjectStorageScope;
  key: string;
  expiresInSeconds: number;
  expectedSha256?: string;
  providerVersionId?: string;
}

export interface PresignedGet {
  method: 'GET';
  url: string;
  expiresAt: string;
}

/** Bytes only. PostgreSQL remains authoritative for ownership, status and durable metadata. */
export interface ObjectStorage {
  readonly provider: ObjectStorageProvider;
  readonly bucket: string;
  /** Non-destructive readiness check for the configured writable storage boundary. */
  probe(): Promise<void>;
  put(request: PutObjectRequest): Promise<ObjectDescriptor>;
  get(request: ReadObjectRequest): Promise<ObjectReadResult>;
  head(scope: ObjectStorageScope, key: string, options?: {providerVersionId?: string}): Promise<ObjectDescriptor | null>;
  delete(scope: ObjectStorageScope, key: string): Promise<void>;
  createPresignedPut?(request: PresignedPutRequest): Promise<PresignedPut>;
  createPresignedGet?(request: PresignedGetRequest): Promise<PresignedGet>;
}

export function workspaceIdOf(scope: ObjectStorageScope): string {
  return parseWorkspaceId(scope?.workspaceId);
}

export function normalizeObjectKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024 || value.includes('\\')
    || value.startsWith('/') || value.endsWith('/')) {
    throw new ObjectStorageError('OBJECT_KEY_INVALID', '对象键格式无效。');
  }
  const parts = value.split('/');
  if (parts.some(part => !/^[A-Za-z0-9][A-Za-z0-9._=-]{0,127}$/u.test(part) || part === '.' || part === '..')) {
    throw new ObjectStorageError('OBJECT_KEY_INVALID', '对象键格式无效。');
  }
  return parts.join('/');
}

export function validateContentType(value: unknown): string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 255
    || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(value)) {
    throw new ObjectStorageError('OBJECT_CONTENT_TYPE_INVALID', '对象 Content-Type 格式无效。');
  }
  return value;
}

export function validateSha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ObjectStorageError('OBJECT_CHECKSUM_INVALID', '对象 SHA-256 校验值无效。');
  }
  return value;
}

export function validateMaxBytes(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 4 * 1024 * 1024 * 1024) {
    throw new ObjectStorageError('OBJECT_LIMIT_INVALID', '对象读取上限无效。');
  }
  return value as number;
}
export function validateProviderVersionId(value:unknown):string|undefined{
  if(value===undefined)return undefined;
  if(typeof value!=='string'||!value||value.length>512||/[\x00-\x1f\x7f]/u.test(value))
    throw new ObjectStorageError('OBJECT_VERSION_INVALID','供应商对象版本无效。');
  return value;
}
