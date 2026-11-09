import { randomBytes } from 'node:crypto';
import {
  CANVAS_LIMITS, CanvasError, canvasError, compareCanvasGraphs, parseCanvasCommandBatch,
  reduceCanvasCommands, validateCanvasGraph, type CanvasBaseline, type CanvasCommandReceipt,
  type CanvasDocument, type CanvasGraph, type CanvasNodeRuntime, type CanvasProductionRunRef,
  type CanvasQuote, type CanvasRevision, type CanvasRuntimeView, type CanvasValidationResult,
  type CanvasResourceRef,
} from '@lyra/shared';
import type {
  PostgresCanvasQuoteStore, PostgresCanvasRunStore, PostgresCanvasStore, StoredCanvasQuote,
  StoredCanvasRun,
} from './repository';
import {
  boundedText, digestGraph, emptyBaseline, initializeGraphFromStoryboard, requireGraph, runtimeStateOf,
  type CanvasSeed,
} from './graph';

export interface CanvasActor {
  workspaceId: string;
  userId: string;
  role: string;
  requestId: string;
}

/** 只读引用核验：返回 true 存在 / false 不存在 / undefined 未能核验。 */
export type CanvasReferenceResolver = (ref: CanvasResourceRef) => Promise<boolean | undefined> | boolean | undefined;

export interface CanvasStoryboardPort {
  /** 从已采用的正式分镜读取初始化数据；无已采用分镜返回 null。 */
  loadAdopted(projectId: string, workspaceId: string): Promise<CanvasSeed | null>;
}

export interface CanvasProductionRunView {
  id: string;
  status: string;
  updatedAt?: string;
  shotMatrix?: Array<{ shotId: string; completed: boolean; stages: Record<string, string | null> }>;
  queue?: { pending: number; ready: number; running: number; waitingHuman: number; failed: number };
  stages?: Array<{ key: string; state: string; completed: number; total: number }>;
  artifacts?: Array<{ id: string; kind: string; title: string; uri: string; shotId?: string | null }>;
  delivery?: { id: string; status: string; title: string; uri: string | null } | null;
  /** 按镜头计算的 Worker 队列位置（1-based），仅对本轮尚未开始执行的镜头给出。 */
  queuePositions?: Record<string, number>;
}

export interface CanvasProductionPort {
  createRun(input: {
    projectId: string; scriptVersionId: string; budgetMicros: number; clientRequestId: string; currency: string;
  }): Promise<{ id: string }>;
  getRun(runId: string): Promise<CanvasProductionRunView | null>;
}

/**
 * 领域命令端口。画布只能提出 selectCandidate / requestDomainEdit，
 * 真正的新版本由领域 Service 创建后再把新引用写回画布。
 */
export interface CanvasDomainPort {
  selectCandidate?(input: { projectId: string; shotId: string; candidateId: string }): Promise<{
    resourceId: string; versionId: string | null; digest: string | null;
  }>;
  applyShotEdit?(input: {
    projectId: string; shotId: string; field: string; value: string | number;
  }): Promise<{ resourceId: string; versionId: string | null; digest: string | null }>;
}

export interface CanvasPorts {
  storyboard?: CanvasStoryboardPort;
  production?: CanvasProductionPort;
  domain?: CanvasDomainPort;
  resolveReference?: CanvasReferenceResolver;
}

/** 冻结的本地价格表。供应商实时价格接入后应替换为正式价格 revision。 */
const CANVAS_PRICE_REVISION = 'canvas-price/2026-11';
const SHOT_BASE_MICROS = 8_000_000;
const SHOT_SECOND_MICROS = 260_000;
const CANDIDATE_EXTRA_MICROS = 4_000_000;
const QUOTE_TTL_MS = 30 * 60 * 1000;

/** 仅用于画布展示的阶段文案；顺序与 productionStageOrder 保持一致。 */
const STAGE_LABELS: Record<string, string> = {
  prepare: '准备', breakdown: '拆解', assets: '资产', storyboard: '分镜', director: '导演',
  video: '渲染', candidates: '候选', review: '复核', compose: '合成', deliver: '交付',
};

