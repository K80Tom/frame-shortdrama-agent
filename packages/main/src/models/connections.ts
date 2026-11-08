import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AppConfig } from '../config';
import { ModelError } from '@lyra/shared';

export const MODEL_ROLES = ['breakdown', 'image', 'video', 'general'] as const;
export type ModelRole = typeof MODEL_ROLES[number];
export interface Connection {
  endpoint: string;
  model: string;
  authType: 'api-key' | 'bearer';
  apiKey: string;
  maxOutputTokens: number;
  timeoutMs: number;
  revision: string;
}
export type ModelKind = 'text' | 'image' | 'video';
export interface ModelProfile extends Connection {
  id: string;
  name: string;
  kind: ModelKind;
  source: 'environment' | 'local';
}
interface Assignment { profileId: string | null; revision: string }
interface ConnectionLibrary {
  schemaVersion: 2;
  profiles: ModelProfile[];
  assignments: Record<ModelRole, Assignment>;
}
const kindForRole = (role: ModelRole): ModelKind => role === 'breakdown' || role === 'general' ? 'text' : role;
const labels: Record<ModelRole, string> = { breakdown: '拆解', general: '通用', image: '生图', video: '生视频' };
const profileId = () => `model_${randomUUID().replaceAll('-', '')}`;
export function parseModelRole(value: unknown): ModelRole {
  if (!MODEL_ROLES.includes(value as ModelRole)) throw invalid('未知模型用途。');
  return value as ModelRole;
}
function invalid(message: string) { return new ModelError(400, 'MODEL_CONNECTION_INVALID', message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('模型配置格式不正确。');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw invalid('配置包含无效字符或超出长度限制。');
  return value.trim();
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw invalid('输出额度或超时时间超出允许范围。');
  return value as number;
}
function endpoint(value: unknown): string {
  const raw = text(value, 2048);
  if (!raw) return '';
  let url: URL;
  try { url = new URL(raw); } catch { throw invalid('请填写完整的 HTTPS 接口地址。'); }
  if (!/^https:\/\//.test(raw) || /\\/.test(raw) || url.protocol !== 'https:' || url.username || url.password || /[?#]/.test(raw)) {
    throw invalid('接口必须使用 HTTPS，不能包含账号、查询参数或片段；密钥请单独填写。');
  }
  return url.href.replace(/\/$/, '');
}
function validate(value: unknown, role: ModelRole): Connection {
  const data = object(value);
  if (Object.keys(data).some(key => !['endpoint', 'model', 'authType', 'apiKey', 'maxOutputTokens', 'timeoutMs', 'revision'].includes(key))) {
    throw invalid('模型配置包含未知字段。');
  }
  const model = text(data.model, 100);
  if (model && !/^[A-Za-z0-9_.:() /-]+$/.test(model)) throw invalid('模型名称包含不支持的字符。');
  if (data.authType !== 'api-key' && data.authType !== 'bearer') throw invalid('请选择受支持的鉴权方式。');
  const result: Connection = { endpoint: endpoint(data.endpoint), model, authType: data.authType,
    apiKey: text(data.apiKey, 4096), maxOutputTokens: integer(data.maxOutputTokens, 256, 32768),
    timeoutMs: integer(data.timeoutMs, 1000, 600000), revision: text(data.revision, 100) };
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(result.revision)) throw invalid('配置版本不正确。');
  if ((role === 'breakdown' || role === 'general') && result.endpoint
    && !new URL(result.endpoint).pathname.endsWith('/chat/completions')) {
    throw invalid('文本模型请填写完整的 /chat/completions 接口，不是网站首页或 Base URL。');
  }
  return result;
}

