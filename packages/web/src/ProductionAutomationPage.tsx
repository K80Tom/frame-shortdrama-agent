import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertCircle, ArrowLeft, ArrowUpRight, Boxes, Check, ChevronDown, ChevronLeft, ChevronRight,
  CircleDot, Eye, Film, Gauge, Inbox, LayoutGrid, LoaderCircle, MoreHorizontal, Pause, Play, RefreshCw,
  RotateCcw, Settings2, ShieldCheck, Sparkles, WalletCards, WandSparkles, Layers3, X, Zap, Dices,
} from 'lucide-react';
import {
  defaultProductionForm, mergeProductionRuns, money, parseProductionRun, parseProductionRuns, parseProjectOptions,
  parseScriptVersionOptions, productionApi, ProductionApiError, productionCreateBody, productionRunActive, productionTaskCanRetry, runTitle, taskShotId,
  validateProductionForm, type ProductionCandidate, type ProductionForm, type ProductionIssue, type ProductionRun,
  type ProductionTask, type ProjectOption, type ProductionStage, type ScriptVersionOption,
} from './production-automation';
import './production-automation.css';
import type { NovelAdaptationResult } from '@lyra/shared';

const pendingKey = 'ohao:production-run-pending:v1';
const createStages = ['剧本拆解', '资产准备', '分镜设计', '3D 预演', '镜头生产包', '视频抽卡', '自动技术复核', '自动剪辑', '最终出片'];
const runLabels: Record<string, string> = { queued: '准备中', running: '制作中', waitingHuman: '等待处理', paused: '已暂停', pausedBudget: '预算已暂停', reconciling: '正在对账', completed: '已完成', partial: '部分完成', failed: '未完成', cancelled: '已取消' };
const taskLabels: Record<string, string> = { pending: '等待', ready: '就绪', running: '进行中', waitingExternal: '等待模型', validating: '校验中', retryWait: '等待重试', reconciling: '正在对账', waitingHuman: '待处理', succeeded: '完成', failed: '失败', skipped: '按需跳过', cancelled: '已取消', invalidated: '已失效', superseded: '已替代', needsAttention: '需处理' };
const stageStateLabels: Record<string, string> = { pending: '未开始', running: '进行中', needsAttention: '需处理', succeeded: '已完成', skipped: '按需跳过' };
const stageDescriptions: Record<string, string> = {
  prepare: '校验剧本版本、制作策略与预算，冻结输入并建立可恢复的任务图。',
  breakdown: '把剧本拆解为人物、场景、道具、场次与对白，每条事实保留原文证据。',
  assets: '按拆解结果匹配既有视觉资产，标记缺口并生成补齐任务。',
  storyboard: '把每个场次展开为镜头清单，确定画面内容、台词与节奏。',
  director: '复杂镜头进入浏览器 3D 白模预演机位与走位，输出构图约束。',
  video: '逐镜头调用视频模型生成片段，受预算与候选上限约束。',
  candidates: '同一镜头的多个候选并排比较，由你或自动策略选优。',
  review: '本地技术复核：容器、哈希、画幅、时长与音轨逐一校验。',
  compose: '把已选镜头叠化剪辑成整集成片，自动附加片头片尾卡。',
  deliver: '成片通过最终技术校验后交付，保留完整溯源记录。',
};
const stageAliases = {
  assets: ['asset'], storyboard: ['storyboard'], director: ['director', 'previs', '3d'],
  video: ['video', 'generation'], candidates: ['candidate', 'selection'], review: ['review', 'quality', 'qc'],
};
type MatrixColumn = keyof typeof stageAliases;
const matrixColumns: Array<{ key: MatrixColumn; label: string }> = [
  { key: 'assets', label: '资产' }, { key: 'storyboard', label: '分镜' }, { key: 'director', label: '3D' },
  { key: 'video', label: '视频' }, { key: 'candidates', label: '候选' }, { key: 'review', label: '技术复核' },
];

