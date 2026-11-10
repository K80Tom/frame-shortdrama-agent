import { Type, type Static } from '@sinclair/typebox';
import Ajv from 'ajv';

/**
 * 模型预设只承载“如何配置连接”的公开元数据。
 * 这里刻意不定义 apiKey / credential 字段：密钥主权属于 packages/main，
 * 预设目录本身不得包含任何真实凭据。
 */
export type ModelKind = 'text' | 'image' | 'video';
/** Issue #172 使用的旧名称；与 ModelKind 完全等价，避免调用方二选一。 */
export type ModelModality = ModelKind;

export interface ProviderCatalogEntry {
  id: string;
  label: string;
  vendor: string;
  platform: 'openai_compatible' | 'newapi' | 'volcengine' | 'dashscope' | string;
  /** 厂商标准接口；文本模型必须包含完整的 /chat/completions 路径。 */
  defaultBaseUrl: string;
  credentialUrl?: string;
  documentationUrl?: string;
  hint?: string;
  supportedKinds: ModelKind[];
}

export interface ModelPresetConfig {
  supportedResolutions?: string[];
  supportedAspectRatios?: string[];
  supportedDurations?: number[];
  minDuration?: number;
  maxDuration?: number;
  defaultDuration?: number;
  supportFirstFrame?: boolean;
  supportLastFrame?: boolean;
  defaultTimeoutMs?: number;
  maxOutputTokens?: number;
  defaultWidth?: number;
  defaultHeight?: number;
}

export interface ModelPresetEntry {
  code: string;
  name: string;
  providerId: string;
  kind: ModelKind;
  description: string;
  capabilities: string[];
  /** 文本模型的推荐上下文窗口；其他类型可省略。 */
  contextWindow?: number;
  /** 供应商实际模型标识；通常与 code 相同，但可独立声明。 */
  modelCode: string;
  /** 完整接口地址；服务商目录提供默认值时可由目录解析补齐。 */
  defaultBaseUrl: string;
  config?: ModelPresetConfig;
}

export interface ModelPresetGroup {
  provider: ProviderCatalogEntry;
  presets: ModelPresetEntry[];
}

/** 兼容 Issue #172 草案中的条目命名。 */
export type ProviderCatalogItem = ProviderCatalogEntry;
export type ModelPresetItem = ModelPresetEntry;

export interface ModelPresetCatalogResponse {
  providers: ProviderCatalogEntry[];
  presets: ModelPresetEntry[];
  groups: ModelPresetGroup[];
  total: number;
  filters: { kind: ModelKind | null; providerId: string | null };
  secretsReturned: false;
}

export interface ProviderCatalogResponse {
  providers: ProviderCatalogEntry[];
  total: number;
  secretsReturned: false;
}

const KIND_VALUES = ['text', 'image', 'video'] as const;
export const ModelKindSchema = Type.Union(KIND_VALUES.map(value => Type.Literal(value)));

const Identifier = Type.String({ minLength: 2, maxLength: 100, pattern: '^[A-Za-z][A-Za-z0-9_.:-]*$' });
const ProviderId = Type.String({ minLength: 2, maxLength: 64, pattern: '^[a-z][a-z0-9_-]*$' });
const HttpsUrl = Type.String({ minLength: 1, maxLength: 2048, pattern: '^https://' });
const WebUrl = Type.String({ minLength: 1, maxLength: 2048, pattern: '^https://' });
const ShortText = Type.String({ minLength: 1, maxLength: 500 });
const Label = Type.String({ minLength: 1, maxLength: 100 });
const StringList = Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 16 });

export const ProviderCatalogEntrySchema = Type.Object({
  id: ProviderId,
  label: Label,
  vendor: Label,
  platform: Type.String({ minLength: 1, maxLength: 64 }),
  defaultBaseUrl: HttpsUrl,
  credentialUrl: Type.Optional(WebUrl),
  documentationUrl: Type.Optional(WebUrl),
  hint: Type.Optional(Type.String({ maxLength: 300 })),
  supportedKinds: Type.Array(ModelKindSchema, { minItems: 1, maxItems: 3 }),
}, { additionalProperties: false });

