import type { FrozenAssetRetrievalPolicy } from '@lyra/shared';

export const productionRunStatuses = ['queued', 'running', 'waitingHuman', 'paused', 'pausedBudget', 'reconciling', 'completed', 'partial', 'failed', 'cancelled'] as const;
export type ProductionRunStatus = typeof productionRunStatuses[number];
export const productionTaskStatuses = ['pending', 'ready', 'running', 'waitingExternal', 'validating', 'retryWait', 'reconciling', 'waitingHuman', 'succeeded', 'failed', 'cancelled', 'invalidated', 'superseded', 'skipped'] as const;
export type ProductionTaskStatus = typeof productionTaskStatuses[number];
export const productionStageStates = ['pending', 'running', 'needsAttention', 'succeeded', 'skipped'] as const;
export type ProductionStageState = typeof productionStageStates[number];

export type ProductionForm = {
  projectId: string;
  scriptVersionId: string;
  ratio: '9:16' | '16:9';
  targetDurationSec: number;
  visualStyle: string;
  qualityPreset: 'fast' | 'balanced' | 'quality';
  automationMode: 'auto' | 'checkpoints' | 'coDirector';
  candidatePolicy: 'direct' | 'gacha';
  candidateLimit: number;
  directorPolicy: 'auto' | 'always' | 'never';
  budgetYuan: number;
};

export const defaultProductionForm: ProductionForm = {
  projectId: '', scriptVersionId: '', ratio: '9:16', targetDurationSec: 90,
  visualStyle: '现实主义电影感，人物自然表演，统一光影与色彩', qualityPreset: 'balanced',
  automationMode: 'auto', candidatePolicy: 'direct', candidateLimit: 1, directorPolicy: 'auto', budgetYuan: 50,
};

export type ProjectOption = { id: string; title: string; currentScriptVersionId: string | null };
export type ScriptVersionOption = { id: string; version: number; createdAt?: string };
export type ProductionStage = { key: string; label: string; state: ProductionStageState; completed: number; total: number; needsAttention: number };
export type ProductionScope = { kind: 'episode' | 'scene' | 'shot' | 'asset'; id: string | null };
export type ProductionTask = {
  id: string; stage: string; label: string; scope: ProductionScope; status: ProductionTaskStatus;
  dependencies: string[]; attemptCount: number; maxAttempts: number; version: number; blockingReason: { code: string; message: string } | null;
  inputManifest: Array<{ kind: string; id: string; revisionId: string; digest: string }>; updatedAt: string;
};
export type ProductionIssue = {
  id: string; taskId: string | null; stage: string; scope: ProductionScope; code: string; title: string; message: string; severity: string;
  status: 'open' | 'resolved'; recommendedActions: string[]; impact: string[]; estimatedAdditionalCostMicros: number | null;
};
export type ProductionCandidate = {
  id: string; artifactId: string | null; label: string; status: string; previewUrl?: string; score?: number; summary: string;
};
export type ProductionCandidateSet = {
  id: string; taskId: string; kind: string; scope: ProductionScope; selectedCandidateId: string | null;
  candidates: ProductionCandidate[];
};
export type ProductionTimelineItem = { id: string; type: string; message: string; createdAt: string; taskId?: string };
export type ProductionArtifact = { id: string; kind: string; label: string; url?: string; taskId?: string; metadata?: Record<string, unknown> };
export type ProductionQualityCheck = { id: string; taskId: string; level: string; label: string; result: 'pass' | 'fail' | 'uncertain'; ruleVersion?: string; issues: string[] };
export type ProductionReview = { id: string; taskId: string; decision: string; candidateId?: string; feedback?: string; createdAt: string };
export type ProductionDelivery = { status: string; videoUrl?: string; message?: string } | null;
export type ProductionSummary = {
  tasks: { completed: number; total: number; running: number; waitingHuman: number; failed: number };
  shots: { completed: number; total: number };
  issues: { open: number; total: number };
  budget: { limitMicros: number; reservedMicros: number; spentMicros: number; frameAssessmentEstimateMicros?: number; currency: string };
};
export type ProductionRun = {
  id: string; clientRequestId: string; projectId: string; scriptVersionId: string; status: ProductionRunStatus; version: number;
  projectTitle?: string; ratio?: string; targetDurationSec?: number; visualStyle?: string; qualityPreset?: string;
  automationMode?: string; candidatePolicy?: string; candidateLimit?: number; directorPolicy?: string; createdAt: string; updatedAt: string; pausedAt: string | null;
  assetRetrievalPolicy?: FrozenAssetRetrievalPolicy;
  summary: ProductionSummary; stages: ProductionStage[]; tasks: ProductionTask[]; issues: ProductionIssue[];
  candidateSets: ProductionCandidateSet[]; artifacts: ProductionArtifact[]; qualityChecks: ProductionQualityCheck[];
  reviews: ProductionReview[]; timeline: ProductionTimelineItem[]; delivery: ProductionDelivery;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown, fallback = '') { return typeof value === 'string' ? value : fallback; }
