import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Cloud, Cpu, Database, HardDrive, LoaderCircle, RefreshCw, Server, Waypoints } from 'lucide-react';
import {
  DeploymentApiError, fetchSystemStatus, systemServiceCatalog, systemServiceIds,
  type SystemHealth, type SystemServiceId, type SystemServiceStatus, type SystemStatus,
} from './deployment';
import './deployment.css';

const healthLabels: Record<SystemHealth, string> = {
  healthy: 'Healthy', degraded: 'Degraded', unconfigured: 'Unconfigured', unavailable: 'Unavailable',
};
const serviceIcons: Record<SystemServiceId, typeof Server> = {
  api: Server, worker: Cpu, postgres: Database, redis: Waypoints, milvus: HardDrive, objectStorage: Cloud,
};

function statusMessage(error: unknown): string {
  if (error instanceof DeploymentApiError && error.kind === 'unsupported') {
    return '当前后端尚未提供系统状态接口；下方服务均标记为未验证，不代表已经停机。';
  }
  return error instanceof Error ? error.message : '系统状态暂不可用。';
}

export function unavailableSystemStatus(): SystemStatus {
  return {
    generatedAt: '', runtimeRole: null,
    services: systemServiceIds.map(id => ({ id, label: systemServiceCatalog[id].label, status: 'unavailable', required: systemServiceCatalog[id].required, detail: '尚未从后端取得状态。' })),
  };
}

export function SystemStatusView({ status, loading, error, onRetry }: { status: SystemStatus; loading: boolean; error: string; onRetry: () => void }) {
  const degraded = status.services.filter(service => service.status !== 'healthy').length;
  return <section className="deployment-status" aria-labelledby="deployment-status-title" aria-busy={loading}>
    <header><div><span className="deployment-kicker">DEPLOYMENT STATUS</span><h2 id="deployment-status-title">系统状态</h2><p>这里只展示 API 报告的依赖探针；探针正常不代表队列已清空、数据已全量回填、历史投影已完成或故障演练已通过。</p></div>
      <div className="deployment-actions"><span className={`deployment-summary ${error ? 'is-unavailable' : degraded ? 'is-degraded' : 'is-healthy'}`}>{loading ? <LoaderCircle size={13} className="deployment-spin" /> : error ? <AlertCircle size={13} /> : degraded ? <AlertCircle size={13} /> : <CheckCircle2 size={13} />}{loading ? '读取中' : error ? '状态未验证' : degraded ? `${degraded} 项需关注` : '探针均正常'}</span><button onClick={onRetry} disabled={loading}><RefreshCw size={13} />刷新</button></div>
    </header>
    {error && <div className="deployment-error" role="alert"><AlertCircle size={16} /><p>{error}</p></div>}
    <div className="deployment-service-grid">
      {status.services.map(service => <ServiceCard key={service.id} service={service} />)}
    </div>
    <div className="deployment-policies">
      <article><Waypoints size={17} /><div><strong>Redis 的职责与失败边界</strong><p>完整对话仍以 PostgreSQL 为准；session 部署配置 Redis 后才使用共享快照与登录/API 限流，限流依赖故障时失败关闭。SSE fan-out 尚未接入。</p></div></article>
      <article><HardDrive size={17} /><div><strong>Milvus 投影需要显式启用</strong><p>持久化索引任务已接线；只有开启 <code>ASSET_VECTOR_ENABLED</code> 并完整配置 Embedding 时才会运行，且可能产生费用。默认关闭时仍走词法检索。</p></div></article>
      <article><Cloud size={17} /><div><strong>对象存储能力与签名边界</strong><p>每个环境只选 MinIO、S3、OSS 或 COS 之一。当前接入的是生产视频/成片，导入资产图片尚未完成对象化迁移。后端报告探针正常只说明 bucket 可访问，不证明历史对象已全部投影，也不证明签名 URL 已能从公网浏览器访问。</p></div></article>
      <article><Cpu size={17} /><div><strong>Worker 状态来自数据库心跳</strong><p>Worker 不开放 HTTP 管理端口；API 读取 PostgreSQL 中未过期的心跳来判断它是否在线。</p></div></article>
    </div>
    <footer><span>运行角色：{status.runtimeRole ?? '尚未确认'}</span><span>{status.generatedAt ? `状态生成：${new Date(status.generatedAt).toLocaleString('zh-CN')}` : '尚无已验证时间'}</span></footer>
  </section>;
}

function ServiceCard({ service }: { service: SystemServiceStatus }) {
  const Icon = serviceIcons[service.id];
  const degradable = !service.required && systemServiceCatalog[service.id].degradable;
  return <article className={`deployment-service is-${service.status}`}>
    <div className="deployment-service-top"><span><Icon size={17} /></span><div><strong>{service.label}</strong><small>{service.id === 'objectStorage' ? service.provider || 'provider 未选择' : service.required ? '核心服务' : degradable ? '可降级服务' : '服务'}</small></div><em>{healthLabels[service.status]}</em></div>
    <p>{service.detail}</p>
    {degradable && <span className="deployment-degrade-note">异常时进入受控降级</span>}
  </article>;
}

export default function SystemStatusPanel() {
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<SystemStatus>(unavailableSystemStatus);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void fetchSystemStatus(controller.signal).then(value => {
      if (!controller.signal.aborted) { setStatus(value); setLoading(false); }
    }).catch(cause => {
      if (!controller.signal.aborted) { setStatus(unavailableSystemStatus()); setError(statusMessage(cause)); setLoading(false); }
    });
    return () => controller.abort();
  }, [revision]);
  return <SystemStatusView status={status} loading={loading} error={error} onRetry={() => setRevision(value => value + 1)} />;
}
