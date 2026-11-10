const test = require('node:test');
const assert = require('node:assert/strict');
const { defineTool, digestOf } = require('@lyra/shared');
const {
  ToolRegistry, ToolKernel, InMemoryToolInvocationStore, InMemoryBudgetLedger,
  InMemoryToolApprovalStore,
  ToolAdapterError, WAITING_CONFIRMATION, validateToolArguments, decideToolPermission,
  runAgentToolLoop,
} = require('../dist/index.js');

const BASE_DEF = {
  toolId: 'demo.read', version: '1.0.0', displayName: '读取演示', description: '读取演示数据', ownerDomain: 'test',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  outputSchema: { type: 'object', properties: {}, additionalProperties: true },
  sideEffect: 'none', executionOwner: 'agent_selectable', requiredPermission: 'workspace_read',
  allowedAgentIds: ['demo-agent'], allowedWorkflowIds: [],
  sensitivity: { input: 'internal', output: 'internal' },
  cost: null, idempotency: { strategy: 'tool_call_id', keyVersion: 1 },
  retry: { timeoutMs: 5000, maxAttempts: 1, backoffMs: 0, retryableCodes: [], unknownCodes: [] },
  capability: { async: false, reconcile: false, cancel: false },
  providers: { hosts: [], modelConnections: [] },
  limits: { maxInputBytes: 4096, maxOutputBytes: 4096, maxItems: 50 },
  produces: { entities: [], revisions: [], artifacts: [], evidence: [], events: [] },
  adapterDigest: digestOf({ adapter: 'demo' }), status: 'frozen', frozenAt: '2024-01-01T00:00:00.000Z',
};

function makeTool(overrides = {}) { return defineTool({ ...BASE_DEF, ...overrides }); }

function context(overrides = {}) {
  return {
    workspaceId: 'ws_demo', projectId: null, userId: 'usr_demo', role: 'member',
    runId: 'run_demo', stepId: 'stp_demo', toolCallId: 'call_1', requestId: 'req_1',
    grantedPermissions: ['workspace_read'], now: new Date(), ...overrides,
  };
}

function proposal(definition, overrides = {}) {
  return {
    proposalId: 'prop_1', runId: 'run_demo', stepId: 'stp_demo',
    toolId: definition.toolId, version: definition.version, manifestDigest: definition.manifestDigest,
    arguments: { id: 'a1' }, reasonSummary: '测试调用', ...overrides,
  };
}

test('工具参数按 Schema 拒绝缺省必填、额外字段与超限值', () => {
  const schema = BASE_DEF.inputSchema;
  assert.throws(() => validateToolArguments(schema, {}), error => error.code === 'AGENT_TOOL_INPUT_INVALID');
  assert.throws(() => validateToolArguments(schema, { id: 'a', extra: 1 }), error => error.code === 'AGENT_TOOL_INPUT_INVALID');
  assert.throws(() => validateToolArguments({ type: 'object', properties: { n: { type: 'integer', maximum: 3 } } }, { n: 4 }),
    error => error.code === 'AGENT_TOOL_INPUT_INVALID');
});

test('权限判定：只读放行，写操作必须确认，查看者越权直接拒绝', () => {
  const read = makeTool();
  const write = makeTool({ toolId: 'demo.write', sideEffect: 'internal_write', requiredPermission: 'workspace_write' });
  const readonlyMode = decideToolPermission({
    definition: write, role: 'member', grantedPermissions: ['workspace_write'], workflow: null,
    mode: 'read_only_only',
  });
  assert.equal(readonlyMode.decision, 'deny');
  assert.equal(readonlyMode.reasonCode, 'AGENT_TOOL_READ_ONLY_MODE');

  const viewer = decideToolPermission({
    definition: write, role: 'viewer', grantedPermissions: ['workspace_write'], workflow: null, mode: 'default',
  });
  assert.equal(viewer.decision, 'deny');

  const memberWrite = decideToolPermission({
    definition: write, role: 'member', grantedPermissions: ['workspace_write'], workflow: null, mode: 'default',
  });
  assert.equal(memberWrite.decision, 'require_confirmation');
  assert.equal(memberWrite.sideEffect, 'internal_write');

  const readOk = decideToolPermission({
    definition: read, role: 'member', grantedPermissions: ['workspace_read'], workflow: null, mode: 'default',
  });
  assert.equal(readOk.decision, 'allow');
});

