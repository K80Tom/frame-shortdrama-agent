import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, BookOpen, Check, ChevronRight, FileText, History, RefreshCw, Save, Sparkles } from 'lucide-react';
import {
  SCRIPT_ELEMENT_LABELS,
  applySelectedDiffs, diffScriptStructures, parseScriptStructure, emptyScriptStructure,
  validateScriptStructure,
  type ScriptDiffItem, type ScriptParseAttempt, type ScriptParseCharacter, type ScriptParseEntity,
  type ScriptParseResult, type ScriptStructure, type ScriptDialogueRepairPreview,
} from '@lyra/shared';
import * as api from './project-workspace-api';
import ProjectFactsPanel from './ProjectFactsPanel';
import StructuredScriptEditor from './StructuredScriptEditor';
import type { FactPlan } from './facts-editor';
import type { PlanCheckIssue } from './plan-issue-list';
import { projectFlowHash, type ScriptWorkspacePanel } from './project-flow';
import {
  clearScriptParsePreview, draftFromParseAttempt, readScriptParsePreview, writeScriptParsePreview,
} from './script-parse-preview';
import { countScriptCharacters, estimateSceneCount } from './script-structure';

type PreviewResult = ScriptParseResult & { attemptId: string; model: string; promptVersion: string };

export function deriveScriptState(input: {
  currentScriptVersionId: string | null;
  runs: Array<{ id: string; scriptVersionId: string }>;
  plans: Array<{ id: string; scriptVersionId: string }>;
  activePlanRevisionId: string | null;
  activePlanScriptVersionId: string | null;
  check: { result: string; ruleVersion: string } | null;
}): 'add-script' | 'start-breakdown' | 'review-facts' | 'adopt-facts' | 'into-storyboard' {
  if (!input.currentScriptVersionId) return 'add-script';
  if (!input.runs.some(run => run.scriptVersionId === input.currentScriptVersionId)) return 'start-breakdown';
  const plan = input.plans.filter(item => item.scriptVersionId === input.currentScriptVersionId).at(-1);
  if (!plan) return 'review-facts';
  if (input.activePlanRevisionId === plan.id && input.activePlanScriptVersionId === input.currentScriptVersionId) return 'into-storyboard';
  return input.check?.result === 'passed' && input.check.ruleVersion === 'extract-facts-completeness/2'
    ? 'adopt-facts' : 'review-facts';
}

/**
 * 付费纪律的单一判定：只有已保存原文、模型配置就绪、原文无未保存修改，
 * 且用户显式勾选模型调用确认时才允许发起 AI 解析。
 */
export function canStartParse(input: {
  approved: boolean;
  busy: boolean;
  modelRevision: string;
  savedScript: { rawText: string } | null;
  script: string;
  dirty: boolean;
}): boolean {
  if (!input.savedScript) return false;
  if (input.busy || !input.approved || !input.modelRevision) return false;
  if (input.dirty || input.script !== input.savedScript.rawText) return false;
  return true;
}

export function repairSceneTarget(plan: FactPlan, issue: PlanCheckIssue, structure: ScriptStructure) {
  const sourceScenes = plan.content.scenes;
  const direct = issue.scope?.kind === 'scene'
    ? sourceScenes.find(scene => scene.id === issue.scope?.targetId)
    : sourceScenes.find(scene => scene.sourceRefs.some(sceneRef => issue.sourceRefs.some(issueRef =>
      sceneRef.start <= issueRef.start && sceneRef.end >= issueRef.end)));
  const candidates = direct ? [direct] : [];
  for (const scene of candidates) {
    for (const episode of structure.episodes) {
      const exact = episode.scenes.find(item => item.sceneNumber === scene.title.value);
      if (exact) return { sceneId: exact.id, sceneNumber: exact.sceneNumber };
    }
    const ordered = structure.episodes.flatMap(episode => episode.scenes)[scene.order - 1];
    if (ordered) return { sceneId: ordered.id, sceneNumber: ordered.sceneNumber };
  }
  return null;
}

function patchEntity(items: ScriptParseEntity[], index: number, patch: Partial<ScriptParseEntity>): ScriptParseEntity[] {
  return items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item);
}

export function ScriptParseEntityFields({ label, items, disabled, onPatch, onRemove, onAppend, addLabel }: {
  label: string; items: ScriptParseEntity[]; disabled: boolean;
  onPatch: (index: number, patch: Partial<ScriptParseEntity>) => void;
  onRemove: (index: number) => void;
  onAppend: () => void;
  addLabel?: string;
}) {
  const noun = label === '场景 / 地点' ? '地点' : label;
  return <section className="script-parse-entity-group" aria-label={`${label}解析结果`}>
    <h5>{label} <span className="muted">{items.length}</span></h5>
    {items.length === 0 && <p className="muted">本次没有识别到{noun}，可以手动添加。</p>}
    {items.map((item, index) => <div className="script-character-row" key={`${label}-${index}`}>
      <input aria-label={`${noun}名称`} value={item.name} disabled={disabled}
        onChange={event => onPatch(index, { name: event.target.value })} />
      <input aria-label={`${noun}别名`} value={item.aliases.join('、')} placeholder="别名（顿号分隔）" disabled={disabled}
        onChange={event => onPatch(index, { aliases: event.target.value.split(/[、，,]/u).map(value => value.trim()).filter(Boolean) })} />
      <input aria-label={`${noun}说明`} value={item.description ?? ''} placeholder="说明" disabled={disabled}
        onChange={event => onPatch(index, { description: event.target.value || null })} />
      <button type="button" disabled={disabled} aria-label={`删除${noun} ${item.name}`} onClick={() => onRemove(index)}>删除</button>
    </div>)}
    <button className="button-secondary" type="button" disabled={disabled} onClick={onAppend}>{addLabel ?? `+ 添加${noun}`}</button>
  </section>;
}

/* -------------------------------------------------------------------------
 * 阶段一：选择性差异比对面板
 * 只展示真正变化的结构项；勾选=采纳 AI 修改，取消勾选=保留原版内容。
 * ---------------------------------------------------------------------- */

export interface ScriptDiffGroup {
  key: string;
  episodeNumber: number;
  episodeTitle: string;
  category: ScriptDiffItem['category'];
  sceneNumber: string;
  sceneIndex: number;
  items: ScriptDiffItem[];
}

