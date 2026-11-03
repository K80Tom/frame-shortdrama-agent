const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  fullChainExecutors, openHarness, driveUntil, outboxStats, runRow, stubExecutor,
} = require('./support/production-e2e-harness.cjs');

if (!process.env.DATABASE_URL) {
  test('production e2e matrix requires DATABASE_URL', { skip: 'Set DATABASE_URL before test:db.' }, () => {});
} else {
  /** Every persisted failure record must stay joinable to run/task/operation identities. */
  function assertCorrelated(run) {
    for (const event of run.outbox) assert.equal(event.runId, run.id);
    for (const attempt of run.attempts) {
      assert.equal(attempt.runId, run.id);
      assert.match(attempt.taskId, /^ptask_[a-f0-9]{32}$/u);
    }
    for (const operation of run.externalOperations) {
      assert.equal(operation.runId, run.id);
      assert.match(operation.taskId, /^ptask_[a-f0-9]{32}$/u);
      assert.ok(operation.operationKey);
    }
  }
  const stageTask = (run, stage, kind = 'episode') => run.tasks.find(task => task.stage === stage && task.scope.kind === kind);

  test('normal chain completes once, survives a restart and replays without new events', async () => {
    const executors = fullChainExecutors();
    const harness = await openHarness({ title: 'e2e-normal', executors });
    try {
      const input = harness.input();
      const created = await harness.service.create(input);
      await harness.service.tick(created.id);

      const restarted = harness.makeService(executors);
      const run = await driveUntil(restarted, created.id, candidate => candidate.status === 'completed');
      assert.equal(run.status, 'completed');
      assert.equal(run.delivery?.status, 'ready');
      assert.ok(run.delivery.verifiedAt);
      assert.equal(run.summary.shots.total, 2);
      assert.equal(run.summary.shots.completed, 2);
      assert.equal(run.summary.issues.open, 0);
      assert.equal(run.tasks.filter(task => task.status === 'superseded').length, 0);
      assert.ok(run.tasks.every(task => ['succeeded', 'skipped'].includes(task.status)), 'no unfinished task in a completed run');
      assert.ok(run.artifacts.some(artifact => artifact.kind === 'delivery' && artifact.status === 'current'));
      assert.match(run.createdAt, /^2026-11-03T12:00:0\d\.000Z$/u, 'clock is frozen to the matrix epoch');
      assertCorrelated(run);

      const stats = await outboxStats(harness.database, run.id);
      assert.equal(stats.count, run.outbox.length, 'every committed transition has exactly one outbox row');
      assert.equal(stats.max - stats.min + 1, stats.count, 'outbox sequence has no gaps');
      assert.equal(stats.distinct_sequences, stats.count);
      const row = await runRow(harness.database, run.id);
      assert.equal(row.version, run.version);
      assert.equal(row.status, 'completed');

      const replay = await restarted.create(input);
      assert.equal(replay.id, run.id, 'idempotent replay keeps the original aggregate');
      const after = await outboxStats(harness.database, run.id);
      assert.equal(after.count, stats.count, 'replay does not append a second event stream');
      assert.equal((await runRow(harness.database, run.id)).version, run.version);
    } finally { await harness.close(); }
  });

  test('a retryable stage timeout only invalidates its descendants and recovers on the next attempt', async () => {
    const callsByTask = new Map();
    const assets = stubExecutor('assets', {
      execute: ({ task }) => {
        const call = (callsByTask.get(task.id) ?? 0) + 1;
        callsByTask.set(task.id, call);
        return task.scope.kind === 'episode' && call === 1
          ? { state: 'failed', code: 'ASSET_MATCH_TIMEOUT', message: '供应商响应超时，未进入付费提交。', retryable: true }
          : { state: 'succeeded' };
      },
    });
    const harness = await openHarness({ title: 'e2e-timeout', executors: fullChainExecutors({ assets }) });
    try {
      const created = await harness.service.create(harness.input());
      let run = await driveUntil(harness.service, created.id, candidate => stageTask(candidate, 'assets').status === 'waitingHuman');
      const assetsTask = stageTask(run, 'assets');
      assert.equal(assetsTask.status, 'waitingHuman');
      assert.equal(stageTask(run, 'prepare').status, 'succeeded');
      assert.equal(stageTask(run, 'breakdown').status, 'succeeded');
      assert.equal(stageTask(run, 'storyboard').status, 'pending');
      assert.equal(stageTask(run, 'assets').attemptCount, 1);
      assert.equal(run.attempts.filter(attempt => attempt.taskId === assetsTask.id).length, 1);
      const attempt = run.attempts.find(item => item.taskId === assetsTask.id);
      assert.equal(attempt.status, 'failed');
      assert.equal(attempt.error.code, 'ASSET_MATCH_TIMEOUT');
      assert.match(attempt.id, /^pattempt_[a-f0-9]{32}$/u);
      const issue = run.issues.find(item => item.code === 'ASSET_MATCH_TIMEOUT');
      assert.ok(issue);
      assert.equal(issue.taskId, assetsTask.id, 'failure evidence keeps the task id');
      assert.equal(issue.status, 'open');
      assert.ok(run.outbox.some(event => event.type === 'production.task.finished'
        && event.payload.taskId === assetsTask.id && event.payload.status === 'waitingHuman'),
      'the failure transition is recorded against the task');

      run = await harness.service.action(run.id, { type: 'retryTask', taskId: assetsTask.id, reason: '超时后重试' });
      assert.equal(stageTask(run, 'prepare').status, 'succeeded', 'completed ancestors survive');
      assert.equal(stageTask(run, 'breakdown').status, 'succeeded');
      assert.equal(stageTask(run, 'assets').status, 'ready');
      assert.equal(stageTask(run, 'storyboard').status, 'pending', 'retry resets only descendants');

      run = await driveUntil(harness.service, run.id, candidate => candidate.status === 'completed');
      assert.equal(run.status, 'completed');
      assert.equal(callsByTask.get(assetsTask.id), 2, 'the episode task ran exactly twice');
      const attempts = run.attempts.filter(item => item.taskId === assetsTask.id);
      assert.deepEqual(attempts.map(item => item.number), [1, 2]);
      assert.ok(attempts.every(item => item.status === 'succeeded' || item.status === 'failed'));
      assertCorrelated(run);
    } finally { await harness.close(); }
  });

  test('an unknown external submission is gated for humans and never resubmitted after restart', async () => {
    const videoCalls = new Map();
    const video = stubExecutor('video', {
      estimateCostMicros: 500, requiresPaid: true, provider: 'stub-media',
      execute: ({ task }) => {
        videoCalls.set(task.id, (videoCalls.get(task.id) ?? 0) + 1);
        return { state: 'waitingExternal', providerTaskId: 'provider-video-1' };
      },
    });
    const harness = await openHarness({ title: 'e2e-unknown', executors: fullChainExecutors({ video }) });
    try {
      const created = await harness.service.create(harness.input());
      let run = await driveUntil(harness.service, created.id, candidate => stageTask(candidate, 'video').status === 'waitingExternal');
      const externalVideoTask = stageTask(run, 'video');
      assert.equal(videoCalls.get(externalVideoTask.id), 1);
      assert.equal(run.externalOperations.length, 1);
      assert.equal(run.externalOperations[0].status, 'submitted');
      assert.equal(run.externalOperations[0].providerTaskId, 'provider-video-1');

      run = await driveUntil(harness.service, created.id, candidate => stageTask(candidate, 'video').status === 'waitingHuman', { maxTicks: 10 });
      const videoTask = stageTask(run, 'video');
      assert.equal(videoTask.status, 'waitingHuman');
      assert.equal(videoTask.blockingReason.code, 'EXTERNAL_RECONCILIATION_REQUIRED');
      const operation = run.externalOperations[0];
      assert.equal(operation.status, 'unknown');
      assert.equal(operation.actualCostMicros, null);
      assert.match(operation.operationKey, /^[a-f0-9]{64}$/u, 'paid intent keeps its idempotency key');
      assert.ok(run.outbox.some(event => event.type === 'production.task.reconciliation_blocked'
        && event.payload.taskId === videoTask.id));

      const restarted = harness.makeService(fullChainExecutors({ video }));
      for (let index = 0; index < 3; index++) await restarted.tick(created.id);
      run = await restarted.get(created.id);
      assert.equal(videoCalls.get(externalVideoTask.id), 1, 'restart never re-executes the unknown task');
      assert.equal(run.externalOperations.filter(item => item.operationKey === operation.operationKey).length, 1);
      const operationKeys = run.externalOperations.map(item => item.operationKey);
      assert.equal(new Set(operationKeys).size, operationKeys.length, 'each external operation keeps a unique intent key');
      assert.equal(stageTask(run, 'video').status, 'waitingHuman');
      assert.equal(run.externalOperations[0].status, 'unknown');

      await assert.rejects(restarted.action(run.id, { type: 'retryTask', taskId: videoTask.id, reason: '强行重试' }),
        error => error.code === 'PRODUCTION_EXTERNAL_OPERATION_UNKNOWN');
      assert.equal(videoCalls.get(externalVideoTask.id), 1);
      assertCorrelated(run);
    } finally { await harness.close(); }
  });

  test('budget shortage pauses before payment and raising the budget pays exactly once across restarts', async () => {
    const breakdown = stubExecutor('breakdown', {
      estimateCostMicros: 2_000_000, requiresPaid: true, provider: 'stub-model',
      execute: () => ({ state: 'succeeded', actualCostMicros: 2_000_000, artifacts: [] }),
    });
    const harness = await openHarness({ title: 'e2e-budget', executors: fullChainExecutors({ breakdown }) });
    try {
      const created = await harness.service.create(harness.input({ budgetMicros: 1_000_000 }));
      let run = await driveUntil(harness.service, created.id, candidate => candidate.status === 'pausedBudget');
      assert.equal(run.status, 'pausedBudget');
      assert.equal(breakdown.counts().executes, 0, 'no paid call happens before the budget gate');
      assert.equal(stageTask(run, 'breakdown').attemptCount, 0);
      assert.equal(run.summary.budget.limitMicros, 1_000_000);
      assert.equal(run.summary.budget.spentMicros, 0);
      const issue = run.issues.find(item => item.code === 'PRODUCTION_BUDGET_EXCEEDED');
      assert.ok(issue);
      assert.equal(issue.estimatedAdditionalCostMicros, 1_000_000);

      const restarted = harness.makeService(fullChainExecutors({ breakdown }));
      await restarted.tick(created.id);
      await restarted.tick(created.id);
      run = await restarted.get(created.id);
      assert.equal(run.status, 'pausedBudget');
      assert.equal(breakdown.counts().executes, 0);

      run = await restarted.action(created.id, { type: 'raiseBudget', budgetMicros: 5_000_000, reason: '离线矩阵授权' });
      assert.equal(run.status, 'running');
      assert.equal(run.summary.budget.limitMicros, 5_000_000);
      run = await driveUntil(restarted, created.id, candidate => candidate.status === 'completed');
      assert.equal(run.status, 'completed');
      assert.equal(breakdown.counts().executes, 1, 'exactly one paid execution');
      assert.equal(run.summary.budget.spentMicros, 2_000_000);
      assert.equal(run.summary.budget.reservedMicros, 0, 'no reservation leaks after settlement');
      assert.equal(run.budgetLedger.filter(entry => entry.kind === 'reserve').length, 1);
      assert.equal(run.budgetLedger.filter(entry => entry.kind === 'charge').length, 1);
      assert.equal(run.budgetLedger.filter(entry => entry.kind === 'release').length, 0);
      const operation = run.externalOperations[0];
      assert.equal(operation.status, 'succeeded');
      assert.equal(operation.actualCostMicros, 2_000_000);

      const again = harness.makeService(fullChainExecutors({ breakdown }));
      await again.tick(created.id);
      assert.equal(breakdown.counts().executes, 1, 'post-completion restart does not re-run a paid stage');
      assertCorrelated(run);
    } finally { await harness.close(); }
  });

  test('a human checkpoint locks the produced version against later ticks and late results', async () => {
    const executors = fullChainExecutors();
    const harness = await openHarness({ title: 'e2e-checkpoint', executors });
    try {
      const created = await harness.service.create(harness.input({ automationMode: 'checkpoints' }));
      let run = await driveUntil(harness.service, created.id,
        candidate => stageTask(candidate, 'breakdown').blockingReason?.code === 'CHECKPOINT_REVIEW_REQUIRED');
      const breakdownTask = stageTask(run, 'breakdown');
      assert.equal(breakdownTask.status, 'waitingHuman');
      assert.equal(run.scriptVersionId, harness.scriptVersionId, 'the adopted script version is the one under production');
      const lockedVersion = breakdownTask.version;
      const artifactCount = run.artifacts.length;
      const breakdownExecutor = executors.find(executor => executor.stage === 'breakdown');
      assert.equal(breakdownExecutor.counts().executes, 1);

      for (let index = 0; index < 3; index++) await harness.service.tick(created.id);
      run = await harness.service.get(created.id);
      const unchanged = stageTask(run, 'breakdown');
      assert.equal(unchanged.status, 'waitingHuman', 'the human gate is not bypassed by background ticks');
      assert.equal(unchanged.version, lockedVersion, 'a waiting checkpoint is not rewritten by late ticks');
      assert.equal(run.artifacts.length, artifactCount, 'produced artifacts are not duplicated');
      assert.equal(run.scriptVersionId, harness.scriptVersionId, 'late ticks cannot replace the adopted script version');
      assert.equal(breakdownExecutor.counts().executes, 1, 'no late result replaces the locked version');

      run = await harness.service.review(run.id, { taskId: unchanged.id, decision: 'approve',
        candidateId: null, issueId: null, feedback: '离线确认' });
      assert.equal(stageTask(run, 'breakdown').status, 'succeeded');
      assert.equal(breakdownExecutor.counts().executes, 1);
      run = await driveUntil(harness.service, created.id, candidate => candidate.status === 'completed', { approveCheckpoints: true });
      assert.equal(run.status, 'completed');
      assert.equal(run.delivery.status, 'ready');
      const deliverTask = stageTask(run, 'deliver');
      await assert.rejects(harness.service.review(run.id, { taskId: deliverTask.id, decision: 'reject',
        candidateId: null, issueId: null, feedback: '迟到覆盖' }), error => error.code === 'PRODUCTION_REVIEW_NOT_ALLOWED');
      assert.equal((await harness.service.get(run.id)).delivery.status, 'ready');
      assertCorrelated(run);
    } finally { await harness.close(); }
  });

  test('two schedulers racing on one ready task produce one attempt and one paid execution', async () => {
    const breakdown = stubExecutor('breakdown', {
      estimateCostMicros: 100, requiresPaid: true, provider: 'stub-model',
      execute: () => ({ state: 'succeeded', actualCostMicros: 100 }),
    });
    const executors = fullChainExecutors({ breakdown });
    const harness = await openHarness({ title: 'e2e-cas', executors });
    try {
      const first = harness.makeService(executors);
      const second = harness.makeService(executors);
      const created = await first.create(harness.input());
      await first.tick(created.id);
      const before = await runRow(harness.database, created.id);
      await Promise.all([first.tick(created.id), second.tick(created.id)]);
      let run = await first.get(created.id);
      const breakdownTask = stageTask(run, 'breakdown');
      assert.equal(run.attempts.filter(attempt => attempt.taskId === breakdownTask.id).length, 1,
        'concurrent claims cannot duplicate an attempt');
      assert.equal(breakdown.counts().executes, 1, 'concurrent claims cannot duplicate a paid call');
      assert.equal(run.externalOperations.length, 1);
      const after = await runRow(harness.database, created.id);
      assert.ok(after.version - before.version >= 1);
      assert.equal(after.version, run.version);
      const started = await harness.database.query(`SELECT COUNT(*)::int AS count FROM production_outbox_events
        WHERE run_id=$1 AND event_type='production.task.started' AND payload_json->>'taskId'=$2`, [run.id, breakdownTask.id]);
      assert.equal(started.rows[0].count, 1, 'the losing scheduler writes no claim event');

      run = await driveUntil(first, created.id, candidate => candidate.status === 'completed');
      assert.equal(run.status, 'completed');
      assert.equal(breakdown.counts().executes, 1);
      assertCorrelated(run);
    } finally { await harness.close(); }
  });

  test('an unfinished delivery never turns a run into success', async () => {
    const deliver = stubExecutor('deliver', {
      execute: () => ({ state: 'failed', code: 'DELIVERY_SHA256_MISMATCH', message: '成片摘要与校验记录不一致。', retryable: false }),
    });
    const harness = await openHarness({ title: 'e2e-unsuccessful', executors: fullChainExecutors({ deliver }) });
    try {
      const created = await harness.service.create(harness.input());
      const run = await driveUntil(harness.service, created.id,
        candidate => ['failed', 'partial'].includes(candidate.status));
      assert.ok(['failed', 'partial'].includes(run.status), 'an unfinished delivery can never be completed');
      assert.notEqual(run.status, 'completed');
      assert.equal(run.delivery, null, 'no delivery record is fabricated');
      assert.equal(run.summary.tasks.failed >= 1, true);
      assert.ok(run.summary.tasks.completed < run.summary.tasks.total);
      const deliverTask = stageTask(run, 'deliver');
      assert.equal(deliverTask.status, 'failed');
      const attempt = run.attempts.find(item => item.taskId === deliverTask.id);
      assert.equal(attempt.status, 'failed');
      assert.equal(attempt.error.code, 'DELIVERY_SHA256_MISMATCH');
      const issue = run.issues.find(item => item.code === 'DELIVERY_SHA256_MISMATCH');
      assert.equal(issue.severity, 'error');
      assert.equal(issue.status, 'open');
      const persisted = await runRow(harness.database, run.id);
      assert.equal(persisted.status, run.status);
      assert.notEqual(persisted.status, 'completed');
      assertCorrelated(run);
    } finally { await harness.close(); }
  });
}
