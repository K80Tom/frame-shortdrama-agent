import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CircleDashed, CheckCircle2, Play, Save } from 'lucide-react';
import FactsEditor from './FactsEditor';
import { PlanIssueList, type PlanCheckIssue } from './plan-issue-list';
import {
  buildEntityEdits, createEntityDrafts, latestPlanForScript, validateEntityDrafts,
  type EntityDrafts, type FactPlan,
} from './facts-editor';
import { workspaceFetch } from './deployment';
import { projectFlowHash } from './project-flow';
import './project-workspace.css';

type Project = { id: string; title: string; currentScriptVersionId: string | null; activePlanRevisionId: string | null };
type Run = { id: string; status: string; scriptVersionId: string; modelConfig: { provider: string; model: string; reasoningEffort: string; connectionRevision?: string } };
type ModelCatalog = { provider: string; configured: boolean; defaultModel: string; maxOutputTokens?: number; connectionRevision?: string };
type Check = { id: string; result: 'passed' | 'failed'; ruleVersion: string };
const CURRENT_FACT_CHECK_RULE_VERSION = 'extract-facts-completeness/2';

export type ScriptPrimaryAction = 'add-script' | 'start-breakdown' | 'review-facts' | 'adopt-facts' | 'into-storyboard';

/** 首屏唯一主行动的纯状态机（与服务端 nextAction 同优先级，本地只负责剧本区段）。 */
export function deriveScriptState(input: {
  currentScriptVersionId: string | null;
  runs: Run[];
  plans: FactPlan[];
  activePlanRevisionId: string | null;
  /** 已采用事实所属的剧本版本；null 表示没有已采用事实。 */
  activePlanScriptVersionId: string | null;
  check: Check | null;
}): ScriptPrimaryAction {
  if (!input.currentScriptVersionId) return 'add-script';
  const hasRunForScript = input.runs.some(run => run.scriptVersionId === input.currentScriptVersionId);
  if (!hasRunForScript) return 'start-breakdown';
  // 已采用事实必须属于当前剧本版本才算新鲜；旧事实不允许直接进入分镜。
  const adoptedFresh = Boolean(input.activePlanRevisionId
    && input.activePlanScriptVersionId === input.currentScriptVersionId);
  if (adoptedFresh) return 'into-storyboard';
  if (!latestPlanForScript(input.plans, input.currentScriptVersionId)) return 'review-facts';
  const passed = Boolean(input.check && input.check.result === 'passed' && input.check.ruleVersion === CURRENT_FACT_CHECK_RULE_VERSION);
  return passed ? 'adopt-facts' : 'review-facts';
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await workspaceFetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shortdrama-Call': '1' }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${data?.error?.message ?? `请求失败（${response.status}）`}`);
  return data as T;
}

async function readPlanStatus(plan: FactPlan | null): Promise<{ check: Check | null; issues: PlanCheckIssue[] }> {
  if (!plan) return { check: null, issues: [] };
  const checks = await api<{ items: Check[] }>(`/api/plan-revisions/${plan.id}/checks`);
  const check = checks.items[0] ?? null;
  const issues = check ? (await api<{ items: PlanCheckIssue[] }>(`/api/plan-revisions/${plan.id}/checks/${check.id}/issues`)).items : [];
  return { check, issues };
}

