const test = require('node:test');
const assert = require('node:assert/strict');
const { defineTool, digestOf } = require('@lyra/shared');
const {
  ToolRegistry, ToolKernel, InMemoryToolInvocationStore, InMemoryBudgetLedger, WAITING_CONFIRMATION,
  InMemoryToolApprovalStore,
  AgentDefinitionRegistry, AgentRuntime, InMemoryAgentRuntimeStore,
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

function definitionInput(overrides = {}) {
  return {
    agentId: 'demo-agent', version: '1.0.0', displayName: '演示 Agent', domain: 'demo',
    description: '用于测试的领域 Agent',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    outputSchema: { type: 'object', properties: {}, additionalProperties: true },
    promptRevisionDigest: digestOf({ prompt: 'v1' }), methodProfileRevisionId: null, methodProfileDigest: null,
    allowedTools: [{ toolId: 'demo.read', range: '1.0.0' }], allowedChildAgentIds: [],
    limits: {
      maxSteps: 8, maxChildDepth: 1, maxConcurrency: 1, stepTimeoutMs: 5000, runTimeoutMs: 30000,
      maxToolCalls: 20, maxTokens: 100000, maxBudgetMicros: 100000, currency: 'CNY',
    },
    requiredPermissions: ['workspace_read'], sensitivity: { input: 'internal', output: 'internal' },
    codeDigest: digestOf({ code: 'demo' }), ...overrides,
  };
}

function snapshotInput(overrides = {}) {
  return {
    workspaceId: 'ws_demo', projectId: 'prj_demo', userId: 'usr_demo', role: 'member',
    parentRunId: null, productionRunId: null, workflowTaskId: null,
    agentId: 'demo-agent', agentVersion: '1.0.0',
    inputRevisions: [{ kind: 'script', id: 'scr_1', digest: digestOf({ script: 'v1' }) }],
    prompt: { revisionDigest: digestOf({ prompt: 'v1' }) },
    method: { profileRevisionId: null, profileDigest: null, packVersionIds: [] },
    model: { connectionRevision: 'mc_1', model: 'stub-model' },
    workflow: null, code: { buildDigest: digestOf({ code: 'demo' }) },
    budget: { maxMicros: 50000, currency: 'CNY' }, timeout: { stepMs: 3000, runMs: 20000 },
    maxSteps: 5, seed: 'seed-1', now: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

function fixture() {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(tool(), { execute: async () => ({ summary: 'ok' }) });
  const definitions = new AgentDefinitionRegistry(toolRegistry);
  const draft = definitions.create(definitionInput());
  const frozen = definitions.freeze('demo-agent', '1.0.0', draft.manifestDigest, '2026-01-01T00:00:00.000Z');
  const snapshot = definitions.snapshot(snapshotInput());
  let clock = new Date('2026-01-01T00:00:01.000Z');
  const store = new InMemoryAgentRuntimeStore();
  const runtime = new AgentRuntime(store, { now: () => clock, leaseTtlMs: 1000 });
  return { toolRegistry, definitions, frozen, snapshot, runtime, store, advance: (ms) => { clock = new Date(clock.getTime() + ms); }, clock: () => clock };
}

test('方法包版本引用只接受 prompt-pack:<packId>@<digest> 单一格式', () => {
  const { definitions } = fixture();
  const valid = `prompt-pack:pack-a@${digestOf({ pack: 'a' })}`;
  const frozen = definitions.snapshot(snapshotInput({ method: { profileRevisionId: null, profileDigest: null, packVersionIds: [valid] } }));
  assert.deepEqual(frozen.method.packVersionIds, [valid]);
  assert.throws(() => definitions.snapshot(snapshotInput({
    method: { profileRevisionId: null, profileDigest: null, packVersionIds: ['skl_pack-a@1'] },
  })), error => error.code === 'AGENT_SNAPSHOT_METHOD_MISMATCH');
  assert.throws(() => definitions.snapshot(snapshotInput({
    method: { profileRevisionId: null, profileDigest: null, packVersionIds: [valid, valid] },
  })), error => error.code === 'AGENT_SNAPSHOT_METHOD_MISMATCH');
});

test('定义必须冻结后才能创建 Run，Snapshot 固化工具精确版本', () => {
  const { definitions, frozen, snapshot } = fixture();
  assert.equal(frozen.status, 'frozen');
  assert.equal(snapshot.agent.manifestDigest, frozen.manifestDigest);
  assert.equal(snapshot.tools[0].version, '1.0.0');
  assert.ok(snapshot.contextSnapshotDigest.length === 64);
  assert.throws(() => definitions.runnable('demo-agent', '1.0.0', digestOf({ bad: true })),
    error => error.code === 'AGENT_DEFINITION_MANIFEST_MISMATCH');
});

test('Run 状态机、租约、心跳、步骤与 checkpoint', async () => {
  const { runtime, store, advance } = fixture();
  const run = await runtime.createRun({ snapshot: fixture().snapshot, now: () => new Date('2026-01-01T00:00:01.000Z') });
  assert.equal(run.state, 'created');
  await runtime.transition(run.runId, 'planning', { summary: '规划中' });
  await runtime.transition(run.runId, 'queued', { summary: '等待执行' });
  const claimed = await runtime.claim(run.runId, { leaseOwner: 'worker-1', ttlMs: 1000 });
  assert.equal(claimed.state, 'running');
  assert.equal(claimed.attemptCount, 1);
  const beaten = await runtime.heartbeat(run.runId, 'worker-1', 1000);
  assert.equal(beaten.leaseExpiresAt, '2026-01-01T00:00:02.000Z');
  const step = await runtime.startStep(run.runId, '调用只读工具');
  assert.equal(step.index, 1);
  const snapshot = await runtime.recordContextSnapshot(run.runId, {
    kind: 'step', payload: { messages: ['hello'] }, cursor: 'event:4', stepId: step.stepId,
  });
  assert.ok(snapshot.payloadDigest.length === 64);
  await runtime.completeStep(step.stepId, 'completed', '完成', 1);
  const now = new Date(clockDate()).toISOString();
  const done = await runtime.transition(run.runId, 'succeeded', { summary: '结束' });
  assert.equal(done.state, 'succeeded');
  await assert.rejects(() => runtime.transition(run.runId, 'running'), error => error.code === 'AGENT_RUN_TERMINAL');
  const replay = await runtime.replay(run.runId);
  assert.ok(replay.some(event => event.event.type === 'completed'));
  advance(1);
  void now;
});

function clockDate() { return '2026-01-01T00:00:03.000Z'; }

test('中断 → interrupted → 恢复 → queued → 新 attempt 领取', async () => {
  const { runtime } = fixture();
  const run = await runtime.createRun({ snapshot: fixture().snapshot });
  await runtime.transition(run.runId, 'planning', {});
  await runtime.transition(run.runId, 'queued', {});
  await runtime.claim(run.runId, { leaseOwner: 'worker-a', ttlMs: 5000 });
  const interrupted = await runtime.interrupt(run.runId, '人工暂停');
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.leaseOwner, undefined);
  const resumed = await runtime.resume(run.runId, 'usr_owner');
  assert.equal(resumed.state, 'queued');
  const reclaimed = await runtime.claim(run.runId, { leaseOwner: 'worker-b', ttlMs: 5000 });
  assert.equal(reclaimed.attemptCount, 2);
  assert.equal(reclaimed.leaseOwner, 'worker-b');
});

test('并发 approve/reject 只有一个持久化 CAS 生效', async () => {
  const { runtime, store } = fixture();
  const run = await runtime.createRun({ snapshot: fixture().snapshot });
  await runtime.transition(run.runId, 'planning', {});
  const approval = {
    approvalId: 'apr_concurrent', runId: run.runId, invocationId: 'inv_concurrent',
    kind: 'paid_action', state: 'pending', summary: '并发审批',
    proposalDigest: digestOf({ proposal: 'concurrent' }), estimateMicros: 5000, currency: 'CNY',
    requestedBy: 'usr_demo', requestedAt: '2026-01-01T00:00:01.000Z',
    expiresAt: '2026-01-01T00:10:00.000Z',
  };
  await runtime.suspendForApproval(run.runId, approval, '等待并发审批');
  const results = await Promise.allSettled([
    runtime.decideApproval({ approvalId: approval.approvalId, decision: 'approved', actor: 'usr_owner_a' }),
    runtime.decideApproval({ approvalId: approval.approvalId, decision: 'rejected', actor: 'usr_owner_b' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected && ['AGENT_APPROVAL_STALE', 'AGENT_APPROVAL_ALREADY_DECIDED'].includes(rejected.reason.code));
  const persisted = await store.getApproval(approval.approvalId);
  assert.ok(persisted.state === 'approved' || persisted.state === 'rejected');
  assert.equal((await runtime.replay(run.runId)).filter(event => event.event.type === 'approval_decided').length, 1);
});

test('未授权工具调用中断为 WAITING_CONFIRMATION，审批批准后恢复 queued', async () => {
  const { runtime } = fixture();
  const run = await runtime.createRun({ snapshot: fixture().snapshot });
  await runtime.transition(run.runId, 'planning', {});
  await runtime.transition(run.runId, 'queued', {});
  const claimed = await runtime.claim(run.runId, { leaseOwner: 'worker-1', ttlMs: 5000 });

  // 未授权 Agent：Runtime 第三层直接拒绝。
  const blocked = tool({ allowedAgentIds: ['other-agent'] });
  const kernelRegistry = new ToolRegistry();
  kernelRegistry.register(blocked, { execute: async () => ({ summary: '不应执行' }) });
  const kernel = new ToolKernel(kernelRegistry, new InMemoryToolInvocationStore(), new InMemoryBudgetLedger({}));
  await assert.rejects(() => kernel.prepare({
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: run.runId, stepId: 'stp_1',
    proposal: { proposalId: 'p1', runId: run.runId, stepId: 'stp_1', toolId: blocked.toolId, version: '1.0.0',
      manifestDigest: blocked.manifestDigest, arguments: {}, reasonSummary: '越权调用' },
    context: { workspaceId: 'ws_demo', projectId: null, userId: 'usr_demo', role: 'member',
      runId: run.runId, stepId: 'stp_1', toolCallId: 'c1', requestId: 'r1', grantedPermissions: ['workspace_read'], now: new Date() },
    role: 'member', grantedPermissions: ['workspace_read'], workflow: null,
  }), error => error.code === 'AGENT_TOOL_NOT_ALLOWED_FOR_AGENT');

  // 需要人工确认的工具：Kernel 返回 WAITING_CONFIRMATION，Runtime 挂起。
  const paid = tool({
    toolId: 'demo.pay', sideEffect: 'paid_external', executionOwner: 'workflow_only',
    requiredPermission: 'workspace_write', allowedWorkflowIds: ['wf_pay'],
    cost: { estimatorRevision: 'q1', budgetDimension: 'money', estimateMicros: 5000, currency: 'CNY' },
  });
  const paidRegistry = new ToolRegistry();
  paidRegistry.register(paid, { execute: async () => ({ summary: 'paid' }) });
  const paidKernel = new ToolKernel(paidRegistry, new InMemoryToolInvocationStore(),
    new InMemoryBudgetLedger({ ws_demo: 100000 }), { approvals: new InMemoryToolApprovalStore() });
  const prepared = await paidKernel.prepare({
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: run.runId, stepId: 'stp_1',
    proposal: { proposalId: 'p2', runId: run.runId, stepId: 'stp_1', toolId: paid.toolId, version: '1.0.0',
      manifestDigest: paid.manifestDigest, arguments: { id: 'x' }, reasonSummary: '付费动作' },
    context: { workspaceId: 'ws_demo', projectId: null, userId: 'usr_demo', role: 'member', runId: run.runId,
      stepId: 'stp_1', toolCallId: 'c2', requestId: 'r2', grantedPermissions: ['workspace_write'], now: new Date() },
    role: 'member', grantedPermissions: ['workspace_write'], workflow: { workflowId: 'wf_pay', stage: 'render', approvedPaidMicros: 0 },
    budgetRemainingMicros: 100000,
  });
  assert.equal(prepared.kind, 'awaiting_confirmation');
  assert.equal(prepared.confirmationState, WAITING_CONFIRMATION);
  const approval = {
    approvalId: 'apr_1', runId: run.runId, invocationId: prepared.invocation.invocationId, kind: 'paid_action',
    state: 'pending', summary: '付费渲染 5000 micros', proposalDigest: prepared.invocation.proposal ? digestOf(prepared.invocation.proposal) : 'x',
    estimateMicros: 5000, currency: 'CNY', requestedBy: 'usr_demo',
    requestedAt: '2026-01-01T00:00:01.000Z', expiresAt: '2026-01-01T00:10:00.000Z',
  };
  const suspended = await runtime.suspendForApproval(claimed.runId, approval, '等待付费确认');
  assert.equal(suspended.state, 'awaiting_approval');
  const decided = await runtime.decideApproval({ approvalId: 'apr_1', decision: 'approved', actor: 'usr_owner' });
  assert.equal(decided.approval.state, 'approved');
  assert.equal(decided.run.state, 'queued');
});
