export const workspaceStorageKey = 'lyra:active-workspace:v1';
export const csrfCookieName = 'lyra_csrf';

export type WorkspaceSummary = {
  id: string;
  name: string;
  slug?: string;
  role?: string;
  legacy: boolean;
};

export type WorkspaceDirectory = {
  items: WorkspaceSummary[];
  currentWorkspaceId: string | null;
  legacyMode: boolean;
};

export const systemServiceIds = ['api', 'worker', 'postgres', 'redis', 'milvus', 'objectStorage'] as const;
export type SystemServiceId = typeof systemServiceIds[number];
export type SystemHealth = 'healthy' | 'degraded' | 'unconfigured' | 'unavailable';
export type RuntimeRole = 'api' | 'worker' | 'all';

export type SystemServiceStatus = {
  id: SystemServiceId;
  label: string;
  status: SystemHealth;
  required: boolean;
  detail: string;
  provider?: string;
};

export type SystemStatus = {
  generatedAt: string;
  runtimeRole: RuntimeRole | null;
  services: SystemServiceStatus[];
};

export const systemServiceCatalog: Record<SystemServiceId, { label: string; required: boolean; degradable: boolean }> = {
  api: { label: 'API', required: true, degradable: false },
  worker: { label: 'Worker', required: true, degradable: false },
  postgres: { label: 'PostgreSQL', required: true, degradable: false },
  redis: { label: 'Redis', required: false, degradable: true },
  milvus: { label: 'Milvus', required: false, degradable: true },
  objectStorage: { label: '对象存储', required: true, degradable: false },
};

const workspaceIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const systemHealthValues = new Set<SystemHealth>(['healthy', 'degraded', 'unconfigured', 'unavailable']);
const runtimeRoles = new Set<RuntimeRole>(['api', 'worker', 'all']);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeText(value: unknown, max: number): string {
  return typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value.trim() : '';
}

export function parseWorkspaceDirectory(value: unknown): WorkspaceDirectory {
  const source = record(value);
  if (!source || !Array.isArray(source.items)) throw new Error('workspace 列表格式不完整。');
  const seen = new Set<string>();
  const items = source.items.flatMap(item => {
    const row = record(item);
    const id = safeText(row?.id, 128);
    const name = safeText(row?.name, 160);
    if (!id || !workspaceIdPattern.test(id) || !name || seen.has(id)) return [];
    seen.add(id);
    const slug = safeText(row?.slug, 128);
    return [{ id, name, ...(slug ? { slug } : {}), legacy: row?.legacy === true }];
  });
  const legacyMode = source.legacyMode === true;
  if (legacyMode && items.length === 0) return legacyWorkspaceDirectory();
  const requestedCurrent = safeText(source.currentWorkspaceId, 128);
  const currentWorkspaceId = items.some(item => item.id === requestedCurrent) ? requestedCurrent : null;
  return { items, currentWorkspaceId, legacyMode };
}

export function legacyWorkspaceDirectory(): WorkspaceDirectory {
  return {
    items: [{ id: 'legacy', name: 'Legacy workspace', legacy: true }],
    currentWorkspaceId: 'legacy',
    legacyMode: true,
  };
}

export function parseSystemStatus(value: unknown): SystemStatus {
  const source = record(value);
  const runtimeRole = safeText(source?.runtimeRole, 16) as RuntimeRole;
  if (!source || !runtimeRoles.has(runtimeRole) || !Array.isArray(source.services)) {
    throw new Error('系统状态格式不完整。');
  }
  const byId = new Map<SystemServiceId, SystemServiceStatus>();
  for (const value of source.services) {
    const row = record(value);
    const id = safeText(row?.id, 32) as SystemServiceId;
    const status = safeText(row?.status, 32) as SystemHealth;
    if (!systemServiceIds.includes(id) || !systemHealthValues.has(status) || byId.has(id)) continue;
    const defaults = systemServiceCatalog[id];
    const label = safeText(row?.label, 80) || defaults.label;
    const detail = safeText(row?.detail, 500) || '后端未提供说明。';
    const provider = safeText(row?.provider, 80);
    byId.set(id, {
      id, label, status, required: typeof row?.required === 'boolean' ? row.required : defaults.required,
      detail, ...(provider ? { provider } : {}),
    });
  }
  const services = systemServiceIds.map(id => byId.get(id) ?? {
    id,
    label: systemServiceCatalog[id].label,
    status: 'unavailable' as const,
    required: systemServiceCatalog[id].required,
    detail: '状态接口未返回此服务，当前状态无法确认。',
  });
  return {
    generatedAt: safeText(source.generatedAt, 80),
    runtimeRole,
    services,
  };
}

export class DeploymentApiError extends Error {
  constructor(message: string, public readonly kind: 'unsupported' | 'unreachable' | 'invalid' | 'http', public readonly status = 0) {
    super(message);
    this.name = 'DeploymentApiError';
  }
}

