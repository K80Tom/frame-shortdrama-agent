const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');

const { MemoryOutboxTaskStore, OutboxTaskConsumer, OutboxTaskError, outboxRetryDelayMs } =
  require('../dist/production/outbox');

const WORKSPACE = `ws_${randomBytes(16).toString('hex')}`;
const USER = `usr_${randomBytes(16).toString('hex')}`;
const TENANT = { userId: USER, workspaceId: WORKSPACE, role: 'member', requestId: 'worker:test' };

function createHarness({ retryBaseMs = 1000, maxAttempts = 3 } = {}) {
  const clock = { value: 1_700_000_000_000 };
  const now = () => new Date(clock.value).toISOString();
  const store = new MemoryOutboxTaskStore({ now: () => clock.value });
  const database = {
    runAsSystem: (_reason, work) => work(),
    runWithTenant: (_tenant, work) => work(),
  };
  let executions = 0;
  const handler = {
    taskType: 'runtime.smoke',
    async execute({ task }) {
      executions += 1;
      if (task.payload.fail === true) throw new Error('handler forced failure');
      return { echo: task.payload.message ?? '', processedAt: now() };
    },
  };
  const consumer = new OutboxTaskConsumer({
    database,
    store,
    tenantResolver: { resolve: async () => TENANT },
    handlers: [handler],
    ownerInstanceId: `wkri_${randomBytes(16).toString('hex')}`,
    consumerName: 'main-worker',
    batchSize: 5,
    pollIntervalMs: 50,
    retryBaseMs,
    claimLeaseMs: 30_000,
  });
  return { clock, now, store, database, consumer, executions: () => executions };
}

test('提交→领取→投递全链路：幂等键去重、消费者记录与幂等跳过', async () => {
  const harness = createHarness();
  const { store, consumer, now } = harness;
  const first = await store.append({
    taskType: 'runtime.smoke', idempotencyKey: 'cli-outbox-demo-1',
    payload: { message: 'hello' }, workspaceId: WORKSPACE,
  });
  const duplicate = await store.append({
    taskType: 'runtime.smoke', idempotencyKey: 'cli-outbox-demo-1',
    payload: { message: 'hello' }, workspaceId: WORKSPACE,
  });
  assert.equal(duplicate.taskId, first.taskId, '同工作区同幂等键必须返回既有任务');
  const outcome = await consumer.pollOnce();
  assert.deepEqual({ claimed: outcome.claimed, delivered: outcome.delivered, skipped: outcome.skipped },
    { claimed: 1, delivered: 1, skipped: 0 });
  assert.equal(harness.executions(), 1);
  const delivered = await store.getTask({ taskId: first.taskId, workspaceId: WORKSPACE });
  assert.equal(delivered.state, 'delivered');
  assert.ok(delivered.deliveredAt);
  const record = await store.getConsumerRecord({ consumerName: 'main-worker', taskId: first.taskId });
  assert.equal(record.result.echo, 'hello');
  assert.equal(record.workspaceId, WORKSPACE);
  // 重放已交付任务：消费者记录命中 → 跳过副作用，仅补齐投递状态。
  const replay = await store.requeueForReplay({
    replayId: `rply_${randomBytes(16).toString('hex')}`, requestedBy: 'tester', reason: '演练重放',
    workspaceId: WORKSPACE, now: now(),
  });
  assert.deepEqual({ scanned: replay.scanned, requeued: replay.requeued }, { scanned: 1, requeued: 1 });
  const replayOutcome = await consumer.pollOnce();
  assert.equal(replayOutcome.skipped, 1, '已应用的任务重放时必须幂等跳过');
  assert.equal(harness.executions(), 1, '重放不得重复执行副作用');
  const replayRun = await store.getReplayRun({ replayId: replay.replayId });
  assert.equal(replayRun.reason, '演练重放');
});

