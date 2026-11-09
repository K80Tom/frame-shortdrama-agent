import { StorageDriverError } from './driver';

/**
 * 统一存储驱动 · 厂商画像（移植自融光 storage-providers.ts 的 STORAGE_PROFILES）。
 *
 * 每个画像声明 endpoint 推导模板、公开地址模板、path-style 与分块上传默认值，
 * 使 MinIO/S3/OSS/COS 等兼容端点可以用同一份配置解析逻辑接入。
 */
export interface StorageProviderProfile {
  readonly provider: string;
  readonly label: string;
  readonly endpointTemplate: string | null;
  readonly publicUrlTemplate: string | null;
  readonly defaultRegion: string | null;
  readonly endpointRequired: boolean;
  readonly pathStyleAccessEnabled: boolean;
  readonly chunkedEncodingEnabled: boolean;
  readonly publicUrlInferable: boolean;
}

const LEGACY_PROVIDER_MAP: Record<string, string> = {
  aliyun_oss: 'oss',
  tencent_cos: 'cos',
  aws_s3: 's3',
};

export const STORAGE_PROFILES: readonly StorageProviderProfile[] = [
  {
    provider: 'generic_s3', label: 'S3 Compatible', endpointTemplate: null, publicUrlTemplate: null,
    defaultRegion: 'us-east-1', endpointRequired: true, pathStyleAccessEnabled: true,
    chunkedEncodingEnabled: false, publicUrlInferable: true,
  },
  {
    provider: 's3', label: 'AWS S3', endpointTemplate: 'https://s3.{region}.amazonaws.com',
    publicUrlTemplate: 'https://{bucket}.s3.{region}.amazonaws.com/{key}', defaultRegion: 'us-east-1',
    endpointRequired: false, pathStyleAccessEnabled: false, chunkedEncodingEnabled: true,
    publicUrlInferable: true,
  },
  {
    provider: 'oss', label: 'Alibaba Cloud OSS', endpointTemplate: 'https://oss-{region}.aliyuncs.com',
    publicUrlTemplate: 'https://{bucket}.oss-{region}.aliyuncs.com/{key}', defaultRegion: null,
    endpointRequired: false, pathStyleAccessEnabled: false, chunkedEncodingEnabled: false,
    publicUrlInferable: true,
  },
  {
    provider: 'cos', label: 'Tencent Cloud COS', endpointTemplate: 'https://cos.{region}.myqcloud.com',
    publicUrlTemplate: 'https://{bucket}.cos.{region}.myqcloud.com/{key}', defaultRegion: null,
    endpointRequired: false, pathStyleAccessEnabled: false, chunkedEncodingEnabled: false,
    publicUrlInferable: true,
  },
  {
    provider: 'qiniu_kodo', label: 'Qiniu Kodo', endpointTemplate: 'https://s3.{region}.qiniucs.com',
    publicUrlTemplate: null, defaultRegion: null, endpointRequired: false,
    pathStyleAccessEnabled: true, chunkedEncodingEnabled: false, publicUrlInferable: true,
  },
  {
    provider: 'ctyun_zos', label: 'CTYun ZOS', endpointTemplate: null, publicUrlTemplate: null,
    defaultRegion: 'us-east-1', endpointRequired: true, pathStyleAccessEnabled: true,
    chunkedEncodingEnabled: false, publicUrlInferable: true,
  },
  {
    provider: 'minio', label: 'MinIO', endpointTemplate: null, publicUrlTemplate: null,
    defaultRegion: 'us-east-1', endpointRequired: true, pathStyleAccessEnabled: true,
    chunkedEncodingEnabled: false, publicUrlInferable: true,
  },
];

const PROVIDER_NAMES = ['generic_s3', 's3', 'oss', 'cos', 'qiniu_kodo', 'ctyun_zos', 'minio'] as const;

export const STORAGE_DRIVER_PROVIDERS: readonly (typeof PROVIDER_NAMES[number] | 'local')[] =
  ['local', ...PROVIDER_NAMES];
export type StorageDriverProvider = typeof STORAGE_DRIVER_PROVIDERS[number];

export function isStorageDriverProvider(value: unknown): value is StorageDriverProvider {
  return typeof value === 'string' && (STORAGE_DRIVER_PROVIDERS as readonly string[]).includes(value);
}

/** 兼容旧别名：aliyun_oss/tencent_cos/aws_s3 归一到统一驱动实现名。 */
export function normalizeStorageProvider(type: string | null | undefined): StorageDriverProvider {
  if (!type?.trim() || type.trim() === 'local') return 'local';
  const value = type.trim().toLowerCase();
  if (isStorageDriverProvider(value)) return value;
  const legacy = LEGACY_PROVIDER_MAP[value];
  if (legacy) return legacy as StorageDriverProvider;
  throw new StorageDriverError('STORAGE_PROFILE_UNSUPPORTED', `不支持的存储厂商：${type}`);
}