export function readActiveWorkspaceId(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): string | null {
  try {
    const value = storage?.getItem(workspaceStorageKey) ?? '';
    return workspaceIdPattern.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeActiveWorkspaceId(id: string, storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  if (!workspaceIdPattern.test(id)) throw new Error('workspace id 不合法。');
  storage?.setItem(workspaceStorageKey, id);
}

export function clearActiveWorkspaceId(storage: Pick<Storage, 'removeItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  try { storage?.removeItem(workspaceStorageKey); } catch { /* Server-side session state remains authoritative. */ }
}

export function resolveActiveWorkspace(directory: WorkspaceDirectory, storedId = readActiveWorkspaceId()): WorkspaceSummary | null {
  return directory.items.find(item => item.id === storedId)
    ?? directory.items.find(item => item.id === directory.currentWorkspaceId)
    ?? directory.items[0]
    ?? null;
}

function sameOriginApiPath(input: RequestInfo | URL): boolean {
  const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (value.startsWith('/api/')) return true;
  const origin = typeof location !== 'undefined' && /^https?:\/\//iu.test(location.origin) ? location.origin : '';
  if (!origin) return false;
  try {
    const url = new URL(value, origin);
    return url.origin === origin && url.pathname.startsWith('/api/');
  } catch { return false; }
}

export function headersForWorkspace(headers: HeadersInit | undefined, workspaceId: string | null): Headers {
  const next = new Headers(headers);
  if (workspaceId && !next.has('X-Workspace-Id')) next.set('X-Workspace-Id', workspaceId);
  return next;
}

export function readCsrfToken(cookie = typeof document === 'undefined' ? '' : document.cookie): string | null {
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== csrfCookieName) continue;
    try {
      const value = decodeURIComponent(part.slice(separator + 1).trim());
      return /^[^\s\u0000-\u001f\u007f]{8,512}$/u.test(value) ? value : null;
    } catch { return null; }
  }
  return null;
}

export function headersForApiRequest(headers: HeadersInit | undefined, workspaceId: string | null,
  csrfToken: string | null, method = 'GET'): Headers {
  const next = headersForWorkspace(headers, workspaceId);
  const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
  if (mutation && csrfToken && !next.has('X-CSRF-Token')) next.set('X-CSRF-Token', csrfToken);
  return next;
}

/** All browser calls to main go through here so a selected workspace is carried end to end. */
export function workspaceFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  // Never forward tenant or CSRF context to an absolute cross-origin URL,
  // even if its pathname happens to start with /api/.
  if (!sameOriginApiPath(input)) return fetch(input, init);
  const workspaceId = readActiveWorkspaceId();
  const method = (init.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();
  const csrfToken = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? readCsrfToken() : null;
  if (!workspaceId && !csrfToken) return fetch(input, init);
  const inputHeaders = typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined;
  const mergedHeaders = new Headers(inputHeaders);
  new Headers(init.headers).forEach((value, key) => mergedHeaders.set(key, value));
  const headers = headersForApiRequest(mergedHeaders, workspaceId, csrfToken, method);
  return fetch(input, { ...init, headers });
}

async function readResponse(response: Response, subject: string): Promise<unknown> {
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 404) throw new DeploymentApiError(`当前后端尚未提供${subject}接口。`, 'unsupported', 404);
    const row = record(data); const error = record(row?.error);
    const message = safeText(error?.message, 300) || `${subject}请求失败（${response.status}）。`;
    throw new DeploymentApiError(message, 'http', response.status);
  }
  return data;
}

async function deploymentGet(path: string, subject: string, signal?: AbortSignal): Promise<unknown> {
  try {
    return await readResponse(await workspaceFetch(path, { signal, cache: 'no-store' }), subject);
  } catch (error) {
    if (error instanceof DeploymentApiError || error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new DeploymentApiError(`无法连接后端，${subject}尚未验证。`, 'unreachable');
  }
}

export async function fetchWorkspaceDirectory(signal?: AbortSignal): Promise<WorkspaceDirectory> {
  try {
    return parseWorkspaceDirectory(await deploymentGet('/api/workspaces', 'workspace', signal));
  } catch (error) {
    if (error instanceof DeploymentApiError) throw error;
    throw new DeploymentApiError(error instanceof Error ? error.message : 'workspace 列表格式不完整。', 'invalid');
  }
}

export async function fetchSystemStatus(signal?: AbortSignal): Promise<SystemStatus> {
  try {
    return parseSystemStatus(await deploymentGet('/api/system/status', '系统状态', signal));
  } catch (error) {
    if (error instanceof DeploymentApiError) throw error;
    throw new DeploymentApiError(error instanceof Error ? error.message : '系统状态格式不完整。', 'invalid');
  }
}
