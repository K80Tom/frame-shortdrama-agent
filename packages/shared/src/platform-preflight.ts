export const PLATFORM_CHECK_IDS = [
  'database', 'migrations', 'media-directory', 'media-service', 'ffmpeg', 'ffprobe',
  'model-breakdown', 'model-video', 'model-image', 'model-general', 'vector', 'production-runtime',
] as const;
export type PlatformCheckId = typeof PLATFORM_CHECK_IDS[number];
export type PlatformReadinessStatus = 'ready' | 'degraded' | 'blocked';
export interface PlatformCapabilityCheck {
  id: PlatformCheckId;
  required: boolean;
  paid: boolean;
  status: PlatformReadinessStatus;
  code: string;
  stages: string[];
  action: string;
}
export interface PlatformPreflightReport {
  schemaVersion: 'lyra-platform-preflight/1';
  checkedAt: string;
  expiresAt: string;
  status: PlatformReadinessStatus;
  providerAvailabilityChecked: false;
  paidCallsMade: 0;
  checks: PlatformCapabilityCheck[];
}

/** HTTP 消费方共享的闭合校验；不得把 healthz 存活误作生产能力就绪。 */
export function parsePlatformPreflightReport(value: unknown): PlatformPreflightReport {
  function invalid(): never { throw new TypeError('运行前检查响应无效。'); }
  function object(item: unknown, keys: string[]): Record<string, unknown> {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid();
    const r = item as Record<string, unknown>;
    if (Object.keys(r).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(r, k))) invalid();
    return r;
  }
  function time(item: unknown): string {
    if (typeof item !== 'string' || item.length !== 24 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(item)
      || !Number.isFinite(Date.parse(item)) || new Date(item).toISOString() !== item) invalid();
    return item;
  }
  const r = object(value, ['schemaVersion', 'checkedAt', 'expiresAt', 'status', 'providerAvailabilityChecked', 'paidCallsMade', 'checks']);
  if (r.schemaVersion !== 'lyra-platform-preflight/1' || r.providerAvailabilityChecked !== false || r.paidCallsMade !== 0
    || !Array.isArray(r.checks) || r.checks.length !== PLATFORM_CHECK_IDS.length) invalid();
  const checkedAt = time(r.checkedAt), expiresAt = time(r.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(checkedAt) || Date.parse(expiresAt) - Date.parse(checkedAt) > 60_000) invalid();
  const stages = ['prepare', 'breakdown', 'assets', 'storyboard', 'director', 'video', 'candidates', 'review', 'compose', 'deliver'];
  const checks = (r.checks as unknown[]).map(item => {
    const c = object(item, ['id', 'required', 'paid', 'status', 'code', 'stages', 'action']);
    if (!PLATFORM_CHECK_IDS.includes(c.id as PlatformCheckId) || typeof c.required !== 'boolean' || typeof c.paid !== 'boolean'
      || !['ready', c.required ? 'blocked' : 'degraded'].includes(c.status as string)
      || typeof c.code !== 'string' || c.code.length > 80 || !/^[A-Z_]+$/u.test(c.code) || /[\r\n]/u.test(c.code)
      || typeof c.action !== 'string' || !c.action.trim() || c.action.length > 200
      || !Array.isArray(c.stages) || !c.stages.length || c.stages.length > stages.length
      || c.stages.some(stage => !stages.includes(stage)) || new Set(c.stages).size !== c.stages.length) invalid();
    return { id: c.id, required: c.required, paid: c.paid, status: c.status, code: c.code,
      stages: [...c.stages], action: c.action } as PlatformCapabilityCheck;
  });
  if (new Set(checks.map(c => c.id)).size !== PLATFORM_CHECK_IDS.length) invalid();
  const status = checks.some(c => c.status === 'blocked') ? 'blocked'
    : checks.some(c => c.status === 'degraded') ? 'degraded' : 'ready';
  if (r.status !== status) invalid();
  return { schemaVersion: 'lyra-platform-preflight/1', checkedAt, expiresAt, status,
    providerAvailabilityChecked: false, paidCallsMade: 0, checks };
}