test('未授权 Agent 的提案在 Runtime 第三层被拒绝', async () => {
  const definition = makeTool({ allowedAgentIds: ['another-agent'] });
  const registry = new ToolRegistry();
  registry.register(definition, { execute: async () => ({ summary: 'ok' }) });
  const kernel = new ToolKernel(registry, new InMemoryToolInvocationStore(), new InMemoryBudgetLedger({}));
  await assert.rejects(() => kernel.prepare({
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: 'run_demo', stepId: 'stp_demo',
    proposal: proposal(definition), context: context(), role: 'member',
    grantedPermissions: ['workspace_read'], workflow: null,
  }), error => error.code === 'AGENT_TOOL_NOT_ALLOWED_FOR_AGENT');
});

test('只读工具执行成功并可按幂等键复用', async () => {
  const definition = makeTool();
  const registry = new ToolRegistry();
  const calls = [];
  registry.register(definition, { execute: async (args) => { calls.push(args); return { summary: '读取成功', data: { count: 1 } }; } });
  const store = new InMemoryToolInvocationStore();
  const kernel = new ToolKernel(registry, store, new InMemoryBudgetLedger({}), { now: () => new Date('2026-01-01T00:00:00Z') });
  const prepared = await kernel.prepare({
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: 'run_demo', stepId: 'stp_demo',
    proposal: proposal(definition), context: context(), role: 'member', grantedPermissions: ['workspace_read'], workflow: null,
  });
  assert.equal(prepared.kind, 'ready');
  const outcome = await kernel.execute(prepared.invocation, context(), { validateOutput: true });
  assert.equal(outcome.result.status, 'succeeded');
  assert.equal(outcome.result.summary, '读取成功');
  assert.equal(calls.length, 1);

  const again = await kernel.prepare({
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: 'run_demo', stepId: 'stp_demo',
    proposal: proposal(definition), context: context(), role: 'member', grantedPermissions: ['workspace_read'], workflow: null,
  });
  assert.equal(again.kind, 'reused');
  assert.equal(again.result.status, 'succeeded');
});