/** 差异项按“分集 → 场次”分组；相同内容已在 diffScriptStructures 中过滤。 */
export function groupScriptDiffs(items: ScriptDiffItem[]): ScriptDiffGroup[] {
  const groups: ScriptDiffGroup[] = [];
  for (const item of items) {
    // 场次锚点来自差异 ID（base: 或 draft: 前缀），避免“新增场次”与相邻场次错并到一组。
    const anchorMatch = /\|scene:([^|]+)/u.exec(item.id);
    const key = item.category === 'episode'
      ? `episode|${item.episodeNumber}`
      : `${item.episodeNumber}|${anchorMatch?.[1] ?? `index:${item.sceneIndex}`}`;
    const last = groups.at(-1);
    if (last && last.key === key) {
      last.items.push(item);
      continue;
    }
    groups.push({
      key, episodeNumber: item.episodeNumber, episodeTitle: item.episodeTitle, category: item.category,
      sceneNumber: item.sceneNumber, sceneIndex: item.sceneIndex, items: [item],
    });
  }
  return groups;
}

/** 顶部统计：新增 / 修改 / 删除，便于用户先看总量再决定是否逐项勾选。 */
export function scriptDiffCounts(items: ScriptDiffItem[]) {
  let inserted = 0;
  let removed = 0;
  let modified = 0;
  for (const item of items) {
    if (item.kind.endsWith('-inserted')) inserted += 1;
    else if (item.kind.endsWith('-removed')) removed += 1;
    else modified += 1;
  }
  return { inserted, removed, modified, total: items.length };
}

function groupTitle(group: ScriptDiffGroup): string {
  if (group.category === 'episode') return `第${group.episodeNumber}集 · ${group.episodeTitle} · 分集级`;
  return `第${group.episodeNumber}集 · 第${group.sceneIndex + 1}场 ${group.sceneNumber || '新场次'}`;
}

export function ScriptDiffReviewPanel({ base, draft, selectedIds, disabled, readOnly, items: providedItems,
  onToggle, onSelectAll, onSelectNone }: {
  base: ScriptStructure | null;
  draft: ScriptStructure;
  selectedIds: ReadonlySet<string>;
  disabled?: boolean;
  readOnly?: boolean;
  /** 父级已经算过差异时直接复用，避免同一对结构重复做对齐。 */
  items?: ScriptDiffItem[];
  onToggle?: (id: string, next: boolean) => void;
  onSelectAll?: () => void;
  onSelectNone?: () => void;
}) {
  const items = useMemo(() => providedItems ?? diffScriptStructures(base, draft), [providedItems, base, draft]);
  const groups = useMemo(() => groupScriptDiffs(items), [items]);
  const counts = scriptDiffCounts(items);
  const selectedCount = items.filter(item => selectedIds.has(item.id)).length;
  const locked = Boolean(disabled || readOnly);

  return <section id="script-diff-panel" className="project-flow-card script-diff-card" data-testid="script-diff-panel">
    <header className="project-flow-card-heading">
      <span className="project-section-icon"><Check size={18} /></span>
      <div><p className="project-kicker">CHERRY-PICK DIFF</p><h2>选择性差异比对</h2></div>
      <div className="script-diff-toolbar">
        <button className="button-secondary" type="button" disabled={locked || items.length === 0} onClick={onSelectAll}>
          全部采纳修改
        </button>
        <button className="button-secondary" type="button" disabled={locked || items.length === 0} onClick={onSelectNone}>
          全部保留原版
        </button>
      </div>
    </header>
    <p className="muted">
      仅展示解析草稿与正式剧本的变动项，相同内容已隐藏。
      勾选 <strong>采纳 AI 修改</strong>，取消勾选 <strong>保留原版内容</strong>；
      已采纳 <strong data-testid="script-diff-selected-count">{selectedCount}</strong> / {counts.total} 项。
      {readOnly ? ' 这是历史解析结果，只读查看，不能合入当前剧本。' : ''}
    </p>
    <div className="script-diff-stats" aria-label="差异统计">
      <span className="script-diff-stat kind-inserted">新增 {counts.inserted}</span>
      <span className="script-diff-stat kind-modified">修改 {counts.modified}</span>
      <span className="script-diff-stat kind-removed">删除 {counts.removed}</span>
    </div>
    {items.length === 0
      ? <p className="script-diff-empty">解析结果与当前正式版本完全一致，没有需要合并的修改；确认后只会保存事实候选。</p>
      : <div className="script-diff-groups">
        {groups.map(group => <div className="script-diff-group" key={group.key}>
          <header>
            <strong>{groupTitle(group)}</strong>
            <small>{group.items.length} 项变动</small>
          </header>
          {group.items.map((item, index) => {
            const checked = selectedIds.has(item.id);
            return <label className={`script-diff-item kind-${item.kind} ${checked ? 'is-selected' : 'is-kept'}`}
              key={item.id} data-diff-id={item.id}>
              <input type="checkbox" checked={checked} disabled={locked}
                aria-label={`采纳${item.label}（第${item.episodeNumber}集 ${item.sceneNumber || '分集'} 第${index + 1}项）`}
                onChange={event => onToggle?.(item.id, event.target.checked)} />
              <span className="script-diff-item-main">
                <span className="script-diff-item-head">
                  <span className="script-diff-item-label">{item.label}</span>
                  {item.elementType && <em className="script-diff-element-type">{SCRIPT_ELEMENT_LABELS[item.elementType]}</em>}
                  <span className={checked ? 'script-diff-choice adopt' : 'script-diff-choice keep'}>
                    {checked ? '采纳 AI 修改' : '保留原版内容'}
                  </span>
                </span>
                <span className="script-diff-item-values">
                  {item.before && <del>{item.before}</del>}
                  {item.before && item.after && <span className="script-diff-arrow">→</span>}
                  {item.after && <ins>{item.after}</ins>}
                  {!item.before && !item.after && <span className="muted">（空）</span>}
                </span>
              </span>
            </label>;
          })}
        </div>)}
      </div>}
  </section>;
}

/* -------------------------------------------------------------------------
 * 两阶段受控向导
 * 阶段一：录入 → 模型确认 → AI 解析草稿 → 差异勾选 → 受控导入
 * 阶段二：场次工作台 → 就地校对 → 保存新版本 → 推进分镜
 * ---------------------------------------------------------------------- */

