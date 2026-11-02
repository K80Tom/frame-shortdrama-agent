import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config';
import { ModelClient } from '../models/client';
import { assertModelSelection, configForRole } from '../models/connections';
import { ModelError } from '@lyra/shared';
import {
  NovelError, buildNovelSource, getChapter, createReviewSeed, applyNovelCorrections,
  validateNovelContent, novelChapterTooLong, novelCheckpointGate, novelResumeRefusal, countNovelParagraphs,
  type NovelRevision, type NovelContent,
} from '@lyra/shared';
import { NovelExtractor } from './extractor';
import type { NovelRepository } from './repository';
import type { AssetService } from '../assets/service';
import { applyNovelAssetBindings } from './assets';
import { NovelReviewWorkflow } from './workflow';
import { buildEntityRegistry } from '@lyra/shared';
import { buildNovelScreenplay } from '@lyra/agent';
import type { BreakdownRepository } from '../breakdown/repository';

export interface NovelAssetLinkAuthorization { candidateId: string }
export interface NovelAssetLinkPolicy {
  assertCanLink(assetIds: readonly string[], authorization?: NovelAssetLinkAuthorization): Promise<void>;
}

function request(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) {
    throw new NovelError(400, 'NOVEL_REQUEST_INVALID', '小说请求字段不符合约定。');
  }
  return value as Record<string, unknown>;
}
function expected(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new NovelError(400, 'NOVEL_REQUEST_INVALID', '请提供当前章节版本。');
  }
  return value;
}
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;