function errorText(error: unknown) { return error instanceof Error && error.name !== 'AbortError' ? error.message : '本地后端连接超时，请稍后重试。'; }
function pendingFromSession() {
  try { const value: unknown = JSON.parse(sessionStorage.getItem(pendingKey) || 'null'); return value && typeof value === 'object' && typeof (value as { clientRequestId?: unknown }).clientRequestId === 'string' ? (value as { clientRequestId: string }).clientRequestId : ''; }
  catch { return ''; }
}
function dateText(value: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间未记录';
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function statusIcon(status: string, size = 14) {
  if (['completed', 'succeeded'].includes(status)) return <Check size={size} />;
  if (['running', 'waitingExternal', 'validating', 'retryWait', 'reconciling'].includes(status)) return <LoaderCircle size={size} className="pa-spin" />;
  if (['waitingHuman', 'failed', 'needsAttention'].includes(status)) return <AlertCircle size={size} />;
  if (status === 'skipped') return <MoreHorizontal size={size} />;
  return <CircleDot size={size} />;
}
function stageMatches(task: ProductionTask, column: MatrixColumn) {
  const stage = task.stage.toLowerCase(); return stageAliases[column].some(alias => stage.includes(alias));
}
function shotRows(run: ProductionRun) {
  const byId = new Map<string, { id: string; scene: string; label: string; tasks: ProductionTask[] }>();
  for (const task of run.tasks) {
    const shotId = taskShotId(task); if (!shotId) continue;
    const previous = byId.get(shotId); const scene = typeof task.inputManifest.find(item => item.kind === 'scene')?.id === 'string' ? task.inputManifest.find(item => item.kind === 'scene')!.id : '按镜头';
    if (previous) previous.tasks.push(task); else byId.set(shotId, { id: shotId, scene, label: shotId, tasks: [task] });
  }
  return [...byId.values()].sort((a, b) => `${a.scene}/${a.id}`.localeCompare(`${b.scene}/${b.id}`, 'zh-CN'));
}
function taskForColumn(tasks: ProductionTask[], column: MatrixColumn) { return tasks.find(task => stageMatches(task, column)); }
function selectedCandidate(run: ProductionRun, taskId: string) { return run.candidateSets.find(set => set.taskId === taskId) ?? null; }
function scopeText(task: ProductionTask) {
  return task.scope.kind === 'episode' ? '整集' : task.scope.kind === 'scene' ? `场次 ${task.scope.id ?? ''}` : task.scope.kind === 'shot' ? `镜头 ${task.scope.id ?? ''}` : `资产 ${task.scope.id ?? ''}`;
}
function stageTasks(run: ProductionRun, key: string) {
  return run.tasks.filter(task => task.stage === key && task.status !== 'superseded')
    .sort((a, b) => (a.scope.kind === 'episode' ? 0 : 1) - (b.scope.kind === 'episode' ? 0 : 1) || `${a.scope.id ?? ''}`.localeCompare(`${b.scope.id ?? ''}`, 'zh-CN'));
}
function currentStageKey(run: ProductionRun) {
  return run.stages.find(stage => stage.state === 'needsAttention')?.key
    ?? run.stages.find(stage => stage.state === 'running')?.key
    ?? run.stages.find(stage => stage.state === 'pending')?.key
    ?? run.stages.at(-1)?.key ?? '';
}

function CreatePanel({ form, projects, versions, loading, consent, onConsent, onChange, onProject, onSubmit }:
  { form: ProductionForm; projects: ProjectOption[]; versions: ScriptVersionOption[]; loading: boolean; consent: boolean;
    onConsent: (value: boolean) => void; onChange: (patch: Partial<ProductionForm>) => void; onProject: (id: string) => void; onSubmit: () => void }) {
  const error = validateProductionForm(form);
  return <div className="pa-create-layout">
    <section className="pa-create-card" aria-labelledby="pa-create-title">
      <div className="pa-card-head"><div><span>NEW PRODUCTION</span><h2 id="pa-create-title">创建一次完整制作</h2></div><WandSparkles size={20} /></div>
      <p className="pa-card-intro">选择已经保存的剧本，Lyra 会建立可恢复的生产任务；模型未接入的环节会明确停下，不会伪造完成。</p>
      <div className="pa-form-grid">
        <label className="pa-wide"><span>项目</span><select aria-label="自动制作项目" value={form.projectId} disabled={loading} onChange={event => onProject(event.target.value)}><option value="">选择已有剧本项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
        <label className="pa-wide"><span>剧本版本</span><select aria-label="自动制作剧本版本" value={form.scriptVersionId} disabled={loading || !form.projectId} onChange={event => onChange({ scriptVersionId: event.target.value })}><option value="">{form.projectId ? '选择剧本版本' : '请先选择项目'}</option>{versions.map(version => <option key={version.id} value={version.id}>版本 {version.version}{version.id === projects.find(project => project.id === form.projectId)?.currentScriptVersionId ? ' · 当前' : ''}</option>)}</select></label>
        <label><span>画面比例</span><select aria-label="整集画面比例" value={form.ratio} onChange={event => onChange({ ratio: event.target.value as ProductionForm['ratio'] })}><option>9:16</option><option>16:9</option></select></label>
        <label><span>目标时长</span><select aria-label="整集目标时长" value={form.targetDurationSec} onChange={event => onChange({ targetDurationSec: Number(event.target.value) })}><option value={60}>约 1 分钟</option><option value={90}>约 1.5 分钟</option><option value={120}>约 2 分钟</option><option value={180}>约 3 分钟</option></select></label>
        <label className="pa-wide"><span>视觉风格</span><textarea aria-label="自动制作视觉风格" maxLength={500} value={form.visualStyle} onChange={event => onChange({ visualStyle: event.target.value })} /></label>
        <label><span>生产策略</span><select aria-label="生产策略" value={form.qualityPreset} onChange={event => onChange({ qualityPreset: event.target.value as ProductionForm['qualityPreset'] })}><option value="fast">快速试片</option><option value="balanced">均衡制作</option><option value="quality">高质量</option></select></label>
        <label><span>自动化模式</span><select aria-label="自动化模式" value={form.automationMode} onChange={event => onChange({ automationMode: event.target.value as ProductionForm['automationMode'] })}><option value="auto">全自动</option><option value="checkpoints">关键节点确认</option><option value="coDirector">共同导演</option></select></label>
        <div className="pa-wide pa-flow-picker" role="radiogroup" aria-label="制作流程">
          <button type="button" className={`pa-flow ${form.candidatePolicy === 'direct' ? 'is-active' : ''}`} aria-pressed={form.candidatePolicy === 'direct'} onClick={() => onChange({ candidatePolicy: 'direct', candidateLimit: 1 })}>
            <span className="pa-flow-head"><Zap size={15} />直出版<small>最省费用</small></span>
            <p>每镜直接生成 1 条视频，跳过抽卡与选优；任务更少、花费最低。</p>
          </button>
          <button type="button" className={`pa-flow ${form.candidatePolicy === 'gacha' ? 'is-active' : ''}`} aria-pressed={form.candidatePolicy === 'gacha'} onClick={() => onChange({ candidatePolicy: 'gacha', candidateLimit: Math.max(2, form.candidateLimit) })}>
            <span className="pa-flow-head"><Dices size={15} />抽卡版<small>多候选选优</small></span>
            <p>每镜生成 2–4 条候选后统一选优；质量更稳，视频费用按候选数成倍。</p>
          </button>
        </div>
        {form.candidatePolicy === 'gacha' && <label><span>每镜候选</span><select aria-label="每镜候选数量" value={form.candidateLimit} onChange={event => onChange({ candidateLimit: Number(event.target.value) })}>{[2, 3, 4].map(value => <option value={value} key={value}>{value} 个</option>)}</select></label>}
        <label><span>3D 预演</span><select aria-label="3D 预演策略" value={form.directorPolicy} onChange={event => onChange({ directorPolicy: event.target.value as ProductionForm['directorPolicy'] })}><option value="auto">按需判断</option><option value="always">全部预演</option><option value="never">暂不使用</option></select></label>
        <label className="pa-wide"><span>整次预算上限</span><div className="pa-money-input"><b>¥</b><input aria-label="整次预算上限" type="number" min="0" max="1000000" step="1" value={form.budgetYuan} onChange={event => onChange({ budgetYuan: Number(event.target.value) })} /><small>候选、返修与抽帧评估共用此上限</small></div></label>
      </div>
      <label className="pa-consent"><input type="checkbox" checked={consent} onChange={event => onConsent(event.target.checked)} /><span>授权本次运行在 ¥{form.budgetYuan.toFixed(0)} 上限内调用已配置的模型和媒体服务，可能产生费用；达到上限或遇到未知提交会暂停。</span></label>
      <button className="pa-primary" disabled={loading || !consent || Boolean(error)} onClick={onSubmit}>{loading ? <LoaderCircle size={16} className="pa-spin" /> : <Sparkles size={16} />}{loading ? '正在创建运行…' : '开始自动制作'}</button>
      {error && <p className="pa-field-error">{error}</p>}
    </section>
    <section className="pa-preview-card" aria-labelledby="pa-preview-title">
      <div className="pa-card-head"><div><span>PRODUCTION PLAN</span><h2 id="pa-preview-title">一条可接管的制作链</h2></div><Layers3 size={20} /></div>
      <ol className="pa-create-stages">{createStages.map((label, index) => <li key={label}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{index === 5 && form.candidatePolicy === 'direct' ? '视频直出' : label}</strong><p>{index === 3 ? '复杂镜头按策略进入；普通镜头可跳过' : index === 5 ? (form.candidatePolicy === 'direct' ? '直出版：每镜 1 条视频直接生成，跳过抽卡' : `抽卡版：每镜最多 ${form.candidateLimit} 个候选`) : index === 8 ? '完成本地技术校验后形成可交付成片' : '创建后由真实任务状态驱动'}</p></div></li>)}</ol>
      <div className="pa-preview-note"><ShieldCheck size={17} /><p>剧本版本、策略和预算会在运行创建时冻结。局部失败只暂停相关依赖，可从具体节点继续。</p></div>
    </section>
  </div>;
}

function InboxPanel({ run, issues, busy, onSelect, onResolve, onRetry }: { run: ProductionRun; issues: ProductionIssue[]; busy: string; onSelect: (taskId: string) => void; onResolve: (issue: ProductionIssue) => void; onRetry: (task: ProductionTask) => void }) {
  const open = issues.filter(issue => issue.status === 'open');
  if (!open.length) return null;
  return <section className="pa-inbox" aria-labelledby="pa-inbox-title"><div className="pa-inbox-title"><span><Inbox size={17} /></span><div><h2 id="pa-inbox-title">需要你处理</h2><p>{open.length} 项决定正在等待</p></div></div><div className="pa-inbox-items">{open.map(issue => {
    const task = run.tasks.find(item => item.id === issue.taskId);
    const location = issue.scope.kind === 'episode' ? '整集' : `${issue.scope.kind === 'scene' ? '场次' : issue.scope.kind === 'shot' ? '镜头' : '资产'} ${issue.scope.id ?? ''}`;
    const candidateDecision = issue.code === 'CANDIDATE_SELECTION_REQUIRED';
    const checkpoint = issue.code === 'CHECKPOINT_REVIEW_REQUIRED';
    return <article key={issue.id}><button className="pa-inbox-copy" onClick={() => { if (issue.taskId) onSelect(issue.taskId); }}><small>{location}</small><strong>{issue.title}</strong><p>{issue.message}</p>{issue.impact.length > 0 && <span>影响：{issue.impact.join('、')}</span>}</button><div className="pa-inbox-actions">{checkpoint && <button disabled={Boolean(busy) || !issue.taskId} onClick={() => onResolve(issue)}>确认并继续</button>}{task && task.status === 'failed' && productionTaskCanRetry(task) && <button disabled={Boolean(busy)} onClick={() => onRetry(task)}><RotateCcw size={12} />重试节点</button>}{issue.taskId && <button onClick={() => onSelect(issue.taskId!)}>{candidateDecision ? '选择候选' : '查看详情'}<ChevronRight size={12} /></button>}</div></article>;
  })}</div></section>;
}

function StageFlowRail({ run, view, current, onStage, onMatrix }: { run: ProductionRun; view: string; current: string; onStage: (key: string) => void; onMatrix: () => void }) {
  return <nav className="pa-rail" aria-label="制作流程">
    {run.stages.map((stage, index) => <Fragment key={stage.key}>
      {index > 0 && <span aria-hidden className={`pa-rail-link ${run.stages[index - 1].state === 'succeeded' ? 'done' : ''}`} />}
      <button className={`pa-rail-node is-${stage.state}${view === stage.key ? ' is-here' : ''}${current === stage.key && stage.state !== 'succeeded' && stage.state !== 'skipped' ? ' is-current' : ''}`} onClick={() => onStage(stage.key)} aria-current={view === stage.key ? 'step' : undefined}>
        <span className="pa-rail-dot">{stage.state === 'succeeded' ? <Check size={13} /> : stage.state === 'running' ? <LoaderCircle size={13} className="pa-spin" /> : stage.state === 'needsAttention' ? <AlertCircle size={13} /> : stage.state === 'skipped' ? <MoreHorizontal size={13} /> : <span className="pa-rail-number">{String(index + 1).padStart(2, '0')}</span>}</span>
        <span className="pa-rail-copy"><strong>{stage.label}</strong><small>{stage.state === 'skipped' ? '按需跳过' : stage.total > 0 ? `${Math.min(stage.completed, stage.total)} / ${stage.total}` : stageStateLabels[stage.state] ?? stage.state}</small></span>
        {stage.needsAttention > 0 && <b>{stage.needsAttention}</b>}
      </button>
    </Fragment>)}
    <span aria-hidden className="pa-rail-link" />
    <button className={`pa-rail-node pa-rail-matrix${view === 'matrix' ? ' is-here' : ''}`} onClick={onMatrix} aria-current={view === 'matrix' ? 'step' : undefined}>
      <span className="pa-rail-dot"><LayoutGrid size={13} /></span>
      <span className="pa-rail-copy"><strong>镜头矩阵</strong><small>跨阶段总览</small></span>
    </button>
  </nav>;
}

function StageCard({ stage, index, onOpen }: { stage: ProductionStage; index: number; onOpen: () => void }) {
  const pct = stage.total > 0 ? Math.round(Math.min(stage.completed, stage.total) / stage.total * 100) : 0;
  return <button className={`pa-stagecard is-${stage.state}`} onClick={onOpen}>
    <div className="pa-stagecard-top"><span>{String(index + 1).padStart(2, '0')}</span><i>{stageStateLabels[stage.state] ?? stage.state}</i></div>
    <strong>{stage.label}</strong>
    <div className="pa-stagecard-bar" aria-hidden><i style={{ width: `${pct}%` }} /></div>
    <small>{stage.state === 'skipped' ? '按需跳过：本流程不执行这一阶段' : stage.total > 0 ? `${Math.min(stage.completed, stage.total)} / ${stage.total} 个节点` : stageStateLabels[stage.state] ?? stage.state}{stage.needsAttention > 0 ? ` · ${stage.needsAttention} 项待处理` : ''}</small>
  </button>;
}

function CandidateList({ run, task, busy, onReview }: { run: ProductionRun; task: ProductionTask; busy: string; onReview: (decision: string, candidate?: ProductionCandidate) => void }) {
  const set = selectedCandidate(run, task.id); if (!set) return null;
  return <div className="pa-candidates"><h3>{set.kind}候选</h3>{set.candidates.map(candidate => { const artifact = run.artifacts.find(item => item.id === candidate.artifactId); const preview = candidate.previewUrl || artifact?.url; return <article key={candidate.id} className={set.selectedCandidateId === candidate.id ? 'selected' : ''}><div className="pa-candidate-top"><span><Film size={14} />{candidate.label}</span><small>{set.selectedCandidateId === candidate.id ? '已采用' : candidate.status}</small></div>{candidate.summary && <p>{candidate.summary}</p>}<div className="pa-candidate-actions">{preview && <a href={preview} target="_blank" rel="noopener noreferrer">打开预览<ArrowUpRight size={12} /></a>}<button disabled={Boolean(busy) || Boolean(set.selectedCandidateId)} onClick={() => onReview('selectCandidate', candidate)}>采用</button></div></article>; })}</div>;
}

/* ── 节点产出内容：图片点击放大、拆解具体内容、各节点生成结果 ── */
const outputKindLabels: Record<string, string> = {
  text: '文本', image: '图片', video: '视频', audio: '音频',
  directorScene: '导演台场景', timeline: '时间线', delivery: '成片', report: '报告',
};
const metadataFieldLabels: Record<string, string> = {
  adopted: '已采用', generated: '本次生成', model: '模型', providerSource: '供应商来源',
  promptVersion: '提示词版本', assetCount: '资产数', matchedCount: '已匹配', missingCount: '缺口',
  scenes: '场次数', characters: '人物数', locations: '地点数', props: '道具数',
  shotCount: '镜头数', totalShots: '镜头总数', requiredShots: '需预演镜头', shotTasks: '镜头任务数',
  entityKind: '实体类型', ruleVersion: '规则版本', policy: '策略', ruleBased: '规则判定',
};
const metadataHiddenKeys = new Set(['planRevisionId', 'storyboardRevisionId', 'scriptVersionId', 'sourcePlanRevisionId',
  'expectedActivePlanRevisionId', 'expectedActiveStoryboardRevisionId', 'checkId', 'assetId', 'entityId', 'key',
  'modelConnectionRevision', 'decisions', 'snapshot', 'shots']);

function ImageLightbox({ source, label, onClose }: { source: string; label: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = previousOverflow; };
  }, [onClose]);
  return <div className="pa-lightbox" role="dialog" aria-modal="true" aria-label={`查看大图：${label}`} onClick={onClose}>
    <button type="button" className="pa-lightbox-close" aria-label="关闭大图" onClick={onClose}><X size={17} /></button>
    <figure className="pa-lightbox-figure" onClick={event => event.stopPropagation()}>
      <img src={source} alt={label} />
      <figcaption>{label} · 点击空白处或按 Esc 关闭</figcaption>
    </figure>
  </div>;
}

