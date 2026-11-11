import { useEffect, useState } from 'react';
import type { PlatformPreflightReport } from '@lyra/shared/dist/platform-preflight';
import { productionApi } from './production-automation';

function parsePlatformPreflightReport(value: unknown): PlatformPreflightReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('运行前检查响应无效。');
  const r = value as Partial<PlatformPreflightReport>;
  if (r.schemaVersion !== 'lyra-platform-preflight/1' || !Array.isArray(r.checks) || typeof r.status !== 'string') {
    throw new TypeError('运行前检查响应无效。');
  }
  return value as PlatformPreflightReport;
}

const labels = { ready: '本地检查通过', degraded: '部分能力降级', blocked: '发现阻断项' };
export function PlatformReadinessPanel() {
  const [report, setReport] = useState<PlatformPreflightReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => controller.abort(), 5000);
    setLoading(true); setFailed(false);
    void productionApi('/api/platform/preflight', undefined, controller.signal)
      .then(parsePlatformPreflightReport)
      .then(value => {
        if (controller.signal.aborted) return;
        setReport(value);
        refresh = setTimeout(() => setRevision(n => n + 1),
          Math.max(1000, Math.min(60000, Date.parse(value.expiresAt) - Date.now())));
      })
      .catch(() => { if (!disposed) { setReport(null); setFailed(true); } })
      .finally(() => { clearTimeout(timeout); if (!disposed) setLoading(false); });
    let disposed = false;
    return () => { disposed = true; controller.abort(); clearTimeout(timeout); clearTimeout(refresh); };
  }, [revision]);
  return <section aria-labelledby="pa-readiness-title" aria-busy={loading}>
    <h3 id="pa-readiness-title">运行前能力检查</h3>
    <p>此为当前后端进程的诊断提示，不是付费授权。API/Worker 分进程时还需核对系统状态；不代表供应商可用性或内容质量已验证。</p>
    <p role="status">{loading ? '正在检查…' : failed ? '未取得有效检查结果，请先检查后端状态。' : report ? labels[report.status] : '尚未检查'}</p>
    {!loading && report && <ul>{report.checks.map(check => <li key={check.id}>
      <strong>{check.id}</strong> · {check.required ? '必需' : '可选'} · {labels[check.status]}
      {check.paid ? ' · 使用时可能收费' : ''}<br />
      影响阶段：{check.stages.join('、')}。{check.action}
    </li>)}</ul>}
    <button type="button" disabled={loading} onClick={() => setRevision(n => n + 1)}>重新检查</button>
  </section>;
}