/** Rule ids are short tokens such as storyboard-validator/2. Drop anything else. */
function ruleVersion(value: unknown): string {
  return typeof value === 'string' && value.length <= 80 && /^[A-Za-z0-9_./:+-]+$/u.test(value) ? value : '';
}
function number(value: unknown, fallback = 0) { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function nullableText(value: unknown) { return typeof value === 'string' ? value : null; }
function list(value: unknown) { return Array.isArray(value) ? value : []; }
function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? value as T : fallback;
}
function counts(value: unknown, keys: string[]) {
  const source = record(value) ?? {};
  return Object.fromEntries(keys.map(key => [key, Math.max(0, Math.floor(number(source[key])))]));
}
function safeLink(value: unknown) {
  if (typeof value !== 'string') return undefined;
  if (/^\/api\/[A-Za-z0-9_?&=/%.-]+$/u.test(value)) return value;
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : undefined; } catch { return undefined; }
}
function parseFrozenAssetRetrievalPolicy(value: unknown): FrozenAssetRetrievalPolicy | undefined {
  const row = record(value); if (!row || !text(row.policyDigest)) return undefined;
  const threshold = number(row.threshold, -1); const ambiguityMargin = number(row.ambiguityMargin, -1); const semanticWeight = number(row.semanticWeight, -1);
  if (threshold < 0 || threshold > 1 || ambiguityMargin < 0 || ambiguityMargin > 0.5 || semanticWeight < 0 || semanticWeight > 1) return undefined;
  return { schemaVersion: 'asset-retrieval-policy/1', threshold, ambiguityMargin, semanticWeight,
    registryRevision: Math.max(0, Math.floor(number(row.registryRevision))), policyDigest: text(row.policyDigest),
    sourceCandidateId: nullableText(row.sourceCandidateId) };
}
function jsonSafe(value: unknown): unknown {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonSafe(item)]));
  return undefined;
}

export function parseProjectOptions(value: unknown): ProjectOption[] {
  const source = record(value); if (!source) throw new Error('项目列表格式不正确。');
  return list(source.items).flatMap(item => { const row = record(item); if (!row || !text(row.id) || !text(row.title)) return [];
    return [{ id: text(row.id), title: text(row.title), currentScriptVersionId: nullableText(row.currentScriptVersionId) }]; });
}
export function parseScriptVersionOptions(value: unknown): ScriptVersionOption[] {
  const source = record(value); if (!source) throw new Error('剧本版本格式不正确。');
  return list(source.items).flatMap(item => { const row = record(item); if (!row || !text(row.id)) return [];
    return [{ id: text(row.id), version: Math.max(1, Math.floor(number(row.version, 1))), ...(text(row.createdAt) ? { createdAt: text(row.createdAt) } : {}) }]; });
}

