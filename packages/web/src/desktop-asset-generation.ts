import type { NovelItem, NovelRevision } from './novel-editor';
import { bindingBlock, bindingFor } from './asset-library';

export type DesktopTaskStatus = 'queued' | 'submitting' | 'generating' | 'importing' | 'awaitingReview'
  | 'accepted' | 'rejected' | 'completed' | 'needsReview' | 'failed' | 'unknown';
export interface DesktopCandidateProvenance {
  promptVersion: string; provider: 'api' | 'desktop' | 'unknown'; model: string | null; modelConnectionRevision: string | null;
  inputRevisionId: string;
  result: DesktopCandidateResult;
}
export interface DesktopCandidateResult { sha256: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; bytes: number }
export interface DesktopAssetCandidate {
  id: string; assetId: string; status: 'awaitingReview' | 'accepted' | 'rejected' | 'needsReview';
  brief: DesktopVisualBrief; result: DesktopCandidateResult;
  reviewNote: string; acceptedRevisionId: string | null;
  createdAt: string; updatedAt: string; provenance: DesktopCandidateProvenance;
}
export interface DesktopTask {
  id: string; sourceId: string; chapterId: string; itemId: string; inputRevisionId: string;
  label: string; kind: 'character' | 'location' | 'prop'; status: DesktopTaskStatus;
  phase: string; message: string; assetId: string | null; linkedRevisionId: string | null;
  createdAt: string; updatedAt: string; intentId?: string; candidate?: DesktopAssetCandidate | null;
}
export interface DesktopStatus {
  available: boolean; code: string; message: string; model: string; busy: boolean;
  /** Binds a paid generation click to the exact server-side model connection the user reviewed. */
  connectionRevision?: string;
}
export interface DesktopVisualBrief {
  schemaVersion: string; itemId: string; kind: 'character' | 'location' | 'prop'; name: string;
  confirmedFacts: string[];
  evidence: Array<{ evidenceId: string; documentId: string; start: number; end: number; quote: string }>;
  designVariables: Array<{ field: string; guidance: string }>; negativeConstraints: string[]; confidence: number;
  pendingConfirmations: string[];
}
export interface DesktopAssetPreview extends DesktopVisualBrief {
  description: string; sourceQuotes: string[]; designNotes: string; promptPreview: string;
  /** Transitional compatibility if an older/newer server wraps the brief. */
  visualBrief?: DesktopVisualBrief;
}

export const desktopTaskLabels: Record<DesktopTaskStatus, string> = {
  queued: '等待处理', submitting: '正在提交', generating: '模型生成中', importing: '正在导入',
  awaitingReview: '候选图待确认', accepted: '已确认并关联', rejected: '已拒绝此候选',
  completed: '已导回并关联（旧任务）', needsReview: '成果待核对', failed: '未完成', unknown: '提交结果待核对',
};
export function desktopTaskActive(task: DesktopTask): boolean {
  return ['queued', 'submitting', 'generating', 'importing'].includes(task.status);
}
export function taskForItem(tasks: DesktopTask[], itemId: string): DesktopTask | null {
  return tasksForItem(tasks, itemId)[0] ?? null;
}
export function tasksForItem(tasks: DesktopTask[], itemId: string): DesktopTask[] {
  return tasks.filter(task => task.itemId === itemId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}
/** A POST result is just a snapshot; subsequent polling is authoritative at equal/newer timestamps. */
export function freshestDesktopTask(serverTask: DesktopTask | null, localTask: DesktopTask | null): DesktopTask | null {
  if (!serverTask) return localTask;
  if (!localTask) return serverTask;
  return serverTask.updatedAt >= localTask.updatedAt ? serverTask : localTask;
}
/** Do not release an ambiguous-submit guard merely because an older failed task is still visible. */
export function desktopSubmissionRecovered(task: DesktopTask | null, previous: DesktopTask | null, itemId: string, inputRevisionId: string): boolean {
  return Boolean(task && task.itemId === itemId && task.inputRevisionId === inputRevisionId
    && (!previous || task.id !== previous.id || task.updatedAt > previous.updatedAt));
}
export function desktopGenerationBlock(item: NovelItem, revision: NovelRevision, options: {
  editable: boolean; dirty: boolean; busy: boolean; assetDraftDirty: boolean;
  status: DesktopStatus | null; task: DesktopTask | null; loading: boolean;
}): string | null {
  const base = bindingBlock(item, options);
  if (base) return base;
  if (options.assetDraftDirty) return '请先保存或放弃资产引用草稿，再生成图片。';
  const binding = bindingFor(revision.content, item);
  if (binding?.status === 'linked') return '此项已有资产引用，不会重复生成。';
  if (binding?.status === 'needsReview') return '请先核对旧引用，确认无可用素材后保存为待补资产。';
  if (options.task && (desktopTaskActive(options.task) || options.task.status === 'unknown'))
    return '此项已有生图任务需要等待或核对，不会重复提交。';
  if (options.loading) return '正在检查生图模型连接与已有任务…';
  if (!options.status?.available) return '生图模型连接不可用，请到「工作台设置 → 模型连接」配置并测试后刷新状态。';
  if (options.status.busy) return '生图服务正在处理其他任务，请等待完成后再生成。';
  return null;
}
export function desktopCompletionNeedsRefresh(task: DesktopTask, chapterId: string, revisions: Pick<NovelRevision, 'id'>[]): boolean {
  const linkedRevisionId = task.linkedRevisionId ?? task.candidate?.acceptedRevisionId ?? null;
  const accepted = ['completed', 'accepted'].includes(task.status) || task.candidate?.status === 'accepted';
  return task.chapterId === chapterId && accepted && Boolean(linkedRevisionId)
    && !revisions.some(revision => revision.id === linkedRevisionId);
}
export function desktopReloadAllowed(options: { dirty: boolean; editable: boolean; busy: boolean }): boolean {
  return !options.dirty && options.editable && !options.busy;
}
export function desktopPermissionHelp(status: DesktopStatus | null): string | null {
  if (!status || status.available) return null;
  return '请到「工作台设置 → 模型连接」检查生图模型的 API 地址、模型名称和凭据，测试通过后再刷新状态。连接可用前不会提交任务。';
}

export function desktopGenerationRequest(itemId: string, revisionId: string, status: DesktopStatus | null, intentId: string) {
  return {
    itemId,
    expectedRevisionId: revisionId,
    intentId,
    allowExistingCredits: true,
    ...(status?.connectionRevision ? { expectedModelConnectionRevision: status.connectionRevision } : {}),
  };
}

export function desktopDecisionRequest(decision: 'accept' | 'reject', expectedRevisionId: string, note: string) {
  return { decision, expectedRevisionId, note: note.trim() };
}

export function createDesktopGenerationIntentId(): string {
  return `asset-generation-${crypto.randomUUID()}`;
}

export async function desktopAssetApi<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const controller = signal ? null : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), 20000) : undefined;
  try {
    const response = await fetch(path, {
      signal: signal ?? controller?.signal, ...(body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shortdrama-Call': '1' }, body: JSON.stringify(body),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message ?? `资产生成请求失败（${response.status}）。`);
    return data as T;
  } catch (cause) {
    if (controller?.signal.aborted) throw new Error('等待生图任务响应超时，提交结果需通过已保存任务核对。');
    throw cause;
  } finally { clearTimeout(timeout); }
}
