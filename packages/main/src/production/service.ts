import {
  ProductionError, canonicalDigest, parseCreateProductionRun, parseProductionAction, parseProductionReview,
  parseProductionRunId, productionId, sameProductionRequest, type BudgetEntry, type CandidateSet,
  type FrozenAssetRetrievalPolicy, type FrozenMethodPack,
  type ProductionArtifact, type ProductionIssue, type ProductionReviewInput, type ProductionStage,
  type ProductionTask, type StoredProductionRun, type TaskAttempt,
} from '@lyra/shared';
import { compileProductionRun } from './blueprint';
import {
  ProductionPreflightExecutor, type ArtifactDraft, type CandidateSetDraft, type DeliveryDraft,
  type IssueDraft, type ProductionExecutionContext, type ProductionExecutor, type ProductionExecutorOutcome,
  type QualityCheckDraft, type SpawnTaskDraft, type TimelineDraft,
} from './executor';
import type { ProductionRepository } from './repository';
import { publicProductionRun } from './view';

export interface ProductionSourceCatalog {
  getProject(projectId: string): Promise<unknown>;
  getScriptVersion(projectId: string, scriptVersionId: string): Promise<unknown>;
}
export interface ProductionServiceOptions {
  now?: () => Date;
  pollIntervalMs?: number;
  executors?: ProductionExecutor[];
  sourceCatalog?: ProductionSourceCatalog;
  /** Resolved once for a new run; replay of an idempotent request keeps its original frozen policy. */
  assetRetrievalPolicy?: () => Promise<FrozenAssetRetrievalPolicy>;
  methodPacks?: (project: unknown) => Promise<FrozenMethodPack[]>;
}

const terminal = new Set(['completed', 'partial', 'failed', 'cancelled']);
const dependencyDone = (task: ProductionTask) => task.status === 'succeeded'
  || task.status === 'skipped' || task.status === 'superseded';
const issueResolutionGates = new Set([
  'CHECKPOINT_REVIEW_REQUIRED', 'CANDIDATE_SELECTION_REQUIRED', 'QUALITY_REVIEW_REQUIRED',
  'PRODUCTION_BUDGET_EXCEEDED', 'CAPABILITY_UNAVAILABLE', 'EXECUTOR_PREPARE_FAILED',
  'EXTERNAL_SUBMISSION_UNKNOWN', 'EXTERNAL_RECONCILIATION_REQUIRED', 'EXTERNAL_RECONCILIATION_FAILED',
  'PAUSED_DURING_EXTERNAL_CALL', 'PAUSED_DURING_EXECUTION', 'TASK_EXECUTION_INTERRUPTED',
]);
const clone = <T>(value: T): T => structuredClone(value);

function notFound(): never { throw new ProductionError(404, 'PRODUCTION_RUN_NOT_FOUND', '生产运行不存在。'); }
function taskNotFound(): never { throw new ProductionError(404, 'PRODUCTION_TASK_NOT_FOUND', '生产任务不存在。'); }
function conflict(code: string, message: string): never { throw new ProductionError(409, code, message); }
function issueRequiresWorkflow(task: ProductionTask, issue: ProductionIssue) {
  return task.status === 'waitingHuman' || task.status === 'failed' || task.status === 'reconciling'
    || issue.severity === 'error' || issueResolutionGates.has(issue.code)
    || /(?:UNKNOWN|FAILED|FAILURE|BUDGET|CAPABILITY|PREPARE|RETRY_LIMIT)/u.test(issue.code);
}

export class ProductionService {
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private readonly executors = new Map<ProductionStage, ProductionExecutor>();
  private readonly sourceCatalog?: ProductionSourceCatalog;
  private readonly assetRetrievalPolicy?: () => Promise<FrozenAssetRetrievalPolicy>;
  private readonly methodPacks?: ProductionServiceOptions['methodPacks'];
  private timer: NodeJS.Timeout | null = null;
  private tickTail: Promise<void> = Promise.resolve();

