export type VideoRunStatus = 'queued' | 'submitting' | 'generating' | 'completed' | 'failed' | 'unknown';
export type VideoNodeId = 'input' | 'model' | 'submit' | 'generate' | 'deliver';
export type VideoNodeState = 'pending' | 'running' | 'waitingExternal' | 'succeeded' | 'failed' | 'needsAttention';
export const activeVideoStates: readonly VideoRunStatus[] = ['queued', 'submitting', 'generating'];
export const MAX_VIDEO_UNKNOWN_RECONCILIATIONS = 3;

export class VideoAutomationError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

export interface CreateVideoRun {
  prompt: string;
  ratio: '9:16' | '16:9';
  duration: number;
  resolution: '720p' | '1080p';
  generateAudio: boolean;
  /** Ordered immutable catalogue references used as Seedance reference images. */
  referenceAssetIds?: string[];
  clientRequestId: string;
  expectedModelConnectionRevision: string;
  allowPaid: true;
}
export interface StoredVideoRun extends Omit<CreateVideoRun, 'expectedModelConnectionRevision' | 'allowPaid'> {
  id: string;
  title: string;
  status: VideoRunStatus;
  model: string;
  modelConnectionRevision: string;
  providerTaskId: string | null;
  result: { videoUrl: string } | null;
  error: { code: string; message: string } | null;
  errorNode: Exclude<VideoNodeId, 'input'> | null;
  /** Query attempts made after the provider result became uncertain. Optional for
   * compatibility with video runs created before this recovery field existed. */
  reconciliationAttempts?: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface VideoAvailability {
  available: boolean;
  code: string;
  message: string;
  model: string | null;
  connectionRevision: string | null;
}

function invalid(): never {
  throw new VideoAutomationError(400, 'VIDEO_REQUEST_INVALID', '请填写 1–8000 字提示词、有效的视频设置、请求标识与当前模型版本，并确认本次模型额度。');
}
export function parseCreateVideoRun(value: unknown): CreateVideoRun {
  const required = ['prompt', 'ratio', 'duration', 'resolution', 'generateAudio', 'clientRequestId', 'expectedModelConnectionRevision', 'allowPaid'];
  const keys = [...required, 'referenceAssetIds'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid();
  const input = value as Record<string, unknown>;
  const references = input.referenceAssetIds;
  if (references !== undefined && (!Array.isArray(references) || references.length > 30
    || references.some(id => typeof id !== 'string' || !/^asset_[a-f0-9]{32}$/u.test(id))
    || new Set(references).size !== references.length)) invalid();
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 8000
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.prompt)
    || Array.from(input.prompt).some(char => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff)
    || !['9:16', '16:9'].includes(input.ratio as string)
    || !Number.isInteger(input.duration) || Number(input.duration) < 4 || Number(input.duration) > 30
    || !['720p', '1080p'].includes(input.resolution as string) || typeof input.generateAudio !== 'boolean'
    || typeof input.clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.clientRequestId)
    || typeof input.expectedModelConnectionRevision !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.expectedModelConnectionRevision)
    || input.allowPaid !== true) invalid();
  return { ...(input as unknown as CreateVideoRun), prompt: input.prompt.trim(),
    ...(references === undefined ? {} : { referenceAssetIds: [...references] as string[] }) };
}
export function parseVideoRunId(id: string): string {
  if (!/^video_[a-f0-9]{32}$/.test(id)) throw new VideoAutomationError(400, 'VIDEO_ID_INVALID', '视频任务 ID 不正确。');
  return id;
}
export function sameVideoRequest(run: StoredVideoRun, input: CreateVideoRun): boolean {
  return run.prompt === input.prompt && run.ratio === input.ratio && run.duration === input.duration
    && run.resolution === input.resolution && run.generateAudio === input.generateAudio
    && sameReferences(run.referenceAssetIds, input.referenceAssetIds)
    && run.clientRequestId === input.clientRequestId && run.modelConnectionRevision === input.expectedModelConnectionRevision;
}

function sameReferences(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  const a = left ?? []; const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** URL validation only: no fetch, DNS request, download or claim of local storage. */
export function checkedVideoUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\\\x00-\x20\x7f]/.test(value)) {
    throw new VideoAutomationError(502, 'VIDEO_RESULT_INVALID', '供应商未返回有效的 HTTPS 视频链接。');
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new VideoAutomationError(502, 'VIDEO_RESULT_INVALID', '供应商未返回有效的 HTTPS 视频链接。'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
    throw new VideoAutomationError(502, 'VIDEO_RESULT_INVALID', '供应商未返回有效的 HTTPS 视频链接。');
  }
  return url.href;
}

export function publicVideoRun(run: StoredVideoRun) {
  const states: Record<VideoNodeId, VideoNodeState> = {
    input: 'succeeded', model: 'succeeded', submit: 'pending', generate: 'pending', deliver: 'pending',
  };
  if (run.status === 'submitting') states.submit = 'running';
  if (run.providerTaskId) { states.submit = 'succeeded'; states.generate = 'waitingExternal'; }
  if (run.status === 'completed') { states.submit = 'succeeded'; states.generate = 'succeeded'; states.deliver = 'succeeded'; }
  if (run.errorNode && (run.status === 'failed' || run.status === 'unknown')) {
    if (run.errorNode === 'deliver') states.generate = 'succeeded';
    states[run.errorNode] = run.status === 'failed' ? 'failed' : 'needsAttention';
  }
  const labels: Record<VideoNodeId, string> = { input: '输入检查', model: '模型确认', submit: '提交任务', generate: '视频生成', deliver: '获取结果' };
  const messages: Record<VideoNodeId, string> = { input: '提示词与视频设置已保存。', model: `已冻结模型 ${run.model} 与连接版本。`,
    submit: '仅提交一次生成请求。', generate: '等待供应商返回任务结果；没有供应商百分比。', deliver: '保存供应商 HTTPS 结果链接；链接可能过期，视频尚未下载入库。' };
  const nodes = (Object.keys(labels) as VideoNodeId[]).map(id => ({ key: id, label: labels[id], state: states[id],
    message: run.errorNode === id && run.error ? run.error.message : messages[id] }));
  return { ...structuredClone(run), nodes, progress: { completed: nodes.filter(node => node.state === 'succeeded').length, total: 5 as const } };
}