type PlanEntityView = { id: string; name: string; description: string | null; aliases: string[] };
type PlanSceneView = { id: string; order: number; title: string; timeOfDay: string | null; locationId: string | null; characterIds: string[] };
type PlanDialogueView = { id: string; sceneId: string; speakerId: string | null; quote: string };
type PlanView = {
  synopsis: string | null; characters: PlanEntityView[]; locations: PlanEntityView[]; props: PlanEntityView[];
  scenes: PlanSceneView[]; dialogues: PlanDialogueView[];
};

function planRow(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function planText(value: unknown): string | null {
  const row = planRow(value); const text = row && typeof row.value === 'string' ? row.value.trim() : '';
  return text || null;
}
function planEntities(value: unknown): PlanEntityView[] {
  return (Array.isArray(value) ? value : []).flatMap(item => {
    const row = planRow(item); if (!row || typeof row.id !== 'string') return [];
    return [{ id: row.id, name: planText(row.name) ?? '未命名', description: planText(row.description),
      aliases: (Array.isArray(row.aliases) ? row.aliases : []).flatMap(alias => { const name = planText(alias); return name ? [name] : []; }) }];
  });
}
function parsePlanRevision(value: unknown): PlanView {
  const row = planRow(value); const content = planRow(row?.content);
  if (!row || !content) throw new Error('拆解版本格式不正确。');
  const sceneRows = (Array.isArray(content.scenes) ? content.scenes : []).flatMap(item => {
    const scene = planRow(item); if (!scene || typeof scene.id !== 'string') return [];
    return [{ id: scene.id, order: typeof scene.order === 'number' ? scene.order : 0, title: planText(scene.title) ?? '未命名场次',
      timeOfDay: planText(scene.timeOfDay), locationId: typeof scene.locationId === 'string' ? scene.locationId : null,
      characterIds: (Array.isArray(scene.characterIds) ? scene.characterIds : []).filter((id): id is string => typeof id === 'string') }];
  });
  const dialogues = (Array.isArray(content.dialogues) ? content.dialogues : []).flatMap(item => {
    const dialogue = planRow(item); if (!dialogue || typeof dialogue.id !== 'string' || typeof dialogue.sceneId !== 'string') return [];
    const sourceRef = planRow(dialogue.sourceRef);
    return [{ id: dialogue.id, sceneId: dialogue.sceneId, speakerId: typeof dialogue.speakerId === 'string' ? dialogue.speakerId : null,
      quote: sourceRef && typeof sourceRef.quote === 'string' ? sourceRef.quote : '' }];
  });
  return { synopsis: planText(content.synopsis), characters: planEntities(content.characters),
    locations: planEntities(content.locations), props: planEntities(content.props), scenes: sceneRows, dialogues };
}

const entityListLimit = 40;
const sceneListLimit = 30;
const dialogueListLimit = 8;

function EntityList({ title, entities }: { title: string; entities: PlanEntityView[] }) {
  if (!entities.length) return null;
  const shown = entities.slice(0, entityListLimit);
  return <div className="pa-breakdown-block"><h4>{title}<small>{entities.length}</small></h4><ul>
    {shown.map(entity => <li key={entity.id}><strong>{entity.name}</strong>
      {entity.aliases.length > 0 && <em>别名：{entity.aliases.join('、')}</em>}
      {entity.description && <span>{entity.description}</span>}</li>)}
  </ul>{entities.length > shown.length && <p className="pa-breakdown-more">仅显示前 {shown.length} 项，共 {entities.length} 项。</p>}</div>;
}

function BreakdownContent({ planRevisionId, projectId }: { planRevisionId: string; projectId: string }) {
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false; const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    setPlan(null); setError('');
    productionApi(`/api/plan-revisions/${encodeURIComponent(planRevisionId)}`, undefined, controller.signal)
      .then(value => { if (!disposed) setPlan(parsePlanRevision(value)); })
      .catch(cause => { if (!disposed) setError(errorText(cause)); })
      .finally(() => clearTimeout(timeout));
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); };
  }, [planRevisionId]);
  return <div className="pa-breakdown" aria-label="剧本拆解具体内容">
    <div className="pa-breakdown-head"><span>拆解版本 {planRevisionId.slice(-8)}</span><a href={`#/production/${encodeURIComponent(projectId)}`}>在拆解校对页打开<ArrowUpRight size={11} /></a></div>
    {error && <p className="pa-breakdown-error" role="alert">{error} 拆解摘要仍显示在下方计数中。</p>}
    {!plan && !error && <p className="pa-breakdown-loading"><LoaderCircle size={13} className="pa-spin" />正在读取拆解内容…</p>}
    {plan && <>
      {plan.synopsis && <p className="pa-breakdown-synopsis">{plan.synopsis}</p>}
      <div className="pa-breakdown-stats">
        <span><strong>{plan.characters.length}</strong><small>人物</small></span>
        <span><strong>{plan.locations.length}</strong><small>地点</small></span>
        <span><strong>{plan.props.length}</strong><small>道具</small></span>
        <span><strong>{plan.scenes.length}</strong><small>场次</small></span>
        <span><strong>{plan.dialogues.length}</strong><small>对白</small></span>
      </div>
      <EntityList title="人物" entities={plan.characters} />
      <EntityList title="地点" entities={plan.locations} />
      <EntityList title="道具" entities={plan.props} />
      {plan.scenes.length > 0 && <div className="pa-breakdown-block"><h4>场次与对白<small>{plan.scenes.length}</small></h4><ol>
        {plan.scenes.slice(0, sceneListLimit).map(scene => {
          const location = plan.locations.find(item => item.id === scene.locationId)?.name;
          const characters = scene.characterIds.map(id => plan.characters.find(item => item.id === id)?.name).filter(Boolean) as string[];
          const dialogues = plan.dialogues.filter(item => item.sceneId === scene.id);
          const shownDialogues = dialogues.slice(0, dialogueListLimit);
          return <li key={scene.id}><strong>场 {scene.order} · {scene.title}</strong>
            <em>{[scene.timeOfDay, location ? `地点：${location}` : null].filter(Boolean).join(' · ') || '未记录时间与地点'}</em>
            {characters.length > 0 && <span>人物：{characters.join('、')}</span>}
            {shownDialogues.length > 0 && <blockquote>
              {shownDialogues.map(dialogue => <p key={dialogue.id}>{dialogue.speakerId ? `${plan.characters.find(item => item.id === dialogue.speakerId)?.name ?? '未知说话人'}：` : ''}{dialogue.quote}</p>)}
              {dialogues.length > shownDialogues.length && <small>另有 {dialogues.length - shownDialogues.length} 条对白未展开。</small>}
            </blockquote>}
          </li>;
        })}
      </ol>{plan.scenes.length > sceneListLimit && <p className="pa-breakdown-more">仅显示前 {sceneListLimit} 场，共 {plan.scenes.length} 场。</p>}</div>}
    </>}
  </div>;
}

