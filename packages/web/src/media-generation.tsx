import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, ArrowUpRight, CheckCircle2, LoaderCircle, Settings2, Sparkles } from 'lucide-react';
import { Modal } from './components';
import {
  parseProductionRun, parseProductionRuns, productionApi, ProductionApiError, productionRunActive,
  type ProductionRun,
} from './production-automation';
import './media-generation.css';

export type MediaModelConnection = { configured: boolean; model: string };
export type MediaModelConnections = { image: MediaModelConnection; video: MediaModelConnection };
const emptyConnections: MediaModelConnections = { image: { configured: false, model: '' }, video: { configured: false, model: '' } };

export async function fetchMediaModelConnections(): Promise<MediaModelConnections> {
  const value = await productionApi('/api/model-connections') as { connections?: Array<{ role?: unknown; configured?: unknown; model?: unknown }> };
  const result = structuredClone(emptyConnections);
  for (const row of value.connections ?? []) {
    if (row.role !== 'image' && row.role !== 'video') continue;
    result[row.role] = { configured: row.configured === true, model: typeof row.model === 'string' ? row.model : '' };
  }
  return result;
}

const runStatusLabels: Record<string, string> = {
  queued: '等待开始', running: '生成中', waitingHuman: '需要处理', paused: '已暂停', pausedBudget: '预算已暂停',
  reconciling: '正在核对供应商结果', completed: '已完成', partial: '部分完成', failed: '未完成', cancelled: '已取消',
};

export function useMediaProductionRun(projectId: string, kind: 'image' | 'video') {
  const [run, setRun] = useState<ProductionRun | null>(null);
  const [pendingId, setPendingId] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const activeKey = `lyra:${kind}-production-active:${projectId}`;
  const pendingKey = `lyra:${kind}-production-pending:${projectId}`;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    setRun(null); setPendingId(''); setError('');
    let activeId = ''; let pending = '';
    try { activeId = sessionStorage.getItem(activeKey) ?? ''; pending = sessionStorage.getItem(pendingKey) ?? ''; } catch { /* Server history remains available. */ }
    if (pending) setPendingId(pending);
    if (!activeId && !pending) return () => { mounted.current = false; };
    const controller = new AbortController();
    if (activeId) {
      void productionApi(`/api/production-runs/${encodeURIComponent(activeId)}`, undefined, controller.signal)
        .then(value => { if (mounted.current) setRun(parseProductionRun(value)); })
        .catch(() => { try { sessionStorage.removeItem(activeKey); } catch { /* no-op */ } });
    }
    return () => { mounted.current = false; controller.abort(); };
  }, [projectId, kind]); // Storage keys are derived from this identity.

  useEffect(() => {
    if (!pendingId && (!run || !productionRunActive(run))) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout> | undefined; let controller: AbortController | undefined;
    async function poll() {
      controller = new AbortController();
      try {
        if (pendingId) {
          const runs = parseProductionRuns(await productionApi('/api/production-runs', undefined, controller.signal));
          const recovered = runs.find(item => item.clientRequestId === pendingId);
          if (recovered && !disposed) {
            setRun(recovered); setPendingId(''); setError('');
            try { sessionStorage.setItem(activeKey, recovered.id); sessionStorage.removeItem(pendingKey); } catch { /* no-op */ }
          }
        } else if (run) {
          const latest = parseProductionRun(await productionApi(`/api/production-runs/${encodeURIComponent(run.id)}`, undefined, controller.signal));
          if (!disposed) { setRun(latest); setError(''); }
        }
      } catch (cause) {
        if (!disposed && !(cause instanceof DOMException && cause.name === 'AbortError')) {
          setError(cause instanceof Error ? `进度读取失败：${cause.message}` : '进度读取失败，请稍后刷新。');
        }
      }
      if (!disposed) timer = setTimeout(() => void poll(), 2500);
    }
    void poll();
    return () => { disposed = true; if (timer) clearTimeout(timer); controller?.abort(); };
  }, [run?.id, run?.status, run?.version, pendingId, activeKey, pendingKey]);

  async function start(buildBody: (clientRequestId: string) => unknown) {
    if (creating || pendingId || (run && productionRunActive(run))) return null;
    const clientRequestId = crypto.randomUUID();
    setCreating(true); setError('');
    try { sessionStorage.setItem(pendingKey, clientRequestId); } catch { setCreating(false); setError('浏览器无法保存本次请求标识，尚未提交。'); return null; }
    setPendingId(clientRequestId);
    try {
      const created = parseProductionRun(await productionApi('/api/production-runs', buildBody(clientRequestId)));
      setRun(created); setPendingId('');
      try { sessionStorage.setItem(activeKey, created.id); sessionStorage.removeItem(pendingKey); } catch { /* no-op */ }
      return created;
    } catch (cause) {
      if (cause instanceof ProductionApiError) {
        setPendingId('');
        try { sessionStorage.removeItem(pendingKey); } catch { /* no-op */ }
        setError(cause.message);
      } else setError('创建结果尚未确认。系统正在按请求编号核对，不会自动重复创建。');
      return null;
    } finally { if (mounted.current) setCreating(false); }
  }

  return { run, creating: creating || Boolean(pendingId), error, start, clearError: () => setError('') };
}

