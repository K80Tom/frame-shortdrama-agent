import { useEffect, useRef, useState } from 'react';
import { Check, ImagePlus, RefreshCw, X } from 'lucide-react';
import type { NovelItem, NovelRevision } from './novel-editor';
import {
  createDesktopGenerationIntentId, desktopAssetApi, desktopDecisionRequest, desktopGenerationBlock, desktopGenerationRequest,
  desktopPermissionHelp, desktopSubmissionRecovered, desktopTaskActive, desktopTaskLabels, freshestDesktopTask, taskForItem, tasksForItem,
  type DesktopAssetPreview, type DesktopStatus, type DesktopTask,
  type DesktopVisualBrief,
} from './desktop-asset-generation';
import './desktop-asset-generation.css';

export function useDesktopAssetTasks(chapterId: string) {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [tasks, setTasks] = useState<DesktopTask[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    setTasks([]); setStatus(null); setError(''); setLoading(Boolean(chapterId));
    if (!chapterId) return;
    async function poll() {
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 12000);
      try {
        const [nextStatus, result] = await Promise.all([
          desktopAssetApi<DesktopStatus>('/api/asset-generation/status', undefined, controller.signal),
          desktopAssetApi<{ tasks: DesktopTask[] }>(`/api/asset-generation?chapterId=${encodeURIComponent(chapterId)}`, undefined, controller.signal),
        ]);
        if (disposed) return;
        setStatus(nextStatus); setTasks(result.tasks); setError('');
      } catch (cause) {
        if (disposed) return;
        controller.abort();
        setStatus(null); setError(cause instanceof Error && cause.name !== 'AbortError' ? cause.message : '生图连接状态读取超时，请检查本地后端。');
      } finally {
        clearTimeout(timeout);
        if (!disposed) { setLoading(false); timer = setTimeout(() => void poll(), 4000); }
      }
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); };
  }, [chapterId, refresh]);
  return { status, tasks, error, loading, refresh: () => setRefresh(value => value + 1) };
}
export type DesktopAssetState = ReturnType<typeof useDesktopAssetTasks>;

function resultSize(byteLength: number): string {
  if (byteLength < 1024) return `${byteLength} B`;
  if (byteLength < 1024 * 1024) return `${(byteLength / 1024).toFixed(1)} KB`;
  return `${(byteLength / 1024 / 1024).toFixed(1)} MB`;
}

function providerLabel(provider: 'api' | 'desktop' | 'unknown'): string {
  return provider === 'api' ? 'API' : provider === 'desktop' ? '桌面工作台' : '历史来源未记录';
}