function id(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function requireProjectId(value: unknown): string {
  const text = boundedText(value, 128);
  if (!/^[a-z][a-z0-9_-]{2,127}$/u.test(text)) {
    throw canvasError('canvas_command_invalid', 'projectId 不合法。');
  }
  return text;
}

function requireRevision(documentId: string): string {
  if (!/^[a-z][a-z0-9_-]{2,127}$/u.test(documentId)) {
    throw canvasError('canvas_not_found', '画布标识不合法。');
  }
  return documentId;
}

function requireOwner(actor: CanvasActor, message: string): void {
  if (actor.role !== 'owner' && actor.role !== 'admin') {
    throw canvasError('canvas_permission_denied', message);
  }
}

function cloneBaseline(baseline: CanvasBaseline): CanvasBaseline {
  return { ...baseline };
}

export class CanvasService {
  constructor(
    private readonly store: PostgresCanvasStore,
    private readonly quotes: PostgresCanvasQuoteStore,
    private readonly runs: PostgresCanvasRunStore,
    private readonly ports: CanvasPorts = {},
  ) {}

  list(projectId: string, actor: CanvasActor): Promise<CanvasDocument[]> {
    return this.store.listDocuments(requireProjectId(projectId));
  }

  async get(documentId: string, actor: CanvasActor): Promise<{
    document: CanvasDocument; latest: CanvasRevision | null; revisions: CanvasRevision[];
  }> {
    const document = await this.store.getDocument(requireRevision(documentId));
    if (!document) throw canvasError('canvas_not_found', '画布不存在或已归档。');
    const [latest, revisions] = await Promise.all([
      this.store.latestRevision(document.id),
      this.store.listRevisions(document.id, 20),
    ]);
    return { document, latest, revisions };
  }

  async create(projectId: string, value: unknown, actor: CanvasActor): Promise<CanvasDocument> {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const title = boundedText(input.title, CANVAS_LIMITS.titleChars) || '主生产画布';
    const source = input.from === 'empty' ? 'empty' : 'storyboard';
    let graph: CanvasGraph;
    let baseline: CanvasBaseline = emptyBaseline();
    if (source === 'storyboard') {
      if (!this.ports.storyboard) {
        throw canvasError('canvas_persistence_unavailable', '分镜读取服务尚未就绪，暂时不能从正式分镜创建画布。');
      }
      const seed = await this.ports.storyboard.loadAdopted(requireProjectId(projectId), actor.workspaceId);
      if (!seed) {
        throw canvasError('canvas_validation_failed', '当前项目还没有已采用的分镜版本，请先完成分镜设计并采用。');
      }
      const initialized = initializeGraphFromStoryboard(seed);
      graph = initialized.graph;
      baseline = initialized.baseline;
    } else {
      graph = { schemaVersion: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    }
    const digests = digestGraph(graph);
    return this.store.createDocument({
      id: id('canvas'), workspaceId: actor.workspaceId, projectId: requireProjectId(projectId),
      title, createdBy: actor.userId, graph, baseline, digests,
    });
  }

  async revision(documentId: string, revisionId: string, actor: CanvasActor): Promise<CanvasRevision> {
    const revision = await this.store.getRevisionById(requireRevision(documentId), revisionId);
    if (!revision) throw canvasError('canvas_revision_not_found', '画布版本不存在。');
    return revision;
  }

  /**
   * 从已有版本创建新草稿（历史版本复制），不覆盖已采用或已交付版本。
   */
  async forkRevision(documentId: string, value: unknown, actor: CanvasActor): Promise<CanvasRevision> {
    const document = await this.store.getDocument(requireRevision(documentId));
    if (!document) throw canvasError('canvas_not_found', '画布不存在。');
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const sourceRevisionId = typeof input.sourceRevisionId === 'string' ? input.sourceRevisionId : null;
    const source = sourceRevisionId
      ? await this.store.getRevisionById(document.id, sourceRevisionId)
      : await this.store.latestRevision(document.id);
    if (!source) throw canvasError('canvas_revision_not_found', '要复制的画布版本不存在。');
    const latest = await this.store.latestRevision(document.id);
    const expectedRevision = Number(input.expectedRevision ?? latest?.revision ?? source.revision);
    if (latest && latest.revision !== expectedRevision) {
      throw canvasError('canvas_revision_conflict', '画布已被其他操作更新，请重新读取后再创建草稿。', {
        expectedRevision, currentRevision: latest.revision,
      });
    }
    const graph = requireGraph(source.graph, actor.workspaceId, document.projectId);
    const digests = digestGraph(graph);
    return this.store.createRevision({
      id: id('canvasrev'), documentId: document.id, expectedRevision: latest?.revision ?? 0,
      baseRevisionId: source.id, createdBy: actor.userId, graph,
      baseline: cloneBaseline(source.baseline), digests,
    });
  }

  /**
   * 应用一批画布命令：纯布局/结构变更直接生成新 Revision；
   * 领域命令只记录 intent，未接入领域 Service 时明确拒绝，不伪造采用。
   */
  async commands(documentId: string, value: unknown, actor: CanvasActor): Promise<{
    revision: CanvasRevision; receipt: CanvasCommandReceipt; replay: boolean;
  }> {
    const document = await this.store.getDocument(requireRevision(documentId));
    if (!document) throw canvasError('canvas_not_found', '画布不存在。');
    const batch = parseCanvasCommandBatch(value);
    const replay = await this.store.findCommand(document.id, batch.clientRequestId);
    if (replay) {
      const latest = await this.store.getRevision(document.id, replay.revision);
      if (latest) return { revision: latest, receipt: replay, replay: true };
    }
    const latest = await this.store.latestRevision(document.id);
    if (!latest) throw canvasError('canvas_revision_not_found', '画布还没有可编辑的版本。');
    if (latest.revision !== batch.expectedRevision) {
      throw canvasError('canvas_revision_conflict', '画布已被其他操作更新，请重新读取后再提交。', {
        expectedRevision: batch.expectedRevision, currentRevision: latest.revision,
      });
    }
    const base = requireGraph(latest.graph, actor.workspaceId, document.projectId);
    const reduced = reduceCanvasCommands(base, batch.commands);
    for (const intent of reduced.domainIntents) {
      if (intent.kind === 'selectCandidate') {
        if (!this.ports.domain?.selectCandidate) {
          throw canvasError('canvas_domain_command_unavailable',
            '候选采用需要资产/生产领域服务接入；当前只允许查看，不会在画布 JSON 中伪造采用结果。');
        }
        const payload = intent.payload as { nodeId: string; candidateId: string };
        const node = reduced.graph.nodes.find(item => item.id === payload.nodeId);
        const shotId = node?.resource?.resourceId;
        if (!node || !shotId) throw canvasError('canvas_command_invalid', '候选节点缺少正式镜头引用。');
        const applied = await this.ports.domain.selectCandidate({
          projectId: document.projectId, shotId, candidateId: payload.candidateId,
        });
        node.resource = node.resource ? { ...node.resource, resourceId: applied.resourceId,
          versionId: applied.versionId, digest: applied.digest } : null;
        node.metadata = { ...node.metadata, selectedCandidateId: payload.candidateId };
      } else {
        if (!this.ports.domain?.applyShotEdit) {
          throw canvasError('canvas_domain_command_unavailable',
            '镜头字段编辑需要分镜领域服务接入；请先到分镜工作台创建新版本，再更新画布引用。');
        }
        const payload = intent.payload as {
          nodeId: string; edit: { shotId: string; field: string; value: string | number };
        };
        const node = reduced.graph.nodes.find(item => item.id === payload.nodeId);
        if (!node) throw canvasError('canvas_command_invalid', '要编辑的节点不存在。');
        const applied = await this.ports.domain.applyShotEdit({
          projectId: document.projectId, shotId: payload.edit.shotId,
          field: payload.edit.field, value: payload.edit.value,
        });
        node.resource = node.resource ? { ...node.resource, resourceId: applied.resourceId,
          versionId: applied.versionId, digest: applied.digest } : null;
      }
    }

    const validation = await validateCanvasGraph(reduced.graph, {
      workspaceId: actor.workspaceId, projectId: document.projectId,
      ...(this.ports.resolveReference ? { resolveReference: this.ports.resolveReference } : {}),
    });
    if (!validation.valid) {
      throw canvasError('canvas_validation_failed', '画布校验未通过，未写入任何新版本。', {
        issues: validation.errors,
      });
    }
    const digests = digestGraph(reduced.graph);
    const revision = await this.store.createRevision({
      id: id('canvasrev'), documentId: document.id, expectedRevision: batch.expectedRevision,
      baseRevisionId: latest.id, createdBy: actor.userId, graph: reduced.graph,
      baseline: cloneBaseline(latest.baseline), digests,
    });
    const receipt: CanvasCommandReceipt = {
      clientRequestId: batch.clientRequestId,
      revision: revision.revision,
      appliedCommandIds: batch.commands.map(command => command.commandId),
      changes: reduced.changes,
      inverse: reduced.inverse,
      semanticGraphDigest: digests.semanticGraphDigest,
      layoutDigest: digests.layoutDigest,
      contentDigest: digests.contentDigest,
    };
    const recorded = await this.store.recordCommand({
      id: id('canvascommand'), documentId: document.id, revisionId: revision.id,
      clientRequestId: batch.clientRequestId, actor: actor.userId,
      expectedRevision: batch.expectedRevision, batch, receipt,
    });
    if (recorded.replay) {
      // 并发重复提交：以先落库的回执为准，新 Revision 不覆盖它。
      return { revision, receipt: recorded.receipt, replay: true };
    }
    return { revision, receipt: recorded.receipt, replay: false };
  }

  async validate(documentId: string, revisionIdOrNumber: string, actor: CanvasActor): Promise<
    CanvasValidationResult & { revision: number }
  > {
    const document = await this.store.getDocument(requireRevision(documentId));
    if (!document) throw canvasError('canvas_not_found', '画布不存在。');
    const revision = /^\d+$/u.test(revisionIdOrNumber)
      ? await this.store.getRevision(document.id, Number(revisionIdOrNumber))
      : await this.store.getRevisionById(document.id, revisionIdOrNumber);
    if (!revision) throw canvasError('canvas_revision_not_found', '画布版本不存在。');
    const graph = requireGraph(revision.graph, actor.workspaceId, document.projectId);
    const result = await validateCanvasGraph(graph, {
      workspaceId: actor.workspaceId, projectId: document.projectId,
      ...(this.ports.resolveReference ? { resolveReference: this.ports.resolveReference } : {}),
    });
    return { ...result, revision: revision.revision };
  }

  async compare(documentId: string, fromRevision: string, toRevision: string, actor: CanvasActor) {
    const document = await this.store.getDocument(requireRevision(documentId));
    if (!document) throw canvasError('canvas_not_found', '画布不存在。');
    const from = await this.store.getRevision(document.id, Number(fromRevision));
    const to = await this.store.getRevision(document.id, Number(toRevision));
    if (!from || !to) throw canvasError('canvas_revision_not_found', '要比较的画布版本不存在。');
    const before = requireGraph(from.graph, actor.workspaceId, document.projectId);
    const after = requireGraph(to.graph, actor.workspaceId, document.projectId);
    return {
      from: { revision: from.revision, digest: from.semanticGraphDigest, status: from.status },
      to: { revision: to.revision, digest: to.semanticGraphDigest, status: to.status },
      diff: compareCanvasGraphs(before, after),
    };
  }

  /** 采用：必须服务端重新校验，不能信任前端传来的 “已校验”。 */
  async adopt(documentId: string, value: unknown, actor: CanvasActor): Promise<CanvasRevision> {
    requireOwner(actor, '只有 owner 或 admin 可以采用的版本需要人工批准。');
    const document = await this.store.getDocument(requireRevision(documentId));
    if (!document) throw canvasError('canvas_not_found', '画布不存在。');
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw canvasError('canvas_command_invalid', '采用时必须携带 expectedRevision。');
    }
    const revision = await this.store.getRevision(document.id, expectedRevision);
    if (!revision) throw canvasError('canvas_revision_not_found', '要采用的画布版本不存在。');
    if (revision.status === 'adopted') return revision;
    const graph = requireGraph(revision.graph, actor.workspaceId, document.projectId);
    const validation = await validateCanvasGraph(graph, {
      workspaceId: actor.workspaceId, projectId: document.projectId,
      ...(this.ports.resolveReference ? { resolveReference: this.ports.resolveReference } : {}),
    });
    if (!validation.valid) {
      throw canvasError('canvas_validation_failed', '画布仍有阻断问题，不能采用。', { issues: validation.errors });
    }
    return this.store.adopt({
      documentId: document.id, revisionId: revision.id, actor: actor.userId, expectedRevision,
    });
  }

  /**
   * 生成报价：冻结当前 Revision 的 semantic digest 与价格表。
   * 预算上限与系统估价分开保存，前端不得混用。
   */
  async quote(documentId: string, revisionIdOrNumber: string, value: unknown, actor: CanvasActor): Promise<CanvasQuote> {
    const document = await this.store.getDocument(requireRevision(documentId));
    if (!document) throw canvasError('canvas_not_found', '画布不存在。');
    const revision = /^\d+$/u.test(revisionIdOrNumber)
      ? await this.store.getRevision(document.id, Number(revisionIdOrNumber))
      : await this.store.getRevisionById(document.id, revisionIdOrNumber);
    if (!revision) throw canvasError('canvas_revision_not_found', '画布版本不存在。');
    if (revision.status === 'archived') throw canvasError('canvas_command_invalid', '归档版本不能直接报价。');

    const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const graph = requireGraph(revision.graph, actor.workspaceId, document.projectId);
    const shotNodes = graph.nodes.filter(node => node.resource?.resourceType === 'shotSpec');
    if (shotNodes.length === 0) {
      throw canvasError('canvas_validation_failed', '画布中没有正式镜头节点，无法生成报价。');
    }
    const seconds = shotNodes.reduce((sum, node) => sum + Number(node.metadata.durationMs ?? 0) / 1000, 0);
    const candidatePolicy = boundedText(input.candidatePolicy, 40) || 'direct';
    const candidateLimit = candidatePolicy === 'gacha' ? Math.min(4, Math.max(2, Number(input.candidateLimit) || 2)) : 1;
    const model = boundedText(input.model, 80) || 'video-default';
    const perShot = SHOT_BASE_MICROS + Math.max(0, seconds / shotNodes.length) * SHOT_SECOND_MICROS
      + (candidateLimit - 1) * CANDIDATE_EXTRA_MICROS;
    const estimate = Math.round(perShot * shotNodes.length);
    const low = Math.round(estimate * 0.82);
    const high = Math.round(estimate * 1.28);
    const budgetMicros = Number.isSafeInteger(input.budgetMicros) && (input.budgetMicros as number) >= 0
      ? input.budgetMicros as number : Math.round(high * 1.1);
    const quote = await this.quotes.create({
      id: id('canvasquote'), documentId: document.id, revisionId: revision.id,
      semanticGraphDigest: revision.semanticGraphDigest, currency: 'CNY',
      budgetMicros, estimateCostMicros: estimate, estimateRange: { lowMicros: low, highMicros: high },
      priceRevision: CANVAS_PRICE_REVISION,
      assumptions: [
        `按 ${shotNodes.length} 个正式镜头、共 ${seconds.toFixed(1)} 秒估算`,
        `候选策略 ${candidatePolicy}（每镜头 ${candidateLimit} 个候选）`,
        '本价格为离线价格表估算，不含返修与人工复核；正式提交前以生产系统冻结预算为准',
      ],
      shotCount: shotNodes.length, model, candidatePolicy,
      status: 'pending', expiresAt: iso(QUOTE_TTL_MS), createdAt: new Date().toISOString(),
    }, { workspaceId: actor.workspaceId, projectId: document.projectId, createdBy: actor.userId });
    await this.store.recordEvent({
      workspaceId: actor.workspaceId, projectId: document.projectId, documentId: document.id,
      revisionId: revision.id, type: 'canvas.quote.created',
      payload: { quoteId: quote.id, estimateMicros: estimate, budgetMicros },
    });
    return quote;
  }

  /**
   * 确认并创建正式 Run。只有 Quote 仍 pending、digest 未变、未过期且预算覆盖估价时才放行。
   */
  async createRun(documentId: string, revisionIdOrNumber: string, value: unknown, actor: CanvasActor): Promise<CanvasProductionRunRef> {
    return this.startRun(documentId, revisionIdOrNumber, value, actor, null);
  }

  /**
   * 节点驱动：分镜节点一键触发异步生成。
   * 同一 revision 已有运行时不重复创建，直接复用该运行，避免二次扣费。
   */
  async generateNode(
    documentId: string, revisionIdOrNumber: string, nodeId: string, value: unknown, actor: CanvasActor,
  ): Promise<CanvasProductionRunRef & { nodeId: string }> {
    const document = await this.store.getDocument(requireRevision(documentId));
    if (!document) throw canvasError('canvas_not_found', '画布不存在。');
    const revision = /^\d+$/u.test(revisionIdOrNumber)
      ? await this.store.getRevision(document.id, Number(revisionIdOrNumber))
      : await this.store.getRevisionById(document.id, revisionIdOrNumber);
    if (!revision) throw canvasError('canvas_revision_not_found', '画布版本不存在。');
    if (!/^[a-z][a-z0-9_-]{2,127}$/u.test(nodeId)) {
      throw canvasError('canvas_command_invalid', '节点标识不合法。');
    }
    const node = revision.graph.nodes.find(item => item.id === nodeId);
    if (!node) throw canvasError('canvas_unknown_node_type', '画布节点不存在。');
    const shotId = node.metadata?.shotId;
    if (typeof shotId !== 'string' || !shotId.trim()) {
      throw canvasError('canvas_command_invalid', '只有绑定镜头的节点可以触发异步生成。');
    }
    const existing = await this.runs.latestForRevision(document.id, revision.id);
    if (existing) {
      return {
        id: existing.id, documentId: document.id, revisionId: revision.id,
        semanticGraphDigest: existing.semanticGraphDigest, quoteId: existing.quoteId,
        createdAt: existing.createdAt, nodeId,
      };
    }
    const created = await this.startRun(document.id, revision.id, value, actor, nodeId);
    return { ...created, nodeId };
  }

  private async startRun(
    documentId: string, revisionIdOrNumber: string, value: unknown, actor: CanvasActor, nodeId: string | null,
  ): Promise<CanvasProductionRunRef> {
    requireOwner(actor, '只有 owner 或 admin 可以确认付费生产。');
    const document = await this.store.getDocument(requireRevision(documentId));
    if (!document) throw canvasError('canvas_not_found', '画布不存在。');
    const revision = /^\d+$/u.test(revisionIdOrNumber)
      ? await this.store.getRevision(document.id, Number(revisionIdOrNumber))
      : await this.store.getRevisionById(document.id, revisionIdOrNumber);
    if (!revision) throw canvasError('canvas_revision_not_found', '画布版本不存在。');
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const clientRequestId = typeof input.clientRequestId === 'string' ? input.clientRequestId : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/u.test(clientRequestId)) {
      throw canvasError('canvas_command_invalid', '创建运行需要 8–128 位 clientRequestId。');
    }
    const existing = await this.runs.getByRequest(document.id, clientRequestId);
    if (existing) {
      return {
        id: existing.id, documentId: document.id, revisionId: revision.id,
        semanticGraphDigest: existing.semanticGraphDigest, quoteId: existing.quoteId, createdAt: existing.createdAt,
      };
    }
    const quoteId = typeof input.quoteId === 'string' ? input.quoteId : '';
    if (!quoteId || !/^[a-z][a-z0-9_-]{2,127}$/u.test(quoteId)) {
      throw canvasError('canvas_command_invalid', '必须先取得报价并提交 quoteId。');
    }
    const quote = await this.quotes.get(document.id, quoteId);
    if (!quote) throw canvasError('canvas_not_found', '估价卡不存在。');
    if (quote.status !== 'pending') throw canvasError('canvas_quote_stale', '估价卡已使用或已过期，请重新报价。');
    if (new Date(quote.expiresAt).getTime() <= Date.now()) {
      throw canvasError('canvas_quote_stale', '估价卡已过期，请重新生成报价。');
    }
    if (quote.semanticGraphDigest !== revision.semanticGraphDigest) {
      throw canvasError('canvas_quote_stale', '画布内容已变化，旧报价不能继续使用。');
    }
    if (quote.budgetMicros < quote.estimateCostMicros) {
      throw canvasError('canvas_validation_failed', '预算上限低于系统估价，无法提交。');
    }
    if (!this.ports.production) {
      throw canvasError('canvas_domain_command_unavailable', '生产编排服务未就绪，暂时不能创建运行；报价保留，可在服务恢复后重试。');
    }
    const baseline = revision.baseline;
    if (!baseline.scriptVersionId) {
      throw canvasError('canvas_validation_failed', '画布缺少冻结的剧本版本，不能创建运行。');
    }
    const run = await this.ports.production.createRun({
      projectId: document.projectId, scriptVersionId: baseline.scriptVersionId,
      budgetMicros: quote.budgetMicros, clientRequestId, currency: quote.currency,
    });
    await this.quotes.confirm(document.id, quoteId);
    const stored = await this.runs.create({
      id: id('canvasrun'), documentId: document.id, revisionId: revision.id,
      workspaceId: actor.workspaceId, projectId: document.projectId,
      semanticGraphDigest: revision.semanticGraphDigest, quoteId, runId: run.id, clientRequestId,
      createdAt: new Date().toISOString(),
    });
    await this.store.recordEvent({
      workspaceId: actor.workspaceId, projectId: document.projectId, documentId: document.id,
      revisionId: revision.id, type: nodeId ? 'canvas.node.generation.requested' : 'canvas.run.created',
      payload: nodeId
        ? { quoteId, runId: run.id, nodeId, semanticGraphDigest: revision.semanticGraphDigest }
        : { quoteId, runId: run.id, semanticGraphDigest: revision.semanticGraphDigest },
    });
    return {
      id: stored.id, documentId: document.id, revisionId: revision.id,
      semanticGraphDigest: stored.semanticGraphDigest, quoteId, createdAt: stored.createdAt,
    };
  }

  /**
   * 运行覆盖：真实状态投影到节点；无对应运行时保持 unknown，绝不显示“成功”。
   */
  async runtimeView(documentId: string, revisionIdOrNumber: string, cursor: string | null, actor: CanvasActor): Promise<CanvasRuntimeView> {
    const document = await this.store.getDocument(requireRevision(documentId));
    if (!document) throw canvasError('canvas_not_found', '画布不存在。');
    const revision = /^\d+$/u.test(revisionIdOrNumber)
      ? await this.store.getRevision(document.id, Number(revisionIdOrNumber))
      : await this.store.getRevisionById(document.id, revisionIdOrNumber);
    if (!revision) throw canvasError('canvas_revision_not_found', '画布版本不存在。');
    const nodes: CanvasNodeRuntime[] = revision.graph.nodes.map(node => ({
      nodeId: node.id, state: 'unknown', message: null, sourceAggregateId: null,
      sourceRevision: null, observedAt: revision.createdAt,
    }));
    if (!this.ports.production) {
      return { revisionId: revision.id, revision: revision.revision, cursor, nodes, generatedAt: new Date().toISOString() };
    }
    const stored = await this.runs.latestForRevision(document.id, revision.id);
    if (!stored) {
      return { revisionId: revision.id, revision: revision.revision, cursor, nodes, generatedAt: new Date().toISOString() };
    }
    const run = await this.ports.production.getRun(stored.runId);
    const observedAt = new Date().toISOString();
    if (!run) return { revisionId: revision.id, revision: revision.revision, cursor, nodes, generatedAt: observedAt };
    const graphNodes = new Map(revision.graph.nodes.map(item => [item.id, item]));
    for (const node of nodes) {
      const graphNode = graphNodes.get(node.nodeId);
      const shotId = graphNode?.metadata?.shotId;
      if (typeof shotId !== 'string') continue;
      const matrix = run.shotMatrix?.find(item => item.shotId === shotId);
      if (!matrix) continue;
      const stages = Object.entries(matrix.stages) as Array<[string, string | null]>;
      const known = stages.filter(([, state]) => state !== null);
      const done = known.filter(([, state]) => state === 'succeeded' || state === 'skipped').length;
      const activeStage = stages.find(([, state]) => state === 'running' || state === 'waitingExternal' || state === 'validating')
        ?? stages.find(([, state]) => state === 'waitingHuman')
        ?? stages.find(([, state]) => state === 'failed');
      if (matrix.completed) node.state = 'succeeded';
      else if (stages.some(([, state]) => state === 'waitingHuman')) node.state = 'waitingHuman';
      else if (stages.some(([, state]) => state === 'failed')) node.state = 'failed';
      else if (stages.some(([, state]) => state === 'reconciling')) node.state = 'reconciling';
      else if (stages.some(([, state]) => state === 'running' || state === 'waitingExternal' || state === 'validating')) node.state = 'running';
      else node.state = 'pending';
      node.stage = activeStage?.[0] ?? null;
      node.progressPercent = known.length ? Math.round((done / known.length) * 100) : null;
      node.queuePosition = run.queuePositions?.[shotId] ?? null;
      node.runStatus = run.status;
      const shotArtifact = (run.artifacts ?? []).find(item => item.shotId === shotId && item.kind === 'video');
      node.artifact = shotArtifact
        ? { id: shotArtifact.id, kind: shotArtifact.kind, title: shotArtifact.title, uri: shotArtifact.uri }
        : null;
      const stageLabel = activeStage ? STAGE_LABELS[activeStage[0]] ?? activeStage[0] : null;
      node.message = matrix.completed ? '镜头已完成'
        : node.state === 'running' ? `${stageLabel ?? '生产'}进行中${node.progressPercent === null ? '' : ` ${node.progressPercent}%`}`
          : node.state === 'pending' ? (node.queuePosition ? `排队中 · 第 ${node.queuePosition} 位` : '排队中，等待 Worker 执行')
            : node.state === 'waitingHuman' ? '等待人工确认'
              : node.state === 'reconciling' ? '外部请求对账中'
                : node.state === 'failed' ? '生成失败，可重试' : null;
      node.sourceAggregateId = run.id;
      node.sourceRevision = revision.revision;
      node.observedAt = run.updatedAt ?? observedAt;
    }
    return {
      revisionId: revision.id, revision: revision.revision, cursor, nodes, generatedAt: observedAt,
      run: {
        id: run.id, status: run.status,
        queue: run.queue ?? { pending: 0, ready: 0, running: 0, waitingHuman: 0, failed: 0 },
        stages: run.stages ?? [],
        delivery: run.delivery?.uri ? { id: run.delivery.id, title: run.delivery.title, uri: run.delivery.uri } : null,
      },
    };
  }

  async events(documentId: string, actor: CanvasActor) {
    const document = await this.store.getDocument(requireRevision(documentId));
    if (!document) throw canvasError('canvas_not_found', '画布不存在。');
    return this.store.listEvents(document.id, 50);
  }
}