function strict(value: unknown, allowed: string[]) {
  const data = object(value);
  if (Object.keys(data).some(key => !allowed.includes(key))) throw invalid('模型配置包含未知字段。');
  return data;
}
function revision(value: unknown): string {
  const result = text(value, 100);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(result)) throw invalid('配置版本不正确。');
  return result;
}
function identifier(value: unknown): string {
  const result = text(value, 100);
  if (!/^[A-Za-z][A-Za-z0-9_-]{2,99}$/.test(result)) throw invalid('模型连接标识不正确。');
  return result;
}
function prettyName(model: string): string {
  return model.startsWith('deepseek-') ? 'DeepSeek' : model === 'kimi-k3' ? 'Kimi K3' : model.slice(0, 80);
}
function profileFields(value: Record<string, unknown>, key: string): Connection {
  const kind = value.kind;
  if (kind !== 'text' && kind !== 'image' && kind !== 'video') throw invalid('请选择文本、生图或生视频连接类型。');
  return validate({ endpoint: value.endpoint, model: value.model, authType: value.authType, apiKey: key,
    maxOutputTokens: value.maxOutputTokens, timeoutMs: value.timeoutMs, revision: value.revision }, kind === 'text' ? 'general' : kind);
}
const fields = ['name', 'kind', 'endpoint', 'model', 'authType', 'apiKey', 'clearApiKey', 'maxOutputTokens', 'timeoutMs'];
function name(value: unknown): string {
  const result = text(value, 80);
  if (!result) throw invalid('请填写连接名称。');
  return result;
}
function secret(data: Record<string, unknown>, previous: string) {
  if (data.clearApiKey !== undefined && typeof data.clearApiKey !== 'boolean') throw invalid('清除密钥标记无效。');
  const supplied = data.apiKey === undefined ? '' : text(data.apiKey, 4096);
  if (supplied && data.clearApiKey) throw invalid('替换密钥与清除密钥不能同时操作。');
  return data.clearApiKey ? '' : supplied || previous;
}