export const ModelPresetConfigSchema = Type.Object({
  supportedResolutions: Type.Optional(StringList),
  supportedAspectRatios: Type.Optional(StringList),
  supportedDurations: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 60 }), { minItems: 1, maxItems: 20 })),
  minDuration: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
  maxDuration: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
  defaultDuration: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
  supportFirstFrame: Type.Optional(Type.Boolean()),
  supportLastFrame: Type.Optional(Type.Boolean()),
  defaultTimeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 600000 })),
  maxOutputTokens: Type.Optional(Type.Integer({ minimum: 256, maximum: 32768 })),
  defaultWidth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
  defaultHeight: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
}, { additionalProperties: false });

export const ModelPresetEntrySchema = Type.Object({
  code: Identifier,
  name: Label,
  providerId: ProviderId,
  kind: ModelKindSchema,
  description: ShortText,
  capabilities: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 12 }),
  contextWindow: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000_000 })),
  modelCode: Identifier,
  defaultBaseUrl: HttpsUrl,
  config: Type.Optional(ModelPresetConfigSchema),
}, { additionalProperties: false });

export const ModelPresetCatalogSchema = Type.Object({
  providers: Type.Array(ProviderCatalogEntrySchema, { minItems: 1, maxItems: 64 }),
  presets: Type.Array(ModelPresetEntrySchema, { minItems: 1, maxItems: 256 }),
}, { additionalProperties: false });

export type ProviderCatalogEntryInput = Static<typeof ProviderCatalogEntrySchema>;
export type ModelPresetEntryInput = Static<typeof ModelPresetEntrySchema>;
export type ModelPresetCatalogInput = Static<typeof ModelPresetCatalogSchema>;

export class ModelPresetContractError extends Error {
  readonly code = 'MODEL_PRESET_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ModelPresetContractError';
  }
}

const ajv = new Ajv({ allErrors: false, strict: false });
const validateProvider = ajv.compile<ProviderCatalogEntryInput>(ProviderCatalogEntrySchema);
const validatePreset = ajv.compile<ModelPresetEntryInput>(ModelPresetEntrySchema);

function contractError(message: string): never {
  throw new ModelPresetContractError(message);
}

function safeUrl(value: string, label: string, allowQuery = false): string {
  let url: URL;
  try { url = new URL(value); } catch { contractError(`${label}不是合法 URL。`); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
    contractError(`${label}必须是 HTTPS 且不能包含账号或密码。`);
  }
  if (!allowQuery && (url.search || url.hash)) contractError(`${label}不能包含查询参数或片段。`);
  return value;
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) contractError(`${label}不能重复。`);
}

function checkDuration(value: number | undefined, label: string, min: number, max: number): void {
  if (value !== undefined && (value < min || value > max)) contractError(`${label}必须在 ${min}–${max} 之间。`);
}

export function isModelKind(value: unknown): value is ModelKind {
  return typeof value === 'string' && (KIND_VALUES as readonly string[]).includes(value);
}

/** 解析并校验服务商目录；任何不符合公开元数据约束的条目都会拒绝。 */
export function parseProviderCatalog(value: unknown): ProviderCatalogEntry[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) contractError('服务商目录必须包含 1–64 条记录。');
  const providers = value.map((item, index) => {
    if (!validateProvider(item)) contractError(`服务商目录第 ${index + 1} 条不符合契约。`);
    const entry = item as ProviderCatalogEntry;
    safeUrl(entry.defaultBaseUrl, `服务商 ${entry.id} 的默认接口`);
    if (entry.credentialUrl) safeUrl(entry.credentialUrl, `服务商 ${entry.id} 的密钥申请链接`, true);
    if (entry.documentationUrl) safeUrl(entry.documentationUrl, `服务商 ${entry.id} 的文档链接`, true);
    if (!entry.supportedKinds.length) contractError(`服务商 ${entry.id} 未声明支持的模型类型。`);
    unique(entry.supportedKinds, `服务商 ${entry.id} 的支持类型`);
    return entry;
  });
  unique(providers.map(entry => entry.id), '服务商 id');
  return providers;
}

