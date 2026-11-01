export const videoRatios = ['9:16', '16:9'] as const;
export const videoResolutions = ['720p', '1080p'] as const;
export const videoDurations = [5, 10, 15] as const;
export type VideoForm = { prompt: string; ratio: typeof videoRatios[number]; duration: number; resolution: typeof videoResolutions[number]; generateAudio: boolean };
export const defaultVideoForm: VideoForm = { prompt: '', ratio: '9:16', duration: 5, resolution: '720p', generateAudio: false };
export type VideoRunStatus = 'queued' | 'submitting' | 'generating' | 'completed' | 'failed' | 'unknown';
export type VideoNodeState = 'pending' | 'running' | 'waitingExternal' | 'succeeded' | 'failed' | 'needsAttention';
export const videoNodeKeys = ['input', 'model', 'submit', 'generate', 'deliver'] as const;
export type VideoNode = { key: typeof videoNodeKeys[number]; label: string; state: VideoNodeState; message: string };
export type VideoRun = {
  id: string; status: VideoRunStatus; clientRequestId: string; modelConnectionRevision: string;
  nodes: VideoNode[]; progress: { completed: number; total: number }; result: { videoUrl: string } | null;
  prompt?: string; model?: string; ratio?: string; duration?: number; resolution?: string; generateAudio?: boolean;
  createdAt?: string; updatedAt?: string; message?: string;
};
export type VideoStatus = { available: boolean; code: string; message: string; model: string; connectionRevision: string; busy: boolean };
export type PendingVideoIntent = { clientRequestId: string; createdAt: string };
export const pendingVideoKey = 'ohao:video-automation-pending:v1';
export const videoRunLabels: Record<VideoRunStatus, string> = {
  queued: '等待处理', submitting: '正在提交', generating: '正在生成', completed: '视频已完成', failed: '任务未完成', unknown: '提交结果待核对',
};
const runStatuses = Object.keys(videoRunLabels);
const nodeStates = ['pending', 'running', 'waitingExternal', 'succeeded', 'failed', 'needsAttention'];
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function isVideoRun(value: unknown): value is VideoRun {
  if (!object(value) || typeof value.id !== 'string' || !value.id || !runStatuses.includes(String(value.status))
    || typeof value.clientRequestId !== 'string' || typeof value.modelConnectionRevision !== 'string'
    || !Array.isArray(value.nodes) || value.nodes.length !== videoNodeKeys.length || !object(value.progress)) return false;
  const keys = new Set<string>();
  for (const node of value.nodes) {
    if (!object(node) || !videoNodeKeys.includes(node.key as typeof videoNodeKeys[number]) || keys.has(String(node.key))
      || !nodeStates.includes(String(node.state)) || typeof node.label !== 'string' || typeof node.message !== 'string') return false;
    keys.add(String(node.key));
  }
  const { completed, total } = value.progress;
  if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || Number(total) !== videoNodeKeys.length
    || Number(completed) < 0 || Number(completed) > Number(total)) return false;
  if (value.result !== null && value.result !== undefined && (!object(value.result) || typeof value.result.videoUrl !== 'string')) return false;
  for (const key of ['prompt', 'model', 'ratio', 'resolution', 'createdAt', 'updatedAt', 'message']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  }
  return true;
}