/** One local backend owns the library and role assignments. Public views never contain secrets. */
export class ModelConnections {
  private state: ConnectionLibrary;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly budget = { active: 0 };
  private readonly snapshots = new Map<ModelRole, AppConfig>();
  private needsInitialization = false;
  private fileIdentity = 'missing';
  constructor(private readonly base: AppConfig, private readonly file?: string) {
    const blank = (): Connection => ({ endpoint: '', model: '', authType: 'bearer', apiKey: '',
      maxOutputTokens: base.maxOutputTokens, timeoutMs: base.timeoutMs, revision: 'environment-v1' });
    const legacy = (): Connection => ({ ...blank(), ...this.environment() });
    this.state = this.fromLegacy({ breakdown: legacy(), general: legacy(), image: blank(), video: blank() });
    if (file) {
      let raw: string;
      try { raw = readFileSync(file, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.needsInitialization = true; return; }
        throw new ModelError(503, 'MODEL_CONNECTION_STORE_UNAVAILABLE', '无法读取本机模型配置；未降级或覆盖。');
      }
      try {
        const loaded = this.decodeStored(raw);
        this.state = loaded.state;
        this.needsInitialization = loaded.needsInitialization;
        this.fileIdentity = this.currentFileIdentity();
      } catch { throw new ModelError(503, 'MODEL_CONNECTION_STORE_INVALID', '本机模型配置损坏或版本不支持；未覆盖，需维护者检查。'); }
    }
  }
  async initialize(options: { readOnly?: boolean } = {}) {
    // In the split deployment only main-api owns the JSON store. A Worker may
    // start from environment defaults while the API creates/migrates the file,
    // but must never race it by overwriting the shared volume.
    if (options.readOnly) return;
    if (this.file && this.needsInitialization) await this.serial(async () => {
      if (this.needsInitialization) await this.commit(this.state);
    });
  }
  private decodeStored(raw: string): { state: ConnectionLibrary; needsInitialization: boolean } {
    if (Buffer.byteLength(raw) > 1024 * 1024) throw invalid('配置文件过大。');
    const saved = object(JSON.parse(raw));
    if (saved.schemaVersion !== 1) return { state: this.readLibrary(saved), needsInitialization: false };
    strict(saved, ['schemaVersion', 'connections']);
    const book = object(saved.connections);
    if (Object.keys(book).length !== MODEL_ROLES.length) throw invalid('配置用途不完整。');
    return { state: this.fromLegacy(Object.fromEntries(MODEL_ROLES.map(role =>
      [role, validate(book[role], role)])) as Record<ModelRole, Connection>), needsInitialization: true };
  }
  private currentFileIdentity(): string {
    if (!this.file) return 'memory';
    try {
      const value = statSync(this.file);
      return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw new ModelError(503, 'MODEL_CONNECTION_STORE_UNAVAILABLE', '无法检查本机模型配置；未继续使用旧凭据。');
    }
  }
  private refreshFromFileIfChanged(): void {
    if (!this.file) return;
    const identity = this.currentFileIdentity();
    if (identity === this.fileIdentity) return;
    if (identity === 'missing') {
      throw new ModelError(503, 'MODEL_CONNECTION_STORE_UNAVAILABLE', '本机模型配置已不可用；未继续使用旧凭据。');
    }
    let raw: string;
    try { raw = readFileSync(this.file, 'utf8'); }
    catch { throw new ModelError(503, 'MODEL_CONNECTION_STORE_UNAVAILABLE', '无法读取本机模型配置；未继续使用旧凭据。'); }
    try {
      const loaded = this.decodeStored(raw);
      this.state = loaded.state;
      this.needsInitialization = loaded.needsInitialization;
      this.snapshots.clear();
      // Keep the identity observed before the read. If an atomic writer replaces
      // the file before or during this read, the next resolve sees a different
      // identity and refreshes again instead of pairing stale bytes with the
      // identity of a newer file.
      this.fileIdentity = identity;
    } catch (error) {
      if (error instanceof ModelError && error.code === 'MODEL_CONNECTION_STORE_UNAVAILABLE') throw error;
      throw new ModelError(503, 'MODEL_CONNECTION_STORE_INVALID', '本机模型配置损坏或版本不支持；未继续使用旧凭据。');
    }
  }
  private blank(): Connection {
    return { endpoint: '', model: '', authType: 'bearer', apiKey: '', maxOutputTokens: this.base.maxOutputTokens,
      timeoutMs: this.base.timeoutMs, revision: 'environment-v1' };
  }
  private environment() {
    return { endpoint: this.base.baseUrl ? `${this.base.baseUrl}/chat/completions` : '', model: this.base.defaultModel,
      apiKey: this.base.apiKey, authType: this.base.authType ?? 'api-key' as const,
      maxOutputTokens: this.base.maxOutputTokens, timeoutMs: this.base.timeoutMs };
  }
  private fromLegacy(book: Record<ModelRole, Connection>): ConnectionLibrary {
    const profiles: ModelProfile[] = [];
    const assignments = {} as Record<ModelRole, Assignment>;
    for (const role of MODEL_ROLES) {
      const item = book[role];
      let saved: ModelProfile | undefined;
      if (item.endpoint || item.model || item.apiKey || item.timeoutMs !== this.base.timeoutMs || item.maxOutputTokens !== this.base.maxOutputTokens) {
        saved = profiles.find(p => p.kind === kindForRole(role) && p.endpoint === item.endpoint && p.model === item.model
          && p.authType === item.authType && p.apiKey === item.apiKey && p.timeoutMs === item.timeoutMs && p.maxOutputTokens === item.maxOutputTokens);
        if (!saved) {
          const title = prettyName(item.model) || `${labels[role]}连接`;
          let unique = title;
          for (let n = 2; profiles.some(p => p.name === unique); n++) unique = `${title.slice(0, 74)} ${n}`;
          saved = { ...item, id: profileId(), name: unique, kind: kindForRole(role),
            source: item.revision === 'environment-v1' ? 'environment' : 'local' };
          profiles.push(saved);
        }
      }
      assignments[role] = { profileId: saved?.id ?? null, revision: item.revision };
    }
    return { schemaVersion: 2, profiles, assignments };
  }
  private readLibrary(value: unknown): ConnectionLibrary {
    const data = strict(value, ['schemaVersion', 'profiles', 'assignments']);
    if (data.schemaVersion !== 2 || !Array.isArray(data.profiles) || data.profiles.length > 64) throw invalid('配置库版本或模型数量不正确。');
    const profiles = data.profiles.map(raw => {
      const p = strict(raw, ['id', 'name', 'kind', 'source', 'endpoint', 'model', 'authType', 'apiKey', 'maxOutputTokens', 'timeoutMs', 'revision']);
      if (p.source !== 'local' && p.source !== 'environment') throw invalid('配置来源不正确。');
      return { ...profileFields(p, text(p.apiKey, 4096)), id: identifier(p.id), name: name(p.name),
        kind: p.kind as ModelKind, source: p.source } as ModelProfile;
    });
    if (new Set(profiles.map(p => p.id)).size !== profiles.length || new Set(profiles.map(p => p.name)).size !== profiles.length) throw invalid('连接标识或名称重复。');
    const rawAssignments = strict(data.assignments, [...MODEL_ROLES]);
    const assignments = {} as Record<ModelRole, Assignment>;
    for (const role of MODEL_ROLES) {
      const a = strict(rawAssignments[role], ['profileId', 'revision']);
      const id = a.profileId === null ? null : identifier(a.profileId);
      if (id && !profiles.some(p => p.id === id && p.kind === kindForRole(role))) throw invalid('用途引用缺失或连接类型不符。');
      assignments[role] = { profileId: id, revision: revision(a.revision) };
    }
    return { schemaVersion: 2, profiles, assignments };
  }
  private selected(role: ModelRole) { return this.state.profiles.find(p => p.id === this.state.assignments[role].profileId); }
  private profile(id: string) {
    const item = this.state.profiles.find(p => p.id === id);
    if (!item) throw new ModelError(404, 'MODEL_PROFILE_NOT_FOUND', '模型连接不存在，请重新读取连接库。');
    return item;
  }
  private publicProfile(item: ModelProfile) {
    const { apiKey, ...safe } = item;
    return { ...safe, hasApiKey: Boolean(apiKey), configured: Boolean(item.endpoint && item.model && apiKey),
      execution: item.kind === 'text' ? 'text' : item.kind === 'image' ? 'asset-generation' : 'task-api-ready',
      roles: MODEL_ROLES.filter(role => this.state.assignments[role].profileId === item.id) };
  }
  public(role: ModelRole) {
    const item = this.selected(role);
    const { apiKey, ...safe } = item ?? this.blank();
    return { ...safe, revision: this.state.assignments[role].revision, profileId: item?.id ?? null, profileName: item?.name ?? null,
      role, hasApiKey: Boolean(apiKey), configured: Boolean(safe.endpoint && safe.model && apiKey),
      execution: kindForRole(role) === 'text' ? 'text' : role === 'image' ? 'asset-generation' : 'task-api-ready', source: item?.source ?? 'local' };
  }
  list() { return { connections: MODEL_ROLES.map(role => this.public(role)), profiles: this.state.profiles.map(p => this.publicProfile(p)),
    legacyImportAvailable: Boolean(this.base.baseUrl && this.base.apiKey), legacyModel: this.base.defaultModel, secretsReturned: false }; }
  resolve(role: ModelRole): AppConfig {
    this.refreshFromFileIfChanged();
    const cached = this.snapshots.get(role);
    if (cached) return cached;
    const item = this.selected(role) ?? this.blank();
    // No cross-role fallback or mutable credentials in a running operation.
    const { modelConnections: _, ...base } = this.base;
    const snapshot = Object.freeze({ ...base, provider: item.authType === 'api-key' ? 'maas' as const : 'openai-compatible' as const,
      baseUrl: '', endpointUrl: item.endpoint, apiKey: item.apiKey, defaultModel: item.model,
      authType: item.authType, reasoningEffort: 'model-default', maxOutputTokens: item.maxOutputTokens,
      timeoutMs: item.timeoutMs, connectionRevision: this.state.assignments[role].revision, callBudget: this.budget });
    this.snapshots.set(role, snapshot);
    return snapshot;
  }
  async update(role: ModelRole, input: unknown) {
    // Compatibility endpoint is copy-on-write: old clients still edit one role only.
    return this.serial(async () => {
      const data = strict(input, ['expectedRevision', 'endpoint', 'model', 'authType', 'apiKey', 'clearApiKey', 'maxOutputTokens', 'timeoutMs']);
      this.checkVersion(data.expectedRevision, this.state.assignments[role].revision);
      const previous = this.selected(role);
      const candidate = validate({ endpoint: data.endpoint, model: data.model, authType: data.authType,
        apiKey: secret(data, previous?.apiKey ?? ''), maxOutputTokens: data.maxOutputTokens,
        timeoutMs: data.timeoutMs, revision: randomUUID() }, role);
      const shared = previous && MODEL_ROLES.filter(r => this.state.assignments[r].profileId === previous.id).length > 1;
      const profile: ModelProfile = { ...candidate, id: previous && !shared ? previous.id : profileId(),
        name: previous && !shared ? previous.name : this.uniqueName(prettyName(candidate.model) || `${labels[role]}连接`),
        kind: kindForRole(role), source: 'local' };
      const profiles = previous && !shared ? this.state.profiles.map(p => p.id === previous.id ? profile : p) : [...this.state.profiles, profile];
      this.checkLimit(profiles.length);
      await this.commit({ ...this.state, profiles,
        assignments: { ...this.state.assignments, [role]: { profileId: profile.id, revision: randomUUID() } } });
      return this.public(role);
    });
  }
  async createProfile(input: unknown) {
    return this.serial(async () => {
      const data = strict(input, [...fields, 'copyCredentialsFrom']);
      const title = name(data.name);
      this.checkName(title); this.checkLimit(this.state.profiles.length + 1);
      let copiedKey = '';
      if (data.copyCredentialsFrom !== undefined) {
        const copy = strict(data.copyCredentialsFrom, ['profileId', 'revision']);
        const source = this.profile(identifier(copy.profileId));
        this.checkVersion(copy.revision, source.revision);
        if (endpoint(data.endpoint) !== source.endpoint || data.authType !== source.authType) throw invalid('复用密钥必须保持原接口与鉴权方式；新接口请填写单独的密钥。');
        if (data.clearApiKey || (data.apiKey !== undefined && text(data.apiKey, 4096))) throw invalid('复用与替换／清除密钥不能同时操作。');
        copiedKey = source.apiKey;
      }
      const profile: ModelProfile = { ...profileFields({ ...data, revision: randomUUID() }, secret(data, copiedKey)),
        id: profileId(), name: title, kind: data.kind as ModelKind, source: 'local' };
      await this.commit({ ...this.state, profiles: [...this.state.profiles, profile] });
      return this.publicProfile(profile);
    });
  }
  async updateProfile(id: string, input: unknown) {
    return this.serial(async () => {
      const data = strict(input, [...fields, 'expectedRevision']);
      const previous = this.profile(identifier(id));
      this.checkVersion(data.expectedRevision, previous.revision);
      const title = name(data.name); this.checkName(title, id);
      const profile: ModelProfile = { ...profileFields({ ...data, revision: randomUUID() }, secret(data, previous.apiKey)),
        id: previous.id, name: title, kind: data.kind as ModelKind, source: 'local' };
      const assignments = { ...this.state.assignments };
      for (const role of MODEL_ROLES) if (assignments[role].profileId === id) {
        if (kindForRole(role) !== profile.kind) throw invalid('此连接正在被用途引用，请先取消分配再修改连接类型。');
        assignments[role] = { profileId: id, revision: randomUUID() };
      }
      await this.commit({ ...this.state, profiles: this.state.profiles.map(p => p.id === id ? profile : p), assignments });
      return this.publicProfile(profile);
    });
  }
  async assign(role: ModelRole, input: unknown) {
    return this.serial(async () => {
      const data = strict(input, ['profileId', 'expectedRevision']);
      this.checkVersion(data.expectedRevision, this.state.assignments[role].revision);
      const id = data.profileId === null ? null : identifier(data.profileId);
      if (id && this.profile(id).kind !== kindForRole(role)) throw new ModelError(400, 'MODEL_PROFILE_INCOMPATIBLE', '连接类型与用途不符；文本模型不能分配为生图或生视频模型。');
      if (this.state.assignments[role].profileId === id) return this.public(role);
      await this.commit({ ...this.state, assignments: { ...this.state.assignments,
        [role]: { profileId: id, revision: randomUUID() } } });
      return this.public(role);
    });
  }
  async importEnvironment(input: unknown) {
    return this.serial(async () => {
      strict(input, []);
      const env = this.environment();
      if (!env.endpoint || !env.apiKey) throw new ModelError(409, 'ENV_MODEL_NOT_CONFIGURED', '旧环境中没有完整文本连接，未导入。');
      // Import is explicit and idempotent; never refill a previously cleared key.
      const existing = this.state.profiles.find(p => p.kind === 'text' && p.endpoint === env.endpoint && p.model === env.model && p.authType === env.authType);
      if (existing) return this.publicProfile(existing);
      this.checkLimit(this.state.profiles.length + 1);
      const profile: ModelProfile = { ...validate({ ...env, revision: randomUUID() }, 'general'), id: profileId(),
        kind: 'text', source: 'environment', name: this.uniqueName(prettyName(env.model)) };
      await this.commit({ ...this.state, profiles: [...this.state.profiles, profile] });
      return this.publicProfile(profile);
    });
  }
  private uniqueName(title: string) {
    let value = title;
    for (let n = 2; this.state.profiles.some(p => p.name === value); n++) value = `${title.slice(0, 74)} ${n}`;
    return value;
  }
  private checkName(title: string, exceptId?: string) {
    if (this.state.profiles.some(p => p.id !== exceptId && p.name === title)) throw new ModelError(409, 'MODEL_PROFILE_NAME_CONFLICT', '已有同名连接，请使用便于区分的名称。');
  }
  private checkLimit(length: number) { if (length > 64) throw invalid('最多保存 64 个模型连接。'); }
  private checkVersion(expected: unknown, actual: string) {
    if (expected !== actual) throw new ModelError(409, 'MODEL_CONNECTION_CONFLICT', '配置已在其他页面修改；请重新读取后核对，当前输入未覆盖服务端。');
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(work);
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  private async commit(state: ConnectionLibrary) {
    if (this.file) await this.persist(state);
    this.state = state; this.needsInitialization = false; this.snapshots.clear();
    if (this.file) this.fileIdentity = this.currentFileIdentity();
  }
  private async persist(state: ConnectionLibrary) {
    const file = this.file!;
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(state), 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, file);
    } catch {
      await unlink(temporary).catch(() => undefined);
      throw new ModelError(503, 'MODEL_CONNECTION_SAVE_FAILED', '本机模型配置未能保存；原配置保持不变，请检查目录权限。');
    }
  }
}

export function configForRole(config: AppConfig, role: ModelRole): AppConfig {
  return config.modelConnections?.resolve(role) ?? config;
}

/** Bind UI spending consent to the exact connection shown, not a newer default from another tab. */
export function assertModelSelection(config: AppConfig, expected: unknown): void {
  if (expected === undefined) return; // Compatibility for existing explicit API clients.
  if (typeof expected !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(expected)) throw new ModelError(400, 'MODEL_SELECTION_INVALID', '模型选择版本格式不正确。');
  if (expected !== config.connectionRevision) throw new ModelError(409, 'MODEL_SELECTION_CHANGED', '模型选择已在其他页面修改，请刷新页面并重新确认后执行；未调用模型。');
}
