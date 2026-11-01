export const modelRoles = ['breakdown', 'image', 'video', 'general'] as const;
export type ModelRole = typeof modelRoles[number];
export type ModelConnection = {
  role: ModelRole; endpoint: string; model: string; authType: 'bearer' | 'api-key';
  hasApiKey: boolean; configured: boolean; revision: string; maxOutputTokens: number; timeoutMs: number;
  source: 'environment' | 'local'; execution: 'text' | 'asset-generation' | 'task-api-ready' | 'not-implemented';
  profileId: string | null; profileName: string | null;
};
export type ModelKind = 'text' | 'image' | 'video';
export type ModelProfile = Omit<ModelConnection, 'role' | 'profileId' | 'profileName'> & { id: string; name: string; kind: ModelKind; roles: ModelRole[] };
export type ModelCatalog = { connections: ModelConnection[]; profiles: ModelProfile[]; legacyImportAvailable: boolean; legacyModel: string };
export type ConnectionDraft = { endpoint: string; model: string; authType: 'bearer' | 'api-key'; apiKey: string;
  clearApiKey: boolean; maxOutputTokens: number; timeoutMs: number };
export type ProfileDraft = ConnectionDraft & { name: string; kind: ModelKind; copyCredentialsFrom?: { profileId: string; revision: string } };
export const roleInfo = {
  breakdown: { title: '剧本／小说拆解', short: '拆解模型', en: 'BREAKDOWN', description: '提取人物、场景、道具与对白；逐段查漏、局部修复和复核也使用此配置。' },
  image: { title: '图像生成', short: '生图模型', en: 'IMAGE', description: '为已校对的人物、场景与道具生成候选图；图片自动导入候选区，人工确认后才关联资产库。' },
  video: { title: '视频生成', short: '生视频模型', en: 'VIDEO', description: '使用 Seedance 异步任务协议；连接、提交与状态查询适配已独立实现。' },
  general: { title: '通用文本', short: '通用模型', en: 'GENERAL', description: '用于通用文本调用与已有分镜设计流程，不替代拆解模型。' },
} as const;
export const isTextRole = (role: ModelRole) => role === 'breakdown' || role === 'general';
export const kindForRole = (role: ModelRole): ModelKind => isTextRole(role) ? 'text' : role as 'image' | 'video';
export const kindNames = { text: '文本模型', image: '生图模型', video: '生视频模型' };
export function compatibleProfiles(profiles: ModelProfile[], role: ModelRole) { return profiles.filter(p => p.kind === kindForRole(role)); }
export function profileDraft(profile?: ModelProfile, kind: ModelKind = 'text'): ProfileDraft {
  return profile ? { ...connectionDraft(profile), name: profile.name, kind: profile.kind } : { name: '', kind, endpoint: '', model: '',
    authType: 'bearer', apiKey: '', clearApiKey: false, maxOutputTokens: 8192, timeoutMs: 180000 };
}
export function copyProfileDraft(profile: ModelProfile): ProfileDraft {
  return { ...profileDraft(profile), name: `${profile.name.slice(0, 70)} 副本`, copyCredentialsFrom: { profileId: profile.id, revision: profile.revision } };
}
export function validateProfileDraft(draft: ProfileDraft): string | null {
  if (!draft.name.trim() || draft.name.length > 80 || /[\x00-\x1f\x7f]/.test(draft.name)) return '请填写 1–80 字符的连接名称。';
  if (!['text', 'image', 'video'].includes(draft.kind)) return '请选择连接类型。';
  if (draft.copyCredentialsFrom && (draft.apiKey.trim() || draft.clearApiKey)) return '复用密钥与替换／清除密钥不能同时操作。';
  return validateConnectionDraft(draft.kind === 'text' ? 'general' : draft.kind, draft);
}
export function profilePayload(draft: ProfileDraft, profile?: ModelProfile) {
  return { ...draft, name: draft.name.trim(), endpoint: draft.endpoint.trim(), model: draft.model.trim(),
    ...(profile ? { expectedRevision: profile.revision } : {}) };
}
export function connectionDraft(item: Pick<ModelConnection, 'endpoint' | 'model' | 'authType' | 'maxOutputTokens' | 'timeoutMs'>): ConnectionDraft {
  return { endpoint: item.endpoint, model: item.model, authType: item.authType, apiKey: '', clearApiKey: false,
    maxOutputTokens: item.maxOutputTokens, timeoutMs: item.timeoutMs };
}
export function connectionDirty(item: ModelConnection, draft: ConnectionDraft): boolean {
  return JSON.stringify(connectionDraft(item)) !== JSON.stringify(draft);
}
export function validateConnectionDraft(role: ModelRole, draft: ConnectionDraft): string | null {
  if (draft.endpoint.trim()) {
    try {
      const url = new URL(draft.endpoint.trim());
      if (!/^https:\/\//.test(draft.endpoint.trim()) || /\\/.test(draft.endpoint) || url.protocol !== 'https:' || url.username || url.password || /[?#]/.test(draft.endpoint)) return '请使用无账号、查询参数或片段的 HTTPS 接口地址。';
      if (isTextRole(role) && !url.pathname.replace(/\/$/, '').endsWith('/chat/completions')) return '文本模型需要完整的 /chat/completions 接口地址。';
    } catch { return '接口地址格式不正确。'; }
  }
  if (draft.model && !/^[A-Za-z0-9_.:() /-]{1,100}$/.test(draft.model)) return '请填写服务商提供的模型名称（最多 100 字符）。';
  if (draft.apiKey && /[\x00-\x1f\x7f]/.test(draft.apiKey)) return '密钥不能包含换行或控制字符。';
  if (draft.apiKey.trim() && draft.clearApiKey) return '不能同时替换和清除密钥。';
  if (!Number.isInteger(draft.timeoutMs) || draft.timeoutMs < 1000 || draft.timeoutMs > 600000) return '超时需为 1–600 秒。';
  if (!Number.isInteger(draft.maxOutputTokens) || draft.maxOutputTokens < 256 || draft.maxOutputTokens > 32768) return '输出额度需为 256–32768。';
  return null;
}
export function connectionPayload(item: ModelConnection, draft: ConnectionDraft) {
  return { expectedRevision: item.revision, ...draft, endpoint: draft.endpoint.trim(), model: draft.model.trim() };
}
export async function connectionApi<T>(path = '', body?: unknown, signal?: AbortSignal): Promise<T> {
  return modelSettingsApi<T>(`/api/model-connections${path}`, body, signal);
}
export async function modelSettingsApi<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shortdrama-Call': '1' }, body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error?.message ?? '无法读取或保存模型连接，请检查本机后端。');
  return result as T;
}