function parseScope(value: unknown): ProductionScope {
  const row = record(value) ?? {}; const kind = enumValue(row.kind, ['episode', 'scene', 'shot', 'asset'] as const, 'episode');
  return { kind, id: kind === 'episode' ? null : nullableText(row.id) };
}
function parseTask(value: unknown): ProductionTask | null {
  const row = record(value); if (!row || !text(row.id) || !text(row.stage)) return null;
  return { id: text(row.id), stage: text(row.stage), label: text(row.label, text(row.stage)), scope: parseScope(row.scope),
    status: enumValue(row.status, productionTaskStatuses, 'pending'), dependencies: list(row.dependencies).filter(item => typeof item === 'string') as string[],
    attemptCount: Math.max(0, Math.floor(number(row.attemptCount))), maxAttempts: Math.max(0, Math.floor(number(row.maxAttempts))),
    version: Math.max(0, Math.floor(number(row.version))),
    blockingReason: (() => { const reason = record(row.blockingReason); return reason ? { code: text(reason.code), message: text(reason.message) } : null; })(),
    inputManifest: list(row.inputManifest).flatMap(value => { const item = record(value); return item && text(item.kind) && text(item.id) && text(item.revisionId) && text(item.digest) ? [{ kind: text(item.kind), id: text(item.id), revisionId: text(item.revisionId), digest: text(item.digest) }] : []; }), updatedAt: text(row.updatedAt) };
}
function parseIssue(value: unknown): ProductionIssue | null {
  const row = record(value); if (!row || !text(row.id)) return null;
  return { id: text(row.id), taskId: nullableText(row.taskId), stage: text(row.stage), scope: parseScope(row.scope), code: text(row.code), title: text(row.title, text(row.code, '需要处理')),
    message: text(row.message), severity: text(row.severity, 'warning'), status: text(row.status) === 'resolved' ? 'resolved' : 'open',
    recommendedActions: list(row.recommendedActions).filter(item => typeof item === 'string') as string[], impact: list(row.impact).filter(item => typeof item === 'string') as string[],
    estimatedAdditionalCostMicros: number(row.estimatedAdditionalCostMicros, -1) >= 0 ? number(row.estimatedAdditionalCostMicros) : null };
}
function parseCandidate(value: unknown): ProductionCandidate | null {
  const row = record(value); if (!row || !text(row.id)) return null;
  return { id: text(row.id), artifactId: nullableText(row.artifactId), label: text(row.label, `候选 ${text(row.id).slice(-4)}`), status: text(row.status, 'available'), summary: text(row.summary),
    ...(safeLink(row.previewUrl) ? { previewUrl: safeLink(row.previewUrl) } : {}), ...(number(row.score, -1) >= 0 ? { score: number(row.score) } : {}) };
}
function parseCandidateSet(value: unknown): ProductionCandidateSet | null {
  const row = record(value); if (!row || !text(row.id) || !text(row.taskId)) return null;
  return { id: text(row.id), taskId: text(row.taskId), kind: text(row.kind, '候选'), scope: parseScope(row.scope),
    selectedCandidateId: nullableText(row.selectedCandidateId), candidates: list(row.candidates).map(parseCandidate).filter(Boolean) as ProductionCandidate[] };
}
function parseStage(value: unknown): ProductionStage | null {
  const row = record(value); if (!row || !text(row.key)) return null;
  const key = text(row.key);
  const labelOverrides: Record<string, string> = { review: '镜头技术复核', compose: '自动剪辑合成' };
  return { key, label: labelOverrides[key] ?? text(row.label, key), state: enumValue(row.state, productionStageStates, 'pending'),
    completed: Math.max(0, Math.floor(number(row.completed))), total: Math.max(0, Math.floor(number(row.total))),
    needsAttention: Math.max(0, Math.floor(number(row.needsAttention))) };
}

