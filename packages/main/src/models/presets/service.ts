import {
  ModelError,
  parseModelPresetCatalog,
  parseProviderCatalog,
  type ModelKind,
  type ModelPresetCatalogResponse,
  type ModelPresetEntry,
  type ProviderCatalogEntry,
  type ProviderCatalogResponse,
} from '@lyra/shared';
import { MODEL_PRESETS, PROVIDER_CATALOG, PROVIDER_BY_ID } from './catalog';

export interface ModelPresetListQuery {
  kind?: string;
  /** Issue #172 的旧查询名；与 kind 等价。 */
  modality?: string;
  providerId?: string;
}

function invalid(message: string): never {
  throw new ModelError(400, 'MODEL_PRESET_FILTER_INVALID', message);
}

function parseFilterKind(value: unknown): ModelKind | undefined {
  if (value === undefined || value === '') return undefined;
  if (value !== 'text' && value !== 'image' && value !== 'video') {
    invalid('模型类型只支持 text、image 或 video。');
  }
  return value;
}

function parseFilterProvider(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(value)) {
    invalid('服务商 id 格式不正确。');
  }
  return value;
}

/**
 * 只读预设目录服务：启动时校验内置元数据，查询时只做内存过滤。
 * 不读取环境变量、不访问文件、不发起任何上游请求。
 */
export class ModelPresetService {
  private readonly providers: readonly ProviderCatalogEntry[];
  private readonly presets: readonly ModelPresetEntry[];
  private readonly byCode: ReadonlyMap<string, ModelPresetEntry>;

  constructor(providers: unknown = PROVIDER_CATALOG, presets: unknown = MODEL_PRESETS) {
    const providerList = parseProviderCatalog(providers);
    this.providers = providerList;
    this.presets = parseModelPresetCatalog(presets, providerList);
    this.byCode = new Map(this.presets.map(preset => [preset.code.toLowerCase(), preset]));
  }

  listProviders(): ProviderCatalogResponse {
    return { providers: [...this.providers], total: this.providers.length, secretsReturned: false };
  }

  listPresets(query: ModelPresetListQuery = {}): ModelPresetCatalogResponse {
    if (query.kind !== undefined && query.modality !== undefined && query.kind !== query.modality) {
      invalid('kind 与 modality 不能同时指定不同值。');
    }
    const kind = parseFilterKind(query.kind ?? query.modality);
    const providerId = parseFilterProvider(query.providerId);
    if (providerId && !this.providers.some(provider => provider.id === providerId)) {
      invalid('未知的模型服务商。');
    }
    const presets = this.presets.filter(preset => (!kind || preset.kind === kind)
      && (!providerId || preset.providerId === providerId));
    const groups = this.providers
      .map(provider => ({ provider, presets: presets.filter(preset => preset.providerId === provider.id) }))
      .filter(group => group.presets.length > 0);
    return {
      providers: [...this.providers],
      presets: [...presets],
      groups,
      total: presets.length,
      filters: { kind: kind ?? null, providerId: providerId ?? null },
      secretsReturned: false,
    };
  }

  /** 供 createProfile 使用；未知 code 返回 null，由连接层决定如何报错。 */
  findPreset(code: unknown): ModelPresetEntry | null {
    if (typeof code !== 'string' || !code.trim()) return null;
    return this.byCode.get(code.trim().toLowerCase()) ?? null;
  }

  requirePreset(code: unknown): ModelPresetEntry {
    const preset = this.findPreset(code);
    if (!preset) throw new ModelError(400, 'MODEL_PRESET_NOT_FOUND', '未知的模型预设，请刷新预设列表后重试。');
    return preset;
  }

  /** 预设只补默认参数；apiKey 永远由调用方在 main 侧单独提交。 */
  profileDefaults(code: unknown): {
    name: string; kind: ModelKind; endpoint: string; model: string; authType: 'bearer';
    maxOutputTokens: number; timeoutMs: number;
  } {
    const preset = this.requirePreset(code);
    return {
      name: preset.name,
      kind: preset.kind,
      endpoint: preset.defaultBaseUrl,
      model: preset.modelCode,
      authType: 'bearer',
      maxOutputTokens: preset.config?.maxOutputTokens ?? 8192,
      timeoutMs: preset.config?.defaultTimeoutMs ?? (preset.kind === 'video' ? 300000 : 180000),
    };
  }

  providerFor(providerId: string): ProviderCatalogEntry | undefined {
    return PROVIDER_BY_ID.get(providerId);
  }
}