export class NovelService {
  constructor(private readonly repository: NovelRepository, private readonly config: AppConfig,
    private readonly transport: typeof fetch = fetch, private readonly assets?: AssetService,
    private readonly assetLinkPolicy?: NovelAssetLinkPolicy,
    private readonly adaptations?: Pick<BreakdownRepository, 'saveNovelAdaptation'>) {}
  list() { return this.repository.listSources(); }
  async create(value: unknown) {
    const input = request(value, ['title', 'rawText', 'sourceUrl']);
    if (typeof input.title !== 'string' || typeof input.rawText !== 'string'
      || (input.sourceUrl !== undefined && typeof input.sourceUrl !== 'string')) {
      throw new NovelError(400, 'NOVEL_REQUEST_INVALID', '请填写小说标题、正文与有效的来源链接。');
    }
    const source = buildNovelSource({ title: input.title, rawText: input.rawText,
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl as string } : {}) });
    return this.repository.createSource(source);
  }
  async get(sourceId: string) {
    const source = await this.repository.getSource(sourceId);
    if (!source) throw new NovelError(404, 'NOVEL_NOT_FOUND', '小说原文不存在。');
    return source;
  }
  private async screenplayDraft(sourceId: string, chapters: unknown) {
    if (!Array.isArray(chapters) || !chapters.length || chapters.length > 2000) {
      throw new NovelError(400, 'NOVEL_ADAPTATION_SELECTION_INVALID', '请选择已拆解的连续章节。');
    }
    const source = await this.get(sourceId);
    const selectedChapters = [];
    let previousOrder = 0;
    for (const raw of chapters) {
      const ref = request(raw, ['chapterId', 'revisionId']);
      const chapterId = expected(ref.chapterId);
      const revisionId = expected(ref.revisionId);
      if (!chapterId || !revisionId) throw new NovelError(400, 'NOVEL_ADAPTATION_REVISION_REQUIRED', '每章都需要一个已保存的拆解版本。');
      const chapter = getChapter(source, chapterId);
      if (previousOrder && chapter.order !== previousOrder + 1) {
        throw new NovelError(400, 'NOVEL_ADAPTATION_SELECTION_INVALID', '章节须按原书顺序连续且不重复。');
      }
      if (revisionId !== chapter.latestRevisionId) throw new NovelError(409, 'NOVEL_REVISION_CONFLICT', '章节版本有更新，请刷新后重新预览。');
      selectedChapters.push({ chapter, revisionId });
      previousOrder = chapter.order;
    }
    const revisions = await this.repository.getSourceRevisions(source, selectedChapters.map(item => item.revisionId));
    return buildNovelScreenplay(source, selectedChapters.map(({ chapter, revisionId }) => {
      const revision = revisions.get(revisionId);
      if (revision?.chapterId !== chapter.id) throw new NovelError(409, 'NOVEL_REVISION_CONFLICT', '缺少本章对应的拆解版本。');
      return { chapter, revision };
    }));
  }
  previewAdaptation(sourceId: string, value: unknown) {
    return this.screenplayDraft(sourceId, request(value, ['chapters']).chapters);
  }
  async adoptAdaptation(sourceId: string, value: unknown) {
    if (!this.adaptations) throw new NovelError(503, 'ADAPTATION_STORAGE_UNAVAILABLE', '剧本项目存储尚未就绪。');
    const input = request(value, ['chapters', 'digest']);
    const draft = await this.screenplayDraft(sourceId, input.chapters);
    if (input.digest !== draft.digest) throw new NovelError(409, 'NOVEL_ADAPTATION_PREVIEW_CHANGED', '草稿已变化，请重新预览后采用。');
    return this.adaptations.saveNovelAdaptation(draft);
  }
  private async chapter(chapterId: string) {
    const source = await this.repository.getChapterSource(chapterId);
    if (!source) throw new NovelError(404, 'NOVEL_CHAPTER_NOT_FOUND', '章节不存在。');
    return { source, chapter: getChapter(source, chapterId) };
  }
  async revisions(chapterId: string) {
    await this.chapter(chapterId);
    return this.repository.listRevisions(chapterId);
  }
  async attempts(chapterId: string) {
    await this.chapter(chapterId);
    return this.repository.listAttempts(chapterId);
  }
  async registry(sourceId: string) {
    const source = await this.get(sourceId);
    const revisions = await this.latestRevisions(source);
    return { entries: buildEntityRegistry(source, revisions), revisionIds: revisions.map(r => r.id) };
  }
  private async latestRevisions(source: Awaited<ReturnType<NovelService['get']>>, beforeOrder = Infinity) {
    const revisions = await Promise.all(source.chapters.filter(c => c.order < beforeOrder && c.latestRevisionId)
      .map(c => this.repository.getRevision(c.latestRevisionId!)));
    return revisions.filter((r): r is NovelRevision => r !== null);
  }
  private async save(chapterId: string, parentRevisionId: string | null,
    createdBy: NovelRevision['createdBy'], content: NovelContent) {
    const { source, chapter } = await this.chapter(chapterId);
    validateNovelContent(content, source, chapter);
    const revision: NovelRevision = { id: id('novelrev'), chapterId, parentRevisionId,
      createdBy, createdAt: new Date().toISOString(), content };
    return this.repository.saveRevision(revision, parentRevisionId);
  }
  async seed(chapterId: string, value: unknown) {
    const input = request(value, ['expectedRevisionId']);
    const base = expected(input.expectedRevisionId);
    const { source, chapter } = await this.chapter(chapterId);
    if (base !== null || chapter.latestRevisionId !== null) {
      throw new NovelError(409, 'NOVEL_REVISION_CONFLICT', '本章已有版本，请在现有版本上校对。');
    }
    return this.save(chapterId, null, 'program', createReviewSeed(source, chapter));
  }
  async correct(revisionId: string, value: unknown) {
    const input = request(value, ['expectedRevisionId', 'items']);
    if (expected(input.expectedRevisionId) !== revisionId) {
      throw new NovelError(409, 'NOVEL_REVISION_CONFLICT', '保存基准与当前版本不一致，请刷新核对。');
    }
    const revision = await this.repository.getRevision(revisionId);
    if (!revision) throw new NovelError(404, 'NOVEL_REVISION_NOT_FOUND', '校对版本不存在。');
    const { source, chapter } = await this.chapter(revision.chapterId);
    const content = applyNovelCorrections(revision, source, chapter,
      input as unknown as Parameters<typeof applyNovelCorrections>[3]);
    return this.save(chapter.id, revisionId, 'user', content);
  }
  async bindAssets(revisionId: string, value: unknown, authorization?: NovelAssetLinkAuthorization) {
    if (!this.assets) throw new NovelError(503, 'ASSET_PERSISTENCE_UNAVAILABLE',
      '资产目录未就绪，请显式应用 009 迁移并重启后端；原有校对仍可保存。');
    const revision = await this.repository.getRevision(revisionId);
    if (!revision) throw new NovelError(404, 'NOVEL_REVISION_NOT_FOUND', '校对版本不存在。');
    const { chapter } = await this.chapter(revision.chapterId);
    if (chapter.latestRevisionId !== revisionId) {
      throw new NovelError(409, 'NOVEL_REVISION_CONFLICT', '仅可关联当前章节最新版本，请刷新后核对；未覆盖已有引用。');
    }
    // Resolve only immutable records from our local catalogue, never caller-supplied snapshots.
    // The repository checks the same chapter pointer under its write lock again.
    const content = applyNovelAssetBindings(revision, value, await this.assets.list());
    if (this.assetLinkPolicy) {
      const previous = new Map((revision.content.assetBindings ?? []).map(binding => [binding.itemId, binding]));
      const newlyLinked = (content.assetBindings ?? []).filter(binding => binding.status === 'linked' && binding.asset
        && (previous.get(binding.itemId)?.status !== 'linked'
          || previous.get(binding.itemId)?.asset?.id !== binding.asset.id));
      await this.assetLinkPolicy.assertCanLink(newlyLinked.map(binding => binding.asset!.id), authorization);
    }
    return this.save(chapter.id, revisionId, 'user', content);
  }
  async extract(chapterId: string, value: unknown) {
    const input = request(value, ['expectedRevisionId', 'allowPaid', 'mode', 'resumeRevisionId', 'confirmRestart', 'expectedModelConnectionRevision']);
    if (input.mode !== undefined && !['single', 'reviewed'].includes(input.mode as string)) {
      throw new NovelError(400, 'NOVEL_REQUEST_INVALID', '未知拆解模式。');
    }
    if (input.confirmRestart !== undefined && input.confirmRestart !== true) {
      throw new NovelError(400, 'NOVEL_REQUEST_INVALID', '重新提取需要明确确认。');
    }
    if (input.confirmRestart === true && input.resumeRevisionId !== undefined) {
      throw new NovelError(400, 'NOVEL_REQUEST_INVALID', '不能同时继续检查点并重新提取。');
    }
    const base = expected(input.expectedRevisionId);
    if (input.allowPaid !== true) throw new NovelError(400, 'PAID_CONFIRMATION_REQUIRED', '请明确确认本章所选拆解模式可能消耗模型额度。');
    const config = configForRole(this.config, 'breakdown');
    assertModelSelection(config, input.expectedModelConnectionRevision);
    new ModelClient(config, this.transport).assertConfigured();
    const { source, chapter } = await this.chapter(chapterId);
    if (novelChapterTooLong(chapter)) {
      throw new NovelError(400, 'NOVEL_CHAPTER_TOO_LONG', '本次单章超过 20000 码点限制，请先整理章节；未调用模型。');
    }
    if ((await this.repository.listAttempts(chapterId)).some(attempt => attempt.status === 'submitted' || attempt.status === 'unknown')) {
      throw new NovelError(409, 'NOVEL_ATTEMPT_PENDING', '本章已有未结束或结果未知的模型请求，请先核对，不能重复调用。');
    }
    const revisions = await this.repository.listRevisions(chapterId);
    const paragraphCount = countNovelParagraphs(source, chapter);
    const gate = novelCheckpointGate(revisions, chapter.latestRevisionId, paragraphCount);
    const resume = input.resumeRevisionId === undefined ? null : await this.repository.getRevision(expected(input.resumeRevisionId)!);
    if (input.resumeRevisionId !== undefined) {
      const refusal = input.mode !== 'reviewed' || !resume || resume.chapterId !== chapterId
        ? '只能继续本章最近的完整模型检查点，已完成阶段不会重做；未调用模型。'
        : novelResumeRefusal(revisions, chapter.latestRevisionId, resume.id, paragraphCount);
      if (refusal) throw new NovelError(400, 'NOVEL_RESUME_INVALID', refusal);
    } else if (gate.resumeRevisionId && input.confirmRestart !== true) {
      throw new NovelError(409, 'NOVEL_CHECKPOINT_RESUME_REQUIRED', '本章已有未完成的模型检查点。继续检查点不会重做已完成阶段；若要放弃检查点并重新付费提取，请明确确认。未调用模型。');
    }
    let resumeContext: NovelRevision[] = [];
    if (resume?.content.analysis) {
      resumeContext = (await Promise.all(resume.content.analysis.contextRevisionIds.map(revisionId => this.repository.getRevision(revisionId)))).filter((revision): revision is NovelRevision => revision !== null);
      if (resumeContext.some(revision => !source.chapters.some(item => item.id === revision.chapterId && item.order < chapter.order))) {
        throw new NovelError(400, 'NOVEL_RESUME_INVALID', '检查点上下文不属于本书前章。');
      }
      if (resumeContext.length !== resume.content.analysis.contextRevisionIds.length) throw new NovelError(400, 'NOVEL_RESUME_INVALID', '检查点上下文版本缺失。');
    }
    const attemptId = id('novelcall');
    await this.repository.beginAttempt({ id: attemptId, chapterId, expectedRevisionId: base,
      model: config.defaultModel, startedAt: new Date().toISOString() });
    let usage: unknown = null;
    let saved: NovelRevision | null = null;
    try {
      let parent = base;
      const context = resume
        ? resumeContext
        : input.mode === 'reviewed' ? await this.latestRevisions(source, chapter.order) : [];
      const result = input.mode === 'reviewed'
        ? await new NovelReviewWorkflow(config, this.transport).extract(source, chapter, buildEntityRegistry(source, context), context.map(r => r.id), async content => {
          saved = await this.save(chapterId, parent, 'model', content);
          parent = saved.id;
        }, async () => {
          const current = await this.chapter(chapterId);
          if (current.chapter.latestRevisionId !== parent) throw new NovelError(409, 'NOVEL_REVISION_CONFLICT',
            '本章已被另一个页面修改，后续模型阶段未提交；请读取保存版本。');
        }, resume?.content) : await new NovelExtractor(config, this.transport).extract(source, chapter);
      usage = result.usage;
      if (!saved) saved = await this.save(chapterId, base, 'model', result.content);
      await this.repository.finishAttempt(attemptId, { status: 'succeeded', errorCode: null,
        usage, endedAt: new Date().toISOString(), revisionId: saved.id });
      return saved;
    } catch (error) {
      if (usage === null && (error instanceof NovelError || error instanceof ModelError) && error.details.usage) usage = error.details.usage;
      const code = error instanceof NovelError || error instanceof ModelError ? error.code : 'NOVEL_EXTRACTION_FAILED';
      const unknown = ['PROXY_UNAVAILABLE', 'UPSTREAM_TIMEOUT'].includes(code);
      // If bookkeeping itself fails, the submitted marker remains and blocks paid resubmission.
      await this.repository.finishAttempt(attemptId, { status: unknown ? 'unknown' : 'failed',
        errorCode: code, usage, endedAt: new Date().toISOString(), revisionId: saved?.id ?? null }).catch(() => undefined);
      if (error instanceof NovelError || error instanceof ModelError) throw error;
      throw new NovelError(502, 'NOVEL_EXTRACTION_FAILED', '本章拆解未完成；未自动重试，已有原文和版本保持不变。');
    }
  }
}