export function parseProductionRun(value: unknown): ProductionRun {
  const row = record(value); if (!row || !text(row.id) || !text(row.projectId) || !text(row.scriptVersionId)) throw new Error('自动制作运行格式不正确。');
  const summary = record(row.summary) ?? {}; const taskCounts = counts(summary.tasks, ['completed', 'total', 'running', 'waitingHuman', 'failed']);
  const shotCounts = counts(summary.shots, ['completed', 'total']); const issueCounts = counts(summary.issues, ['open', 'total']);
  const budget = record(summary.budget) ?? {};
  const deliveryRow = record(row.delivery);
  const assetRetrievalPolicy = parseFrozenAssetRetrievalPolicy(row.assetRetrievalPolicy);
  return {
    id: text(row.id), clientRequestId: text(row.clientRequestId), projectId: text(row.projectId), scriptVersionId: text(row.scriptVersionId),
    status: enumValue(row.status, productionRunStatuses, 'queued'), version: Math.max(0, Math.floor(number(row.version))),
    ...(text(row.projectTitle) ? { projectTitle: text(row.projectTitle) } : {}), ...(text(row.ratio) ? { ratio: text(row.ratio) } : {}),
    ...(number(row.targetDurationSec, -1) >= 0 ? { targetDurationSec: number(row.targetDurationSec) } : {}), ...(text(row.visualStyle) ? { visualStyle: text(row.visualStyle) } : {}),
    ...(text(row.qualityPreset) ? { qualityPreset: text(row.qualityPreset) } : {}), ...(text(row.automationMode) ? { automationMode: text(row.automationMode) } : {}),
    ...(text(row.candidatePolicy) ? { candidatePolicy: text(row.candidatePolicy) } : {}),
    ...(number(row.candidateLimit, -1) >= 0 ? { candidateLimit: number(row.candidateLimit) } : {}), ...(text(row.directorPolicy) ? { directorPolicy: text(row.directorPolicy) } : {}),
    createdAt: text(row.createdAt), updatedAt: text(row.updatedAt), pausedAt: nullableText(row.pausedAt),
    ...(assetRetrievalPolicy ? { assetRetrievalPolicy } : {}),
    summary: { tasks: taskCounts as ProductionSummary['tasks'], shots: shotCounts as ProductionSummary['shots'], issues: issueCounts as ProductionSummary['issues'],
      budget: { limitMicros: Math.max(0, number(budget.limitMicros)), reservedMicros: Math.max(0, number(budget.reservedMicros)), spentMicros: Math.max(0, number(budget.spentMicros)),
        frameAssessmentEstimateMicros: Math.max(0, number(budget.frameAssessmentEstimateMicros)), currency: text(budget.currency, 'CNY') } },
    stages: list(row.stages).map(parseStage).filter(Boolean) as ProductionStage[], tasks: list(row.tasks).map(parseTask).filter(Boolean) as ProductionTask[],
    issues: list(row.issues).map(parseIssue).filter(Boolean) as ProductionIssue[], candidateSets: list(row.candidateSets).map(parseCandidateSet).filter(Boolean) as ProductionCandidateSet[],
    artifacts: list(row.artifacts).flatMap(value => { const item = record(value); if (!item || !text(item.id)) return []; const metadata = jsonSafe(item.metadata); return [{ id: text(item.id), kind: text(item.kind), label: text(item.title, text(item.kind, '产物')), ...(safeLink(item.uri) ? { url: safeLink(item.uri) } : {}), ...(text(item.taskId) ? { taskId: text(item.taskId) } : {}), ...(metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata) && Object.keys(metadata).length > 0 ? { metadata: metadata as Record<string, unknown> } : {}) }]; }),
    qualityChecks: list(row.qualityChecks).flatMap(value => { const item = record(value); if (!item || !text(item.id) || !text(item.taskId)) return []; const result = enumValue(item.result, ['pass', 'fail', 'uncertain'] as const, 'uncertain'); const version = ruleVersion(item.ruleVersion); return [{ id: text(item.id), taskId: text(item.taskId), level: text(item.level), label: text(item.summary, '质量检查'), result, ...(version ? { ruleVersion: version } : {}), issues: list(item.issues).filter(value => typeof value === 'string') as string[] }]; }),
    reviews: list(row.reviews).flatMap(value => { const item = record(value); if (!item || !text(item.id) || !text(item.taskId)) return []; return [{ id: text(item.id), taskId: text(item.taskId), decision: text(item.decision), ...(text(item.candidateId) ? { candidateId: text(item.candidateId) } : {}), ...(text(item.feedback) ? { feedback: text(item.feedback) } : {}), createdAt: text(item.createdAt) }]; }),
    timeline: list(row.outbox).flatMap(value => { const item = record(value); if (!item || !text(item.id)) return []; const type = text(item.type); return [{ id: text(item.id), type, message: productionEventLabel(type), createdAt: text(item.createdAt) }]; }),
    delivery: deliveryRow ? (() => { const artifact = list(row.artifacts).map(record).find(item => item && text(item.id) === text(deliveryRow.artifactId)); return { status: text(deliveryRow.status, 'validating'), ...(artifact && safeLink(artifact.uri) ? { videoUrl: safeLink(artifact.uri) } : {}), message: text(deliveryRow.status) === 'ready' ? '整集成片已完成本地技术校验。' : text(deliveryRow.status) === 'failed' ? '本地技术校验未通过，请查看镜头技术复核问题。' : '正在进行最终成片本地技术校验。' }; })() : null,
  };
}

