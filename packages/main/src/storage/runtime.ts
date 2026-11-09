import { StorageDriverError, type BlobStorageDriver } from './driver';
import { LocalBlobStorageDriver } from './local-driver';
import { MemoryBlobStorageDriver } from './memory-driver';
import { createS3BlobStorageDriver, type S3DriverDependencies } from './s3-driver';
import { normalizeStorageProvider, resolveStorageEndpoint, type StorageDriverProvider } from './profiles';

/**
 * 统一存储驱动运行时装配。
 *
 * 与应用侧 ObjectStorage 端口共享 OBJECT_STORAGE_* 环境变量命名空间，
 * 但通过厂商画像补齐 endpoint 模板、path-style 与 region 默认值，
 * 让 OSS/COS/Qiniu/ZOS 等 S3 家族端点无需额外代码即可接入 Worker 拓扑。
 * provider=memory 仅供测试与离线冒烟，生产配置缺失时启动期即报错。
 */
export type StorageDriverConfig = {
  readonly provider: 'local';
  readonly root: string;
} | {
  readonly provider: 'memory';
} | {
  readonly provider: Exclude<StorageDriverProvider, 'local' | 'memory'>;
  readonly bucket: string;
  readonly region: string | null;
  readonly endpoint: string | null;
  readonly resolved: ReturnType<typeof resolveStorageEndpoint>;
  readonly accessKey: string | null;
  readonly secretKey: string | null;
  readonly basePrefix: string | null;
  readonly customDomain: string | null;
};

export interface StorageDriverRuntimeDependencies extends S3DriverDependencies {
}

export function readStorageDriverConfig(env: NodeJS.ProcessEnv): StorageDriverConfig {
  const rawProvider = env.OBJECT_STORAGE_PROVIDER?.trim() || 'local';
  if (rawProvider === 'memory') return { provider: 'memory' };
  const provider = normalizeStorageProvider(rawProvider);
  if (provider === 'local') {
    return { provider, root: env.OBJECT_STORAGE_LOCAL_ROOT?.trim() || 'outputs/private/object-storage-driver' };
  }
  const bucket = env.OBJECT_STORAGE_BUCKET?.trim();
  if (!bucket) throw new StorageDriverError('STORAGE_CONFIG_INVALID', '非本地存储必须配置 OBJECT_STORAGE_BUCKET。');
  const accessKey = env.OBJECT_STORAGE_ACCESS_KEY?.trim() || null;
  const secretKey = env.OBJECT_STORAGE_SECRET_KEY || null;
  if (Boolean(accessKey) !== Boolean(secretKey)) {
    throw new StorageDriverError('STORAGE_CONFIG_INVALID', '对象存储 access key 与 secret key 必须成对配置。');
  }
  const endpointRaw = env.OBJECT_STORAGE_ENDPOINT?.trim() || null;
  const region = env.OBJECT_STORAGE_REGION?.trim() || null;
  const resolved = resolveStorageEndpoint({ provider, endpoint: endpointRaw, region });
  if (resolved.endpoint && !/^https?:\/\//iu.test(resolved.endpoint)) {
    throw new StorageDriverError('STORAGE_CONFIG_INVALID', '对象存储 endpoint 必须是 http(s) 地址。');
  }
  const basePrefix = env.OBJECT_STORAGE_PREFIX?.trim().replace(/^\/+|\/+$/g, '') || null;
  const customDomain = env.OBJECT_STORAGE_CUSTOM_DOMAIN?.trim() || null;
  return {
    provider, bucket, region, endpoint: resolved.endpoint, resolved,
    accessKey, secretKey, basePrefix, customDomain,
  };
}

export function createStorageDriverFromEnv(env: NodeJS.ProcessEnv,
  dependencies: StorageDriverRuntimeDependencies = {}): BlobStorageDriver {
  return createStorageDriver(readStorageDriverConfig(env), dependencies);
}

export function createStorageDriver(config: StorageDriverConfig,
  dependencies: StorageDriverRuntimeDependencies = {}): BlobStorageDriver {
  switch (config.provider) {
    case 'memory': return new MemoryBlobStorageDriver();
    case 'local': return new LocalBlobStorageDriver(config.root);
    default:
      return createS3BlobStorageDriver({
        bucket: config.bucket,
        endpoint: config.resolved,
        accessKey: config.accessKey,
        secretKey: config.secretKey,
        basePrefix: config.basePrefix,
        customDomain: config.customDomain,
      }, dependencies);
  }
}

export { isStorageDriverProvider } from './profiles';
