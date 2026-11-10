const test = require('node:test');
const assert = require('node:assert/strict');
const { defineTool, digestOf } = require('@lyra/shared');
const {
  ToolRegistry, ToolKernel, InMemoryToolInvocationStore, InMemoryBudgetLedger, InMemoryToolApprovalStore,
  AgentDefinitionRegistry, AgentRuntime, InMemoryAgentRuntimeStore, runResumableAgentToolLoop,
} = require('../dist/index.js');

function tool(overrides = {}) {
  return defineTool({
    toolId: 'demo.read', version: '1.0.0', displayName: '读取', description: '读取', ownerDomain: 'test',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    outputSchema: { type: 'object', properties: {}, additionalProperties: true },
    sideEffect: 'none', executionOwner: 'agent_selectable', requiredPermission: 'workspace_read',
    allowedAgentIds: ['demo-agent'], allowedWorkflowIds: [],
    sensitivity: { input: 'internal', output: 'internal' }, cost: null,
    idempotency: { strategy: 'tool_call_id', keyVersion: 1 },
    retry: { timeoutMs: 5000, maxAttempts: 1, backoffMs: 0, retryableCodes: [], unknownCodes: [] },
    capability: { async: false, reconcile: false, cancel: false },
    providers: { hosts: [], modelConnections: [] }, limits: { maxInputBytes: 4096, maxOutputBytes: 4096, maxItems: 20 },
    produces: { entities: [], revisions: [], artifacts: [], evidence: [], events: [] },
    adapterDigest: digestOf({ adapter: 'demo' }), status: 'frozen', frozenAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  });
}

function definitionInput() {
  return {
    agentId: 'demo-agent', version: '1.0.0', displayName: '演示 Agent', domain: 'demo',
    description: '用于测试的领域 Agent',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    outputSchema: { type: 'object', properties: {}, additionalProperties: true },
    promptRevisionDigest: digestOf({ prompt: 'v1' }), methodProfileRevisionId: null, methodProfileDigest: null,
    allowedTools: [{ toolId: 'demo.read', range: '1.0.0' }],
    allowedChildAgentIds: [], limits: {
      maxSteps: 8, maxChildDepth: 1, maxConcurrency: 1, stepTimeoutMs: 5000, runTimeoutMs: 60000,
      maxToolCalls: 20, maxTokens: 100000, maxBudgetMicros: 100000, currency: 'CNY',
    },
    requiredPermissions: ['workspace_read'], sensitivity: { input: 'internal', output: 'internal' },
    codeDigest: digestOf({ code: 'demo' }),
  };
}