test('付费工具必须挂 Workflow、先估价再人工确认，不能由模型直接执行', async () => {
  const definition = makeTool({
    toolId: 'demo.pay', sideEffect: 'paid_external', executionOwner: 'workflow_only',
    requiredPermission: 'workspace_write', allowedWorkflowIds: ['wf_paid'],
    cost: { estimatorRevision: 'quote-v1', budgetDimension: 'money', estimateMicros: 5000, currency: 'CNY' },
  });
  const registry = new ToolRegistry();
  registry.register(definition, { execute: async () => ({ summary: '付费完成', costMicros: 4200 }) });
  const store = new InMemoryToolInvocationStore();
  const ledger = new InMemoryBudgetLedger({ ws_demo: 100000 });
  const approvals = new InMemoryToolApprovalStore();
  const kernel = new ToolKernel(registry, store, ledger, {
    now: () => new Date('2026-01-01T00:00:00Z'), approvals,
  });
  const paidContext = context({ grantedPermissions: ['workspace_write'] });
  const prepared = await kernel.prepare({
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: 'run_demo', stepId: 'stp_demo',
    proposal: proposal(definition), context: paidContext, role: 'member', grantedPermissions: ['workspace_write'],
    workflow: { workflowId: 'wf_paid', stage: 'render', approvedPaidMicros: 0 },
    budgetRemainingMicros: 100000,
  });
  assert.equal(prepared.kind, 'awaiting_confirmation');
  assert.equal(prepared.confirmationState, WAITING_CONFIRMATION);
  assert.equal(prepared.approval.estimateMicros, 5000);
  assert.equal(prepared.invocation.approvalRequestId, prepared.approval.approvalId);
  assert.equal((await approvals.getApproval(prepared.approval.approvalId)).state, 'pending');

  // 仅凭布尔标记不能恢复；Kernel 会回读 Invocation 绑定的持久化 pending 审批。
  const booleanOnly = await kernel.prepare({
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: 'run_demo', stepId: 'stp_demo',
    proposal: proposal(definition), context: paidContext, role: 'member', grantedPermissions: ['workspace_write'],
    workflow: { workflowId: 'wf_paid', stage: 'render', approvedPaidMicros: 5000 },
    budgetRemainingMicros: 100000, approvedInvocation: true,
  });
  assert.equal(booleanOnly.kind, 'awaiting_confirmation');
  assert.equal(booleanOnly.approval.approvalId, prepared.approval.approvalId);

  const applied = await approvals.updateApproval(prepared.approval.approvalId, {
    ...prepared.approval, state: 'approved', decidedBy: 'usr_owner', decidedAt: '2026-01-01T00:00:01.000Z',
  });
  assert.equal(applied, true);
  const approved = await kernel.prepare({
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: 'run_demo', stepId: 'stp_demo',
    proposal: proposal(definition), context: paidContext, role: 'member', grantedPermissions: ['workspace_write'],
    workflow: { workflowId: 'wf_paid', stage: 'render', approvedPaidMicros: 5000 },
    budgetRemainingMicros: 100000, approvalId: prepared.approval.approvalId,
  });
  assert.equal(approved.kind, 'ready');
  const outcome = await kernel.execute(approved.invocation, paidContext, { validateOutput: true });
  assert.equal(outcome.result.status, 'succeeded');
  assert.equal(ledger.balanceOf('ws_demo'), 100000 - 4200);
  const reservation = ledger.reservationFor('ws_demo', approved.invocation.invocationId);
  assert.equal(reservation.state, 'settled');
});

test('审批必须回读持久化事实：提案 digest 或有效期漂移都拒绝执行', async () => {
  const definition = makeTool({
    toolId: 'demo.pay.approval', sideEffect: 'paid_external', executionOwner: 'workflow_only',
    requiredPermission: 'workspace_write', allowedWorkflowIds: ['wf_paid'],
    cost: { estimatorRevision: 'quote-v1', budgetDimension: 'money', estimateMicros: 5000, currency: 'CNY' },
  });
  const registry = new ToolRegistry();
  registry.register(definition, { execute: async () => ({ summary: '不应执行' }) });
  const approvals = new InMemoryToolApprovalStore();
  const kernel = new ToolKernel(registry, new InMemoryToolInvocationStore(), new InMemoryBudgetLedger({ ws_demo: 100000 }),
    { now: () => new Date('2026-01-01T00:00:00Z'), approvals });
  const paidContext = context({ grantedPermissions: ['workspace_write'] });
  const base = {
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: 'run_demo', stepId: 'stp_demo',
    proposal: proposal(definition), context: paidContext, role: 'member', grantedPermissions: ['workspace_write'],
    workflow: { workflowId: 'wf_paid', stage: 'render', approvedPaidMicros: 5000 },
    budgetRemainingMicros: 100000,
  };
  const waiting = await kernel.prepare(base);
  assert.equal(waiting.kind, 'awaiting_confirmation');

  await approvals.updateApproval(waiting.approval.approvalId, {
    ...waiting.approval, proposalDigest: '0'.repeat(64),
  });
  await assert.rejects(() => kernel.prepare({ ...base, approvalId: waiting.approval.approvalId }),
    error => error.code === 'AGENT_APPROVAL_PROPOSAL_CHANGED');

  await approvals.updateApproval(waiting.approval.approvalId, {
    ...waiting.approval, expiresAt: '2026-01-01T00:00:00.000Z',
  });
  await assert.rejects(() => kernel.prepare({ ...base, approvalId: waiting.approval.approvalId }),
    error => error.code === 'AGENT_APPROVAL_EXPIRED');
  assert.equal((await approvals.getApproval(waiting.approval.approvalId)).state, 'expired');
});

