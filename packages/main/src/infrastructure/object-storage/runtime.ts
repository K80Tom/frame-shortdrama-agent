import { resolve } from 'node:path';
import { LocalObjectStorage } from './local';
import { ObjectStorageError, type ObjectStorage, type ObjectStorageProvider } from './port';
import {
  AwsS3CompatibleClient, S3CompatibleObjectStorage,
  type AwsS3CommandModule, type AwsS3SendClient,
} from './s3-compatible';

interface S3RuntimeModule extends AwsS3CommandModule {
  S3Client: new (options: Record<string, unknown>) => AwsS3SendClient;
}
interface S3PresignerModule {
  getSignedUrl(client: AwsS3SendClient, command: unknown,
    options: { expiresIn: number }): Promise<string>;
}

export type ObjectStorageConfig = {
  provider: 'local'; root: string; bucket: string;
} | {
  provider: Exclude<ObjectStorageProvider, 'local'>;
  endpoint?: string;
  region: string;
  bucket: string;
  prefix?: string;
  forcePathStyle: boolean;
  accessKey?: string;
  secretKey?: string;
};

export interface ObjectStorageRuntimeDependencies {
  s3Module?: S3RuntimeModule;
  presignerModule?: S3PresignerModule;
}

export function readObjectStorageConfig(env: NodeJS.ProcessEnv): ObjectStorageConfig {
  const provider = (env.OBJECT_STORAGE_PROVIDER?.trim().toLowerCase() || 'local') as ObjectStorageProvider;
  if (!['local', 'minio', 's3', 'oss', 'cos'].includes(provider)) {
    throw new ObjectStorageError('OBJECT_STORAGE_CONFIG_INVALID', 'OBJECT_STORAGE_PROVIDER 无效。');
  }
  const bucket = env.OBJECT_STORAGE_BUCKET?.trim() || (provider === 'local' ? 'local' : '');
  if (provider === 'local') {
    return { provider, bucket, root: resolve(env.OBJECT_STORAGE_LOCAL_ROOT?.trim()
      || 'outputs/private/object-storage') };
  }
  if (!bucket) throw new ObjectStorageError('OBJECT_STORAGE_CONFIG_INVALID', '对象存储缺少 bucket。');
  const accessKey = env.OBJECT_STORAGE_ACCESS_KEY?.trim();
  const secretKey = env.OBJECT_STORAGE_SECRET_KEY;
  if (Boolean(accessKey) !== Boolean(secretKey)) {
    throw new ObjectStorageError('OBJECT_STORAGE_CONFIG_INVALID', '对象存储 access key 与 secret key 必须成对配置。');
  }
  const endpoint = env.OBJECT_STORAGE_ENDPOINT?.trim();
  if (provider !== 's3' && !endpoint) {
    throw new ObjectStorageError('OBJECT_STORAGE_CONFIG_INVALID', `${provider} 对象存储缺少 endpoint。`);
  }
  if (endpoint) validateEndpoint(endpoint, provider);
  const forcePathStyle = booleanValue(env.OBJECT_STORAGE_FORCE_PATH_STYLE,
    provider === 'minio', 'OBJECT_STORAGE_FORCE_PATH_STYLE');
  const prefix = env.OBJECT_STORAGE_PREFIX?.trim();
  return { provider, ...(endpoint ? { endpoint } : {}), region: env.OBJECT_STORAGE_REGION?.trim() || 'us-east-1',
    bucket, ...(prefix ? { prefix } : {}), forcePathStyle,
    ...(accessKey && secretKey ? { accessKey, secretKey } : {}) };
}

/** Creates a local rollback store or a lazy network client; it performs no request itself. */
export function createObjectStorageFromEnv(env: NodeJS.ProcessEnv,
  dependencies: ObjectStorageRuntimeDependencies = {}): ObjectStorage {
  const config = readObjectStorageConfig(env);
  if (config.provider === 'local') return new LocalObjectStorage(config.root, { bucket: config.bucket });
  const s3 = dependencies.s3Module ?? loadS3Module();
  const presigner = dependencies.presignerModule ?? loadPresignerModule();
  const clientOptions: Record<string, unknown> = {
    region: config.region, forcePathStyle: config.forcePathStyle,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.accessKey && config.secretKey ? { credentials: {
      accessKeyId: config.accessKey, secretAccessKey: config.secretKey,
    } } : {}),
  };
  const client = new s3.S3Client(clientOptions);
  return new S3CompatibleObjectStorage(new AwsS3CompatibleClient(client, s3), {
    provider: config.provider, bucket: config.bucket, prefix: config.prefix,
    presignPut: (input, expiresIn) => presigner.getSignedUrl(client, new s3.PutObjectCommand(input), { expiresIn }),
    presignGet: (input, expiresIn) => presigner.getSignedUrl(client, new s3.GetObjectCommand(input), { expiresIn }),
  });
}

function validateEndpoint(value: string, provider: Exclude<ObjectStorageProvider, 'local'>): void {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.pathname !== '/') throw new Error('invalid');
    if (url.protocol === 'http:' && provider !== 'minio') throw new Error('insecure');
  } catch {
    throw new ObjectStorageError('OBJECT_STORAGE_CONFIG_INVALID',
      '对象存储 endpoint 必须是不含凭据、查询或路径的地址；HTTP 仅允许 MinIO。');
  }
}

function booleanValue(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (!raw?.trim()) return fallback;
  if (/^(?:1|true)$/iu.test(raw.trim())) return true;
  if (/^(?:0|false)$/iu.test(raw.trim())) return false;
  throw new ObjectStorageError('OBJECT_STORAGE_CONFIG_INVALID', `${name} 必须为 true 或 false。`);
}

function loadS3Module(): S3RuntimeModule {
  try { return require('@aws-sdk/client-s3') as S3RuntimeModule; }
  catch { throw new ObjectStorageError('OBJECT_STORAGE_DEPENDENCY_MISSING', '缺少 @aws-sdk/client-s3 运行依赖。'); }
}
function loadPresignerModule(): S3PresignerModule {
  try { return require('@aws-sdk/s3-request-presigner') as S3PresignerModule; }
  catch { throw new ObjectStorageError('OBJECT_STORAGE_DEPENDENCY_MISSING',
    '缺少 @aws-sdk/s3-request-presigner 运行依赖。'); }
}