function snapshotInput() {
  return {
    workspaceId: 'ws_demo', projectId: 'prj_demo', userId: 'usr_demo', role: 'member',
    parentRunId: null, productionRunId: null, workflowTaskId: null,
    agent: { agentId: 'demo-agent', version: '1.0.0', manifestDigest: digestOf({ agent: 'demo' }) },
    inputRevisions: [{ kind: 'script', id: 'scr_1', digest: digestOf({ script: 'v1' }) }],
    prompt: { revisionDigest: digestOf({ prompt: 'v1' }) },
    method: { profileRevisionId: null, profileDigest: null, packVersionIds: [] },
    model: { connectionRevision: 'mc_1', model: 'stub-model' },
    tools: [{ toolId: 'demo.read', version: '1.0.0', manifestDigest: tool().manifestDigest }],
    workflow: null, code: { buildDigest: digestOf({ code: 'demo' }) },
    budget: { maxMicros: 50000, currency: 'CNY' }, timeout: { stepMs: 3000, runMs: 30000 },
    maxSteps: 5, seed: 'seed-1', contextSnapshotDigest: digestOf({ context: 'v1' }),
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function fixture(execute) {
  const toolRegistry = new ToolRegistry();
  const definition = tool();
  const calls = [];
  toolRegistry.register(definition, { execute: async (args) => {
    calls.push(args);
    return execute ? execute(args, calls.length) : { summary: '读取成功', data: { count: 1 } };
  } });
  const definitions = new AgentDefinitionRegistry(toolRegistry);
  const frozen = definitions.freeze('demo-agent', '1.0.0', definitions.create(definitionInput()).manifestDigest, '2026-01-01T00:00:00.000Z');
  const snapshot = { ...snapshotInput(), agent: { agentId: frozen.agentId, version: frozen.version, manifestDigest: frozen.manifestDigest } };
  let clock = new Date('2026-01-01T00:00:01.000Z');
  const store = new InMemoryAgentRuntimeStore();
  const runtime = new AgentRuntime(store, { now: () => clock, leaseTtlMs: 5000 });
  const invocationStore = new InMemoryToolInvocationStore();
  const kernel = new ToolKernel(toolRegistry, invocationStore, new InMemoryBudgetLedger({}), {
    now: () => clock, approvals: new InMemoryToolApprovalStore(),
  });
  const advance = (ms) => { clock = new Date(clock.getTime() + ms); };
  return { definition, toolRegistry, definitions, snapshot, runtime, store, invocationStore, kernel, calls, advance };
}

async function prepareRun(fixtureValue, leaseOwner = 'worker-1') {
  const run = await fixtureValue.runtime.createRun({ snapshot: fixtureValue.snapshot });
  await fixtureValue.runtime.transition(run.runId, 'planning', { summary: '规划' });
  await fixtureValue.runtime.transition(run.runId, 'queued', { summary: '排队' });
  await fixtureValue.runtime.claim(run.runId, { leaseOwner, ttlMs: 5000 });
  const step = await fixtureValue.runtime.startStep(run.runId, '工具步骤');
  return { run, step };
}

function context(runId, stepId) {
  return {
    workspaceId: 'ws_demo', projectId: 'prj_demo', userId: 'usr_demo', role: 'member',
    runId, stepId, toolCallId: 'call_1', requestId: 'req_1',
    grantedPermissions: ['workspace_read'], now: new Date('2026-01-01T00:00:01.000Z'),
  };
}

function proposal(runId, stepId, definition) {
  return {
    proposalId: 'prop_1', runId, stepId, toolId: definition.toolId, version: definition.version,
    manifestDigest: definition.manifestDigest, arguments: { id: 'a1' }, reasonSummary: '测试',
  };
}

function prepareInput(runId, stepId, definition) {
  return {
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: runId, stepId,
    proposal: proposal(runId, stepId, definition), context: context(runId, stepId),
    role: 'member', grantedPermissions: ['workspace_read'], workflow: null,
  };
}

test('可恢复 Tool Loop 在每次调用前后写 Checkpoint，完成后重放不再执行工具', async () => {
  const value = fixture();
  const { run, step } = await prepareRun(value);
  let plannerCalls = 0;
  const result = await runResumableAgentToolLoop(value.kernel, {
    ...prepareInput(run.runId, step.stepId, value.definition),
    runtime: value.runtime, runId: run.runId, stepId: step.stepId,
    planner: async ({ round }) => {
      plannerCalls += 1;
      return round === 1 ? { calls: [proposal(run.runId, step.stepId, value.definition)] } : { done: true, summary: '完成' };
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(value.calls.length, 1);
  assert.equal(plannerCalls, 2);
  const checkpoints = await value.runtime.listCheckpoints(run.runId);
  assert.deepEqual(checkpoints.map(item => item.phase), ['before_tool', 'after_tool', 'run_completed']);
  assert.ok(checkpoints[0].pendingInvocationId);
  assert.equal(checkpoints[1].pendingInvocationId, null);
  assert.equal(checkpoints[0].sequence + 1, checkpoints[1].sequence);
  const invocations = await value.invocationStore.listByRun(run.runId);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].state, 'succeeded');

  // 已完成 Run 的恢复直接返回 Checkpoint 中的结果，不调用 planner、不再执行工具。
  const resumed = await runResumableAgentToolLoop(value.kernel, {
    ...prepareInput(run.runId, step.stepId, value.definition),
    runtime: value.runtime, runId: run.runId, stepId: step.stepId,
    planner: async () => { throw new Error('不应调用 planner'); },
  });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.summary, '完成');
  assert.equal(value.calls.length, 1);
});

test('Invocation 已持久化但 before_tool 尚未落盘时崩溃：复用同一幂等键恢复执行', async () => {
  const value = fixture();
  const { run, step } = await prepareRun(value);
  const prepared = await value.kernel.prepare(prepareInput(run.runId, step.stepId, value.definition));
  assert.equal(prepared.kind, 'ready');
  const result = await runResumableAgentToolLoop(value.kernel, {
    ...prepareInput(run.runId, step.stepId, value.definition),
    runtime: value.runtime, runId: run.runId, stepId: step.stepId,
    planner: async ({ round }) => round === 1
      ? { calls: [proposal(run.runId, step.stepId, value.definition)] }
      : { done: true, summary: '恢复完成' },
  });
  assert.equal(result.status, 'completed');
  assert.equal(value.calls.length, 1);
  const invocations = await value.invocationStore.listByRun(run.runId);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].invocationId, prepared.invocation.invocationId);
  assert.equal(invocations[0].state, 'succeeded');
});

