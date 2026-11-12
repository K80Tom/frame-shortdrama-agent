import { useEffect, useState } from 'react';
import FactsEditor from './FactsEditor';
import { PlanIssueList, type PlanCheckIssue } from './plan-issue-list';
import {
  buildEntityEdits, createEntityDrafts, latestPlanForScript, validateEntityDrafts,
  type EntityDraft, type EntityDrafts, type FactPlan,
} from './facts-editor';
import * as api from './project-workspace-api';

const CURRENT_FACT_CHECK_RULE_VERSION = 'extract-facts-completeness/2';
type Check = { id: string; result: 'passed' | 'failed'; ruleVersion: string };

export default function ProjectFactsPanel({ project, plans, disabled, onDirtyChange, onError, onMessage, onProjectChange, onRefresh,
  onManualRepair, onAiRepair, repairBusy }: {
  project: api.ProjectRecord;
  plans: FactPlan[];
  disabled: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
  onProjectChange: (project: api.ProjectRecord) => void;
  onRefresh: () => Promise<void>;
  onManualRepair: (plan: FactPlan, issue: PlanCheckIssue) => void;
  onAiRepair: (plan: FactPlan, check: Check, issue: PlanCheckIssue) => void;
  repairBusy?: boolean;
}) {
  const latestPlan = latestPlanForScript(plans, project.currentScriptVersionId);
  const [planId, setPlanId] = useState<string | null>(latestPlan?.id ?? plans.at(-1)?.id ?? null);
  const [draftBook, setDraftBook] = useState<Record<string, EntityDrafts>>({});
  const [check, setCheck] = useState<Check | null>(null);
  const [issues, setIssues] = useState<PlanCheckIssue[]>([]);
  const [ignoredIssueIds, setIgnoredIssueIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const plan = plans.find(item => item.id === planId) ?? latestPlan ?? plans.at(-1) ?? null;
  const drafts = plan ? draftBook[plan.id] ?? createEntityDrafts(plan.content) : {};
  const edits = plan ? buildEntityEdits(plan.content, drafts) : [];
  const dirty = edits.length > 0;
  const draftErrors = plan && dirty ? validateEntityDrafts(plan.content, drafts) : [];
  const editable = Boolean(plan && latestPlan?.id === plan.id);
  const active = Boolean(plan && project.activePlanRevisionId === plan.id);
  const currentCheckReviewed = check?.ruleVersion === CURRENT_FACT_CHECK_RULE_VERSION;
  const currentCheckPassed = currentCheckReviewed && check?.result === 'passed';
  const visibleIssues = issues.filter(issue => !ignoredIssueIds.includes(issue.id));
  const ignoredCount = issues.length - visibleIssues.length;

  useEffect(() => {
    const latest = latestPlanForScript(plans, project.currentScriptVersionId);
    setPlanId(current => {
      const selected = plans.find(item => item.id === current);
      if (selected?.scriptVersionId === project.currentScriptVersionId) return current;
      return latest?.id ?? plans.at(-1)?.id ?? null;
    });
    // 原文切换后等候选列表刷新完成再选择；同原文内的人工版本选择不被刷新打断。
  }, [project.currentScriptVersionId, plans]);

  useEffect(() => {
    if (!plan) { setCheck(null); setIssues([]); setIgnoredIssueIds([]); return; }
    let alive = true;
    setIgnoredIssueIds([]);
    void api.request<{ items: Check[] }>(`/plan-revisions/${plan.id}/checks`).then(async result => {
      const current = result.items[0] ?? null;
      const currentIssues = current
        ? (await api.request<{ items: PlanCheckIssue[] }>(`/plan-revisions/${plan.id}/checks/${current.id}/issues`)).items
        : [];
      if (alive) { setCheck(current); setIssues(currentIssues); }
    }).catch(() => { if (alive) { setCheck(null); setIssues([]); } });
    return () => { alive = false; };
  }, [plan?.id]);

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  async function action(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); onError('');
    try { await work(); } catch (reason) {
      onError(reason instanceof Error ? reason.message : '事实候选操作失败。');
    } finally { setBusy(false); }
  }

  function updateDraft(key: string, draft: EntityDraft) {
    if (!plan || !editable || busy || disabled) return;
    setDraftBook(previous => ({
      ...previous,
      [plan.id]: { ...(previous[plan.id] ?? createEntityDrafts(plan.content)), [key]: draft },
    }));
  }

  function saveEdits() {
    if (!plan || !editable || !dirty || draftErrors.length) return;
    void action(async () => {
      const saved = await api.request<FactPlan>(`/plan-revisions/${plan.id}/entity-edits`, {
        method: 'POST',
        body: { expectedActivePlanRevisionId: project.activePlanRevisionId, edits },
      });
      setDraftBook(previous => { const next = { ...previous }; delete next[plan.id]; return next; });
      setPlanId(saved.id); setCheck(null); setIssues([]);
      await onRefresh();
      onMessage('校对已保存为新候选；请重新校验，人工核对后再采用。');
    });
  }

  function runCheck() {
    if (!plan || !editable || dirty) return;
    void action(async () => {
      const result = await api.request<{ check: Check; issues: PlanCheckIssue[] }>(`/plan-revisions/${plan.id}/checks`, {
        method: 'POST', body: {},
      });
      setCheck(result.check); setIssues(result.issues); setIgnoredIssueIds([]);
      onMessage(result.check.result === 'passed'
        ? '程序校验通过，请人工核对语义后采用。'
        : `发现 ${result.issues.length} 项校验提示。可修复、仅忽略当前提示，或确认警告后采用。`);
    });
  }

  function adopt() {
    if (!plan || !check || !currentCheckReviewed || dirty || !editable || active) return;
    if (check.result === 'failed' && !window.confirm(
      `当前仍有 ${issues.length} 项校验警告，采用不会自动修复这些问题，后续分镜可能继承缺失内容。已知问题仍继续？`,
    )) return;
    void action(async () => {
      await api.request(`/projects/${project.id}/adoptions`, {
        method: 'POST',
        body: {
          planRevisionId: plan.id, checkId: check.id,
          expectedActivePlanRevisionId: project.activePlanRevisionId,
          ...(check.result === 'failed' ? { allowCheckWarnings: true } : {}),
        },
      });
      onProjectChange(await api.getProject(project.id));
      onMessage(check.result === 'failed'
        ? `已在保留 ${issues.length} 项校验警告的情况下采用这版事实，可继续后续分镜。`
        : '已采用这版事实候选，旧版本仍可从版本列表查看。');
    });
  }

  if (!plan) return <p className="muted">当前原文还没有事实候选。</p>;
  return <div className="project-facts-panel">
    <div className="facts-version-picker">
      <label htmlFor="script-facts-plan">事实候选版本</label>
      <select id="script-facts-plan" disabled={busy || disabled} value={plan.id}
        onChange={event => setPlanId(event.target.value)}>
        {[...plans].reverse().map(item => <option key={item.id} value={item.id}>
          {item.reason === 'manualEdit' ? '人工校对' : '模型提取'} · {new Date(item.createdAt).toLocaleString('zh-CN')}
          {project.activePlanRevisionId === item.id ? ' · 已采用' : ' · 候选'}{latestPlan?.id === item.id ? ' · 最新' : ' · 历史只读'}
        </option>)}
      </select>
    </div>
    {!editable && <p className="facts-readonly">这是历史候选，仅供查看。请选择当前原文的最新版本继续校对。</p>}
    <div className="facts-save-bar">
      <div><strong>{dirty ? `${edits.length} 项实体有未保存校对` : '当前版本没有未保存校对'}</strong>
        <small>保存后请重新校验，再决定是否采用。</small></div>
      <div className="project-actions">
        <button className="button-secondary" disabled={busy || disabled || !dirty} onClick={() => {
          if (!window.confirm('取消当前版本的未保存校对？')) return;
          setDraftBook(previous => { const next = { ...previous }; delete next[plan.id]; return next; });
        }}>取消修改</button>
        <button className="button-primary" disabled={busy || disabled || !editable || !dirty || draftErrors.length > 0} onClick={saveEdits}>保存校对为新候选</button>
      </div>
    </div>
    {draftErrors.length > 0 && <div className="production-issues" role="alert">{draftErrors.map(error => <p key={error}>{error}</p>)}</div>}
    <FactsEditor plan={plan} drafts={drafts} disabled={busy || disabled || !editable} onChange={updateDraft} />
    <div className="project-actions facts-check-actions">
      <button className="button-secondary" disabled={busy || disabled || dirty || !editable} onClick={runCheck}>运行程序校验</button>
      <button className="button-primary" disabled={busy || disabled || dirty || !editable || active || !currentCheckReviewed} onClick={adopt}>
        {check?.result === 'failed' ? '确认警告并采用' : '采用这版事实'}
      </button>
      <small>程序校验：{check ? check.result === 'passed' ? currentCheckPassed ? '通过' : '旧规则已通过 · 请重跑' : `警告 ${issues.length} 项 · 确认后仍可采用` : '未运行'} · {active ? '这版已采用' : '这版尚未采用'}</small>
    </div>
    {issues.length > 0 && <div className="facts-check-guidance" role="status">
      <strong>校验提示不会阻止你继续</strong>
      <p>对白问题可使用 AI 修复或手动定位；忽略只关闭当前提示，不修改原文、剧本或候选。也可以确认全部警告后采用。</p>
    </div>}
    <PlanIssueList issues={visibleIssues} renderActions={issue => {
      const repairable = ['DIALOGUE_MISSING', 'SCENE_DIALOGUE_MISSING'].includes(issue.code);
      const repairDisabled = busy || disabled || repairBusy || dirty || !editable || !check;
      return <>
        {repairable && <button type="button" className="button-primary" disabled={repairDisabled}
          title="调用模型生成修复预览，确认保存后自动重跑校验"
          onClick={() => check && onAiRepair(plan, check, issue)}>{repairBusy ? 'AI 修复中…' : 'AI 修复'}</button>}
        {repairable && <button type="button" className="button-secondary" disabled={repairDisabled}
          title="定位到对应场次和原文，手动补齐内容"
          onClick={() => onManualRepair(plan, issue)}>手动修复</button>}
        <button type="button" className="button-secondary" disabled={busy || disabled || dirty || !editable || !check}
          title="只关闭当前警告，不修改任何数据；重新校验会再次出现"
          onClick={() => {
            setIgnoredIssueIds(previous => previous.includes(issue.id) ? previous : [...previous, issue.id]);
            onMessage('已忽略当前警告，未修改任何数据；重新校验后仍会提示。');
          }}>忽略</button>
      </>;
    }} />
    {ignoredCount > 0 && <p className="facts-ignored-note">已在当前页面忽略 {ignoredCount} 项提示；原校验记录仍保留。<button type="button" className="button-link" onClick={() => setIgnoredIssueIds([])}>恢复显示</button></p>}
    <div className="production-facts facts-synopsis"><article><h3>剧情梗概 · 只读</h3><p>{plan.content.synopsis?.value ?? '未提取'}</p></article></div>
    <h3 className="production-scenes-title">场次与对白 · 只读核对</h3>
    {plan.content.scenes.map(scene => <article className="production-scene" key={scene.id}>
      <div><strong>{String(scene.order).padStart(2, '0')} · {scene.title.value}</strong><small>{scene.sourceRefs.length} 段原文</small></div>
      {plan.content.dialogues.filter(line => line.sceneId === scene.id).map(line => <blockquote key={line.id}>
        <b>{plan.content.characters.find(item => item.id === line.speakerId)?.name.value ?? '待确认人物'}：</b>{line.sourceRef.quote}
      </blockquote>)}
    </article>)}
  </div>;
}