export default function ProjectScriptWorkspace({ projectId, panel = 'parse', onUnsavedChange }: {
  projectId: string; panel?: ScriptWorkspacePanel; onUnsavedChange?: (dirty: boolean) => void;
}) {
  const [project, setProject] = useState<api.ProjectRecord | null>(null);
  const [plans, setPlans] = useState<FactPlan[]>([]);
  const [factsDirty, setFactsDirty] = useState(false);
  const [savedScript, setSavedScript] = useState<api.ScriptVersionRecord | null>(null);
  const [versions, setVersions] = useState<api.ScriptVersionSummary[]>([]);
  const [script, setScript] = useState('');
  const [dirty, setDirty] = useState(false);
  const [scriptStructure, setScriptStructure] = useState<ScriptStructure>(() => emptyScriptStructure());
  const [structureDirty, setStructureDirty] = useState(false);
  const [parseStructure, setParseStructure] = useState<ScriptStructure | null>(null);
  const [parseCharacters, setParseCharacters] = useState<ScriptParseCharacter[]>([]);
  const [parseLocations, setParseLocations] = useState<ScriptParseEntity[]>([]);
  const [parseProps, setParseProps] = useState<ScriptParseEntity[]>([]);
  const [parsePreview, setParsePreview] = useState(false);
  const [activeAttemptId, setActiveAttemptId] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<ScriptParseAttempt[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [approved, setApproved] = useState(false);
  const [model, setModel] = useState('默认拆解模型');
  const [previewVersion, setPreviewVersion] = useState('');
  const [modelRevision, setModelRevision] = useState('');
  const [repairPreview, setRepairPreview] = useState<ScriptDialogueRepairPreview | null>(null);
  const [repairFocus, setRepairFocus] = useState<{ sceneId: string; requestId: number } | null>(null);
  const [repairNotice, setRepairNotice] = useState('');
  const [manualRepairPlan, setManualRepairPlan] = useState<FactPlan | null>(null);
  const [diffMode, setDiffMode] = useState<'all' | 'none' | 'custom'>('all');
  const [diffIds, setDiffIds] = useState<Set<string>>(() => new Set());

  const structureReady = Boolean(savedScript?.structure);
  const activeAttempt = attempts.find(attempt => attempt.id === activeAttemptId) ?? null;
  const parseReadOnly = Boolean(activeAttempt && savedScript && activeAttempt.scriptVersionId !== savedScript.id);
  const baseStructure = savedScript?.structure ?? null;

  const diffItems = useMemo(() => (
    parsePreview && parseStructure ? diffScriptStructures(baseStructure, parseStructure) : []
  ), [parsePreview, parseStructure, baseStructure]);

  const selectedDiffIds = useMemo(() => {
    if (diffMode === 'all') return new Set(diffItems.map(item => item.id));
    if (diffMode === 'none' || diffMode === 'custom') return new Set(diffItems.filter(item => diffIds.has(item.id)).map(item => item.id));
    return new Set<string>();
  }, [diffMode, diffIds, diffItems]);

  const resetDiffSelection = useCallback(() => {
    setDiffMode('all');
    setDiffIds(new Set());
  }, []);

  const toggleDiff = useCallback((id: string, next: boolean) => {
    const current = new Set(selectedDiffIds);
    if (next) current.add(id); else current.delete(id);
    setDiffMode('custom');
    setDiffIds(current);
  }, [selectedDiffIds]);

  const refreshFacts = useCallback(async () => {
    setPlans(await api.listPlanRevisions(projectId));
  }, [projectId]);

  const refreshAttempts = useCallback(async () => {
    const items = await api.listScriptParseAttempts(projectId);
    setAttempts(items);
    return items;
  }, [projectId]);

  const refreshVersions = useCallback(async () => {
    const items = await api.listScriptVersions(projectId);
    setVersions(items);
    return items;
  }, [projectId]);

  const load = useCallback(async () => {
    setError('');
    // 切换阶段时会重新读取服务端事实，但保留上一步的成功提示（例如“已进入场次工作台”）。
    try {
      const [nextProject, nextSaved, nextAttempts, nextVersions] = await Promise.all([
        api.getProject(projectId), api.getCurrentScriptVersion(projectId),
        api.listScriptParseAttempts(projectId), api.listScriptVersions(projectId),
      ]);
      await refreshFacts();
      setProject(nextProject);
      setSavedScript(nextSaved);
      setVersions(nextVersions);
      setScript(nextSaved?.rawText ?? '');
      setScriptStructure(nextSaved?.structure ?? (nextSaved ? parseScriptStructure(nextSaved.rawText) : emptyScriptStructure()));
      setStructureDirty(false);
      setAttempts(nextAttempts);
      setParsePreview(false);
      setRepairPreview(null);
      setActiveAttemptId(null);
      setParseStructure(null);
      resetDiffSelection();
      if (nextSaved) {
        const draft = readScriptParsePreview(window.localStorage, projectId, nextSaved.id);
        const attempt = draft ? nextAttempts.find(item => item.id === draft.attemptId && item.status === 'succeeded') : null;
        const manualRepair = draft?.attemptId.startsWith('manual-dialogue-repair:') && draft.repair?.kind === 'exclude';
        if (draft && (attempt || manualRepair)) {
          setParseStructure(draft.structure);
          setParseCharacters(draft.characters);
          setParseLocations(draft.locations);
          setParseProps(draft.props);
          setRepairPreview(draft.repair ?? null);
          setPreviewVersion(attempt?.promptVersion ?? draft.promptVersion ?? 'manual-dialogue-repair/1');
          setActiveAttemptId(attempt?.id ?? draft.attemptId);
          setParsePreview(true);
          setDiffMode('all');
          setDiffIds(new Set());
          if (panel === 'parse') setMessage(manualRepair ? '已恢复上次未确认的手动修复预览。' : '已恢复上次未确认的解析预览，可以继续编辑。');
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取项目数据失败。');
    }
  }, [projectId, refreshFacts, panel, resetDiffSelection]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    setManualRepairPlan(null);
    setRepairFocus(null);
    setRepairNotice('');
  }, [projectId]);
  useEffect(() => {
    api.getBreakdownModel().then(value => {
      setModel(value.model);
      setPreviewVersion(value.connectionRevision);
      setModelRevision(value.connectionRevision);
    }).catch(() => undefined);
  }, [projectId]);
  useEffect(() => {
    onUnsavedChange?.(dirty || Boolean(script !== (savedScript?.rawText ?? '')) || (panel === 'structure' && structureDirty) || factsDirty);
    return () => onUnsavedChange?.(false);
  }, [dirty, script, savedScript, structureDirty, factsDirty, panel, onUnsavedChange]);

  useEffect(() => {
    if (!parsePreview || !activeAttemptId || !savedScript || !parseStructure || parseReadOnly) return;
    const saved = writeScriptParsePreview(window.localStorage, projectId, {
      attemptId: activeAttemptId,
      scriptVersionId: savedScript.id,
      structure: parseStructure,
      characters: parseCharacters,
      locations: parseLocations,
      props: parseProps,
      ...(repairPreview ? { repair: repairPreview } : {}),
      promptVersion: previewVersion,
    });
    if (!saved) setMessage('浏览器无法保存预览草稿；请不要刷新，或先打开解析记录重新加载原始结果。');
  }, [projectId, parsePreview, activeAttemptId, savedScript, parseStructure, parseCharacters, parseLocations, parseProps,
    parseReadOnly, repairPreview, previewVersion]);

  async function mutate(work: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await work(); } catch (reason) {
      setMessage('');
      setError(reason instanceof Error ? reason.message : '操作失败，请稍后重试。');
    } finally { setBusy(false); }
  }

  function resetPreviewState() {
    setParsePreview(false);
    setRepairPreview(null);
    setActiveAttemptId(null);
    setParseStructure(null);
    resetDiffSelection();
  }

  async function saveRaw() {
    if (parsePreview && !window.confirm('保存新原文会使当前预览成为历史结果；当前编辑草稿将被清除，原解析记录仍保留。确定继续？')) return;
    await mutate(async () => {
      const saved = await api.saveScriptVersion(projectId, { rawText: script });
      if (savedScript) clearScriptParsePreview(window.localStorage, projectId, savedScript.id);
      setSavedScript(saved);
      setProject(current => current ? { ...current, currentScriptVersionId: saved.id } : current);
      setScriptStructure(parseScriptStructure(saved.rawText));
      setStructureDirty(false);
      setDirty(false);
      setManualRepairPlan(null);
      setRepairFocus(null);
      setRepairNotice('');
      resetPreviewState();
      setMessage(`原文已保存为 V${saved.version}。旧解析仍保留在记录中；请基于新原文发起解析。`);
      await Promise.all([refreshAttempts(), refreshVersions()]);
    });
  }

  /** 保存场次结构为新的不可变版本；返回是否真正保存成功，供“推进至分镜”串联。 */
  async function saveStructure(): Promise<boolean> {
    if (!savedScript) return false;
    try { validateScriptStructure(scriptStructure); } catch (reason) {
      setError(reason instanceof Error ? reason.message : '剧本结构不完整，请检查场次编号和元素。');
      return false;
    }
    const repairPlan = manualRepairPlan;
    if (repairPlan && !window.confirm('确认保存手动修复？将创建新剧本版本和事实候选，并自动重跑校验；不会自动采用。')) return false;
    setBusy(true); setError(''); setMessage('');
    try {
      const saved = await api.saveScriptVersion(projectId, { rawText: script, structure: scriptStructure });
      let repairMessage = '';
      if (repairPlan) {
        try {
          const candidate = await api.request<FactPlan>(`/projects/${projectId}/script-character-candidates`, {
            method: 'POST', body: {
              scriptVersionId: saved.id,
              characters: repairPlan.content.characters.map(item => ({ name: item.name.value,
                aliases: item.aliases.map(alias => alias.value), description: item.description?.value ?? null })),
              locations: repairPlan.content.locations.map(item => ({ name: item.name.value,
                aliases: item.aliases.map(alias => alias.value), description: item.description?.value ?? null })),
              props: repairPlan.content.props.map(item => ({ name: item.name.value,
                aliases: item.aliases.map(alias => alias.value), description: item.description?.value ?? null })),
              dialogueExclusions: (repairPlan.content.dialogueExclusions ?? []).map(item => ({
                ...item, sourceRef: { ...item.sourceRef, scriptVersionId: saved.id },
              })),
            },
          });
          const checked = await api.request<{ check: { result: 'passed' | 'failed' }; issues: PlanCheckIssue[] }>(
            `/plan-revisions/${candidate.id}/checks`, { method: 'POST', body: {} });
          repairMessage = checked.check.result === 'passed'
            ? '手动修复已保存，自动重跑校验通过。返回解析中心可人工核对并采用。'
            : `手动修复已保存，自动重跑后仍有 ${checked.issues.length} 项问题。`;
        } catch (reason) {
          repairMessage = `剧本已保存，但新事实候选或自动校验未完成：${reason instanceof Error ? reason.message : '未知错误'}`;
        }
      }
      setSavedScript(saved);
      setProject(current => current ? { ...current, currentScriptVersionId: saved.id } : current);
      setScriptStructure(saved.structure ?? scriptStructure);
      setStructureDirty(false);
      if (repairPlan) {
        setManualRepairPlan(null);
        setRepairFocus(null);
        setRepairNotice('');
      }
      setMessage(repairPlan ? `剧本 V${saved.version}。${repairMessage}` : `场次已保存为剧本 V${saved.version}。`);
      await Promise.all([refreshAttempts(), refreshVersions(), ...(repairPlan ? [refreshFacts()] : [])]);
      return true;
    } catch (reason) {
      setMessage('');
      setError(reason instanceof Error ? reason.message : '保存剧本结构失败，请稍后重试。');
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openAttempt(attempt: ScriptParseAttempt) {
    const stored = attempt.scriptVersionId === savedScript?.id
      ? readScriptParsePreview(window.localStorage, projectId, attempt.scriptVersionId)
      : null;
    const draft = stored?.attemptId === attempt.id ? stored : draftFromParseAttempt(attempt);
    if (!draft) return;
    setParseStructure(draft.structure);
    setParseCharacters(draft.characters);
    setParseLocations(draft.locations);
    setParseProps(draft.props);
    setRepairPreview(draft.repair ?? null);
    setPreviewVersion(attempt.promptVersion);
    setActiveAttemptId(attempt.id);
    setParsePreview(true);
    resetDiffSelection();
    setMessage(attempt.scriptVersionId === savedScript?.id
      ? '已打开解析预览，编辑会保存在本浏览器，刷新后仍可继续。'
      : `这是剧本 V${attempt.scriptVersion} 的历史结果，只读查看，不会覆盖当前版本。`);
  }

  function cancelPreview() {
    const versionId = activeAttempt?.scriptVersionId ?? savedScript?.id;
    if (versionId) clearScriptParsePreview(window.localStorage, projectId, versionId);
    resetPreviewState();
    setMessage('预览已关闭；解析记录仍保留，可以随时重新打开。');
  }

  async function startParse() {
    if (!savedScript) { setError('请先保存原文，再使用 AI 解析。'); return; }
    if (dirty || script !== savedScript.rawText) { setError('原文有未保存修改，请先保存原文。'); return; }
    if (!approved) { setError('请先勾选模型调用确认，再开始智能解析。'); return; }
    if (parsePreview && !parseReadOnly && !window.confirm('重新解析会替换当前未确认预览；原记录仍保留。确定继续？')) return;
    setManualRepairPlan(null);
    await mutate(async () => {
      try {
        const result = await api.request<PreviewResult>(`/projects/${projectId}/script-parses`, {
          method: 'POST', body: { allowPaid: true, scriptVersionId: savedScript.id, expectedModelConnectionRevision: modelRevision },
        });
        setParseStructure(result.structure);
        setParseCharacters(result.characters);
        setParseLocations(result.locations ?? []);
        setParseProps(result.props ?? []);
        setRepairPreview(result.repair ?? null);
        setPreviewVersion(result.promptVersion);
        setActiveAttemptId(result.attemptId);
        setParsePreview(true);
        resetDiffSelection();
        await refreshAttempts().catch(() => undefined);
        setMessage('解析完成。结果仍是未确认草稿：请在下方向导逐项勾选要采纳的修改。');
      } catch (reason) {
        await refreshAttempts().catch(() => undefined);
        throw reason;
      }
    });
  }

  function manualRepair(plan: FactPlan, issue: PlanCheckIssue) {
    if (!savedScript?.structure) { setError('当前版本还没有可编辑的剧本结构。'); return; }
    if (structureDirty) { setError('剧本结构有未保存修改，请先保存或取消后再定位修复。'); return; }
    const target = repairSceneTarget(plan, issue, savedScript.structure);
    if (!target) { setError('无法把该问题定位到当前结构，请检查场次编号或重新解析。'); return; }
    setRepairFocus(previous => ({ sceneId: target.sceneId, requestId: (previous?.requestId ?? 0) + 1 }));
    setManualRepairPlan(plan);
    const sourceQuote = issue.sourceRefs[0]?.quote.trim();
    setRepairNotice(`手动修复 ${issue.code}：已定位到 ${target.sceneNumber}。请用“上方补对白”按原文顺序插入，或使用“+ 添加对白”补齐原文内容；保存时会创建新候选并自动重跑校验。${sourceQuote ? ` 对应原文：${sourceQuote.slice(0, 160)}${sourceQuote.length > 160 ? '…' : ''}` : ''}`);
    location.hash = projectFlowHash(projectId, 'script-structure');
  }

  async function startAiRepair(plan: FactPlan, check: { id: string }, issue: PlanCheckIssue) {
    if (!modelRevision) { setError('拆解模型尚未就绪，请先在模型中心确认配置。'); return; }
    if (parsePreview && !parseReadOnly && !window.confirm('生成修复建议会替换当前未确认预览；原解析记录仍保留。确定继续？')) {
      setMessage('已取消 AI 修复，未调用模型。'); return;
    }
    if (!window.confirm(`AI 修复将调用 ${model}，本次独立计价。只允许补齐原文已有对白或建议排除非对白误报；先预览，不直接保存。确认调用？`)) {
      setMessage('已取消 AI 修复，未调用模型。'); return;
    }
    setManualRepairPlan(null);
    await mutate(async () => {
      setMessage('AI 修复调用中，请稍候；完成前不会修改正式剧本。');
      try {
        const result = await api.request<PreviewResult>(`/projects/${projectId}/script-dialogue-repair`, {
          method: 'POST', body: {
            allowPaid: true, planRevisionId: plan.id, checkId: check.id, issueId: issue.id,
            expectedModelConnectionRevision: modelRevision,
          },
        });
        if (!result.repair) throw new Error('模型没有返回可确认的修复预览。');
        setParseStructure(result.structure);
        setParseCharacters(result.characters);
        setParseLocations(result.locations ?? []);
        setParseProps(result.props ?? []);
        setRepairPreview(result.repair);
        setPreviewVersion(result.promptVersion);
        setActiveAttemptId(result.attemptId);
        setParsePreview(true);
        resetDiffSelection();
        await refreshAttempts().catch(() => undefined);
        setMessage('AI 修复建议已生成，已为你定位到预览；确认保存后会自动重跑校验。');
        window.requestAnimationFrame(() => {
          document.getElementById('script-parse-preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      } catch (reason) {
        await refreshAttempts().catch(() => undefined);
        window.requestAnimationFrame(() => {
          document.getElementById('script-workspace-error')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        throw reason;
      }
    });
  }

  function patchParseCharacter(index: number, patch: Partial<ScriptParseCharacter>) {
    const previous = parseCharacters[index]?.name;
    setParseCharacters(items => patchEntity(items, index, patch));
    if (patch.name && previous && patch.name !== previous) {
      setParseStructure(structure => {
        if (!structure) return structure;
        return {
          ...structure,
          episodes: structure.episodes.map(episode => ({
            ...episode,
            scenes: episode.scenes.map(scene => ({
              ...scene,
              dialogues: scene.dialogues.map(element => element.type === 1 && element.characterName === previous
                ? { ...element, characterName: patch.name } : element),
            })),
          })),
        };
      });
    }
  }

  function patchParseLocation(index: number, patch: Partial<ScriptParseEntity>) {
    const previous = parseLocations[index]?.name;
    setParseLocations(items => patchEntity(items, index, patch));
    if (patch.name && previous && patch.name !== previous) {
      setParseStructure(structure => structure ? {
        ...structure,
        episodes: structure.episodes.map(episode => ({
          ...episode,
          scenes: episode.scenes.map(scene => scene.location === previous ? { ...scene, location: patch.name! } : scene),
        })),
      } : structure);
    }
  }

  function removeParseLocation(index: number) {
    const removed = parseLocations[index];
    setParseLocations(items => items.filter((_, itemIndex) => itemIndex !== index));
    if (removed) setParseStructure(structure => structure ? {
      ...structure,
      episodes: structure.episodes.map(episode => ({
        ...episode,
        scenes: episode.scenes.map(scene => scene.location === removed.name ? { ...scene, location: '' } : scene),
      })),
    } : structure);
  }

  async function confirmPreview() {
    if (!savedScript || !parseStructure || parseReadOnly) return;
    let merged: ScriptStructure;
    try {
      merged = applySelectedDiffs(baseStructure, parseStructure, selectedDiffIds);
    } catch (reason) {
      setMessage('');
      setError(reason instanceof Error
        ? `无法按当前勾选合并：${reason.message}`
        : '无法按当前勾选合并，请至少采纳一项修改或保留原版内容。');
      return;
    }
    const adoptedCount = selectedDiffIds.size;
    const repairing = repairPreview;
    await mutate(async () => {
      // 原文保持不变：解析记录与对话排除证据的 sourceRef 偏移都绑定原文，
      // 重新序列化会让既有证据错位；新版本只合并结构，不重写原文。
      const rawText = script;
      const saved = await api.saveScriptVersion(projectId, { rawText, structure: merged });
      let candidateError = '';
      let recheckError = '';
      let recheckMessage = '';
      const hasParseEntities = parseCharacters.length + parseLocations.length + parseProps.length > 0;
      if (hasParseEntities || repairing) {
        try {
          const candidate = await api.request<FactPlan>(`/projects/${projectId}/script-character-candidates`, {
            method: 'POST', body: {
              scriptVersionId: saved.id, characters: parseCharacters,
              locations: parseLocations, props: parseProps,
              ...(repairing ? { dialogueExclusions: repairing.exclusions.map(item => ({
                ...item, sourceRef: { ...item.sourceRef, scriptVersionId: saved.id },
              })) } : {}),
            },
          });
          if (repairing) {
            try {
              const checked = await api.request<{ check: { result: 'passed' | 'failed' }; issues: PlanCheckIssue[] }>(
                `/plan-revisions/${candidate.id}/checks`, { method: 'POST', body: {} });
              recheckMessage = checked.check.result === 'passed'
                ? '自动重跑校验已通过，请人工核对后决定是否采用。'
                : `自动重跑后仍有 ${checked.issues.length} 项问题，未自动采用。`;
            } catch (reason) {
              recheckError = reason instanceof Error ? reason.message : '自动重跑校验失败';
            }
          }
        } catch (reason) {
          candidateError = reason instanceof Error ? reason.message : '创建事实候选失败';
        }
      }
      clearScriptParsePreview(window.localStorage, projectId, savedScript.id);
      setSavedScript(saved);
      setProject(current => current ? { ...current, currentScriptVersionId: saved.id } : current);
      setScript(rawText);
      setScriptStructure(merged);
      setStructureDirty(false);
      setManualRepairPlan(null);
      setRepairFocus(null);
      setRepairNotice('');
      resetPreviewState();
      setMessage(candidateError
        ? `剧本已按勾选合并为 V${saved.version}，但事实候选没有创建：${candidateError}`
        : recheckError
          ? `剧本与事实候选已保存为 V${saved.version}，但自动重跑校验失败：${recheckError}`
          : repairing
            ? `修复已保存为剧本 V${saved.version}。${recheckMessage}`
            : `已合并 ${adoptedCount} 项勾选修改，保存为剧本 V${saved.version}；已进入场次工作台。`);
      await Promise.all([refreshFacts(), refreshAttempts(), refreshVersions()]);
      // 先同步清掉父级未保存标记，再跳转，避免 hash 守卫把刚保存的版本当成脏数据。
      onUnsavedChange?.(false);
      location.hash = projectFlowHash(projectId, 'script-structure');
    });
  }

  async function confirmScenes() {
    if (!savedScript?.structure) return;
    if (structureDirty) {
      const downstream = Boolean(project?.activePlanRevisionId || project?.activeStoryboardRevisionId);
      const hint = downstream
        ? '保存新场次版本会重置已采用的事实与分镜，需要重新拆解与采用。确认保存并推进至分镜？'
        : '确认把当前场次保存为新的正式版本，然后进入分镜设计？';
      if (!window.confirm(hint)) { setMessage('已取消推进，场次修改尚未保存。'); return; }
      if (!await saveStructure()) return;
    }
    onUnsavedChange?.(false);
    location.hash = projectFlowHash(projectId, 'storyboard');
  }

  const parseCounts = {
    characters: parseCharacters.length,
    locations: parseLocations.length,
    props: parseProps.length,
    scenes: parseStructure?.episodes.reduce((total, episode) => total + episode.scenes.length, 0) ?? 0,
  };
  const characterCount = countScriptCharacters(script);
  const sceneEstimate = estimateSceneCount(script);

  return <div className="project-flow-view script-workspace-view">
    <nav className="script-wizard-steps" aria-label="剧本工作流阶段">
      <a href={projectFlowHash(projectId, 'script-parse')} aria-current={panel === 'parse' ? 'page' : undefined}
        data-stage="1" className={panel === 'parse' ? 'is-current' : ''}>
        <span className="script-step-index">1</span>
        <span><strong>剧本录入与 AI 解析</strong><small>模型确认 → 差异比对 → 受控导入</small></span>
      </a>
      <ChevronRight size={14} className="script-step-arrow" />
      <a href={projectFlowHash(projectId, 'script-structure')} aria-current={panel === 'structure' ? 'page' : undefined}
        data-stage="2" className={panel === 'structure' ? 'is-current' : ''}>
        <span className="script-step-index">2</span>
        <span><strong>剧本场次工作台</strong><small>场次校对 → 保存版本 → 推进分镜</small></span>
      </a>
    </nav>

    {error && <p id="script-workspace-error" className="project-error" role="alert">{error}</p>}
    {message && <p className="notice" role="status">{message}</p>}

    {panel === 'structure' ? <section className="project-flow-card script-structure-page">
      <header className="project-flow-card-heading"><span className="project-section-icon"><BookOpen size={18} /></span>
        <div><p className="project-kicker">STAGE 2 · SAVED SCRIPT STRUCTURE</p><h2>剧本场次工作台</h2></div>
        <a className="button-secondary" href={projectFlowHash(projectId, 'script-parse')}>返回阶段一</a>
      </header>
      <p className="muted">这里只编辑已确认保存的分集、场次与五类元素；时空可就地修改，相邻场次可合并。
        人物、地点、道具请回到阶段一核对。</p>
      {structureReady || structureDirty ? <>
        <StructuredScriptEditor structure={scriptStructure} disabled={busy}
          focusRequest={repairFocus} repairNotice={repairNotice}
          onChange={next => { setScriptStructure(next); setStructureDirty(true); }} />
        <div className="script-save-toolbar">
          <span className={structureDirty ? 'warning' : 'muted'}>
            {structureDirty ? '场次有未保存修改' : savedScript ? `场次已保存 · 剧本 V${savedScript.version}` : '场次已保存'}
          </span>
          <div className="script-save-actions">
            <button className="button-secondary" disabled={busy || !structureDirty} onClick={() => { void saveStructure(); }}>
              <Save size={16} />{manualRepairPlan ? '保存手动修复并重跑校验' : '仅保存新版本'}
            </button>
            <button className="button-primary" disabled={busy} onClick={() => { void confirmScenes(); }}>
              <Check size={16} />确认场次，推进至分镜<ArrowRight size={15} />
            </button>
          </div>
        </div>
        <p className="muted script-flow-hint">唯一流转主行动：确认场次后进入「正式分镜」；若场次未保存，会先保存为新的不可变剧本版本。</p>
      </> : <div className="script-structure-empty">
        <FileText size={28} />
        <h3>还没有已确认的剧本结构</h3>
        <p>请先在阶段一完成 AI 解析、逐项采纳修改并导入场次，再来这里校对。</p>
        <a className="button-primary" href={projectFlowHash(projectId, 'script-parse')}>前往阶段一<ArrowRight size={15} /></a>
      </div>}
    </section> : <>
      <section className="project-flow-card script-parse-center">
        <header className="project-flow-card-heading"><span className="project-section-icon"><FileText size={18} /></span>
          <div><p className="project-kicker">STAGE 1 · ORIGINAL & AI PARSE</p><h2>原文与 AI 解析</h2></div>
          {structureReady && <a className="button-secondary" href={projectFlowHash(projectId, 'script-structure')}>前往场次工作台<ArrowRight size={15} /></a>}
        </header>
        <div className="script-source-layout">
          <div>
            <div className="script-source-label">
              <label htmlFor="project-script-raw" className="project-kicker">剧本文本</label>
              <span className="script-source-stats" data-testid="script-source-stats">
                <span>{characterCount} 字</span>
                <span>预估 {sceneEstimate || 1} 场</span>
              </span>
            </div>
            <textarea id="project-script-raw" value={script} disabled={busy}
              onChange={event => { setScript(event.target.value); setDirty(true); }} rows={18}
              placeholder="粘贴剧本原文。保存原文后才能发起 AI 解析。" />
          </div>
          <aside className="script-source-guide">
            <span className="project-kicker">受控流程</span>
            <h3>先确认模型，再比对差异，最后受控导入</h3>
            <p>AI 解析只生成独立草稿，不会静默覆盖正式剧本；相同内容会在差异面板中自动折叠，只留下需要你决定的变动。</p>
            {savedScript && <p className="muted">当前原文 V{savedScript.version}{structureReady ? ' · 已有正式场次' : ' · 尚未导入场次'}</p>}
          </aside>
        </div>
        <div className="project-actions">
          <button className="button-primary" disabled={busy || !dirty} onClick={saveRaw}><Save size={16} />保存原文</button>
          {savedScript && <button className="button-secondary" disabled={busy || script !== savedScript.rawText}
            onClick={() => { setScriptStructure(parseScriptStructure(script)); setStructureDirty(true); location.hash = projectFlowHash(projectId, 'script-structure'); }}>
            按原文整理结构
          </button>}
          <span className={dirty ? 'warning' : 'muted'}>{dirty ? '原文有未保存修改' : savedScript ? `原文 V${savedScript.version} 已保存` : '原文尚未保存'}</span>
        </div>
        {savedScript && <div className="script-parse-cta">
          <label className="parse-approval"><input type="checkbox" checked={approved} disabled={busy}
            onChange={event => setApproved(event.target.checked)} />
            <span>我确认调用 <strong>{model}</strong> 解析；本次独立计价，刷新可恢复草稿，确认前不会写入正式剧本。</span>
          </label>
          <button className="button-primary" disabled={!canStartParse({ approved, busy, modelRevision, savedScript, script, dirty })} onClick={startParse}>
            <Sparkles size={16} />{busy ? '正在解析…' : parsePreview && !parseReadOnly ? '重新解析并替换草稿' : '开始智能解析'}<ArrowRight size={15} />
          </button>
        </div>}
      </section>

      {parsePreview && parseStructure && <section id="script-parse-preview" className="project-flow-card script-parse-preview-card">
        <header className="project-flow-card-heading"><span className="project-section-icon"><Sparkles size={18} /></span>
          <div><p className="project-kicker">{repairPreview ? 'UNCONFIRMED REPAIR DRAFT' : 'UNCONFIRMED PARSE DRAFT'}</p>
            <h2>{parseReadOnly ? '历史解析结果（只读）' : repairPreview ? '修复草稿（未确认）' : '解析草稿（未确认）'}</h2></div>
          <button className="button-secondary" onClick={cancelPreview}>关闭结果</button>
        </header>
        <p className="muted">{previewVersion} · {parseCounts.scenes} 场 · 人物 {parseCounts.characters} · 地点 {parseCounts.locations} · 道具 {parseCounts.props}。
          {parseReadOnly ? '历史结果不会覆盖当前剧本。' : '刷新页面后会恢复这份草稿；确认导入前不会进入正式场次。'}</p>
        {repairPreview && <div className={`script-repair-preview kind-${repairPreview.kind}`} data-testid="dialogue-repair-preview">
          <h3>{repairPreview.kind === 'append' ? '补齐原文对白' : '排除非对白误报'}</h3>
          <p>{repairPreview.reason}</p>
          {repairPreview.addedDialogues.map((dialogue, index) => <blockquote key={`${dialogue.sceneId}-${index}`}>
            <strong>{dialogue.sceneNumber} · {dialogue.characterName || '待确认人物'}</strong>
            <span>{dialogue.content}</span>
            <small>原文 {dialogue.sourceRef.start}:{dialogue.sourceRef.end}</small>
          </blockquote>)}
          {repairPreview.exclusions.map((exclusion, index) => <blockquote key={`${exclusion.sourceRef.start}-${index}`}>
            <strong>非对白 · 原文 {exclusion.sourceRef.start}:{exclusion.sourceRef.end}</strong>
            <span>{exclusion.sourceRef.quote}</span>
            <small>{exclusion.reason}</small>
          </blockquote>)}
          <small>原文不改写；确认保存后创建新剧本版本和事实候选，并自动重跑校验。</small>
        </div>}
        <div className="script-character-preview">
          <ScriptParseEntityFields label="人物" items={parseCharacters} disabled={busy || parseReadOnly}
            onPatch={patchParseCharacter}
            onRemove={index => setParseCharacters(items => items.filter((_, itemIndex) => itemIndex !== index))}
            onAppend={() => setParseCharacters(items => [...items, { name: '新人物', aliases: [], description: null }])} addLabel="+ 添加人物" />
          <ScriptParseEntityFields label="场景 / 地点" items={parseLocations} disabled={busy || parseReadOnly}
            onPatch={patchParseLocation} onRemove={removeParseLocation}
            onAppend={() => setParseLocations(items => [...items, { name: '新地点', aliases: [], description: null }])} addLabel="+ 添加地点" />
          <ScriptParseEntityFields label="道具" items={parseProps} disabled={busy || parseReadOnly}
            onPatch={(index, patch) => setParseProps(items => patchEntity(items, index, patch))}
            onRemove={index => setParseProps(items => items.filter((_, itemIndex) => itemIndex !== index))}
            onAppend={() => setParseProps(items => [...items, { name: '新道具', aliases: [], description: null }])} addLabel="+ 添加道具" />
        </div>
      </section>}

      {parsePreview && parseStructure && <ScriptDiffReviewPanel
        base={baseStructure}
        draft={parseStructure}
        selectedIds={selectedDiffIds}
        disabled={busy}
        readOnly={parseReadOnly}
        items={diffItems}
        onToggle={toggleDiff}
        onSelectAll={() => setDiffMode('all')}
        onSelectNone={() => setDiffMode('none')} />}

      {parsePreview && parseStructure && !parseReadOnly && <div className="script-import-gateway">
        <button className="button-primary" disabled={busy || (!baseStructure && selectedDiffIds.size === 0)} onClick={confirmPreview}><Check size={16} />
          确认保存并导入剧本场次<ArrowRight size={15} />
        </button>
        <span className="muted">只合并已勾选采纳的修改；未勾选项完全保持原版。导入后进入阶段二场次工作台。
          {!baseStructure && selectedDiffIds.size === 0
            ? ' 当前没有正式剧本可保留原版，请至少采纳一项修改。'
            : diffMode === 'none' && parseStructure ? ' 当前全部保留原版。' : ''}</span>
      </div>}

      <section className="project-flow-card script-parse-history">
        <header className="project-flow-card-heading"><span className="project-section-icon"><History size={18} /></span>
          <div><p className="project-kicker">PARSE ATTEMPTS</p><h2>解析记录</h2></div>
          <button className="button-secondary" disabled={busy} onClick={() => void mutate(async () => {
            await refreshAttempts(); setMessage('解析记录已刷新。');
          })}><RefreshCw size={15} />刷新记录</button>
        </header>
        {attempts.length === 0 ? <p className="muted">还没有解析记录。保存原文并完成费用确认后，可发起第一次解析。</p> : <ol className="script-attempt-list">
          {attempts.map(attempt => {
            const output = attempt.output;
            const current = attempt.scriptVersionId === savedScript?.id;
            return <li key={attempt.id} data-status={attempt.status}>
              <div className="script-attempt-meta">
                <strong>{attempt.promptVersion === 'script-dialogue-repair/1'
                  ? attempt.status === 'succeeded' ? '修复成功' : attempt.status === 'failed' ? '修复失败' : '修复中'
                  : attempt.status === 'succeeded' ? '解析成功' : attempt.status === 'failed' ? '解析失败' : '解析中'}</strong>
                <span>剧本 V{attempt.scriptVersion} · {attempt.model} · {attempt.promptVersion}</span>
                <time>{new Date(attempt.createdAt).toLocaleString()}</time>
              </div>
              <div className="script-attempt-summary">
                {output ? <span>{output.structure.episodes.length} 集 · {output.structure.episodes.reduce((total, episode) => total + episode.scenes.length, 0)} 场 · 人物 {output.characters?.length ?? 0} · 地点 {output.locations?.length ?? 0} · 道具 {output.props?.length ?? 0}</span>
                  : <span>{attempt.errorCode ?? '没有可用结果'}</span>}
                {attempt.status === 'succeeded' && output && <button className="button-secondary"
                  disabled={activeAttemptId === attempt.id && parsePreview} onClick={() => openAttempt(attempt)}>
                  {activeAttemptId === attempt.id && parsePreview ? '当前结果' : current ? '打开 / 继续草稿' : '查看历史结果'}
                </button>}
              </div>
            </li>;
          })}
        </ol>}
      </section>

      <section className="project-flow-card script-version-history">
        <header className="project-flow-card-heading"><span className="project-section-icon"><FileText size={18} /></span>
          <div><p className="project-kicker">VERSION HISTORY</p><h2>版本历史</h2></div>
          <button className="button-secondary" disabled={busy} onClick={() => void mutate(async () => {
            await refreshVersions(); setMessage('版本历史已刷新。');
          })}><RefreshCw size={15} />刷新版本</button>
        </header>
        {versions.length === 0 ? <p className="muted">还没有剧本版本。保存原文后会生成不可变版本记录。</p> : <ol className="script-version-list">
          {versions.map(item => <li key={item.id} data-current={item.id === savedScript?.id}>
            <strong>V{item.version}</strong>
            <span>{new Date(item.createdAt).toLocaleString()}</span>
            {item.id === savedScript?.id && <em className="script-version-current">当前版本</em>}
          </li>)}
        </ol>}
      </section>

      {plans.length > 0 && <section className="project-flow-card">
        <header className="project-flow-card-heading"><span className="project-section-icon"><Check size={18} /></span>
          <div><p className="project-kicker">FACTS CANDIDATES</p><h2>事实候选与采用</h2></div>
          <button className="button-secondary" onClick={() => void mutate(refreshFacts)}><RefreshCw size={15} />刷新版本列表</button>
        </header>
        <p className="muted">导入后创建的人物、地点和道具在这里继续校对；场次结构请在阶段二编辑。</p>
        {project && <ProjectFactsPanel project={project} plans={plans} disabled={busy}
          onDirtyChange={setFactsDirty} onError={setError} onMessage={setMessage}
          onProjectChange={setProject} onRefresh={refreshFacts}
          onManualRepair={manualRepair} onAiRepair={startAiRepair}
          repairBusy={busy} />}
      </section>}
    </>}
  </div>;
}
