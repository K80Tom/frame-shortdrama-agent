import { useEffect, useRef, useState } from 'react';
import FactsEditor from './FactsEditor';
import { buildEntityEdits, createEntityDrafts, latestPlanForScript, validateEntityDrafts, type EntityDraft, type EntityDrafts, type FactPlan as Plan, type SourceRef as Ref } from './facts-editor';
import './production.css';

type Project = { id: string; title: string; source: { url: string; title?: string; author?: string; chapterTitle?: string } | null; currentScriptVersionId: string | null; activePlanRevisionId: string | null; activeStoryboardRevisionId: string | null };
type Run = { id: string; status: string; scriptVersionId: string; modelConfig: { provider: string; model: string; reasoningEffort: string; connectionRevision?: string } };
type ModelCatalog = { provider: string; configured: boolean; defaultModel: string; connectionRevision?: string };
type Check = { id: string; result: 'passed' | 'failed'; ruleVersion: string };
const CURRENT_FACT_CHECK_RULE_VERSION = 'extract-facts-completeness/2';
type Issue = { id: string; code: string; message: string; sourceRefs: Ref[] };
type Storyboard = { id: string; sourcePlanRevisionId: string; shots: Array<{ id: string; sceneId: string; order: number;
  design: { origin: 'designSuggestion'; visualDescription: string; shotSize: string; cameraMovement: string; durationMs: number };
  sourceRefs: Ref[]; dialogueIds: string[] }> };
type DraftSession = { basePlan: Plan; drafts: EntityDrafts };
type IsCurrent = () => boolean;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shortdrama-Call': '1' }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${data?.error?.message ?? `请求失败（${response.status}）`}${response.status === 409 ? ' 本页校对草稿已保留，请刷新版本列表并核对最新版本。' : ''}`);
  return data as T;
}

async function readPlanStatus(plan: Plan | null): Promise<{ check: Check | null; issues: Issue[] }> {
  if (!plan) return { check: null, issues: [] };
  const checks = await api<{ items: Check[] }>(`/api/plan-revisions/${plan.id}/checks`);
  const check = checks.items[0] ?? null;
  const issues = check ? (await api<{ items: Issue[] }>(`/api/plan-revisions/${plan.id}/checks/${check.id}/issues`)).items : [];
  return { check, issues };
}