test('执行成功但结果落库前崩溃：恢复复用已确认结果，不产生第二次业务副作用', async () => {
  const value = fixture();
  const { run, step } = await prepareRun(value);
  const prepared = await value.kernel.prepare(prepareInput(run.runId, step.stepId, value.definition));
  assert.equal(prepared.kind, 'ready');
  const outcome = await value.kernel.execute(prepared.invocation, context(run.runId, step.stepId));
  assert.equal(outcome.result.status, 'succeeded');
  assert.equal(value.calls.length, 1);

  await value.runtime.recordCheckpoint(run.runId, {
    phase: 'before_tool', stepId: step.stepId,
    payload: { version: 1, round: 1, callIndex: 0, calls: [proposal(run.runId, step.stepId, value.definition)],
      observations: [], awaitingPlanner: false },
    pendingInvocationId: prepared.invocation.invocationId, cursor: 'round:1:call:0',
  });

  const result = await runResumableAgentToolLoop(value.kernel, {
    ...prepareInput(run.runId, step.stepId, value.definition),
    runtime: value.runtime, runId: run.runId, stepId: step.stepId,
    planner: async ({ round }) => round === 2 ? { done: true, summary: '恢复完成' } : { calls: [] },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.summary, '恢复完成');
  assert.equal(value.calls.length, 1, '已确认结果不能再执行 Adapter');
  const invocations = await value.invocationStore.listByRun(run.runId);
  assert.equal(invocations[0].state, 'succeeded');
  assert.equal(invocations[0].attemptCount, 1);
});

test('执行中崩溃：running 的幂等只读调用重新排队，新 Attempt 执行且不重复结果', async () => {
  const value = fixture();
  const { run, step } = await prepareRun(value);
  const prepared = await value.kernel.prepare(prepareInput(run.runId, step.stepId, value.definition));
  const live = await value.invocationStore.get(prepared.invocation.invocationId);
  const running = {
    ...live, state: 'running', version: live.version + 1, attemptCount: 1,
    updatedAt: new Date().toISOString(),
  };
  assert.equal(await value.invocationStore.update(live.version, running), true);
  await value.invocationStore.appendAttempt({
    attemptId: `att_${'a'.repeat(32)}`, invocationId: running.invocationId, attemptNumber: 1,
    state: 'running', startedAt: '2026-01-01T00:00:01.000Z',
  });
  await value.runtime.recordCheckpoint(run.runId, {
    phase: 'before_tool', stepId: step.stepId,
    payload: { version: 1, round: 1, callIndex: 0, calls: [proposal(run.runId, step.stepId, value.definition)],
      observations: [], awaitingPlanner: false },
    pendingInvocationId: running.invocationId, cursor: 'round:1:call:0',
  });

  const result = await runResumableAgentToolLoop(value.kernel, {
    ...prepareInput(run.runId, step.stepId, value.definition),
    runtime: value.runtime, runId: run.runId, stepId: step.stepId,
    planner: async ({ round }) => round === 2 ? { done: true, summary: '崩溃恢复' } : { calls: [] },
  });
  assert.equal(result.status, 'completed');
  assert.equal(value.calls.length, 1);
  const invocations = await value.invocationStore.listByRun(run.runId);
  assert.equal(invocations[0].state, 'succeeded');
  assert.equal(invocations[0].attemptCount, 2);
  const attempts = value.invocationStore.attemptsOf(invocations[0].invocationId);
  assert.equal(attempts[0].state, 'failed');
  assert.equal(attempts[0].reasonCode, 'AGENT_TOOL_WORKER_INTERRUPTED');
  assert.equal(attempts[1].state, 'succeeded');
});

test('恢复点已确认本轮全部调用时，下一轮直接请求 planner，不重放旧轮次', async () => {
  const value = fixture();
  const { run, step } = await prepareRun(value);
  const calls = [1, 2].map(index => ({
    ...proposal(run.runId, step.stepId, value.definition),
    proposalId: `prop_after_${index}`,
  }));
  await value.runtime.recordCheckpoint(run.runId, {
    phase: 'after_tool', stepId: step.stepId,
    payload: { version: 1, round: 1, callIndex: 2, calls, observations: [
      { round: 1, proposalId: 'prop_after_1', toolId: 'demo.read', version: '1.0.0', status: 'succeeded', summary: 'ok' },
      { round: 1, proposalId: 'prop_after_2', toolId: 'demo.read', version: '1.0.0', status: 'succeeded', summary: 'ok' },
    ], awaitingPlanner: false },
    cursor: 'round:1:call:2', summary: '本轮工具已全部确认',
  });
  const plannerRounds = [];
  const result = await runResumableAgentToolLoop(value.kernel, {
    ...prepareInput(run.runId, step.stepId, value.definition),
    runtime: value.runtime, runId: run.runId, stepId: step.stepId,
    planner: async ({ round }) => {
      plannerRounds.push(round);
      return { done: true, summary: '下一轮完成' };
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.summary, '下一轮完成');
  assert.deepEqual(plannerRounds, [2]);
  assert.equal(value.calls.length, 0);
});

test('两个 Worker 并发领取同一 Run：最多一个持有租约并只创建一个 Attempt', async () => {
  const value = fixture();
  const run = await value.runtime.createRun({ snapshot: value.snapshot });
  await value.runtime.transition(run.runId, 'planning', { summary: '规划' });
  await value.runtime.transition(run.runId, 'queued', { summary: '排队' });
  const results = await Promise.allSettled([
    value.runtime.claim(run.runId, { leaseOwner: 'worker-a', ttlMs: 5000 }),
    value.runtime.claim(run.runId, { leaseOwner: 'worker-b', ttlMs: 5000 }),
  ]);
  const fulfilled = results.filter(item => item.status === 'fulfilled');
  assert.equal(fulfilled.length, 1);
  const rejected = results.find(item => item.status === 'rejected');
  assert.ok(rejected && ['AGENT_RUN_STALE', 'AGENT_RUN_LEASE_HELD'].includes(rejected.reason.code));
  const attempts = await value.runtime.listAttempts(run.runId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].state, 'running');
  assert.equal(attempts[0].leaseOwner, fulfilled[0].value.leaseOwner);
});

test('崩溃恢复创建新 Run Attempt，旧 Attempt 不被覆盖', async () => {
  const value = fixture();
  const { run } = await prepareRun(value, 'worker-a');
  assert.equal((await value.runtime.listAttempts(run.runId)).length, 1);
  await value.runtime.interrupt(run.runId, 'Worker 崩溃');
  await value.runtime.resume(run.runId, 'usr_owner');
  const reclaimed = await value.runtime.claim(run.runId, { leaseOwner: 'worker-b', ttlMs: 5000 });
  assert.equal(reclaimed.attemptCount, 2);
  const attempts = await value.runtime.listAttempts(run.runId);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].state, 'interrupted');
  assert.equal(attempts[1].state, 'running');
  assert.notEqual(attempts[0].attemptId, attempts[1].attemptId);
  assert.equal(reclaimed.currentAttemptId, attempts[1].attemptId);
});