test('领取 CAS 与 fencing：旧实例迟到的完成投递必须被拒绝', async () => {
  const harness = createHarness();
  const { store, clock } = harness;
  const task = await store.append({
    taskType: 'runtime.smoke', idempotencyKey: 'fencing-case-1',
    payload: {}, workspaceId: WORKSPACE,
  });
  const workerA = `wkri_${randomBytes(16).toString('hex')}`;
  const claimedByA = await store.claimBatch({ workerId: workerA, batchSize: 1, leaseMs: 30_000, now: harness.now() });
  assert.equal(claimedByA[0].taskId, task.taskId);
  assert.equal(claimedByA[0].fencingToken, 1);
  // A 崩溃不再续约：租约过期后被回收，B 以更高 fencing 接管。
  clock.value += 60_000;
  assert.equal(await store.recoverExpiredLeases({ now: harness.now() }), 1);
  const workerB = `wkri_${randomBytes(16).toString('hex')}`;
  const claimedByB = await store.claimBatch({ workerId: workerB, batchSize: 1, leaseMs: 30_000, now: harness.now() });
  assert.equal(claimedByB[0].fencingToken, 2);
  await assert.rejects(() => store.completeDelivery({
    taskId: task.taskId, workspaceId: WORKSPACE, consumerName: 'main-worker',
    workerId: workerA, fencingToken: 1, result: { stale: true },
  }), error => error instanceof OutboxTaskError && error.code === 'OUTBOX_TASK_CONFLICT');
  const outcome = await store.completeDelivery({
    taskId: task.taskId, workspaceId: WORKSPACE, consumerName: 'main-worker',
    workerId: workerB, fencingToken: 2, result: { ok: true },
  });
  assert.equal(outcome, 'delivered');
  assert.equal((await store.completeDelivery({
    taskId: task.taskId, workspaceId: WORKSPACE, consumerName: 'main-worker',
    workerId: workerB, fencingToken: 2, result: { ok: true },
  })), 'already', '重复完成投递必须幂等返回 already');
});

test('失败退避与 dead_letter：重试次数用尽后进入死信', async () => {
  const harness = createHarness({ retryBaseMs: 1000, maxAttempts: 3 });
  const { store, consumer, clock, now } = harness;
  const task = await store.append({
    taskType: 'runtime.smoke', idempotencyKey: 'backoff-case-1',
    payload: { fail: true }, workspaceId: WORKSPACE, maxAttempts: 3,
  });
  await consumer.pollOnce();
  let state = await store.getTask({ taskId: task.taskId, workspaceId: WORKSPACE });
  assert.equal(state.state, 'failed');
  assert.equal(state.attempts, 1);
  assert.equal(state.lastError, 'handler forced failure');
  assert.equal(new Date(state.availableAt).getTime() - clock.value, outboxRetryDelayMs(1000, 1));
  clock.value += outboxRetryDelayMs(1000, 1) + 1;
  await consumer.pollOnce();
  state = await store.getTask({ taskId: task.taskId, workspaceId: WORKSPACE });
  assert.equal(state.state, 'failed');
  assert.equal(state.attempts, 2);
  clock.value += outboxRetryDelayMs(1000, 2) + 1;
  await consumer.pollOnce();
  state = await store.getTask({ taskId: task.taskId, workspaceId: WORKSPACE });
  assert.equal(state.state, 'dead_letter', '第三次失败后进入死信');
  assert.equal(state.attempts, 3);
  assert.equal(await consumer.pollOnce().then(outcome => outcome.claimed), 0, '死信任务不再被领取');
});