type StoryboardShotView = { id: string; sceneId: string; order: number; durationMs?: number; shotSize?: string; cameraMovement?: string; visualDescription?: string };
function storyboardShots(value: unknown): StoryboardShotView[] {
  return (Array.isArray(value) ? value : []).flatMap(item => {
    const row = planRow(item); if (!row || typeof row.id !== 'string') return [];
    return [{
      id: row.id, sceneId: typeof row.sceneId === 'string' ? row.sceneId : '', order: typeof row.order === 'number' ? row.order : 0,
      durationMs: typeof row.durationMs === 'number' ? row.durationMs : undefined,
      shotSize: typeof row.shotSize === 'string' ? row.shotSize : undefined,
      cameraMovement: typeof row.cameraMovement === 'string' ? row.cameraMovement : undefined,
      visualDescription: typeof row.visualDescription === 'string' ? row.visualDescription : undefined,
    }];
  });
}
function StoryboardShots({ shots }: { shots: StoryboardShotView[] }) {
  const shotLimit = 30; const shown = shots.slice(0, shotLimit);
  return <div className="pa-breakdown-block"><h4>镜头清单<small>{shots.length}</small></h4><ol>
    {shown.map(shot => <li key={shot.id}><strong>镜 {shot.order}</strong>
      <span>{[shot.shotSize, shot.cameraMovement, typeof shot.durationMs === 'number' ? `${(shot.durationMs / 1000).toFixed(1)} 秒` : null].filter(Boolean).join(' · ') || '未记录景别与运镜'}</span>
      {shot.visualDescription && <p>{shot.visualDescription}</p>}</li>)}
  </ol>{shots.length > shotLimit && <p className="pa-breakdown-more">仅显示前 {shotLimit} 个镜头，共 {shots.length} 个。</p>}</div>;
}

function MetadataRows({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata).filter(([key, value]) =>
    !metadataHiddenKeys.has(key) && ['string', 'number', 'boolean'].includes(typeof value) && value !== '');
  if (!entries.length) return null;
  return <dl className="pa-artifact-meta">{entries.map(([key, value]) => <div key={key}>
    <dt>{metadataFieldLabels[key] ?? key}</dt>
    <dd title={String(value)}>{typeof value === 'boolean' ? (value ? '是' : '否') : String(value)}</dd>
  </div>)}</dl>;
}

function TaskOutputs({ run, task }: { run: ProductionRun; task: ProductionTask }) {
  const [lightbox, setLightbox] = useState<{ source: string; label: string } | null>(null);
  const artifacts = run.artifacts.filter(artifact => artifact.taskId === task.id);
  if (!artifacts.length) {
    const done = ['succeeded', 'skipped'].includes(task.status);
    return <div className="pa-outputs"><h3>产出内容</h3><p className="pa-outputs-empty">{done ? '该节点没有独立产物记录。' : '节点完成后，这里会显示它生成的具体内容。'}</p></div>;
  }
  return <div className="pa-outputs" aria-label="节点产出内容">
    <h3>产出内容<small>{artifacts.length} 项</small></h3>
    {artifacts.map(artifact => {
      const planRevisionId = artifact.kind === 'text' && typeof artifact.metadata?.planRevisionId === 'string' ? artifact.metadata.planRevisionId : '';
      const shots = storyboardShots(artifact.metadata?.shots);
      const isMedia = artifact.kind === 'image' || artifact.kind === 'video' || artifact.kind === 'delivery' || artifact.kind === 'audio';
      return <article key={artifact.id} className="pa-artifact">
        <div className="pa-artifact-head"><strong>{artifact.label}</strong><small>{outputKindLabels[artifact.kind] ?? artifact.kind}</small></div>
        {artifact.kind === 'image' && artifact.url && <button type="button" className="pa-artifact-image" aria-label={`查看大图：${artifact.label}`} onClick={() => setLightbox({ source: artifact.url!, label: artifact.label })}>
          <img src={artifact.url} alt={artifact.label} loading="lazy" /><span><Eye size={12} />点击查看大图</span>
        </button>}
        {isMedia && artifact.kind !== 'image' && artifact.url && <video className="pa-artifact-video" src={artifact.url} controls preload="metadata" />}
        {planRevisionId && <BreakdownContent planRevisionId={planRevisionId} projectId={run.projectId} />}
        {shots.length > 0 && <StoryboardShots shots={shots} />}
        {artifact.metadata && <MetadataRows metadata={artifact.metadata} />}
        {artifact.url && artifact.kind !== 'image' && <a className="pa-artifact-link" href={artifact.url} target="_blank" rel="noopener noreferrer">打开原始内容<ArrowUpRight size={11} /></a>}
      </article>;
    })}
    {lightbox && <ImageLightbox source={lightbox.source} label={lightbox.label} onClose={() => setLightbox(null)} />}
  </div>;
}