export function parseVideoRun(value: unknown): VideoRun {
  if (!isVideoRun(value)) throw new Error('视频任务返回格式不完整，请刷新后核对。');
  return { ...value, result: value.result ?? null, nodes: videoNodeKeys.map(key => value.nodes.find(node => node.key === key)!) };
}
export function parseVideoRuns(value: unknown): VideoRun[] {
  if (!object(value) || !Array.isArray(value.runs)) throw new Error('视频任务列表返回格式不完整。');
  return value.runs.map(parseVideoRun);
}
export function parseVideoStatus(value: unknown): VideoStatus {
  if (!object(value) || typeof value.available !== 'boolean' || typeof value.busy !== 'boolean'
    || !['code', 'message'].every(key => typeof value[key] === 'string')
    || (value.model !== null && typeof value.model !== 'string')
    || (value.connectionRevision !== undefined && value.connectionRevision !== null && typeof value.connectionRevision !== 'string')) {
    throw new Error('视频模型状态返回格式不完整。');
  }
  return { ...value, model: value.model ?? '', connectionRevision: value.connectionRevision ?? '' } as VideoStatus;
}
export function validateVideoForm(form: VideoForm): string | null {
  if (!form.prompt.trim()) return '先描述你想创建的视频。';
  if (form.prompt.trim().length > 8000) return '视频描述请控制在 8000 字符以内。';
  if (!videoRatios.includes(form.ratio) || !videoResolutions.includes(form.resolution)
    || !videoDurations.includes(form.duration as typeof videoDurations[number]) || typeof form.generateAudio !== 'boolean') return '请检查视频设置。';
  return null;
}
export function videoResultLink(value: string | undefined): string | null {
  if (!value || /[\s\\\u0000-\u001f\u007f]/.test(value) || !value.startsWith('https://')) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function videoRunActive(run: VideoRun): boolean { return ['queued', 'submitting', 'generating'].includes(run.status); }
export function videoCreationBlocked(options: { status: VideoStatus | null; runs: VideoRun[]; pending: boolean; loading: boolean; posting: boolean; reconciling: boolean }): boolean {
  return !options.status?.available || !options.status.connectionRevision || options.status.busy
    || options.runs.some(videoRunActive) || options.pending || options.loading || options.posting || options.reconciling;
}
export function mergeVideoRuns(current: VideoRun[], incoming: VideoRun[]): VideoRun[] {
  const byId = new Map(current.map(run => [run.id, run]));
  for (const run of incoming) {
    const previous = byId.get(run.id);
    if (!previous || !previous.updatedAt || !run.updatedAt || run.updatedAt >= previous.updatedAt) byId.set(run.id, run);
  }
  return [...byId.values()].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || b.id.localeCompare(a.id));
}
export function resolvePendingVideoIntent(pending: PendingVideoIntent | null, runs: VideoRun[], posting: boolean):
  { state: 'none' | 'waiting' | 'notFound'; run?: never } | { state: 'found'; run: VideoRun } {
  if (!pending) return { state: 'none' };
  if (posting) return { state: 'waiting' };
  const run = runs.find(item => item.clientRequestId === pending.clientRequestId);
  return run ? { state: 'found', run } : { state: 'notFound' };
}
export function readPendingVideoIntent(storage: Pick<Storage, 'getItem'>): PendingVideoIntent | null {
  try {
    const raw = storage.getItem(pendingVideoKey);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    return object(value) && typeof value.clientRequestId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(value.clientRequestId)
      && typeof value.createdAt === 'string' ? value as PendingVideoIntent : null;
  } catch { return null; }
}
export function videoSubmission(form: VideoForm, status: VideoStatus, clientRequestId: string) {
  const error = validateVideoForm(form);
  if (error) throw new Error(error);
  if (!status.available || status.busy || !status.connectionRevision) throw new Error('视频模型尚未就绪，请刷新状态。');
  return { ...form, prompt: form.prompt.trim(), clientRequestId, expectedModelConnectionRevision: status.connectionRevision, allowPaid: true as const };
}
export class VideoApiError extends Error { constructor(message: string, public status: number) { super(message); this.name = 'VideoApiError'; } }
export async function videoAutomationApi(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal, cache: 'no-store', ...(body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shortdrama-Call': '1' }, body: JSON.stringify(body),
  }) });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = object(data) && object(data.error) && typeof data.error.message === 'string' ? data.error.message.slice(0, 500) : `请求失败（${response.status}）`;
    throw new VideoApiError(message, response.status);
  }
  return data;
}