/** 校验预设及其与目录的引用关系；视频/文本预设的必需参数在此统一把关。 */
export function parseModelPresetCatalog(value: unknown, providers: ProviderCatalogEntry[]): ModelPresetEntry[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) contractError('模型预设必须包含 1–256 条记录。');
  const byId = new Map(providers.map(provider => [provider.id, provider]));
  const presets = value.map((item, index) => {
    if (!validatePreset(item)) contractError(`模型预设第 ${index + 1} 条不符合契约。`);
    const entry = item as ModelPresetEntry;
    const provider = byId.get(entry.providerId);
    if (!provider) contractError(`预设 ${entry.code} 引用了不存在的服务商 ${entry.providerId}。`);
    if (!provider.supportedKinds.includes(entry.kind)) contractError(`预设 ${entry.code} 的类型不在服务商支持范围。`);
    safeUrl(entry.defaultBaseUrl, `预设 ${entry.code} 的接口`);
    unique(entry.capabilities, `预设 ${entry.code} 的能力标签`);
    if (entry.kind === 'text' && entry.contextWindow === undefined) {
      contractError(`文本预设 ${entry.code} 必须声明推荐上下文窗口。`);
    }
    if (entry.kind === 'video') {
      if (!entry.config?.supportedResolutions?.length) contractError(`视频预设 ${entry.code} 必须声明支持分辨率。`);
      if (!entry.config.supportedAspectRatios?.length) contractError(`视频预设 ${entry.code} 必须声明支持画幅。`);
    }
    const config = entry.config;
    if (config) {
      if (config.minDuration !== undefined && config.maxDuration !== undefined && config.minDuration > config.maxDuration) {
        contractError(`预设 ${entry.code} 的最小时长不能大于最大时长。`);
      }
      checkDuration(config.minDuration, `预设 ${entry.code} 的最小时长`, 1, 60);
      checkDuration(config.maxDuration, `预设 ${entry.code} 的最大时长`, 1, 60);
      checkDuration(config.defaultDuration, `预设 ${entry.code} 的默认时长`, 1, 60);
      if (config.defaultDuration !== undefined && config.minDuration !== undefined && config.defaultDuration < config.minDuration) {
        contractError(`预设 ${entry.code} 的默认时长不能小于最小时长。`);
      }
      if (config.defaultDuration !== undefined && config.maxDuration !== undefined && config.defaultDuration > config.maxDuration) {
        contractError(`预设 ${entry.code} 的默认时长不能大于最大时长。`);
      }
      if (config.supportedDurations && config.minDuration !== undefined
        && config.supportedDurations.some(duration => duration < config.minDuration!)) {
        contractError(`预设 ${entry.code} 的可选时长小于最小时长。`);
      }
      if (config.supportedDurations && config.maxDuration !== undefined
        && config.supportedDurations.some(duration => duration > config.maxDuration!)) {
        contractError(`预设 ${entry.code} 的可选时长大于最大时长。`);
      }
      if (config.supportLastFrame && !config.supportFirstFrame) {
        contractError(`预设 ${entry.code} 声明支持尾帧时必须同时支持首帧。`);
      }
      if (config.defaultTimeoutMs !== undefined && (config.defaultTimeoutMs < 1000 || config.defaultTimeoutMs > 600000)) {
        contractError(`预设 ${entry.code} 的默认超时必须在 1–600 秒。`);
      }
    }
    return entry;
  });
  unique(presets.map(entry => entry.code), '预设 code');
  return presets;
}

/** 兼容目录文档形态：同时接受数组和 {providers,presets}。 */
export function parseModelPresetCatalogDocument(value: unknown): { providers: ProviderCatalogEntry[]; presets: ModelPresetEntry[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) contractError('预设目录必须是对象或数组。');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !['providers', 'presets'].includes(key))) contractError('预设目录包含未知字段。');
  const providers = parseProviderCatalog(data.providers);
  const presets = parseModelPresetCatalog(data.presets, providers);
  return { providers, presets };
}