function TaskContentModal({ run, task, onClose }: { run: ProductionRun; task: ProductionTask; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('.pa-lightbox')) return; // 大图灯箱打开时，Esc 只关灯箱。
      onClose();
    };
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = previousOverflow; };
  }, [onClose]);
  const checks = run.qualityChecks.filter(check => check.taskId === task.id);
  const stage = run.stages.find(item => item.key === task.stage);
  return <div className="pa-modal-backdrop" role="dialog" aria-modal="true" aria-label={`节点详情：${task.label}`} onClick={onClose}>
    <div className="pa-modal" onClick={event => event.stopPropagation()}>
      <header className="pa-modal-head">
        <div>
          <p className="pa-modal-kicker"><span>{stage?.label || task.stage}</span><i>·</i><span>{scopeText(task)}</span></p>
          <h2>{task.label}</h2>
          <div className="pa-modal-meta">
            <i className={`pa-task-state pa-task-${task.status}`}>{statusIcon(task.status)}{taskLabels[task.status] || task.status}</i>
            <span>尝试 {task.attemptCount} / {task.maxAttempts} 次</span>
            <span>更新于 {dateText(task.updatedAt)}</span>
          </div>
        </div>
        <button type="button" className="pa-modal-close" aria-label="关闭详情窗口" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="pa-modal-body">
        {task.blockingReason && <div className="pa-block-reason pa-modal-block"><AlertCircle size={15} /><p>{task.blockingReason.message}</p></div>}
        <TaskOutputs run={run} task={task} />
        {checks.length > 0 && <div className="pa-quality pa-modal-quality"><h3>镜头技术复核</h3>{checks.map(check => <div key={check.id} className={`pa-quality-${check.result}`}>{check.result === 'pass' ? <Check size={13} /> : <AlertCircle size={13} />}<span><strong>{check.label}</strong>{check.issues.length > 0 && <small>{check.issues.join('；')}</small>}</span></div>)}</div>}
      </div>
    </div>
  </div>;
}

function TaskDetail({ run, task, busy, onRetry, onReview }: { run: ProductionRun; task: ProductionTask | null; busy: string; onRetry: (task: ProductionTask) => void; onReview: (task: ProductionTask, decision: string, candidate?: ProductionCandidate) => void }) {
  if (!task) return <aside className="pa-detail pa-detail-empty"><Boxes size={27} /><h2>选择一个制作节点</h2><p>点击节点会打开独立详情窗口，查看生成的具体内容；这里同步显示状态、候选与可执行的操作。</p></aside>;
  const checks = run.qualityChecks.filter(check => check.taskId === task.id);
  const candidateSet = selectedCandidate(run, task.id);
  const checkpointRequired = run.issues.some(issue => issue.taskId === task.id && issue.status === 'open' && issue.code === 'CHECKPOINT_REVIEW_REQUIRED');
  const canRetry = productionTaskCanRetry(task);
  return <aside className="pa-detail"><div className="pa-detail-head"><div><span>{scopeText(task)}</span><h2>{task.label}</h2></div><i className={`pa-task-state pa-task-${task.status}`}>{statusIcon(task.status)}{taskLabels[task.status] || task.status}</i></div>
    {task.blockingReason && <div className="pa-block-reason"><AlertCircle size={15} /><p>{task.blockingReason.message}</p></div>}
    <dl className="pa-detail-meta"><div><dt>阶段</dt><dd>{run.stages.find(stage => stage.key === task.stage)?.label || task.stage}</dd></div><div><dt>尝试</dt><dd>{task.attemptCount} / {task.maxAttempts} 次</dd></div><div><dt>更新时间</dt><dd>{dateText(task.updatedAt)}</dd></div><div><dt>依赖</dt><dd>{task.dependencies.length ? `${task.dependencies.length} 个节点` : '无'}</dd></div></dl>
    {checks.length > 0 && <div className="pa-quality"><h3>镜头技术复核</h3>{checks.map(check => <div key={check.id} className={`pa-quality-${check.result}`}>{check.result === 'pass' ? <Check size={13} /> : <AlertCircle size={13} />}<span><strong>{check.label}</strong>{check.issues.length > 0 && <small>{check.issues.join('；')}</small>}</span></div>)}</div>}
    <CandidateList run={run} task={task} busy={busy} onReview={(decision, candidate) => onReview(task, decision, candidate)} />
    <div className="pa-detail-actions">{canRetry && <button disabled={Boolean(busy)} onClick={() => onRetry(task)}><RotateCcw size={13} />{candidateSet ? '整组重做' : '局部重试'}</button>}{checkpointRequired && <button className="primary" disabled={Boolean(busy)} onClick={() => onReview(task, 'approve')}><Check size={13} />确认并继续</button>}</div>
    <details><summary>高级信息<ChevronDown size={13} /></summary><pre>{JSON.stringify({ taskId: task.id, status: task.status, version: task.version, inputManifest: task.inputManifest }, null, 2)}</pre></details>
  </aside>;
}

function TaskTable({ run, tasks, selectedTaskId, onSelect }: { run: ProductionRun; tasks: ProductionTask[]; selectedTaskId: string; onSelect: (task: ProductionTask) => void }) {
  if (!tasks.length) return <div className="pa-stage-empty"><LoaderCircle size={22} className={run.status === 'running' ? 'pa-spin' : ''} /><h3>该阶段尚未展开任务</h3><p>上游阶段完成后，这里会出现真实的制作节点和状态。</p></div>;
  return <div className="pa-tasktable-wrap"><table className="pa-tasktable"><thead><tr><th>范围</th><th>节点</th><th>状态</th><th>尝试</th><th>更新时间</th></tr></thead><tbody>
    {tasks.map(task => <tr key={task.id} className={selectedTaskId === task.id ? 'active' : ''} onClick={() => onSelect(task)} tabIndex={0} onKeyDown={event => { if (event.key === 'Enter') onSelect(task); }}>
      <td className="pa-tasktable-scope">{scopeText(task)}</td>
      <td><strong>{task.label}</strong></td>
      <td><i className={`pa-task-pill pa-pill-${task.status}`}>{statusIcon(task.status, 12)}{taskLabels[task.status] || task.status}</i></td>
      <td className="pa-tasktable-attempts">{task.attemptCount} / {task.maxAttempts}</td>
      <td className="pa-tasktable-time">{dateText(task.updatedAt)}</td>
    </tr>)}
  </tbody></table></div>;
}