  constructor(private readonly repository: ProductionRepository, options: ProductionServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 2_000);
    this.sourceCatalog = options.sourceCatalog;
    this.assetRetrievalPolicy = options.assetRetrievalPolicy;
    this.methodPacks = options.methodPacks;
    for (const executor of [new ProductionPreflightExecutor(), ...(options.executors ?? [])]) this.executors.set(executor.stage, executor);
  }

  async list() { return { runs: (await this.repository.list()).map(publicProductionRun) }; }
  async get(id: string) { return publicProductionRun(await this.requireRun(parseProductionRunId(id))); }

  async create(value: unknown) {
    const input = parseCreateProductionRun(value);
    const existing = await this.repository.getByClientRequestId(input.clientRequestId);
    if (existing) {
      if (!sameProductionRequest(existing, input)) conflict('PRODUCTION_REQUEST_REUSED', '该请求标识已用于不同的生产输入。');
      return publicProductionRun(existing);
    }
    const project = await this.sourceCatalog?.getProject(input.projectId);
    await this.sourceCatalog?.getScriptVersion(input.projectId, input.scriptVersionId);
    const policy = this.assetRetrievalPolicy ? await this.assetRetrievalPolicy() : undefined;
    const draft = compileProductionRun(input, this.timestamp(), undefined, policy);
    if (this.methodPacks) draft.methodPacks = await this.methodPacks(project);
    const created = await this.repository.create(draft);
    if (!sameProductionRequest(created, input)) conflict('PRODUCTION_REQUEST_REUSED', '该请求标识已用于不同的生产输入。');
    return publicProductionRun(created);
  }

  async action(id: string, value: unknown) {
    let run = await this.requireRun(parseProductionRunId(id)); const action = parseProductionAction(value);
    // `partial` means "some work could not finish", not "nothing may ever change":
    // an operator must be able to reconcile, retry, abandon or raise the budget
    // through the API instead of editing run_json in the database.
    const repairAction = ['retryTask', 'abandonOperation', 'reconcileOperation', 'reconcileOperations', 'raiseBudget'].includes(action.type);
    if (terminal.has(run.status) && !(run.status === 'partial' && repairAction)) {
      conflict('PRODUCTION_RUN_TERMINAL', '已结束的生产运行不能再更改。');
    }
    let at = this.timestamp();
    if (action.type === 'pause') {
      if (run.pausedAt) return publicProductionRun(run);
      run.pausedAt = at;
      for (const task of run.tasks.filter(item => item.status === 'running')) {
        const attempt = run.attempts.find(item => item.id === run.attempts.filter(a => a.taskId === task.id).at(-1)?.id);
        if (attempt?.status === 'running') { attempt.status = 'interrupted'; attempt.endedAt = at; }
        const operation = this.activeOperation(run, task.id);
        if (operation) { operation.status = 'unknown'; operation.updatedAt = at; task.status = 'reconciling';
          task.blockingReason = { code: 'PAUSED_DURING_EXTERNAL_CALL', message: '暂停时外部请求可能已提交，只允许对账。' }; }
        else { task.status = 'waitingHuman'; task.blockingReason = { code: 'PAUSED_DURING_EXECUTION', message: '任务在执行中被暂停，需要人工确认后重试。' }; }
        task.version++; task.updatedAt = at;
      }
      run.status = 'paused';
      return publicProductionRun(await this.save(run, 'production.run.paused', {}));
    }
    if (action.type === 'resume') {
      if (!run.pausedAt && run.status !== 'pausedBudget') return publicProductionRun(run);
      run.pausedAt = null;
      // Without this reset refreshRunStatus keeps the pausedBudget label forever
      // (it early-returns on it), and the ticker would skip the run for good.
      if (run.status === 'pausedBudget') run.status = 'queued';
      this.promoteReady(run); this.refreshRunStatus(run);
      return publicProductionRun(await this.save(run, 'production.run.resumed', {}));
    }
    if (action.type === 'raiseBudget') {
      if (action.budgetMicros <= run.budgetMicros) {
        conflict('PRODUCTION_BUDGET_NOT_RAISED', '新预算必须高于当前预算。');
      }
      const previousBudgetMicros = run.budgetMicros;
      run.budgetMicros = action.budgetMicros;
      for (const task of run.tasks.filter(item => item.status === 'waitingHuman'
        && item.blockingReason?.code === 'PRODUCTION_BUDGET_EXCEEDED')) {
        task.status = 'pending'; task.blockingReason = null; task.version++; task.updatedAt = at;
      }
      for (const issue of run.issues.filter(item => item.code === 'PRODUCTION_BUDGET_EXCEEDED' && item.status === 'open')) {
        issue.status = 'resolved'; issue.resolvedAt = at;
      }
      run.pausedAt = null;
      if (run.status === 'pausedBudget') run.status = 'queued';
      this.promoteReady(run); this.refreshRunStatus(run);
      return publicProductionRun(await this.save(run, 'production.run.budget_raised',
        { budgetMicros: run.budgetMicros, previousBudgetMicros }));
    }
    if (action.type === 'reconcileOperations') {
      return publicProductionRun(await this.reconcileUnknownOperations(run, action.reason));
    }
    let task = run.tasks.find(item => item.id === action.taskId); if (!task) taskNotFound();
    if (action.type === 'abandonOperation') {
      // Human reconciliation authority for synchronous providers that cannot be
      // re-queried: the operator confirms the original paid submission is
      // irrecoverable, releases the double-charge guard, and requeues the task.
      if (task.status !== 'waitingHuman') conflict('PRODUCTION_TASK_NOT_ABANDONABLE', '只有等待人工处理的任务才能放弃外部操作。');
      const operation = this.activeOperation(run, task.id);
      if (!operation || operation.status !== 'unknown') {
        conflict('PRODUCTION_OPERATION_NOT_UNKNOWN', '没有等待人工对账的外部操作。');
      }
      const attempt = run.attempts.find(item => item.id === operation.attemptId);
      if (attempt) this.charge(run, task, attempt, 0, at, true, operation.billingBasis === 'estimate');
      operation.status = 'abandoned'; operation.updatedAt = at;
      this.resolveTaskIssues(run, task.id, at);
      this.invalidateFrom(run, task.id, at);
      task.status = task.dependencies.every(id => dependencyDone(run.tasks.find(item => item.id === id)!)) ? 'ready' : 'pending';
      task.blockingReason = null; task.version++; task.updatedAt = at;
      this.refreshRunStatus(run);
      return publicProductionRun(await this.save(run, 'production.task.operation_abandoned', { taskId: task.id, reason: action.reason }));
    }
    if (action.type === 'reconcileOperation') {
      // Human-triggered reconciliation: re-query the original external operation
      // without creating a second paid submission.
      if (!['waitingHuman', 'reconciling'].includes(task.status)) {
        conflict('PRODUCTION_TASK_NOT_RECONCILABLE', '当前任务状态不能对账。');
      }
      const operation = this.activeOperation(run, task.id);
      if (!operation) conflict('PRODUCTION_OPERATION_NOT_FOUND', '没有等待对账的外部操作。');
      if (operation.status !== 'unknown') conflict('PRODUCTION_OPERATION_NOT_UNKNOWN', '外部操作不在结果未知状态，无需对账。');
      await this.reconcile(run, task);
      return publicProductionRun(await this.requireRun(run.id));
    }
    if (!['waitingHuman', 'failed', 'reconciling', 'invalidated', 'succeeded'].includes(task.status)) {
      conflict('PRODUCTION_TASK_NOT_RETRYABLE', '当前任务状态不能重试。');
    }
    if (task.status === 'succeeded' && action.force !== true) {
      conflict('PRODUCTION_RETRY_REQUIRES_FORCE', '重跑已完成任务会作废其产物和下游，需要显式 force。');
    }
    const operation = this.activeOperation(run, task.id);
    if (operation) {
      if (task.status !== 'waitingHuman' || operation.status !== 'unknown') {
        conflict('PRODUCTION_EXTERNAL_OPERATION_UNKNOWN', '外部付费操作尚未明确结束，不能创建第二次提交。');
      }
      // A human-authorized retry is also reconciliation authority: query the
      // original external operation first; only a definitive outcome unlocks
      // the second submission, otherwise the double-charge guard still applies.
      await this.reconcile(run, task);
      run = await this.requireRun(run.id);
      task = run.tasks.find(item => item.id === action.taskId); if (!task) taskNotFound();
      if (this.activeOperation(run, task.id)) {
        conflict('PRODUCTION_EXTERNAL_OPERATION_UNKNOWN', '原外部付费操作对账后仍无确定结果，不能创建第二次提交。');
      }
      if (!['waitingHuman', 'failed', 'reconciling', 'invalidated'].includes(task.status)) {
        // Reconciliation already resolved the task (completed or waiting at a
        // checkpoint); no second submission is needed.
        return publicProductionRun(run);
      }
      at = this.timestamp();
    }
    if (task.attemptCount >= task.maxAttempts && action.force !== true) {
      conflict('PRODUCTION_RETRY_LIMIT', '该任务已达重试上限。');
    }
    if (action.force === true && task.attemptCount >= task.maxAttempts) {
      // Explicit operator override: raise the per-task ceiling so the scheduler
      // gate (which re-checks attemptCount >= maxAttempts) also lets it run.
      task.maxAttempts = task.attemptCount + 1;
    }
    this.invalidateFrom(run, task.id, at);
    task.status = task.dependencies.every(id => dependencyDone(run.tasks.find(item => item.id === id)!)) ? 'ready' : 'pending';
    task.blockingReason = null; task.version++; task.updatedAt = at;
    this.resolveTaskIssues(run, task.id, at);
    this.refreshRunStatus(run);
    return publicProductionRun(await this.save(run, 'production.task.retry_requested', { taskId: task.id, reason: action.reason }));
  }

  async review(id: string, value: unknown) {
    const run = await this.requireRun(parseProductionRunId(id)); const input = parseProductionReview(value);
    if (run.pausedAt || terminal.has(run.status)) conflict('PRODUCTION_REVIEW_NOT_ALLOWED', '当前运行状态不能复核。');
    const task = run.tasks.find(item => item.id === input.taskId); if (!task) taskNotFound();
    const at = this.timestamp();
    this.validateReview(run, task, input);
    await this.executors.get(task.stage)?.review?.({ run: clone(run), task: clone(task), input: clone(input) });
    if (input.decision === 'selectCandidate') this.selectCandidate(run, task, input, at);
    else if (input.decision === 'approve') this.approveCheckpoint(run, task, input, at);
    else if (input.decision === 'resolveIssue') this.resolveIssue(run, task, input, at);
    else this.rejectTask(run, task, input, at);
    run.reviews.push({ id: productionId('preview'), runId: run.id, taskId: task.id, issueId: input.issueId,
      candidateId: input.candidateId, decision: input.decision, feedback: input.feedback, createdAt: at });
    this.promoteReady(run); this.refreshRunStatus(run);
    return publicProductionRun(await this.save(run, 'production.review.recorded', { taskId: task.id, decision: input.decision }));
  }

  async start() {
    const at = this.timestamp();
    for (const current of await this.repository.list()) {
      if (terminal.has(current.status) || current.pausedAt) continue;
      let changed = false;
      for (const task of current.tasks.filter(item => item.status === 'running')) {
        const attempt = current.attempts.filter(item => item.taskId === task.id).at(-1);
        const attemptWasRunning = attempt?.status === 'running';
        if (attemptWasRunning) { attempt!.status = 'interrupted'; attempt!.endedAt = at; }
        const operation = this.activeOperation(current, task.id);
        if (operation) { operation.status = 'unknown'; operation.updatedAt = at; task.status = 'reconciling';
          task.blockingReason = { code: 'EXTERNAL_SUBMISSION_UNKNOWN', message: '后端重启时付费提交可能已发生，只能查询原任务。' }; }
        else {
          // The process that held this attempt is gone, and no external operation
          // was opened. Settle the hold so a later retry can reserve again.
          if (attemptWasRunning) this.charge(current, task, attempt!, 0, at, true);
          task.status = 'waitingHuman'; task.blockingReason = { code: 'TASK_EXECUTION_INTERRUPTED', message: '后端重启中断了本地任务，需要明确重试。' };
        }
        task.updatedAt = at; task.version++; this.addIssue(current, task, {
          code: task.blockingReason.code, title: '任务需要恢复', message: task.blockingReason.message,
          severity: 'warning', recommendedActions: operation ? ['对账原外部任务'] : ['确认后重试'],
        }, at); changed = true;
      }
      if (changed) { this.refreshRunStatus(current); await this.save(current, 'production.run.recovered', {}); }
    }
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick().catch(() => undefined), this.pollIntervalMs);
      this.timer.unref();
    }
    await this.tick();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.tickTail;
  }

  async tick(runId?: string) {
    const execute = async () => {
      const runs = runId ? [await this.requireRun(parseProductionRunId(runId))] : await this.repository.list();
      for (const run of runs) {
        if (terminal.has(run.status) || run.pausedAt || run.status === 'pausedBudget') continue;
        await this.advanceOne(run).catch(error => {
          if (!(error instanceof ProductionError && error.code === 'PRODUCTION_RUN_CONFLICT')) throw error;
        });
      }
    };
    const scheduled = this.tickTail.then(execute, execute);
    this.tickTail = scheduled.catch(() => undefined);
    return scheduled;
  }

  private async advanceOne(initial: StoredProductionRun) {
    let run = initial;
    const waiting = run.tasks.filter(task => task.status === 'waitingExternal' || task.status === 'reconciling')
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id))[0];
    if (waiting) {
      await this.reconcile(run, waiting);
      run = await this.requireRun(run.id);
      if (terminal.has(run.status) || run.pausedAt || run.status === 'pausedBudget') return;
    }
    const promoted = this.promoteReady(run);
    const ready = run.tasks.filter(item => item.status === 'ready');
    if (!ready.length) {
      this.refreshRunStatus(run);
      if (run.status !== (await this.repository.get(run.id))?.status) await this.save(run, 'production.run.status_changed', { status: run.status });
      return;
    }
    for (const task of ready) {
      const executor = this.executors.get(task.stage);
      if (!executor) {
        const at = this.timestamp(); task.status = 'waitingHuman'; task.version++; task.updatedAt = at;
        task.blockingReason = { code: 'CAPABILITY_UNAVAILABLE', message: `当前还没有配置“${task.label}”执行器，未伪造阶段成果。` };
        this.addIssue(run, task, { code: 'CAPABILITY_UNAVAILABLE', title: `${task.label}暂不可执行`, message: task.blockingReason.message,
          severity: 'warning', impact: [task.label, '其下游任务'], recommendedActions: ['配置对应执行器', '人工处理后重试'] }, at);
        this.refreshRunStatus(run); await this.save(run, 'production.task.blocked', { taskId: task.id, code: 'CAPABILITY_UNAVAILABLE' }); return;
      }
      const result = await this.execute(run, task, executor);
      if (result !== 'deferred') return;
    }
    this.refreshRunStatus(run);
    if (promoted) await this.save(run, 'production.tasks.deferred', { taskIds: ready.map(task => task.id) });
  }

  private async execute(run: StoredProductionRun, task: ProductionTask, executor: ProductionExecutor) {
    // Upstream invalidation can make an interrupted downstream task ready again.
    // Its original external submission must be settled before another attempt.
    if (this.activeOperation(run, task.id)) { await this.reconcile(run, task); return; }
    if (task.attemptCount >= task.maxAttempts) {
      const at = this.timestamp();
      task.status = 'failed'; task.version++; task.updatedAt = at;
      task.blockingReason = { code: 'PRODUCTION_RETRY_LIMIT', message: '该任务已达重试上限，未再调用执行器。' };
      this.addIssue(run, task, { code: 'PRODUCTION_RETRY_LIMIT', title: '重试次数已用尽', message: task.blockingReason.message,
        severity: 'error', recommendedActions: ['检查失败原因后创建新的生产运行'] }, at);
      this.refreshRunStatus(run);
      await this.save(run, 'production.task.retry_limit_reached', { taskId: task.id });
      return;
    }
    let prepared;
    try { prepared = await executor.prepare({ run: clone(run), task: clone(task) }); }
    catch { return this.blockPrepare(run, task); }
    if (!Number.isSafeInteger(prepared.estimateCostMicros) || prepared.estimateCostMicros < 0 || !prepared.inputDigest || !prepared.executor) {
      return this.blockPrepare(run, task);
    }
    if (prepared.prerequisites?.length) {
      if (prepared.requiresPaid || prepared.estimateCostMicros !== 0) return this.blockPrepare(run, task);
      const at = this.timestamp();
      this.materializeSpawnTasks(run, task, prepared.prerequisites, at, true);
      task.status = 'pending'; task.updatedAt = at; task.version++;
      this.promoteReady(run); this.refreshRunStatus(run);
      await this.save(run, 'production.task.prerequisites_created', { taskId: task.id });
      return;
    }
    if (prepared.defer) {
      if (prepared.requiresPaid || prepared.estimateCostMicros !== 0 || prepared.provider !== null
        || typeof prepared.defer.code !== 'string' || !prepared.defer.code
        || typeof prepared.defer.message !== 'string' || !prepared.defer.message) return this.blockPrepare(run, task);
      return 'deferred' as const;
    }
    const available = run.budgetMicros - this.spent(run) - this.reserved(run);
    if (prepared.estimateCostMicros > available) {
      const at = this.timestamp(); task.status = 'waitingHuman'; task.version++; task.updatedAt = at;
      task.blockingReason = { code: 'PRODUCTION_BUDGET_EXCEEDED', message: `「${task.label}」预留费用将超过本次运行的已授权预算。` };
      this.addIssue(run, task, { code: 'PRODUCTION_BUDGET_EXCEEDED', title: '预算不足', message: task.blockingReason.message,
        severity: 'error', estimatedAdditionalCostMicros: prepared.estimateCostMicros - available,
        recommendedActions: ['创建新的运行并授权更高预算', '改用直出版或减少每镜候选数、降低质量档位'] }, at);
      run.status = 'pausedBudget'; await this.save(run, 'production.run.budget_paused', { taskId: task.id }); return;
    }
    const at = this.timestamp(); const attemptId = productionId('pattempt');
    const operationKey = prepared.requiresPaid ? canonicalDigest({ runId: run.id, taskId: task.id, taskVersion: task.version,
      attempt: task.attemptCount + 1, inputDigest: prepared.inputDigest }) : null;
    const attempt: TaskAttempt = { id: attemptId, runId: run.id, taskId: task.id, number: task.attemptCount + 1,
      status: 'running', executor: prepared.executor, inputDigest: prepared.inputDigest, error: null, startedAt: at, endedAt: null };
    task.status = 'running'; task.attemptCount++; task.version++; task.updatedAt = at; task.blockingReason = null; run.attempts.push(attempt);
    if (prepared.estimateCostMicros) run.budgetLedger.push(this.budget(run, task.id, attemptId, 'reserve', prepared.estimateCostMicros, '执行前预留', at));
    if (prepared.requiresPaid) run.externalOperations.push({ id: productionId('pop'), runId: run.id, taskId: task.id,
      attemptId, operationKey: operationKey!, provider: prepared.provider ?? 'configured-adapter', providerTaskId: null,
      ...(prepared.billingBasis ? { billingBasis: prepared.billingBasis } : {}),
      status: 'prepared', estimatedCostMicros: prepared.estimateCostMicros, actualCostMicros: null, createdAt: at, updatedAt: at });
    run.status = 'running';
    const claimed = await this.save(run, 'production.task.started', { taskId: task.id, attemptId });
    const claimedTask = claimed.tasks.find(item => item.id === task.id)!;
    const context: ProductionExecutionContext = { run: clone(claimed), task: clone(claimedTask), attemptId,
      inputDigest: prepared.inputDigest, operationKey };
    let outcome: ProductionExecutorOutcome;
    try { outcome = await executor.execute(context); }
    catch (error) {
      if (error instanceof ProductionError && error.code === 'PRODUCTION_RUN_CONFLICT') return;
      const failed = await this.requireRun(claimed.id); const currentTask = failed.tasks.find(item => item.id === task.id)!;
      const currentAttempt = failed.attempts.find(item => item.id === attemptId)!; const end = this.timestamp();
      currentAttempt.status = 'failed'; currentAttempt.endedAt = end;
      currentAttempt.error = { code: prepared.requiresPaid ? 'EXTERNAL_SUBMISSION_UNKNOWN' : 'EXECUTOR_FAILED',
        message: prepared.requiresPaid ? '付费提交结果不明，不会自动重发。' : '执行器运行失败，原始错误未暴露。' };
      const operation = this.activeOperation(failed, currentTask.id);
      if (operation) { operation.status = 'unknown'; operation.updatedAt = end; currentTask.status = 'reconciling'; }
      else {
        // No external operation was opened, so the thrown attempt did not report
        // a charge. Release the hold; a returned local failure already does this.
        this.charge(failed, currentTask, currentAttempt, 0, end, true);
        currentTask.status = 'failed';
      }
      currentTask.blockingReason = clone(currentAttempt.error); currentTask.updatedAt = end; currentTask.version++;
      this.addIssue(failed, currentTask, { code: currentAttempt.error.code, title: '执行未完成', message: currentAttempt.error.message,
        severity: 'error', recommendedActions: operation ? ['查询原供应商任务', '不要重复提交'] : ['检查执行器后重试'] }, end);
      this.refreshRunStatus(failed); await this.save(failed, 'production.task.execution_failed', { taskId: task.id });
      return;
    }
    await this.applyOutcomeAfterClaim(claimed, task.id, attemptId, outcome);
  }

  /** Query every unknown external operation on this run. Never starts a new paid submit.
   * Operations with no provider task id stay on the human gate and do not rewrite the run. */
  private async reconcileUnknownOperations(initial: StoredProductionRun, reason: string): Promise<StoredProductionRun> {
    const taskIds = this.unknownOperationTaskIds(initial);
    const queryable = taskIds.filter(taskId => {
      const operation = initial.externalOperations.filter(item => item.taskId === taskId && item.status === 'unknown').at(-1);
      return typeof operation?.providerTaskId === 'string' && operation.providerTaskId.trim().length > 0;
    });
    for (const taskId of queryable) {
      const current = await this.requireRun(initial.id);
      const task = current.tasks.find(item => item.id === taskId);
      if (!task || !this.unknownOperationTaskIds(current).includes(task.id)) continue;
      const operation = this.activeOperation(current, task.id);
      if (!operation?.providerTaskId) continue;
      await this.reconcile(current, task);
    }
    const latest = await this.requireRun(initial.id);
    if (queryable.length === 0) return latest;
    const results = taskIds.map(taskId => {
      const task = latest.tasks.find(item => item.id === taskId);
      const operation = latest.externalOperations.filter(item => item.taskId === taskId).at(-1) ?? null;
      return {
        taskId,
        taskStatus: task?.status ?? null,
        operationId: operation?.id ?? null,
        operationStatus: operation?.status ?? null,
        providerTaskId: operation?.providerTaskId ?? null,
      };
    });
    return this.save(latest, 'production.run.operations_reconciled', { reason, results });
  }

  private unknownOperationTaskIds(run: StoredProductionRun): string[] {
    return run.tasks.filter(task => {
      if (!['waitingHuman', 'reconciling'].includes(task.status)) return false;
      const operation = this.activeOperation(run, task.id);
      return operation?.status === 'unknown';
    }).map(task => task.id).sort((left, right) => left.localeCompare(right));
  }

  private async reconcile(run: StoredProductionRun, task: ProductionTask) {
    const operation = this.activeOperation(run, task.id); const executor = this.executors.get(task.stage);
    if (!operation || !executor?.reconcile || !operation.providerTaskId) {
      if (task.status !== 'waitingHuman') {
        const at = this.timestamp();
        if (operation) { operation.status = 'unknown'; operation.updatedAt = at; }
        task.status = 'waitingHuman'; task.version++; task.updatedAt = at;
        task.blockingReason = { code: 'EXTERNAL_RECONCILIATION_REQUIRED', message: '原外部任务无法自动查询，需要人工对账。' };
        this.addIssue(run, task, { code: 'EXTERNAL_RECONCILIATION_REQUIRED', title: '需要外部任务对账', message: task.blockingReason.message,
          severity: 'error', recommendedActions: ['确认原供应商任务状态', '不要重复提交'] }, at);
        this.refreshRunStatus(run); await this.save(run, 'production.task.reconciliation_blocked', { taskId: task.id });
      }
      return;
    }
    const attempt = run.attempts.find(item => item.id === operation.attemptId); if (!attempt) return;
    const at = this.timestamp(); operation.status = 'polling'; operation.updatedAt = at; task.status = 'reconciling'; task.updatedAt = at; task.version++;
    const polling = await this.save(run, 'production.external.polling', { taskId: task.id, operationId: operation.id });
    const currentTask = polling.tasks.find(item => item.id === task.id)!; const currentOp = this.activeOperation(polling, task.id)!;
    let outcome: ProductionExecutorOutcome;
    try { outcome = await executor.reconcile({ run: clone(polling), task: clone(currentTask), attemptId: attempt.id,
      inputDigest: attempt.inputDigest, operationKey: operation.operationKey }, clone(currentOp)); }
    catch (error) {
      if (error instanceof ProductionError && error.code === 'PRODUCTION_RUN_CONFLICT') return;
      const latest = await this.requireRun(run.id); const latestTask = latest.tasks.find(item => item.id === task.id);
      const latestOp = this.activeOperation(latest, task.id);
      // Another process may have completed the operation while this query was in
      // flight. Preserve that terminal result instead of overwriting it with a
      // stale reconciliation failure.
      if (!latestTask || !latestOp) return;
      const end = this.timestamp();
      latestOp.status = 'unknown'; latestOp.updatedAt = end; latestTask.status = 'waitingHuman'; latestTask.version++; latestTask.updatedAt = end;
      latestTask.blockingReason = { code: 'EXTERNAL_RECONCILIATION_FAILED', message: '原外部任务查询失败，未重复提交。' };
      this.addIssue(latest, latestTask, { code: 'EXTERNAL_RECONCILIATION_FAILED', title: '对账失败', message: latestTask.blockingReason.message,
        severity: 'error', recommendedActions: ['稍后再对账原任务'] }, end);
      this.refreshRunStatus(latest); await this.save(latest, 'production.external.reconciliation_failed', { taskId: task.id });
      return;
    }
    await this.applyOutcomeAfterClaim(polling, task.id, attempt.id, outcome);
  }

  private async applyOutcomeAfterClaim(claimed: StoredProductionRun, taskId: string, attemptId: string,
    outcome: ProductionExecutorOutcome) {
    let current = claimed;
    // The executor has already run and may already have spent money. A CAS retry must
    // only re-apply that returned outcome; it must never call the executor again.
    for (let casAttempt = 0; casAttempt < 2; casAttempt++) {
      const task = current.tasks.find(item => item.id === taskId);
      const attempt = current.attempts.find(item => item.id === attemptId);
      if (!task || !attempt || ['succeeded', 'failed'].includes(attempt.status)) return;
      if (current.externalOperations.some(op => op.attemptId === attemptId && op.status === 'abandoned')) return;
      try { await this.applyOutcome(current, task, attemptId, outcome); return; }
      catch (error) {
        if (!(error instanceof ProductionError && error.code === 'PRODUCTION_RUN_CONFLICT')) {
          await this.failInvalidOutcome(current.id, taskId, attemptId, error); return;
        }
        current = await this.requireRun(current.id);
      }
    }
    // A second conflicting write means the returned provider outcome cannot safely be
    // materialized against the moving aggregate. Persist a reconciliation gate with
    // any returned provider ID and leave the reservation untouched. This prevents a
    // later retry from issuing a second paid request.
    await this.persistOutcomeConflictGate(current.id, taskId, attemptId, outcome);
  }

  private async persistOutcomeConflictGate(runId: string, taskId: string, attemptId: string,
    outcome: ProductionExecutorOutcome) {
    for (let casAttempt = 0; casAttempt < 5; casAttempt++) {
      const latest = await this.requireRun(runId);
      const task = latest.tasks.find(item => item.id === taskId);
      const attempt = latest.attempts.find(item => item.id === attemptId);
      const operation = latest.externalOperations.find(item => item.attemptId === attemptId) ?? null;
      if (!task || !attempt || ['succeeded', 'failed'].includes(attempt.status)
        || (operation && ['succeeded', 'failed'].includes(operation.status))) return;
      const at = this.timestamp();
      if (operation) {
        if (outcome.state === 'waitingExternal' && typeof outcome.providerTaskId === 'string'
          && outcome.providerTaskId.trim()) operation.providerTaskId = outcome.providerTaskId.trim();
        operation.status = 'unknown'; operation.actualCostMicros = null; operation.updatedAt = at;
      }
      attempt.status = 'interrupted'; attempt.endedAt = at;
      attempt.error = { code: 'EXTERNAL_OUTCOME_UNKNOWN_AFTER_CONFLICT',
        message: '外部调用已返回，但连续状态冲突阻止了安全落库；已禁止重复提交并转入对账。' };
      const canReconcile = Boolean(operation?.providerTaskId && this.executors.get(task.stage)?.reconcile);
      task.status = canReconcile ? 'reconciling' : 'waitingHuman';
      task.blockingReason = clone(attempt.error); task.version++; task.updatedAt = at;
      this.addIssue(latest, task, { code: attempt.error.code, title: '外部结果需要对账', message: attempt.error.message,
        severity: 'error', recommendedActions: canReconcile
          ? ['查询已保存的原供应商任务', '不要重复提交']
          : ['人工核对供应商任务与账单', '不要重复提交'] }, at);
      this.refreshRunStatus(latest);
      try {
        await this.save(latest, 'production.external.outcome_persistence_blocked', {
          taskId, attemptId, providerTaskIdPreserved: Boolean(operation?.providerTaskId),
        });
        return;
      } catch (error) {
        if (!(error instanceof ProductionError && error.code === 'PRODUCTION_RUN_CONFLICT')) throw error;
      }
    }
    conflict('PRODUCTION_RUN_CONFLICT', '外部结果对账门禁暂时无法持久化，请重新读取；不会重复提交。');
  }

  private async failInvalidOutcome(runId: string, taskId: string, attemptId: string, error: unknown) {
    console.error('[failInvalidOutcome]', taskId, error instanceof Error ? (error.stack || error.message) : JSON.stringify(error));
    const latest = await this.requireRun(runId); const task = latest.tasks.find(item => item.id === taskId);
    const attempt = latest.attempts.find(item => item.id === attemptId);
    if (!task || !attempt || attempt.status === 'succeeded') return;
    const at = this.timestamp(); const code = error instanceof ProductionError ? error.code : 'PRODUCTION_EXECUTOR_OUTPUT_INVALID';
    // Keep a redacted, field-level reason on the attempt so the UI can explain the
    // rejection without re-running the paid step only to see the same error again.
    const reason = error instanceof ProductionError ? error.message : redactExecutorError(error);
    const message = reason ? `执行器输出未通过编排器校验（${code}）：${reason}；未保存部分成果。`
      : '执行器输出未通过编排器校验，未保存部分成果。';
    attempt.status = 'failed'; attempt.endedAt = at; attempt.error = { code, message };
    const operation = this.activeOperation(latest, task.id);
    if (operation) { operation.status = 'unknown'; operation.updatedAt = at; task.status = 'waitingHuman'; }
    else {
      this.charge(latest, task, attempt, 0, at, true);
      task.status = 'failed';
    }
    task.blockingReason = clone(attempt.error); task.version++; task.updatedAt = at;
    this.addIssue(latest, task, { code, title: '执行器输出无效', message: attempt.error.message,
      severity: 'error', recommendedActions: operation ? ['对账原外部任务，不要重复提交'] : ['修复执行器后局部重试'] }, at);
    this.refreshRunStatus(latest);
    await this.save(latest, 'production.task.output_rejected', { taskId, code });
  }

  private async applyOutcome(run: StoredProductionRun, task: ProductionTask, attemptId: string, outcome: ProductionExecutorOutcome) {
    const at = this.timestamp(); const attempt = run.attempts.find(item => item.id === attemptId); if (!attempt) return;
    const operation = this.activeOperation(run, task.id);
    if (outcome.state === 'waitingExternal') {
      if (!operation || typeof outcome.providerTaskId !== 'string' || !outcome.providerTaskId.trim()) {
        outcome = { state: 'failed', code: 'EXTERNAL_OPERATION_INVALID', message: '执行器未返回可查询的外部任务标识。', retryable: false };
      } else {
        operation.providerTaskId = outcome.providerTaskId.trim(); operation.status = 'submitted'; operation.updatedAt = at;
        const reportedActual = outcome.actualCostMicros ?? 0;
        const reservedForAttempt = this.reservedForAttempt(run, task, attempt);
        if (!this.actualCostAuthorized(reportedActual, reservedForAttempt)) {
          await this.blockUnauthorizedActualCost(run, task, attempt, operation, reportedActual, reservedForAttempt, at); return;
        }
        task.status = 'waitingExternal'; task.version++; task.updatedAt = at; task.blockingReason = null;
        this.charge(run, task, attempt, outcome.actualCostMicros ?? 0, at, false);
        this.refreshRunStatus(run); await this.save(run, 'production.external.submitted', { taskId: task.id, operationId: operation.id }); return;
      }
    }
    const reportedActual = outcome.actualCostMicros ?? 0;
    const reservedForAttempt = this.reservedForAttempt(run, task, attempt);
    if (!this.actualCostAuthorized(reportedActual, reservedForAttempt)) {
      await this.blockUnauthorizedActualCost(run, task, attempt, operation, reportedActual, reservedForAttempt, at); return;
    }
    if (outcome.state === 'waitingHuman' && outcome.operationUnknown === true) {
      if (!operation || reportedActual !== 0 || outcome.candidateSets?.length || outcome.qualityChecks?.length
        || outcome.spawnTasks?.length) {
        conflict('PRODUCTION_EXECUTOR_OUTPUT_INVALID', '结果不明的外部操作不能结算、创建候选或推进下游。');
      }
      this.materialize(run, task, outcome.artifacts ?? [], [], [], at);
      attempt.endedAt = at; attempt.status = 'interrupted';
      attempt.error = { code: outcome.issue.code, message: outcome.issue.message };
      operation.status = 'unknown'; operation.actualCostMicros = null; operation.updatedAt = at;
      task.status = 'waitingHuman'; task.blockingReason = clone(attempt.error); task.version++; task.updatedAt = at;
      this.addIssue(run, task, outcome.issue, at);
      this.refreshRunStatus(run);
      await this.save(run, 'production.external.unknown', { taskId: task.id, operationId: operation.id });
      return;
    }
    attempt.endedAt = at;
    if (outcome.state === 'failed') {
      attempt.status = 'failed'; attempt.error = { code: outcome.code, message: outcome.message };
      this.charge(run, task, attempt, outcome.actualCostMicros ?? 0, at, true);
      if (operation) { operation.status = 'failed'; operation.updatedAt = at; }
      task.status = outcome.retryable && task.attemptCount < task.maxAttempts ? 'waitingHuman' : 'failed';
      task.blockingReason = clone(attempt.error); task.version++; task.updatedAt = at;
      this.addIssue(run, task, { code: outcome.code, title: '任务失败', message: outcome.message, severity: 'error',
        recommendedActions: outcome.retryable ? ['检查原因后局部重试'] : ['人工接管'] }, at);
    } else {
      this.materialize(run, task, outcome.artifacts ?? [], outcome.candidateSets ?? [], outcome.qualityChecks ?? [], at);
      if (outcome.spawnTasks?.length) this.materializeSpawnTasks(run, task, outcome.spawnTasks, at);
      const estimated = outcome.state === 'succeeded' && outcome.settleAtEstimate === true;
      if (estimated && (!operation || operation.billingBasis !== 'estimate' || outcome.actualCostMicros !== undefined)) {
        conflict('PRODUCTION_EXECUTOR_OUTPUT_INVALID', '估算结算缺少对应的付费预留。');
      }
      this.charge(run, task, attempt, outcome.actualCostMicros ?? 0, at, true, estimated);
      if (operation) { operation.status = 'succeeded'; operation.updatedAt = at; }
      attempt.status = 'succeeded'; attempt.error = null;
      if (outcome.state === 'blocked' || outcome.state === 'waitingHuman') {
        task.status = 'waitingHuman'; task.blockingReason = { code: outcome.issue.code, message: outcome.issue.message };
        this.addIssue(run, task, outcome.issue, at);
      } else {
        if (outcome.timeline) this.materializeTimeline(run, task, outcome.timeline, at);
        if (outcome.delivery) this.materializeDelivery(run, task, outcome.delivery, at);
        const qualityNeedsReview = (outcome.qualityChecks ?? []).some(check => check.result !== 'pass');
        const continueWithRepair = outcome.continueOnFailedQuality === true;
        if (continueWithRepair && (run.automationMode !== 'auto' || !outcome.spawnTasks?.length)) {
          conflict('PRODUCTION_EXECUTOR_OUTPUT_INVALID', '质量失败只能在全自动模式且已创建真实返修子图时继续。');
        }
        const candidatesNeedReview = run.candidateSets.some(set => set.taskId === task.id && set.status === 'open');
        if (qualityNeedsReview && continueWithRepair) {
          task.status = 'succeeded'; task.blockingReason = null;
          this.addIssue(run, task, { code: 'AUTOMATED_REPAIR_SCHEDULED', title: '已进入局部返修',
            message: '质量检查未通过，系统已创建明确的返修子任务，未把问题当作通过。',
            severity: 'warning', recommendedActions: ['查看返修子任务和后续复核'] }, at);
        } else if (qualityNeedsReview) {
          task.status = 'waitingHuman'; task.blockingReason = { code: 'QUALITY_REVIEW_REQUIRED', message: '质量检查未明确通过，需要人工复核。' };
          this.addIssue(run, task, { code: 'QUALITY_REVIEW_REQUIRED', title: '质量需复核', message: task.blockingReason.message,
            severity: 'warning', recommendedActions: ['查看检查依据', '重试最小上游节点'] }, at);
        } else if (candidatesNeedReview) {
          task.status = 'waitingHuman'; task.blockingReason = { code: 'CANDIDATE_SELECTION_REQUIRED', message: '候选组需要选择一个采用项。' };
          this.addIssue(run, task, { code: 'CANDIDATE_SELECTION_REQUIRED', title: '请选择候选', message: task.blockingReason.message,
            recommendedActions: ['比较候选并采用', '拒绝后局部重试'] }, at);
        } else if (this.checkpoint(run, task.stage)) {
          task.status = 'waitingHuman'; task.blockingReason = { code: 'CHECKPOINT_REVIEW_REQUIRED', message: '当前自动化模式要求在该阶段确认。' };
          this.addIssue(run, task, { code: 'CHECKPOINT_REVIEW_REQUIRED', title: `${task.label}待确认`, message: task.blockingReason.message,
            severity: 'info', recommendedActions: ['查看输出后通过或驳回'] }, at);
        } else task.status = 'succeeded';
      }
      task.version++; task.updatedAt = at;
      if (task.status === 'succeeded' && task.stage === 'review' && task.scope.kind === 'shot') {
        for (const issue of run.issues.filter(item => item.status === 'open' && item.code === 'AUTOMATED_REPAIR_SCHEDULED'
          && item.scope.kind === 'shot' && item.scope.id === task.scope.id)) {
          issue.status = 'resolved'; issue.resolvedAt = at;
        }
      }
    }
    this.promoteReady(run); this.refreshRunStatus(run);
    await this.save(run, 'production.task.finished', { taskId: task.id, status: task.status });
  }

  private materialize(run: StoredProductionRun, task: ProductionTask, artifacts: ArtifactDraft[], sets: CandidateSetDraft[], checks: QualityCheckDraft[], at: string) {
    const keys = new Map<string, string>();
    for (const draft of artifacts) {
      if (!draft.key || keys.has(draft.key) || !draft.title) conflict('PRODUCTION_EXECUTOR_OUTPUT_INVALID', '执行器输出的成果标识不正确。');
      const artifact: ProductionArtifact = { id: productionId('partifact'), runId: run.id, taskId: task.id, kind: draft.kind,
        title: draft.title, uri: draft.uri ?? null, sha256: draft.sha256 ?? null,
        metadata: { ...clone(draft.metadata ?? {}), key: draft.key }, status: 'current', createdAt: at };
      keys.set(draft.key, artifact.id); run.artifacts.push(artifact);
    }
    for (const draft of sets) {
      if (!draft.candidates.length || draft.candidates.length > run.candidateLimit) conflict('PRODUCTION_EXECUTOR_OUTPUT_INVALID', '候选数超出本次运行限制。');
      if (draft.recommendedIndex !== undefined && draft.recommendedIndex !== null
        && (!Number.isInteger(draft.recommendedIndex) || draft.recommendedIndex < 0 || draft.recommendedIndex >= draft.candidates.length)) {
        conflict('PRODUCTION_EXECUTOR_OUTPUT_INVALID', '推荐候选索引超出范围。');
      }
      const autoIndex = run.automationMode === 'auto' ? draft.recommendedIndex ?? null : null;
      const set: CandidateSet = { id: productionId('pcset'), runId: run.id, taskId: task.id, kind: draft.kind,
        scope: clone(draft.scope ?? task.scope), status: autoIndex === null ? 'open' : 'selected', selectedCandidateId: null, createdAt: at,
        candidates: draft.candidates.map(candidate => ({ id: productionId('pcandidate'), artifactId: candidate.artifactKey ? keys.get(candidate.artifactKey) ?? null : null,
          label: candidate.label, summary: candidate.summary, score: candidate.score ?? null, status: 'available', createdAt: at })) };
      if (autoIndex !== null) {
        set.selectedCandidateId = set.candidates[autoIndex]!.id;
        set.candidates.forEach((candidate, index) => { candidate.status = index === autoIndex ? 'selected' : 'rejected'; });
      }
      run.candidateSets.push(set);
    }
    for (const check of checks) run.qualityChecks.push({ id: productionId('pcheck'), runId: run.id, taskId: task.id,
      level: check.level, result: check.result, ruleVersion: check.ruleVersion, summary: check.summary,
      issues: [...(check.issues ?? [])], createdAt: at });
  }

  private materializeTimeline(run: StoredProductionRun, task: ProductionTask, draft: TimelineDraft, at: string) {
    const current = run.artifacts.filter(item => item.status === 'current');
    const resolve = (key: string) => current.find(item => item.taskId === task.id && item.metadata.key === key)?.id
      ?? current.find(item => item.id === key)?.id;
    run.timeline.forEach(item => { if (item.status === 'adopted') item.status = 'superseded'; });
    run.timeline.push({ id: productionId('ptimeline'), runId: run.id, taskId: task.id, version: run.timeline.length + 1,
      tracks: draft.tracks.map(track => ({ kind: track.kind, artifactIds: track.artifactKeys.map(resolve).filter((id): id is string => Boolean(id)) })),
      durationSec: draft.durationSec, status: 'adopted', createdAt: at });
  }

  private materializeDelivery(run: StoredProductionRun, task: ProductionTask, draft: DeliveryDraft, at: string) {
    const artifact = run.artifacts.find(item => item.taskId === task.id && item.metadata.key === draft.artifactKey)
      ?? run.artifacts.find(item => item.id === draft.artifactKey);
    if (!artifact || artifact.kind !== 'delivery' || !artifact.uri?.startsWith('/api/production-media/') || !artifact.sha256
      || !/^[a-f0-9]{64}$/u.test(artifact.sha256) || !draft.verified) {
      conflict('PRODUCTION_DELIVERY_NOT_VERIFIED', '成片必须是已校验的本地 MP4 媒体，不能把临时链接当作交付。');
    }
    run.delivery = { id: productionId('pdelivery'), runId: run.id, taskId: task.id, artifactId: artifact.id,
      status: 'ready', spec: { ratio: run.ratio, durationSec: draft.durationSec, container: 'mp4' }, verifiedAt: at, createdAt: at };
  }

  private materializeSpawnTasks(run: StoredProductionRun, parent: ProductionTask, drafts: SpawnTaskDraft[], at: string, beforeParent = false) {
    if (drafts.length > 500) conflict('PRODUCTION_TASK_EXPANSION_INVALID', '一次展开的子任务过多。');
    const keys = new Map<string, string>();
    for (const draft of drafts) {
      if (!/^[A-Za-z0-9_-]{1,100}$/u.test(draft.key) || keys.has(draft.key) || !draft.label.trim()
        || !draft.scope.id) {
        conflict('PRODUCTION_TASK_EXPANSION_INVALID', '动态任务定义不正确。');
      }
      keys.set(draft.key, `ptask_${canonicalDigest({ runId: run.id, parentTaskId: parent.id, key: draft.key }).slice(0, 32)}`);
    }
    const created: ProductionTask[] = drafts.map(draft => {
      const id = keys.get(draft.key)!;
      const defaultDeps = beforeParent ? [] : [parent.id];
      const dependencies = (draft.dependsOn?.length ? draft.dependsOn : defaultDeps).map(ref => keys.get(ref) ?? ref);
      if (dependencies.includes(id) || dependencies.some(dep => !run.tasks.some(task => task.id === dep) && ![...keys.values()].includes(dep))) {
        conflict('PRODUCTION_TASK_EXPANSION_INVALID', '动态任务依赖不存在或指向自身。');
      }
      const existing = run.tasks.find(task => task.id === id);
      const task: ProductionTask = { id, runId: run.id, stage: draft.stage, label: draft.label.trim(), scope: clone(draft.scope),
        status: draft.stage === 'director' && run.directorPolicy === 'never' ? 'skipped' : 'pending',
        dependencies, attemptCount: 0, maxAttempts: draft.maxAttempts ?? parent.maxAttempts,
        version: 0, blockingReason: null, inputManifest: [...clone(parent.inputManifest), {
          kind: 'dynamicScope', id: draft.scope.id, revisionId: draft.key,
          digest: canonicalDigest({ parent: parent.id, key: draft.key, scope: draft.scope }),
        }], createdAt: at, updatedAt: at };
      if (existing) {
        const comparable = ({ status: _s, attemptCount: _a, version: _v, blockingReason: _b,
          createdAt: _c, updatedAt: _u, ...rest }: ProductionTask) => rest;
        if (canonicalDigest(comparable(existing)) !== canonicalDigest(comparable(task))) {
          conflict('PRODUCTION_TASK_EXPANSION_CONFLICT', '同一子任务键被重放为不同定义。');
        }
        if (existing.status === 'superseded') {
          existing.status = existing.stage === 'director' && run.directorPolicy === 'never' ? 'skipped' : 'pending';
          existing.blockingReason = null; existing.version++; existing.updatedAt = at;
        }
        return existing;
      }
      return task;
    });
    const prospective = [...run.tasks, ...created.filter(task => !run.tasks.some(existing => existing.id === task.id))];
    this.assertAcyclic(prospective);
    for (const task of created) if (!run.tasks.some(existing => existing.id === task.id)) run.tasks.push(task);
    if (beforeParent) {
      for (const child of created) if (!parent.dependencies.includes(child.id)) parent.dependencies.push(child.id);
      this.assertAcyclic(run.tasks);
      return;
    }
    const sameStageChildren = created.filter(task => task.stage === parent.stage && task.scope.kind !== 'episode').map(task => task.id);
    if (parent.scope.kind === 'episode' && sameStageChildren.length) {
      const nextEpisodeTasks = run.tasks.filter(task => task.scope.kind === 'episode' && task.dependencies.includes(parent.id));
      for (const next of nextEpisodeTasks) for (const id of sameStageChildren) if (!next.dependencies.includes(id)) next.dependencies.push(id);
    }
    // Shot review tasks are real completion gates for episode composition.
    const shotReviews = created.filter(task => task.scope.kind === 'shot' && task.stage === 'review').map(task => task.id);
    const compose = run.tasks.find(task => task.stage === 'compose' && task.scope.kind === 'episode');
    if (compose) for (const id of shotReviews) if (!compose.dependencies.includes(id)) compose.dependencies.push(id);
    this.assertAcyclic(run.tasks);
  }

  private assertAcyclic(tasks: ProductionTask[]) {
    const byId = new Map(tasks.map(task => [task.id, task])); const visiting = new Set<string>(); const visited = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) conflict('PRODUCTION_DAG_CYCLE', '动态任务产生了循环依赖。');
      if (visited.has(id)) return; const task = byId.get(id);
      if (!task) conflict('PRODUCTION_TASK_EXPANSION_INVALID', '动态任务依赖不存在。');
      visiting.add(id); for (const dependency of task.dependencies) visit(dependency);
      visiting.delete(id); visited.add(id);
    };
    for (const task of tasks) visit(task.id);
  }

  private blockPrepare(run: StoredProductionRun, task: ProductionTask) {
    const at = this.timestamp(); task.status = 'waitingHuman'; task.version++; task.updatedAt = at;
    task.blockingReason = { code: 'EXECUTOR_PREPARE_FAILED', message: '执行器未能安全准备输入；没有发起外部请求。' };
    this.addIssue(run, task, { code: 'EXECUTOR_PREPARE_FAILED', title: '执行准备失败', message: task.blockingReason.message,
      severity: 'error', recommendedActions: ['检查输入版本与执行器配置'] }, at);
    this.refreshRunStatus(run); return this.save(run, 'production.task.prepare_failed', { taskId: task.id });
  }

  private checkpoint(run: StoredProductionRun, stage: ProductionStage) {
    if (stage === 'prepare') return false;
    if (run.automationMode === 'coDirector') return true;
    return run.automationMode === 'checkpoints' && ['breakdown', 'assets', 'storyboard', 'deliver'].includes(stage);
  }
  private validateReview(run: StoredProductionRun, task: ProductionTask, input: ProductionReviewInput) {
    if (input.decision === 'approve' && (task.status !== 'waitingHuman' || task.blockingReason?.code !== 'CHECKPOINT_REVIEW_REQUIRED')) {
      conflict('PRODUCTION_APPROVAL_NOT_ALLOWED', '只能通过已产生真实输出的人工检查点，不能跳过缺失的执行器。');
    }
    if (input.decision === 'selectCandidate') {
      if (task.status !== 'waitingHuman' || task.blockingReason?.code !== 'CANDIDATE_SELECTION_REQUIRED') {
        conflict('PRODUCTION_CANDIDATE_SELECTION_CLOSED', '候选选择已关闭；如需更换，请从相应任务发起局部重做。');
      }
      const set = input.candidateId ? run.candidateSets.find(item => item.taskId === task.id
        && item.candidates.some(candidate => candidate.id === input.candidateId)) : null;
      if (!set || set.status === 'superseded') conflict('PRODUCTION_CANDIDATE_NOT_FOUND', '候选不存在或已失效。');
      if (set.status !== 'open') conflict('PRODUCTION_CANDIDATE_SELECTION_CLOSED', '该候选组已经选定，不能覆盖原选择。');
    }
    if (input.decision === 'resolveIssue') {
      const issue = input.issueId ? run.issues.find(item => item.id === input.issueId
        && item.taskId === task.id && item.status === 'open') : null;
      if (!issue) conflict('PRODUCTION_ISSUE_NOT_FOUND', '待处理问题不存在或已关闭。');
      if (issueRequiresWorkflow(task, issue)) conflict('PRODUCTION_ISSUE_RESOLUTION_NOT_ALLOWED',
        '该问题是生产门禁，请使用审批、候选选择、局部重试或外部对账，不能直接标记已解决。');
    }
    if (input.decision === 'reject' && !['waitingHuman', 'succeeded'].includes(task.status)) {
      conflict('PRODUCTION_REJECTION_NOT_ALLOWED', '当前任务没有可驳回的成果。');
    }
  }
  private selectCandidate(run: StoredProductionRun, task: ProductionTask, input: ProductionReviewInput, at: string) {
    if (!input.candidateId) conflict('PRODUCTION_CANDIDATE_REQUIRED', '请选择具体候选。');
    const set = run.candidateSets.find(item => item.taskId === task.id && item.candidates.some(candidate => candidate.id === input.candidateId));
    if (!set || set.status === 'superseded') conflict('PRODUCTION_CANDIDATE_NOT_FOUND', '候选不存在或已失效。');
    if (set.status !== 'open') conflict('PRODUCTION_CANDIDATE_SELECTION_CLOSED', '该候选组已经选定，不能覆盖原选择。');
    set.selectedCandidateId = input.candidateId; set.status = 'selected';
    for (const candidate of set.candidates) candidate.status = candidate.id === input.candidateId ? 'selected' : 'rejected';
    this.resolveTaskIssues(run, task.id, at, ['CANDIDATE_SELECTION_REQUIRED']);
    if (run.candidateSets.filter(item => item.taskId === task.id && item.status !== 'superseded').every(item => item.status === 'selected')) {
      task.status = 'succeeded'; task.blockingReason = null; task.version++; task.updatedAt = at;
    }
  }
  private approveCheckpoint(run: StoredProductionRun, task: ProductionTask, _input: ProductionReviewInput, at: string) {
    if (task.status !== 'waitingHuman' || task.blockingReason?.code !== 'CHECKPOINT_REVIEW_REQUIRED') {
      conflict('PRODUCTION_APPROVAL_NOT_ALLOWED', '只能通过已产生真实输出的人工检查点，不能跳过缺失的执行器。');
    }
    this.resolveTaskIssues(run, task.id, at, ['CHECKPOINT_REVIEW_REQUIRED']);
    task.status = 'succeeded'; task.blockingReason = null; task.version++; task.updatedAt = at;
  }
  private resolveIssue(run: StoredProductionRun, task: ProductionTask, input: ProductionReviewInput, at: string) {
    if (!input.issueId) conflict('PRODUCTION_ISSUE_REQUIRED', '请指定要处理的问题。');
    const issue = run.issues.find(item => item.id === input.issueId && item.taskId === task.id && item.status === 'open');
    if (!issue) conflict('PRODUCTION_ISSUE_NOT_FOUND', '待处理问题不存在或已关闭。');
    if (issueRequiresWorkflow(task, issue)) conflict('PRODUCTION_ISSUE_RESOLUTION_NOT_ALLOWED',
      '该问题是生产门禁，请使用审批、候选选择、局部重试或外部对账，不能直接标记已解决。');
    issue.status = 'resolved'; issue.resolvedAt = at;
  }
  private rejectTask(run: StoredProductionRun, task: ProductionTask, input: ProductionReviewInput, at: string) {
    if (!['waitingHuman', 'succeeded'].includes(task.status)) conflict('PRODUCTION_REJECTION_NOT_ALLOWED', '当前任务没有可驳回的成果。');
    this.invalidateFrom(run, task.id, at); task.status = 'waitingHuman'; task.version++; task.updatedAt = at;
    task.blockingReason = { code: 'USER_REJECTED', message: input.feedback || '用户驳回了当前成果。' };
    this.addIssue(run, task, { code: 'USER_REJECTED', title: '成果已驳回', message: task.blockingReason.message,
      severity: 'warning', recommendedActions: ['修改最小上游输入后局部重试'] }, at);
  }

  private invalidateFrom(run: StoredProductionRun, taskId: string, at: string) {
    const root = run.tasks.find(task => task.id === taskId);
    const affected = new Set([taskId]); let changed = true;
    while (changed) { changed = false; for (const task of run.tasks) if (!affected.has(task.id) && task.dependencies.some(id => affected.has(id))) {
      affected.add(task.id); changed = true;
    } }
    for (const item of run.tasks.filter(task => affected.has(task.id) && task.id !== taskId)) {
      const obsoleteDynamicBranch = root?.scope.kind === 'episode'
        && item.inputManifest.some(entry => entry.kind === 'dynamicScope');
      item.status = obsoleteDynamicBranch ? 'superseded'
        : item.stage === 'director' && run.directorPolicy === 'never' ? 'skipped' : 'pending';
      item.blockingReason = null; item.version++; item.updatedAt = at;
    }
    run.artifacts.filter(item => affected.has(item.taskId) && item.status === 'current').forEach(item => { item.status = 'superseded'; });
    run.candidateSets.filter(item => affected.has(item.taskId) && item.status !== 'superseded').forEach(item => {
      item.status = 'superseded'; item.candidates.forEach(candidate => { candidate.status = 'superseded'; });
    });
    run.timeline.filter(item => affected.has(item.taskId) && item.status !== 'superseded').forEach(item => { item.status = 'superseded'; });
    if (run.delivery && affected.has(run.delivery.taskId)) run.delivery = null;
    for (const issue of run.issues.filter(item => item.taskId && affected.has(item.taskId) && item.status === 'open')) {
      issue.status = 'resolved'; issue.resolvedAt = at;
    }
  }
  private promoteReady(run: StoredProductionRun) {
    if (run.pausedAt) return false;
    let changed = false;
    for (const task of run.tasks.filter(item => item.status === 'pending')) {
      if (task.dependencies.every(id => { const dependency = run.tasks.find(item => item.id === id); return Boolean(dependency && dependencyDone(dependency)); })) {
        task.status = 'ready'; task.version++; task.updatedAt = this.timestamp(); changed = true;
      }
    }
    return changed;
  }
  private refreshRunStatus(run: StoredProductionRun) {
    if (run.pausedAt) { run.status = 'paused'; return; }
    if (run.status === 'pausedBudget') return;
    const required = run.tasks.filter(task => task.status !== 'skipped' && task.status !== 'superseded');
    const allDone = required.every(task => task.status === 'succeeded');
    const episodePass = run.qualityChecks.some(check => check.level === 'episode' && check.result === 'pass');
    if (allDone && run.delivery?.status === 'ready' && run.delivery.verifiedAt && episodePass) { run.status = 'completed'; return; }
    if (allDone) { run.status = run.artifacts.length ? 'partial' : 'failed'; return; }
    if (run.tasks.some(task => ['running', 'waitingExternal', 'ready'].includes(task.status))) { run.status = 'running'; return; }
    if (run.tasks.some(task => task.status === 'reconciling')) { run.status = 'reconciling'; return; }
    if (run.tasks.some(task => task.status === 'waitingHuman')) { run.status = 'waitingHuman'; return; }
    if (run.tasks.some(task => task.status === 'failed')) { run.status = run.artifacts.length ? 'partial' : 'failed'; return; }
    run.status = 'queued';
  }
  private addIssue(run: StoredProductionRun, task: ProductionTask, draft: IssueDraft, at: string) {
    const same = run.issues.find(issue => issue.taskId === task.id && issue.code === draft.code && issue.status === 'open');
    if (same) return same;
    const issue: ProductionIssue = { id: productionId('pissue'), runId: run.id, taskId: task.id, stage: task.stage,
      scope: clone(task.scope), severity: draft.severity ?? 'warning', status: 'open', code: draft.code,
      title: draft.title, message: draft.message, impact: [...(draft.impact ?? [task.label])],
      recommendedActions: [...(draft.recommendedActions ?? [])], estimatedAdditionalCostMicros: draft.estimatedAdditionalCostMicros ?? null,
      createdAt: at, resolvedAt: null };
    run.issues.push(issue); return issue;
  }
  private resolveTaskIssues(run: StoredProductionRun, taskId: string, at: string, codes?: string[]) {
    for (const issue of run.issues.filter(item => item.taskId === taskId && item.status === 'open' && (!codes || codes.includes(item.code)))) {
      issue.status = 'resolved'; issue.resolvedAt = at;
    }
  }
  private activeOperation(run: StoredProductionRun, taskId: string) {
    return run.externalOperations.filter(item => item.taskId === taskId && !['succeeded', 'failed', 'abandoned'].includes(item.status)).at(-1) ?? null;
  }
  private spent(run: StoredProductionRun) { return run.budgetLedger.filter(item => item.kind === 'charge').reduce((sum, item) => sum + item.amountMicros, 0); }
  private reserved(run: StoredProductionRun) { return Math.max(0, run.budgetLedger.reduce((sum, item) => sum
    + (item.kind === 'reserve' ? item.amountMicros : 0) - (item.kind === 'charge' || item.kind === 'release' ? item.amountMicros : 0), 0)); }
  private budget(run: StoredProductionRun, taskId: string | null, attemptId: string | null, kind: BudgetEntry['kind'], amountMicros: number, note: string, at: string): BudgetEntry {
    return { id: productionId('pbudget'), runId: run.id, taskId, attemptId, kind, amountMicros, currency: run.currency, note, createdAt: at };
  }
  private charge(run: StoredProductionRun, task: ProductionTask, attempt: TaskAttempt, actual: number, at: string, terminalOutcome: boolean, estimated = false) {
    const operation = this.activeOperation(run, task.id); const reserved = this.reservedForAttempt(run, task, attempt);
    const amount = estimated ? reserved : actual;
    if (terminalOutcome && amount) run.budgetLedger.push({ ...this.budget(run, task.id, attempt.id, 'charge', amount,
      estimated ? '抽帧评估按预留上限估算入账（供应商实付未知）' : '实际费用', at),
      ...(estimated ? { basis: 'frameAssessmentCeiling' as const } : {}) });
    if (terminalOutcome && reserved > amount) run.budgetLedger.push(this.budget(run, task.id, attempt.id, 'release', reserved - amount, '释放未使用预留', at));
    if (operation) operation.actualCostMicros = terminalOutcome && !estimated ? amount : null;
  }
  private reservedForAttempt(run: StoredProductionRun, task: ProductionTask, attempt: TaskAttempt) {
    const operation = this.activeOperation(run, task.id);
    return operation?.estimatedCostMicros ?? run.budgetLedger.filter(item => item.attemptId === attempt.id && item.kind === 'reserve')
      .reduce((sum, item) => sum + item.amountMicros, 0);
  }
  private actualCostAuthorized(reported: number, reserved: number) {
    return Number.isSafeInteger(reported) && reported >= 0 && reported <= reserved;
  }
  private async blockUnauthorizedActualCost(run: StoredProductionRun, task: ProductionTask, attempt: TaskAttempt,
    operation: ReturnType<ProductionService['activeOperation']>, reported: number, reserved: number, at: string) {
    attempt.endedAt = at; attempt.status = 'failed';
    attempt.error = { code: 'PRODUCTION_ACTUAL_COST_UNAUTHORIZED',
      message: '执行器报告的实际费用超过本轮持久化预留，未落账也未将任务标记为完成。' };
    if (operation) { operation.status = 'unknown'; operation.actualCostMicros = null; operation.updatedAt = at; }
    task.status = 'waitingHuman'; task.blockingReason = clone(attempt.error); task.version++; task.updatedAt = at;
    this.addIssue(run, task, { code: attempt.error.code, title: '实际费用超出授权', message: attempt.error.message,
      severity: 'error', estimatedAdditionalCostMicros: Number.isSafeInteger(reported) && reported >= 0
        ? Math.max(0, reported - reserved) : null,
      recommendedActions: ['对账供应商账单和原任务', '不要重复提交', '需要更高预算时创建新运行'] }, at);
    this.refreshRunStatus(run);
    await this.save(run, 'production.task.actual_cost_unauthorized', { taskId: task.id, reservedMicros: reserved });
  }
  private async requireRun(id: string) { const run = await this.repository.get(id); return run ?? notFound(); }
  private async save(run: StoredProductionRun, eventType: string, payload: Record<string, unknown>) {
    const at = this.timestamp(); run.updatedAt = at;
    run.outbox.push({ id: productionId('pevent'), runId: run.id, sequence: run.outbox.length + 1,
      type: eventType, payload: clone(payload), createdAt: at });
    return this.repository.replace(run, run.version);
  }
  private timestamp() { return this.now().toISOString(); }
}

/** Redact secrets, URLs and control characters before an executor error reaches the UI. */
function redactExecutorError(value: unknown): string {
  if (!(value instanceof Error) || !value.message) return '';
  return value.message.replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\b(?:Bearer\s+)?(?:MAAS|sk-|ak-)[A-Za-z0-9._-]{8,}\b/gi, '[REDACTED]')
    .replace(/https:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/\s+/g, ' ').trim().slice(0, 300);
}