export default function ProjectScriptWorkspace({ projectId, onUnsavedChange }: {
  projectId: string; onUnsavedChange?: (dirty: boolean) => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [script, setScript] = useState('');
  const [savedScript, setSavedScript] = useState('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const [plans, setPlans] = useState<FactPlan[]>([]);
  const [plan, setPlan] = useState<FactPlan | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [issues, setIssues] = useState<PlanCheckIssue[]>([]);
  const [allowPaid, setAllowPaid] = useState(false);
  const [draftBook, setDraftBook] = useState<Record<string, { basePlan: FactPlan; drafts: EntityDrafts }>>({});
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const epoch = useRef(0);

  const drafts = plan ? draftBook[plan.id]?.drafts ?? createEntityDrafts(plan.content) : {};
  const edits = plan ? buildEntityEdits(plan.content, drafts) : [];
  const dirty = edits.length > 0;
  const unsaved = dirty || script !== savedScript;
  useEffect(() => {
    onUnsavedChange?.(unsaved);
    return () => onUnsavedChange?.(false);
  }, [unsaved, onUnsavedChange]);
  const draftErrors = plan && dirty ? validateEntityDrafts(plan.content, drafts) : [];
  const latestPlan = latestPlanForScript(plans, project?.currentScriptVersionId ?? null);
  const editable = Boolean(plan && latestPlan?.id === plan.id);
  const adopted = Boolean(project && plan && project.activePlanRevisionId === plan.id);
  const checkPassed = check?.result === 'passed' && check.ruleVersion === CURRENT_FACT_CHECK_RULE_VERSION;
  const modelReady = Boolean(modelCatalog?.configured);
  const runModelMatch = Boolean(run && modelCatalog && run.modelConfig.provider === modelCatalog.provider
    && run.modelConfig.model === modelCatalog.defaultModel && run.modelConfig.reasoningEffort === 'model-default');

  useEffect(() => {
    epoch.current += 1;
    const my = epoch.current;
    setBusy('读取'); setMessage('');
    void (async () => {
      try {
        const [selected, runHistory, revisions, catalog] = await Promise.all([
          api<Project>(`/api/projects/${projectId}`),
          api<{ items: Run[] }>(`/api/projects/${projectId}/breakdown-runs`),
          api<{ items: FactPlan[] }>(`/api/projects/${projectId}/plan-revisions`),
          api<ModelCatalog>('/api/models?role=breakdown'),
        ]);
        const saved = selected.currentScriptVersionId
          ? await api<{ rawText: string }>(`/api/projects/${projectId}/script-versions/${selected.currentScriptVersionId}`)
          : { rawText: '' };
        const current = latestPlanForScript(revisions.items, selected.currentScriptVersionId) ?? revisions.items.at(-1) ?? null;
        const status = await readPlanStatus(current);
        if (epoch.current !== my) return;
        setProject(selected); setRuns(runHistory.items); setPlans(revisions.items);
        setRun(runHistory.items.find(item => item.id === current?.runId) ?? runHistory.items[0] ?? null);
        setSavedScript(saved.rawText); setScript(saved.rawText);
        setPlan(current); setCheck(status.check); setIssues(status.issues); setModelCatalog(catalog);
      } catch (reason) {
        if (epoch.current === my) setMessage(reason instanceof Error ? reason.message : '读取项目失败。');
      } finally {
        if (epoch.current === my) setBusy('');
      }
    })();
    return () => { epoch.current += 1; };
  }, [projectId]);

  async function mutate(name: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(name); setMessage('');
    try { await work(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : '操作失败。'); }
    finally { setBusy(''); }
  }

  function reload() {
    void mutate('刷新', async () => {
      const [selected, revisions] = await Promise.all([
        api<Project>(`/api/projects/${projectId}`),
        api<{ items: FactPlan[] }>(`/api/projects/${projectId}/plan-revisions`),
      ]);
      const current = latestPlanForScript(revisions.items, selected.currentScriptVersionId) ?? revisions.items.at(-1) ?? null;
      const status = await readPlanStatus(current);
      setProject(selected); setPlans(revisions.items); setPlan(current); setCheck(status.check); setIssues(status.issues);
    });
  }

  const activePlan = plans.find(item => item.id === project?.activePlanRevisionId) ?? null;
  const primary: ScriptPrimaryAction = deriveScriptState({
    currentScriptVersionId: project?.currentScriptVersionId ?? null,
    runs, plans,
    activePlanRevisionId: project?.activePlanRevisionId ?? null,
    activePlanScriptVersionId: activePlan?.scriptVersionId ?? null,
    check,
  });

  return <div className="project-flow-view">
    <div className="project-flow-hero">
      <span className="project-kicker">SCRIPT & FACTS</span>
      <h2>剧本与事实</h2>
      <p>原文版本、拆解运行与事实采用都归属本项目正式链；人工校对与采用才会更新正式版本。</p>
      <PrimaryActionBanner projectId={projectId} primary={primary} />
    </div>

    <section className="project-flow-card">
      <h3>原文版本</h3>
      <textarea className="project-flow-script" aria-label="创作原文" disabled={!!busy || !project}
        value={script} onChange={event => setScript(event.target.value)} placeholder="粘贴一章小说或一集中文剧本。每次保存创建新版本，旧版本不被覆盖。" />
      <div className="project-flow-row">
        <small>{script !== savedScript ? '原文有未保存修改' : project?.currentScriptVersionId ? '原文已保存' : '尚未保存原文'}</small>
        <button disabled={!!busy || !project || !script.trim() || script === savedScript}
          onClick={() => void mutate('保存原文', async () => {
            await api(`/api/projects/${projectId}/script-versions`, { rawText: script });
            setSavedScript(script); reload();
          })}><Save size={14} />{busy === '保存原文' ? '保存中…' : '保存原文新版本'}</button>
      </div>
    </section>

    <section className="project-flow-card">
      <h3>拆解运行</h3>
      <p className="muted">{modelReady ? `当前拆解模型：${modelCatalog!.defaultModel}` : '拆解模型未配置时，人工校对不受影响；模型调用前会再次确认。'}</p>
      <div className="project-flow-row">
        <button disabled={!!busy || !project?.currentScriptVersionId || script !== savedScript}
          onClick={() => void mutate('创建 Run', async () => {
            const outputBudget = Math.min(32_768, Math.max(256, modelCatalog?.maxOutputTokens ?? 8192));
            await api(`/api/projects/${projectId}/breakdown-runs`, { maxModelCalls: 1, maxOutputTokens: outputBudget, requirements: { language: '中文' } });
            setAllowPaid(false); reload();
          })}>创建拆解 Run</button>
        {runs.length > 0 && <select aria-label="选择运行记录" value={run?.id ?? ''} disabled={!!busy}
          onChange={event => { const chosen = runs.find(item => item.id === event.target.value); if (chosen) { setRun(chosen); setAllowPaid(false); } }}>
          {runs.map(item => <option key={item.id} value={item.id}>{item.id.slice(0, 15)} · {item.status}</option>)}</select>}
      </div>
      {run && <p className="project-flow-status">状态：{run.status} · 模型：{run.modelConfig.model}{!runModelMatch && ' · 历史模型配置已变更，不能继续执行'}</p>}
      <label className="production-consent"><input type="checkbox" checked={allowPaid} disabled={!!busy || !modelReady || !runModelMatch}
        onChange={event => setAllowPaid(event.target.checked)} />我确认此次调用模型，可能产生费用</label>
      <button className="production-primary" disabled={!!busy || !modelReady || !runModelMatch || !run
        || run.status !== 'draft' || run.scriptVersionId !== project?.currentScriptVersionId || script !== savedScript || !allowPaid}
        onClick={() => void mutate('运行拆解', async () => {
          await api(`/api/breakdown-runs/${run!.id}/execute`, { allowPaid: true });
          setAllowPaid(false); reload();
        })}><Play size={14} />{busy === '运行拆解' ? '正在拆解…' : '运行事实拆解'}</button>
    </section>

    {plans.length > 0 && <section className="project-flow-card">
      <div className="project-flow-head"><h3>事实候选与采用</h3>
        <button className="text-button" onClick={reload}>刷新版本列表</button></div>
      <select aria-label="拆解版本" value={plan?.id ?? ''} disabled={!!busy}
        onChange={event => { const chosen = plans.find(item => item.id === event.target.value); if (!chosen) return; setPlan(chosen); setCheck(null); setIssues([]); }}>
        {[...plans].reverse().map(item => <option key={item.id} value={item.id}>
          {item.reason === 'manualEdit' ? '人工校对' : '模型提取'} · {new Date(item.createdAt).toLocaleString('zh-CN')}
          {project?.activePlanRevisionId === item.id ? ' · 已采用' : ' · 候选'}
          {latestPlan?.id === item.id ? ' · 最新' : ' · 历史只读'}
        </option>)}
      </select>
      {plan && <>
        {!editable && <p className="facts-readonly">这是历史拆解版本，仅供查看；请选择当前原文的最新版本继续校对。</p>}
        <div className="production-save-bar"><div>
          <strong>{dirty ? `${edits.length} 项实体有未保存校对` : '当前版本没有未保存校对'}</strong>
        </div><div className="production-actions">
          <button disabled={!!busy || !dirty} onClick={() => setDraftBook(previous => { const next = { ...previous }; delete next[plan.id]; return next; })}>取消修改</button>
          <button className="production-primary" disabled={!!busy || !editable || !dirty || draftErrors.length > 0}
            onClick={() => void mutate('保存校对', async () => {
              await api(`/api/plan-revisions/${plan.id}/entity-edits`, { expectedActivePlanRevisionId: project?.activePlanRevisionId, edits });
              reload();
            })}>{busy === '保存校对' ? '保存中…' : '保存校对为新候选'}</button>
        </div></div>
        {draftErrors.length > 0 && <div className="production-issues" role="alert"><h3>保存前请处理</h3>{draftErrors.map(error => <p key={error}>{error}</p>)}</div>}
        <FactsEditor plan={plan} drafts={drafts} disabled={!!busy || !editable} onChange={(key, draft) => {
          if (!plan || !editable) return;
          setDraftBook(previous => ({ ...previous, [plan.id]: { basePlan: plan, drafts: { ...(previous[plan.id]?.drafts ?? createEntityDrafts(plan.content)), [key]: draft } } }));
        }} />
        <div className="production-actions facts-check-actions">
          <button disabled={!!busy || dirty || !editable} onClick={() => void mutate('程序校验', async () => {
            const result = await api<{ check: Check; issues: PlanCheckIssue[] }>(`/api/plan-revisions/${plan.id}/checks`, {});
            setCheck(result.check); setIssues(result.issues);
          })}>运行程序校验</button>
          <button className="production-primary" disabled={!!busy || dirty || !editable || adopted || !checkPassed}
            onClick={() => void mutate('采用', async () => {
              await api(`/api/projects/${projectId}/adoptions`, { planRevisionId: plan.id, checkId: check!.id, expectedActivePlanRevisionId: project?.activePlanRevisionId });
              reload();
            })}>采用这版事实</button>
        </div>
        <p className="project-flow-status">程序校验：{check ? (checkPassed ? '通过' : check.result === 'failed' ? `未通过 · ${issues.length} 项` : '旧规则已通过') : '未运行'} · {adopted ? '这版已采用' : '这版尚未采用'} · 人工仍需核对语义</p>
        <PlanIssueList issues={issues} />
      </>}
    </section>}
    {message && <p className="production-message" role="status">{message}</p>}
  </div>;
}

function PrimaryActionBanner({ projectId, primary }: { projectId: string; primary: ScriptPrimaryAction }) {
  const copy = {
    'add-script': { title: '添加剧本', detail: '先保存一版原文，再开始拆解事实。' },
    'start-breakdown': { title: '开始拆解', detail: '为当前原文创建并运行拆解 Run（模型调用前会再次确认）。' },
    'review-facts': { title: '核对事实候选', detail: '对照原文校对实体、运行程序校验，再决定采用。' },
    'adopt-facts': { title: '采用事实版本', detail: '校验已通过；人工确认语义后采用，旧版本保留可查。' },
    'into-storyboard': { title: '进入分镜', detail: '事实已采用，可以基于它生成分镜候选。' },
  }[primary];
  return <div className="project-flow-next">
    {primary === 'into-storyboard'
      ? <a className="project-primary-action" href={projectFlowHash(projectId, 'storyboard')}>{copy.title}<ArrowRight size={15} /></a>
      : primary === 'add-script' || primary === 'start-breakdown'
        ? <span className="project-next-hint"><CircleDashed size={15} />{copy.title}：{copy.detail}</span>
        : <span className="project-next-hint"><CheckCircle2 size={15} />{copy.title}：{copy.detail}</span>}
  </div>;
}