function StageView({ run, stageKey, selectedTaskId, busy, onBack, onStage, onTask, onResolve, onRetry, onReview }:
  { run: ProductionRun; stageKey: string; selectedTaskId: string; busy: string; onBack: () => void; onStage: (key: string) => void; onTask: (task: ProductionTask) => void; onResolve: (issue: ProductionIssue) => void; onRetry: (task: ProductionTask) => void; onReview: (task: ProductionTask, decision: string, candidate?: ProductionCandidate) => void }) {
  const index = run.stages.findIndex(stage => stage.key === stageKey);
  const stage = run.stages[index] ?? null;
  if (!stage) return null;
  const tasks = stageTasks(run, stageKey);
  const issues = run.issues.filter(issue => issue.status === 'open' && issue.stage === stageKey);
  const candidateCount = run.candidateSets.filter(set => tasks.some(task => task.id === set.taskId)).length;
  const prev = index > 0 ? run.stages[index - 1] : null;
  const next = index < run.stages.length - 1 ? run.stages[index + 1] : null;
  return <div className="pa-stageview">
    <section className="pa-stagehero" aria-labelledby="pa-stagehero-title">
      <div>
        <button className="pa-back" onClick={onBack}><ArrowLeft size={13} />返回总览</button>
        <p className="pa-stagehero-kicker"><span>STAGE {String(index + 1).padStart(2, '0')}</span><i className={`pa-stagehero-state is-${stage.state}`}>{statusIcon(stage.state === 'succeeded' ? 'succeeded' : stage.state === 'running' ? 'running' : stage.state === 'needsAttention' ? 'needsAttention' : stage.state === 'skipped' ? 'skipped' : 'pending')} {stageStateLabels[stage.state] ?? stage.state}</i></p>
        <h1 id="pa-stagehero-title">{stage.label}</h1>
        <p className="pa-stagehero-desc">{stage.state === 'skipped' ? tasks.find(task => task.blockingReason?.message)?.blockingReason?.message ?? stageDescriptions[stageKey] ?? '制作流水线中的真实任务阶段。' : stageDescriptions[stageKey] ?? '制作流水线中的真实任务阶段。'}</p>
        <div className="pa-stagehero-metrics">
          <span><strong>{tasks.length}</strong><small>节点</small></span>
          <span><strong>{tasks.filter(task => task.status === 'succeeded' || task.status === 'skipped').length}</strong><small>已完成</small></span>
          <span><strong>{tasks.filter(task => ['running', 'waitingExternal', 'validating', 'retryWait', 'reconciling'].includes(task.status)).length}</strong><small>进行中</small></span>
          <span><strong>{tasks.filter(task => ['waitingHuman', 'failed'].includes(task.status)).length}</strong><small>需处理</small></span>
          {candidateCount > 0 && <span><strong>{candidateCount}</strong><small>组候选</small></span>}
        </div>
      </div>
    </section>
    <div className="pa-workspace">
      <div className="pa-stagebody">
        <InboxPanel run={run} issues={issues} busy={busy} onSelect={taskId => { const task = run.tasks.find(item => item.id === taskId); if (task) onTask(task); }} onResolve={onResolve} onRetry={onRetry} />
        <section className="pa-panel">
          <div className="pa-section-head"><div><span>NODES</span><h2>本阶段节点</h2></div><small>{tasks.length ? `${tasks.length} 个节点` : '等待上游'}</small></div>
          <TaskTable run={run} tasks={tasks} selectedTaskId={selectedTaskId} onSelect={onTask} />
        </section>
        {stageKey === 'deliver' && <section className="pa-panel pa-delivery">
          <div className="pa-section-head"><div><span>DELIVERY</span><h2>最终交付</h2></div><Film size={16} /></div>
          {run.delivery?.status === 'ready' && run.delivery.videoUrl ? <><p>{run.delivery.message || '整集已通过本地技术校验，可以打开最终成片。'}</p><a href={run.delivery.videoUrl} target="_blank" rel="noopener noreferrer">打开最终成片<ArrowUpRight size={14} /></a></> : <><p>{run.delivery?.message || '镜头选择、镜头技术复核与自动剪辑完成后，成片会出现在这里。'}</p><span className="pa-delivery-wait">{run.delivery?.status || '等待上游完成'}</span></>}
        </section>}
        <div className="pa-stage-nav">
          {prev ? <button onClick={() => onStage(prev.key)}><ChevronLeft size={14} />上一阶段 · {prev.label}</button> : <span />}
          {next ? <button onClick={() => onStage(next.key)}>下一阶段 · {next.label}<ChevronRight size={14} /></button> : <span />}
        </div>
      </div>
      <TaskDetail run={run} task={run.tasks.find(item => item.id === selectedTaskId) ?? null} busy={busy} onRetry={onRetry} onReview={onReview} />
    </div>
  </div>;
}

function MatrixView({ run, selectedTaskId, busy, onTask, onRetry, onReview }: { run: ProductionRun; selectedTaskId: string; busy: string; onTask: (task: ProductionTask) => void; onRetry: (task: ProductionTask) => void; onReview: (task: ProductionTask, decision: string, candidate?: ProductionCandidate) => void }) {
  const rows = shotRows(run);
  return <div className="pa-workspace">
    <section className="pa-panel">
      <div className="pa-section-head"><div><span>SHOT MATRIX</span><h2>镜头生产矩阵</h2></div><small>{rows.length ? `${rows.length} 个镜头` : '等待分镜展开'}</small></div>
      {rows.length ? <div className="pa-matrix-scroll"><table className="pa-matrix"><thead><tr><th>镜头</th>{matrixColumns.map(column => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id}><th><small>{row.scene}</small><strong>{row.label}</strong></th>{matrixColumns.map(column => { const cell = taskForColumn(row.tasks, column.key); return <td key={column.key}>{cell ? <button aria-label={`${row.label} ${column.label} ${taskLabels[cell.status] || cell.status}`} className={`pa-cell pa-cell-${cell.status} ${selectedTaskId === cell.id ? 'active' : ''}`} onClick={() => onTask(cell)}>{statusIcon(cell.status)}<span>{taskLabels[cell.status] || cell.status}</span></button> : <span className="pa-cell-empty">—</span>}</td>; })}</tr>)}</tbody></table></div> : <div className="pa-stage-empty"><LoaderCircle size={22} className={run.status === 'running' ? 'pa-spin' : ''} /><h3>镜头任务尚未展开</h3><p>完成剧本拆解与分镜设计后，这里会按真实场次和镜头显示节点。</p></div>}
    </section>
    <TaskDetail run={run} task={run.tasks.find(item => item.id === selectedTaskId) ?? null} busy={busy} onRetry={onRetry} onReview={onReview} />
  </div>;
}

function OverviewView({ run, busy, onStage, onMatrix, onTask, onResolve, onRetry }: { run: ProductionRun; busy: string; onStage: (key: string) => void; onMatrix: () => void; onTask: (task: ProductionTask) => void; onResolve: (issue: ProductionIssue) => void; onRetry: (task: ProductionTask) => void }) {
  const budget = run.summary.budget; const used = budget.spentMicros + budget.reservedMicros;
  const budgetPct = budget.limitMicros > 0 ? Math.min(100, Math.round(used / budget.limitMicros * 100)) : 0;
  return <>
    <section className="pa-run-stats">
      <div><Film size={16} /><span><strong>{run.summary.shots.completed} / {run.summary.shots.total}</strong><small>镜头完成</small></span></div>
      <div><Gauge size={16} /><span><strong>{run.summary.tasks.running}</strong><small>正在执行</small></span></div>
      <div><Inbox size={16} /><span><strong>{run.summary.tasks.waitingHuman}</strong><small>等待决定</small></span></div>
      <div><WalletCards size={16} /><span><strong>{money(used, budget.currency)}</strong><small>已用与预留 / {money(budget.limitMicros, budget.currency)}</small>
        {budget.frameAssessmentEstimateMicros !== undefined && budget.frameAssessmentEstimateMicros > 0
          && <small>含抽帧估算 {money(budget.frameAssessmentEstimateMicros, budget.currency)}</small>}
        <i className="pa-budget-bar" aria-hidden><b style={{ width: `${budgetPct}%` }} /></i></span></div>
    </section>
    <InboxPanel run={run} issues={run.issues} busy={busy} onSelect={taskId => { const task = run.tasks.find(item => item.id === taskId); if (task) onTask(task); }} onResolve={onResolve} onRetry={onRetry} />
    <section className="pa-stagegrid" aria-label="制作阶段总览">
      {run.stages.map((stage, index) => <StageCard key={stage.key} stage={stage} index={index} onOpen={() => onStage(stage.key)} />)}
      <button className="pa-stagecard pa-stagecard-matrix" onClick={onMatrix}>
        <div className="pa-stagecard-top"><span>ALL</span><i>总览</i></div>
        <strong>镜头矩阵</strong>
        <div className="pa-stagecard-bar" aria-hidden><i style={{ width: run.summary.shots.total > 0 ? `${Math.round(run.summary.shots.completed / run.summary.shots.total * 100)}%` : '0%' }} /></div>
        <small>{run.summary.shots.completed} / {run.summary.shots.total} 个镜头跨阶段对照</small>
      </button>
    </section>
    <div className="pa-bottom-grid">
      <section className="pa-panel pa-timeline"><div className="pa-section-head"><div><span>ACTIVITY</span><h2>运行记录</h2></div><Activity size={16} /></div>{run.timeline.length ? <ol>{run.timeline.slice(0, 10).map(item => <li key={item.id}><i /><div><strong>{item.message}</strong><small>{dateText(item.createdAt)}</small></div></li>)}</ol> : <p className="pa-empty-copy">运行建立后，真实状态变化和人工决定会记录在这里。</p>}</section>
      <section className="pa-panel pa-delivery"><div className="pa-section-head"><div><span>DELIVERY</span><h2>最终交付</h2></div><Film size={16} /></div>{run.delivery?.status === 'ready' && run.delivery.videoUrl ? <><p>{run.delivery.message || '整集已通过本地技术校验，可以打开最终成片。'}</p><a href={run.delivery.videoUrl} target="_blank" rel="noopener noreferrer">打开最终成片<ArrowUpRight size={14} /></a></> : <><p>{run.delivery?.message || '镜头选择、镜头技术复核与自动剪辑完成后，成片会出现在这里。'}</p><span className="pa-delivery-wait">{run.delivery?.status || '等待上游完成'}</span></>}</section>
    </div>
  </>;
}