test('同一付费 Invocation 并发 execute 只预留一次预算，取消会释放预留', async () => {
  const definition = makeTool({
    toolId: 'demo.pay.concurrent', sideEffect: 'paid_external', executionOwner: 'workflow_only',
    requiredPermission: 'workspace_write', allowedWorkflowIds: ['wf_paid'],
    cost: { estimatorRevision: 'quote-v1', budgetDimension: 'money', estimateMicros: 5000, currency: 'CNY' },
  });
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register(definition, { execute: async () => { executions += 1; return { summary: '付费完成', costMicros: 4200 }; } });
  const store = new InMemoryToolInvocationStore();
  const ledger = new InMemoryBudgetLedger({ ws_demo: 100000 });
  const approvals = new InMemoryToolApprovalStore();
  const kernel = new ToolKernel(registry, store, ledger, {
    now: () => new Date('2026-01-01T00:00:00Z'), approvals,
  });
  const paidContext = context({ grantedPermissions: ['workspace_write'] });
  const base = {
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: 'run_demo', stepId: 'stp_demo',
    proposal: proposal(definition), context: paidContext, role: 'member', grantedPermissions: ['workspace_write'],
    workflow: { workflowId: 'wf_paid', stage: 'render', approvedPaidMicros: 5000 },
    budgetRemainingMicros: 100000,
  };
  const waiting = await kernel.prepare(base);
  await approvals.updateApproval(waiting.approval.approvalId, {
    ...waiting.approval, state: 'approved', decidedBy: 'usr_owner', decidedAt: '2026-01-01T00:00:01.000Z',
  });
  const ready = await kernel.prepare({ ...base, approvalId: waiting.approval.approvalId });
  assert.equal(ready.kind, 'ready');

  const concurrent = await Promise.allSettled([
    kernel.execute(ready.invocation, paidContext),
    kernel.execute(ready.invocation, paidContext),
  ]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = concurrent.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'AGENT_TOOL_INVOCATION_STALE');
  assert.equal(executions, 1);
  assert.equal(ledger.balanceOf('ws_demo'), 100000 - 4200);
  assert.equal(ledger.reservationFor('ws_demo', ready.invocation.invocationId).state, 'settled');

  // 取消运行中的 Invocation 必须在 CAS 成功后释放唯一预留，不能永久占用。
  const cancelDefinition = makeTool({
    toolId: 'demo.pay.cancel', sideEffect: 'paid_external', executionOwner: 'workflow_only',
    requiredPermission: 'workspace_write', allowedWorkflowIds: ['wf_paid'],
    cost: { estimatorRevision: 'quote-v1', budgetDimension: 'money', estimateMicros: 5000, currency: 'CNY' },
  });
  let startedResolve;
  let finishResolve;
  const started = new Promise(resolvePromise => { startedResolve = resolvePromise; });
  const finish = new Promise(resolvePromise => { finishResolve = resolvePromise; });
  const cancelRegistry = new ToolRegistry();
  cancelRegistry.register(cancelDefinition, {
    execute: async () => { startedResolve(); await finish; return { summary: '完成', costMicros: 4200 }; },
  });
  const cancelStore = new InMemoryToolInvocationStore();
  const cancelLedger = new InMemoryBudgetLedger({ ws_demo: 100000 });
  const cancelApprovals = new InMemoryToolApprovalStore();
  const cancelKernel = new ToolKernel(cancelRegistry, cancelStore, cancelLedger, {
    now: () => new Date('2026-01-01T00:00:00Z'), approvals: cancelApprovals,
  });
  const cancelContext = context({
    grantedPermissions: ['workspace_write'], toolCallId: 'call_cancel', requestId: 'req_cancel',
  });
  const cancelBase = {
    ...base, context: cancelContext, proposal: proposal(cancelDefinition, { proposalId: 'prop_cancel' }),
  };
  const cancelWaiting = await cancelKernel.prepare(cancelBase);
  assert.equal(cancelWaiting.kind, 'awaiting_confirmation');
  await cancelApprovals.updateApproval(cancelWaiting.approval.approvalId, {
    ...cancelWaiting.approval, state: 'approved', decidedBy: 'usr_owner', decidedAt: '2026-01-01T00:00:01.000Z',
  });
  const cancelReady = await cancelKernel.prepare({ ...cancelBase, approvalId: cancelWaiting.approval.approvalId });
  const running = cancelKernel.execute(cancelReady.invocation, cancelContext);
  await started;
  const live = await cancelStore.get(cancelReady.invocation.invocationId);
  assert.equal(live.state, 'running');
  await assert.rejects(cancelKernel.cancel(live, '用户取消'), error => error.code === 'AGENT_TOOL_RECONCILIATION_REQUIRED');
  assert.equal(cancelLedger.balanceOf('ws_demo'), 95000);
  assert.equal(cancelLedger.reservationFor('ws_demo', cancelReady.invocation.invocationId).state, 'reserved');
  finishResolve();
  const completed = await running;
  assert.equal(completed.invocation.state, 'succeeded');
  assert.equal(cancelLedger.balanceOf('ws_demo'), 95800);
  assert.equal(cancelLedger.reservationFor('ws_demo', cancelReady.invocation.invocationId).state, 'settled');
});

