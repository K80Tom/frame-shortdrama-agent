import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronRight, CircleAlert, Clock3, Film, LoaderCircle, RefreshCw, Settings2, Sparkles, Volume2 } from 'lucide-react';
import {
  defaultVideoForm, mergeVideoRuns, parseVideoRun, parseVideoRuns, parseVideoStatus, pendingVideoKey, readPendingVideoIntent,
  resolvePendingVideoIntent, validateVideoForm, VideoApiError, videoAutomationApi, videoDurations, videoRatios, videoResolutions,
  videoCreationBlocked, videoResultLink, videoRunActive, videoRunLabels, videoSubmission,
  type PendingVideoIntent, type VideoForm, type VideoRun, type VideoStatus,
} from './video-automation';
import './video-automation.css';

function pendingFromSession() {
  try { return readPendingVideoIntent(sessionStorage); } catch { return null; }
}
function runDate(run: VideoRun) {
  if (!run.createdAt || !Number.isFinite(Date.parse(run.createdAt))) return '已保存任务';
  return new Date(run.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function errorText(error: unknown) { return error instanceof Error && error.name !== 'AbortError' ? error.message : '连接超时，请检查本地后端后重试读取。'; }

export function VideoRunProgress({ run, reconciling, onReconcile }: { run: VideoRun; reconciling: boolean; onReconcile: () => void }) {
  const link = run.status === 'completed' ? videoResultLink(run.result?.videoUrl) : null;
  const canReconcile = ['submitting', 'generating', 'unknown'].includes(run.status);
  return <section className="va-progress" aria-labelledby="va-progress-title">
    <div className="va-section-top"><div><span className="va-overline">本次创作</span><h2 id="va-progress-title">{videoRunLabels[run.status]}</h2></div><span className={`va-run-state va-run-state-${run.status}`}>{videoRunActive(run) ? <LoaderCircle size={13} className="va-spin" /> : run.status === 'completed' ? <Check size={13} /> : <CircleAlert size={13} />}{run.progress.completed} / {run.progress.total} 环节</span></div>
    <p className="va-run-description">{run.prompt || '视频创作任务'} </p>
    <ol className="va-nodes" aria-label="视频制作进度">{run.nodes.map(node => <li key={node.key} className={`va-node va-node-${node.state}`}><span className="va-node-icon" aria-hidden="true">{node.state === 'succeeded' ? <Check size={15} /> : ['running', 'waitingExternal'].includes(node.state) ? <LoaderCircle size={15} className="va-spin" /> : ['failed', 'needsAttention'].includes(node.state) ? <CircleAlert size={15} /> : <span />}</span><div><strong>{node.label}</strong><p>{node.message || (node.state === 'pending' ? '等待前序环节' : '正在读取任务状态')}</p></div></li>)}</ol>
    {run.status === 'unknown' && <p className="va-warning" role="status">提交结果尚不明确，原请求可能已经计费。不会重新发送；请核对已有任务。</p>}
    {run.status === 'failed' && <p className="va-warning">{run.message || '本次任务未完成，已有记录会保留。修改描述或设置后，可明确发起一次新任务。'}</p>}
    {run.status === 'completed' && (link ? <a className="va-result-link" href={link} target="_blank" rel="noopener noreferrer">打开生成的视频<ArrowUpRight size={16} /></a> : <p className="va-warning">任务已完成，但没有可安全打开的 HTTPS 视频地址。请刷新核对结果。</p>)}
    {canReconcile && <button className="va-secondary" disabled={reconciling} onClick={onReconcile}><RefreshCw size={14} className={reconciling ? 'va-spin' : ''} />{reconciling ? '正在核对…' : '核对已有任务'}</button>}
    <div className="va-run-meta"><span>{run.model || '视频模型'} · {runDate(run)}</span><small title={run.id}>任务 {run.id}</small></div>
  </section>;
}

export default function VideoAutomationPage({ onUnsavedChange }: { onUnsavedChange?: (dirty: boolean) => void }) {
  const [form, setForm] = useState<VideoForm>({ ...defaultVideoForm });
  const [dirty, setDirty] = useState(false);
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<VideoStatus | null>(null);
  const [runs, setRuns] = useState<VideoRun[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [pending, setPending] = useState<PendingVideoIntent | null>(pendingFromSession);
  const [posting, setPosting] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const [refresh, setRefresh] = useState(0);
  const pendingRef = useRef(pending);
  const postingRef = useRef(false);
  const reconcileRef = useRef(false);
  const actionEpoch = useRef(0);
  const mutationController = useRef<AbortController | null>(null);
  const run = runs.find(item => item.id === selectedId) ?? runs[0] ?? null;
  const configured = Boolean(status?.available && status.connectionRevision);
  const blocked = videoCreationBlocked({ status, runs, pending: Boolean(pending), loading, posting, reconciling });

  function clearPending() {
    pendingRef.current = null; setPending(null);
    try { sessionStorage.removeItem(pendingVideoKey); } catch { /* The server record remains authoritative. */ }
  }

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    async function poll() {
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 12000);
      const results = await Promise.allSettled([
        videoAutomationApi('/api/video-automation/status', undefined, controller.signal).then(parseVideoStatus),
        videoAutomationApi('/api/video-automation-runs', undefined, controller.signal).then(parseVideoRuns),
      ]);
      clearTimeout(timeout);
      if (disposed) return;
      const [connection, history] = results;
      setStatus(connection.status === 'fulfilled' ? connection.value : null);
      const errors: string[] = [];
      if (connection.status === 'rejected') errors.push(`模型状态：${errorText(connection.reason)}`);
      if (history.status === 'fulfilled') {
        setRuns(current => mergeVideoRuns(current, history.value));
        const recovered = resolvePendingVideoIntent(pendingRef.current, history.value, postingRef.current);
        if (recovered.state === 'found') {
          clearPending(); setSelectedId(recovered.run.id); setDirty(false); setConsent(false);
          setMessage('已找到刚才的任务，继续读取真实进度；没有重复提交。');
        } else if (recovered.state === 'notFound') {
          clearPending(); setConsent(false);
          setMessage('已核对任务列表，未找到刚才的创建记录。没有自动重发；你可以重新确认额度并创建新任务。');
        }
      } else errors.push(`任务列表：${errorText(history.reason)}`);
      setLoadError(errors.join(' ')); setLoading(false);
      timer = setTimeout(() => void poll(), 4000);
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); };
  }, [refresh]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    void videoAutomationApi(`/api/video-automation-runs/${encodeURIComponent(selectedId)}`, undefined, controller.signal)
      .then(parseVideoRun).then(result => { if (!controller.signal.aborted) setRuns(current => mergeVideoRuns(current, [result])); })
      .catch(() => { /* The regular list poll continues to display any read failure. */ }).finally(() => clearTimeout(timeout));
    return () => { controller.abort(); clearTimeout(timeout); };
  }, [selectedId]);

  useEffect(() => () => { actionEpoch.current += 1; mutationController.current?.abort(); }, []);
  useEffect(() => { onUnsavedChange?.(dirty || posting); return () => onUnsavedChange?.(false); }, [dirty, posting, onUnsavedChange]);
  useEffect(() => {
    if (!dirty && !posting) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave);
  }, [dirty, posting]);
  useEffect(() => { setConsent(false); }, [status?.connectionRevision]);

  function edit(change: Partial<VideoForm>) { setForm(current => ({ ...current, ...change })); setDirty(true); setConsent(false); }

  async function submit() {
    if (postingRef.current || reconcileRef.current || pendingRef.current || blocked || !status || !consent) return;
    const validation = validateVideoForm(form);
    if (validation) { setMessage(validation); return; }
    const intent = { clientRequestId: crypto.randomUUID(), createdAt: new Date().toISOString() };
    const body = videoSubmission(form, status, intent.clientRequestId);
    try { sessionStorage.setItem(pendingVideoKey, JSON.stringify(intent)); }
    catch { setMessage('无法保存本次操作标识，尚未提交。请检查浏览器存储后再试。'); return; }
    pendingRef.current = intent; setPending(intent);
    postingRef.current = true; setPosting(true); setConsent(false); setMessage('');
    const epoch = ++actionEpoch.current;
    const controller = new AbortController(); mutationController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const result = parseVideoRun(await videoAutomationApi('/api/video-automation-runs', body, controller.signal));
      if (epoch !== actionEpoch.current) return;
      clearPending(); setRuns(current => mergeVideoRuns(current, [result])); setSelectedId(result.id); setDirty(false);
      setMessage('任务已保存。你可以离开页面，回来后继续查看进度。');
    } catch (error) {
      if (epoch !== actionEpoch.current) return;
      if (error instanceof VideoApiError) { clearPending(); setMessage(error.message); }
      else setMessage('创建响应未能确认，正在核对已有任务。不会自动重新提交。');
    } finally {
      clearTimeout(timeout);
      if (epoch === actionEpoch.current) { postingRef.current = false; setPosting(false); setRefresh(value => value + 1); }
    }
  }

  async function reconcile() {
    if (!run || reconcileRef.current || postingRef.current) return;
    reconcileRef.current = true; setReconciling(true); setMessage('');
    const epoch = ++actionEpoch.current;
    const controller = new AbortController(); mutationController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const result = parseVideoRun(await videoAutomationApi(`/api/video-automation-runs/${encodeURIComponent(run.id)}/reconcile`, {}, controller.signal));
      if (epoch === actionEpoch.current) { setRuns(current => mergeVideoRuns(current, [result])); setMessage('已核对原任务，没有提交新生成请求。'); }
    } catch (error) { if (epoch === actionEpoch.current) setMessage(errorText(error)); }
    finally { clearTimeout(timeout); if (epoch === actionEpoch.current) { reconcileRef.current = false; setReconciling(false); setRefresh(value => value + 1); } }
  }

  return <div className="va-page">
    <header className="va-page-heading"><div><span className="va-heading-icon"><Film size={20} strokeWidth={1.6} /></span><div><h1>自动成片</h1><p>写下画面，让一个想法动起来。</p></div></div><a href="#/settings/models"><Settings2 size={14} />模型设置<ArrowUpRight size={13} /></a></header>
    <div className="va-layout">
      <section className="va-composer" aria-labelledby="va-compose-title"><div className="va-section-top"><h2 id="va-compose-title">描述你的视频</h2><span className="va-subtle">文本生成视频</span></div>
        <form onSubmit={event => { event.preventDefault(); void submit(); }}>
          <label className="va-sr-only" htmlFor="va-prompt">视频描述</label><textarea id="va-prompt" value={form.prompt} maxLength={8000} disabled={posting || Boolean(pending)} placeholder="例如：黄昏的雨巷里，一位穿黑色风衣的年轻人缓缓转身。镜头从远处推进，雨滴与霓虹倒影交织，电影质感。" onChange={event => edit({ prompt: event.target.value })} />
          <div className="va-prompt-foot"><span>写清人物、动作、环境与镜头</span><span>{form.prompt.length} / 8000</span></div>
          <div className="va-settings"><label><span>画面比例</span><select aria-label="画面比例" value={form.ratio} disabled={posting || Boolean(pending)} onChange={event => edit({ ratio: event.target.value as VideoForm['ratio'] })}>{videoRatios.map(value => <option key={value}>{value}</option>)}</select></label><label><span>时长</span><select aria-label="视频时长" value={form.duration} disabled={posting || Boolean(pending)} onChange={event => edit({ duration: Number(event.target.value) })}>{videoDurations.map(value => <option key={value} value={value}>{value} 秒</option>)}</select></label><label><span>分辨率</span><select aria-label="视频分辨率" value={form.resolution} disabled={posting || Boolean(pending)} onChange={event => edit({ resolution: event.target.value as VideoForm['resolution'] })}>{videoResolutions.map(value => <option key={value}>{value}</option>)}</select></label></div>
          <label className="va-audio"><span><Volume2 size={15} />生成声音</span><input type="checkbox" checked={form.generateAudio} disabled={posting || Boolean(pending)} onChange={event => edit({ generateAudio: event.target.checked })} /><span>{form.generateAudio ? '已开启' : '关闭'}</span></label>
          <div className="va-model"><span className={configured ? 'va-model-dot va-model-ready' : 'va-model-dot'} /><span title={configured ? status!.model : undefined}>{loading ? '正在读取模型状态…' : configured ? '生视频模型已就绪' : '视频模型尚未就绪'}</span>{!configured && <a href="#/settings/models">配置模型<ChevronRight size={12} /></a>}</div>
          {!loading && !configured && <p className="va-config-note">{status?.message || '请启动本地后端，并在模型设置中配置视频连接。连接就绪后再创建视频。'}</p>}
          {status?.busy && <p className="va-config-note">视频服务正在处理任务，请等待当前任务结束。</p>}
          <label className="va-consent"><input type="checkbox" checked={consent} disabled={blocked} onChange={event => setConsent(event.target.checked)} /><span>允许将本次描述发送到所选视频 API，创建 1 个视频任务并消耗 API 额度，可能产生费用。不会自动购买额度或重新生成。</span></label>
          <button type="submit" className="va-create" disabled={blocked || !consent || Boolean(validateVideoForm(form))}>{posting ? <LoaderCircle size={17} className="va-spin" /> : <Sparkles size={17} />}{posting ? '正在保存任务…' : '一键创建视频'}</button>
          <p className="va-boundary">本次生成一段视频；多镜头编排、配音与整集剪辑仍需后续制作。</p>
        </form>
      </section>
      <div className="va-results">{run ? <VideoRunProgress run={run} reconciling={reconciling} onReconcile={() => void reconcile()} /> : <section className="va-empty"><span><Film size={34} strokeWidth={1.2} /></span><h2>让故事的第一帧动起来</h2><p>提交后，这里会显示任务的真实进度与视频结果。</p><div><span>描述</span><ChevronRight size={12} /><span>生成</span><ChevronRight size={12} /><span>交付</span></div></section>}</div>
    </div>
    {pending && !posting && <div className="va-alert" role="alert"><CircleAlert size={16} /><p>正在确认刚才是否已创建任务。暂不允许再次提交，避免重复消耗额度。</p><button onClick={() => setRefresh(value => value + 1)}>重新读取</button></div>}
    {message && <p className="va-message" role="status">{message}</p>}
    {loadError && <div className="va-alert" role="alert"><CircleAlert size={16} /><p>{loadError} 已有记录仍保留。</p><button onClick={() => setRefresh(value => value + 1)}><RefreshCw size={13} />刷新</button></div>}
    <section className="va-history" aria-labelledby="va-history-title"><div className="va-section-top"><h2 id="va-history-title">创作记录</h2><span className="va-subtle">{runs.length ? `${runs.length} 个任务` : loading ? '读取中…' : '暂无记录'}</span></div>{runs.length ? <div className="va-history-list">{runs.map(item => <button key={item.id} className={run?.id === item.id ? 'va-history-active' : ''} onClick={() => setSelectedId(item.id)} aria-pressed={run?.id === item.id}><span className="va-history-icon"><Film size={17} /></span><span className="va-history-copy"><strong>{item.prompt || `视频任务 ${item.id.slice(0, 12)}`}</strong><small><Clock3 size={10} />{runDate(item)}</small></span><span className={`va-history-status va-history-status-${item.status}`}>{videoRunLabels[item.status]}</span><ChevronRight size={14} /></button>)}</div> : <p className="va-history-empty">创建的视频任务会保存在本地后端，可随时回来查看。</p>}</section>
  </div>;
}