test('崩溃恢复：投递中任务在租约过期后由下一轮领取重新消费', async () => {
  const harness = createHarness();
  const { store, consumer, clock } = harness;
  const task = await store.append({
    taskType: 'runtime.smoke', idempotencyKey: 'crash-recovery-1',
    payload: { message: 'resume' }, workspaceId: WORKSPACE,
  });
  const ghostWorker = `wkri_${randomBytes(16).toString('hex')}`;
  const claimed = await store.claimBatch({ workerId: ghostWorker, batchSize: 1, leaseMs: 30_000, now: harness.now() });
  assert.equal(claimed.length, 1);
  assert.equal((await store.getTask({ taskId: task.taskId, workspaceId: WORKSPACE })).state, 'delivering');
  // ghost 实例崩溃：不完成也不失败，任务停留在 delivering。
  const stuck = await consumer.pollOnce();
  assert.equal(stuck.claimed, 0, '租约未过期时不得重复领取 delivering 任务');
  clock.value += 45_000;
  const recovered = await consumer.pollOnce();
  assert.equal(recovered.delivered, 1, '租约过期后任务被回收并由活实例消费');
  const finalTask = await store.getTask({ taskId: task.taskId, workspaceId: WORKSPACE });
  assert.equal(finalTask.state, 'delivered');
});

test('未知任务类型与租户解析失败都必须登记失败而不是卡死', async () => {
  const harness = createHarness();
  const { store, clock } = harness;
  const unknown = await store.append({
    taskType: 'runtime.smoke', idempotencyKey: 'unknown-type-1',
    payload: {}, workspaceId: WORKSPACE,
  });
  // 直接改写任务类型以模拟"已提交但 handler 未注册"（白名单外类型无法经 service 提交）。
  store.tasks.get(unknown.taskId).taskType = 'legacy.unknown_type';
  const database = {
    runAsSystem: (_reason, work) => work(),
    runWithTenant: (_tenant, work) => work(),
  };
  const consumer = new OutboxTaskConsumer({
    database, store,
    tenantResolver: { resolve: async () => TENANT },
    handlers: [], ownerInstanceId: `wkri_${randomBytes(16).toString('hex')}`,
    consumerName: 'main-worker', batchSize: 5, pollIntervalMs: 50, retryBaseMs: 1000, claimLeaseMs: 30_000,
  });
  const outcome = await consumer.pollOnce();
  assert.equal(outcome.failed, 1);
  let task = await store.getTask({ taskId: unknown.taskId, workspaceId: WORKSPACE });
  assert.equal(task.state, 'failed');
  assert.match(task.lastError, /没有注册的任务类型/);
  clock.value += outboxRetryDelayMs(1000, 1) + 1;
  // 租户解析失败：走系统作用域失败登记路径。
  const failingResolver = {
    resolve: async () => { throw new Error('no active member'); },
  };
  const consumer2 = new OutboxTaskConsumer({
    database, store, tenantResolver: failingResolver, handlers: [],
    ownerInstanceId: `wkri_${randomBytes(16).toString('hex')}`,
    consumerName: 'main-worker', batchSize: 5, pollIntervalMs: 50, retryBaseMs: 1000, claimLeaseMs: 30_000,
  });
  const outcome2 = await consumer2.pollOnce();
  assert.ok(outcome2.claimed >= 1);
  task = await store.getTask({ taskId: unknown.taskId, workspaceId: WORKSPACE });
  assert.match(task.lastError, /租户解析失败/);
});

test('提交参数校验：负载类型、幂等键与任务类型', async () => {
  const harness = createHarness();
  const { store } = harness;
  await assert.rejects(() => store.append({
    taskType: 'Bad_Type', idempotencyKey: 'valid-key-1', payload: {}, workspaceId: WORKSPACE,
  }), OutboxTaskError);
  await assert.rejects(() => store.append({
    taskType: 'runtime.smoke', idempotencyKey: 'short', payload: {}, workspaceId: WORKSPACE,
  }), OutboxTaskError);
  await assert.rejects(() => store.append({
    taskType: 'runtime.smoke', idempotencyKey: 'valid-key-2', payload: [], workspaceId: WORKSPACE,
  }), OutboxTaskError);
  await assert.rejects(() => store.append({
    taskType: 'runtime.smoke', idempotencyKey: 'valid-key-3', payload: { a: 1 },
    aggregateType: 'production_run', workspaceId: WORKSPACE,
  }), OutboxTaskError, 'aggregate 字段必须成对');
});
