import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AssetService } from '../assets/service';
import { AssetError } from '@ohao/shared';
import { MAX_ASSET_BYTES, inspectAssetImage, parseAssetImport } from '../assets/media';
import type { NovelRepository } from '../novel/repository';
import type { NovelService } from '../novel/service';
import { NovelError } from '@ohao/shared';
import type { DesktopAssetAdapter } from './adapter';
import {
  ASSET_PROMPT_VERSION, LEGACY_ASSET_PROMPT_VERSION, acceptanceReservation, activeStates, buildAssetVisualBrief, desktopError,
  eligibleItem, generatedAssetMarker, generationPrompt, imageGenerationPrompt, intentId, isAcceptanceReservation, itemKey,
  opaqueId, parseAcceptanceReservation, reconcilableStates, reviewNote,
  previewDescription, publicTask, type AssetVisualBrief, type StoredAssetGenerationCandidate, type StoredDesktopTask,
} from './contracts';
import type { DesktopBridgeHealth } from './adapter';
import type { DesktopTaskRepository } from './repository';

const UNVERIFIED_HISTORICAL_LINK = '检测到历史版本曾关联此候选资产，但没有可验证的人工接受凭据；未认定为已接受，请人工核对。';

/** Local-only orchestrator. No model client, remote HTTP, shell string or user-supplied path is accepted. */
export class DesktopAssetService {
  private timer?: NodeJS.Timeout;
  private working: Promise<void> | null = null;
  private readonly decisions = new Set<string>();
  private stopped = false;
  readonly outputRoot: string;
  constructor(private readonly jobs: DesktopTaskRepository, private readonly novels: NovelRepository,
    private readonly novelService: NovelService, private readonly assets: AssetService,
    private readonly adapter: DesktopAssetAdapter, projectRoot = process.cwd()) {
    this.outputRoot = resolve(projectRoot, 'outputs/private/desktop-assets');
  }
  async status() {
    const health = await this.adapter.health();
    const busy = (await this.jobs.list()).some(task => activeStates.includes(task.status));
    return {available: health.available, code: health.code, message: health.message,
      model: health.model ?? '未配置', connectionRevision: health.connectionRevision, busy};
  }
  private async public(task: StoredDesktopTask) {
    const candidate = await this.jobs.getCandidateByTask(task.id);
    return publicTask(task, candidate ? await this.recoverAcceptedCandidate(candidate) : null);
  }
  async list(chapterId: string) {
    const tasks = await this.jobs.list(opaqueId(chapterId));
    return {tasks: await Promise.all(tasks.map(task => this.public(task)))};
  }
  private async input(revisionId: string, itemId: string) {
    const revision = await this.novels.getRevision(opaqueId(revisionId));
    if (!revision) desktopError(404, 'NOVEL_REVISION_NOT_FOUND', '校对版本不存在。');
    const source = await this.novels.getChapterSource(revision.chapterId);
    const chapter = source?.chapters.find(c => c.id === revision.chapterId);
    if (!source || !chapter) desktopError(404, 'NOVEL_CHAPTER_NOT_FOUND', '章节不存在。');
    if (chapter.latestRevisionId !== revisionId) desktopError(409, 'NOVEL_REVISION_CONFLICT', '仅可使用最新已保存版本，请先刷新核对。');
    const item = eligibleItem(revision, opaqueId(itemId));
    return {revision, source, chapter, item};
  }
  async preview(revisionId: string, itemId: string) { return previewDescription((await this.input(revisionId, itemId)).item); }
  async create(revisionId: string, value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![3, 4, 5].includes(Object.keys(value).length)
      || Object.keys(value).some(key => !['itemId', 'expectedRevisionId', 'allowExistingCredits', 'expectedModelConnectionRevision', 'intentId'].includes(key))) {
      desktopError(400, 'DESKTOP_REQUEST_INVALID', '请提供条目、当前版本和单张生成授权。');
    }
    const body = value as Record<string, unknown>;
    if (body.allowExistingCredits !== true) desktopError(400, 'PAID_CONFIRMATION_REQUIRED', '请确认使用当前生图连接的额度生成一张图片。');
    if (body.expectedRevisionId !== revisionId) desktopError(409, 'NOVEL_REVISION_CONFLICT', '生成基准不一致，请刷新核对。');
    const {source, chapter, item} = await this.input(revisionId, opaqueId(body.itemId));
    const requestedIntent = body.intentId === undefined ? undefined : intentId(body.intentId);
    const jobKey = itemKey(chapter.id, item, requestedIntent);
    const existing = (await this.jobs.list(chapter.id)).find(task => task.jobKey === jobKey);
    if (existing) {
      // Clicking create with a fresh credit confirmation is the only retry path.
      // Unknown/active/completed work is never replayed, even across restarts.
      if (existing.status !== 'failed') return this.public(existing);
      if (existing.assetId || existing.linkedRevisionId) desktopError(409, 'DESKTOP_RETRY_UNSAFE', '任务已有保存成果，不能重新生图。');
      await this.emptyTaskDirectory(existing);
      const health = await this.adapter.health();
      if (!health.available) desktopError(503, health.code, health.message);
      this.assertModelSelection(health.connectionRevision, body.expectedModelConnectionRevision);
      const retry = this.snapshotPrompt({...existing, inputRevisionId: revisionId, submittedAt: null,
        ...(health.model ? {model: health.model} : {}),
        ...(health.connectionRevision ? {modelConnectionRevision: health.connectionRevision} : {})}, health);
      this.assertPromptSize(retry);
      try {
        return this.public(await this.change(retry, {status: 'queued', phase: '排队',
          message: '已核对未提交且产物目录为空，按本次明确授权重新排队；只生成一张图片。'}));
      } catch (error) {
        if (!(error instanceof NovelError) || error.code !== 'DESKTOP_TASK_CONFLICT') throw error;
        // A second click must observe the winner, not create another attempt.
        const current = await this.jobs.get(existing.id);
        if (current && current.jobKey === jobKey) return this.public(current);
        throw error;
      }
    }
    const health = await this.adapter.health();
    if (!health.available) desktopError(503, health.code, health.message);
    this.assertModelSelection(health.connectionRevision, body.expectedModelConnectionRevision);
    const now = new Date().toISOString();
    const base: StoredDesktopTask = {id: `desktop_${randomUUID().replaceAll('-', '')}`, jobKey,
      sourceId: source.id, chapterId: chapter.id, itemId: item.id, inputRevisionId: revisionId,
      ...(requestedIntent ? {intentId: requestedIntent} : {}),
      label: item.label, kind: item.kind, item: structuredClone(item), status: 'queued', phase: '排队',
      message: '已保存单张生成任务，等待已选生图连接；刷新或关闭页面不重复提交。',
      ...(health.model ? {model: health.model} : {}),
      ...(health.connectionRevision ? {modelConnectionRevision: health.connectionRevision} : {}),
      assetId: null, linkedRevisionId: null, version: 0, submittedAt: null, createdAt: now, updatedAt: now};
    const candidate = this.snapshotPrompt(base, health);
    this.assertPromptSize(candidate);
    const task = await this.jobs.create(candidate);
    return this.public(task);
  }
  async start() {
    // Submission uncertainty is persistent. Never replay an interrupted keystroke.
    for (const task of await this.jobs.list()) {
      if (task.status === 'submitting') await this.change(task, {status: 'unknown', phase: '待核对',
        message: '后端曾在提交期间中断；只检查原任务输出，不会再次发送生图请求。'});
    }
    // Resolve any durable acceptance reservation before HTTP becomes ready.
    // A linked revision wins and repairs accepted; otherwise restore the
    // version-checked review baseline without submitting or binding anything.
    for (const candidate of await this.jobs.listCandidates()) {
      if (!isAcceptanceReservation(candidate.reviewNote)) continue;
      const task = await this.jobs.get(candidate.taskId);
      if (task) await this.restoreAcceptanceReservation(task, candidate);
    }
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, 4_000);
    this.timer.unref();
  }
  async stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); await this.working?.catch(() => undefined); }
  /** Public for deterministic tests; never dispatches more than one active generation task. */
  async tick() {
    if (this.working || this.stopped) return;
    this.working = (async () => {
      const task = (await this.jobs.list()).find(value => activeStates.includes(value.status));
      if (!task) return;
      if (task.status === 'queued') await this.dispatch(task);
      else await this.collect(task);
    })();
    try { await this.working; } finally { this.working = null; }
  }
  async reconcile(id: string, body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) desktopError(400, 'DESKTOP_REQUEST_INVALID', '核对请求不接受额外字段或文件路径。');
    const task = await this.jobs.get(opaqueId(id));
    if (!task) desktopError(404, 'DESKTOP_TASK_NOT_FOUND', '桌面生成任务不存在。');
    // This endpoint cannot dispatch, retry or authorize generation.
    if (!this.working && reconcilableStates.includes(task.status)) {
      this.working = this.collect(task);
      try { await this.working; } finally { this.working = null; }
    }
    return this.public((await this.jobs.get(id))!);
  }
  private change(task: StoredDesktopTask, patch: Partial<StoredDesktopTask>) {
    return this.jobs.replace({...task, ...patch, updatedAt: new Date().toISOString()}, task.version);
  }
  private snapshotPrompt(task: StoredDesktopTask, health: DesktopBridgeHealth): StoredDesktopTask {
    const provider = health.transport ?? (this.adapter.promptMode === 'api' ? 'api' : 'desktop');
    const brief = buildAssetVisualBrief(task.item as StoredDesktopTask['item'] & {kind: AssetVisualBrief['kind']});
    const snapshot = {...task, provider, brief, promptVersion: ASSET_PROMPT_VERSION} as StoredDesktopTask;
    return {...snapshot, promptSnapshot: provider === 'desktop'
      ? generationPrompt(snapshot, this.outputPath(snapshot.id)) : imageGenerationPrompt(snapshot)};
  }
  private submittedPrompt(task: StoredDesktopTask): string {
    if (task.promptSnapshot) return task.promptSnapshot;
    return (task.provider ?? (this.adapter.promptMode === 'api' ? 'api' : 'desktop')) === 'desktop'
      ? generationPrompt(task, this.outputPath(task.id)) : imageGenerationPrompt(task);
  }
  private assertModelSelection(actual: string | undefined, expected: unknown) {
    if (!actual) return; // Legacy desktop bridge has no independently selectable connection.
    if (typeof expected !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(expected)) {
      desktopError(400, 'MODEL_SELECTION_INVALID', '请刷新生图连接后再确认本次生成。');
    }
    if (expected !== actual) desktopError(409, 'MODEL_SELECTION_CHANGED', '生图连接已在其他页面修改；请刷新并重新确认，未调用模型。');
  }
  outputPath(id: string) {
    if (!/^desktop_[a-f0-9]{32}$/.test(id)) desktopError(400, 'DESKTOP_TASK_INVALID', '任务标识无效。');
    return join(this.outputRoot, id, 'result.png');
  }
  private assertPromptSize(task: StoredDesktopTask) {
    const prompt = this.submittedPrompt(task);
    if (Buffer.byteLength(prompt, 'utf8') > 32_000) {
      desktopError(400, 'DESKTOP_PROMPT_TOO_LARGE', '该条目的描述与依据超过单次生图输入限制，请先精简并保存；未创建或提交任务。');
    }
  }
  /** Missing is safe only under real directories; existing must be a regular,
   * empty directory. Any marker, result, symlink or unrelated content prevents retry. */
  private async emptyTaskDirectory(task: StoredDesktopTask) {
    const directory = dirname(this.outputPath(task.id));
    let before;
    try { before = await lstat(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Validate the nearest existing ancestor before mkdir can traverse it.
      let ancestor = dirname(directory);
      for (;;) {
        try {
          const entry = await lstat(ancestor);
          if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(ancestor) !== ancestor) {
            desktopError(409, 'DESKTOP_PATH_UNSAFE', '桌面产物目录不能经过符号链接或非目录文件。');
          }
          return false;
        } catch (parentError) {
          if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw parentError;
          const parent = dirname(ancestor);
          if (parent === ancestor) throw parentError;
          ancestor = parent;
        }
      }
    }
    if (!before.isDirectory() || before.isSymbolicLink() || await realpath(directory) !== directory) {
      desktopError(409, 'DESKTOP_PATH_UNSAFE', '任务目录不是独立的真实目录，不能重新提交。');
    }
    const entries = await readdir(directory);
    const after = await lstat(directory);
    if (!after.isDirectory() || after.isSymbolicLink() || after.ino !== before.ino || after.dev !== before.dev
      || after.mtimeMs !== before.mtimeMs || await realpath(directory) !== directory) {
      desktopError(409, 'DESKTOP_PATH_UNSAFE', '任务目录检查期间发生变化，请先核对；未重新提交。');
    }
    if (entries.length) desktopError(409, 'DESKTOP_RETRY_UNSAFE', '任务目录已有提交标记、图片或其他内容；请核对原任务，不能重新生图。');
    return true;
  }
  private async prepareDirectory(task: StoredDesktopTask) {
    await this.emptyTaskDirectory(task);
    await mkdir(this.outputRoot, {recursive: true, mode: 0o700});
    if (await realpath(this.outputRoot) !== this.outputRoot) desktopError(409, 'DESKTOP_PATH_UNSAFE', '桌面产物目录不能是符号链接。');
    const directory = dirname(this.outputPath(task.id));
    try { await mkdir(directory, {mode: 0o700}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    // A known, never-submitted failure may leave a safe empty directory.
    await this.emptyTaskDirectory(task);
    return this.outputPath(task.id);
  }
  private async dispatch(initial: StoredDesktopTask) {
    let task = initial;
    try {
      const {item} = await this.input(task.inputRevisionId, task.itemId);
      if (!isDeepStrictEqual(item, task.item)) desktopError(409, 'DESKTOP_INPUT_CHANGED', '原文条目已变化。');
      const health = await this.adapter.health();
      if (!health.available) desktopError(503, health.code, health.message);
      if (task.modelConnectionRevision) this.assertModelSelection(health.connectionRevision, task.modelConnectionRevision);
      else if (health.connectionRevision) desktopError(409, 'MODEL_SELECTION_CHANGED', '该旧任务没有保存生图连接版本，未调用模型；请在页面上重新确认。');
      if (!task.provider || !task.promptVersion || !task.promptSnapshot || !task.brief) {
        const snapshot = this.snapshotPrompt(task, health);
        task = await this.change(task, {provider: snapshot.provider, promptVersion: snapshot.promptVersion,
          promptSnapshot: snapshot.promptSnapshot, brief: snapshot.brief});
      }
      const outputPath = await this.prepareDirectory(task);
      const desktop = this.adapter.promptMode === 'desktop';
      task = await this.change(task, {status: 'submitting', phase: desktop ? '提交桌面任务' : '提交生图任务', submittedAt: new Date().toISOString(),
        message: desktop ? '正在桌面豆包提交一张图片；请勿操作豆包窗口。' : `正在调用已选生图连接${task.model ? `（${task.model}）` : ''}，只生成一张图片。`});
      const result = await this.adapter.submit({jobId: task.id,
        prompt: this.submittedPrompt(task), outputPath,
        expectedModelConnectionRevision: task.modelConnectionRevision});
      await this.change(task, result.state === 'submitted'
        ? {status: 'generating', phase: '豆包生成中', message: '生图请求已提交；只等待此任务的图片，不会重复生图。'}
        : result.state === 'blocked'
          ? {status: 'failed', phase: '提交前停止', message: result.message}
          : {status: 'unknown', phase: '待核对', message: result.message});
    } catch (error) {
      const current = await this.jobs.get(task.id);
      if (!current || current.version !== task.version) return;
      await this.change(task, task.status === 'submitting'
        ? {status: 'unknown', phase: '待核对', message: '提交结果未明确；已禁止自动重发，仅检查原任务输出。'}
        : {status: 'failed', phase: '提交前停止', message: error instanceof NovelError ? error.message : '生图连接未就绪或产物目录无法准备，未提交生成。'});
    }
  }
  private async readOutput(task: StoredDesktopTask): Promise<Buffer | null> {
    const path = this.outputPath(task.id);
    let entry;
    try { entry = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (await realpath(dirname(path)) !== dirname(path) || !entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1
      || entry.size <= 0 || entry.size > MAX_ASSET_BYTES) desktopError(400, 'DESKTOP_OUTPUT_INVALID', '产物不是受支持的独立图片文件，未导入。');
    // Avoid importing a partially written file. Container validation follows.
    if (Date.now() - entry.mtimeMs < 1_500) return null;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (before.ino !== entry.ino || before.size !== entry.size) return null;
      const bytes = await handle.readFile(); const after = await handle.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size) return null;
      inspectAssetImage(bytes);
      return bytes;
    } finally { await handle.close(); }
  }
  private async collect(initial: StoredDesktopTask) {
    // An idle worker can see submitting after the helper returned but both
    // result-state writes failed. Reconcile this boundary without dispatching
    // again; if persistence is still down, the next tick may try this write.
    let task = initial.status === 'submitting'
      ? await this.change(initial, {status: 'unknown', phase: '待核对',
        message: '提交后的状态未能完整保存；只检查原任务输出，不会再次发送生图请求。'})
      : initial;
    try {
      let candidate = await this.jobs.getCandidateByTask(task.id);
      if (!candidate) {
        let asset = task.assetId ? await this.savedAsset(task.assetId) : null;
        if (!asset) {
          const bytes = await this.readOutput(task);
          if (!bytes) {
            if (task.status === 'generating' && Date.now() - Date.parse(task.submittedAt!) > 20 * 60_000) {
              await this.change(task, {status: 'unknown', phase: '等待超时 · 待核对', message: '尚未收到图片；请核对豆包原任务。系统只检查原输出，不会重发或另扣生成额度。'});
            }
            return;
          }
          if (task.status !== 'importing') task = await this.change(task, {status: 'importing', phase: '导回资产库',
            message: '已检测到完整图片，正在保存原图与来源。'});
          const input = this.generatedAssetInput(task, bytes);
          const expectedAssetId = parseAssetImport(input).record.id;
          if (task.assetId && task.assetId !== expectedAssetId) {
            desktopError(409, 'ASSET_CANDIDATE_CONFLICT', '任务中的生成资产标识与原图不一致，未覆盖任何记录。');
          }
          asset = await this.assets.importImage(input);
          if (asset.id !== expectedAssetId) desktopError(409, 'ASSET_CANDIDATE_CONFLICT', '导入资产与任务预期标识不一致。');
          // The immutable catalogue marker is committed atomically with the
          // media. Persist the public task pointer only after the asset exists;
          // if this write fails, policy still recognizes and blocks the marker.
          if (!task.assetId) task = await this.change(task, {assetId: asset.id});
        }
        candidate = await this.ensureCandidate(task);
      }
      if (task.status !== 'awaitingReview') {
        await this.change(task, {status: 'awaitingReview', phase: '候选待确认',
          message: '图片已作为候选保存到资产库，尚未关联小说条目。请先预览并选择接受或拒绝。'});
      }
      return;
    } catch (error) {
      const current = await this.jobs.get(task.id);
      if (!current || current.version !== task.version) return;
      // Keep the generated file and immutable asset even if storage or binding fails.
      await this.change(task, {status: 'unknown', phase: '导回待核对',
        message: error instanceof NovelError ? error.message : '图片导回暂未完成，已保留原任务；可重新检查结果，不会重新生图。'});
    }
  }
  private generatedAssetInput(task: StoredDesktopTask, bytes: Buffer) {
    const preview = previewDescription(task.item);
    return {kind: task.kind, name: `${Array.from(task.label).slice(0,140).join('')} · 豆包生成候选`,
      description: `${generatedAssetMarker(task.id)} ${task.model ?? '已配置生图模型'} API 生成候选，任务 ${task.id}。原文描述：${Array.from(preview.description).slice(0,800).join('')}。视觉设计规则：${preview.designNotes}。未描述外观属于设计，不是小说事实；未自动做视觉质量验收。`,
      contentBase64: bytes.toString('base64')};
  }
  private async savedAsset(id: string) {
    try { return await this.assets.get(id); }
    catch (error) {
      if (error instanceof AssetError && error.code === 'ASSET_NOT_FOUND') return null;
      throw error;
    }
  }
  private async ensureCandidate(task: StoredDesktopTask): Promise<StoredAssetGenerationCandidate> {
    const existing = await this.jobs.getCandidateByTask(task.id);
    if (existing) {
      if (existing.assetId !== task.assetId) desktopError(409, 'ASSET_CANDIDATE_CONFLICT', '任务候选与已导入资产不一致，未覆盖现有记录。');
      return existing;
    }
    if (!task.assetId) desktopError(409, 'ASSET_CANDIDATE_INCOMPLETE', '候选图片尚未完整导入资产库。');
    const media = await this.assets.content(task.assetId);
    const now = new Date().toISOString();
    const brief = task.brief ?? buildAssetVisualBrief(task.item as StoredDesktopTask['item'] & {kind: AssetVisualBrief['kind']});
    const exactPrompt = task.promptVersion === ASSET_PROMPT_VERSION && typeof task.promptSnapshot === 'string'
      && task.promptSnapshot.length > 0 && (task.provider === 'api' || task.provider === 'desktop');
    return this.jobs.appendCandidate({
      id: `candidate_${randomUUID().replaceAll('-', '')}`,
      taskId: task.id, assetId: task.assetId, chapterId: task.chapterId, itemId: task.itemId,
      status: 'awaitingReview', version: 0,
      provenance: {
        promptVersion: exactPrompt ? ASSET_PROMPT_VERSION : LEGACY_ASSET_PROMPT_VERSION,
        promptSnapshot: exactPrompt ? task.promptSnapshot! : null,
        provider: task.provider ?? 'unknown',
        model: task.model ?? null,
        modelConnectionRevision: task.modelConnectionRevision ?? null,
        inputRevisionId: task.inputRevisionId,
        sourceItem: structuredClone(task.item), brief: structuredClone(brief),
        result: {sha256: media.sha256, mimeType: media.mimeType, bytes: media.bytes.length},
      },
      reviewNote: '', acceptedRevisionId: null, createdAt: now, updatedAt: now,
    });
  }

  /** A linked revision proves only that this asset/item pair existed. It proves
   * this candidate was accepted only when accompanied by our durable acceptance
   * reservation (or when the candidate is already terminally accepted). */
  private async linkedRevision(candidate: StoredAssetGenerationCandidate): Promise<string | null> {
    const revisions = await this.novels.listRevisions(candidate.chapterId);
    return revisions.find(revision => revision.content.assetBindings?.some(binding => binding.itemId === candidate.itemId
      && binding.status === 'linked' && binding.asset?.id === candidate.assetId))?.id ?? null;
  }
  private async acceptedRevisionForReservation(candidate: StoredAssetGenerationCandidate,
    expectedRevisionId: string): Promise<string | null> {
    const revisions = await this.novels.listRevisions(candidate.chapterId);
    return revisions.find(revision => (revision.id === expectedRevisionId
      || revision.parentRevisionId === expectedRevisionId)
      && revision.content.assetBindings?.some(binding => binding.itemId === candidate.itemId
        && binding.status === 'linked' && binding.asset?.id === candidate.assetId))?.id ?? null;
  }
  private async recoverAcceptedCandidate(initial: StoredAssetGenerationCandidate) {
    if (initial.status === 'accepted') return initial;
    let candidate = initial; let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (candidate.status === 'accepted') return candidate;
      const reservation = parseAcceptanceReservation(candidate.reviewNote);
      const acceptedRevisionId = reservation
        ? await this.acceptedRevisionForReservation(candidate, reservation.expectedRevisionId)
        : await this.linkedRevision(candidate);
      if (!acceptedRevisionId) return candidate;
      const next = reservation
        ? {...candidate, status: 'accepted' as const, reviewNote: reservation.note, acceptedRevisionId,
            updatedAt: new Date().toISOString()}
        : {...candidate, status: 'needsReview' as const, reviewNote: UNVERIFIED_HISTORICAL_LINK,
            acceptedRevisionId: null, updatedAt: new Date().toISOString()};
      if (candidate.status === next.status && candidate.reviewNote === next.reviewNote
        && candidate.acceptedRevisionId === next.acceptedRevisionId) return candidate;
      try {
        return await this.jobs.replaceCandidate(next, candidate.version);
      } catch (error) {
        failure = error;
        const current = await this.jobs.getCandidateByTask(initial.taskId);
        if (!current) desktopError(409, 'ASSET_CANDIDATE_NOT_READY', '候选审核记录暂时不可用。');
        candidate = current;
      }
    }
    throw failure;
  }
  private matchingReservation(candidate: StoredAssetGenerationCandidate, expectedRevisionId: string, note: string) {
    const reservation = parseAcceptanceReservation(candidate.reviewNote);
    if (!reservation) {
      if (isAcceptanceReservation(candidate.reviewNote)) {
        desktopError(409, 'ASSET_CANDIDATE_CONFLICT', '候选的接受凭据无法验证，已保持安全锁定，请重启后重新核对。');
      }
      return null;
    }
    if (reservation.expectedRevisionId !== expectedRevisionId || reservation.note !== note) {
      desktopError(409, 'ASSET_CANDIDATE_CONFLICT', '候选已有另一个持久化的接受决定，本次参数不一致，未覆盖原决定。');
    }
    return reservation;
  }
  private async reserveAcceptance(initial: StoredAssetGenerationCandidate, expectedRevisionId: string, note: string) {
    let candidate = initial; let failure: unknown;
    const reservation = acceptanceReservation(expectedRevisionId, randomUUID().replaceAll('-', ''), note);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (candidate.status === 'accepted') return candidate;
      if (candidate.status === 'rejected') {
        desktopError(409, 'ASSET_CANDIDATE_ALREADY_REJECTED', '候选已经拒绝，不能再接受；可重新生成新候选。');
      }
      if (this.matchingReservation(candidate, expectedRevisionId, note)) return candidate;
      try {
        return await this.jobs.replaceCandidate({...candidate, status: 'needsReview', reviewNote: reservation,
          acceptedRevisionId: null, updatedAt: new Date().toISOString()}, candidate.version);
      } catch (error) {
        if (!(error instanceof NovelError) || error.code !== 'ASSET_CANDIDATE_CONFLICT') throw error;
        failure = error;
        const current = await this.jobs.getCandidateByTask(initial.taskId);
        if (!current) desktopError(409, 'ASSET_CANDIDATE_NOT_READY', '候选审核记录暂时不可用。');
        candidate = current;
      }
    }
    throw failure;
  }
  private async restoreAcceptanceReservation(task: StoredDesktopTask, initial: StoredAssetGenerationCandidate) {
    const recovered = await this.recoverAcceptedCandidate(initial);
    if (recovered.status === 'accepted') {
      await this.syncTaskDecision(task, {status: 'accepted', phase: '候选已接受并关联',
        linkedRevisionId: recovered.acceptedRevisionId, message: '已恢复中断的接受决定；未重复保存小说版本。'});
      return recovered;
    }
    const reservation = parseAcceptanceReservation(recovered.reviewNote);
    if (!reservation) return recovered; // malformed internal state stays fail-closed
    const source = await this.novels.getChapterSource(task.chapterId);
    const latestId = source?.chapters.find(value => value.id === task.chapterId)?.latestRevisionId;
    const latest = latestId ? await this.novels.getRevision(latestId) : null;
    const item = latest?.content.items.find(value => value.id === task.itemId);
    const binding = latest?.content.assetBindings?.find(value => value.itemId === task.itemId);
    const canResume = latest?.id === reservation.expectedRevisionId && isDeepStrictEqual(item, task.item)
      && (!binding || binding.status === 'missing');
    if (canResume) {
      await this.decision(task.id, {decision: 'accept', expectedRevisionId: reservation.expectedRevisionId, note: reservation.note});
      return (await this.jobs.getCandidateByTask(task.id))!;
    }
    return this.jobs.replaceCandidate({...recovered, status: 'needsReview', reviewNote: reservation.note,
      acceptedRevisionId: null, updatedAt: new Date().toISOString()}, recovered.version);
  }

  async decision(id: string, value: unknown) {
    const taskId = opaqueId(id);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![2, 3].includes(Object.keys(value).length)
      || Object.keys(value).some(key => !['decision', 'expectedRevisionId', 'note'].includes(key))) {
      desktopError(400, 'DESKTOP_DECISION_INVALID', '请提供候选决定、当前章节版本和可选备注。');
    }
    const body = value as Record<string, unknown>;
    if (body.decision !== 'accept' && body.decision !== 'reject') {
      desktopError(400, 'DESKTOP_DECISION_INVALID', '候选决定只能是接受或拒绝。');
    }
    const expectedRevisionId = opaqueId(body.expectedRevisionId);
    const note = reviewNote(body.note);
    if (this.decisions.has(taskId)) desktopError(409, 'ASSET_CANDIDATE_CONFLICT', '候选正在审核，请稍后读取最新状态。');
    this.decisions.add(taskId);
    try {
      const task = await this.jobs.get(taskId);
      if (!task) desktopError(404, 'DESKTOP_TASK_NOT_FOUND', '资产生成任务不存在。');
      let candidate = await this.jobs.getCandidateByTask(taskId);
      if (!candidate) desktopError(409, 'ASSET_CANDIDATE_NOT_READY', '图片尚未形成可审核候选。');
      candidate = await this.recoverAcceptedCandidate(candidate);
      if (body.decision === 'reject') {
        if (candidate.status === 'accepted') desktopError(409, 'ASSET_CANDIDATE_ALREADY_ACCEPTED', '候选已经关联，不能改为拒绝。');
        if (isAcceptanceReservation(candidate.reviewNote)) {
          desktopError(409, 'ASSET_CANDIDATE_CONFLICT', '候选正在提交接受决定，请稍后读取最新状态。');
        }
        if (await this.linkedRevision(candidate)) {
          desktopError(409, 'ASSET_CANDIDATE_CONFLICT', '历史版本曾关联此候选资产，但没有可验证的人工接受凭据；已保持待重核，不能直接标记为已拒绝。');
        }
        if (candidate.status !== 'rejected') candidate = await this.jobs.replaceCandidate({...candidate, status: 'rejected',
          reviewNote: note, acceptedRevisionId: null, updatedAt: new Date().toISOString()}, candidate.version);
        const synced = await this.syncTaskDecision(task, {status: 'rejected', phase: '候选已拒绝', linkedRevisionId: null,
          message: '候选图片和生成溯源已保留，但没有修改小说版本或资产关联。'});
        return publicTask(synced, candidate);
      }
      if (candidate.status === 'rejected') desktopError(409, 'ASSET_CANDIDATE_ALREADY_REJECTED', '候选已经拒绝，不能再接受；可重新生成新候选。');
      if (candidate.status === 'accepted') {
        const synced = await this.syncTaskDecision(task, {status: 'accepted', phase: '候选已接受并关联',
          linkedRevisionId: candidate.acceptedRevisionId, message: '候选已按人工决定关联到小说版本。'});
        return publicTask(synced, candidate);
      }
      const persistedReservation = this.matchingReservation(candidate, expectedRevisionId, note);

      const source = await this.novels.getChapterSource(task.chapterId);
      const chapter = source?.chapters.find(value => value.id === task.chapterId);
      const latest = chapter?.latestRevisionId ? await this.novels.getRevision(chapter.latestRevisionId) : null;
      if (!latest) desktopError(404, 'NOVEL_REVISION_NOT_FOUND', '当前章节版本不存在。');
      const currentItem = latest.content.items.find(item => item.id === task.itemId);
      if (!isDeepStrictEqual(currentItem, task.item)) {
        if (persistedReservation) {
          desktopError(409, 'NOVEL_REVISION_CONFLICT', '候选的接受决定已持久化，但小说条目事实已变化；未覆盖或回滚原决定。');
        }
        if (candidate.status !== 'needsReview' || isAcceptanceReservation(candidate.reviewNote)) candidate = await this.jobs.replaceCandidate({...candidate, status: 'needsReview',
          reviewNote: note || '小说条目事实已变化，候选未自动关联。', acceptedRevisionId: null,
          updatedAt: new Date().toISOString()}, candidate.version);
        const synced = await this.syncTaskDecision(task, {status: 'needsReview', phase: '事实已变化 · 待重核', linkedRevisionId: null,
          message: '小说条目事实已变化，候选和资产已保留，未覆盖最新版本。请重新核对或生成新候选。'});
        return publicTask(synced, candidate);
      }
      if (latest.id !== expectedRevisionId) {
        desktopError(409, 'NOVEL_REVISION_CONFLICT', '章节版本已变化，请刷新后再确认；未修改资产关联。');
      }
      const binding = latest.content.assetBindings?.find(value => value.itemId === task.itemId);
      if (binding && binding.status !== 'missing' && !(binding.status === 'linked' && binding.asset?.id === candidate.assetId)) {
        if (persistedReservation) {
          desktopError(409, 'NOVEL_REVISION_CONFLICT', '候选的接受决定已持久化，但条目资产关联已变化；未覆盖或回滚原决定。');
        }
        if (candidate.status !== 'needsReview' || isAcceptanceReservation(candidate.reviewNote)) candidate = await this.jobs.replaceCandidate({...candidate, status: 'needsReview',
          reviewNote: note || '条目已有其他资产或待重核引用，候选未覆盖。', acceptedRevisionId: null,
          updatedAt: new Date().toISOString()}, candidate.version);
        const synced = await this.syncTaskDecision(task, {status: 'needsReview', phase: '关联已变化 · 待重核', linkedRevisionId: null,
          message: '当前条目已有其他资产或待重核引用，候选未覆盖现有结果。'});
        return publicTask(synced, candidate);
      }

      candidate = await this.reserveAcceptance(candidate, expectedRevisionId, note);
      if (candidate.status === 'accepted') {
        const synced = await this.syncTaskDecision(task, {status: 'accepted', phase: '候选已接受并关联',
          linkedRevisionId: candidate.acceptedRevisionId, message: '候选已按人工决定关联到小说版本。'});
        return publicTask(synced, candidate);
      }
      let acceptedRevisionId = latest.id;
      try {
        if (!(binding?.status === 'linked' && binding.asset?.id === candidate.assetId)) {
          try {
            const saved = await this.novelService.bindAssets(latest.id, {expectedRevisionId: latest.id, bindings: [{itemId: task.itemId,
              status: 'linked', assetId: candidate.assetId,
              note: `人工接受生成候选（任务 ${task.id}，模型 ${Array.from(task.model ?? '未记录').slice(0, 200).join('')}）。未在原文中确认的外观仍属于视觉设计。${note ? ` 审核备注：${note}` : ''}`}]},
            {candidateId: candidate.id});
            acceptedRevisionId = saved.id;
          } catch (error) {
            if (!(error instanceof NovelError) || error.status !== 409) throw error;
            const refreshedSource = await this.novels.getChapterSource(task.chapterId);
            const refreshedId = refreshedSource?.chapters.find(value => value.id === task.chapterId)?.latestRevisionId;
            const refreshed = refreshedId ? await this.novels.getRevision(refreshedId) : null;
            const refreshedItem = refreshed?.content.items.find(item => item.id === task.itemId);
            const refreshedBinding = refreshed?.content.assetBindings?.find(value => value.itemId === task.itemId);
            if (!refreshed || !isDeepStrictEqual(refreshedItem, task.item)
              || refreshedBinding?.status !== 'linked' || refreshedBinding.asset?.id !== candidate.assetId) {
              desktopError(409, 'NOVEL_REVISION_CONFLICT', '接受时章节版本发生变化，候选已保留且未覆盖新内容。');
            }
            acceptedRevisionId = refreshed.id;
          }
        }
        try {
          candidate = await this.jobs.replaceCandidate({...candidate, status: 'accepted', reviewNote: note,
            acceptedRevisionId, updatedAt: new Date().toISOString()}, candidate.version);
        } catch {
          candidate = await this.recoverAcceptedCandidate(candidate);
          if (candidate.status !== 'accepted') desktopError(503, 'DESKTOP_PERSISTENCE_UNAVAILABLE', '接受决定已安全保留，状态待恢复。');
          acceptedRevisionId = candidate.acceptedRevisionId!;
        }
      } catch (error) {
        const recovered = await this.recoverAcceptedCandidate(candidate);
        if (recovered.status === 'accepted') {
          candidate = recovered;
          acceptedRevisionId = recovered.acceptedRevisionId!;
        } else throw error;
      }
      const synced = await this.syncTaskDecision(task, {status: 'accepted', phase: '候选已接受并关联', linkedRevisionId: acceptedRevisionId,
        message: '已按人工决定将候选关联到最新章节版本；小说事实和原文依据未改写。'});
      return publicTask(synced, candidate);
    } finally {
      this.decisions.delete(taskId);
    }
  }

  private async syncTaskDecision(initial: StoredDesktopTask, patch: Partial<StoredDesktopTask>) {
    try {
      let task = await this.jobs.get(initial.id) ?? initial;
      const same = Object.entries(patch).every(([key, value]) => isDeepStrictEqual(task[key as keyof StoredDesktopTask], value));
      if (same) return task;
      try { return await this.change(task, patch); }
      catch {
        task = await this.jobs.get(initial.id) ?? task;
        return task;
      }
    } catch { return initial; }
  }
}