test('可重试失败按策略重试，外部结果未知进入 reconciling 而非失败', async () => {
  const retryDefinition = makeTool({
    toolId: 'demo.retry',
    retry: { timeoutMs: 1000, maxAttempts: 3, backoffMs: 1, retryableCodes: ['E_TEMP'], unknownCodes: [] },
  });
  let attempts = 0;
  const registry = new ToolRegistry();
  registry.register(retryDefinition, {
    execute: async () => {
      attempts += 1;
      if (attempts < 2) throw new ToolAdapterError('E_TEMP', '临时失败', { retryable: true });
      return { summary: '重试成功' };
    },
  });
  const kernel = new ToolKernel(registry, new InMemoryToolInvocationStore(), new InMemoryBudgetLedger({}), { now: () => new Date() });
  const prepared = await kernel.prepare({
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: 'run_demo', stepId: 'stp_demo',
    proposal: proposal(retryDefinition), context: context(), role: 'member', grantedPermissions: ['workspace_read'], workflow: null,
  });
  const outcome = await kernel.execute(prepared.invocation, context(), { sleep: async () => undefined });
  assert.equal(outcome.result.status, 'succeeded');
  assert.equal(attempts, 2);
  assert.equal(outcome.invocation.attemptCount, 2);

  const unknownDefinition = makeTool({ toolId: 'demo.unknown' });
  const unknownRegistry = new ToolRegistry();
  unknownRegistry.register(unknownDefinition, {
    execute: async () => { throw new ToolAdapterError('E_UNKNOWN', '远端超时', { unknown: true }); },
  });
  const unknownKernel = new ToolKernel(unknownRegistry, new InMemoryToolInvocationStore(), new InMemoryBudgetLedger({}));
  const unknown = await unknownKernel.prepare({
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: 'run_demo', stepId: 'stp_demo',
    proposal: proposal(unknownDefinition), context: context(), role: 'member', grantedPermissions: ['workspace_read'], workflow: null,
  });
  const unknownOutcome = await unknownKernel.execute(unknown.invocation, context());
  assert.equal(unknownOutcome.result.status, 'inconclusive');
  assert.equal(unknownOutcome.invocation.state, 'reconciling');
});

