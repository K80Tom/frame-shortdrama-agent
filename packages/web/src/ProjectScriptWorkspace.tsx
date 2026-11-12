import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, BookOpen, Check, FileText, History, RefreshCw, Save, Sparkles } from 'lucide-react';
import {
  parseScriptStructure, emptyScriptStructure, validateScriptStructure,
  type ScriptParseAttempt, type ScriptParseCharacter, type ScriptParseEntity,
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

export default function ProjectScriptWorkspace({ projectId, panel = 'parse', onUnsavedChange }: {
  projectId: string; panel?: ScriptWorkspacePanel; onUnsavedChange?: (dirty: boolean) => void;
}) {
  const [project, setProject] = useState<api.ProjectRecord | null>(null);
  const [plans, setPlans] = useState<FactPlan[]>([]);
  const [factsDirty, setFactsDirty] = useState(false);
  const [savedScript, setSavedScript] = useState<api.ScriptVersionRecord | null>(null);
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

  const structureReady = Boolean(savedScript?.structure);
  const activeAttempt = attempts.find(attempt => attempt.id === activeAttemptId) ?? null;
  const parseReadOnly = Boolean(activeAttempt && savedScript && activeAttempt.scriptVersionId !== savedScript.id);

  const refreshFacts = useCallback(async () => {
    setPlans(await api.listPlanRevisions(projectId));
  }, [projectId]);

  const refreshAttempts = useCallback(async () => {
    const items = await api.listScriptParseAttempts(projectId);
    setAttempts(items);
    return items;
  }, [projectId]);

  const load = useCallback(async () => {
    setError('');
    setMessage('');
    try {
      const [nextProject, nextSaved, nextAttempts] = await Promise.all([
        api.getProject(projectId), api.getCurrentScriptVersion(projectId), api.listScriptParseAttempts(projectId),
      ]);
      await refreshFacts();
      setProject(nextProject);
      setSavedScript(nextSaved);
      setScript(nextSaved?.rawText ?? '');
      setScriptStructure(nextSaved?.structure ?? (nextSaved ? parseScriptStructure(nextSaved.rawText) : emptyScriptStructure()));
      setStructureDirty(false);
      setAttempts(nextAttempts);
      setParsePreview(false);
      setRepairPreview(null);
      setActiveAttemptId(null);
      setParseStructure(null);
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
          if (panel === 'parse') setMessage(manualRepair ? '已恢复上次未确认的手动修复预览。' : '已恢复上次未确认的解析预览，可以继续编辑。');
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取项目数据失败。');
    }
  }, [projectId, refreshFacts, panel]);

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
      setParsePreview(false);
      setRepairPreview(null);
      setActiveAttemptId(null);
      setParseStructure(null);
      setMessage(`原文已保存为 V${saved.version}。旧解析仍保留在记录中；请基于新原文发起解析。`);
      await refreshAttempts();
    });
  }

  async function saveStructure() {
    if (!savedScript) return;
    try { validateScriptStructure(scriptStructure); } catch (reason) {
      setError(reason instanceof Error ? reason.message : '剧本结构不完整，请检查场次编号和元素。');
      return;
    }
    const repairPlan = manualRepairPlan;
    if (repairPlan && !window.confirm('确认保存手动修复？将创建新剧本版本和事实候选，并自动重跑校验；不会自动采用。')) return;
    await mutate(async () => {
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
      setMessage(repairPlan ? `剧本 V${saved.version}。${repairMessage}` : `分集 / 场次已保存为剧本 V${saved.version}。`);
      await Promise.all([refreshAttempts(), ...(repairPlan ? [refreshFacts()] : [])]);
    });
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
    setMessage(attempt.scriptVersionId === savedScript?.id
      ? '已打开解析预览，编辑会保存在本浏览器，刷新后仍可继续。'
      : `这是剧本 V${attempt.scriptVersion} 的历史结果，只读查看，不会覆盖当前版本。`);
  }

  function cancelPreview() {
    const versionId = activeAttempt?.scriptVersionId ?? savedScript?.id;
    if (versionId) clearScriptParsePreview(window.localStorage, projectId, versionId);
    setParsePreview(false); setRepairPreview(null); setActiveAttemptId(null); setParseStructure(null);
    setMessage('预览已关闭；解析记录仍保留，可以随时重新打开。');
  }

  async function startParse() {
    if (!savedScript) { setError('请先保存原文，再使用 AI 解析。'); return; }
    if (dirty || script !== savedScript.rawText) { setError('原文有未保存修改，请先保存原文。'); return; }
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
        await refreshAttempts().catch(() => undefined);
        setMessage('解析完成。当前仍是未确认预览，不会自动跳转或改写正式剧本。');
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
    const repairing = repairPreview;
    await mutate(async () => {
      const saved = await api.saveScriptVersion(projectId, { rawText: script, structure: parseStructure });
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
      setScriptStructure(parseStructure);
      setStructureDirty(false);
      setManualRepairPlan(null);
      setRepairFocus(null);
      setRepairNotice('');
      setParsePreview(false);
      setRepairPreview(null);
      setActiveAttemptId(null);
      setParseStructure(null);
      setMessage(candidateError
        ? `剧本结构已保存为 V${saved.version}，但事实候选没有创建：${candidateError}`
        : recheckError
          ? `剧本结构与事实候选已保存为 V${saved.version}，但自动重跑校验失败：${recheckError}`
          : repairing
            ? `修复已保存为剧本 V${saved.version}。${recheckMessage}`
            : `剧本结构与事实候选已保存为 V${saved.version}。点击“前往剧本结构”继续编辑。`);
      await Promise.all([refreshFacts(), refreshAttempts()]);
    });
  }

  const parseCounts = {
    characters: parseCharacters.length,
    locations: parseLocations.length,
    props: parseProps.length,
    scenes: parseStructure?.episodes.reduce((total, episode) => total + episode.scenes.length, 0) ?? 0,
  };

  return <div className="project-flow-view script-workspace-view">
    <nav className="script-workspace-tabs" aria-label="剧本工作区页面">
      <a href={projectFlowHash(projectId, 'script-parse')} aria-current={panel === 'parse' ? 'page' : undefined}>
        <Sparkles size={16} />AI 解析中心
      </a>
      <a href={projectFlowHash(projectId, 'script-structure')} aria-current={panel === 'structure' ? 'page' : undefined}>
        <BookOpen size={16} />剧本结构
      </a>
    </nav>

    {error && <p id="script-workspace-error" className="project-error" role="alert">{error}</p>}
    {message && <p className="notice" role="status">{message}</p>}

    {panel === 'structure' ? <section className="project-flow-card script-structure-page">
      <header className="project-flow-card-heading"><span className="project-section-icon"><BookOpen size={18} /></span>
        <div><p className="project-kicker">SAVED SCRIPT STRUCTURE</p><h2>剧本结构</h2></div>
        <a className="button-secondary" href={projectFlowHash(projectId, 'script-parse')}>返回 AI 解析中心</a>
      </header>
      <p className="muted">这里只编辑已确认保存的分集、场次和五类元素；人物、地点、道具请回到解析中心核对。</p>
      {structureReady || structureDirty ? <>
        <StructuredScriptEditor structure={scriptStructure} disabled={busy}
          focusRequest={repairFocus} repairNotice={repairNotice}
          onChange={next => { setScriptStructure(next); setStructureDirty(true); }} />
        <div className="script-save-toolbar">
          <span className={structureDirty ? 'warning' : 'muted'}>{structureDirty ? '结构有未保存修改' : '剧本结构已保存'}</span>
          <button className="button-primary" disabled={busy || !structureDirty} onClick={saveStructure}>
            <Save size={16} />{manualRepairPlan ? '保存手动修复并重跑校验' : '保存剧本结构新版本'}
          </button>
        </div>
      </> : <div className="script-structure-empty">
        <FileText size={28} />
        <h3>还没有已确认的剧本结构</h3>
        <p>请先在 AI 解析中心生成并确认预览，或使用原文自动整理。</p>
        <a className="button-primary" href={projectFlowHash(projectId, 'script-parse')}>前往 AI 解析中心<ArrowRight size={15} /></a>
      </div>}
    </section> : <>
      <section className="project-flow-card script-parse-center">
        <header className="project-flow-card-heading"><span className="project-section-icon"><FileText size={18} /></span>
          <div><p className="project-kicker">ORIGINAL & AI PARSE</p><h2>原文与 AI 解析</h2></div>
          {structureReady && <a className="button-secondary" href={projectFlowHash(projectId, 'script-structure')}>前往剧本结构<ArrowRight size={15} /></a>}
        </header>
        <div className="script-source-layout">
          <div>
            <label htmlFor="project-script-raw" className="project-kicker">剧本文本</label>
            <textarea id="project-script-raw" value={script} disabled={busy}
              onChange={event => { setScript(event.target.value); setDirty(true); }} rows={18}
              placeholder="粘贴剧本原文。保存原文后才能发起 AI 解析。" />
          </div>
          <aside className="script-source-guide">
            <span className="project-kicker">独立预览，不直接改写</span>
            <h3>先核对人物、地点和道具，再确认结构</h3>
            <p>解析预览保存在本浏览器；每次成功或失败都会留下项目记录。确认保存后仍需你手动进入剧本结构页。</p>
            {savedScript && <p className="muted">当前原文 V{savedScript.version}{structureReady ? ' · 已有保存结构' : ' · 尚未解析'}</p>}
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
            <span>我确认调用 <strong>{model}</strong> 解析；本次独立计价，刷新可恢复预览。</span>
          </label>
          <button className="button-primary" disabled={busy || !approved || !modelRevision || dirty || script !== savedScript.rawText} onClick={startParse}>
            <Sparkles size={16} />{busy ? '正在解析…' : parsePreview && !parseReadOnly ? '重新解析并替换预览' : 'AI 解析分场与实体'}
          </button>
        </div>}
      </section>

      {parsePreview && parseStructure && <section id="script-parse-preview" className="project-flow-card script-parse-preview-card">
        <header className="project-flow-card-heading"><span className="project-section-icon"><Sparkles size={18} /></span>
          <div><p className="project-kicker">{repairPreview ? 'UNCONFIRMED REPAIR PREVIEW' : 'UNCONFIRMED PARSE PREVIEW'}</p>
            <h2>{parseReadOnly ? '历史解析结果（只读）' : repairPreview ? '修复预览（未确认）' : '解析预览（未确认）'}</h2></div>
          <button className="button-secondary" onClick={cancelPreview}>关闭结果</button>
        </header>
        <p className="muted">{previewVersion} · {parseCounts.scenes} 场 · 人物 {parseCounts.characters} · 地点 {parseCounts.locations} · 道具 {parseCounts.props}。
          {parseReadOnly ? '历史结果不会覆盖当前剧本。' : '刷新页面后会恢复这份预览；确认保存前不会进入正式结构。'}</p>
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
        {!parseReadOnly && <div className="project-actions">
          <button className="button-primary" disabled={busy} onClick={confirmPreview}><Check size={16} />
            {repairPreview ? '确认保存修复并重跑校验' : '确认保存并创建事实候选'}</button>
          <span className="muted">保存后停留在本页，由你手动前往剧本结构。</span>
        </div>}
      </section>}

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
                  {activeAttemptId === attempt.id && parsePreview ? '当前结果' : current ? '打开 / 继续预览' : '查看历史结果'}
                </button>}
              </div>
            </li>;
          })}
        </ol>}
      </section>

      {plans.length > 0 && <section className="project-flow-card">
        <header className="project-flow-card-heading"><span className="project-section-icon"><Check size={18} /></span>
          <div><p className="project-kicker">FACTS CANDIDATES</p><h2>事实候选与采用</h2></div>
          <button className="button-secondary" onClick={() => void mutate(refreshFacts)}><RefreshCw size={15} />刷新版本列表</button>
        </header>
        <p className="muted">确认解析后创建的人物、地点和道具在这里继续校对；剧本结构请在独立页面编辑。</p>
        {project && <ProjectFactsPanel project={project} plans={plans} disabled={busy}
          onDirtyChange={setFactsDirty} onError={setError} onMessage={setMessage}
          onProjectChange={setProject} onRefresh={refreshFacts}
          onManualRepair={manualRepair} onAiRepair={startAiRepair}
          repairBusy={busy} />}
      </section>}
    </>}
  </div>;
}