export default function ProductionPage({ onUnsavedChange, initialProjectId }: { onUnsavedChange?: (dirty: boolean) => void; initialProjectId?: string }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [title, setTitle] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [script, setScript] = useState('');
  const [savedScript, setSavedScript] = useState('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const [generalCatalog, setGeneralCatalog] = useState<ModelCatalog | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [draftBook, setDraftBook] = useState<Record<string, DraftSession>>({});
  const [check, setCheck] = useState<Check | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [allowPaid, setAllowPaid] = useState(false);
  const [allowStoryboardPaid, setAllowStoryboardPaid] = useState(false);
  const [storyboards, setStoryboards] = useState<Storyboard[]>([]);
  const [storyboard, setStoryboard] = useState<Storyboard | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const busyRef = useRef(false);
  const requestEpoch = useRef(0);
  const scriptDrafts = useRef<Record<string, string>>({});

  const drafts = plan ? draftBook[plan.id]?.drafts ?? createEntityDrafts(plan.content) : {};
  const edits = plan ? buildEntityEdits(plan.content, drafts) : [];
  const dirty = edits.length > 0;
  const draftErrors = plan && dirty ? validateEntityDrafts(plan.content, drafts) : [];
  const anyDirty = Boolean(title || sourceUrl) || Object.values(draftBook).some(session => buildEntityEdits(session.basePlan.content, session.drafts).length > 0) || Object.keys(scriptDrafts.current).length > 0;
  const latestPlan = latestPlanForScript(plans, project?.currentScriptVersionId ?? null);
  const editable = Boolean(plan && latestPlan?.id === plan.id);
  const active = Boolean(project && plan && project.activePlanRevisionId === plan.id);
  const activeBoard = Boolean(project && storyboard && project.activeStoryboardRevisionId === storyboard.id);
  const currentCheckPassed = check?.result === 'passed' && check.ruleVersion === CURRENT_FACT_CHECK_RULE_VERSION;
  const modelReady = Boolean(modelCatalog?.configured);
  const generalReady = Boolean(generalCatalog?.configured);
  const currentRunModel = Boolean(run && modelCatalog && run.modelConfig.provider === modelCatalog.provider
    && run.modelConfig.model === modelCatalog.defaultModel && run.modelConfig.reasoningEffort === 'model-default'
    && (run.modelConfig.connectionRevision ? run.modelConfig.connectionRevision === modelCatalog.connectionRevision
      : !modelCatalog.connectionRevision || modelCatalog.connectionRevision === 'environment-v1'));

  // Serialize actions and ignore responses belonging to an unmounted page or obsolete load.
  async function action(name: string, work: (isCurrent: IsCurrent) => Promise<void>) {
    if (busyRef.current) return;
    const epoch = ++requestEpoch.current;
    const isCurrent = () => epoch === requestEpoch.current;
    busyRef.current = true;
    setBusy(name); setMessage('');
    try { await work(isCurrent); }
    catch (error) { if (isCurrent()) setMessage(error instanceof Error ? error.message : '操作失败。'); }
    finally { if (isCurrent()) { busyRef.current = false; setBusy(''); } }
  }

  function confirmLeavingDraft(destination: string): boolean {
    if (!dirty && script === savedScript) return true;
    return window.confirm(`当前有未保存内容，确定${destination}？\n校对与原文草稿会暂存在本页，返回相同项目和拆解版本可继续；刷新或离开本页会丢失未保存内容。`);
  }

  async function loadProject(id: string, isCurrent: IsCurrent) {
    const [selected, history, boards, revisions] = await Promise.all([
      api<Project>(`/api/projects/${id}`),
      api<{ items: Run[] }>(`/api/projects/${id}/breakdown-runs`),
      api<{ items: Storyboard[] }>(`/api/projects/${id}/storyboards`),
      api<{ items: Plan[] }>(`/api/projects/${id}/plan-revisions`),
    ]);
    const current = latestPlanForScript(revisions.items, selected.currentScriptVersionId) ?? revisions.items.at(-1) ?? null;
    const [saved, status] = await Promise.all([
      selected.currentScriptVersionId ? api<{ rawText: string }>(`/api/projects/${id}/script-versions/${selected.currentScriptVersionId}`) : Promise.resolve({ rawText: '' }),
      readPlanStatus(current),
    ]);
    if (!isCurrent()) return;
    setProject(selected); setRuns(history.items);
    setRun(history.items.find(item => item.id === current?.runId) ?? history.items[0] ?? null);
    setStoryboards(boards.items); setStoryboard(boards.items[0] ?? null);
    setSavedScript(saved.rawText); setScript(scriptDrafts.current[id] ?? saved.rawText);
    setPlans(revisions.items); setPlan(current); setCheck(status.check); setIssues(status.issues);
    setAllowPaid(false); setAllowStoryboardPaid(false);
  }

  async function refreshProjectMetadata(id: string, isCurrent: IsCurrent) {
    const selected = await api<Project>(`/api/projects/${id}`);
    if (!isCurrent()) return;
    setProject(selected); setProjects(items => items.map(item => item.id === id ? selected : item));
  }

  async function selectPlan(selected: Plan | null, isCurrent: IsCurrent) {
    const status = await readPlanStatus(selected);
    if (!isCurrent()) return;
    setPlan(selected); setCheck(status.check); setIssues(status.issues);
  }

  useEffect(() => {
    let disposed = false;
    void api<ModelCatalog>('/api/models?role=breakdown').then(catalog => { if (!disposed) setModelCatalog(catalog); }).catch(() => undefined);
    void api<ModelCatalog>('/api/models?role=general').then(catalog => { if (!disposed) setGeneralCatalog(catalog); }).catch(() => undefined);
    void action('读取项目', async isCurrent => {
      const data = await api<{ items: Project[] }>('/api/projects');
      if (!isCurrent()) return;
      setProjects(data.items);
      const selectedId = initialProjectId === 'new' ? undefined : initialProjectId ?? data.items[0]?.id;
      if (selectedId) await loadProject(selectedId, isCurrent);
    });
    return () => { disposed = true; requestEpoch.current += 1; busyRef.current = false; };
  }, []);

  useEffect(() => {
    onUnsavedChange?.(anyDirty);
    return () => onUnsavedChange?.(false);
  }, [anyDirty, onUnsavedChange]);

  useEffect(() => {
    if (!anyDirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [anyDirty]);

  function updateDraft(key: string, draft: EntityDraft) {
    if (!plan || !editable || busyRef.current) return;
    setDraftBook(previous => ({ ...previous, [plan.id]: { basePlan: plan, drafts: { ...(previous[plan.id]?.drafts ?? createEntityDrafts(plan.content)), [key]: draft } } }));
  }

  function cancelEdits() {
    if (!plan || !window.confirm('取消当前版本的未保存校对？已保存的候选与原文不会改变。')) return;
    setDraftBook(previous => { const next = { ...previous }; delete next[plan.id]; return next; });
    setMessage('已取消当前版本的未保存校对。');
  }

  function saveEdits() {
    if (!plan || !project || !editable || !dirty || draftErrors.length) return;
    void action('保存校对', async isCurrent => {
      const saved = await api<Plan>(`/api/plan-revisions/${plan.id}/entity-edits`, { expectedActivePlanRevisionId: project.activePlanRevisionId, edits });
      if (!isCurrent()) return;
      // A successful save stays visible even when the subsequent history refresh fails.
      setDraftBook(previous => { const next = { ...previous }; delete next[plan.id]; return next; });
      setPlans(items => [...items.filter(item => item.id !== saved.id), saved]);
      setPlan(saved); setCheck(null); setIssues([]);
      setMessage('校对已保存为新候选，旧版本与已采用结果未被覆盖。请重新校验，人工核对后再采用。');
      try {
        const revisions = await api<{ items: Plan[] }>(`/api/projects/${project.id}/plan-revisions`);
        if (isCurrent()) setPlans(revisions.items);
      } catch {
        if (isCurrent()) setMessage('校对已保存为新候选，但版本列表刷新失败。可稍后刷新列表；请勿重复提交。');
      }
    });
  }

  function createProject() {
    if (!confirmLeavingDraft('创建并切换到新项目')) return;
    void action('创建项目', async isCurrent => {
      const created = await api<Project>('/api/projects', { title: title.trim(), ...(sourceUrl.trim() ? { source: { url: sourceUrl.trim() } } : {}) });
      if (!isCurrent()) return;
      setTitle(''); setSourceUrl(''); setProjects(items => [created, ...items]);
      await loadProject(created.id, isCurrent);
      if (isCurrent()) setMessage('项目已创建，请粘贴原文并保存新版本。');
    });
  }

  function saveScript() {
    if (!project || !confirmLeavingDraft('保存新的原文版本（现有拆解将成为历史版本）')) return;
    void action('保存剧本', async isCurrent => {
      await api(`/api/projects/${project.id}/script-versions`, { rawText: script });
      if (!isCurrent()) return;
      delete scriptDrafts.current[project.id];
      await loadProject(project.id, isCurrent);
      if (isCurrent()) setMessage('已保存新的原文版本。历史拆解与校对仍保留，请为新原文创建 Run 并重新拆解。');
    });
  }

  function createRun() {
    if (!project || !confirmLeavingDraft('创建新的拆解 Run')) return;
    void action('创建 Run', async isCurrent => {
      const created = await api<Run>(`/api/projects/${project.id}/breakdown-runs`, { maxModelCalls: 1, maxOutputTokens: 8192, requirements: { language: '中文' } });
      if (!isCurrent()) return;
      setRun(created); setRuns(items => [created, ...items]); setAllowPaid(false);
      setMessage('Run 已创建，尚未调用模型。已有拆解和未保存校对仍保留。');
    });
  }

  function executeRun() {
    if (!run || !project || !modelReady || !currentRunModel || !confirmLeavingDraft('运行新的事实拆解（可能产生费用）')) return;
    void action('运行拆解', async isCurrent => {
      const result = await api<{ plan: Plan }>(`/api/breakdown-runs/${run.id}/execute`, { allowPaid: true });
      if (!isCurrent()) return;
      setPlan(result.plan); setPlans(items => [...items, result.plan]); setCheck(null); setIssues([]); setAllowPaid(false);
      setMessage('已生成新候选；原校对草稿保留在对应版本中。请先核对并运行程序校验。');
      const updated = await api<Run>(`/api/breakdown-runs/${run.id}`);
      if (isCurrent()) { setRun(updated); setRuns(items => items.map(item => item.id === updated.id ? updated : item)); }
    });
  }

  return <div className="production-page">
    <section className="production-create" aria-labelledby="create-project-title">
      <div><span>NEW PROJECT / 开始创作</span><h1 id="create-project-title">新建项目</h1><p>给故事起名，创建后粘贴原文。来源链接可选，保存为出处，不会自动抓取网页。</p></div>
      <form onSubmit={event => { event.preventDefault(); if (!busy && title.trim()) createProject(); }}>
        <label htmlFor="new-project-title">项目名称</label><input id="new-project-title" aria-label="新项目名称" required disabled={!!busy} maxLength={160} placeholder="例如：诸天万界蹭车系统" value={title} onChange={event => setTitle(event.target.value)} />
        <label htmlFor="new-project-source">来源链接 <small>可选</small></label><input id="new-project-source" aria-label="来源链接" type="url" disabled={!!busy} placeholder="https://…" value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} />
        <button className="production-primary" type="submit" disabled={!!busy || !title.trim()}>{busy === '创建项目' ? '正在创建…' : '创建项目'}</button>
      </form>
    </section>
    <header className="production-hero"><span>LOCAL PRODUCTION / 真实项目</span><h1>先把故事里的每一项，核对清楚。</h1><p>对照原文校对人物、场景和道具，保存为新的候选版本。保存不等于采用；检查通过并人工确认后，才更新正式拆解。</p></header>
    <div className="production-grid"><section className="production-card"><h2>01 · 项目与剧本</h2>
      <div className="production-row"><select aria-label="选择项目" disabled={!!busy} value={project?.id ?? ''} onChange={event => { const id = event.target.value; if (id && id !== project?.id && confirmLeavingDraft('切换项目')) void action('选择项目', current => loadProject(id, current)); }}><option value="" disabled>选择已有项目</option>{projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>
      {project?.source && <p className="production-source">来源：<a href={project.source.url} target="_blank" rel="noreferrer">{project.source.chapterTitle ?? project.source.title ?? project.source.url}</a>{project.source.author && ` · ${project.source.author}`}</p>}
      <label className="production-label" htmlFor="production-script">创作原文（小说或剧本）</label><textarea id="production-script" disabled={!!busy || !project} value={script} onChange={event => { const value = event.target.value; setScript(value); if (project) { if (value === savedScript) delete scriptDrafts.current[project.id]; else scriptDrafts.current[project.id] = value; } }} placeholder="粘贴一章小说或一集中文剧本。每次保存会创建新版本，已有版本不会被覆盖。" />
      <div className="production-actions"><button disabled={!!busy || !project || !script.trim() || script === savedScript} onClick={saveScript}>保存原文新版本</button><small>{script !== savedScript ? '原文有未保存修改' : project?.currentScriptVersionId ? '原文已保存' : '请先创建项目并保存剧本'}</small></div>
    </section><section className="production-card"><h2>02 · 拆解运行</h2><p>使用设置中选定的“拆解”模型提取事实，可能产生费用。下方人工校对与保存不调用模型。</p>
      <p role="status">{modelReady ? `当前拆解模型：${modelCatalog!.defaultModel}` : '拆解模型尚未配置或状态不可用；请到工作台设置 → 模型连接配置后刷新。人工校对与保存不受影响。'}</p>
      <div className="production-actions"><button disabled={!!busy || !project?.currentScriptVersionId || script !== savedScript} onClick={createRun}>创建拆解 Run</button></div>
      {runs.length > 0 && <select aria-label="选择运行记录" disabled={!!busy} value={run?.id ?? ''} onChange={event => { const chosen = runs.find(item => item.id === event.target.value); if (!chosen || !confirmLeavingDraft('切换运行记录')) return; void action('选择 Run', async isCurrent => { const candidate = plans.filter(item => item.runId === chosen.id).at(-1) ?? null; await selectPlan(candidate, isCurrent); if (isCurrent()) { setRun(chosen); setAllowPaid(false); } }); }}><option value="" disabled>选择历史 Run</option>{runs.map(item => <option key={item.id} value={item.id}>{item.id.slice(0, 15)} · {item.status}</option>)}</select>}
      {run && <div className="production-run"><span>状态：{run.status}</span><span>模型：{run.modelConfig.model}</span></div>}
      {run && modelCatalog && !currentRunModel && <p className="facts-downstream-note">此历史 Run 的模型配置已移除，不能继续执行。请新建 Run；历史结果仍可查看和校对。</p>}
      <label className="production-consent"><input type="checkbox" disabled={!!busy || !modelReady || !currentRunModel} checked={allowPaid} onChange={event => setAllowPaid(event.target.checked)} />我确认此次调用模型，可能产生费用</label>
      <button className="production-primary" disabled={!!busy || !modelReady || !currentRunModel || !run || run.status !== 'draft' || run.scriptVersionId !== project?.currentScriptVersionId || script !== savedScript || !allowPaid} onClick={executeRun}>{busy === '运行拆解' ? '正在拆解…' : '运行事实拆解 Agent'}</button>
    </section></div>
    {message && <p className="production-message" role="status">{message}</p>}
    {!!plans.length && <section className="production-card production-result">
      <div className="production-result-head"><div><span>03 · 拆解校对</span><h2>{active ? '已采用的拆解' : '待核对的拆解'}</h2></div><div className="production-actions"><button disabled={!!busy || !project} onClick={() => { if (project && confirmLeavingDraft('刷新版本列表')) void action('刷新版本', current => loadProject(project.id, current)); }}>刷新版本列表</button></div></div>
      <div className="facts-version-picker"><label htmlFor="facts-plan-version">拆解版本</label><select id="facts-plan-version" disabled={!!busy} value={plan?.id ?? ''} onChange={event => { const selected = plans.find(item => item.id === event.target.value); if (!selected || !confirmLeavingDraft('切换拆解版本')) return; void action('选择拆解版本', async current => { await selectPlan(selected, current); if (current()) setRun(runs.find(item => item.id === selected.runId) ?? run); }); }}><option value="" disabled>请选择要核对的版本</option>{[...plans].reverse().map(item => <option key={item.id} value={item.id}>{item.reason === 'manualEdit' ? '人工校对' : '模型提取'} · {new Date(item.createdAt).toLocaleString('zh-CN')} · {item.id.slice(-8)}{project?.activePlanRevisionId === item.id ? ' · 已采用' : ' · 候选'}{latestPlan?.id === item.id ? ' · 最新' : ' · 历史只读'}{draftBook[item.id] && buildEntityEdits(item.content, draftBook[item.id].drafts).length ? ' · 有暂存草稿' : ''}</option>)}</select></div>
      {!plan && <p>当前运行尚无拆解结果，可选择已保存版本查看。</p>}
      {plan && <>
        <p className="facts-editor-intro">核对名称、别名与说明；原文依据只读保留。修改会标记为人工来源，保存时创建新候选，不覆盖旧版，也不会自动采用。<br />本轮不修改原文引用、人物身份关联、场次或对白，也不接入资产。</p>
        {!editable && <p className="facts-readonly">这是历史拆解，仅供查看。请选择当前原文的最新版本继续校对；历史未保存草稿如有保留，可对照查看，不会自动合并。</p>}
        <div className="facts-save-bar"><div><strong>{dirty ? `${edits.length} 项实体有未保存校对` : '当前版本没有未保存校对'}</strong><small>{plan.parentRevisionId ? `基于版本 ${plan.parentRevisionId.slice(-8)} · ` : ''}保存后请重新运行程序校验，再决定是否采用。</small></div><div className="production-actions"><button disabled={!!busy || !dirty} onClick={cancelEdits}>取消修改</button><button className="production-primary" disabled={!!busy || !editable || !dirty || draftErrors.length > 0} onClick={saveEdits}>{busy === '保存校对' ? '正在保存…' : '保存校对为新候选'}</button></div></div>
        {draftErrors.length > 0 && <div className="production-issues" role="alert"><h3>保存前请处理</h3>{draftErrors.map(error => <p key={error}>{error}</p>)}</div>}
        <FactsEditor plan={plan} drafts={drafts} disabled={!!busy || !editable} onChange={updateDraft} />
        <div className="production-actions facts-check-actions"><button disabled={!!busy || dirty || !editable} onClick={() => void action('程序校验', async isCurrent => { const result = await api<{ check: Check; issues: Issue[] }>(`/api/plan-revisions/${plan.id}/checks`, {}); if (isCurrent()) { setCheck(result.check); setIssues(result.issues); setMessage(result.check.result === 'passed' ? '程序校验通过。请人工核对语义后采用。' : '发现阻断问题；请核对问题。当前编辑器仅支持实体字段校对，场次与对白问题仍需后续处理。'); } })}>运行程序校验</button><button className="production-primary" disabled={!!busy || dirty || !editable || active || !currentCheckPassed} onClick={() => void action('采用', async isCurrent => { await api(`/api/projects/${project!.id}/adoptions`, { planRevisionId: plan.id, checkId: check!.id, expectedActivePlanRevisionId: project!.activePlanRevisionId }); await refreshProjectMetadata(project!.id, isCurrent); if (isCurrent()) setMessage('已采用这版事实拆解。旧版本仍可从版本列表查看。'); })}>采用这版拆解</button><small>{dirty ? '先保存校对，再校验与采用' : '采用才会更新项目正式拆解；已采用分镜可能需要重新核对'}</small></div>
        <div className="production-status">程序校验：{check ? (check.result === 'passed' ? (currentCheckPassed ? '通过' : '旧规则已通过 · 请重新运行程序校验') : `未通过 · ${issues.length} 项`) : '未运行'} · {active ? '这版已采用' : '这版尚未采用'} · 人工仍需核对剧情语义</div>
        {issues.length > 0 && <div className="production-issues"><h3>待处理问题</h3>{issues.map(issue => <div key={issue.id}><strong>{issue.message}</strong><small>{issue.code}</small>{issue.sourceRefs.map((ref, i) => <blockquote key={i}>{ref.quote}</blockquote>)}</div>)}</div>}
        <div className="production-facts facts-synopsis"><article><h3>梗概 · 只读</h3><p>{plan.content.synopsis?.value ?? '未提取'}</p>{plan.content.synopsis?.sourceRefs.map((ref, i) => <small key={i}>原文：「{ref.quote}」</small>)}</article></div>
        <h3 className="production-scenes-title">场次与对白 · 只读核对</h3>{plan.content.scenes.map(scene => <article className="production-scene" key={scene.id}><div><strong>{String(scene.order).padStart(2, '0')} · {scene.title.value}</strong><small>{scene.sourceRefs.length} 段原文</small></div><details className="facts-scene-evidence"><summary>查看场次原文</summary>{scene.sourceRefs.map((ref, i) => <blockquote key={i}>{ref.quote}</blockquote>)}</details>{plan.content.dialogues.filter(line => line.sceneId === scene.id).map(line => <blockquote key={line.id}><b>{plan.content.characters.find(item => item.id === line.speakerId)?.name.value ?? '待确认人物'}：</b>{line.sourceRef.quote}</blockquote>)}</article>)}
      </>}
    </section>}
    {project?.activePlanRevisionId && <section className="production-card production-result">
      <div className="production-result-head"><div><span>04 · 分镜设计</span><h2>一行一个连续镜头</h2></div>
        <button className="production-primary" disabled={!!busy || dirty || !generalReady || !allowStoryboardPaid} onClick={() => void action('生成分镜', async isCurrent => {
          const generated = await api<Storyboard>(`/api/projects/${project.id}/storyboards`, { allowPaid: true,
            expectedModelConnectionRevision: generalCatalog?.connectionRevision });
          if (!isCurrent()) return;
          setStoryboard(generated); setStoryboards(items => [generated, ...items]); setAllowStoryboardPaid(false);
          setMessage('候选分镜已生成。程序核验了场次、原文引用和对白覆盖；请核对画面设计。');
        })}>{busy === '生成分镜' ? '正在生成…' : '生成候选分镜'}</button></div>
      <p className="facts-downstream-note">分镜生成使用已采用拆解，不会使用未采用的校对候选。</p>
      <p className="facts-downstream-note">{generalReady ? `通用模型：${generalCatalog!.defaultModel}` : '通用模型未配置，暂不能生成分镜；请在模型连接页单独配置。'}</p>
      <label className="production-consent"><input type="checkbox" disabled={!!busy || !generalReady} checked={allowStoryboardPaid} onChange={event => setAllowStoryboardPaid(event.target.checked)} />我确认此次分镜生成调用通用模型，可能产生费用</label>
      {storyboards.length > 0 && <select aria-label="选择分镜版本" disabled={!!busy} value={storyboard?.id ?? ''} onChange={event => setStoryboard(storyboards.find(item => item.id === event.target.value) ?? null)}>{storyboards.map(item => <option key={item.id} value={item.id}>{item.id.slice(0, 18)}{project.activeStoryboardRevisionId === item.id ? ' · 已采用' : ' · 候选'}</option>)}</select>}
      {storyboard && <><div className="production-status">{activeBoard ? '已采用' : '候选版本'} · {storyboard.shots.length} 个连续镜头 · 景别、运镜与画面描述是 AI 建议{storyboard.sourcePlanRevisionId !== project.activePlanRevisionId ? ' · 来自旧拆解，不能作为当前版本采用' : ''}</div>
        <div className="production-shot-list">{storyboard.shots.map(shot => <article key={shot.id}><div><strong>场次 {shot.sceneId.slice(0, 12)} · 镜头 {shot.order}</strong><span>AI 设计建议</span></div><p>{shot.design.visualDescription}</p><small>{shot.design.shotSize} · {shot.design.cameraMovement} · {(shot.design.durationMs / 1000).toFixed(1)} 秒</small><blockquote>原文：{shot.sourceRefs.map(ref => ref.quote).join(' / ')}</blockquote></article>)}</div>
        <div className="production-actions"><button className="production-primary" disabled={!!busy || dirty || activeBoard || storyboard.sourcePlanRevisionId !== project.activePlanRevisionId} onClick={() => void action('采用分镜', async isCurrent => {
          await api(`/api/projects/${project.id}/storyboards/${storyboard.id}/adoptions`, { expectedActiveStoryboardRevisionId: project.activeStoryboardRevisionId });
          await refreshProjectMetadata(project.id, isCurrent); if (isCurrent()) setMessage('已采用这版分镜。');
        })}>核对后采用分镜</button></div></>}
    </section>}
  </div>;
}