export function resolveProviderProfile(provider: string): StorageProviderProfile {
  const profile = STORAGE_PROFILES.find(item => item.provider === provider);
  if (!profile) throw new StorageDriverError('STORAGE_PROFILE_UNSUPPORTED', `不支持的存储厂商：${provider}`);
  return profile;
}

export interface ResolvedStorageEndpoint {
  readonly profile: StorageProviderProfile;
  readonly provider: StorageDriverProvider;
  readonly endpoint: string | null;
  readonly region: string | null;
  readonly signingRegion: string;
  readonly pathStyleAccessEnabled: boolean;
  readonly chunkedEncodingEnabled: boolean;
  readonly checksumCalculation: 'WHEN_REQUIRED' | 'WHEN_SUPPORTED';
}

export interface StorageEndpointInput {
  readonly provider: StorageDriverProvider;
  readonly endpoint?: string | null;
  readonly region?: string | null;
  readonly options?: Record<string, unknown>;
}

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function booleanOption(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeEndpoint(value: string | null): string | null {
  if (!value) return null;
  const withScheme = /^https?:\/\//iu.test(value) ? value : `https://${value}`;
  return withScheme.replace(/\/+$/u, '');
}

/**
 * 由画像解析 endpoint/region/path-style。缺少必填配置时抛出
 * STORAGE_CONFIG_INVALID，让部署问题在启动期暴露而不是首次上传时。
 */
export function resolveStorageEndpoint(input: StorageEndpointInput): ResolvedStorageEndpoint {
  const profile = resolveProviderProfile(input.provider);
  const options = input.options && typeof input.options === 'object' ? input.options : {};
  const region = nonBlank(input.region) ?? profile.defaultRegion;
  let endpoint = normalizeEndpoint(nonBlank(input.endpoint)
    ?? (profile.endpointTemplate ? profile.endpointTemplate.replaceAll('{region}', region ?? '') : null));
  if (!nonBlank(input.endpoint) && profile.endpointTemplate && !region) {
    throw new StorageDriverError('STORAGE_CONFIG_INVALID', `${profile.label} 未配置 endpoint 时必须填写 region。`);
  }
  if (!endpoint && profile.endpointRequired) {
    throw new StorageDriverError('STORAGE_CONFIG_INVALID', `${profile.label} 存储配置缺少 endpoint。`);
  }
  const rawChecksum = nonBlank(options.checksumCalculation)?.toUpperCase();
  return {
    profile,
    provider: input.provider,
    endpoint,
    region,
    signingRegion: nonBlank(options.signingRegion) ?? region ?? 'us-east-1',
    pathStyleAccessEnabled: booleanOption(options.pathStyleAccessEnabled, profile.pathStyleAccessEnabled),
    chunkedEncodingEnabled: booleanOption(options.chunkedEncodingEnabled, profile.chunkedEncodingEnabled),
    checksumCalculation: rawChecksum === 'WHEN_SUPPORTED' ? 'WHEN_SUPPORTED' : 'WHEN_REQUIRED',
  };
}

/** 由画像推导稳定公开地址；不可推导的厂商要求显式自定义域名。 */
export function resolveStoragePublicUrl(input: {
  resolved: ResolvedStorageEndpoint;
  bucket: string;
  customDomain?: string | null;
  objectKey: string;
}): string {
  const { resolved, bucket, customDomain, objectKey } = input;
  const key = objectKey.replaceAll('\\', '/').replace(/^\/+/u, '').split('/')
    .filter(Boolean).map(part => encodeURIComponent(part)).join('/');
  if (nonBlank(customDomain)) {
    const domain = (customDomain as string).trim();
    return `${/^https?:\/\//iu.test(domain) ? domain : `https://${domain}`}`.replace(/\/+$/u, '') + `/${key}`;
  }
  if (resolved.profile.publicUrlTemplate && resolved.region) {
    return resolved.profile.publicUrlTemplate
      .replaceAll('{bucket}', bucket).replaceAll('{region}', resolved.region).replaceAll('{key}', key);
  }
  if (!resolved.profile.publicUrlInferable) {
    throw new StorageDriverError('STORAGE_PUBLIC_URL_UNAVAILABLE',
      `${resolved.profile.label} 无法推导公开地址，请配置自定义域名。`);
  }
  if (!resolved.endpoint) {
    throw new StorageDriverError('STORAGE_CONFIG_INVALID', '存储配置缺少 endpoint，无法生成公开地址。');
  }
  const endpoint = new URL(resolved.endpoint);
  const base = `${endpoint.protocol}//${endpoint.host}`;
  return resolved.pathStyleAccessEnabled
    ? `${base}/${bucket}/${key}`
    : `${endpoint.protocol}//${bucket}.${endpoint.host}/${key}`;
}