function RunDashboard({ run, runs, projects, busy, onRun, onAction, onResolve, onRetry, onReview }:
  { run: ProductionRun; runs: ProductionRun[]; projects: ProjectOption[]; busy: string; onRun: (id: string) => void;
    onAction: (type: 'pause' | 'resume') => void; onResolve: (issue: ProductionIssue) => void; onRetry: (task: ProductionTask) => void;
    onReview: (task: ProductionTask, decision: string, candidate?: ProductionCandidate) => void }) {
  const [view, setView] = useState('overview');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [contentTaskId, setContentTaskId] = useState('');
  useEffect(() => { setView('overview'); setSelectedTaskId(''); setContentTaskId(''); }, [run.id]);
  const effectiveView = view !== 'overview' && view !== 'matrix' && !run.stages.some(stage => stage.key === view) ? 'overview' : view;
  const current = currentStageKey(run);
  const contentTask = run.tasks.find(item => item.id === contentTaskId) ?? null;
  const openTask = (task: ProductionTask) => { setSelectedTaskId(task.id); setView(task.stage); setContentTaskId(task.id); };
  const pickTask = (task: ProductionTask) => { setSelectedTaskId(task.id); setContentTaskId(task.id); };
  const openStage = (key: string) => {
    setView(key);
    const selected = run.tasks.find(item => item.id === selectedTaskId);
    if (selected && selected.stage !== key && key !== 'matrix' && key !== 'overview') setSelectedTaskId('');
  };
  return <div className="pa-dashboard">
    <header className="pa-run-head">
      <div>
        <div className="pa-run-kicker"><span className={`pa-live pa-live-${run.status}`} />{runLabels[run.status] || run.status}<span>·</span><span>{run.ratio || '画幅已冻结'}</span>{run.candidatePolicy ? <><span>·</span><span>{run.candidatePolicy === 'direct' ? '直出版' : '抽卡版'}</span></> : null}<span>·</span><span>{run.stages.find(stage => stage.key === current)?.label ?? ''}</span></div>
        <h1>{runTitle(run, projects)}</h1>
        <p>整集自动制作 · 剧本版本 {run.scriptVersionId.slice(-8)} · {run.summary.tasks.completed} / {run.summary.tasks.total} 个节点已完成</p>
      </div>
      <div className="pa-run-controls">
        <label><span className="pa-sr-only">选择制作运行</span><select value={run.id} onChange={event => onRun(event.target.value)}>{runs.map(item => <option key={item.id} value={item.id}>{runTitle(item, projects)} · {dateText(item.createdAt)}</option>)}</select></label>
        {['paused', 'pausedBudget'].includes(run.status) ? <button disabled={Boolean(busy) || run.status === 'pausedBudget'} onClick={() => onAction('resume')}><Play size={14} />继续</button> : productionRunActive(run) && <button disabled={Boolean(busy)} onClick={() => onAction('pause')}><Pause size={14} />暂停</button>}
      </div>
    </header>
    <StageFlowRail run={run} view={effectiveView} current={current} onStage={openStage} onMatrix={() => setView('matrix')} />
    {effectiveView === 'overview' && <OverviewView run={run} busy={busy} onStage={openStage} onMatrix={() => setView('matrix')} onTask={openTask} onResolve={onResolve} onRetry={onRetry} />}
    {effectiveView === 'matrix' && <MatrixView run={run} selectedTaskId={selectedTaskId} busy={busy} onTask={pickTask} onRetry={onRetry} onReview={onReview} />}
    {effectiveView !== 'overview' && effectiveView !== 'matrix' && <StageView run={run} stageKey={effectiveView} selectedTaskId={selectedTaskId} busy={busy} onBack={() => setView('overview')} onStage={openStage} onTask={pickTask} onResolve={onResolve} onRetry={onRetry} onReview={onReview} />}
    {contentTask && <TaskContentModal run={run} task={contentTask} onClose={() => setContentTaskId('')} />}
  </div>;
}

