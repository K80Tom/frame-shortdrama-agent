import type { RuntimeRole } from '../config';

export type ServiceHealth = 'healthy' | 'degraded' | 'unconfigured' | 'unavailable';
export type SystemServiceId = 'api' | 'worker' | 'postgres' | 'redis' | 'milvus' | 'objectStorage';

export interface ServiceStatus {
  id: SystemServiceId;
  label: string;
  status: ServiceHealth;
  required: boolean;
  detail: string;
  provider?: string;
}

export interface ServiceProbeResult {
  status: ServiceHealth;
  detail: string;
  provider?: string;
}

export interface ServiceProbe {
  required: boolean;
  check: () => Promise<ServiceProbeResult> | ServiceProbeResult;
}

export interface SystemStatusSnapshot {
  generatedAt: string;
  runtimeRole: RuntimeRole;
  readiness: 'ready' | 'not-ready';
  services: ServiceStatus[];
}

const LABELS: Record<SystemServiceId, string> = {
  api: 'API 服务',
  worker: 'Worker',
  postgres: 'PostgreSQL',
  redis: 'Redis',
  milvus: 'Milvus',
  objectStorage: '对象存储',
};

const IDS = Object.freeze(Object.keys(LABELS) as SystemServiceId[]);

function runtimeProbe(id: 'api' | 'worker', role: RuntimeRole): ServiceProbe {
  const active = role === 'all' || role === id;
  return {
    required: active,
    check: () => active
      ? { status: 'healthy', detail: id === 'api' ? '当前进程提供 HTTP API。' : '当前进程负责后台任务。' }
      : { status: 'degraded', detail: `当前进程角色为 ${role}；${id} 由独立进程提供。` },
  };
}

function absent(detail: string, required: boolean): ServiceProbe {
  return { required, check: () => ({ status: 'unconfigured', detail }) };
}

/** A sanitized status surface shared by health probes and the settings UI. */
export class SystemStatusService {
  private readonly probes: Record<SystemServiceId, ServiceProbe>;

  constructor(readonly runtimeRole: RuntimeRole, probes: Partial<Record<SystemServiceId, ServiceProbe>> = {}) {
    this.probes = {
      api: probes.api ?? runtimeProbe('api', runtimeRole),
      worker: probes.worker ?? runtimeProbe('worker', runtimeRole),
      postgres: probes.postgres ?? absent('PostgreSQL 尚未配置。', true),
      redis: probes.redis ?? absent('Redis 尚未配置；对话暂时直接回源 PostgreSQL。', false),
      milvus: probes.milvus ?? absent('Milvus 尚未配置；检索降级为词法模式。', false),
      objectStorage: probes.objectStorage ?? absent('对象存储尚未配置。', true),
    };
  }

  async snapshot(now = new Date()): Promise<SystemStatusSnapshot> {
    const services = await Promise.all(IDS.map(async id => {
      const probe = this.probes[id];
      try {
        const result = await probe.check();
        return { id, label: LABELS[id], required: probe.required, ...result } satisfies ServiceStatus;
      } catch {
        return { id, label: LABELS[id], required: probe.required, status: 'unavailable',
          detail: `${LABELS[id]}健康检查失败；详细原因只记录在服务端脱敏日志。` } satisfies ServiceStatus;
      }
    }));
    const readiness = services.some(service => service.required && service.status !== 'healthy')
      ? 'not-ready' : 'ready';
    return { generatedAt: now.toISOString(), runtimeRole: this.runtimeRole, readiness, services };
  }
}

export function staticProbe(required: boolean, result: ServiceProbeResult): ServiceProbe {
  return { required, check: () => result };
}
