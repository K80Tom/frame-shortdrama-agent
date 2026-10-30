import { randomUUID } from 'node:crypto';
import type { SeedanceTask } from '../models/media-client';
import type { VideoAutomationAdapter } from './adapter';
import { activeVideoStates, checkedVideoUrl, MAX_VIDEO_UNKNOWN_RECONCILIATIONS, parseCreateVideoRun, parseVideoRunId, publicVideoRun,
  sameVideoRequest, VideoAutomationError, type StoredVideoRun } from './contracts';
import type { VideoAutomationRepository } from './repository';

export interface VideoAutomationOptions { pollIntervalMs?: number; now?: () => Date }
export class VideoAutomationService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private working: Promise<void> | null = null;
  private readonly queries = new Map<string, Promise<StoredVideoRun>>();
  private stopped = true;
  private readonly now: () => Date;
  constructor(private readonly repository: VideoAutomationRepository, private readonly adapter: VideoAutomationAdapter,
    private readonly options: VideoAutomationOptions = {}) { this.now = options.now ?? (() => new Date()); }

  async status() {
    const health = await this.adapter.health();
    const active = (await this.repository.list()).find(run => activeVideoStates.includes(run.status));
    return { ...health, model: health.model ?? '', busy: Boolean(active), activeRunId: active?.id ?? null };
  }
  async list() { return { runs: (await this.repository.list()).map(publicVideoRun) }; }
  private async stored(id: string) {
    parseVideoRunId(id);
    const run = await this.repository.get(id);
    if (!run) throw new VideoAutomationError(404, 'VIDEO_RUN_NOT_FOUND', '视频任务不存在。');
    return run;
  }
  async get(id: string) { return publicVideoRun(await this.stored(id)); }
  async create(value: unknown) {
    const input = parseCreateVideoRun(value);
    const previous = await this.repository.getByClientRequestId(input.clientRequestId);
    if (previous) return this.match(previous, input);
    const health = await this.adapter.health();
    if (!health.available || !health.model || !health.connectionRevision) {
      throw new VideoAutomationError(503, health.code, health.message);
    }
    if (health.connectionRevision !== input.expectedModelConnectionRevision) {
      throw new VideoAutomationError(409, 'MODEL_SELECTION_CHANGED', '生视频连接已变化，请刷新后重新确认；未调用模型。');
    }
    const { allowPaid: _, expectedModelConnectionRevision, ...settings } = input;
    const timestamp = this.timestamp();
    const run: StoredVideoRun = { ...settings, id: `video_${randomUUID().replaceAll('-', '')}`,
      title: Array.from(input.prompt.replace(/\s+/g, ' ')).slice(0, 40).join(''), status: 'queued',
      model: health.model, modelConnectionRevision: expectedModelConnectionRevision,
      providerTaskId: null, result: null, error: null, errorNode: null, reconciliationAttempts: 0, version: 0,
      createdAt: timestamp, updatedAt: timestamp };
    const saved = await this.repository.create(run);
    const response = this.match(saved, input);
    // Never await a provider call in the creation request. An unstarted service is inert in tests.
    if (!this.stopped) setImmediate(() => { if (!this.stopped) void this.tick().catch(() => undefined); });
    return response;
  }
  private match(run: StoredVideoRun, input: ReturnType<typeof parseCreateVideoRun>) {
    if (!sameVideoRequest(run, input)) throw new VideoAutomationError(409, 'VIDEO_REQUEST_CONFLICT', '此请求标识已用于另一组输入；未再次调用模型。');
    return publicVideoRun(run);
  }
  private timestamp() { return this.now().toISOString(); }
  private change(run: StoredVideoRun, changes: Partial<StoredVideoRun>) {
    return this.repository.replace({ ...run, ...changes, updatedAt: this.timestamp() }, run.version);
  }

  async start() {
    if (!this.stopped) return;
    // A submitting marker is written before the network call. Never replay it after restart.
    for (const run of await this.repository.list()) {
      if (run.status === 'submitting') {
        await this.change(run, { status: run.providerTaskId ? 'generating' : 'unknown', errorNode: run.providerTaskId ? null : 'submit',
          reconciliationAttempts: 0,
          error: run.providerTaskId ? null : { code: 'VIDEO_SUBMISSION_INTERRUPTED', message: '提交期间服务中断，结果不明；不会自动重发或重复计费。' } });
      }
    }
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, this.options.pollIntervalMs ?? 4000);
    this.timer.unref();
    void this.tick().catch(() => undefined);
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.working;
    await Promise.allSettled(this.queries.values());
  }
  /** One durable state transition per tick; exposed for offline deterministic tests. */
  async tick(): Promise<void> {
    if (this.working) return this.working;
    const work = async () => {
      const run = (await this.repository.list()).find(item => item.status === 'queued' || item.status === 'generating');
      if (!run) return;
      if (run.status === 'queued') await this.dispatch(run);
      else await this.query(run);
    };
    this.working = work();
    try { await this.working; } finally { this.working = null; }
  }
  private async dispatch(run: StoredVideoRun) {
    const health = await this.adapter.health();
    if (!health.available || health.connectionRevision !== run.modelConnectionRevision || health.model !== run.model) {
      await this.change(run, { status: 'failed', errorNode: 'model', error: {
        code: health.available ? 'MODEL_SELECTION_CHANGED' : health.code,
        message: health.available ? '模型连接在排队期间发生变化，未提交生成请求。' : health.message } });
      return;
    }
    // CAS wins submission ownership; no network request occurs before this durable marker.
    const submitting = await this.change(run, { status: 'submitting', error: null, errorNode: null });
    let receivedTaskId: string | null = null;
    try {
      const response = await this.adapter.submit(submitting);
      if (response.state !== 'submitted') {
        await this.change(submitting, { status: response.state === 'blocked' ? 'failed' : 'unknown', reconciliationAttempts: 0,
          errorNode: 'submit', error: { code: response.code, message: response.message } });
        return;
      }
      // Save a valid provider ID before interpreting status/result, so malformed output can be reconciled.
      if (!validTaskId(response.task.taskId)) throw new Error('Invalid task ID');
      receivedTaskId = response.task.taskId;
      const submitted = await this.change(submitting, { status: 'generating', providerTaskId: response.task.taskId,
        reconciliationAttempts: 0 });
      await this.applyTask(submitted, response.task);
    } catch {
      const current = await this.repository.get(run.id);
      if (current && (current.status === 'submitting' || current.status === 'generating')) {
        const providerTaskId = current.providerTaskId ?? receivedTaskId;
        await this.change(current, { status: 'unknown', providerTaskId, reconciliationAttempts: 0,
          errorNode: providerTaskId ? 'generate' : 'submit',
          error: { code: 'VIDEO_SUBMISSION_UNCERTAIN', message: '视频请求可能已被供应商处理；已保存可用任务标识，不会自动重发。' } });
      }
    }
  }
  async reconcile(id: string, value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) {
      throw new VideoAutomationError(400, 'VIDEO_RECONCILE_INVALID', '查询结果仅接受空对象，不允许修改输入或重新授权提交。');
    }
    const run = await this.stored(id);
    // Reconcile is query-only, including for unknown submissions. It never submits queued work.
    if (!run.providerTaskId || !['generating', 'unknown'].includes(run.status)) return publicVideoRun(run);
    if (run.status === 'unknown' && (run.reconciliationAttempts ?? 0) >= MAX_VIDEO_UNKNOWN_RECONCILIATIONS) {
      return publicVideoRun(run);
    }
    return publicVideoRun(await this.query(run));
  }
  private async query(run: StoredVideoRun): Promise<StoredVideoRun> {
    const existing = this.queries.get(run.id);
    if (existing) return existing;
    const operation = (async () => {
      try { return await this.applyTask(run, await this.adapter.query(run)); }
      catch (error) {
        const current = await this.repository.get(run.id);
        if (!current) throw error;
        if (current.version !== run.version || !['generating', 'unknown'].includes(current.status)) return current;
        return this.markUnknown(current, 'generate', {
          code: error instanceof VideoAutomationError ? error.code : 'VIDEO_QUERY_UNCERTAIN',
          message: error instanceof VideoAutomationError ? error.message : '暂时无法确认视频结果；任务 ID 已保留，可再次查询，不会重新生成。' });
      }
    })();
    this.queries.set(run.id, operation);
    try { return await operation; } finally { this.queries.delete(run.id); }
  }
  private async applyTask(run: StoredVideoRun, task: SeedanceTask): Promise<StoredVideoRun> {
    const storedTaskId = run.providerTaskId ?? '';
    if (!task || !validTaskId(task.taskId) || !sameProviderTask(task.taskId, storedTaskId) || typeof task.status !== 'string') {
      throw new VideoAutomationError(502, 'VIDEO_TASK_RESPONSE_INVALID', '供应商返回了不匹配或无效的任务信息；保留原任务 ID。');
    }
    const status = task.status.toLowerCase();
    if (['failed', 'cancelled', 'expired'].includes(status)) {
      return this.change(run, { status: 'failed', result: null, errorNode: 'generate',
        error: { code: `VIDEO_PROVIDER_${status.toUpperCase()}`, message: '供应商已将此视频任务标记为失败、取消或过期；不会自动重试。' } });
    }
    if (status === 'succeeded') {
      let videoUrl: string;
      try { videoUrl = checkedVideoUrl(task.videoUrl); }
      catch { return this.markUnknown(run, 'deliver',
        { code: 'VIDEO_RESULT_INVALID', message: '供应商标记生成成功，但未返回有效 HTTPS 视频链接；可以再次查询，不会重新生成。' },
        { result: null }); }
      return this.change(run, { status: 'completed', result: { videoUrl }, error: null, errorNode: null });
    }
    if (!['queued', 'pending', 'submitted', 'running', 'processing', 'generating'].includes(status)) {
      throw new VideoAutomationError(502, 'VIDEO_TASK_STATUS_UNKNOWN', '供应商返回了未知状态；保留原任务 ID，可以再次查询。');
    }
    if (run.status === 'unknown') return this.markUnknown(run, 'generate', {
      code: 'VIDEO_EXTERNAL_STILL_RUNNING', message: '供应商任务仍在生成，可稍后再次查询；不会重新提交。' });
    // Retain generating without artificial percentages or redundant database writes.
    return run;
  }

  private markUnknown(run: StoredVideoRun, errorNode: NonNullable<StoredVideoRun['errorNode']>,
    error: NonNullable<StoredVideoRun['error']>, changes: Partial<StoredVideoRun> = {}) {
    const reconciliationAttempts = Math.min(MAX_VIDEO_UNKNOWN_RECONCILIATIONS,
      (run.reconciliationAttempts ?? 0) + 1);
    const exhausted = reconciliationAttempts >= MAX_VIDEO_UNKNOWN_RECONCILIATIONS;
    return this.change(run, { ...changes, status: 'unknown', errorNode, reconciliationAttempts,
      error: exhausted ? { code: 'VIDEO_RECONCILIATION_LIMIT_REACHED',
        message: `已连续 ${MAX_VIDEO_UNKNOWN_RECONCILIATIONS} 次无法确认供应商任务结果，自动查询已停止；任务 ID 已保留，需要人工对账。` }
        : error });
  }
}
function validTaskId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
}

/**
 * The gateway is inconsistent about task IDs: the submit response can return
 * "model-prefix:task-id" while the query response returns the bare task id.
 * Accept the bare id when it is the exact ":suffix" of the stored id, so the
 * same provider task is recognized across both formats. Anything else stays a
 * mismatch — the guard against applying another task's result is preserved.
 */
function sameProviderTask(responseTaskId: string, storedTaskId: string): boolean {
  if (responseTaskId === storedTaskId) return true;
  if (!storedTaskId) return false;
  const separator = storedTaskId.lastIndexOf(':');
  if (separator <= 0 || separator === storedTaskId.length - 1) return false;
  return responseTaskId === storedTaskId.slice(separator + 1)
    && validTaskId(responseTaskId);
}