export default function ProductionAutomationPage({ onUnsavedChange, initialScript }: {
  onUnsavedChange?: (dirty: boolean) => void; initialScript?: NovelAdaptationResult;
}) {
  const [form, setForm] = useState<ProductionForm>({ ...defaultProductionForm, projectId: initialScript?.projectId ?? '' });
  const pinnedScript = useRef(initialScript);
  const [projects, setProjects] = useState<ProjectOption[]>([]); const [versions, setVersions] = useState<ScriptVersionOption[]>([]);
  const [runs, setRuns] = useState<ProductionRun[]>([]); const [selectedRunId, setSelectedRunId] = useState('');
  const [consent, setConsent] = useState(false); const [dirty, setDirty] = useState(false); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [loadError, setLoadError] = useState(''); const [refresh, setRefresh] = useState(0);
  const [creating, setCreating] = useState(Boolean(initialScript));
  const [pendingClientId, setPendingClientId] = useState(pendingFromSession);
  const mutation = useRef(false); const controllerRef = useRef<AbortController | null>(null);
  const explicitRejection = useRef(false);
  const run = creating ? null : runs.find(item => item.id === selectedRunId) ?? runs[0] ?? null;
  const isCreate = creating || !run;

  const currentProject = useMemo(() => projects.find(project => project.id === form.projectId) ?? null, [projects, form.projectId]);
  useEffect(() => { onUnsavedChange?.(isCreate && dirty); return () => onUnsavedChange?.(false); }, [dirty, isCreate, onUnsavedChange]);
  useEffect(() => { if (!isCreate || !dirty) return; const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave); }, [dirty, isCreate]);

  useEffect(() => {
    let disposed = false; let timer: ReturnType<typeof setTimeout> | undefined; let controller: AbortController | undefined;
    async function poll() {
      controller = new AbortController(); const timeout = setTimeout(() => controller?.abort(), 12000);
      const [projectResult, runResult] = await Promise.allSettled([
        productionApi('/api/projects', undefined, controller.signal).then(parseProjectOptions),
        productionApi('/api/production-runs', undefined, controller.signal).then(parseProductionRuns),
      ]); clearTimeout(timeout); if (disposed) return;
      const failures: string[] = [];
      if (projectResult.status === 'fulfilled') setProjects(projectResult.value); else failures.push(`项目列表：${errorText(projectResult.reason)}`);
      if (runResult.status === 'fulfilled') {
        setRuns(current => mergeProductionRuns(current, runResult.value));
        setSelectedRunId(current => current || runResult.value[0]?.id || '');
        const recovered = pendingClientId ? runResult.value.find(item => item.clientRequestId === pendingClientId) : null;
        if (recovered) {
          try { sessionStorage.removeItem(pendingKey); } catch { /* Server state remains authoritative. */ }
          setPendingClientId(''); setSelectedRunId(recovered.id); setCreating(false); setDirty(false); setConsent(false);
          setMessage('已找到刚才创建的运行，继续读取真实进度；没有重复创建。');
        }
      } else failures.push(`制作运行：${errorText(runResult.reason)}`);
      setLoadError(failures.join(' '));
      setLoading(false); timer = setTimeout(() => void poll(), 4000);
    }
    void poll(); return () => { disposed = true; clearTimeout(timer); controller?.abort(); };
  }, [refresh, pendingClientId]);

  useEffect(() => {
    if (!form.projectId) { setVersions([]); return; }
    const controller = new AbortController();
    void productionApi(`/api/projects/${encodeURIComponent(form.projectId)}/script-versions`, undefined, controller.signal).then(parseScriptVersionOptions).then(items => {
      if (controller.signal.aborted) return;
      setVersions(items);
      const pinned = pinnedScript.current;
      if (pinned && !items.some(item => item.id === pinned.scriptVersionId)) {
        setError('未找到已采用的小说剧本版本，请返回小说重新核对，或手动选择项目和版本。');
      }
      setForm(previous => ({ ...previous, scriptVersionId: pinned
        ? items.find(item => item.id === pinned.scriptVersionId)?.id ?? ''
        : items.find(item => item.id === previous.scriptVersionId)?.id || items.find(item => item.id === currentProject?.currentScriptVersionId)?.id || items.at(-1)?.id || '' }));
    }).catch(cause => { if (!controller.signal.aborted) setError(errorText(cause)); });
    return () => controller.abort();
  }, [form.projectId, currentProject?.currentScriptVersionId]);

  useEffect(() => {
    if (!selectedRunId) return; const controller = new AbortController();
    void productionApi(`/api/production-runs/${encodeURIComponent(selectedRunId)}`, undefined, controller.signal).then(parseProductionRun).then(value => { if (!controller.signal.aborted) setRuns(current => mergeProductionRuns(current, [value])); }).catch(() => undefined);
    return () => controller.abort();
  }, [selectedRunId, refresh]);
  useEffect(() => () => controllerRef.current?.abort(), []);

  function edit(patch: Partial<ProductionForm>) {
    if (patch.scriptVersionId !== undefined) pinnedScript.current = undefined;
    setForm(current => ({ ...current, ...patch })); setConsent(false); setDirty(true);
  }
  function selectProject(projectId: string) { setVersions([]); edit({ projectId, scriptVersionId: '' }); }
  async function mutate(label: string, path: string, body: unknown) {
    if (mutation.current) return null; mutation.current = true; explicitRejection.current = false; setBusy(label); setMessage(''); setError('');
    const controller = new AbortController(); controllerRef.current = controller; const timeout = setTimeout(() => controller.abort(), 20000);
    try { const result = parseProductionRun(await productionApi(path, body, controller.signal)); setRuns(current => mergeProductionRuns(current, [result])); setSelectedRunId(result.id); return result; }
    catch (cause) { explicitRejection.current = cause instanceof ProductionApiError; setError(errorText(cause)); return null; }
    finally { clearTimeout(timeout); mutation.current = false; setBusy(''); setRefresh(value => value + 1); }
  }
  async function create() {
    if (!consent || mutation.current || pendingClientId) return;
    const clientRequestId = crypto.randomUUID();
    try { sessionStorage.setItem(pendingKey, JSON.stringify({ clientRequestId, createdAt: new Date().toISOString() })); setPendingClientId(clientRequestId); } catch { setError('浏览器无法保存本次创建标识，尚未提交。'); return; }
    const result = await mutate('create', '/api/production-runs', productionCreateBody(form, clientRequestId));
    if (result) { try { sessionStorage.removeItem(pendingKey); } catch { /* Server record remains authoritative. */ } setPendingClientId(''); setConsent(false); setDirty(false); setCreating(false); setMessage('自动制作运行已建立。任务会在预算与人工门禁内推进。'); }
    else if (explicitRejection.current) { try { sessionStorage.removeItem(pendingKey); } catch { /* no-op */ } setPendingClientId(''); setConsent(false); setMessage('后端已明确拒绝创建，没有启动运行。请按提示修改后再试。'); }
    else setMessage('创建响应未确认。系统不会自动重新提交，请先刷新运行历史核对。');
  }
  async function action(type: 'pause' | 'resume') { if (!run) return; const result = await mutate(type, `/api/production-runs/${encodeURIComponent(run.id)}/actions`, { type }); if (result) setMessage(type === 'pause' ? '运行已暂停，当前成果和任务状态已保留。' : '运行已继续，调度器会从可执行节点恢复。'); }
  async function retry(task: ProductionTask) { if (!run) return; const result = await mutate('retry', `/api/production-runs/${encodeURIComponent(run.id)}/actions`, { type: 'retryTask', taskId: task.id, reason: '用户从生产总控台明确发起局部重试' }); if (result) setMessage(`已为「${task.label}」创建一次局部重试。`); }
  async function review(task: ProductionTask, decision: string, candidate?: ProductionCandidate, issue?: ProductionIssue) {
    if (!run) return; const body = { taskId: task.id, decision, ...(candidate ? { candidateId: candidate.id } : {}), ...(issue ? { issueId: issue.id } : {}), feedback: '用户在生产总控台作出明确决定' };
    const result = await mutate('review', `/api/production-runs/${encodeURIComponent(run.id)}/reviews`, body); if (result) setMessage(decision === 'reject' ? '候选已拒绝，决定已保存。' : '决定已保存，受影响的下游任务会按依赖继续。');
  }
  function resolve(issue: ProductionIssue) {
    const task = run?.tasks.find(item => item.id === issue.taskId);
    if (task) void review(task, issue.code === 'CHECKPOINT_REVIEW_REQUIRED' ? 'approve' : 'resolveIssue', undefined, issue);
  }

  return <div className="pa-page">
    {isCreate && <header className="pa-page-head"><div><span className="pa-head-icon"><Sparkles size={20} /></span><div><h1>自动制作</h1><p>把剧本交给 Lyra，完成一整条可见、可暂停、可返修的制作流程。</p></div></div><div><a href="#/automation/video"><Film size={14} />单镜头视频工具<ArrowUpRight size={12} /></a><a href="#/settings/models"><Settings2 size={14} />模型设置</a></div></header>}
    {isCreate ? <CreatePanel form={form} projects={projects} versions={versions} loading={loading || busy === 'create' || Boolean(pendingClientId)} consent={consent} onConsent={setConsent} onChange={edit} onProject={selectProject} onSubmit={() => void create()} />
      : <RunDashboard run={run} runs={runs} projects={projects} busy={busy}
        onRun={id => { setCreating(false); setSelectedRunId(id); }}
        onAction={type => void action(type)} onResolve={resolve} onRetry={task => void retry(task)} onReview={(task, decision, candidate) => void review(task, decision, candidate)} />}
    {pendingClientId && <div className="pa-recovery" role="alert"><AlertCircle size={15} /><p>正在核对刚才的创建结果。暂不允许再次创建，避免重复启动一整条付费流水线。</p><button onClick={() => setRefresh(value => value + 1)}>重新读取</button><button onClick={() => { if (!window.confirm('只有确认后端没有这次运行时才应解除。确定解除待确认状态？')) return; try { sessionStorage.removeItem(pendingKey); } catch { /* no-op */ } setPendingClientId(''); setConsent(false); }}>确认未创建</button></div>}
    {(message || error || loadError) && <div className={`pa-toast-inline ${error || loadError ? 'error' : ''}`} role={error || loadError ? 'alert' : 'status'}>{error || loadError ? <AlertCircle size={15} /> : <Check size={15} />}<p>{error || loadError || message}</p>{(error || loadError) && <button onClick={() => { setError(''); setLoadError(''); setRefresh(value => value + 1); }}><RefreshCw size={12} />刷新</button>}</div>}
    {!isCreate && <button className="pa-new-run" onClick={() => { setCreating(true); setDirty(false); setConsent(false); }}>新建一次制作</button>}
  </div>;
}