export function parseProductionRuns(value: unknown) {
  const row = record(value); if (!row) throw new Error('运行列表格式不正确。');
  return list(row.items ?? row.runs).map(parseProductionRun);
}
export function productionCreateBody(form: ProductionForm, clientRequestId: string) {
  const error = validateProductionForm(form); if (error) throw new Error(error);
  const { budgetYuan, ...input } = form;
  return { ...input, visualStyle: form.visualStyle.trim(), targetDurationSec: Math.floor(form.targetDurationSec),
    budgetMicros: Math.round(budgetYuan * 1_000_000), currency: 'CNY', allowPaid: true as const, clientRequestId };
}
export function validateProductionForm(form: ProductionForm) {
  if (!form.projectId || !form.scriptVersionId) return '请选择已有剧本项目和剧本版本。';
  if (!form.visualStyle.trim() || form.visualStyle.trim().length > 500) return '请填写 1–500 字的视觉风格。';
  if (!Number.isInteger(form.targetDurationSec) || form.targetDurationSec < 15 || form.targetDurationSec > 900) return '目标时长须为 15–900 秒。';
  if (!['direct', 'gacha'].includes(form.candidatePolicy)) return '请选择直出版或抽卡版流程。';
  if (form.candidatePolicy === 'direct' && form.candidateLimit !== 1) return '直出版每镜只生成 1 条视频。';
  if (form.candidatePolicy === 'gacha' && (!Number.isInteger(form.candidateLimit) || form.candidateLimit < 2 || form.candidateLimit > 4)) return '抽卡版每镜候选须为 2–4 个。';
  if (!Number.isFinite(form.budgetYuan) || form.budgetYuan < 0 || form.budgetYuan > 1_000_000) return '预算上限格式不正确。';
  return '';
}
export function productionRunActive(run: ProductionRun) { return ['queued', 'running', 'waitingHuman', 'paused', 'pausedBudget', 'reconciling'].includes(run.status); }
export function productionTaskCanRetry(task: ProductionTask) {
  return ['failed', 'waitingHuman'].includes(task.status) && task.attemptCount < task.maxAttempts;
}
export function mergeProductionRuns(current: ProductionRun[], incoming: ProductionRun[]) {
  const byId = new Map(current.map(run => [run.id, run]));
  for (const run of incoming) { const previous = byId.get(run.id); if (!previous || run.version >= previous.version) byId.set(run.id, run); }
  return [...byId.values()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || b.id.localeCompare(a.id));
}
export class ProductionApiError extends Error { constructor(message: string, public status: number) { super(message); this.name = 'ProductionApiError'; } }
export async function productionApi(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal, cache: 'no-store', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shortdrama-Call': '1' }, body: JSON.stringify(body) }) });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) { const row = record(data); const error = record(row?.error); throw new ProductionApiError(text(error?.message, `请求失败（${response.status}）`).slice(0, 500), response.status); }
  return data;
}
export function money(micros: number, currency = 'CNY') { return `${currency === 'CNY' ? '¥' : `${currency} `}${(micros / 1_000_000).toFixed(2)}`; }
export function taskShotId(task: ProductionTask) { return task.scope.kind === 'shot' ? task.scope.id ?? '' : ''; }
function productionEventLabel(type: string) {
  const labels: Record<string, string> = { 'production.run.created': '已创建生产运行', 'production.run.paused': '运行已暂停', 'production.run.resumed': '运行已继续', 'production.task.started': '制作节点开始执行', 'production.task.succeeded': '制作节点完成', 'production.task.waiting_human': '制作节点等待人工处理', 'production.review.recorded': '已保存人工决定' };
  return labels[type] || type.replace(/^production\./u, '').replaceAll('.', ' · ');
}
export function runTitle(run: ProductionRun, projects: ProjectOption[]) { return run.projectTitle || projects.find(project => project.id === run.projectId)?.title || `制作运行 ${run.id.slice(-6)}`; }