test('多轮 tool_calls 循环逐轮重新校验，遇到需确认调用立即 WAITING_CONFIRMATION 挂起', async () => {
  const read = makeTool();
  const registry = new ToolRegistry();
  registry.register(read, { execute: async () => ({ summary: '第一轮读取成功' }) });
  const kernel = new ToolKernel(registry, new InMemoryToolInvocationStore(), new InMemoryBudgetLedger({}),
    { now: () => new Date('2026-01-01T00:00:00Z') });
  const base = {
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: 'run_demo', stepId: 'stp_demo',
    context: context(), role: 'member', grantedPermissions: ['workspace_read'], workflow: null,
  };
  const result = await runAgentToolLoop(kernel, {
    ...base,
    planner: async ({ round, observations }) => {
      if (round === 1) return { calls: [proposal(read)] };
      assert.equal(observations.length, 1);
      assert.equal(observations[0].status, 'succeeded');
      return { done: true, summary: '两轮完成', output: { count: 1 } };
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.rounds, 2);
  assert.deepEqual(result.output, { count: 1 });
  assert.equal(result.observations[0].summary, '第一轮读取成功');

  const paid = makeTool({
    toolId: 'demo.loop.pay', sideEffect: 'paid_external', executionOwner: 'workflow_only',
    requiredPermission: 'workspace_write', allowedWorkflowIds: ['wf_paid'],
    cost: { estimatorRevision: 'quote-v1', budgetDimension: 'money', estimateMicros: 5000, currency: 'CNY' },
  });
  const paidRegistry = new ToolRegistry();
  let executed = 0;
  paidRegistry.register(paid, { execute: async () => { executed += 1; return { summary: '不应执行' }; } });
  const paidKernel = new ToolKernel(paidRegistry, new InMemoryToolInvocationStore(),
    new InMemoryBudgetLedger({ ws_demo: 100000 }),
    { approvals: new InMemoryToolApprovalStore() });
  const suspended = await runAgentToolLoop(paidKernel, {
    ...base, context: context({ grantedPermissions: ['workspace_write'] }),
    grantedPermissions: ['workspace_write'],
    workflow: { workflowId: 'wf_paid', stage: 'render', approvedPaidMicros: 0 },
    budgetRemainingMicros: 100000,
    planner: async () => ({ calls: [proposal(paid)] }),
  });
  assert.equal(suspended.status, 'WAITING_CONFIRMATION');
  assert.equal(suspended.confirmationState, WAITING_CONFIRMATION);
  assert.equal(suspended.approval.estimateMicros, 5000);
  assert.equal(executed, 0);
});


for (const sideEffect of ['none','external_write','paid_external']) test('unknown '+sideEffect+' recovery/replay/cancel cannot recycle reserved workspace budget', async () => {
  const definition = makeTool({sideEffect,...(sideEffect==='paid_external'?{executionOwner:'workflow_only',allowedWorkflowIds:['wf_paid'],cost:{estimatorRevision:'quote-v1',budgetDimension:'money',estimateMicros:5000,currency:'CNY'}}:{}),requiredPermission: sideEffect==='none'?'workspace_read':'workspace_write',idempotency:{strategy:'none',keyVersion:1}});
  const registry = new ToolRegistry();let executed=0;
  registry.register(definition,{execute:async()=>{executed++;return {summary:'must not run'};}});
  const store = new InMemoryToolInvocationStore(), ledger = new InMemoryBudgetLedger({ws_demo:5000});
  const kernel = new ToolKernel(registry,store,ledger,{approvals:new InMemoryToolApprovalStore()});
  const ctx=context({grantedPermissions:['workspace_read','workspace_write']});
  const prepared=await kernel.prepare({workspaceId:'ws_demo',agentId:'demo-agent',agentRunId:'run_demo',stepId:'stp_demo',proposal:proposal(definition),context:ctx,role:'member',grantedPermissions:ctx.grantedPermissions,workflow:sideEffect==='paid_external'?{workflowId:'wf_paid',stage:'render',approvedPaidMicros:0}:null,budgetRemainingMicros:5000});
  assert.ok(prepared.invocation);
  const live=await store.get(prepared.invocation.invocationId);
  const running={...live,state:'running',version:live.version+1,attemptCount:1};assert.equal(await store.update(live.version,running),true);
  await ledger.reserve({workspaceId:'ws_demo',agentRunId:'run_demo',invocationId:running.invocationId,amountMicros:5000,currency:'CNY'});
  await assert.rejects(kernel.cancel(running,'user cancellation'),e=>e.code==='AGENT_TOOL_RECONCILIATION_REQUIRED');
  const recovered=await kernel.recover(await store.get(running.invocationId),ctx);
  assert.equal(recovered.invocation.state,'reconciling');
  await kernel.recover(await store.get(running.invocationId),ctx);
  await assert.rejects(kernel.cancel(recovered.invocation,'cancel unknown'),e=>e.code==='AGENT_TOOL_RECONCILIATION_REQUIRED');
  const attempts=await Promise.allSettled([1,2].map(n=>ledger.reserve({workspaceId:'ws_demo',agentRunId:'another-run',invocationId:'another-'+n,amountMicros:1,currency:'CNY'})));
  assert.ok(attempts.every(r=>r.status==='rejected'),'the full budget must remain unavailable to concurrent callers');
  assert.equal(executed,0);
});


for(const mode of ['unknown','generic_error','unknown_commit','result_commit','settle','known_failure']) test('paid execution budget fault: '+mode,async()=>{
 const definition=makeTool({sideEffect:'paid_external',executionOwner:'workflow_only',allowedWorkflowIds:['wf_paid'],requiredPermission:'workspace_write',cost:{estimatorRevision:'quote-v1',budgetDimension:'money',estimateMicros:5000,currency:'CNY'}});
 const registry=new ToolRegistry();let executed=0;
 registry.register(definition,{execute:async()=>{executed++;if(mode==='generic_error')throw new Error('connection closed after submit');if(mode.startsWith('unknown'))throw new ToolAdapterError('E_UNKNOWN','unknown',{unknown:true});if(mode==='known_failure')throw new ToolAdapterError('E_NOT_EXECUTED','confirmed not executed');return {summary:'confirmed',costMicros:4200};}});
 const store=new InMemoryToolInvocationStore(),ledger=new InMemoryBudgetLedger({ws_demo:100000}),approvals=new InMemoryToolApprovalStore();
 const kernel=new ToolKernel(registry,store,ledger,{approvals});const ctx=context({grantedPermissions:['workspace_write']});
 const base={workspaceId:'ws_demo',agentId:'demo-agent',agentRunId:'run_demo',stepId:'stp_demo',proposal:proposal(definition),context:ctx,role:'member',grantedPermissions:ctx.grantedPermissions,workflow:{workflowId:'wf_paid',stage:'render',approvedPaidMicros:5000},budgetRemainingMicros:100000};
 const pending=await kernel.prepare(base);await approvals.updateApproval(pending.approval.approvalId,{...pending.approval,state:'approved',decidedBy:'usr_owner',decidedAt:new Date().toISOString()});
 const ready=await kernel.prepare({...base,approvalId:pending.approval.approvalId});assert.equal(ready.kind,'ready');
 const update=store.update.bind(store),settle=ledger.settle.bind(ledger);
 store.update=async(version,next)=>{if(mode==='result_commit'&&next.state==='succeeded'||mode==='unknown_commit'&&next.state==='reconciling')return false;return update(version,next);};
 if(mode==='settle')ledger.settle=async()=>{throw new Error('settlement unavailable');};
 if(['result_commit','unknown_commit','settle'].includes(mode))await assert.rejects(kernel.execute(ready.invocation,ctx));else await kernel.execute(ready.invocation,ctx);
 assert.equal(executed,1);
 assert.equal(ledger.reservationFor('ws_demo',ready.invocation.invocationId).state,mode==='known_failure'?'released':'reserved');
 assert.equal(ledger.balanceOf('ws_demo'),mode==='known_failure'?100000:95000);
 store.update=update;ledger.settle=settle;
 if(mode==='settle'){
  await kernel.recover(await store.get(ready.invocation.invocationId),ctx);
  assert.equal(ledger.balanceOf('ws_demo'),95800);assert.equal(ledger.reservationFor('ws_demo',ready.invocation.invocationId).state,'settled');
 }else if(mode!=='known_failure'){
  const replay=await kernel.recover(await store.get(ready.invocation.invocationId),ctx);assert.equal(replay.invocation.state,'reconciling');assert.equal(ledger.balanceOf('ws_demo'),95000);
 }
 assert.equal(executed,1);
});