export function DesktopVisualBriefView({ brief }: { brief: DesktopVisualBrief }) {
  const confidence = `${Math.round(brief.confidence <= 1 ? brief.confidence * 100 : brief.confidence)}%`;
  return <div className="desktop-visual-brief">
    <div className="desktop-visual-brief-title"><strong>{brief.name}</strong><span>{brief.schemaVersion} · 置信度 {confidence}</span></div>
    <h5>已确认事实</h5>
    {brief.confirmedFacts.length ? <ul>{brief.confirmedFacts.map((fact, index) => <li key={index}>{fact}</li>)}</ul> : <p>暂无可用的已确认事实。</p>}
    <h5>原文证据</h5>
    {brief.evidence.length ? brief.evidence.map(evidence => <blockquote key={evidence.evidenceId}><strong>{evidence.evidenceId}</strong><small>{evidence.documentId} · {evidence.start}–{evidence.end}</small>{evidence.quote}</blockquote>) : <p>暂无原文证据，不应发起付费生成。</p>}
    <h5>可设计变量（不是小说事实）</h5>
    {brief.designVariables.length ? <dl>{brief.designVariables.map(variable => <div key={variable.field}><dt>{variable.field}</dt><dd>{variable.guidance}</dd></div>)}</dl> : <p>无额外可设计变量。</p>}
    <h5>负面约束</h5>
    {brief.negativeConstraints.length ? <ul>{brief.negativeConstraints.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p>无额外负面约束。</p>}
    <h5>待确认项</h5>
    {brief.pendingConfirmations.length ? <ul className="desktop-asset-pending-list">{brief.pendingConfirmations.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p>无待确认项。</p>}
  </div>;
}

export function DesktopTaskCard({ task, busy, onReconcile, onDecision }: {
  task: DesktopTask; busy: boolean; onReconcile: () => void;
  onDecision?: (decision: 'accept' | 'reject', note: string) => void;
}) {
  const [note, setNote] = useState(task.candidate?.reviewNote ?? '');
  const active = desktopTaskActive(task);
  const candidate = task.candidate;
  const candidateAssetId = candidate?.assetId ?? task.assetId;
  const reviewable = task.status === 'awaitingReview' && candidate?.status === 'awaitingReview';
  const canReconcile = ['submitting', 'generating', 'importing', 'unknown'].includes(task.status);
  return <article className={`desktop-asset-task desktop-asset-task-${task.status}`} aria-label="资产生图任务" aria-live="polite">
    <div className="desktop-asset-task-title"><strong>{desktopTaskLabels[task.status]}</strong><small>{task.label}</small></div>
    <p>{task.message || (active ? '任务已保存，正在等待模型结果。' : '请核对任务成果。')}</p>
    <small>任务 {task.id} · {new Date(task.updatedAt).toLocaleString()}</small>
    {candidateAssetId && <div className="desktop-asset-candidate">
      <img src={`/api/assets/${encodeURIComponent(candidateAssetId)}/content`} alt={`${task.label}的生成候选图`} loading="lazy" />
      {candidate && <div className="desktop-asset-provenance" aria-label="候选图生成摘要">
        <span>{providerLabel(candidate.provenance.provider)} · {candidate.provenance.model || '未报告模型名'}</span>
        <span>提示词版本 {candidate.provenance.promptVersion}</span>
        <span>{candidate.provenance.result.mimeType} · {resultSize(candidate.provenance.result.bytes)}</span>
        <code title={candidate.provenance.result.sha256}>SHA-256 {candidate.provenance.result.sha256.slice(0, 16)}…</code>
      </div>}
      <p><a href="#/assets">{task.status === 'accepted' || task.status === 'completed' ? '查看已关联的资产' : '在资产库查看此候选'} ↗</a><code>{candidateAssetId}</code></p>
    </div>}
    {reviewable && <div className="desktop-asset-decision">
      <label><span>审核备注（可选）</span><textarea value={note} disabled={busy} maxLength={500}
        placeholder="记录接受原因、需改进的外观或重新生成要求。" onChange={event => setNote(event.target.value)} /></label>
      <div className="desktop-asset-decision-actions">
        <button className="novel-primary" disabled={busy || !onDecision} onClick={() => onDecision?.('accept', note)}><Check size={13} />确认并关联</button>
        <button disabled={busy || !onDecision} onClick={() => onDecision?.('reject', note)}><X size={13} />拒绝此候选</button>
      </div>
      <small>只有确认后才会关联到当前小说条目；拒绝不会删除历史，也不阻止下次显式生成。</small>
    </div>}
    {candidate?.reviewNote && !reviewable && <p className="desktop-asset-review-note">审核备注：{candidate.reviewNote}</p>}
    {canReconcile && <div className="novel-row"><button disabled={busy} onClick={onReconcile}><RefreshCw size={12} />检查已有结果并导回</button><small>只核对本次任务，不重新生图。</small></div>}
    {(task.status === 'unknown' || task.status === 'failed') && <p className="desktop-asset-caution">未自动重试。请先核对供应商任务与现有成果，避免重复消耗 API 额度。</p>}
    {task.status === 'failed' && <p className="desktop-asset-caution">仅提交前停止可再次尝试；已有提交记录不重发。再次尝试需要重新勾选额度授权，服务端会核对是否安全。</p>}
    {task.status === 'needsReview' && <p className="desktop-asset-caution">小说版本、校对事实、原文证据或资产关联可能已变化，也可能是上次接受未能在原基准完成。该旧候选只保留作为历史，不能直接关联。你可以按当前版本重新生成候选；如果已有合适的人工作品，请在资产库另行导入或登记后再选择。</p>}
  </article>;
}

export default function DesktopAssetGeneration({ item, revision, editable, dirty, busy, assetDraftDirty, desktop }: {
  item: NovelItem; revision: NovelRevision; editable: boolean; dirty: boolean; busy: boolean; assetDraftDirty: boolean; desktop: DesktopAssetState;
}) {
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [localTask, setLocalTask] = useState<DesktopTask | null>(null);
  const [submissionUnknown, setSubmissionUnknown] = useState(false);
  const [preview, setPreview] = useState<DesktopAssetPreview | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const pending = useRef(false);
  const pendingIntentId = useRef<string | null>(null);
  const submitBaseline = useRef<DesktopTask | null>(null);
  const mounted = useRef(true);
  const taskFromServer = taskForItem(desktop.tasks, item.id);
  const taskHistory = tasksForItem(localTask
    ? [...desktop.tasks.filter(value => value.id !== localTask.id), freshestDesktopTask(desktop.tasks.find(value => value.id === localTask.id) ?? null, localTask)!]
    : desktop.tasks, item.id);
  const task = taskHistory[0] ?? null;
  const generationBlockingTask = taskHistory.find(value => desktopTaskActive(value) || value.status === 'unknown') ?? task;
  const block = desktopGenerationBlock(item, revision, { editable, dirty, busy: busy || submitting, assetDraftDirty,
    status: desktop.status, task: generationBlockingTask, loading: desktop.loading });
  const permissionHelp = desktopPermissionHelp(desktop.status);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (block) setConsent(false); }, [block]);
  useEffect(() => {
    if (!submissionUnknown || !desktopSubmissionRecovered(taskFromServer, submitBaseline.current, item.id, revision.id)) return;
    setSubmissionUnknown(false); setConsent(false);
    pendingIntentId.current = null;
    setLocalTask(previous => freshestDesktopTask(taskFromServer, previous));
    setMessage('已从服务器保存的任务恢复状态，不会重新提交生图。');
  }, [submissionUnknown, taskFromServer, item.id, revision.id]);
  useEffect(() => {
    if (!previewOpen || item.kind === 'dialogue') return;
    let disposed = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    setPreviewError('');
    void desktopAssetApi<DesktopAssetPreview>(`/api/novel-revisions/${encodeURIComponent(revision.id)}/items/${encodeURIComponent(item.id)}/asset-generation-preview`, undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) setPreview(result); })
      .catch(cause => { if (!disposed) setPreviewError(cause instanceof Error && cause.name !== 'AbortError' ? cause.message : '描述预览读取超时，请重新展开。'); })
      .finally(() => clearTimeout(timeout));
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); };
  }, [previewOpen, revision.id, item.id, item.kind]);

  async function start() {
    if (block || !consent || pending.current || pendingIntentId.current || submissionUnknown) return;
    submitBaseline.current = task;
    const intentId = createDesktopGenerationIntentId();
    pendingIntentId.current = intentId;
    pending.current = true; setSubmitting(true); setConsent(false); setMessage('');
    try {
      const result = await desktopAssetApi<DesktopTask>(`/api/novel-revisions/${encodeURIComponent(revision.id)}/asset-generation`,
        desktopGenerationRequest(item.id, revision.id, desktop.status, intentId));
      pendingIntentId.current = null;
      if (mounted.current) { setLocalTask(result); setMessage('候选生成任务已保存。成图后需要人工确认才会关联。'); desktop.refresh(); }
    } catch (cause) {
      if (mounted.current) {
        setSubmissionUnknown(true); desktop.refresh();
        setMessage(`${cause instanceof Error ? cause.message : '未收到提交结果。'} 已停止重复提交，请先检查已有任务。`);
      }
    } finally { pending.current = false; if (mounted.current) setSubmitting(false); }
  }
  async function reconcile(target: DesktopTask) {
    if (pending.current) return;
    pending.current = true; setSubmitting(true); setMessage('');
    try {
      const result = await desktopAssetApi<DesktopTask>(`/api/asset-generation/${encodeURIComponent(target.id)}/reconcile`, {});
      if (mounted.current) { setLocalTask(result); desktop.refresh(); }
    } catch (cause) { if (mounted.current) setMessage(cause instanceof Error ? cause.message : '未能核对已有结果，不会重新提交。'); }
    finally { pending.current = false; if (mounted.current) setSubmitting(false); }
  }
  async function decide(target: DesktopTask, decision: 'accept' | 'reject', note: string) {
    if (pending.current || target.status !== 'awaitingReview') return;
    pending.current = true; setSubmitting(true); setMessage('');
    try {
      const result = await desktopAssetApi<DesktopTask>(`/api/asset-generation/${encodeURIComponent(target.id)}/decision`,
        desktopDecisionRequest(decision, revision.id, note));
      if (mounted.current) {
        setLocalTask(result); setConsent(false); desktop.refresh();
        setMessage(decision === 'accept'
          ? '已确认候选并请求关联。只有当前页面没有草稿、历史版本或其他操作时才会安全刷新。'
          : '已拒绝此候选并保留记录。如需新候选，请重新勾选额度授权并再次生成。');
      }
    } catch (cause) { if (mounted.current) setMessage(cause instanceof Error ? cause.message : '未能保存候选审核决定。'); }
    finally { pending.current = false; if (mounted.current) setSubmitting(false); }
  }
  if (item.kind === 'dialogue') return null;
  const visualBrief = preview?.visualBrief ?? preview;
  return <section className="desktop-asset-generation" aria-label="使用已配置的生图 API 生成候选资产">
    <div className="desktop-asset-heading"><div><ImagePlus size={16} /><h4>没有合适素材？生成候选，确认后关联</h4></div><span>{desktop.status?.model || '当前生图模型'}</span></div>
    <p>自动整理已确认的事实与原文证据，调用设置中选定的生图模型生成 1 张候选图。成图会保留在历史中，只有人工确认后才关联此项。</p>
    <div className="desktop-asset-status"><span className={desktop.status?.available ? 'ready' : ''}>{desktop.loading ? '正在检查生图连接…' : desktop.status?.available ? '生图连接可用' : '生图连接未就绪'}</span><button disabled={submitting || desktop.loading} onClick={desktop.refresh}><RefreshCw size={12} />刷新状态</button></div>
    {permissionHelp && <p className="desktop-asset-caution" role="status">{permissionHelp}</p>}
    {desktop.error && <p className="novel-errors" role="alert">{desktop.error}</p>}
    <details open={previewOpen} onToggle={event => setPreviewOpen(event.currentTarget.open)} className="desktop-asset-preview"><summary>查看视觉简报、原文证据与设计边界</summary>
      {preview ? <>{visualBrief ? <DesktopVisualBriefView brief={visualBrief} /> : <><h5>已确认的事实描述</h5><p>{preview.description}</p><h5>原文依据</h5>{preview.sourceQuotes.map((quote, index) => <blockquote key={index}>{quote}</blockquote>)}<h5>视觉设计（不是新增小说事实）</h5><p>{preview.designNotes}</p></>}
        <details><summary>生图内容预览</summary><pre>{preview.promptPreview}</pre></details></> : <p>{previewError || '正在读取描述预览…'}</p>}
    </details>
    {taskHistory.length > 0 && <section className="desktop-asset-history" aria-label="候选生成历史">
      <div className="desktop-asset-history-heading"><h5>候选与任务历史</h5><span>{taskHistory.length} 条</span></div>
      {taskHistory.map(historyTask => <DesktopTaskCard key={historyTask.id} task={historyTask}
        busy={busy || submitting || !editable || assetDraftDirty} onReconcile={() => void reconcile(historyTask)}
        onDecision={(decision, note) => void decide(historyTask, decision, note)} />)}
    </section>}
    {block && block !== desktop.status?.message && <p className="novel-note" role="status">{block}</p>}
    {message && <p className={submissionUnknown ? 'novel-errors' : 'novel-note'} role={submissionUnknown ? 'alert' : 'status'}>{message}</p>}
    <label className="desktop-asset-consent"><input type="checkbox" checked={consent} disabled={Boolean(block) || submissionUnknown} onChange={event => setConsent(event.target.checked)} /><span>允许将此项的视觉简报和原文证据发送到设置中选定的生图 API，本次生成 1 张候选图。每张图都需要单独勾选授权；供应商可能消耗 API 额度并计费；不自动购买套餐，不自动重试。</span></label>
    <button className="novel-primary desktop-asset-start" disabled={Boolean(block) || !consent || submissionUnknown} onClick={() => void start()}><ImagePlus size={15} />{submitting ? '正在保存本次操作…' : '生成候选图片'}</button>
    <small className="desktop-asset-footnote">任务由本地后端调用已配置的模型连接执行。候选图不会自动关联；拒绝或重新生成不会改写小说，也不会打开 3D 导演台。</small>
  </section>;
}