export function MediaGenerationDialog({ open, kind, title, description, facts, model, busy, onClose, onConfirm }: {
  open: boolean;
  kind: 'image' | 'video';
  title: string;
  description: string;
  facts: Array<{ label: string; value: string }>;
  model: MediaModelConnection | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (budgetYuan: number) => void;
}) {
  const [allowPaid, setAllowPaid] = useState(false);
  const [budgetYuan, setBudgetYuan] = useState(20);
  useEffect(() => { if (open) { setAllowPaid(false); setBudgetYuan(20); } }, [open, title]);
  const mediaLabel = kind === 'image' ? '图片' : '视频';
  return <Modal open={open} title={title} onClose={() => { if (!busy) onClose(); }} className="media-generate-modal">
    <div className="media-generate-intro"><Sparkles size={22} /><p>{description}</p></div>
    <dl className="media-generate-facts">{facts.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
    <label className="media-budget-field"><span>本次预算上限（元）</span><input aria-label="本次预算上限" type="number" min={1} max={1000} step={1}
      value={budgetYuan} disabled={busy} onChange={event => setBudgetYuan(Number(event.target.value))} /></label>
    <p className="media-generate-note">使用当前{mediaLabel}模型真实生成。任务会保存进度；本次不会额外启动另一类媒体生成。</p>
    {model && !model.configured && <div className="media-model-warning" role="alert"><AlertCircle size={15} />
      <span>当前{mediaLabel}模型尚未配置，不能发起生成。</span><a href="#/settings/models"><Settings2 size={13} />去配置</a></div>}
    <label className="media-paid-check"><input type="checkbox" checked={allowPaid} disabled={busy || !model?.configured}
      onChange={event => setAllowPaid(event.target.checked)} /><span>我已核对生成范围与预算，授权本次真实模型调用及可能产生的费用。</span></label>
    <div className="media-generate-actions"><button disabled={busy} onClick={onClose}>取消</button>
      <button className="primary" disabled={!allowPaid || busy || !model?.configured || !Number.isFinite(budgetYuan) || budgetYuan <= 0 || budgetYuan > 1000}
        onClick={() => onConfirm(budgetYuan)}>{busy ? <LoaderCircle className="media-spin" size={15} /> : <Sparkles size={15} />}{busy ? '正在创建…' : `确认并生成${mediaLabel}`}</button></div>
  </Modal>;
}

export function MediaRunNotice({ run, projectId, successText, children }: { run: ProductionRun; projectId: string; successText: string; children?: ReactNode }) {
  const issue = run.issues.find(item => item.status === 'open');
  const modelIssue = issue && /MODEL_NOT_CONFIGURED|CAPABILITY_UNAVAILABLE/u.test(issue.code);
  return <section className={`media-run-notice media-run-${run.status}`} role={run.status === 'failed' || run.status === 'partial' ? 'alert' : 'status'}>
    <div className="media-run-heading">{run.status === 'completed' ? <CheckCircle2 size={16} /> : run.status === 'failed' || run.status === 'partial' ? <AlertCircle size={16} /> : <LoaderCircle className="media-spin" size={16} />}
      <strong>{runStatusLabels[run.status] ?? run.status}</strong><span>{run.summary.tasks.completed}/{run.summary.tasks.total} 节点完成</span>
      <a href={`#/projects/${projectId}/production`}>查看任务<ArrowUpRight size={12} /></a></div>
    <p>{issue?.message ?? (run.status === 'completed' ? successText : '生成任务已在服务端保存，可以留在本页等待，也可以稍后回来查看。')}</p>
    {modelIssue && <a className="media-run-settings" href="#/settings/models"><Settings2 size={12} />配置模型后，在任务详情中局部重试</a>}
    {children}
  </section>;
}
