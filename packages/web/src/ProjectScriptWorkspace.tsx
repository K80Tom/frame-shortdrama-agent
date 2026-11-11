import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CircleDashed, CheckCircle2, Save, Sparkles, X } from 'lucide-react';
import FactsEditor from './FactsEditor';
import StructuredScriptEditor from './StructuredScriptEditor';
import { PlanIssueList, type PlanCheckIssue } from './plan-issue-list';
import type { ScriptParseCharacter } from '@lyra/shared';
import { emptyScriptStructure, type ScriptStructure } from './script-structure';
import {
  buildEntityEdits, createEntityDrafts, latestPlanForScript, synopsisChanged, synopsisDraftErrors,
  synopsisEditValue, validateEntityDrafts,
  type EntityDrafts, type FactPlan,
} from './facts-editor';
import { workspaceFetch } from './deployment';
import { projectFlowHash } from './project-flow';
import './project-workspace.css';

type Project = { id: string; title: string; currentScriptVersionId: string | null; activePlanRevisionId: string | null };
type Run = { id: string; status: string; scriptVersionId: string; modelConfig: { provider: string; model: string; reasoningEffort: string; connectionRevision?: string } };
type ModelCatalog = { provider: string; configured: boolean; defaultModel: string; maxOutputTokens?: number; connectionRevision?: string };
type ScriptVersionDetail = { id: string; version: number; rawText: string; structure: ScriptStructure | null };
type ScriptParseResponse = { structure: ScriptStructure; characters: ScriptParseCharacter[]; attemptId: string; model: string };
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
  const [scriptStructure, setScriptStructure] = useState<ScriptStructure>(emptyScriptStructure);
  const [structureReady, setStructureReady] = useState(false);
  const [structuredMode, setStructuredMode] = useState(false);
  const [parseCharacters, setParseCharacters] = useState<ScriptParseCharacter[]>([]);
  const [parsePreview, setParsePreview] = useState(false);
  const [parseConsent, setParseConsent] = useState(false);
  const [structureDirty, setStructureDirty] = useState(false);
  const [synopsisDraft, setSynopsisDraft] = useState('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const [plans, setPlans] = useState<FactPlan[]>([]);
  const [plan, setPlan] = useState<FactPlan | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [issues, setIssues] = useState<PlanCheckIssue[]>([]);
  const [draftBook, setDraftBook] = useState<Record<string, { basePlan: FactPlan; drafts: EntityDrafts }>>({});
  const [busy, setBusy] = useState('');
  const [savingSceneId, setSavingSceneId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const epoch = useRef(0);

  const drafts = plan ? draftBook[plan.id]?.drafts ?? createEntityDrafts(plan.content) : {};
  const edits = plan ? buildEntityEdits(plan.content, drafts) : [];
  const dirty = edits.length > 0 || synopsisChanged(plan, synopsisDraft);
  const unsaved = dirty || script !== savedScript || structureDirty;
  useEffect(() => {
    onUnsavedChange?.(unsaved);
    return () => onUnsavedChange?.(false);
  }, [unsaved, onUnsavedChange]);
  const draftErrors = plan
    ? [...(dirty ? validateEntityDrafts(plan.content, drafts) : []), ...synopsisDraftErrors(plan, synopsisDraft)]
    : [];
  const latestPlan = latestPlanForScript(plans, project?.currentScriptVersionId ?? null);
  const editable = Boolean(plan && latestPlan?.id === plan.id);
  const adopted = Boolean(project && plan && project.activePlanRevisionId === plan.id);
  const checkPassed = check?.result === 'passed' && check.ruleVersion === CURRENT_FACT_CHECK_RULE_VERSION;
  const modelReady = Boolean(modelCatalog?.configured);

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
          ? await api<ScriptVersionDetail>(`/api/projects/${projectId}/script-versions/${selected.currentScriptVersionId}`)
          : { id: '', version: 0, rawText: '', structure: null };
        const savedStructure = saved.structure;
        const current = latestPlanForScript(revisions.items, selected.currentScriptVersionId) ?? revisions.items.at(-1) ?? null;
        const status = await readPlanStatus(current);
        if (epoch.current !== my) return;
        setProject(selected); setRuns(runHistory.items); setPlans(revisions.items);
        setSavedScript(saved.rawText); setScript(saved.rawText);
        setStructureReady(Boolean(savedStructure)); setStructuredMode(Boolean(savedStructure));
        setScriptStructure(savedStructure ?? emptyScriptStructure());
        setParseCharacters([]); setParsePreview(false); setParseConsent(false); setStructureDirty(false);
        setSynopsisDraft(current?.content.synopsis?.value ?? '');
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

  async function refreshAfterSave() {
    const [selected, revisions] = await Promise.all([
      api<Project>(`/api/projects/${projectId}`),
      api<{ items: FactPlan[] }>(`/api/projects/${projectId}/plan-revisions`),
    ]);
    const current = latestPlanForScript(revisions.items, selected.currentScriptVersionId) ?? revisions.items.at(-1) ?? null;
    const status = await readPlanStatus(current);
    setProject(selected); setPlans(revisions.items); setPlan(current); setCheck(status.check); setIssues(status.issues);
    setSynopsisDraft(current?.content.synopsis?.value ?? '');
  }

  function reload() {
    void mutate('刷新', async () => {
      const [selected, revisions] = await Promise.all([
        api<Project>(`/api/projects/${projectId}`),
        api<{ items: FactPlan[] }>(`/api/projects/${projectId}/plan-revisions`),
      ]);
      if (selected.currentScriptVersionId) {
        const detail = await api<ScriptVersionDetail>(`/api/projects/${projectId}/script-versions/${selected.currentScriptVersionId}`);
        setSavedScript(detail.rawText); setScript(detail.rawText);
        setStructureReady(Boolean(detail.structure)); setStructuredMode(Boolean(detail.structure));
        setScriptStructure(detail.structure ?? emptyScriptStructure());
        setParseCharacters([]); setParsePreview(false); setStructureDirty(false);
      }
      const current = latestPlanForScript(revisions.items, selected.currentScriptVersionId) ?? revisions.items.at(-1) ?? null;
      const status = await readPlanStatus(current);
      setProject(selected); setPlans(revisions.items); setPlan(current); setCheck(status.check); setIssues(status.issues);
      setSynopsisDraft(current?.content.synopsis?.value ?? '');
    });
  }

  function syncStructure(next: ScriptStructure) {
    setScriptStructure(next);
    setStructureDirty(true);
  }

  function saveStructure(sceneId?: string) {
    void mutate(sceneId ? '保存本场' : '保存剧本', async () => {
      if (sceneId) setSavingSceneId(sceneId);
      try {
        const detail = await api<ScriptVersionDetail>(`/api/projects/${projectId}/script-versions`, {
          structure: scriptStructure, rawText: savedScript,
        });
        const nextStructure = detail.structure ?? scriptStructure;
        setSavedScript(detail.rawText); setScript(detail.rawText); setScriptStructure(nextStructure);
        setStructureDirty(false);
        await refreshAfterSave();
        setMessage(sceneId ? '本场已保存为新剧本版本。' : '剧本已保存为新版本。');
      } finally {
        if (sceneId) setSavingSceneId(null);
      }
    });
  }


  function startParse() {
    void mutate('AI解析', async () => {
      if (!project?.currentScriptVersionId || script !== savedScript) return;
      const result = await api<ScriptParseResponse>(`/api/projects/${projectId}/script-parses`, {
        allowPaid: true,
        scriptVersionId: project.currentScriptVersionId,
        expectedModelConnectionRevision: modelCatalog?.connectionRevision,
      });
      setScriptStructure(result.structure);
      setParseCharacters(result.characters); setStructureDirty(false);
      setStructureReady(true); setStructuredMode(true); setParsePreview(true); setParseConsent(false);
      setMessage(`AI 解析完成（${result.model}）：请核对自动拆出的场次和人物，确认后保存。`);
    });
  }

  function renameInStructure(from: string, to: string) {
    if (!from || from === to) return;
    setScriptStructure(previous => ({ ...previous, episodes: previous.episodes.map(episode => ({
      ...episode,
      scenes: episode.scenes.map(scene => ({ ...scene, dialogues: scene.dialogues.map(element =>
        element.characterName === from ? { ...element, characterName: to } : element) })),
    })) }));
  }

  function patchParseCharacter(index: number, patch: Partial<ScriptParseCharacter>) {
    const current = parseCharacters[index];
    if (patch.name !== undefined && current) renameInStructure(current.name, patch.name);
    setParseCharacters(previous => previous.map((character, itemIndex) =>
      itemIndex === index ? { ...character, ...patch } : character));
  }

  function removeParseCharacter(index: number) {
    const removed = parseCharacters[index];
    if (removed) renameInStructure(removed.name, '');
    setParseCharacters(previous => previous.filter((_, current) => current !== index));
  }

  function appendParseCharacter() {
    setParseCharacters(previous => [...previous, { name: '', aliases: [], description: null }]);
  }

  function cancelParse() {
    setParsePreview(false);
    setParseCharacters([]);
    setMessage('已取消本次 AI 解析预览，原文和当前剧本版本没有变化。');
    reload();
  }

  function confirmParse() {
    void mutate('确认解析', async () => {
      const detail = await api<ScriptVersionDetail>(`/api/projects/${projectId}/script-versions`, {
        structure: scriptStructure, rawText: savedScript,
      });
      setSavedScript(detail.rawText); setScript(detail.rawText); setScriptStructure(detail.structure ?? scriptStructure);
      setStructureDirty(false);
      let candidateError = '';
      if (parseCharacters.length > 0) {
        try {
          await api(`/api/projects/${projectId}/script-character-candidates`, {
            scriptVersionId: detail.id,
            characters: parseCharacters.map(character => ({
              name: character.name.trim(),
              aliases: character.aliases.map((alias: string) => alias.trim()).filter(Boolean),
              description: character.description?.trim() || null,
            })),
          });
        } catch (reason) {
          candidateError = reason instanceof Error ? reason.message : '人物候选创建失败。';
        }
      }
      setParsePreview(false); setParseCharacters([]); setParseConsent(false);
      await refreshAfterSave();
      setMessage(candidateError
        ? `分集/场次已保存为新剧本版本，但人物候选没有创建：${candidateError}`
        : '分集/场次已保存为新剧本版本，人物候选已创建；请继续核对事实。');
    });
  }

  const previewSafeSave = parsePreview ? undefined : (_episodeId: string, sceneId: string) => saveStructure(sceneId);

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
      <p>原文版本、AI 解析与事实采用都归属本项目正式链；人工校对与采用才会更新正式版本。</p>
      <PrimaryActionBanner projectId={projectId} primary={primary} />
    </div>

    <section className="project-flow-card">
      <div className="project-flow-head">
        <h3>剧本内容</h3>
        <button className="text-button" disabled={!!busy || parsePreview || !structureReady}
          onClick={() => setStructuredMode(!structuredMode)}>{!structureReady ? 'AI 解析后可切换' : structuredMode ? '切换到原文' : '切换到结构化编辑'}</button>
      </div>
      {structuredMode
        ? <StructuredScriptEditor structure={scriptStructure} disabled={!!busy || !project || parsePreview}
            preview={parsePreview}
            savingSceneId={savingSceneId} onSaveScene={previewSafeSave}
            onChange={syncStructure} />
        : <textarea className="project-flow-script" aria-label="创作原文" disabled={!!busy || !project}
            value={script} onChange={event => setScript(event.target.value)} placeholder="粘贴一整段中文故事或剧本。保存原文后点「AI 解析分场与人物」，系统会自动拆场次并识别人物。" />}

      {!structureReady && !parsePreview && <div className="script-parse-cta">
        <div>
          <h4><Sparkles size={15} />AI 解析分场与人物</h4>
          <p>当前原文还没有场次结构。解析会把整段按 1 集处理，自动拆场、识别人物，并填入对白/动作/旁白/镜头/环境。解析结果先进入可编辑预览，不直接保存。</p>
        </div>
        <label className="production-consent"><input type="checkbox" checked={parseConsent}
          disabled={!!busy || !modelReady || script !== savedScript || !project?.currentScriptVersionId}
          onChange={event => setParseConsent(event.target.checked)} />我确认调用拆解模型 {modelCatalog?.defaultModel ?? ''}，可能产生费用</label>
        <button className="production-primary" disabled={!!busy || !modelReady || !parseConsent
          || script !== savedScript || !project?.currentScriptVersionId}
          onClick={startParse}><Sparkles size={14} />{busy === 'AI解析' ? '正在解析…' : 'AI 解析分场与人物'}</button>
        {script !== savedScript && <small>原文有未保存修改，请先点「保存剧本新版本」再解析。</small>}
        {!modelReady && <small>拆解模型未配置，暂时不能解析。<a href="#/settings/models">去配置模型</a></small>}
      </div>}

      {parsePreview && <div className="script-character-preview">
        <div className="project-flow-head"><h4>AI 识别人物（可编辑）</h4><span className="muted">确认后创建人物候选，不覆盖已采用事实</span></div>
        <div><button type="button" className="text-button" disabled={!!busy} onClick={appendParseCharacter}>+ 添加人物</button></div>
        {parseCharacters.length === 0 && <p className="muted">没有识别人物。你仍可以保存场次结构，或返回原文补充人物后重新解析。</p>}
        {parseCharacters.map((character, index) => <div className="script-character-row" key={index}>
          <label>姓名<input value={character.name} disabled={!!busy}
            onChange={event => patchParseCharacter(index, { name: event.target.value })} /></label>
          <label>别名<input value={character.aliases.join('、')} disabled={!!busy}
            onChange={event => patchParseCharacter(index, { aliases: event.target.value.split(/[、,，]/).map(value => value.trim()).filter(Boolean) })} placeholder="用顿号分隔，可空" /></label>
          <label className="wide">说明<input value={character.description ?? ''} disabled={!!busy}
            onChange={event => patchParseCharacter(index, { description: event.target.value || null })} placeholder="简短人物说明，可空" /></label>
          <button type="button" className="script-character-remove" aria-label={`删除人物 ${character.name}`}
            disabled={!!busy} onClick={() => removeParseCharacter(index)}><X size={14} /></button>
        </div>)}
        <div className="project-flow-row">
          <small>场次与元素也可以直接修改；确认后会生成新的剧本版本。</small>
          <div className="production-actions">
            <button disabled={!!busy} onClick={cancelParse}>取消预览</button>
            <button className="production-primary" disabled={!!busy
              || parseCharacters.some(character => !character.name.trim())}
              onClick={confirmParse}>{busy === '确认解析' ? '保存中…' : '确认保存并创建人物候选'}</button>
          </div>
        </div>
      </div>}

      {!parsePreview && <div className="project-flow-row">
        <small>{script !== savedScript ? '剧本有未保存修改' : project?.currentScriptVersionId ? '剧本已保存' : '尚未保存剧本'}</small>
        <button disabled={!!busy || !project || (structuredMode ? !structureDirty : !script.trim() || script === savedScript)}
          onClick={() => {
            if (!structuredMode) {
              void mutate('保存原文', async () => {
                const detail = await api<ScriptVersionDetail>(`/api/projects/${projectId}/script-versions`, { rawText: script });
                setSavedScript(detail.rawText); setScript(detail.rawText);
                setStructureReady(false); setStructuredMode(false);
                setScriptStructure(emptyScriptStructure()); setParseCharacters([]); setParsePreview(false); setStructureDirty(false);
                await refreshAfterSave();
                setMessage('原文已保存；请点「AI 解析分场与人物」生成场次和人物。');
              });
              return;
            }
            saveStructure();
          }}><Save size={14} />{busy === '保存原文' || busy === '保存剧本' ? '保存中…' : '保存剧本新版本'}</button>
      </div>}
    </section>
    {plans.length > 0 && <section className="project-flow-card">
      <div className="project-flow-head"><h3>事实候选与采用</h3>
        <button className="text-button" onClick={reload}>刷新版本列表</button></div>
      <select aria-label="拆解版本" value={plan?.id ?? ''} disabled={!!busy}
        onChange={event => { const chosen = plans.find(item => item.id === event.target.value); if (!chosen) return; setPlan(chosen); setCheck(null); setIssues([]); setSynopsisDraft(chosen.content.synopsis?.value ?? ''); }}>
        {[...plans].reverse().map(item => <option key={item.id} value={item.id}>
          {item.reason === 'manualEdit' ? '人工校对' : '模型提取'} · {new Date(item.createdAt).toLocaleString('zh-CN')}
          {project?.activePlanRevisionId === item.id ? ' · 已采用' : ' · 候选'}
          {latestPlan?.id === item.id ? ' · 最新' : ' · 历史只读'}
        </option>)}
      </select>
      {plan && <>
        {!editable && <p className="facts-readonly">这是历史拆解版本，仅供查看；请选择当前原文的最新版本继续校对。</p>}
        <div className="project-flow-synopsis">
          <label htmlFor="project-facts-synopsis">剧情梗概</label>
          <textarea id="project-facts-synopsis" value={synopsisDraft} disabled={!!busy || !editable}
            onChange={event => setSynopsisDraft(event.target.value)}
            placeholder="用一两句话概括本集剧情；拆解没有提取到梗概时，可在这里人工补写。" />
          {plan.content.synopsis && <small>原文依据：{plan.content.synopsis.sourceRefs[0]?.quote ?? '人工填写'}</small>}
        </div>
        <div className="production-save-bar"><div>
          <strong>{dirty ? `${edits.length} 项实体${synopsisChanged(plan, synopsisDraft) ? '和梗概' : ''}有未保存校对` : '当前版本没有未保存校对'}</strong>
        </div><div className="production-actions">
          <button disabled={!!busy || !dirty} onClick={() => setDraftBook(previous => { const next = { ...previous }; delete next[plan.id]; return next; })}>取消修改</button>
          <button className="production-primary" disabled={!!busy || !editable || !dirty || draftErrors.length > 0}
            onClick={() => void mutate('保存校对', async () => {
              const synopsis = synopsisEditValue(plan, synopsisDraft);
              await api(`/api/plan-revisions/${plan.id}/entity-edits`, { expectedActivePlanRevisionId: project?.activePlanRevisionId, edits,
                ...(synopsis === undefined ? {} : { synopsis }) });
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
          })}>{busy === '程序校验' ? '校验中…' : check ? '重新运行程序校验' : '运行程序校验'}</button>
          <button className="production-primary" disabled={!!busy || dirty || !editable || adopted || !checkPassed}
            onClick={() => void mutate('采用', async () => {
              await api(`/api/projects/${projectId}/adoptions`, { planRevisionId: plan.id, checkId: check!.id, expectedActivePlanRevisionId: project?.activePlanRevisionId });
              reload();
            })}>采用这版事实</button>
        </div>
        <p className="project-flow-status">程序校验：{check ? (checkPassed ? '通过' : check.result === 'failed' ? `未通过 · ${issues.length} 项` : '旧规则已通过') : '未运行'} · {adopted ? '这版已采用' : '这版尚未采用'} · 人工仍需核对语义</p>
        {check?.result === 'failed' && <p className="project-flow-status">校验未通过：按待处理问题修改后，先保存为新候选，再重新运行程序校验。</p>}
        <PlanIssueList issues={issues} />
      </>}
    </section>}
    {message && <p className="production-message" role="status">{message}</p>}
  </div>;
}

function PrimaryActionBanner({ projectId, primary }: { projectId: string; primary: ScriptPrimaryAction }) {
  const copy = {
    'add-script': { title: '添加剧本', detail: '先保存一版原文，再开始拆解事实。' },
    'start-breakdown': { title: '开始拆解', detail: '保存原文后点「AI 解析分场与人物」，解析结果先预览再保存。' },
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
